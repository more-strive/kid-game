import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, glow, outlineTxt, rr, star, txt } from '@/core/draw'

/**
 * 立定跳远（对齐 dongdongpark 真实规则，逆向报告 _reverse/reports/long-jump.md）：
 * 摆臂→下蹲→蹬跳，每人 5 跳取最好成绩（厘米），回合制无时间压力。
 * 状态机 aim(蓄力) → fly(1s 抛物线) → land(1.6s) → walk(1.2s)，全员跳完 2.4s 后结算。
 * 距离公式 cm = 70 + 75×起跳分量 + 40×蹲深分量 + 15×摆臂旗标 + 45×摆臂力量分量（上限 245）。
 *
 * 站点框架行为等价代理说明：
 * - motion.squat（0~1 蹲深）：引擎侧阈值未随报告给出，用膝关节平均弯曲角折算（站直≈172°、深蹲≈92°）。
 * - motion.armLift（0~1 手臂上举度）：用双手相对髋的抬高量 ÷ 1.8×躯干 折算。
 * - events.has('jump') → body.jumping；手腕 vel.y 用本文件自记的上一帧腕位置差分。
 * - e.big（大屏标志）不存在于本框架：免责声明/额外统计/灯文字始终显示（大屏行为）。
 * - 站点 AI 人格表（le 5 组）依赖 AI 玩家槽位，本框架玩家全部来自摄像头；出场者缺 body 按
 *   报告 §8.3 的路径处理：轮次照常推进，空跳记 0 成绩。
 * - 音效映射：whoosh→jump、thud→hit、tada→fanfare、chime→good、pop→pop（站点音效名缺采样，等价映射）。
 * - 双人破纪录增量按全局最好成绩计（score 最终值 = 全局 best），保证壳层厘米星级线语义成立。
 */

// ---- 全部字面量（对齐报告 §1） ----
const JUMPS = 5 // k：每人跳数
const RULER_CM = 270 // te：沙坑标尺满量程（厘米），刻度每 10cm、标数字每 50cm
const RISE_GO = 0.17 // ne：起跳触发，髋部上升 rise > 0.17（×躯干）
const AIM_FLY_DELAY = 0.4 // re：aim 态起跳后延迟 0.4s 自动发射
const CHARGE_WIN = 1.6 // ie：蓄力窗，起跳前 1.6s 历史参与蹲深取值
const ARM_WIN = 0.45 // ae：摆臂速度窗，起跳前 0.45s 最大手上摆速度参与计分
const FLY_UP_WIN = 0.25 // oe：fly 相位前 0.25s 继续累计摆臂速度
const FLY_PEAK_WIN = 0.5 // se：fly 相位前 0.5s 继续累计 rise/armLift 峰值
const FLY_TIME = 1 // A：fly 相位时长（秒）
const LAND_TIME = 1.6 // j：land 相位时长
const WALK_TIME = 1.2 // M：walk 相位时长
const HIST_WIN = 2.2 // ce：动作历史保留窗口（秒）
const REMIND_EVERY = 9 // aim 停滞提醒间隔（秒）
const REMIND_MAX = 2 // 提醒次数上限
const HAND_LOW_LIFT = 0.35 // low：双手 y 均低于 髋 − 0.35×躯干
const END_TIME = 2.4 // 结算停留秒数（后 finish）
const NOBODY_TAKEOFF = 1.2 // 出场者无 body 的空跳触发延时（§8.3）
const CM_CAP = 245 // 成绩上限
const CM_FLOOR = 70 // 保底成绩
const STARS = [
  [120, 150, 180], // easy
  [140, 170, 200], // medium
  [160, 190, 220], // hard
] // 难度表 ee：星级线（厘米），与 catalog 完全一致
const REMIND_TEXT = '两臂往后摆，蹲下，再用力往前上方跳！'
const COACH_TIPS = ['，手臂用力往前上方甩', '，下次蹲深一点', '，脚用力蹬地']
const LAMP_LABELS = ['摆臂', '下蹲', '起跳']

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v))
}

/** 膝角（度）：a 髋 b 膝 c 踝 */
function kneeAngle(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }) {
  const v1x = a.x - b.x
  const v1y = a.y - b.y
  const v2x = c.x - b.x
  const v2y = c.y - b.y
  const d = v1x * v2x + v1y * v2y
  const m = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) || 1
  return (Math.acos(Math.max(-1, Math.min(1, d / m))) * 180) / Math.PI
}

/** motion.squat 代理：膝关节平均弯曲角折算蹲深 0~1 */
function squatDepth(b: Body): number {
  const okL = (b.lm[25]?.visibility ?? 0) >= 0.3 && (b.lm[27]?.visibility ?? 0) >= 0.3
  const okR = (b.lm[26]?.visibility ?? 0) >= 0.3 && (b.lm[28]?.visibility ?? 0) >= 0.3
  const angs: number[] = []
  if (okL) angs.push(kneeAngle(b.lHip, b.lKnee, b.lFoot))
  if (okR) angs.push(kneeAngle(b.rHip, b.rKnee, b.rFoot))
  if (!angs.length) return 0
  const avg = angs.reduce((n, v) => n + v, 0) / angs.length
  return clamp01((172 - avg) / 80)
}

