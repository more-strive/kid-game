import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, glow, outlineTxt, rr, txt } from '@/core/draw'

/**
 * 游泳比赛（对齐 dongdongpark 真实规则，逆向报告 _reverse/reports/swim-race.md）：
 * 竞速游泳——两臂轮流从头顶前伸划水前进（腕回落过肩线记一次划水，交替才有全速 1.25 / 同侧 0.6），
 * 按提示转头换气（归位武装 armed + 保持 0.08s），氧气不足会减速；单人 vs 小海豚、双人上下泳道对拼。
 * 计分：到壁 score += round(400×赛程/用时)；未完成按已游距离给“加油”分；G 时程表（首名到 +12s、
 * 全员到 +2.5s、90s 强收）由本文件调度后调用 finish()（catalog duration=0）。
 *
 * 站点框架行为等价代理说明：
 * - 本框架无 e.big 大屏标志，按儿童模式（F=!big）实现：length=min(难,25)、bot×0.82、every+1、
 *   drop=0.18 固定、换气窗 window=4（大屏 3）、最短宽限 windowMin=2.2（大屏 1.2）、
 *   转头阈值 turnOn=0.35（大屏 0.45）、HUD 只显 {里程} 米（大屏另有秒表与速度）。
 * - motion.turn（转头量）：用头中心相对肩中线的横向偏移 ÷ 肩宽 折算（引擎侧定义未随报告给出）。
 * - 站点玩家 AI（§7 {hands,turn}，划臂相位 + 80% 概率换气）在双人模式下为缺 body 的泳道补位，
 *   保证赛程能推进到结算；单人无 body 时泳者原地漂浮等真人。
 * - 顶部 progress({kind:'race'}) 无对应框架 API，用 setStage 显示赛程文案（等价代理）。
 * - 音效映射：bubble→pop(0.8/1.4 变速)、splash→drop(1.4 变速)、oops→fail、到壁 tada→fanfare、
 *   海豚 boop→pop；开场哨由外壳倒计时结束的 whistle 提供。
 * - 双人共享 score 取两名玩家得分的较大值（站点壳层按人对照星级，本壳层只有一个分数槽）。
 */

// ---- 难度表 v（基础值，全部字面量） ----
const DIFF = [
  { length: 25, bot: 1.15, every: 6, drop: 0.3 },
  { length: 50, bot: 1.5, every: 5, drop: 0.35 },
  { length: 50, bot: 1.8, every: 4, drop: 0.35 },
]
// 儿童模式覆盖（F=!big）
const KID_BOT = 0.82
const KID_DROP = 0.18
const BREATH_WIN = 4 // 换气提示窗口秒（大屏 3）
const BREATH_MIN = 2.2 // 提示后最少等待，不足不判失败（大屏 1.2）
const TURN_ON = 0.35 // 转头有效阈值（大屏 0.45）

// ---- 模块级字面量 ----
const TURN_REARM = 0.3 // 转头归位死区：|turn|<0.3 重新武装
const STROKE_ALT = 1.25 // 交替划水速度增量（米/秒）
const STROKE_SAME = 0.6 // 同侧重复划水速度增量
const V_MAX = 3.2 // 速度上限（米/秒）
const GLIDE_T = 0.55 // 入水滑行时长（秒）
const DIVE_BOOST = 1.8 // 入水瞬间初速增量
const START_D = -0.35 // 出发位置（米，线后）
const WALL_K = 0.44 // 身体中心到触壁偏移：d+k ≥ R 判到达
const TIME_CAP = 90 // 全局时间上限（秒）
const SCORE_K = 400 // 得分系数：score = round(400 × 赛程 / 用时)
const SAME_SIDE_CD = 0.15 // 同侧再触发防抖（秒）
const SPLASH_CD = 0.12 // 水花音限频（秒）
const BOT_LATE = 0.3 // 海豚延迟出发（秒）
const BOT_TAU = 2.5 // 海豚速度逼近 τ
const BOT_SEG = 5 // 海豚分段长度（米，段内随机 0.9~1.1 线性插值）
const SPOUT_MIN = 3.5 // 海豚喷水间隔 3.5 + rand×2 秒
const DIVE_DIST = 2.35 // 出发台滑行距离（米）
const GAS_T = 0.7 // 吸气表情时长
const MISS_T = 1.4 // 喘气表情时长
const OXY_FLOOR = 0.25 // 氧气下限
const TURN_HOLD = 0.08 // 转头需持续时长
const FIRST_BONUS = 12 // 首名到 → G=min(G, t+12)
const ALL_BONUS_DUO = 2.5 // 全员到 → +2.5s（单人 +3）
const TOUCH_DECAY = 1.25 // 触壁后惯性减速 v *= exp(-1.25dt)
const SWIM_DRAG = 0.8 // 水中漂阻（米/秒²）：报告未给漂阻系数（§8 空缺），按入水滑行约 2m 量级反推的等价代理
const SWIM_PX = 78 // 泳者渲染基准（px @720p，对应 A=1.75 米的比例映射）
const DOLPHIN_M = 2 // j：海豚渲染尺寸（米）

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v))
}
function clamp01(v: number) {
  return clamp(v, 0, 1)
}
/** smoothstep 缓动（入水滑行） */
function easeSS(x: number) {
  const t = clamp01(x)
  return t * t * (3 - 2 * t)
}

