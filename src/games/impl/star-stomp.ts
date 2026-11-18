import { BaseGame, seatLost } from '@/core/base'
import type { Game, GameContext, PoseFrame } from '@/core/types'
import { circle, glow, outlineTxt, ring, star, txt } from '@/core/draw'

/**
 * 踩星星（对齐 dongdongpark 真实规则）：
 * 影子锚点跟随脚下，星星亮在脚边（左星左脚/右星右脚），用脚踩 +1；黑洞驻留 0.2s 判踩中扣分。
 * hard 星星会滑动，需要预判。漏星无惩罚。
 */
interface Star {
  owner: number
  x: number
  y: number
  baseX: number
  baseY: number
  r: number
  side: number // -1 左 1 右
  age: number
  stay: number
  dir: { x: number; y: number }
  state: 'live' | 'hit' | 'gone'
  hitAt: number
  hitFoot: number // 0 左 1 右
}

interface Hole {
  owner: number
  x: number
  y: number
  r: number
  age: number
  stay: number
  dwell: number
  state: 'live' | 'gone'
}

/** 对齐站点难度表：停留/间隔/上限/尺寸/距离/黑洞间隔停留上限扣分/hard 滑动 */
const DIFF = [
  { stay: 2.0, every: 1.25, max: 1, size: 1.15, reach: 0.85, holeEvery: 6.5, holeStay: 3.0, holeMax: 1, penalty: 0, slide: 0 },
  { stay: 1.5, every: 1.25, max: 2, size: 1.0, reach: 1, holeEvery: 4.5, holeStay: 2.6, holeMax: 1, penalty: 1, slide: 0 },
  { stay: 1.1, every: 1.0, max: 2, size: 0.92, reach: 1, holeEvery: 3.4, holeStay: 2.4, holeMax: 2, penalty: 1, slide: 0.3 },
]
const PROT = 0.12 // 出生保护期
const DWELL_T = 0.2 // 黑洞驻留判定阈值
const FOOT_R = 18 // 脚部判定半径
/** 五声音阶（MIDI，连击越高音越高，对齐站点 E 表） */
const SCALE = [72, 74, 76, 79, 81, 84, 86, 88]

interface PState {
  /** 影子锚点 */
  ax: number
  ay: number
  t: number
  ready: boolean
  stars: Star[]
  holes: Hole[]
  starT: number
  holeT: number
  combo: number
  hit: number
  shown: number
  react: number
  left: number
  right: number
  holesStepped: number
  lastTorso: number
}

