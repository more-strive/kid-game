import { BaseGame } from '@/core/base'
import type { Game, GameContext, PoseFrame } from '@/core/types'
import { circle, glow, txt } from '@/core/draw'

/**
 * 戳泡泡（对齐 dongdongpark 真实规则）：
 * 底角两只青蛙轮流吹泡，手/头碰到就破；小泡泡分数多（1/2/3），彩虹泡连锁破一片再 +5。
 * 无任何惩罚，漏掉飘出屏幕就算了。
 */
type Kind = 'big' | 'mid' | 'small' | 'rainbow'

/** 泡泡种类表（对齐站点：半径/分值/破泡音调） */
const KINDS: Record<Kind, { r: number; pts: number; pitch: number }> = {
  big: { r: 62, pts: 1, pitch: 1 },
  mid: { r: 44, pts: 2, pitch: 1.25 },
  small: { r: 29, pts: 3, pitch: 1.6 },
  rainbow: { r: 56, pts: 3, pitch: 1 },
}
const RAINBOW_P = 0.05 // 彩虹泡概率（固定 5%）
const CHAIN_R = 250 // 彩虹连锁半径

/** 对齐站点难度表：间隔/上限/漂速/种类概率 [big,mid,small] */
const DIFF = [
  { every: 0.85, max: 14, drift: 1, mix: [0.5, 0.35, 0.15] },
  { every: 0.65, max: 18, drift: 1.2, mix: [0.35, 0.4, 0.25] },
  { every: 0.5, max: 22, drift: 1.45, mix: [0.25, 0.4, 0.35] },
]

interface Bubble {
  x: number
  y: number
  vx: number
  vy: number
  r: number
  kind: Kind
  phase: number
  age: number
  alive: boolean
}

class BubblePop extends BaseGame implements Game {
  bubbles: Bubble[] = []
  score = 0
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  spawnT = 0.3
  side = 0 // 两只青蛙轮流吹
  /** 青蛙吹气动画强度（3/s 衰减） */
  blow = [0, 0]

  tick(f: PoseFrame, dt: number) {
    const drift = this.cfg.drift
    const heat = Math.min(1, this.t / 45)
    const duo = this.present() > 1

    // 生成（对齐站点节奏公式）
    this.spawnT -= dt
    if (this.spawnT <= 0) {
      if (this.bubbles.length < this.cfg.max * (1 + 0.2 * heat) * (duo ? 1.4 : 1)) this.spawn()
      this.side = (this.side + 1) % 2
      this.blow[this.side] = 1
      this.spawnT = (this.cfg.every * (1 - 0.3 * heat) * (0.7 + Math.random() * 0.6)) / (duo ? 1.3 : 1)
    }
    this.blow[0] = Math.max(0, this.blow[0] - dt * 3)
    this.blow[1] = Math.max(0, this.blow[1] - dt * 3)

    // 漂浮物理（对齐站点：水平阻力 e^-0.9dt、浮力趋近 -38×drift、正弦摇摆）
    for (const b of this.bubbles) {
      if (!b.alive) continue
      b.age += dt
      b.vx *= Math.exp(-0.9 * dt)
      b.vy += (-38 * drift - b.vy) * Math.min(1, 0.6 * dt)
      b.x += (b.vx + Math.sin(b.age * 1.6 + b.phase) * 22 * drift) * dt
      b.y += b.vy * dt
      if (b.y < -2 * b.r || b.x < -2 * b.r || b.x > this.W + 2 * b.r) b.alive = false
    }

    // 命中：出生 0.25s 保护期后，手/头碰到（r×0.85 + 部位），全体玩家共享
    const parts: { x: number; y: number; r: number }[] = []
    for (const b of f.bodies) {
      parts.push(
        { x: b.lHand.x * this.W, y: b.lHand.y * this.H, r: 20 },
        { x: b.rHand.x * this.W, y: b.rHand.y * this.H, r: 20 },
        { x: b.head.x * this.W, y: b.head.y * this.H, r: Math.max(0.05, b.scale) * this.H * 0.18 },
      )
    }
    for (const b of this.bubbles) {
      if (!b.alive || b.age < 0.25) continue
      for (const p of parts) {
        if (Math.hypot(p.x - b.x, p.y - b.y) < b.r * 0.85 + p.r) {
          this.pop(b, true)
          break
        }
      }
    }
    this.bubbles = this.bubbles.filter((b) => b.alive)
    this.ctx.setScore(this.score)
  }

  private present() {
    return this.players.filter((p) => p.body).length
  }

  /** 两只青蛙的位置与朝向（底角，对齐站点 150×unit 尺寸） */
  private frog(side: number) {
    return { x: side === 0 ? 82.5 : this.W - 82.5, y: this.H - 40, dir: side === 0 ? 1 : -1, s: 150 }
  }

  private spawn() {
    const fr = this.frog(this.side)
    // 种类 roll：先掷彩虹 5%，再按 mix 分 big/mid/small
    let kind: Kind
    if (Math.random() < RAINBOW_P) kind = 'rainbow'
    else {
      const roll = Math.random()
      const [mBig, mMid] = this.cfg.mix
      kind = roll < mBig ? 'big' : roll < mBig + mMid ? 'mid' : 'small'
    }
    const k = KINDS[kind]
    this.bubbles.push({
      x: fr.x + fr.dir * fr.s * 0.7,
      y: fr.y - fr.s * 0.74,
      vx: fr.dir * (90 + Math.random() * 140) * driftOf(this.cfg),
      vy: -(25 + Math.random() * 55) * driftOf(this.cfg),
      r: k.r * (0.9 + Math.random() * 0.2),
      kind,
      phase: Math.random() * 10,
      age: 0,
      alive: true,
    })
    this.ctx.audio.play('pop', 0.7, 0.6 + Math.random() * 0.2)
  }

