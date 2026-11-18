import { BaseGame, updateSeats } from '@/core/base'
import type { Game, GameContext, PoseFrame } from '@/core/types'
import { circle, outlineTxt, ring, txt } from '@/core/draw'

/**
 * 吹气球 / blow-balloon（对齐 dongdongpark 真实规则）：
 * 对着麦克风吹气气球变大（绿→黄→红刻度），黄区停吹 0.8 秒系好飞天 +1（正中完美区 +2），
 * 红区才停放飞失败、一路吹到满直接爆。双人是合作模式：一只共享气球、双方同分。
 *
 * 全部字面量沿用站点：吹气门限 mic > 0.15、停吹结算 0.8s、填充 grow 0.42/0.38/0.42
 * （×min(mic,.9)×(1.15−0.4n)÷limit，越满越难吹）、黄区 0.46~0.86 / 0.57~0.86 / 0.65~0.87、
 * 完美区 = 黄区正中 40% 宽（±(hi−lo)×0.2）、薄皮气球仅 hard（limit 0.74~1.12，填充快视觉小）、
 * 出生保护 0.21s、系好后 0.9s / 失败后 1.3s 出下一只、bubble 音高随填充升高、红区每 0.5s wobble、
 * teach 前 3/1/0 只进黄区语音提醒「黄啦，停！」、绿区停吹无惩罚。
 *
 * 与站点的差异（写明待实测）：
 * 1) 站点 e.mic 黑盒 → 本框架 mic.level（RMS 减噪底 ×6、EMA 12/s）；0.15/0.9 两个门限需真机校准；
 * 2) 站点精灵（气球/打气筒/量表）→ 几何绘制；e.big 状态大字统一显示；
 * 3) 双人共享一个分数（仓库口径=站点双人同分合作）；软管从各玩家头部出发；
 * 4) ai() 演示替身未实装。
 */
interface Balloon {
  id: number
  n: number
  limit: number
  deco: number
  born: number
  quiet: number
}

/** 站点三档：黄区下界 / 上界 / 填充速度 / 薄皮 / 教学只数 */
const DIFF = [
  { lo: 0.46, hi: 0.86, grow: 0.42, thin: false, teach: 3 },
  { lo: 0.57, hi: 0.86, grow: 0.38, thin: false, teach: 1 },
  { lo: 0.65, hi: 0.87, grow: 0.42, thin: true, teach: 0 },
]

const BLOW_GATE = 0.15 // 吹气判定阈值
const SETTLE = 0.8 // 停吹结算时长（秒）
const RESPAWN_TIED = 0.9 // 系好后出下一只间隔
const RESPAWN_FAIL = 1.3 // 失败后间隔
const BORN_PROT = 0.21 // 出生保护（秒）
const POP_ANIM = 0.35 // 出生弹出动画
const FIRST_AT = 0.3 // 首只气球时刻
const BUBBLE_EVERY = 0.32
const WOBBLE_EVERY = 0.5
const GREEN_IDLE_HINT = 4

type Zone2 = 'green' | 'yellow' | 'red'
type Outcome = 'tied' | 'perfect' | 'fly' | 'pop'

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

