import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, outlineTxt, rr, txt } from '@/core/draw'

/**
 * 瑜伽体式（对齐逆向报告 yoga.md / 站点 game-DWplXCUF.js）：
 * 跟教练依次摆体式（山式起 + 3 轮洗牌池），入场需连续达标 0.3s，掉出 0.45s 才算掉出（计时暂停）。
 * 保持中每 0.5s 按稳定度（运动量越低越稳）得 0~1 分，完成一次性 +5；
 * find 超时 / hold 总窗超时 → skip 不扣分；全员结算完休息 2.6s 进入下一个。
 * 教练旁 9s 呼吸圈（吸 4s / 呼 5s），教练随呼吸摆臂并平滑变形成目标体式。
 */

/** 难度表（报告 §1）：hold 保持秒数 / find 找姿势限时 / extra hold 总窗额外秒 / calm 稳定度满分运动量线 / span 线性区间宽 */
const DIFF = [
  { hold: 10, find: 14, extra: 9, calm: 0.5, span: 0.32 },
  { hold: 15, find: 12, extra: 8, calm: 0.42, span: 0.28 },
  { hold: 20, find: 12, extra: 8, calm: 0.36, span: 0.24 },
]

/** 常量（报告 §1）：ENTER 入场确认 / EXIT 掉出确认 / REST 体式间休息 / TICK 稳定度结算 / BONUS 完成奖励 / 呼吸 9s=吸4+呼5 */
const ENTER = 0.3
const EXIT = 0.45
const REST = 2.6
const TRANS = 1.2
const TICK = 0.5
const BONUS = 5
const BREATH_CYCLE = 9
const BREATH_IN = 4
const FLOOR_K = 0.74
const FOOT_LIFT = 0.18 // 抬脚判定：踝高差 > 0.18×scale（站点 motion.liftedFoot 代理，推断）
const NOTE_LANES = [-2, 1, 2, 4, 6] // 站点 MIDI [67,71,74,79,83] → tonePop lane=(midi-69)*5/12

type PoseId =
  | 'mountain'
  | 'tree'
  | 'tree2'
  | 'warrior'
  | 'triangle'
  | 'chair'
  | 'star'
  | 'moon'
  | 'dancer'

interface PoseInfo {
  id: PoseId
  name: string
  say: string
  cue: string
  oneLeg: boolean
}

/** 体式文案（站点翻译表 en 列） */
const POSES: Record<PoseId, PoseInfo> = {
  mountain: { id: 'mountain', name: '山式', say: '山式。双脚并拢站稳，双手慢慢向上伸直。', cue: '双脚并拢，双手向上伸直', oneLeg: false },
  tree: { id: 'tree', name: '树式', say: '树式。抬起一只脚，踩在另一条腿内侧，双手合十。', cue: '单脚站稳，双手合十举过头顶', oneLeg: true },
  tree2: { id: 'tree2', name: '树式 · 换腿', say: '换一条腿，再做一次树式。', cue: '换另一只脚抬起来，双手合十', oneLeg: true },
  warrior: { id: 'warrior', name: '战士二式', say: '战士二式。两脚大大分开，弯曲一侧膝盖，双臂向两边平举。', cue: '两脚大大分开，弯一侧膝盖，双臂平举', oneLeg: false },
  triangle: { id: 'triangle', name: '三角式', say: '三角式。两脚分开，身体向一侧倒，一只手向下，一只手指向天空。', cue: '两脚分开，身体侧倒，一手向下一手向上', oneLeg: false },
  chair: { id: 'chair', name: '椅子式', say: '椅子式。像坐椅子一样屈膝往下坐，双手举高。', cue: '屈膝往下坐，双手举过头顶', oneLeg: false },
  star: { id: 'star', name: '星星式', say: '星星式。两脚分开，双臂斜向上打开，像一颗五角星。', cue: '两脚分开，双臂斜向上打开', oneLeg: false },
  moon: { id: 'moon', name: '新月式', say: '新月式。双手举过头顶合拢，身体慢慢向一侧弯。', cue: '双手举过头顶，身体向一侧弯', oneLeg: false },
  dancer: { id: 'dancer', name: '舞王式', say: '舞王式。单脚站稳，一只手扶住抬起的脚，另一只手向上伸。', cue: '单脚站，一手扶后脚，一手向前上方伸', oneLeg: true },
}

