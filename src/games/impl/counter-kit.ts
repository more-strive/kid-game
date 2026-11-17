import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { outlineTxt, txt } from '@/core/draw'

/**
 * 计数游戏共享套件（移植 dongdongpark counter 引擎 + counter-text 检测器）：
 * 波形弹跳（跳绳）、深蹲、开合跳、高抬腿 四种检测器 + 统一计分外壳
 * （goal 三星线 / breakGap 连续段 / 每 10 个里程碑 / 6s 闲置提醒 / 平均节奏·最快10秒·最长连续 三统计）。
 * 所有几何量都直接从 lm（BlazePose 33）计算，站点框架层的 motion/events 用等价代理实现（见各检测器注释）。
 */

const LM = {
  lShoulder: 11, rShoulder: 12, lHip: 23, rHip: 24,
  lKnee: 25, rKnee: 26, lAnkle: 27, rAnkle: 28,
}

function vis(lm: { visibility?: number }[], i: number) {
  return Boolean(lm[i] && (lm[i].visibility ?? 1) >= 0.5)
}
void vis

/** 躯干长（肩中点到髋中点，归一化），下限防抖 */
function torsoOf(b: Body) {
  const shY = (b.lm[LM.lShoulder].y + b.lm[LM.rShoulder].y) / 2
  const hipY = (b.lm[LM.lHip].y + b.lm[LM.rHip].y) / 2
  return Math.max(0.06, Math.abs(hipY - shY))
}

interface RepResult {
  rep: boolean
  tip?: string
}

const NO_REP: RepResult = { rep: false }

/** 波形弹跳计数器（跳绳计数）：躯干中点 y 相对 EMA 中线的升-落周期 */
export class WaveCounter {
  static CFG = { minPtp: 0.04, band: 0.012, maxDip: 0.3, maxHigh: 0.8, minGap: 0.18, tau: 0.7 }
  mid = NaN
  hi = 0
  lo = 0
  high = false
  highAt = 0
  lastAt = -Infinity
  count = 0
  reset() {
    this.mid = NaN
    this.hi = this.lo = 0
    this.high = false
  }
  lost() {
    this.mid = NaN
    this.high = false
  }
  update(b: Body, t: number, dt: number): boolean {
    const cfg = WaveCounter.CFG
    const shY = (b.lm[LM.lShoulder].y + b.lm[LM.rShoulder].y) / 2
    const hipY = (b.lm[LM.lHip].y + b.lm[LM.rHip].y) / 2
    const sig = (shY + hipY) / 2
    const torso = torsoOf(b)
    if (!Number.isFinite(this.mid)) {
      this.mid = sig
      this.lo = this.hi = 0
      return false
    }
    const a = (this.mid - sig) / torso // 正 = 身体升高
    this.mid += (sig - this.mid) * (1 - Math.exp(-Math.max(0, dt) / cfg.tau))
    let rep = false
    if (this.high) {
      this.hi = Math.max(this.hi, a)
      if (a < -cfg.band) {
        if (this.hi - this.lo >= cfg.minPtp && -this.lo <= cfg.maxDip && t - this.highAt <= cfg.maxHigh && t - this.lastAt >= cfg.minGap) {
          rep = true
          this.count++
          this.lastAt = t
        }
        this.high = false
        this.lo = a
      }
    } else {
      this.lo = Math.min(this.lo, a)
      if (a > cfg.band) {
        this.high = true
        this.highAt = t
        this.hi = a
      }
    }
    return rep
  }
}

