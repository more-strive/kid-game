import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, glow, outlineTxt, ring, txt } from '@/core/draw'
import { drawItem, preloadItems } from '@/core/sprites'

/** 每个游戏用的球类素材 */
const BALL_ITEM: Record<string, string> = {
  hoops: 'basketball',
  'soccer-kick': 'soccer',
  goalkeeper: 'soccer',
  darts: 'dart',
  archery: 'dart',
  bowling: 'bowling',
  'air-pong': 'tennis',
  tennis: 'tennis',
  volley: 'volleyball',
  shuttlecock: 'shuttlecock',
  'frisbee-dog': 'frisbee',
  aim: 'basketball',
}

/** 投掷/瞄准类原型：对准移动的目标，挥手把球投出去 */
type TargetKind = 'hoop' | 'board' | 'pins' | 'goal' | 'net' | 'ring'

interface Theme {
  kind: TargetKind
  color: string
  ball: 'basketball' | 'football' | 'dart' | 'ball' | 'shuttle'
  label: string
  /** 用脚踢 */
  kick: boolean
}

const THEMES: Record<string, Theme> = {
  hoops: { kind: 'hoop', color: '#ff7a45', ball: 'basketball', label: '投篮', kick: false },
  darts: { kind: 'board', color: '#ff4d6d', ball: 'dart', label: '投镖', kick: false },
  archery: { kind: 'board', color: '#3ddc97', ball: 'dart', label: '射箭', kick: false },
  bowling: { kind: 'pins', color: '#4cc9f0', ball: 'ball', label: '保龄球', kick: false },
  'soccer-kick': { kind: 'goal', color: '#3ddc97', ball: 'football', label: '射门', kick: true },
  goalkeeper: { kind: 'goal', color: '#ffb703', ball: 'football', label: '扑救', kick: false },
  'air-pong': { kind: 'net', color: '#7c5cff', ball: 'ball', label: '对打', kick: false },
  tennis: { kind: 'net', color: '#ffd54a', ball: 'ball', label: '对打', kick: false },
  volley: { kind: 'net', color: '#4cc9f0', ball: 'ball', label: '垫球', kick: false },
  shuttlecock: { kind: 'net', color: '#ff8fa3', ball: 'shuttle', label: '踢毽子', kick: true },
  'frisbee-dog': { kind: 'ring', color: '#3ddc97', ball: 'ball', label: '扔飞盘', kick: false },
  'stone-skip': { kind: 'net', color: '#7c5cff', ball: 'ball', label: '打水漂', kick: false },
  aim: { kind: 'hoop', color: '#ff7a45', ball: 'ball', label: '投掷', kick: false },
}

interface Ball {
  x: number
  y: number
  vx: number
  vy: number
  r: number
  alive: boolean
  scored: boolean
  color: string
  spin: number
}

const G = 1000

class AimGame extends BaseGame implements Game {
  theme: Theme
  target = { x: 640, y: 200, r: 68, dir: 1, speed: 150 }
  balls: Ball[] = []
  score = 0
  hits = 0
  throws = 0
  combo = 0
  cool = 0
  private prevHand: { x: number; y: number } | null = null
  private prevFoot: { x: number; y: number } | null = null

  constructor(ctx: GameContext) {
    super(ctx)
    this.theme = THEMES[ctx.meta.slug] ?? THEMES.aim
    this.target.speed = 210 + ctx.difficulty * 70
    preloadItems(['basketball', 'soccer', 'dart', 'bowling', 'tennis', 'volleyball', 'shuttlecock', 'frisbee'])
  }

  tick(f: PoseFrame, dt: number) {
    this.cool = Math.max(0, this.cool - dt)
    const b = f.bodies[0] ?? null

    // 目标左右移动
    this.target.x += this.target.dir * this.target.speed * dt
    if (this.target.x > this.W - 200) {
      this.target.x = this.W - 200
      this.target.dir = -1
    }
    if (this.target.x < 200) {
      this.target.x = 200
      this.target.dir = 1
    }

    if (b && this.cool <= 0) this.tryThrow(b)

    for (const bl of this.balls) {
      if (!bl.alive) continue
      bl.vy += G * dt
      bl.x += bl.vx * dt
      bl.y += bl.vy * dt
      bl.spin += dt * 8
      if (!bl.scored && Math.hypot(bl.x - this.target.x, bl.y - this.target.y) < this.target.r + bl.r) {
        this.scoreHit(bl)
      }
      if (bl.y > this.H + 80 || bl.x < -80 || bl.x > this.W + 80) bl.alive = false
    }
    this.balls = this.balls.filter((x) => x.alive)
    this.ctx.setScore(this.score)
  }

