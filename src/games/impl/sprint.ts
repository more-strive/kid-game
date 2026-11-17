import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, emoji, glow, outlineTxt, txt } from '@/core/draw'

/**
 * 百米冲刺（对齐 dongdongpark 真实规则，逆向报告 _reverse/reports/sprint.md）：
 * 各就位→预备→砰！原地全力跑 100 米，抢跑一次警告、两次直接取消资格（DQ）；
 * 单人有一只按目标配速跑的兔子当「破纪录」参照（pacer m/s，105m 处停住）。
 * 分数 = round(10000/用时) = 100 × 平均速度(m/s)；未完赛 round(100×距离/用时)。
 *
 * 站点框架行为等价代理说明（与 hurdles 同一套起跑/速度模型，参数字典一致）：
 * - motion.run（0~1）：双膝相对髋的抬升量折算；motion.stepRate → 双膝抬升沿频率（1s 滑窗），
 *   ≥3 步/秒触发 +10% 速度加成；reaction 记录但不在统计显示（报告 §8：站点同款行为）。
 * - 抢跑检测：run>0.2 持续 ≥0.2s（fsT）；第 2 次 out=true 取消资格，score 清零其贡献。
 * - 双人模式无兔子/电脑，纯竞速。
 * - 音效映射：crack→play('hit',高倍率)（发令枪）、oops→fail、tada→win。
 * - 音乐 run：BGM 由外壳统一管理。duration=0（比赛制）：冲线/超时由本游戏调用 finish()。
 */

// ---- 难度表 u（报告 §1 全部字面量） ----
const DIFF = [
  { gain: 2.3, setWait: [1.2, 2.2], pacer: 6 },
  { gain: 2, setWait: [1.5, 3], pacer: 6.8 },
  { gain: 1.7, setWait: [1.8, 3.6], pacer: 7.6 },
]
const RACE_M = 100 // d：赛程 100 米
const VMAX = 8 // f：速度上限基数（步频加成后 8.8）
const TIMEOUT = 45 // p：超时强制结束
const PX_PER_M_DEN = 14 // m：像素/米换算分母（W/14）
const FS_TH = 0.2 // 抢跑阈值：run > 0.2
const FS_T = 0.2 // 持续 ≥0.2s
const ACCEL_R = 2.2 // 加速率
const DECEL_R = 1.6 // 减速率
const STEP_BONUS = 3 // 步频 ≥3 加成门槛
const REACT_TH = 0.15 // reaction：run×gain > 0.15 首次出现（内部记录，不显示）
const RABBIT_STOP = 105 // 兔子 105m 上限（超过终点 5m 停住）
const TRACK_COLORS = ['#ff3385', '#ffd54a', '#3ddc97', '#3390fc', '#a78bfa', '#ff8a3d', '#4dd0c4']

type Phase = 'marks' | 'set' | 'go' | 'over'

interface RS {
  dist: number
  v: number
  top: number
  run: number
  steps: number[]
  wasL: boolean
  wasR: boolean
  stepPeak: number
  fsT: number
  out: boolean // 抢跑两次取消资格
  reaction: number
  finishT: number
  legPhase: number
}

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v))
}

function torsoOf(b: Body): number {
  const shY = (b.lm[11].y + b.lm[12].y) / 2
  const hipY = (b.lm[23].y + b.lm[24].y) / 2
  return Math.max(0.06, Math.abs(hipY - shY))
}

/** motion.run 代理：双膝相对髋的抬升量折算 0~1 */
function runOf(b: Body): number {
  const hipY = b.hipC.y
  const liftL = (hipY - b.lKnee.y) / Math.max(0.06, torsoOf(b) * 2)
  const liftR = (hipY - b.rKnee.y) / Math.max(0.06, torsoOf(b) * 2)
  return clamp01((liftL + liftR + 0.9) / 1.1)
}

function newRS(): RS {
  return {
    dist: 0,
    v: 0,
    top: 0,
    run: 0,
    steps: [],
    wasL: false,
    wasR: false,
    stepPeak: 0,
    fsT: 0,
    out: false,
    reaction: -1,
    finishT: -1,
    legPhase: 0,
  }
}