interface Chk {
  ok: boolean
  /** 部位达标情况（用于 mint 纠错描线） */
  arms: boolean
  legs: boolean
  body: boolean
  hint: string
  /** 侧别（tree/tree2 抬哪只脚 0/1；triangle/moon 朝哪边弯 -1/1） */
  side: number | null
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

/** 蹲下分量：站直≈0、深蹲≈1（与 simon-says 同口径） */
function squatComp(b: Body) {
  const s = Math.max(0.05, b.scale)
  const ratio = ((b.lKnee.y - b.lHip.y) / s + (b.rKnee.y - b.rHip.y) / s) / 2
  return clamp01(1 - ratio / 0.7)
}

/** 抬膝分量（与 simon-says 同口径） */
function kneeComp(b: Body) {
  const s = Math.max(0.05, b.scale)
  const minRatio = Math.min(b.lKnee.y - b.lHip.y, b.rKnee.y - b.rHip.y) / s
  return clamp01((0.55 - minRatio) / 0.4)
}

/** 抬起的脚：踝高差 > FOOT_LIFT×scale 返回 0/1，否则 -1（站点 motion.liftedFoot 代理） */
function liftedFoot(b: Body): number {
  const s = Math.max(0.05, b.scale)
  const ly = b.lFoot.y
  const ry = b.rFoot.y
  if (ly < ry - FOOT_LIFT * s) return 0
  if (ry < ly - FOOT_LIFT * s) return 1
  return -1
}

/** 双手合十举高（tree/tree2/moon） */
function palmsUp(b: Body): { together: boolean; high: boolean } {
  const s = Math.max(0.05, b.scale)
  const together = Math.abs(b.lHand.x - b.rHand.x) < 0.45 * s
  const high = b.lHand.y < b.head.y && b.rHand.y < b.head.y
  return { together, high }
}

/** 双臂平举（warrior）：手在肩高、越过肩外侧 */
function armsLevel(b: Body): boolean {
  const s = Math.max(0.05, b.scale)
  return (
    Math.abs(b.lHand.y - b.shoulderC.y) < 0.4 * s &&
    Math.abs(b.rHand.y - b.shoulderC.y) < 0.4 * s &&
    b.lHand.x < b.lShoulder.x - 0.4 * s &&
    b.rHand.x > b.rShoulder.x + 0.4 * s
  )
}

/** 双臂斜上打开（star）：手高于肩、两外侧 */
function armsDiagUp(b: Body): boolean {
  const s = Math.max(0.05, b.scale)
  return (
    b.lHand.y < b.shoulderC.y - 0.3 * s &&
    b.rHand.y < b.shoulderC.y - 0.3 * s &&
    b.lHand.x < b.lShoulder.x - 0.35 * s &&
    b.rHand.x > b.rShoulder.x + 0.35 * s
  )
}

/** 姿势检查（站点黑盒 g() 的本地等价实现：按 cue 文案拆子条件，阈值为推断） */
function checkPose(key: PoseId, b: Body, expectedSide: number): Chk {
  const s = Math.max(0.05, b.scale)
  const feet = b.feetSpread / s
  const lean = (b.shoulderC.x - b.hipC.x) / s
  switch (key) {
    case 'mountain': {
      const legs = feet < 0.35
      const arms = b.armsUp
      return { ok: legs && arms, arms, legs, body: true, hint: !legs ? '双脚并拢一点' : '双手向上伸直', side: null }
    }
    case 'tree':
    case 'tree2': {
      const foot = liftedFoot(b)
      const legs = kneeComp(b) > 0.25 && (expectedSide < 0 || foot === expectedSide)
      const pal = palmsUp(b)
      const arms = pal.together && pal.high
      const hint = !legs
        ? expectedSide >= 0 && foot >= 0 && foot !== expectedSide
          ? '换另一只脚抬起来'
          : '抬起一只脚'
        : !pal.together
          ? '双手合十靠拢'
          : !pal.high
            ? '合十的手举到胸前以上'
            : ''
      return { ok: legs && arms, arms, legs, body: true, hint, side: foot < 0 ? null : foot }
    }
    case 'warrior': {
      const legs = feet > 1.2 && squatComp(b) > 0.15
      const arms = armsLevel(b)
      const hint = feet <= 1.2 ? '两脚再分开一点' : squatComp(b) <= 0.15 ? '弯曲一侧膝盖' : arms ? '' : '双臂向两边平举'
      return { ok: legs && arms, arms, legs, body: true, hint, side: null }
    }
    case 'triangle': {
      const side = lean >= 0 ? 1 : -1
      const legs = feet > 1.0
      const body = Math.abs(lean) > 0.35
      const down = Math.min(b.lHand.y, b.rHand.y) > b.shoulderC.y + 0.15 * s
      const up = Math.max(b.lHand.y, b.rHand.y) < b.head.y
      const arms = down && up
      const hint =
        !legs
          ? '两脚再分开一点'
          : !body
            ? '身体向一侧倒'
            : !down
              ? '一只手向下够'
              : !up
                ? '另一只手指向天空'
                : ''
      return { ok: legs && body && arms, arms, legs, body, hint, side }
    }
    case 'chair': {
      const legs = squatComp(b) > 0.35
      const arms = b.armsUp
      return { ok: legs && arms, arms, legs, body: true, hint: !legs ? '屈膝往下坐' : arms ? '' : '双手举过头顶', side: null }
    }
    case 'star': {
      const legs = feet > 1.2
      const arms = armsDiagUp(b)
      return { ok: legs && arms, arms, legs, body: true, hint: !legs ? '两脚再分开一点' : arms ? '' : '双臂斜着往上举', side: null }
    }
    case 'moon': {
      const side = lean >= 0 ? 1 : -1
      const legs = feet < 0.5
      const body = Math.abs(lean) > 0.3
      const pal = palmsUp(b)
      const arms = pal.together && pal.high
      const hint =
        !pal.together
          ? '两手靠拢'
          : !pal.high
            ? '双手举过头顶'
            : !body
              ? '身体向一侧弯'
              : !legs
                ? '双脚并拢一点'
                : ''
      return { ok: legs && body && arms, arms, legs, body, hint, side }
    }
    case 'dancer': {
      const foot = liftedFoot(b)
      const knee = foot === 0 ? b.lKnee : foot === 1 ? b.rKnee : null
      const legs = kneeComp(b) > 0.45 && knee !== null
      const s2 = Math.max(0.05, b.scale)
      const holdFoot =
        knee !== null &&
        (Math.hypot(b.lHand.x - knee.x, b.lHand.y - knee.y) < 0.7 * s2 ||
          Math.hypot(b.rHand.x - knee.x, b.rHand.y - knee.y) < 0.7 * s2)
      const reachUp = Math.min(b.lHand.y, b.rHand.y) < b.head.y
      const arms = holdFoot && reachUp
      const hint =
        !legs ? '抬起一只脚' : !holdFoot ? '另一只手往下扶住脚' : reachUp ? '' : '一只手向上伸'
      return { ok: legs && arms, arms, legs, body: true, hint, side: foot < 0 ? null : foot }
    }
  }
}

/** 单个体式的每玩家状态（站点 I()） */
interface PState {
  state: 'find' | 'hold' | 'done' | 'skip'
  in: boolean
  okFor: number
  badFor: number
  held: number
  streak: number
  firstIn: number
  tick: number
  eSum: number
  eDur: number
  frac: number
  gain: number
  stab: number
  pStab: number
  pN: number
  chk: Chk | null
  flip: boolean
  lastNote: number
  best: number
  stabSum: number
  stabN: number
  done: number
  treeFoot: number
  footTime: [number, number]
}

const newState = (): PState => ({
  state: 'find',
  in: false,
  okFor: 0,
  badFor: 0,
  held: 0,
  streak: 0,
  firstIn: -1,
  tick: 0,
  eSum: 0,
  eDur: 0,
  frac: 0,
  gain: 0,
  stab: 0,
  pStab: 0,
  pN: 0,
  chk: null,
  flip: false,
  lastNote: 0,
  best: 0,
  stabSum: 0,
  stabN: 0,
  done: 0,
  treeFoot: -1,
  footTime: [0, 0],
})

/** 呼吸圈（站点 R()）：9s 周期，吸 4s 胀 / 呼 5s 缩 */
function breath(clock: number) {
  const t = ((clock % BREATH_CYCLE) + BREATH_CYCLE) % BREATH_CYCLE
  const inOut = (n: number) => (n < 0.5 ? 2 * n * n : 1 - (-2 * n + 2) ** 2 / 2)
  if (t < BREATH_IN) {
    return { b: inOut(t / BREATH_IN), inhale: true, left: Math.ceil(BREATH_IN - t) }
  }
  return { b: 1 - inOut((t - BREATH_IN) / (BREATH_CYCLE - BREATH_IN)), inhale: false, left: Math.ceil(BREATH_CYCLE - t) }
}

/** 简笔小人规格：arms 双手相对肩心（scale 单位，y 向下） / legs 腿型 / lean 躯干倾斜弧度 */
interface FigSpec {
  arms: [{ x: number; y: number }, { x: number; y: number }]
  legs: 'together' | 'apart' | 'wide' | 'squat' | 'knee'
  lean?: number
}

/** 各体式的示范骨架（站点 v[pose].shape 黑盒的本地等价规格，按 cue 推断） */
const POSE_SPEC: Record<PoseId, FigSpec> = {
  mountain: { arms: [{ x: -0.12, y: -0.95 }, { x: 0.12, y: -0.95 }], legs: 'together' },
  tree: { arms: [{ x: -0.07, y: -0.9 }, { x: 0.07, y: -0.9 }], legs: 'knee' },
  tree2: { arms: [{ x: -0.07, y: -0.9 }, { x: 0.07, y: -0.9 }], legs: 'knee' },
  warrior: { arms: [{ x: -1.0, y: -0.05 }, { x: 1.0, y: -0.05 }], legs: 'wide' },
  triangle: { arms: [{ x: -0.15, y: 0.9 }, { x: 0.15, y: -0.9 }], legs: 'apart', lean: 0.45 },
  chair: { arms: [{ x: -0.14, y: -0.9 }, { x: 0.14, y: -0.9 }], legs: 'squat' },
  star: { arms: [{ x: -0.85, y: -0.7 }, { x: 0.85, y: -0.7 }], legs: 'wide' },
  moon: { arms: [{ x: -0.09, y: -0.9 }, { x: 0.09, y: -0.9 }], legs: 'together', lean: 0.4 },
  dancer: { arms: [{ x: 0.35, y: -0.85 }, { x: 0.2, y: 0.45 }], legs: 'knee' },
}

/** 镜像规格（flip 时） */
function mirrorSpec(sp: FigSpec): FigSpec {
  return {
    arms: [{ x: -sp.arms[1].x, y: sp.arms[1].y }, { x: -sp.arms[0].x, y: sp.arms[0].y }],
    legs: sp.legs,
    lean: sp.lean ? -sp.lean : 0,
  }
}

/** 简笔小人（肩心在 x,y，T=比例尺）：站点 sprites 骨架绘制的本地等价 */
function drawFigure(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  T: number,
  spec: FigSpec,
  color: string,
  alpha = 1,
) {
  c.save()
  c.globalAlpha = alpha
  c.translate(x, y + T * 0.5)
  c.rotate(spec.lean ?? 0)
  c.translate(-x, -(y + T * 0.5))
  c.strokeStyle = color
  c.lineCap = 'round'
  c.lineJoin = 'round'
  c.lineWidth = T * 0.16
  // 躯干 + 头
  c.beginPath()
  c.moveTo(x, y)
  c.lineTo(x, y + T * 0.95)
  c.stroke()
  circle(c, x, y - T * 0.42, T * 0.3, color)
  // 手臂（肩 ±0.22T）
  for (let i = 0; i < 2; i++) {
    const sx = x + (i === 0 ? -0.22 : 0.22) * T
    const h = spec.arms[i]
    c.beginPath()
    c.moveTo(sx, y + T * 0.05)
    c.lineTo((sx + x + h.x * T) / 2, (y + h.y * T) / 2)
    c.lineTo(x + h.x * T, y + h.y * T)
    c.stroke()
  }
  // 腿（髋 y+0.95T）
  const hipY = y + T * 0.95
  c.lineWidth = T * 0.18
  const leg = (x0: number, kx: number, ky: number, fx: number, fy: number) => {
    c.beginPath()
    c.moveTo(x0, hipY)
    c.lineTo(kx, ky)
    c.lineTo(fx, fy)
    c.stroke()
  }
  if (spec.legs === 'together') {
    leg(x - 0.1 * T, x - 0.13 * T, hipY + 0.7 * T, x - 0.15 * T, hipY + 1.4 * T)
    leg(x + 0.1 * T, x + 0.13 * T, hipY + 0.7 * T, x + 0.15 * T, hipY + 1.4 * T)
  } else if (spec.legs === 'apart') {
    leg(x - 0.1 * T, x - 0.45 * T, hipY + 0.7 * T, x - 0.6 * T, hipY + 1.4 * T)
    leg(x + 0.1 * T, x + 0.45 * T, hipY + 0.7 * T, x + 0.6 * T, hipY + 1.4 * T)
  } else if (spec.legs === 'wide') {
    leg(x - 0.1 * T, x - 0.6 * T, hipY + 0.7 * T, x - 0.85 * T, hipY + 1.4 * T)
    leg(x + 0.1 * T, x + 0.6 * T, hipY + 0.7 * T, x + 0.85 * T, hipY + 1.4 * T)
  } else if (spec.legs === 'squat') {
    leg(x - 0.1 * T, x - 0.5 * T, hipY + 0.55 * T, x - 0.28 * T, hipY + 1.1 * T)
    leg(x + 0.1 * T, x + 0.5 * T, hipY + 0.55 * T, x + 0.28 * T, hipY + 1.1 * T)
  } else {
    // knee：一条直立一条屈膝抬起
    leg(x - 0.1 * T, x - 0.13 * T, hipY + 0.7 * T, x - 0.15 * T, hipY + 1.4 * T)
    leg(x + 0.1 * T, x + 0.55 * T, hipY + 0.3 * T, x + 0.4 * T, hipY + 0.7 * T)
  }
  c.restore()
}

/** 瑜伽体式 */
class YogaGame extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  unit = this.H / 720
  /** 体式序列（站点 H）：mountain 打头 + 3 轮洗牌池；hard 先把单脚式提到第 2 位并展开 tree→tree2 */
  seq: PoseId[]
  idx = -1
  pose: PoseId = 'mountain'
  /** pose | rest（站点 G） */
  mode: 'pose' | 'rest' = 'pose'
  started = false
  /** 当前体式开始时刻（站点 K） */
  poseAt = 0
  restAt = 0
  ps: PState[] = [newState(), newState()]
  /** 教练形状过渡（站点 J→re()，TRANS 秒 inOut） */
  transFrom: FigSpec = POSE_SPEC.mountain
  transTo: FigSpec = POSE_SPEC.mountain
  transAt = -99
  /** 完成扩散环特效（站点 fx.ring） */
  rings: { x: number; y: number; age: number }[] = []
  bannerT = 0
  bannerMax = 0
  bannerText = ''
  bannerSub = ''
  bannerColor = '#14b8a6'
  /** 运动量代理（τ=0.12 平滑 + 去最快 2 关节） */
  private sp: number[][] = [[], []]
  private prev: ({ x: number; y: number } | null)[][] = [[], []]
  energy = [0, 0]
  totalDone = 0
  bestHold = 0
  stabSum = 0
  stabN = 0