/** 每帧划水/换气输入：真身来自 Body，缺位 AI 合成同构数据 */
interface SwimInput {
  shoulderY: number // 肩中线 y（归一化）
  headY: number
  torso: number // 归一化躯干
  turn: number // 转头量 −1~1
  handY: [number, number] // 左/右腕 y
  vis: [boolean, boolean] // 腕可见度 ≥0.2
}

type Phase = 'dive' | 'swim' | 'done'

interface Swimmer {
  isDolphin: boolean
  idx: number // 玩家序号（渲染/AI 相位用）
  d: number
  v: number
  phase: Phase
  phaseT: number
  botDelay: number // 海豚出发延迟
  // 划水检测
  raised: [boolean, boolean]
  armH: [number, number]
  strokes: number
  alt: number
  lastHand: number // -1 无 / 0 左 / 1 右
  lastSideT: [number, number]
  splashCd: number
  splashFx: number // 划水水花计时
  // 换气
  oxy: number
  oxyShow: number
  since: number
  promptT: number // >0 = 提示剩余
  promptAge: number
  armed: boolean
  turnHold: number
  breaths: number
  prompts: number
  gaspT: number
  missT: number
  missVoiced: boolean
  needRearm: boolean // 未归位就转头 → 提示“脸先转回来”
  // 竞速
  time: number // 触壁精确用时（0=未完赛）
  place: number
  arrived: boolean
  maxV: number
  halfCheer: boolean
  kick: number
  score: number
  // 海豚
  botB: number[] // 每 5 米段倍率
  spoutT: number
}

function newSwimmer(isDolphin: boolean, idx: number): Swimmer {
  return {
    isDolphin,
    idx,
    d: START_D,
    v: 0,
    phase: 'dive',
    phaseT: 0,
    botDelay: isDolphin ? BOT_LATE : 0,
    raised: [false, false],
    armH: [0, 0],
    strokes: 0,
    alt: 0,
    lastHand: -1,
    lastSideT: [-9, -9],
    splashCd: 0,
    splashFx: 0,
    oxy: 1,
    oxyShow: 1,
    since: 0,
    promptT: 0,
    promptAge: 0,
    armed: false,
    turnHold: 0,
    breaths: 0,
    prompts: 0,
    gaspT: 0,
    missT: 0,
    missVoiced: false,
    needRearm: false,
    time: 0,
    place: 0,
    arrived: false,
    maxV: 0,
    halfCheer: false,
    kick: 0,
    score: 0,
    botB: [],
    spoutT: SPOUT_MIN + Math.random() * 2,
  }
}

class SwimRace extends BaseGame implements Game {
  base = DIFF[this.ctx.difficulty] ?? DIFF[1]
  /** 儿童模式生效值（F=!big） */
  R = Math.min((DIFF[this.ctx.difficulty] ?? DIFF[1]).length, 25)
  bot = (DIFF[this.ctx.difficulty] ?? DIFF[1]).bot * KID_BOT
  every = (DIFF[this.ctx.difficulty] ?? DIFF[1]).every + 1
  drop = KID_DROP

  swimmers: Swimmer[] = []
  duo = false
  started = false
  raceT = 0
  /** 收尾时程（秒）：首名到 +12s、全员到 +2.5/3s、90s 强收 */
  G = TIME_CAP
  score = 0
  arriveCount = 0
  firstBannerDone = false
  finishing = false
  finished = false
  /** 换气语音：前 3 次、2.5s 冷却 */
  turnHintN = 0
  lastVoiceTurn = -9

  constructor(ctx: GameContext) {
    super(ctx)
  }

  /** 首个有效帧确定编队：双人=上下两条泳道对拼（无海豚）；单人=上道玩家 + 下道海豚 */
  private roster() {
    if (this.started) return
    this.duo = this.players.filter((p) => p.body).length > 1
    this.swimmers = this.duo
      ? [newSwimmer(false, 0), newSwimmer(false, 1)]
      : [newSwimmer(false, 0), newSwimmer(true, 1)]
    this.started = true
    this.ctx.setStage(`${this.R} 米自由泳`)
  }

  // ---------- 输入 ----------

