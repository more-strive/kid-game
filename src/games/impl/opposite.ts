import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, glow, outlineTxt, rr, star, txt } from '@/core/draw'

/**
 * 反着做（对齐逆向报告 opposite.md / 站点 game-Bm_SoTwx.js）：
 * 小喇叭喊一个动作，做**相反**的才算对（+1/条）；做成喊的那个 = 上当（不扣分，只记数）。
 * 前 4 条教学（每组相反动作各教一遍，窗口 +3s、抓错不罚），之后越来越快（heat 收缩窗口/间歇）；
 * hard 从第 6 条起有「绿色小喇叭」正着做陷阱（说=做），首次出现横幅 + 窗口 +2s。
 */

/** 难度表（报告 §1）：window 作答时限 / gap 口令间歇 / hold 静止判定时长 / still 静止阈值 / same 正着做陷阱率 / hint 提示答案 */
const DIFF = [
  { window: 3.5, gap: 1.4, hold: 1.2, still: 0.3, same: 0, hint: true },
  { window: 3, gap: 1.1, hold: 1.5, still: 0.25, same: 0, hint: false },
  { window: 2.5, gap: 0.8, hold: 1.5, still: 0.25, same: 0.3, hint: false },
]

/** 游戏内常量（报告 §1）：GRACE 口令后宽限 / WANT_T 动作确认 / TRAP_T 上当确认 */
const GRACE = 0.3
const WANT_T = 0.15
const TRAP_T = 0.2
const LEAN_T = 0.35 // 站点 motion.lean 阈值（本框架 lean=(肩心x-髋心x)/scale 换算，推断）
const OPEN_SPREAD = 1.8 // 张开手：腕距 > 1.8×躯干
const STILL_TRAP_K = 0.75 // 收尾补判：整轮静止占比 ≥ (elapsed-0.2)×0.75 判上当

/** 8 个动作、4 组相反对（报告 §1 姿势池）；OPPO = 同组取反 */
type Move = 'up' | 'squat' | 'leanL' | 'leanR' | 'jump' | 'freeze' | 'open' | 'hug'
const PAIRS: [Move, Move][] = [
  ['up', 'squat'],
  ['leanL', 'leanR'],
  ['jump', 'freeze'],
  ['open', 'hug'],
]
const OPPO: Record<Move, Move> = {
  up: 'squat',
  squat: 'up',
  leanL: 'leanR',
  leanR: 'leanL',
  jump: 'freeze',
  freeze: 'jump',
  open: 'hug',
  hug: 'open',
}
/** 站点文案表 v.name / v.doing */
const MOVE_NAME: Record<Move, string> = {
  up: '举高',
  squat: '蹲下',
  leanL: '往左歪',
  leanR: '往右歪',
  jump: '跳一跳',
  freeze: '不许动',
  open: '张开手',
  hug: '抱紧自己',
}
const MOVE_DOING: Record<Move, string> = {
  up: '举高！',
  squat: '蹲下！',
  leanL: '往左歪！',
  leanR: '往右歪！',
  jump: '跳一跳！',
  freeze: '不许动！',
  open: '张开手！',
  hug: '抱紧自己！',
}

/** 单条口令 */
interface Round {
  idx: number
  pair: number
  said: Move
  want: Move
  trap: Move
  same: boolean
  teach: boolean
  intro: boolean
  at: number
  window: number
  endAt: number | null
  laughed: boolean
  state: ('wait' | 'ok' | 'fooled' | 'late')[]
  /** 陷阱反作弊：开局已摆着陷阱姿势时先解除，离开再进入才判上当 */
  armed: boolean[]
  wantT: number[]
  trapT: number[]
  stillT: number[]
  doneAt: number[]
}

