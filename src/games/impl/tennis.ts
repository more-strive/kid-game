import { BaseGame } from '@/core/base'
import type { Game, GameContext, PoseFrame } from '@/core/types'
import { circle, glow, outlineTxt, txt } from '@/core/draw'

/**
 * 网球大战（对齐 dongdongpark 真实规则，报告 _reverse/reports/tennis.md）：
 * 球从对面飞过来（两段弹道：t1 落地弹起 + t2 到击球点，弧顶反解钳制在网顶上方防碰网），
 * 落到哪一边就用那边的手横着挥回去，挥速要过门槛，挥在甜点上又快又准；
 * 对手漏接才得 1 分。来回越多球越快（heat）。
 * 单人 vs 机器人对手（简单跟随 + 报告 miss 率参数 cpu），双人隔着中央网对打。
 */

/** 对齐站点难度表：玩家回球飞行/机器人回球飞行/横挥门槛(躯干/s)/判定延伸(×手半径)/甜点比/远程球率/击球高度窗/机器人回中率/机器人甜点率 */
const DIFF = [
  { flight: 2, ret: 1.25, minSpeed: 2, reach: 1.35, sweet: 0.5, far: 0.25, hLo: 0.3, hHi: 0.75, cpu: 0.42, cpuSweet: 0.22 },
  { flight: 1.65, ret: 1.1, minSpeed: 2.5, reach: 1.2, sweet: 0.45, far: 0.4, hLo: 0.15, hHi: 0.85, cpu: 0.5, cpuSweet: 0.28 },
  { flight: 1.35, ret: 0.95, minSpeed: 2.8, reach: 1.1, sweet: 0.4, far: 0.5, hLo: 0.05, hHi: 0.95, cpu: 0.66, cpuSweet: 0.4 },
]
const BALL_R = 22 // 球基础半径 px×unit
const SERVE_HOLD = 0.9 // 发球持球时长 s
const DEAD_T = 0.9 // 死球状态时长 s
const CPU_SWING = 0.24 // 机器人挥拍时长 s
const TRACK_T = 0.12 // 触碰后最小距离追踪窗 s
const HAND_R = 20 // 手半径 px×unit
const TOO_SLOW_CD = 2.5 // 慢挥提示冷却 s
const G1 = 1360 // 一段弹道重力（px/s²）
const G2 = 1700 // 二段弹道重力（px/s²，反解 vy2 用）
const NET_CLEAR = 8 // 过网余量 px×unit

interface Ball {
  state: 'serve' | 'fly' | 'hit' | 'dead'
  t: number
  t1: number
  t2: number
  x: number
  y: number
  /** 一段：起点/速度/落弹点 */
  sx: number
  sy: number
  vx1: number
  vy1: number
  bx: number
  /** 二段：初速（vx2 由 t2 反推）与击球点 */
  vy2: number
  vx2: number
  hx: number
  hy: number
  /** 飞向谁：0 玩家侧(或 P0) / 1 对面 */
  to: number
  isServe: boolean
  /** 机器人这拍会不会接（发球回接用 cpuSweet） */
  cpuWillHit: boolean
  /** 机器人挥空后球出界的额外时长 */
  overshoot: number
  /** 甜点球 */
  sweet: boolean
  /** 进入 hit 状态的时刻 */
  hitAt: number
}

interface TrailDot {
  x: number
  y: number
  life: number
  sweet: boolean
}

interface Racket {
  /** 机器人位置 / 目标 */
  x: number
  tx: number
  /** 挥拍动画剩余时长 */
  swingT: number
}