  /** 真身 → SwimInput；转头量用 头相对肩中线横偏 ÷ 肩宽 代理 */
  private inputOf(b: Body): SwimInput {
    const torso = Math.max(0.05, b.scale)
    const width = Math.max(0.04, Math.abs(b.lShoulder.x - b.rShoulder.x))
    const turn = clamp((b.head.x - b.shoulderC.x) / width, -1, 1)
    return {
      shoulderY: b.shoulderC.y,
      headY: b.head.y,
      torso,
      turn,
      handY: [b.lHand.y, b.rHand.y],
      vis: [(b.lm[15]?.visibility ?? 0) >= 0.2, (b.lm[16]?.visibility ?? 0) >= 0.2],
    }
  }

  /** 缺位玩家 AI（报告 §7）：划臂相位 o<0.5 左举右落、反之互换；提示 >0.4s 后 80% 概率转头 */
  private aiInput(sw: Swimmer): SwimInput {
    const torso = 0.19
    const shoulderY = 0.55
    const headY = 0.45
    const t = this.raceT + sw.idx * 0.23
    const o = (t * 0.85 + 0.05 * Math.sin(t * 0.5 + sw.idx * 2)) % 1
    const upY = headY - 0.6 * torso
    const downY = shoulderY + 0.85 * torso
    const left = o < 0.5
    let turn = 0
    const hash = Math.abs(Math.sin(sw.idx * 12.9898 + Math.floor(this.raceT) * 78.233) * 43758.5453) % 1
    if (sw.promptT > 0 && sw.promptAge > 0.4 && hash >= 0.2) {
      turn = sw.prompts % 2 ? 0.8 : -0.8 // 80% 概率换气（20% 故意错过）
    }
    return {
      shoulderY,
      headY,
      torso,
      turn,
      handY: left ? [upY, downY] : [downY, upY],
      vis: [true, true],
    }
  }

  // ---------- 划水 ----------

  private strokeDetect(sw: Swimmer, inp: SwimInput) {
    const shoulderLine = inp.shoulderY + 0.2 * inp.torso
    const headLine = inp.headY + 0.1 * inp.torso
    for (let side = 0; side < 2; side++) {
      if (!inp.vis[side]) continue // 可见度 <0.2 的腕跳过
      const y = inp.handY[side]
      sw.armH[side] = clamp01((shoulderLine - y) / Math.max(0.02, shoulderLine - headLine))
      if (y < headLine) {
        sw.raised[side] = true // 举过头
      } else if (sw.raised[side] && y > shoulderLine) {
        // up 状态下腕回落过肩线 → 记一次划水
        sw.raised[side] = false
        this.onStroke(sw, side)
      }
    }
  }

  private onStroke(sw: Swimmer, side: number) {
    if (sw.phase === 'done') return
    const now = this.raceT
    if (now - sw.lastSideT[side] < SAME_SIDE_CD) return // 同侧防抖
    sw.lastSideT[side] = now
    const isAlt = sw.lastHand !== side
    const gain = isAlt ? STROKE_ALT : STROKE_SAME
    if (sw.phase === 'swim') sw.v = Math.min(V_MAX, sw.v + gain * (0.6 + 0.4 * sw.oxy))
    if (isAlt) sw.alt++
    sw.lastHand = side
    sw.strokes++
    sw.splashFx = 0.18
    if (now - sw.splashCd > SPLASH_CD) {
      sw.splashCd = now
      this.ctx.audio.play('drop', 0.45, 1.4) // splash
    }
    if (!sw.isDolphin) {
      sw.since++
      if (sw.promptT <= 0 && sw.since >= this.every) {
        // 换气提示（fe）
        sw.since = 0
        sw.promptT = BREATH_WIN
        sw.promptAge = 0
        sw.armed = false
        sw.turnHold = 0
        sw.prompts++
        this.ctx.audio.play('pop', 0.8, 0.8) // bubble
        if (this.turnHintN < 3 && this.raceT - this.lastVoiceTurn > 2.5) {
          this.turnHintN++
          this.lastVoiceTurn = this.raceT
          this.ctx.speak('转头换气')
        }
      }
    }
  }

