import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, glow, outlineTxt, ring, star, txt } from '@/core/draw'

type Phase = 'green' | 'freeze'

/** 对齐站点真实难度表：红灯宽限秒数 / 静止阈值（躯干长/秒）/ 红绿灯时长区间 */
const DIFF = [
  { grace: 0.9, still: 0.5, green: [4.5, 7], red: [3, 4] },
  { grace: 0.6, still: 0.42, green: [4, 6.5], red: [3, 4.5] },
  { grace: 0.5, still: 0.32, green: [4, 6], red: [3.5, 5] },
]

const BANK_CAP = 45 // 单轮绿灯星星罐上限（对齐站点）
const EARN_RATE = 8 // 满速积星速率（颗/秒）
const FULL_SPEED = 1.2 // 关节均速达到该值（×1.6 后）即满速积星
const TWITCH_T = 0.3 // 超阈值持续 0.3s 才判「动了」（抖动容忍）
const SMOOTH_TAU = 0.12 // 关节速度指数平滑时间常数（秒）
const COLLECT_SPEED = 1.6 // 整体运动量放大系数（对齐站点 fill = 均值×1.6）

/** 单个玩家的本轮状态 */
interface PState {
  bank: number // 本轮绿灯攒的星星（红灯结束才收进总分）
  sp: number[] // 每关节的平滑速度（躯干长/秒）
  prev: ({ x: number; y: number } | null)[]
  twitch: number // 红灯期超阈值累积时长
  moved: boolean // 本轮红灯是否被抓
  sadT: number // 被抓后的沮丧表现时长
  shown: number // 罐子显示用的平滑星数
}

/** 木头人：绿灯使劲动攒星星（单轮上限 45），红灯憋住别动；红灯结束收星入账，被抓清空本轮 */
class FreezeGame extends BaseGame implements Game {
  phase: Phase = 'green'
  phaseT = 5
  phaseTotal = 5
  redT = 0 // 本轮红灯已经过秒数
  score = 0
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  states: PState[] = [
    { bank: 0, sp: [], prev: [], twitch: 0, moved: false, sadT: 0, shown: 0 },
    { bank: 0, sp: [], prev: [], twitch: 0, moved: false, sadT: 0, shown: 0 },
  ]
  glowLevel = 0
  /** 结束前是否已执行最后一轮收星 */
  finalCollected = false

  constructor(ctx: GameContext) {
    super(ctx)
    this.phaseTotal = this.rand(this.cfg.green)
    this.phaseT = this.phaseTotal
  }

  private rand([a, b]: number[]) {
    return a + Math.random() * (b - a)
  }

  tick(f: PoseFrame, dt: number) {
    // 游戏结束前把最后一轮罐里的星星也收进账（对齐站点 timeLeft≤0 执行 T()）
    if (!this.finalCollected && this.ctx.hud().timeLeft <= 0.2) {
      this.finalCollected = true
      this.collect()
    }
    this.phaseT -= dt
    if (this.phase === 'freeze') this.redT += dt
    if (this.phaseT <= 0) this.nextPhase()

    for (let i = 0; i < 2; i++) {
      const st = this.states[i]
      st.sadT = Math.max(0, st.sadT - dt)
      const b = f.bodies[i]
      if (!b) continue
      const { fill, still } = this.motion(st, b, dt)

      if (this.phase === 'green') {
        // 攒星：clamp(fill/1.2, 0, 1) × 8 颗/秒，单轮封顶 45（对齐站点）
        const rate = Math.min(1, fill / FULL_SPEED) * EARN_RATE
        st.bank = Math.min(BANK_CAP, st.bank + rate * dt)
        if (fill > 0.5) {
          this.particles.burst(
            ((b.lHand.x + b.rHand.x) / 2) * this.W,
            ((b.lHand.y + b.rHand.y) / 2) * this.H,
            '#ffd54a',
            1,
            160,
            4,
            500,
          )
        }
      } else if (!st.moved && this.redT > this.cfg.grace) {
        // 红灯判罚：宽限期后，稳健静止量超阈值 → 累积 twitch，0.3s 判「动了」
        if (still > this.cfg.still) st.twitch += dt
        else st.twitch = Math.max(0, st.twitch - dt * 2)
        if (st.twitch >= TWITCH_T) {
          st.moved = true
          st.sadT = 1.5
          st.bank = 0 // 没收本轮罐内星星（已入账的不扣）
          this.ctx.audio.fail()
          this.say('动了！', b.head.x * this.W, b.head.y * this.H - 60, '#ff6b6b', 46)
        }
      }
      st.shown += (st.bank - st.shown) * Math.min(1, dt * 8)
    }
    this.ctx.setScore(Math.round(this.score))
    this.ctx.setExtra('stars', Math.round(this.states.reduce((n, s, i) => n + (f.bodies[i] ? s.bank : 0), 0)))
  }

