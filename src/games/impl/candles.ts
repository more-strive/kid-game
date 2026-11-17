import { BaseGame } from '@/core/base'
import type { Game, GameContext, PoseFrame } from '@/core/types'
import { circle, outlineTxt, txt } from '@/core/draw'

/**
 * 吹蜡烛 / candles（对齐 dongdongpark 真实规则）：
 * 对着麦克风吹气，蓄力条充满吹灭一根蛋糕上的蜡烛 +1 分；调皮蜡烛 0.9~1.7 秒后自己复燃（送分陷阱）；
 * 一口气连吹第 2 根起蓄力线每次 +0.3s（封顶 +0.9），音量跌破 0.6×thr 清零连吹。纯麦克风玩法（e.body 不参与）。
 *
 * 全部字面量沿用站点：判定线 thr 0.35/0.45/0.55、蓄力 hold 0.3s（衰减 2×dt）、
 * 连吹加成 min(w,3)×0.3s、连吹中断线 0.6×thr、火焰预兆 0.5×thr/摇摆 0.3×thr、
 * 蛋糕蜡烛数 3/4/5（双人封顶 3）、调皮率 0.15/0.2/0.28、复燃窗口 0.9+rng×0.8s、
 * 熄灭残留 1.6s、补烛等待 0.6s（最小间隔 0.35s）、双人轮流吹（吹灭换边、零烛方自动让位）。
 *
 * 与站点的差异（写明待实测）：
 * 1) 站点 e.mic 黑盒 → 本框架 mic.level（RMS 减噪底×6、EMA 12/s），thr 需真机校准；
 * 2) 站点蜡烛槽位/颜色/目标用种子 rng 流 → 这里用 mulberry32 等价实现；蛋糕/蜡烛/火焰几何绘制；
 * 3) 双人共享一个分数（仓库口径）；语音换边播报简化为 say 文字；
 * 4) ai() 演示替身未实装。
 */
interface Candle {
  slot: number
  col: string
  lit: boolean
  born: number
  outAt: number // 熄灭时刻（0=点燃态）
  naughty: boolean
  relightAt: number // 0=无
}

/** 站点三档：判定线 / 蛋糕蜡烛数 / 调皮率（hold 恒 0.3） */
const DIFF = [
  { thr: 0.35, count: 3, naughty: 0.15 },
  { thr: 0.45, count: 4, naughty: 0.2 },
  { thr: 0.55, count: 5, naughty: 0.28 },
]

const HOLD = 0.3 // 单根蓄力时长
const RESIDUE = 1.6 // 熄灭残留（秒）
const RELIGHT_WAIT = 0.6 // 补烛等待（秒）
const RELIGHT_WIN: [number, number] = [0.9, 1.7]
const CANDLE_COLS = ['#ff6b6b', '#4cc9f0', '#ffd54a', '#9be15d', '#b088f0', '#ff9f43']
const DUR = 60

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

