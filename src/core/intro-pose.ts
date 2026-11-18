import { lmFromCtrl, type SkeletonCtrl } from './sim'
import type { LM } from './types'

/**
 * 详情页 3D 玩法示范的动作库。
 *
 * 每个动作是一段可循环的骨架控制点动画（复用 sim 的 33 点合成，零素材零模型）；
 * 游戏 → 动作序列在 GAME_ACTIONS 里点名，没点名的按玩法类型兜底（TYPE_ACTIONS），
 * 保证 110 个游戏都有示范。想给某个游戏换动作，在 GAME_ACTIONS 加一行即可。
 */

export type ActionId =
  | 'idle'
  | 'jump'
  | 'squat'
  | 'jack'
  | 'clap'
  | 'punch'
  | 'patUp'
  | 'slash'
  | 'bow'
  | 'stretch'
  | 'run'
  | 'kick'
  | 'stomp'
  | 'balance'
  | 'blow'
  | 'pat'

interface ActionDef {
  /** 单循环时长（秒） */
  d: number
  /** p ∈ [0,1) 循环相位 → 骨架控制点 */
  fn: (p: number) => SkeletonCtrl
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k
const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
/** 平滑 0→1 */
const ease = (x: number) => (1 - Math.cos(Math.PI * clamp01(x))) / 2
/** 0→1→0 脉冲，起止为 0 */
const pulse = (x: number) => Math.sin(Math.PI * clamp01(x))
/** p 落在 [t0,t1] 段内的进度 0..1（自动截断） */
const seg = (p: number, t0: number, t1: number) => clamp01((p - t0) / (t1 - t0))

function base(over: Partial<SkeletonCtrl> = {}): SkeletonCtrl {
  const cx = over.cx ?? 0.5
  return {
    cx,
    headY: 0.205,
    shY: 0.305,
    hipY: 0.53,
    kneeY: 0.71,
    ankleY: 0.9,
    shX: 0.055,
    hipX: 0.042,
    kneeX: 0.05,
    lw: { x: cx - 0.11, y: 0.445 },
    rw: { x: cx + 0.11, y: 0.445 },
    ...over,
  }
}

const ACTIONS: Record<ActionId, ActionDef> = {
  idle: {
    d: 2.4,
    fn: (p) => {
      const s = Math.sin(p * Math.PI * 2)
      const dy = 0.006 * s
      const c = base()
      return {
        ...c,
        headY: c.headY + dy,
        shY: c.shY + dy,
        hipY: c.hipY + dy,
        lw: { x: c.lw.x, y: c.lw.y + dy - 0.006 * s },
        rw: { x: c.rw.x, y: c.rw.y + dy + 0.006 * s },
      }
    },
  },
  jump: {
    d: 1.3,
    fn: (p) => {
      // 蹲 0~0.2 → 起跳 0.2~0.34 → 腾空 0.34~0.72 → 落地缓冲 → 站直
      const crouch = p < 0.2 ? ease(p / 0.2) : p < 0.34 ? 1 - ease((p - 0.2) / 0.14) : 0
      const air = p >= 0.34 && p < 0.72 ? Math.sin(((p - 0.34) / 0.38) * Math.PI) : 0
      const land = p >= 0.72 && p < 0.9 ? 0.6 * pulse((p - 0.72) / 0.18) : 0
      const dy = 0.14 * air - 0.055 * crouch - 0.03 * land
      const c = base()
      return {
        ...c,
        headY: c.headY + dy,
        shY: c.shY + dy,
        hipY: c.hipY + dy,
        kneeY: c.kneeY + 0.05 * crouch - 0.07 * air,
        kneeX: c.kneeX + 0.03 * crouch,
        ankleY: c.ankleY - 0.06 * air,
        lw: { x: c.lw.x, y: c.lw.y + dy - 0.12 * air },
        rw: { x: c.rw.x, y: c.rw.y + dy - 0.12 * air },
      }
    },
  },
  squat: {
    d: 2.2,
    fn: (p) => {
      // 下 0~0.35 → 保持 → 起 0.6~0.95
      const k = p < 0.35 ? ease(p / 0.35) : p < 0.6 ? 1 : p < 0.95 ? 1 - ease((p - 0.6) / 0.35) : 0
      const c = base()
      const dy = 0.115 * k
      return {
        ...c,
        headY: c.headY + dy,
        shY: c.shY + dy,
        hipY: c.hipY + dy,
        kneeY: c.kneeY + 0.06 * k,
        kneeX: c.kneeX + 0.04 * k,
        lw: { x: c.cx - 0.13, y: c.shY + dy + 0.03 }, // 手前伸保持平衡
        rw: { x: c.cx + 0.13, y: c.shY + dy + 0.03 },
      }
    },
  },
  jack: {
    d: 1.5,
    fn: (p) => {
      const k = (1 - Math.cos(p * Math.PI * 2)) / 2 // 0→1→0，1 = 手脚全开
      const c = base()
      return {
        ...c,
        hipX: c.hipX + 0.055 * k,
        kneeX: c.kneeX + 0.07 * k,
        lw: { x: c.cx - 0.11 - 0.13 * k, y: c.lw.y - 0.34 * k },
        rw: { x: c.cx + 0.11 + 0.13 * k, y: c.rw.y - 0.34 * k },
      }
    },
  },
  clap: {
    d: 0.9,
    fn: (p) => {
      // 分开 → 拍合 → 分开
      const k = p < 0.45 ? ease(p / 0.45) : 1 - ease((p - 0.45) / 0.55)
      const c = base()
      const y = c.shY + 0.03 + 0.02 * Math.sin(p * Math.PI * 2)
      const x = lerp(0.16, 0.028, k)
      return { ...c, lw: { x: c.cx - x, y }, rw: { x: c.cx + x, y } }
    },
  },
  punch: {
    d: 0.8,
    fn: (p) => {
      // 左右交替出拳，打向对侧
      const q = (p * 2) % 1
      const k = pulse(q)
      const right = p < 0.5
      const c = base()
      const dy = 0.008 * Math.sin(p * Math.PI * 4)
      const homeL = { x: c.cx - 0.1, y: c.shY + 0.1 }
      const homeR = { x: c.cx + 0.1, y: c.shY + 0.1 }
      const outL = { x: c.cx + 0.07, y: c.shY + 0.05 }
      const outR = { x: c.cx - 0.07, y: c.shY + 0.05 }
      return {
        ...c,
        shY: c.shY + dy,
        lw: right ? homeL : { x: lerp(homeL.x, outL.x, k), y: lerp(homeL.y, outL.y, k) },
        rw: right ? { x: lerp(homeR.x, outR.x, k), y: lerp(homeR.y, outR.y, k) } : homeR,
      }
    },
  },
  patUp: {
    d: 1.0,
    fn: (p) => {
      // 双手举过头顶交替下拍（拍气球/泡泡）
      const s = Math.sin(p * Math.PI * 2)
      const c = base()
      return {
        ...c,
        lw: { x: c.cx - 0.09, y: c.headY - 0.07 - 0.035 * s },
        rw: { x: c.cx + 0.09, y: c.headY - 0.07 + 0.035 * s },
      }
    },
  },
  slash: {
    d: 0.7,
    fn: (p) => {
      // 右臂斜向快速挥切（切水果/挥拍）
      const k = (1 - Math.cos(p * Math.PI * 2)) / 2
      const c = base()
      const ax = lerp(c.cx + 0.24, c.cx - 0.12, k)
      const ay = lerp(c.shY - 0.16, c.shY + 0.22, k)
      return { ...c, rw: { x: ax, y: ay }, lw: { x: c.cx - 0.09, y: c.shY + 0.1 } }
    },
  },
  bow: {
    d: 3.4,
    fn: (p) => {
      // 射箭：举弓 → 拉弦 → 稳住 → 放箭 → 收势
      const raise = ease(seg(p, 0.05, 0.3)) * (1 - ease(seg(p, 0.9, 1)))
      const draw = ease(seg(p, 0.35, 0.6)) * (1 - ease(seg(p, 0.78, 0.86)))
      const rel = ease(seg(p, 0.78, 0.86)) * (1 - ease(seg(p, 0.9, 1)))
      const c = base()
      const dy = -0.012 * draw
      const lwRest = { x: c.cx - 0.11, y: 0.445 }
      const rwRest = { x: c.cx + 0.11, y: 0.445 }
      const armOut = { x: c.cx - 0.27, y: c.shY + 0.01 + dy } // 左臂端弓
      const onBow = { x: c.cx - 0.15, y: c.shY + dy } // 右手搭弦
      const cheek = { x: c.cx - 0.02, y: c.headY + 0.02 } // 拉到腮边
      const snapped = { x: c.cx + 0.13, y: c.shY + 0.09 } // 放箭后弹回
      const lw = { x: lerp(lwRest.x, armOut.x, raise), y: lerp(lwRest.y, armOut.y, raise) }
      let rw = {
        x: lerp(rwRest.x, onBow.x, raise),
        y: lerp(rwRest.y, onBow.y, raise),
      }
      rw = { x: lerp(rw.x, cheek.x, draw), y: lerp(rw.y, cheek.y, draw) }
      rw = { x: lerp(rw.x, snapped.x, rel), y: lerp(rw.y, snapped.y, rel) }
      return {
        ...c,
        headY: c.headY + dy,
        shY: c.shY + dy,
        hipY: c.hipY + dy,
        lw,
        rw,
      }
    },
  },
  stretch: {
    d: 3.2,
    fn: (p) => {
      // 双臂上举侧向拉伸（瑜伽/太极）
      const k = (1 - Math.cos(p * Math.PI * 2)) / 2
      const sway = Math.sin(p * Math.PI * 2)
      const c = base({ cx: 0.5 + 0.015 * sway })
      const dy = -0.02 * k
      return {
        ...c,
        headY: c.headY + dy,
        shY: c.shY + dy,
        hipY: c.hipY + dy,
        ankleY: c.ankleY - 0.015 * k, // 提踵
        lw: { x: c.cx - 0.075, y: lerp(0.445, c.headY - 0.1, k) },
        rw: { x: c.cx + 0.075, y: lerp(0.445, c.headY - 0.1, k) },
      }
    },
  },
  run: {
    d: 0.7,
    fn: (p) => {
      // 原地小跑：左右膝交替抬高，手臂弯曲摆动
      const kl = (1 + Math.sin(p * Math.PI * 2)) / 2
      const kr = 1 - kl
      const c = base()
      const dy = -0.012 * Math.abs(Math.sin(p * Math.PI * 2))
      return {
        ...c,
        headY: c.headY + dy,
        shY: c.shY + dy,
        hipY: c.hipY + dy,
        lKneeY: c.kneeY - 0.11 * kl,
        rKneeY: c.kneeY - 0.11 * kr,
        lAnkleY: c.ankleY - 0.12 * kl,
        rAnkleY: c.ankleY - 0.12 * kr,
        lw: { x: c.cx - 0.105, y: 0.36 + 0.09 * kl },
        rw: { x: c.cx + 0.105, y: 0.36 + 0.09 * kr },
      }
    },
  },
  kick: {
    d: 1.2,
    fn: (p) => {
      // 左右交替踢腿（正踢）
      const q = (p * 2) % 1
      const k = pulse(q)
      const left = p < 0.5
      const c = base()
      const dy = -0.01 * k
      return {
        ...c,
        headY: c.headY + dy,
        shY: c.shY + dy,
        hipY: c.hipY + dy,
        lKneeY: c.kneeY - (left ? 0.16 * k : 0),
        rKneeY: c.kneeY - (left ? 0 : 0.16 * k),
        lAnkleY: c.ankleY - (left ? 0.3 * k : 0),
        rAnkleY: c.ankleY - (left ? 0 : 0.3 * k),
        lKneeX: c.kneeX - (left ? 0.02 * k : 0),
        rKneeX: c.kneeX - (left ? 0 : 0.02 * k),
        lw: { x: c.cx - 0.14, y: c.shY + 0.06 },
        rw: { x: c.cx + 0.14, y: c.shY + 0.06 },
      }
    },
  },
  stomp: {
    d: 1.0,
    fn: (p) => {
      // 左右交替抬脚跺地（踩星星）
      const q = (p * 2) % 1
      const liftK = q < 0.5 ? ease(q / 0.5) : q < 0.65 ? clamp01(1 - (q - 0.5) / 0.15) : 0
      const left = p < 0.5
      const c = base()
      const dy = 0.012 * liftK
      return {
        ...c,
        headY: c.headY - dy,
        shY: c.shY - dy,
        hipY: c.hipY - dy,
        lKneeY: c.kneeY - (left ? 0.14 * liftK : 0),
        rKneeY: c.kneeY - (left ? 0 : 0.14 * liftK),
        lAnkleY: c.ankleY - (left ? 0.09 * liftK : 0),
        rAnkleY: c.ankleY - (left ? 0 : 0.09 * liftK),
      }
    },
  },
  balance: {
    d: 2.6,
    fn: (p) => {
      // 金鸡独立：右腿支撑，双臂平举微微晃动找平衡
      const w = Math.sin(p * Math.PI * 4)
      const c = base()
      return {
        ...c,
        lKneeY: c.kneeY - 0.06,
        lAnkleY: c.ankleY - 0.13,
        lKneeX: 0.02,
        lw: { x: c.cx - 0.27, y: c.shY + 0.012 * w },
        rw: { x: c.cx + 0.27, y: c.shY - 0.012 * w },
      }
    },
  },
  blow: {
    d: 3.0,
    fn: (p) => {
      // 双手拢在嘴边吹气（吹蜡烛/呼吸练习）
      const k = ease(seg(p, 0.05, 0.25)) * (1 - ease(seg(p, 0.72, 0.95)))
      const c = base()
      const mouthL = { x: c.cx - 0.03, y: c.headY + 0.055 }
      const mouthR = { x: c.cx + 0.03, y: c.headY + 0.055 }
      const breathe = 0.008 * Math.sin(p * Math.PI * 4) * k
      return {
        ...c,
        headY: c.headY - breathe,
        shY: c.shY - breathe,
        hipY: c.hipY - breathe,
        lw: { x: lerp(c.lw.x, mouthL.x, k), y: lerp(c.lw.y, mouthL.y, k) },
        rw: { x: lerp(c.rw.x, mouthR.x, k), y: lerp(c.rw.y, mouthR.y, k) },
      }
    },
  },
  pat: {
    d: 0.8,
    fn: (p) => {
      // 双手交替下拍（打鼓/拍球/划桨）
      const q = (p * 2) % 1
      const k = pulse(q)
      const left = p < 0.5
      const c = base()
      const dy = 0.008 * k
      return {
        ...c,
        headY: c.headY + dy,
        shY: c.shY + dy,
        hipY: c.hipY + dy,
        lw: { x: c.cx - 0.105, y: lerp(0.35, 0.47, left ? k : 1 - k) },
        rw: { x: c.cx + 0.105, y: lerp(0.35, 0.47, left ? 1 - k : k) },
      }
    },
  },
}

/** 点名编排的游戏（slug → 动作序列），其余按 TYPE_ACTIONS 兜底 */
const GAME_ACTIONS: Record<string, ActionId[]> = {
  archery: ['bow'],
  'jump-rope': ['jump'],
  'rope-count': ['jump'],
  trampoline: ['jump'],
  'long-jump': ['jump'],
  hopscotch: ['jump'],
  'squat-count': ['squat'],
  'radish-squat': ['squat'],
  'pull-carrot': ['squat'],
  'musical-chairs': ['squat'],
  'jack-count': ['jack'],
  'knee-count': ['run'],
  sprint: ['run'],
  'forest-run': ['run'],
  'swim-race': ['run'],
  hurdles: ['run', 'jump'],
  'dragon-boat': ['pat'],
  'balloon-keep': ['patUp'],
  'bubble-pop': ['patUp'],
  'star-muncher': ['patUp'],
  volley: ['patUp'],
  'air-pong': ['patUp'],
  candles: ['blow'],
  dandelion: ['blow'],
  'blow-balloon': ['blow'],
  breathing: ['blow'],
  'loud-quiet': ['blow'],
  'fruit-slash': ['slash'],
  tennis: ['slash'],
  'saw-log': ['slash'],
  shuttlecock: ['slash'],
  'touch-color': ['slash'],
  boxing: ['punch'],
  'kungfu-duel': ['punch'],
  fencing: ['punch'],
  'pillow-fight': ['punch'],
  'snowball-fight': ['punch'],
  'whack-mole': ['punch'],
  yoga: ['stretch'],
  taichi: ['stretch'],
  'photo-pose': ['stretch'],
  'star-stomp': ['stomp'],
  'clap-count': ['clap'],
  'clap-bloom': ['clap'],
  'air-drums': ['pat'],
  'air-piano': ['pat'],
  conductor: ['pat'],
  'bounce-ball': ['pat'],
  'balance-scale': ['balance'],
  'soccer-kick': ['kick'],
  dodgeball: ['squat', 'jump'],
  'laser-hall': ['jump', 'squat'],
}

/** 按玩法类型兜底的动作序列 */
const TYPE_ACTIONS: Record<string, ActionId[]> = {
  用手: ['slash', 'clap'],
  全身: ['jack', 'stretch'],
  跑跳: ['run', 'jump'],
  安静: ['blow', 'stretch'],
  动脑: ['pat', 'clap'],
  节奏: ['pat', 'clap'],
  体能: ['squat', 'jack'],
  合作: ['clap', 'jump'],
  对战: ['punch', 'clap'],
}

const DEFAULT_ACTIONS: ActionId[] = ['idle', 'clap']

/** 动作间过渡（秒） */
const FADE = 0.25

function seqFor(slug: string, types: string[]): ActionId[] {
  const named = GAME_ACTIONS[slug]
  if (named?.length) return named
  for (const t of types) {
    const byType = TYPE_ACTIONS[t]
    if (byType?.length) return byType
  }
  return DEFAULT_ACTIONS
}

/** 把可选的左右腿字段补齐成完整数值，便于插值 */
function filled(c: SkeletonCtrl): Required<SkeletonCtrl> {
  return {
    ...c,
    lKneeY: c.lKneeY ?? c.kneeY,
    rKneeY: c.rKneeY ?? c.kneeY,
    lAnkleY: c.lAnkleY ?? c.ankleY,
    rAnkleY: c.rAnkleY ?? c.ankleY,
    lKneeX: c.lKneeX ?? c.kneeX,
    rKneeX: c.rKneeX ?? c.kneeX,
  }
}

function lerpCtrl(a: SkeletonCtrl, b: SkeletonCtrl, k: number): SkeletonCtrl {
  const x = filled(a)
  const y = filled(b)
  const P = (p1: { x: number; y: number }, p2: { x: number; y: number }) => ({
    x: lerp(p1.x, p2.x, k),
    y: lerp(p1.y, p2.y, k),
  })
  return {
    cx: lerp(x.cx, y.cx, k),
    headY: lerp(x.headY, y.headY, k),
    shY: lerp(x.shY, y.shY, k),
    hipY: lerp(x.hipY, y.hipY, k),
    kneeY: lerp(x.kneeY, y.kneeY, k),
    ankleY: lerp(x.ankleY, y.ankleY, k),
    shX: lerp(x.shX, y.shX, k),
    hipX: lerp(x.hipX, y.hipX, k),
    kneeX: lerp(x.kneeX, y.kneeX, k),
    lw: P(x.lw, y.lw),
    rw: P(x.rw, y.rw),
    lKneeY: lerp(x.lKneeY, y.lKneeY, k),
    rKneeY: lerp(x.rKneeY, y.rKneeY, k),
    lAnkleY: lerp(x.lAnkleY, y.lAnkleY, k),
    rAnkleY: lerp(x.rAnkleY, y.rAnkleY, k),
    lKneeX: lerp(x.lKneeX, y.lKneeX, k),
    rKneeX: lerp(x.rKneeX, y.rKneeX, k),
  }
}

/** t 秒时刻该游戏的示范控制点（序列循环播放，动作间交叉淡化） */
export function introCtrl(slug: string, types: string[], t: number): SkeletonCtrl {
  const ids = seqFor(slug, types)
  const durs = ids.map((id) => ACTIONS[id].d)
  const cycle = durs.reduce((a, b) => a + b, 0)
  let local = ((t % cycle) + cycle) % cycle
  let i = 0
  while (local >= durs[i]) {
    local -= durs[i]
    i = (i + 1) % ids.length
  }
  const cur = ACTIONS[ids[i]].fn(local / durs[i])
  const remaining = durs[i] - local
  if (ids.length > 1 && remaining < FADE) {
    const j = (i + 1) % ids.length
    const k = 1 - remaining / FADE
    // 目标动作先走一小段，衔接更自然
    return lerpCtrl(cur, ACTIONS[ids[j]].fn(k * 0.3), k)
  }
  return cur
}

/** t 秒时刻该游戏的示范姿态（33 关键点） */
export function introPose(slug: string, types: string[], t: number): LM[] {
  return lmFromCtrl(introCtrl(slug, types, t))
}
