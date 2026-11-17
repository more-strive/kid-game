import { BaseGame, PLAYER_COLORS } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { outlineTxt, rr, star } from '@/core/draw'

/**
 * 相扑推手（对齐 dongdongpark 真实规则）：
 * 两人站在土俵里，双手一起快速往对方那边推；对手「嘿——」蓄力时蹲低马步顶住。三局两胜，每局 20 秒。
 *
 * 站点原样保留的五条规则：
 * 1. 推的识别：手朝对手的前推速度 > 2.5 躯干/秒、手在肩前、且不高过胯；**两手须在 0.4 秒内配对**。
 * 2. 冲量 `V += 方向 × v × 防御 × 领先 × 时间`，`B += V·dt`，`V` 按 `exp(−5dt)` 衰减（半衰期 0.14 秒）。
 * 3. 防御：蹲下减伤 60%（`1 − squat×0.6`），抱架且 0.6 秒没出推再减 20%。
 * 4. 领先加成（最高 +50%）与时间加成（第 8 秒起爬、第 18 秒满 +60%）叠加，逼后期决战。
 * 5. 限时判胜：20 秒到先用 B 判，近似平局（|B| ≤ 0.02）比推的次数；赢局得分 `10 + (0~5)`，越没被逼到边越高。
 *
 * 与站点的差异：站点有连续的 `motion.squat` 与 `motion.guard`，本框架 `squat` 是布尔、没有 guard，
 * 这里蹲下按 1/0 取值（减伤就是 60% 或 0），抱架用「双手举过肩」代理。
 */

const DIFF = [
  { calm: [2.6, 3.6], tap: 0.03, tapEvery: 1.2, surge: 0.1, surgeN: [2, 3], squatP: 0.2, squatLen: 1 },
  { calm: [1.9, 2.9], tap: 0.055, tapEvery: 0.9, surge: 0.19, surgeN: [2, 3], squatP: 0.3, squatLen: 1.2 },
  { calm: [1.4, 2.2], tap: 0.075, tapEvery: 0.7, surge: 0.24, surgeN: [3, 4], squatP: 0.4, squatLen: 1.3 },
]

const PUSH_V = 2.5 // 前推速度阈值（躯干长/秒）
const PAIR = 0.4 // 双手配对窗口（秒）
const COOL = 0.32 // 推的冷却（秒）
const GUARD_W = 0.6 // 抱架减伤窗口（对手多久没推）
const SQUAT_AT = 0.35 // 蹲稳阈值
const DECAY = 5 // 冲量衰减率
const ROUND_T = 20 // 每局限时（秒）
const READY_T = 2 // 预备时长（秒）
const OUT_T = 2.6 // 一局结束后的停顿（秒）
const WINDUP = 0.7 // 电脑爆发前蓄力（秒）
const SURGE_GAP = 0.3 // 电脑爆发期内推的间隔（秒）
const WIN_ROUNDS = 2 // 三局两胜
const TAU = Math.PI * 2

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v))
}
function rnd(a: number, b: number) {
  return a + Math.random() * (b - a)
}

interface HandTrack {
  x: number
  y: number
  has: boolean
  was: boolean
  at: number
  speed: number
  used: boolean
  cool: number
}

interface Side {
  /** 0..1 蹲下程度（真人只有 0/1） */
  squat: number
  guard: boolean
  pushes: number
  blocks: number
  maxPower: number
  /** 本局被逼到边的最大程度 */
  danger: number
  lastPushAt: number
  pushAnim: number
  hitAnim: number
  hands: HandTrack[]
}

type Phase = 'ready' | 'fight' | 'out'

