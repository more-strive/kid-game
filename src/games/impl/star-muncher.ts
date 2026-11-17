import { BaseGame } from '@/core/base'
import type { Game, GameContext, PoseFrame } from '@/core/types'
import { glow, outlineTxt, star, txt } from '@/core/draw'

/**
 * 大嘴吃星星（对齐 dongdongpark 真实规则）：
 * 星星飞到嘴边悬停，头凑过去 + 张嘴吃掉 +1（金星 +2）；柠檬要闭紧嘴，张嘴吃会酸。
 * 站点用面部 jaw 检测，我们没有脸部分析 → 用「手贴头」近似张嘴（吃前先摸一下头）。
 * 低低的星星要蹲下来吃；hard 吃柠檬 −1。
 */
type Kind = 'star' | 'gold' | 'lemon'

/** 对齐站点难度表：间隔/飞入/悬停/飞出/并发/柠檬率/金星率/低星率/高度带/低星高度/散布/尺寸/吃柠檬扣分 */
const DIFF = [
  { every: 2.3, inT: 1.9, stay: 2.4, outT: 1.4, max: 2, lemon: 0.12, big: 0.1, low: 0.1, dy: [-0.1, 0.15], lowDy: [0.4, 0.5], spread: 1.2, size: 46, sour: false },
  { every: 1.8, inT: 1.5, stay: 1.5, outT: 1.1, max: 2, lemon: 0.2, big: 0.08, low: 0.2, dy: [-0.12, 0.25], lowDy: [0.5, 0.65], spread: 1.6, size: 40, sour: false },
  { every: 1.45, inT: 1.15, stay: 0.9, outT: 0.9, max: 3, lemon: 0.28, big: 0.06, low: 0.3, dy: [-0.15, 0.3], lowDy: [0.6, 0.8], spread: 2, size: 34, sour: true },
]

interface Item {
  owner: number
  kind: Kind
  from: { x: number; y: number }
  at: { x: number; y: number }
  out: { x: number; y: number }
  age: number
  inT: number
  stay: number
  outT: number
  r: number
  state: 'in' | 'stay' | 'out' | 'bounce' | 'gone' | 'eaten'
  bounceVX: number
  bounceVY: number
  offX: number
  offY: number
  offVX: number
  offVY: number
  phase: number
}

interface PState {
  anchorX: number
  anchorY: number
  t: number
  ready: number
  items: Item[]
  spawnT: number
  count: number
  score: number
  eaten: number
  bouncedLemon: number
  ateLemon: number
  lastX: number
  mouthOpen: boolean
  openAt: number
  sourT: number
}