  /** 换气循环：归位武装 → |turn|>turnOn 持续 0.08s 成功；超窗且≥windowMin 失败扣氧 */
  private breath(sw: Swimmer, inp: SwimInput, dt: number) {
    if (sw.promptT <= 0) {
      sw.needRearm = false
      return
    }
    sw.promptAge += dt
    sw.promptT -= dt
    if (!sw.armed) {
      if (Math.abs(inp.turn) < TURN_REARM) sw.armed = true
      sw.needRearm = Math.abs(inp.turn) > TURN_ON
    } else {
      sw.needRearm = false
    }
    if (sw.armed && Math.abs(inp.turn) > TURN_ON) {
      sw.turnHold += dt
      if (sw.turnHold >= TURN_HOLD) {
        // 成功：氧气回满
        sw.promptT = 0
        sw.oxy = 1
        sw.breaths++
        sw.gaspT = GAS_T
        const p = this.swimPos(sw)
        this.say('换气！', p.x + 60, p.y - 60, '#9fe8ff', 30)
        this.ctx.audio.play('pop', 1, 1.4) // bubble
        for (let i = 0; i < 8; i++) {
          this.particles.burst(p.x, p.y - 10, 'rgba(190,235,255,.9)', 1, 120, 4, -60)
        }
        return
      }
    } else {
      sw.turnHold = Math.max(0, sw.turnHold - dt * 2)
    }
    // 失败：超窗且距提示 ≥ windowMin
    if (sw.promptT <= 0 && sw.promptAge >= BREATH_MIN) {
      sw.oxy = Math.max(OXY_FLOOR, sw.oxy - this.drop)
      sw.missT = MISS_T
      this.ctx.audio.fail() // oops
      const p = this.swimPos(sw)
      this.say('憋气啦', p.x, p.y - 70, '#ffb703', 32) // 大屏文案为“没换气，变慢了”
      if (!sw.missVoiced) {
        sw.missVoiced = true
        this.ctx.speak('记得转头换气，不然会变慢')
      }
    }
  }

  // ---------- 泳者推进 ----------

  private tickSwimmer(sw: Swimmer, b: Body | null, dt: number) {
    sw.phaseT += dt
    sw.splashFx = Math.max(0, sw.splashFx - dt)
    sw.gaspT = Math.max(0, sw.gaspT - dt)
    sw.missT = Math.max(0, sw.missT - dt)
    sw.kick += dt * (3 + sw.v * 5)

    // 输入：真身优先；双人缺位泳道由 AI 补位（单人无 body 不代打）
    const needAI = sw.isDolphin || (this.duo && !b)
    const inp = sw.isDolphin ? null : b ? this.inputOf(b) : needAI ? this.aiInput(sw) : null

    // 出发滑行 d = O + 2.35×ease(t/0.55)，入水 v += 1.8
    if (sw.phase === 'dive') {
      if (sw.phaseT >= sw.botDelay) {
        const gt = clamp01((sw.phaseT - sw.botDelay) / GLIDE_T)
        sw.d = START_D + DIVE_DIST * easeSS(gt)
        if (gt >= 1) {
          sw.phase = 'swim'
          sw.phaseT = 0
          sw.v += DIVE_BOOST
          const p = this.swimPos(sw)
          this.particles.burst(p.x, p.y, '#bfe9ff', 22, 320, 4)
          this.particles.burst(p.x, p.y, 'rgba(255,255,255,.9)', 10, 200, 5, 200)
        }
      }
    } else if (sw.phase === 'swim') {
      if (sw.isDolphin) {
        // 海豚：bot × 每 5 米段随机 0.9~1.1（线性插值），τ=2.5 逼近
        const k = Math.floor(Math.max(0, sw.d) / BOT_SEG)
        while (sw.botB.length < k + 2) sw.botB.push(0.9 + Math.random() * 0.2)
        const frac = (Math.max(0, sw.d) - k * BOT_SEG) / BOT_SEG
        const target = this.bot * (sw.botB[k] + (sw.botB[k + 1] - sw.botB[k]) * frac)
        sw.v += (target - sw.v) * Math.min(1, dt / BOT_TAU)
        sw.d += sw.v * dt
        // 海豚喷水
        sw.spoutT -= dt
        if (sw.spoutT <= 0) {
          sw.spoutT = SPOUT_MIN + Math.random() * 2
          const p = this.swimPos(sw)
          this.particles.burst(p.x, p.y - 20, 'rgba(200,240,255,.9)', 10, 180, 4, 500)
        }
      } else {
        // 水中漂阻：不划水会滑行减速停下（漂阻系数为等价代理，见常量注释）
        sw.v = Math.max(0, sw.v - SWIM_DRAG * dt)
        sw.d += sw.v * dt
        sw.maxV = Math.max(sw.maxV, sw.v)
        // 中途鼓励：单人游过半程（一次）
        if (!this.duo && !sw.halfCheer && sw.d >= this.R / 2) {
          sw.halfCheer = true
          this.ctx.speak('游到一半啦，加油！')
        }
      }
      // 到壁：d + 0.44 ≥ R
      if (sw.d + WALL_K >= this.R) {
        this.onArrive(sw)
      }
    } else {
      // 触壁惯性滑行：v *= exp(−1.25dt)，漂到 d=R−0.44 附近
      sw.v *= Math.exp(-TOUCH_DECAY * dt)
      sw.d += sw.v * dt
      sw.d = Math.min(sw.d, this.R - WALL_K + 0.05)
    }

    // 划水与换气（海豚无换气）
    if (inp) {
      this.strokeDetect(sw, inp)
      if (!sw.isDolphin) this.breath(sw, inp, dt)
    }
    // 氧气显示 τ=5 追真值
    sw.oxyShow += (sw.oxy - sw.oxyShow) * Math.min(1, dt * 5)
  }