class SumoPush extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[0]
  phase: Phase = 'ready'
  phaseAt = 0
  /** 圈心位移：+1 左方（P0）胜 */
  B = 0
  V = 0
  round = 1
  roundT = 0
  wins: [number, number] = [0, 0]
  winner = -1
  /** 比赛是否已收局（防止 out 阶段每帧重复 finish） */
  private over = false
  private drum = 0
  private banner = ''
  private bannerSub = ''
  private bannerColor = '#ffd54a'
  private bannerT = 0
  private duo = false
  sides: Side[] = []
  private cpu = {
    mode: 'calm' as 'calm' | 'windup' | 'surge',
    t: 0,
    dur: 0,
    nextTap: 0,
    left: 0,
    squatFrom: -1,
    squatUntil: -1,
  }

  constructor(ctx: GameContext) {
    super(ctx)
    for (let i = 0; i < 2; i++) {
      this.sides.push(this.blankSide())
    }
    this.cpuEnterCalm(true)
    this.startRound()
  }

  private blankSide(): Side {
    return {
      squat: 0,
      guard: false,
      pushes: 0,
      blocks: 0,
      maxPower: 0,
      danger: 0,
      lastPushAt: -99,
      pushAnim: 0,
      hitAnim: 0,
      hands: [0, 1].map(() => ({ x: 0, y: 0, has: false, was: false, at: -99, speed: 0, used: true, cool: -99 })),
    }
  }

  private dir(i: number) {
    return i === 0 ? 1 : -1
  }

  // ---------------------------------------------------------------- 回合流程

  private startRound() {
    this.phase = 'ready'
    this.phaseAt = this.t
    this.roundT = 0
    this.drum = 0
    this.B = 0
    this.V = 0
    this.winner = -1
    for (const s of this.sides) {
      s.pushes = 0
      s.blocks = 0
      s.danger = 0
      s.lastPushAt = -99
      s.pushAnim = 0
      s.hitAnim = 0
      for (const h of s.hands) Object.assign(h, { was: false, at: -99, used: true, cool: -99 })
    }
    this.cpuEnterCalm(true)
    this.banner = `第 ${this.round} 局`
    this.bannerSub = this.wins[0] === 1 && this.wins[1] === 1 ? '1 : 1 → 决胜局！' : `${this.wins[0]} : ${this.wins[1]}`
    this.bannerColor = '#ffd54a'
    this.bannerT = 1.6
    this.publishStats()
  }

  tick(f: PoseFrame, dt: number) {
    this.duo = f.bodies.length > 1
    if (this.bannerT > 0) this.bannerT -= dt
    for (const s of this.sides) {
      s.pushAnim = Math.max(0, s.pushAnim - dt * 3)
      s.hitAnim = Math.max(0, s.hitAnim - dt * 2.4)
    }

    if (this.phase === 'ready') {
      const e = this.t - this.phaseAt
      // 第 0.42 / 1.22 秒各一声鼓
      if ((e >= 0.42 && this.drum === 0) || (e >= 1.22 && this.drum === 1)) {
        this.drum++
        this.ctx.audio.play('tick', 0.9)
        this.ctx.audio.play('hit', 0.35, 0.8)
      }
      if (e >= READY_T) {
        this.phase = 'fight'
        this.phaseAt = this.t
        this.banner = '推！'
        this.bannerSub = ''
        this.bannerColor = '#ff6b6b'
        this.bannerT = 0.9
        this.ctx.audio.play('start', 0.8)
        this.ctx.speak('推！')
      }
      return
    }

    if (this.phase === 'out') {
      if (this.over) return
      if (this.t - this.phaseAt >= OUT_T) {
        if (this.wins[0] >= WIN_ROUNDS || this.wins[1] >= WIN_ROUNDS) {
          this.finishMatch()
        } else {
          this.round++
          this.startRound()
        }
      }
      return
    }

    // ---- 开打
    this.roundT += dt
    for (let i = 0; i < 2; i++) {
      const b = f.bodies[i] ?? null
      const s = this.sides[i]
      if (i === 1 && !this.duo) {
        this.squatCpu(s, dt)
        continue
      }
      if (!b) {
        s.squat = 0
        s.guard = false
        continue
      }
      s.squat = b.squat ? 1 : 0
      s.guard = b.armsUp
      const v = this.stepHands(i, b, dt)
      if (v > 0) this.applyPush(i, v)
    }
    if (!this.duo) this.cpuStep(dt)

    // ---- 冲量积分
    this.B += this.V * dt
    this.V *= Math.exp(-DECAY * dt)
    for (let i = 0; i < 2; i++) {
      const s = this.sides[i]
      s.danger = Math.max(s.danger, -this.B * this.dir(i))
    }

    if (this.B >= 1) this.endRound(0)
    else if (this.B <= -1) this.endRound(1)
    else if (this.roundT >= ROUND_T) {
      if (this.B > 0.02) this.endRound(0)
      else if (this.B < -0.02) this.endRound(1)
      else if (this.sides[0].pushes !== this.sides[1].pushes) this.endRound(this.sides[0].pushes > this.sides[1].pushes ? 0 : 1)
      else this.endRound(-1)
    }
    this.publishStats()
  }

  /** 手部前推识别 → 返回本次推的强度（0 表示没推） */
  private stepHands(i: number, b: Body, dt: number): number {
    const T = Math.max(0.05, b.hipC.y - b.shoulderC.y)
    const dir = this.dir(i)
    const s = this.sides[i]
    const pts = [b.lHand, b.rHand]

    for (let k = 0; k < 2; k++) {
      const h = s.hands[k]
      const p = pts[k]
      if (!h.has) {
        h.x = p.x
        h.y = p.y
        h.has = true
        continue
      }
      const dx = p.x - h.x
      const dy = p.y - h.y
      const vx = dx / dt
      const speed = Math.hypot(dx, dy) / dt / T
      h.x = p.x
      h.y = p.y

      const u = (vx * dir) / T // 朝对手的前推速度（躯干/秒）
      const front = ((p.x - b.shoulderC.x) * dir) / T
      const pushing = u > PUSH_V && front > -0.1 && p.y < b.hipC.y + 0.1 * T

      if (pushing && !h.was && this.t >= h.cool) {
        h.at = this.t
        h.speed = speed
        h.used = false
        h.cool = this.t + COOL
      } else if (pushing && !h.used) {
        h.speed = Math.max(h.speed, speed)
      }
      h.was = pushing
    }

    const live = s.hands.filter((h) => h.has && !h.used && this.t - h.at <= PAIR)
    if (live.length < 2) return 0
    // 两手触发时刻本身也要在窗口内
    if (Math.abs(live[0].at - live[1].at) > PAIR) return 0
    for (const h of live) h.used = true
    const avg = (live[0].speed + live[1].speed) / 2
    return clamp(0.5 + (avg - PUSH_V) / 7, 0.5, 1)
  }

  /** 结算一次推：防御 / 领先 / 时间三重修正 */
  private applyPush(i: number, v: number) {
    const s = this.sides[i]
    const opp = this.sides[1 - i]
    const dir = this.dir(i)
    const def = (1 - opp.squat * 0.6) * (opp.guard && this.t - opp.lastPushAt > GUARD_W ? 0.8 : 1)
    const lead = 1 + 0.5 * Math.max(0, this.B * dir)
    const timeK = 1 + 0.6 * clamp((this.roundT - 8) / 10, 0, 1)

    this.V += dir * v * def * lead * timeK
    s.pushes++
    s.lastPushAt = this.t
    s.maxPower = Math.max(s.maxPower, v)
    s.pushAnim = 1
    opp.hitAnim = Math.max(opp.hitAnim, 0.6)

    if (opp.squat >= SQUAT_AT) {
      opp.blocks++
      this.say('顶住！', this.W / 2 + dir * -120, this.ringY() - 150, '#3ddc97', 34)
      this.ctx.audio.play('hit', 0.4, 0.8)
    } else if (v > 0.85) {
      this.say('大力推！', this.W / 2 + dir * 140, this.ringY() - 190, '#ff6b6b', 36)
      this.ctx.audio.play('hit', 0.8, 1.1)
      this.particles.burst(this.W / 2, this.ringY() - 120, '#ffd54a', 12, 380, 6)
    } else {
      this.ctx.audio.play('pop', 0.35, 1.3)
      this.particles.burst(this.W / 2, this.ringY() - 120, '#ffe066', 6, 240, 5)
    }
  }

  // ---------------------------------------------------------------- 电脑脚本

  private cpuEnterCalm(first = false) {
    const c = this.cpu
    const [lo, hi] = this.cfg.calm
    c.mode = 'calm'
    c.t = 0
    c.dur = rnd(lo, hi) * (first ? 0.3 : 1)
    c.nextTap = this.cfg.tapEvery * 0.6
    c.left = 0
    // 平静期内可能插一段格挡窗口
    if (!first && Math.random() < this.cfg.squatP) {
      const len = this.cfg.squatLen
      c.squatFrom = Math.max(0.3, Math.random() * Math.max(0.1, c.dur - len))
      c.squatUntil = c.squatFrom + len
    } else {
      c.squatFrom = -1
      c.squatUntil = -1
    }
  }

  private cpuStep(dt: number) {
    const c = this.cpu
    c.t += dt
    if (c.mode === 'calm') {
      if (c.t >= c.nextTap) {
        c.nextTap += this.cfg.tapEvery
        this.applyPush(1, this.cfg.tap)
      }
      if (c.t >= c.dur) {
        c.mode = 'windup'
        c.t = 0
        this.ctx.audio.play('drop', 0.5, 0.9)
        if (this.roundT < 8) this.ctx.speak('嘿——！')
      }
    } else if (c.mode === 'windup') {
      if (c.t >= WINDUP) {
        c.mode = 'surge'
        c.t = 0
        c.nextTap = 0
        const [a, b] = this.cfg.surgeN
        c.left = a + Math.floor(Math.random() * (b - a + 1))
      }
    } else {
      if (c.left > 0 && c.t >= c.nextTap) {
        c.nextTap += SURGE_GAP
        c.left--
        this.applyPush(1, this.cfg.surge)
      }
      if (c.left <= 0 && c.t > c.nextTap + 0.4) this.cpuEnterCalm()
    }
  }

  /** 电脑的蹲下（脚本覆盖：蓄力/爆发期不蹲） */
  private squatCpu(s: Side, _dt: number) {
    const c = this.cpu
    if (c.mode !== 'calm') {
      s.squat = 0
    } else {
      s.squat = c.squatFrom >= 0 && c.t >= c.squatFrom && c.t <= c.squatUntil ? 0.8 : 0
    }
    s.guard = c.mode === 'calm'
  }

  // ---------------------------------------------------------------- 结算

  private endRound(winner: number) {
    if (this.phase === 'out') return
    this.phase = 'out'
    this.phaseAt = this.t
    this.winner = winner
    this.V = 0

    if (winner < 0) {
      this.banner = '平局'
      this.bannerSub = '这局重来'
      this.bannerColor = '#ff9f43'
      this.ctx.audio.play('drop', 0.6)
      this.ctx.speak('平局，这局重来')
      this.bannerT = OUT_T
      this.publishStats()
      return
    }

    this.wins[winner]++
    const human = winner === 0 || this.duo
    if (human) {
      const clean = clamp(this.sides[winner].danger, 0, 1)
      const gain = 10 + Math.round(5 * (1 - clean))
      this.ctx.addScore(gain)
      this.say(`赢一局 +${gain}`, this.W / 2, this.H * 0.35, '#ffd54a', 40)
      this.ctx.audio.win()
      this.particles.confetti(this.W, 30)
      this.banner = '你赢了这局！'
      this.bannerSub = `第 ${this.round} 局`
      this.bannerColor = '#3ddc97'
      this.ctx.speak('赢啦！')
    } else {
      this.ctx.audio.lose()
      this.banner = '电脑赢了这局'
      this.bannerSub = '被推出去了，再来'
      this.bannerColor = '#c98a4b'
      this.ctx.speak('被推出去了，再来')
    }
    this.bannerT = OUT_T
    this.publishStats()
  }

  private finishMatch() {
    this.over = true
    const w = this.wins[0] >= WIN_ROUNDS ? 0 : 1
    if (w === 0 || this.duo) {
      this.banner = '赢了比赛！'
      this.bannerColor = '#ffd54a'
    } else {
      this.banner = '比赛结束'
      this.bannerColor = '#c98a4b'
    }
    this.bannerSub = `${this.wins[0]} : ${this.wins[1]}`
    this.bannerT = 2
    this.ctx.setStage('done')
    this.ctx.finish()
  }

  private publishStats() {
    const a = this.sides[0]
    this.ctx.setExtra('赢局', this.wins[0])
    this.ctx.setExtra('输局', this.wins[1])
    this.ctx.setExtra('推了', a.pushes)
    this.ctx.setExtra('最大推力', Math.round(a.maxPower * 100))
    this.ctx.setExtra('蹲稳顶住', a.blocks)
  }

  // ---------------------------------------------------------------- 绘制

  private ringY() {
    return this.H * 0.8
  }

  paint(c: CanvasRenderingContext2D) {
    const cx = this.W / 2
    const fy = this.ringY()
    const rx = this.W * 0.3
    const ry = this.H * 0.1

    // 土俵
    c.beginPath()
    c.ellipse(cx, fy, rx, ry, 0, 0, TAU)
    c.fillStyle = 'rgba(226,189,134,.22)'
    c.fill()
    c.lineWidth = 6
    c.strokeStyle = 'rgba(255,255,255,.55)'
    c.stroke()
    // 危险弧光
    if (Math.abs(this.B) > 0.65) {
      const a = 0.25 + 0.25 * Math.sin(this.t * 8)
      c.beginPath()
      c.ellipse(cx, fy, rx * 1.02, ry * 1.04, 0, 0, TAU)
      c.lineWidth = 12
      c.strokeStyle = `rgba(255,80,80,${a})`
      c.stroke()
    }

    const shift = clamp(this.B, -1, 1) * rx * 0.5
    // 被推的一方走得更远：只让两人一起平移的话，看起来像整块滑动而不是「有人被顶出去」
    const loser = this.B > 0 ? 1 : 0
    for (let i = 0; i < 2; i++) {
      const human = i === 0 || this.duo
      if (!human) continue
      const pv = this.player(i)
      const s = this.sides[i]
      const body = pv.body
      const base = body ? body.center.x * this.W : cx + (i === 0 ? -1 : 1) * rx * 0.55
      const x = clamp(base, 80, this.W - 80) + shift * (i === loser ? 1.45 : 0.55)
      this.drawRikishi(c, x, fy, pv.color, s)
    }
    if (!this.duo) {
      const cs = this.sides[1]
      this.drawRikishi(c, cx + rx * 0.62 + shift * (loser === 1 ? 1.45 : 0.55), fy, '#ff9f68', cs, -1)
    }

    this.drawHud(c)

    if (this.bannerT > 0 && this.banner) {
      c.globalAlpha = Math.min(1, this.bannerT * 1.8)
      outlineTxt(c, this.banner, this.W / 2, this.H * 0.24, 66, this.bannerColor)
      if (this.bannerSub) outlineTxt(c, this.bannerSub, this.W / 2, this.H * 0.24 + 66, 30, '#ffffffd0')
      c.globalAlpha = 1
    }
  }

  private drawRikishi(c: CanvasRenderingContext2D, x: number, fy: number, color: string, s: Side, face = 1) {
    const sz = this.H * 0.15 // 体型基准
    const crouch = s.squat
    const hipY = fy - sz * (0.55 - 0.18 * crouch)
    const bodyY = hipY - sz * (0.45 - 0.1 * crouch)
    const reach = 0.35 + 0.55 * s.pushAnim
    const lean = 0.1 + 0.22 * s.pushAnim - 0.2 * s.hitAnim

    // 影子
    c.beginPath()
    c.ellipse(x, fy + 4, sz * 0.62, sz * 0.12, 0, 0, TAU)
    c.fillStyle = 'rgba(18,22,55,.28)'
    c.fill()

    // 腿
    c.lineCap = 'round'
    c.strokeStyle = color
    c.lineWidth = sz * 0.24
    for (const side of [-1, 1]) {
      c.beginPath()
      c.moveTo(x + side * sz * 0.16, hipY)
      c.lineTo(x + side * sz * (0.26 + 0.1 * crouch), fy)
      c.stroke()
    }

    // 躯干
    c.beginPath()
    c.ellipse(x, bodyY, sz * (0.36 + 0.08 * crouch), sz * 0.34, 0, 0, TAU)
    c.fillStyle = color
    c.fill()
    // 腰带
    c.beginPath()
    c.ellipse(x, hipY - sz * 0.12, sz * (0.34 + 0.06 * crouch), sz * 0.1, 0, 0, TAU)
    c.fillStyle = 'rgba(220,60,90,.85)'
    c.fill()

    // 头
    c.beginPath()
    c.arc(x + face * sz * lean * 0.4, bodyY - sz * 0.48, sz * 0.24, 0, TAU)
    c.fillStyle = '#ffdfc0'
    c.fill()
    c.lineWidth = 3
    c.strokeStyle = 'rgba(30,40,80,.35)'
    c.stroke()
    // 眼睛（蹲下变成两条横线 —— 「咬牙顶住」）
    c.strokeStyle = '#2b3555'
    c.lineWidth = 3
    const ey = bodyY - sz * 0.5
    for (const side of [-1, 1]) {
      c.beginPath()
      if (crouch > SQUAT_AT) {
        c.moveTo(x + face * sz * lean * 0.4 + side * sz * 0.09 - 5, ey)
        c.lineTo(x + face * sz * lean * 0.4 + side * sz * 0.09 + 5, ey)
      } else {
        c.arc(x + face * sz * lean * 0.4 + side * sz * 0.09, ey, 3.4, 0, TAU)
      }
      c.stroke()
    }

    // 手臂：朝对手推出去
    c.strokeStyle = color
    c.lineWidth = sz * 0.16
    for (const side of [-0.1, 0.1]) {
      c.beginPath()
      c.moveTo(x + side * sz, bodyY - sz * 0.05)
      c.lineTo(x + face * sz * reach * 1.05 + side * sz * 0.5, bodyY + sz * 0.05 - sz * 0.1 * crouch)
      c.stroke()
      // 拳头
      c.beginPath()
      c.arc(x + face * sz * reach * 1.05 + side * sz * 0.5, bodyY + sz * 0.05 - sz * 0.1 * crouch, sz * 0.12, 0, TAU)
      c.fillStyle = '#ffdfc0'
      c.fill()
    }

    // 蹲下时的防御环
    if (squatRing(crouch, this.t)) {
      c.beginPath()
      c.ellipse(x, fy + 6, sz * 0.7, sz * 0.16, 0, 0, TAU)
      c.lineWidth = 4
      c.strokeStyle = 'rgba(61,220,151,.7)'
      c.stroke()
    }
    // 受击闪红
    if (s.hitAnim > 0) {
      c.globalAlpha = s.hitAnim * 0.4
      c.beginPath()
      c.arc(x, bodyY, sz * 0.6, 0, TAU)
      c.fillStyle = '#ff4d4d'
      c.fill()
      c.globalAlpha = 1
    }
  }

  private drawHud(c: CanvasRenderingContext2D) {
    // 顶部比分
    const y = 118
    const tag = (i: number) => (this.duo ? (i === 0 ? '左边' : '右边') : i === 0 ? '你' : '电脑')
    for (let i = 0; i < 2; i++) {
      const x = i === 0 ? this.W * 0.28 : this.W * 0.72
      outlineTxt(c, tag(i), x, y, 28, i === 0 ? PLAYER_COLORS[0] : '#ff9f68')
      for (let k = 0; k < WIN_ROUNDS; k++) {
        const sx = x + (k - (WIN_ROUNDS - 1) / 2) * 40
        if (k < this.wins[i]) star(c, sx, y + 34, 14, '#ffd54a')
        else {
          c.beginPath()
          c.arc(sx, y + 34, 10, 0, TAU)
          c.lineWidth = 3
          c.strokeStyle = 'rgba(255,255,255,.55)'
          c.stroke()
        }
      }
    }
    outlineTxt(c, `第 ${this.round} 局`, this.W / 2, y, 26, '#ffffffdd')

    // 底部局内时间条
    const left = this.W * 0.32
    const w = this.W * 0.36
    const by = this.H - 54
    rr(c, left, by, w, 14, 7)
    c.fillStyle = 'rgba(18,22,55,.45)'
    c.fill()
    const pct = this.phase === 'fight' ? clamp(1 - this.roundT / ROUND_T, 0, 1) : 1
    if (pct > 0.01) {
      rr(c, left, by, w * pct, 14, 7)
      c.fillStyle = pct < 0.25 ? '#ff5252' : '#4cc9f0'
      c.fill()
    }
    // 圈心指示
    const mid = left + w / 2
    const off = clamp(this.B, -1, 1) * (w / 2 - 12)
    c.beginPath()
    c.arc(mid + off, by + 7, 9, 0, TAU)
    c.fillStyle = '#ffd54a'
    c.fill()
  }
}

/** 蹲下时的防御环脉动（提出来避免在主绘制里塞条件表达式） */
function squatRing(crouch: number, t: number) {
  return crouch > SQUAT_AT && Math.sin(t * 6) > -0.3
}

export function createSumoPush(ctx: GameContext): Game {
  return new SumoPush(ctx)
}


export default createSumoPush
