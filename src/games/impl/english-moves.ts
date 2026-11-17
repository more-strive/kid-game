import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, emoji, outlineTxt, rr, txt } from '@/core/draw'

/**
 * 英语口令（对齐逆向报告 english-moves.md）：
 * 听英语口令做动作，牌子上有小人图示与英文渐进提示；瞬时动作（jump/clap）命中即完成，
 * 保持动作需「先离开姿势再保持 0.15s」；hard 有双步组合口令；全员漏听进 Look! 示范模式（补做不给分）。
 */

type Act =
  | 'jump' | 'clap' | 'up' | 'squat' | 'head' | 'open'
  | 'shoulders' | 'knees' | 'oneLeg' | 'leanL' | 'leanR'
  | 'leftHand' | 'rightHand' | 'leftLeg' | 'rightLeg'

const INSTANT: Act[] = ['jump', 'clap']

/** 难度表（报告 §1）：pool 口令池 / window 时限 / gap 间隔 / text 英文显示阈值 / pic 图示阈值 / combo 双步概率 / skill AI 成功率（本地无 AI 框架，保留字面量） */
const DIFF = [
  { window: 5.5, gap: 1.2, text: 0, pic: 0, combo: 0, skill: 0.9, pool: ['jump', 'clap', 'up', 'squat', 'head', 'open'] as Act[] },
  {
    window: 5, gap: 1, text: 0, pic: 0.45, combo: 0, skill: 0.82,
    pool: ['jump', 'clap', 'up', 'squat', 'head', 'open', 'shoulders', 'knees', 'oneLeg', 'leanL', 'leanR'] as Act[],
  },
  {
    window: 4.5, gap: 0.8, text: 0.4, pic: 1, combo: 0.3, skill: 0.75,
    pool: [
      'jump', 'clap', 'up', 'squat', 'head', 'open', 'shoulders', 'knees', 'oneLeg', 'leanL', 'leanR',
      'leftHand', 'rightHand', 'leftLeg', 'rightLeg',
    ] as Act[],
  },
]

/** 双步组合句（10 句，仅 hard，报告 L81-111），逗号断步 */
const COMBOS: [string, Act, Act][] = [
  ['Clap, then jump!', 'clap', 'jump'],
  ['Jump, then clap!', 'jump', 'clap'],
  ['Jump, then squat down!', 'jump', 'squat'],
  ['Hands up, then squat down!', 'up', 'squat'],
  ['Touch your head, then clap!', 'head', 'clap'],
  ['Clap, then touch your head!', 'clap', 'head'],
  ['Open your arms, then clap!', 'open', 'clap'],
  ['Jump, then touch your shoulders!', 'jump', 'shoulders'],
  ['Touch your knees, then clap!', 'knees', 'clap'],
  ['Hands up, then touch your knees!', 'up', 'knees'],
]

/** 规则常量（报告 L154-159）：发题最短时 / 保持时长 / 双步间隔 / 双步加时 / 新动作加时 / 示范时长 / 首条延迟 */
const MIN_AT = 0.3
const HOLD = 0.15
const STEP_GAP = 0.3
const COMBO_BONUS = 2.5
const FRESH_BONUS = 1.5
const DEMO_ALL = 2.6
const FIRST_DELAY = 1.2
const EARLY_END = 0.6

const PRAISE = ['Great!', 'Good job!', 'Well done!', 'Yes!']

/** 每玩家每步状态 */
interface StepState {
  armed: boolean
  holdT: number
  step: number
  stepAt: number
  done: boolean
}

/** 一条口令 */
interface Cmd {
  steps: Act[]
  text: string
  at: number
  endT: number
  fresh: boolean
  resolved: boolean
  earlySet: boolean
  st: StepState[]
}

