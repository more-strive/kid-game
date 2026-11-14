import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, glow, outlineTxt, ring, starPath, txt } from '@/core/draw'

type Mode = 'catch' | 'hit' | 'jump' | 'pose'

interface Item {
  x: number
  y: number
  vx: number
  vy: number
  r: number
  ch: string
  color: string
  good: boolean
  alive: boolean
  rot: number
  spin: number
  hitAt?: number
}

/** 通用玩法原型：在专属实现就绪前，按玩法类型给每个游戏一个可玩的版本 */
class GenericGame extends BaseGame implements Game {
  mode: Mode
  items: Item[] = []
  score = 0
  combo = 0
  best = 0
  spawnT = 0
  spawnGap = 1.15
  poseTask = 'arms'
  poseT = 0
  poseHold = 0
  level = 0
  timeAlive = 0

  constructor(ctx: GameContext) {
    super(ctx)
    const types = ctx.meta.types.join('/')
    const name = ctx.meta.name
    if (types.includes('动脑') && ctx.meta.star3 > 0) this.mode = 'pose'
    else if (types.includes('跑跳') || types.includes('体能')) this.mode = 'jump'
    else if (types.includes('节奏')) this.mode = 'hit'
    else if (types.includes('全身') && !types.includes('用手')) this.mode = 'pose'
    else this.mode = 'catch'
    if (name.includes('跳') || name.includes('跑') || name.includes('蹲')) this.mode = 'jump'
    this.spawnGap = this.mode === 'jump' ? 1.0 : 1.15
  }

  private addCombo() {
    this.combo++
    this.best = Math.max(this.best, this.combo)
    this.ctx.setCombo(this.combo)
    const gain = 10 + Math.min(20, Math.floor(this.combo / 3) * 5)
    this.score += gain
    this.ctx.addScore(gain)
    this.ctx.setExtra('best', this.best)
    return gain
  }

  private breakCombo() {
    if (this.combo >= 5) this.ctx.audio.fail()
    this.combo = 0
    this.ctx.setCombo(0)
  }

  tick(f: PoseFrame, dt: number) {
    this.timeAlive += dt
    const b = f.bodies[0] ?? null
    if (this.mode === 'pose') return this.tickPose(b, dt)
    this.spawnT -= dt
    if (this.spawnT <= 0) {
      this.spawnT = this.spawnGap * (0.72 + Math.random() * 0.55)
      this.spawn()
    }
    for (const it of this.items) {
      if (!it.alive) continue
      if (this.mode === 'hit' && it.hitAt) {
        const age = this.t - it.hitAt
        if (age < 0.35) {
          it.vy += 900 * dt
          it.x += it.vx * dt
          it.y += it.vy * dt
          it.rot += it.spin * dt * 2
          continue
        }
        it.alive = false
        continue
      }
      it.vy += (this.mode === 'catch' ? 420 : 0) * dt
      it.x += it.vx * dt
      it.y += it.vy * dt
      it.rot += it.spin * dt
      if (it.x < 40 || it.x > this.W - 40) it.vx *= -1

      // 手碰撞
      if (b && this.mode !== 'jump') {
        const hands = [b.lHand, b.rHand]
        for (const h of hands) {
          const hx = h.x * this.W
          const hy = h.y * this.H
          if (Math.hypot(hx - it.x, hy - it.y) < it.r + 34) {
            if (this.mode === 'catch' || it.good) {
              this.onCatch(it)
            } else {
              it.alive = false
              this.breakCombo()
              this.ctx.audio.hit()
              this.say('哎哟', it.x, it.y, '#ff6b6b', 38)
            }
            break
          }
        }
      }

      // 跳跃碰撞
      if (b && this.mode === 'jump' && b.jumping) {
        const fy = Math.min(b.lFoot.y, b.rFoot.y) * this.H
        if (Math.abs(it.x - b.center.x * this.W) < 120 && Math.abs(fy - it.y) < 130) {
          this.onCatch(it)
        }
      }

      const out = it.y > this.H + 90 || it.y < -160
      if (out) {
        it.alive = false
        if (it.good && !it.hitAt) this.breakCombo()
      }
    }
    this.items = this.items.filter((i) => i.alive)
  }

  private onCatch(it: Item) {
    it.alive = false
    if (this.mode === 'hit') {
      it.hitAt = this.t
      it.alive = true
      it.vy = -420
      it.vx = (Math.random() - 0.5) * 260
      it.spin = 6
    }
    const gain = this.addCombo()
    this.ctx.audio.pop()
    this.particles.burst(it.x, it.y, it.color, 10, 300, 5)
    this.say(`+${gain}`, it.x, it.y - 20, '#fff36b', 34)
  }

