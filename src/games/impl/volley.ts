import { BaseGame } from '@/core/base'
import type { Game, GameContext, PoseFrame } from '@/core/types'
import { glow, outlineTxt, txt } from '@/core/draw'

/**
 * 排球垫球（对齐 dongdongpark 真实规则，报告 _reverse/reports/volley.md）：
 * 排球落下来，走到圆圈那里；到腰的高度两手并拢往上垫，到头顶双手举高托起来，连续不落地。
 * 姿势二分：同一颗球按玩家当前姿势自动判托或垫；medium+ 垫球要求腕部「正在向上运动」。
 * 双人（mode=coop 同队）传球给队友、合作共分。
 */

/** 对齐站点难度表：重力(×H/s²) / 顶点区间(×H) / 落点漂移(×W) / 球判定半径(×H) / 额外判定(×躯干) / 垫球双腕最大间距 / 托球手高线 / 垫球腕上行门槛 / AI失误率(未用) */
const DIFF = [
  { g: 0.55, apex: [0.02, 0.28] as const, drift: [0.03, 0.11] as const, r: 0.058, reach: 0.42, gap: 0.8, setUp: -0.25, lift: -1, miss: 0.14 },
  { g: 0.62, apex: [0, 0.3] as const, drift: [0.05, 0.17] as const, r: 0.052, reach: 0.34, gap: 0.6, setUp: 0, lift: 0.3, miss: 0.18 },
  { g: 0.8, apex: [-0.02, 0.33] as const, drift: [0.07, 0.24] as const, r: 0.047, reach: 0.28, gap: 0.5, setUp: 0.12, lift: 0.6, miss: 0.22 },
]
const GROUND = 0.92 // 地面线（×H）
const SHADOW_B = 0.45 // 影子基础尺寸 px×unit
const LIFT_WIN = 0.35 // 垫球「刚抬腕」有效窗 s
const SAND_H = 24 // 沙地高度 px×unit
const HIT_CD = 0.25 // 距上次击球的最短间隔 s
const DROP_T = 1.5 // 落地弹跳时长 s
const HINT_CD = 7 // 接空提示语音冷却 s

interface VolleyBall {
  x: number
  y: number
  vx: number
  vy: number
  r: number
  /** 归属目标玩家（应去接的人） */
  to: number
  /** 最近一次击球者 */
  lastHitBy: number
  lastHitT: number
  /** 落点预告 */
  tx: number
  state: 'fly' | 'drop'
  dropT: number
}

interface Deck {
  sets: number
  bumps: number
  /** 最近抬腕时刻（垫球「正在向上运动」判定） */
  lastLiftT: number
  lastHintT: number
}