  private tryThrow(b: Body) {
    const useFoot = this.theme.kick
    const hand = useFoot
      ? { x: b.lFoot.x, y: b.lFoot.y, v: 0 }
      : b.lHandV > b.rHandV
        ? { x: b.lHand.x, y: b.lHand.y, v: b.lHandV }
        : { x: b.rHand.x, y: b.rHand.y, v: b.rHandV }
    const prev = useFoot ? this.prevFoot : this.prevHand
    this.prevHand = { x: b.lHand.x, y: b.lHand.y }
    this.prevFoot = { x: b.lFoot.x, y: b.lFoot.y }
    if (!prev) return

    const up = prev.y - hand.y
    const speed = Math.hypot(hand.x - prev.x, hand.y - prev.y)
    const isThrow = useFoot
      ? up > 0.022 || (b.lFoot.y < 0.78 && up > 0.012)
      : hand.v > 0.85 || speed > 0.1

    if (!isThrow || speed < 0.02) return
    this.cool = 0.78
    this.throws++
    const hx = hand.x * this.W
    const hy = hand.y * this.H
    // 目标本身在动，再叠一点瞄准误差，投太急就会偏
    const tx = this.target.x + (Math.random() - 0.5) * 90
    const ty = this.target.y + (Math.random() - 0.5) * 40
    const dist = Math.hypot(tx - hx, ty - hy) || 1
    const power = 1180
    // 朝目标飞（飞行中目标会移动，需要预判）
    const vx = ((tx - hx) / dist) * power
    const vy = ((ty - hy) / dist) * power - 260
    this.balls.push({
      x: hx,
      y: hy,
      vx,
      vy,
      r: this.theme.ball === 'basketball' ? 22 : 18,
      alive: true,
      scored: false,
      color: this.theme.color,
      spin: 0,
    })
    this.ctx.audio.pop()
  }

  private scoreHit(bl: Ball) {
    bl.scored = true
    bl.alive = false
    this.hits++
    this.combo++
    const gain = 20 + Math.min(30, this.combo * 5)
    this.score += gain
    this.ctx.setCombo(this.combo)
    this.ctx.setExtra('hits', this.hits)
    this.ctx.audio.good()
    this.particles.burst(bl.x, bl.y, this.theme.color, 20, 420, 7)
    this.say(`+${gain}`, this.target.x, this.target.y - 40, '#fff36b', 40)
    if (this.combo > 0 && this.combo % 3 === 0) {
      this.ctx.speak('好球')
      this.target.speed += 20
    }
  }

  private drawTarget(c: CanvasRenderingContext2D) {
    const { x, y, r } = this.target
    const t = this.theme
    glow(c, x, y, r * 2, t.color, 0.25)
    if (t.kind === 'hoop') {
      c.strokeStyle = t.color
      c.lineWidth = 8
      c.beginPath()
      c.ellipse(x, y, r, r * 0.34, 0, 0, Math.PI * 2)
      c.stroke()
      // 网
      c.strokeStyle = 'rgba(255,255,255,.75)'
      c.lineWidth = 3
      for (let i = -3; i <= 3; i++) {
        c.beginPath()
        c.moveTo(x + i * (r / 3.4), y)
        c.lineTo(x + i * (r / 6), y + r * 0.62)
        c.stroke()
      }
      c.beginPath()
      c.moveTo(x - r * 0.55, y + r * 0.62)
      c.lineTo(x + r * 0.55, y + r * 0.62)
      c.stroke()
      // 篮板
      c.fillStyle = 'rgba(255,255,255,.85)'
      c.beginPath()
      c.roundRect(x - r * 1.35, y - r * 1.1, r * 2.7, r * 0.9, 8)
      c.fill()
    } else if (t.kind === 'board') {
      for (let i = 4; i >= 1; i--) {
        c.beginPath()
        c.arc(x, y, (r * i) / 4, 0, Math.PI * 2)
        c.fillStyle = i % 2 === 0 ? '#f7f9ff' : t.color
        c.fill()
      }
      circle(c, x, y, r * 0.12, '#ffd54a')
    } else if (t.kind === 'pins') {
      for (let i = -1; i <= 1; i++) {
        const px = x + i * 52
        const py = y + (i === 0 ? -14 : 10)
        c.fillStyle = '#ffffff'
        c.beginPath()
        c.ellipse(px, py, 16, 30, 0, 0, Math.PI * 2)
        c.fill()
        c.strokeStyle = t.color
        c.lineWidth = 4
        c.beginPath()
        c.arc(px, py - 12, 9, 0, Math.PI * 2)
        c.stroke()
      }
    } else if (t.kind === 'goal') {
      c.strokeStyle = 'rgba(255,255,255,.9)'
      c.lineWidth = 9
      c.strokeRect(x - r * 1.3, y - r * 0.6, r * 2.6, r * 1.5)
      c.strokeStyle = 'rgba(255,255,255,.35)'
      c.lineWidth = 2
      for (let i = 1; i < 8; i++) {
        c.beginPath()
        c.moveTo(x - r * 1.3 + (i * r * 2.6) / 8, y - r * 0.6)
        c.lineTo(x - r * 1.3 + (i * r * 2.6) / 8, y + r * 0.9)
        c.stroke()
      }
    } else if (t.kind === 'ring') {
      c.strokeStyle = t.color
      c.lineWidth = 12
      c.beginPath()
      c.ellipse(x, y, r, r * 0.4, 0, 0, Math.PI * 2)
      c.stroke()
    } else {
      // net
      c.strokeStyle = 'rgba(255,255,255,.85)'
      c.lineWidth = 5
      c.beginPath()
      c.moveTo(x - r * 1.4, y)
      c.lineTo(x + r * 1.4, y)
      c.stroke()
      for (let i = -4; i <= 4; i++) {
        c.beginPath()
        c.moveTo(x + i * (r / 2.6), y - 40)
        c.lineTo(x + i * (r / 2.6), y + r * 1.6)
        c.strokeStyle = 'rgba(255,255,255,.3)'
        c.lineWidth = 2
        c.stroke()
      }
    }
  }

