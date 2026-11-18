import { BaseGame, updateSeats } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, outlineTxt, txt } from '@/core/draw'

/**
 * 猜拳大赛 / rps（对齐 dongdongpark 真实规则）：
 * 猴子喊「石头、剪刀、布」三拍 → 「出！」窗口内用手势出拳（握拳=石头/比耶=剪刀/张手=布）→ 亮牌判定；
 * 三局两胜算赢一「轮」+1 分，赢了猴子掉香蕉。无效回合（没看见手）全场重来、不扣分。
 *
 * 全部字面量沿用站点：口令窗口 0.9/0.75/0.6s、猴子偷看概率 0/0.35/1（偷看=改出克制你上一拳的手势，
 * hard 重复上一拳必输）、口令 3 拍 × 0.5s（tick 音高 1+拍号×0.2 递升）、wait 0.7s（首回合 1.1s）、
 * 亮牌 1.5s（赛点 2.1s）、猴子亮牌延迟 0.15s、防抖 ≥2 帧（argmax 并列按 fist→victory→open 取先）、
 * 克制环 fist>victory>open>fist。
 *
 * 与站点的差异（写明待实测）：
 * 1) 站点 player.gestures 由框架侧分类（黑盒）→ 本仓库用 HandLandmarker 的伸直手指数自建分类：
 *    0 根=fist、2 根=victory、≥4 根=open、1/3 根不输出（等价不计票）；
 *    不区分「是哪两根手指」（站点剪刀要求食指+中指），2 根即算剪刀，属放宽，待实测；
 * 2) 猴子出拳策略照抄：每回合掷 peek → 克制你上一有效拳，否则均匀随机（seed rng(2) 流）；
 * 3) 精灵（猴子/手势图标/香蕉）全部几何绘制；双人共享一个分数（仓库口径，站点各 +1）；
 * 4) ai() 演示替身未实装。
 */
type Gesture = 'fist' | 'victory' | 'open'

const GESTURES: Gesture[] = ['fist', 'victory', 'open']
const G_NAME: Record<Gesture, string> = { fist: '石头', victory: '剪刀', open: '布' }
const G_ICON: Record<Gesture, string> = { fist: '✊', victory: '✌️', open: '🖐️' }
/** 克制函数 s(g)：赢过 g 的手势（fist>victory>open>fist） */
const BEATS: Record<Gesture, Gesture> = { fist: 'open', victory: 'fist', open: 'victory' }

/** 站点三档：口令窗口 / 猴子偷看概率 */
const DIFF = [
  { window: 0.9, peek: 0 },
  { window: 0.75, peek: 0.35 },
  { window: 0.6, peek: 1 },
]

const BEAT = 0.5 // 口令节拍（秒）
const WAIT = 0.7 // 回合前静默（首回合多 0.4s）
const REVEAL = 1.5 // 亮牌时长
const REVEAL_MATCH = 2.1 // 赛点亮牌时长
const MONKEY_DELAY = 0.15 // 猴子亮牌延迟
const DEBOUNCE = 2 // 有效出拳最少帧数

interface Zone {
  x0: number
  x1: number
  cx: number
}

interface RpsPlayer {
  votes: [number, number, number]
  hand: Gesture | null // 本回合判定结果
  last: Gesture | null // 上一有效回合的拳（猴子偷看基准）
  zone: Zone
}

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