/** 深蹲计数器：蹲深代理 = 1 − (踝中y−髋中y)/(0.45×肩踝距)，站姿≈0、深蹲→1 */
export class SquatCounter {
  static DEEP = 0.5
  static ENTER = 0.2
  static EXIT = 0.15
  static QUALIFY = 0.45
  dipping = false
  peak = 0
  reset() {
    this.dipping = false
    this.peak = 0
  }
  lost() {
    this.reset()
  }
  private metric(b: Body) {
    const ankleY = (b.lm[LM.lAnkle].y + b.lm[LM.rAnkle].y) / 2
    const hipY = (b.lm[LM.lHip].y + b.lm[LM.rHip].y) / 2
    const shY = (b.lm[LM.lShoulder].y + b.lm[LM.rShoulder].y) / 2
    const span = Math.max(0.06, Math.abs(ankleY - shY)) // 肩踝距
    return Math.max(0, Math.min(1, 1 - Math.max(0, ankleY - hipY) / (0.45 * span)))
  }
  update(b: Body): RepResult {
    const squat = this.metric(b)
    if (!this.dipping && squat > SquatCounter.ENTER) {
      this.dipping = true
      this.peak = squat
    }
    if (this.dipping) this.peak = Math.max(this.peak, squat)
    // 站直（<0.15）结算一次蹲相：蹲到 QUALIFY 以上才算一个，0.5 以下提示「蹲低一点」
    if (this.dipping && squat < SquatCounter.EXIT) {
      this.dipping = false
      const peak = this.peak
      this.peak = 0
      if (peak >= SquatCounter.QUALIFY) {
        return { rep: true, tip: peak < SquatCounter.DEEP ? '蹲低一点' : undefined }
      }
      return { rep: false, tip: '蹲低一点' }
    }
    return NO_REP
  }
}

/** 开合跳计数器：张开（举双手+双脚分开）→ 收拢 = 一个；只跳腿/只举手超 0.5s 给纠正提示 */
export class JackCounter {
  static APART = 0.7 // 双踝横向距 ×肩踝距 超过算“跳开”
  static TOGETHER = 0.4
  static LEGS_ONLY_T = 0.5
  static ARMS_ONLY_T = 0.5
  open = false
  wasOpen = false
  legsOnlyT = 0
  armsOnlyT = 0
  reset() {
    this.open = this.wasOpen = false
    this.legsOnlyT = this.armsOnlyT = 0
  }
  lost() {
    this.reset()
  }
  private spread(b: Body) {
    const lx = b.lm[LM.lAnkle].x
    const rx = b.lm[LM.rAnkle].x
    const shY = (b.lm[LM.lShoulder].y + b.lm[LM.rShoulder].y) / 2
    const ankY = (b.lm[LM.lAnkle].y + b.lm[LM.rAnkle].y) / 2
    const span = Math.max(0.06, Math.abs(ankY - shY))
    return Math.abs(lx - rx) / span
  }
  update(b: Body, dt: number): RepResult {
    const sp = this.spread(b)
    const apart = sp > JackCounter.APART
    const together = sp < JackCounter.TOGETHER
    const armsUp = b.armsUp
    // 只跳腿 / 只举手质检（对齐站点 0.5s 计时）
    this.legsOnlyT = apart && !armsUp ? this.legsOnlyT + dt : 0
    this.armsOnlyT = armsUp && together ? this.armsOnlyT + dt : 0
    let tip: string | undefined
    if (this.legsOnlyT > JackCounter.LEGS_ONLY_T) {
      tip = '手举过头'
      this.legsOnlyT = 0
    } else if (this.armsOnlyT > JackCounter.ARMS_ONLY_T) {
      tip = '两脚跳开'
      this.armsOnlyT = 0
    }
    // 开→合 = 一个（开合跳事件代理）
    let rep = false
    if (!this.open && apart && armsUp) {
      this.open = true
      this.wasOpen = true
    } else if (this.open && together && !armsUp) {
      this.open = false
      rep = this.wasOpen
      this.wasOpen = false
    }
    return rep ? { rep: true, tip } : tip ? { rep: false, tip } : NO_REP
  }
}

