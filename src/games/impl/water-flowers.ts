import { BaseGame, seatLost } from '@/core/base'
import type { Game, GameContext, PoseFrame } from '@/core/types'
import { outlineTxt, txt } from '@/core/draw'

/**
 * 浇花小园丁（对齐 dongdongpark 真实规则）：
 * 手悬停在渴花盆口注水，水位到绿线就把手拿开 → 开花 +1；浇到满格会淹水罚 1.6s。
 * 绿线后水流变慢（slow 倍率），easy 无淹水直接开花。
 */
interface Pot {
  state: 'thirsty' | 'bloom'
  level: number
  shown: number // 显示用平滑水位
  last: number
  bloomAt: number
  stateT: number
  dry: number
  hold: boolean
  crossed: boolean
}

/** 对齐站点难度表：绿线/注满秒数/并发渴花/间隔/淹水/过线减速 */
const DIFF = [
  { g0: 0.5, fill: 4.0, max: 1, gap: 1.8, spill: false, slow: 1 },
  { g0: 0.6, fill: 3.6, max: 2, gap: 3.0, spill: true, slow: 0.6 },
  { g0: 0.7, fill: 3.2, max: 3, gap: 2.6, spill: true, slow: 0.65 },
]
const POT_OFFS = [-1.22, -0.6, 0.6, 1.22]
const POT_W = 0.54
const HAND_TOL = 0.78
const DRY_GRACE = 0.15
const FLOOD_T = 1.6

const FLOWER_NAMES = ['🌸', '🌻', '🌷', '🌺', '🌼', '💐']

