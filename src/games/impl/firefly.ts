import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, LM, PoseFrame } from '@/core/types'
import { circle, emoji, glow, ring, rr, star, txt } from '@/core/draw'

/**
 * 捉萤火虫（对齐 dongdongpark 真实规则，见 _reverse/reports/firefly.md）：
 * 张开手（抬到髋以上）罩住一只并停住（cover ≥ hold）→ 它发光（白环倒计时 win 窗口）→
 * 握拳 ≥0.12s（近似握拳 ≥0.2s 兜底）→ 收进瓶子 +1；手速超 scare（躯干/s）会把萤火虫吓跑。
 * 生命周期 enter→wander→ready→caught / flee→leave；框架无手势识别，
 * 握拳用 lm 指尖-腕距/前臂长 比值近似（张手 ≈0.6~0.9，握拳 ≈0.3~0.45）。
 */

type FlyState = 'enter' | 'wander' | 'ready' | 'gone' | 'leave'

/** 对齐站点难度表：巡航速度/寿命/罩住时长/发光窗口/受惊门槛/同屏上限/刷新间隔/捕捉半径加成 */
const DIFF = [
  { speed: 40, life: 16, hold: 0.3, win: 2.6, scare: 3.8, max: 3, every: 1.8, reach: 44 },
  { speed: 60, life: 12, hold: 0.4, win: 2, scare: 3, max: 3, every: 2.2, reach: 38 },
  { speed: 88, life: 9, hold: 0.55, win: 1.4, scare: 2.6, max: 4, every: 2, reach: 32 },
]

const FIST_T = 0.12 // te：有效握拳最短持续
const FIST_SOFT_T = 0.2 // ne：近似握拳兜底（拇指/≤1 指也算）持续
const LOST_T = 0.5 // re：发光中手丢失 >0.5s → 回漫游
const MIN_TORSO = 110 // ie：速度归一化最小躯干像素（防远距离玩家手速虚高）
const FLEE_T = 0.8 // ae：受惊逃离时长
const SHY_T = 0.7 // oe：受惊后的害羞冷却（不可捕捉）
const FLY_T = 0.75 // x：捕捉成功飞向瓶子时长
const SCARE_K = 1.7 // S：受惊判定半径 = (手半径+reach)×1.7
const HAND_R = 20 // 手关键点半径
const HEAT_UP = 0.3 // 受热提速
const HEAT_LIFE = 0.2 // 受热缩寿命
const HEAT_EVERY = 0.25 // 受热缩刷新间隔
const AIM_HINT = 8 // 8s 未罩住任何萤火虫 → 最近目标上显示张手提示

/** 四色发光（55%/20%/17%/8% 纯装饰，不分值） */
const COLORS = ['#ffe066', '#b5ff5c', '#7ae2ff', '#ffa8e0']

interface Fly {
  owner: number
  color: string
  x: number
  y: number
  wx: number
  wy: number // 当前航点
  speed: number
  state: FlyState
  age: number
  life: number
  cover: number // 罩住累积（秒）
  shy: number // >0 不可捕捉
  stateT: number // 当前状态时长
  fleeT: number // 受惊逃离剩余（>0 时 4× 速度）
  hand: 0 | 1 // ready 锁定的手
  kT: number // fist 连续秒数（ready 起累积，防提前握拳骗判）
  aT: number // 近似握拳连续秒数
  lostT: number // ready 手丢失累计
  phase: number // 闪烁相位
  sx: number
  sy: number // caught 入瓶起点
  ct: number // caught 动画进度 0~1
}

interface PState {
  spawnT: number
  jar: number // 瓶中只数
  jarPop: number
  tries: number // 吓跑次数
  speakScare: number // 「轻一点」语音限 2 次
  timeoutHints: number // 「亮了就要握拳哦」最多 2 次
  noCoverT: number // 未罩住计时（瞄准提示）
  streak: number // 连续捕捉（吓跑/超时清零）
  passOnce: boolean // easy 识别失败直接放行一次
  fastest: number // 最快一只（秒，罩住→握拳）
}

function newPS(): PState {
  return {
    spawnT: 0.8,
    jar: 0,
    jarPop: 0,
    tries: 0,
    speakScare: 0,
    timeoutHints: 0,
    noCoverT: 0,
    streak: 0,
    passOnce: false,
    fastest: 0,
  }
}