class Rps extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[0]
  rpsPlayers: RpsPlayer[] = []
  seats = 1
  private seatActive = [false, false]
  /** 每个席位最后一次检测到人的时刻（配合 updateSeats 判断离场） */
  private seatSeen = [-9, -9]
  phase: 'wait' | 'call' | 'window' | 'reveal' = 'wait'
  phaseAt = 0
  round = 0
  beat = 0
  scores: [number, number] = [0, 0] // 小比分（三局两胜）
  matchWinner: number | null = null // 0=P0 / 1=P1或猴子
  monkeyHand: Gesture | null = null
  monkeyExpr: 'normal' | 'happy' | 'sad' | 'think' = 'normal'
  winner: number | null = null // 本回合胜者（2P 用）
  private rng = mulberry32(2)
  private bananas: { x: number; y: number; vx: number; vy: number; rot: number }[] = []

  constructor(ctx: GameContext) {
    super(ctx)
    // 手部检测（手势分类的核心输入）
    ctx.enableHands().catch(() => undefined)
    for (let i = 0; i < 2; i++) {
      this.rpsPlayers.push({
        votes: [0, 0, 0], hand: null, last: null,
        zone: { x0: 0, x1: this.W, cx: this.W / 2 },
      })
    }
    this.layout()
    this.phaseAt = -0.4 // 首回合 wait 1.1s（站点 k=-0.4）
  }

  private layout() {
    const duo = this.seats > 1
    for (let i = 0; i < 2; i++) {
      const z = duo ? { x0: (i * this.W) / 2, x1: ((i + 1) * this.W) / 2 } : { x0: 0, x1: this.W }
      this.rpsPlayers[i].zone = { ...z, cx: (z.x0 + z.x1) / 2 }
    }
  }

  /** 从骨架手势检测：双手各出一个标签（0 根=fist、2 根=victory、≥4 根=open、其余不计） */
  private gestureOf(b: Body): Gesture[] {
    const out: Gesture[] = []
    for (const det of [b.lHandDet, b.rHandDet]) {
      if (!det) continue
      if (det.fingers === 0) out.push('fist')
      else if (det.fingers === 2) out.push('victory')
      else if (det.fingers >= 4) out.push('open')
    }
    return out
  }

  tick(f: PoseFrame, dt: number) {
    if (this.seats === 1 && f.bodies[1]) {
      this.seats = 2
      this.layout()
    }
    updateSeats(this.seatActive, this.seatSeen, f.bodies, this.t)

    // 香蕉粒子
    for (const bn of this.bananas) {
      bn.vy += 900 * (Math.min(this.W, this.H) / 720) * dt
      bn.x += bn.vx * dt
      bn.y += bn.vy * dt
      bn.rot += 6 * dt
    }
    this.bananas = this.bananas.filter((bn) => bn.y < this.H + 40)

    const elapsed = this.t - this.phaseAt
    if (this.phase === 'wait') {
      if (elapsed >= WAIT) {
        this.phase = 'call'
        this.phaseAt = this.t
        this.beat = 0
        this.round++
        for (const p of this.rpsPlayers) {
          p.votes = [0, 0, 0]
          p.hand = null
        }
        this.monkeyHand = null
        this.winner = null
        this.ctx.speak('石头、剪刀、布')
      }
      return
    }
    if (this.phase === 'call') {
      const b = Math.min(2, Math.floor(elapsed / BEAT))
      if (b > this.beat) {
        this.beat = b
        this.ctx.audio.play('tick', 0.5, 1 + this.beat * 0.2)
      }
      if (elapsed >= BEAT * 3) {
        this.phase = 'window'
        this.phaseAt = this.t
        this.ctx.audio.play('pop', 0.6, 1.4)
      }
      return
    }
    if (this.phase === 'window') {
      // 只在窗口期计票（防抖 ≥2 帧在判定时检查票数）
      const duo = this.seats > 1
      for (let i = 0; i < (duo ? 2 : 1); i++) {
        const b = f.bodies[i]
        if (!b) continue
        for (const g of this.gestureOf(b)) {
          this.rpsPlayers[i].votes[GESTURES.indexOf(g)]++
        }
      }
      if (elapsed >= this.cfg.window) this.judge()
      return
    }
    // reveal
    if (elapsed >= (this.matchWinner !== null ? REVEAL_MATCH : REVEAL)) {
      if (this.matchWinner !== null) {
        this.scores = [0, 0]
        this.matchWinner = null
        this.monkeyExpr = 'normal'
      }
      this.phase = 'wait'
      this.phaseAt = this.t
    }
  }

  /** 判定 G()：argmax + ≥2 帧防抖；猴子 peek 策略；胜负与比分 */
  private judge() {
    const duo = this.seats > 1
    const argmax = (v: [number, number, number]): Gesture | null => {
      let bi = 0
      for (let i = 1; i < 3; i++) if (v[i] > v[bi]) bi = i
      return v[bi] >= DEBOUNCE ? GESTURES[bi] : null
    }
    this.rpsPlayers[0].hand = argmax(this.rpsPlayers[0].votes)
    if (duo) this.rpsPlayers[1].hand = argmax(this.rpsPlayers[1].votes)
    else this.monkeyHand = this.monkeyPick()

    // 无效回合：任一方没出 → 全场重来
    const invalid = this.rpsPlayers[0].hand === null || (duo && this.rpsPlayers[1].hand === null)
    this.phase = 'reveal'
    this.phaseAt = this.t
    if (invalid) {
      this.ctx.audio.play('miss', 0.5, 0.9)
      this.say(duo ? '有人没出哦' : '没看见你的手', this.W / 2, this.H * 0.2, '#ff9f43', 32)
      this.ctx.speak('没看见手，再来一次')
      this.monkeyExpr = 'think'
      return
    }
    const a = this.rpsPlayers[0].hand!
    if (!duo) {
      // vs 猴子
      const m = this.monkeyHand!
      const c = this.beats(a, m)
      if (c > 0) {
        this.scores[0]++
        this.monkeyExpr = 'sad'
        this.dropBananas(2)
        this.say('赢啦！', this.W / 2, this.H * 0.3, '#6bcb77', 44)
        this.ctx.audio.play('score', 0.6)
      } else if (c < 0) {
        this.scores[1]++
        this.monkeyExpr = 'happy'
        this.say('小猴子赢了', this.W / 2, this.H * 0.3, '#4cc9f0', 34)
        this.ctx.audio.play('miss', 0.5, 1.1)
      } else {
        this.monkeyExpr = 'normal'
        this.ctx.audio.play('tick', 0.4, 0.8)
      }
      this.winner = c > 0 ? 0 : c < 0 ? 1 : null
    } else {
      const b2 = this.rpsPlayers[1].hand!
      const c = this.beats(a, b2)
      this.winner = c > 0 ? 0 : c < 0 ? 1 : null
      if (this.winner !== null) {
        this.scores[this.winner]++
        this.monkeyExpr = 'happy'
        this.say(`P${this.winner + 1} 赢啦`, this.W / 2, this.H * 0.2, this.players[this.winner]?.color ?? '#fff', 36)
      } else {
        this.monkeyExpr = 'normal'
        this.ctx.audio.play('tick', 0.4, 0.8)
      }
    }
    // 记录上一有效拳（猴子偷看基准）
    this.rpsPlayers[0].last = a
    if (duo) this.rpsPlayers[1].last = this.rpsPlayers[1].hand!
    // 三局两胜
    const done = this.scores.findIndex((s) => s >= 2)
    if (done >= 0) {
      this.matchWinner = done
      this.phaseAt = this.t
      this.monkeyExpr = done === 0 || duo ? 'happy' : 'happy'
      this.ctx.addScore(done === 0 || duo ? 1 : 0) // 猴子赢整场不加分（单人）
      if (done === 0 || duo) {
        this.ctx.audio.play('win')
        this.particles.burst(this.W / 2, this.H * 0.4, '#ffd54a', 36, 460, 5)
        this.dropBananas(4)
        if (!duo) this.ctx.speak('你赢了一轮！')
      } else {
        this.ctx.audio.play('miss', 0.6, 0.6)
        this.say('小猴子赢了这一轮，没关系，再来！', this.W / 2, this.H * 0.24, '#4cc9f0', 28)
      }
    }
  }

  private beats(a: Gesture, b2: Gesture): number {
    if (a === b2) return 0
    return BEATS[b2] === a ? 1 : -1 // a 赢过 b2
  }

  /** 猴子出拳：peek → 克制玩家上一有效拳；否则均匀随机（rng(2) 流） */
  private monkeyPick(): Gesture | null {
    const peek = this.rng() < this.cfg.peek
    const d = GESTURES[Math.floor(this.rng() * 3)]
    const last = this.rpsPlayers[0].last
    return last && peek ? BEATS[last] : d
  }

  private dropBananas(n: number) {
    const mx = this.seats > 1 ? this.W / 2 : this.W * 0.5
    for (let i = 0; i < n; i++) {
      this.bananas.push({
        x: mx + (Math.random() - 0.5) * 60,
        y: this.H * 0.42,
        vx: (Math.random() - 0.5) * 260,
        vy: -180 - Math.random() * 160,
        rot: Math.random() * Math.PI,
      })
    }
  }

  paint(c: CanvasRenderingContext2D) {
    const duo = this.seats > 1
    const U = Math.min(this.W, this.H) / 720
    // 猴子（1P 大居中 / 2P 顶部小）
    const mx = this.W / 2
    const my = duo ? this.H * 0.16 : this.H * 0.4
    const ms = (duo ? 150 : 220) * U
    const bounce = this.monkeyExpr === 'happy' ? Math.abs(Math.sin(this.t * 9)) * 12 * U : 0
    this.monkey(c, mx, my - bounce, ms)

    // 口令气泡（call 期逐拍点亮）
    if (this.phase === 'call') {
      const by = duo ? this.H * 0.42 : this.H * 0.6
      GESTURES.forEach((g, i) => {
        const bx = this.W / 2 + (i - 1) * 110 * U
        const active = i <= this.beat
        const pop = i === this.beat ? 1 + Math.sin(this.t * 14) * 0.12 : 1
        circle(c, bx, by, 34 * U * pop, active ? '#fffdf3' : 'rgba(255,255,255,.5)')
        txt(c, G_ICON[g], bx, by, 36 * U * pop, active ? '#26152c' : 'rgba(38,21,44,.35)')
      })
    }
    // 「出！」
    if (this.phase === 'window') {
      const s = 1 + Math.sin(this.t * 12) * 0.08
      outlineTxt(c, '出！', this.W / 2, this.H * 0.34, 64 * s, '#ff5d5d')
    }

    // 出拳圈
    for (let i = 0; i < (duo ? 2 : 1); i++) {
      const p = this.rpsPlayers[i]
      const z = p.zone
      const px = duo ? (i === 0 ? z.x0 + z.cx / 2 : z.cx + (z.x1 - z.cx) / 2) : this.W * 0.28
      const py = duo ? this.H * 0.56 : this.H * 0.68
      const pr = 64 * U
      const revealing = this.phase === 'reveal'
      const pop = revealing ? Math.min(1, (this.t - this.phaseAt) / 0.35) : 1
      circle(c, px, py, pr * (0.8 + 0.2 * pop), revealing && p.hand ? '#fffdf3' : 'rgba(255,255,255,.6)')
      c.strokeStyle = this.players[i].color
      c.lineWidth = 4
      c.beginPath()
      c.arc(px, py, pr * (0.8 + 0.2 * pop), 0, Math.PI * 2)
      c.stroke()
      if (revealing) {
        if (p.hand) {
          txt(c, G_ICON[p.hand], px, py, 52 * U * pop, '#26152c')
          txt(c, G_NAME[p.hand], px, py + pr * 0.9, 20 * U, '#26152c')
        } else {
          txt(c, '没出', px, py, 22 * U, '#ff9f43')
        }
      } else {
        txt(c, '?', px, py, 40 * U, this.players[i].color)
      }
    }
    // 猴子亮牌圈（单人）
    if (!duo && this.phase === 'reveal' && this.t - this.phaseAt > MONKEY_DELAY) {
      const px = this.W * 0.72
      const py = this.H * 0.68
      circle(c, px, py, 64 * U, '#f2e2c4')
      if (this.monkeyHand) {
        txt(c, G_ICON[this.monkeyHand], px, py, 52 * U, '#5a3d2b')
        txt(c, G_NAME[this.monkeyHand], px, py + 64 * U * 0.9, 20 * U, '#5a3d2b')
      } else {
        txt(c, '…', px, py, 30 * U, '#5a3d2b')
      }
    } else if (!duo) {
      const px = this.W * 0.72
      const py = this.H * 0.68
      circle(c, px, py, 64 * U, 'rgba(242,226,196,.5)')
      txt(c, '?', px, py, 40 * U, '#5a3d2b')
    }
    if (duo && this.phase === 'reveal') {
      txt(c, 'VS', this.W / 2, this.H * 0.56, 44, '#b088f0', 'center', '900')
    }
    // 结果大字
    if (this.phase === 'reveal' && this.winner !== null && !duo) {
      const c2 = this.winner === 0 ? '#6bcb77' : this.winner === 1 ? '#4cc9f0' : '#4cc9f0'
      outlineTxt(c, this.winner === 0 ? '赢啦！' : this.winner === 1 ? '输了' : '平手', this.W / 2, this.H * 0.14, 48, c2)
    }
    // 计分点
    const label0 = duo ? 'P1' : '你'
    const label1 = duo ? 'P2' : '🐵 小猴子'
    txt(c, label0, this.W * 0.22, this.H * 0.8, 20 * U, '#fff', 'center', 'bold')
    for (let k = 0; k < 2; k++) circle(c, this.W * 0.22 + (k - 0.5) * 26 * U, this.H * 0.84, 9 * U, this.scores[0] > k ? '#ffd54a' : 'rgba(255,255,255,.5)')
    txt(c, label1, this.W * 0.78, this.H * 0.8, 20 * U, '#fff', 'center', 'bold')
    for (let k = 0; k < 2; k++) circle(c, this.W * 0.78 + (k - 0.5) * 26 * U, this.H * 0.84, 9 * U, this.scores[1] > k ? '#ffd54a' : 'rgba(255,255,255,.5)')
    // 香蕉
    for (const bn of this.bananas) {
      c.save()
      c.translate(bn.x, bn.y)
      c.rotate(bn.rot)
      txt(c, '🍌', 0, 0, 30 * U, '#fff')
      c.restore()
    }
  }

  /** 猴子精灵（几何绘制）：脸 + 双耳 + 表情 */
  private monkey(c: CanvasRenderingContext2D, x: number, y: number, s: number) {
    circle(c, x - s * 0.42, y - s * 0.3, s * 0.16, '#a9744f') // 耳
    circle(c, x + s * 0.42, y - s * 0.3, s * 0.16, '#a9744f')
    circle(c, x, y, s * 0.4, '#a9744f') // 头
    circle(c, x, y + s * 0.04, s * 0.3, '#e8c39e') // 脸
    // 表情眼
    const eye = (ex: number) => {
      if (this.monkeyExpr === 'happy') {
        c.strokeStyle = '#26152c'
        c.lineWidth = s * 0.05
        c.beginPath()
        c.arc(ex, y - s * 0.02, s * 0.08, Math.PI, 0)
        c.stroke()
      } else if (this.monkeyExpr === 'think') {
        circle(c, ex, y - s * 0.04, s * 0.05, '#26152c')
      } else {
        circle(c, ex, y - s * 0.04, s * 0.055, '#26152c')
      }
    }
    eye(x - s * 0.14)
    eye(x + s * 0.14)
    // 嘴
    c.strokeStyle = '#26152c'
    c.lineWidth = s * 0.045
    c.beginPath()
    if (this.monkeyExpr === 'sad') c.arc(x, y + s * 0.2, s * 0.1, Math.PI, 0)
    else if (this.monkeyExpr === 'happy') c.arc(x, y + s * 0.12, s * 0.12, 0, Math.PI)
    else {
      c.moveTo(x - s * 0.1, y + s * 0.16)
      c.lineTo(x + s * 0.1, y + s * 0.16)
    }
    c.stroke()
  }
}

export default function create(ctx: GameContext) {
  return new Rps(ctx)
}
