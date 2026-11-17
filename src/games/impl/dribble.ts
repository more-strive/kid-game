import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, outlineTxt, rr, txt } from '@/core/draw'

/**
 * 运球闯关 / dribble（对齐 dongdongpark 真实规则）：
 * 腰线以下快速下拍 = 一次运球 = 前进 0.9 米；每拍一次 +1 分；扑防结算时必须「还在运球」且
 * 往防守者反方向侧移才算闪开（+2）；满 18 步双手举过头投篮（必进 +5）；被抢断退回检查点。
 *
 * 全部字面量沿用站点难度表：period 运球周期（×(1−0.12×heat)）、open 上行再拍门槛、late 超时宽限、
 * hitSpeed 下拍最小速度（躯干/秒）、waist 腰线（髋上方 waist×躯干）、defs 每轮防守数（第 3 轮起 +1 上限 4）、
 * lunge 扑防耗时（×(1−0.2×heat)）、dodge 反向侧移阈值；
 * 常量：一步 0.9 米、检查点 6/12 步、篮筐 19.2 米/3.05 米高/半径 0.72、下拍 0.4×period×√高度、
 * 上行 0.6×period、拍球事件有效期 0.14 秒、失球 0.9 秒自动回手、被抢 0.8 秒退检查点 + 1.7 秒恢复、
 * 投篮飞行 0.85 秒 + 2 秒后下一轮、轮切 0.6 秒。
 *
 * 与站点的差异（写明待实测）：
 * 1) heat：本框架 ctx.heat = 局内时长线性 0→1（core/engine.ts），站点为宿主黑盒；
 * 2) 站点 events.has('handsUp') 本框架没有 → 投篮触发用「双手都高于肩上 0.4×躯干」电平（aim 一次性）；
 * 3) motion.shift 黑盒 → 「髋部横向速度 ÷ 躯干 ÷1.6」代理（与 forest-run 同款），dodge 阈值需真机校准；
 * 4) 站点投篮命中是「必然进」（无打铁判定），照抄；精灵贴图全部几何图形绘制；
 * 5) 双人共享一个分数（仓库口径），站点各自计分。
 */
interface Zone {
  cx: number
  w: number
  f: number
  hy: number
}

interface Defender {
  at: number // 触发步数
  side: number // −1 左 1 右
  state: 'wait' | 'lunge' | 'beaten' | 'gone'
  t0: number
  z0: number
}

interface Ball {
  state: 'hold' | 'down' | 'up' | 'gone' | 'drop'
  elapsed: number
  dur: number
  dropAt: number
  startH: number // 下拍起始高度（0~1，球高/躯干）
}

interface Baller {
  mode: 'run' | 'aim' | 'shot' | 'rest' | 'stolen'
  modeAt: number
  steps: number
  cp: number // 已过检查点数（0/1/2）
  s: number // 平滑后的前进米数
  x: number // 横向（shift 平滑）
  streak: number
  maxStreak: number
  streakMark: number // 已庆祝过的连击阈值
  dodges: number
  shots: number
  steals: number
  lap: number
  patAt: [number, number]
  on: [boolean, boolean]
  used: [boolean, boolean]
  prevHandY: [number, number]
  prevX: number
  ball: Ball
  defs: Defender[]
  shot: { t0: number; scored: boolean } | null
  stolenAt: number
  stepsRolled: boolean
  body: Body | null
  zone: Zone
}

/** 站点三档：period/open/late/hitSpeed/waist/defs/lunge/dodge */
const DIFF = [
  { period: 0.95, open: 0.45, late: 0.5, hitSpeed: 1.2, waist: 0.5, defs: 2, lunge: 2, dodge: 0.45 },
  { period: 0.8, open: 0.55, late: 0.4, hitSpeed: 1.4, waist: 0.35, defs: 3, lunge: 1.6, dodge: 0.6 },
  { period: 0.68, open: 0.6, late: 0.32, hitSpeed: 1.5, waist: 0.25, defs: 4, lunge: 1.25, dodge: 0.6 },
]

