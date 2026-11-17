import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, emoji, glow, outlineTxt, txt } from '@/core/draw'

/**
 * 跨栏赛（对齐 dongdongpark 真实规则，逆向报告 _reverse/reports/hurdles.md）：
 * 各就位→预备→跑！原地全力跑驱动小人沿 110 米跑道前进；栏架碰到黄色判定线时跳起
 * （滞空时间 = win），跨过 +特效，碰栏大幅减速；单人与 🤖 电脑竞速。
 * 分数 = 100 × 平均速度：完赛 round(11000/用时)，未完赛 round(100×距离/用时)。
 *
 * 站点框架行为等价代理说明：
 * - motion.run（0~1 跑步强度）：双膝相对髋的抬升量折算（站立≈0、高抬腿≈1），τ=0.12 平滑。
 * - motion.stepRate（步/秒）：双膝抬升沿频率（1s 滑窗），≥3 步/秒触发 +10% 速度加成。
 * - events.has('jump') → body.jumping 上升沿；髋基线抬升通道（>0.2×torso，回落<0.08 复位，
 *   基线自适应：下落快(hipV>0.25)时 τ 快）与站点一致。
 * - 抢跑检测：run>0.2 持续 ≥0.2s（fsT），照抄报告。
 * - 报告 §8 的 AI 演示位（双人时 AI 故意抢跑）与逐栏起跳扰动表仅作用于站点 AI 槽位，
 *   本框架双人都是真人，不实现。
 * - 音效映射：crack→play('hit',高倍率)（发令枪）、whoosh→jump、thud→hit、whistle/tada 同名。
 * - 音乐 run：BGM 由外壳统一管理。duration=0（比赛制）：跑完/超时由本游戏调用 finish()。
 */

// ---- 难度表 p（报告 §1 全部字面量） ----
const DIFF = [
  { gain: 2.3, setWait: [1.2, 2.2], count: 6, first: 18, gap: 14, win: 0.55, cpu: 6.6, cpuMiss: 0.25 },
  { gain: 2, setWait: [1.5, 3], count: 8, first: 16, gap: 11, win: 0.4, cpu: 7.3, cpuMiss: 0.15 },
  { gain: 1.7, setWait: [1.8, 3.6], count: 10, first: 13.72, gap: 9.14, win: 0.32, cpu: 7.9, cpuMiss: 0.1 },
]
const RACE_M = 110 // m：赛程 110 米
const VMAX = 8 // h：速度上限基数（步频加成后 8.8）
const TIMEOUT = 50 // g：超时强制结束
const PX_PER_M_DEN = 15 // _：像素/米换算分母（W/15）
const CLEAR_GRACE = 0.06 // v：过栏宽限（未起跳穿过栏后 0.06s 内补跳仍算过）
const STUMBLE_T = 0.35 // y：撞栏踉跄时长（速度强制 0）
const FOUL_HOLD = 1 // b：第二次抢跑罚站时长
const FS_TH = 0.2 // 抢跑阈值：run > 0.2
const FS_T = 0.2 // 持续 ≥0.2s
const ACCEL_R = 2.2 // 加速率
const DECEL_R = 1.6 // 减速率
const STEP_BONUS = 3 // 步频 ≥3 加成门槛
const JUMP_RISE = 0.2 // 髋部抬升 >0.2×torso
const JUMP_RESET = 0.08 // 回落 <0.08 复位
const JUMP_CD = 0.35 // 起跳冷却
const EARLY_EXTRA = 0.6 // early：栏前时间 > win+0.6 时起跳算跳早
const HIT_TIP = 0.45 // 撞栏后 0.45s 内起跳且非 early → 「晚了一点」
const PRAISE = ['漂亮！', '好跳！', '过！', '真轻快！']

type Phase = 'marks' | 'set' | 'go' | 'over'

interface HurdleSt {
  x: number
  st: 0 | 1 | 2 // 0 未到 1 跨过 2 碰栏
  early: boolean
}

interface Runner {
  dist: number
  v: number
  top: number
  run: number
  steps: number[]
  wasL: boolean
  wasR: boolean
  stepPeak: number
  fsT: number
  hipBase: number
  air: boolean
  airT: number
  jumpAt: number
  lastHitAt: number
  pendLate: number
  hurdles: HurdleSt[]
  next: number
  cleared: number
  hits: number
  leadSum: number
  leadN: number
  reaction: number
  finishT: number
  stumbleT: number
  legPhase: number
}

