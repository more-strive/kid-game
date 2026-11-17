import { BaseGame } from '@/core/base'
import type { Game, GameContext, PoseFrame } from '@/core/types'
import { glow, outlineTxt, txt } from '@/core/draw'

/**
 * 枕头大战（对齐 dongdongpark 真实规则）：
 * 枕头从四侧抛物线飞来，使劲拍飞 +1；黑枕头瞄准头部，碰到清连击（不扣分），躲开反而 +1。
 */
interface Pillow {
  x: number
  y: number
  vx: number
  vy: number
  size: number
  rot: number
  vr: number
  colorIdx: number
  grumpy: boolean
  owner: number
  age: number
  flight: number
  state: 'fly' | 'away'
  bounceAt: number
}

/** 对齐站点真实难度表：间隔/同屏上限/飞行时长/边长/黑枕头率/拍打手速门槛 */
const DIFF = [
  { every: 1.4, max: 3, flight: 2.0, size: 115, grumpy: 0, minSpeed: 0 },
  { every: 1.05, max: 4, flight: 1.65, size: 100, grumpy: 0.15, minSpeed: 1.6 },
  { every: 0.8, max: 6, flight: 1.35, size: 88, grumpy: 0.25, minSpeed: 2.1 },
]
const G = 380 // 重力（×unit，unit=1）
const COLORS = ['#ffffff', '#e8eefc', '#ffd6e0', '#d6f5e3', '#efe3ff', '#ffe9c9']

class PillowFight extends BaseGame implements Game {
  pillows: Pillow[] = []
  score = 0
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  spawnT = 0.6
  spawnCount = 0
  combos = [0, 0]
  dodged = 0
  private lastUrge = -10

  private zone(pi: number) {
    if (this.present() <= 1) return { x0: this.W * 0.06, x1: this.W * 0.94 }
    return pi === 0 ? { x0: this.W * 0.04, x1: this.W * 0.48 } : { x0: this.W * 0.52, x1: this.W * 0.96 }
  }

  private present() {
    return this.players.filter((p) => p.body).length
  }