class Tennis extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  ball: Ball = this.newDead()
  trail: TrailDot[] = []
  robot: Racket = { x: 0, tx: 0, swingT: 0 }
  /** 发球方：单人机器人先发且一直发；双人轮换 */
  server = 1
  serveCount = 0
  serveT = 0
  rallyCur = 0
  bestRally = 0
  scores = [0, 0]
  returns = 0
  sweets = 0
  bannerT = 0
  bannerText = ''
  slowCd = 0

  private duo() {
    return this.players.filter((p) => p.body).length > 1
  }

  private newDead(): Ball {
    return {
      state: 'dead', t: 0, t1: 0, t2: 0, x: this.W / 2, y: this.H * 0.4,
      sx: 0, sy: 0, vx1: 0, vy1: 0, bx: 0, vy2: 0, vx2: 0, hx: 0, hy: 0,
      to: 0, isServe: false, cpuWillHit: false, overshoot: 0, sweet: false, hitAt: 0,
    }
  }

  /** 场地：地线/网/机器人位 */
  private court() {
    const U = this.H / 720
    const duo = this.duo()
    const ground = this.H - 56 * U
    const netX = duo ? this.W / 2 : this.W * 0.67
    const netTop = ground - this.H * 0.24
    const ceil = 130 * U
    const cpuHome = netX + (this.W - netX) * 0.55
    return { ground, netX, netTop, ceil, cpuHome, duo, U }
  }

  /** 连击热度：来回越多球越快（原站 env.heat 宿主维护，这里按来回数近似） */
  private heat() {
    return Math.min(1, Math.max(0, this.rallyCur - 2) * 0.15)
  }

  private torsoOf(pi: number) {
    const b = this.players[pi].body
    return b ? Math.max(60, Math.max(0.05, b.scale) * this.H) : this.H * 0.2
  }

  tick(f: PoseFrame, dt: number) {
    const ct = this.court()
    if (this.bannerT > 0) this.bannerT -= dt
    this.slowCd = Math.max(0, this.slowCd - dt)
    for (const d of this.trail) d.life -= dt
    this.trail = this.trail.filter((d) => d.life > 0)
    this.robot.swingT = Math.max(0, this.robot.swingT - dt)

    // ---- 发球流程 ----
    if (this.ball.state === 'dead') {
      this.serveT -= dt
      if (this.serveT <= 0) this.serve(ct)
    } else if (this.ball.state === 'serve') {
      this.ball.t += dt
      const srv = this.serverHome(ct)
      const k = this.ball.t / SERVE_HOLD
      this.ball.x = srv.x
      this.ball.y = srv.y + Math.sin(Math.min(1, k) * Math.PI * 0.8) * 14 * ct.U
      if (this.ball.t >= SERVE_HOLD) {
        this.launchServe(ct)
        this.ctx.audio.pop()
      }
    }

    if (this.ball.state === 'fly') this.stepFly(ct, dt)
    else if (this.ball.state === 'hit') this.stepHit(ct, dt)

    // ---- 玩家击球判定（球朝该玩家侧飞时） ----
    if (this.ball.state === 'fly') {
      if (this.ball.to === 0) this.tryPlayerHit(ct, dt, f, 0)
      if (ct.duo && this.ball.to === 1) this.tryPlayerHit(ct, dt, f, 1)
    }

    // ---- 机器人（单人）----
    if (!ct.duo) this.stepRobot(ct, dt)

    // 统计
    this.ctx.setScore(this.scores[0] + (ct.duo ? this.scores[1] : 0))
    this.ctx.setExtra('回球', this.returns)
    this.ctx.setExtra('甜点球', this.sweets)
    this.ctx.setExtra('最长来回', this.bestRally)
    if (!ct.duo) this.ctx.setExtra('比分', this.scores[0])
  }

  /** 发球方持球位（单人：机器人 home −0.78S、地面上方 1.9S；双人：发球玩家肩前） */
  private serverHome(ct: ReturnType<Tennis['court']>) {
    if (!ct.duo) {
      const S = this.H * 0.2
      return { x: ct.cpuHome - 0.78 * S, y: ct.ground - 1.9 * S }
    }
    const b = this.players[this.server].body
    const px = b ? b.shoulderC.x * this.W : this.server === 0 ? ct.netX * 0.45 : (ct.netX + this.W) / 2
    return { x: px, y: ct.ground - 1.2 * this.torsoOf(this.server) }
  }

  /** 持球 → 解算弹道并发射（发球飞行 ×0.8） */
  private serve(ct: ReturnType<Tennis['court']>) {
    const srv = this.serverHome(ct)
    const b = this.newDead()
    b.state = 'serve'
    b.x = srv.x
    b.y = srv.y
    b.sx = srv.x
    b.sy = srv.y
    b.to = this.server === 0 ? 1 : 0
    b.isServe = true
    this.serveCount++
    this.ball = b
  }

  private launchServe(ct: ReturnType<Tennis['court']>) {
    const b = this.ball
    if (!ct.duo) {
      // 单人机器人先发且一直发（对齐站点 server = +!O 后续机器人发）
      this.server = 1
      b.cpuWillHit = Math.random() < this.cfg.cpuSweet
    } else {
      // 双人轮换：下一次出球换边
      this.server = this.serveCount % 2
      b.cpuWillHit = false
    }
    this.buildFlight(ct, b, b.sx, b.sy, b.to, b.isServe)
    b.state = 'fly'
    b.t = 0
  }

  /**
   * 两段弹道解算：
   * 一段 t1：从 (sx,sy) 以重力 G1 恰好落在弹点 (bx, ground)，vy1 反解；
   * 二段：从 (bx, ground) 弹起，弧顶钳制在网顶上方（8 次迭代防碰网），t2 由落回击球点高度反解。
   */
  private buildFlight(ct: ReturnType<Tennis['court']>, b: Ball, sx: number, sy: number, to: number, serve: boolean) {
    const U = ct.U
    b.sx = sx
    b.sy = sy
    b.to = to
    // 落弹点与击球点在接球方场地
    const zoneL = to === 0 ? 40 * U : ct.netX + 20 * U
    const zoneR = to === 0 ? ct.netX - 20 * U : this.W - 40 * U
    const pick = (lo: number, hi: number) => lo + Math.random() * (hi - lo)
    const deep = Math.random() < this.cfg.far
    b.bx = deep ? pick(zoneR - (zoneR - zoneL) * 0.3, zoneR - 10 * U) : pick(zoneL + 10 * U, zoneL + (zoneR - zoneL) * 0.7)
    // 击球点：优先贴着接球方身体（远程球落深）
    const recvTorso = this.torsoOf(to)
    const recvBody = this.players[to].body
    let hx = recvBody
      ? recvBody.shoulderC.x * this.W + (Math.random() - 0.5) * recvTorso * 1.2
      : b.bx + (Math.random() - 0.5) * (zoneR - zoneL) * 0.25
    hx = Math.max(zoneL + BALL_R * U, Math.min(zoneR - BALL_R * U, hx))
    const hT = this.cfg.hLo + Math.random() * (this.cfg.hHi - this.cfg.hLo)
    b.hx = hx
    b.hy = ct.ground - hT * recvTorso
    // 飞行时长：球去对面(1)用玩家 flight，回玩家(0)用机器人 ret；heat 加速
    const heat = this.heat()
    let dur = (to === 1 ? this.cfg.flight : this.cfg.ret) * (0.9 + Math.random() * 0.2) * (serve ? 0.8 : 1)
    dur *= to === 1 ? 1 - 0.15 * heat : 1 - 0.1 * heat
    dur = Math.max(0.55, dur)
    b.t1 = dur * 0.55
    // 一段反解：vy1 使 y(t1) = ground
    b.vx1 = (b.bx - sx) / b.t1
    b.vy1 = (ct.ground - sy + 0.5 * G1 * b.t1 * b.t1) / b.t1
    // 二段反解：弧顶从网顶上方开始试，8 次迭代防碰网
    let wantApex = Math.max(ct.netTop - 36 * U, ct.ground - Math.max(hT * recvTorso + 30 * U, (ct.ground - ct.netTop) * 0.72))
    let t2 = 0
    for (let i = 0; i < 8; i++) {
      b.vy2 = -Math.sqrt(2 * G2 * Math.max(20, ct.ground - wantApex))
      t2 = this.solveT2(b, ct)
      b.vx2 = (hx - b.bx) / Math.max(0.2, t2)
      // 球过网时刻的高度（bx 与 hx 跨网时才有意义）
      const dir = Math.sign(hx - b.bx)
      const tNet = dir !== 0 ? (ct.netX - b.bx) / (b.vx2 || 1) : -1
      if (tNet <= 0 || tNet >= t2) break // 不跨网（同侧回球）→ 无碰网问题
      const yNet = ct.ground + b.vy2 * tNet - 0.5 * G2 * tNet * tNet
      if (yNet < ct.netTop - NET_CLEAR * U) break
      wantApex -= 26 * U // 弧顶抬高再试
      wantApex = Math.max(wantApex, ct.ceil + 20 * U)
    }
    b.t2 = Math.max(0.15, t2)
    b.overshoot = 0
    b.sweet = false
    if (!ct.duo && to === 1) {
      // 机器人这拍是否回击（miss 率参数 cpu）
      b.cpuWillHit = Math.random() < this.cfg.cpu
      b.overshoot = Math.random() < 0.5 ? 0.05 : 0.3
    }
  }

  /** 二段时长：由 vy2 与击球点高度反解（落回 hy 的正根） */
  private solveT2(b: Ball, ct: ReturnType<Tennis['court']>) {
    const disc = b.vy2 * b.vy2 - 2 * G2 * (b.hy - ct.ground)
    const root = Math.sqrt(Math.max(0, disc))
    return Math.max(0.15, (b.vy2 + root) / G2)
  }

  /** 飞行推进 */
  private stepFly(ct: ReturnType<Tennis['court']>, dt: number) {
    const b = this.ball
    b.t += dt
    if (b.t < b.t1) {
      // 一段：起点 → 落弹点
      b.x = b.sx + b.vx1 * b.t
      b.y = b.sy + b.vy1 * b.t - 0.5 * G1 * b.t * b.t
      if (b.y >= ct.ground || b.t >= b.t1) {
        b.t = b.t1
        b.x = b.bx
        b.y = ct.ground
        this.ctx.audio.tick()
        this.particles.burst(b.bx, ct.ground, '#ffffff', 4, 140, 3)
      }
    } else {
      // 二段：弹起 → 击球点
      const tt = b.t - b.t1
      b.x = b.bx + b.vx2 * tt
      b.y = ct.ground + b.vy2 * tt - 0.5 * G2 * tt * tt
      if (tt > b.t2 + b.overshoot) {
        // 机器人成功回击：触球改走 hit 追踪；否则飞完 → 结算
        if (!ct.duo && b.to === 1 && b.cpuWillHit) {
          b.state = 'hit'
          b.hitAt = b.t
          b.hx = b.x
          b.hy = b.y
          b.sweet = Math.random() < this.cfg.cpuSweet
          this.robot.swingT = CPU_SWING
          this.ctx.audio.play('hit', 0.8, 1.05)
        } else {
          this.ballDone(ct, b)
          return
        }
      }
    }
    // 拖尾
    this.trail.push({ x: b.x, y: b.y, life: 0.25, sweet: b.sweet })
    if (this.trail.length > 28) this.trail.shift()
  }

  /** hit 状态：TRACK_T 追踪窗结束后回击 */
  private stepHit(ct: ReturnType<Tennis['court']>, dt: number) {
    const b = this.ball
    b.t += dt
    if (b.t >= b.hitAt + TRACK_T) {
      this.returnBall(ct, b)
    }
  }

  /** 玩家击球判定：手够近 + 横挥速度过门槛；碰后进 hit 追踪窗（甜点在触碰瞬间判定） */
  private tryPlayerHit(ct: ReturnType<Tennis['court']>, dt: number, f: PoseFrame, pi: number) {
    const b = this.ball
    const body = f.bodies[pi]
    if (!body) return
    const U = ct.U
    const torso = this.torsoOf(pi)
    const judge = BALL_R * U + HAND_R * U * this.cfg.reach
    const hands = [
      { c: this.players[pi].lHand, p: body.lHand },
      { c: this.players[pi].rHand, p: body.rHand },
    ]
    for (const h of hands) {
      const hx = h.p.x * this.W
      const hy = h.p.y * this.H
      const d = Math.hypot(hx - b.x, hy - b.y)
      if (d > judge) continue
      // 横挥速度（轨迹末两点 → 归一化/s → 躯干/s）
      let vxn = 0
      if (h.c.trail.length >= 2) {
        const a = h.c.trail[h.c.trail.length - 2]
        const z = h.c.trail[h.c.trail.length - 1]
        vxn = Math.abs(z.x - a.x) / Math.max(0.001, dt) / Math.max(0.05, torso / this.H)
      }
      if (vxn < this.cfg.minSpeed) {
        // 不够快只记 tooSlow（2.5s 冷却提示）
        if (this.slowCd <= 0) {
          this.slowCd = TOO_SLOW_CD
          this.say('横着挥，快一点！', hx, hy - 60, '#9ad0ff', 34)
          this.ctx.audio.play('hit', 0.3, 0.6)
        }
        continue
      }
      // 碰到：进入 0.12s 最小距离追踪
      b.state = 'hit'
      b.hitAt = b.t
      b.sweet = d < judge * this.cfg.sweet
      b.to = pi
      b.hx = b.x
      b.hy = b.y
      b.overshoot = 0
      this.returns++
      this.ctx.audio.play('hit', 0.8, 1.1)
      this.particles.burst(b.x, b.y, '#ffffff', 6, 220, 4)
      return
    }
  }

  /** 回击：换向并解算新弹道；甜点出金星特效 */
  private returnBall(ct: ReturnType<Tennis['court']>, b: Ball) {
    const pi = b.to
    const opp = pi === 0 ? 1 : 0
    this.rallyCur++
    this.bestRally = Math.max(this.bestRally, this.rallyCur)
    const nb = this.newDead()
    nb.state = 'fly'
    nb.t = 0
    nb.to = opp
    nb.isServe = false
    this.buildFlight(ct, nb, b.x, b.y, opp, false)
    if (!ct.duo && opp === 1) {
      this.robot.tx = nb.hx + 0.62 * this.H * 0.2
    }
    if (b.sweet) {
      this.sweets++
      this.say('甜点！', b.x, b.y - 46, '#ffd54a', 40)
      this.ctx.audio.slash()
      this.particles.burst(b.x, b.y, '#ffd54a', 10, 300, 4)
    }
    this.ball = nb
  }

  /** 球飞完无人接 → 得分结算 */
  private ballDone(ct: ReturnType<Tennis['court']>, b: Ball) {
    const loser = b.to
    const winner = 1 - loser
    this.scores[winner]++
    if (loser === 0) {
      // 玩家侧漏接
      this.say('没接到', b.x, Math.min(b.y, this.H * 0.7), '#ff9db1', 40)
      this.ctx.audio.fail()
    } else {
      // 对面漏接 → 玩家得分 +1（confetti×18 + coin）
      this.say('得分 +1', this.W * (ct.duo ? (winner === 0 ? 0.25 : 0.75) : 0.4), this.H * 0.3, '#ffd54a', 44)
      this.particles.confetti(this.W, 18)
      this.ctx.audio.coin()
    }
    if (this.rallyCur >= 2) {
      const col = this.rallyCur >= 6 ? '#ff9d45' : '#9ad0ff'
      this.say(`来回 ${this.rallyCur}`, this.W / 2, this.H * 0.2, col, 30)
    }
    this.rallyCur = 0
    this.bannerText = `比分 ${this.scores[0]} : ${this.scores[1]}`
    this.bannerT = 1
    // 下一球：单人机器人发；双人胜方发球
    if (!ct.duo) this.server = 1
    else this.server = winner
    this.ball = this.newDead()
    this.serveT = DEAD_T
  }

  /** 机器人：简单跟随击球点（τ=6 平滑）+ 时机挥拍（弹道总时长 −0.12s） */
  private stepRobot(ct: ReturnType<Tennis['court']>, dt: number) {
    const rk = this.robot
    const b = this.ball
    const S = this.H * 0.2
    if (b.state === 'fly' && b.to === 1) {
      rk.tx = b.hx + 0.62 * S
    } else {
      rk.tx = ct.cpuHome
    }
    if (rk.x === 0) rk.x = ct.cpuHome
    rk.x += (rk.tx - rk.x) * Math.min(1, dt * 6)
    // 挥拍时机 = 弹道总时长 − 0.12 s
    if (b.state === 'fly' && b.to === 1 && b.t >= b.t1 + b.t2 - 0.12 && rk.swingT <= 0) {
      rk.swingT = CPU_SWING
      if (!b.cpuWillHit) {
        // 挥空：球继续飞（overshoot 已在解算时掷骰）
        b.overshoot = Math.max(b.overshoot, 0.12)
        this.ctx.audio.play('hit', 0.4, 0.7)
      }
    }
  }

  paint(c: CanvasRenderingContext2D) {
    const ct = this.court()
    const U = ct.U
    const b = this.ball
    // 地面分色（玩家色 28% alpha）+ 地线 + 边线
    c.save()
    c.globalAlpha = 0.28
    c.fillStyle = this.players[0].color
    c.fillRect(0, ct.ground, ct.duo ? ct.netX : ct.netX, this.H - ct.ground)
    if (ct.duo) {
      c.fillStyle = this.players[1].color
      c.fillRect(ct.netX, ct.ground, this.W - ct.netX, this.H - ct.ground)
    }
    c.restore()
    c.fillStyle = 'rgba(255,255,255,.85)'
    c.fillRect(0, ct.ground, this.W, 4 * U)
    c.fillStyle = 'rgba(255,255,255,.35)'
    c.fillRect(30 * U, ct.ground, 3 * U, this.H - ct.ground)
    c.fillRect(this.W - 33 * U, ct.ground, 3 * U, this.H - ct.ground)

    // 网（网柱 + 网带 + 网格）
    c.save()
    c.strokeStyle = '#e8ecf7'
    c.lineWidth = 8 * U
    c.beginPath()
    c.moveTo(ct.netX, ct.ground)
    c.lineTo(ct.netX, ct.netTop)
    c.stroke()
    c.lineWidth = 10 * U
    c.beginPath()
    c.moveTo(ct.netX - 26 * U, ct.netTop + 6 * U)
    c.lineTo(ct.netX + 26 * U, ct.netTop + 6 * U)
    c.stroke()
    c.globalAlpha = 0.3
    c.lineWidth = 1.5
    for (let y = ct.netTop + 14 * U; y < ct.ground; y += 16 * U) {
      c.beginPath()
      c.moveTo(ct.netX - 24 * U, y)
      c.lineTo(ct.netX + 24 * U, y)
      c.stroke()
    }
    c.restore()

    // 落点预告：玩家侧来球画虚线落点圈（hard 未过网不显示）
    if (b.state === 'fly' && b.to === 0) {
      const crossed = b.x >= ct.netX - 4
      if (!(this.ctx.difficulty === 2 && !crossed)) {
        const torso = this.torsoOf(0)
        const rr = Math.max(BALL_R * U * 1.6, torso * 0.36)
        c.save()
        c.globalAlpha = 0.3 + Math.sin(this.t * 6) * 0.12
        circle(c, b.bx, ct.ground, rr, this.players[0].color)
        c.globalAlpha = 0.9
        c.setLineDash([10, 8])
        c.lineWidth = 3
        c.strokeStyle = '#fff'
        c.beginPath()
        c.arc(b.bx, ct.ground, rr * (1 + Math.sin(this.t * 6) * 0.06), 0, Math.PI * 2)
        c.stroke()
        c.restore()
      }
    }

    // 拖尾（甜点金 / 普通白 7 帧）
    for (const d of this.trail) {
      c.save()
      c.globalAlpha = Math.max(0, d.life / 0.25) * 0.55
      circle(c, d.x, d.y, (d.sweet ? 7 : 5) * U, d.sweet ? '#ffd54a' : '#ffffff')
      c.restore()
    }

    // 球影子 + 球
    if (b.state !== 'dead') {
      const hgt = Math.max(0, Math.min(1, 1 - (ct.ground - b.y) / this.H))
      c.save()
      c.globalAlpha = 0.2
      c.beginPath()
      c.ellipse(b.x, ct.ground + 6 * U, BALL_R * U * (0.5 + 0.7 * hgt), BALL_R * U * 0.3, 0, 0, Math.PI * 2)
      c.fillStyle = '#000'
      c.fill()
      c.restore()
      glow(c, b.x, b.y, BALL_R * U * 2, '#d9ff6b', 0.25)
      circle(c, b.x, b.y, BALL_R * U, b.sweet ? '#ffe27a' : '#d9f26b')
      c.strokeStyle = 'rgba(255,255,255,.85)'
      c.lineWidth = 2.5
      c.beginPath()
      c.arc(b.x, b.y, BALL_R * U * 0.62, 0.6, 3.6)
      c.stroke()
    }

    // 机器人对手（单人）
    if (!ct.duo) this.paintRobot(c, ct)

    // 比分 / 来回
    if (!ct.duo) {
      outlineTxt(c, `比分 ${this.scores[0]} : ${this.scores[1]}`, this.W * 0.18, 60, 34, '#fff')
    } else {
      outlineTxt(c, `${this.scores[0]} : ${this.scores[1]}`, this.W / 2, 60, 40, '#fff')
    }
    if (this.rallyCur >= 2) {
      outlineTxt(c, `来回 ${this.rallyCur}`, this.W / 2, 108, 30, this.rallyCur >= 6 ? '#ff9d45' : '#9ad0ff')
    }
    if (this.bannerT > 0 && this.bannerText && ct.duo) {
      c.globalAlpha = Math.min(1, this.bannerT / 0.3)
      outlineTxt(c, this.bannerText, this.W / 2, this.H * 0.16, 36, '#ffe27a')
      c.globalAlpha = 1
    }
    txt(c, '球到哪边，就用那边的手横着挥过去；挥在甜点上又快又准', this.W / 2, this.H - 30, 20, 'rgba(255,255,255,.85)', 'center', 'bold')
  }

  /** 机器人小人：持拍手臂两段 IK 绘制 + 挥拍动画（happy/dizzy/big 表情省略为单表情） */
  private paintRobot(c: CanvasRenderingContext2D, ct: ReturnType<Tennis['court']>) {
    const U = ct.U
    const rk = this.robot
    const S = this.H * 0.2
    const x = rk.x
    const ground = ct.ground
    c.save()
    c.strokeStyle = '#8f9bb8'
    c.lineWidth = 9 * U
    c.lineCap = 'round'
    // 腿
    c.beginPath()
    c.moveTo(x, ground - S * 0.42)
    c.lineTo(x - S * 0.18, ground)
    c.moveTo(x, ground - S * 0.42)
    c.lineTo(x + S * 0.18, ground)
    c.stroke()
    // 躯干
    c.beginPath()
    c.moveTo(x, ground - S * 0.42)
    c.lineTo(x, ground - S * 0.95)
    c.stroke()
    // 持拍手臂：两段近似，挥拍时摆到身前（挥动残影）
    const swing = rk.swingT > 0 ? Math.sin((1 - rk.swingT / CPU_SWING) * Math.PI) : 0
    const shX = x + S * 0.3
    const shY = ground - S * 0.9
    const elX = shX + S * 0.28 + swing * S * 0.2
    const elY = shY + S * 0.24 - swing * S * 0.28
    const raX = elX + S * 0.24 + swing * S * 0.34
    const raY = elY + S * 0.1 - swing * S * 0.3
    c.lineWidth = 7 * U
    c.beginPath()
    c.moveTo(shX, shY)
    c.lineTo(elX, elY)
    c.lineTo(raX, raY)
    c.stroke()
    if (rk.swingT > 0 && rk.swingT < CPU_SWING * 0.6) {
      c.save()
      c.globalAlpha = 0.35
      c.strokeStyle = '#fff'
      c.lineWidth = 5
      c.beginPath()
      c.moveTo(raX - S * 0.2, raY + S * 0.1)
      c.lineTo(raX + S * 0.1, raY - S * 0.16)
      c.stroke()
      c.restore()
    }
    // 球拍
    c.save()
    c.translate(raX, raY)
    c.rotate(-0.5 + swing * 1.1)
    c.strokeStyle = '#3a4668'
    c.lineWidth = 5 * U
    c.beginPath()
    c.moveTo(0, 0)
    c.lineTo(S * 0.34, -S * 0.1)
    c.stroke()
    c.beginPath()
    c.ellipse(S * 0.42, -S * 0.13, S * 0.17, S * 0.22, -0.4, 0, Math.PI * 2)
    c.fillStyle = 'rgba(255,255,255,.85)'
    c.fill()
    c.strokeStyle = '#3a4668'
    c.stroke()
    c.restore()
    // 头 + 表情
    const hy = ground - S * 1.12
    circle(c, x, hy, S * 0.26, '#ffd9b3')
    c.font = `${Math.round(S * 0.3)}px sans-serif`
    c.textAlign = 'center'
    c.textBaseline = 'middle'
    c.fillText('🙂', x, hy - 1)
    c.restore()
  }
}

export default function create(ctx: GameContext) {
  return new Tennis(ctx)
}