interface Cpu {
  dist: number
  v: number
  react: number
  airUntil: number
  miss: boolean[]
  next: number
  cleared: number
  hits: number
  finishT: number
  stumbleT: number
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

/** motion.run 代理：双膝相对髋的抬升量折算 0~1（站立≈0、跑动高抬腿≈1） */
function runOf(b: Body): number {
  const hipY = b.hipC.y
  const liftL = (hipY - b.lKnee.y) / Math.max(0.06, torsoOf(b) * 2)
  const liftR = (hipY - b.rKnee.y) / Math.max(0.06, torsoOf(b) * 2)
  return clamp01((liftL + liftR + 0.9) / 1.1)
}

function newRunner(cfg: (typeof DIFF)[0]): Runner {
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
    hipBase: NaN,
    air: false,
    airT: 0,
    jumpAt: -9,
    lastHitAt: -9,
    pendLate: 0,
    hurdles: Array.from({ length: cfg.count }, (_, i) => ({ x: cfg.first + i * cfg.gap, st: 0 as 0, early: false })),
    next: 0,
    cleared: 0,
    hits: 0,
    leadSum: 0,
    leadN: 0,
    reaction: -1,
    finishT: -1,
    stumbleT: 0,
    legPhase: 0,
  }
}

class Hurdles extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  phase: Phase = 'marks'
  phaseT = 0
  setDur = 2
  goAt = -1 // go 相开始的 this.t
  fouls = [0, 0]
  hold = [0, 0] // 发令后罚站剩余（raceT 秒）
  ps: Runner[] = [newRunner(this.cfg), newRunner(this.cfg)]
  cpu: Cpu | null = null
  bannerText = ''
  bannerT = 0
  shakeT = 0
  popAt = -9
  endAt = -1
  ended = false
  firstFinisher = -1
  cpuAnnounced = false
  winSolo: boolean | null = null
  started = false
  private realClock = 0

  constructor(ctx: GameContext) {
    super(ctx)
    this.ctx.setStage('栏架碰到黄线时跳起来！')
    this.armRace()
  }

  /** 生成/重置一次起跑（抢跑后全场重来） */
  private armRace() {
    const [lo, hi] = this.cfg.setWait
    this.setDur = lo + Math.random() * (hi - lo)
    this.phase = 'marks'
    this.phaseT = 0
    this.goAt = -1
    this.endAt = -1
    this.firstFinisher = -1
    this.cpuAnnounced = false
    this.winSolo = null
    this.ps = [newRunner(this.cfg), newRunner(this.cfg)]
    this.hold = [0, 0]
    // CPU（单人）：反应 0.15+rand×0.12s；每栏预掷 cpuMiss 概率「没跳」
    this.cpu = {
      dist: 0,
      v: 0,
      react: 0.15 + Math.random() * 0.12,
      airUntil: -1,
      miss: Array.from({ length: this.cfg.count }, () => Math.random() < this.cfg.cpuMiss),
      next: 0,
      cleared: 0,
      hits: 0,
      finishT: -1,
      stumbleT: 0,
      legPhase: 0,
    }
  }

  update(f: PoseFrame, dt: number) {
    this.realClock += dt
    this.bannerT = Math.max(0, this.bannerT - dt)
    this.shakeT = Math.max(0, this.shakeT - dt)
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
    const duo = this.duo

    // 起跑流程
    this.phaseT += dt
    if (this.phase === 'marks' && this.phaseT >= 1) {
      this.phase = 'set'
      this.phaseT = 0
      this.ctx.speak('预备……别动！')
    } else if (this.phase === 'set' && this.phaseT >= this.setDur) {
      this.phase = 'go'
      this.goAt = this.t
      // 发令枪 crack + 震屏
      this.ctx.audio.play('hit', 0.9, 1.7)
      this.ctx.speak('跑！')
      this.banner('跑！', 1)
      this.shakeT = 0.3
    }

    for (let pi = 0; pi < 2; pi++) {
      const b = f.bodies[pi] ?? null
      const r = this.ps[pi]
      if (!b) continue
      if (this.phase !== 'go') {
        // 抢跑检测：run>0.2 持续 ≥0.2s
        const run = runOf(b)
        r.fsT = run > FS_TH ? r.fsT + dt : 0
        if (r.fsT >= FS_T) {
          r.fsT = 0
          this.foul(pi)
        }
        continue
      }
      this.tickRunner(pi, r, b, dt)
    }

    // CPU（单人）
    if (!duo && this.cpu && this.phase === 'go') this.tickCpu(dt)

    // 结束条件
    this.checkEnd()

    // HUD 分数 = 100 × 最好平均速度（完赛插值，未完赛实时）
    const sc = this.bestScore()
    this.ctx.setScore(sc)
    const lead = this.leader()
    if (lead) {
      this.ctx.setExtra('跨栏(个)', lead.cleared)
      this.ctx.setExtra('碰栏(个)', lead.hits)
      this.ctx.setExtra('最高速度(m/s)', Math.round(lead.top * 10) / 10)
      this.ctx.setExtra('起跑反应(秒)', lead.reaction >= 0 ? Math.round(lead.reaction * 100) / 100 : 0)
      this.ctx.setExtra('栏前(秒)', lead.leadN ? Math.round((lead.leadSum / lead.leadN) * 100) / 100 : 0)
    }
    this.ctx.setCombo(Math.max(...this.ps.map((r) => r.cleared)))
  }

  private foul(pi: number) {
    this.fouls[pi]++
    if (this.fouls[pi] === 1) {
      // 第 1 次：全场重置重新起跑
      this.banner('抢跑！再来一次', 1.8)
      this.ctx.speak('抢跑，再来一次')
      this.ctx.audio.whistle()
      this.armRace()
    } else {
      // 第 2 次：发令后罚站 1 秒，不取消资格
      this.banner('又抢跑了，发令后罚站 1 秒', 1.8)
      this.ctx.speak('又抢跑了，罚站一秒')
      this.ctx.audio.whistle()
      this.hold[pi] = FOUL_HOLD
    }
  }

  private tickRunner(pi: number, r: Runner, b: Body, dt: number) {
    const raceT = this.raceT
    const gain = this.cfg.gain

    // 跑步强度 / 步频代理
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

    // 起跑反应：发令后 run×gain > 0.15 首次出现
    if (r.reaction < 0 && r.run * gain > 0.15) r.reaction = raceT

    // 速度模型：目标 = 8 × clamp(run×gain,0,1) × (步频≥3 ? 1.1 : 1)
    r.stumbleT = Math.max(0, r.stumbleT - dt)
    let target = VMAX * clamp01(r.run * gain) * (rate >= STEP_BONUS ? 1.1 : 1)
    if (raceT < this.hold[pi]) target = 0 // 罚站
    if (r.stumbleT > 0) target = 0
    const rr2 = target > r.v ? ACCEL_R : DECEL_R
    r.v += (target - r.v) * (1 - Math.exp(-dt * rr2))
    if (r.stumbleT > 0) r.v = 0
    r.top = Math.max(r.top, r.v)

    // 跳栏判定（髋基线抬升 / 框架 jumping 上升沿，冷却 0.35s）
    this.updateAir(pi, r, b, dt)

    const prev = r.dist
    r.dist += r.v * dt

    // 补跳窗口结算：未起跳穿过栏后 0.06s 内补跳算过，超时判 hit
    if (r.pendLate > 0 && r.air) this.clearHurdle(pi, r)
    else if (r.pendLate > 0 && this.t > r.pendLate) this.hitHurdle(pi, r)

    // 栏在 dist 越过 hurdle.x 时判定
    const hx = r.next < r.hurdles.length ? r.hurdles[r.next].x : undefined
    if (hx !== undefined && prev < hx && r.dist >= hx) {
      if (r.air) this.clearHurdle(pi, r)
      else r.pendLate = this.t + CLEAR_GRACE
    }

    // 冲线：用时插值 time = I − (dist−110)/v
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

  private updateAir(pi: number, r: Runner, b: Body, dt: number) {
    const torso = torsoOf(b)
    if (!Number.isFinite(r.hipBase)) r.hipBase = b.hipC.y
    if (!r.air) {
      // 基线自适应：下落快（hipV>0.25）时 τ 快
      r.hipBase += (b.hipC.y - r.hipBase) * Math.min(1, dt * (b.hipV > 0.25 ? 6 : 1.2))
      const rise = (r.hipBase - b.hipC.y) / torso
      const jumped = (rise > JUMP_RISE || b.jumping) && this.t - r.jumpAt > JUMP_CD
      if (jumped) {
        r.air = true
        r.airT = 0
        r.jumpAt = this.t
        // 起跳时机统计 + early 标记 + 补跳
        const hx = r.next < r.hurdles.length ? r.hurdles[r.next].x : undefined
        if (hx !== undefined && r.v > 0.5) {
          const tau = (hx - r.dist) / r.v
          if (tau >= 0 && tau <= this.cfg.win) {
            r.leadSum += tau
            r.leadN++
          }
          if (tau > this.cfg.win + EARLY_EXTRA) r.hurdles[r.next].early = true
        }
        if (r.pendLate > 0 && this.t <= r.pendLate) this.clearHurdle(pi, r)
        else if (this.t - r.lastHitAt <= HIT_TIP && !(r.next > 0 && r.hurdles[r.next - 1].early)) {
          const p = this.lanePos(pi)
          this.say('晚了一点', p.x, p.y - 130, '#ffd54a', 26)
        }
      }
    } else {
      r.airT += dt
      const rise = (r.hipBase - b.hipC.y) / torso
      if (rise < JUMP_RESET) r.air = false
    }
  }

  private clearHurdle(pi: number, r: Runner) {
    if (r.next >= r.hurdles.length) return
    const h = r.hurdles[r.next]
    h.st = 1
    r.cleared++
    r.pendLate = 0
    r.next++
    this.ctx.audio.jump() // whoosh
    this.popAt = this.realClock // highlight(1)
    const p = this.lanePos(pi)
    const hx = this.W / PX_PER_M_DEN * (h.x - this.camX(pi)) + p.hx
    this.particles.burst(hx, p.y - 90, '#ffe97a', 6, 260, 5)
    // 随机赞语（大屏）或 ⭐（儿童）——本框架为儿童端，用赞语文字
    this.say(PRAISE[Math.floor(Math.random() * PRAISE.length)], p.hx, p.y - 150, '#fff', 32)
  }

  private hitHurdle(pi: number, r: Runner) {
    const h = r.hurdles[r.next]
    h.st = 2
    r.hits++
    r.pendLate = 0
    r.next++
    r.v *= 0.15
    r.stumbleT = STUMBLE_T
    this.ctx.audio.hit() // thud
    this.shakeT = 0.4
    const p = this.lanePos(pi)
    this.say(h.early ? '跳早啦' : '碰栏！', p.hx, p.y - 150, '#ff8a8a', 34)
    this.particles.burst(p.hx, p.y - 70, '#c9184a', 10, 300, 5)
    r.lastHitAt = this.t
  }

  private tickCpu(dt: number) {
    const cpu = this.cpu!
    const raceT = this.raceT
    cpu.stumbleT = Math.max(0, cpu.stumbleT - dt)
    if (raceT < cpu.react || cpu.finishT >= 0) return
    // 速度 cpu × (0.97+0.03sin)
    cpu.v = this.cfg.cpu * (0.97 + 0.03 * Math.sin(raceT * 2.4))
    if (cpu.stumbleT > 0) cpu.v = 0
    cpu.legPhase += dt * 16
    // 跳点：栏前剩余时间 ≤ win×0.55 起跳
    const hx = cpu.next < this.cfg.count ? this.cfg.first + cpu.next * this.cfg.gap : undefined
    if (hx !== undefined) {
      const tau = (hx - cpu.dist) / Math.max(0.5, cpu.v)
      if (tau <= this.cfg.win * 0.55 && !cpu.miss[cpu.next]) cpu.airUntil = raceT + this.cfg.win
    }
    const air = raceT <= cpu.airUntil
    const prev = cpu.dist
    cpu.dist += cpu.v * dt
    if (hx !== undefined && prev < hx && cpu.dist >= hx) {
      if (air) {
        cpu.cleared++
        cpu.next++
      } else {
        // 撞栏放水
        cpu.hits++
        cpu.next++
        cpu.v *= 0.15
        cpu.stumbleT = STUMBLE_T
      }
    }
    if (cpu.finishT < 0 && cpu.dist >= RACE_M) {
      cpu.finishT = raceT - (cpu.dist - RACE_M) / Math.max(0.5, cpu.v)
      // CPU 先到 → banner（若玩家未完赛）
      if (this.ps[0].finishT < 0 && !this.cpuAnnounced) {
        this.cpuAnnounced = true
        this.banner('电脑先到啦，加油冲！', 1.8)
        this.ctx.audio.whistle()
      }
    }
  }

  private onFinished(pi: number) {
    const r = this.ps[pi]
    const duo = this.duo
    if (this.firstFinisher < 0) {
      this.firstFinisher = pi
      if (duo) {
        this.banner(`玩家${pi + 1} 第一个冲线！`, 2.2)
        this.ctx.speak(`玩家${pi + 1}第一个冲线！`)
      } else {
        // 单人 vs CPU：比较（CPU 未完赛按剩余距离估算）
        const cpu = this.cpu!
        const cpuEst = cpu.finishT >= 0 ? cpu.finishT : this.raceT + (RACE_M - cpu.dist) / Math.max(0.5, cpu.v)
        this.winSolo = r.finishT < cpuEst
        this.banner(this.winSolo ? '赢了电脑！' : '冲线啦！', 2.2)
        this.ctx.speak(this.winSolo ? '赢了电脑！' : '冲线啦！')
      }
      this.ctx.audio.win() // tada
      this.particles.confetti(this.W, 24)
    }
    // 结束时限：任意完赛 → 双人 10s / 单人 2.5s；全员完赛 → 2.5s
    const allDone = this.ps.every((p, i) => !this.players[i].body || p.finishT >= 0)
    const delay = allDone ? 2.5 : duo ? 10 : 2.5
    if (this.endAt < 0 || this.endAt > this.t + delay) this.endAt = this.t + delay
  }

  private checkEnd() {
    // 超 50s 强制结算
    if (this.raceT >= TIMEOUT) this.finishRace()
    if (this.endAt >= 0 && this.t >= this.endAt) this.finishRace()
  }

  private finishRace() {
    if (this.ended) return
    this.ended = true
    this.phase = 'over'
    this.ctx.setScore(this.bestScore())
    this.ctx.finish()
  }

  /** 分数 = 100 × 最好平均速度（完赛 round(11000/用时)，未完赛 round(100×距离/用时)） */
  private bestScore() {
    const raceT = Math.max(1, this.raceT)
    let best = 0
    for (let pi = 0; pi < 2; pi++) {
      if (!this.players[pi].body) continue
      const r = this.ps[pi]
      const s = r.finishT >= 0 ? Math.round(11000 / Math.max(0.5, r.finishT)) : Math.round((100 * r.dist) / raceT)
      best = Math.max(best, s)
    }
    return best
  }

  private leader(): Runner | null {
    const act = this.ps.filter((_, i) => this.players[i].body)
    if (!act.length) return null
    return act.reduce((a, b) => (b.cleared > a.cleared ? b : a))
  }

  /** 玩家屏幕位置：跑道固定 x（camX 跟随）， lane 决定 y */
  private lanePos(pi: number) {
    const duo = this.duo
    const y = duo ? (pi === 0 ? this.H * 0.76 : this.H * 0.9) : this.H * 0.8
    const hx = this.W * (duo ? (pi === 0 ? 0.3 : 0.34) : 0.3)
    return { x: hx, y, hx }
  }

  private camX(pi: number) {
    return this.ps[pi].dist - 3.5
  }

  // ---------- 绘制 ----------

  paint(c: CanvasRenderingContext2D) {
    const unit = this.H / 720
    c.save()
    if (this.shakeT > 0) {
      const amp = 7 * (this.shakeT / 0.4)
      c.translate(Math.sin(this.realClock * 70) * amp, Math.cos(this.realClock * 63) * amp * 0.5)
    }
    this.paintWorld(c, unit)
    const duo = this.duo
    for (let pi = 0; pi < 2; pi++) {
      if (!this.players[pi].body) continue
      this.paintLane(c, pi, unit)
    }
    if (!duo && this.cpu) this.paintCpu(c, unit)
    // 黄色判定线 + 「跳！」提示（下一个未跨栏进入 win+0.08 窗口）
    for (let pi = 0; pi < 2; pi++) {
      if (!this.players[pi].body || this.phase !== 'go') continue
      const r = this.ps[pi]
      const hx = r.next < r.hurdles.length ? r.hurdles[r.next].x : undefined
      if (hx === undefined || r.v < 0.5) continue
      const tau = (hx - r.dist) / r.v
      if (tau <= this.cfg.win + 0.08) {
        const p = this.lanePos(pi)
        const sx = (hx - this.camX(pi)) * (this.W / PX_PER_M_DEN) + p.hx
        const flash = 0.5 + Math.sin(this.realClock * 14) * 0.4
        c.save()
        c.globalAlpha = Math.max(0.25, flash)
        c.strokeStyle = '#ffd54a'
        c.lineWidth = 6
        c.beginPath()
        c.moveTo(sx, p.y - 130)
        c.lineTo(sx, p.y + 10)
        c.stroke()
        c.restore()
        outlineTxt(c, '▲ 跳！', p.hx, p.y - 170, 40, '#ffd54a')
      }
    }
    // 起跑倒计时 / 阶段文字
    if (this.phase === 'marks') outlineTxt(c, '各就位…', this.W / 2, this.H * 0.3, 54, '#ffffff')
    else if (this.phase === 'set') outlineTxt(c, '预备……别动！', this.W / 2, this.H * 0.3, 54, '#ffb703')
    if (this.bannerT > 0) {
      c.globalAlpha = Math.min(1, this.bannerT / 0.3)
      outlineTxt(c, this.bannerText, this.W / 2, this.H * 0.18, 52, '#ffd54a')
      c.globalAlpha = 1
    }
    // 分段赛道图（右上角每栏一个小图标）+ 抢跑牌
    this.paintMap(c)
    // 与电脑距离条
    if (!duo && this.cpu && this.phase === 'go') {
      const d = Math.round(this.cpu.dist - this.ps[0].dist)
      txt(c, d >= 0 ? `电脑 ▶ ${d} 米` : `◀ 电脑 ${-d} 米`, this.W / 2, this.H * 0.12, 22, '#ffffff', 'center', 'bold')
    }
    // 顶部实时成绩
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
    c.restore()
    if (this.ended) this.paintResult(c)
    txt(c, '各就位别动，枪响再跑；栏架碰到黄线时跳起来，跳早跳晚都会碰栏', this.W / 2, this.H - 26, 20, 'rgba(255,255,255,.8)', 'center', 'bold')
  }

  /** 世界背景：看台观众（视差+跳动）、草地、红棕跑道、白线里程标 */
  private paintWorld(c: CanvasRenderingContext2D, unit: number) {
    const pxm = this.W / PX_PER_M_DEN
    const cam = this.ps[0].dist - 3.5
    // 看台
    c.fillStyle = 'rgba(30,36,80,.85)'
    c.fillRect(0, 0, this.W, this.H * 0.22)
    const colors = ['#ff8fab', '#7cc7ff', '#8be0a4', '#ffd54a', '#c3a6ff']
    const off = (cam * pxm * 0.35) % 34
    for (let i = 0; i < 42; i++) {
      const x = i * 34 - off
      const row = i % 2
      const bob = this.phase === 'go' ? Math.abs(Math.sin(this.realClock * 8 + i)) * 6 : 0
      circle(c, x, this.H * 0.09 + row * 30 - bob, 9 * unit, colors[(i + Math.floor(cam)) % colors.length])
    }
    // 草地
    c.fillStyle = '#3e7d3a'
    c.fillRect(0, this.H * 0.22, this.W, this.H * 0.2)
    // 跑道
    c.fillStyle = '#a83a28'
    c.fillRect(0, this.H * 0.42, this.W, this.H * 0.58)
    c.fillStyle = 'rgba(255,255,255,.1)'
    c.fillRect(0, this.H * 0.42, this.W, 6)
    // 车道线
    c.strokeStyle = 'rgba(255,255,255,.35)'
    c.lineWidth = 3
    for (const y of [this.H * 0.62, this.H * 0.84]) {
      c.beginPath()
      c.moveTo(0, y)
      c.lineTo(this.W, y)
      c.stroke()
    }
    // 白线里程标（每 10m）
    const m0 = Math.floor(cam / 10) * 10
    for (let m = m0; m <= cam + PX_PER_M_DEN + 12; m += 10) {
      if (m < 0 || m > RACE_M) continue
      const x = (m - cam) * pxm
      c.fillStyle = 'rgba(255,255,255,.75)'
      c.fillRect(x, this.H * 0.44, 4, 26)
      txt(c, `${m}`, x + 18, this.H * 0.47, 16, 'rgba(255,255,255,.85)', 'center', 'bold')
    }
    // 终点
    const fx = (RACE_M - cam) * pxm
    if (fx > -40 && fx < this.W + 40) {
      c.fillStyle = '#ffffff'
      for (let i = 0; i < 10; i++) {
        c.fillStyle = i % 2 ? '#222' : '#fff'
        c.fillRect(fx, this.H * 0.44 + i * 14, 8, 14)
      }
      outlineTxt(c, '终点', fx + 44, this.H * 0.5, 22, '#ffffff')
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

  /** 跑道上的栏架（对应该玩家 camX） */
  private paintLaneHurdles(c: CanvasRenderingContext2D, pi: number, laneY: number, unit: number) {
    const pxm = this.W / PX_PER_M_DEN
    const r = this.ps[pi]
    for (const h of r.hurdles) {
      const sx = (h.x - this.camX(pi)) * pxm + this.lanePos(pi).hx
      if (sx < -60 || sx > this.W + 60) continue
      c.save()
      c.translate(sx, laneY)
      if (h.st === 2) c.rotate(0.5)
      c.globalAlpha = h.st === 0 ? 1 : 0.85
      c.strokeStyle = h.st === 2 ? '#8a8a8a' : '#ff6b6b'
      c.lineWidth = 6 * unit
      c.beginPath()
      c.moveTo(-26 * unit, 0)
      c.lineTo(-26 * unit, -74 * unit)
      c.moveTo(26 * unit, 0)
      c.lineTo(26 * unit, -74 * unit)
      c.stroke()
      c.fillStyle = h.st === 2 ? 'rgba(200,200,200,.9)' : 'rgba(255,255,255,.92)'
      c.fillRect(-34 * unit, -88 * unit, 68 * unit, 18 * unit)
      c.fillStyle = h.st === 2 ? '#777' : '#ff6b6b'
      for (let i = 0; i < 3; i++) c.fillRect(-34 * unit + i * 23 * unit, -88 * unit, 12 * unit, 18 * unit)
      // 跨过标记
      if (h.st === 1) {
        outlineTxt(c, '✓', 0, -110 * unit, 24, '#3ddc97')
      }
      c.restore()
    }
  }

  /** 简易跑步小人（双腿按步频摆动，跳起画抛物线，踉跄倾斜） */
  private paintDude(
    c: CanvasRenderingContext2D,
    x: number,
    groundY: number,
    unit: number,
    color: string,
    legPhase: number,
    air: number, // 0~1 跳起进度（0=地面）
    stumble: boolean,
    alpha = 1,
  ) {
    const s = 56 * unit
    const jump = Math.sin(Math.min(1, air) * Math.PI) * s * 1.15
    c.save()
    c.globalAlpha = alpha
    c.translate(x, groundY - jump)
    if (stumble) c.rotate(Math.sin(this.realClock * 30) * 0.3)
    glow(c, 0, -s * 0.9, s * 1.5, color, 0.18)
    // 腿
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
    // 躯干 + 手臂
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

  private paintLane(c: CanvasRenderingContext2D, pi: number, unit: number) {
    const r = this.ps[pi]
    const p = this.lanePos(pi)
    this.paintLaneHurdles(c, pi, p.y, unit)
    const air = r.air ? Math.min(1, r.airT / this.cfg.win) : 0
    this.paintDude(c, p.hx, p.y, unit, this.players[pi].color, r.legPhase, air, r.stumbleT > 0)
    outlineTxt(c, `玩家${pi + 1}`, p.hx, p.y + 30, 20, this.players[pi].color)
    if (this.hold[pi] > 0 && this.phase === 'go') {
      outlineTxt(c, '罚站…', p.hx, p.y - 140, 26, '#ff8a8a')
    }
  }

  private paintCpu(c: CanvasRenderingContext2D, unit: number) {
    const cpu = this.cpu!
    const y = this.H * 0.66
    const pxm = this.W / PX_PER_M_DEN
    // CPU 的栏（只画状态标记简化）
    for (let i = 0; i < this.cfg.count; i++) {
      const hx = this.cfg.first + i * this.cfg.gap
      const sx = (hx - (cpu.dist - 3.5)) * pxm
      if (sx < -40 || sx > this.W + 40) continue
      c.globalAlpha = 0.5
      c.fillStyle = '#e8e0d8'
      c.fillRect(sx - 3, y - 70 * unit, 6, 70 * unit)
      c.globalAlpha = 1
    }
    const air = this.raceT <= cpu.airUntil && this.raceT >= cpu.react ? Math.min(1, (cpu.airUntil - this.raceT) / this.cfg.win) : 0
    this.paintDude(c, 3.5 * pxm, y, unit, '#9aa4b8', cpu.legPhase, air, cpu.stumbleT > 0)
    emoji(c, '🤖', 3.5 * pxm, y - 150 * unit, 26)
    txt(c, '电脑', 3.5 * pxm, y + 30, 18, '#c8d0e0', 'center', 'bold')
  }

  /** 分段赛道图（右上角）：绿=跨过 红=碰栏 白=未到；抢跑黄/红牌 */
  private paintMap(c: CanvasRenderingContext2D) {
    const n = this.cfg.count
    const w = 26
    const x0 = this.W - n * (w + 6) - 28
    for (let i = 0; i < n; i++) {
      const lead = this.leader()
      const st = lead && i < lead.hurdles.length ? lead.hurdles[i].st : 0
      c.fillStyle = st === 1 ? '#3ddc97' : st === 2 ? '#ff5c5c' : 'rgba(255,255,255,.25)'
      c.beginPath()
      c.roundRect(x0 + i * (w + 6), 30, w, 20, 5)
      c.fill()
    }
    // 抢跑牌
    let cx = x0
    for (let pi = 0; pi < 2; pi++) {
      if (!this.players[pi].body) continue
      for (let k = 0; k < Math.min(2, this.fouls[pi]); k++) {
        c.fillStyle = k === 0 ? '#ffd54a' : '#ff5c5c'
        c.beginPath()
        c.roundRect(cx, 58, 20, 28, 4)
        c.fill()
        cx += 26
      }
    }
  }

  /** 结算面板（报告 §6 统计项） */
  private paintResult(c: CanvasRenderingContext2D) {
    const lead = this.leader()
    if (!lead) return
    const duo = this.duo
    const w = 430
    const h = 300
    const x = this.W / 2 - w / 2
    const y = this.H * 0.3 - h / 2
    c.fillStyle = 'rgba(10,14,40,.8)'
    c.beginPath()
    c.roundRect(x, y, w, h, 20)
    c.fill()
    c.strokeStyle = 'rgba(255,255,255,.25)'
    c.stroke()
    const title = duo
      ? this.firstFinisher >= 0
        ? `玩家${this.firstFinisher + 1} 第一个冲线！`
        : '比赛结束'
      : this.winSolo === true
        ? '赢了电脑！'
        : this.winSolo === false
          ? '冲线啦！'
          : '比赛结束'
    outlineTxt(c, title, this.W / 2, y + 44, 34, '#ffd54a')
    const lines: string[] = []
    if (lead.finishT >= 0) lines.push(`用时：${lead.finishT.toFixed(2)} 秒`)
    else lines.push(`没跑完（${Math.floor(lead.dist)} 米）${this.fouls[0] + this.fouls[1] > 0 ? ` · 抢跑 ${this.fouls[0] + this.fouls[1]} 次` : ''}`)
    lines.push(
      lead.hits === 0 && lead.cleared === this.cfg.count
        ? '跨栏：全部跨过'
        : `跨栏：${lead.cleared} / ${this.cfg.count}${lead.hits ? `（碰了 ${lead.hits} 个）` : ''}`,
    )
    lines.push(`最高速度：${(Math.round(lead.top * 10) / 10).toFixed(1)} m/s`)
    if (lead.reaction >= 0) lines.push(`起跑反应：${lead.reaction.toFixed(2)} 秒`)
    if (lead.leadN) lines.push(`起跳时机：栏前 ${(lead.leadSum / lead.leadN).toFixed(2)} 秒`)
    if (!duo && this.cpu) {
      if (this.winSolo) lines.push('对手：赢了电脑')
      else if (this.cpu.finishT >= 0 && lead.finishT >= 0) lines.push(`对手：比电脑慢 ${(lead.finishT - this.cpu.finishT).toFixed(2)} 秒`)
    }
    lines.forEach((s, i) => txt(c, s, this.W / 2, y + 92 + i * 36, 22, '#ffffff', 'center', 'bold'))
  }
}

export default function create(ctx: GameContext) {
  return new Hurdles(ctx)
}
