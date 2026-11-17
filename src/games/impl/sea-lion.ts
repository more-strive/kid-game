import { BaseGame } from '@/core/base'
import type { Game, GameContext, PoseFrame } from '@/core/types'
import { glow, outlineTxt, ring, txt } from '@/core/draw'

/**
 * 小海狮套圈（对齐 dongdongpark 真实规则）：
 * 饲养员把圈抛向你，头钻进圈 +2、举手接 +1；脖子套满 5 个奖励小鱼，嘴接 +3。
 * 圈有低/中/高三档落点（蹲下/原地/跳起或举手），easy 全程有落点预告，hard 没有。
 */
interface Throw {
  owner: number
  fish: boolean
  kind: 'low' | 'mid' | 'high'
  from: { x: number; y: number }
  ctrl: { x: number; y: number }
  at: { x: number; y: number }
  age: number
  inT: number
  r: number
  judged: boolean
  state: 'fly' | 'miss' | 'caught'
  missVX: number
  missVY: number
  color: string
}

/** 对齐站点难度表 */
const DIFF = [
  { every: 2.2, inT: 1.7, r: 0.55, step: 1, spread: 1.8, low: 0.25, high: 0.15, preview: -1, neck: 0.7, arm: 0.75, max: 1 },
  { every: 1.7, inT: 1.35, r: 0.48, step: 1.3, spread: 2.3, low: 0.3, high: 0.25, preview: 0.45, neck: 0.65, arm: 0.7, max: 2 },
  { every: 1.3, inT: 1.0, r: 0.42, step: 1.6, spread: 2.8, low: 0.3, high: 0.3, preview: 2, neck: 0.58, arm: 0.65, max: 2 },
]
const WINDUP = 0.4 // 预备投掷时长 s
const NECK_CAP = 5 // 套满 5 个奖励小鱼
const RING_COLORS = ['#ff5c8a', '#ffd166', '#4cc9f0', '#9b5de5', '#3ddc97']

interface PState {
  anchorX: number
  anchorY: number
  t: number
  ready: boolean
  throwT: number
  count: number
  neckRings: number
  fishDue: boolean
  neck: number
  hand: number
  fish: number
  thrown: number
  lowHint: boolean
  highHint: boolean
}