  private drawBall(c: CanvasRenderingContext2D, bl: Ball) {
    c.save()
    c.translate(bl.x, bl.y)
    c.rotate(bl.spin)
    const pic = BALL_ITEM[this.ctx.meta.slug]
    if (pic && drawItem(c, pic, 0, 0, bl.r * 2.5)) {
      c.restore()
      return
    }
    const kind = this.theme.ball
    if (kind === 'basketball' || kind === 'football') {
      circle(c, 0, 0, bl.r, kind === 'basketball' ? '#ff8a3d' : '#ffffff')
      c.strokeStyle = kind === 'basketball' ? '#a33f10' : '#2b2b3d'
      c.lineWidth = 2.5
      c.beginPath()
      c.arc(0, 0, bl.r, 0, Math.PI * 2)
      c.stroke()
      c.beginPath()
      c.moveTo(-bl.r, 0)
      c.lineTo(bl.r, 0)
      c.moveTo(0, -bl.r)
      c.lineTo(0, bl.r)
      c.stroke()
      if (kind === 'football') {
        for (let i = 0; i < 5; i++) {
          circle(c, Math.cos((i / 5) * 6.28) * bl.r * 0.45, Math.sin((i / 5) * 6.28) * bl.r * 0.45, bl.r * 0.2, '#2b2b3d')
        }
      }
    } else if (kind === 'dart') {
      c.fillStyle = '#e8eefc'
      c.beginPath()
      c.moveTo(bl.r, 0)
      c.lineTo(-bl.r, -bl.r * 0.4)
      c.lineTo(-bl.r * 0.4, 0)
      c.lineTo(-bl.r, bl.r * 0.4)
      c.closePath()
      c.fill()
      circle(c, bl.r * 0.7, 0, bl.r * 0.28, '#ff4d6d')
    } else if (kind === 'shuttle') {
      c.fillStyle = '#ffffff'
      c.beginPath()
      c.ellipse(0, -bl.r * 0.3, bl.r * 0.9, bl.r * 0.42, 0, 0, Math.PI * 2)
      c.fill()
      circle(c, 0, bl.r * 0.4, bl.r * 0.34, this.theme.color)
    } else {
      circle(c, 0, 0, bl.r, this.theme.color)
      circle(c, -bl.r * 0.3, -bl.r * 0.3, bl.r * 0.32, 'rgba(255,255,255,.55)')
    }
    c.restore()
  }

  paint(c: CanvasRenderingContext2D) {
    this.drawTarget(c)
    for (const bl of this.balls) this.drawBall(c, bl)

    // 命中数与命中率
    const acc = this.throws ? Math.round((this.hits / this.throws) * 100) : 0
    c.fillStyle = 'rgba(10,14,40,.4)'
    c.beginPath()
    c.roundRect(24, 24, 200, 52, 26)
    c.fill()
    outlineTxt(c, `命中 ${this.hits}${this.throws > 3 ? ` · ${acc}%` : ''}`, 124, 50, 24, '#ffd54a')

    if (this.combo >= 2) {
      c.fillStyle = 'rgba(10,14,40,.42)'
      c.beginPath()
      c.roundRect(this.W / 2 - 105, 24, 210, 52, 26)
      c.fill()
      outlineTxt(c, `连中 ${this.combo}`, this.W / 2, 50, 26, '#ffd54a')
    }

    // 冷却环（提示可以再投）
    const ready = this.cool <= 0
    ring(c, this.W - 70, this.H - 70, 26, ready ? 1 : 1 - this.cool / 0.32, ready ? '#3ddc97' : 'rgba(255,255,255,.5)', 7)
    txt(c, ready ? '可以投' : '等一下', this.W - 70, this.H - 32, 13, 'rgba(255,255,255,.85)', 'center', 'bold')

    txt(
      c,
      this.theme.kick ? '把球踢向目标' : '对准目标，挥手投出去',
      this.W / 2,
      this.H - 30,
      20,
      'rgba(255,255,255,.82)',
      'center',
      'bold',
    )
  }
}

export default function create(ctx: GameContext) {
  return new AimGame(ctx)
}