/** 动作匹配器（黑盒 s(action, player, body, tall) 的本地实现，几何阈值按 tall=历史最大躯干长折算） */
function matchAct(act: Act, b: Body, tall: number): boolean {
  const t = Math.max(0.06, tall)
  switch (act) {
    case 'jump':
      // 瞬时：跳跃事件代理（框架事件 → Body.jumping）
      return b.jumping
    case 'clap':
      // 瞬时：双手合拢
      return Math.hypot(b.lHand.x - b.rHand.x, b.lHand.y - b.rHand.y) < t * 0.3
    case 'up':
      return b.lHandAboveHead && b.rHandAboveHead
    case 'squat':
      return b.squat
    case 'head':
      return (
        Math.hypot(b.lHand.x - b.head.x, b.lHand.y - b.head.y) < t * 0.35 &&
        Math.hypot(b.rHand.x - b.head.x, b.rHand.y - b.head.y) < t * 0.35
      )
    case 'open': {
      const spread = Math.abs(b.lHand.x - b.rHand.x)
      const shoulderW = Math.abs(b.lShoulder.x - b.rShoulder.x)
      const level =
        Math.abs(b.lHand.y - b.shoulderC.y) < t * 0.4 && Math.abs(b.rHand.y - b.shoulderC.y) < t * 0.4
      return spread > Math.max(shoulderW * 2.1, t * 0.9) && level
    }
    case 'shoulders':
      return (
        Math.hypot(b.lHand.x - b.lShoulder.x, b.lHand.y - b.lShoulder.y) < t * 0.3 &&
        Math.hypot(b.rHand.x - b.rShoulder.x, b.rHand.y - b.rShoulder.y) < t * 0.3
      )
    case 'knees':
      return (
        Math.hypot(b.lHand.x - b.lKnee.x, b.lHand.y - b.lKnee.y) < t * 0.3 &&
        Math.hypot(b.rHand.x - b.rKnee.x, b.rHand.y - b.rKnee.y) < t * 0.3
      )
    case 'oneLeg':
      return (b.lKnee.y < b.rKnee.y - 0.045 || b.rKnee.y < b.lKnee.y - 0.045) && !b.jumping
    case 'leanL':
      return b.shoulderC.x < b.hipC.x - t * 0.12
    case 'leanR':
      return b.shoulderC.x > b.hipC.x + t * 0.12
    case 'leftHand':
      // 屏幕语义：照镜子式跟做，屏幕左手（玩家身体右手）举起
      return b.lHandAboveHead && !b.rHandAboveHead
    case 'rightHand':
      return b.rHandAboveHead && !b.lHandAboveHead
    case 'leftLeg':
      return b.lKnee.y < b.rKnee.y - 0.045 && !b.jumping
    case 'rightLeg':
      return b.rKnee.y < b.lKnee.y - 0.045 && !b.jumping
    default:
      return false
  }
}