  constructor(ctx: GameContext) {
    super(ctx)
    const pool: PoseId[] =
      ctx.difficulty === 2
        ? ['tree', 'dancer', 'warrior', 'triangle', 'chair', 'star', 'moon']
        : ['star', 'chair', 'warrior', 'tree', 'moon', 'triangle']
    const seq: PoseId[] = ['mountain']
    for (let k = 0; k < 3; k++) {
      const sh = [...pool]
      for (let i = sh.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[sh[i], sh[j]] = [sh[j], sh[i]]
      }
      if (sh[0] === seq[seq.length - 1] && sh.length > 1) [sh[0], sh[1]] = [sh[1], sh[0]]
      seq.push(...sh)
    }
    if (ctx.difficulty === 2) {
      const at = seq.findIndex((p, i) => i >= 1 && POSES[p].oneLeg)
      if (at > 2) {
        const t = seq[2]
        seq[2] = seq[at]
        seq[at] = t
      }
      // tree 展开 tree/tree2
      const out: PoseId[] = []
      for (const p of seq) out.push(p, ...(p === 'tree' ? (['tree', 'tree2'] as PoseId[]) : [p]))
      seq.length = 0
      seq.push(...out)
    }
    this.seq = seq
  }

  private dual() {
    return !!(this.players[0].body && this.players[1].body)
  }

