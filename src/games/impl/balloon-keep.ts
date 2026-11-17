import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, glow, outlineTxt, txt } from '@/core/draw'

interface Balloon {
  x: number
  y: number
  vx: number
  vy: number
  r: number
  colorIdx: number
  color: string
  spin: number
  alive: boolean
  /** 上次被有效命中的时刻（每球独立 0.28s 冷却） */
  lastHit: number
  /** 重生时刻（真实时钟秒）；-1 表示在场上 */
  respawnAt: number
  owner: number
}

/** 对齐站点真实难度表：气球数 / 半径系数 / 时间加速系数 */
const DIFF = [
  { count: 2, r: 0.9, speed: 0.7 },
  { count: 3, r: 0.75, speed: 1 },
  { count: 4, r: 0.66, speed: 1.3 },
]
const COLORS = ['#ff5c8a', '#ffd166', '#4cc9f0', '#9b5de5', '#3ddc97']

/** 部位加力系数（对齐站点 d 表：hand 1, head 0.8, 其它 0.7） */
const POWER: Record<string, number> = { hand: 1, head: 0.8, elbow: 0.7, knee: 0.7, foot: 0.7 }
/** 非手部位命中半径缩放（对齐站点 f 表） */
const RADII: Record<string, number> = { hand: 1, head: 0.9, elbow: 1, knee: 0.85, foot: 0.8 }
/** 我们框架里部位的基础碰撞半径（站点用骨骼估计半径，这里取近似值） */
const BASE_R: Record<string, number> = { hand: 0.42, head: 0.32, elbow: 0.25, knee: 0.28, foot: 0.26 }

/** 可碰的部位列表：id → 从 Body 取位置的字段 */
const PARTS: { id: string; pick: (b: Body) => { x: number; y: number } }[] = [
  { id: 'hand', pick: (b) => b.lHand },
  { id: 'hand', pick: (b) => b.rHand },
  { id: 'head', pick: (b) => b.head },
  { id: 'elbow', pick: (b) => b.lElbow },
  { id: 'elbow', pick: (b) => b.rElbow },
  { id: 'knee', pick: (b) => b.lKnee },
  { id: 'knee', pick: (b) => b.rKnee },
  { id: 'foot', pick: (b) => b.lFoot },
  { id: 'foot', pick: (b) => b.rFoot },
]

const COOLDOWN = 0.28 // 同一气球两次有效命中的最小间隔
const RESPAWN = 1.3 // 落地爆掉后 1.3s 重生

/** 托气球：气球从天上掉下来，用手/头/脚把它顶上去；落地就爆，别让它着地 */
class BalloonKeep extends BaseGame implements Game {
  balloons: Balloon[] = []
  score = 0
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  /** 基准长度单位（对齐站点 g = H/8.73） */
  g = this.H / 8.73
  /** 各玩家各部位的上一帧位置，用于估算部位速度 */
  private prevParts: ({ x: number; y: number; vx: number; vy: number } | null)[][] = [
    PARTS.map(() => null),
    PARTS.map(() => null),
  ]

  constructor(ctx: GameContext) {
    super(ctx)
    // 对齐站点：第 i 个球在 0.4 + i×1.4s 依次登场
    const total = this.cfg.count + (this.present() > 1 ? 1 : 0)
    for (let i = 0; i < total; i++) {
      this.balloons.push({
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        r: this.cfg.r * this.g,
        colorIdx: i % COLORS.length,
        color: COLORS[i % COLORS.length],
        spin: Math.random() * 10,
        alive: false, // 等 respawnAt 到点再从天上落下
        lastHit: -10,
        respawnAt: 0.4 + i * 1.4,
        owner: i % Math.max(1, this.present()),
      })
    }
  }

  /** 当前检测到的人数 */
  private present() {
    return this.players.filter((p) => p.body).length
  }

  /** 玩家的水平分区（单人不限，双人各半） */
  private zone(owner: number) {
    if (this.present() <= 1) return { x0: this.W * 0.06, x1: this.W * 0.94 }
    return owner === 0 ? { x0: this.W * 0.05, x1: this.W * 0.48 } : { x0: this.W * 0.52, x1: this.W * 0.95 }
  }