/** 动作图示小人（口令牌内示范用），h 为全高 */
function drawAct(c: CanvasRenderingContext2D, act: Act, h: number) {
  c.lineCap = 'round'
  c.lineJoin = 'round'
  c.beginPath()
  c.arc(0, -h * 0.4, h * 0.09, 0, Math.PI * 2)
  c.fill()
  const tilt = act === 'leanL' ? -0.28 : act === 'leanR' ? 0.28 : 0
  c.save()
  c.rotate(tilt)
  c.beginPath()
  c.moveTo(0, -h * 0.28)
  c.lineTo(0, h * 0.16)
  c.stroke()
  const arm = (sx: number, ex: number, ey: number, hx: number, hy: number) => {
    c.beginPath()
    c.moveTo(sx * h * 0.06, -h * 0.24)
    c.lineTo(ex * h, ey * h)
    c.lineTo(hx * h, hy * h)
    c.stroke()
  }
  const leg = (sx: number, kx: number, ky: number, fx: number, fy: number) => {
    c.beginPath()
    c.moveTo(sx * h * 0.05, h * 0.16)
    c.lineTo(kx * h, ky * h)
    c.lineTo(fx * h, fy * h)
    c.stroke()
  }
  switch (act) {
    case 'jump':
      arm(-0.06, -0.22, -0.42, -0.3, -0.56)
      arm(0.06, 0.22, -0.42, 0.3, -0.56)
      leg(-0.05, -0.16, 0.3, -0.22, 0.42)
      leg(0.05, 0.16, 0.3, 0.22, 0.42)
      break
    case 'clap':
      arm(-0.06, -0.16, -0.1, -0.04, -0.04)
      arm(0.06, 0.16, -0.1, 0.04, -0.04)
      leg(-0.05, -0.11, 0.4, -0.13, 0.62)
      leg(0.05, 0.11, 0.4, 0.13, 0.62)
      break
    case 'up':
      arm(-0.06, -0.16, -0.4, -0.22, -0.58)
      arm(0.06, 0.16, -0.4, 0.22, -0.58)
      leg(-0.05, -0.11, 0.4, -0.13, 0.62)
      leg(0.05, 0.11, 0.4, 0.13, 0.62)
      break
    case 'squat':
      arm(-0.06, -0.3, -0.2, -0.46, -0.06)
      arm(0.06, 0.3, -0.2, 0.46, -0.06)
      leg(-0.05, -0.3, 0.32, -0.14, 0.56)
      leg(0.05, 0.3, 0.32, 0.14, 0.56)
      break
    case 'head':
      arm(-0.06, -0.18, -0.32, -0.06, -0.42)
      arm(0.06, 0.18, -0.32, 0.06, -0.42)
      leg(-0.05, -0.11, 0.4, -0.13, 0.62)
      leg(0.05, 0.11, 0.4, 0.13, 0.62)
      break
    case 'open':
      arm(-0.06, -0.4, -0.22, -0.62, -0.22)
      arm(0.06, 0.4, -0.22, 0.62, -0.22)
      leg(-0.05, -0.11, 0.4, -0.13, 0.62)
      leg(0.05, 0.11, 0.4, 0.13, 0.62)
      break
    case 'shoulders':
      arm(-0.06, -0.2, -0.3, -0.08, -0.26)
      arm(0.06, 0.2, -0.3, 0.08, -0.26)
      leg(-0.05, -0.11, 0.4, -0.13, 0.62)
      leg(0.05, 0.11, 0.4, 0.13, 0.62)
      break
    case 'knees':
      arm(-0.06, -0.2, 0.12, -0.1, 0.34)
      arm(0.06, 0.2, 0.12, 0.1, 0.34)
      leg(-0.05, -0.11, 0.4, -0.13, 0.62)
      leg(0.05, 0.11, 0.4, 0.13, 0.62)
      break
    case 'oneLeg':
    case 'leftLeg':
    case 'rightLeg':
      arm(-0.06, -0.28, -0.2, -0.44, -0.1)
      arm(0.06, 0.28, -0.2, 0.44, -0.1)
      leg(-0.05, -0.12, 0.4, -0.14, 0.62)
      leg(0.05, 0.24, 0.3, 0.05, 0.42)
      break
    case 'leanL':
    case 'leanR':
      arm(-0.06, -0.3, -0.3, -0.5, -0.38)
      arm(0.06, 0.3, -0.1, 0.5, 0)
      leg(-0.05, -0.11, 0.4, -0.13, 0.62)
      leg(0.05, 0.11, 0.4, 0.13, 0.62)
      break
    case 'leftHand':
      arm(-0.06, -0.16, -0.4, -0.22, -0.58)
      arm(0.06, 0.18, -0.08, 0.24, 0.2)
      leg(-0.05, -0.11, 0.4, -0.13, 0.62)
      leg(0.05, 0.11, 0.4, 0.13, 0.62)
      break
    case 'rightHand':
      arm(-0.06, -0.18, -0.08, -0.24, 0.2)
      arm(0.06, 0.16, -0.4, 0.22, -0.58)
      leg(-0.05, -0.11, 0.4, -0.13, 0.62)
      leg(0.05, 0.11, 0.4, 0.13, 0.62)
      break
  }
  c.restore()
}