  private onArrive(sw: Swimmer) {
    sw.phase = 'done'
    sw.phaseT = 0
    // 用时精确到 0.01s：触壁时刻回推 −(d+k−R)/v（保底 0.01s）
    const overshoot = sw.d + WALL_K - this.R
    const tWall = Math.max(0.01, this.raceT - overshoot / Math.max(0.1, sw.v || 0.1))
    sw.time = Math.round(tWall * 100) / 100
    sw.arrived = true
    sw.d = this.R - WALL_K
    sw.maxV = Math.max(sw.maxV, sw.v)
    // 时程表：首名到 +12s；全员到 +2.5s（单人 +3s）
    if (this.arriveCount === 0) this.G = Math.min(this.G, this.raceT + FIRST_BONUS)
    this.arriveCount++
    const players = this.swimmers.filter((s) => !s.isDolphin)
    if (players.every((s) => s.arrived)) {
      this.G = Math.min(this.G, this.raceT + (this.duo ? ALL_BONUS_DUO : 3))
    }
    const p = this.swimPos(sw)
    if (sw.isDolphin) {
      // 海豚到壁
      this.say('小海豚到啦', p.x - 40, p.y - 60, '#8fd3ff', 30)
      this.ctx.audio.pop() // boop
      return
    }
    sw.place = 1 + this.swimmers.filter((s) => s.arrived && s !== sw).length
    sw.score = Math.round((SCORE_K * this.R) / sw.time)
    this.say(`${sw.time} 秒`, p.x, p.y - 70, '#ffd54a', 34)
    this.ctx.audio.fanfare() // tada
    this.particles.confetti(this.W, 20)
    const pname = sw.idx === 0 ? '1P' : '2P'
    if (!this.firstBannerDone) {
      this.firstBannerDone = true
      if (this.duo) {
        this.bannerText = `${pname} 第一个到！`
        this.bannerSub = `${sw.time} 秒`
        this.bannerT = 2.2
        this.ctx.speak(`${sw.idx === 0 ? '左边' : '右边'}的小朋友第一个到`)
      } else if (sw.place === 1) {
        this.bannerText = '赢了小海豚！'
        this.bannerSub = `${sw.time} 秒`
        this.bannerT = 2.2
        this.ctx.speak('赢了小海豚！')
      } else {
        this.bannerText = '游到终点啦！'
        this.bannerSub = `${sw.time} 秒`
        this.bannerT = 2.2
      }
    }
  }

  /** 收尾：到点未完成者按已游距离给“加油”分后 finish() */
  private finalize() {
    if (this.finishing) return
    this.finishing = true
    for (const sw of this.swimmers) {
      if (sw.isDolphin || sw.arrived) continue
      sw.score = Math.round((SCORE_K * clamp(sw.d + WALL_K, 0, this.R)) / Math.max(this.raceT, 1))
      const p = this.swimPos(sw)
      this.say('加油！', p.x, p.y - 70, '#9fe8ff', 34)
    }
  }

  tick(f: PoseFrame, dt: number) {
    this.roster()
    if (!this.started) return
    if (!this.finished) this.raceT += dt
    this.bannerT = Math.max(0, this.bannerT - dt)

    for (const sw of this.swimmers) {
      const b = sw.isDolphin ? null : (f.bodies[sw.idx] ?? null)
      if (!this.finished) this.tickSwimmer(sw, b, dt)
    }

    // score = 单人取玩家分；双人取较大者（站点壳层按人对照星级，等价代理）
    const players = this.swimmers.filter((s) => !s.isDolphin)
    this.score = players.reduce((n, s) => Math.max(n, s.score), 0)
    this.ctx.setScore(this.score)
    const p0 = players[0]
    const p1 = players[players.length - 1]
    const strokes = players.reduce((n, s) => n + s.strokes, 0)
    const alts = players.reduce((n, s) => n + s.alt, 0)
    const breaths = players.reduce((n, s) => n + s.breaths, 0)
    const prompts = players.reduce((n, s) => n + s.prompts, 0)
    const times = players.filter((s) => s.time > 0).map((s) => s.time)
    this.ctx.setExtra('划水(下)', strokes)
    this.ctx.setExtra('换气(次)', breaths)
    this.ctx.setExtra('换气提示(次)', prompts)
    this.ctx.setExtra('交替(%)', strokes > 0 ? Math.round((alts / strokes) * 100) : 0)
    this.ctx.setExtra('最好用时(秒)', times.length ? Math.min(...times) : 0)
    this.ctx.setExtra('名次', this.duo ? Math.min(p0.place || 9, p1.place || 9) : p0.place || (this.raceT >= this.G ? 2 : 0))
    this.ctx.setExtra('游程(米)', Math.floor(clamp(players[0].d + WALL_K, 0, this.R)))

    // 时程到点：强收 + finish()
    if (!this.finished && this.raceT >= this.G) {
      this.finalize()
      this.finished = true
      this.ctx.finish()
    }
  }