  /** 重生一个气球：屏外上方落下，出生点在属主分区内且与其它球水平距离 > 2.2r（尝试 8 次） */
  private respawn(bl: Balloon) {
    const z = this.zone(bl.owner)
    const r = bl.r
    let x = z.x0 + 1.5 * r + Math.random() * Math.max(1, z.x1 - z.x0 - 3 * r)
    for (let t = 0; t < 8; t++) {
      const cand = z.x0 + 1.5 * r + Math.random() * Math.max(1, z.x1 - z.x0 - 3 * r)
      x = cand
      if (this.balloons.every((o) => o === bl || !o.alive || Math.abs(o.x - cand) > 2.2 * r)) break
    }
    bl.x = x
    bl.y = -1.6 * r
    bl.vx = (Math.random() - 0.5) * 0.6 * this.g
    bl.vy = 0.6 * this.g
    bl.alive = true
    bl.respawnAt = -1
    bl.lastHit = -10
  }

  /** 估算部位速度（像素/秒），限幅到 12g（对齐站点部位速度限幅） */
  private partCollider(pi: number, idx: number, b: Body, dt: number) {
    const pos = PARTS[idx].pick(b)
    const px = pos.x * this.W
    const py = pos.y * this.H
    const prev = this.prevParts[pi][idx]
    let vx = 0
    let vy = 0
    if (prev && dt > 0.001) {
      vx = (px - prev.x) / dt
      vy = (py - prev.y) / dt
    }
    this.prevParts[pi][idx] = { x: px, y: py, vx, vy }
    const cap = 12 * this.g
    const sp = Math.hypot(vx, vy)
    if (sp > cap) {
      vx = (vx / sp) * cap
      vy = (vy / sp) * cap
    }
    const kind = PARTS[idx].id
    const hr = kind === 'hand' ? Math.max(0.42 * this.g, BASE_R.hand * this.g) : BASE_R[kind] * this.g * RADII[kind]
    return { x: px, y: py, vx, vy, r: hr, kind }
  }

