import { BaseGame } from '@/core/base'
import type { Game, GameContext, PoseFrame } from '@/core/types'
import { circle, emoji, outlineTxt, rr, txt } from '@/core/draw'

/**
 * 投篮高手（对齐 dongdongpark 真实规则，见 _reverse/reports/hoops.md）：
 * 篮筐左右摆动（hard 另有远近交替远景筐），双手举过头顶用力往上一投；
 * 峰值速度追踪，回落到峰值 55% 时出手，出手瞬间按力度/横向偏差预判结果；
 * 连进 3 球着火（每球 +1），空心 3 分、普通/打板 2 分。
 */

/** 对齐站点难度表：period 摆动周期(s) / amp 摆幅(×unit) / power 进球所需力度(躯干/s) /
 *  tol 力度容差 / far 远景筐开关 / next 进球后下一球延迟(s) */
const DIFF = [
  { period: 11, amp: 180, power: 3.2, tol: 1.4, far: 0, next: 1.3 },
  { period: 9, amp: 220, power: 4, tol: 1, far: 0, next: 1.5 },
  { period: 7, amp: 260, power: 4.4, tol: 0.75, far: 1, next: 1.5 },
]
/** 站点儿童模式（!env.big）覆盖表 {hoop:1.3, slow:1.4, tol:1.4, power:.85, minPower:1.4}——
 *  本框架无宿主 big 标志，等价代理：默认按成人（big）处理；常量导出备查 */
export const KID = { hoop: 1.3, slow: 1.4, tol: 1.4, power: 0.85, minPower: 1.4 }
const MIN_POWER = 1.8 // 成人最低出手力度（儿童 1.4）
const FLY_T = 1 // 球飞行时长 s
const FIRE_STREAK = 3 // 着火连击线
const HOOP_W = 125 // 篮筐基准宽 ×unit
const GRAV_IN = 500 // 进球后下落重力 ×unit
const GRAV_MISS = 800 // 失手球下落重力 ×unit

/** 确定性伪随机（站点 env.rng 等价代理） */
function frac(x: number) {
  return x - Math.floor(x)
}
function hash(n: number) {
  return frac(Math.sin(n * 127.1 + 311.7) * 43758.5453)
}

type ShotResult = 'swish' | 'in' | 'bank' | 'side' | 'short' | 'long'

interface Hoop {
  x: number
  y: number
  scale: number // 远景缩小
  farS: number // 远景参数 s∈[0,1]
  w: number
  powerEff: number // 当前所需力度（远景 +1.3s）
}

interface Ball {
  state: 'hold' | 'fly' | 'through' | 'fall' | 'dead'
  t: number
  x: number
  y: number
  from: { x: number; y: number }
  to: { x: number; y: number }
  ctrl: { x: number; y: number }
  arc: number
  result: ShotResult
  hot: boolean // 出手时是否着火
  rot: number
  vx: number
  vy: number
}

interface PState {
  ball: Ball | null
  timer: number // 无球倒计时（初始 0.6）
  armed: boolean
  peak: number
  coolT: number // "用力往上投！"冷却
  missN: number // 连续失手（儿童提示用）
  streak: number
  maxStreak: number
  made: number
  shots: number
  swishes: number
  netE: number // 入网弹性
  fireBanner: boolean
}