/** 英语口令 */
class EnglishMoves extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  unit = this.H / 720
  cmd: Cmd | null = null
  gapT = FIRST_DELAY
  nextGap = 1
  lastFirst: Act | null = null
  score = 0
  issued = 0
  /** 已见动作集合（新动作加时 + 必给图示） */
  seen = new Set<Act>()
  late = 0
  praiseI = 0
  bannerT = 0
  bannerText = ''
  demoColor = '#ff9f1c'
  /** 示范模式截止时刻（橙色牌，补做给音效不给分） */
  demoUntil = 0
  demoCmd: Cmd | null = null
  copied = [false, false]
  /** 每玩家历史最大躯干长（缓慢衰减 tall = max(torso, tall*(1-0.08*dt))，报告 L295） */
  tall = [0, 0]
  /** 完成勾圈动画（玩家 id → 时刻） */
  checkFx = [-10, -10]
  /** 喇叭扩音动画起点 */
  hornAt = -10

  constructor(ctx: GameContext) {
    super(ctx)
    this.nextGap = this.cfg.gap
    ctx.setStage('听口令做动作')
  }

  tick(_f: PoseFrame, dt: number) {
    this.bannerT = Math.max(0, this.bannerT - dt)

    // 示范模式期间：漏听玩家补做只给音效反馈不给分（报告 L297-306；保持动作简化为对上姿势即算）
    if (this.t < this.demoUntil && this.demoCmd) {
      for (const pv of this.players) {
        const b = pv.body
        if (!b || this.copied[pv.id]) continue
        const act = this.demoCmd.steps[0]
        if (matchAct(act, b, this.tallOf(pv.id, b, dt))) {
          this.copied[pv.id] = true
          this.ctx.audio.pop()
          this.checkFx[pv.id] = this.t
        }
      }
      return
    }

    // 间隔 → 出题（新口令仅当剩余时间 > 2s，报告 L307）
    if (!this.cmd) {
      this.gapT -= dt
      const tl = this.ctx.hud().timeLeft
      if (this.gapT <= 0 && tl > 2) this.issue()
      return
    }

    const cmd = this.cmd
    const present = this.presentIds()

    // 全员（有身体者）完成 → 提前 0.6s 收尾（报告 §2）
    if (!cmd.earlySet && present.length > 0 && present.every((pi) => cmd.st[pi].done)) {
      cmd.earlySet = true
      cmd.endT = Math.min(cmd.endT, this.t + EARLY_END)
    }

    for (const pi of present) {
      const b = this.players[pi].body
      if (!b || cmd.st[pi].done) continue
      const st = cmd.st[pi]
      const act = cmd.steps[st.step]
      const tall = this.tallOf(pi, b, dt)
      const u = matchAct(act, b, tall)
      // 武装机制：出题（或上一步结算）时已在姿势里 → 须先离开再触发/保持（报告 L252/L318）
      if (!u) st.armed = true
      const timedOk = this.t - cmd.at >= MIN_AT && this.t - st.stepAt >= (st.step > 0 ? STEP_GAP : MIN_AT)
      if (INSTANT.includes(act)) {
        // 瞬时动作：离开后命中即完成该步
        if (u && st.armed && timedOk) this.stepDone(cmd, pi, b)
      } else if (u && st.armed && timedOk) {
        // 保持动作：保持 0.15s
        st.holdT += dt
        if (st.holdT >= HOLD) this.stepDone(cmd, pi, b)
      } else {
        st.holdT = 0
      }
    }

    // 到窗超时 $()（报告 L279-286）
    if (!cmd.resolved && this.t >= cmd.endT) {
      cmd.resolved = true
      const missedAll = present.length > 0 && present.every((pi) => !cmd.st[pi].done)
      let anyLate = false
      for (const pi of present) {
        if (!cmd.st[pi].done) {
          this.late++
          anyLate = true
        }
      }
      if (anyLate) {
        // 全员漏听 → 示范 2.6s、下一条间隔 3s；部分漏听 → 1.6s、间隔 ≥1.6s
        this.demoUntil = this.t + (missedAll ? DEMO_ALL : 1.6)
        this.demoCmd = cmd
        this.copied = [false, false]
        this.nextGap = missedAll ? 3 : Math.max(this.cfg.gap, 1.6)
        this.bannerT = 1.4
        this.bannerText = `Look! ${cmd.text}`
        this.demoColor = '#ff9f1c'
        this.ctx.speak(`Look! ${cmd.text}`)
        this.ctx.setStage(`Look! ${cmd.text}`)
      } else {
        this.nextGap = this.cfg.gap
      }
      this.ctx.setExtra('没跟上', this.late)
      this.cmd = null
      this.gapT = this.nextGap
    }
  }

  private presentIds() {
    return this.players.filter((p) => p.body).map((p) => p.id)
  }

  private tallOf(pi: number, b: Body, dt: number) {
    this.tall[pi] = Math.max(b.scale, this.tall[pi] * (1 - 0.08 * dt))
    return this.tall[pi]
  }

  /** 单步完成 → 双步则步进重判，整条完成结算 Z()（报告 L259-271） */
  private stepDone(cmd: Cmd, pi: number, b: Body) {
    const st = cmd.st[pi]
    st.step++
    if (st.step < cmd.steps.length) {
      // 第一步完成：sfx pop，重置步计时与武装
      st.stepAt = this.t
      st.holdT = 0
      st.armed = !matchAct(cmd.steps[st.step], b, this.tall[pi])
      this.ctx.audio.pop()
      return
    }
    st.done = true
    this.score++
    this.checkFx[pi] = this.t
    this.say(PRAISE[this.praiseI++ % PRAISE.length], b.head.x * this.W, b.head.y * this.H - 70, '#b6ffdd', 34)
    this.particles.burst(b.head.x * this.W, b.head.y * this.H, '#ffd54a', 16, 420, 6)
    // sfx chime → good 兜底
    this.ctx.audio.good()
    this.ctx.setScore(this.score)
  }

  /** 出题：牌堆抽取避免重复；hard 第 5 条起 0.3 概率双步；新动作加时 1.5s（报告 §1/§4） */
  private issue() {
    let steps: Act[]
    let text: string
    const canCombo = this.cfg.combo > 0 && this.issued >= 4 && Math.random() < this.cfg.combo
    if (canCombo) {
      const pick = COMBOS[Math.floor(Math.random() * COMBOS.length)]
      text = pick[0]
      steps = [pick[1], pick[2]]
      // 双步第一步不与上一条重复
      if (steps[0] === this.lastFirst) steps = [steps[1], steps[0]]
    } else {
      let pool = this.cfg.pool.filter((p) => p !== this.lastFirst)
      if (!pool.length) pool = this.cfg.pool
      steps = [pool[Math.floor(Math.random() * pool.length)]]
      text = CMD_TEXT[steps[0]]
    }
    this.lastFirst = steps[0]
    this.issued++
    const fresh = steps.some((a) => !this.seen.has(a))
    for (const a of steps) this.seen.add(a)
    const window = this.cfg.window + (steps.length > 1 ? COMBO_BONUS : 0) + (fresh ? FRESH_BONUS : 0)
    const cmd: Cmd = {
      steps,
      text,
      at: this.t,
      endT: this.t + window,
      fresh,
      resolved: false,
      earlySet: false,
      st: [],
    }
    for (let pi = 0; pi < 2; pi++) {
      const b = this.players[pi].body
      cmd.st.push({
        // 武装：出题时已在该姿势 → 须先离开（报告 L252）
        armed: b ? !matchAct(steps[0], b, this.tall[pi]) : true,
        holdT: 0,
        step: 0,
        stepAt: this.t,
        done: false,
      })
    }
    this.cmd = cmd
    this.hornAt = this.t
    // 出题 sfx appear → pop 兜底；播报英文口令
    this.ctx.audio.pop()
    this.ctx.speak(text)
    this.ctx.setStage(`Listen! / ${text}`)
  }

  paint(c: CanvasRenderingContext2D) {
    const demo = this.t < this.demoUntil ? this.demoCmd : null
    const cmd = demo ?? this.cmd

    // 喇叭（出题扩音动画 1.4s，平时脉动，报告 L256-257）
    const hornAge = this.t - this.hornAt
    const pulse = hornAge < 1.4 ? 1.35 - hornAge * 0.25 : 0.5 + Math.sin(this.t * 5) * 0.4
    c.save()
    c.translate(this.W * 0.08, this.H * 0.2)
    c.rotate(hornAge < 0.8 ? -0.35 * (1 - hornAge / 0.8) : 0)
    c.scale(pulse, pulse)
    emoji(c, '📣', 0, 0, 52)
    c.restore()

    // 口令牌：白底圆角卡（demo 橙色），顶部图示 + 底部英文（报告 §5）
    if (cmd) {
      const cw = 260 * this.unit
      const ch = 250 * this.unit
      const cx = this.W / 2
      const cy = this.H * 0.13
      c.save()
      c.fillStyle = demo ? 'rgba(255,159,28,.92)' : 'rgba(255,255,255,.94)'
      rr(c, cx - cw / 2, cy, cw, ch, 22)
      c.fill()
      c.strokeStyle = demo ? '#b34700' : 'rgba(120,90,40,.35)'
      c.lineWidth = 4
      c.stroke()

      // 渐进提示阈值：窗口进度
      const prog = Math.max(0, Math.min(1, (this.t - cmd.at) / (cmd.endT - cmd.at)))
      const showText = demo || prog >= this.cfg.text
      const showPic = demo || prog >= this.cfg.pic || (cmd.fresh && this.cfg.pic >= 1)

      // 图示区
      if (showPic) {
        c.fillStyle = demo ? '#7a3d00' : '#334'
        c.strokeStyle = demo ? '#7a3d00' : '#334'
        const figH = 92 * this.unit
        if (cmd.steps.length > 1) {
          c.save()
          c.translate(cx - 62 * this.unit, cy + 78 * this.unit)
          c.lineWidth = 7
          drawAct(c, cmd.steps[0], figH)
          c.restore()
          c.save()
          c.translate(cx + 62 * this.unit, cy + 78 * this.unit)
          c.lineWidth = 7
          drawAct(c, cmd.steps[1], figH)
          c.restore()
          outlineTxt(c, '→', cx, cy + 78 * this.unit, 34, demo ? '#7a3d00' : '#ff9f1c')
        } else {
          c.save()
          c.translate(cx, cy + 78 * this.unit)
          c.lineWidth = 8
          drawAct(c, cmd.steps[0], figH)
          c.restore()
        }
      } else {
        outlineTxt(c, '❓', cx, cy + 78 * this.unit, 44, demo ? '#7a3d00' : 'rgba(60,60,80,.4)')
      }

      // 英文分行（逗号断行；text 阈值前显示 Listen!）
      const lines = showText ? splitLines(cmd.text) : ['Listen!']
      c.fillStyle = demo ? '#fff6ec' : '#2b3350'
      lines.forEach((ln, i) => {
        txt(c, ln, cx, cy + 152 * this.unit + i * 30 * this.unit, 22 * this.unit, demo ? '#fff6ec' : '#2b3350', 'center', '900')
      })

      // 倒计时条：0.9 牌宽，剩余 <30% 变橙（报告 L400-405）
      if (this.cmd === cmd && !cmd.resolved) {
        const left = Math.max(0, cmd.endT - this.t)
        const pct = left / (cmd.endT - cmd.at)
        const bw = cw * 0.9
        c.fillStyle = 'rgba(0,0,0,.14)'
        rr(c, cx - bw / 2, cy + ch + 10, bw, 12, 6)
        c.fill()
        c.fillStyle = pct < 0.3 ? '#ff9f1c' : '#3ddc97'
        rr(c, cx - bw / 2, cy + ch + 10, Math.max(4, bw * pct), 12, 6)
        c.fill()
      }
      c.restore()
    }

    // 完成勾圈弹出（outBack 用简单缩放近似，报告 §5）
    for (let pi = 0; pi < 2; pi++) {
      const age = this.t - this.checkFx[pi]
      if (age < 0 || age > 0.6) continue
      const b = this.players[pi].body
      if (!b) continue
      const k = Math.min(1, age / 0.3)
      const scale = 0.5 + 0.5 * (1 - (1 - k) * (1 - k)) * 1.2
      const cxp = b.head.x * this.W
      const cyp = (b.head.y - 0.12) * this.H
      c.save()
      c.translate(cxp, cyp)
      c.scale(scale, scale)
      c.globalAlpha = 1 - age / 0.6
      c.strokeStyle = '#3ddc97'
      c.lineWidth = 7
      circle(c, 0, 0, 24, 'rgba(61,220,151,.25)')
      c.beginPath()
      c.arc(0, 0, 24, 0, Math.PI * 2)
      c.stroke()
      c.beginPath()
      c.moveTo(-11, 1)
      c.lineTo(-3, 10)
      c.lineTo(12, -8)
      c.stroke()
      c.restore()
    }

    txt(c, '听英语口令做动作，看牌子上小人跟做；hard 有两步连着做的口令', this.W / 2, this.H - 16, 15, 'rgba(255,255,255,.55)')
  }
}

/** 英文断行：逗号处断，否则按词均分两行（黑盒 k() 的简化实现） */
function splitLines(s: string): string[] {
  if (s.includes(',')) return s.split(',').map((x) => x.trim()).filter(Boolean)
  const words = s.split(' ')
  if (words.length <= 3) return [s]
  const mid = Math.ceil(words.length / 2)
  return [words.slice(0, mid).join(' '), words.slice(mid).join(' ')]
}

/** 单步口令英文原文（报告 §1 m 表） */
const CMD_TEXT: Record<Act, string> = {
  jump: 'Jump!',
  clap: 'Clap your hands!',
  up: 'Hands up!',
  squat: 'Squat down!',
  head: 'Touch your head!',
  open: 'Open your arms!',
  shoulders: 'Touch your shoulders!',
  knees: 'Touch your knees!',
  oneLeg: 'Stand on one leg!',
  leanL: 'Lean left!',
  leanR: 'Lean right!',
  leftHand: 'Left hand up!',
  rightHand: 'Right hand up!',
  leftLeg: 'Left leg up!',
  rightLeg: 'Right leg up!',
}

export default function create(ctx: GameContext) {
  return new EnglishMoves(ctx)
}