/** motion.armLift 代理：双手相对髋的抬高量（越举越高 → 0~1） */
function armLift(b: Body): number {
  const hy = Math.min(b.lHand.y, b.rHand.y)
  return clamp01((b.hipC.y - hy) / (1.8 * Math.max(0.05, b.scale)))
}

interface Hist {
  t: number
  squat: number
  up: number
  low: boolean
  lift: number
}

type Phase = 'idle' | 'aim' | 'fly' | 'land' | 'walk'

interface PS {
  // 采样（仅出场者）
  hipBase: number // 归一化 y，自适应髋基线
  ready: boolean
  prevL: { x: number; y: number } | null
  prevR: { x: number; y: number } | null
  hist: Hist[]
  lights: [boolean, boolean] // 摆臂灯 / 下蹲灯
  // 起跳后的计分采样
  took: boolean
  tookAt: number
  squatPk: number
  upPk: number
  back: boolean
  liftPk: number
  risePk: number
  squatAtTook: number
  // 成绩
  marks: number[]
  best: number
  full: number // “动作到位”计数
  flagCm: number // 最好成绩飘旗逼近值
  // 该玩家渲染相位
  phase: Phase
  phaseT: number
  cm: number
  dispCm: number
  rate: [number, number, number]
  wasRecord: boolean // 本跳破纪录（用于 land 起身欢呼）
}

function newPS(): PS {
  return {
    hipBase: NaN,
    ready: false,
    prevL: null,
    prevR: null,
    hist: [],
    lights: [false, false],
    took: false,
    tookAt: 0,
    squatPk: 0,
    upPk: 0,
    back: false,
    liftPk: 0,
    risePk: 0,
    squatAtTook: 0,
    marks: [],
    best: 0,
    full: 0,
    flagCm: 0,
    phase: 'idle',
    phaseT: 0,
    cm: 0,
    dispCm: 0,
    rate: [0, 0, 0],
    wasRecord: false,
  }
}

class LongJump extends BaseGame implements Game {
  cfg = STARS[this.ctx.difficulty] ?? STARS[1]
  ps = [newPS(), newPS()]
  /** 全局回合：z=[0,1,0,1…] 交替出场，共 k×L 轮 */
  turnIdx = 0
  cur = 0
  /** 全局最好成绩（score 累计破纪录增量，最终值 = 全局 best） */
  score = 0
  globalBest = 0
  /** aim 停滞提醒 */
  remindN = 0
  remindT = 0
  /** 结束态 */
  ended = false
  endT = 0
  finished = false
  /** 横幅 */
  bannerText = ''
  bannerSub = ''
  bannerT = 0
  /** 落地震屏 */
  shakeT = 0
  /** 大字成绩颜色（fly/land 显示 dispCm 滚动值；黄=破纪录或首次达标二星线） */
  bigWordColor = '#fff'
  recordWordT = 0
  /** 沙坑颗粒固定种子点 */
  private speckles: { x: number; y: number; r: number }[] = []

  constructor(ctx: GameContext) {
    super(ctx)
    let seed = 7
    const rnd = () => {
      seed = (seed * 16807) % 2147483647
      return seed / 2147483647
    }
    for (let i = 0; i < 160; i++) {
      this.speckles.push({ x: rnd(), y: rnd(), r: 1 + rnd() * 2 })
    }
    this.ctx.setStage('摆臂蹲下，用力跳！')
  }

  private present() {
    return this.players.filter((p) => p.body).length
  }

  private name(pi: number) {
    return pi === 0 ? '1P' : '2P'
  }

  // ---------- 采样 ----------

  /** 每帧动作采样 + 髋基线自适应（对齐报告 hipBase 逻辑），返回本帧样本 */
  private sample(pi: number, b: Body, dt: number) {
    const st = this.ps[pi]
    const torso = Math.max(0.05, b.scale)
    // 髋基线：无人下蹲（squat<0.12）时 τ=4（|rise|<0.12）或 0.4 指数逼近当前髋
    const squat = squatDepth(b)
    if (!st.ready) {
      st.ready = true
      st.hipBase = b.hipC.y
    }
    let rise = (st.hipBase - b.hipC.y) / torso
    if (squat < 0.12) {
      const tau = Math.abs(rise) < 0.12 ? 4 : 0.4
      st.hipBase += (b.hipC.y - st.hipBase) * Math.min(1, dt / tau)
      rise = (st.hipBase - b.hipC.y) / torso
    }
    if (rise < 0.08) st.hipBase = b.hipC.y // rise 回落 <0.08 复位到当前髋
    // 双手上摆速度（躯干/秒）：只取可见腕的 vel.y 均值
    let up = 0
    const lOk = (b.lm[15]?.visibility ?? 0) >= 0.2
    const rOk = (b.lm[16]?.visibility ?? 0) >= 0.2
    const dys: number[] = []
    if (lOk && st.prevL) dys.push(b.lHand.y - st.prevL.y)
    if (rOk && st.prevR) dys.push(b.rHand.y - st.prevR.y)
    if (dys.length && dt > 0.001) up = Math.max(0, -(dys.reduce((n, v) => n + v, 0) / dys.length) / dt / torso)
    st.prevL = { x: b.lHand.x, y: b.lHand.y }
    st.prevR = { x: b.rHand.x, y: b.rHand.y }
    const low = b.lHand.y > b.hipC.y - HAND_LOW_LIFT * torso && b.rHand.y > b.hipC.y - HAND_LOW_LIFT * torso
    const lift = armLift(b)
    st.hist.push({ t: this.t, squat, up, low, lift })
    while (st.hist.length && this.t - st.hist[0].t > HIST_WIN) st.hist.shift()
    return { squat, up, low, lift, rise, torso }
  }