class Hoops extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  unit = this.H / 720
  ps: [PState, PState]
  /** 摆动相位（站点 rng(5)()×2π，双人同相位） */
  phase0 = hash(5) * Math.PI * 2
  bannerT = 0
  bannerText = ''
  bannerSub = ''
  bannerColor = '#fff'
  score = 0

  constructor(ctx: GameContext) {
    super(ctx)
    this.ps = [this.newPS(), this.newPS()]
    this.ps[0].timer = 0.6
    this.ps[1].timer = 1.2
  }

  private newPS(): PState {
    return {
      ball: null,
      timer: 0.6,
      armed: false,
      peak: 0,
      coolT: 0,
      missN: 0,
      streak: 0,
      maxStreak: 0,
      made: 0,
      shots: 0,
      swishes: 0,
      netE: 0,
      fireBanner: false,
    }
  }

  tick(f: PoseFrame, dt: number) {
    this.bannerT = Math.max(0, this.bannerT - dt)
    const duo = this.players.filter((p) => p.body).length >= 2
    for (let pi = 0; pi < 2; pi++) {
      const st = this.ps[pi]
      if (pi === 1 && !duo) continue
      st.coolT = Math.max(0, st.coolT - dt)
      st.netE = Math.max(0, st.netE - dt * 2.2)
      const body = f.bodies[pi]
      const hoop = this.hoopPos(pi)

      // 发球：无球时倒计时归零 → 持球（对齐站点 S[i]/M(i)）
      if (!st.ball) {
        st.timer -= dt
        if (st.timer <= 0) {
          st.ball = this.newBall(st)
          this.ctx.audio.play('pop', 0.7, 0.9) // 站点 appear
        }
      }

      if (!body) continue

      // 出手判定：双手举过头顶 + 上行速度 → armed，峰值追踪，回落 55% 出手（对齐站点）
      const torso = Math.max(0.05, body.scale)
      const headR = torso * this.H * 0.14 // 站点 head.r 黑盒等价代理
      const upLine = body.head.y * this.H - headR * 0.35
      const lUp = body.lHand.y * this.H < upLine
      const rUp = body.rHand.y * this.H < upLine
      const p = (body.lHandV + body.rHandV) / 2 / torso
      // 上行检测：trail 的竖直位移（屏幕 y 向上为负）
      const vyAvg = this.handVy(f, pi)
      if (!st.armed) {
        if (lUp && rUp && vyAvg < 0 && p > 1) {
          st.armed = true
          st.peak = p
        }
      } else {
        if (lUp && rUp) st.peak = Math.max(st.peak, p)
        const released = !lUp || !rUp || p < st.peak * 0.55
        if (released) {
          st.armed = false
          if (st.ball && st.ball.state === 'hold') {
            const minPower = MIN_POWER // 成人（儿童 1.4，见 KID 注释）
            if (st.peak >= minPower) this.shoot(st, body, hoop)
            else if (st.coolT <= 0) {
              st.coolT = 2.5
              this.say('用力往上投！', body.shoulderC.x * this.W, body.head.y * this.H - 70, '#ff9f43', 34)
            }
          }
          st.peak = 0
        }
      }

      // 球状态机
      if (st.ball) this.tickBall(st, pi, dt)
    }

    this.ctx.setScore(this.score)
    const s0 = this.ps[0]
    const shots = s0.shots + (duo ? this.ps[1].shots : 0)
    const made = s0.made + (duo ? this.ps[1].made : 0)
    this.ctx.setExtra('命中率', shots > 0 ? Math.round((made / shots) * 100) : 0)
    this.ctx.setExtra('最多连进', Math.max(s0.maxStreak, this.ps[1].maxStreak))
    this.ctx.setExtra('空心球', s0.swishes + this.ps[1].swishes)
  }

  /** 双手竖直速度均值（屏幕 px/s，向上为负）。速度标量无法给方向，改用 trail 前后帧 */
  private handVy(f: PoseFrame, pi: number): number {
    const body = f.bodies[pi]
    if (!body) return 0
    const dt = Math.max(0.016, f.dt || 1 / 30)
    const l = this.players[pi].lHand.trail
    const r = this.players[pi].rHand.trail
    let vy = 0
    let n = 0
    if (l.length >= 2) {
      vy += l[l.length - 1].y - l[l.length - 2].y
      n++
    }
    if (r.length >= 2) {
      vy += r[r.length - 1].y - r[r.length - 2].y
      n++
    }
    if (n === 0) return 0
    return vy / n / dt
  }

  /** 篮筐位置 j()：区域中心 + sin 摆动；hard 远景参数 s 连续正弦（对齐站点） */
  private hoopPos(pi: number): Hoop {
    const u = this.unit
    const z = this.zone(pi)
    const zc = (z.x0 + z.x1) / 2
    const zw = z.x1 - z.x0
    const t = this.t
    const x = zc + Math.sin((t / this.cfg.period) * Math.PI * 2 + this.phase0) * Math.min(zw * 0.32, this.cfg.amp * u)
    const far = this.cfg.far > 0
    const s = far ? (Math.sin((t / (this.cfg.period * 1.7)) * Math.PI * 2 + this.phase0 * 0.5) + 1) / 2 : 0
    return {
      x,
      y: Math.max(128, this.H * 0.21) - s * 30 * u,
      scale: 1 - 0.3 * s,
      farS: s,
      w: HOOP_W * u,
      powerEff: this.cfg.power + 1.3 * s,
    }
  }

  private newBall(st: PState): Ball {
    const hot = st.streak >= FIRE_STREAK
    return {
      state: 'hold',
      t: 0,
      x: 0,
      y: 0,
      from: { x: 0, y: 0 },
      to: { x: 0, y: 0 },
      ctrl: { x: 0, y: 0 },
      arc: 0,
      result: 'short',
      hot,
      rot: 0,
      vx: 0,
      vy: 0,
    }
  }

  /** 出手瞬间结果判定 P()：力度差 d + 横向偏差 h → swish/in/bank/side/short/long（对齐站点） */
  private shoot(st: PState, body: import('@/core/types').Body, hoop: Hoop) {
    const ball = st.ball!
    const u = this.unit
    const handCx = ((body.lHand.x + body.rHand.x) / 2) * this.W
    const handCy = ((body.lHand.y + body.rHand.y) / 2) * this.H
    const shoulderCx = body.shoulderC.x * this.W
    const d = st.peak - hoop.powerEff
    const h = (handCx - shoulderCx) * 2.2 + handCx - hoop.x
    const m = (hoop.w * hoop.scale) / 2
    let result: ShotResult
    if (Math.abs(d) <= this.cfg.tol * 0.35 && Math.abs(h) < m * 0.4) result = 'swish'
    else if (Math.abs(d) <= this.cfg.tol && Math.abs(h) < m * 0.9) result = 'in'
    else if (d > this.cfg.tol && d <= this.cfg.tol + 0.9 && Math.abs(h) < m * 0.8) result = 'bank'
    else if (Math.abs(h) >= m * 0.9 && Math.abs(d) <= this.cfg.tol + 0.5) result = 'side'
    else if (d < 0) result = 'short'
    else result = 'long'

    st.shots++
    ball.state = 'fly'
    ball.t = 0
    ball.result = result
    ball.arc = Math.max(0.05, body.scale) * this.H * (0.35 + 0.14 * st.peak)
    ball.from = { x: handCx, y: handCy }
    const rimY = hoop.y
    const rimX = hoop.x
    if (result === 'swish' || result === 'in') ball.to = { x: rimX, y: rimY }
    else if (result === 'bank') ball.to = { x: rimX + Math.sign(h || 1) * m * 0.7, y: rimY - 16 * u }
    else if (result === 'side') ball.to = { x: rimX + Math.sign(h || 1) * m * 1.15, y: rimY + 10 * u }
    else if (result === 'short') ball.to = { x: rimX - Math.sign(hoop.x - handCx || 1) * m * 1.4, y: rimY + 120 * u }
    else ball.to = { x: rimX + (handCx < rimX ? -1 : 1) * m * 1.9, y: rimY - 40 * u }
    const midX = (ball.from.x + ball.to.x) / 2
    const midY = Math.min(ball.from.y, ball.to.y) - ball.arc
    ball.ctrl = { x: midX, y: midY }
    this.ctx.audio.slash() // 站点 whoosh
    this.ctx.audio.play('hit', 0.6, 1.4)
  }

  private tickBall(st: PState, pi: number, dt: number) {
    const ball = st.ball!
    const u = this.unit
    ball.t += dt
    if (ball.state === 'hold') {
      // 跟随双手中点
      const pv = this.players[pi]
      if (pv.body) {
        ball.x = ((pv.body.lHand.x + pv.body.rHand.x) / 2) * this.W
        ball.y = ((pv.body.lHand.y + pv.body.rHand.y) / 2) * this.H - 10
      }
      return
    }
    if (ball.state === 'fly') {
      const e = Math.min(1, ball.t / FLY_T)
      const a = 1 - e
      ball.x = a * a * ball.from.x + 2 * a * e * ball.ctrl.x + e * e * ball.to.x
      ball.y = a * a * ball.from.y + 2 * a * e * ball.ctrl.y + e * e * ball.to.y
      ball.rot += 7 * dt
      if (e >= 1) this.arrive(st, pi, ball)
      return
    }
    if (ball.state === 'through') {
      // 进球后穿网下落（重力 500u），网弹回
      ball.vy += GRAV_IN * u * dt
      ball.x += ball.vx * dt
      ball.y += ball.vy * dt
      ball.rot += 7 * dt
      if (ball.y > this.H + 60) st.ball = null
      return
    }
    if (ball.state === 'fall') {
      // 失手球弹开下落（重力 800u，long 砸回带反弹）
      ball.vy += GRAV_MISS * u * dt
      ball.x += ball.vx * dt
      ball.y += ball.vy * dt
      ball.rot += 5 * dt
      if (ball.y > this.H - 40 * u && ball.vy > 0) {
        if (ball.result === 'long' && Math.abs(ball.vy) > 200) {
          ball.vy = -Math.abs(ball.vy) * 0.45 // 太用力：砸回弹起
        } else {
          ball.vx *= 0.7
          ball.vy = 0
        }
      }
      if (ball.y > this.H + 60 || ball.x < -80 || ball.x > this.W + 80) st.ball = null
    }
  }

  /** 命中结算 F()：计分 + 连击/着火 + 反馈文案（对齐站点） */
  private arrive(st: PState, pi: number, ball: Ball) {
    const u = this.unit
    const hoop = this.hoopPos(pi)
    const r = ball.result
    const good = r === 'swish' || r === 'in' || r === 'bank'
    if (good) {
      const l = (r === 'swish' ? 3 : 2) + (ball.hot ? 1 : 0)
      this.score += l
      st.made++
      st.missN = 0
      st.streak++
      st.maxStreak = Math.max(st.maxStreak, st.streak)
      if (r === 'swish') {
        st.swishes++
        this.say('空心！+' + l, hoop.x, hoop.y - 30, '#ffd54a', 40)
        this.ctx.audio.good() // 站点 chime
        this.particles.burst(hoop.x, hoop.y, '#ffd54a', 10, 320 * u, 12 * u)
        this.particles.confetti(this.W, 20)
      } else {
        this.say(r === 'bank' ? '打板进 +' + l : '进了 +' + l, hoop.x, hoop.y - 30, '#3ddc97', 38)
        this.ctx.audio.coin()
        this.particles.burst(hoop.x, hoop.y, '#3ddc97', 6, 260 * u, 10 * u)
      }
      st.netE = 1
      // 着火横幅：首次到 3 → 着火了！；之后每 +3 → 连进 ×N！
      if (st.streak === FIRE_STREAK && !st.fireBanner) {
        st.fireBanner = true
        this.showBanner('着火了！', '连续进球，每球多 1 分', '#ff9f43', 1.4)
        this.ctx.audio.play('win', 0.8) // 站点 tada
      } else if (st.streak > FIRE_STREAK && (st.streak - FIRE_STREAK) % 3 === 0) {
        this.showBanner(`连进 ×${st.streak}！`, '', '#ff6b6b', 1.1)
        this.ctx.audio.combo()
      }
      st.timer = this.cfg.next * 0.8
      ball.state = 'through'
      ball.vx = 0
      ball.vy = 120
      ball.y = hoop.y + 10
    } else {
      st.streak = 0
      st.missN++
      if (st.fireBanner) {
        st.fireBanner = false
        this.showBanner('火灭了…', '', '#9aa7b5', 1)
      }
      if (r === 'long') {
        this.say('太用力了！', hoop.x, hoop.y + 60, '#ff6b6b', 36)
        this.ctx.audio.hit() // 站点 thud + 震屏
        this.shakeT = 0.35
        ball.vx = (ball.from.x < hoop.x ? -1 : 1) * 160
        ball.vy = -320
      } else if (r === 'short') {
        this.say('轻了，再用力！', hoop.x, hoop.y + 60, '#ff9f43', 36)
        this.ctx.audio.fail() // 站点 boing
        ball.vx = 0
        ball.vy = 0
      } else {
        this.say(hoop.x > ball.to.x ? '偏左了！' : '偏右了！', ball.to.x, hoop.y + 40, '#4cc9f0', 34)
        this.ctx.audio.fail()
        ball.vx = Math.sign(ball.to.x - hoop.x || 1) * 120
        ball.vy = -100
      }
      st.timer = this.cfg.next
      ball.state = 'fall'
    }
  }

  private shakeT = 0

  private showBanner(text: string, sub: string, color: string, sec: number) {
    this.bannerText = text
    this.bannerSub = sub
    this.bannerColor = color
    this.bannerT = sec
  }

  /** 玩家区域：单人 0.08~0.92，双人 P0 0.03~0.47 / P1 0.53~0.97 */
  private zone(pi: number) {
    const duo = this.players.filter((p) => p.body).length >= 2
    if (!duo) return { x0: this.W * 0.08, x1: this.W * 0.92 }
    return pi === 0 ? { x0: this.W * 0.03, x1: this.W * 0.47 } : { x0: this.W * 0.53, x1: this.W * 0.97 }
  }

  update(f: PoseFrame, dt: number) {
    this.shakeT = Math.max(0, this.shakeT - dt)
    super.update(f, dt)
  }

  paint(c: CanvasRenderingContext2D) {
    const u = this.unit
    const duo = this.players.filter((p) => p.body).length >= 2
    c.save()
    if (this.shakeT > 0) {
      const amp = 8 * (this.shakeT / 0.35)
      c.translate(Math.sin(this.t * 70) * amp, Math.cos(this.t * 63) * amp * 0.5)
    }

    for (let pi = 0; pi < 2; pi++) {
      if (pi === 1 && !duo) continue
      const st = this.ps[pi]
      const hoop = this.hoopPos(pi)
      const hw = hoop.w * hoop.scale
      const hot = st.streak >= FIRE_STREAK

      // 篮筐：板 + 筐 + 网（进球弹性 netE）
      const backW = hw * 1.5
      c.save()
      c.translate(hoop.x, hoop.y)
      if (hot) {
        c.shadowColor = '#ff9f43'
        c.shadowBlur = 26 * u
      }
      rr(c, -backW / 2, -74 * u * hoop.scale, backW, 52 * u * hoop.scale, 8 * u)
      c.fillStyle = '#f4a261'
      c.fill()
      c.strokeStyle = '#4a3b5c'
      c.lineWidth = 4 * u
      c.stroke()
      // 筐（横杆）
      c.beginPath()
      c.moveTo(-hw / 2, 0)
      c.lineTo(hw / 2, 0)
      c.strokeStyle = '#e63946'
      c.lineWidth = 9 * u
      c.lineCap = 'round'
      c.stroke()
      c.shadowBlur = 0
      // 网（弹性摆动）
      const sway = Math.sin(this.t * 22) * st.netE * 10 * u
      c.strokeStyle = 'rgba(255,255,255,.75)'
      c.lineWidth = 2 * u
      for (const k of [-1, -0.5, 0, 0.5, 1]) {
        c.beginPath()
        c.moveTo((k * hw) / 2, 0)
        c.quadraticCurveTo(k * hw * 0.32 + sway, 30 * u, k * hw * 0.22 + sway, 52 * u)
        c.stroke()
      }
      c.restore()
      if (hot) {
        emoji(c, '🔥', hoop.x - hw / 2 - 24 * u, hoop.y - 40 * u, 34 * u)
        emoji(c, '🔥', hoop.x + hw / 2 + 24 * u, hoop.y - 46 * u, 30 * u)
      }
      // 远/近标注（big 实时标注）
      if (this.cfg.far > 0) {
        txt(c, hoop.farS > 0.5 ? '远' : '近', hoop.x, hoop.y - 96 * u * hoop.scale, 22, 'rgba(255,255,255,.85)')
      }
      // 连进 ≥2 篮筐下显示
      if (st.streak >= 2) {
        outlineTxt(c, `${hot ? '🔥 ' : ''}连进 ${st.streak}`, hoop.x, hoop.y + 86 * u, 30 + Math.min(14, st.streak * 2), hot ? '#ff9f43' : '#fff')
      }

      // 球
      const ball = st.ball
      if (ball && ball.state !== 'dead') {
        c.save()
        c.translate(ball.x, ball.y)
        c.rotate(ball.rot)
        if (ball.hot && ball.state !== 'through') {
          c.shadowColor = '#ff9f43'
          c.shadowBlur = 22 * u
        }
        const br = 23 * u
        circle(c, 0, 0, br, '#e8722d')
        c.strokeStyle = '#4a3b5c'
        c.lineWidth = 2.5 * u
        c.stroke()
        c.beginPath()
        c.moveTo(-br, 0)
        c.lineTo(br, 0)
        c.moveTo(0, -br)
        c.lineTo(0, br)
        c.stroke()
        c.beginPath()
        c.arc(-br * 0.5, -br * 0.4, br * 0.4, 0.4, 2.4)
        c.arc(br * 0.5, br * 0.4, br * 0.4, 3.5, 5.5)
        c.stroke()
        c.restore()
      }

      // 力度条 UI：armed 时画在手上（白色槽 + 绿色目标区 + 玩家色峰值指针）
      const body = this.players[pi].body
      if (st.armed && body && ball?.state === 'hold') {
        const hx = ((body.lHand.x + body.rHand.x) / 2) * this.W
        const hy = ((body.lHand.y + body.rHand.y) / 2) * this.H
        const bw = 150 * u
        const bh = 12 * u
        const bx = hx - bw / 2
        const by = hy - 70 * u
        c.save()
        rr(c, bx, by, bw, bh, 6 * u)
        c.fillStyle = 'rgba(255,255,255,.85)'
        c.fill()
        // 绿色目标区 (power±tol)/8
        const z0 = Math.max(0, (this.cfg.power - this.cfg.tol) / 8)
        const z1 = Math.min(1, (this.cfg.power + this.cfg.tol) / 8)
        rr(c, bx + z0 * bw, by, (z1 - z0) * bw, bh, 4 * u)
        c.fillStyle = 'rgba(61,220,151,.9)'
        c.fill()
        // 峰值指针
        const pk = Math.min(1, st.peak / 8)
        circle(c, bx + pk * bw, by + bh / 2, bh * 0.9, this.players[pi].color)
        c.restore()
      }
    }
    c.restore()

    if (this.bannerT > 0) {
      c.globalAlpha = Math.min(1, this.bannerT / 0.3)
      outlineTxt(c, this.bannerText, this.W / 2, this.H * 0.3, 54, this.bannerColor)
      if (this.bannerSub) outlineTxt(c, this.bannerSub, this.W / 2, this.H * 0.3 + 54, 28, '#fff')
      c.globalAlpha = 1
    }
    txt(c, '双手举过头顶，用力往上快投！连进 3 球着火，每球多 1 分', this.W / 2, this.H - 28, 20, 'rgba(255,255,255,.85)', 'center', 'bold')
  }
}

export default function create(ctx: GameContext) {
  return new Hoops(ctx)
}