const STEP = 0.9 // 一步（米）
const CKPT = [0, 6, 12] // 检查点步数
const GOAL = 18 // 到篮下的步数
const HOOP_Z = 19.2 // 篮筐距离（米）
const RIM_H = 3.05
const RIM_R = 0.72
const BOARD_Z = 20.775
const FT_Z = 14.975
const HALF_W = 7.5
const NEAR = 4 // 投影近平面偏移（站点 z+4）
const HOLD_OFF = 0.44 // 持球横向偏移（米）
const DEF_HOME = 3.6 // 防守者待机纵深（前方米数基准）
const SHOT_T = 0.85 // 投篮飞行（秒）
const REST = 2 // 出手后停留（秒）
const SWITCH = 0.6 // 轮次切换动画（秒）
const STOLEN_T = 1.7 // 被抢恢复（秒）
const DOWN_K = 0.4 // 下拍时长系数
const UP_K = 0.6 // 上行时长系数
const REHOLD = 0.9 // 失球后回手等待（秒）
const PAT_WIN = 0.14 // 拍球事件有效期（秒）
const HOLD_H = 0.85 // 持球高度（×躯干）

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)

/** rr 只描路径，这里补一个带填充的版本 */
function rrf(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, fill: string) {
  rr(c, x, y, w, h, r)
  c.fillStyle = fill
  c.fill()
}

function shiftOf(b: Body, prevX: number, dt: number) {
  const Tn = Math.max(0.1, b.scale)
  return clamp((((b.hipC.x - prevX) / Math.max(dt, 1e-3)) / Tn) / 1.6, -1, 1)
}

function armLiftOf(b: Body) {
  const t = Math.max(0.08, b.scale)
  const handY = (b.lHand.y + b.rHand.y) / 2
  return clamp(((b.shoulderC.y - handY) / t) * 1.3, -1, 1)
}