  /** 窗口内取峰值样本 */
  private peak(st: PS, from: number, pick: (h: Hist) => number) {
    let v = 0
    for (const h of st.hist) {
      if (h.t < from) continue
      v = Math.max(v, pick(h))
    }
    return v
  }

  /** 距离公式 F(o)（厘米）与三分量质量 rate=[摆臂,下蹲,起跳] */
  private computeCm(st: PS, rise: number) {
    const t = clamp01((st.squatPk - 0.15) / 0.6)
    const n = clamp01((st.upPk - 2) / 6)
    const r = st.back ? clamp01((st.liftPk + 0.1) / 0.6) * 0.7 : 0
    const i = Math.max(n, r)
    const a = clamp01((rise - 0.12) / 0.45)
    const o = st.back ? 1 : 0
    const cm = Math.min(CM_CAP, Math.round(CM_FLOOR + 75 * a + 40 * t + 15 * o + 45 * i))
    st.cm = cm
    st.rate = [o * 0.25 + i * 0.75, t, a]
    return cm
  }

  // ---------- 回合 ----------

  private startTurn() {
    const L = Math.max(1, this.present())
    this.cur = L > 1 ? this.turnIdx % 2 : 0
    const st = this.ps[this.cur]
    st.phase = 'aim'
    st.phaseT = 0
    st.took = false
    st.squatPk = 0
    st.upPk = 0
    st.back = false
    st.liftPk = 0
    st.risePk = 0
    st.wasRecord = false
    st.hist.length = 0
    this.remindN = 0
    this.remindT = 0
    const n = st.marks.length + 1
    if (L > 1) {
      this.bannerText = `轮到 ${this.name(this.cur)}`
      this.bannerSub = n >= JUMPS ? '最后一跳，全力以赴！' : `第 ${n} 跳`
      this.bannerT = 1.4
      this.ctx.speak(`轮到${this.name(this.cur)}${n >= JUMPS ? '，最后一跳' : ''}`)
    } else {
      this.bannerSub = n >= JUMPS ? '最后一跳，全力以赴！' : `第 ${n} 跳`
    }
    this.ctx.setStage(`第 ${n} / ${JUMPS} 跳`)
  }

  /** 落地记账：成绩表 / 破纪录 / 星级线 / 教练提示 / 动作到位 */
  private settle(pi: number) {
    const st = this.ps[pi]
    const cm = Math.round(st.cm)
    st.marks.push(cm)
    st.best = Math.max(st.best, cm)
    const prevBest = this.globalBest
    const hadPrev = this.globalBest > 0
    const isRecord = hadPrev && cm > prevBest
    st.wasRecord = isRecord
    // score += cm − 此前最好（全局最好口径，见文件头说明）
    this.score += Math.max(0, cm - prevBest)
    this.globalBest = Math.max(this.globalBest, cm)
    // 音效分级：破纪录 tada(fanfare)、跨星级线 chime(good)、未破纪录 pop
    let crossed = 0
    for (const s of this.cfg) {
      if (prevBest < s && s <= cm) crossed++
    }
    this.ctx.audio.hit() // thud 落地
    this.shakeT = 0.35
    if (isRecord) {
      this.ctx.audio.fanfare() // tada
      this.particles.confetti(this.W, 30)
      this.say('新纪录！', this.xOf(cm), this.H * 0.67 - 120, '#ff5c5c', 44)
    } else if (crossed > 0) {
      this.ctx.audio.good() // chime
    } else {
      this.ctx.audio.pop()
    }
    // 跨星级线：每条线 10 星粒子 + 星旗
    for (const s of this.cfg) {
      if (prevBest < s && s <= cm) {
        this.particles.burst(this.xOf(s), this.H * 0.67 - 40, '#ffd54a', 10, 300, 5)
      }
    }
    // 大字：黄色 = 破纪录或首次达标二星线
    const twoStar = this.cfg[1]
    const gold = isRecord || (prevBest < twoStar && cm >= twoStar)
    this.bigWordColor = gold ? '#ffd54a' : '#ffffff'
    this.recordWordT = isRecord ? LAND_TIME + 0.4 : 0
    // “动作到位”：squat>0.3 && rate[0]>0.5
    if (st.squatAtTook > 0.3 && st.rate[0] > 0.5) st.full++
    // 单人教练：cm < 三星线且最低分量 < 0.45 时给针对性建议
    if (this.present() <= 1 && cm < this.cfg[2]) {
      let mn = 0
      for (let i = 1; i < 3; i++) if (st.rate[i] < st.rate[mn]) mn = i
      if (st.rate[mn] < 0.45) this.ctx.speak(`${cm} 厘米${COACH_TIPS[mn]}`)
      else this.ctx.speak(`${cm} 厘米`)
    } else if (this.present() <= 1) {
      this.ctx.speak(`${cm} 厘米`)
    }
  }

