import { BaseGame } from '@/core/base'
import type { Game, GameContext, PoseFrame } from '@/core/types'
import { circle, outlineTxt, rr, txt } from '@/core/draw'

/**
 * 空中乒乓（对齐 dongdongpark 真实规则，见 _reverse/reports/air-pong.md）：
 * 手的高低控制球拍，球越打越快；挥拍竖直速度赋予上/下旋弧线；
 * 连打 5 板球点燃（×1.18 提速、该回合 2 分）；单人 1 号位为简单跟随的 CPU 对手（cpuMiss 故意漏球）。
 */

/** 对齐站点难度表：v0 初始球速 / vMax 速度上限 / grow 每击加速 / paddle 拍判定半高 /
 *  cpuReact AI 决策周期 / cpuSpeed AI 移速 / cpuErr AI 瞄准误差 / cpuMiss AI 故意漏球率（均场高单位） */
const DIFF = [
  { v0: 1.5, vMax: 3.2, grow: 1.05, paddle: 0.27, cpuReact: 0.45, cpuSpeed: 1.0, cpuErr: 0.12, cpuMiss: 0.4 },
  { v0: 1.8, vMax: 3.8, grow: 1.06, paddle: 0.23, cpuReact: 0.3, cpuSpeed: 1.4, cpuErr: 0.08, cpuMiss: 0.25 },
  { v0: 2.1, vMax: 4.4, grow: 1.07, paddle: 0.2, cpuReact: 0.18, cpuSpeed: 2.0, cpuErr: 0.05, cpuMiss: 0.12 },
]
const BALL_R = 0.032 // 球半径（场高）
const PAD_X = 0.09 // 球拍距场地左右边缘的横向位置
const FIRE_HITS = 5 // 触发火焰球的连击数
const MAX_ANG = (62 * Math.PI) / 180 // 击球最大出射角 62°
const HAND_BASE = 0.35 // 手部高度映射基准偏移
const WALL_LO = 0.032 // 上下墙内边界（场高）
const WALL_HI = 0.968
const CPU_COLOR = '#8d7bb5' // CPU 一侧默认颜色（站点 m）

/** 确定性伪随机（站点 h(e)=frac(sin(e×127.1+311.7)×43758.5453)） */
function hash(n: number) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return s - Math.floor(s)
}

interface RingFx {
  x: number
  y: number
  r: number
  life: number
  color: string
}

/** 每块拍的状态（场高坐标：y ∈ [0,1]，x ∈ [0,A]） */
interface Paddle {
  y: number
  vy: number // 归一化挥拍竖直速度（躯干/s 折算）
  glow: number
  /** CPU 用 */
  cpu: boolean
  decideT: number
  targetY: number
  color: string
  label: string
}

interface Ball {
  x: number // 0..A
  y: number
  px: number // 上一帧 x（越线判定）
  vx: number
  vy: number
  speed: number
  spin: number
  rot: number
  fire: boolean
  hits: number // 本回合连续击球数
  trail: { x: number; y: number }[]
}

type Phase = 'serve' | 'play'

