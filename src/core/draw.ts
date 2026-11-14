export type C2D = CanvasRenderingContext2D

export const W = 1280
export const H = 720

export function rr(c: C2D, x: number, y: number, w: number, h: number, r = 16) {
  const rad = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2)
  c.beginPath()
  c.moveTo(x + rad, y)
  c.arcTo(x + w, y, x + w, y + h, rad)
  c.arcTo(x + w, y + h, x, y + h, rad)
  c.arcTo(x, y + h, x, y, rad)
  c.arcTo(x, y, x + w, y, rad)
  c.closePath()
}

export function circle(c: C2D, x: number, y: number, r: number, fill: string) {
  c.beginPath()
  c.arc(x, y, r, 0, Math.PI * 2)
  c.fillStyle = fill
  c.fill()
}

export function txt(
  c: C2D,
  s: string,
  x: number,
  y: number,
  size = 32,
  color = '#fff',
  align: CanvasTextAlign = 'center',
  weight: string | number = 'bold',
  font = '"PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
) {
  c.font = `${weight} ${size}px ${font}`
  c.textAlign = align
  c.textBaseline = 'middle'
  c.fillStyle = color
  c.fillText(s, x, y)
}

export function outlineTxt(
  c: C2D,
  s: string,
  x: number,
  y: number,
  size = 42,
  color = '#fff',
  stroke = 'rgba(20,24,60,.72)',
  align: CanvasTextAlign = 'center',
  weight: string | number = 900,
) {
  c.font = `${weight} ${size}px "PingFang SC","Microsoft YaHei",system-ui,sans-serif`
  c.textAlign = align
  c.textBaseline = 'middle'
  c.lineWidth = Math.max(3, size * 0.16)
  c.strokeStyle = stroke
  c.lineJoin = 'round'
  c.strokeText(s, x, y)
  c.fillStyle = color
  c.fillText(s, x, y)
}

export function emoji(c: C2D, ch: string, x: number, y: number, size = 48) {
  c.font = `${size}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`
  c.textAlign = 'center'
  c.textBaseline = 'middle'
  c.fillText(ch, x, y)
}

export function starPath(c: C2D, x: number, y: number, r: number, points = 5) {
  c.beginPath()
  for (let i = 0; i < points * 2; i++) {
    const rad = i % 2 === 0 ? r : r * 0.44
    const a = (Math.PI / points) * i - Math.PI / 2
    const px = x + Math.cos(a) * rad
    const py = y + Math.sin(a) * rad
    i === 0 ? c.moveTo(px, py) : c.lineTo(px, py)
  }
  c.closePath()
}

export function star(c: C2D, x: number, y: number, r: number, color = '#ffd54a') {
  starPath(c, x, y, r)
  c.fillStyle = color
  c.fill()
}

export function ring(c: C2D, x: number, y: number, r: number, pct: number, color = '#3ddc97', width = 10) {
  c.beginPath()
  c.arc(x, y, r, 0, Math.PI * 2)
  c.strokeStyle = 'rgba(255,255,255,.18)'
  c.lineWidth = width
  c.stroke()
  c.beginPath()
  c.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0, Math.min(1, pct)))
  c.strokeStyle = color
  c.lineCap = 'round'
  c.lineWidth = width
  c.stroke()
}

export function bg(c: C2D, top: string, bottom: string) {
  const g = c.createLinearGradient(0, 0, 0, H)
  g.addColorStop(0, top)
  g.addColorStop(1, bottom)
  c.fillStyle = g
  c.fillRect(0, 0, W, H)
}

export function glow(c: C2D, x: number, y: number, r: number, color: string, alpha = 0.5) {
  const g = c.createRadialGradient(x, y, 0, x, y, r)
  g.addColorStop(0, color)
  g.addColorStop(1, 'rgba(0,0,0,0)')
  c.globalAlpha = alpha
  c.fillStyle = g
  c.beginPath()
  c.arc(x, y, r, 0, Math.PI * 2)
  c.fill()
  c.globalAlpha = 1
}

interface P {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  max: number
  color: string
  size: number
  ch?: string
  gravity: number
}

export class Particles {
  list: P[] = []

  burst(x: number, y: number, color: string, n = 14, spread = 340, size = 6, gravity = 900, ch?: string) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const sp = spread * (0.35 + Math.random() * 0.65)
      const max = 0.45 + Math.random() * 0.5
      this.list.push({
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 60,
        life: max,
        max,
        color,
        size: size * (0.5 + Math.random()),
        ch,
        gravity,
      })
    }
  }

  confetti(w: number, n = 60) {
    const colors = ['#ff3385', '#ffd54a', '#3ddc97', '#3390fc', '#a78bfa']
    for (let i = 0; i < n; i++) {
      const max = 1.4 + Math.random()
      this.list.push({
        x: Math.random() * w,
        y: -20,
        vx: (Math.random() - 0.5) * 160,
        vy: 80 + Math.random() * 160,
        life: max,
        max,
        color: colors[i % colors.length],
        size: 5 + Math.random() * 6,
        gravity: 120,
      })
    }
  }

  update(dt: number) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i]
      p.life -= dt
      if (p.life <= 0) {
        this.list.splice(i, 1)
        continue
      }
      p.vy += p.gravity * dt
      p.x += p.vx * dt
      p.y += p.vy * dt
    }
  }

  draw(c: C2D) {
    for (const p of this.list) {
      const a = Math.min(1, p.life / p.max * 1.6)
      c.globalAlpha = a
      if (p.ch) {
        emoji(c, p.ch, p.x, p.y, p.size * 3)
      } else {
        c.fillStyle = p.color
        c.beginPath()
        c.arc(p.x, p.y, p.size, 0, Math.PI * 2)
        c.fill()
      }
    }
    c.globalAlpha = 1
  }

  clear() {
    this.list.length = 0
  }
}

/** 手部光标：糖果色光点 + 拖尾 */
export class Cursor {
  x: number
  y: number
  color: string
  trail: { x: number; y: number }[] = []
  active = false

  constructor(x = 0, y = 0, color = '#ffd54a') {
    this.x = x
    this.y = y
    this.color = color
  }

  move(x: number, y: number) {
    this.x = x
    this.y = y
    this.active = true
    this.trail.push({ x, y })
    if (this.trail.length > 9) this.trail.shift()
  }

  draw(c: C2D) {
    if (!this.active) return
    for (let i = 0; i < this.trail.length; i++) {
      const t = this.trail[i]
      const k = (i + 1) / this.trail.length
      c.globalAlpha = k * 0.35
      circle(c, t.x, t.y, 22 * k, this.color)
    }
    c.globalAlpha = 1
    glow(c, this.x, this.y, 52, this.color, 0.55)
    circle(c, this.x, this.y, 15, '#fff')
    circle(c, this.x, this.y, 9, this.color)
  }
}
