import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { glow, outlineTxt, ring, txt } from '@/core/draw'

/**
 * 喂羊驼（对齐 dongdongpark 真实规则）：
 * 空手伸腰边南瓜桶拿糖，送到羊驼嘴边 +1；耐心耗尽吐口水，在脸前快挥擦掉。
 * 不同体型耐心不同（胖的最急），被吐不扣分只罚清洁时间。
 */
type BodyType = 'tall' | 'normal' | 'chubby' | 'baby'

/** 体型表（对齐站点 m 表）：身宽/头尺寸/耐心倍率 */
const TYPES: Record<BodyType, { w: number; hs: number; patience: number }> = {
  tall: { w: 0.9, hs: 0.58, patience: 1 },
  normal: { w: 0.95, hs: 0.62, patience: 1 },
  chubby: { w: 1.3, hs: 0.66, patience: 0.7 },
  baby: { w: 0.62, hs: 0.5, patience: 1.15 },
}
const TYPE_POOL: BodyType[] = ['normal', 'tall', 'baby', 'chubby', 'normal', 'tall']
/** 嘴位偏移（×躯干，相对肩中心） */
const MOUTH_OFF: Record<BodyType, { x: number; y: number }> = {
  tall: { x: 0.85, y: -0.95 },
  normal: { x: 1.05, y: -0.15 },
  chubby: { x: 1.0, y: 0.35 },
  baby: { x: 0.75, y: 0 },
}
/** 对齐站点难度表：耐心/同场上限/间隔 */
const DIFF = [
  { patience: 9, max: 2, gap: 2.2 },
  { patience: 7, max: 3, gap: 1.6 },
  { patience: 5.5, max: 4, gap: 1.2 },
]
const WALK_IN = 420 // 走入速度 px/s（对齐站点 420×unit）
const WALK_OUT = 480
const SPIT_T = 0.42 // 口水飞行时长 s
const WIPE_SPEED = 0.7 // 擦口水手速阈值（归一化屏幕/s ≈ 500×unit px/s）
const WOOL = ['#f5f0e8', '#d9c7f0', '#f7d6e0', '#cfe8f7']
const CANDY = ['🍬', '🍎', '🥕']

interface Llama {
  owner: number
  type: BodyType
  wool: string
  side: number
  mouth: { x: number; y: number }
  bodyX: number
  homeX: number
  groundY: number
  state: 'in' | 'wait' | 'happy' | 'angry' | 'out' | 'gone'
  stateT: number
  patience: number
  wait: number
  walk: number
}

interface Candy {
  x: number
  y: number
  t: number // 0→1 飞行
  from: { x: number; y: number }
  to: { x: number; y: number }
  kind: number
}

interface Splat {
  x: number
  y: number
  r: number
  alpha: number
  wiped: boolean
  age: number
}