  /** 关节运动量：指数平滑（τ=0.12s）→ fill=均值×1.6；still=去掉最快 2 关节后的均值（稳健静止量） */
  private motion(st: PState, b: Body, dt: number): { fill: number; still: number } {
    if (st.sp.length !== b.lm.length) {
      st.sp = b.lm.map(() => 0)
      st.prev = b.lm.map(() => null)
    }
    const k = 1 - Math.exp(-dt / SMOOTH_TAU)
    const speeds: number[] = []
    const scale = Math.max(0.05, b.scale)
    for (let i = 0; i < b.lm.length; i++) {
      const p = b.lm[i]
      const q = st.prev[i]
      let v = 0
      if (q && (p.visibility ?? 1) >= 0.5) {
        v = Math.hypot(p.x - q.x, p.y - q.y) / Math.max(0.016, dt) / scale
      }
      st.prev[i] = { x: p.x, y: p.y }
      if ((p.visibility ?? 1) < 0.5) continue
      st.sp[i] += (v - st.sp[i]) * k
      speeds.push(st.sp[i])
    }
    if (!speeds.length) return { fill: 0, still: 0 }
    speeds.sort((a, z) => a - z)
    const keep = Math.max(1, speeds.length - 2)
    let quiet = 0
    for (let i = 0; i < keep; i++) quiet += speeds[i]
    let sum = 0
    for (const v of speeds) sum += v
    return { fill: (sum / speeds.length) * COLLECT_SPEED, still: quiet / keep }
  }

  /** 红灯结束（或游戏收尾）：没收被抓者的罐，其他人把罐内星星整数化入账（对齐站点 T()） */
  private collect() {
    for (let i = 0; i < 2; i++) {
      const st = this.states[i]
      if (!st.moved && Math.round(st.bank) > 0) {
        this.score += Math.round(st.bank)
        this.particles.burst(this.W - 130, this.H - 190, '#ffd54a', 14, 380, 6)
        this.ctx.audio.good()
      }
      st.bank = 0
      st.moved = false
      st.twitch = 0
    }
    this.ctx.setScore(Math.round(this.score))
    this.ctx.setExtra('stars', 0)
  }

  private nextPhase() {
    if (this.phase === 'green') {
      this.phase = 'freeze'
      this.phaseTotal = this.rand(this.cfg.red)
      this.phaseT = this.phaseTotal
      this.redT = 0
      for (const st of this.states) {
        st.moved = false
        st.twitch = 0
      }
      this.ctx.audio.whistle()
      this.ctx.speak('木头人')
      this.ctx.setStage('木头人！')
    } else {
      this.collect()
      this.phase = 'green'
      this.phaseTotal = this.rand(this.cfg.green)
      this.phaseT = this.phaseTotal
      this.ctx.audio.countdown(true)
      this.ctx.speak('绿灯，动起来')
      this.ctx.setStage('动起来')
    }
  }