class StarMuncher extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  ps: PState[] = [
    this.newPS(),
    this.newPS(),
  ]

  private newPS(): PState {
    return {
      anchorX: this.W / 2,
      anchorY: this.H * 0.45,
      t: this.H * 0.22,
      ready: 0,
      items: [],
      spawnT: 0.8,
      count: 0,
      score: 0,
      eaten: 0,
      bouncedLemon: 0,
      ateLemon: 0,
      lastX: 0,
      mouthOpen: false,
      openAt: -10,
      sourT: 0,
    }
  }

  private zone(pi: number) {
    if (this.present() <= 1) return { x0: this.W * 0.08, x1: this.W * 0.92 }
    return pi === 0 ? { x0: this.W * 0.03, x1: this.W * 0.47 } : { x0: this.W * 0.53, x1: this.W * 0.97 }
  }

  private present() {
    return this.players.filter((p) => p.body).length
  }

  tick(f: PoseFrame, dt: number) {
    const heat = Math.min(1, this.t / 45)
    for (let pi = 0; pi < 2; pi++) {
      const st = this.ps[pi]
      const b = f.bodies[pi]
      const z = this.zone(pi)
      if (st.sourT > 0) st.sourT -= dt

      // 嘴锚点平滑
      if (b) {
        const headX = b.head.x * this.W
        const headY = b.head.y * this.H
        if (st.ready === 0) {
          st.anchorX = headX
          st.anchorY = headY
          st.t = Math.max(0.05, b.scale) * this.H
          st.ready = 1
        }
        const k = Math.min(1, dt * 1.5)
        st.anchorX += (headX - st.anchorX) * k
        st.anchorY += (headY - st.anchorY) * k
        st.t += (Math.max(0.05, b.scale) * this.H - st.t) * k
        // 张嘴代理：任一手贴头（0.35 躯干内）= 张嘴
        const hx = Math.min(
          Math.hypot(b.lHand.x * this.W - headX, b.lHand.y * this.H - headY),
          Math.hypot(b.rHand.x * this.W - headX, b.rHand.y * this.H - headY),
        )
        const open = hx < st.t * 0.35
        if (open && !st.mouthOpen) st.openAt = this.t
        st.mouthOpen = open
      }

      // 生成（对齐站点：柠檬第 3 个起、金星随机、低星第 4 个起）
      if (b && st.ready === 1) {
        st.spawnT -= dt
        if (st.spawnT <= 0 && st.items.filter((i) => i.state !== 'gone').length < this.cfg.max) {
          this.spawn(st, pi, z)
          st.spawnT = this.cfg.every * (0.8 + Math.random() * 0.4) * (1 - 0.25 * heat)
        }
      }

      // 物品状态机 + 吃判定
      for (const it of st.items) {
        if (it.state === 'gone' || it.state === 'eaten') continue
        it.age += dt
        // 弹开弹簧回复
        it.offVX += (-60 * it.offX - 7 * it.offVX) * dt
        it.offVY += (-60 * it.offY - 7 * it.offVY) * dt
        it.offX += it.offVX * dt
        it.offY += it.offVY * dt
        if (it.state === 'bounce') {
          it.offVX += it.bounceVX * dt
          it.offVY += it.bounceVY * dt
          if (it.age - (it.inT + it.stay) > 0.8) it.state = 'gone'
        }
        if (it.state === 'in' && it.age >= it.inT) it.state = 'stay'
        if (it.state === 'stay' && it.age >= it.inT + it.stay) it.state = 'out'
        if (it.state === 'out' && it.age >= it.inT + it.stay + it.outT) it.state = 'gone'
        const pos = this.itemPos(it)
        if (!b || !st.ready) continue
        if (it.state === 'stay' || it.state === 'in') {
          // 进食点：嘴中心向头位置 lerp 0.7（对齐站点）
          const eatX = st.anchorX + (b.head.x * this.W - st.anchorX) * 0.7
          const eatY = st.anchorY + (b.head.y * this.H - st.anchorY) * 0.7
          const headR = st.t * 0.16
          if (Math.hypot(eatX - pos.x, eatY - pos.y) < headR + it.r * 0.45) {
            const open = st.mouthOpen && this.t - st.openAt > 0.15
            if (it.kind === 'lemon') {
              if (open) {
                // 吃到柠檬
                it.state = 'eaten'
                st.ateLemon++
                st.sourT = 1.3
                if (this.cfg.sour) {
                  st.score = Math.max(0, st.score - 1)
                  this.say('好酸！−1', pos.x, pos.y - 40, '#9bb01f', 40)
                } else {
                  this.say('好酸！', pos.x, pos.y - 40, '#9bb01f', 40)
                }
                this.ctx.audio.fail()
                this.particles.burst(pos.x, pos.y, '#d6e33a', 16, 300, 5)
              } else {
                // 闭嘴弹飞
                it.state = 'bounce'
                it.bounceVX = (pos.x - eatX) * 3 + (Math.random() - 0.5) * 200
                it.bounceVY = -380 - Math.random() * 100
                st.bouncedLemon++
                this.ctx.audio.play('pop', 1, 0.8)
                this.say('不吃！', pos.x, pos.y - 40, '#3ddc97', 36)
              }
            } else if (open) {
              // 吃到星星
              it.state = 'eaten'
              const gain = it.kind === 'gold' ? 2 : 1
              st.score += gain
              st.eaten++
              this.ctx.audio.good()
              this.say(`+${gain}`, pos.x, pos.y - 40, '#fff36b', 34)
              this.particles.burst(pos.x, pos.y, '#ffd93d', 14, 380, 5)
              if (it.kind === 'gold') this.ctx.audio.good()
            } else {
              // 闭嘴弹开
              it.state = 'bounce'
              it.bounceVX = (pos.x - eatX) * 3 + (Math.random() - 0.5) * 200
              it.bounceVY = -120
              this.ctx.audio.play('pop', 0.9, 0.7)
            }
          }
        }
      }
      st.items = st.items.filter((i) => i.state !== 'gone' && i.state !== 'eaten')
    }

    this.ctx.setScore(this.ps[0].score + this.ps[1].score)
    this.ctx.setExtra('吃星星', this.ps[0].eaten + this.ps[1].eaten)
    this.ctx.setExtra('弹开柠檬', this.ps[0].bouncedLemon + this.ps[1].bouncedLemon)
    this.ctx.setExtra('吃到柠檬', this.ps[0].ateLemon + this.ps[1].ateLemon)
  }

  private itemPos(it: Item) {
    // 三段轨迹：飞入 ease-out → 悬停摆动 → 飞出 ease-in（对齐站点）
    if (it.state === 'in' || it.state === 'gone') {
      const n = Math.min(1, Math.max(0, it.age / it.inT))
      const e = 1 - (1 - n) * (1 - n)
      return { x: it.from.x + (it.at.x - it.from.x) * e, y: it.from.y + (it.at.y - it.from.y) * e }
    }
    if (it.state === 'stay') {
      const n = (it.age - it.inT) / it.stay
      return {
        x: it.at.x + Math.sin(n * 3.1 + it.phase) * it.r * 0.18,
        y: it.at.y + Math.sin(n * 4.7 + it.phase) * it.r * 0.22,
      }
    }
    if (it.state === 'out') {
      const n = Math.min(1, (it.age - it.inT - it.stay) / it.outT)
      return { x: it.at.x + (it.out.x - it.at.x) * n * n, y: it.at.y + (it.out.y - it.at.y) * n * n }
    }
    // bounce/eaten：悬停点 + 弹簧偏移
    return { x: it.at.x + it.offX, y: it.at.y + it.offY }
  }

  private spawn(st: PState, pi: number, z: { x0: number; x1: number }) {
    st.count++
    let kind: Kind = 'star'
    const roll = Math.random()
    if (st.count >= 2 && roll < this.cfg.lemon) kind = 'lemon'
    else if (Math.random() > 1 - this.cfg.big) kind = 'gold'
    const isLow = kind !== 'lemon' && st.count >= 3 && Math.random() < this.cfg.low
    const dyRange = isLow ? this.cfg.lowDy : this.cfg.dy
    const jx = (Math.random() * 2 - 1) * this.cfg.spread
    st.lastX = Math.abs(jx - st.lastX) < 0.6 ? (jx >= 0 ? jx + 0.6 : jx - 0.6) : jx
    const x = Math.min(z.x1 - 0.6 * st.t, Math.max(z.x0 + 0.6 * st.t, st.anchorX + st.lastX * st.t))
    const y = Math.min(this.H * 0.85, Math.max(this.H * 0.12, st.anchorY + (dyRange[0] + Math.random() * (dyRange[1] - dyRange[0])) * st.t))
    const at = { x, y }
    const fromSide = Math.random() < 0.5 ? -1 : 1
    const from = { x: z.x0 <= 0 ? -60 : fromSide < 0 ? z.x0 - 60 : z.x1 + 60, y: this.H * 0.2 + Math.random() * this.H * 0.3 }
    const out = { x: from.x < this.W / 2 ? this.W + 60 : -60, y: -60 }
    // 柠檬瞄准嘴（逼玩家闭嘴）
    const aim = kind === 'lemon' ? { x: st.anchorX + (Math.random() - 0.5) * st.t * 0.4, y: st.anchorY + (Math.random() - 0.5) * st.t * 0.3 } : at
    const heat = Math.min(1, this.t / 45)
    st.items.push({
      owner: pi,
      kind,
      from,
      at: aim,
      out,
      age: 0,
      inT: this.cfg.inT * (1 - 0.15 * heat),
      stay: this.cfg.stay * (1 - 0.25 * heat),
      outT: this.cfg.outT,
      r: (kind === 'gold' ? 1.35 : 1) * this.cfg.size * (this.H / 720),
      state: 'in',
      bounceVX: 0,
      bounceVY: 0,
      offX: 0,
      offY: 0,
      offVX: 0,
      offVY: 0,
      phase: Math.random() * 6,
    })
    if (isLow && st.count <= 4) this.ctx.speak('低低的星星，蹲下来吃！')
    this.ctx.audio.play('click', 0.6, 1.2)
  }

  paint(c: CanvasRenderingContext2D) {
    for (let pi = 0; pi < 2; pi++) {
      const st = this.ps[pi]
      for (const it of st.items) {
        if (it.state === 'gone' || it.state === 'eaten') continue
        const pos = this.itemPos(it)
        c.save()
        c.translate(pos.x + it.offX, pos.y + it.offY)
        if (it.state === 'in') {
          // 目标预告虚线圈
          c.globalAlpha = 0.3 + Math.min(0.45, it.age / it.inT * 0.45)
          c.strokeStyle = '#fff6a8'
          c.setLineDash([10, 9])
          c.lineWidth = 3
          c.beginPath()
          c.ellipse(it.at.x - pos.x, it.at.y - pos.y, it.r * 1.45, it.r * 1.45, this.t, 0, Math.PI * 2)
          c.stroke()
          c.setLineDash([])
          c.globalAlpha = 1
        }
        if (it.kind === 'lemon') {
          glow(c, 0, 0, it.r * 1.7, '#d6e33a', 0.35)
          c.font = `${it.r * 1.6}px system-ui`
          c.textAlign = 'center'
          c.textBaseline = 'middle'
          c.fillText('🍋', 0, 0)
        } else {
          glow(c, 0, 0, it.r * 1.9, '#ffd93d', it.kind === 'gold' ? 0.5 : 0.3)
          const pulse = it.kind === 'gold' ? 1 + Math.sin(this.t * 7 + it.phase) * 0.05 : 1
          star(c, 0, 0, it.r * pulse, it.kind === 'gold' ? '#fff3b0' : '#ffd93d')
          if (it.kind === 'gold') star(c, 0, 0, it.r * 0.55, '#ffffff')
        }
        // 低星下蹲箭头提示
        const dy = it.at.y - st.anchorY
        if (dy > st.t * 0.35) {
          c.globalAlpha = 0.8
          c.font = `${it.r * 0.5}px system-ui`
          c.textAlign = 'center'
          c.fillText('▼', 0, it.r * 1.5 + Math.sin(this.t * 6) * 5)
          c.globalAlpha = 1
        }
        c.restore()
      }
      // 张嘴状态提示
      const b = this.players[pi].body
      if (b && st.ready) {
        const open = st.mouthOpen
        outlineTxt(c, open ? '😃 张嘴' : '😅 闭嘴（摸头=张嘴）', b.head.x * this.W, b.head.y * this.H - st.t * 0.7, open ? 26 : 18, open ? '#3ddc97' : 'rgba(255,255,255,.7)')
      }
    }

    txt(c, '头凑过去吃星星：先摸一下头「张嘴」；🍋 来了别摸头，闭紧嘴', this.W / 2, this.H - 30, 20, 'rgba(255,255,255,.8)', 'center', 'bold')
  }
}

export default function create(ctx: GameContext) {
  return new StarMuncher(ctx)
}