class Volley extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  ball: VolleyBall = this.newBall(0)
  decks: Deck[] = [
    { sets: 0, bumps: 0, lastLiftT: -9, lastHintT: -9 },
    { sets: 0, bumps: 0, lastLiftT: -9, lastHintT: -9 },
  ]
  /** 连续计数（落地清 0） */
  combo = 0
  best = 0
  drops = 0
  bannerT = 0
  bannerText = ''
  shakeT = 0

  private newBall(to: number): VolleyBall {
    return { x: this.W / 2, y: -50, vx: 0, vy: 0, r: this.cfg.r * this.H, to, lastHitBy: -1, lastHitT: -9, tx: this.W / 2, state: 'fly', dropT: 0 }
  }

  private duo() {
    return this.players.filter((p) => p.body).length > 1
  }

  /** 玩家活动区（solo 0.08~0.92；duo 各半场） */
  private zone(pi: number) {
    if (this.duo()) return pi === 0 ? { x0: this.W * 0.03, x1: this.W * 0.47 } : { x0: this.W * 0.53, x1: this.W * 0.97 }
    return { x0: this.W * 0.08, x1: this.W * 0.92 }
  }

  /** 连击热度：连击越多重力越大（原站 env.heat 宿主维护，这里按连击近似） */
  private gravity() {
    const heat = Math.min(1, this.combo * 0.06)
    return this.cfg.g * this.H * (1 + 0.15 * heat)
  }

  /** 轨迹解算 U()：给落点 xt 与顶点 apex 反解初速（vy0 向上，vx=全程位移/总时长，≥0.5s 保护） */
  private serveBall(x0: number, y0: number, xt: number, to: number, by: number) {
    const g = this.gravity()
    const groundY = GROUND * this.H
    const apexLo = this.cfg.apex[0] * this.H
    const apexHi = this.cfg.apex[1] * this.H
    const apexY = Math.min(y0, groundY) - (apexLo + Math.random() * (apexHi - apexLo))
    // 上升/下降时长
    const hRise = Math.max(10, y0 - apexY)
    const hFall = Math.max(10, apexY - (groundY - this.ball.r))
    const tRise = Math.sqrt((2 * hRise) / g)
    const tFall = Math.sqrt((2 * hFall) / g)
    const total = Math.max(0.5, tRise + tFall)
    const vy0 = -Math.sqrt(2 * g * hRise)
    const vx = (xt - x0) / total
    const b = this.newBall(to)
    b.x = x0
    b.y = y0
    b.vx = vx
    b.vy = vy0
    b.tx = xt
    b.lastHitBy = by
    b.lastHitT = this.t
    this.ball = b
    this.ctx.audio.slash()
  }

  /** 从屏幕上方发球：落点 = 区内随机（漂移自中心 ±drift×W），起点偏向随机侧 ±0.22W */
  private serveFromTop(to: number) {
    const z = this.zone(to)
    const cx = (z.x0 + z.x1) / 2
    const drift = (this.cfg.drift[0] + Math.random() * (this.cfg.drift[1] - this.cfg.drift[0])) * this.W
    // 落点钳制区 20%~80%
    const xt = Math.max(z.x0 + (z.x1 - z.x0) * 0.2, Math.min(z.x1 - (z.x1 - z.x0) * 0.2, cx + (Math.random() * 2 - 1) * drift))
    const x0 = xt + (Math.random() < 0.5 ? -1 : 1) * 0.22 * this.W
    this.serveBall(x0, -this.cfg.r * this.H, xt, to, -1)
  }

  /** 击球后重发：单人自传随机区；双人传队友区（队友缺位自动改自传） */
  private passTo(pi: number) {
    const duo = this.duo()
    let target = pi
    if (duo) {
      const mate = 1 - pi
      if (this.players[mate].body) target = mate
    }
    const z = this.zone(target)
    // 单人全区 20%~80%；双人队友区内侧 24%~76%
    const lo = duo ? 0.24 : 0.2
    const hi = duo ? 0.76 : 0.8
    const xt = z.x0 + (z.x1 - z.x0) * (lo + Math.random() * (hi - lo))
    this.serveBall(this.ball.x, this.ball.y, xt, target, pi)
  }

  tick(f: PoseFrame, dt: number) {
    const duo = this.duo()
    const groundY = GROUND * this.H
    const T = (pi: number) => {
      const b = f.bodies[pi]
      return b ? Math.max(60, Math.max(0.05, b.scale) * this.H) : this.H * 0.2
    }
    if (this.bannerT > 0) this.bannerT -= dt
    if (this.shakeT > 0) this.shakeT -= dt

    // 抬腕检测（垫球「正在向上运动」：双手平均上行速度 > lift，躯干/s）
    for (let pi = 0; pi < 2; pi++) {
      const body = f.bodies[pi]
      if (!body) continue
      const scale = Math.max(0.05, body.scale)
      const dy = this.wristVy(pi, dt) // 归一化/s（向上为负）
      const up = -dy / scale
      if (up > this.cfg.lift) this.decks[pi].lastLiftT = this.t
    }

    const b = this.ball
    if (b.state === 'fly') {
      b.vy += this.gravity() * dt
      b.x += b.vx * dt
      b.y += b.vy * dt
      // 屏幕左右边界弹回（起点可能偏出屏）
      if (b.x < b.r) {
        b.x = b.r
        b.vx = Math.abs(b.vx)
      } else if (b.x > this.W - b.r) {
        b.x = this.W - b.r
        b.vx = -Math.abs(b.vx)
      }
      // 落地
      if (b.y >= groundY - b.r) {
        b.y = groundY - b.r
        b.state = 'drop'
        b.dropT = DROP_T
        this.onDrop()
      }
    } else {
      // drop：弹跳 1.5s 后重发（vy 衰减 0.4 / 0.35）
      b.dropT -= dt
      b.vy += this.gravity() * dt
      b.y += b.vy * dt
      if (b.y >= groundY - b.r) {
        b.y = groundY - b.r
        b.vy = -Math.abs(b.vy) * (b.vy > -300 ? 0.35 : 0.4)
        if (Math.abs(b.vy) < 60) b.vy = 0
      }
      if (b.dropT <= 0) {
        this.serveFromTop(b.to)
      }
    }

    // 击球判定（球下落 vy>0 且距上次击球 >0.25s）：托 / 垫两姿势
    if (b.state === 'fly' && b.vy > 0 && this.t - b.lastHitT > HIT_CD) {
      for (let pi = 0; pi < 2; pi++) {
        const body = f.bodies[pi]
        if (!body) continue
        const hit = this.tryHit(pi, body, T(pi))
        if (hit) {
          this.onHit(pi, hit, duo)
          break
        }
      }
      // 接空提示：球到判定圈内但姿势不对
      if (b.state === 'fly') this.emptyHint(f, T)
    }

    // 统计
    this.ctx.setScore(this.scoreTotal())
    this.ctx.setCombo(this.combo)
    this.ctx.setExtra('托球', this.decks[0].sets + this.decks[1].sets)
    this.ctx.setExtra('垫球', this.decks[0].bumps + this.decks[1].bumps)
    this.ctx.setExtra('最多连续', this.best)
    this.ctx.setExtra('落地', this.drops)
  }

  private scoreTotal() {
    const base = this.decks[0].sets + this.decks[0].bumps + this.decks[1].sets + this.decks[1].bumps
    return base
  }

  /** 双腕竖直速度（归一化/s，向上为负）：双手轨迹末两点 ÷ dt */
  private wristVy(pi: number, dt: number) {
    const l = this.players[pi].lHand.trail
    const r = this.players[pi].rHand.trail
    const vyOf = (tr: { x: number; y: number }[]) => {
      if (tr.length < 2) return 0
      const a = tr[tr.length - 2]
      const z = tr[tr.length - 1]
      return (z.y - a.y) / Math.max(0.001, dt)
    }
    return (vyOf(l) + vyOf(r)) / 2
  }

  /** 两种击球姿势 G()：托（双手在头高线以上）/ 垫（双腕并拢且在腰腹高度） */
  private pose(pi: number, b: NonNullable<PoseFrame['bodies'][number]>, T: number): 'set' | 'bump' | null {
    const headY = b.head.y * this.H
    const shY = b.shoulderC.y * this.H
    const hipY = b.hipC.y * this.H
    const l = b.lHand.y * this.H
    const r = b.rHand.y * this.H
    // 托球：双手都在 头y − setUp×torso 之上（easy 线在头下 0.25T 更容易）
    const line = headY - this.cfg.setUp * T
    if (l < line && r < line) return 'set'
    // 垫球：双腕间距 < gap×torso 且两腕都在 肩+0.15T 到 髋+0.45T 之间
    const lx = b.lHand.x * this.W
    const rx = b.rHand.x * this.W
    const wristGap = Math.hypot(lx - rx, l - r)
    const top = shY + 0.15 * T
    const bot = hipY + 0.45 * T
    const inBand = l > top && l < bot && r > top && r < bot
    if (wristGap < this.cfg.gap * T && inBand) {
      // medium/hard：要求 0.35s 内腕部正在向上运动
      if (this.cfg.lift < 0 || this.t - this.decks[pi].lastLiftT < LIFT_WIN) return 'bump'
    }
    return null
  }

  /** 击中判定 K()：托 → 球距双手中点/任一手 < r×H + reach×torso 且球低于手 0.2T 内；垫半径再 +0.05T、低于腕中点 0.25T 内 */
  private tryHit(pi: number, b: NonNullable<PoseFrame['bodies'][number]>, T: number): 'set' | 'bump' | null {
    const ball = this.ball
    const pose = this.pose(pi, b, T)
    if (!pose) return null
    const lx = b.lHand.x * this.W
    const ly = b.lHand.y * this.H
    const rx = b.rHand.x * this.W
    const ry = b.rHand.y * this.H
    const midX = (lx + rx) / 2
    const midY = (ly + ry) / 2
    if (pose === 'set') {
      const rad = this.cfg.r * this.H + this.cfg.reach * T
      const d = Math.min(Math.hypot(ball.x - midX, ball.y - midY), Math.hypot(ball.x - lx, ball.y - ly), Math.hypot(ball.x - rx, ball.y - ry))
      if (d < rad && ball.y > midY - 0.2 * T) return 'set'
    } else {
      const rad = this.cfg.r * this.H + this.cfg.reach * T + 0.05 * T
      if (Math.hypot(ball.x - midX, ball.y - midY) < rad && ball.y > midY - 0.25 * T) return 'bump'
    }
    return null
  }

  /** 击中结算：+1（双人队友同加）、连击、每满 10 庆祝、重发 */
  private onHit(pi: number, pose: 'set' | 'bump', duo: boolean) {
    const ball = this.ball
    if (pose === 'set') this.decks[pi].sets++
    else this.decks[pi].bumps++
    this.combo++
    this.best = Math.max(this.best, this.combo)
    this.ctx.audio.play(pose === 'set' ? 'hit' : 'pop', 0.9, 1 + Math.min(0.4, this.combo * 0.02))
    this.particles.burst(ball.x, ball.y, '#ffffff', 8, 260, 4)
    this.say('托！', ball.x, ball.y - 40, '#ffe27a', 32)
    if (pose === 'bump') this.say('垫！', ball.x, ball.y - 76, '#ffb703', 28)
    // 每满 10：tada + 横幅 + 6 处 confetti×14
    if (this.combo % 10 === 0) {
      this.ctx.audio.play('win', 0.85)
      this.bannerText = duo ? `一起传了 ${this.combo} 个！` : `${this.combo} 个不落地！`
      this.bannerT = 1.6
      for (let i = 0; i < 6; i++) {
        const x = this.W * (0.12 + (i % 3) * 0.38)
        const y = this.H * (i < 3 ? 0.25 : 0.55)
        this.particles.burst(x, y, '#ffd54a', 14, 340, 5)
      }
    }
    this.passTo(pi)
  }

  /** 落地 Y()：连击清 0、落地+1、震屏 4、提示 */
  private onDrop() {
    const prevCombo = this.combo
    this.drops++
    this.combo = 0
    this.shakeT = 0.4
    this.ctx.audio.play('hit', 0.8, 0.7)
    this.ctx.audio.fail()
    // 连击 ≥3 时额外提示「连续 {F} 个，再来！」
    this.bannerText = prevCombo >= 3 ? `连续 ${prevCombo} 个，再来！` : '落地啦'
    this.bannerT = 1.2
  }

  /** 接空提示 q()：球到判定圈内但姿势不对时按球高提示（7s 语音冷却） */
  private emptyHint(f: PoseFrame, T: (pi: number) => number) {
    const ball = this.ball
    const pi = ball.to
    const body = f.bodies[pi]
    if (!body) return
    const torso = T(pi)
    const rad = this.cfg.r * this.H + this.cfg.reach * torso
    if (Math.hypot(ball.x - body.shoulderC.x * this.W, ball.y - body.shoulderC.y * this.H) > rad * 1.6) return
    const dk = this.decks[pi]
    if (this.t - dk.lastHintT < HINT_CD) return
    const headY = body.head.y * this.H
    if (Math.abs(ball.y - headY) < torso * 0.5) {
      dk.lastHintT = this.t
      this.say('双手举高托！', body.head.x * this.W, headY - torso * 0.5, '#9ad0ff', 34)
      this.ctx.audio.play('pop', 0.5, 0.8)
    } else {
      const l = body.lHand
      const r = body.rHand
      const wristGap = Math.hypot((l.x - r.x) * this.W, (l.y - r.y) * this.H) / torso
      if (wristGap > this.cfg.gap) {
        dk.lastHintT = this.t
        this.say('两手并拢垫！', body.hipC.x * this.W, body.hipC.y * this.H - torso * 0.6, '#ffb703', 34)
      } else {
        dk.lastHintT = this.t
        this.say('往上一垫！', body.hipC.x * this.W, body.hipC.y * this.H - torso * 0.6, '#ffb703', 34)
      }
      this.ctx.audio.play('pop', 0.5, 0.8)
    }
  }

  paint(c: CanvasRenderingContext2D) {
    const U = this.H / 720
    const duo = this.players.filter((p) => p.body).length > 1
    const groundY = GROUND * this.H
    if (this.shakeT > 0) {
      c.save()
      const amp = 4 * (this.shakeT / 0.4)
      c.translate(Math.sin(this.t * 66) * amp, Math.cos(this.t * 61) * amp * 0.5)
    }

    // 沙地带（底部，高 C=24×unit 波浪边）+ 双人网柱（中线）
    c.save()
    c.fillStyle = 'rgba(226,196,140,.4)'
    c.beginPath()
    c.moveTo(0, this.H - SAND_H * U)
    for (let x = 0; x <= this.W; x += 60 * U) {
      c.quadraticCurveTo(x + 30 * U, this.H - SAND_H * U - 10 * U, x + 60 * U, this.H - SAND_H * U)
    }
    c.lineTo(this.W, this.H)
    c.lineTo(0, this.H)
    c.closePath()
    c.fill()
    c.restore()
    if (duo) {
      c.save()
      c.strokeStyle = '#b98a5a'
      c.lineWidth = 8 * U
      c.beginPath()
      c.moveTo(this.W / 2, groundY - this.H * 0.3)
      c.lineTo(this.W / 2, groundY)
      c.stroke()
      c.globalAlpha = 0.4
      c.lineWidth = 3
      for (let y = groundY - this.H * 0.28; y < groundY; y += 20 * U) {
        c.beginPath()
        c.moveTo(this.W / 2 - 40 * U, y)
        c.lineTo(this.W / 2 + 40 * U, y)
        c.stroke()
      }
      c.restore()
    }

    const b = this.ball
    // 落点预告：球下落时按当前 vy 解到达 min(地面, 髋−0.3T) 的时间画影子椭圆 + 虚线目标圈
    if (b.state === 'fly' && b.vy > 0) {
      const g = this.gravity()
      const body = this.players[b.to].body
      const targetY = body ? Math.min(groundY, body.hipC.y * this.H - 0.3 * Math.max(60, Math.max(0.05, body.scale) * this.H)) : groundY
      const hFall = Math.max(10, targetY - b.y)
      const tFall = Math.sqrt((2 * hFall) / g)
      const px = Math.max(30, Math.min(this.W - 30, b.x + b.vx * tFall))
      const shR = SHADOW_B * U * (0.7 + 0.6 * Math.min(1, hFall / (this.H * 0.5)))
      c.save()
      c.globalAlpha = 0.25
      c.beginPath()
      c.ellipse(px, groundY, shR * 1.6, shR * 0.5, 0, 0, Math.PI * 2)
      c.fillStyle = '#000'
      c.fill()
      c.globalAlpha = 0.55 + Math.sin(this.t * 7) * 0.15
      c.setLineDash([10, 8])
      c.strokeStyle = this.players[b.to].color
      c.lineWidth = 3.5
      c.beginPath()
      c.ellipse(px, targetY, shR * 1.5, shR * 1.5 * 0.6, 0, 0, Math.PI * 2)
      c.stroke()
      c.restore()
    }

    // 动作徽章：球落到玩家附近下落时（横距 <1.8T、高度在托/垫窗）画 托/垫 徽章
    for (let pi = 0; pi < 2; pi++) {
      const body = this.players[pi].body
      if (!body || b.state !== 'fly' || b.vy <= 0) continue
      const T0 = Math.max(60, Math.max(0.05, body.scale) * this.H)
      const dx = Math.abs(b.x - body.shoulderC.x * this.W)
      if (dx > 1.8 * T0) continue
      const headY = body.head.y * this.H
      const hipY = body.hipC.y * this.H
      if (Math.abs(b.y - headY) < T0 * 0.5) {
        outlineTxt(c, '托', b.x, b.y - 70 * U, 30, '#9ad0ff')
      } else if (b.y > hipY && b.y < hipY + 0.6 * T0) {
        outlineTxt(c, '垫', b.x, b.y - 70 * U, 30, '#ffb703')
      }
    }

    // 球（拖影 + 球体）
    if (b.state !== 'drop' || b.dropT > 0) {
      glow(c, b.x, b.y, b.r * 2, '#ffffff', 0.18)
      c.save()
      c.translate(b.x, b.y)
      c.beginPath()
      c.arc(0, 0, b.r, 0, Math.PI * 2)
      c.fillStyle = '#fdfdfd'
      c.fill()
      c.strokeStyle = '#4cc9f0'
      c.lineWidth = Math.max(3, b.r * 0.16)
      for (const k of [-0.5, 0, 0.5]) {
        c.beginPath()
        c.ellipse(k * b.r * 0.7, 0, b.r * 0.3, b.r * 0.95, 0, 0, Math.PI * 2)
        c.stroke()
      }
      c.strokeStyle = 'rgba(30,30,60,.5)'
      c.lineWidth = 2
      c.beginPath()
      c.arc(0, 0, b.r, 0, Math.PI * 2)
      c.stroke()
      c.restore()
    }

    // 托/垫姿势可视化：托球双手间黄弧、垫球双腕间橙前臂条
    for (let pi = 0; pi < 2; pi++) {
      const body = this.players[pi].body
      if (!body) continue
      const T0 = Math.max(60, Math.max(0.05, body.scale) * this.H)
      const pose = this.pose(pi, body, T0)
      const lx = body.lHand.x * this.W
      const ly = body.lHand.y * this.H
      const rx = body.rHand.x * this.W
      const ry = body.rHand.y * this.H
      if (pose === 'set') {
        c.save()
        c.strokeStyle = '#ffd54a'
        c.lineWidth = 5
        c.beginPath()
        c.arc((lx + rx) / 2, (ly + ry) / 2, Math.max(24, Math.hypot(lx - rx, ly - ry) * 0.6), 0, Math.PI * 2)
        c.stroke()
        c.restore()
      } else if (pose === 'bump') {
        c.save()
        c.strokeStyle = '#ff9d45'
        c.lineWidth = 9
        c.lineCap = 'round'
        c.beginPath()
        c.moveTo(lx, ly)
        c.lineTo(rx, ry)
        c.stroke()
        c.restore()
      }
    }

    if (this.shakeT > 0) c.restore()

    // 连击角标
    if (this.combo >= 2) {
      outlineTxt(c, `连续 ${this.combo}`, 110, 60, 30 + Math.min(14, this.combo), '#ffd54a')
      outlineTxt(c, `最多 ${this.best}`, 110, 100, 22, '#ffffffaa')
    }
    if (this.bannerT > 0 && this.bannerText) {
      c.globalAlpha = Math.min(1, this.bannerT / 0.3)
      outlineTxt(c, this.bannerText, this.W / 2, this.H * 0.2, 48, '#ffd54a')
      c.globalAlpha = 1
    }
    txt(c, '低球两手并拢往上垫，高球双手举高托；球别落地（双人传给队友）', this.W / 2, this.H - 30, 20, 'rgba(255,255,255,.85)', 'center', 'bold')
  }
}

export default function create(ctx: GameContext) {
  return new Volley(ctx)
}