  /** 破泡：彩虹泡把 250 半径内的其它泡一并消除（不嵌套连锁），额外 +5 */
  private pop(b: Bubble, allowChain: boolean) {
    b.alive = false
    const k = KINDS[b.kind]
    this.score += k.pts
    this.ctx.setScore(this.score)
    this.ctx.audio.play('pop', 1, k.pitch)
    this.particles.burst(b.x, b.y, b.kind === 'rainbow' ? '#c9a6ff' : '#bfe6ff', 10 + k.pts * 2, 260, 4)
    if (allowChain && b.kind === 'rainbow') {
      this.ctx.audio.good()
      for (const o of this.bubbles) {
        if (o.alive && o !== b && Math.hypot(o.x - b.x, o.y - b.y) < CHAIN_R) this.pop(o, false)
      }
      this.score += 5
      this.ctx.setScore(this.score)
      this.say('彩虹 +5', b.x, b.y - 40, '#c9a6ff', 44)
      this.particles.burst(b.x, b.y, '#ffd54a', 18, 380, 5)
    } else {
      this.say(`+${k.pts}`, b.x, b.y - 20, '#ffffff', 26)
    }
  }

  paint(c: CanvasRenderingContext2D) {
    // 两只青蛙
    for (const side of [0, 1]) {
      const fr = this.frog(side)
      const blow = this.blow[side]
      c.save()
      c.translate(fr.x, fr.y + blow * 6)
      const s = fr.s * 0.42 * (1 + blow * 0.12)
      circle(c, 0, 0, s, '#7bc950')
      circle(c, -s * 0.45, -s * 0.55, s * 0.3, '#7bc950')
      circle(c, s * 0.45, -s * 0.55, s * 0.3, '#7bc950')
      circle(c, -s * 0.45, -s * 0.6, s * 0.15, '#ffffff')
      circle(c, s * 0.45, -s * 0.6, s * 0.15, '#ffffff')
      circle(c, -s * 0.45 + fr.dir * 3, -s * 0.6, s * 0.07, '#2b3d1e')
      circle(c, s * 0.45 + fr.dir * 3, -s * 0.6, s * 0.07, '#2b3d1e')
      c.beginPath()
      c.arc(fr.dir * s * 0.3, s * 0.1, s * 0.28 * (0.6 + blow * 0.5), 0, Math.PI * 2)
      c.fillStyle = '#5da13c'
      c.fill()
      c.restore()
    }

    // 泡泡（保体积压扁拉伸 + 淡入）
    for (const b of this.bubbles) {
      const fadeIn = Math.min(1, b.age / 0.3)
      const wob = 1 + Math.sin(this.t * 3 + b.phase) * 0.04
      c.save()
      c.translate(b.x, b.y)
      c.globalAlpha = fadeIn
      glow(c, 0, 0, b.r * 1.9, b.kind === 'rainbow' ? '#c9a6ff' : '#7cd8ff', 0.3)
      c.scale(wob, 1 / wob)
      const g = c.createRadialGradient(-b.r * 0.3, -b.r * 0.35, b.r * 0.1, 0, 0, b.r)
      if (b.kind === 'rainbow') {
        g.addColorStop(0, 'rgba(255,255,255,.95)')
        g.addColorStop(0.5, '#c9a6ffcc')
        g.addColorStop(1, '#ff9fd055')
      } else {
        g.addColorStop(0, 'rgba(255,255,255,.95)')
        g.addColorStop(0.55, '#7cd8ffcc')
        g.addColorStop(1, '#7cd8ff55')
      }
      c.beginPath()
      c.arc(0, 0, b.r, 0, Math.PI * 2)
      c.fillStyle = g
      c.fill()
      c.strokeStyle = 'rgba(255,255,255,.85)'
      c.lineWidth = 3
      c.stroke()
      c.beginPath()
      c.ellipse(-b.r * 0.35, -b.r * 0.38, b.r * 0.2, b.r * 0.13, -0.6, 0, Math.PI * 2)
      c.fillStyle = 'rgba(255,255,255,.9)'
      c.fill()
      // 大泡 40% 带笑脸（纯装饰）
      if (b.kind === 'big' && b.phase % 1 < 0.4) {
        circle(c, -b.r * 0.22, -b.r * 0.05, b.r * 0.06, 'rgba(40,60,90,.7)')
        circle(c, b.r * 0.22, -b.r * 0.05, b.r * 0.06, 'rgba(40,60,90,.7)')
        c.beginPath()
        c.arc(0, b.r * 0.15, b.r * 0.16, 0.15 * Math.PI, 0.85 * Math.PI)
        c.strokeStyle = 'rgba(40,60,90,.7)'
        c.lineWidth = 2.5
        c.stroke()
      }
      c.restore()
    }

    txt(c, '伸手戳破泡泡：小泡泡分数多，彩虹泡泡一下破一片 +5', this.W / 2, this.H - 30, 20, 'rgba(255,255,255,.8)', 'center', 'bold')
  }
}

function driftOf(cfg: { drift: number }) {
  return cfg.drift
}

export default function create(ctx: GameContext) {
  return new BubblePop(ctx)
}