/** 动作判定（对齐站点 A()，报告 §2；up/squat 用 Body 派生布尔代理站点 armLift>0.55 / squat>0.45，推断） */
function checkMove(m: Move, b: Body, energy: number, still: number): boolean {
  const s = Math.max(0.05, b.scale)
  switch (m) {
    case 'up':
      return b.armsUp
    case 'squat':
      return b.squat
    case 'leanL':
    case 'leanR': {
      const lean = (b.shoulderC.x - b.hipC.x) / s
      return m === 'leanL' ? lean < -LEAN_T : lean > LEAN_T
    }
    case 'jump':
      return b.jumping
    case 'freeze':
      return energy < still
    case 'open':
      return Math.abs(b.lHand.x - b.rHand.x) > OPEN_SPREAD * s
    case 'hug': {
      const okWrist = (p: { x: number; y: number }) =>
        Math.abs(p.x - b.shoulderC.x) < 0.6 * s &&
        p.y > b.shoulderC.y - 0.3 * s &&
        p.y < b.shoulderC.y + 0.7 * s
      return okWrist(b.lHand) && okWrist(b.rHand)
    }
  }
}

/** 动作简笔画图标（站点 sprites 图标 f() 的本地等价自绘） */
function drawMoveIcon(c: CanvasRenderingContext2D, m: Move, x: number, y: number, size: number, alpha = 1) {
  const ink = '#4a3d5c'
  c.save()
  c.translate(x, y)
  c.scale(size / 114, size / 114)
  c.globalAlpha = alpha
  c.strokeStyle = ink
  c.lineWidth = 13
  c.lineCap = 'round'
  c.lineJoin = 'round'
  const line = (x0: number, y0: number, x1: number, y1: number) => {
    c.beginPath()
    c.moveTo(x0, y0)
    c.lineTo(x1, y1)
    c.stroke()
  }
  c.rotate(m === 'leanL' ? -0.32 : m === 'leanR' ? 0.32 : 0)
  line(0, -32, 0, 26) // 躯干
  if (m === 'up' || m === 'jump') {
    line(-12, -26, -44, -74)
    line(12, -26, 44, -74)
  } else if (m === 'open') {
    line(-12, -22, -56, -22)
    line(12, -22, 56, -22)
  } else if (m === 'hug') {
    line(-12, -18, 14, 0)
    line(12, -18, -14, 0)
  } else if (m === 'freeze') {
    line(-12, -24, -18, 12)
    line(12, -24, 18, 12)
  } else {
    line(-12, -20, -34, 8) // squat / lean 手向前下
    line(12, -20, 34, 8)
  }
  circle(c, 0, m === 'jump' ? -88 : -52, 19, ink)
  if (m === 'jump') {
    line(-4, 26, -40, 58)
    line(4, 26, 40, 58)
  } else if (m === 'squat') {
    line(-4, 26, -34, 40)
    line(-34, 40, -30, 62)
    line(4, 26, 34, 40)
    line(34, 40, 30, 62)
  } else {
    line(-4, 26, -16, 60)
    line(4, 26, 16, 60)
  }
  if (m === 'jump') {
    c.globalAlpha = alpha * 0.5
    c.lineWidth = 8
    c.beginPath()
    c.arc(0, 66, 52, Math.PI * 0.15, Math.PI * 0.85)
    c.stroke()
  }
  c.restore()
}

