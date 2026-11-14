import { BaseGame, segHit } from '@/core/base'
import type { Game, GameContext, PoseFrame } from '@/core/types'
import { glow, outlineTxt, ring, txt } from '@/core/draw'

type Kind = 'round' | 'oval' | 'crescent' | 'cluster'

interface FruitType {
  color: string
  color2: string
  kind: Kind
  leaf: boolean
}

const FRUITS: FruitType[] = [
  { color: '#ff4d6d', color2: '#c9184a', kind: 'round', leaf: true },      // 苹果
  { color: '#ff9f1c', color2: '#e85d04', kind: 'round', leaf: false },     // 橙子
  { color: '#ffd166', color2: '#f5a623', kind: 'oval', leaf: false },      // 柠檬
  { color: '#9b5de5', color2: '#6a2fb5', kind: 'cluster', leaf: true },    // 葡萄
  { color: '#7bc950', color2: '#3f8f22', kind: 'round', leaf: true },      // 青苹果
  { color: '#ff8fa3', color2: '#e5537a', kind: 'round', leaf: true },      // 桃子
  { color: '#ffe066', color2: '#e8b800', kind: 'crescent', leaf: false },  // 香蕉
  { color: '#66d9a3', color2: '#2f9e6b', kind: 'oval', leaf: false },      // 猕猴桃
]

interface Fruit {
  x: number
  y: number
  vx: number
  vy: number
  r: number
  type: FruitType
  rot: number
  spin: number
  alive: boolean
  bomb: boolean
  cut: boolean
  life: number
}

const G = 1500

function drawFruit(c: CanvasRenderingContext2D, r: number, t: FruitType) {
  const g = c.createRadialGradient(-r * 0.3, -r * 0.35, r * 0.15, 0, 0, r)
  g.addColorStop(0, t.color)
  g.addColorStop(1, t.color2)

  if (t.kind === 'crescent') {
    c.beginPath()
    c.arc(0, 0, r * 1.05, 0.35 * Math.PI, 1.65 * Math.PI)
    c.arc(-r * 0.15, 0, r * 0.72, 1.5 * Math.PI, 0.5 * Math.PI, true)
    c.closePath()
    c.fillStyle = g
    c.fill()
    return
  }

  if (t.kind === 'cluster') {
    const pts: [number, number, number][] = [
      [-r * 0.4, -r * 0.1, r * 0.42],
      [r * 0.36, -r * 0.2, r * 0.4],
      [0, -r * 0.45, r * 0.42],
      [-r * 0.18, r * 0.35, r * 0.46],
      [r * 0.3, r * 0.28, r * 0.4],
    ]
    for (const [x, y, rr] of pts) {
      const gg = c.createRadialGradient(x - rr * 0.3, y - rr * 0.3, rr * 0.1, x, y, rr)
      gg.addColorStop(0, t.color)
      gg.addColorStop(1, t.color2)
      c.beginPath()
      c.arc(x, y, rr, 0, Math.PI * 2)
      c.fillStyle = gg
      c.fill()
    }
    return
  }

  const rx = t.kind === 'oval' ? r * 0.78 : r
  const ry = t.kind === 'oval' ? r * 1.06 : r
  c.beginPath()
  c.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2)
  c.fillStyle = g
  c.fill()

  // 高光
  c.beginPath()
  c.ellipse(-rx * 0.34, -ry * 0.36, rx * 0.22, ry * 0.16, -0.6, 0, Math.PI * 2)
  c.fillStyle = 'rgba(255,255,255,.55)'
  c.fill()

  // 叶子/梗
  if (t.leaf) {
    c.strokeStyle = '#6b3e26'
    c.lineWidth = r * 0.12
    c.lineCap = 'round'
    c.beginPath()
    c.moveTo(0, -ry * 0.85)
    c.lineTo(0, -ry * 1.12)
    c.stroke()
    c.beginPath()
    c.ellipse(r * 0.34, -ry * 1.02, r * 0.3, r * 0.14, -0.5, 0, Math.PI * 2)
    c.fillStyle = '#4caf50'
    c.fill()
  }
}

