import { BaseGame, PLAYER_COLORS } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, emoji, outlineTxt, rr, txt } from '@/core/draw'

/**
 * 拔河（对齐 dongdongpark 真实规则）：
 * 双手「举到胸前 → 往下压 → 甩到胯边」才算一次拉拽，两手必须在一个 0.4~0.6 秒的窗口内相继完成。
 * 绳中央的红结被拉过自己一侧的白线就赢一局，45 秒内赢几局就是几星。
 *
 * 站点原样保留的四条规则：
 * 1. 三段式行程：`c < 0.45` 举手 → 记录下压峰值速度 → `c > 0.65` 完成；光抖手或单次挥手不计分。
 * 2. 力量映射 `clamp((峰值 − 0.6) / 4, 0.3, 1)`：峰值 0.6 躯干/秒 → 0，4.6 → 1，再被下限抬到 0.3。
 * 3. 连拉疲劳：第 17 次连拉起每次 −10%，最低 40%，逼「一下一下有节奏」而不是疯狂快拉。
 * 4. 判胜后 1.5 秒冻结、绳自动回中、局数 +1，45 秒内可以打多局。
 *
 * 与站点的差异：站点用 `motion.run > 0.3` 做跑动加成，本框架只有 `hipV`（归一化/秒），
 * 这里用 `|hipV| > 1.2` 近似「在跑」；`big` 大屏模式的那套更严阈值没做（只有一套参数）。
 */

const DIFF = [
  { bullPull: 0.024, bullPeriod: 0.8 },
  { bullPull: 0.034, bullPeriod: 0.75 },
  { bullPull: 0.046, bullPeriod: 0.7 },
]

const PULL = 0.14 // 每次有效拉拽的基础位移
const UP_AT = 0.45 // 举手阈值（手高 < 0.45 躯干长即视为举起）
const BACK = 0.65 // 放下完成阈值（手高 > 0.65 躯干长）
const PAIR_GAP = 0.6 // 双手行程配对窗口（秒）
const MIN_PULL = 0.3 // 单拉力量下限
const TIRED_AFTER = 16 // 连拉疲劳起点
const BULL_K = 0.65 // 常规模式小牛力度倍率
const STREAK_GAP = 1.6 // 连拉判定间隔（秒）
const FREEZE = 1.5 // 判胜后冻结（秒）
const RUN_BOOST = 1.3 // 跑动加成

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v))
}

interface HandState {
  x: number
  y: number
  has: boolean
  /** 已「举起」，等待完成一次下压 */
  up: boolean
  /** 本次行程的最大下压速度（躯干长/秒） */
  peak: number
  /** 上一次完成行程的时刻 */
  strokeAt: number
  /** 这次行程是否已被结算 */
  used: boolean
}

interface PStat {
  pulls: number
  maxPower: number
  streak: number
  bestStreak: number
  lastPullT: number
  /** 当前显示的力量（衰减用） */
  shown: number
  praiseT: number
}