  /** 布局（站点 X()）：地面 0.74H、比例尺 T、教练 x、玩家垫 x */
  private layout() {
    const dual = this.dual()
    const T = this.H * (dual ? 0.145 : 0.155)
    return {
      floor: this.H * FLOOR_K,
      T,
      coachX: this.W * (dual ? 0.17 : 0.27),
      xs: dual ? [this.W * 0.44, this.W * 0.71] : [this.W * 0.66],
    }
  }

  /** 运动量（对齐站点 motion.energy：τ=0.12 平滑，去最快 2 关节的均值，躯干长/秒） */
  private updateEnergy(b: Body, i: number, dt: number) {
    if (this.sp[i].length !== b.lm.length) {
      this.sp[i] = b.lm.map(() => 0)
      this.prev[i] = b.lm.map(() => null)
      this.energy[i] = 0
    }
    const k = 1 - Math.exp(-dt / 0.12)
    const scale = Math.max(0.05, b.scale)
    for (let j = 0; j < b.lm.length; j++) {
      const p = b.lm[j]
      const q = this.prev[i][j]
      let v = 0
      if (q && (p.visibility ?? 1) >= 0.5) {
        v = Math.hypot(p.x - q.x, p.y - q.y) / Math.max(0.016, dt) / scale
      }
      this.prev[i][j] = { x: p.x, y: p.y }
      this.sp[i][j] += (v - this.sp[i][j]) * k
    }
    const speeds = this.sp[i].filter((_, j) => (b.lm[j].visibility ?? 1) >= 0.5)
    if (!speeds.length) {
      this.energy[i] = 0
      return 0
    }
    speeds.sort((a, z) => a - z)
    const keep = Math.max(1, speeds.length - 2)
    let sum = 0
    for (let j = 0; j < keep; j++) sum += speeds[j]
    this.energy[i] = sum / keep
    return this.energy[i]
  }