type Gest = 'fist' | 'soft' | 'open' | 'none'

/**
 * 手势近似识别：腕(15/16)-肘(13/14) 作前臂长基准，
 * 食指/小指/拇指尖(19/20,17/18,21/22) 到腕的平均距离 ÷ 前臂长：
 * 张手 ≈0.6~0.9、握拳 ≈0.3~0.45 → <0.48 判握拳、<0.62 判近似握拳。
 */
function gestureOf(lm: LM[], side: 0 | 1): Gest {
  const wr = lm[side === 0 ? 15 : 16]
  const el = lm[side === 0 ? 13 : 14]
  const tips = side === 0 ? [19, 17, 21] : [20, 18, 22]
  if (!wr || !el || (wr.visibility ?? 1) < 0.5 || (el.visibility ?? 1) < 0.5) return 'none'
  const arm = Math.hypot(wr.x - el.x, wr.y - el.y)
  if (arm < 0.02) return 'none'
  let sum = 0
  let n = 0
  for (const i of tips) {
    const p = lm[i]
    if (!p || (p.visibility ?? 1) < 0.5) continue
    sum += Math.hypot(p.x - wr.x, p.y - wr.y)
    n++
  }
  if (n === 0) return 'none'
  const ratio = sum / n / arm
  if (ratio < 0.48) return 'fist'
  if (ratio < 0.62) return 'soft' // 近似握拳兜底
  return 'open'
}