function drawBomb(c: CanvasRenderingContext2D, r: number, t: number) {
  const g = c.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.1, 0, 0, r)
  g.addColorStop(0, '#4a4a5c')
  g.addColorStop(1, '#16161f')
  c.beginPath()
  c.arc(0, 0, r, 0, Math.PI * 2)
  c.fillStyle = g
  c.fill()
  c.beginPath()
  c.ellipse(-r * 0.32, -r * 0.34, r * 0.18, r * 0.12, -0.6, 0, Math.PI * 2)
  c.fillStyle = 'rgba(255,255,255,.35)'
  c.fill()
  // 引信
  c.strokeStyle = '#8a6a3a'
  c.lineWidth = r * 0.15
  c.lineCap = 'round'
  c.beginPath()
  c.moveTo(r * 0.12, -r * 0.9)
  c.quadraticCurveTo(r * 0.5, -r * 1.35, r * 0.2, -r * 1.55)
  c.stroke()
  // 火花
  const spark = 0.7 + Math.sin(t * 18) * 0.3
  c.beginPath()
  c.arc(r * 0.2, -r * 1.55, r * 0.26 * spark, 0, Math.PI * 2)
  c.fillStyle = '#ffcc33'
  c.fill()
  c.beginPath()
  c.arc(r * 0.2, -r * 1.55, r * 0.13 * spark, 0, Math.PI * 2)
  c.fillStyle = '#fff6cc'
  c.fill()
}

class FruitSlash extends BaseGame implements Game {
  fruits: Fruit[] = []
  score = 0
  combo = 0
  comboT = 0
  spawnT = 0.35
  sliceFx: { x: number; y: number; a: number; life: number; color: string }[] = []

  tick(_f: PoseFrame, dt: number) {
    this.spawnT -= dt
    if (this.spawnT <= 0) {
      this.spawnT = 0.95 - Math.min(0.3, this.ctx.difficulty * 0.08) + Math.random() * 0.4
      const n = Math.random() < 0.3 ? 2 : 1
      for (let i = 0; i < n; i++) this.spawn()
    }
    if (this.comboT > 0) {
      this.comboT -= dt
      if (this.comboT <= 0) {
        this.combo = 0
        this.ctx.setCombo(0)
      }
    }

    for (const fr of this.fruits) {
      if (!fr.alive) continue
      fr.vy += G * dt
      fr.x += fr.vx * dt
      fr.y += fr.vy * dt
      fr.rot += fr.spin * dt
      fr.life -= dt
      if (fr.y > this.H + 120 || fr.life <= 0) fr.alive = false
    }

    for (const pv of this.players) {
      const b = pv.body
      if (!b) continue
      const hands = [
        { sp: b.lHandV, c: pv.lHand },
        { sp: b.rHandV, c: pv.rHand },
      ]
      for (const h of hands) {
        if (h.sp < 0.5) continue
        const trail = h.c.trail
        if (trail.length < 2) continue
        const a = trail[trail.length - 2]
        const z = trail[trail.length - 1]
        for (const fr of this.fruits) {
          if (!fr.alive || fr.cut) continue
          if (segHit(a.x, a.y, z.x, z.y, fr.x, fr.y, fr.r + 18)) this.slice(fr)
        }
      }
    }

    this.fruits = this.fruits.filter((f) => f.alive)
    for (let i = this.sliceFx.length - 1; i >= 0; i--) {
      const s = this.sliceFx[i]
      s.life -= dt
      if (s.life <= 0) this.sliceFx.splice(i, 1)
    }
    this.ctx.setScore(this.score)
    this.ctx.setExtra('combo', this.combo)
  }