  private nextTurn() {
    this.turnIdx++
    const L = Math.max(1, this.present())
    // 全员（当前在场 roster）跳完 JUMPS 次 → 结束
    const done = [] as boolean[]
    for (let pi = 0; pi < L; pi++) done.push(this.ps[pi].marks.length >= JUMPS)
    if (done.every(Boolean)) {
      this.ended = true
      this.endT = END_TIME
      const b0 = this.ps[0].best
      if (L > 1) {
        const b1 = this.ps[1].best
        if (b0 === b1) {
          this.bannerText = '一样远，平手！'
          this.bannerSub = `都是 ${b0} 厘米`
        } else {
          const w = b0 > b1 ? 0 : 1
          this.bannerText = `${this.name(w)} 跳得最远！`
          this.bannerSub = `${Math.max(b0, b1)} 厘米`
          this.ctx.audio.win()
        }
      } else {
        this.bannerText = `最好成绩 ${b0} 厘米`
        const n3 = this.cfg.filter((s) => b0 >= s).length
        this.bannerSub = n3 >= 3 ? '跳得真远！' : '多练摆臂和下蹲，还能更远'
        this.ctx.audio.win()
      }
      return
    }
    // 下一个还有跳次的出场者
    for (let k = 1; k <= L; k++) {
      const pi = (this.turnIdx + k - 1) % L
      if (this.ps[pi].marks.length < JUMPS) {
        this.turnIdx = this.turnIdx + k - 1
        break
      }
    }
    this.startTurn()
  }

  tick(f: PoseFrame, dt: number) {
    this.bannerT = Math.max(0, this.bannerT - dt)
    this.recordWordT = Math.max(0, this.recordWordT - dt)
    this.shakeT = Math.max(0, this.shakeT - dt)

    if (this.ended) {
      this.endT -= dt
      if (!this.finished && this.endT <= 0) {
        this.finished = true
        this.ctx.setScore(this.score)
        this.ctx.finish()
      }
      this.updateHud()
      return
    }

    const cur = this.cur
    const st = this.ps[cur]
    const b = f.bodies[cur] ?? null
    if (st.phase === 'idle') this.startTurn() // 开局/下一跳进入 aim
    st.phaseT += dt

    if (st.phase === 'aim') {
      if (b) {
        const s = this.sample(cur, b, dt)
        // 准备灯（每盏亮起播 tick）
        const l0 = s.low && s.squat > 0.2
        const l1 = s.squat > 0.3
        if (l0 && !st.lights[0]) this.ctx.audio.tick()
        if (l1 && !st.lights[1]) this.ctx.audio.tick()
        st.lights = [l0, l1]
        st.risePk = Math.max(st.risePk, s.rise)
        // 起跳触发：rise > 0.17（×躯干）或引擎 jump 事件
        if (!st.took && (s.rise > RISE_GO || b.jumping)) {
          st.took = true
          st.tookAt = this.t
          // 计分采样（起跳时刻窗口）
          st.squatPk = this.peak(st, this.t - CHARGE_WIN, (h) => h.squat)
          st.squatAtTook = s.squat
          st.back = st.hist.some((h) => h.t >= this.t - CHARGE_WIN && h.low && h.squat > 0.2)
          st.liftPk = this.peak(st, this.t - CHARGE_WIN, (h) => h.lift)
          st.upPk = this.peak(st, this.t - ARM_WIN, (h) => h.up)
          st.risePk = Math.max(st.risePk, s.rise)
          this.ctx.audio.jump() // whoosh
        }
        if (st.took) {
          // 起跳后 0.4s 继续采样（窗口随时间推移）
          st.squatPk = Math.max(st.squatPk, s.squat)
          st.upPk = Math.max(st.upPk, this.peak(st, this.t - ARM_WIN, (h) => h.up))
          st.liftPk = Math.max(st.liftPk, s.lift)
          st.risePk = Math.max(st.risePk, s.rise)
          st.back = st.back || (s.low && s.squat > 0.2)
          if (st.phaseT >= AIM_FLY_DELAY) {
            this.computeCm(st, st.risePk)
            st.dispCm = st.cm * 0.85
            this.bigWordColor = '#ffffff'
            st.phase = 'fly'
            st.phaseT = 0
          }
        } else {
          // aim 停滞提醒：每 9 秒（最多 2 次）
          this.remindT += dt
          if (this.remindT >= REMIND_EVERY && this.remindN < REMIND_MAX) {
            this.remindT = 0
            this.remindN++
            this.ctx.speak(REMIND_TEXT)
          }
        }
      } else {
        // 出场者无 body：空跳路径（报告 §8.3），cm 记 0
        st.lights = [false, false]
        if (st.phaseT >= NOBODY_TAKEOFF) {
          st.cm = 0
          st.rate = [0, 0, 0]
          st.phase = 'fly'
          st.phaseT = 0
        }
      }
    } else if (st.phase === 'fly') {
      // fly 前 0.5s 继续 rise/armLift 峰值、前 0.25s 继续 up 峰值，实时重算 cm
      if (b && st.took) {
        const s = this.sample(cur, b, dt)
        if (st.phaseT < FLY_PEAK_WIN) {
          st.risePk = Math.max(st.risePk, s.rise)
          st.liftPk = Math.max(st.liftPk, s.lift)
        }
        if (st.phaseT < FLY_UP_WIN) st.upPk = Math.max(st.upPk, s.up)
        this.computeCm(st, st.risePk)
      }
      // 显示值从 cm×0.85 以速率 9/s 逼近 cm
      st.dispCm = Math.min(st.cm, st.dispCm + 9 * dt)
      if (st.phaseT >= FLY_TIME) {
        st.phase = 'land'
        st.phaseT = 0
        this.settle(cur)
        // 落点沙尘
        this.particles.burst(this.xOf(st.cm), this.H * 0.67 + 6, '#d9b26a', 16, 260, 4)
      }
    } else if (st.phase === 'land') {
      // 达标/破纪录起身欢呼在渲染层表现
      if (st.phaseT >= LAND_TIME) {
        st.phase = 'walk'
        st.phaseT = 0
      }
    } else if (st.phase === 'walk') {
      if (st.phaseT >= WALK_TIME) {
        st.phase = 'idle'
        st.phaseT = 0
        this.nextTurn()
      }
    }

    // 最好成绩飘旗逼近 best（5/s）
    for (let pi = 0; pi < 2; pi++) {
      const p = this.ps[pi]
      p.flagCm = Math.min(p.best, p.flagCm + 5 * dt)
    }

    this.updateHud()
  }