class BlowBalloon extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[0]
  balloon: Balloon | null = null
  nextAt = FIRST_AT
  seats = 1
  private seatActive = [false, false]
  /** 每个席位最后一次检测到人的时刻（配合 updateSeats 判断离场） */
  private seatSeen = [-9, -9]
  tied = 0
  perfect = 0
  overs = 0
  private rng = mulberry32(4)
  private bubbleT = 0
  private wobbleT = 0
  private idleT = 0
  private idleHintT = -10
  private taught = 0
  private firstPop = false
  private firstFly = false
  /** 飞天/放飞动画中的气球 */
  private fx: { x: number; y: number; kind: Outcome; age: number; heading: number } | null = null
  private popFx = 0
  private zonePrev: Zone2 = 'green'
  private U = Math.min(this.W, this.H) / 720

  constructor(ctx: GameContext) {
    super(ctx)
    ctx.mic.ensure().catch(() => undefined)
  }

  private zoneOf(n: number): Zone2 {
    if (n < this.cfg.lo) return 'green'
    if (n <= this.cfg.hi) return 'yellow'
    return 'red'
  }

  private spawn() {
    const thin = this.cfg.thin && this.rng() < 0.6
    this.balloon = {
      id: Math.floor(this.t * 100) + 1,
      n: 0,
      limit: thin ? 0.74 + this.rng() * 0.38 : 1,
      deco: Math.floor(this.rng() * 3),
      born: this.t,
      quiet: 0,
    }
    this.zonePrev = 'green'
    this.ctx.audio.play('pop', 0.3, 1.3)
  }

  tick(f: PoseFrame, dt: number) {
    // 吹气判定不依赖人体姿态，但气嘴软管要连到（可能有的）人头，座位按“人走了就撤座”维护
    updateSeats(this.seatActive, this.seatSeen, f.bodies, this.t)
    this.seats = Math.max(1, this.seatActive.filter(Boolean).length)
    // 结局动画推进
    if (this.popFx > 0) this.popFx -= dt
    if (this.fx) {
      this.fx.age += dt
      if (this.fx.kind === 'tied' || this.fx.kind === 'perfect') {
        this.fx.y -= (90 + this.fx.age * 110) * this.U * dt
        this.fx.x += Math.sin(this.fx.age * 2.3) * 16 * this.U * dt
        if (this.fx.y < -100) this.fx = null
      } else {
        this.fx.heading += 9 * dt
        this.fx.x += Math.cos(this.fx.heading) * 560 * this.U * dt
        this.fx.y += (-80 + Math.abs(Math.sin(this.fx.heading)) * 200) * this.U * dt
        if (this.fx.age > 1.4) this.fx = null
      }
    }

    const mic = this.ctx.mic.level
    // 生成
    if (!this.balloon && this.t >= this.nextAt) this.spawn()
    const b = this.balloon
    if (!b) return

    // 吹气填充
    const blowing = mic > BLOW_GATE && this.t - b.born > BORN_PROT
    if (blowing) {
      b.n += this.cfg.grow * Math.min(mic, 0.9) * (1.15 - 0.4 * b.n) / b.limit * dt
      b.quiet = 0
      this.idleT = 0
      this.bubbleT -= dt
      if (this.bubbleT <= 0) {
        this.bubbleT = BUBBLE_EVERY
        this.ctx.audio.play('pop', 0.2, 0.55 + b.n * 0.9)
      }
    } else {
      b.quiet += dt
      this.idleT += dt
    }

    // 分区切换提示
    const z = this.zoneOf(b.n)
    if (z !== this.zonePrev) {
      if (z === 'yellow') {
        this.ctx.audio.play('score', 0.5)
        if (b.id <= this.cfg.teach && this.taught < this.cfg.teach) {
          this.taught++
          this.say('黄啦，停！', this.W / 2, this.H * 0.2, '#ffd54a', 34)
          this.ctx.speak('黄啦，停')
        }
      } else if (z === 'red') {
        this.ctx.audio.play('tick', 0.5, 0.6)
      }
      this.zonePrev = z
    }
    if (z === 'red') {
      this.wobbleT -= dt
      if (this.wobbleT <= 0) {
        this.wobbleT = WOBBLE_EVERY
        this.ctx.audio.play('tick', 0.4, 0.5)
      }
    }
    // 绿区久等提示
    if (z === 'green' && b.quiet > GREEN_IDLE_HINT && this.t - this.idleHintT > 10) {
      this.idleHintT = this.t
      this.say('鼓起腮帮子，呼——', this.W / 2, this.H * 0.2, '#4cc9f0', 26)
    }

    // —— 结局判定（优先级：爆 > 系好/放飞）——
    const mid = (this.cfg.lo + this.cfg.hi) / 2
    const tol = (this.cfg.hi - this.cfg.lo) * 0.2
    if (b.n >= 1) {
      this.finishBalloon("pop")
      return
    }
    if (b.quiet >= SETTLE) {
      if (z === 'yellow') {
        this.finishBalloon(Math.abs(b.n - mid) <= tol ? "perfect" : "tied")
        return
      }
      if (z === 'red') {
        this.finishBalloon("fly")
        return
      }
    }

    // 统计
    this.ctx.setExtra('tied', this.tied)
    this.ctx.setExtra('perfect', this.perfect)
    this.ctx.setExtra('overs', this.overs)
  }

  private finishBalloon(kind: Outcome) {
    const bx = this.W / 2
    const by = this.H * 0.42
    this.balloon = null
    this.bubbleT = 0
    this.wobbleT = 0
    if (kind === 'pop') {
      this.popFx = 0.8
      this.overs++
      this.ctx.audio.play('miss', 0.8)
      this.particles.burst(bx, by, '#ff6b6b', 22, 380, 5)
      if (!this.firstPop) {
        this.firstPop = true
        this.say('嘭！吹太大啦，换一个', this.W / 2, this.H * 0.2, '#ff6b6b', 30)
      }
      this.nextAt = this.t + RESPAWN_FAIL
    } else if (kind === 'fly') {
      this.overs++
      this.fx = { x: bx, y: by, kind, age: 0, heading: this.rng() * 6 }
      this.ctx.audio.play('click', 0.6, 0.6)
      if (!this.firstFly) {
        this.firstFly = true
        this.say('红了才停，气球跑掉啦', this.W / 2, this.H * 0.2, '#ff9f43', 28)
      }
      this.nextAt = this.t + RESPAWN_FAIL
    } else {
      this.tied++
      this.fx = { x: bx, y: by, kind, age: 0, heading: 0 }
      if (kind === 'perfect') {
        this.perfect++
        this.ctx.addScore(2)
        this.say('正好！', bx, by - 60, '#ff9f43', 44)
        this.ctx.audio.play('win', 0.6)
      } else {
        this.ctx.addScore(1)
        this.ctx.audio.play('score', 0.6)
      }
      this.particles.burst(bx, by - 40, '#ffd54a', 14, 300, 4)
      this.nextAt = this.t + RESPAWN_TIED
    }
    this.ctx.setExtra('tied', this.tied)
    this.ctx.setExtra('perfect', this.perfect)
    this.ctx.setExtra('overs', this.overs)
  }

  paint(c: CanvasRenderingContext2D) {
    const U = this.U
    const R = Math.min(this.H * 0.2, this.W * 0.13)
    const bx = this.W / 2
    const by = this.H * 0.42
    const b = this.balloon
    // 打气筒底座
    c.fillStyle = '#5a4632'
    c.fillRect(bx - 40 * U, this.H * 0.79, 80 * U, 14 * U)
    // 软管：从玩家头到气嘴
    for (let i = 0; i < (this.seats > 1 ? 2 : 1); i++) {
      if (!this.seatActive[i]) continue
      const body = this.player(i).body
      const mouth = body ? { x: b?.id ? body.head.x * this.W : this.W / 2, y: body.head.y * this.H + 30 * U } : { x: this.W / 2, y: this.H * 0.4 }
      const nozzle = { x: bx + 30 * U, y: this.H * 0.79 }
      c.strokeStyle = 'rgba(0,0,0,.25)'
      c.lineWidth = 19 * U
      c.beginPath()
      c.moveTo(mouth.x, mouth.y)
      c.quadraticCurveTo((mouth.x + nozzle.x) / 2, Math.min(mouth.y, nozzle.y) - 60 * U, nozzle.x, nozzle.y)
      c.stroke()
      c.strokeStyle = this.players[i].color
      c.lineWidth = 12 * U
      c.stroke()
    }
    // 气球
    const drawB = (x: number, y: number, n: number, limit: number, deco: number, age: number, zone: Zone2) => {
      const born = clamp(age / POP_ANIM, 0, 1)
      const scale = 0.8 + 0.2 * born + Math.sin(born * Math.PI) * 0.08
      const rr2 = R * (0.22 + 0.78 * clamp(n, 0, 1.05) * limit) * scale
      const sway = Math.sin(this.t * 1.6) * 0.035 * rr2 + (zone === 'red' ? Math.sin(this.t * 43) * 0.05 * rr2 : 0)
      let col = '#9be15d'
      if (n > this.cfg.hi) col = '#ff6b6b'
      else if (n >= this.cfg.lo) col = '#ffd54a'
      else if (n > this.cfg.lo - 0.025) col = '#d4e88a'
      circle(c, x + sway, y, rr2, col)
      c.fillStyle = 'rgba(255,255,255,.35)'
      circle(c, x + sway - rr2 * 0.3, y - rr2 * 0.35, rr2 * 0.22, 'rgba(255,255,255,.35)')
      // 结 + 线
      c.fillStyle = '#5a4632'
      c.fillRect(x + sway - 6 * U, y + rr2, 12 * U, 8 * U)
      c.strokeStyle = 'rgba(90,70,50,.6)'
      c.lineWidth = 2
      c.beginPath()
      c.moveTo(x + sway, y + rr2 + 8 * U)
      c.lineTo(x + sway, this.H * 0.79)
      c.stroke()
      void deco
    }
    if (b) {
      const age = this.t - b.born
      const zone = this.zoneOf(b.n)
      drawB(bx, by, b.n, b.limit, b.deco, age, zone)
      // 黄区停吹进度环
      if (zone === 'yellow' && b.quiet > 0.06) {
        ring(c, bx, by - R * (0.22 + 0.78 * b.n) - 20 * U, 22 * U, b.quiet / SETTLE, '#fff', 6)
      }
      // 状态大字
      const label = zone === 'red' ? '太大啦！' : zone === 'yellow' ? (Math.abs(b.n - (this.cfg.lo + this.cfg.hi) / 2) <= (this.cfg.hi - this.cfg.lo) * 0.2 ? '正好，停！' : '停！') : b.n < 0.03 ? '开始吹' : '吹吹吹～'
      outlineTxt(c, label, bx, this.H * 0.12, 36, zone === 'red' ? '#ff5d5d' : zone === 'yellow' ? '#ffd54a' : '#9be15d')
      // 量表
      const gx = this.W - 60 * U
      const gTop = 120 * U
      const gBot = this.H - 100 * U
      const gy = (v: number) => gBot - clamp(v, 0, 1.05) * (gBot - gTop)
      c.fillStyle = 'rgba(38,21,44,.4)'
      c.fillRect(gx - 10 * U, gTop, 20 * U, gBot - gTop)
      c.fillStyle = '#ffd54a66'
      c.fillRect(gx - 10 * U, gy(this.cfg.hi), 20 * U, gy(this.cfg.lo) - gy(this.cfg.hi))
      c.fillStyle = '#fff'
      c.beginPath()
      c.moveTo(gx - 20 * U, gy(b.n))
      c.lineTo(gx - 8 * U, gy(b.n) - 7 * U)
      c.lineTo(gx - 8 * U, gy(b.n) + 7 * U)
      c.closePath()
      c.fill()
    }
    // 飞天 / 放飞动画
    if (this.fx) {
      const fade = this.fx.kind === 'fly' ? clamp(1.4 - this.fx.age, 0.3, 1) : 1
      c.globalAlpha = fade
      drawB(this.fx.x, this.fx.y, this.fx.kind === 'fly' ? 0.92 : this.cfg.hi, 1, 0, 1, this.fx.kind === 'fly' ? 'red' : 'yellow')
      c.globalAlpha = 1
    }
    // 爆炸红闪
    if (this.popFx > 0) {
      c.fillStyle = `rgba(255,60,60,${this.popFx * 0.5})`
      c.fillRect(0, 0, this.W, this.H)
      outlineTxt(c, '嘭！', this.W / 2, this.H * 0.4, 64, '#ff5d5d')
    }
    // 统计
    txt(c, `系好 ${this.tied} · 正好 ${this.perfect} · 吹过头 ${this.overs}`, 24, this.H - 20, 16, '#ffffffcc', 'left', 'bold')
  }
}

export default function create(ctx: GameContext) {
  return new BlowBalloon(ctx)
}
