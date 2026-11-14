import { BaseGame } from '@/core/base'
import type { Game, GameContext, PoseFrame } from '@/core/types'
import { circle, glow, outlineTxt, star, txt } from '@/core/draw'

/** 打击类原型：目标出现 → 用手打中 → 连击 */
type TargetKind = 'mole' | 'bubble' | 'star' | 'pillow' | 'button' | 'flower'

interface Theme {
  kind: TargetKind
  colors: string[]
  hitWord: string
  /** 每个目标基础分 */
  score: number
}

const THEMES: Record<string, Theme> = {
  'whack-mole': { kind: 'mole', colors: ['#b07d4b', '#8a5f37'], hitWord: '咚！', score: 12 },
  'bubble-pop': { kind: 'bubble', colors: ['#7cd8ff', '#b8a1ff', '#ffd6f0'], hitWord: '啪！', score: 10 },
  'star-stomp': { kind: 'star', colors: ['#ffd54a'], hitWord: '踩到！', score: 12 },
  'pillow-fight': { kind: 'pillow', colors: ['#ffffff', '#e8eefc'], hitWord: '嘭！', score: 12 },
  'clap-bloom': { kind: 'flower', colors: ['#ff8fb1', '#ffd166', '#9b5de5'], hitWord: '开花！', score: 14 },
  'boxing': { kind: 'button', colors: ['#ff6b6b', '#ffd166'], hitWord: '出拳！', score: 14 },
  'whack': { kind: 'mole', colors: ['#b07d4b'], hitWord: '咚！', score: 12 },
}

interface Target {
  x: number
  y: number
  r: number
  born: number
  life: number
  color: string
  alive: boolean
  hit: boolean
  kind: TargetKind
  scale: number
}

class WhackGame extends BaseGame implements Game {
  theme: Theme
  targets: Target[] = []
  score = 0
  combo = 0
  best = 0
  spawnT = 0.4
  slots: { x: number; y: number }[] = []