  tick(f: PoseFrame, dt: number) {
    const speed = this.cfg.speed
    const g = this.g
    const now = this.realClock
    const dtC = Math.max(0.001, dt)

    // 部位碰撞体（每人最多 9 个）
    const colliders: (ReturnType<BalloonKeep['partCollider']> & { owner: number })[] = []
    for (let pi = 0; pi < 2; pi++) {
      const b = f.bodies[pi]
      if (!b) continue
      for (let idx = 0; idx < PARTS.length; idx++) {
        const c = this.partCollider(pi, idx, b, dtC)
        colliders.push({ ...c, owner: pi })
      }
    }

    for (const bl of this.balloons) {
      if (!bl.alive) {
        if (now >= bl.respawnAt) this.respawn(bl)
        continue
      }
      // 物理（对齐站点：重力 1.15g·speed，阻力 e^(-0.5dt)，下落终速 2.3g·speed）
      bl.vy += 1.15 * speed * g * dt
      const drag = Math.exp(-dt * 0.5)
      bl.vx *= drag
      bl.vy *= drag
      bl.vy = Math.min(bl.vy, 2.3 * speed * g)
      bl.x += bl.vx * dt
      bl.y += bl.vy * dt
      bl.spin += dt * 1.3

      // 左右墙：恢复 0.7；顶：恢复 0.3
      if (bl.x < bl.r) {
        bl.x = bl.r
        bl.vx = Math.abs(bl.vx) * 0.7
      }
      if (bl.x > this.W - bl.r) {
        bl.x = this.W - bl.r
        bl.vx = -Math.abs(bl.vx) * 0.7
      }
      if (bl.y < 0.6 * bl.r && bl.vy < 0) bl.vy = -bl.vy * 0.3

      // 落地 = 爆（0.9H 失败线）：无扣分，1.3s 后重生
      if (bl.y + 1.05 * bl.r > this.H * 0.9) {
        bl.alive = false
        bl.respawnAt = now + RESPAWN
        this.ctx.audio.pop()
        this.particles.burst(bl.x, bl.y, bl.color, 26, 420, 6)
        this.say('啪！', bl.x, bl.y - 30, '#7a6b8a', 40)
        continue
      }

      // 部位命中（圆-圆）：全体部位都能碰任何球（对齐站点：物理不分区，仅出生/AI 分区）
      for (const c of colliders) {
        const d = Math.hypot(c.x - bl.x, c.y - bl.y)
        if (d >= bl.r + c.r) continue
        // 接触面校正：气球放到接触点外
        const nx = (bl.x - c.x) / (d || 1)
        const ny = (bl.y - c.y) / (d || 1)
        bl.x = c.x + nx * (bl.r + c.r)
        bl.y = c.y + ny * (bl.r + c.r)
        // 法向反弹（接近速度 ×1.6）+ 挥动传力（0.35 × 部位速度 × 加力系数）
        const approach = (bl.vx - c.vx) * nx + (bl.vy - c.vy) * ny
        const power = POWER[c.kind] ?? 0.7
        if (approach < 0) {
          bl.vx += nx * (-1.6 * approach)
          bl.vy += ny * (-1.6 * approach)
        }
        bl.vx += c.vx * 0.35 * power
        bl.vy += c.vy * 0.35 * power
        // 向上保底：不是从正上方下压（法线 y < 0.4）时，强制给一个上升速度
        if (ny < 0.4) {
          bl.vy = Math.min(bl.vy, -(3 * g + Math.max(0, -c.vy) * 0.25) * power * Math.sqrt(speed))
        }
        // 总速度限幅 9g
        const sp = Math.hypot(bl.vx, bl.vy)
        const cap = 9 * g
        if (sp > cap) {
          bl.vx = (bl.vx / sp) * cap
          bl.vy = (bl.vy / sp) * cap
        }
        // 计分：+1/次，0.28s/球冷却；每 10 次出里程碑
        if (now - bl.lastHit > COOLDOWN) {
          bl.lastHit = now
          this.score++
          this.ctx.setScore(this.score)
          // 命中音随气球颜色变调（对齐站点 0.85 + color×0.07）
          this.ctx.audio.play('score', 1, 0.85 + bl.colorIdx * 0.07)
          this.particles.burst(bl.x, bl.y - bl.r * 1.3, bl.color, 8, 260, 4)
          this.say('+1', bl.x, bl.y - bl.r * 1.3, '#fff36b', 24)
          if (c.kind === 'head') this.say('头顶！', bl.x, bl.y - bl.r * 2, bl.color, 36)
          if (c.kind === 'foot' || c.kind === 'knee') this.say('脚踢！', bl.x, bl.y - bl.r * 2, bl.color, 36)
          if (this.score > 0 && this.score % 10 === 0) {
            this.ctx.audio.good()
            for (let k = 0; k < 6; k++) {
              this.particles.burst(((k + 0.5) / 6) * this.W, this.H * 0.15, COLORS[k % COLORS.length], 8, 380, 4)
            }
            this.bannerText = `${this.score} 下！`
            this.bannerT = 1.2
          }
        }
      }
    }

    // 气球间碰撞：推开重叠 + 沿法线交换接近速度 ×0.9
    const live = this.balloons.filter((b) => b.alive)
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i]
        const b2 = live[j]
        const dx = b2.x - a.x
        const dy = b2.y - a.y
        const d = Math.hypot(dx, dy)
        if (d >= a.r + b2.r || d < 1) continue
        const nx = dx / d
        const ny = dy / d
        const overlap = (a.r + b2.r - d) / 2
        a.x -= nx * overlap
        a.y -= ny * overlap
        b2.x += nx * overlap
        b2.y += ny * overlap
        const approach = (b2.vx - a.vx) * nx + (b2.vy - a.vy) * ny
        if (approach < 0) {
          a.vx += nx * approach * 0.9
          a.vy += ny * approach * 0.9
          b2.vx -= nx * approach * 0.9
          b2.vy -= ny * approach * 0.9
        }
      }
    }

    this.ctx.setScore(this.score)
  }

  bannerText = ''
  bannerT = 0
  private realClock = 0

  update(f: PoseFrame, dt: number) {
    this.realClock += dt
    this.bannerT = Math.max(0, this.bannerT - dt)
    super.update(f, dt)
  }

  paint(c: CanvasRenderingContext2D) {
    // 地面失败线（0.9H）
    c.save()
    c.strokeStyle = 'rgba(255,255,255,.28)'
    c.lineWidth = 3
    c.setLineDash([16, 12])
    c.beginPath()
    c.moveTo(0, this.H * 0.9)
    c.lineTo(this.W, this.H * 0.9)
    c.stroke()
    c.restore()

    for (const bl of this.balloons) {
      if (!bl.alive) continue
      // 倾角：速度倾斜 + 待机摇摆（对齐站点）
      const tilt = Math.max(-0.5, Math.min(0.5, (bl.vx / this.g) * 0.08)) + Math.sin(this.realClock * 1.3 + bl.spin) * 0.06
      const falling = bl.vy > 0.6 * this.g && bl.y > this.H * 0.9 - 2.2 * this.g
      c.save()
      c.translate(bl.x, bl.y)
      c.rotate(tilt)
      glow(c, 0, 0, bl.r * 2.2, bl.color, falling ? 0.42 : 0.3)
      // 绳子
      c.beginPath()
      c.moveTo(0, bl.r * 1.05)
      c.quadraticCurveTo(Math.sin(bl.spin) * 8, bl.r * 1.5, Math.sin(bl.spin * 1.4) * 6, bl.r * 1.9)
      c.strokeStyle = 'rgba(255,255,255,.55)'
      c.lineWidth = 2.5
      c.stroke()
      // 气球
      c.beginPath()
      c.ellipse(0, 0, bl.r * 0.92, bl.r, 0, 0, Math.PI * 2)
      c.fillStyle = bl.color
      c.fill()
      c.beginPath()
      c.ellipse(-bl.r * 0.3, -bl.r * 0.32, bl.r * 0.22, bl.r * 0.3, -0.5, 0, Math.PI * 2)
      c.fillStyle = 'rgba(255,255,255,.55)'
      c.fill()
      // 表情（下落快且接近地面 → 受惊 O 嘴）
      const eye = falling ? 5.5 : 4.5
      circle(c, -16, -2, eye, 'rgba(30,30,60,.8)')
      circle(c, 16, -2, eye, 'rgba(30,30,60,.8)')
      c.beginPath()
      if (falling) {
        c.arc(0, 12, 8, 0, Math.PI * 2)
        c.fillStyle = 'rgba(30,30,60,.8)'
        c.fill()
      } else {
        c.arc(0, 8, 10, 0.15 * Math.PI, 0.85 * Math.PI)
        c.strokeStyle = 'rgba(30,30,60,.8)'
        c.lineWidth = 3
        c.stroke()
      }
      // 结
      c.beginPath()
      c.moveTo(-7, bl.r * 0.98)
      c.lineTo(7, bl.r * 0.98)
      c.lineTo(0, bl.r * 1.12)
      c.closePath()
      c.fillStyle = bl.color
      c.fill()
      c.restore()
    }

    // 里程碑横幅
    if (this.bannerT > 0) {
      c.globalAlpha = Math.min(1, this.bannerT / 0.3)
      outlineTxt(c, this.bannerText, this.W / 2, this.H * 0.24, 52, '#ffd54a')
      c.globalAlpha = 1
    }
    txt(c, '把气球顶上去别让它落地：手、头、脚都能碰，落地就爆', this.W / 2, this.H - 30, 20, 'rgba(255,255,255,.8)', 'center', 'bold')
  }
}

export default function create(ctx: GameContext) {
  return new BalloonKeep(ctx)
}