  tick(f: PoseFrame, dt: number) {
    const duo = this.present() > 1
    // 生成（对齐站点：双人密度 ×1.6、间隔 ÷1.5）
    this.spawnT -= dt
    if (this.spawnT <= 0) {
      const flying = this.pillows.filter((p) => p.state === 'fly').length
      if (flying < this.cfg.max * (duo ? 1.6 : 1)) this.spawn(duo)
      this.spawnT = (this.cfg.every * (0.75 + Math.random() * 0.5)) / (duo ? 1.5 : 1)
    }

    // 物理
    for (const p of this.pillows) {
      if (p.state !== 'fly') continue
      p.vy += G * dt
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.rot += p.vr * dt
      p.age += dt
    }
    // 黑枕头躲开奖励：飞完没人碰 → owner +1（须在场）
    for (const p of this.pillows) {
      if (p.state === 'fly' && p.grumpy && p.age > p.flight + 0.25) {
        p.state = 'away'
        this.dodged++
        if (this.players[p.owner].body) {
          this.score++
          this.say('躲开啦！+1', p.x, p.y - 40, '#9be29b', 36)
          this.ctx.audio.jump()
        }
      }
    }
    this.pillows = this.pillows.filter((p) => p.state === 'fly' && p.y < this.H + p.size * 2 && p.age < p.flight + 3 && p.x > -p.size * 3 && p.x < this.W + p.size * 3)

    // 命中判定
    for (let pi = 0; pi < 2; pi++) {
      const b = f.bodies[pi]
      if (!b) continue
      const torso = Math.max(0.05, b.scale)
      const hands = [
        { trail: this.players[pi].lHand.trail },
        { trail: this.players[pi].rHand.trail },
      ]
      for (const h of hands) {
        if (h.trail.length < 2) continue
        const a = h.trail[h.trail.length - 2]
        const z = h.trail[h.trail.length - 1]
        const hx = z.x * this.W
        const hy = z.y * this.H
        const dtn = Math.max(0.001, dt)
        const vxn = (z.x - a.x) / dtn
        const vyn = (z.y - a.y) / dtn
        const speedTorso = Math.hypot(vxn, vyn) / torso

        for (const p of this.pillows) {
          if (p.state !== 'fly') continue
          if (p.grumpy) {
            // 黑枕头：手/头/肘 + 躯干核心，碰到清连击（不扣分）
            const hitR = p.size * 0.4
            const parts = [
              { x: b.lHand.x * this.W, y: b.lHand.y * this.H },
              { x: b.rHand.x * this.W, y: b.rHand.y * this.H },
              { x: b.head.x * this.W, y: b.head.y * this.H },
              { x: b.lElbow.x * this.W, y: b.lElbow.y * this.H },
              { x: b.rElbow.x * this.W, y: b.rElbow.y * this.H },
            ]
            const coreX = (b.shoulderC.x + b.hipC.x) / 2 * this.W
            const coreY = (b.shoulderC.y + b.hipC.y) / 2 * this.H
            const touched =
              parts.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < hitR + 30) ||
              Math.hypot(coreX - p.x, coreY - p.y) < hitR + torso * this.H * 0.45
            if (touched) {
              p.state = 'away'
              this.combos[pi] = 0
              this.ctx.audio.fail()
              this.say('哎哟！', p.x, p.y, '#6e5b84', 44)
              this.particles.burst(p.x, p.y, '#4a3b5c', 14, 420, 6)
              continue
            }
            continue
          }
          // 正常枕头：手拍中（近似圆判定 size×0.42）
          if (Math.hypot(hx - p.x, hy - p.y) > p.size * 0.42 + 24) continue
          const dx = p.x - hx
          const dy = p.y - hy
          const d = Math.hypot(dx, dy) || 1
          if (speedTorso < this.cfg.minSpeed) {
            // 手速不足：轻推开弹走（0.4s 节流），提示「用力拍！」（3s 节流）
            if (this.realClock - p.bounceAt > 0.4) {
              p.bounceAt = this.realClock
              p.vx = (dx / d) * 250 + vxn * this.H * 0.5
              p.vy = (dy / d) * 250 + vyn * this.H * 0.5 - 80
              p.vr *= 1.5
              this.ctx.audio.play('pop', 0.8, 0.8)
              if (this.realClock - this.lastUrge > 3) {
                this.lastUrge = this.realClock
                this.say('用力拍！', this.W / 2, this.H * 0.3, '#ffe27a', 40)
              }
            }
            continue
          }
          // 命中：+1，5 连击额外 +2 + 横幅
          p.state = 'away'
          this.combos[pi]++
          this.score++
          this.ctx.audio.play('pop', 1, 1.1 + Math.min(0.5, this.combos[pi] * 0.05))
          this.particles.burst(p.x, p.y, '#ffffff', 18, 420, 5)
          this.particles.burst(p.x, p.y, COLORS[p.colorIdx], 8, 360, 4)
          this.say('+1', p.x, p.y - 30, '#fff36b', 30)
          if (this.combos[pi] % 5 === 0) {
            this.score += 2
            this.say('连击 +2', p.x, p.y - 70, '#ffd54a', 38)
            this.sayText(`连击 ×${this.combos[pi]}！`)
            this.ctx.audio.good()
          }
        }
      }
    }