  paint(c: CanvasRenderingContext2D) {
    const green = this.phase === 'green'
    const pulse = 0.5 + 0.5 * Math.sin(this.t * 5)
    this.glowLevel += ((green ? 1 : 0) - this.glowLevel) * 0.08

    const edge = c.createRadialGradient(this.W / 2, this.H / 2, this.H * 0.32, this.W / 2, this.H / 2, this.H * 0.85)
    edge.addColorStop(0, 'rgba(0,0,0,0)')
    edge.addColorStop(1, green ? `rgba(46,204,113,${0.32 + pulse * 0.12})` : `rgba(231,76,60,${0.42 + pulse * 0.12})`)
    c.fillStyle = edge
    c.fillRect(0, 0, this.W, this.H)

    // 红灯「木头人」定格轮廓：宽限期后对没被抓的玩家画圆角轮廓（0.4s 淡入，对齐站点）
    if (!green) {
      for (let i = 0; i < 2; i++) {
        const st = this.states[i]
        const b = this.players[i].body
        if (!b || st.moved || this.redT < this.cfg.grace * 0.6) continue
        let x0 = 1
        let y0 = 1
        let x1 = 0
        let y1 = 0
        for (const p of b.lm) {
          if ((p.visibility ?? 1) < 0.5) continue
          x0 = Math.min(x0, p.x)
          y0 = Math.min(y0, p.y)
          x1 = Math.max(x1, p.x)
          y1 = Math.max(y1, p.y)
        }
        if (x1 <= x0) continue
        const padX = b.scale * 0.35
        const padTop = b.scale * 0.55
        c.save()
        // 0.4s 淡入 + 轻呼吸
        c.globalAlpha = Math.min(1, (this.redT - this.cfg.grace * 0.6) / 0.4) * (0.6 + 0.15 * Math.sin(this.t * 3))
        c.strokeStyle = '#bfe6ff'
        c.lineWidth = 6
        c.beginPath()
        c.roundRect(
          (x0 - padX) * this.W,
          (y0 - padTop) * this.H,
          (x1 - x0 + padX * 2) * this.W,
          (y1 - y0 + padX + padTop) * this.H,
          24,
        )
        c.stroke()
        c.restore()
      }
    }

    // 红绿灯（左上，避开画面中间的人）
    const cx = 166
    const cy = 82
    c.fillStyle = 'rgba(12,18,44,.62)'
    c.beginPath()
    c.roundRect(cx - 126, cy - 40, 252, 80, 40)
    c.fill()
    circle(c, cx - 66, cy, 23, green ? '#2ecc71' : 'rgba(255,255,255,.13)')
    circle(c, cx + 66, cy, 23, !green ? '#ff4d4d' : 'rgba(255,255,255,.13)')
    if (green) glow(c, cx - 66, cy, 56, '#2ecc71', 0.6)
    else glow(c, cx + 66, cy, 56, '#ff4d4d', 0.6)

    if (green) {
      outlineTxt(c, '使劲动起来！', this.W / 2, 76, 46, '#ffffff')
      // 绿灯尾警告：剩不到 1.2s 时白条闪烁（对齐站点 sin(clock×18)）
      if (this.phaseT < 1.2) {
        c.save()
        c.globalAlpha = Math.max(0, Math.sin(this.t * 18)) * 0.5
        c.fillStyle = '#ffffff'
        c.beginPath()
        c.roundRect(this.W / 2 - 130, 110, 260, 26, 13)
        c.fill()
        c.restore()
      }
    } else {
      outlineTxt(c, '木头人！不许动', this.W / 2, 76, 52, '#fff')
      for (let i = 0; i < 2; i++) {
        const st = this.states[i]
        const b = this.players[i].body
        if (!b || st.moved) continue
        outlineTxt(c, `稳住 ${Math.max(0, st.bank).toFixed(0)} 颗`, (b.shoulderC.x) * this.W, (b.head.y - 0.16) * this.H, 24, '#ffe27a')
      }
    }

    // 星星罐：显示本轮罐内星星（收星后清零重攒）
    const jx = this.W - 130
    const jy = this.H - 190
    c.save()
    c.globalAlpha = 0.95
    c.fillStyle = 'rgba(255,255,255,.16)'
    c.beginPath()
    c.roundRect(jx - 62, jy - 40, 124, 168, 28)
    c.fill()
    c.strokeStyle = 'rgba(255,255,255,.5)'
    c.lineWidth = 4
    c.stroke()
    c.restore()

    const shown = this.states[0].shown
    const rows = Math.min(24, Math.floor(shown / 6))
    for (let i = 0; i < rows; i++) {
      const col = i % 4
      const row = Math.floor(i / 4)
      const sxp = jx - 40 + col * 27
      const syp = jy + 108 - row * 22
      star(c, sxp, syp, 11, i < rows - 1 ? '#ffd54a' : '#fff2a8')
    }
    outlineTxt(c, `${Math.round(shown)}`, jx, jy + 148, 30, '#fff')
    txt(c, `本轮·上限${BANK_CAP}`, jx, jy + 172, 13, 'rgba(255,255,255,.75)', 'center', 'bold')

    // 阶段剩余时间
    ring(c, 64, this.H - 64, 30, Math.max(0, this.phaseT / this.phaseTotal), green ? '#2ecc71' : '#ff4d4d', 8)
  }
}

export default function create(ctx: GameContext) {
  return new FreezeGame(ctx)
}