class SeaLion extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  score = 0
  throws: Throw[] = []
  ps: PState[] = [
    this.newPS(),
    this.newPS(),
  ]

  private newPS(): PState {
    return {
      anchorX: this.W / 2,
      anchorY: this.H * 0.45,
      t: this.H * 0.22,
      ready: false,
      throwT: 1.2,
      count: 0,
      neckRings: 0,
      fishDue: false,
      neck: 0,
      hand: 0,
      fish: 0,
      thrown: 0,
      lowHint: false,
      highHint: false,
    }
  }

  private zone(pi: number) {
    if (this.present() <= 1) return { x0: this.W * 0.08, x1: this.W * 0.92 }
    return pi === 0 ? { x0: this.W * 0.03, x1: this.W * 0.47 } : { x0: this.W * 0.53, x1: this.W * 0.97 }
  }

  private present() {
    return this.players.filter((p) => p.body).length
  }

  /** 饲养员站位：zone 边缘 */
  private keeper(pi: number) {
    const z = this.zone(pi)
    return { x: pi === 0 ? z.x0 + 20 : z.x1 - 20, y: this.H * 0.62 }
  }

  tick(f: PoseFrame, dt: number) {
    const heat = Math.min(1, this.t / 45)
    for (let pi = 0; pi < 2; pi++) {
      const st = this.ps[pi]
      const b = f.bodies[pi]
      const z = this.zone(pi)
      // 头部锚点平滑（对齐站点 1-exp(-dt*1.5)）
      if (b) {
        const headX = b.head.x * this.W
        const headY = b.head.y * this.H
        if (!st.ready) {
          st.ready = true
          st.anchorX = headX
          st.anchorY = headY
          st.t = Math.max(0.05, b.scale) * this.H
        }
        const k = Math.min(1, dt * 1.5)
        st.anchorX += (headX - st.anchorX) * k
        st.anchorY += (headY - st.anchorY) * k
        st.t += (Math.max(0.05, b.scale) * this.H - st.t) * k
      }

      // 投掷节奏
      if (b && st.ready) {
        st.throwT -= dt
        if (st.throwT <= 0) {
          const flying = this.throws.filter((t) => t.owner === pi && t.state === 'fly').length
          if (flying < this.cfg.max) this.spawnThrow(st, pi, z)
          st.throwT = this.cfg.every * (0.85 + Math.random() * 0.3) * (1 - 0.25 * heat)
        }
      }

      // 圈的判定（进度窗 0.78–1.1，对齐站点）
      for (const t of this.throws) {
        if (t.owner !== pi || t.state !== 'fly') continue
        t.age += dt
        const n = t.age / t.inT
        if (!b || !st.ready) continue
        if (n >= 0.78 && n <= 1.1 && !t.judged) {
          const pos = this.throwPos(t)
          const ringR = t.r * (0.22 + 0.78 * Math.pow(Math.min(1, Math.max(0, n)), 1.3))
          // 鱼只有头（嘴）接 +3 / 手接 +1；圈头 +2 / 手 +1
          const headD = Math.hypot(st.anchorX - pos.x, st.anchorY - pos.y)
          const hands = [
            { x: b.lHand.x * this.W, y: b.lHand.y * this.H },
            { x: b.rHand.x * this.W, y: b.rHand.y * this.H },
          ]
          const headY = st.anchorY
          const headR = st.t * 0.16
          let done = false
          if (t.fish) {
            if (headD < ringR * 0.9) {
              this.eat(st, pos, 3, '啊呜！')
              done = true
            } else {
              for (const h of hands) {
                if (h.y <= headY - headR * 0.2 && Math.hypot(h.x - pos.x, h.y - pos.y) < ringR * this.cfg.arm) {
                  this.eat(st, pos, 1, '+1')
                  done = true
                  break
                }
              }
            }
          } else if (headD < ringR * this.cfg.neck) {
            // 套脖
            t.judged = true
            t.state = 'caught'
            this.score += 2
            st.neckRings++
            this.ctx.audio.good()
            this.say('套中！+2', pos.x, pos.y - 40, '#fff36b', 36)
            if (st.neckRings >= NECK_CAP) {
              st.neckRings = 0
              st.fishDue = true
              this.sayText('套满五个！小鱼来啦')
              this.ctx.audio.good()
            }
            done = true
          } else {
            for (const h of hands) {
              if (h.y <= headY - headR * 0.2 && Math.hypot(h.x - pos.x, h.y - pos.y) < ringR * this.cfg.arm) {
                this.eat(st, pos, 1, '+1')
                done = true
                break
              }
            }
          }
          if (done) {
            t.judged = true
            t.state = 'caught'
          }
        }
        if (!t.judged && n > 1.1) {
          // 落空
          t.judged = true
          t.state = 'miss'
          t.missVX = (Math.random() - 0.5) * 40
          t.missVY = 60
        }
      }
      // miss 物理
      for (const t of this.throws) {
        if (t.state !== 'miss') continue
        t.age += dt
        t.missVY += 1500 * dt
        const pos = this.throwPos(t)
        pos.x += t.missVX * dt
        pos.y += t.missVY * dt
        t.from = { ...pos }
        if (pos.y > this.H) t.state = 'caught'
      }
    }
    this.throws = this.throws.filter((t) => t.state !== 'caught' && t.age < t.inT + 3)

    this.ctx.setScore(this.score)
    this.ctx.setExtra('套脖', this.ps[0].neck + this.ps[1].neck)
    this.ctx.setExtra('手接', this.ps[0].hand + this.ps[1].hand)
    this.ctx.setExtra('吃鱼', this.ps[0].fish + this.ps[1].fish)
  }

  private eat(st: PState, pos: { x: number; y: number }, gain: number, label: string) {
    void st
    this.score += gain
    this.ctx.audio.good()
    this.say(label, pos.x, pos.y - 40, '#fff36b', 34)
    this.particles.burst(pos.x, pos.y, '#ffd54a', 10, 300, 5)
  }

  /** 贝塞尔轨迹位置 */
  private throwPos(t: Throw) {
    const n = Math.min(1.1, Math.max(0, t.age / t.inT))
    const u = 1 - n
    return {
      x: u * u * t.from.x + 2 * u * n * t.ctrl.x + n * n * t.at.x,
      y: u * u * t.from.y + 2 * u * n * t.ctrl.y + n * n * t.at.y,
    }
  }

  private spawnThrow(st: PState, pi: number, z: { x0: number; x1: number }) {
    st.count++
    st.thrown++
    const fish = st.fishDue
    st.fishDue = false
    let kind: 'low' | 'mid' | 'high' = 'mid'
    if (st.count >= 2 && Math.random() < this.cfg.low) kind = 'low'
    else if (st.count >= 3 && Math.random() < this.cfg.high) kind = 'high'
    const off = (Math.random() * 2 - 1) * (kind === 'high' ? this.cfg.step * 0.55 : this.cfg.step + Math.random() * (this.cfg.spread - this.cfg.step))
    let x = st.anchorX + off
    if (x < z.x0 + 40 || x > z.x1 - 40) x = st.anchorX - off
    x = Math.min(z.x1 - 0.8 * st.t, Math.max(z.x0 + 0.8 * st.t, x))
    const yOff = kind === 'low' ? (0.35 + Math.random() * 0.15) : kind === 'high' ? -(0.38 + Math.random() * 0.12) : -0.1 + Math.random() * 0.22
    const at = { x, y: st.anchorY + yOff * st.t }
    const kp = this.keeper(pi)
    const dist = Math.hypot(at.x - kp.x, at.y - kp.y)
    const ctrl = {
      x: (kp.x + at.x) / 2 + (Math.random() - 0.5) * 0.5 * dist,
      y: (kp.y + at.y) / 2 - 0.2 * dist,
    }
    const T = st.t
    this.throws.push({
      owner: pi,
      fish,
      kind,
      from: { ...kp },
      ctrl,
      at,
      age: -WINDUP,
      inT: this.cfg.inT * (1 - 0.2 * heat(this.t)),
      r: (fish ? 0.85 : 1) * this.cfg.r * T,
      judged: false,
      state: 'fly',
      missVX: 0,
      missVY: 0,
      color: fish ? '#ffb703' : RING_COLORS[st.count % RING_COLORS.length],
    })
    if (kind === 'low' && !st.lowHint) {
      st.lowHint = true
      this.ctx.speak('低低的圈圈，蹲下来钻过去！')
    }
    if (kind === 'high' && !st.highHint) {
      st.highHint = true
      this.ctx.speak('高高的圈圈，跳起来，或者举手接！')
    }
    // 初次出手音
    if (this.t > 1) this.ctx.audio.play('click', 0.7, 1.4)
  }

  private sayText(text: string) {
    this.bannerText = text
    this.bannerT = 1.4
  }

  bannerText = ''
  bannerT = 0

  paint(c: CanvasRenderingContext2D) {
    for (const t of this.throws) {
      const n = Math.min(1, Math.max(0, t.age / t.inT))
      // 预备阶段画在饲养员手上
      if (t.age < 0) continue
      const pos = this.throwPos(t)
      const ringR = t.r * (0.22 + 0.78 * Math.pow(n, 1.3))
      c.save()
      c.translate(pos.x, pos.y)
      // 落点预告圈（进度 ≥ preview 后显示）
      if (n >= this.cfg.preview && n < 0.9) {
        c.globalAlpha = Math.min(0.75, 0.3 + n)
        c.strokeStyle = t.color
        c.setLineDash([10, 9])
        c.lineWidth = 3
        c.beginPath()
        c.ellipse(t.at.x - pos.x, t.at.y - pos.y, t.r, t.r * (0.35 + 0.65 * n), 0, 0, Math.PI * 2)
        c.stroke()
        c.setLineDash([])
        c.globalAlpha = 1
      }
      // 圈本体（透视椭圆）
      c.strokeStyle = t.color
      c.lineWidth = ringR * 0.22 + 4
      c.beginPath()
      c.ellipse(0, 0, ringR, ringR * (0.35 + 0.65 * Math.pow(n, 1.5)), 0, 0, Math.PI * 2)
      c.stroke()
      if (t.fish) {
        c.font = `${ringR * 1.2}px system-ui`
        c.textAlign = 'center'
        c.textBaseline = 'middle'
        c.fillText('🐟', 0, 0)
      }
      c.restore()
      // 饲养员
      if (t.age < 0.2) {
        const kp = this.keeper(t.owner)
        c.save()
        glow(c, kp.x, kp.y - 40, 60, '#ffd166', 0.4)
        c.font = '64px system-ui'
        c.textAlign = 'center'
        c.fillText('🧑‍🌾', kp.x, kp.y)
        c.restore()
      }
    }

    // 圈堆计数（套脖）
    for (let pi = 0; pi < 2; pi++) {
      const st = this.ps[pi]
      if (!st.ready || st.neckRings === 0) continue
      for (let i = 0; i < st.neckRings; i++) {
        c.save()
        c.globalAlpha = 0.85
        c.strokeStyle = RING_COLORS[i % RING_COLORS.length]
        c.lineWidth = 8
        c.beginPath()
        c.ellipse(st.anchorX, st.anchorY + st.t * 0.25 + i * 6, st.t * 0.3, st.t * 0.12, 0, 0, Math.PI * 2)
        c.stroke()
        c.restore()
      }
    }

    if (this.bannerT > 0) {
      c.globalAlpha = Math.min(1, this.bannerT / 0.3)
      outlineTxt(c, this.bannerText, this.W / 2, 150, 40, '#4cc9f0')
      c.globalAlpha = 1
    }
    ring(c, this.W - 64, this.H - 64, 26, Math.min(1, (this.ps[0].neck + this.ps[1].neck) / NECK_CAP), '#4cc9f0', 6)
    txt(c, '头钻进圈 +2、举手接 +1；套满 5 个来小鱼，头接 +3', this.W / 2, this.H - 30, 20, 'rgba(255,255,255,.8)', 'center', 'bold')
  }
}

function heat(t: number) {
  return Math.min(1, t / 45)
}

export default function create(ctx: GameContext) {
  return new SeaLion(ctx)
}