class WaterFlowers extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  stats = [
    { blooms: 0, floods: 0 },
    { blooms: 0, floods: 0 },
  ]
  pots: Pot[][] = [
    POT_OFFS.map(() => ({ state: 'thirsty', level: 0.1, shown: 0.1, last: -10, bloomAt: -10, stateT: 0, dry: 0, hold: false, crossed: false })),
    POT_OFFS.map(() => ({ state: 'thirsty', level: 0.1, shown: 0.1, last: -10, bloomAt: -10, stateT: 0, dry: 0, hold: false, crossed: false })),
  ]
  anchors = [
    { x: this.W / 2, r: this.H * 0.64, t: this.H * 0.2, ready: false },
    { x: this.W / 2, r: this.H * 0.64, t: this.H * 0.2, ready: false },
  ]
  gapT = [0.6, 0.6]
  private seenAt = [-9, -9]
  thirstHint = 0
  bannerText = ''
  bannerT = 0

  private zone(pi: number) {
    if (this.present() <= 1) return { x0: this.W * 0.08, x1: this.W * 0.92 }
    return pi === 0 ? { x0: this.W * 0.03, x1: this.W * 0.47 } : { x0: this.W * 0.53, x1: this.W * 0.97 }
  }

  private present() {
    return this.players.filter((p) => p.body).length
  }

  private potX(pi: number, i: number) {
    const st = this.anchors[pi]
    const z = this.zone(pi)
    const spread = Math.min(1, (z.x1 - z.x0) / (2.6 * st.t))
    return Math.min(z.x1, Math.max(z.x0, st.x + POT_OFFS[i] * st.t * spread))
  }

  tick(f: PoseFrame, dt: number) {
    const heat = Math.min(1, this.t / 45)
    if (this.bannerT > 0) this.bannerT -= dt

    for (let pi = 0; pi < 2; pi++) {
      const st = this.anchors[pi]
      const b = f.bodies[pi]
      const z = this.zone(pi)
      const pots = this.pots[pi]
      // 人真的走了就撤掉标定：花盆不该留在原地，回来按新位置重新摆
      if (seatLost(this.seenAt, pi, b, this.t) && st.ready) {
        st.ready = false
        for (const p of pots) {
          p.state = 'thirsty'
          p.level = 0.1
          p.shown = 0.1
          p.stateT = 0
          p.hold = false
          p.crossed = false
        }
      }

      // 锚点跟随（横向死区 0.6T 慢跟）
      if (b) {
        const torso = Math.max(70, Math.max(0.05, b.scale) * this.H)
        if (!st.ready) {
          st.ready = true
          st.t = torso
          st.r = b.hipC.y * this.H + 0.04 * torso
          st.x = b.shoulderC.x * this.W
        }
        st.t += (torso - st.t) * Math.min(1, dt * 2)
        st.r += (Math.min(b.hipC.y * this.H + 0.04 * st.t, this.H - 0.6 * st.t) - st.r) * Math.min(1, dt * 2)
        const dx = b.shoulderC.x * this.W - st.x
        if (Math.abs(dx) > 0.6 * st.t) st.x += dx * Math.min(1, dt * 0.8)
        st.x = Math.min(z.x1 - st.t * 1.3, Math.max(z.x0 + st.t * 1.3, st.x))
      }

      // 发花节奏：挑最久没用过的盆变渴
      if (b) {
        this.gapT[pi] -= dt
        if (this.gapT[pi] <= 0) {
          const thirsty = pots.filter((p) => p.state === 'thirsty').length
          if (thirsty < this.cfg.max) {
            let pick = -1
            let oldest = Infinity
            pots.forEach((p, i) => {
              if (p.state === 'bloom' && p.stateT <= 2.2) return
              if (p.state === 'thirsty') return
              if (p.last < oldest) {
                oldest = p.last
                pick = i
              }
            })
            if (pick >= 0) {
              const p = pots[pick]
              p.state = 'thirsty'
              p.level = 0.1
              p.last = this.t
              this.ctx.audio.play('click', 0.7, 1.3)
              if (this.t - this.thirstHint > 9) {
                this.thirstHint = this.t
                this.ctx.speak('花渴了，快去浇水！')
              }
            }
          }
          this.gapT[pi] = this.cfg.gap * (0.8 + Math.random() * 0.4) * (1 - 0.2 * heat)
        }
      }

      // 手悬停检测（横容差 0.78×盆宽、高度带盆口上方）
      let overPot = -1
      if (b) {
        const hands = [
          { x: b.lHand.x * this.W, y: b.lHand.y * this.H },
          { x: b.rHand.x * this.W, y: b.rHand.y * this.H },
        ]
        for (const h of hands) {
          let best = -1
          let bestD = Infinity
          pots.forEach((p, i) => {
            if (p.state !== 'thirsty' || p.hold) return
            const px = this.potX(pi, i)
            const pw = POT_W * st.t
            if (Math.abs(h.x - px) > HAND_TOL * pw) return
            if (h.y < st.r - 1.3 * st.t || h.y > st.r - 0.15 * st.t) return
            const d = Math.abs(h.x - px)
            if (d < bestD) {
              bestD = d
              best = i
            }
          })
          if (best >= 0) overPot = best
        }
      }

      pots.forEach((p, i) => {
        p.stateT += dt
        p.shown += (p.level - p.shown) * Math.min(1, dt * 10)
        if (p.state !== 'thirsty') {
          p.level = Math.max(0.3, p.level - 0.15 * dt)
          return
        }
        const hovering = overPot === i
        if (p.hold) {
          // 淹水排空中：必须先移手
          p.level = Math.max(0.1, p.level - dt / FLOOD_T)
          if (p.level <= 0.35 && !hovering) p.hold = false
          return
        }
        if (hovering) {
          const wasBelow = p.level < this.cfg.g0
          p.level += (dt / this.cfg.fill) * (p.level >= this.cfg.g0 ? this.cfg.slow : 1)
          p.dry = 0
          if (wasBelow && p.level >= this.cfg.g0) {
            p.crossed = true
            this.ctx.audio.good()
            if (this.stats[pi].blooms + this.stats[pi].floods < 2) this.ctx.speak('到绿线啦，把手拿开！')
          }
          if (p.level >= 1) {
            if (this.cfg.spill) {
              // 淹水罚：排空 1.6s 且必须移手
              p.hold = true
              p.level = 1
              this.stats[pi].floods++
              this.ctx.audio.fail()
              this.particles.burst(this.potX(pi, i), st.r, '#4cc9f0', 16, 320, 5)
              this.bannerText = '水太多啦！到绿线就把手拿开'
              this.bannerT = 2.2
              this.ctx.speak('水太多啦！')
            } else {
              this.bloom(pi, i)
            }
          }
        } else {
          // 移开手：dry 累计；过线且移开宽限到 → 开花（对齐站点 0.15s 防抖）
          p.dry += dt
          if (p.crossed && p.dry >= DRY_GRACE) this.bloom(pi, i)
        }
      })
    }

    const blooms = this.stats[0].blooms + this.stats[1].blooms
    this.ctx.setScore(blooms)
    this.ctx.setExtra('淹水', this.stats[0].floods + this.stats[1].floods)
    this.ctx.setExtra('开花', blooms)
  }

  private bloom(pi: number, i: number) {
    const p = this.pots[pi][i]
    p.state = 'bloom'
    p.bloomAt = this.t
    p.stateT = 0
    p.crossed = false
    p.last = this.t
    this.stats[pi].blooms++
    this.ctx.audio.good()
    const x = this.potX(pi, i)
    this.particles.burst(x, this.anchors[pi].r - this.anchors[pi].t * 0.8, '#ff8fb1', 12, 300, 5)
    if (Math.random() < 0.35) {
      this.say(['开花啦！', '好漂亮！', '谢谢你！'][Math.floor(Math.random() * 3)], x, this.anchors[pi].r - this.anchors[pi].t * 1.2, '#ff8fb1', 34)
    }
  }

  paint(c: CanvasRenderingContext2D) {
    for (let pi = 0; pi < 2; pi++) {
      const st = this.anchors[pi]
      if (!st.ready) continue
      this.pots[pi].forEach((p, i) => {
        const px = this.potX(pi, i)
        const pw = POT_W * st.t
        const ph = 0.5 * st.t
        const baseY = st.r
        const bloomH = p.state === 'bloom' ? Math.min(1, p.stateT / 0.4) : 0.2
        const stemTop = baseY - ph - ph * 0.9 * bloomH
        c.strokeStyle = '#3f8f22'
        c.lineWidth = 4
        c.beginPath()
        c.moveTo(px, baseY - ph * 0.6)
        c.lineTo(px, stemTop)
        c.stroke()
        if (p.state === 'bloom') {
          c.font = `${st.t * 0.34}px system-ui`
          c.textAlign = 'center'
          c.textBaseline = 'middle'
          c.fillText(FLOWER_NAMES[i % FLOWER_NAMES.length], px, stemTop)
        } else {
          c.globalAlpha = 0.6 + 0.4 * Math.sin(this.t * 5 + i)
          c.font = `${st.t * 0.26}px system-ui`
          c.textAlign = 'center'
          c.fillText('💧', px, stemTop - 8)
          c.globalAlpha = 1
        }
        // 花盆
        c.beginPath()
        c.moveTo(px - pw * 0.6, baseY - ph)
        c.lineTo(px + pw * 0.6, baseY - ph)
        c.lineTo(px + pw * 0.45, baseY)
        c.lineTo(px - pw * 0.45, baseY)
        c.closePath()
        c.fillStyle = '#c96f4a'
        c.fill()
        // 水位
        const lvH = ph * 0.9 * Math.min(1, Math.max(0, p.shown))
        if (p.shown > 0.02) {
          c.fillStyle = p.shown >= this.cfg.g0 ? '#3ddc97' : '#4cc9f0'
          c.fillRect(px - pw * 0.4, baseY - lvH, pw * 0.8, lvH)
        }
        // 绿线
        const gy = baseY - ph * 0.9 * this.cfg.g0
        c.strokeStyle = p.crossed ? '#7dffc4' : '#2fbf71'
        c.lineWidth = 3
        c.setLineDash([6, 5])
        c.beginPath()
        c.moveTo(px - pw * 0.5, gy)
        c.lineTo(px + pw * 0.5, gy)
        c.stroke()
        c.setLineDash([])
        if (p.hold) outlineTxt(c, '拿开手…', px, baseY - ph - 26, 22, '#4cc9f0')
      })
    }

    if (this.bannerT > 0) {
      c.globalAlpha = Math.min(1, this.bannerT / 0.3)
      outlineTxt(c, this.bannerText, this.W / 2, 150, 36, '#4cc9f0')
      c.globalAlpha = 1
    }
    txt(c, '手悬在花盆上浇水，到绿线就把手拿开，浇过头会淹水', this.W / 2, this.H - 30, 20, 'rgba(255,255,255,.8)', 'center', 'bold')
  }
}

export default function create(ctx: GameContext) {
  return new WaterFlowers(ctx)
}