    this.ctx.setScore(this.score)
    this.ctx.setCombo(Math.max(this.combos[0], this.combos[1]))
    this.ctx.setExtra('躲开', this.dodged)
  }

  bannerText = ''
  bannerT = 0
  private realClock = 0

  private sayText(text: string) {
    this.bannerText = text
    this.bannerT = 1.1
  }

  update(f: PoseFrame, dt: number) {
    this.realClock += dt
    this.bannerT = Math.max(0, this.bannerT - dt)
    super.update(f, dt)
  }

  /** 抛出一个枕头：从四侧入场，抛物线恰好 flight 秒后到达目标点（对齐站点解算） */
  private spawn(duo: boolean) {
    const owner = this.spawnCount % Math.max(1, this.present())
    this.spawnCount++
    const z = this.zone(owner)
    const b = this.players[owner].body
    const torso = b ? Math.max(0.05, b.scale) : 0.22
    const size = this.cfg.size * (0.9 + Math.random() * 0.2)
    const grumpy = Math.random() < this.cfg.grumpy
    const cx = b ? b.shoulderC.x * this.W : (z.x0 + z.x1) / 2
    const cy = b ? b.shoulderC.y * this.H : this.H * 0.45
    let tx: number
    let ty: number
    if (grumpy && b) {
      // 黑枕头直接瞄准头部
      tx = b.head.x * this.W + (Math.random() - 0.5) * torso * this.H * 0.4
      ty = b.head.y * this.H + torso * this.H * 0.1
    } else {
      tx = cx + (Math.random() * 2 - 1) * torso * this.H * 1.1
      ty = cy + (-1.1 + Math.random() * 1.6) * torso * this.H
    }
    tx = Math.min(this.W - size * 0.6, Math.max(size * 0.6, tx))
    ty = Math.min(this.H * 0.85, Math.max(this.H * 0.15, ty))

    // 入场方向：双人各限两侧
    const dirs = duo ? (owner === 0 ? ['left', 'topL'] : ['right', 'topR']) : ['left', 'right', 'topL', 'topR']
    const dir = dirs[Math.floor(Math.random() * dirs.length)]
    let x: number
    let y: number
    if (dir === 'left') {
      x = -size
      y = this.H * (0.25 + Math.random() * 0.35)
    } else if (dir === 'right') {
      x = this.W + size
      y = this.H * (0.25 + Math.random() * 0.35)
    } else if (dir === 'topL') {
      x = this.W * (0.05 + Math.random() * 0.2)
      y = -size
    } else {
      x = this.W * (0.75 + Math.random() * 0.2)
      y = -size
    }
    // 抛物线解算：D 秒后到达 (tx, ty)
    const D = this.cfg.flight * (0.85 + Math.random() * 0.3)
    const vx = (tx - x) / D
    const vy = (ty - y - 0.5 * G * D * D) / D
    this.pillows.push({
      x,
      y,
      vx,
      vy,
      size,
      rot: Math.random() * 6,
      vr: (Math.random() < 0.5 ? -1 : 1) * (2 + Math.random() * 3),
      colorIdx: Math.floor(Math.random() * COLORS.length),
      grumpy,
      owner,
      age: 0,
      flight: D,
      state: 'fly',
      bounceAt: -10,
    })
    this.ctx.audio.play('pop', 0.6, 0.7)
  }

  paint(c: CanvasRenderingContext2D) {
    for (const p of this.pillows) {
      if (p.state !== 'fly') continue
      c.save()
      c.translate(p.x, p.y)
      if (p.grumpy) {
        // 黑枕头暗色脉冲光晕
        c.save()
        c.globalAlpha = 0.25 + Math.sin(this.realClock * 10) * 0.08
        c.fillStyle = '#3d2c4a'
        c.beginPath()
        c.arc(0, 0, p.size * 0.72, 0, Math.PI * 2)
        c.fill()
        c.restore()
      } else {
        glow(c, 0, 0, p.size * 1.1, COLORS[p.colorIdx], 0.2)
      }
      c.rotate(p.rot)
      // 速度方向挤压拉伸
      const sp = Math.hypot(p.vx, p.vy)
      const sq = Math.min(0.15, sp / 6000)
      c.scale(1 + sq, 1 - sq)
      const s = p.size
      c.beginPath()
      c.roundRect(-s / 2, -s * 0.36, s, s * 0.72, s * 0.25)
      c.fillStyle = p.grumpy ? '#4a3b5c' : COLORS[p.colorIdx]
      c.fill()
      c.strokeStyle = p.grumpy ? '#2a2040' : '#cbd5e1'
      c.lineWidth = 4
      c.stroke()
      circleBtn(c, 0, 0, s * 0.1, p.grumpy ? '#b983ff' : '#dbe3f0')
      if (p.grumpy) {
        // 生气的眉眼
        c.strokeStyle = '#b983ff'
        c.lineWidth = 3
        c.beginPath()
        c.moveTo(-s * 0.14, -s * 0.1)
        c.lineTo(-s * 0.05, -s * 0.04)
        c.moveTo(s * 0.14, -s * 0.1)
        c.lineTo(s * 0.05, -s * 0.04)
        c.stroke()
      }
      c.restore()
    }

    const best = Math.max(this.combos[0], this.combos[1])
    if (best >= 2) outlineTxt(c, `连击 ${best}`, 100, 50, 30 + Math.min(16, best), '#ffd54a')
    if (this.bannerT > 0) {
      c.globalAlpha = Math.min(1, this.bannerT / 0.3)
      outlineTxt(c, this.bannerText, this.W / 2, 150, 44, '#ffd54a')
      c.globalAlpha = 1
    }
    txt(c, '使劲拍飞枕头；黑枕头瞄准你的头，躲开它反而 +1', this.W / 2, this.H - 30, 20, 'rgba(255,255,255,.8)', 'center', 'bold')
  }
}

function circleBtn(c: CanvasRenderingContext2D, x: number, y: number, r: number, color: string) {
  c.beginPath()
  c.arc(x, y, r, 0, Math.PI * 2)
  c.fillStyle = color
  c.fill()
}

export default function create(ctx: GameContext) {
  return new PillowFight(ctx)
}