  private updateHud() {
    this.ctx.setScore(this.score)
    this.ctx.setExtra('最好成绩(厘米)', this.globalBest)
    const all = [...this.ps[0].marks, ...this.ps[1].marks]
    const avg = all.length ? Math.round(all.reduce((n, v) => n + v, 0) / all.length) : 0
    this.ctx.setExtra('平均(厘米)', avg)
    this.ctx.setExtra('动作到位(跳)', this.ps[0].full + this.ps[1].full)
  }

  // ---------- 渲染几何（对齐报告 §2 渲染标尺） ----------

  private u() {
    return this.H / 720
  }

  private athleteS() {
    return Math.min(182 * this.u(), this.H * 0.25)
  }

  private lineX() {
    return Math.max(this.W * 0.19, this.athleteS() * 1.25)
  }

  private ppcm() {
    return (this.W - 22 * this.u() - 34 * this.u() - this.lineX()) / RULER_CM
  }

  private xOf(cm: number) {
    return this.lineX() + cm * this.ppcm()
  }

  private groundY() {
    return this.H * 0.67
  }

  // ---------- 渲染 ----------

  /** 画一个卡通运动员：x 为髋部锚点，pose 决定姿态 */
  private athlete(
    c: CanvasRenderingContext2D,
    x: number,
    hipY: number,
    s: number,
    color: string,
    pose: { squat: number; armPhase: number; cheer: boolean; jump: boolean },
    t: number,
  ) {
    const headR = s * 0.16
    const legL = s * 0.34 * (1 - pose.squat * 0.42)
    const torso = s * 0.38 * (1 - pose.squat * 0.18)
    const shoulderY = hipY - torso
    const headY = shoulderY - headR * 1.25
    c.save()
    c.lineCap = 'round'
    // 腿
    c.strokeStyle = '#2b3a67'
    c.lineWidth = s * 0.09
    const spread = pose.jump ? s * 0.3 : s * 0.14
    for (const sd of [-1, 1]) {
      c.beginPath()
      c.moveTo(x, hipY)
      c.lineTo(x + sd * spread * 0.6, hipY + legL * 0.55)
      c.lineTo(x + sd * spread, hipY + legL)
      c.stroke()
    }
    // 躯干
    c.strokeStyle = color
    c.lineWidth = s * 0.13
    c.beginPath()
    c.moveTo(x, hipY)
    c.lineTo(x, shoulderY)
    c.stroke()
    // 手臂：armPhase 0=垂放/后摆 1=前上举；欢呼时 sin 挥手
    let lift = pose.armPhase
    if (pose.cheer) lift = 1
    const armL = s * 0.3
    const handY = shoulderY + (1 - lift) * armL * 1.15
    const handX = x + (pose.cheer ? Math.sin(t * 10) * s * 0.1 : 0) + lift * s * 0.22
    c.strokeStyle = color
    c.lineWidth = s * 0.08
    for (const sd of [-1, 1]) {
      c.beginPath()
      c.moveTo(x, shoulderY + s * 0.02)
      c.quadraticCurveTo(x + sd * s * 0.12, shoulderY + armL * 0.5, x + handX + sd * s * 0.06, handY)
      c.stroke()
    }
    // 头
    circle(c, x, headY, headR, '#ffd9b3')
    c.fillStyle = '#243b6b'
    c.beginPath()
    c.arc(x - headR * 0.32, headY - headR * 0.1, headR * 0.1, 0, Math.PI * 2)
    c.arc(x + headR * 0.32, headY - headR * 0.1, headR * 0.1, 0, Math.PI * 2)
    c.fill()
    c.restore()
  }

