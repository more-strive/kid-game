import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, outlineTxt, ring, rr, txt } from '@/core/draw'

/**
 * 时钟人 / clock-arms（对齐 dongdongpark 真实规则）：
 * 伸直的手臂是长分针、弯着的是短时针——屏幕报时间，双臂摆出钟面角度并停住 0.8~1 秒 = 答对 +1 分。
 * 判定不预设哪只手当时针：枚举两种角色分配，取「角度误差/容差 + 弯臂罚分 0.6」代价最小者。
 *
 * 全部字面量沿用站点：题库分钟池（整点/整点+半点/三刻）、tolH 25/20/20、tolM 30/25/25
 * （目标近竖直 ±15° 再 +10）、hold 0.8/1/1s（中断按 2×dt 衰减）、出题 0.4s 防误判窗、
 * mini 题卡亮答案 0/5/8s、ghost 幽灵指针 3/8/11s、15s 无人答对讲解、hard 弯臂 len≤0.88×
 * （目标近竖直 ±30° 豁免）、首题固定 3:00、全对过场 1.6s / 有人对宽限 4s+收卷 0.8s / 讲解 2.4s、
 * 双针同侧与双针近竖直向下的题剔除、读数分钟步长 15/15/5。
 *
 * 与站点的差异（写明待实测）：
 * 1) 站点钟面/铃/题卡是精灵贴图，这里几何绘制；`e.big`（大屏）不存在 → 统计项恒写入；
 * 2) 双人共享一个分数（仓库口径），站点各自计分；「比快」保留为各自的 times 统计；
 * 3) t.stat 的平均用时/最快一题 → setExtra；
 * 4) ai() 演示替身未实装。
 */
interface Q {
  h: number
  m: number
  hourA: number
  minA: number
  digital: string
  cn: string
}

interface Zone {
  x0: number
  x1: number
}

interface ArmInfo {
  ang: number
  len: number
  ok: boolean
  pts: { x: number; y: number }[]
}

interface PState {
  arms: [ArmInfo, ArmInfo] | null
  judge: { ok: boolean; hourIdx: number } | null
  hold: number
  wasCorrect: boolean
  solved: boolean
  solvedAt: number
  times: number[]
  anchor: { x: number; y: number; T: number }
  ringUntil: number
  zone: Zone
}

/** 站点三档：题库分钟池 / 时针容差 / 分针容差 / 保持 / 题卡亮答案 / 幽灵指针 / 讲解 / 弯臂 / 读数步长 */
const DIFF = [
  { pool: [0], tolH: 25, tolM: 30, hold: 0.8, mini: 0, ghost: 3, skip: 15, bend: false, step: 15 },
  { pool: [0, 30], tolH: 20, tolM: 25, hold: 1, mini: 5, ghost: 8, skip: 15, bend: false, step: 15 },
  { pool: [15, 30, 45], tolH: 20, tolM: 25, hold: 1, mini: 8, ghost: 11, skip: 15, bend: true, step: 5 },
]

const NEAR_TOL_BONUS = 10 // 目标近竖直（±15°）容差加成
const BEND_RATIO = 0.88 // hard 弯臂：时针臂长 ≤ 分针臂 ×0.88
const BEND_EXEMPT = 30 // 目标时针近竖直 ±30° 豁免弯臂
const BEND_FAIL_COST = 0.6 // 角色互换代价中的弯臂罚分
const GUARD = 0.4 // 出题防误判窗（秒）
const HOLD_DECAY = 2 // 保持中断衰减倍速
const FIRST_DELAY = 0.5 // 首题延迟
const DONE_ALL = 1.6 // 全对过场
const DONE_SOME = 0.8 // 有人对收卷
const GRACE = 4 // 有人对后另一人宽限
const REVEAL_T = 2.4 // 讲解停留
const RING_T = 1.2 // 答对庆祝时长
const HOUR_LEN = 0.52 // 时针画长 ×rim
const MIN_LEN = 0.74 // 分针画长 ×rim
const PRAISE = ['对啦！', '真棒！', '答对啦！', '好厉害！']

const C = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

