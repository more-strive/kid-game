import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { emoji, glow, outlineTxt, rr, star, txt } from '@/core/draw'

/**
 * 快枪手（对齐 dongdongpark 真实规则）：
 * 两人站定、手放下别动，等「开枪！」信号一出立刻把手举过头顶，先举的赢这一轮；
 * 中间穿插假信号（鸟叫 / 风滚草），提前动或提前举手算抢跑，直接输掉该轮。
 * 单人时 1 号席位由仙人掌顶替（反应 cpu×[0.8,1.3]，会被假信号骗到抢跑）。
 *
 * 与站点的差异：站点读 motion.energy 判断"在动"，本框架用手的归一化速度 + 髋部速度代理，
 * still 阈值沿用站点字面量，真机手感需要实测校准（见 _reverse/reports/quick-draw.md §8）。
 */
type Phase = 'ready' | 'wait' | 'signal' | 'result'

/** 对齐站点难度表：cpu 反应 / 假信号被骗概率 / 等待区间 / 假信号个数 / 静止阈值 */
const DIFF = [
  { cpu: 0.35, fooled: 0.25, wait: [2.0, 4.5], fakes: 1, still: 0.55 },
  { cpu: 0.25, fooled: 0.1, wait: [2.0, 5.0], fakes: 2, still: 0.5 },
  { cpu: 0.18, fooled: 0.03, wait: [2.5, 5.5], fakes: 2, still: 0.45 },
]

const GROUP = 5 // 每 5 轮结算一组
const READY_MIN = 1.3 // ready 最短停留
const READY_MAX = 3.8 // 兜底强制开始
const WAIT_GRACE = 0.5 // wait 开头 0.5s 不判抢跑
const RESULT = 2.3 // result 停留
const SIGNAL_MAX = 2.0 // signal 最长
const TWITCH = 0.12 // 抢跑累积阈值（秒）
const LEAD_MS = 800 // 领先 800ms 提前结算

interface Seat {
  human: boolean
  armed: boolean
  twitch: number
  /** 反应毫秒，-1 = 未出手 */
  react: number
  falseStart: boolean
  wins: number
  setWins: number
}

interface Fake {
  kind: 'bird' | 'weed'
  at: number
  t: number
  fired: boolean
  dir: number
}