  /** 开下一个体式（站点 Q()） */
  private nextPose() {
    this.idx++
    if (this.idx >= this.seq.length) {
      // 90s 内一般跑不完；兜底再洗一轮接上
      const pool: PoseId[] = this.ctx.difficulty === 2
        ? ['tree', 'tree2', 'dancer', 'warrior', 'triangle', 'chair', 'star', 'moon']
        : ['star', 'chair', 'warrior', 'tree', 'tree2', 'moon', 'triangle']
      const sh = [...pool]
      for (let i = sh.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[sh[i], sh[j]] = [sh[j], sh[i]]
      }
      if (sh[0] === this.seq[this.seq.length - 1] && sh.length > 1) [sh[0], sh[1]] = [sh[1], sh[0]]
      this.seq.push(...sh)
    }
    this.pose = this.seq[this.idx]
    this.mode = 'pose'
    this.poseAt = this.t
    this.transFrom = this.transTo
    this.transTo = POSE_SPEC[this.pose]
    this.transAt = this.t
    for (const st of this.ps) {
      st.state = 'find'
      st.in = false
      st.okFor = 0
      st.badFor = 0
      st.held = 0
      st.streak = 0
      st.firstIn = -1
      st.tick = 0
      st.eSum = 0
      st.eDur = 0
      st.frac = 0
      st.gain = 0 // 站点每体式重置 gain（完成 ✓ +{gain} 只显示本体式所得）
      st.pStab = 0
      st.pN = 0
      st.lastNote = 0
      st.footTime = [0, 0]
      st.chk = null
      st.flip = false
    }
    const info = POSES[this.pose]
    this.banner(info.name, info.cue, '#14b8a6', 1600)
    this.ctx.speak(this.idx === 0 ? `跟着圆圈慢慢呼吸。${info.say}` : info.say)
    this.ctx.audio.good() // 站点 chime
    this.ctx.setStage(info.name)
  }

  /** 进休息（站点 ie()） */
  private toRest() {
    this.mode = 'rest'
    this.poseAt = this.t
  }

  /** 完成（站点 ae()）：+5、飘字、星爆 + 扩散环；单人加横幅 */
  private complete(i: number) {
    const st = this.ps[i]
    st.state = 'done'
    st.in = false
    st.done++
    this.totalDone++
    const L = this.layout()
    const x = L.xs[Math.min(i, L.xs.length - 1)]
    st.gain += BONUS
    this.ctx.addScore(BONUS)
    const stab = st.pN ? st.pStab / st.pN : 0
    this.bestHold = Math.max(this.bestHold, st.best)
    this.particles.burst(x, L.floor - L.T * 1.6, '#14b8a6', 5, 220, 6)
    this.particles.burst(x, L.floor - L.T * 1.6, '#fff6c2', 4, 220, 6)
    this.particles.burst(x, L.floor - L.T * 1.6, '#a7f3d0', 3, 220, 5)
    this.rings.push({ x, y: L.floor - L.T * 1.6, age: 0 })
    this.ctx.audio.good() // 站点 sparkle
    this.say(`完成 +${BONUS}`, x, L.floor - L.T * 3.2, '#14b8a6', 40 * this.unit)
    if (!this.dual()) {
      this.banner('完成！', `稳定度 ${Math.round(stab * 100)}%`, '#3ddc97', 1300)
    }
    this.pushStats()
  }

  /** 结算统计（站点 Z()：完成体式 / 最长保持 / 平均稳定度） */
  private pushStats() {
    this.ctx.setExtra('完成体式', this.totalDone)
    let best = 0
    let stabSum = 0
    let stabN = 0
    for (const st of this.ps) {
      best = Math.max(best, st.best)
      stabSum += st.stabSum
      stabN += st.stabN
    }
    this.ctx.setExtra('最长保持秒', Math.round(best * 10) / 10)
    this.ctx.setExtra('平均稳定度%', stabN ? Math.round((stabSum / stabN) * 100) : 0)
  }

  /** 横幅（站点 banner 代理） */
  private banner(text: string, sub: string, color: string, ms: number) {
    this.bannerText = text
    this.bannerSub = sub
    this.bannerColor = color
    this.bannerMax = ms / 1000
    this.bannerT = this.bannerMax
  }