class Dribble extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[0]
  ballers: Baller[] = []
  seats = 1

  constructor(ctx: GameContext) {
    super(ctx)
    for (let i = 0; i < 2; i++) {
      this.ballers.push({
        mode: 'run', modeAt: 0, steps: 0, cp: 0, s: 0, x: 0,
        streak: 0, maxStreak: 0, streakMark: 0, dodges: 0, shots: 0, steals: 0, lap: 0,
        patAt: [-9, -9], on: [false, false], used: [false, false], prevHandY: [0.6, 0.6], prevX: 0.5,
        ball: { state: 'hold', elapsed: 0, dur: 1, dropAt: 0, startH: HOLD_H },
        defs: [], shot: null, stolenAt: 0, stepsRolled: false, body: null,
        zone: { cx: this.W / 2, w: this.W, f: 0, hy: 0 },
      })
      this.spawnDefs(this.ballers[i])
    }
    this.layout()
  }

  private layout() {
    const n = this.seats
    for (let i = 0; i < 2; i++) {
      const z = this.ballers[i].zone
      z.w = this.W / n
      z.cx = z.w * i + z.w / 2
      z.f = Math.min(this.H * 0.9, z.w * 0.82)
      z.hy = this.H - 70 * (Math.min(this.W, this.H) / 720) - z.f / 2
    }
  }

  /** 投影 A：scale = f/(z+4)，相机高 2 米 */
  private proj(z: Zone, xM: number, depth: number, r: number) {
    if (depth + NEAR < 0.3) return null
    const sc = z.f / (depth + NEAR)
    return { x: z.cx + xM * sc, y: z.hy + (2 - r) * sc, sc }
  }

  private spawnDefs(p: Baller) {
    p.defs = []
    const n = Math.min(4, this.cfg.defs + (p.lap >= 2 ? 1 : 0))
    for (let i = 0; i < n; i++) {
      p.defs.push({
        at: Math.round(2 + i * (14 / n) + Math.random() * Math.max(0, 14 / n - 2)),
        side: Math.random() < 0.5 ? -1 : 1,
        state: 'wait', t0: 0, z0: 0,
      })
    }
  }

  tick(f: PoseFrame, dt: number) {
    if (this.seats === 1 && f.bodies[1]) {
      this.seats = 2
      this.layout()
    }
    for (let i = 0; i < 2; i++) {
      const p = this.ballers[i]
      const b = f.bodies[i] ?? null
      p.body = b
      if (!b) continue
      this.step(p, b, dt)
      this.ctx.setExtra(`streak${i}`, p.maxStreak)
      this.ctx.setExtra(`dodges${i}`, p.dodges)
      this.ctx.setExtra(`shots${i}`, p.shots)
      this.ctx.setExtra(`steals${i}`, p.steals)
    }
  }

  private step(p: Baller, b: Body, dt: number) {
    const now = this.t
    const Tn = Math.max(0.1, b.scale)
    const heat = this.ctx.heat
    const period = this.cfg.period * (1 - 0.12 * heat)

    // —— 拍球检测（两手独立）：只有腰线以下起的下拍才记 patAt（腰下门槛的实现口径）——
    const hands = [b.lHand, b.rHand]
    const shift = shiftOf(b, p.prevX, dt)
    p.prevX = b.hipC.x
    for (let h = 0; h < 2; h++) {
      const vy = (hands[h].y - p.prevHandY[h]) / Math.max(dt, 1e-3) // 归一化/秒
      p.prevHandY[h] = hands[h].y
      const r = vy / Tn // 躯干/秒
      if (r > this.cfg.hitSpeed) {
        p.on[h] = true
        // 腰线 = 髋上方 waist×躯干（屏幕 y 向下，手在腰线下 = y 更大）
        const belowWaist = hands[h].y > b.hipC.y - this.cfg.waist * Tn
        if (!p.used[h] && belowWaist) p.patAt[h] = now
      }
      if (p.on[h] && r < 0.4) {
        p.on[h] = false
        p.used[h] = false
      }
    }
    // —— 有效拍球 ——
    const canTap =
      p.mode === 'run' && p.steps < GOAL &&
      (p.ball.state === 'hold' || (p.ball.state === 'up' && p.ball.elapsed >= p.ball.dur * this.cfg.open))
    if (canTap) {
      for (let h = 0; h < 2; h++) {
        if (now - p.patAt[h] > PAT_WIN || p.used[h]) continue
        p.used[h] = true
        p.steps = Math.min(GOAL, p.steps + 1)
        p.streak++
        p.maxStreak = Math.max(p.maxStreak, p.streak)
        this.ctx.addScore(1)
        this.ctx.audio.play('pop', 0.35, 0.8)
        const startH = p.ball.state === 'hold' ? HOLD_H : Math.max(0.2, p.ball.startH)
        p.ball = { state: 'down', elapsed: 0, dur: period * DOWN_K * Math.sqrt(startH), dropAt: 0, startH }
        // 检查点
        if (p.steps === CKPT[1] && p.cp === 0) {
          p.cp = 1
          this.ctx.audio.coin()
          this.say('检查点 ✓', b.center.x * this.W, b.head.y * this.H - 60, '#9be15d', 32)
        } else if (p.steps === CKPT[2] && p.cp === 1) {
          p.cp = 2
          this.ctx.audio.coin()
          this.say('检查点 ✓', b.center.x * this.W, b.head.y * this.H - 60, '#9be15d', 32)
        }
        if (p.streak >= p.streakMark + 10) {
          p.streakMark = Math.floor(p.streak / 10) * 10
          this.ctx.audio.play('combo', 0.7)
          this.say(`连续运球 ${p.streak}！`, p.zone.cx, this.H * 0.2, '#ffb24d', 40)
        }
        break
      }
    }
    // —— 球相位 ——
    const ball = p.ball
    if (ball.state === 'down') {
      ball.elapsed += dt
      if (ball.elapsed >= ball.dur) {
        p.ball = { state: 'up', elapsed: 0, dur: period * UP_K, dropAt: 0, startH: 0 }
        this.ctx.audio.play('pop', 0.15, 1.3)
      }
    } else if (ball.state === 'up') {
      ball.elapsed += dt
      if (ball.elapsed > ball.dur + this.cfg.late) {
        p.ball = { state: 'drop', elapsed: 0, dur: 0, dropAt: now, startH: 0 }
        p.streak = 0
        p.streakMark = 0
        this.ctx.audio.play('click', 0.5, 0.6)
        if (p.mode === 'run') this.say('运球停了', b.center.x * this.W, b.head.y * this.H - 40, '#c9c9e0', 30)
      }
    } else if (ball.state === 'drop') {
      if (now - ball.dropAt >= REHOLD) p.ball = { state: 'hold', elapsed: 0, dur: 1, dropAt: 0, startH: HOLD_H }
    }

    // —— 位移 ——
    p.x += (clamp(shift, -1, 1) - p.x) * (1 - Math.exp(-dt * 10))
    p.s += (p.steps * STEP - p.s) * (1 - Math.exp(-dt * (p.mode === 'stolen' ? 7 : 6)))

    // —— 投篮 ——
    if (p.mode === 'run' && p.steps >= GOAL && p.ball.state === 'up' && p.ball.elapsed >= p.ball.dur) {
      p.mode = 'aim'
      p.modeAt = now
      this.say('投篮！双手举过头', p.zone.cx, this.H * 0.22, '#ffd54a', 42)
      this.ctx.speak('双手举高，投篮！')
    }
    const handsUp =
      b.lHand.y < b.shoulderC.y - 0.4 * Tn && b.rHand.y < b.shoulderC.y - 0.4 * Tn
    if (p.mode === 'aim' && now - p.modeAt > 0.25 && (armLiftOf(b) > 0.55 || handsUp)) {
      p.mode = 'shot'
      p.modeAt = now
      p.shot = { t0: now, scored: false }
      p.ball = { state: 'gone', elapsed: 0, dur: 0, dropAt: 0, startH: 0 }
      this.ctx.audio.play('click', 0.6, 1.3)
    }
    if (p.mode === 'shot' && p.shot) {
      const tt = now - p.shot.t0
      if (tt >= SHOT_T && !p.shot.scored) {
        p.shot.scored = true
        p.shots++
        this.ctx.addScore(5)
        this.ctx.audio.play('fanfare', 0.7)
        const hp = this.proj(p.zone, 0, HOOP_Z, RIM_H)
        if (hp) {
          this.say('空心 +5', hp.x, hp.y - 40, '#ffd54a', 44)
          this.particles.burst(hp.x, hp.y, '#ffb24d', 14, 320, 5)
        }
      }
      if (tt >= SHOT_T + REST) {
        p.lap++
        p.steps = 0
        p.cp = 0
        p.x = 0
        this.spawnDefs(p)
        p.ball = { state: 'hold', elapsed: 0, dur: 1, dropAt: 0, startH: HOLD_H }
        p.mode = 'rest'
        p.modeAt = now
        p.shot = null
        this.say(`第 ${p.lap + 1} 轮`, p.zone.cx, this.H * 0.22, '#ffffff', 40)
      }
    }
    if (p.mode === 'rest' && now - p.modeAt >= SWITCH) p.mode = 'run'

    // —— 防守扑抢 ——
    const lunging = p.defs.some((d) => d.state === 'lunge')
    if (!lunging && p.mode === 'run' && p.ball.state !== 'hold') {
      const d = p.defs.find((d2) => d2.state === 'wait' && p.steps >= d2.at)
      if (d) {
        d.state = 'lunge'
        d.t0 = now
        d.z0 = clamp(d.at * STEP + DEF_HOME - p.s, 2.2, 6)
        this.ctx.audio.play('tick', 0.9, 1.4)
        this.say(d.side < 0 ? '往右闪！' : '往左闪！', b.center.x * this.W, b.head.y * this.H - 80, '#ff8fa8', 36)
      }
    }
    for (const d of p.defs) {
      if (d.state !== 'lunge') continue
      if (now - d.t0 < this.cfg.lunge * (1 - 0.2 * heat)) continue
      // 结算（shift 用本帧开始时算好的值）
      if (p.mode !== 'run') {
        d.state = 'beaten'
      } else if ((p.ball.state === 'down' || p.ball.state === 'up') && shift * -d.side > this.cfg.dodge) {
        d.state = 'beaten'
        p.dodges++
        this.ctx.addScore(2)
        this.ctx.audio.play('pop', 0.7, 1.2)
        this.say('闪开 +2', b.center.x * this.W, b.head.y * this.H - 60, '#9be15d', 38)
        this.particles.burst(b.center.x * this.W, b.center.y * this.H, '#9be15d', 8, 240, 4)
      } else {
        d.state = 'gone'
        const wasIdle = p.ball.state === 'hold' // 停球被抢 → 提示「别停下运球」
        p.mode = 'stolen'
        p.modeAt = now
        p.stolenAt = now
        p.stepsRolled = false
        p.ball = { state: 'gone', elapsed: 0, dur: 0, dropAt: 0, startH: 0 }
        p.streak = 0
        p.streakMark = 0
        p.steals++
        this.ctx.audio.fail()
        this.say('球被抢了！', p.zone.cx, this.H * 0.24, '#ff6b8a', 44)
        this.say(wasIdle ? '别停下运球' : '往另一边闪开', p.zone.cx, this.H * 0.24 + 46, '#ffffffcc', 28)
      }
    }
    if (p.mode === 'stolen') {
      if (!p.stepsRolled && now - p.stolenAt >= 0.8) {
        p.steps = CKPT[p.cp]
        p.stepsRolled = true
      }
      if (now - p.modeAt >= STOLEN_T) {
        for (const d of p.defs) if (d.state !== 'beaten') d.state = 'beaten'
        p.mode = 'run'
        p.ball = { state: 'hold', elapsed: 0, dur: 1, dropAt: 0, startH: HOLD_H }
      }
    }
  }

  paint(c: CanvasRenderingContext2D) {
    const n = this.seats
    for (let i = 0; i < 2; i++) {
      const p = this.ballers[i]
      const z = p.zone
      const x0 = z.cx - z.w / 2
      if (n === 1 && i === 1) continue
      c.save()
      c.beginPath()
      c.rect(x0, 0, z.w, this.H)
      c.clip()
      this.gym(c, z, i)
      this.court(c, z)
      this.hoop(c, z)
      this.defsLayer(c, p, z)
      this.playerLayer(c, p, z)
      c.restore()
      this.hud(c, p, z)
      if (n > 1 && i === 0) {
        c.fillStyle = '#fff'
        c.fillRect(this.W / 2 - 3, 0, 6, this.H)
      }
    }
  }

  /** 球馆背景：紫渐变 + 聚光 + 观众点阵 + 横幅 */
  private gym(c: CanvasRenderingContext2D, z: Zone, i: number) {
    const x0 = z.cx - z.w / 2
    const g = c.createLinearGradient(0, 0, 0, this.H)
    g.addColorStop(0, '#171236')
    g.addColorStop(1, '#3a2d6b')
    c.fillStyle = g
    c.fillRect(x0, 0, z.w, this.H)
    for (let k = 0; k < 3; k++) {
      const sx = x0 + z.w * (0.25 + k * 0.25)
      c.fillStyle = 'rgba(255,255,220,.05)'
      c.beginPath()
      c.moveTo(sx, 0)
      c.lineTo(sx - 90, z.hy + 60)
      c.lineTo(sx + 90, z.hy + 60)
      c.closePath()
      c.fill()
    }
    // 观众：两排点
    for (let row = 0; row < 2; row++) {
      for (let k = 0; k < Math.floor(z.w / 26); k++) {
        const hue = (k * 47 + row * 90 + i * 30) % 360
        c.fillStyle = `hsl(${hue} 45% 62%)`
        circle(c, x0 + 13 + k * 26 + (row % 2) * 13, 26 + row * 20 + Math.sin(this.t * 2 + k) * 2, 8, `hsl(${hue} 45% 62%)`)
      }
    }
    rrf(c, x0 + z.w / 2 - 90, 70, 180, 30, 10, 'rgba(255,255,255,.14)')
    txt(c, `🏀 运球闯关`, x0 + z.w / 2, 85, 18, '#ffffffcc')
  }

  /** 木地板 + 边线 + 油漆区 + 三分弧 */
  private court(c: CanvasRenderingContext2D, z: Zone) {
    const near = this.proj(z, -HALF_W, 2.6, 0)
    const nearR = this.proj(z, HALF_W, 2.6, 0)
    const far = this.proj(z, -HALF_W, 24.775, 0)
    const farR = this.proj(z, HALF_W, 24.775, 0)
    if (!near || !nearR || !far || !farR) return
    c.fillStyle = '#d9a05f'
    c.beginPath()
    c.moveTo(near.x, near.y)
    c.lineTo(nearR.x, nearR.y)
    c.lineTo(farR.x, farR.y)
    c.lineTo(far.x, far.y)
    c.closePath()
    c.fill()
    c.fillStyle = 'rgba(255,240,200,.25)'
    c.beginPath()
    c.moveTo(near.x, near.y)
    c.lineTo(nearR.x, nearR.y)
    const midN = this.proj(z, HALF_W, 10, 0)
    const midL = this.proj(z, -HALF_W, 10, 0)
    if (midN && midL) {
      c.lineTo(midN.x, midN.y)
      c.lineTo(midL.x, midL.y)
    }
    c.closePath()
    c.fill()
    c.strokeStyle = '#f6e7c8'
    c.lineWidth = 3
    c.beginPath()
    c.moveTo(near.x, near.y)
    c.lineTo(nearR.x, nearR.y)
    c.lineTo(farR.x, farR.y)
    c.lineTo(far.x, far.y)
    c.closePath()
    c.stroke()
    // 油漆区（z: 14.975 ~ 24.775，±2.45）
    const p1 = this.proj(z, -2.45, FT_Z, 0)
    const p2 = this.proj(z, 2.45, FT_Z, 0)
    const p3 = this.proj(z, 2.45, 24, 0)
    const p4 = this.proj(z, -2.45, 24, 0)
    if (p1 && p2 && p3 && p4) {
      c.fillStyle = 'rgba(190,70,70,.30)'
      c.beginPath()
      c.moveTo(p1.x, p1.y)
      c.lineTo(p2.x, p2.y)
      c.lineTo(p3.x, p3.y)
      c.lineTo(p4.x, p4.y)
      c.closePath()
      c.fill()
      c.stroke()
    }
    // 三分弧
    c.beginPath()
    let first = true
    for (let a = -1.2; a <= 1.2; a += 0.1) {
      const pt = this.proj(z, RIM_R * 9.4 * Math.sin(a), 12.6 + 6.75 * Math.cos(a), 0)
      if (!pt) continue
      if (first) {
        c.moveTo(pt.x, pt.y)
        first = false
      } else c.lineTo(pt.x, pt.y)
    }
    c.stroke()
  }

  private hoop(c: CanvasRenderingContext2D, z: Zone) {
    const bb1 = this.proj(z, -0.95, BOARD_Z, 3.95)
    const bb2 = this.proj(z, 0.95, BOARD_Z, 2.9)
    if (bb1 && bb2) {
      c.fillStyle = '#e8e4f0'
      c.fillRect(bb1.x, bb1.y, bb2.x - bb1.x, bb2.y - bb1.y)
      c.strokeStyle = '#c9c9d8'
      c.strokeRect(bb1.x, bb1.y, bb2.x - bb1.x, bb2.y - bb1.y)
    }
    const rim = this.proj(z, 0, HOOP_Z, RIM_H)
    if (rim) {
      const rx = RIM_R * rim.sc
      c.strokeStyle = '#ff7b3d'
      c.lineWidth = Math.max(3, rim.sc * 0.04)
      c.beginPath()
      c.ellipse(rim.x, rim.y, rx, rx * 0.35, 0, 0, Math.PI * 2)
      c.stroke()
      c.strokeStyle = 'rgba(255,255,255,.55)'
      c.lineWidth = 1.5
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2
        c.beginPath()
        c.moveTo(rim.x + Math.cos(a) * rx, rim.y + Math.sin(a) * rx * 0.35)
        c.lineTo(rim.x, rim.y + rx * 0.9)
        c.stroke()
      }
    }
  }

  /** 防守者 */
  private defsLayer(c: CanvasRenderingContext2D, p: Baller, z: Zone) {
    if (p.mode === 'shot' || p.mode === 'rest') return
    for (const d of p.defs) {
      if (d.state === 'beaten' || d.state === 'gone') continue
      let depth: number
      let x: number
      if (d.state === 'lunge') {
        const k = clamp((this.t - d.t0) / (this.cfg.lunge * (1 - 0.2 * this.ctx.heat)), 0, 1)
        depth = d.z0 + (0.75 - d.z0) * k
        x = d.side * (3.4 + (0.45 - 3.4) * k)
      } else {
        depth = clamp(d.at * STEP + DEF_HOME - p.s, 2.2, 6)
        x = d.side * 3.4
      }
      const pt = this.proj(z, x, Math.max(0.5, depth), 0)
      if (!pt) continue
      const size = pt.sc
      circle(c, pt.x, pt.y - size * 0.75, size * 0.2, '#d05a5a') // 头
      c.strokeStyle = '#d05a5a'
      c.lineWidth = Math.max(3, size * 0.1)
      c.beginPath()
      c.moveTo(pt.x, pt.y - size * 0.55)
      c.lineTo(pt.x, pt.y - size * 0.2)
      c.moveTo(pt.x, pt.y - size * 0.45)
      c.lineTo(pt.x - size * 0.22, pt.y - size * 0.3)
      c.moveTo(pt.x, pt.y - size * 0.45)
      c.lineTo(pt.x + size * 0.22, pt.y - size * 0.3)
      c.moveTo(pt.x, pt.y - size * 0.2)
      c.lineTo(pt.x - size * 0.14, pt.y)
      c.moveTo(pt.x, pt.y - size * 0.2)
      c.lineTo(pt.x + size * 0.14, pt.y)
      c.stroke()
      if (d.state === 'lunge') {
        const pulse = 1 + Math.sin(this.t * 18) * 0.15
        txt(c, '!', pt.x, pt.y - size * 1.1, 26 * pulse, '#ff4d4d', 'center', 'bold')
      }
    }
  }

  /** 球员 + 球 */
  private playerLayer(c: CanvasRenderingContext2D, p: Baller, z: Zone) {
    const pt = this.proj(z, p.x, Math.max(0.4, p.s), 0)
    if (!pt) return
    const size = pt.sc
    const sad = p.mode === 'stolen'
    const lean = p.x * 0.2
    c.save()
    c.translate(pt.x, pt.y)
    c.rotate(lean)
    // 阴影
    c.fillStyle = 'rgba(0,0,0,.2)'
    c.beginPath()
    c.ellipse(0, 0, size * 0.3, size * 0.08, 0, 0, Math.PI * 2)
    c.fill()
    const shirt = sad ? '#8f8fa8' : '#4d7dd0'
    // 腿
    c.strokeStyle = '#3a3a55'
    c.lineWidth = Math.max(3, size * 0.09)
    const stride = Math.sin(this.t * 8) * size * 0.12 * (p.ball.state === 'down' || p.ball.state === 'up' ? 1 : 0.3)
    c.beginPath()
    c.moveTo(0, -size * 0.35)
    c.lineTo(-size * 0.14 + stride, 0)
    c.moveTo(0, -size * 0.35)
    c.lineTo(size * 0.14 - stride, 0)
    c.stroke()
    // 身体
    c.strokeStyle = shirt
    c.lineWidth = Math.max(4, size * 0.14)
    c.beginPath()
    c.moveTo(0, -size * 0.35)
    c.lineTo(0, -size * 0.75)
    c.stroke()
    // 手臂：持球时垂向球侧，投篮时举高
    const shooting = p.mode === 'aim' || p.mode === 'shot'
    c.strokeStyle = shirt
    c.lineWidth = Math.max(3, size * 0.08)
    c.beginPath()
    if (shooting) {
      c.moveTo(0, -size * 0.7)
      c.lineTo(-size * 0.12, -size * 1.0)
      c.moveTo(0, -size * 0.7)
      c.lineTo(size * 0.12, -size * 1.0)
    } else {
      c.moveTo(0, -size * 0.7)
      c.lineTo(size * 0.24, -size * 0.35)
      c.moveTo(0, -size * 0.7)
      c.lineTo(-size * 0.2, -size * 0.4)
    }
    c.stroke()
    // 头
    circle(c, 0, -size * 0.9, size * 0.14, '#f2c9a0')
    if (sad) {
      c.strokeStyle = '#3a2d2d'
      c.lineWidth = 2
      c.beginPath()
      c.arc(0, -size * 0.86, size * 0.06, 1.15 * Math.PI, 1.85 * Math.PI)
      c.stroke()
    }
    c.restore()

    // 球（世界坐标：横向偏移 HOLD_OFF，高度按相位 0~1.8 米）
    const ball = p.ball
    if (ball.state === 'hold' || ball.state === 'down' || ball.state === 'up') {
      let hFrac: number
      if (ball.state === 'hold') hFrac = HOLD_H
      else if (ball.state === 'down') hFrac = ball.startH * (1 - clamp(ball.elapsed / Math.max(0.05, ball.dur), 0, 1))
      else hFrac = clamp(ball.elapsed / Math.max(0.05, ball.dur), 0, 1) * HOLD_H
      const bp = this.proj(z, p.x + HOLD_OFF, Math.max(0.4, p.s) + 0.3, hFrac * 1.8)
      if (bp) {
        const br = Math.max(5, 0.15 * bp.sc * 1.6)
        circle(c, bp.x, bp.y, br, '#e8963c')
        c.strokeStyle = 'rgba(90,40,10,.6)'
        c.lineWidth = 1.5
        c.beginPath()
        c.arc(bp.x, bp.y, br * 0.7, this.t * 5, this.t * 5 + 1.6)
        c.stroke()
      }
    }
    // 投篮球：抛物线飞向篮筐
    if (p.mode === 'shot' && p.shot) {
      const tt = clamp((this.t - p.shot.t0) / SHOT_T, 0, 1)
      const depth = 0.3 + (HOOP_Z - p.s - 0.3) * tt
      const height = 2.3 + (3.17 - 2.3) * tt + 5.6 * tt * (1 - tt)
      const bp = this.proj(z, p.x * (1 - tt), depth, height)
      if (bp) circle(c, bp.x, bp.y, Math.max(5, 0.15 * bp.sc * 1.6), '#e8963c')
    }
  }

  /** HUD：轮次 + 18 进度点 + 连击 */
  private hud(c: CanvasRenderingContext2D, p: Baller, z: Zone) {
    const x0 = z.cx - z.w / 2
    rrf(c, x0 + 14, 96, Math.min(240, z.w - 28), 64, 12, 'rgba(10,14,40,.55)')
    txt(c, `第 ${p.lap + 1} 轮`, x0 + 30, 114, 20, '#ffd54a', 'left', 'bold')
    txt(c, `连击 ${p.streak}`, x0 + 30, 140, 16, p.streak >= 10 ? '#ffb24d' : '#ffffffcc', 'left', 'bold')
    const dotN = 18
    const dx0 = x0 + 110
    for (let k = 0; k < dotN; k++) {
      const done = k < p.steps
      const bold = k === 5 || k === 11
      const col = done ? (bold ? '#9be15d' : 'rgba(155,225,93,.6)') : bold ? 'rgba(255,255,255,.5)' : 'rgba(255,255,255,.22)'
      circle(c, dx0 + k * 9, 118, bold ? 3.5 : 2.5, col)
    }
    txt(c, p.steps >= GOAL ? '到篮下！' : `还有 ${GOAL - p.steps} 步`, dx0, 140, 14, '#ffffffcc', 'left', 'bold')
    if (p.mode === 'stolen') {
      outlineTxt(c, '球被抢了！', z.cx, this.H * 0.3, 40, '#ff6b8a')
    }
  }
}

export default function create(ctx: GameContext) {
  return new Dribble(ctx)
}