class Candles extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[0]
  candles: Candle[] = []
  seats = 1
  private U = Math.min(this.W, this.H) / 720
  turn = 0 // 当前回合方（0/1；单人恒 0）
  charge = 0
  w = 0 // 连吹数
  best = 0 // 最长连吹
  private nextLightAt = 0
  private rng = mulberry32(6)

  constructor(ctx: GameContext) {
    super(ctx)
    ctx.mic.ensure().catch(() => undefined)
  }

  /** 槽位坐标：单人 7 槽（±0.43/±0.27/±0.135/0 ×蛋糕宽），双人 5 槽单侧 */
  private slots(): number[] {
    if (this.seats === 1) return [-0.43, -0.27, -0.135, 0, 0.135, 0.27, 0.43]
    return [0.07, 0.17, 0.27, 0.39, 0.47]
  }

  private cakeW() {
    return this.seats > 1 ? Math.min(this.W / 2 * 0.8, this.H * 0.5) : Math.min(this.W * 0.28, this.H * 0.42)
  }

  private isGone(c: Candle) {
    return !c.lit && !c.naughty && this.t - c.outAt > RESIDUE
  }

  /** 点亮一根：随机空槽 */
  private lightCandle() {
    const used = new Set(this.candles.filter((c) => this.isGone(c) === false).map((c) => c.slot))
    const free = this.slots().filter((s) => !used.has(s))
    if (free.length === 0) return
    const slot = free[Math.floor(this.rng() * free.length)]
    this.candles.push({
      slot,
      col: CANDLE_COLS[Math.floor(this.rng() * CANDLE_COLS.length)],
      lit: true, born: this.t, outAt: 0, naughty: false, relightAt: 0,
    })
    this.ctx.audio.play('pop', 0.3, 1.2)
  }

  tick(f: PoseFrame, dt: number) {
    void f
    if (this.candles.length === 0 && this.t >= 0.3) {
      // 开局补满到 count
      while (this.litTotal() < this.count()) this.lightCandle()
    }
    // 移除消亡蜡烛
    this.candles = this.candles.filter((c) => !this.isGone(c))
    // 补烛
    if (this.litTotal() < this.count() && this.t >= this.nextLightAt) this.lightCandle()
    // 复燃
    for (const c of this.candles) {
      if (!c.lit && c.naughty && c.relightAt > 0 && this.t >= c.relightAt) {
        c.lit = true
        c.naughty = false
        c.relightAt = 0
        this.say('嘻嘻！', this.candleX(c), this.candleY(c) - 40, '#b088f0', 22)
        this.ctx.audio.play('pop', 0.4, 1.6)
      }
    }
    // 双人零烛方自动让位
    if (this.seats > 1 && this.litTurnCount(this.turn) === 0 && this.litTurnCount(1 - this.turn) > 0) {
      this.turn = 1 - this.turn
    }

    // —— 麦克风判定 ——
    const mic = this.ctx.mic.level
    const thr = this.cfg.thr
    if (mic < thr * 0.6) this.w = 0
    const goal = HOLD + Math.min(this.w, 3) * 0.3
    if (mic > thr) {
      // 回合方有点燃蜡烛才蓄力生效
      if (this.litTurnCount(this.turn) > 0) {
        this.charge += dt
        if (this.charge >= goal) {
          this.charge = 0
          this.blowOut()
        }
      }
    } else {
      this.charge = Math.max(0, this.charge - dt * 2)
    }

    this.ctx.setExtra('best', this.best)
    if (this.t >= DUR) this.ctx.finish()
  }

  private count() {
    return this.seats > 1 ? Math.min(3, this.cfg.count) : this.cfg.count
  }
  private litTotal() {
    return this.candles.filter((c) => c.lit).length
  }
  private litTurnCount(turn: number) {
    if (this.seats === 1) return this.litTotal()
    return this.candles.filter((c) => c.lit && ((turn === 0 && c.slot < 0) || (turn === 1 && c.slot > 0))).length
  }
  private candleX(c: Candle) {
    const cw = this.cakeW()
    const zoneCx = this.seats > 1 ? (c.slot < 0 ? this.W * 0.25 : this.W * 0.75) : this.W / 2
    return zoneCx + c.slot * cw * (this.seats > 1 ? 2 : 1)
  }
  private candleY(c: Candle) {
    const base = this.H * 0.68
    const tall = Math.abs(c.slot) > 0.3 ? 1 : 0.68
    return base - 90 * this.U * tall - (Math.abs(c.slot) % 2) * 12 * this.U
  }

  /** 吹灭一根：从回合方点燃蜡烛随机挑 */
  private blowOut() {
    const pool = this.candles.filter((c) => c.lit && (this.seats === 1 || ((this.turn === 0 && c.slot < 0) || (this.turn === 1 && c.slot > 0))))
    if (pool.length === 0) return
    const c = pool[Math.floor(this.rng() * pool.length)]
    c.lit = false
    c.outAt = this.t
    this.w++
    this.best = Math.max(this.best, this.w)
    this.ctx.addScore(1)
    this.ctx.audio.play('score', 0.4, 0.9)
    this.say('呼～', this.candleX(c), this.candleY(c) - 30, '#4cc9f0', 24)
    this.particles.burst(this.candleX(c), this.candleY(c), '#cccccc', 6, 160, 3)
    if (this.rng() < this.cfg.naughty) {
      c.naughty = true
      c.relightAt = this.t + RELIGHT_WIN[0] + this.rng() * (RELIGHT_WIN[1] - RELIGHT_WIN[0])
    } else {
      c.naughty = false
      c.relightAt = 0
    }
    this.nextLightAt = this.t + RELIGHT_WAIT
    if (this.seats > 1) {
      this.turn = 1 - this.turn
      this.say(`轮到 P${this.turn + 1} 吹`, this.W / 2, this.H * 0.14, this.players[this.turn].color, 24)
    }
  }

  paint(c: CanvasRenderingContext2D) {
    const U = this.U
    // 蛋糕
    const drawCake = (cx: number) => {
      const cw = this.cakeW()
      const cy = this.H * 0.68
      c.fillStyle = '#e8b04b'
      c.fillRect(cx - cw / 2, cy, cw, 60 * U)
      c.fillStyle = '#f6d38f'
      c.fillRect(cx - cw / 2, cy, cw, 24 * U)
      c.fillStyle = '#d98a9c'
      c.beginPath()
      c.ellipse(cx, cy, cw / 2, 16 * U, 0, Math.PI, 0)
      c.fill()
    }
    if (this.seats === 1) drawCake(this.W / 2)
    else {
      drawCake(this.W * 0.25)
      drawCake(this.W * 0.75)
    }
    // 蜡烛 + 火焰
    for (const cd of this.candles) {
      const x = this.candleX(cd)
      const y = this.candleY(cd)
      const pop = Math.min(1, (this.t - cd.born) / 0.4)
      const h = 70 * U * (Math.abs(cd.slot) > 0.3 ? 1 : 0.68) * (0.5 + 0.5 * pop)
      c.fillStyle = cd.col
      c.fillRect(x - 7 * U, y - h, 14 * U, h)
      c.strokeStyle = 'rgba(0,0,0,.15)'
      c.lineWidth = 1
      c.strokeRect(x - 7 * U, y - h, 14 * U, h)
      if (cd.lit) {
        // 火焰：尺寸随 mic 预兆线、摆幅随摇摆线
        const mic = this.ctx.mic.level
        const thr = this.cfg.thr
        const big = mic > thr * 0.5 ? 1 + (clamp(mic / thr, 0, 1) * 0.6) : 1
        const sway = mic > thr * 0.3 ? clamp((mic - thr * 0.3) / thr, 0, 1) * 0.9 * Math.sin(this.t * 20 + cd.slot) * 6 * U : 0
        circle(c, x + sway, y - h - 12 * U * big, 9 * U * big, '#ffd54a')
        circle(c, x + sway, y - h - 10 * U * big, 4.5 * U * big, '#ff6b3d')
      } else {
        // 烟
        c.globalAlpha = 0.5
        circle(c, x, y - h - 14 * U, 6 * U, '#cccccc')
        c.globalAlpha = 1
        if (cd.naughty) txt(c, '😜', x, y - h - 30 * U, 20 * U, '#fff')
      }
    }
    // 蓄力条
    const goal = HOLD + Math.min(this.w, 3) * 0.3
    const bw = 260 * U
    const bx = this.W / 2 - bw / 2
    const by = this.H * 0.94
    rr2(c, bx, by, bw, 28 * U)
    c.fillStyle = 'rgba(255,255,255,.25)'
    c.fill()
    c.fillStyle = this.ctx.mic.level > this.cfg.thr ? '#4cc9f0' : '#9fc4ff'
    c.fillRect(bx + 3, by + 3, (bw - 6) * clamp(this.charge / goal, 0, 1), 28 * U - 6)
    // 音量圆点
    const mic = this.ctx.mic.level
    circle(c, bx - 20 * U, by + 14 * U, (10 + clamp(mic / this.cfg.thr, 0, 1.6) * 12) * U, mic > this.cfg.thr ? '#4cc9f0' : '#ffffffcc')
    // 提示
    const tip = mic > this.cfg.thr ? '使劲吹！' : '鼓起腮帮子吹～'
    outlineTxt(c, tip, this.W / 2, this.H * 0.08, 24, mic > this.cfg.thr ? '#ff5d5d' : '#4cc9f0')
    txt(c, `灭 ${Math.floor(this.ctx.hud().score)} 根 · 最长一口气 ${this.best}`, this.W / 2, this.H * 0.87, 16, '#ffffffcc', 'center', 'bold')
  }
}

/** rr 只描路径：本文件的圆角矩形帮手 */
function rr2(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  c.beginPath()
  const r = 8
  c.moveTo(x + r, y)
  c.arcTo(x + w, y, x + w, y + h, r)
  c.arcTo(x + w, y + h, x, y + h, r)
  c.arcTo(x, y + h, x, y, r)
  c.arcTo(x, y, x + w, y, r)
  c.closePath()
}

export default function create(ctx: GameContext) {
  return new Candles(ctx)
}