class AirPong extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  unit = this.H / 720
  /** 场地几何 O()：x0=70u x1=W−70u y0=150u y1=H−160u；A=(x1−x0)/ch */
  x0 = 70 * this.unit
  x1 = this.W - 70 * this.unit
  y0 = 150 * this.unit
  y1 = this.H - 160 * this.unit
  ch = this.y1 - this.y0
  A = (this.x1 - this.x0) / this.ch

  paddles: [Paddle, Paddle]
  ball: Ball
  phase: Phase = 'serve'
  phaseT = 0.9 // 发球停留 0.9s
  toward = 0 // 发球方向侧
  rallyId = 0
  cpuScore = 0 // CPU 分（仅展示 🤖 电脑 {D}）
  points = 0 // 总回合（得分）数
  maxRally = 0 // 最长回合
  fires = 0 // 火焰球次数
  bannerT = 0
  bannerText = ''
  bannerSub = ''
  bannerColor = '#fff'
  hitPulse = 0 // 连打文字脉冲
  rings: RingFx[] = []
  prevHandY: [number, number] = [0, 0]
  score = 0

  constructor(ctx: GameContext) {
    super(ctx)
    const solo = ctx.meta.mode !== 'versus' && ctx.meta.mode !== 'coop'
    // 单人：1 号位为 CPU（无体感时走 CPU 分支）；双打两人都体感控拍，无 AI
    this.paddles = [
      { y: 0.5, vy: 0, glow: 0, cpu: false, decideT: 0, targetY: 0.5, color: '#ffd54a', label: '玩家 1' },
      { y: 0.5, vy: 0, glow: 0, cpu: solo, decideT: 0, targetY: 0.5, color: solo ? CPU_COLOR : '#4cc9f0', label: solo ? '🤖 电脑 0' : '玩家 2' },
    ]
    this.ball = {
      x: this.A / 2,
      y: 0.5,
      px: this.A / 2,
      vx: 0,
      vy: 0,
      speed: this.cfg.v0,
      spin: 0,
      rot: 0,
      fire: false,
      hits: 0,
      trail: [],
    }
  }

  private sx(nx: number) {
    return this.x0 + nx * this.ch
  }
  private sy(ny: number) {
    return this.y0 + ny * this.ch
  }

  tick(f: PoseFrame, dt: number) {
    this.bannerT = Math.max(0, this.bannerT - dt)
    this.hitPulse = Math.max(0, this.hitPulse - 1.5 * dt)
    for (let i = this.rings.length - 1; i >= 0; i--) {
      this.rings[i].life -= dt
      if (this.rings[i].life <= 0) this.rings.splice(i, 1)
    }

    this.updatePaddles(f, dt)
    this.updateBall(dt)

    this.ctx.setScore(this.score)
    this.ctx.setCombo(this.maxRally)
    this.paddles[1].label = this.paddles[1].cpu ? `🤖 电脑 ${this.cpuScore}` : '玩家 2'
    // 结算统计（对齐站点：回合数/最长回合/火焰球）
    this.ctx.setExtra('回合数', this.points)
    this.ctx.setExtra('最长回合', this.maxRally)
    this.ctx.setExtra('火焰球', this.fires)
  }

  /** 球拍控制 g(body)：取更高的一只手，手齐髋→拍在底、举到髋上 1.75 躯干→拍顶（对齐站点映射） */
  private updatePaddles(f: PoseFrame, dt: number) {
    for (let pi = 0; pi < 2; pi++) {
      const pad = this.paddles[pi]
      pad.glow = Math.max(0, pad.glow - 4 * dt)
      const body = f.bodies[pi]
      if (pad.cpu || !body) {
        if (pad.cpu) this.updateCpu(pad, dt)
        continue
      }
      // 屏幕位置更高（y 更小）的一只手
      const hy = Math.min(body.lHand.y, body.rHand.y)
      const a = (body.hipC.y - hy) / Math.max(0.05, body.scale)
      const target = 1 - Math.max(0, Math.min(1, (a - HAND_BASE) / 1.4))
      // 指数平滑（时间常数 ≈1/18 s），夹在 [paddle/2, 1−paddle/2]
      const half = this.cfg.paddle / 2
      pad.y += (target - pad.y) * (1 - Math.exp(-dt * 18))
      pad.y = Math.max(half, Math.min(1 - half, pad.y))
      // 归一化挥拍竖直速度（躯干/s）
      let vyT = 0
      if (this.prevHandY[pi] !== 0) {
        vyT = ((hy - this.prevHandY[pi]) * this.H) / Math.max(0.016, dt) / Math.max(0.05, body.scale * this.H)
      }
      this.prevHandY[pi] = hy
      pad.vy += (vyT - pad.vy) * Math.min(1, dt * 20)
    }
  }

  /** CPU 对手：每 cpuReact 决策一次；预测落点（线性外推+墙折叠），cpuMiss 概率故意够不着（对齐站点 I()/F()） */
  private updateCpu(pad: Paddle, dt: number) {
    const b = this.ball
    pad.decideT -= dt
    if (pad.decideT <= 0) {
      pad.decideT = this.cfg.cpuReact
      if (b.vx > 0 && b.x > this.A * 0.42) {
        const hashV = hash(this.rallyId * 13.7 + Math.floor(this.t * 7))
        if (hashV < this.cfg.cpuMiss) {
          // 失误骰：瞄准点故意偏移 ±(paddle×0.9+0.08)，必然够不着
          const off = (this.cfg.paddle * 0.9 + 0.08) * (hash(this.rallyId * 5.3 + Math.floor(this.t * 11)) < 0.5 ? -1 : 1)
          pad.targetY = this.predictY() + off
        } else {
          const distFactor = Math.min(1, Math.max(0, (b.x - this.A * 0.42) / (this.A * 0.58)))
          pad.targetY = this.predictY() + (hash(this.rallyId * 7.9 + this.t * 31) - 0.5) * 2 * this.cfg.cpuErr * (0.6 + distFactor)
        }
      } else {
        pad.targetY = 0.5 + (hash(Math.floor(this.t * 3)) - 0.5) * 0.2 // 回中 0.5±0.1
      }
      const half = this.cfg.paddle / 2
      pad.targetY = Math.max(half, Math.min(1 - half, pad.targetY))
    }
    // 移动限速 cpuSpeed（场高/s）；CPU 拍速折算 handVy（−dy/dt×0.6），同样能打出旋转
    const dy = pad.targetY - pad.y
    const step = Math.max(-this.cfg.cpuSpeed * dt, Math.min(this.cfg.cpuSpeed * dt, dy))
    pad.y += step
    pad.vy = (-step / Math.max(0.016, dt)) * 0.6
  }

  /** 线性外推 + 上下墙折叠反射的落点预测（对齐站点 F()） */
  private predictY() {
    const b = this.ball
    const t = (this.A - 0.09 - b.x) / (b.vx || 0.001)
    let y = b.y + b.vy * t + 0.5 * b.spin * b.speed * 0.5 * t * t
    // 折叠反射到 [WALL_LO, WALL_HI]
    const span = WALL_HI - WALL_LO
    y = ((y - WALL_LO) % (2 * span) + 2 * span) % (2 * span)
    return y > span ? 2 * span - y + WALL_LO : y + WALL_LO
  }

  private updateBall(dt: number) {
    const b = this.ball
    if (this.phase === 'serve') {
      this.phaseT -= dt
      if (this.phaseT <= 0) {
        // 发射：±0.35rad 随机角，指向 toward 一侧，速度重置 v0（对齐站点 j()/M()）
        const ang = (hash(this.rallyId * 3.7 + 1) - 0.5) * 0.7
        const dir = this.toward === 0 ? -1 : 1
        b.speed = this.cfg.v0
        b.vx = Math.cos(ang) * b.speed * dir
        b.vy = Math.sin(ang) * b.speed
        b.spin = 0
        b.fire = false
        b.hits = 0
        b.trail.length = 0
        this.phase = 'play'
        this.ctx.audio.pop()
      }
      b.px = b.x
      return
    }

    // substep 步进：单步位移 ≤0.03 场高（对齐站点）
    const dist = Math.hypot(b.vx, b.vy) * dt
    const n = Math.max(1, Math.ceil(dist / 0.03))
    const sdt = dt / n
    for (let i = 0; i < n; i++) {
      b.vy += b.spin * b.speed * 0.5 * sdt // 马格努斯式弧线
      b.spin *= Math.exp(-1.1 * sdt) // 旋转衰减
      const len = Math.hypot(b.vx, b.vy) || 1
      b.vx = (b.vx / len) * b.speed // 重新归一化：匀速、仅改方向
      b.vy = (b.vy / len) * b.speed
      b.px = b.x
      b.x += b.vx * sdt
      b.y += b.vy * sdt
      b.rot += (b.vx > 0 ? 1 : -1) * b.speed * 3 * sdt
      // 上下墙反弹
      if (b.y < WALL_LO) {
        b.y = WALL_LO
        b.vy = Math.abs(b.vy)
        this.ctx.audio.tick()
      } else if (b.y > WALL_HI) {
        b.y = WALL_HI
        b.vy = -Math.abs(b.vy)
        this.ctx.audio.tick()
      }
      this.tryHit(0)
      this.tryHit(1)
    }

    // 尾迹
    b.trail.push({ x: b.x, y: b.y })
    if (b.trail.length > 9) b.trail.shift()
    if (b.fire && Math.random() < dt * 40) {
      this.particles.burst(this.sx(b.x), this.sy(b.y), '#ff9f43', 1, 60, 4 * this.unit, 0)
    }

    // 漏球判定：越过拍线 0.35 场高才算漏（对齐站点）
    if (b.x < -0.35) this.endRally(0)
    else if (b.x > this.A + 0.35) this.endRally(1)
  }

  /** 击球 N()：球心越过拍线 + 方向匹配 + 高度在拍面内 → 反弹、加速、赋旋（对齐站点） */
  private tryHit(side: 0 | 1) {
    const b = this.ball
    const line = side === 0 ? PAD_X : this.A - PAD_X
    const pad = this.paddles[side]
    const crossing = side === 0 ? b.vx < 0 && b.px >= line && b.x <= line : b.vx > 0 && b.px <= line && b.x >= line
    if (!crossing) return
    if (Math.abs(b.y - pad.y) >= this.cfg.paddle / 2 + BALL_R * 0.9) return

    b.hits++
    this.maxRally = Math.max(this.maxRally, b.hits)
    b.speed = Math.min(this.cfg.vMax, b.speed * this.cfg.grow)
    // 出射角：拍边缘出大角度，向上挥拍压低出射角
    let ang = Math.max(-1, Math.min(1, (b.y - pad.y) / (this.cfg.paddle / 2))) * MAX_ANG * 0.75
    ang -= Math.max(-3.5, Math.min(3.5, pad.vy)) * 0.1
    ang = Math.max(-MAX_ANG, Math.min(MAX_ANG, ang))
    const dir = side === 0 ? 1 : -1
    b.vx = Math.cos(ang) * b.speed * dir
    b.vy = Math.sin(ang) * b.speed
    // 旋转：spin = −handVy×0.4；|handVy|>1.2 弹上旋/下旋字
    b.spin = -pad.vy * 0.4
    if (Math.abs(pad.vy) > 1.2) {
      this.say(pad.vy < 0 ? '上旋！' : '下旋！', this.sx(line), this.sy(pad.y) - 30, pad.color, 26)
    }
    b.x = line - dir * 0.052 // 重置到拍线外防连触
    this.ctx.audio.play('hit', 0.9, 1 + Math.min(0.5, b.hits * 0.04)) // 站点 sfx('kick') 音高随回合升
    this.rings.push({ x: this.sx(b.x), y: this.sy(b.y), r: this.ch * 0.08, life: 0.3, color: pad.color })
    pad.glow = 1
    this.hitPulse = 1
    // 火焰球：连打 5 板点燃，×1.18 提速，该回合值 2 分（对齐站点）
    if (b.hits >= FIRE_HITS && !b.fire) {
      b.fire = true
      this.fires++
      b.speed = Math.min(this.cfg.vMax, b.speed * 1.18)
      const len = Math.hypot(b.vx, b.vy) || 1
      b.vx = (b.vx / len) * b.speed
      b.vy = (b.vy / len) * b.speed
      this.showBanner('火焰球！', '赢下这球得 2 分', '#e8590c', 1.3)
      this.ctx.audio.slash() // 站点 sfx('whoosh') → 噪声 whoosh 等价代理
      const cols = ['#ffd54a', '#ff9f43', '#ff6b6b']
      for (const col of cols) this.particles.burst(this.sx(b.x), this.sy(b.y), col, 5, 320 * this.unit, 10 * this.unit)
    }
  }

  /** 回合结束 P()：火焰球 2 分/普通 1 分，赢家 = 漏球方的对面（对齐站点） */
  private endRally(missSide: 0 | 1) {
    const winner = (missSide === 0 ? 1 : 0) as 0 | 1
    const pts = this.ball.fire ? 2 : 1
    this.points++
    this.toward = missSide // 漏球者接发球
    this.rallyId++
    this.phase = 'serve'
    this.phaseT = 0.8
    this.ball.x = this.A / 2
    this.ball.y = 0.5
    this.ball.trail.length = 0
    const pad = this.paddles[winner]
    const mx = this.sx(this.A / 2)
    if (pad.cpu) {
      this.cpuScore += pts
      this.say('漏了！', mx, this.sy(0.4), '#7a6b9a', 34)
      this.ctx.audio.fail()
    } else {
      this.score += pts
      this.say(this.ball.fire ? '火焰球 +2' : '+1', mx, this.sy(0.35), '#ffd54a', 34)
      this.ctx.audio.coin()
      this.particles.burst(mx, this.sy(0.4), pad.color, 16, 300 * this.unit, 10 * this.unit)
    }
  }

  private showBanner(text: string, sub: string, color: string, sec: number) {
    this.bannerText = text
    this.bannerSub = sub
    this.bannerColor = color
    this.bannerT = sec
  }

  paint(c: CanvasRenderingContext2D) {
    const u = this.unit
    const ch = this.ch
    // 背景：天/地渐变 + 地纹线 + 白光（对齐站点）
    const sky = c.createLinearGradient(0, 0, 0, this.y0 + ch * 0.65)
    sky.addColorStop(0, '#f8f1ff')
    sky.addColorStop(1, '#e9e0f7')
    c.fillStyle = sky
    c.fillRect(0, 0, this.W, this.y0 + ch * 0.65)
    const gr = c.createLinearGradient(0, this.y0 + ch * 0.65, 0, this.H)
    gr.addColorStop(0, '#d8b48a')
    gr.addColorStop(1, '#c49a6c')
    c.fillStyle = gr
    c.fillRect(0, this.y0 + ch * 0.65, this.W, this.H - this.y0 - ch * 0.65)
    c.strokeStyle = 'rgba(255,255,255,.14)'
    c.lineWidth = 2
    for (let i = 1; i <= 6; i++) {
      const y = this.y0 + ch * 0.65 + ((this.H - this.y0 - ch * 0.65) * i) / 7
      c.beginPath()
      c.moveTo(0, y)
      c.lineTo(this.W, y)
      c.stroke()
    }
    c.save()
    c.globalAlpha = 0.18
    c.fillStyle = '#fff'
    c.beginPath()
    c.moveTo(this.W * 0.2, 0)
    c.lineTo(this.W * 0.34, 0)
    c.lineTo(this.W * 0.44, this.H)
    c.lineTo(this.W * 0.3, this.H)
    c.fill()
    c.beginPath()
    c.moveTo(this.W * 0.7, 0)
    c.lineTo(this.W * 0.84, 0)
    c.lineTo(this.W * 0.78, this.H)
    c.lineTo(this.W * 0.64, this.H)
    c.fill()
    c.restore()

    // 球台 + 两端玩家色条 + 中线 + 网
    rr(c, this.x0, this.y0, this.x1 - this.x0, ch, 18)
    c.fillStyle = '#2f9e9a'
    c.fill()
    c.strokeStyle = '#fffdf3'
    c.lineWidth = 7 * u
    c.stroke()
    c.strokeStyle = '#4a3b5c'
    c.lineWidth = 4 * u
    c.stroke()
    c.save()
    c.globalAlpha = 0.2
    c.fillStyle = this.paddles[0].color
    c.fillRect(this.x0, this.y0, ch * 0.2, ch)
    c.fillStyle = this.paddles[1].color
    c.fillRect(this.x1 - ch * 0.2, this.y0, ch * 0.2, ch)
    c.restore()
    c.setLineDash([14, 12])
    c.strokeStyle = 'rgba(255,255,255,.5)'
    c.lineWidth = 3
    c.beginPath()
    c.moveTo((this.x0 + this.x1) / 2, this.y0 + 6)
    c.lineTo((this.x0 + this.x1) / 2, this.y1 - 6)
    c.stroke()
    c.setLineDash([])

    // 球拍（随移动速度倾斜，命中光晕，旁标签）
    for (let pi = 0; pi < 2; pi++) {
      const pad = this.paddles[pi]
      const px = pi === 0 ? this.sx(PAD_X) : this.sx(this.A - PAD_X)
      const py = this.sy(pad.y)
      const ph = this.cfg.paddle * ch
      const tilt = Math.max(-1.5, Math.min(1.5, pad.vy)) * 0.12 * (pi === 0 ? 1 : -1)
      c.save()
      c.translate(px, py)
      c.rotate(tilt)
      if (pad.glow > 0) {
        c.shadowColor = pad.color
        c.shadowBlur = 30 * u * pad.glow
      }
      rr(c, -10 * u, -ph / 2, 20 * u, ph, 10 * u)
      c.fillStyle = pad.color
      c.fill()
      c.strokeStyle = '#4a3b5c'
      c.lineWidth = 3
      c.stroke()
      c.shadowBlur = 0
      rr(c, -4 * u, -ph / 2 + 8 * u, 8 * u, ph - 16 * u, 4 * u)
      c.fillStyle = 'rgba(255,255,255,.55)'
      c.fill()
      c.restore()
      txt(c, pad.label, px, this.y0 - 26 * u, 22, pad.color)
    }

    // 网（中柱）
    const nx = (this.x0 + this.x1) / 2
    c.strokeStyle = 'rgba(255,253,243,.9)'
    c.lineWidth = 5 * u
    c.beginPath()
    c.moveTo(nx, this.y0 - 14 * u)
    c.lineTo(nx, this.y1 + 14 * u)
    c.stroke()

    // 球 + 尾迹
    const b = this.ball
    for (let i = 0; i < b.trail.length; i++) {
      const tp = b.trail[i]
      c.save()
      c.globalAlpha = ((i + 1) / b.trail.length) * 0.4
      circle(c, this.sx(tp.x), this.sy(tp.y), BALL_R * ch * (0.4 + (0.6 * i) / b.trail.length), b.fire ? '#ff9f43' : '#ffffff')
      c.restore()
    }
    const bx = this.sx(b.x)
    const by = this.sy(b.y)
    const pulse = this.phase === 'serve' ? 1 + Math.sin(this.t * 10) * 0.08 : 1
    c.save()
    c.translate(bx, by)
    if (b.fire) {
      c.shadowColor = '#ff9f43'
      c.shadowBlur = 26 * u
    }
    c.rotate(b.rot)
    circle(c, 0, 0, BALL_R * ch * pulse, b.fire ? '#ffb347' : '#ffffff')
    c.strokeStyle = b.fire ? '#e8590c' : '#4a3b5c'
    c.lineWidth = 2.5 * u
    c.stroke()
    c.beginPath()
    c.arc(0, 0, BALL_R * ch * pulse * 0.4, 0, Math.PI * 2)
    c.fillStyle = b.fire ? '#fff3bf' : 'rgba(74,59,92,.5)'
    c.fill()
    c.restore()
    if (this.phase === 'serve') {
      // 发球箭头
      const dir = this.toward === 0 ? -1 : 1
      c.save()
      c.globalAlpha = 0.7 + Math.sin(this.t * 8) * 0.2
      c.fillStyle = '#fff'
      c.beginPath()
      c.moveTo(bx + dir * 30 * u, by)
      c.lineTo(bx + dir * 64 * u, by - 14 * u)
      c.lineTo(bx + dir * 64 * u, by + 14 * u)
      c.fill()
      c.restore()
      outlineTxt(c, '发球！', bx, by - 52 * u, 30, '#ffd54a')
    }

    // 命中圆环
    for (const rf of this.rings) {
      c.save()
      c.globalAlpha = Math.max(0, rf.life / 0.3)
      c.strokeStyle = rf.color
      c.lineWidth = 5 * u
      c.beginPath()
      c.arc(rf.x, rf.y, rf.r * (1.3 - rf.life), 0, Math.PI * 2)
      c.stroke()
      c.restore()
    }

    // 连打计数（火焰球带 🔥，脉冲缩放）
    if (b.hits >= 2 && this.phase === 'play') {
      const sc = 1 + this.hitPulse * 0.25
      c.save()
      c.translate(this.W / 2, 64 * u)
      c.scale(sc, sc)
      outlineTxt(c, b.fire ? `🔥 连打 ${b.hits}！` : `连打 ${b.hits}`, 0, 0, 30, b.fire ? '#ff9f43' : '#fff')
      c.restore()
    }

    if (this.bannerT > 0) {
      c.globalAlpha = Math.min(1, this.bannerT / 0.3)
      outlineTxt(c, this.bannerText, this.W / 2, this.H * 0.24, 54, this.bannerColor)
      if (this.bannerSub) outlineTxt(c, this.bannerSub, this.W / 2, this.H * 0.24 + 52, 28, '#fff')
      c.globalAlpha = 1
    }
    txt(c, '手多高球拍就多高；快速上挥/下挥能打上旋、下旋；连打 5 板出火焰球', this.W / 2, this.H - 26, 20, 'rgba(255,255,255,.85)', 'center', 'bold')
  }
}

export default function create(ctx: GameContext) {
  return new AirPong(ctx)
}
