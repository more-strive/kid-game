import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, glow, outlineTxt, ring, star, txt } from '@/core/draw'

type Phase = 'green' | 'freeze'

/** 木头人：绿灯使劲动攒星星，喊“木头人”必须立刻停下 */
class FreezeGame extends BaseGame implements Game {
  phase: Phase = 'green'
  phaseT = 4
  stars = 0
  shown = 0
  glowLevel = 0
  private prevLm: { x: number; y: number }[] | null = null
  private still = 0
  private moved = false

  tick(f: PoseFrame, dt: number) {
    const b = f.bodies[0] ?? null
    this.phaseT -= dt
    if (this.phaseT <= 0) this.nextPhase()

    if (!b) return
    const motion = this.motion(b, dt)

    if (this.phase === 'green') {
      // 越动越多星星
      const gain = Math.min(3, motion * 26)
      this.stars += gain * dt * 3.4
      this.sync()
      if (motion > 0.5) {
        this.particles.burst(
          (b.lHand.x + b.rHand.x) / 2 * this.W,
          (b.lHand.y + b.rHand.y) / 2 * this.H,
          '#ffd54a',
          1,
          160,
          4,
          500,
        )
      }
    } else {
      if (motion > 0.22) {
        this.still = 0
        if (!this.moved) {
          this.moved = true
          this.ctx.audio.fail()
          this.stars = Math.max(0, this.stars - 12)
          this.sync()
          this.say('动了！−12', this.W / 2, this.H / 2 + 120, '#ff6b6b', 46)
        }
      } else {
        this.still += dt
        this.moved = false
      }
    }
  }

  private motion(b: Body, dt: number): number {
    if (!this.prevLm) {
      this.prevLm = b.lm.map((p) => ({ x: p.x, y: p.y }))
      return 0
    }
    let sum = 0
    let n = 0
    for (let i = 0; i < b.lm.length; i++) {
      const p = b.lm[i]
      const q = this.prevLm[i]
      if ((p.visibility ?? 1) < 0.4) continue
      sum += Math.hypot(p.x - q.x, p.y - q.y)
      n++
      q.x = p.x
      q.y = p.y
    }
    const m = n ? sum / n / Math.max(0.016, dt) : 0
    // 用身体尺度归一化：个子小的动同样多也算多
    return Math.min(2, m / Math.max(0.35, b.scale))
  }

  private sync() {
    this.ctx.setScore(Math.round(this.stars))
    this.ctx.setExtra('stars', Math.round(this.stars))
  }

  private nextPhase() {
    if (this.phase === 'green') {
      this.phase = 'freeze'
      this.phaseT = 2.4 + Math.random() * 1.2
      this.moved = false
      this.still = 0
      this.ctx.audio.whistle()
      this.ctx.speak('木头人')
      this.ctx.setStage('木头人！')
    } else {
      this.phase = 'green'
      this.phaseT = 3.2 + Math.random() * 1.6
      this.ctx.audio.countdown(true)
      this.ctx.speak('绿灯，动起来')
      this.ctx.setStage('动起来')
    }
  }

  paint(c: CanvasRenderingContext2D) {
    const green = this.phase === 'green'
    const pulse = 0.5 + 0.5 * Math.sin(this.t * 5)
    this.glowLevel += ((green ? 1 : 0) - this.glowLevel) * 0.08

    const edge = c.createRadialGradient(this.W / 2, this.H / 2, this.H * 0.32, this.W / 2, this.H / 2, this.H * 0.85)
    edge.addColorStop(0, 'rgba(0,0,0,0)')
    edge.addColorStop(1, green ? `rgba(46,204,113,${0.32 + pulse * 0.12})` : `rgba(231,76,60,${0.42 + pulse * 0.12})`)
    c.fillStyle = edge
    c.fillRect(0, 0, this.W, this.H)

    // 红绿灯（左上，避开画面中间的人）
    const cx = 166
    const cy = 82
    c.fillStyle = 'rgba(12,18,44,.62)'
    c.beginPath()
    c.roundRect(cx - 126, cy - 40, 252, 80, 40)
    c.fill()
    circle(c, cx - 66, cy, 23, green ? '#2ecc71' : 'rgba(255,255,255,.13)')
    circle(c, cx + 66, cy, 23, !green ? '#ff4d4d' : 'rgba(255,255,255,.13)')
    if (green) glow(c, cx - 66, cy, 56, '#2ecc71', 0.6)
    else glow(c, cx + 66, cy, 56, '#ff4d4d', 0.6)

    if (green) {
      outlineTxt(c, '使劲动起来！', this.W / 2, 76, 46, '#ffffff')
    } else {
      outlineTxt(c, '木头人！不许动', this.W / 2, 76, 52, '#fff')
      if (!this.moved && this.still > 0.2) {
        outlineTxt(c, `稳住 ${this.still.toFixed(1)}s`, this.W / 2, this.H - 70, 32, '#ffe27a')
      }
    }

    // 星星罐
    const jx = this.W - 130
    const jy = this.H - 190
    c.save()
    c.globalAlpha = 0.95
    c.fillStyle = 'rgba(255,255,255,.16)'
    c.beginPath()
    c.roundRect(jx - 62, jy - 40, 124, 168, 28)
    c.fill()
    c.strokeStyle = 'rgba(255,255,255,.5)'
    c.lineWidth = 4
    c.stroke()
    c.restore()

    const shown = this.stars
    const rows = Math.min(24, Math.floor(shown / 6))
    for (let i = 0; i < rows; i++) {
      const col = i % 4
      const row = Math.floor(i / 4)
      const sxp = jx - 40 + col * 27
      const syp = jy + 108 - row * 22
      star(c, sxp, syp, 11, i < rows - 1 ? '#ffd54a' : '#fff2a8')
    }
    outlineTxt(c, `${Math.round(shown)}`, jx, jy + 148, 30, '#fff')
    txt(c, '颗星', jx, jy + 172, 13, 'rgba(255,255,255,.75)', 'center', 'bold')

    // 阶段剩余时间
    const total = green ? 4.6 : 3
    ring(c, 64, this.H - 64, 30, Math.max(0, this.phaseT / total), green ? '#2ecc71' : '#ff4d4d', 8)
  }
}

export default function create(ctx: GameContext) {
  return new FreezeGame(ctx)
}