  /** 逐玩家更新（站点 oe()） */
  private updatePlayer(i: number, dt: number) {
    const st = this.ps[i]
    const b = this.players[i].body
    const expected = this.pose === 'tree2' && st.treeFoot >= 0 ? (st.treeFoot === 0 ? 1 : 0) : -1
    st.chk = b ? checkPose(this.pose, b, expected) : null
    if (st.chk && st.chk.side !== null) st.flip = st.chk.side === 1
    if (st.state === 'done' || st.state === 'skip') return
    const elapsed = this.t - this.poseAt
    const ok = st.chk?.ok === true
    if (ok) {
      st.okFor += dt
      st.badFor = 0
    } else {
      st.badFor += dt
      st.okFor = 0
    }
    const wasIn = st.in
    if (!st.in && st.okFor >= ENTER) st.in = true
    else if (st.in && st.badFor >= EXIT) st.in = false
    if (st.in && !wasIn) {
      st.state = 'hold'
      st.streak = 0
      st.tick = 0
      st.eSum = 0
      st.eDur = 0
      if (st.firstIn < 0) st.firstIn = this.t
      this.ctx.audio.pop() // 站点 bubble
    } else if (!st.in && wasIn && st.streak > 1.2) {
      this.ctx.audio.drop() // 站点 wobble
    }
    if (!b) return
    const energy = this.updateEnergy(b, i, dt)
    if (st.in) {
      st.held += dt
      st.streak += dt
      st.best = Math.max(st.best, st.streak)
      // 抬脚计时（tree 决定 treeFoot 供 tree2 换腿）
      const foot = liftedFoot(b)
      if (foot === 0 || foot === 1) st.footTime[foot] += dt
      if (this.pose === 'tree' && st.footTime[0] + st.footTime[1] > 0) {
        st.treeFoot = st.footTime[0] >= st.footTime[1] ? 0 : 1
      }
      st.eSum += energy * dt
      st.eDur += dt
      st.tick += dt
      if (st.tick >= TICK) {
        st.tick -= TICK
        const avg = st.eDur > 0 ? st.eSum / st.eDur : 0
        st.eSum = 0
        st.eDur = 0
        const stab = clamp01((this.cfg.calm - avg) / this.cfg.span)
        st.stab = stab
        st.stabSum += stab
        st.stabN++
        st.pStab += stab
        st.pN++
        st.frac += 0.5 + stab
        const whole = Math.floor(st.frac)
        if (whole > 0) {
          st.frac -= whole
          st.gain += whole
          this.ctx.addScore(whole)
        }
        this.pushStats()
      }
      // 每保持满 5s 一个上行音（站点 MIDI 67/71/74/79/83）
      const note = Math.floor(st.held / 5)
      if (note > st.lastNote) {
        st.lastNote = note
        this.ctx.audio.tonePop(NOTE_LANES[Math.min(4, note - 1)])
      }
      if (st.held >= this.cfg.hold) this.complete(i)
    }
    // 超时：find 超 find 秒 / hold 超 find+hold+extra → skip
    if (st.state === 'find' && elapsed > this.cfg.find) st.state = 'skip'
    else if (st.state === 'hold' && elapsed > this.cfg.find + this.cfg.hold + this.cfg.extra) {
      st.state = 'skip'
      st.in = false
    }
  }

  tick(_f: PoseFrame, dt: number) {
    this.bannerT = Math.max(0, this.bannerT - dt)
    for (let k = this.rings.length - 1; k >= 0; k--) {
      this.rings[k].age += dt
      if (this.rings[k].age > 0.6) this.rings.splice(k, 1)
    }
    if (!this.started) {
      this.started = true
      this.nextPose()
    } else if (this.mode === 'rest') {
      if (this.t - this.poseAt >= REST) this.nextPose()
    } else {
      for (let i = 0; i < 2; i++) this.updatePlayer(i, dt)
      // 全员 done/skip → 休息（对齐站点：缺席的玩家 find 超时后也会 skip，卡进度与站点一致）
      if (this.ps.every((st) => st.state === 'done' || st.state === 'skip')) {
        if (this.ps.every((st) => st.state === 'skip')) this.ctx.speak('没关系，换下一个。')
        this.toRest()
      }
    }
  }

