import { BaseGame } from '@/core/base'
import type { Game, GameContext, PoseFrame } from '@/core/types'
import { circle, glow, outlineTxt, txt } from '@/core/draw'

interface Balloon {
  x: number
  y: number
  vx: number
  vy: number
  r: number
  color: string
  drift: number
  alive: boolean
  age: number
}

const COLORS = ['#ff5c8a', '#ffd166', '#4cc9f0', '#9b5de5', '#3ddc97']

class BalloonKeep extends BaseGame implements Game {
  balloons: Balloon[] = []
  score = 0
  combo = 0
  drops = 0
  spawnT = 0

  constructor(ctx: GameContext) {
    super(ctx)
    for (let i = 0; i < 2; i++) this.spawn()
  }

  private spawn() {
    this.balloons.push({
      x: 200 + Math.random() * (this.W - 400),
      y: 240 + Math.random() * 200,
      vx: (Math.random() - 0.5) * 120,
      vy: -40 - Math.random() * 60,
      r: 52,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      drift: Math.random() * 6.28,
      alive: true,
      age: 0,
    })
  }

  tick(f: PoseFrame, dt: number) {
    const hands = f.bodies.flatMap((b) => [
      { x: b.lHand.x * this.W, y: b.lHand.y * this.H },
      { x: b.rHand.x * this.W, y: b.rHand.y * this.H },
    ])

    for (const bl of this.balloons) {
      bl.age += dt
      bl.drift += dt * 1.6
      // 浮力 + 空气阻力
      bl.vy += (95 - bl.vy * 0.85) * dt
      bl.vx += Math.sin(bl.drift) * 40 * dt
      bl.vx *= 1 - 0.6 * dt
      bl.x += bl.vx * dt
      bl.y += bl.vy * dt

      if (bl.x < bl.r) {
        bl.x = bl.r
        bl.vx = Math.abs(bl.vx) * 0.7
      }
      if (bl.x > this.W - bl.r) {
        bl.x = this.W - bl.r
        bl.vx = -Math.abs(bl.vx) * 0.7
      }
      if (bl.y < 80) {
        bl.y = 80
        bl.vy = Math.abs(bl.vy) * 0.4
      }

      // 手托
      for (const h of hands) {
        const d = Math.hypot(h.x - bl.x, h.y - bl.y)
        if (d < bl.r + 42) {
          const fromBelow = h.y > bl.y - 10
          if (fromBelow || bl.vy > 0) {
            const dx = (bl.x - h.x) / (bl.r + 42)
            bl.vy = -420 - Math.random() * 120
            bl.vx += dx * 260
            this.score += 10 + Math.min(20, this.combo * 2)
            this.combo++
            this.ctx.setCombo(this.combo)
            this.ctx.setScore(this.score)
            this.ctx.audio.pop()
            this.particles.burst(bl.x, bl.y + bl.r * 0.7, bl.color, 8, 240, 5, 600)
            this.say(`+${10 + Math.min(20, (this.combo - 1) * 2)}`, bl.x, bl.y - 20, '#fff36b', 28)
            bl.y = h.y - bl.r - 20
          }
        }
      }

      // 落地
      if (bl.y > this.H + bl.r) {
        bl.alive = false
        this.drops++
        this.combo = 0
        this.ctx.setCombo(0)
        this.ctx.audio.fail()
        this.ctx.setExtra('drops', this.drops)
        this.say('掉了！', bl.x, this.H - 80, '#ff6b6b', 40)
      }
    }
    this.balloons = this.balloons.filter((b) => b.alive)

    if (this.balloons.length < 2) {
      this.spawnT -= dt
      if (this.spawnT <= 0) {
        this.spawnT = 1.4
        this.spawn()
      }
    }
  }

  paint(c: CanvasRenderingContext2D) {
    for (const bl of this.balloons) {
      const wob = Math.sin(bl.drift) * 4
      glow(c, bl.x, bl.y, bl.r * 2.4, bl.color, 0.3)
      // 绳子
      c.beginPath()
      c.moveTo(bl.x, bl.y + bl.r * 1.05)
      c.quadraticCurveTo(bl.x + wob * 1.6, bl.y + bl.r * 1.5, bl.x + wob, bl.y + bl.r * 1.9)
      c.strokeStyle = 'rgba(255,255,255,.55)'
      c.lineWidth = 2.5
      c.stroke()
      // 气球
      c.beginPath()
      c.ellipse(bl.x, bl.y, bl.r * 0.92, bl.r, 0, 0, Math.PI * 2)
      c.fillStyle = bl.color
      c.fill()
      c.beginPath()
      c.ellipse(bl.x - bl.r * 0.3, bl.y - bl.r * 0.32, bl.r * 0.22, bl.r * 0.3, -0.5, 0, Math.PI * 2)
      c.fillStyle = 'rgba(255,255,255,.55)'
      c.fill()
      // 表情
      circle(c, bl.x - 16, bl.y - 2, 4.5, 'rgba(30,30,60,.8)')
      circle(c, bl.x + 16, bl.y - 2, 4.5, 'rgba(30,30,60,.8)')
      c.beginPath()
      c.arc(bl.x, bl.y + 10, 10, 0.15 * Math.PI, 0.85 * Math.PI)
      c.strokeStyle = 'rgba(30,30,60,.8)'
      c.lineWidth = 3
      c.stroke()
      // 结
      c.beginPath()
      c.moveTo(bl.x - 7, bl.y + bl.r * 0.98)
      c.lineTo(bl.x + 7, bl.y + bl.r * 0.98)
      c.lineTo(bl.x, bl.y + bl.r * 1.12)
      c.closePath()
      c.fillStyle = bl.color
      c.fill()
    }

    if (this.combo >= 3) {
      const w = 190
      c.fillStyle = 'rgba(10,14,40,.45)'
      c.beginPath()
      c.roundRect(this.W / 2 - w / 2, 22, w, 52, 26)
      c.fill()
      outlineTxt(c, `连托 ${this.combo} 下`, this.W / 2, 48, 28, '#ffd54a')
    }
    txt(c, '用手把气球托起来，别让它落地', this.W / 2, this.H - 30, 20, 'rgba(255,255,255,.8)', 'center', 'bold')
  }
}

export default function create(ctx: GameContext) {
  return new BalloonKeep(ctx)
}