  constructor(ctx: GameContext) {
    super(ctx)
    this.theme = THEMES[ctx.meta.slug] ?? { kind: 'mole', colors: ['#ffb703'], hitWord: '咚！', score: 12 }
    // 3x3 洞位
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        this.slots.push({
          x: this.W * (0.22 + c * 0.28),
          y: 250 + r * 175,
        })
      }
    }
  }

  tick(_f: PoseFrame, dt: number) {
    this.spawnT -= dt
    const maxAlive = 2 + this.ctx.difficulty
    if (this.spawnT <= 0 && this.targets.filter((t) => !t.hit).length < maxAlive) {
      this.spawnT = Math.max(0.34, 0.85 - this.ctx.difficulty * 0.12) * (0.7 + Math.random() * 0.6)
      this.spawn()
    }

    for (const t of this.targets) {
      if (!t.alive) continue
      t.born += dt
      const age = t.born
      t.scale = age < 0.18 ? age / 0.18 : 1
      if (age > t.life && !t.hit) {
        t.alive = false
        this.combo = 0
        this.ctx.setCombo(0)
      }
      if (t.hit && age - t.life > 0.5) t.alive = false
    }

    // 手打
    for (const pv of this.players) {
      const b = pv.body
      if (!b) continue
      const hands = [b.lHand, b.rHand]
      for (const h of hands) {
        const hx = h.x * this.W
        const hy = h.y * this.H
        for (const t of this.targets) {
          if (!t.alive || t.hit) continue
          if (t.born < 0.14) continue
          if (Math.hypot(hx - t.x, hy - t.y) < t.r * 0.95) this.hit(t)
        }
      }
    }

    this.targets = this.targets.filter((t) => t.alive)
    this.ctx.setScore(this.score)
  }

  private spawn() {
    const free = this.slots.filter(
      (s) => !this.targets.some((t) => !t.hit && Math.hypot(t.x - s.x, t.y - s.y) < 60),
    )
    if (!free.length) return
    const s = free[Math.floor(Math.random() * free.length)]
    const bomb = Math.random() < 0.12
    this.targets.push({
      x: s.x + (Math.random() - 0.5) * 20,
      y: s.y + (Math.random() - 0.5) * 16,
      r: 62 + Math.random() * 16,
      born: 0,
      life: Math.max(0.85, 1.75 - this.ctx.difficulty * 0.18),
      color: bomb ? '#3a3a4d' : this.theme.colors[Math.floor(Math.random() * this.theme.colors.length)],
      alive: true,
      hit: false,
      kind: bomb ? 'mole' : this.theme.kind,
      scale: 0,
    })
  }

  private hit(t: Target) {
    t.hit = true
    t.born = t.life
    if (t.color === '#3a3a4d') {
      this.ctx.audio.hit()
      this.particles.burst(t.x, t.y, '#ff5c5c', 20, 460, 8)
      this.score = Math.max(0, this.score - 15)
      this.combo = 0
      this.ctx.setCombo(0)
      this.say('−15', t.x, t.y - 40, '#ff6b6b', 40)
      return
    }
    this.combo++
    this.best = Math.max(this.best, this.combo)
    this.ctx.setCombo(this.combo)
    const gain = this.theme.score + Math.min(30, this.combo * 2)
    this.score += gain
    this.ctx.audio.pop()
    this.particles.burst(t.x, t.y, t.color, 14, 380, 6)
    this.say(`+${gain}`, t.x, t.y - 40, '#fff36b', 32)
    this.ctx.setExtra('best', this.best)
  }

  private drawTarget(c: CanvasRenderingContext2D, t: Target) {
    const k = t.scale
    c.save()
    c.translate(t.x, t.y)
    c.scale(k, k)
    const bomb = t.color === '#3a3a4d'
    glow(c, 0, 0, t.r * 1.9, t.color, 0.32)

    if (bomb) {
      circle(c, 0, 0, t.r * 0.86, '#2b2b3d')
      txt(c, '✕', 0, 2, t.r * 1.1, '#ff6b6b', 'center', 900)
    } else if (t.kind === 'bubble') {
      const g = c.createRadialGradient(-t.r * 0.3, -t.r * 0.35, t.r * 0.1, 0, 0, t.r)
      g.addColorStop(0, 'rgba(255,255,255,.95)')
      g.addColorStop(0.55, t.color + 'cc')
      g.addColorStop(1, t.color + '55')
      c.beginPath()
      c.arc(0, 0, t.r, 0, Math.PI * 2)
      c.fillStyle = g
      c.fill()
      c.strokeStyle = 'rgba(255,255,255,.85)'
      c.lineWidth = 3
      c.stroke()
      c.beginPath()
      c.ellipse(-t.r * 0.35, -t.r * 0.38, t.r * 0.2, t.r * 0.13, -0.6, 0, Math.PI * 2)
      c.fillStyle = 'rgba(255,255,255,.9)'
      c.fill()
    } else if (t.kind === 'star') {
      star(c, 0, 0, t.r, t.color)
      star(c, 0, 0, t.r * 0.55, '#fff3b0')
    } else if (t.kind === 'pillow') {
      c.beginPath()
      c.roundRect(-t.r, -t.r * 0.72, t.r * 2, t.r * 1.44, t.r * 0.5)
      c.fillStyle = t.color
      c.fill()
      c.strokeStyle = '#cbd5e1'
      c.lineWidth = 3
      c.stroke()
      c.beginPath()
      c.arc(0, 0, t.r * 0.16, 0, Math.PI * 2)
      c.fillStyle = '#dbe3f0'
      c.fill()
    } else if (t.kind === 'flower') {
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2
        c.beginPath()
        c.ellipse(Math.cos(a) * t.r * 0.62, Math.sin(a) * t.r * 0.62, t.r * 0.34, t.r * 0.24, a, 0, Math.PI * 2)
        c.fillStyle = t.color
        c.fill()
      }
      circle(c, 0, 0, t.r * 0.34, '#ffe066')
    } else if (t.kind === 'button') {
      circle(c, 0, 0, t.r * 0.9, t.color)
      circle(c, 0, 0, t.r * 0.6, 'rgba(255,255,255,.35)')
      txt(c, '拳', 0, 2, t.r * 0.9, '#fff', 'center', 900)
    } else {
      // 地鼠
      const g = c.createRadialGradient(-t.r * 0.3, -t.r * 0.4, t.r * 0.1, 0, 0, t.r)
      g.addColorStop(0, '#c98f57')
      g.addColorStop(1, '#8a5f37')
      c.beginPath()
      c.ellipse(0, 0, t.r * 0.88, t.r, 0, 0, Math.PI * 2)
      c.fillStyle = g
      c.fill()
      // 耳朵
      circle(c, -t.r * 0.7, -t.r * 0.62, t.r * 0.24, '#a8713f')
      circle(c, t.r * 0.7, -t.r * 0.62, t.r * 0.24, '#a8713f')
      // 眼睛
      circle(c, -t.r * 0.28, -t.r * 0.12, t.r * 0.11, '#2b1c0e')
      circle(c, t.r * 0.28, -t.r * 0.12, t.r * 0.11, '#2b1c0e')
      // 鼻子
      circle(c, 0, t.r * 0.18, t.r * 0.13, '#5d3d22')
      // 胡须
      c.strokeStyle = 'rgba(60,40,20,.6)'
      c.lineWidth = 2
      for (const s of [-1, 1]) {
        for (const dy of [-0.02, 0.06, 0.14]) {
          c.beginPath()
          c.moveTo(s * t.r * 0.18, t.r * dy)
          c.lineTo(s * t.r * 0.8, t.r * (dy - 0.05))
          c.stroke()
        }
      }
    }
    c.restore()
  }

  paint(c: CanvasRenderingContext2D) {
    // 洞位阴影
    for (const s of this.slots) {
      c.beginPath()
      c.ellipse(s.x, s.y + 52, 68, 20, 0, 0, Math.PI * 2)
      c.fillStyle = 'rgba(20,30,60,.10)'
      c.fill()
    }
    for (const t of this.targets) this.drawTarget(c, t)

    if (this.combo >= 3) {
      c.fillStyle = 'rgba(10,14,40,.42)'
      c.beginPath()
      c.roundRect(this.W / 2 - 105, 20, 210, 54, 27)
      c.fill()
      outlineTxt(c, `连击 ${this.combo}`, this.W / 2, 47, 30, '#ffd54a')
    }
    txt(c, '用手打到亮起来的目标', this.W / 2, this.H - 34, 20, 'rgba(255,255,255,.8)', 'center', 'bold')
  }
}

export default function create(ctx: GameContext) {
  return new WhackGame(ctx)
}