  private spawn() {
    const meta = this.ctx.meta
    const ch = Math.random() < 0.12 ? '💣' : meta.emoji
    const good = ch !== '💣'
    const base = {
      r: 34 + Math.random() * 12,
      ch,
      color: good ? meta.color : '#ff5252',
      good,
      alive: true,
      rot: 0,
      spin: (Math.random() - 0.5) * 2,
    }
    if (this.mode === 'catch') {
      this.items.push({ ...base, x: 150 + Math.random() * (this.W - 300), y: -60, vx: 0, vy: 120 + Math.random() * 80 })
    } else if (this.mode === 'hit') {
      this.items.push({
        ...base,
        x: 150 + Math.random() * (this.W - 300),
        y: this.H + 60,
        vx: (Math.random() - 0.5) * 120,
        vy: -(720 + Math.random() * 260),
      })
    } else {
      const side = Math.random() < 0.5 ? -1 : 1
      this.items.push({
        ...base,
        x: side < 0 ? -50 : this.W + 50,
        y: 380 + Math.random() * 190,
        vx: side * (170 + Math.random() * 140),
        vy: 0,
      })
    }
  }

  private tickPose(b: Body | null, dt: number) {
    this.poseT -= dt
    if (!b) return
    let ok = false
    if (this.poseTask === 'arms') ok = b.armsUp
    else if (this.poseTask === 'squat') ok = b.squat
    else if (this.poseTask === 'spread') ok = b.feetSpread > 0.22 && b.armsUp
    else if (this.poseTask === 'jump') ok = b.jumping
    if (ok) {
      this.poseHold += dt
      if (this.poseHold > 0.55) {
        const gain = this.addCombo()
        this.ctx.audio.good()
        this.particles.burst(this.W / 2, 250, this.ctx.meta.color, 18, 420, 6)
        this.say(`+${gain}`, this.W / 2, 240, '#fff36b', 40)
        this.poseHold = 0
        this.poseT = 0
      }
    } else {
      this.poseHold = Math.max(0, this.poseHold - dt * 2)
    }
    if (this.poseT <= 0) {
      const pool = ['arms', 'squat', 'spread', 'jump']
      this.poseTask = pool[Math.floor(Math.random() * pool.length)]
      this.poseT = 6
    }
  }

  private taskText() {
    return this.poseTask === 'arms'
      ? '双手举高'
      : this.poseTask === 'squat'
        ? '蹲下来'
        : this.poseTask === 'spread'
          ? '张开双手双脚'
          : '跳一下'
  }

  paint(c: CanvasRenderingContext2D) {
    // 顶部提示
    const grd = c.createLinearGradient(0, 0, 0, 120)
    grd.addColorStop(0, 'rgba(10,14,40,.55)')
    grd.addColorStop(1, 'rgba(10,14,40,0)')
    c.fillStyle = grd
    c.fillRect(0, 0, this.W, 120)

    if (this.mode === 'pose') {
      const y = 160
      const pct = Math.min(1, this.poseHold / 0.55)
      c.save()
      c.globalAlpha = 0.92
      c.fillStyle = 'rgba(10,16,44,.55)'
      c.beginPath()
      c.roundRect(this.W / 2 - 190, y - 66, 380, 132, 34)
      c.fill()
      c.restore()
      outlineTxt(c, this.taskText(), this.W / 2, y - 16, 52)
      ring(c, this.W / 2, y + 44, 26, pct, '#3ddc97', 8)
    }

    for (const it of this.items) {
      c.save()
      c.translate(it.x, it.y)
      c.rotate(it.rot)
      if (it.ch === '💣') {
        glow(c, 0, 0, 70, '#ff5252', 0.5)
        circle(c, 0, 0, it.r, '#2b2b3d')
        txt(c, '💣', 0, 2, it.r * 1.5)
      } else {
        glow(c, 0, 0, it.r * 2.2, it.color, 0.35)
        circle(c, 0, 0, it.r, 'rgba(255,255,255,.92)')
        txt(c, it.ch, 0, 3, it.r * 1.5)
      }
      c.restore()
    }

    // 连击
    if (this.combo >= 3) {
      starPath(c, 96, this.H - 70, 26)
      c.fillStyle = '#ffd54a'
      c.fill()
      outlineTxt(c, `x${this.combo}`, 140, this.H - 70, 40, '#fff', 'rgba(0,0,0,.45)', 'left')
    }
  }
}

export default function create(ctx: GameContext) {
  return new GenericGame(ctx)
}