class Firefly extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  flies: Fly[] = []
  st: PState[] = [newPS(), newPS()]
  score = 0
  /** 儿童档辅助（站点 ageMin 3 低龄玩家）：手势识别失败直接放行一次 */
  private get easy() {
    return this.ctx.difficulty === 0
  }
  /** 夜空装饰（构造时固定，避免每帧随机跳动） */
  stars = Array.from({ length: 30 }, () => ({ x: Math.random(), y: Math.random() * 0.6, r: 1 + Math.random() * 1.6, ph: Math.random() * 6 }))
  blooms = Array.from({ length: 14 }, () => ({ x: Math.random(), y: 0.1 + Math.random() * 0.65, r: 20 + Math.random() * 34, ph: Math.random() * 6, c: Math.random() < 0.5 ? '#ffe066' : '#7ae2ff' }))
  grass = Array.from({ length: 26 }, (_, i) => ({ x: (i + Math.random() * 0.7) / 26, h: 40 + Math.random() * 60, lean: Math.random() * 0.5 - 0.25 }))

  private unit() {
    return this.H / 720
  }

  private present() {
    return this.players.filter((p) => p.body).length
  }

  private zone(pi: number) {
    if (this.present() <= 1) return { x0: this.W * 0.08, x1: this.W * 0.92 }
    return pi === 0 ? { x0: this.W * 0.03, x1: this.W * 0.47 } : { x0: this.W * 0.53, x1: this.W * 0.97 }
  }

  private heat() {
    return Math.min(1, this.t / 60)
  }

  private torsoPx(b: Body) {
    return Math.max(MIN_TORSO, b.scale * this.H * 0.5)
  }

  /** 活动区：基区（区中心 ±32%/27% 宽，y 0.23~0.54H）按身体姿态修正，萤火虫始终飞到孩子够得着的高度 */
  private targetArea(pi: number, b: Body | null) {
    const z = this.zone(pi)
    const zx = (z.x0 + z.x1) / 2
    const half = (this.present() > 1 ? 0.32 : 0.27) * (z.x1 - z.x0)
    let x0 = zx - half
    let x1 = zx + half
    let y0 = this.H * 0.23
    let y1 = this.H * 0.54
    if (b) {
      const torso = this.torsoPx(b)
      const shX = b.shoulderC.x * this.W
      // x ∈ 肩 ±2.6×躯干
      x0 = Math.max(x0, shX - 2.6 * torso)
      x1 = Math.min(x1, shX + 2.6 * torso)
      // y ∈ [肩-1.1×躯干, 髋-0.3×躯干]，过窄时放宽
      const sy = b.shoulderC.y * this.H
      const hy = b.hipC.y * this.H
      if (hy - 0.3 * torso - (sy - 1.1 * torso) > 0.5 * torso) {
        y0 = Math.max(y0, sy - 1.1 * torso)
        y1 = Math.min(y1, hy - 0.3 * torso)
      } else {
        y0 = this.H * 0.12
        y1 = this.H * 0.82
      }
    }
    if (x1 - x0 < 60) {
      x0 = zx - 30
      x1 = zx + 30
    }
    if (y1 - y0 < 60) {
      y0 = this.H * 0.3
      y1 = this.H * 0.6
    }
    return { x0: Math.max(z.x0 + 20, x0), x1: Math.min(z.x1 - 20, x1), y0, y1 }
  }

  private randPoint(area: { x0: number; x1: number; y0: number; y1: number }) {
    return { x: area.x0 + Math.random() * (area.x1 - area.x0), y: area.y0 + Math.random() * (area.y1 - area.y0) }
  }

  /** 从屏幕底部 H×0.9 进入，飞向活动区航点 */
  private spawnFly(pi: number) {
    const b = this.players[pi].body
    const area = this.targetArea(pi, b)
    const z = this.zone(pi)
    const w = this.randPoint(area)
    const r = Math.random()
    const color = r < 0.55 ? COLORS[0] : r < 0.75 ? COLORS[1] : r < 0.92 ? COLORS[2] : COLORS[3]
    const heat = this.heat()
    this.flies.push({
      owner: pi,
      color,
      x: z.x0 + Math.random() * (z.x1 - z.x0),
      y: this.H * 0.9,
      wx: w.x,
      wy: w.y,
      speed: this.cfg.speed * this.unit() * (1 + HEAT_UP * heat),
      state: 'enter',
      age: 0,
      life: this.cfg.life * (0.85 + Math.random() * 0.3) * (1 - HEAT_LIFE * heat),
      cover: 0,
      shy: 0,
      stateT: 0,
      fleeT: 0,
      hand: 0,
      kT: 0,
      aT: 0,
      lostT: 0,
      phase: Math.random() * 6,
      sx: 0,
      sy: 0,
      ct: 0,
    })
  }

  private handPos(b: Body, hi: 0 | 1) {
    const h = hi === 0 ? b.lHand : b.rHand
    return { x: h.x * this.W, y: h.y * this.H }
  }

  private jarPos(pi: number) {
    const z = this.zone(pi)
    const w = z.x1 - z.x0
    return { x: this.present() > 1 && pi === 1 ? z.x1 - w * 0.84 : z.x0 + w * 0.84, y: this.H * 0.88 }
  }

  /** 受惊：手在 ×1.7 半径内且手速超 scare（躯干/s）→ 4× 速度逃离 */
  private tryScare(f: Fly, pi: number) {
    const st = this.st[pi]
    const b = this.players[pi].body
    if (!b || f.shy > 0) return
    const torsoPx = this.torsoPx(b)
    const reach = this.cfg.reach * this.unit()
    const r = (HAND_R + reach) * SCARE_K
    for (const hi of [0, 1] as const) {
      const p = this.handPos(b, hi)
      const v = hi === 0 ? b.lHandV : b.rHandV
      const speedTorso = (v * this.H) / torsoPx
      if (speedTorso > this.cfg.scare && Math.hypot(p.x - f.x, p.y - f.y) < r) {
        // 逃离 = wander + fleeT 计时（>0 时 4× 速度）
        f.state = 'wander'
        f.fleeT = FLEE_T
        f.shy = SHY_T
        f.cover = 0
        const area = this.targetArea(pi, b)
        // 逃向远离该手的一侧航点
        const away = this.randPoint(area)
        if (Math.abs(away.x - p.x) < Math.abs(f.x - p.x)) {
          away.x = p.x + (p.x - away.x)
        }
        f.wx = Math.min(area.x1, Math.max(area.x0, away.x))
        f.wy = away.y
        st.tries++
        st.streak = 0
        this.ctx.audio.slash() // whoosh
        this.say('轻一点～', f.x, f.y - 40 * this.unit(), '#ffe066', 40)
        if (st.speakScare < 2) {
          st.speakScare++
          this.ctx.speak('轻一点，萤火虫吓跑了')
        }
        return
      }
    }
  }

  /** 罩住判定：手抬到髋以上且距萤 < 手半径+reach → cover 累积（断开 1.5× 速度消退） */
  private updateCover(f: Fly, pi: number) {
    const st = this.st[pi]
    const b = this.players[pi].body
    if (!b) {
      f.cover = Math.max(0, f.cover - 1.5 * this.lastDt)
      return
    }
    const torso = Math.max(0.06, b.scale)
    const reach = this.cfg.reach * this.unit()
    const hipLine = b.hipC.y - 0.1 * torso
    let covering: 0 | 1 | null = null
    for (const hi of [0, 1] as const) {
      const p = this.handPos(b, hi)
      const h = hi === 0 ? b.lHand : b.rHand
      if (h.y < hipLine && Math.hypot(p.x - f.x, p.y - f.y) < HAND_R + reach) {
        covering = hi
        break
      }
    }
    if (covering !== null && f.shy <= 0) {
      f.cover += this.lastDt
      st.noCoverT = 0
      // cover ≥ hold → 发光（需 age < life-1.2，寿命将尽的不可瞄准）
      if (f.cover >= this.cfg.hold && f.age < f.life - 1.2) {
        f.state = 'ready'
        f.stateT = 0
        f.hand = covering
        f.kT = 0
        f.aT = 0
        f.lostT = 0
        this.ctx.audio.good() // sparkle
        glowFx(this, f.x, f.y, f.color)
      }
    } else {
      f.cover = Math.max(0, f.cover - 1.5 * this.lastDt)
    }
  }

  /** ready → 握拳捕捉 / 超时 / 手丢失 */
  private updateReady(f: Fly, pi: number, dt: number) {
    const st = this.st[pi]
    const b = this.players[pi].body
    // 萤火虫以 8/s 插值吸附在手上
    if (b) {
      const p = this.handPos(b, f.hand)
      f.x += (p.x - f.x) * Math.min(1, 8 * dt)
      f.y += (p.y - f.y) * Math.min(1, 8 * dt)
      const g = b.lm.length > 22 ? gestureOf(b.lm, f.hand) : 'none'
      if (g === 'fist') {
        f.kT += dt
        f.aT += dt
        f.lostT = 0
      } else if (g === 'soft') {
        f.aT += dt
        f.kT = 0
        f.lostT = 0
      } else if (g === 'open') {
        f.kT = 0
        f.aT = 0
        f.lostT = 0
      } else {
        // 识别不出手势：easy 直接放行一次；否则当接近丢失处理
        f.kT = 0
        f.aT = 0
        if (this.easy && !st.passOnce && f.stateT > 1) {
          st.passOnce = true
          this.catchFly(f, pi)
          this.say('站近一点，握拳更容易认出来', f.x, f.y - 60 * this.unit(), '#9be29b', 28)
          return
        }
        f.lostT += dt
      }
      // 握拳 ≥0.12s（或近似 ≥0.2s）→ 捕捉
      if (f.kT >= FIST_T || f.aT >= FIST_SOFT_T) {
        this.catchFly(f, pi)
        return
      }
    } else {
      f.lostT += dt
    }
    // 手丢失 >0.5s → 回漫游
    if (f.lostT > LOST_T) {
      f.state = 'wander'
      f.stateT = 0
      f.cover = 0
      f.shy = 0.5
      return
    }
    // 超时：回漫游（shy 0.5s），提示最多 2 次
    if (f.stateT >= this.cfg.win) {
      f.state = 'wander'
      f.stateT = 0
      f.cover = 0
      f.shy = 0.5
      this.ctx.audio.play('pop', 0.5, 0.6) // boop
      if (st.timeoutHints < 2) {
        st.timeoutHints++
        this.say('亮了就要握拳哦', f.x, f.y - 50 * this.unit(), '#7ae2ff', 30)
      }
    }
  }

  private catchFly(f: Fly, pi: number) {
    const st = this.st[pi]
    const held = f.stateT // 从罩住到握拳的秒数
    f.state = 'gone'
    f.stateT = 0
    f.ct = 0
    f.sx = f.x
    f.sy = f.y
    this.score++
    st.streak++
    st.fastest = st.fastest === 0 ? held : Math.min(st.fastest, held)
    this.ctx.audio.pop()
    const u = this.unit()
    this.particles.burst(f.x, f.y, f.color, 10, 300 * u, 5 * u)
    this.say('+1', f.x, f.y - 30 * u, '#fff', 32)
  }

  lastDt = 0.016

  tick(_f: PoseFrame, dt: number) {
    this.lastDt = Math.max(0.001, dt)
    const heat = this.heat()
    // 刷新：每玩家独立，max 只上限；场上没有时 ×0.5 加速补（缺席玩家不刷）
    for (let pi = 0; pi < 2; pi++) {
      const st = this.st[pi]
      if (st.jarPop > 0) st.jarPop -= dt
      if (!this.players[pi].body) continue
      const mine = this.flies.filter((f) => f.owner === pi && f.state !== 'gone' && f.state !== 'leave')
      st.spawnT -= dt
      if (st.spawnT <= 0) {
        if (mine.length < this.cfg.max) {
          const empty = mine.length === 0
          this.spawnFly(pi)
          st.spawnT = this.cfg.every * (1 - HEAT_EVERY * heat) * (0.7 + Math.random() * 0.6) * (empty ? 0.5 : 1)
        } else {
          st.spawnT = 0.3
        }
      }
    }

    for (const f of this.flies) {
      const pi = f.owner
      const st = this.st[pi]
      const b = this.players[pi].body
      f.age += dt
      f.stateT += dt
      f.shy = Math.max(0, f.shy - dt)

      if (f.state === 'gone') {
        // 0.75s 贝塞尔飞进瓶子
        f.ct += dt / FLY_T
        if (f.ct >= 1) {
          st.jar++
          st.jarPop = 0.4
          this.ctx.audio.play('score', 0.9, 1 + (st.jar % 6) * 0.08) // chime 上行
        }
        continue
      }
      if (f.state === 'leave') {
        // 寿命尽向上飞出屏幕
        f.y -= 150 * this.unit() * dt
        f.x += Math.sin(f.age * 3 + f.phase) * 30 * this.unit() * dt
        continue
      }

      // 受惊检测（wander/enter）
      if (f.state === 'wander' || f.state === 'enter') this.tryScare(f, pi)

      if (f.state === 'ready') {
        this.updateReady(f, pi, dt)
        continue
      }

      // 移动：航点制；受惊逃离期 4× 速度
      f.fleeT = Math.max(0, f.fleeT - dt)
      const mult = f.fleeT > 0 ? 4 : 1
      const dx = f.wx - f.x
      const dy = f.wy - f.y
      const d = Math.hypot(dx, dy) || 1
      const sp = f.speed * mult
      f.x += (dx / d) * sp * dt
      f.y += (dy / d) * sp * dt
      if (d < 14 * this.unit()) {
        if (f.state === 'enter') {
          f.state = 'wander'
          f.stateT = 0
        }
        const area = this.targetArea(pi, b)
        const w = this.randPoint(area)
        f.wx = w.x
        f.wy = w.y
      }
      // enter 2.5s 未进入则转 wander
      if (f.state === 'enter' && f.stateT > 2.5) {
        f.state = 'wander'
        f.stateT = 0
        const area = this.targetArea(pi, b)
        const w = this.randPoint(area)
        f.wx = w.x
        f.wy = w.y
      }
      // 罩住累积（漫游态）
      if (f.state === 'wander' && f.shy <= 0) this.updateCover(f, pi)
      else if (f.state === 'wander') f.cover = Math.max(0, f.cover - 1.5 * dt)
      // 寿命尽（无罩住）→ 向上飞走
      if (f.state === 'wander' && f.age > f.life && f.cover <= 0) f.state = 'leave'
    }
    this.flies = this.flies.filter((f) => {
      if (f.state === 'gone') return f.ct < 1
      if (f.state === 'leave') return f.y > -60
      return true
    })

    const s0 = this.st[0]
    const s1 = this.st[1]
    // 8s 未罩住任何漫游萤火虫 → 瞄准提示（每玩家计时，需在场）
    for (let pi = 0; pi < 2; pi++) {
      const st = this.st[pi]
      const covered = this.flies.some((f) => f.owner === pi && f.cover > 0)
      if (covered) st.noCoverT = 0
      else if (this.players[pi].body) st.noCoverT += dt
    }
    this.ctx.setScore(this.score)
    this.ctx.setCombo(Math.max(s0.streak, s1.streak))
    this.ctx.setExtra('吓跑了', s0.tries + s1.tries)
    const fastest = Math.min(s0.fastest || 99, s1.fastest || 99)
    this.ctx.setExtra('最快一只(秒)', fastest === 99 ? 0 : Math.round(fastest * 10) / 10)
  }

  paint(c: CanvasRenderingContext2D) {
    const u = this.unit()
    // 夜空渐变遮罩（顶部深蓝 0.9 → 底部青 0.74）
    const g = c.createLinearGradient(0, 0, 0, this.H)
    g.addColorStop(0, 'rgba(16,24,72,.9)')
    g.addColorStop(1, 'rgba(20,90,110,.74)')
    c.fillStyle = g
    c.fillRect(0, 0, this.W, this.H)

    c.save()
    c.globalCompositeOperation = 'lighter'
    // 30 颗闪烁星星
    for (const s of this.stars) {
      const a = 0.4 + 0.4 * Math.sin(this.t * 2 + s.ph)
      c.globalAlpha = Math.max(0.1, a)
      circle(c, s.x * this.W, s.y * this.H, s.r * u, '#fff6d8')
    }
    c.globalAlpha = 1
    // 14 团远景萤火光雾
    for (const bl of this.blooms) {
      const a = 0.05 + 0.05 * Math.sin(this.t * 1.3 + bl.ph)
      glow(c, bl.x * this.W, bl.y * this.H, bl.r * u, bl.c, a)
    }
    // 月亮
    glow(c, this.W * 0.88, this.H * 0.14, 110 * u, '#fff3c4', 0.35)
    c.globalCompositeOperation = 'source-over'
    circle(c, this.W * 0.88, this.H * 0.14, 34 * u, '#fff3c4')
    c.globalAlpha = 0.25
    circle(c, this.W * 0.88 - 12 * u, this.H * 0.14 - 6 * u, 26 * u, 'rgba(16,24,72,.9)')
    c.globalAlpha = 1
    c.restore()

    // 草丛剪影
    c.fillStyle = 'rgba(10,30,26,.85)'
    for (const bl of this.grass) {
      const x = bl.x * this.W
      const h = bl.h * u
      c.beginPath()
      c.moveTo(x - 7 * u, this.H)
      c.quadraticCurveTo(x + bl.lean * 40 * u, this.H - h, x + bl.lean * 60 * u, this.H - h * 0.86)
      c.quadraticCurveTo(x + bl.lean * 40 * u + 8 * u, this.H - h * 0.5, x + 9 * u, this.H)
      c.closePath()
      c.fill()
    }

    // 萤火虫
    for (const f of this.flies) {
      const bobY = Math.sin(this.t * 2.2 + f.phase) * 6 * u
      const fx = f.x
      const fy = f.y + bobY
      if (f.state === 'gone') {
        // 飞向瓶子的贝塞尔
        const jp = this.jarPos(f.owner)
        const mx = (f.sx + jp.x) / 2
        const my = Math.min(f.sy, jp.y) - 90 * u
        const p = Math.min(1, f.ct)
        const q = 1 - p
        const x = q * q * f.sx + 2 * q * p * mx + p * p * jp.x
        const y = q * q * f.sy + 2 * q * p * my + p * p * jp.y
        c.save()
        c.globalCompositeOperation = 'lighter'
        glow(c, x, y, 34 * u, f.color, 0.7)
        circle(c, x, y, 4 * u, '#fff')
        c.restore()
        continue
      }
      const pulse = 0.55 + 0.3 * Math.sin(this.t * 3 + f.phase)
      c.save()
      c.globalCompositeOperation = 'lighter'
      glow(c, fx, fy, (f.state === 'ready' ? 46 : 30) * u, f.color, f.state === 'ready' ? 0.85 : pulse)
      c.globalCompositeOperation = 'source-over'
      circle(c, fx, fy, 4.5 * u, '#fffbe6')
      c.restore()

      if (f.state === 'ready') {
        // 白色倒计时圆环（顺时针收缩）
        const pct = Math.max(0, 1 - f.stateT / this.cfg.win)
        ring(c, fx, fy, 46 * u, pct, '#fff', 5 * u)
        // 拳形提示（弹跳出现）+ 4 颗绕圈小星
        const pop = Math.min(1, f.stateT / 0.2)
        const s = (0.6 + 0.4 * pop) * (1 + Math.sin(f.stateT * 10) * 0.08)
        c.save()
        c.translate(fx, fy - 84 * u)
        c.scale(s, s)
        emoji(c, '✊', 0, 0, 76 * u)
        c.restore()
        for (let i = 0; i < 4; i++) {
          const a = this.t * 3 + (i * Math.PI) / 2
          star(c, fx + Math.cos(a) * 62 * u, fy + Math.sin(a) * 62 * u, 5 * u, '#fff')
        }
      } else if (f.state === 'wander' && f.cover > 0) {
        // 罩住进度环（白色进度圈）
        ring(c, fx, fy, 36 * u, Math.min(1, f.cover / this.cfg.hold), '#fff', 4 * u)
      }
    }

    // 瞄准提示：8s 未罩住 → 最近漫游目标上显示张手图标
    for (let pi = 0; pi < 2; pi++) {
      const st = this.st[pi]
      if (st.noCoverT < AIM_HINT) continue
      let near: Fly | null = null
      let bestD = Infinity
      const b = this.players[pi].body
      const ref = b ? this.handPos(b, 0) : { x: this.W / 2, y: this.H / 2 }
      for (const f of this.flies) {
        if (f.owner !== pi || f.state !== 'wander' || f.shy > 0) continue
        const d = Math.hypot(f.x - ref.x, f.y - ref.y)
        if (d < bestD) {
          bestD = d
          near = f
        }
      }
      if (!near) continue
      const a = 0.6 + 0.4 * Math.sin(this.t * 5)
      c.save()
      c.globalAlpha = a
      emoji(c, '✋', near.x, near.y - 64 * u, 44 * u)
      c.globalAlpha = 1
      txt(c, '张开手，轻轻罩住它', near.x, near.y - 100 * u, 20 * u, 'rgba(255,255,255,.85)')
      c.restore()
    }

    // 瓶子（每玩家，瓶内发光数 = 已捉只数）
    for (let pi = 0; pi < 2; pi++) {
      const st = this.st[pi]
      if (pi === 1 && !this.players[pi].body && this.present() > 0) continue
      this.drawJar(c, this.jarPos(pi), st, u)
    }

    txt(c, '张开手轻轻罩住萤火虫，停一下等它发光，再握拳收进瓶子里；手挥快了会吓跑它', this.W / 2, this.H - 30, 20, 'rgba(255,255,255,.8)', 'center', 'bold')
  }

  /** 玻璃瓶：瓶内萤火虫越多光越亮（min(1, 0.35+count/12) 光晕） */
  private drawJar(c: CanvasRenderingContext2D, p: { x: number; y: number }, st: PState, u: number) {
    const pop = st.jarPop > 0 ? 1 + Math.sin((st.jarPop / 0.4) * Math.PI) * 0.12 : 1
    c.save()
    c.translate(p.x, p.y)
    c.scale(pop, pop)
    if (st.jar > 0) glow(c, 0, -10 * u, 90 * u, '#ffe066', Math.min(1, 0.35 + st.jar / 12) * 0.4)
    rr(c, -34 * u, -46 * u, 68 * u, 96 * u, 16 * u)
    c.fillStyle = 'rgba(210,240,255,.16)'
    c.fill()
    c.strokeStyle = 'rgba(230,245,255,.5)'
    c.lineWidth = 3 * u
    c.stroke()
    // 瓶口
    rr(c, -20 * u, -62 * u, 40 * u, 18 * u, 6 * u)
    c.fillStyle = '#8a6a3a'
    c.fill()
    // 瓶内萤火虫
    for (let i = 0; i < st.jar; i++) {
      const a = i * 2.4
      const fx = Math.sin(a * 1.7 + this.t * (0.6 + (i % 3) * 0.25)) * 18 * u
      const fy = -8 * u + Math.cos(a * 2.3 + this.t * 0.5) * 30 * u
      c.save()
      c.globalCompositeOperation = 'lighter'
      glow(c, fx, fy, 15 * u, COLORS[i % COLORS.length], 0.6)
      c.restore()
      circle(c, fx, fy, 3 * u, '#fffbe6')
    }
    if (st.jar > 0) txt(c, `${st.jar}`, 0, 64 * u, 26 * u, '#fff')
    c.restore()
  }
}

/** 发光瞬间的小白环特效（用粒子近似站点 sparkle + 白环） */
function glowFx(g: Firefly, x: number, y: number, color: string) {
  g.particles.burst(x, y, color, 6, 160, 3, 0)
  g.particles.burst(x, y, '#ffffff', 4, 120, 2.5, 0)
}

export default function create(ctx: GameContext) {
  return new Firefly(ctx)
}