/** 高抬腿计数器：滞回 UP/DOWN + 左右配对（pairMax）+ 同腿 0.25s 去抖 */
export class KneePairCounter {
  static UP = 0.6
  static DOWN = 0.45
  pairMax: number
  up = [false, false]
  at = [-9, -9]
  last: { leg: number; t: number } | null = null
  constructor(pairMax = 1.1) {
    this.pairMax = pairMax
  }
  reset() {
    this.last = null
  }
  lost() {
    this.reset()
  }
  private lift(b: Body, leg: 0 | 1) {
    const kneeI = leg === 0 ? LM.lKnee : LM.rKnee
    const hipY = (b.lm[LM.lHip].y + b.lm[LM.rHip].y) / 2
    const shY = (b.lm[LM.lShoulder].y + b.lm[LM.rShoulder].y) / 2
    const span = Math.max(0.06, Math.abs(hipY - shY))
    // 站姿时膝盖在髋下方 ~0.45，抬到髋高 ≈0.45、抬过髋更高：加 0.45 基准映射到站点的 0~1 标尺
    return Math.max(0, (hipY - b.lm[kneeI].y) / span + 0.45)
  }
  update(b: Body, t: number): RepResult {
    let rep = false
    let tip: string | undefined
    for (const leg of [0, 1] as const) {
      const lift = this.lift(b, leg)
      let fired = false
      if (!this.up[leg] && lift > KneePairCounter.UP) {
        this.up[leg] = true
        fired = true
      } else if (this.up[leg] && lift < KneePairCounter.DOWN) {
        this.up[leg] = false
      }
      if (!fired || t - this.at[leg] < 0.25) continue
      this.at[leg] = t
      const l = this.last
      if (l && l.leg !== leg && t - l.t <= this.pairMax) {
        rep = true
        this.last = null
      } else {
        if (l && l.leg === leg) tip = '左右交替'
        else if (l && t - l.t > this.pairMax) tip = '快一点！'
        this.last = { leg, t }
      }
    }
    return rep ? { rep: true, tip } : tip ? { rep: false, tip } : NO_REP
  }
}

export type CounterKind = 'rope' | 'squat' | 'jack' | 'knee'

/**
 * 计数游戏外壳（移植站点 counter 工厂）：goal 三星线、breakGap 连续段、
 * 逢 10 里程碑、6s 闲置提醒、2.5s 提示节流、平均节奏/最快10秒/最长连续 三统计、大数字 HUD。
 */
export abstract class CounterGame extends BaseGame implements Game {
  goal: number
  breakGap: number
  sound: 'tick' | 'score'
  kindLabel: string
  color: string
  counts = [0, 0]
  protected states = [
    { run: 0, bestRun: 0, best10: 0, lastAt: -Infinity, idleAt: 0, times: [] as number[], tip: '', tipUntil: 0, tipAt: -9, popAt: -9, star3: false },
    { run: 0, bestRun: 0, best10: 0, lastAt: -Infinity, idleAt: 0, times: [] as number[], tip: '', tipUntil: 0, tipAt: -9, popAt: -9, star3: false },
  ]
  protected started = false

  constructor(ctx: GameContext, kind: CounterKind, goal: number[], breakGap: number, color: string) {
    super(ctx)
    this.kindLabel = kind === 'rope' ? '跳绳' : kind === 'squat' ? '深蹲' : kind === 'jack' ? '开合跳' : '高抬腿'
    this.goal = goal[ctx.difficulty] ?? goal[1]
    this.breakGap = breakGap
    this.sound = kind === 'rope' ? 'tick' : 'score'
    this.color = color
  }

  private present() {
    return this.players.filter((p) => p.body).length
  }

  protected abstract detector(pi: number): { lost(): void; reset(): void }
  protected abstract step(b: Body, pi: number, t: number, dt: number): RepResult