  // ---------- 渲染 ----------

  bannerText = ''
  bannerSub = ''
  bannerT = 0

  /** 里程 → 屏幕 x；泳者所在泳道的基准点 */
  private laneY(sw: Swimmer) {
    return sw.idx === 0 ? this.H * 0.34 : this.H * 0.7
  }

  private swimPos(sw: Swimmer) {
    const x0 = this.W * 0.13
    const x1 = this.W * 0.94
    const x = x0 + (clamp(sw.d, START_D, this.R) / this.R) * (x1 - x0)
    const y = this.laneY(sw)
    return { x, y, x0, x1 }
  }

  paint(c: CanvasRenderingContext2D) {
    if (!this.started) return
    const u = this.H / 720
    const { x0, x1 } = { x0: this.W * 0.13, x1: this.W * 0.94 }

    // 泳池水面（半透明保留摄像头）
    const topY = this.H * 0.18
    const botY = this.H * 0.86
    c.fillStyle = 'rgba(58,142,196,.4)'
    c.fillRect(x0, topY, x1 - x0, botY - topY)
    // 深色中缝带（2 到 R−2）
    const midY = (topY + botY) / 2
    const dx2 = x0 + (2 / this.R) * (x1 - x0)
    const dxR2 = x0 + ((this.R - 2) / this.R) * (x1 - x0)
    c.fillStyle = 'rgba(24,72,110,.4)'
    c.fillRect(dx2, midY - 12 * u, dxR2 - dx2, 24 * u)

    // 泳道浮标线（上缘 / 中缝 / 下缘）：0.3m 间隔，两端 5m 红、中段蓝黄相间
    const ropes = [topY, midY, botY]
    for (const ry of ropes) {
      const n = Math.floor(this.R / 0.5)
      for (let e = 0; e < n; e++) {
        const m = (e / n) * this.R
        const px = x0 + (m / this.R) * (x1 - x0)
        const col = m < 5 || m > this.R - 5 ? '#ff5c5c' : e % 4 < 2 ? '#4cc9f0' : '#ffd54a'
        circle(c, px, ry, 3.5 * u, col)
      }
    }

    // 每 5m/10m 距离数字
    for (let m = 5; m < this.R; m += 5) {
      const px = x0 + (m / this.R) * (x1 - x0)
      txt(c, `${m}`, px, topY - 12 * u, 13 * u, 'rgba(255,255,255,.8)', 'center', 'bold')
    }
    // 5m 处红黄蓝三色三角旗线
    {
      const px = x0 + (5 / this.R) * (x1 - x0)
      const cols = ['#ff5c5c', '#ffd54a', '#4cc9f0']
      for (let i = 0; i < 12; i++) {
        const fy = topY - 30 * u + Math.sin(this.t * 2 + i) * 2 * u
        const fx = px + (i - 6) * 9 * u
        c.fillStyle = cols[i % 3]
        c.beginPath()
        c.moveTo(fx, fy - 10 * u)
        c.lineTo(fx + 7 * u, fy)
        c.lineTo(fx, fy + 4 * u)
        c.closePath()
        c.fill()
      }
    }

    // 出发台与终点触壁板
    c.fillStyle = 'rgba(255,255,255,.75)'
    c.fillRect(x0 - 26 * u, this.H * 0.24, 12 * u, 26 * u)
    c.fillRect(x0 - 30 * u, this.H * 0.24 - 6 * u, 20 * u, 8 * u)
    c.fillStyle = 'rgba(255,255,255,.85)'
    c.fillRect(x1, topY, 7 * u, botY - topY)

    // 泳道名签：上道玩家 / 下道（玩家或海豚）
    for (const sw of this.swimmers) {
      const ly = this.laneY(sw)
      const label = sw.isDolphin ? '🐬 小海豚' : `${sw.idx + 1}P`
      txt(c, label, x0 - 34 * u, ly - 26 * u, 15 * u, sw.isDolphin ? '#8fd3ff' : this.players[sw.idx].color, 'center', 'bold')
    }

    // 泳者 / 海豚
    for (const sw of this.swimmers) {
      if (sw.isDolphin) this.paintDolphin(c, sw, u)
      else this.paintSwimmer(c, sw, u)
    }

    // HUD：氧气条（130u 宽）+ 换气提示 + 里程
    for (const sw of this.swimmers) {
      if (sw.isDolphin) continue
      this.paintBreathHud(c, sw, u)
    }

    // 里程（儿童屏只显 {里程} 米）
    const p0 = this.swimmers[0]
    outlineTxt(c, `${Math.floor(clamp(p0.d + WALL_K, 0, this.R))} 米`, this.W / 2, 40 * u, 30 * u, '#ffffff')

    // 横幅
    if (this.bannerT > 0) {
      c.globalAlpha = Math.min(1, this.bannerT / 0.3)
      outlineTxt(c, this.bannerText || '', this.W / 2, this.H * 0.1, 44 * u, '#ffd54a')
      if (this.bannerSub) outlineTxt(c, this.bannerSub, this.W / 2, this.H * 0.1 + 42 * u, 24 * u, '#ffffff')
      c.globalAlpha = 1
    }

    txt(c, '两臂轮流从头顶往前划，冒泡泡时转头换气，比小海豚先到终点', this.W / 2, this.H - 20, 17 * u, 'rgba(255,255,255,.8)')
  }

