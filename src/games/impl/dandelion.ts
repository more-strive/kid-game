import { BaseGame } from '@/core/base'
import type { Game, GameContext, PoseFrame } from '@/core/types'
import { circle, outlineTxt, txt } from '@/core/draw'

/**
 * 吹蒲公英 / dandelion（对齐 dongdongpark 真实规则）：
 * 顶着一颗蒲公英头，对着麦克风吹气把种子吹出去——吹得久飞得远，看准「亮着的花盆」停气让种子落进去开花
 * +1（所有玩家同分）；全部开完换新一排。麦克风滞回双阈值（发射 0.15 / 维持 0.1）、松气悬停 pause 后下落、
 * 个人化吹力棘轮（平时吹得猛→分母变大同音量飞更慢，自动难度平衡）、3 连 miss 换目标盆。
 *
 * 全部字面量沿用站点：花盆数 3/4/5、位置 near 0.3/0.1/0.07 ~ far 0.92/0.93/0.95（±15% 抖动等分）、
 * 盆高 104/92/78 ×(0.92+rng×0.16)、目标容差 盆宽/2+28/16/6px（非大屏再 +12px）、
 * 吹力分母 full 1.3/1.5/1.5 ×clamp(个人均值/0.45, 0.3, 1)（棘轮：≥ 立即抬升、< 缓降 ×0.4）、
 * 悬停 pause 0.65/0.5/0.5（非大屏 +0.3s）、发射阈值 0.15/维持 0.1、弱吹检测 0.05~0.15 累计 1.2s 提示、
 * 发射需持续 0.1s、水平惯性 τ=0.12s、下坠 −300u/s（τ=0.3s）、头上 14 颗种子、
 * 3 连 miss 换目标、开花音高 0.7+u×0.5、双人轮流吹（每次落地换边）共享分数。
 *
 * 与站点的差异（写明待实测）：
 * 1) e.micRaw 黑盒 → 本框架 mic.raw（RMS 原始值）；0.15/0.1/0.05/0.45 全套量纲需真机校准；
 * 2) 精灵（角色/花盆/种子/草地）→ 几何绘制；e.big 补偿（+12px/+0.3s）恒定生效；
 * 3) 双人共享一个分数（仓库口径=站点开花所有玩家 +1）；ai() 演示替身未实装。
 */
interface Pot {
  u: number // 归一化位置 0~1（0=角色，1=屏宽 90%）
  h: number // 盆高（px）
  col: number
  bloomed: boolean
  wobble: number
}

/** 站点三档：花盆数 / 近端 / 远端 / 盆高基准 / 额外容差 / 吹力分母 / 悬停 */
const DIFF = [
  { pots: 3, near: 0.3, far: 0.92, mouth: 104, extra: 28, full: 1.3, pause: 0.65 },
  { pots: 4, near: 0.1, far: 0.93, mouth: 92, extra: 16, full: 1.5, pause: 0.5 },
  { pots: 5, near: 0.07, far: 0.95, mouth: 78, extra: 6, full: 1.5, pause: 0.5 },
]

const READY_TH = 0.15 // 发射吹气阈值
const FLY_TH = 0.1 // 飞行维持阈值（滞回）
const WEAK_TH = 0.05 // 弱吹检测
const WEAK_T = 1.2 // 弱吹提示累计（秒）
const LAUNCH_T = 0.1 // 发射需持续吹气（秒）
const INERTIA = 0.12 // 水平速度惯性 τ
const FALL_V = 300 // 下坠速度（u 域 px/s ×unit）
const NON_BIG_EXTRA = 12 // 非大屏额外容差（px）
const NON_BIG_PAUSE = 0.3 // 非大屏额外悬停
const HEAD_H = 235 // 头部离地（×unit）
const SEED_START = 245 // 种子初始高度（×unit）
const SEED_LIFT = 35 // 飞行上浮上限
const SEEDS = 14 // 头上种子数
const SPAN = 0.9 // u=1 对应屏宽 90%
const M_PER_U = 6 // u → 米
const IDLE_T = 8 // 闲置提示

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type State = 'ready' | 'fly' | 'fall'