class StarStomp extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  ps: PState[] = [
    this.newState(640, 660),
    this.newState(640, 660),
  ]
  holeVoice = false

  private newState(ax: number, ay: number): PState {
    return {
      ax, ay, t: 0.35, ready: false,
      stars: [], holes: [],
      starT: 0.9, holeT: 5,
      combo: 0, hit: 0, shown: 0, react: 0, left: 0, right: 0, holesStepped: 0,
      lastTorso: 0.22,
    }
  }

  private zone(pi: number) {
    if (this.present() <= 1) return { x0: this.W * 0.08, x1: this.W * 0.92 }
    return pi === 0 ? { x0: this.W * 0.04, x1: this.W * 0.48 } : { x0: this.W * 0.52, x1: this.W * 0.96 }
  }

  private seenAt = [-9, -9]

  private present() {
    return this.players.filter((p) => p.body).length
  }

  tick(f: PoseFrame, dt: number) {
    const heat = Math.min(1, this.t / 45)
    for (let pi = 0; pi < 2; pi++) {
      const st = this.ps[pi]
      const b = f.bodies[pi]
      const z = this.zone(pi)
      // 人真的走了就撤掉标定：否则影子和星星锚点会在原地一直留着
      if (seatLost(this.seenAt, pi, b, this.t) && st.ready) {
        st.ready = false
        st.stars.length = 0
        st.holes.length = 0
      }

      // 影子锚点：x 跟髋（1.6/s），y 跟最低的脚（下 3/s 上 0.8/s，对齐站点）
      if (b) {
        const kx = Math.min(1, 1.6 * dt)
        st.ax += (b.hipC.x * this.W - st.ax) * kx
        const lowestFoot = Math.max(b.lFoot.y, b.rFoot.y) * this.H
        const ky = lowestFoot > st.ay ? 3 : 0.8
        st.ay += (Math.min(this.H - 8, lowestFoot) - st.ay) * Math.min(1, ky * dt)
        st.t += (Math.max(0.05, b.scale) * this.H - st.t) * Math.min(1, 2 * dt)
        st.lastTorso += (Math.max(0.05, b.scale) - st.lastTorso) * Math.min(1, 2 * dt)
        st.ready = true
      }

      // 星星生成（随机侧，同侧有星则翻对侧；落点在锚点附近按 reach 展开）
      if (b && st.ready) {
        st.starT -= dt
        if (st.starT <= 0 && st.stars.filter((s) => s.state === 'live').length < this.cfg.max) {
          this.spawnStar(st, pi, z)
          st.starT = this.cfg.every * (1 - 0.25 * heat) * (0.8 + Math.random() * 0.4)
        }
        // 黑洞生成（首次播语音提示）
        st.holeT -= dt
        if (st.holeT <= 0 && st.holes.filter((h) => h.state === 'live').length < this.cfg.holeMax) {
          this.spawnHole(st, pi, z)
          st.holeT = this.cfg.holeEvery * (1 - 0.2 * heat) * (0.75 + Math.random() * 0.5)
        }
      }

      // 星星状态机 + hard 滑动
      for (const s of st.stars) {
        s.age += dt
        if (s.state === 'live') {
          if (this.cfg.slide > 0) {
            s.baseX += s.dir.x * this.cfg.slide * st.lastTorso * this.H * dt
            s.baseY += s.dir.y * this.cfg.slide * st.lastTorso * this.H * dt
          }
          s.x = s.baseX
          s.y = s.baseY
          if (s.age >= s.stay) s.state = 'gone' // 漏星无惩罚也不清连击（对齐站点）
        } else if (s.state === 'hit' && s.age - s.hitAt > 0.35) s.state = 'gone'
      }
      st.stars = st.stars.filter((s) => s.state !== 'gone')
      for (const h of st.holes) {
        h.age += dt
        if (h.age > h.stay) h.state = 'gone'
        else h.dwell = Math.max(0, h.dwell - 2 * dt)
      }
      st.holes = st.holes.filter((h) => h.state !== 'gone')

      // 脚部判定
      if (!b) continue
      const feet = [
        { x: b.lFoot.x * this.W, y: b.lFoot.y * this.H },
        { x: b.rFoot.x * this.W, y: b.rFoot.y * this.H },
      ]
      for (const s of st.stars) {
        if (s.state !== 'live' || s.age < PROT) continue
        for (let fi = 0; fi < 2; fi++) {
          if (Math.hypot(feet[fi].x - s.x, feet[fi].y - s.y) < s.r * 0.85 + FOOT_R * 0.6) {
            s.state = 'hit'
            s.hitAt = s.age
            s.hitFoot = fi
            st.hit++
            st.combo++
            st.react += s.age
            if (fi === 0) st.left++
            else st.right++
            const midi = SCALE[st.combo % SCALE.length]
            this.ctx.audio.play('score', 1, Math.pow(2, (midi - 72) / 12))
            this.particles.burst(s.x, s.y, '#ffd54a', 12, 340, 5)
            this.say('+1', s.x, s.y - 30, '#fff36b', 30)
            break
          }
        }
      }
      for (const h of st.holes) {
        if (h.state !== 'live') continue
        let inside = false
        for (const ft of feet) {
          if (Math.hypot(ft.x - h.x, ft.y - h.y) < h.r * 0.6 + FOOT_R * 0.4) inside = true
        }
        h.dwell = inside ? h.dwell + dt : Math.max(0, h.dwell - 2 * dt)
        if (h.dwell >= DWELL_T) {
          h.state = 'gone'
          st.holesStepped++
          st.combo = 0
          this.ctx.audio.fail()
          this.say('哎呀，黑洞！', h.x, h.y - 40, '#7a6b8a', 36)
          this.particles.burst(h.x, h.y, '#2a1446', 16, 420, 6)
        }
      }
    }

    const shown = this.ps[0].shown + this.ps[1].shown
    const hit = this.ps[0].hit + this.ps[1].hit
    this.ctx.setScore(Math.max(0, hit - (this.ps[0].holesStepped + this.ps[1].holesStepped) * this.cfg.penalty))
    this.ctx.setCombo(Math.max(this.ps[0].combo, this.ps[1].combo))
    this.ctx.setExtra('命中率', Math.round((hit / Math.max(1, shown)) * 100))
    this.ctx.setExtra('左脚', this.ps[0].left + this.ps[1].left)
    this.ctx.setExtra('右脚', this.ps[0].right + this.ps[1].right)
    this.ctx.setExtra('踩黑洞', this.ps[0].holesStepped + this.ps[1].holesStepped)
  }

  private spawnStar(st: PState, pi: number, z: { x0: number; x1: number }) {
    let side = Math.random() < 0.5 ? -1 : 1
    if (st.stars.some((s) => s.state === 'live' && s.side === side)) side = -side
    const r = Math.min(72, Math.max(24, st.lastTorso * this.H * 0.3 * this.cfg.size))
    const reach = (0.65 + Math.random() * 0.4) * this.cfg.reach * st.lastTorso * this.H
    const ang = -0.5 + Math.random() * 1.5
    const bx = Math.min(z.x1 - r * 1.2, Math.max(z.x0 + r * 1.2, st.ax + side * Math.cos(ang) * reach))
    const by = Math.min(this.H - r * 0.55, Math.max(this.H * 0.45, st.ay + Math.sin(Math.abs(ang)) * reach * 0.4))
    const slideDir = this.cfg.slide > 0
      ? { x: side * Math.cos(-1.2 + Math.random() * 2.4), y: Math.sin(-0.6 + Math.random() * 1.2) * 0.5 }
      : { x: 0, y: 0 }
    st.shown++
    st.stars.push({
      owner: pi, x: bx, y: by, baseX: bx, baseY: by, r, side,
      age: 0,
      stay: this.cfg.stay * (1 - 0.15 * Math.min(1, this.t / 45)) * (0.9 + Math.random() * 0.2),
      dir: slideDir,
      state: 'live', hitAt: 0, hitFoot: -1,
    })
    this.ctx.audio.play('click', 0.8, 1.2)
  }

  private spawnHole(st: PState, pi: number, z: { x0: number; x1: number }) {
    if (!this.holeVoice) {
      this.holeVoice = true
      this.ctx.speak('黑洞千万别踩！')
    }
    const r = Math.min(84, Math.max(28, st.lastTorso * this.H * 0.36))
    // 黑洞离脚更远：直接放在锚点侧向更远处
    const side = Math.random() < 0.5 ? -1 : 1
    const hx = Math.min(z.x1 - r, Math.max(z.x0 + r, st.ax + side * (st.lastTorso * this.H * 1.4 + r)))
    const hy = Math.min(this.H - r * 0.5, Math.max(this.H * 0.5, st.ay - r * 0.3))
    st.holes.push({ owner: pi, x: hx, y: hy, r, age: 0, stay: this.cfg.holeStay, dwell: 0, state: 'live' })
    this.ctx.audio.play('drop', 0.8, 0.8)
  }

  paint(c: CanvasRenderingContext2D) {
    for (let pi = 0; pi < 2; pi++) {
      const st = this.ps[pi]
      const color = this.players[pi].color
      // 影子锚点（虚线椭圆）
      if (st.ready) {
        c.save()
        c.globalAlpha = 0.16
        c.fillStyle = color
        c.beginPath()
        c.ellipse(st.ax, st.ay, st.t * 1.1, st.t * 0.4, 0, 0, Math.PI * 2)
        c.fill()
        c.globalAlpha = 0.35
        c.setLineDash([8, 8])
        c.strokeStyle = color
        c.lineWidth = 2.5
        c.beginPath()
        c.ellipse(st.ax, st.ay, st.t * 1.1, st.t * 0.4, 0, 0, Math.PI * 2)
        c.stroke()
        c.restore()
      }

      // 黑洞（眨眼）
      for (const h of st.holes) {
        c.save()
        c.translate(h.x, h.y)
        glow(c, 0, 0, h.r * 1.6, '#2a1446', 0.5)
        c.beginPath()
        c.arc(0, 0, h.r, 0, Math.PI * 2)
        c.fillStyle = '#2a1446'
        c.fill()
        const blink = Math.sin(this.t * 1.7 + h.x) > 0.96
        if (!blink) {
          circle(c, -h.r * 0.28, -h.r * 0.15, h.r * 0.14, '#b983ff')
          circle(c, h.r * 0.28, -h.r * 0.15, h.r * 0.14, '#b983ff')
        }
        // 脚悬停警告：红色急促闪烁边
        if (h.dwell > 0.02) {
          c.globalAlpha = 0.5 + 0.5 * Math.sin(this.t * 30)
          c.strokeStyle = '#ff5c5c'
          c.lineWidth = 5
          c.beginPath()
          c.arc(0, 0, h.r * 1.15, 0, Math.PI * 2)
          c.stroke()
        }
        c.restore()
      }

      // 星星：底晕 + 脚印提示 + 倒计时环（最后 30% 红闪）
      for (const s of st.stars) {
        const remain = 1 - s.age / s.stay
        const k = s.state === 'hit' ? Math.max(0, 1 - (s.age - s.hitAt) / 0.35) : 1
        c.save()
        c.translate(s.x, s.y)
        c.globalAlpha = s.state === 'hit' ? k : 1
        if (s.state === 'hit') c.scale(1 + 0.6 * (1 - k), 1 + 0.6 * (1 - k) * 0.4)
        glow(c, 0, 0, s.r * 1.7, '#ffd54a', 0.3)
        star(c, 0, 0, s.r * (s.state === 'hit' ? 0.9 : 1), s.state === 'hit' ? '#fff3b0' : '#ffd54a')
        // 脚印提示：星心标 L/R
        txt(c, s.side < 0 ? 'L' : 'R', 0, s.r * 0.35, s.r * 0.5, '#7a5a00', 'center', '900')
        if (s.state === 'live') {
          const urgent = remain < 0.3
          ring(c, 0, 0, s.r * 1.35, Math.max(0, remain), urgent ? '#ff6b6b' : color, 5)
          if (urgent) {
            c.globalAlpha = 0.55 + 0.45 * Math.sin(this.t * 22)
            ring(c, 0, 0, s.r * 1.35, remain, '#ff6b6b', 5)
          }
        }
        c.restore()
      }
    }

    const best = Math.max(this.ps[0].combo, this.ps[1].combo)
    if (best >= 2) outlineTxt(c, `连踩 ${best}`, 100, 50, 30 + Math.min(14, best), '#ffd54a')
    txt(c, '脚踩亮起的星星（L 左脚 R 右脚），黑洞千万别踩', this.W / 2, this.H - 30, 20, 'rgba(255,255,255,.8)', 'center', 'bold')
  }
}

export default function create(ctx: GameContext) {
  return new StarStomp(ctx)
}