  /** 氧气条 + 换气提示（气泡 outBack + 倒计时点阵） */
  private paintBreathHud(c: CanvasRenderingContext2D, sw: Swimmer, u: number) {
    const bx = this.W * 0.05
    const by = this.laneY(sw) - 96 * u
    // 氧气条
    const w = 130 * u
    c.fillStyle = 'rgba(10,16,44,.5)'
    rr(c, bx - 6 * u, by - 14 * u, w + 12 * u, 22 * u, 11 * u)
    c.fill()
    const show = clamp01(sw.oxyShow)
    let col = '#3ddc97'
    if (show < 0.5) col = Math.sin(this.t * 10) > 0 ? '#ff9f1c' : '#ff4d4d' // <0.5 橙/红闪烁
    else if (show < 0.75) col = '#ffd54a'
    c.fillStyle = col
    rr(c, bx, by - 10 * u, w * show, 14 * u, 7 * u)
    c.fill()
    txt(c, '氧气', bx + w + 24 * u, by - 3 * u, 14 * u, 'rgba(255,255,255,.85)', 'left', 'bold')

    // 换气提示：气泡图标 outBack 弹出 + 换气 文字 + window 个倒计时圆点逐个熄灭
    if (sw.promptT > 0) {
      const age = sw.promptAge
      const pop = Math.min(1, age / 0.25)
      const outBack = 1 + 2.7 * Math.pow(pop - 1, 3) + 1.7 * Math.pow(pop - 1, 2) // easeOutBack
      const scale = Math.max(0.01, outBack)
      const px = bx + w / 2
      const py = by - 46 * u
      c.save()
      c.translate(px, py)
      c.scale(scale, scale)
      glow(c, 0, 0, 30 * u, '#9fe8ff', 0.5)
      circle(c, 0, 0, 20 * u, 'rgba(190,235,255,.92)')
      circle(c, -6 * u, -6 * u, 5 * u, 'rgba(255,255,255,.9)')
      circle(c, 4 * u, 2 * u, 3 * u, 'rgba(255,255,255,.8)')
      c.restore()
      outlineTxt(c, '换气', px, py + 36 * u, 20 * u, '#9fe8ff')
      // 倒计时点阵
      const dots = BREATH_WIN
      for (let i = 0; i < dots; i++) {
        const lit = sw.promptT > i * (BREATH_WIN / dots)
        circle(c, px - (dots - 1) * 9 * u + i * 18 * u, py + 58 * u, 5 * u, lit ? '#9fe8ff' : 'rgba(255,255,255,.25)')
      }
      // 未归位就转头 → 提示先回正
      if (sw.needRearm) {
        outlineTxt(c, '脸先转回来', px, py + 80 * u, 18 * u, '#ffb703')
      }
    }
    // 表情字
    if (sw.gaspT > 0) txt(c, '😮', this.swimPos(sw).x + 30, this.swimPos(sw).y - 40, 26 * u)
    else if (sw.missT > 0) txt(c, '😵', this.swimPos(sw).x + 30, this.swimPos(sw).y - 40, 26 * u)
  }