class Sprint extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  phase: Phase = 'marks'
  phaseT = 0
  setDur = 2
  goAt = -1
  fouls = [0, 0]
  ps: RS[] = [newRS(), newRS()]
  bannerText = ''
  bannerT = 0
  shakeT = 0
  endAt = -1
  ended = false
  firstFinisher = -1
  started = false
  private realClock = 0

  constructor(ctx: GameContext) {
    super(ctx)
    this.ctx.setStage('枪响再跑，抢跑两次取消资格！')
    this.armRace()
  }

  private armRace() {
    const [lo, hi] = this.cfg.setWait
    this.setDur = lo + Math.random() * (hi - lo)
    this.phase = 'marks'
    this.phaseT = 0
    this.goAt = -1
    this.endAt = -1
    this.firstFinisher = -1
    this.ps = [newRS(), newRS()]
  }

  update(f: PoseFrame, dt: number) {
    this.realClock += dt
    this.bannerT = Math.max(0, this.bannerT - dt)
    this.shakeT = Math.max(0, this.shakeT - dt)
    this.popT = Math.max(0, this.popT - dt)
    super.update(f, dt)
  }

  private banner(text: string, sec: number) {
    this.bannerText = text
    this.bannerT = sec
  }

  private get raceT() {
    return this.goAt >= 0 ? this.t - this.goAt : 0
  }

  private get duo() {
    return this.players.filter((p) => p.body).length > 1
  }

  tick(f: PoseFrame, dt: number) {
    if (!this.started) {
      this.started = true
      this.ctx.speak('各就位！')
    }
    if (this.ended) return

    // 起跑流程：marks(1s) → set(随机) → go（砰！banner + 枪声 + 震屏 4）
    this.phaseT += dt
    if (this.phase === 'marks' && this.phaseT >= 1) {
      this.phase = 'set'
      this.phaseT = 0
      this.ctx.speak('预备……别动！')
    } else if (this.phase === 'set' && this.phaseT >= this.setDur) {
      this.phase = 'go'
      this.goAt = this.t
      this.ctx.audio.play('hit', 0.9, 1.7) // crack 代理
      this.ctx.speak('跑！')
      this.banner('砰！跑！', 1)
      this.shakeT = 0.3
    }

    for (let pi = 0; pi < 2; pi++) {
      const b = f.bodies[pi] ?? null
      const r = this.ps[pi]
      if (!b || r.out) continue
      if (this.phase !== 'go') {
        // 抢跑检测：run>0.2 持续 ≥0.2s（fsT，动一下即清零）
        const run = runOf(b)
        r.fsT = run > FS_TH ? r.fsT + dt : 0
        if (r.fsT >= FS_T) this.foul(pi)
        continue
      }
      this.tickRunner(pi, r, b, dt)
    }

    // 结束：冲线 / 超时
    if (this.raceT >= TIMEOUT) this.finishRace()
    if (this.endAt >= 0 && this.t >= this.endAt) this.finishRace()

    // HUD：分数 = 100 × 最好平均速度（DQ 不计）
    this.ctx.setScore(this.bestScore())
    const lead = this.leader()
    if (lead) {
      this.ctx.setExtra('最高速度(m/s)', Math.round(lead.top * 10) / 10)
      this.ctx.setExtra('最快步频(步/秒)', Math.round(lead.stepPeak * 10) / 10)
      this.ctx.setExtra('距离(米)', Math.floor(lead.dist))
    }
    this.ctx.setCombo(0)
  }

  private foul(pi: number) {
    this.fouls[pi]++
    if (this.fouls[pi] === 1) {
      // 第 1 次：警告 + 全场重置重新起跑
      this.banner('抢跑！再来一次，枪响之前不能动哦', 2.2)
      this.ctx.speak('抢跑，再来一次')
      this.ctx.audio.fail() // oops
      this.armRace()
    } else {
      // 第 2 次：取消资格（out=true），分数清零其贡献
      this.ps[pi].out = true
      this.banner('抢跑两次，取消啦', 2.2)
      this.ctx.speak('抢跑两次，取消啦')
      this.ctx.audio.fail()
      this.ctx.setScore(this.bestScore())
      // 全员都取消 → 1.5s 后结束
      const allOut = this.ps.every((p, i) => !this.players[i].body || p.out)
      if (allOut && this.endAt < 0) this.endAt = this.t + 1.5
    }
  }

  private tickRunner(pi: number, r: RS, b: Body, dt: number) {
    const raceT = this.raceT
    const gain = this.cfg.gain

    const raw = runOf(b)
    r.run += (raw - r.run) * Math.min(1, dt / 0.12)
    const lUp = b.lKnee.y < b.lHip.y - 0.02
    const rUp = b.rKnee.y < b.rHip.y - 0.02
    if (lUp && !r.wasL) r.steps.push(this.t)
    if (rUp && !r.wasR) r.steps.push(this.t)
    r.wasL = lUp
    r.wasR = rUp
    while (r.steps.length && this.t - r.steps[0] > 1) r.steps.shift()
    const rate = r.steps.length
    r.stepPeak = Math.max(r.stepPeak, rate)
    r.legPhase += dt * (2 + rate * 2.2)

    // 反应时刻（内部记录，不显示——与站点一致）
    if (r.reaction < 0 && r.run * gain > REACT_TH) r.reaction = raceT

    // 速度模型（与 hurdles 参数一致）：VMAX × clamp(run×gain) × (步频≥3 ? 1.1 : 1)
    const target = VMAX * clamp01(r.run * gain) * (rate >= STEP_BONUS ? 1.1 : 1)
    const rr2 = target > r.v ? ACCEL_R : DECEL_R
    r.v += (target - r.v) * (1 - Math.exp(-dt * rr2))
    r.top = Math.max(r.top, r.v)
    r.dist += r.v * dt

    // 冲线：用时插值 time = I − (dist−100)/v
    if (r.finishT < 0 && r.dist >= RACE_M) {
      r.finishT = raceT - (r.dist - RACE_M) / Math.max(0.5, r.v)
      this.onFinished(pi)
    }

    // 高速扬尘（v>5，随机 8/s）
    if (r.v > 5 && Math.random() < 8 * dt) {
      const p = this.lanePos(pi)
      this.particles.burst(p.x, p.y, '#d9b38c', 2, 90, 3.5, 260)
    }
  }

  private onFinished(pi: number) {
    const r = this.ps[pi]
    if (this.firstFinisher < 0) {
      this.firstFinisher = pi
      if (this.duo) {
        this.banner(`玩家${pi + 1} 第一个冲线！`, 2.2)
        this.ctx.speak(`玩家${pi + 1}第一个冲线！`)
      } else {
        this.banner(`冲线啦！${r.finishT.toFixed(2)} 秒`, 2.2)
        this.ctx.speak('冲线啦！')
      }
      this.ctx.audio.win() // tada
      this.particles.confetti(this.W, 40)
      this.popT = 3 // highlight(3)
      this.popAt = this.realClock
    }
    // 首个完赛 → 10s 后强制结束；全员完赛 → 2.5s
    const allDone = this.ps.every((p, i) => !this.players[i].body || p.out || p.finishT >= 0)
    const delay = allDone ? 2.5 : 10
    if (this.endAt < 0 || this.endAt > this.t + delay) this.endAt = this.t + delay
  }

  private finishRace() {
    if (this.ended) return
    this.ended = true
    this.phase = 'over'
    // 未完赛结算浮字「加油！」
    for (let pi = 0; pi < 2; pi++) {
      const b = this.players[pi].body
      const r = this.ps[pi]
      if (b && !r.out && r.finishT < 0) {
        this.say('加油！', b.head.x * this.W, (b.head.y - 0.1) * this.H, '#ffd54a', 34)
      }
    }
    this.ctx.setScore(this.bestScore())
    this.ctx.finish()
  }

  private bestScore() {
    const raceT = Math.max(1, this.raceT)
    let best = 0
    for (let pi = 0; pi < 2; pi++) {
      if (!this.players[pi].body) continue
      const r = this.ps[pi]
      if (r.out) continue // 抢跑取消 → 分数清零
      const s = r.finishT >= 0 ? Math.round(10000 / Math.max(0.5, r.finishT)) : Math.round(((10000 / raceT) * r.dist) / RACE_M)
      best = Math.max(best, s)
    }
    return best
  }

  private leader(): RS | null {
    const act = this.ps.filter((r, i) => this.players[i].body && !r.out)
    if (!act.length) return null
    return act.reduce((a, b) => (b.dist > a.dist ? b : a))
  }

  private lanePos(pi: number) {
    const duo = this.duo
    const y = duo ? (pi === 0 ? this.H * 0.76 : this.H * 0.9) : this.H * 0.8
    return { x: this.W * (duo ? (pi === 0 ? 0.3 : 0.34) : 0.3), y }
  }

  private camX(pi: number) {
    return this.ps[pi].dist - 3.5
  }

  // ---------- 绘制 ----------

  paint(c: CanvasRenderingContext2D) {
    const unit = this.H / 720
    c.save()
    if (this.shakeT > 0) {
      const amp = 6 * (this.shakeT / 0.3)
      c.translate(Math.sin(this.realClock * 70) * amp, Math.cos(this.realClock * 63) * amp * 0.5)
    }
    this.paintWorld(c, unit)
    const duo = this.duo
    for (let pi = 0; pi < 2; pi++) {
      if (!this.players[pi].body) continue
      const r = this.ps[pi]
      const p = this.lanePos(pi)
      this.paintDude(c, p.x, p.y, unit, this.players[pi].color, r.legPhase, r.out, 0)
      outlineTxt(c, r.out ? '玩家' + (pi + 1) + '（取消）' : `玩家${pi + 1}`, p.x, p.y + 30, 20, r.out ? '#ff8a8a' : this.players[pi].color)
      if (this.ps[pi].out) outlineTxt(c, '🚫', p.x + 60, p.y - 150, 30, '#ff8a8a')
    }
    // 陪跑兔（单人）：按 pacer m/s 匀速，105m 停住
    if (!duo && this.phase === 'go') {
      const rabbitD = Math.min(RABBIT_STOP, this.cfg.pacer * this.raceT)
      const pxm = this.W / PX_PER_M_DEN
      const rx = (rabbitD - this.camX(0)) * pxm + this.lanePos(0).x
      if (rx > -40 && rx < this.W + 40) {
        emoji(c, '🐇', rx, this.H * 0.66, 44)
        txt(c, '目标配速', rx, this.H * 0.66 + 34, 15, 'rgba(255,255,255,.85)', 'center', 'bold')
      }
    }
    // 起跑阶段文字
    if (this.phase === 'marks') outlineTxt(c, '各就位…', this.W / 2, this.H * 0.3, 54, '#ffffff')
    else if (this.phase === 'set') outlineTxt(c, '预备……别动！', this.W / 2, this.H * 0.3, 54, '#ffb703')
    if (this.bannerT > 0) {
      c.globalAlpha = Math.min(1, this.bannerT / 0.3)
      outlineTxt(c, this.bannerText, this.W / 2, this.H * 0.18, 50, '#ffd54a')
      c.globalAlpha = 1
    }
    // 顶部实时成绩（大屏）：秒表 + m/s · 米
    if (this.phase === 'go') {
      const r = this.ps[0]
      txt(
        c,
        `${this.raceT.toFixed(2)} 秒 · ${r.v.toFixed(1)} m/s · ${Math.floor(r.dist)} 米`,
        this.W / 2,
        this.H * 0.06 + 16,
        24,
        '#ffffff',
        'center',
        'bold',
      )
    }
    // 抢跑警告牌：黄牌 1 张 / 红牌（取消）
    let cx = 30
    for (let pi = 0; pi < 2; pi++) {
      if (!this.players[pi].body) continue
      for (let k = 0; k < Math.min(2, this.fouls[pi]); k++) {
        c.fillStyle = k === 0 ? '#ffd54a' : '#ff5c5c'
        c.beginPath()
        c.roundRect(cx, 66, 20, 28, 4)
        c.fill()
        cx += 26
      }
    }
    // 冲线白闪（highlight(3) 代理）
    if (this.popT > 0) {
      c.globalAlpha = Math.min(0.35, this.popT * 0.12)
      c.fillStyle = '#ffffff'
      c.fillRect(-20, -20, this.W + 40, this.H + 40)
      c.globalAlpha = 1
    }
    c.restore()
    if (this.ended) this.paintResult(c)
    txt(c, '各就位别动，枪响再跑；抢跑一次警告，两次取消；追上兔子就是好成绩', this.W / 2, this.H - 26, 20, 'rgba(255,255,255,.8)', 'center', 'bold')
  }

  /** 世界背景：蓝天、看台、绿草、红跑道、每 10m 里程标、起点/终点横幅、终点彩带 */
  private paintWorld(c: CanvasRenderingContext2D, unit: number) {
    const pxm = this.W / PX_PER_M_DEN
    const cam = this.ps[0].dist - 3.5
    // 蓝天
    const g = c.createLinearGradient(0, 0, 0, this.H * 0.3)
    g.addColorStop(0, '#7ec3ff')
    g.addColorStop(1, '#cfe9ff')
    c.fillStyle = g
    c.fillRect(0, 0, this.W, this.H * 0.3)
    // 看台
    c.fillStyle = 'rgba(30,36,80,.85)'
    c.fillRect(0, this.H * 0.14, this.W, this.H * 0.14)
    const off = (cam * pxm * 0.35) % 34
    for (let i = 0; i < 42; i++) {
      const x = i * 34 - off
      const row = i % 2
      const bob = this.phase === 'go' ? Math.abs(Math.sin(this.realClock * 8 + i)) * 6 : 0
      circle(c, x, this.H * 0.2 + row * 24 - bob, 8 * unit, TRACK_COLORS[(i + Math.floor(cam)) % TRACK_COLORS.length])
    }
    // 绿草
    c.fillStyle = '#3e7d3a'
    c.fillRect(0, this.H * 0.28, this.W, this.H * 0.14)
    // 红跑道
    c.fillStyle = '#a83a28'
    c.fillRect(0, this.H * 0.42, this.W, this.H * 0.58)
    c.fillStyle = 'rgba(255,255,255,.1)'
    c.fillRect(0, this.H * 0.42, this.W, 6)
    c.strokeStyle = 'rgba(255,255,255,.35)'
    c.lineWidth = 3
    for (const y of [this.H * 0.62, this.H * 0.84]) {
      c.beginPath()
      c.moveTo(0, y)
      c.lineTo(this.W, y)
      c.stroke()
    }
    // 彩色跑道圆点（7 色循环）营造速度感
    const dotOff = (cam * pxm * 0.9) % 150
    for (let i = 0; i < 12; i++) {
      circle(c, i * 150 - dotOff + 40, this.H * 0.86, 6, TRACK_COLORS[i % TRACK_COLORS.length])
    }
    // 里程标（每 10m）
    const m0 = Math.floor(cam / 10) * 10
    for (let m = m0; m <= cam + PX_PER_M_DEN + 12; m += 10) {
      if (m < 0 || m > RACE_M) continue
      const x = (m - cam) * pxm
      c.fillStyle = 'rgba(255,255,255,.75)'
      c.fillRect(x, this.H * 0.44, 4, 26)
      txt(c, `${m}`, x + 18, this.H * 0.47, 16, 'rgba(255,255,255,.85)', 'center', 'bold')
    }
    // 终点横幅 + 彩带（tape）
    const fx = (RACE_M - cam) * pxm
    if (fx > -60 && fx < this.W + 60) {
      c.fillStyle = '#ffffff'
      c.fillRect(fx - 4, this.H * 0.44, 8, this.H * 0.5)
      outlineTxt(c, '终点', fx + 46, this.H * 0.48, 22, '#ffffff')
      // tape 动画：未冲线画横带，冲线后飘走
      const leader = this.leader()
      const broke = leader ? leader.finishT >= 0 : false
      if (!broke) {
        c.strokeStyle = '#ff3385'
        c.lineWidth = 6
        c.beginPath()
        c.moveTo(fx, this.H * 0.62)
        c.quadraticCurveTo(fx + 14 * Math.sin(this.realClock * 3), this.H * 0.7, fx, this.H * 0.78)
        c.stroke()
      } else {
        c.globalAlpha = 0.5
        c.strokeStyle = '#ff3385'
        c.lineWidth = 4
        c.beginPath()
        c.moveTo(fx, this.H * 0.62)
        c.quadraticCurveTo(fx + 60, this.H * 0.55 + Math.sin(this.realClock * 5) * 10, fx + 110, this.H * 0.6)
        c.stroke()
        c.globalAlpha = 1
      }
    }
    // 起点横幅
    const sx = (0 - cam) * pxm
    if (sx > -80 && sx < this.W) {
      c.fillStyle = 'rgba(255,212,74,.9)'
      c.beginPath()
      c.roundRect(sx - 50, this.H * 0.36, 130, 34, 8)
      c.fill()
      txt(c, '起点', sx + 15, this.H * 0.36 + 17, 20, '#5a3e00', 'center', 'bold')
    }
  }

  /** 简易跑步小人（与 hurdles 同款风格） */
  private paintDude(c: CanvasRenderingContext2D, x: number, groundY: number, unit: number, color: string, legPhase: number, dq: boolean, air: number) {
    const s = 56 * unit
    const jump = Math.sin(Math.min(1, air) * Math.PI) * s * 1.15
    c.save()
    if (dq) c.globalAlpha = 0.4 // 抢跑取消：半透明罚站
    c.translate(x, groundY - jump)
    glow(c, 0, -s * 0.9, s * 1.5, color, 0.18)
    const sw = Math.sin(legPhase) * 0.55
    c.strokeStyle = '#2b3a67'
    c.lineWidth = 7 * unit
    c.lineCap = 'round'
    c.beginPath()
    c.moveTo(0, -s * 0.9)
    c.lineTo(Math.sin(sw) * s * 0.5, -s * 0.45 + Math.cos(sw) * s * 0.1)
    c.lineTo(Math.sin(sw) * s * 0.7, air > 0 ? -s * 0.2 : 0)
    c.moveTo(0, -s * 0.9)
    c.lineTo(-Math.sin(sw) * s * 0.5, -s * 0.45 + Math.cos(-sw) * s * 0.1)
    c.lineTo(-Math.sin(sw) * s * 0.7, air > 0 ? -s * 0.35 : 0)
    c.stroke()
    c.strokeStyle = color
    c.lineWidth = 9 * unit
    c.beginPath()
    c.moveTo(0, -s * 0.9)
    c.lineTo(0, -s * 1.7)
    c.stroke()
    const arm = -sw * 0.7
    c.lineWidth = 6 * unit
    c.beginPath()
    c.moveTo(0, -s * 1.55)
    c.lineTo(Math.sin(arm) * s * 0.55, -s * (1.2 + 0.25 * Math.cos(arm)))
    c.moveTo(0, -s * 1.55)
    c.lineTo(-Math.sin(arm) * s * 0.55, -s * (1.2 + 0.25 * Math.cos(-arm)))
    c.stroke()
    circle(c, 0, -s * 1.98, s * 0.26, '#ffd9b3')
    c.restore()
  }

  /** 结算面板（报告 §6：用时 / 最高速度 / 最快步频） */
  private paintResult(c: CanvasRenderingContext2D) {
    const lead = this.leader()
    const w = 380
    const h = 240
    const x = this.W / 2 - w / 2
    const y = this.H * 0.32 - h / 2
    c.fillStyle = 'rgba(10,14,40,.8)'
    c.beginPath()
    c.roundRect(x, y, w, h, 20)
    c.fill()
    c.strokeStyle = 'rgba(255,255,255,.25)'
    c.stroke()
    const duo = this.duo
    const title = duo
      ? this.firstFinisher >= 0
        ? `玩家${this.firstFinisher + 1} 第一个冲线！`
        : '比赛结束'
      : this.ps[0].finishT >= 0
        ? `${this.ps[0].finishT.toFixed(2)} 秒冲线！`
        : '比赛结束'
    outlineTxt(c, title, this.W / 2, y + 44, 34, '#ffd54a')
    const lines: string[] = []
    const r = lead ?? this.ps[0]
    if (r.out) lines.push('用时：抢跑取消')
    else if (r.finishT >= 0) lines.push(`用时：${r.finishT.toFixed(2)} 秒`)
    else lines.push(`用时：没跑完（${Math.floor(r.dist)} 米）`)
    lines.push(`最高速度：${(Math.round(r.top * 10) / 10).toFixed(1)} m/s`)
    lines.push(`最快步频：${(Math.round(r.stepPeak * 10) / 10).toFixed(1)} 步/秒`)
    lines.forEach((s, i) => txt(c, s, this.W / 2, y + 96 + i * 36, 22, '#ffffff', 'center', 'bold'))
  }

  /** highlight(3) 代理：冲线白闪剩余时长 */
  popT = 0
  popAt = -9
}

export default function create(ctx: GameContext) {
  return new Sprint(ctx)
}