  paint(c: CanvasRenderingContext2D) {
    const u = this.u()
    const s = this.athleteS()
    const gx = this.lineX()
    const gy = this.groundY()
    const L = Math.max(1, this.present())

    c.save()
    // 落地震屏
    if (this.shakeT > 0) {
      const amp = 4 * (this.shakeT / 0.35)
      c.translate(Math.sin(this.t * 70) * amp, Math.cos(this.t * 63) * amp * 0.6)
    }

    // 地面（半透明让摄像头可见）：跑道 + 沙坑
    c.fillStyle = 'rgba(126,164,96,.42)'
    c.fillRect(0, gy, gx + 8, this.H - gy)
    c.fillStyle = 'rgba(238,203,142,.6)'
    c.fillRect(gx + 8, gy - s * 0.12, this.W - gx, this.H - gy + s * 0.12)
    // 沙坑颗粒
    c.fillStyle = 'rgba(160,120,60,.35)'
    for (const sp of this.speckles) {
      const px = gx + 14 + sp.x * (this.W - gx - 28)
      const py = gy + 4 + sp.y * (this.H - gy - 8)
      c.beginPath()
      c.arc(px, py, sp.r * u, 0, Math.PI * 2)
      c.fill()
    }

    // 标尺：刻度每 10cm，数字每 50cm（50~250）
    c.textAlign = 'center'
    for (let cm = 0; cm <= RULER_CM; cm += 10) {
      const x = this.xOf(cm)
      const major = cm % 50 === 0
      c.strokeStyle = major ? 'rgba(255,255,255,.85)' : 'rgba(255,255,255,.4)'
      c.lineWidth = major ? 3 : 1.5
      c.beginPath()
      c.moveTo(x, gy + 4)
      c.lineTo(x, gy + (major ? 20 : 11) * u)
      c.stroke()
      if (major && cm >= 50 && cm <= 250) {
        txt(c, String(cm), x, gy + 36 * u, 15 * u, 'rgba(255,255,255,.9)')
      }
    }

    // 起跳线（白条 + 文字）
    c.fillStyle = 'rgba(255,255,255,.92)'
    rr(c, gx - 3 * u, gy - s * 0.72, 6 * u, s * 0.72 + 6 * u, 3 * u)
    c.fill()
    txt(c, '起跳线', gx, gy + 58 * u, 17 * u, 'rgba(255,255,255,.95)', 'center', 'bold')

    // 每跳落点：小椭圆足印 + 编号小旗（旗色按玩家）
    for (let pi = 0; pi < 2; pi++) {
      const st = this.ps[pi]
      st.marks.forEach((m, i) => {
        if (L === 1 && pi > 0) return
        const x = this.xOf(m)
        if (x > this.W - 10) return
        c.save()
        c.globalAlpha = 0.75
        c.fillStyle = pi === 0 ? 'rgba(120,90,50,.8)' : 'rgba(90,110,140,.8)'
        c.beginPath()
        c.ellipse(x, gy + 8 * u, 14 * u, 5 * u, 0, 0, Math.PI * 2)
        c.fill()
        c.restore()
        // 编号小旗
        const fy = gy - s * 0.5
        c.strokeStyle = this.players[pi].color
        c.lineWidth = 2.5 * u
        c.beginPath()
        c.moveTo(x, fy + 26 * u)
        c.lineTo(x, gy)
        c.stroke()
        c.fillStyle = this.players[pi].color
        c.beginPath()
        c.moveTo(x, fy)
        c.lineTo(x + 18 * u, fy + 7 * u)
        c.lineTo(x, fy + 14 * u)
        c.closePath()
        c.fill()
        txt(c, String(i + 1), x + 9 * u, fy + 7 * u, 11 * u, '#20304d', 'center', 'bold')
      })
    }

    // 最好成绩飘旗（flagCm 以 5/s 逼近 best）
    for (let pi = 0; pi < L; pi++) {
      const st = this.ps[pi]
      if (st.best <= 0) continue
      const x = this.xOf(st.flagCm)
      const fy = gy - s * 1.15
      glow(c, x, fy + 20 * u, 30 * u, this.players[pi].color, 0.25)
      c.strokeStyle = '#fff'
      c.lineWidth = 3 * u
      c.beginPath()
      c.moveTo(x, fy + 40 * u)
      c.lineTo(x, fy)
      c.stroke()
      c.fillStyle = this.players[pi].color
      c.beginPath()
      c.moveTo(x, fy)
      c.lineTo(x + 26 * u, fy + 9 * u)
      c.lineTo(x, fy + 18 * u)
      c.closePath()
      c.fill()
      txt(c, `${st.best}`, x + 13 * u, fy + 9 * u, 12 * u, '#20304d', 'center', 'bold')
    }

    // 运动员：出场者走状态机，等待者站等待区（lineX − 0.88s）；结算时胜者欢呼 2.4s
    for (let pi = 0; pi < L; pi++) {
      const st = this.ps[pi]
      const color = this.players[pi].color
      if (this.ended) {
        const win = L === 1 || st.best >= Math.max(...this.ps.slice(0, L).map((q) => q.best))
        this.athlete(
          c,
          this.xOf(st.best) || this.lineX(),
          this.groundY() - s * 0.72,
          s * 0.72,
          color,
          { squat: 0, armPhase: 1, cheer: win && st.best > 0, jump: false },
          this.t,
        )
        continue
      }
      if (pi !== this.cur || st.phase === 'idle') {
        // 等待区站位
        const wx = gx - 0.88 * s
        this.athlete(c, wx, gy - s * 0.72, s * 0.72, color, { squat: 0, armPhase: 0, cheer: false, jump: false }, this.t)
        continue
      }
      if (st.phase === 'aim') {
        const liveSquat = st.lights[1] ? 0.5 : st.lights[0] ? 0.2 : 0
        const arm = st.lights[0] ? 0 : 0.1
        this.athlete(c, gx, gy - s * (0.72 - liveSquat * 0.3), s, color, { squat: liveSquat, armPhase: arm, cheer: false, jump: false }, this.t)
      } else if (st.phase === 'fly') {
        const p = Math.min(1, st.phaseT / FLY_TIME)
        const x = gx + (this.xOf(st.cm) - gx) * p
        const y = gy - s * (0.72 + Math.sin(p * Math.PI) * 0.55)
        this.athlete(c, x, y, s, color, { squat: 0, armPhase: 1, cheer: false, jump: true }, this.t)
      } else if (st.phase === 'land') {
        const inSand = st.phaseT < 0.22 // 前 0.22s 入沙
        const settleP = Math.min(1, st.phaseT / 0.5)
        const x = this.xOf(st.cm)
        const squat = inSand ? 0.9 : (1 - settleP) * 0.6
        const cheer = st.wasRecord && st.phaseT > 0.22
        this.athlete(c, x, gy - s * (0.72 - squat * 0.3), s, color, { squat, armPhase: cheer ? 1 : 0.2, cheer, jump: false }, this.t)
      } else if (st.phase === 'walk') {
        const p = Math.min(1, st.phaseT / WALK_TIME)
        const x = this.xOf(st.cm) + (gx - this.xOf(st.cm)) * p
        const bob = Math.abs(Math.sin(this.t * 8)) * s * 0.04
        this.athlete(c, x, gy - s * (0.72 - bob), s, color, { squat: 0, armPhase: 0.1, cheer: false, jump: false }, this.t)
      }
    }

    c.restore()

    this.paintLamps(c, u)
    this.paintMarksTable(c, u, L)
    this.paintWords(c, u)

    // 免责声明（站点大屏显示）
    txt(
      c,
      '※ 距离是按动作估算的游戏成绩（蹲多深、摆臂多快、蹬多高），不是真的测量',
      this.W / 2,
      this.H - 20,
      16 * u,
      'rgba(255,255,255,.72)',
    )
  }