class TugOfWar extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[0]
  /** 绳位置：−1 左方胜，+1 右方胜 */
  D = 0
  round = 1
  wins: [number, number] = [0, 0]
  private bullT = 0
  private bullPose = 0
  private freeze = 0
  private ropeY = this.H * 0.55
  private banner = ''
  private bannerSub = ''
  private bannerColor = '#3ddc91'
  private bannerT = 0
  private saidPush = false
  private duo = false
  hands: HandState[][] = []
  stats: PStat[] = []

  constructor(ctx: GameContext) {
    super(ctx)
    for (let i = 0; i < 2; i++) {
      this.hands.push([0, 1].map(() => ({ x: 0, y: 0, has: false, up: false, peak: 0, strokeAt: -99, used: true })))
      this.stats.push({ pulls: 0, maxPower: 0, streak: 0, bestStreak: 0, lastPullT: -99, shown: 0, praiseT: -99 })
    }
    this.banner = '双手从胸前甩到胯边！'
    this.bannerSub = '把红布条拉过自己这边的线'
    this.bannerColor = '#ffffff'
    this.bannerT = 3
  }

  private dir(i: number) {
    return i === 0 ? -1 : 1
  }

  // ---------------------------------------------------------------- 主循环

  tick(f: PoseFrame, dt: number) {
    this.duo = f.bodies.length > 1
    if (this.bannerT > 0) this.bannerT -= dt
    this.bullPose = Math.max(0, this.bullPose - dt * 3)
    for (const st of this.stats) st.shown = Math.max(0, st.shown - dt * 1.4)

    // 绳跟着身体重心走（肩 0.4 + 胯 0.6）
    if (f.bodies.length) {
      let y = 0
      for (const b of f.bodies) y += b.shoulderC.y * this.H * 0.4 + b.hipC.y * this.H * 0.6
      y /= f.bodies.length
      this.ropeY += (y - this.ropeY) * (1 - Math.exp(-dt * 2))
    }

    if (this.freeze > 0) {
      this.freeze -= dt
      // 冻结期绳以 4/秒指数回中
      this.D += (0 - this.D) * (1 - Math.exp(-dt * 4))
      if (this.freeze <= 0) {
        this.D = 0
        this.round++
        this.bullT = 0
        for (const h of this.hands) for (const x of h) Object.assign(x, { up: false, peak: 0, strokeAt: -99, used: true })
        for (const st of this.stats) {
          st.streak = 0
          st.lastPullT = -99
        }
        this.banner = `第 ${this.round} 局`
        this.bannerSub = ''
        this.bannerColor = '#3ddc91'
        this.bannerT = 1.1
        this.ctx.audio.play('start', 0.5)
      }
      return
    }

    for (let i = 0; i < 2; i++) {
      const b = f.bodies[i] ?? null
      if (!b) continue
      if (i === 1 && !this.duo) continue
      this.stepStroke(i, b, dt)
      this.tryPull(i, b)
    }

    // 单人：小牛固定节奏往回拉
    if (!this.duo) {
      this.bullT += dt
      if (this.bullT >= this.cfg.bullPeriod) {
        this.bullT -= this.cfg.bullPeriod
        this.D += this.cfg.bullPull * BULL_K
        this.bullPose = 1
      }
      // 快被拉走时提醒一次
      if (!this.saidPush && this.D > 0.6) {
        this.saidPush = true
        this.ctx.speak('加油，使劲拉！')
      }
    }

    this.D = clamp(this.D, -1, 1)
    if (this.D <= -1) this.finishRound(0)
    else if (this.D >= 1) this.finishRound(1)

    this.publishStats()
  }

  /** 三段式行程识别 */
  private stepStroke(i: number, b: Body, dt: number) {
    const T = Math.max(0.05, b.hipC.y - b.shoulderC.y) // 归一化躯干长
    const hs = this.hands[i]
    const pts = [b.lHand, b.rHand]
    for (let k = 0; k < 2; k++) {
      const h = hs[k]
      const p = pts[k]
      const c = (p.y - b.shoulderC.y) / T // 手高，向下为正（单位=躯干长）
      if (!h.has) {
        h.x = p.x
        h.y = p.y
        h.has = true
        continue
      }
      const dx = p.x - h.x
      const dy = p.y - h.y
      const speed = Math.hypot(dx, dy) / dt / T // 躯干长/秒
      const vy = dy / dt
      h.x = p.x
      h.y = p.y

      if (c < UP_AT) {
        h.up = true
        h.peak = 0
      }
      if (h.up && vy > 0) h.peak = Math.max(h.peak, speed)
      if (c > BACK) {
        if (h.up) {
          h.strokeAt = this.t
          h.used = false
        }
        h.up = false
      }
    }
  }

  /** 两只手的行程在一个窗口内都完成 → 记一次拉拽 */
  private tryPull(i: number, b: Body) {
    const hs = this.hands[i]
    const a = hs.filter((h) => h.has && !h.used && h.strokeAt >= 0 && this.t - h.strokeAt <= PAIR_GAP)
    if (a.length < 2) return
    for (const h of a) h.used = true

    const peak = (a[0].peak + a[1].peak) / 2
    const power = clamp((peak - 0.6) / 4, MIN_PULL, 1)
    const st = this.stats[i]
    st.streak = this.t - st.lastPullT < STREAK_GAP ? st.streak + 1 : 1
    st.lastPullT = this.t
    st.pulls++
    st.bestStreak = Math.max(st.bestStreak, st.streak)
    st.maxPower = Math.max(st.maxPower, power)
    st.shown = power

    const fatigue = st.streak <= TIRED_AFTER ? 1 : Math.max(0.4, 1 - 0.1 * (st.streak - TIRED_AFTER))
    const run = Math.abs(b.hipV) > 1.2 ? RUN_BOOST : 1
    this.D += this.dir(i) * PULL * power * fatigue * run

    this.ctx.audio.play('drop', 0.25 + power * 0.45, 1.4)
    if (power > 0.9 && this.t - st.praiseT > 3) {
      st.praiseT = this.t
      const pv = this.player(i)
      this.say('好大的力气！', pv.body ? pv.body.shoulderC.x * this.W : this.W / 2, (pv.body?.shoulderC.y ?? 0.3) * this.H - 50, pv.color, 32)
    }
  }

  private finishRound(side: number) {
    this.freeze = FREEZE
    this.wins[side]++
    const human = side === 0 || this.duo
    if (human) {
      this.ctx.addScore(1)
      this.ctx.audio.win()
      this.particles.confetti(this.W, 36)
      this.banner = this.duo ? `${side === 0 ? '左边' : '右边'}赢了这局！` : '拉过线啦！'
      this.bannerSub = `第 ${this.round} 局`
      this.bannerColor = '#3ddc91'
      this.ctx.speak('赢啦！')
    } else {
      this.ctx.audio.lose()
      this.banner = '小牛赢了这局'
      this.bannerSub = '再使点劲！'
      this.bannerColor = '#c98a4b'
      this.ctx.speak('小牛赢了这局')
    }
    this.bannerT = FREEZE
    this.D = clamp(this.D, -1, 1)
  }

  private publishStats() {
    for (let i = 0; i < 2; i++) {
      const st = this.stats[i]
      if (i === 1 && !this.duo) continue
      const tag = this.duo ? `${i + 1}` : ''
      this.ctx.setExtra(`最大力量${tag}`, Math.round(st.maxPower * 100))
      this.ctx.setExtra(`拉绳次数${tag}`, st.pulls)
      this.ctx.setExtra(`最长连拉${tag}`, st.bestStreak)
    }
  }

  // ---------------------------------------------------------------- 绘制

  paint(c: CanvasRenderingContext2D) {
    const halfW = this.W * (this.duo ? 0.4 : 0.3)
    const cx = this.W / 2
    const y = this.ropeY

    // 两侧彩色界线
    for (const [sx, color] of [
      [cx - halfW, '#4cc9f0'],
      [cx + halfW, '#ff7b54'],
    ] as const) {
      c.beginPath()
      c.moveTo(sx, y - 110)
      c.lineTo(sx, y + 110)
      c.lineWidth = 8
      c.strokeStyle = color
      c.lineCap = 'round'
      c.stroke()
      // 朝中间的小三角
      c.beginPath()
      c.moveTo(sx, y - 110)
      c.lineTo(sx + (sx < cx ? 26 : -26), y - 110)
      c.lineTo(sx, y - 84)
      c.closePath()
      c.fillStyle = color
      c.fill()
    }

    // 绳
    const wave = this.t - Math.max(this.stats[0].lastPullT, this.stats[1].lastPullT) < 1 ? 1 : 0.2
    c.beginPath()
    for (let x = -10; x <= this.W + 10; x += 24) {
      const yy = y + Math.sin(x * 0.02 + this.t * 9) * (10 + Math.abs(Math.sin(this.t * 9)) * 6) * wave
      if (x === -10) c.moveTo(x, yy)
      else c.lineTo(x, yy)
    }
    c.lineWidth = 14
    c.strokeStyle = '#d8b06a'
    c.lineCap = 'round'
    c.stroke()
    c.lineWidth = 6
    c.strokeStyle = '#f0d3a0'
    c.stroke()

    // 中央虚线
    c.beginPath()
    c.moveTo(cx, y - 90)
    c.lineTo(cx, y + 90)
    c.setLineDash([16, 12])
    c.lineWidth = 5
    c.strokeStyle = 'rgba(255,255,255,.73)'
    c.stroke()
    c.setLineDash([])

    // 红结
    const kx = cx + clamp(this.D, -1, 1) * halfW
    const pop = this.freeze > 0 ? 1 + Math.sin(this.t * 20) * 0.08 : 1
    circle(c, kx, y, 26 * pop, '#ff3b5c')
    circle(c, kx, y, 14 * pop, '#ff8fa3')

    // 单人：右侧的小牛
    if (!this.duo) {
      const bx = this.W * 0.9
      const by = this.H * 0.93
      const size = Math.min(this.H * 0.34, this.W * 0.18) * (1 + this.bullPose * 0.06)
      c.save()
      c.translate(bx, by)
      c.rotate(this.bullPose * 0.16)
      emoji(c, '🐂', 0, -size * 0.42, size)
      c.restore()
      txt(c, '小牛', bx, by - 6, 24, 'rgba(255,255,255,.85)')
    }

    this.drawHud(c)

    if (this.bannerT > 0 && this.banner) {
      const a = Math.min(1, this.bannerT * 2)
      c.globalAlpha = a
      outlineTxt(c, this.banner, this.W / 2, this.H * 0.2, 62, this.bannerColor)
      if (this.bannerSub) outlineTxt(c, this.bannerSub, this.W / 2, this.H * 0.2 + 62, 30, '#ffffffd0')
      c.globalAlpha = 1
    }
  }

  private drawHud(c: CanvasRenderingContext2D) {
    const y = 150
    if (this.duo) {
      outlineTxt(c, `第 ${this.round} 局 · ${this.wins[0]} : ${this.wins[1]}`, this.W / 2, y, 30)
    } else {
      outlineTxt(c, `第 ${this.round} 局 · 你 ${this.wins[0]} : ${this.wins[1]} 小牛`, this.W * 0.26, y, 28, '#fff', undefined, 'left')
    }

    // 力量条：贴在底边
    const seats = this.duo ? [0, 1] : [0]
    for (const i of seats) {
      const st = this.stats[i]
      const x = this.duo ? (i === 0 ? 54 : this.W - 54) : 54
      const h = 150
      const bw = 34
      const by = this.H - 40 - h
      rr(c, x - bw / 2, by, bw, h, 17)
      c.fillStyle = 'rgba(18,22,55,.42)'
      c.fill()
      const shownH = h * clamp(st.shown, 0, 1)
      if (shownH > 4) {
        rr(c, x - bw / 2 + 4, by + h - shownH + 2, bw - 8, Math.max(6, shownH - 4), 12)
        c.fillStyle = PLAYER_COLORS[i]
        c.fill()
      }
      const tired = st.streak > TIRED_AFTER
      txt(c, '连拉', x, by - 42, 20, 'rgba(255,255,255,.8)')
      txt(c, tired ? '歇一下' : String(st.streak), x, by - 20, tired ? 20 : 24, tired ? '#ff6b6b' : '#fff')
    }
  }
}

export function createTugOfWar(ctx: GameContext): Game {
  return new TugOfWar(ctx)
}


export default createTugOfWar