class LlamaTreat extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  score = 0
  llamas: Llama[] = []
  candies: Candy[] = []
  splats: Splat[] = []
  /** 每玩家双手持有的糖（null=空） */
  hands: (number | null)[][] = [
    [null, null],
    [null, null],
  ]
  gapT = 1
  spawnCount = 0
  firstSpit = true
  bannerText = ''
  bannerT = 0
  private realClock = 0

  private zone(pi: number) {
    if (this.present() <= 1) return { x0: this.W * 0.08, x1: this.W * 0.92 }
    return pi === 0 ? { x0: this.W * 0.03, x1: this.W * 0.47 } : { x0: this.W * 0.53, x1: this.W * 0.97 }
  }

  private present() {
    return this.players.filter((p) => p.body).length
  }

  private bucket(b: Body) {
    const T = Math.max(60, Math.max(0.05, b.scale) * this.H)
    return { x: b.hipC.x * this.W, y: b.hipC.y * this.H + 0.12 * T, w: Math.max(70, 0.8 * T) }
  }

  tick(f: PoseFrame, dt: number) {
    if (this.bannerT > 0) this.bannerT -= dt
    const duo = this.present() > 1
    const cap = this.cfg.max + (duo ? 1 : 0)

    // 羊驼进场
    this.gapT -= dt
    if (this.gapT <= 0) {
      const waiting = this.llamas.filter((l) => l.state !== 'out').length
      if (waiting < cap && this.present() > 0) this.spawn()
      this.gapT = this.cfg.gap * (0.8 + Math.random() * 0.4)
    }

    // 取糖/喂食/挥擦
    for (let pi = 0; pi < 2; pi++) {
      const b = f.bodies[pi]
      if (!b) continue
      const bk = this.bucket(b)
      const handPts = [
        { x: b.lHand.x * this.W, y: b.lHand.y * this.H, v: b.lHandV },
        { x: b.rHand.x * this.W, y: b.rHand.y * this.H, v: b.rHandV },
      ]
      for (let hi = 0; hi < 2; hi++) {
        const h = handPts[hi]
        if (this.hands[pi][hi] === null) {
          // 空手伸桶拿糖
          if (Math.hypot(h.x - bk.x, h.y - bk.y) < bk.w * 0.45 + 12) {
            this.hands[pi][hi] = Math.floor(Math.random() * CANDY.length)
            this.ctx.audio.play('score', 0.9, 1.3)
            this.particles.burst(bk.x, bk.y, '#ffd54a', 6, 200, 4)
          }
        } else {
          // 持糖喂食：任意 wait 态羊驼的嘴位
          for (const l of this.llamas) {
            if (l.state !== 'wait') continue
            const mouth = this.mouthPos(l)
            const T = this.ps_T(l.owner)
            if (Math.hypot(h.x - mouth.x, h.y - mouth.y) < T * TYPES[l.type].hs * 0.42 + 14) {
              this.hands[pi][hi] = null
              l.state = 'happy'
              l.stateT = 0
              this.score++
              this.ctx.audio.play('pop', 1, 1.1)
              if (Math.random() < 0.35) this.say(['好吃！', '谢谢！', '真甜！'][Math.floor(Math.random() * 3)], mouth.x, mouth.y - 40, '#c9a6ff', 32)
              break
            }
          }
        }
        // 挥手擦口水
        for (const s of this.splats) {
          if (s.alpha <= 0 || s.wiped) continue
          const near = Math.hypot(h.x - s.x, h.y - s.y) < s.r * 1.15 || Math.hypot(h.x - b.head.x * this.W, h.y - b.head.y * this.H) < Math.max(0.05, b.scale) * this.H * 0.9
          if (near && h.v > WIPE_SPEED) {
            s.alpha -= 3 * dt
            if (s.alpha <= 0.15) {
              s.wiped = true
              this.ctx.audio.good()
              this.say('擦干净啦！', s.x, s.y - 30, '#3ddc97', 36)
            }
          }
        }
      }
    }

    // 羊驼状态机
    for (const l of this.llamas) {
      l.stateT += dt
      if (l.state === 'in') {
        const dir = Math.sign(l.homeX - l.bodyX)
        l.bodyX += dir * WALK_IN * dt
        l.walk += dt * 9
        if (Math.abs(l.homeX - l.bodyX) < 8) l.state = 'wait'
      } else if (l.state === 'wait') {
        l.wait -= dt
        if (l.wait <= 0) {
          l.state = 'angry'
          l.stateT = 0
          this.ctx.audio.fail()
        }
      } else if (l.state === 'happy') {
        if (l.stateT > 1.3) {
          l.state = 'out'
          l.stateT = 0
        }
      } else if (l.state === 'angry') {
        if (l.stateT > 0.7) {
          // 吐口水
          l.state = 'out'
          l.stateT = 0
          const mouth = this.mouthPos(l)
          const to = { x: this.W * (0.3 + Math.random() * 0.4), y: this.H * (0.3 + Math.random() * 0.3) }
          this.candies.push({ x: mouth.x, y: mouth.y, t: 0, from: mouth, to, kind: -1 })
          this.ctx.audio.play('drop', 1, 0.6)
          if (this.firstSpit) {
            this.firstSpit = false
            this.bannerText = '被吐口水啦！挥挥手擦掉它'
            this.bannerT = 2.2
            this.ctx.speak('被吐口水啦！挥挥手擦掉它')
          }
        }
      } else {
        const dir = l.bodyX > this.W / 2 ? 1 : -1
        l.bodyX += dir * WALK_OUT * dt
        if (l.bodyX < -200 || l.bodyX > this.W + 200) l.state = 'gone'
      }
    }
    this.llamas = this.llamas.filter((l) => l.state !== 'gone')

    // 口水飞行与黏液
    for (const c of this.candies) {
      if (c.kind !== -1) continue
      c.t += dt / SPIT_T
      if (c.t >= 1) {
        this.splats.push({ x: c.to.x, y: c.to.y, r: this.H * (0.16 + Math.random() * 0.06), alpha: 0.85, wiped: false, age: 0 })
        this.ctx.audio.play('hit', 0.8, 0.7)
        this.ctx.audio.fail()
      }
    }
    this.candies = this.candies.filter((c) => c.kind !== -1 && c.t < 1)
    for (const s of this.splats) {
      s.age += dt
      if (!s.wiped) s.alpha -= (s.age > 6 ? 0.8 : 0.05) * dt
    }
    this.splats = this.splats.filter((s) => s.alpha > 0.15)

    this.ctx.setScore(this.score)
    this.ctx.setExtra('喂到', this.score)
  }

  private spawn() {
    const owner = this.spawnCount % Math.max(1, this.present())
    this.spawnCount++
    const type = TYPE_POOL[Math.floor(Math.random() * TYPE_POOL.length)]
    const z = this.zone(owner)
    const b = this.players[owner].body
    const T = b ? Math.max(0.05, b.scale) * this.H : this.H * 0.22
    const sc = b ? { x: b.shoulderC.x * this.W, y: b.shoulderC.y * this.H } : { x: (z.x0 + z.x1) / 2, y: this.H * 0.45 }
    const off = MOUTH_OFF[type]
    const side = Math.random() < 0.5 ? -1 : 1
    const mouth = {
      x: sc.x + side * off.x * T,
      y: type === 'baby' ? b ? b.hipC.y * this.H : sc.y : sc.y + off.y * T,
    }
    mouth.x = Math.min(z.x1 - 0.35 * T, Math.max(z.x0 + 0.35 * T, mouth.x))
    const w = TYPES[type].w * T
    const homeX = mouth.x - 0.55 * w * side
    const bodyX = side > 0 ? this.W + w : -w
    const groundY = Math.min(this.H * 0.99, Math.max(mouth.y + 0.9 * T, b ? b.lFoot.y * this.H : this.H * 0.9))
    this.llamas.push({
      owner,
      type,
      wool: WOOL[Math.floor(Math.random() * WOOL.length)],
      side,
      mouth,
      bodyX,
      homeX,
      groundY,
      state: 'in',
      stateT: 0,
      patience: this.cfg.patience * TYPES[type].patience * (0.9 + Math.random() * 0.2),
      wait: this.cfg.patience * TYPES[type].patience * (0.9 + Math.random() * 0.2),
      walk: 0,
    })
  }

  private mouthPos(l: Llama) {
    const dx = l.bodyX - l.homeX
    return { x: l.mouth.x + dx, y: l.mouth.y }
  }

  paint(c: CanvasRenderingContext2D) {
    // 黏液
    for (const s of this.splats) {
      c.save()
      c.globalAlpha = Math.max(0, s.alpha)
      c.fillStyle = '#7ac74f'
      for (let i = 0; i < 8; i++) {
        const ang = (i / 8) * Math.PI * 2 + s.age * 0.1
        const rr = s.r * (i % 2 === 0 ? 0.55 : 0.4)
        c.beginPath()
        c.ellipse(s.x + Math.cos(ang) * s.r * 0.5, s.y + Math.sin(ang) * s.r * 0.4, rr, rr * 0.7, ang, 0, Math.PI * 2)
        c.fill()
      }
      c.restore()
    }

    for (const l of this.llamas) {
      const T = this.ps_T(l.owner)
      const type = TYPES[l.type]
      const w = type.w * T
      const bodyY = l.groundY - w * 0.55
      c.save()
      // 身体
      c.fillStyle = l.wool
      c.beginPath()
      c.ellipse(l.bodyX, bodyY, w * 0.55, w * 0.42, 0, 0, Math.PI * 2)
      c.fill()
      // 脖子与头
      const neckX = l.bodyX + l.side * w * 0.42
      c.strokeStyle = l.wool
      c.lineWidth = w * 0.24
      c.lineCap = 'round'
      c.beginPath()
      c.moveTo(neckX, bodyY)
      c.lineTo(l.mouth.x, l.mouth.y + type.hs * T * 0.3)
      c.stroke()
      const hs = type.hs * T
      circleHead(c, l.mouth.x, l.mouth.y, hs * 0.42, l.wool)
      // 耳朵
      c.fillStyle = l.wool
      c.beginPath()
      c.ellipse(l.mouth.x - hs * 0.18, l.mouth.y - hs * 0.5, hs * 0.08, hs * 0.2, -0.2, 0, Math.PI * 2)
      c.fill()
      c.beginPath()
      c.ellipse(l.mouth.x + hs * 0.18, l.mouth.y - hs * 0.5, hs * 0.08, hs * 0.2, 0.2, 0, Math.PI * 2)
      c.fill()
      // 表情
      const happy = l.state === 'happy'
      const grumpy = l.state === 'angry' || (l.state === 'wait' && l.wait < l.patience * 0.4)
      c.fillStyle = '#3a2e3e'
      circleHead(c, l.mouth.x - hs * 0.15, l.mouth.y - hs * 0.12, hs * 0.06, '#3a2e3e')
      circleHead(c, l.mouth.x + hs * 0.15, l.mouth.y - hs * 0.12, hs * 0.06, '#3a2e3e')
      c.font = `${hs * 0.5}px system-ui`
      c.textAlign = 'center'
      c.fillText(happy ? '😊' : grumpy ? '😠' : '', l.mouth.x, l.mouth.y + hs * 0.45)
      // 耐心环
      if (l.state === 'wait') {
        const remain = Math.max(0, l.wait / l.patience)
        ring(c, l.mouth.x, l.mouth.y - hs * 1.1, hs * 0.5, remain, remain > 0.5 ? '#3ddc97' : remain > 0.25 ? '#ffd166' : '#ff5c5c', 5)
      }
      if (l.state === 'happy') {
        glow(c, l.mouth.x, l.mouth.y, hs * 2, '#ffd54a', 0.5)
      }
      c.restore()
    }

    // 南瓜桶 + 手持糖
    for (let pi = 0; pi < 2; pi++) {
      const b = this.players[pi].body
      if (!b) continue
      const bk = this.bucket(b)
      c.save()
      c.fillStyle = '#e8862e'
      c.beginPath()
      c.ellipse(bk.x, bk.y, bk.w * 0.5, bk.w * 0.34, 0, 0, Math.PI * 2)
      c.fill()
      c.strokeStyle = '#a85a1a'
      c.lineWidth = 4
      c.stroke()
      c.font = `${bk.w * 0.4}px system-ui`
      c.textAlign = 'center'
      c.textBaseline = 'middle'
      c.fillText('🎃', bk.x, bk.y)
      c.restore()
      for (let hi = 0; hi < 2; hi++) {
        const candy = this.hands[pi][hi]
        if (candy === null) continue
        const h = hi === 0 ? b.lHand : b.rHand
        c.font = '30px system-ui'
        c.textAlign = 'center'
        c.fillText(CANDY[candy], h.x * this.W, h.y * this.H - 36)
      }
    }

    // 飞行口水
    for (const c2 of this.candies) {
      const n = Math.max(0, Math.min(1, c2.t))
      const x = c2.from.x + (c2.to.x - c2.from.x) * n
      const y = c2.from.y + (c2.to.y - c2.from.y) * n - Math.sin(n * Math.PI) * this.H * 0.08
      c.font = `${20 + n * 30}px system-ui`
      c.textAlign = 'center'
      c.fillText('💨', x, y)
    }

    if (this.bannerT > 0) {
      c.globalAlpha = Math.min(1, this.bannerT / 0.3)
      outlineTxt(c, this.bannerText, this.W / 2, 150, 36, '#3ddc97')
      c.globalAlpha = 1
    }
    txt(c, '空手伸南瓜桶拿糖，喂到嘴边；耐心耗尽会吐口水，快挥擦掉', this.W / 2, this.H - 30, 20, 'rgba(255,255,255,.8)', 'center', 'bold')
  }

  /** 该羊驼属主玩家的躯干像素 */
  private ps_T(owner: number) {
    const b = this.players[owner].body
    return Math.max(60, (b ? Math.max(0.05, b.scale) : 0.22) * this.H)
  }

  update(f: PoseFrame, dt: number) {
    this.realClock += dt
    this.bannerT = Math.max(0, this.bannerT - dt)
    super.update(f, dt)
  }
}

function circleHead(c: CanvasRenderingContext2D, x: number, y: number, r: number, color: string) {
  c.beginPath()
  c.arc(x, y, r, 0, Math.PI * 2)
  c.fillStyle = color
  c.fill()
}

export default function create(ctx: GameContext) {
  void ctx
  return new LlamaTreat(ctx)
}