class Dandelion extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[0]
  private U = Math.min(this.W, this.H) / 720
  pots: Pot[] = []
  potQueue: number[] = [] // 目标顺序（队首=当前目标）
  state: State = 'ready'
  seats = 1
  turn = 0
  private hold = 0
  private quiet = 0
  private weakT = 0
  private weakHintAt = -10
  private idleAt = 0
  private u = 0 // 种子水平位置（归一化）
  private vu = 0
  private alt = SEED_START * this.U
  private valt = 0
  private blowMean = 0
  private blowT = 0
  private personal = [0.45, 0.45] // 每玩家吹力基准 U（棘轮）
  private denom = 1 // 发射瞬间锁定的分母
  private prevAlt = 0
  private missStreak = 0
  private blooms = 0
  private tries: [number, number] = [0, 0]
  private hits: [number, number] = [0, 0]
  private farthest = 0
  private rowDoneAt = -10
  private hint = { text: '', at: -10 }
  private lastBlowT = 0
  private rng = mulberry32(7)

  constructor(ctx: GameContext) {
    super(ctx)
    ctx.mic.ensure().catch(() => undefined)
    this.newRow()
  }

  private newRow() {
    this.pots = []
    const n = this.cfg.pots
    for (let i = 0; i < n; i++) {
      this.pots.push({
        u: this.cfg.near + (i + 0.5 + (this.rng() - 0.5) * 0.3) * ((this.cfg.far - this.cfg.near) / n),
        h: this.cfg.mouth * (0.92 + this.rng() * 0.16) * this.U,
        col: (i * 2 + this.blooms * 3) % 5,
        bloomed: false,
        wobble: 0,
      })
    }
    // 洗牌目标顺序
    this.potQueue = this.pots.map((_, i) => i)
    for (let i = this.potQueue.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1))
      ;[this.potQueue[i], this.potQueue[j]] = [this.potQueue[j], this.potQueue[i]]
    }
  }

  private get target(): Pot | null {
    const i = this.potQueue[0]
    return i === undefined ? null : this.pots[i]
  }

  /** 角色位置（草地左端） */
  private heroX() {
    return this.W * 0.07
  }
  private groundY() {
    return this.H * 0.9
  }
  /** u → 屏幕 x */
  private uToX(u: number) {
    return this.heroX() + u * SPAN * this.W
  }

  tick(f: PoseFrame, dt: number) {
    void f
    const H = this.ctx.mic.raw // 站点 e.micRaw 口径
    const pot = this.target

    // 花盆抖动衰减
    for (const p of this.pots) if (p.wobble > 0) p.wobble -= dt

    if (this.state === 'ready') {
      if (H > READY_TH) {
        this.hold += dt
        this.idleAt = this.t
        if (this.hold >= LAUNCH_T) this.launch()
      } else if (H > FLY_TH) {
        // 余气：hold 保持
        this.idleAt = this.t
      } else {
        this.hold = 0
      }
      // 弱吹提示
      if (H > WEAK_TH && H <= READY_TH) {
        this.weakT += dt
        if (this.weakT > WEAK_T && this.t - this.weakHintAt > 6) {
          this.weakT = 0
          this.weakHintAt = this.t
          this.hint = { text: '再使劲一点，对着麦克风呼——', at: this.t }
        }
      } else this.weakT = 0
      // 闲置提示
      if (this.t - this.idleAt > IDLE_T) {
        this.idleAt = this.t
        this.hint = { text: '对着麦克风，呼～吹一口气', at: this.t }
      }
    } else if (this.state === 'fly') {
      const blowing = H > FLY_TH
      if (blowing) {
        this.quiet = 0
        this.blowMean += H * dt
        this.blowT += dt
        this.lastBlowT = this.t
      } else {
        this.quiet += dt
      }
      const targetV = blowing ? H / this.denom : 0
      this.vu += (targetV - this.vu) * (1 - Math.exp(-dt / INERTIA))
      this.u += this.vu * dt
      // 高度缓慢上浮
      this.alt = this.alt + (SEED_START * this.U + Math.min(SEED_LIFT * this.U, (this.t % 1000) * 25 * this.U) - this.alt) * Math.min(1, dt * 0.5)
      // 目标盆容差（虚线变金）
      if (pot) {
        const px = this.uToX(pot.u)
        const sx = this.uToX(this.u)
        void px
        void sx
      }
      if (this.quiet >= this.cfg.pause + NON_BIG_PAUSE) {
        this.state = 'fall'
        this.settlePersonal()
      }
      // 飞出屏幕
      if (this.uToX(this.u) > this.W + 40) this.miss('away')
    } else {
      // fall：惯性滑行 + 下坠
      this.vu += (0 - this.vu) * (1 - Math.exp(-dt / INERTIA))
      this.u += this.vu * dt
      this.valt += (-FALL_V * this.U - this.valt) * (1 - Math.exp(-dt / 0.3))
      this.prevAlt = this.alt
      this.alt += this.valt * dt
      this.checkLanding()
      if (this.uToX(this.u) > this.W + 40) this.miss('away')
    }

    // 换行
    if (this.pots.every((p) => p.bloomed) && this.rowDoneAt < 0) {
      this.rowDoneAt = this.t
      this.say('哇，花都开啦！', this.W / 2, this.H * 0.3, '#ff8fab', 34)
      this.ctx.audio.play('win', 0.6)
    }
    if (this.rowDoneAt > 0 && this.t - this.rowDoneAt > 1.5) {
      this.rowDoneAt = -10
      this.blooms = 0
      this.newRow()
      this.ctx.audio.play('pop', 0.4, 1.3)
    }

    this.ctx.setExtra('hits0', this.hits[0])
    this.ctx.setExtra('far', Math.round(this.farthest * M_PER_U * 10) / 10)
  }

  private launch() {
    this.hold = 0
    this.quiet = 0
    this.blowMean = 0
    this.blowT = 0
    this.u = 0
    this.vu = 0
    this.alt = SEED_START * this.U
    this.valt = 0
    this.tries[this.turn]++
    this.denom = this.cfg.full * clamp(this.personal[this.turn] / 0.45, 0.3, 1)
    this.state = 'fly'
    this.ctx.audio.play('click', 0.5, 0.7)
  }

  /** 个人吹力棘轮：下落开始时结算本回合吹气均值 */
  private settlePersonal() {
    if (this.blowT > 0.2) {
      const e = this.blowMean / this.blowT
      const cur = this.personal[this.turn]
      if (e >= cur) this.personal[this.turn] = e
      else this.personal[this.turn] = cur + (e - cur) * 0.4
      this.personal[this.turn] = clamp(this.personal[this.turn], 0.3 * 0.45, 1.2)
    }
  }

  /** 落地判定：穿盆冠层 */
  private checkLanding() {
    const pot = this.target
    const sx = this.uToX(this.u)
    const canopy = (_u: number, h: number) => this.groundY() - h * 0.78
    if (pot && !pot.bloomed) {
      const potX = this.uToX(pot.u)
      const top = canopy(pot.u, pot.h)
      const crossed = this.prevAlt > top && this.alt <= top
      const extra = this.cfg.extra + NON_BIG_EXTRA
      if (crossed) {
        if (Math.abs(sx - potX) <= 24 * this.U / 2 + extra) {
          this.bloom(pot)
          return
        }
      }
      // 撞非目标/目标偏移
      for (const p of this.pots) {
        if (p.bloomed) continue
        const px = this.uToX(p.u)
        const ptop = canopy(p.u, p.h)
        if (this.prevAlt > ptop && this.alt <= ptop && Math.abs(sx - px) <= 24 * this.U / 2) {
          if (p === pot) {
            this.bloom(p)
          } else {
            p.wobble = 0.8
            this.miss('wrong')
          }
          return
        }
      }
    }
    if (this.alt <= 0) {
      const targetX = pot ? this.uToX(pot.u) : this.W / 2
      this.miss(sx < targetX ? 'short' : 'long')
    }
  }

  private bloom(p: Pot) {
    p.bloomed = true
    this.blooms++
    this.missStreak = 0
    this.hits[this.turn]++
    this.farthest = Math.max(this.farthest, p.u)
    this.ctx.addScore(1)
    this.ctx.audio.play('score', 0.5, 0.7 + p.u * 0.5)
    const px = this.uToX(p.u)
    this.particles.burst(px, this.groundY() - p.h, '#ff8fab', 10, 240, 4)
    // 3 连 miss 保护与换目标无关；全开走换行
    this.endTurn()
  }

  private miss(kind: 'short' | 'long' | 'wrong' | 'away') {
    this.missStreak++
    const pot = this.target
    const tip =
      kind === 'wrong'
        ? '要亮着的花盆哦'
        : kind === 'short'
          ? this.lastBlowT > 0 && this.lastBlowT - this.stateAt < 0.7
            ? '吹长一点，呼——'
            : '再吹久一点'
          : kind === 'long'
            ? '轻一点，短一点'
            : ''
    if (tip) this.hint = { text: tip, at: this.t }
    this.ctx.audio.play('miss', 0.4, kind === 'wrong' ? 1.4 : 0.8)
    void pot
    // 3 连 miss 且未开花盆 >1 → 目标排到队尾
    if (this.missStreak >= 3 && this.pots.filter((p) => !p.bloomed).length > 1) {
      this.missStreak = 0
      const head = this.potQueue.shift()
      if (head !== undefined) this.potQueue.push(head)
    }
    this.endTurn()
  }

  private stateAt = 0

  private endTurn() {
    if (this.seats > 1) this.turn = 1 - this.turn
    this.state = 'ready'
    this.hold = 0
    this.quiet = 0
    this.u = 0
    this.vu = 0
    this.idleAt = this.t
    this.stateAt = this.t
  }

  paint(c: CanvasRenderingContext2D) {
    const U = this.U
    // 草地
    const g = c.createLinearGradient(0, 0, 0, this.H)
    g.addColorStop(0, '#8ed0f5')
    g.addColorStop(0.6, '#d8f0c0')
    g.addColorStop(1, '#8fd68a')
    c.fillStyle = g
    c.fillRect(0, 0, this.W, this.H)
    circle(c, this.W * 0.8, 60, 30, 'rgba(255,255,255,.9)')
    circle(c, this.W * 0.3, 90, 24, 'rgba(255,255,255,.85)')
    // 地面
    c.fillStyle = '#7bc47f'
    c.fillRect(0, this.groundY(), this.W, this.H - this.groundY())
    // 花盆
    for (const p of this.pots) {
      const px = this.uToX(p.u)
      const py = this.groundY()
      const wobble = p.wobble > 0 ? Math.sin(this.t * 30) * 4 : 0
      const isTarget = this.potQueue[0] !== undefined && this.pots[this.potQueue[0]] === p && !p.bloomed
      // 目标光柱
      if (isTarget) {
        c.fillStyle = `rgba(255,213,74,${0.18 + Math.sin(this.t * 4) * 0.08})`
        c.fillRect(px - 30 * U, py - p.h * 1.6, 60 * U, p.h * 1.6)
        txt(c, '▼', px, py - p.h - 26 * U + Math.sin(this.t * 5) * 4, 22 * U, p.bloomed ? '#9aa4b5' : '#ffd54a')
      }
      const pw = 44 * U
      c.fillStyle = p.bloomed ? '#c98850' : '#a9744f'
      c.beginPath()
      c.moveTo(px - pw / 2 + wobble, py - p.h)
      c.lineTo(px + pw / 2 + wobble, py - p.h)
      c.lineTo(px + pw / 2.6 + wobble, py)
      c.lineTo(px - pw / 2.6 + wobble, py)
      c.closePath()
      c.fill()
      // 开花
      if (p.bloomed) {
        const cols = ['#ff6b81', '#ffd54a', '#b088f0', '#4cc9f0', '#ff9f43']
        for (let k = 0; k < 6; k++) {
          const a = (k / 6) * Math.PI * 2 + this.t * 0.5
          circle(c, px + wobble + Math.cos(a) * 12 * U, py - p.h - 10 * U + Math.sin(a) * 12 * U, 7 * U, cols[p.col])
        }
        circle(c, px + wobble, py - p.h - 10 * U, 8 * U, '#fff2a8')
      }
    }
    // 角色 + 蒲公英头
    const hx = this.heroX()
    const headY = this.groundY() - HEAD_H * U
    const blow = clamp((this.ctx.mic.raw - 0.04) / 0.6, 0, 1)
    c.fillStyle = '#4a8a96'
    c.fillRect(hx - 20 * U, headY + 40 * U, 40 * U, this.groundY() - headY - 40 * U)
    circle(c, hx + blow * 8 * U, headY, 42 * U, '#fffdf3')
    // 头上种子点
    for (let k = 0; k < SEEDS; k++) {
      const a = (k / SEEDS) * Math.PI * 2 + this.t * 0.4
      circle(c, hx + blow * 8 * U + Math.cos(a) * 36 * U, headY + Math.sin(a) * 36 * U, 4 * U, '#ffffff')
    }
    // 呼吸线
    c.strokeStyle = `rgba(255,255,255,${0.3 + blow * 0.5})`
    c.lineWidth = 6 * U + blow * 16 * U
    c.beginPath()
    c.moveTo(hx + 30 * U, headY + 20 * U)
    c.lineTo(hx + 80 * U, headY + 10 * U)
    c.stroke()
    // 飞行中的种子
    if (this.state !== 'ready') {
      const sx = this.uToX(this.u)
      const sy = this.groundY() - this.alt
      const pot = this.target
      const inTol = pot && Math.abs(sx - this.uToX(pot.u)) <= (24 * U) / 2 + this.cfg.extra + NON_BIG_EXTRA
      // 瞄准垂线
      c.strokeStyle = inTol ? '#ffd54a' : 'rgba(255,255,255,.6)'
      c.setLineDash([6, 8])
      c.beginPath()
      c.moveTo(sx, sy)
      c.lineTo(sx, this.groundY())
      c.stroke()
      c.setLineDash([])
      circle(c, sx, sy, 16 * U, '#fffdf3')
      circle(c, sx + 5 * U, sy - 5 * U, 3 * U, '#cccccc')
    }
    // 提示
    if (this.t - this.hint.at < 2.5 && this.hint.text) {
      outlineTxt(c, this.hint.text, this.W / 2, this.H * 0.14, 26, '#4cc9f0')
    }
    // 目标距离牌
    const pot = this.target
    if (pot) {
      txt(c, `${(pot.u * M_PER_U).toFixed(1)} 米`, this.uToX(pot.u), this.groundY() + 26 * U, 16 * U, '#26152c', 'center', 'bold')
    }
    txt(c, `开花 ${this.blooms}`, 24, 40, 20, '#26152c', 'left', 'bold')
  }
}

export default function create(ctx: GameContext) {
  return new Dandelion(ctx)
}