  /** 三盏质量灯：aim 中未亮的下一盏脉冲（1+sin(clock*7)*0.06），落地后按 rate 亮星 */
  private paintLamps(c: CanvasRenderingContext2D, u: number) {
    const st = this.ps[this.cur]
    const x0 = this.W * 0.6
    const y = 60 * u
    for (let i = 0; i < 3; i++) {
      const x = x0 + i * 84 * u
      const on = st.lights[i] || st.phase !== 'aim'
      let alpha = on ? 1 : 0.28
      // 未亮的下一盏脉冲提示
      const nextIdx = st.lights[0] ? 1 : 0
      if (st.phase === 'aim' && !st.took && i === nextIdx && !st.lights[i]) alpha = 1 + Math.sin(this.t * 7) * 0.06
      c.save()
      c.globalAlpha = Math.min(1, alpha)
      glow(c, x, y, 26 * u, on ? '#ffd54a' : '#8a93b8', on ? 0.35 : 0.12)
      circle(c, x, y, 17 * u, on ? '#ffd54a' : 'rgba(255,255,255,.25)')
      txt(c, LAMP_LABELS[i], x, y + 34 * u, 15 * u, 'rgba(255,255,255,.9)', 'center', 'bold')
      c.restore()
      // 落地后评分星：分量 ≥0.8→3 星 / ≥0.5→2 / ≥0.2→1
      if (st.marks.length > 0 && st.phase !== 'aim') {
        const v = st.rate[i]
        const nStar = v >= 0.8 ? 3 : v >= 0.5 ? 2 : v >= 0.2 ? 1 : 0
        for (let k = 0; k < nStar; k++) star(c, x - 16 * u + k * 16 * u, y - 30 * u, 7 * u, '#ffd54a')
      }
    }
  }