class ClockArms extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[0]
  pool: Q[] = []
  states: PState[] = []
  seats = 1
  private seatActive = [false, false]
  phase: 'wait' | 'ask' | 'done' | 'reveal' = 'wait'
  phaseAt = 0
  q: Q | null = null
  qStart = 0
  private firstSolvedAt = -1
  private count = 0
  private praised = 0
  private doneAll = false

  constructor(ctx: GameContext) {
    super(ctx)
    this.buildPool()
    for (let i = 0; i < 2; i++) {
      this.states.push({
        arms: null, judge: null, hold: 0, wasCorrect: false, solved: false, solvedAt: -1,
        times: [], anchor: { x: this.W / 2, y: this.H * 0.4, T: this.H * 0.2 }, ringUntil: -9,
        zone: { x0: 0, x1: this.W },
      })
    }
    this.layout()
  }

  private layout() {
    const duo = this.seats > 1
    for (let i = 0; i < 2; i++) {
      this.states[i].zone = duo
        ? { x0: (i * this.W) / 2, x1: ((i + 1) * this.W) / 2 }
        : { x0: 0, x1: this.W }
    }
  }

  /** 题库：12 小时 × 分钟池，剔双针同侧（D）与双针近竖直向下（O） */
  private buildPool() {
    const rightDeg = (a: number) => (a > 20 && a < 160 ? Math.max(0, 70 - Math.abs(a - 90)) : 0)
    const leftDeg = (a: number) => (a > 200 && a < 340 ? Math.max(0, 70 - Math.abs(a - 260)) : 0)
    for (let h = 0; h < 12; h++) {
      for (const m of this.cfg.pool) {
        const hourA = (h * 30 + m * 0.5) % 360
        const minA = m * 6
        if (Math.min(rightDeg(hourA) + leftDeg(minA), rightDeg(minA) + leftDeg(hourA)) !== 0) continue
        if (C(hourA, 180) < 40 && C(minA, 180) < 40) continue
        const hh = h === 0 ? 12 : h
        const mm = m === 0 ? '00' : String(m).padStart(2, '0')
        const cn = m === 0 ? `${hh}点整` : m === 15 ? `${hh}点一刻` : m === 30 ? `${hh}点半` : `${hh}点三刻`
        this.pool.push({ h, m, hourA, minA, digital: `${hh}:${mm}`, cn })
      }
    }
  }

  private nextQ() {
    // 首题固定 3:00（站点 j = S(3,0) 教学题）
    let q =
      this.count === 0
        ? this.pool.find((x) => x.digital === '3:00') ?? this.pool[0]
        : this.pool[Math.floor(Math.random() * this.pool.length)]
    for (let k = 0; k < 8 && this.q && q.digital === this.q.digital; k++) {
      q = this.pool[Math.floor(Math.random() * this.pool.length)]
    }
    this.q = q
    this.qStart = this.t
    this.firstSolvedAt = -1
    this.count++
    for (const st of this.states) {
      st.solved = false
      st.hold = 0
      st.wasCorrect = false
    }
    this.phase = 'ask'
    this.phaseAt = this.t
    this.ctx.audio.play('pop', 0.5, 1.2)
  }

  tick(f: PoseFrame, dt: number) {
    if (this.seats === 1 && f.bodies[1]) {
      this.seats = 2
      this.layout()
    }
    for (let i = 0; i < 2; i++) if (f.bodies[i]) this.seatActive[i] = true

    if (this.phase === 'wait') {
      if (this.t >= FIRST_DELAY) this.nextQ()
      return
    }
    if (this.phase === 'done') {
      if (this.t - this.phaseAt >= (this.doneAll ? DONE_ALL : DONE_SOME)) this.nextQ()
      return
    }
    if (this.phase === 'reveal') {
      if (this.t - this.phaseAt >= REVEAL_T) this.nextQ()
      return
    }

    // ask：逐玩家判定
    let anySolved = false
    let allSolved = true
    for (let i = 0; i < 2; i++) {
      const st = this.states[i]
      if (!this.seatActive[i]) continue // 缺席者不阻塞收卷
      this.updatePlayer(st, this.states[i], f.bodies[i] ?? null, dt, i)
      if (st.solved) {
        anySolved = true
        if (this.firstSolvedAt < 0) this.firstSolvedAt = this.t
      } else allSolved = false
    }
    const participating = this.states.some((_, i) => this.seatActive[i])
    if (!participating) return

    const since = this.t - this.qStart
    if (allSolved) {
      this.doneAll = true
      this.phase = 'done'
      this.phaseAt = this.t
      return
    }
    if (anySolved && this.firstSolvedAt >= 0 && this.t - this.firstSolvedAt >= GRACE) {
      this.doneAll = false
      this.phase = 'done'
      this.phaseAt = this.t
      return
    }
    if (since >= this.cfg.skip) {
      if (anySolved) {
        this.doneAll = false
        this.phase = 'done'
        this.phaseAt = this.t
      } else {
        this.phase = 'reveal'
        this.phaseAt = this.t
        this.ctx.audio.play('miss', 0.5, 0.7)
        if (this.q) this.ctx.speak(`没关系，是${this.q.cn}`)
      }
    }
  }

  private updatePlayer(st: PState, _all: PState, b: Body | null, dt: number, idx: number) {
    void _all
    // 锚点平滑：钟心 6/s、躯干 2/s
    const k6 = 1 - Math.exp(-dt * 6)
    const k2 = 1 - Math.exp(-dt * 2)
    if (b) {
      st.anchor.x += (b.shoulderC.x * this.W - st.anchor.x) * k6
      st.anchor.y += (b.shoulderC.y * this.H - st.anchor.y) * k6
      st.anchor.T += (Math.max(70, b.scale * this.H * 1.1) - st.anchor.T) * k2
    } else {
      const z = st.zone
      st.anchor.x += ((z.x0 + z.x1) / 2 - st.anchor.x) * k6
      st.anchor.y += (this.H * 0.4 - st.anchor.y) * k6
    }
    st.arms = b ? this.armInfo(b, st) : null
    st.judge = this.q && st.arms ? this.judge(st.arms, this.q) : null

    if (st.solved) return
    const correct = !!(st.judge?.ok && this.t - this.qStart >= GUARD)
    if (correct && !st.wasCorrect) this.ctx.audio.play('tick', 0.5, 1.4)
    st.wasCorrect = correct
    if (correct) {
      st.hold += dt
      if (st.hold >= this.cfg.hold) this.solve(st, idx)
    } else {
      st.hold = Math.max(0, st.hold - dt * HOLD_DECAY)
    }
  }

  /** 手臂角：atan2(腕x−肩x, 肩y−腕y)，0°=竖直向上顺时针；按肩屏幕 x 排序 [左臂,右臂] */
  private armInfo(b: Body, st: PState): [ArmInfo, ArmInfo] {
    const X = (n: number) => n * this.W
    const Y = (n: number) => n * this.H
    const T = st.anchor.T
    const raw = [
      { sh: b.lShoulder, wr: b.lHand },
      { sh: b.rShoulder, wr: b.rHand },
    ]
    if (X(b.lShoulder.x) > X(b.rShoulder.x)) raw.reverse()
    return raw.map((a) => {
      const sx = X(a.sh.x)
      const sy = Y(a.sh.y)
      const wx = X(a.wr.x)
      const wy = Y(a.wr.y)
      const ang = ((Math.atan2(wx - sx, sy - wy) * 180) / Math.PI + 360) % 360
      const len = Math.hypot(wx - sx, wy - sy) / T
      const ok = true // 本框架无逐点可见度：body 存在即算有效（站点 vis>0.5）
      const pts = [
        { x: sx, y: sy },
        { x: (a.sh.x * 0.3 + a.wr.x * 0.7) * this.W, y: (a.sh.y * 0.3 + a.wr.y * 0.7) * this.H },
        { x: wx, y: wy },
      ]
      return { ang, len, ok, pts }
    }) as [ArmInfo, ArmInfo]
  }

  /** 角色互换判定 R：两种「谁是时针」假设取代价最小；近竖直目标容差 +10 */
  private judge(arms: [ArmInfo, ArmInfo], q: Q): { ok: boolean; hourIdx: number } {
    const tolH = this.cfg.tolH + (C(q.hourA, 0) < 15 || C(q.hourA, 180) < 15 ? NEAR_TOL_BONUS : 0)
    const tolM = this.cfg.tolM + (C(q.minA, 0) < 15 || C(q.minA, 180) < 15 ? NEAR_TOL_BONUS : 0)
    const bendExempt = C(q.hourA, 0) < BEND_EXEMPT || C(q.hourA, 180) < BEND_EXEMPT
    let best = { ok: false, hourIdx: 0, cost: Infinity }
    for (const i of [0, 1]) {
      const j = (1 - i) as 0 | 1
      const c = C(arms[i].ang, q.hourA)
      const l = C(arms[j].ang, q.minA)
      const bendFail = this.cfg.bend && !bendExempt && arms[i].len > arms[j].len * BEND_RATIO
      const cost = c / tolH + l / tolM + (bendFail ? BEND_FAIL_COST : 0)
      const ok = c <= tolH && l <= tolM && !bendFail
      if (cost < best.cost) best = { ok, hourIdx: i, cost }
    }
    return { ok: best.ok, hourIdx: best.hourIdx }
  }

  private solve(st: PState, idx: number) {
    st.solved = true
    st.hold = this.cfg.hold
    st.solvedAt = this.t
    st.ringUntil = this.t + RING_T
    st.times.push(this.t - this.qStart)
    this.ctx.addScore(1)
    this.ctx.audio.play('win', 0.6)
    this.praised++
    if (this.praised % 3 === 0 && this.q) this.ctx.speak(`${this.q.cn}，${PRAISE[this.praised % PRAISE.length]}`)
    this.particles.burst(st.anchor.x, st.anchor.y, '#6bcb77', 12, 380, 5)
    const avg = st.times.reduce((a, b) => a + b, 0) / st.times.length
    this.ctx.setExtra(`avg${idx}`, Math.round(avg * 10) / 10)
    this.ctx.setExtra(`best${idx}`, Math.round(Math.min(...st.times) * 10) / 10)
    if (this.seats === 1 && this.q) this.say(`✓ ${this.q.digital}`, st.anchor.x, st.anchor.y - st.anchor.T * 1.1, '#6bcb77', 40)
  }

  paint(c: CanvasRenderingContext2D) {
    const duo = this.seats > 1
    if (duo) {
      c.fillStyle = 'rgba(255,255,255,.12)'
      c.fillRect(this.W / 2 - 1, 0, 2, this.H)
    }
    if (!this.q) return
    const q = this.q
    for (let i = 0; i < 2; i++) {
      if (!this.seatActive[i]) continue
      const st = this.states[i]
      const rim = Math.max(60 * (Math.min(this.W, this.H) / 720), Math.min(st.anchor.T * 1.34, (this.H - 150 * (Math.min(this.W, this.H) / 720)) / 2))
      const ax = st.anchor.x
      const ay = st.anchor.y
      const celebrating = this.t < st.ringUntil
      // 钟铃（±42°，庆祝抖动）
      for (const side of [-1, 1]) {
        const bx = ax + Math.sin((side * 42 * Math.PI) / 180 + (celebrating ? Math.sin(this.t * 55 + side) * 0.22 : 0)) * rim * 1.1
        const by = ay - Math.cos((side * 42 * Math.PI) / 180) * rim * 1.1
        circle(c, bx, by, rim * 0.12, celebrating ? '#ff8fa8' : this.players[i].color)
      }
      // 钟面
      circle(c, ax, ay, rim, '#fffdf3')
      c.strokeStyle = 'rgba(38,21,44,.35)'
      c.lineWidth = 6
      c.beginPath()
      c.arc(ax, ay, rim, 0, Math.PI * 2)
      c.stroke()
      // 数字 1~12
      c.font = `700 ${Math.max(13, rim * 0.14)}px system-ui`
      c.fillStyle = 'rgba(38,21,44,.6)'
      c.textAlign = 'center'
      c.textBaseline = 'middle'
      for (let n = 1; n <= 12; n++) {
        const a = (n * 30 * Math.PI) / 180
        c.fillText(String(n), ax + Math.sin(a) * rim * 0.86, ay - Math.cos(a) * rim * 0.86)
      }
      // 幽灵目标指针（超时未答对）
      const since = this.t - this.qStart
      if (!st.solved && since >= this.cfg.ghost && (this.phase === 'ask' || this.phase === 'reveal')) {
        const alpha = this.phase === 'reveal' ? 0.95 : 0.55 + Math.sin(this.t * 5) * 0.25
        c.globalAlpha = alpha
        this.hand(c, ax, ay, (q.hourA * Math.PI) / 180, HOUR_LEN * rim, '#ffb24d', 0.085 * rim)
        this.hand(c, ax, ay, (q.minA * Math.PI) / 180, MIN_LEN * rim, '#4cc9f0', 0.06 * rim)
        c.globalAlpha = 1
      }
      // 玩家臂画成指针（judge 选取的时针/分针角色；单臂变绿仅 easy/medium，hard 全对才绿）
      if (st.arms && st.judge) {
        const hi = st.judge.hourIdx
        const mi = (1 - hi) as 0 | 1
        const armOk = (i2: number, isHour: boolean) => {
          const tolH = this.cfg.tolH + (C(q.hourA, 0) < 15 || C(q.hourA, 180) < 15 ? NEAR_TOL_BONUS : 0)
          const tolM = this.cfg.tolM + (C(q.minA, 0) < 15 || C(q.minA, 180) < 15 ? NEAR_TOL_BONUS : 0)
          const diff = isHour ? C(st.arms![i2].ang, q.hourA) : C(st.arms![i2].ang, q.minA)
          return diff <= (isHour ? tolH : tolM)
        }
        const hourOk = armOk(hi, true)
        const minOk = armOk(mi, false)
        const greenAll = st.judge.ok && this.cfg.bend // hard 只有整套对才全绿
        this.drawArm(c, ax, ay, st.arms[hi], HOUR_LEN * rim, greenAll || (!this.cfg.bend && hourOk) ? '#6bcb77' : '#ffa94d', 0.085 * rim)
        this.drawArm(c, ax, ay, st.arms[mi], MIN_LEN * rim, greenAll || (!this.cfg.bend && minOk) ? '#6bcb77' : '#4cc9f0', 0.06 * rim)
      }
      // 保持进度环 + 钟心
      if (!st.solved && st.hold > 0) {
        ring(c, ax, ay, rim * 0.13, st.hold / this.cfg.hold, '#6bcb77', rim * 0.05)
      }
      circle(c, ax, ay, rim * 0.065, st.solved ? '#6bcb77' : '#ff5d5d')
      // 分数
      txt(c, `${st.times.length} 题`, st.zone.x1 - 16, 40, 20, this.players[i].color, 'right', 'bold')
    }

    // 题卡
    const reveal = this.phase === 'reveal'
    const solvedAll = this.states.every((s, i) => !this.seatActive[i] || s.solved)
    const showAnswer = reveal || this.t - this.qStart >= this.cfg.mini
    const cw = duo ? 360 : 230
    const ch = duo ? 150 : 190
    const cx = duo ? this.W / 2 - cw / 2 : this.states[0].anchor.x < this.W * 0.42 ? this.W - cw - 24 : 24
    const cy = duo ? this.H - ch - 24 : Math.max(90, this.states[0].anchor.y - ch / 2)
    rr(c, cx, cy, cw, ch, 16)
    c.fillStyle = 'rgba(255,253,243,.94)'
    c.fill()
    c.strokeStyle = solvedAll ? '#6bcb77' : reveal ? '#ffa94d' : '#e8dccf'
    c.lineWidth = 5
    c.stroke()
    txt(c, reveal ? '答案是' : '摆成', cx + cw / 2, cy + 30, 22, '#8b7bb5')
    txt(c, q.digital, cx + cw / 2, cy + (duo ? 76 : 86), duo ? 52 : 58, solvedAll ? '#6bcb77' : '#26152c', 'center', '900')
    txt(c, q.cn, cx + cw / 2, cy + (duo ? 118 : 146), 24, '#ff9f43')
    // 题卡小钟（mini 秒后亮答案）
    if (showAnswer) {
      const mcx = cx + cw - 46
      const mcy = cy + 34
      circle(c, mcx, mcy, 26, '#fff')
      c.strokeStyle = '#e8dccf'
      c.lineWidth = 3
      c.beginPath()
      c.arc(mcx, mcy, 26, 0, Math.PI * 2)
      c.stroke()
      const ha = (q.hourA * Math.PI) / 180
      const ma = (q.minA * Math.PI) / 180
      c.strokeStyle = '#ffa94d'
      c.lineWidth = 4
      c.beginPath()
      c.moveTo(mcx, mcy)
      c.lineTo(mcx + Math.sin(ha) * 11, mcy - Math.cos(ha) * 11)
      c.stroke()
      c.strokeStyle = '#4cc9f0'
      c.beginPath()
      c.moveTo(mcx, mcy)
      c.lineTo(mcx + Math.sin(ma) * 17, mcy - Math.cos(ma) * 17)
      c.stroke()
    }
    if (reveal) {
      outlineTxt(c, `没关系，是 ${q.cn}`, this.W / 2, this.H * 0.2, 30, '#ff9f43')
    }
  }

  private hand(c: CanvasRenderingContext2D, ax: number, ay: number, a: number, len: number, col: string, w: number) {
    c.strokeStyle = col
    c.lineWidth = w
    c.beginPath()
    c.moveTo(ax, ay)
    c.lineTo(ax + Math.sin(a) * len, ay - Math.cos(a) * len)
    c.stroke()
  }

  private drawArm(c: CanvasRenderingContext2D, ax: number, ay: number, arm: ArmInfo, len: number, col: string, w: number) {
    const a = (arm.ang * Math.PI) / 180
    c.strokeStyle = col
    c.lineWidth = w
    c.beginPath()
    c.moveTo(ax, ay)
    c.lineTo(ax + Math.sin(a) * len, ay - Math.cos(a) * len)
    c.stroke()
  }
}

export default function create(ctx: GameContext) {
  return new ClockArms(ctx)
}
