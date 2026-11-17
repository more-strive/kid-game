import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame, Pt } from '@/core/types'
import { circle, glow, outlineTxt, txt } from '@/core/draw'

/**
 * 射箭（对齐 dongdongpark 真实规则，报告 _reverse/reports/archery.md）：
 * 一手伸直当弓、另一手拉到肩边拉满，稳住准星松手放箭；持弓越久越晃、medium 起有风、hard 靶横移，
 * 每人 10 支按总环数计分。预判定型：环数在松手瞬间按 0.1s 前准星位置结算。
 */

/** 对齐站点难度表：靶半径 px×unit / 初始晃动(靶半径) / 每秒晃动增幅 / 宽限 s / 晃动上限 / 风力 / 靶横移幅度 / 横移周期 s */
const DIFF = [
  { r: 108, sway0: 0.1, grow: 0.1, calm: 1.4, swayMax: 0.6, wind: 0, move: 0, period: 1 },
  { r: 96, sway0: 0.14, grow: 0.15, calm: 1, swayMax: 0.8, wind: 0.32, move: 0, period: 1 },
  { r: 84, sway0: 0.16, grow: 0.2, calm: 0.8, swayMax: 1, wind: 0.45, move: 0.9, period: 6.5 },
]
const FULL_SPAN = 1.2 // 拉满最小弓距（躯干）
const REL_SPD = 2 // 放箭速度阈值（躯干/s）
const ARM_HOLD = 0.3 // 武装前需持满时长 s
const ARM_MAX_SPD = 1.5 // 武装时弦手速度上限（躯干/s）
const HOLD_MAX = 8 // 持弓超时自动放箭 s
const LOOKBACK = 0.1 // 出手瞬间的准星延迟回看 s
const TILT_X = 2.4 // 弓臂倾斜→准星横移增益
const HEIGHT_Y = 3 // 弓弦高度差→准星纵移增益
const FLIGHT = 0.42 // 箭飞行时长 s
const NEXT_IN = 1.2 // 一支箭落地到下一支的间隔 s
const ARROWS = 10 // 每人气数（单人/双人均 10）
const CLAMP_AIM = 1.8 // 准星钳制（靶半径）
const MISS_R = 1.25 // 脱靶半径（靶半径）
const TIMEOUT = 300 // 代码内超时上限 s
const WIND_RAMP = 1.6 // 开弓后风从 0 渐起的时长 s
const SPAN_DROP = 0.45 // 0.22s 内弓距掉这么多 → 回弹放箭
const SPAN_WIN = 0.22
const RELEASE_BUF = 0.15 // 失去拉满后判弱放的宽限 s

/** 靶面 10 环配色（由外到内 5 色各 2 环） */
const RING_COLORS = ['#fdfaf2', '#33343d', '#3fa9f5', '#ff5a5a', '#ffd54a']

interface StuckArrow {
  /** 相对靶心的偏移（靶半径为单位） */
  dx: number
  dy: number
  /** 插靶抖动计时 */
  jit: number
}

interface Deck {
  state: 'ready' | 'aim' | 'fly' | 'land' | 'done'
  idx: number // 已射支数
  total: number
  tens: number
  misses: number
  holdSum: number
  hold: number // 本次持弓时长
  fullT: number // 本次连续拉满时长
  armed: boolean
  armedShown: boolean
  /** 一阶滤波后的准星偏移（靶半径） */
  ax: number
  ay: number
  /** 本支箭的晃动频率/相位（每箭随机） */
  f1: number
  f2: number
  ph0: number
  ph1: number
  f1y: number
  f2y: number
  windDir: number
  /** 准星历史（延迟补偿 + 拖尾） */
  hist: { x: number; y: number; t: number }[]
  /** 弓距窗口（回弹放箭检测） */
  spanHist: { v: number; t: number }[]
  lostFullT: number
  flyT: number
  /** 飞行箭：起点（屏幕 px）与落点（屏幕 px），环数在松手瞬间已定 */
  from: Pt
  to: Pt
  lastRing: number
  lastMiss: boolean
  lastHitD: number
  landT: number
  arrows: StuckArrow[]
  bowSide: number // 弓手屏幕侧（-1 左 1 右），用于画弓
  lastBow: Pt
  lastStr: Pt
  kDraw: number // 拉弓系数 0~1
  missHintT: number
}