  /** 泳者（侧视）：双臂相位 + 打腿 + 尾迹 + 表情 */
  private paintSwimmer(c: CanvasRenderingContext2D, sw: Swimmer, u: number) {
    const p = this.swimPos(sw)
    const s = SWIM_PX * u // 泳者渲染尺寸（A=1.75 米的比例映射）
    const y = p.y
    const dir = 1 // 向右游
    // 尾迹（v/2.5 强度）
    if (sw.phase === 'swim' && sw.v > 0.3) {
      c.save()
      c.globalAlpha = clamp01(sw.v / 2.5) * 0.4
      c.strokeStyle = '#dff3ff'
      c.lineWidth = 4 * u
      c.beginPath()
      c.moveTo(p.x - dir * s * 0.3, y - s * 0.15)
      for (let i = 1; i <= 4; i++) {
        c.lineTo(p.x - dir * (s * 0.3 + i * s * 0.42), y - s * 0.15 + Math.sin(this.t * 9 + i) * 4 * u)
      }
      c.stroke()
      c.restore()
    }
    // 身体（流线：水平椭圆）
    c.save()
    c.translate(p.x, y)
    const tilt = sw.phase === 'dive' ? -0.25 : Math.sin(this.t * 3) * 0.05
    c.rotate(tilt)
    c.fillStyle = this.players[sw.idx].color
    c.beginPath()
    c.ellipse(0, 0, s * 0.5, s * 0.17, 0, 0, Math.PI * 2)
    c.fill()
    // 头
    circle(c, s * 0.52, -s * 0.1, s * 0.15, '#ffd9b3')
    // 表情：gasp 吸气 / puff 缺氧或失败 / happy 完赛 / calm
    const face = sw.time > 0 ? '😄' : sw.gaspT > 0 ? '😮' : sw.missT > 0 || sw.oxy < 0.5 ? '😟' : '😌'
    txt(c, face, s * 0.62, -s * 0.12, s * 0.22)
    // 双臂：armH 相位（0=水中 1=举过头），举臂侧画头顶弧线
    for (let side = 0; side < 2; side++) {
      const h = sw.armH[side]
      const sx = s * 0.3
      const sy = -s * 0.05
      const ang = -Math.PI * 0.5 + h * Math.PI * 0.9 + (side === 0 ? 0 : Math.PI * 0.25)
      const hx = sx + Math.cos(ang) * s * 0.42
      const hy = sy + Math.sin(ang) * s * 0.42
      c.strokeStyle = 'rgba(255,255,255,.85)'
      c.lineWidth = 5 * u
      c.beginPath()
      c.moveTo(sx, sy)
      c.lineTo(hx, hy)
      c.stroke()
      circle(c, hx, hy, 4.5 * u, '#ffd54a')
    }
    // 打腿
    c.strokeStyle = 'rgba(255,255,255,.75)'
    c.lineWidth = 4.5 * u
    for (const ph of [0, Math.PI]) {
      const a = sw.kick + ph
      c.beginPath()
      c.moveTo(-s * 0.42, 0)
      c.lineTo(-s * 0.62, Math.sin(a) * s * 0.14)
      c.stroke()
    }
    c.restore()
    // 划水水花
    if (sw.splashFx > 0) {
      c.save()
      c.globalAlpha = sw.splashFx / 0.18
      circle(c, p.x + s * 0.5, y - s * 0.35, 10 * u * (sw.splashFx / 0.18), 'rgba(230,248,255,.8)')
      c.restore()
    }
    // 名次/用时标签
    if (sw.time > 0) {
      outlineTxt(c, `第 ${sw.place} 名`, p.x, y + 42 * u, 18 * u, this.players[sw.idx].color)
    }
  }

  /** 小海豚（侧视）：灰蓝身体 + 背鳍 + 尾巴 + 喷水 */
  private paintDolphin(c: CanvasRenderingContext2D, sw: Swimmer, u: number) {
    const p = this.swimPos(sw)
    const s = 52 * u * (DOLPHIN_M / 1.75) // j=2（米）相对泳者 A=1.75 的比例
    const y = p.y + Math.sin(this.t * 2.2) * 5 * u
    const bob = Math.sin(this.t * 3.1) * 0.08
    c.save()
    c.translate(p.x, y)
    c.rotate(bob)
    c.fillStyle = '#6fa8dc'
    c.beginPath()
    c.ellipse(0, 0, s * 0.55, s * 0.2, 0, 0, Math.PI * 2)
    c.fill()
    // 背鳍
    c.beginPath()
    c.moveTo(-s * 0.05, -s * 0.16)
    c.quadraticCurveTo(s * 0.08, -s * 0.5, s * 0.2, -s * 0.14)
    c.closePath()
    c.fill()
    // 尾巴
    c.beginPath()
    c.moveTo(-s * 0.5, 0)
    c.quadraticCurveTo(-s * 0.75, -s * 0.22 + Math.sin(this.t * 7) * s * 0.1, -s * 0.82, -s * 0.05)
    c.quadraticCurveTo(-s * 0.72, s * 0.12, -s * 0.5, s * 0.06)
    c.closePath()
    c.fillStyle = '#5d92c4'
    c.fill()
    // 嘴与眼
    c.strokeStyle = '#33618e'
    c.lineWidth = 2.5 * u
    c.beginPath()
    c.arc(s * 0.5, s * 0.02, s * 0.12, -0.5, 0.6)
    c.stroke()
    circle(c, s * 0.42, -s * 0.05, 3.5 * u, '#1d3a57')
    c.restore()
    // 领先距离标签（大屏功能，儿童模式不显示）
    txt(c, '小海豚', p.x, y + 34 * u, 14 * u, 'rgba(255,255,255,.8)', 'center', 'bold')
  }
}

export default function create(ctx: GameContext) {
  return new SwimRace(ctx)
}