  tick(f: PoseFrame, dt: number) {
    if (!this.started) {
      this.started = true
      this.ctx.audio.play('win', 0.6, 1)
      this.ctx.speak(`${this.kindLabel}，开始！`)
      this.ctx.setStage(`${this.kindLabel}，开始！`)
    }
    for (let pi = 0; pi < 2; pi++) {
      const b = f.bodies[pi]
      const s = this.states[pi]
      if (!b) {
        this.detector(pi)?.lost?.()
        continue
      }
      const t = this.t
      const r = this.step(b, pi, t, dt)
      if (r.tip && t - s.tipAt > 2.5) {
        s.tipAt = t
        s.tip = r.tip
        s.tipUntil = t + 1.6
        this.ctx.audio.play('click', 0.6, 0.8)
      }
      if (r.rep) {
        const c = ++this.counts[pi]
        s.run = t - s.lastAt <= this.breakGap ? s.run + 1 : 1
        s.bestRun = Math.max(s.bestRun, s.run)
        s.lastAt = t
        s.idleAt = t
        s.times.push(t)
        s.best10 = Math.max(s.best10, s.times.filter((x) => x > t - 10).length)
        s.popAt = this.realClock
        const gain = c
        this.ctx.addScore(1)
        void gain
        this.ctx.audio.play(this.sound, 1, 1 + Math.min(0.5, (c % 50) * 0.01))
        if (c === this.goal && !s.star3) {
          s.star3 = true
          this.sayText('三星！')
          this.ctx.audio.good()
          this.particles.burst(this.W / 2, this.H / 2, '#ffd54a', 24, 420, 6)
        } else if (c % 10 === 0) {
          this.sayText(`${c} 个！`)
          this.ctx.audio.good()
        }
        if (r.tip) this.showTip(pi, r.tip, t)
      }
      if (t - s.idleAt > 6) {
        s.idleAt = t
        this.showTip(pi, this.counts[pi] ? '接着来！' : '开始吧！', t)
      }
      if (s.tipUntil && t > s.tipUntil) s.tip = ''
    }
    const best = Math.max(...this.counts)
    this.ctx.setCombo(best)
    this.ctx.setExtra('最快10秒', Math.max(this.states[0].best10, this.states[1].best10))
    this.ctx.setExtra('最长连续', Math.max(this.states[0].bestRun, this.states[1].bestRun))
  }

  private showTip(pi: number, text: string, t: number) {
    void t
    const b = this.players[pi].body
    if (!b) return
    this.say(text, b.shoulderC.x * this.W, (b.shoulderC.y - 0.18) * this.H, '#ff8a8a', 30)
  }

  private bannerText = ''
  private bannerT = 0
  private realClock = 0

  private sayText(text: string) {
    this.bannerText = text
    this.bannerT = 1.4
  }

  /** 近 10 秒每分钟节奏（对齐站点口径） */
  protected pace(pi: number) {
    const s = this.states[pi]
    const n = Math.min(10, this.t)
    if (n < 3 || this.counts[pi] < 3) return 0
    return Math.round((s.times.filter((x) => x > this.t - n).length / n) * 60)
  }

  update(f: PoseFrame, dt: number) {
    this.realClock += dt
    this.bannerT = Math.max(0, this.bannerT - dt)
    super.update(f, dt)
  }

  paint(c: CanvasRenderingContext2D) {
    // 大数字 + 节奏副标题（对齐站点 HUD）
    const duo = this.players.some((p) => p.body) && this.present() > 1
    for (let pi = 0; pi < 2; pi++) {
      const st = this.states[pi]
      if (!this.players[pi].body) continue
      const hPos = duo ? (pi === 0 ? this.W * 0.25 : this.W * 0.75) : this.W * 0.14
      const vPos = duo ? this.H * 0.4 : this.H * 0.3
      const pop = 1 + 0.3 * Math.max(0, Math.min(1, 1 - (this.realClock - st.popAt) / 0.25))
      c.save()
      c.translate(hPos, vPos)
      c.scale(pop, pop)
      outlineTxt(c, String(this.counts[pi]), 0, 0, 110, this.color)
      c.restore()
      const pace = this.pace(pi)
      txt(c, pace ? `${this.kindLabel} · 每分钟 ${pace} 个` : `${this.kindLabel} · 个`, hPos, vPos + 72, 22, 'rgba(255,255,255,.75)', 'center', 'bold')
      if (st.tip) {
        const b = this.players[pi].body
        if (b) outlineTxt(c, st.tip, b.shoulderC.x * this.W, (b.shoulderC.y - 0.18) * this.H, 38, '#ff8a8a')
      }
    }
    if (this.bannerT > 0) {
      c.globalAlpha = Math.min(1, this.bannerT / 0.3)
      outlineTxt(c, this.bannerText, this.W / 2, this.H * 0.22, 48, '#ffd54a')
      c.globalAlpha = 1
    }
    txt(c, this.hint(), this.W / 2, this.H - 30, 20, 'rgba(255,255,255,.8)', 'center', 'bold')
  }

  protected abstract hint(): string
}