/** 反着做 */
class OppositeGame extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  unit = this.H / 720
  idx = 0
  /** 教学顺序（4 组洗牌，站点 rng(21)）与每条的喊法硬币 */
  teachOrder: number[]
  teachFlip: number[]
  lastPair = -1
  cur: Round | null = null
  shown: Round | null = null
  /** 下一条口令最早时刻（站点 R） */
  nextAt = 1.2
  saidSameOnce = false
  dizzy = [0, 0]
  okPop = [0, 0]
  shake = 0
  score = 0
  fooled = 0
  late = 0
  times: number[] = []
  /** 每玩家运动量（τ=0.12 指数平滑，去最快 2 关节的均值，躯干长/秒） */
  private sp: number[][] = [[], []]
  private prev: ({ x: number; y: number } | null)[][] = [[], []]
  energy = [0, 0]
  /** 横幅（站点 e.banner 代理） */
  bannerT = 0
  bannerMax = 0
  bannerText = ''
  bannerSub = ''
  bannerColor = ''
  /** 喇叭弹出动画计时（站点 z=1.4） */
  mega = 0

  constructor(ctx: GameContext) {
    super(ctx)
    const order = [0, 1, 2, 3]
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[order[i], order[j]] = [order[j], order[i]]
    }
    this.teachOrder = order
    this.teachFlip = order.map(() => Math.random())
  }

  /** 双人分屏判定（本框架按当前帧双人都有身体） */
  private dual() {
    return !!(this.players[0].body && this.players[1].body)
  }

  /** 站点 heat：局内热身度（引擎字段，推断按 45s 线性到 1，与其他已实装游戏同口径） */
  private heat() {
    return Math.min(1, this.t / 45)
  }

  /** 运动量：每关节速度指数平滑后取去掉最快 2 关节的均值（对齐站点 motion.energy 静止判定） */
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

  tick(f: PoseFrame, dt: number) {
    this.bannerT = Math.max(0, this.bannerT - dt)
    this.mega = Math.max(0, this.mega - dt * 1.4)
    this.shake = Math.max(0, this.shake - dt)
    for (let i = 0; i < 2; i++) {
      this.dizzy[i] = Math.max(0, this.dizzy[i] - dt)
      this.okPop[i] = Math.max(0, this.okPop[i] - dt)
    }

    if (!this.cur) {
      // 开新口令：间歇到了且局时剩 >1.2s（对齐站点）
      const tl = this.ctx.hud().timeLeft
      if (this.t >= this.nextAt && tl > 1.2) this.newRound()
      return
    }

    const r = this.cur
    const elapsed = this.t - r.at
    for (let i = 0; i < 2; i++) {
      const b = f.bodies[i] ?? null
      if (!b) continue
      const energy = this.updateEnergy(b, i, dt)
      if (r.state[i] !== 'wait') continue
      // 静止累计（freeze 陷阱收尾补判用）；口令后前 0.3s 不判定
      if (energy < this.cfg.still) r.stillT[i] += dt
      if (elapsed < GRACE) continue

      // want 判定
      if (r.want === 'jump') {
        if (b.jumping) {
          this.win(r, i, b)
          continue
        }
      } else {
        r.wantT[i] = checkMove(r.want, b, energy, this.cfg.still) ? r.wantT[i] + dt : 0
        if (r.wantT[i] >= (r.want === 'freeze' ? this.cfg.hold : WANT_T)) {
          this.win(r, i, b)
          continue
        }
      }
      // trap 判定（教学 / 首次正着做 / freeze 陷阱除外；freeze 陷阱收尾补判）
      if (r.teach || r.intro || r.trap === 'freeze') continue
      if (r.trap === 'jump') {
        if (b.jumping) this.fooledAt(r, i, b)
        continue
      }
      const inTrap = checkMove(r.trap, b, energy, this.cfg.still)
      if (!inTrap) r.armed[i] = true
      r.trapT[i] = inTrap && r.armed[i] ? r.trapT[i] + dt : 0
      if (r.trapT[i] >= TRAP_T) this.fooledAt(r, i, b)
    }

    // 在场玩家全部结算完 → 提前 0.55s 收尾（对齐站点）
    const alive = [0, 1].filter((i) => f.bodies[i])
    if (r.endAt === null && alive.length > 0 && alive.every((i) => r.state[i] !== 'wait')) {
      r.endAt = this.t + 0.55
    }
    if ((r.endAt !== null && this.t >= r.endAt) || elapsed >= r.window) this.close(r)
  }

  /** 开新口令（对齐站点 U()） */
  private newRound() {
    const F = this.idx
    const teach = F < 4
    let pair: number
    let said: Move
    if (teach) {
      pair = this.teachOrder[F]
      said = this.teachFlip[F] < 0.5 ? PAIRS[pair][0] : PAIRS[pair][1]
    } else {
      const pool = [0, 1, 2, 3].filter((p) => p !== this.lastPair)
      pair = pool[Math.floor(Math.random() * pool.length)] ?? 0
      said = Math.random() < 0.5 ? PAIRS[pair][0] : PAIRS[pair][1]
    }
    this.lastPair = pair
    const same = !teach && F >= 5 && Math.random() < this.cfg.same
    const intro = same && !this.saidSameOnce
    if (same) this.saidSameOnce = true
    const want = same ? said : OPPO[said]
    const trap = same ? OPPO[said] : said
    let window = teach ? this.cfg.window + 3 : intro ? this.cfg.window + 2 : this.cfg.window * (1 - 0.2 * this.heat())
    if (want === 'freeze') window = Math.max(window, GRACE + this.cfg.hold + 1)

    const r: Round = {
      idx: F,
      pair,
      said,
      want,
      trap,
      same,
      teach,
      intro,
      at: this.t,
      window,
      endAt: null,
      laughed: false,
      state: ['wait', 'wait'],
      armed: [false, false],
      wantT: [0, 0],
      trapT: [0, 0],
      stillT: [0, 0],
      doneAt: [0, 0],
    }
    for (let i = 0; i < 2; i++) {
      const b = this.players[i].body
      // 开局就摆着陷阱姿势 → 不武装，必须离开再进入（对齐站点 armed）
      r.armed[i] = !(
        b &&
        trap !== 'jump' &&
        trap !== 'freeze' &&
        checkMove(trap, b, this.energy[i], this.cfg.still)
      )
    }
    this.cur = r
    this.idx++
    this.mega = 1.4

    if (teach) {
      this.ctx.speak(`我说${MOVE_NAME[said]}，你就${MOVE_DOING[want]}`)
    } else if (intro) {
      this.banner('绿色小喇叭', '正着做：做一样的！', '#1e6e18', 1600)
      this.ctx.speak(`绿喇叭正着做，${MOVE_NAME[said]}！`)
    } else {
      this.ctx.speak(same ? `正着做，${MOVE_NAME[said]}！` : `${MOVE_NAME[said]}！`)
    }
    if (same) this.ctx.audio.good() // 站点 sparkle
    else this.ctx.audio.pop() // 站点 appear
    this.ctx.setStage(r.teach ? `学一学 ${F + 1}/4` : same ? '正着做！' : '反着做！')
  }

  /** 成功（站点 W）：+1，confetti；freeze 再加雪花 */
  private win(r: Round, i: number, b: Body) {
    r.state[i] = 'ok'
    r.doneAt[i] = this.t
    this.score++
    this.ctx.addScore(1)
    if (r.want !== 'freeze') this.times.push((this.t - r.at) * 1000)
    const hx = b.head.x * this.W
    const hy = b.head.y * this.H - 40 * this.unit
    this.particles.burst(hx, hy, '#ffd54a', 9, 320, 6)
    this.particles.burst(hx, hy, '#3ddc97', 7, 320, 5)
    if (r.want === 'freeze') this.particles.burst(hx, hy + 30 * this.unit, '#bfe6ff', 8, 260, 5)
    this.ctx.audio.win() // 站点 tada
    this.okPop[i] = 0.6
    this.pushStats()
  }

  /** 上当（站点 G）：不扣分，记数 + 头顶「上当啦！」+ 星星 + 震屏 + 头晕 */
  private fooledAt(r: Round, i: number, b: Body) {
    r.state[i] = 'fooled'
    r.doneAt[i] = this.t
    this.fooled++
    this.dizzy[i] = 1.8
    this.shake = 0.5
    const hx = b.head.x * this.W
    const hy = b.head.y * this.H
    this.say('上当啦！', hx, hy - 60 * this.unit, '#ff8f3c', 46 * this.unit)
    this.particles.burst(hx, hy, '#ffd54a', 4, 220, 7)
    this.particles.burst(hx, hy, '#ff9f1c', 4, 220, 6)
    this.ctx.audio.fail() // 站点 boing
    if (!r.laughed) {
      r.laughed = true
      const dual = this.dual()
      this.ctx.speak(dual ? `${i === 0 ? '左边' : '右边'}的小朋友上当啦！` : '哈哈，上当啦！')
    }
    this.pushStats()
  }

  /** 超时（站点 K）：教学「没关系」、正式「慢了一点」 */
  private lateAt(r: Round, i: number, b: Body) {
    r.state[i] = 'late'
    this.late++
    this.say(r.teach ? '没关系' : '慢了一点', b.head.x * this.W, b.head.y * this.H - 50 * this.unit, '#8d7ba0', 32 * this.unit)
    this.pushStats()
  }

  /** 收尾（站点 q）：还在等的玩家按陷阱类型补判，然后进入间歇 */
  private close(r: Round) {
    const elapsed = this.t - r.at
    for (let i = 0; i < 2; i++) {
      const b = this.players[i].body
      if (r.state[i] !== 'wait' || !b) continue
      if (r.trap === 'freeze' && !r.teach && !r.intro && r.stillT[i] >= (elapsed - 0.2) * STILL_TRAP_K) {
        this.fooledAt(r, i, b)
      } else {
        this.lateAt(r, i, b)
      }
    }
    this.shown = r
    this.cur = null
    this.nextAt = this.t + this.cfg.gap * (1 - 0.35 * this.heat())
    if (r.teach && r.idx === 3) {
      this.banner('学会啦！', this.dual() ? '开始反着做，越来越快哦' : '开始咯', '#7c5cff', 1700)
      this.ctx.speak('学会啦，开始咯！')
    }
  }

  /** 结算统计（站点 H：上当 / 没来得及 / 平均反应毫秒） */
  private pushStats() {
    this.ctx.setExtra('上当', this.fooled)
    this.ctx.setExtra('没来得及', this.late)
    const avg = this.times.length ? Math.round(this.times.reduce((a, z) => a + z, 0) / this.times.length) : 0
    this.ctx.setExtra('平均反应毫秒', avg)
  }

  /** 横幅（站点 e.banner 代理） */
  private banner(text: string, sub: string, color: string, ms: number) {
    this.bannerText = text
    this.bannerSub = sub
    this.bannerColor = color
    this.bannerMax = ms / 1000
    this.bannerT = this.bannerMax
  }

  paint(c: CanvasRenderingContext2D) {
    const u = this.unit
    // 震屏（站点 stage.shake(5) 的画布平移等价）
    c.save()
    if (this.shake > 0) {
      const amp = 5 * (this.shake / 0.5)
      c.translate(Math.sin(this.t * 60) * amp, Math.cos(this.t * 55) * amp * 0.6)
    }

    // 玩家头顶表现：freeze 进度环 / 成功笑脸 / 头晕星星
    const r0 = this.cur
    for (let i = 0; i < 2; i++) {
      const b = this.players[i].body
      if (!b) continue
      const hx = b.head.x * this.W
      const hy = b.head.y * this.H
      const hr = Math.max(0.045, b.scale * 0.32) * this.H
      if (r0 && r0.state[i] === 'wait' && r0.want === 'freeze' && this.t - r0.at >= GRACE) {
        const pct = Math.min(1, r0.wantT[i] / this.cfg.hold)
        const cx = b.shoulderC.x * this.W
        const cy = (b.shoulderC.y + b.scale * 0.35) * this.H
        const rad = b.scale * 1.3 * this.H
        c.save()
        c.lineCap = 'round'
        c.lineWidth = 12 * u
        c.strokeStyle = 'rgba(255,255,255,.44)'
        c.beginPath()
        c.arc(cx, cy, rad, 0, Math.PI * 2)
        c.stroke()
        c.strokeStyle = '#8fd3ff'
        c.beginPath()
        c.arc(cx, cy, rad, -Math.PI / 2, -Math.PI / 2 + pct * Math.PI * 2)
        c.stroke()
        c.restore()
      }
      if (r0 && r0.state[i] === 'ok') {
        const k = Math.max(0.05, Math.min(1, (this.t - r0.doneAt[i]) / 0.3)) // outBack 近似
        const rr0 = hr * 0.5 * k
        const ax = i === 0 ? -1 : 1
        const sx = hx + ax * hr * 1.5
        circle(c, sx, hy - hr * 0.5, rr0, '#ffe27a')
        circle(c, sx - rr0 * 0.32, hy - rr0 * 0.58, rr0 * 0.14, '#4a3d5c')
        circle(c, sx + rr0 * 0.32, hy - rr0 * 0.58, rr0 * 0.14, '#4a3d5c')
        c.strokeStyle = '#4a3d5c'
        c.lineWidth = Math.max(2, rr0 * 0.16)
        c.beginPath()
        c.arc(sx, hy - rr0 * 0.42, rr0 * 0.42, 0.15 * Math.PI, 0.85 * Math.PI)
        c.stroke()
      }
      if (this.dizzy[i] > 0) {
        c.save()
        c.globalAlpha = Math.min(1, this.dizzy[i] / 0.4)
        for (let e = 0; e < 3; e++) {
          const a = this.t * 5 + (e * Math.PI * 2) / 3
          star(c, hx + Math.cos(a) * hr * 1.2, hy - hr * 1.05 + Math.sin(a) * hr * 0.3, hr * 0.2, '#ffd54a')
        }
        c.restore()
      }
    }

    // 顶部：喇叭 + 标题（学一学 i/4 / 正着做！ / 反着做！）
    const show = r0 ?? this.shown
    const active = !!r0
    const same = show?.same ?? false
    const main = same ? '#1e6e18' : '#7c5cff'
    const label = show
      ? show.teach
        ? `学一学 ${show.idx + 1}/4`
        : same
          ? '正着做！'
          : '反着做！'
      : '反着做'
    const ex = this.dual() ? this.W / 2 : Math.max(92 * u + 24 * u, this.W * 0.13)
    const megaS = 50 * u * (active ? 1 + this.mega * 0.18 : 1 + Math.sin(this.t * 5) * 0.08)
    const tw = label.length * 30 * u
    const lx = ex - (megaS * 1.42 + tw) / 2
    c.save()
    c.translate(lx + megaS * 0.5, 116 * u)
    c.rotate(-0.12)
    c.font = `${Math.round(megaS)}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`
    c.textAlign = 'center'
    c.textBaseline = 'middle'
    c.fillText('📣', 0, 0)
    c.restore()
    outlineTxt(c, label, lx + megaS + tw / 2, 116 * u, (this.dual() ? 30 : 27) * u, main)

    if (!show) {
      this.card(c, ex, 221 * u, 184 * u, 150 * u, '#ffffff', '#8d7ba0')
      txt(c, '听好啦……', ex, 221 * u, 26 * u, '#8d7ba0')
      c.restore()
      return
    }

    const q = this.t - show.at
    const pop = active ? Math.max(0.05, Math.min(1, q / 0.3)) : 1
    const teachLike = show.teach || show.intro
    // 口令卡（站点 said 卡 184×150×unit，outBack 弹出）
    c.save()
    c.translate(ex, 221 * u)
    c.scale(pop, pop)
    if (!active) c.globalAlpha = 0.85
    this.card(c, 0, 0, 184 * u, 150 * u, '#ffffff', '#8d7ba0')
    drawMoveIcon(c, show.said, 0, -14 * u, 114 * u)
    txt(c, teachLike ? `我说${MOVE_NAME[show.said]}` : MOVE_NAME[show.said], 0, 58 * u, (this.dual() ? 24 : 22) * u, '#4a3d5c')
    c.restore()
    // = / ≠
    outlineTxt(c, same ? '=' : '≠', ex, 324 * u, 26 * u, same ? '#1e6e18' : '#7c5cff')
    // 答题卡（want 卡 435u）
    const wantY = 435 * u
    if (teachLike || !active) {
      this.card(c, ex, wantY, 184 * u, 150 * u, '#ecfbee', '#1e6e18')
      drawMoveIcon(c, show.want, ex, wantY - 14 * u, 114 * u)
      txt(c, teachLike ? `你就${MOVE_DOING[show.want]}` : MOVE_DOING[show.want], ex, wantY + 58 * u, (this.dual() ? 24 : 22) * u, '#1e6e18')
      star(c, ex + 86 * u, wantY - 69 * u, 17 * u, '#ffd54a')
    } else {
      this.card(c, ex, wantY, 184 * u, 150 * u, '#f6f0ff', '#b9a6d6')
      // easy 提示：窗口走完 45%~70% 半透明淡入答案图标（站点 hint）
      const hint = this.cfg.hint ? Math.max(0, Math.min(1, (q / show.window - 0.45) / 0.25)) * 0.45 : 0
      if (hint > 0) drawMoveIcon(c, show.want, ex, wantY - 14 * u, 114 * u, hint)
      c.save()
      c.translate(ex, wantY - 6 * u)
      c.rotate(Math.sin(this.t * 6) * 0.08)
      outlineTxt(c, '?', 0, 0, Math.round(84 * u * (1 - hint * 0.5)), same ? '#1e6e18' : '#7c5cff', 'rgba(255,255,255,.85)')
      c.restore()
    }
    // 窗口倒计时条（active 才显示）
    if (active) {
      const left = Math.max(0, 1 - q / show.window)
      const bw = 184 * u * 0.9
      const by = wantY + 75 * u + 16 * u
      c.fillStyle = 'rgba(255,255,255,.69)'
      rr(c, ex - bw / 2, by, bw, 12 * u, 6 * u)
      c.fill()
      if (left > 0) {
        c.fillStyle = left < 0.3 ? '#ff9f1c' : same ? '#3ddc97' : '#9b5de5'
        rr(c, ex - bw / 2, by, Math.max(12 * u, bw * left), 12 * u, 6 * u)
        c.fill()
      }
    }
    // 横幅（学会啦 / 绿色小喇叭）
    if (this.bannerT > 0) {
      c.save()
      c.globalAlpha = Math.min(1, this.bannerT / 0.3)
      outlineTxt(c, this.bannerText, this.W / 2, this.H * 0.34, 52, this.bannerColor)
      if (this.bannerSub) txt(c, this.bannerSub, this.W / 2, this.H * 0.34 + 44, 22, 'rgba(255,255,255,.92)')
      c.restore()
    }
    c.restore()
  }

  /** 圆角卡片（站点 u() 简化代理） */
  private card(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fill: string, stroke: string) {
    c.fillStyle = fill
    rr(c, x - w / 2, y - h / 2, w, h, 16 * this.unit)
    c.fill()
    c.strokeStyle = stroke
    c.lineWidth = 4 * this.unit
    c.stroke()
  }

  draw(c: CanvasRenderingContext2D) {
    super.draw(c)
    // 成功头顶光晕（站点 highlight 代理）
    for (let i = 0; i < 2; i++) {
      const b = this.players[i].body
      if (b && this.okPop[i] > 0) glow(c, b.head.x * this.W, b.head.y * this.H, 90, '#ffe27a', 0.25 * (this.okPop[i] / 0.6))
    }
  }
}

export default function create(ctx: GameContext) {
  return new OppositeGame(ctx)
}