class QuickDraw extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[0]
  phase: Phase = 'ready'
  k = 0
  round = 1
  group = 1
  seats: Seat[] = [
    { human: true, armed: false, twitch: 0, react: -1, falseStart: false, wins: 0, setWins: 0 },
    { human: false, armed: false, twitch: 0, react: -1, falseStart: false, wins: 0, setWins: 0 },
  ]
  fakes: Fake[] = []
  private waitLen = 3
  private cpuReact = 0.3
  private winner: number | null = null
  private flash = 0
  private ring = 0
  private cpuArm = 0
  private banner = ''
  private groupT = 0

  tick(f: PoseFrame, dt: number) {
    this.k += dt
    this.flash = Math.max(0, this.flash - dt * 2.5)
    this.ring = Math.min(1, this.ring + dt * 1.6)
    this.cpuArm = Math.max(0, this.cpuArm - dt * 3)
    for (const fs of this.fakes) fs.t += dt

    // 第二席位是否存在真人
    this.seats[1].human = !!f.bodies[1]

    if (this.phase === 'ready') return this.tickReady(f)
    if (this.phase === 'wait') return this.tickWait(f, dt)
    if (this.phase === 'signal') return this.tickSignal(f)
    if (this.k >= RESULT + (this.groupT > 0 ? 2.4 : 0)) this.nextRound()
  }

  private tickReady(f: PoseFrame) {
    const seated = this.seats.every((s, i) => {
      if (!s.human) return true
      const b = f.bodies[i]
      return !!b && this.handsDown(b)
    })
    if ((this.k >= READY_MIN && seated) || this.k > READY_MAX) this.startWait()
  }

  private startWait() {
    this.phase = 'wait'
    this.k = 0
    this.banner = ''
    const [a, b] = this.cfg.wait
    this.waitLen = a + Math.random() * (b - a)
    this.seats.forEach((s) => {
      s.armed = false
      s.twitch = 0
      s.react = -1
      s.falseStart = false
    })
    this.winner = null
    this.fakes = []
    const n = Math.floor(Math.random() * (this.cfg.fakes + 1))
    for (let i = 0; i < n; i++) {
      this.fakes.push({
        kind: Math.random() < 0.5 ? 'bird' : 'weed',
        at: 0.7 + Math.random() * Math.max(0.3, this.waitLen - 1.6),
        t: 0,
        fired: false,
        dir: Math.random() < 0.5 ? 1 : -1,
      })
    }
  }

  private tickWait(f: PoseFrame, dt: number) {
    for (const fs of this.fakes) {
      if (fs.fired || this.k < fs.at) continue
      fs.fired = true
      this.ctx.audio.play(fs.kind === 'bird' ? 'pop' : 'drop', 0.5, fs.kind === 'bird' ? 1.7 : 0.8)
      // 单人模式：仙人掌有概率被假信号骗到抢跑
      if (!this.seats[1].human && Math.random() < this.cfg.fooled) {
        this.seats[1].falseStart = true
        this.endRound(1, '上当了！')
        return
      }
    }

    for (let i = 0; i < 2; i++) {
      const s = this.seats[i]
      const b = f.bodies[i]
      if (!s.human || !b) continue
      if (!s.armed && this.handsDown(b)) s.armed = true
      if (!s.armed || this.k < WAIT_GRACE) continue
      const moving = this.energy(b) > this.cfg.still || this.handsUp(b)
      s.twitch = moving ? s.twitch + dt : Math.max(0, s.twitch - 2 * dt)
      if (s.twitch >= TWITCH) {
        s.falseStart = true
        this.endRound(i, '抢跑！')
        return
      }
    }

    if (this.k >= this.waitLen) {
      this.phase = 'signal'
      this.k = 0
      this.flash = 1
      this.ring = 0
      this.ctx.audio.play('score', 1, 1.1)
      this.ctx.audio.play('combo', 0.8)
      this.cpuReact = this.cfg.cpu * (0.8 + Math.random() * 0.5)
      this.seats.forEach((s) => (s.react = -1))
      this.ctx.speak('开枪')
    }
  }

  private tickSignal(f: PoseFrame) {
    for (let i = 0; i < 2; i++) {
      const s = this.seats[i]
      if (s.react >= 0) continue
      if (!s.human) {
        if (this.k >= this.cpuReact) {
          s.react = Math.round(this.cpuReact * 1000)
          this.cpuArm = 1
        }
        continue
      }
      const b = f.bodies[i]
      if (b && this.handsUp(b)) {
        s.react = Math.round(this.k * 1000)
        this.ctx.audio.play('pop', 0.7, 1.4)
        this.say(`${s.react} 毫秒`, this.W / 2, 200 + i * 90, '#fff36b', 40)
      }
    }

    const reacts = this.seats.map((s) => s.react)
    const ready = reacts.every((r) => r >= 0)
    const fastest = Math.min(...reacts.filter((r) => r >= 0))
    const lead = reacts.some((r) => r >= 0) && this.k * 1000 - fastest > LEAD_MS
    if (ready || lead || this.k > SIGNAL_MAX) this.endRound(null, '')
  }

  /** 结算一轮。busted 非空 = 该席位抢跑判负 */
  private endRound(busted: number | null, why: string) {
    this.phase = 'result'
    this.k = 0
    const humanIdx = this.seats.map((s, i) => (s.human ? i : -1)).filter((i) => i >= 0)
    if (busted !== null) {
      this.winner = humanIdx.find((i) => i !== busted) ?? -1
      this.seats[busted].falseStart = true
      this.ctx.audio.fail()
      this.banner = `${this.seatName(busted)}${why}`
    } else {
      const r0 = this.seats[0].react
      const r1 = this.seats[1].react
      if (r0 < 0 && r1 < 0) {
        this.winner = -1
        this.banner = '都太慢了…'
      } else if (r0 < 0) this.winner = 1
      else if (r1 < 0) this.winner = 0
      else this.winner = r0 <= r1 ? 0 : 1 // 平手判 0 号席位（对齐站点）
      this.banner = this.winner < 0 ? '都太慢了…' : `${this.seatName(this.winner)}赢啦！`
      if (this.winner >= 0) {
        this.ctx.audio.coin()
        const w = this.winner
        this.particles.burst(this.W / 2, this.H * 0.4, '#ffd54a', 16, 380, 5)
        // HUD 只有一个总分：任一真人赢下一轮都记 1 分（双人时视为合计胜利数）
        if (this.seats[w].human) this.ctx.addScore(1)
      }
    }

    if (this.winner >= 0) {
      const seat = this.seats[this.winner]
      seat.wins++
      seat.setWins++
      if (seat.setWins >= GROUP) {
        this.groupT = 1
        this.banner = `第 ${this.group} 组：${this.seatName(0)} ${this.seats[0].setWins} 比 ${this.seats[1].setWins} ${this.seatName(1)}`
      }
    }
    const w = this.winner
    this.ctx.setCombo(w !== null && w >= 0 ? this.seats[w].wins : 0)
  }

  private nextRound() {
    if (this.groupT > 0) {
      this.group++
      this.groupT = 0
      this.seats.forEach((s) => (s.setWins = 0))
    }
    this.round++
    this.phase = 'ready'
    this.k = 0
    this.banner = ''
    this.winner = null
  }

  private seatName(i: number) {
    if (!this.seats[i].human) return '仙人掌'
    return i === 0 ? '你' : '对手'
  }

  private torso(b: Body) {
    return Math.max(40, b.scale * this.H * 1.1)
  }

  /** 任一手高于头顶 0.1T */
  private handsUp(b: Body) {
    const T = this.torso(b)
    return Math.min(b.lHand.y, b.rHand.y) * this.H < b.head.y * this.H - 0.1 * T
  }

  /** 双手都低于肩线 0.1T */
  private handsDown(b: Body) {
    const T = this.torso(b)
    const line = b.shoulderC.y * this.H - 0.1 * T
    return b.lHand.y * this.H > line && b.rHand.y * this.H > line
  }

  /** "在动"的代理量：手速 + 髋部速度（站点用 motion.energy） */
  private energy(b: Body) {
    return Math.max(b.lHandV, b.rHandV) + b.hipV * 0.5
  }

  paint(c: CanvasRenderingContext2D) {
    // 暖色沙地
    c.fillStyle = 'rgba(255,179,71,.14)'
    c.fillRect(0, 0, this.W, this.H)
    const g = c.createRadialGradient(this.W / 2, this.H / 2, this.H * 0.2, this.W / 2, this.H / 2, this.H * 0.8)
    g.addColorStop(0, 'rgba(0,0,0,0)')
    g.addColorStop(1, 'rgba(60,30,10,.35)')
    c.fillStyle = g
    c.fillRect(0, 0, this.W, this.H)
    c.fillStyle = 'rgba(242,207,138,.33)'
    c.fillRect(0, this.H * 0.86, this.W, this.H * 0.14)

    // 假信号
    for (const fs of this.fakes) {
      if (!fs.fired) continue
      const p = Math.min(1, fs.t / 2.6)
      if (p >= 1) continue
      const x = fs.kind === 'bird' ? (fs.dir > 0 ? -40 + p * (this.W + 80) : this.W + 40 - p * (this.W + 80)) : this.W / 2 + Math.sin(p * 10) * 120
      const y = fs.kind === 'bird' ? this.H * 0.22 + Math.sin(p * 22) * 22 : this.H * 0.8 + Math.abs(Math.sin(p * 12)) * -30
      c.globalAlpha = Math.min(1, (1 - p) * 3)
      emoji(c, fs.kind === 'bird' ? '🐦' : '🌾', x, y, 46)
      c.globalAlpha = 1
    }

    // 顶部提示条
    const tip =
      this.phase === 'ready'
        ? '手放下，站好'
        : this.phase === 'wait'
          ? '别动…等信号'
          : this.phase === 'signal'
            ? '举手！'
            : this.banner
    const w = Math.max(300, tip.length * 34 + 90)
    rr(c, this.W / 2 - w / 2, 52, w, 62, 31)
    c.fillStyle = 'rgba(12,18,42,.6)'
    c.fill()
    outlineTxt(c, tip, this.W / 2, 83, 34, this.phase === 'signal' ? '#fff36b' : '#fff')

    // 信号闪白 + 光环
    if (this.flash > 0) {
      c.fillStyle = `rgba(255,255,255,${this.flash * 0.55})`
      c.fillRect(0, 0, this.W, this.H)
    }
    if (this.phase === 'signal') {
      c.strokeStyle = `rgba(255,243,120,${1 - this.ring})`
      c.lineWidth = 10
      c.beginPath()
      c.arc(this.W / 2, this.H / 2, this.H * 0.22 * this.ring, 0, Math.PI * 2)
      c.stroke()
      outlineTxt(c, '开枪！', this.W / 2, this.H / 2, 72, '#ff4d6d')
    }

    // 仙人掌
    if (!this.seats[1].human) {
      const x = this.W * 0.86
      const y = this.H * 0.9
      emoji(c, '🌵', x, y - 40, 120)
      emoji(c, this.cpuArm > 0.05 ? '🙌' : '🌵', x, y - 140 - this.cpuArm * 30, 56)
    }

    // 双席位牌
    for (let i = 0; i < 2; i++) {
      const s = this.seats[i]
      if (!s.human && i === 1) continue
      const bw = 260
      const bx = i === 0 ? 40 : this.W - 40 - bw
      const by = this.H - 108
      rr(c, bx, by, bw, 74, 18)
      c.fillStyle = 'rgba(12,18,42,.6)'
      c.fill()
      c.strokeStyle = i === 0 ? '#ffd54a' : '#4cc9f0'
      c.lineWidth = 3
      c.stroke()
      txt(c, i === 0 ? '你' : '对手', bx + 18, by + 26, 22, '#fff', 'left', 'bold')
      const ms = s.react
      const label = s.falseStart ? '抢跑' : ms >= 0 ? `${ms} 毫秒` : '—'
      txt(c, label, bx + bw - 18, by + 26, 22, s.falseStart ? '#ff6b8a' : '#fff9', 'right', 'bold')
      for (let k = 0; k < GROUP; k++) {
        const on = k < s.setWins
        c.globalAlpha = on ? 1 : 0.25
        star(c, bx + 30 + k * 30, by + 54, 11, on ? '#ffd54a' : '#ffffff')
        c.globalAlpha = 1
      }
    }

    txt(c, `第 ${this.group} 组 · 第 ${this.round} 轮`, this.W / 2, this.H - 24, 20, 'rgba(255,255,255,.75)', 'center', 'bold')
    if (this.phase === 'wait') glow(c, this.W / 2, this.H * 0.3, 200, '#ffb347', 0.12)
  }
}

export default function create(ctx: GameContext) {
  return new QuickDraw(ctx)
}