  paint(c: CanvasRenderingContext2D) {
    const u = this.unit
    const L = this.layout()
    const { floor, T } = L
    // 底：草地瑜伽馆（站点 yoga-bg 的简化代理；地面 0.74H）
    const g = c.createLinearGradient(0, 0, 0, this.H)
    g.addColorStop(0, '#dff0ec')
    g.addColorStop(0.55, '#f2efdf')
    g.addColorStop(1, '#e5e0cc')
    c.fillStyle = g
    c.fillRect(0, 0, this.W, this.H)
    c.fillStyle = 'rgba(160,180,140,.25)'
    c.fillRect(0, floor, this.W, this.H - floor)

    const br = breath(this.t)
    // 呼吸圈（站点 S()：半径随 b 涨缩）
    const circleY = floor - T * 1.8
    const circleR = T * 1.75 * (0.55 + 0.45 * br.b)
    c.save()
    c.globalAlpha = 0.5
    circle(c, L.coachX, circleY, circleR, br.inhale ? 'rgba(20,184,166,.35)' : 'rgba(154,134,224,.3)')
    c.restore()
    c.strokeStyle = br.inhale ? '#14b8a6' : '#9a86e0'
    c.lineWidth = 5 * u
    c.beginPath()
    c.arc(L.coachX, circleY, circleR, 0, Math.PI * 2)
    c.stroke()
    txt(c, `${br.inhale ? '吸气' : '呼气'} ${br.left}`, L.coachX, circleY - T * 1.75 - 16 * u, 22 * u, br.inhale ? '#14b8a6' : '#9a86e0')
    // 教练小人：肩心在 floor-2.35T（脚落地），呼吸臂 / 体式形状 TRANS 秒插值（站点 J→re()）
    const breathSpec: FigSpec = {
      arms: [
        { x: -(0.35 + 0.45 * br.b), y: -(0.05 + 0.6 * br.b) },
        { x: 0.35 + 0.45 * br.b, y: -(0.05 + 0.6 * br.b) },
      ],
      legs: 'together',
    }
    const targetSpec = this.mode === 'pose' ? POSE_SPEC[this.pose] : breathSpec
    const tp = Math.max(0, Math.min(1, (this.t - this.transAt) / TRANS))
    const ease = tp < 0.5 ? 2 * tp * tp : 1 - (-2 * tp + 2) ** 2 / 2
    const coachSpec: FigSpec = {
      arms: [
        {
          x: this.transFrom.arms[0].x + (targetSpec.arms[0].x - this.transFrom.arms[0].x) * ease,
          y: this.transFrom.arms[0].y + (targetSpec.arms[0].y - this.transFrom.arms[0].y) * ease,
        },
        {
          x: this.transFrom.arms[1].x + (targetSpec.arms[1].x - this.transFrom.arms[1].x) * ease,
          y: this.transFrom.arms[1].y + (targetSpec.arms[1].y - this.transFrom.arms[1].y) * ease,
        },
      ],
      legs: this.mode === 'pose' ? targetSpec.legs : 'together',
      lean: (this.transFrom.lean ?? 0) + ((targetSpec.lean ?? 0) - (this.transFrom.lean ?? 0)) * ease,
    }
    drawFigure(c, L.coachX, floor - T * 2.35, T, coachSpec, '#0f766e', 1)
    // 教练下文案（站点：跟着教练做 / 体式名+cue / 放松一下+下一个）
    const lineY = floor + 50 * u
    const line2Y = floor + 92 * u
    if (this.idx < 0) {
      txt(c, '跟着教练做', L.coachX, lineY, 30 * u, '#14b8a6')
      txt(c, '跟着圆圈慢慢呼吸', L.coachX, line2Y, 22 * u, 'rgba(60,80,60,.8)')
    } else if (this.mode === 'pose') {
      txt(c, POSES[this.pose].name, L.coachX, lineY, 32 * u, '#14b8a6')
      txt(c, POSES[this.pose].cue, L.coachX, line2Y, 22 * u, 'rgba(60,80,60,.8)')
    } else {
      txt(c, '放松一下', L.coachX, lineY, 30 * u, '#9a86e0')
      const next = this.seq[Math.min(this.idx + 1, this.seq.length - 1)]
      txt(c, `下一个：${POSES[next].name}`, L.coachX, line2Y, 22 * u, 'rgba(60,80,60,.8)')
    }

    // 每玩家：垫子 + 幽灵目标 + 落地小人 + 状态条
    for (let i = 0; i < 2; i++) {
      const st = this.ps[i]
      const b = this.players[i].body
      const x = L.xs[Math.min(i, L.xs.length - 1)]
      const col = this.players[i].color
      // 垫子（站点 mat：宽 T*2.7，hold 中按 held/hold 填充）
      const matW = T * 2.7
      const matH = T * 0.42
      c.fillStyle = this.rgba(col, 0.22)
      rr(c, x - matW / 2, floor - matH / 2, matW, matH, matH / 2)
      c.fill()
      c.strokeStyle = this.rgba(col, 0.5)
      c.lineWidth = 3 * u
      c.stroke()
      const prog = this.mode === 'pose' ? Math.min(1, st.held / this.cfg.hold) : st.state === 'done' ? 1 : 0
      if (prog > 0) {
        c.save()
        rr(c, x - matW / 2, floor - matH / 2, matW, matH, matH / 2)
        c.clip()
        c.fillStyle = st.state === 'done' ? 'rgba(167,243,208,.75)' : 'rgba(20,184,166,.55)'
        c.fillRect(x - matW / 2, floor - matH / 2, matW * prog, matH)
        c.restore()
      }
      // 目标幽灵（站点白色 ghost alpha .3，flip 镜像）；肩心取 floor-2.35T 让脚落地
      if (this.mode === 'pose' && st.state !== 'done' && st.state !== 'skip') {
        const spec = st.flip ? mirrorSpec(POSE_SPEC[this.pose]) : POSE_SPEC[this.pose]
        drawFigure(c, x, floor - T * 2.35, T, spec, '#ffffff', 0.3)
      }
      // 光环（站点 teal 径向渐变：入场中 / rest 态已完成）
      if (b && ((this.mode === 'pose' && st.in) || (this.mode === 'rest' && st.state === 'done'))) {
        const gy = floor - T * 1.2
        const gr = c.createRadialGradient(x, gy, T * 0.2, x, gy, T * 1.6)
        gr.addColorStop(0, 'rgba(20,184,166,.4)')
        gr.addColorStop(1, 'rgba(20,184,166,0)')
        c.fillStyle = gr
        c.beginPath()
        c.ellipse(x, gy, T * 1.6, T * 2, 0, 0, Math.PI * 2)
        c.fill()
      }
      // 落地小人（站点 se()：把玩家骨架平移到垫上、脚贴地；踝-髋差异常时按 1.12×T 折算）
      if (b) {
        const ankleDrop = Math.max(b.lFoot.y, b.rFoot.y) - b.hipC.y
        const s = Math.max(0.5, Math.min(1.6, ankleDrop > 0 ? ankleDrop / Math.max(0.05, b.scale) : 1.12))
        const hipY = floor - 0.13 * T - s * T
        const dx = x - b.hipC.x * this.W
        const dy = hipY - b.hipC.y * this.H
        const P = (p: { x: number; y: number }) => [p.x * this.W + dx, p.y * this.H + dy] as [number, number]
        const segs: [number, number][][] = [
          [P(b.lShoulder), P(b.lElbow), P(b.lHand)],
          [P(b.rShoulder), P(b.rElbow), P(b.rHand)],
          [P(b.lHip), P(b.lKnee), P(b.lFoot)],
          [P(b.rHip), P(b.rKnee), P(b.rFoot)],
          [P(b.lShoulder), P(b.rShoulder)],
          [P(b.lHip), P(b.rHip)],
          [P(b.lShoulder), P(b.lHip)],
          [P(b.rShoulder), P(b.rHip)],
        ]
        c.save()
        c.globalAlpha = 0.92
        c.strokeStyle = col
        c.lineCap = 'round'
        c.lineJoin = 'round'
        c.lineWidth = T * 0.14
        for (const seg of segs) {
          c.beginPath()
          seg.forEach(([px, py], k) => (k ? c.lineTo(px, py) : c.moveTo(px, py)))
          c.stroke()
        }
        circle(c, b.head.x * this.W + dx, b.head.y * this.H + dy, T * 0.28, col)
        c.restore()
        // mint 纠错描线（站点：未入场时描出不达标部位）
        if (this.mode === 'pose' && st.chk && !st.in && st.state !== 'done' && st.state !== 'skip') {
          c.save()
          c.strokeStyle = 'rgba(52,211,153,.9)'
          c.lineWidth = T * 0.09
          c.lineCap = 'round'
          c.lineJoin = 'round'
          const draw = (seg: [number, number][]) => {
            c.beginPath()
            seg.forEach(([px, py], k) => (k ? c.lineTo(px, py) : c.moveTo(px, py)))
            c.stroke()
          }
          if (!st.chk.arms) {
            draw(segs[0])
            draw(segs[1])
          }
          if (!st.chk.legs) {
            draw(segs[2])
            draw(segs[3])
          }
          c.restore()
        }
      } else {
        drawFigure(c, x, floor - T * 2.35, T, POSE_SPEC[this.pose], col, 0.35)
      }
      // 状态条（站点 $()：胶囊 + 进度 + 双人 emoji 徽章）
      const pw = Math.min(250 * u, this.W * 0.19)
      const ph = 44 * u
      const py = floor + 52 * u
      c.fillStyle = 'rgba(255,255,255,.85)'
      rr(c, x - pw / 2, py - ph / 2, pw, ph, ph / 2)
      c.fill()
      if (this.dual()) {
        circle(c, x - pw / 2 + ph * 0.5, py, ph * 0.4, col)
        txt(c, i === 0 ? 'P1' : 'P2', x - pw / 2 + ph * 0.5, py, ph * 0.4, '#ffffff')
      }
      const label =
        this.idx < 0
          ? '站好，深呼吸'
          : st.state === 'done'
            ? `完成 ✓ +${st.gain}`
            : st.state === 'skip'
              ? st.gain > 0
                ? `+${st.gain} 下次再稳一点`
                : '没关系，下一个'
              : !b
                ? '站到镜头前'
                : st.in
                  ? `保持 ${Math.max(0, Math.ceil(this.cfg.hold - st.held))} 秒`
                  : (st.chk?.ok ? '稳住……' : st.chk?.hint) || '摆出体式'
      const fs = (label.length > 9 ? 15 : 18) * u * (this.dual() ? 0.85 : 1)
      txt(c, label, x + (this.dual() ? ph * 0.3 : 0), py, fs, 'rgba(50,45,70,.95)')
      if (this.mode === 'pose' && st.in) {
        // 稳定度文字（站点 big 行为：>70% 绿 / >40% 橙 / 否则红）
        const stabPct = Math.round(st.stab * 100)
        const stabCol = st.stab > 0.7 ? '#1e6e18' : st.stab > 0.4 ? '#b34700' : '#c0262e'
        txt(c, st.stabN ? `稳定 ${stabPct}%` : '稳住……', x, py + 40 * u, 20 * u, stabCol)
      } else if (this.mode === 'pose' && b && st.held > 0 && st.state !== 'done' && st.state !== 'skip') {
        txt(c, '掉出来了，计时暂停', x, py + 40 * u, 18 * u, '#b34700')
      }
    }

    // 完成扩散环（站点 fx.ring）
    for (const rg of this.rings) {
      c.save()
      c.globalAlpha = 1 - rg.age / 0.6
      c.strokeStyle = '#14b8a6'
      c.lineWidth = 6 * u
      c.beginPath()
      c.arc(rg.x, rg.y, 20 + (rg.age / 0.6) * T * 1.8, 0, Math.PI * 2)
      c.stroke()
      c.restore()
    }

    // 横幅
    if (this.bannerT > 0) {
      c.save()
      c.globalAlpha = Math.min(1, this.bannerT / 0.3)
      outlineTxt(c, this.bannerText, this.W / 2, this.H * 0.24, 52, this.bannerColor)
      if (this.bannerSub) txt(c, this.bannerSub, this.W / 2, this.H * 0.24 + 44, 22, 'rgba(255,255,255,.95)')
      c.restore()
    }
  }

  private rgba(col: string, a: number) {
    const n = parseInt(col.slice(1), 16)
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
  }
}

export default function create(ctx: GameContext) {
  return new YogaGame(ctx)
}