  /** 成绩表 HUD：成绩（厘米）/ 第 n / 5 跳；当前待跳格闪框，最好成绩格金黄 */
  private paintMarksTable(c: CanvasRenderingContext2D, u: number, L: number) {
    const x1 = this.W - 26 * u
    const w = 196 * u
    const rowH = 34 * u
    const cellW = (w - 12 * u) / JUMPS
    const y0 = this.H * 0.24
    c.fillStyle = 'rgba(10,16,44,.5)'
    rr(c, x1 - w, y0, w, 46 * u + rowH * L + 8 * u, 14 * u)
    c.fill()
    txt(c, L > 1 ? '成绩（厘米）' : '成绩', x1 - w / 2, y0 + 20 * u, 17 * u, '#ffd54a', 'center', 'bold')
    const st = this.ps[this.cur]
    const curN = Math.min(JUMPS, st.marks.length + 1)
    txt(c, `第 ${curN} / ${JUMPS} 跳`, x1 - w / 2, y0 + 40 * u, 14 * u, 'rgba(255,255,255,.85)')
    for (let pi = 0; pi < L; pi++) {
      const p = this.ps[pi]
      const ry = y0 + 46 * u + pi * rowH
      const isCur = pi === this.cur && !this.ended
      for (let i = 0; i < JUMPS; i++) {
        const cx = x1 - w + 6 * u + i * cellW
        const has = i < p.marks.length
        const bestHere = has && p.marks[i] === p.best && p.best > 0
        c.fillStyle = bestHere ? 'rgba(255,213,74,.85)' : has ? 'rgba(255,255,255,.16)' : 'rgba(255,255,255,.08)'
        rr(c, cx + 2 * u, ry + 2 * u, cellW - 6 * u, rowH - 8 * u, 6 * u)
        c.fill()
        // 当前待跳格闪框
        if (isCur && i === p.marks.length && this.ps[pi].marks.length < JUMPS) {
          c.save()
          c.globalAlpha = 0.5 + Math.sin(this.t * 7) * 0.4
          c.strokeStyle = this.players[pi].color
          c.lineWidth = 2.5 * u
          rr(c, cx + 2 * u, ry + 2 * u, cellW - 6 * u, rowH - 8 * u, 6 * u)
          c.stroke()
          c.restore()
        }
        if (has) {
          txt(c, String(p.marks[i]), cx + cellW / 2, ry + rowH / 2 - 1 * u, 14 * u, bestHere ? '#20304d' : '#fff', 'center', 'bold')
        } else if (isCur && i === p.marks.length) {
          txt(c, '?', cx + cellW / 2, ry + rowH / 2 - 1 * u, 14 * u, 'rgba(255,255,255,.5)', 'center', 'bold')
        }
      }
    }
  }

  /** 大字成绩（fly 期间从 cm×0.85 滚动逼近）+ 新纪录 + 横幅 */
  private paintWords(c: CanvasRenderingContext2D, u: number) {
    const st = this.ps[this.cur]
    if ((st.phase === 'fly' || st.phase === 'land') && st.cm > 0) {
      const x = Math.min(this.W - 90 * u, Math.max(90 * u, this.xOf(st.dispCm)))
      outlineTxt(c, `${Math.round(st.dispCm)}`, x, this.groundY() - this.athleteS() * 1.5, 44 * u, this.bigWordColor)
      txt(c, '厘米', x, this.groundY() - this.athleteS() * 1.5 + 30 * u, 18 * u, 'rgba(255,255,255,.9)')
      if (this.recordWordT > 0) {
        outlineTxt(c, '新纪录！', x, this.groundY() - this.athleteS() * 1.5 - 40 * u, 30 * u, '#ff5c5c')
      }
    }
    if (this.bannerT > 0) {
      c.globalAlpha = Math.min(1, this.bannerT / 0.3)
      outlineTxt(c, this.bannerText, this.W / 2, this.H * 0.14, 46 * u, '#ffffff')
      if (this.bannerSub) outlineTxt(c, this.bannerSub, this.W / 2, this.H * 0.14 + 44 * u, 26 * u, '#ffd54a')
      c.globalAlpha = 1
    } else if (this.ended) {
      outlineTxt(c, this.bannerText, this.W / 2, this.H * 0.14, 46 * u, '#ffd54a')
      if (this.bannerSub) outlineTxt(c, this.bannerSub, this.W / 2, this.H * 0.14 + 44 * u, 26 * u, '#ffffff')
    }
  }
}

export default function create(ctx: GameContext) {
  return new LongJump(ctx)
}