  private spawn() {
    const isBomb = Math.random() < 0.14
    const type = FRUITS[Math.floor(Math.random() * FRUITS.length)]
    const x = 140 + Math.random() * (this.W - 280)
    const targetH = 430 + Math.random() * 180
    const vy = -Math.sqrt(2 * G * targetH)
    const vx = (this.W / 2 - x) * 0.2 + (Math.random() - 0.5) * 70
    this.fruits.push({
      x,
      y: this.H + 70,
      vx,
      vy,
      r: 46 + Math.random() * 12,
      type,
      rot: Math.random() * 6,
      spin: (Math.random() - 0.5) * 2.4,
      alive: true,
      bomb: isBomb,
      cut: false,
      life: 6,
    })
  }

  private slice(fr: Fruit) {
    fr.cut = true
    fr.alive = false
    const color = fr.bomb ? '#ff5c5c' : fr.type.color
    this.sliceFx.push({ x: fr.x, y: fr.y, a: Math.atan2(fr.vy, fr.vx), life: 0.32, color })
    if (fr.bomb) {
      this.ctx.audio.hit()
      this.particles.burst(fr.x, fr.y, '#ff5c5c', 30, 560, 9)
      this.particles.burst(fr.x, fr.y, '#ffb703', 16, 380, 6)
      this.score = Math.max(0, this.score - 25)
      this.combo = 0
      this.ctx.setCombo(0)
      this.say('−25', fr.x, fr.y, '#ff6b6b', 44)
      this.ctx.setScore(this.score)
      return
    }
    this.combo++
    this.comboT = 0.9
    this.ctx.setCombo(this.combo)
    const gain = 10 + Math.min(30, (this.combo - 1) * 4)
    this.score += gain
    this.ctx.audio.slash()
    this.particles.burst(fr.x, fr.y, fr.type.color, 18, 400, 7)
    this.particles.burst(fr.x, fr.y, '#ffffff', 6, 240, 3)
    this.say(`+${gain}`, fr.x, fr.y - 10, this.combo >= 4 ? '#fff36b' : '#ffffff', 34)
    if (this.combo % 5 === 0) {
      this.ctx.audio.good()
      this.say(`连击 ${this.combo}！`, this.W / 2, 210, '#ffd54a', 52)
    }
  }

  paint(c: CanvasRenderingContext2D) {
    for (const s of this.sliceFx) {
      const k = s.life / 0.32
      c.save()
      c.translate(s.x, s.y)
      c.rotate(s.a)
      c.globalAlpha = k
      c.strokeStyle = '#fff'
      c.lineWidth = 9 * k
      c.lineCap = 'round'
      c.beginPath()
      c.moveTo(-110 * (1 - k), 0)
      c.lineTo(110 * (1 - k), 0)
      c.stroke()
      c.globalAlpha = 1
      c.restore()
    }

    for (const fr of this.fruits) {
      c.save()
      c.translate(fr.x, fr.y)
      if (fr.bomb) {
        glow(c, 0, 0, fr.r * 1.9, '#ff5c5c', 0.42)
      } else {
        glow(c, 0, 0, fr.r * 1.6, fr.type.color, 0.22)
      }
      c.rotate(fr.rot)
      if (fr.bomb) drawBomb(c, fr.r, this.t)
      else drawFruit(c, fr.r, fr.type)
      c.restore()
    }

    if (this.combo >= 2) {
      const pct = Math.max(0, this.comboT / 0.9)
      c.fillStyle = 'rgba(10,14,40,.42)'
      c.beginPath()
      c.roundRect(this.W / 2 - 118, 22, 236, 56, 28)
      c.fill()
      outlineTxt(c, `连击 ${this.combo}`, this.W / 2 - 16, 50, 30, '#ffd54a')
      ring(c, this.W / 2 + 86, 50, 18, pct, '#ffd54a', 5)
    }

    txt(c, '挥手切水果，别碰炸弹', this.W / 2, this.H - 34, 20, 'rgba(255,255,255,.8)', 'center', 'bold')
  }
}

export default function create(ctx: GameContext) {
  return new FruitSlash(ctx)
}