function newDeck(): Deck {
  return {
    state: 'ready',
    idx: 0,
    total: 0,
    tens: 0,
    misses: 0,
    holdSum: 0,
    hold: 0,
    fullT: 0,
    armed: false,
    armedShown: false,
    ax: 0,
    ay: 0,
    f1: 0.45 + Math.random() * 0.25,
    f2: 1.1 + Math.random() * 0.4,
    ph0: Math.random() * 6.28,
    ph1: Math.random() * 6.28,
    f1y: 0.45 + Math.random() * 0.25,
    f2y: 1.1 + Math.random() * 0.4,
    windDir: Math.random() < 0.5 ? -1 : 1,
    hist: [],
    spanHist: [],
    lostFullT: 0,
    flyT: 0,
    from: { x: 0, y: 0 },
    to: { x: 0, y: 0 },
    lastRing: 0,
    lastMiss: false,
    lastHitD: 9,
    landT: 0,
    arrows: [],
    bowSide: 1,
    lastBow: { x: 0, y: 0 },
    lastStr: { x: 0, y: 0 },
    kDraw: 0,
    missHintT: 0,
  }
}

function smoothstep(a: number, b: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

class Archery extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  decks = [newDeck(), newDeck()]
  /** 全局已射支数：双人偶数支 0 号先射 */
  shotCount = 0
  /** 单人靶偏移方向（每局随机 ±） */
  side = Math.random() < 0.5 ? -1 : 1
  turnBannerT = 0
  turnText = ''
  endBannerT = 0
  endText = ''
  endSub = ''
  finished = false
  private endTimer = -1

  private duo() {
    return this.players.filter((p) => p.body).length > 1
  }

  /** 该玩家本支是否轮到他射（双人轮流，偶数支 0 号） */
  private isActive(pi: number) {
    return this.duo() ? this.shotCount % 2 === pi : true
  }

  /** 靶心屏幕位置 */
  private targetPos(_pi: number) {
    const U = this.H / 720
    const Y = this.cfg.r * U
    const duo = this.duo()
    const y = duo ? Math.max(this.H * 0.26, 96 * U + Y * 1.25) : Math.max(this.H * 0.3, 70 * U + Y * 1.25)
    let x: number
    if (duo) {
      // 双人轮流共用中央靶（对齐站点：双人靶心 W/2）
      x = this.W / 2
    } else {
      // 单人：靶心从中心偏移 ±min(W×0.35, W/2−(move+1.3)×靶半径)
      const off = Math.min(this.W * 0.35, this.W / 2 - (this.cfg.move + 1.3) * Y)
      x = this.W / 2 + this.side * off
    }
    return { x, y }
  }

  /** hard 靶横移：沿横线以 period 周期滑行 ±move 靶半径 */
  private targetX(pi: number, t: number) {
    const base = this.targetPos(pi)
    if (this.cfg.move <= 0) return base.x
    const U = this.H / 720
    return base.x + Math.sin((t / this.cfg.period) * Math.PI * 2) * this.cfg.move * this.cfg.r * U
  }

  tick(f: PoseFrame, dt: number) {
    const duo = this.duo()
    // 超时上限
    if (!this.finished && this.t > TIMEOUT) {
      this.finishGame()
      return
    }
    if (this.turnBannerT > 0) this.turnBannerT -= dt
    if (this.endBannerT > 0) this.endBannerT -= dt
    for (let pi = 0; pi < 2; pi++) {
      const dk = this.decks[pi]
      const b = f.bodies[pi]
      const active = this.isActive(pi)

      // 飞行 / 落地阶段（与姿态无关）
      if (dk.state === 'fly') {
        dk.flyT += dt
        if (dk.flyT >= FLIGHT) {
          dk.state = 'land'
          dk.landT = NEXT_IN
          this.onLand(pi, dk, duo)
        }
        continue
      }
      if (dk.state === 'land') {
        dk.landT -= dt
        for (const a of dk.arrows) a.jit += dt
        if (dk.landT <= 0) this.nextArrow(pi, dk)
        continue
      }
      if (dk.state === 'done') continue
      if (!b || !active) continue

      // ---- 弓/弦手识别：两肩外伸更远者为弓手（比另一手大 0.35 以上且外伸 > 0.6）----
      const torso = Math.max(60, Math.max(0.05, b.scale) * this.H)
      const T = torso
      const extL = Math.abs(b.lHand.x - b.shoulderC.x) * this.W / T
      const extR = Math.abs(b.rHand.x - b.shoulderC.x) * this.W / T
      let bow: Pt | null = null
      let str: Pt | null = null
      let bowSide = 1
      if (extL >= extR + 0.35 && extL > 0.6) {
        bow = { x: b.lHand.x * this.W, y: b.lHand.y * this.H }
        str = { x: b.rHand.x * this.W, y: b.rHand.y * this.H }
        bowSide = b.lHand.x < b.shoulderC.x * this.W ? -1 : 1
      } else if (extR >= extL + 0.35 && extR > 0.6) {
        bow = { x: b.rHand.x * this.W, y: b.rHand.y * this.H }
        str = { x: b.lHand.x * this.W, y: b.lHand.y * this.H }
        bowSide = b.rHand.x < b.shoulderC.x * this.W ? -1 : 1
      }
      dk.bowSide = bowSide

      // ---- 拉满判定 ----
      let full = false
      let span = 0
      if (bow && str) {
        dk.lastBow = bow
        dk.lastStr = str
        span = Math.hypot(bow.x - str.x, bow.y - str.y) / T
        const ext = Math.abs(str.x - b.shoulderC.x * this.W) / T // 拉弦手外伸
        const lift = (bow.y - str.y) / T // 高度差
        const back = Math.hypot(str.x - b.shoulderC.x * this.W, str.y - b.shoulderC.y * this.H) / T // 弦手到肩距离
        const bowH = Math.abs(bow.y - b.shoulderC.y * this.H) / T // 弓手不高于肩线太多
        full = span > FULL_SPAN && ext > 0.75 && Math.abs(lift) < 0.6 && back < 0.75 && bowH < 0.35
      }
      // 部分拉弓系数
      dk.kDraw = span > 0.12 * FULL_SPAN ? Math.max(0, Math.min(1, (span - 0.3) / 0.9)) : Math.max(0, dk.kDraw - dt * 2)

      if (dk.state === 'ready') {
        if (full) {
          dk.state = 'aim'
          dk.hold = 0
          dk.fullT = 0
          dk.armed = false
          dk.ax = 0
          dk.ay = 0
          dk.hist = []
          dk.spanHist = []
          dk.lostFullT = 0
          this.ctx.audio.click()
        }
        continue
      }

      // ---- 瞄准阶段 ----
      dk.hold += dt
      dk.fullT = full ? dk.fullT + dt : 0
      const strSpdT = str ? Math.max(b.lHandV, b.rHandV) / Math.max(0.05, b.scale) : 0

      // 武装：full 持续 ≥0.3s 且弦手速度 <1.5 躯干/s
      if (!dk.armed && full && dk.fullT >= ARM_HOLD && strSpdT < ARM_MAX_SPD) {
        dk.armed = true
        if (dk.idx < 2 && !dk.armedShown) {
          dk.armedShown = true
          this.say('稳住…松手！', this.W / 2, this.H * 0.42, '#9be29b', 40)
        }
      }
      if (!full) dk.armed = false

      // 晃动幅度：持弓越久越晃（宽限后线性增长到上限）
      const amp = Math.min(this.cfg.swayMax, this.cfg.sway0 + this.cfg.grow * Math.max(0, dk.hold - this.cfg.calm))
      // 风：开弓 1.6s 内从 0 渐起，仅横向
      const wind = this.cfg.wind * smoothstep(0, WIND_RAMP, dk.hold) * dk.windDir

      if (bow && str) {
        // 瞄准模型（躯干归一 → 靶半径单位）
        const anchorX = b.shoulderC.x * this.W
        const rawX = ((bow.x - anchorX) / T) * TILT_X
        const dxT = Math.abs(bow.x - str.x) / T
        const rawY = ((bow.y - str.y) / T / Math.max(0.6 * TILT_X, dxT)) * HEIGHT_Y
        // 一阶滤波 τ=1/16
        const k = 1 - Math.exp(-dt * 16)
        dk.ax += (rawX - dk.ax) * k
        dk.ay += (rawY - dk.ay) * k
        // 晃动：双正弦叠加
        const swayX = (amp * (Math.sin(2 * Math.PI * dk.f1 * dk.hold + dk.ph0) + 0.45 * Math.sin(2 * Math.PI * dk.f2 * dk.hold + dk.ph1))) / 1.45
        const swayY = (amp * (Math.sin(2 * Math.PI * dk.f1y * dk.hold + dk.ph0 + 1.7) + 0.45 * Math.sin(2 * Math.PI * dk.f2y * dk.hold + dk.ph1 + 0.9))) / 1.45
        let cx = dk.ax + swayX + wind
        let cy = dk.ay + swayY
        cx = Math.max(-CLAMP_AIM, Math.min(CLAMP_AIM, cx))
        cy = Math.max(-CLAMP_AIM, Math.min(CLAMP_AIM, cy))
        const tp = this.targetPos(pi)
        const tx = this.targetX(pi, this.t)
        const Y = this.cfg.r * (this.H / 720)
        dk.hist.push({ x: tx + cx * Y, y: tp.y + cy * Y, t: this.t })
        while (dk.hist.length > 90) dk.hist.shift()
      }

      // 弓距窗口（回弹放箭检测）
      dk.spanHist.push({ v: span, t: this.t })
      while (dk.spanHist.length > 0 && this.t - dk.spanHist[0].t > SPAN_WIN) dk.spanHist.shift()

      // ---- 放箭条件 ----
      let release = false
      let acid = false
      const strSpd = strSpdT
      if (strSpd > REL_SPD) release = true // 快松手
      const spanDrop = dk.spanHist.length > 1 ? dk.spanHist[0].v - span : 0
      if (spanDrop > SPAN_DROP) release = true // 回弹放箭
      if (!full && bow && str) {
        dk.lostFullT += dt
        if (dk.lostFullT > RELEASE_BUF) release = true // 失去拉满 → 弱放
      } else {
        dk.lostFullT = 0
      }
      if (dk.hold > HOLD_MAX) {
        release = true
        acid = true // 手酸自动放箭
      }

      if (release) {
        this.release(pi, dk, acid)
      }
    }

    // ---- 结束流程 ----
    if (!this.finished && this.decks.every((d) => d.state === 'done')) {
      this.finishGame()
    }
    if (this.endTimer > 0) {
      this.endTimer -= dt
      if (this.endTimer <= 0 && !this.finished) {
        this.finished = true
        this.ctx.finish()
      }
    }

    this.ctx.setScore(this.decks.reduce((n, d) => n + d.total, 0))
    this.ctx.setExtra('10 环', this.decks.reduce((n, d) => n + d.tens, 0))
    this.ctx.setExtra('脱靶', this.decks.reduce((n, d) => n + d.misses, 0))
    const cur = duo ? this.shotCount % 2 : 0
    const curDeck = this.decks[cur]
    this.ctx.setStage(curDeck.state === 'done' ? '射完啦' : `第 ${Math.min(ARROWS, curDeck.idx + 1)}/${ARROWS} 支`)
  }

  /** 松手：环数在松手瞬间按 LOOKBACK 前的准星位置结算（预判定） */
  private release(pi: number, dk: Deck, acid: boolean) {
    const tx = this.targetX(pi, this.t)
    const tp = this.targetPos(pi)
    const Y = this.cfg.r * (this.H / 720)
    // 命中点 = 0.1s 前的准星历史位置
    const past = dk.hist.length > 0 ? dk.hist[dk.hist.length - 1] : null
    let hx = past ? past.x : tx
    let hy = past ? past.y : tp.y
    for (const h of dk.hist) {
      if (this.t - h.t >= LOOKBACK) {
        hx = h.x
        hy = h.y
      }
    }
    dk.from = { x: dk.lastBow.x, y: dk.lastBow.y }
    dk.to = { x: hx, y: hy }
    const d = Math.hypot(hx - tx, hy - tp.y) / Y
    dk.lastHitD = d
    // ring = d<1 ? max(1, 10−floor(d×10)) : 0；d ≥ 1.25 → 脱靶
    dk.lastRing = d < 1 ? Math.max(1, 10 - Math.floor(d * 10)) : 0
    dk.lastMiss = d >= MISS_R
    dk.holdSum += dk.hold
    dk.idx++
    dk.arrows.push({ dx: (hx - tx) / Y, dy: (hy - tp.y) / Y, jit: 0 })
    dk.state = 'fly'
    dk.flyT = 0
    dk.hold = 0
    dk.armed = false
    dk.hist = []
    this.shotCount++
    if (acid) this.say('手酸啦，箭飞出去了', this.W / 2, this.H * 0.4, '#ffb0a0', 36)
    // 放箭音 + 弦回弹
    this.ctx.audio.play('pop', 0.45, 1.3)
    // 双人横幅：轮到下一位
    if (this.duo() && dk.idx < ARROWS) {
      const next = this.shotCount % 2
      this.turnText = `轮到 ${next === 0 ? '玩家 1' : '玩家 2'} 第 ${this.decks[next].idx + 1}/${ARROWS} 支`
      this.turnBannerT = NEXT_IN + FLIGHT
    }
    // 新箭参数
    dk.f1 = 0.45 + Math.random() * 0.25
    dk.f2 = 1.1 + Math.random() * 0.4
    dk.f1y = 0.45 + Math.random() * 0.25
    dk.f2y = 1.1 + Math.random() * 0.4
    dk.ph0 = Math.random() * 6.28
    dk.ph1 = Math.random() * 6.28
    dk.windDir = Math.random() < 0.5 ? -1 : 1
  }

  /** 落地：按预判定环数给反馈 */
  private onLand(pi: number, dk: Deck, duo: boolean) {
    const ring = dk.lastRing
    dk.total += ring
    dk.tens += ring === 10 ? 1 : 0
    if (dk.lastMiss) dk.misses++
    const tx = this.targetX(pi, this.t - FLIGHT)
    const tp = this.targetPos(pi)
    const Y = this.cfg.r * (this.H / 720)
    const px = tx + dk.arrows[dk.arrows.length - 1].dx * Y
    const py = tp.y + dk.arrows[dk.arrows.length - 1].dy * Y
    if (ring === 10) {
      this.say('正中靶心！10 环', px, py - 40, '#ffd54a', 44)
      this.ctx.audio.play('win', 0.85)
      this.particles.burst(px, py, '#ffd54a', 20, 360, 6, 700, '⭐')
      this.particles.confetti(this.W, 24)
      this.turnBannerT = 0
      this.turnText = ''
      this.endBannerT = 1.4
      this.endText = '正中靶心！'
    } else if (ring >= 8) {
      this.say(`${ring} 环`, px, py - 36, '#ff9db1', 40)
      this.ctx.audio.good()
      this.particles.burst(px, py, '#ffd54a', 10, 300, 5, 700, '⭐')
    } else if (ring >= 5) {
      this.say(`${ring} 环`, px, py - 32, '#9ad0ff', 36)
      this.ctx.audio.coin()
      this.particles.burst(px, py, '#9ad0ff', 8, 260, 4)
    } else if (ring >= 1) {
      this.say(`${ring} 环`, px, py - 30, '#dfe6f5', 30)
      this.ctx.audio.pop()
      this.particles.burst(px, py, '#dfe6f5', 6, 220, 3.5)
    } else if (!dk.lastMiss) {
      this.say('擦边，0 环', px, py - 30, '#c9a27a', 30)
      this.ctx.audio.fail()
    } else {
      this.say('脱靶了', px, py - 30, '#ff8a8a', 30)
      this.ctx.audio.fail()
    }
    void duo
  }

  /** 下一支 / 结束 */
  private nextArrow(pi: number, dk: Deck) {
    if (dk.idx >= ARROWS) {
      dk.state = 'done'
      if (this.duo()) {
        // 双人都在等对方
        if (this.decks[0].state === 'done' && this.decks[1].state === 'done') {
          const a = this.decks[0].total
          const b = this.decks[1].total
          this.endText = a === b ? '平手！' : `${a > b ? '玩家 1' : '玩家 2'} 赢啦！`
          this.endSub = `${a} : ${b} 环`
          this.endBannerT = 2.2
          this.endTimer = 2.2
          this.ctx.audio.play('win', 0.9)
        }
      } else {
        this.endText = `${dk.total} 环！`
        this.endSub = ''
        this.endBannerT = 2
        this.endTimer = 2
        this.ctx.audio.play('win', 0.9)
      }
      return
    }
    dk.state = 'ready'
    dk.hold = 0
    dk.fullT = 0
    dk.armed = false
    dk.kDraw = 0
    dk.lostFullT = 0
    // 双人时切到对方后对方 deck 自动 ready（isActive 控制）
    void pi
  }

  private finishGame() {
    if (this.finished) return
    this.finished = true
    this.ctx.finish()
  }

  // ---- 绘制 ----

  paint(c: CanvasRenderingContext2D) {
    const U = this.H / 720
    const duo = this.players.filter((p) => p.body).length > 1
    for (let pi = 0; pi < 2; pi++) {
      const dk = this.decks[pi]
      if (duo && !this.players[pi].body) continue
      const tx = this.targetX(pi, this.t)
      const tp = this.targetPos(pi)
      const Y = this.cfg.r * U

      // 靶面（10 环 5 色）+ 支架线
      for (let i = 4; i >= 0; i--) {
        circle(c, tx, tp.y, (Y * (i + 1)) / 5, RING_COLORS[i])
      }
      c.strokeStyle = 'rgba(20,24,60,.4)'
      c.lineWidth = 3 * U
      c.beginPath()
      c.arc(tx, tp.y, Y, 0, Math.PI * 2)
      c.stroke()
      // 靶底支杆
      c.strokeStyle = 'rgba(90,60,30,.55)'
      c.lineWidth = 8 * U
      c.beginPath()
      c.moveTo(tx, tp.y + Y)
      c.lineTo(tx, tp.y + Y + 90 * U)
      c.stroke()

      // 移动靶轨迹线（hard）
      if (this.cfg.move > 0) {
        c.save()
        c.globalAlpha = 0.25
        c.setLineDash([8, 10])
        c.strokeStyle = '#fff'
        c.lineWidth = 2
        c.beginPath()
        c.moveTo(tx - this.cfg.move * Y, tp.y + Y + 30 * U)
        c.lineTo(tx + this.cfg.move * Y, tp.y + Y + 30 * U)
        c.stroke()
        c.restore()
      }

      // 已插的箭（带插靶抖动）
      for (let ai = 0; ai < dk.arrows.length; ai++) {
        const a = dk.arrows[ai]
        const jit = ai === dk.arrows.length - 1 && dk.state === 'land' ? Math.sin(a.jit * 30) * 0.35 * Math.exp(-a.jit * 5) : 0
        this.drawArrow(c, tx + a.dx * Y + jit * 8, tp.y + a.dy * Y + jit * 4, Math.PI * 0.06, Y * 0.72, U)
      }

      // 飞行中的箭
      if (dk.state === 'fly' || (dk.state === 'land' && dk.flyT < FLIGHT + 0.05)) {
        const k = Math.min(1, dk.flyT / FLIGHT)
        const ax = dk.from.x + (dk.to.x - dk.from.x) * k
        const ay = dk.from.y + (dk.to.y - dk.from.y) * k - Math.sin(k * Math.PI) * 40 * U
        const ang = Math.atan2(dk.to.y - dk.from.y, dk.to.x - dk.from.x)
        this.drawArrow(c, ax, ay, ang, Y * 0.85, U)
      }

      // 准星 + 拖尾（瞄准阶段）
      if (dk.state === 'aim' && dk.hist.length > 0) {
        // 拖尾点：0.5s 内轨迹
        c.save()
        for (const h of dk.hist) {
          const age = this.t - h.t
          if (age > 0.5) continue
          c.globalAlpha = (1 - age / 0.5) * 0.4
          circle(c, h.x, h.y, 3 * U, '#fff')
        }
        c.restore()
        const cur = dk.hist[dk.hist.length - 1]
        const col = dk.armed ? '#3ddc97' : '#ffffff'
        glow(c, cur.x, cur.y, 34 * U, col, dk.armed ? 0.4 : 0.18)
        c.save()
        c.strokeStyle = col
        c.lineWidth = 3 * U
        c.beginPath()
        c.arc(cur.x, cur.y, Y * 0.3, 0, Math.PI * 2)
        c.stroke()
        c.beginPath()
        c.moveTo(cur.x - Y * 0.46, cur.y)
        c.lineTo(cur.x - Y * 0.14, cur.y)
        c.moveTo(cur.x + Y * 0.14, cur.y)
        c.lineTo(cur.x + Y * 0.46, cur.y)
        c.moveTo(cur.x, cur.y - Y * 0.46)
        c.lineTo(cur.x, cur.y - Y * 0.14)
        c.moveTo(cur.x, cur.y + Y * 0.14)
        c.lineTo(cur.x, cur.y + Y * 0.46)
        c.stroke()
        c.restore()
      }

      // 弓与搭箭（跟随玩家）
      const b = this.players[pi].body
      if (b && dk.state !== 'done' && (dk.kDraw > 0.12 || dk.state === 'aim')) {
        this.drawBow(c, b, dk, U)
      }
    }

    // 风指示（medium+）：靶上方箭头，强度 1~3 个
    if (this.cfg.wind > 0) {
      let wDir = 0
      let wStr = 0
      for (let pi = 0; pi < 2; pi++) {
        const dk = this.decks[pi]
        if (dk.state !== 'aim') continue
        const w = this.cfg.wind * smoothstep(0, WIND_RAMP, dk.hold) * dk.windDir
        if (Math.abs(w) > Math.abs(wStr)) {
          wStr = w
          wDir = dk.windDir
        }
      }
      if (wStr > 0.02) {
        const tp = this.targetPos(0)
        const U2 = this.H / 720
        const n = wStr > this.cfg.wind * 0.66 ? 3 : wStr > this.cfg.wind * 0.33 ? 2 : 1
        const label = `风 ${wDir < 0 ? '←'.repeat(n) : '→'.repeat(n)}`
        outlineTxt(c, label, this.duo() ? this.W / 2 : this.targetX(0, this.t), Math.max(40, tp.y - this.cfg.r * U2 - 46 * U2), 26, '#cfe8ff')
      }
    }

    // 未拉满引导：肩侧虚线引导圈（伸直/拉到这儿）
    for (let pi = 0; pi < 2; pi++) {
      const dk = this.decks[pi]
      const b = this.players[pi].body
      if (!b || dk.state !== 'ready' || dk.idx >= ARROWS) continue
      if (!this.isActive(pi)) continue
      const T = Math.max(60, Math.max(0.05, b.scale) * this.H)
      const gx = b.shoulderC.x * this.W + (dk.bowSide || 1) * T * 0.85
      const gy = b.shoulderC.y * this.H
      c.save()
      c.globalAlpha = 0.55 + Math.sin(this.t * 5) * 0.15
      c.setLineDash([10, 8])
      c.strokeStyle = this.players[pi].color
      c.lineWidth = 4
      c.beginPath()
      c.arc(gx, gy, T * 0.3, 0, Math.PI * 2)
      c.stroke()
      c.restore()
      txt(c, '伸直', gx, gy - T * 0.3 - 18, 22, '#ffffffcc')
      txt(c, '拉到这儿', gx + (dk.bowSide || 1) * -T * 0.5, gy + T * 0.32, 22, '#ffffffcc')
    }

    // 箭计数条：每人 10 支箭图标，射一支淡一支
    for (let pi = 0; pi < 2; pi++) {
      const dk = this.decks[pi]
      const x0 = duo ? (pi === 0 ? this.W * 0.3 : this.W * 0.7) : this.W / 2
      const y = this.H - 30 * U
      for (let i = 0; i < ARROWS; i++) {
        const used = i < dk.idx
        c.save()
        c.globalAlpha = used ? 0.18 : 0.9
        c.translate(x0 + (i - (ARROWS - 1) / 2) * 26 * U, y)
        c.rotate(-0.5)
        this.drawArrow(c, 0, 0, 0, 22 * U, U)
        c.restore()
      }
    }

    // 双人轮次横幅
    if (this.turnBannerT > 0 && this.turnText) {
      c.globalAlpha = Math.min(1, this.turnBannerT / 0.3)
      outlineTxt(c, this.turnText, this.W / 2, this.H * 0.14, 38, '#ffe27a')
      c.globalAlpha = 1
    }
    // 结果横幅
    if (this.endBannerT > 0 && this.endText) {
      c.globalAlpha = Math.min(1, Math.min(0.3, this.endBannerT) / 0.3 + 0.4)
      outlineTxt(c, this.endText, this.W / 2, this.H * 0.3, 60, '#ffd54a')
      if (this.endSub) outlineTxt(c, this.endSub, this.W / 2, this.H * 0.3 + 64, 40, '#fff')
      c.globalAlpha = 1
    }
    txt(c, '一手伸直当弓，另一手拉到肩边；稳住准星快松手，持弓越久越晃', this.W / 2, this.H - 56, 20, 'rgba(255,255,255,.8)', 'center', 'bold')
  }

  /** 画一支箭（箭头朝 ang 方向，长 len） */
  private drawArrow(c: CanvasRenderingContext2D, x: number, y: number, ang: number, len: number, U: number) {
    c.save()
    c.translate(x, y)
    c.rotate(ang)
    c.strokeStyle = '#8a5a2b'
    c.lineWidth = 4 * U
    c.lineCap = 'round'
    c.beginPath()
    c.moveTo(-len * 0.55, 0)
    c.lineTo(len * 0.45, 0)
    c.stroke()
    // 箭头
    c.fillStyle = '#dfe6f5'
    c.beginPath()
    c.moveTo(len * 0.6, 0)
    c.lineTo(len * 0.32, -5 * U)
    c.lineTo(len * 0.32, 5 * U)
    c.closePath()
    c.fill()
    // 箭羽
    c.fillStyle = '#ff5a5a'
    for (const s of [-1, 1]) {
      c.beginPath()
      c.moveTo(-len * 0.55, 0)
      c.lineTo(-len * 0.42, s * 6 * U)
      c.lineTo(-len * 0.3, s * 2 * U)
      c.closePath()
      c.fill()
    }
    c.restore()
  }

  /** 画弓：弓手处画弓形（随拉弓系数弯曲），弦连到弦手，搭箭后移 */
  private drawBow(c: CanvasRenderingContext2D, b: Body, dk: Deck, U: number) {
    const bow = dk.lastBow
    const str = dk.lastStr
    if (bow.x === 0 && bow.y === 0) return
    const T = Math.max(60, Math.max(0.05, b.scale) * this.H)
    const k = dk.kDraw
    const side = dk.bowSide
    c.save()
    // 弓臂：从弓手上下的弧
    const bowH = T * 0.75
    c.strokeStyle = '#7c4a1e'
    c.lineWidth = 7 * U
    c.lineCap = 'round'
    c.beginPath()
    c.moveTo(bow.x + side * 6 * U, bow.y - bowH * 0.55)
    c.quadraticCurveTo(bow.x + side * (14 + 26 * k) * U, bow.y, bow.x + side * 6 * U, bow.y + bowH * 0.55)
    c.stroke()
    // 弦：弓两端连到弦手（拉距越大弦越靠后）
    const tipT = { x: bow.x + side * 6 * U, y: bow.y - bowH * 0.55 }
    const tipB = { x: bow.x + side * 6 * U, y: bow.y + bowH * 0.55 }
    const nock = { x: str.x, y: str.y }
    c.strokeStyle = k > 0.02 && dk.state === 'aim' ? `rgba(255,255,255,${0.5 + Math.sin(this.t * 70) * 0.1})` : 'rgba(255,255,255,.5)'
    c.lineWidth = 2 * U
    c.beginPath()
    c.moveTo(tipT.x, tipT.y)
    c.lineTo(nock.x, nock.y)
    c.lineTo(tipB.x, tipB.y)
    c.stroke()
    // 搭箭：从弦手搭向弓手方向
    if (k > 0.12) {
      const dx = bow.x - nock.x
      const dy = bow.y - nock.y
      const dl = Math.hypot(dx, dy) || 1
      this.drawArrow(c, nock.x + (dx / dl) * T * 0.2, nock.y + (dy / dl) * T * 0.2, Math.atan2(dy, dx), T * 0.7 * Math.min(1, k + 0.3), U)
    }
    c.restore()
  }
}

export default function create(ctx: GameContext) {
  return new Archery(ctx)
}
