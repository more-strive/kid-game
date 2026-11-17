import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, glow, outlineTxt, rr, txt } from '@/core/draw'

/**
 * 老师说（对齐逆向报告 simon-says.md）：
 * 指令带「老师说」才能做（按时做对 +1）；没带前缀却动了 → 掉一颗心（3 心出局），
 * 假指令忍住不动也 +1。真指令要求相似度 ≥0.8 且比开题基线明显提高（或 ≥0.95 直接判成）。
 */

/** 难度表（报告 §1）：window 作答时限（三档同 2.5）/ gap 指令间隔 / trick 假指令概率 / pool 姿势池 */
const DIFF = [
  { window: 2.5, gap: 1.3, trick: 0.25, pool: ['up', 't', 'hips', 'leftUp', 'rightUp', 'y'] },
  { window: 2.5, gap: 0.9, trick: 0.33, pool: ['up', 't', 'hips', 'leftUp', 'rightUp', 'y', 'star', 'muscle', 'wave'] },
  {
    window: 2.5, gap: 0.5, trick: 0.4,
    pool: ['up', 't', 'hips', 'leftUp', 'rightUp', 'y', 'star', 'muscle', 'wave', 'squat', 'kneeL'],
  },
]

const POSE_NAME: Record<string, string> = {
  up: '举高高', t: '双手张开', hips: '叉腰', leftUp: '举一只手', rightUp: '举另一只手',
  y: 'Y 字', star: '大星星', muscle: '大力士', wave: '挥挥手', squat: '蹲下', kneeL: '金鸡独立',
}

/** 规则常量（报告 L48-96）：心数 / 相似度阈值 / 假指令宽限 / 反应下限 / 全员完成提前收尾 / 收尾窗 */
const HEARTS = 3
const SIM_THR = 0.8
const GRACE = 0.6
const REACT_MIN = 0.25
const EARLY_END = 0.7
const REAL_WINDOW = 2.75 // window + 0.25
const FAKE_WINDOW = 2.125 // window * 0.85
const FOOLED_T = 0.2 // 当当判定需持续 0.2s 防抖

/** 姿势目标：双手相对肩心的位置（scale 单位，dy 正=在肩上方）；leg 为附加腿部分量（黑盒相似度的本地设计） */
interface Spec {
  l: { x: number; y: number }
  r: { x: number; y: number }
  leg?: 'star' | 'squat' | 'knee'
}

const SPECS: Record<string, Spec> = {
  up: { l: { x: -0.16, y: 1.0 }, r: { x: 0.16, y: 1.0 } },
  t: { l: { x: -0.95, y: 0 }, r: { x: 0.95, y: 0 } },
  hips: { l: { x: -0.34, y: -0.42 }, r: { x: 0.34, y: -0.42 } },
  leftUp: { l: { x: -0.14, y: 1.0 }, r: { x: 0.18, y: -0.5 } },
  rightUp: { l: { x: -0.18, y: -0.5 }, r: { x: 0.14, y: 1.0 } },
  y: { l: { x: -0.62, y: 0.8 }, r: { x: 0.62, y: 0.8 } },
  star: { l: { x: -1.05, y: 0.42 }, r: { x: 1.05, y: 0.42 }, leg: 'star' },
  muscle: { l: { x: -0.32, y: 0.12 }, r: { x: 0.32, y: 0.12 } },
  wave: { l: { x: -0.16, y: -0.5 }, r: { x: 0.4, y: 0.95 } },
  squat: { l: { x: -0.38, y: -0.12 }, r: { x: 0.38, y: -0.12 }, leg: 'squat' },
  kneeL: { l: { x: -0.45, y: 0.05 }, r: { x: 0.45, y: 0.05 }, leg: 'knee' },
}

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n))
}

/** 蹲下分量：站直≈0、深蹲≈1 */
function squatComp(b: Body) {
  const s = Math.max(0.05, b.scale)
  const ratio = ((b.lKnee.y - b.lHip.y) / s + (b.rKnee.y - b.rHip.y) / s) / 2
  return clamp01(1 - ratio / 0.7)
}

/** 抬膝分量：至少一条膝抬起越明显越高 */
function kneeComp(b: Body) {
  const s = Math.max(0.05, b.scale)
  const minRatio = Math.min(b.lKnee.y - b.lHip.y, b.rKnee.y - b.rHip.y) / s
  return clamp01((0.55 - minRatio) / 0.4)
}

/** 特征-姿势相似度（黑盒 n(t(pts,vis), spec) 的本地实现）：双手目标分均值，带腿部姿势再均分腿部分量 */
function simOf(b: Body, spec: Spec): number {
  const s = Math.max(0.05, b.scale)
  const rel = (p: { x: number; y: number }) => ({ x: (p.x - b.shoulderC.x) / s, y: (b.shoulderC.y - p.y) / s })
  const handScore = (p: { x: number; y: number }, t: { x: number; y: number }) => {
    const q = rel(p)
    return clamp01(1 - Math.hypot(q.x - t.x, q.y - t.y) / 0.55)
  }
  const hl = handScore(b.lHand, spec.l)
  const hr = handScore(b.rHand, spec.r)
  if (!spec.leg) return (hl + hr) / 2
  const leg = spec.leg === 'star' ? clamp01(b.feetSpread / s) : spec.leg === 'squat' ? squatComp(b) : kneeComp(b)
  return (hl + hr + leg) / 3
}

/** 一条指令 */
interface Cmd {
  pose: string
  real: boolean
  startT: number
  endT: number
  resolved: boolean
  earlySet: boolean
  /** 每玩家：开题基线 / 是否完成 / 是否上当 / 当当累积 */
  baseline: number[]
  done: boolean[]
  fooled: boolean[]
  fooledT: number[]
}

/** 老师说 */
class SimonSays extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  unit = this.H / 720
  cmdNo = 0
  cmd: Cmd | null = null
  /** 指令间隔倒计时 */
  gapT = 1.2
  hearts = [HEARTS, HEARTS]
  out = [false, false]
  everSeen = [false, false]
  score = 0
  correct = 0
  held = 0
  fooledN = 0
  bannerT = 0
  bannerBig = ''
  bannerSub = ''
  /** 教师表情：真指令 happy / 假指令与上当 serious（1.2s 切换） */
  teacherFace: 'happy' | 'serious' = 'happy'
  faceT = 0
  shakeT = 0
  /** 每玩家运动能量（motion.energy 代理：帧间关节均速 / 躯干长，指数平滑） */
  energy = [0, 0]
  private prevLm: ({ x: number; y: number } | null)[][] = [[], []]
  /** 教师手臂当前插值位置（scale 单位），向指令姿势平滑 */
  teachL = { x: -0.18, y: -0.5 }
  teachR = { x: 0.18, y: -0.5 }
  okFlash = [0, 0]

  tick(_f: PoseFrame, dt: number) {
    this.bannerT = Math.max(0, this.bannerT - dt)
    this.shakeT = Math.max(0, this.shakeT - dt)
    this.faceT = Math.max(0, this.faceT - dt)
    if (this.faceT <= 0) this.teacherFace = 'happy'
    for (let i = 0; i < 2; i++) this.okFlash[i] = Math.max(0, this.okFlash[i] - dt)

    // 能量代理更新
    for (const b of this.lastBodies) this.updateEnergy(b, dt)

    // 指令间隔
    if (!this.cmd) {
      this.gapT -= dt
      if (this.gapT <= 0) this.issue()
      return
    }

    const cmd = this.cmd
    const alive = this.aliveIds()

    // 真指令全员完成 → 提前 0.7s 收尾（报告 L188）
    if (cmd.real && !cmd.earlySet && alive.length > 0 && alive.every((i) => cmd.done[i])) {
      cmd.earlySet = true
      cmd.endT = Math.min(cmd.endT, this.t + EARLY_END)
    }

    for (const pi of alive) {
      const b = this.players[pi].body
      if (!b) continue
      const d = simOf(b, SPECS[cmd.pose])
      if (cmd.real) {
        // 真指令：d ≥ 0.8 且（d ≥ 基线+0.04 或 d ≥ 0.95），反应 ≥0.25s（报告 L177-178）
        if (!cmd.done[pi] && this.t - cmd.startT >= REACT_MIN && d >= SIM_THR && (d >= cmd.baseline[pi] + 0.04 || d >= 0.95)) {
          cmd.done[pi] = true
          this.correct++
          this.score++
          this.okFlash[pi] = 0.8
          this.particles.burst(b.head.x * this.W, b.head.y * this.H, '#3ddc97', 16, 420, 6)
          this.say('+1', b.head.x * this.W, b.head.y * this.H - 60, '#b6ffdd', 36)
          this.ctx.audio.win()
        }
      } else if (this.t - cmd.startT >= GRACE) {
        // 假指令：宽限 0.6s 后，大幅乱动（energy>0.6）或摆出被点名姿势（d≥0.75 且 ≥基线+0.08）累积上当（报告 L191-193）
        const trigger = this.energy[pi] > 0.6 || (d >= 0.75 && d >= cmd.baseline[pi] + 0.08)
        if (trigger) cmd.fooledT[pi] += dt
        else cmd.fooledT[pi] = Math.max(0, cmd.fooledT[pi] - dt)
        if (!cmd.fooled[pi] && cmd.fooledT[pi] >= FOOLED_T) {
          cmd.fooled[pi] = true
          this.fooledN++
          this.hearts[pi] = Math.max(0, this.hearts[pi] - 1)
          this.shakeT = 0.4
          this.teacherFace = 'serious'
          this.faceT = 1.2
          const hx = b.head.x * this.W
          const hy = b.head.y * this.H
          this.say('上当啦！', hx, hy - 70, '#ff6b6b', 44 * this.unit)
          this.particles.burst(hx, hy, '#ff6b6b', 6, 260, 7)
          this.ctx.audio.fail()
          if (this.hearts[pi] <= 0) {
            this.out[pi] = true
            const duo = this.everSeen[0] && this.everSeen[1]
            this.bannerT = 1.8
            this.bannerBig = duo ? '休息一下' : '三颗心没有啦'
            this.bannerSub = '下次听清楚"老师说"'
            this.ctx.audio.lose()
          }
        }
      }
    }

    // 收尾 P()
    if (!cmd.resolved && this.t >= cmd.endT) {
      cmd.resolved = true
      if (cmd.real) {
        // 真指令未完成者：头顶飘「再试试」，不扣分（报告 L108-112）
        for (const pi of alive) {
          if (cmd.done[pi]) continue
          const b = this.players[pi].body
          if (b) this.say('再试试', b.head.x * this.W, b.head.y * this.H - 60, 'rgba(255,255,255,.85)', 26)
        }
      } else {
        // 假指令所有未上当者 +1「忍住了」（报告 L112-130）
        for (const pi of alive) {
          if (cmd.fooled[pi]) continue
          this.held++
          this.score++
          const b = this.players[pi].body
          const hx = b ? b.head.x * this.W : this.W / 2
          const hy = b ? b.head.y * this.H : this.H / 2
          this.say('忍住了 +1', hx, hy - 60, '#ffd54a', 30)
          this.particles.burst(hx, hy, '#ffd54a', 8, 300, 5)
          this.ctx.audio.good()
        }
      }
      this.ctx.setScore(this.score)
      this.cmd = null
      this.gapT = this.cfg.gap

      // 结束条件：所有出过场的玩家都出局 → finish（报告 L161-164）
      if (this.everSeen.some(Boolean) && this.everSeen.every((seen, i) => !seen || this.out[i])) {
        this.ctx.finish()
      }
    }
  }

  private lastBodies: Body[] = []

  update(f: PoseFrame, dt: number) {
    this.lastBodies = f.bodies
    for (const b of f.bodies) this.everSeen[b.id] = true
    super.update(f, dt)
  }

  private aliveIds() {
    const ids: number[] = []
    for (let i = 0; i < 2; i++) if (!this.out[i] && this.players[i].body) ids.push(i)
    return ids
  }

  /** 出题：姿势排除上一条；前 2 条必为真（报告 L85）；真=appear/假=boop + 教师表情切换（报告 §2） */
  private issue() {
    const prev = this.cmd?.pose
    let pool = this.cfg.pool.filter((p) => p !== prev)
    if (!pool.length) pool = this.cfg.pool
    const pose = pool[Math.floor(Math.random() * pool.length)]
    const real = this.cmdNo < 2 || Math.random() >= this.cfg.trick
    this.cmdNo++
    const alive = this.aliveIds()
    const cmd: Cmd = {
      pose,
      real,
      startT: this.t,
      endT: this.t + (real ? REAL_WINDOW : FAKE_WINDOW),
      resolved: false,
      earlySet: false,
      baseline: alive.map(() => 0),
      done: [false, false],
      fooled: [false, false],
      fooledT: [0, 0],
    }
    for (const pi of alive) {
      const b = this.players[pi].body
      cmd.baseline[pi] = b ? simOf(b, SPECS[pose]) : 0
    }
    this.cmd = cmd
    this.teacherFace = real ? 'happy' : 'serious'
    this.faceT = 1.2
    if (real) {
      this.ctx.audio.pop() // sfx appear → pop 兜底
      this.ctx.speak(`老师说，${POSE_NAME[pose]}！`)
    } else {
      this.ctx.audio.fail() // sfx boop → fail 兜底
      this.ctx.speak(`${POSE_NAME[pose]}！`)
    }
    this.ctx.setStage(real ? `老师说：${POSE_NAME[pose]}` : POSE_NAME[pose])
  }

  /** 运动能量代理：帧间可见关节均速（躯干长/秒），τ=0.15 指数平滑 */
  private updateEnergy(b: Body, dt: number) {
    const id = b.id
    const prev = this.prevLm[id]
    if (prev.length !== b.lm.length) {
      this.prevLm[id] = b.lm.map((p) => ({ x: p.x, y: p.y }))
      return
    }
    let sum = 0
    let n = 0
    const scale = Math.max(0.05, b.scale)
    for (let i = 0; i < b.lm.length; i++) {
      const p = b.lm[i]
      const q = prev[i]
      if (!q || (p.visibility ?? 1) < 0.5) continue
      sum += Math.hypot(p.x - q.x, p.y - q.y) / Math.max(0.016, dt) / scale
      n++
      prev[i] = { x: p.x, y: p.y }
    }
    const raw = n ? sum / n : 0
    const k = 1 - Math.exp(-dt / 0.15)
    this.energy[id] += (raw - this.energy[id]) * k
  }

  /** 教师简笔小人（手臂向指令姿势插值，1-exp(-dt*9)，报告 L205） */
  private drawTeacher(c: CanvasRenderingContext2D, dt: number) {
    const target = this.cmd ? SPECS[this.cmd.pose] : { l: { x: -0.18, y: -0.5 }, r: { x: 0.18, y: -0.5 } }
    const k = 1 - Math.exp(-dt * 9)
    this.teachL.x += (target.l.x - this.teachL.x) * k
    this.teachL.y += (target.l.y - this.teachL.y) * k
    this.teachR.x += (target.r.x - this.teachR.x) * k
    this.teachR.y += (target.r.y - this.teachR.y) * k
    const cx = this.W * 0.14
    const cy = this.H * 0.62
    const s = 110
    const col = '#ffd166'
    // 身体
    c.strokeStyle = col
    c.lineWidth = 12
    c.lineCap = 'round'
    c.beginPath()
    c.moveTo(cx, cy - s * 0.55)
    c.lineTo(cx, cy + s * 0.25)
    c.stroke()
    // 手臂（目标坐标 × s）
    c.lineWidth = 10
    c.beginPath()
    c.moveTo(cx - 16, cy - s * 0.42)
    c.lineTo(cx + this.teachL.x * s * 0.75, cy - this.teachL.y * s * 0.75)
    c.stroke()
    c.beginPath()
    c.moveTo(cx + 16, cy - s * 0.42)
    c.lineTo(cx + this.teachR.x * s * 0.75, cy - this.teachR.y * s * 0.75)
    c.stroke()
    // 头 + 表情
    circle(c, cx, cy - s * 0.75, s * 0.17, col)
    c.fillStyle = '#3a2c1a'
    const eyeY = cy - s * 0.78
    circle(c, cx - 7, eyeY, 2.6, '#3a2c1a')
    circle(c, cx + 7, eyeY, 2.6, '#3a2c1a')
    c.strokeStyle = '#3a2c1a'
    c.lineWidth = 2.4
    c.beginPath()
    if (this.teacherFace === 'happy') c.arc(cx, eyeY + 8, 8, 0.15 * Math.PI, 0.85 * Math.PI)
    else c.moveTo(cx - 7, eyeY + 12), c.lineTo(cx + 7, eyeY + 10)
    c.stroke()
    txt(c, '老师', cx, cy + s * 0.45, 16, 'rgba(255,255,255,.7)')
  }

  paint(c: CanvasRenderingContext2D) {
    const cmd = this.cmd

    // 黑板底
    c.save()
    c.fillStyle = 'rgba(16,24,52,.5)'
    rr(c, this.W * 0.03, this.H * 0.14, this.W * 0.22, this.H * 0.52, 20)
    c.fill()
    c.strokeStyle = 'rgba(255,255,255,.25)'
    c.lineWidth = 3
    c.stroke()

    // 指令气泡 + 进度条（真绿/假橙，宽度=剩余时间，报告 L214-220）
    if (cmd) {
      const bx = this.W * 0.14
      const by = this.H * 0.3
      c.fillStyle = 'rgba(255,255,255,.92)'
      rr(c, bx - 120, by - 46, 240, 64, 18)
      c.fill()
      outlineTxt(c, cmd.real ? `老师说：${POSE_NAME[cmd.pose]}` : `${POSE_NAME[cmd.pose]}！`, bx, by - 12, 21, cmd.real ? '#1e6e18' : '#b34700', 'rgba(255,255,255,.95)')
      const left = Math.max(0, cmd.endT - this.t)
      const total = cmd.real ? REAL_WINDOW : FAKE_WINDOW
      c.fillStyle = cmd.real ? '#3ddc97' : '#ff9f1c'
      rr(c, bx - 110, by + 34, (220 * left) / total, 12, 6)
      c.fill()
    } else {
      txt(c, '听好啦……', this.W * 0.14, this.H * 0.3, 22, 'rgba(255,255,255,.75)')
    }
    c.restore()

    // 心形条（每玩家 3 颗，屏幕上角）
    for (let pi = 0; pi < 2; pi++) {
      if (pi === 1 && !this.everSeen[1]) continue
      const hx = pi === 0 ? this.W - 120 : this.W - 260
      for (let i = 0; i < HEARTS; i++) {
        const aliveHeart = i < this.hearts[pi]
        c.save()
        c.globalAlpha = aliveHeart ? 1 : 0.22
        c.fillStyle = aliveHeart ? '#ff5c8a' : '#fff'
        const x = hx - i * 44
        const y = 44
        // 心形：两圆 + 三角
        c.beginPath()
        c.arc(x - 8, y - 4, 10, Math.PI, 0)
        c.arc(x + 8, y - 4, 10, Math.PI, 0)
        c.lineTo(x, y + 16)
        c.closePath()
        c.fill()
        c.restore()
      }
      if (this.out[pi]) txt(c, '休息一下', hx - 44, 78, 16, 'rgba(255,255,255,.5)')
    }

    // 假指令警告圈：宽限后未上当玩家周围蓝色虚线圆（报告 §4）
    if (cmd && !cmd.real && this.t - cmd.startT >= GRACE) {
      for (const pi of this.aliveIds()) {
        if (cmd.fooled[pi]) continue
        const b = this.players[pi].body
        if (!b) continue
        c.save()
        c.globalAlpha = 0.25 + Math.sin(this.t * 4) * 0.1
        c.setLineDash([12, 10])
        c.strokeStyle = '#4cc9f0'
        c.lineWidth = 4
        c.beginPath()
        c.arc(b.shoulderC.x * this.W, b.shoulderC.y * this.H, b.scale * 1.5 * this.H, 0, Math.PI * 2)
        c.stroke()
        c.restore()
      }
    }

    // 做对头顶绿 ✓ 闪烁（报告 §5）
    for (let pi = 0; pi < 2; pi++) {
      if (this.okFlash[pi] <= 0) continue
      const b = this.players[pi].body
      if (!b) continue
      c.save()
      c.globalAlpha = 0.85 + Math.sin(this.t * 10) * 0.15
      outlineTxt(c, '✓', b.head.x * this.W, (b.head.y - 0.09) * this.H, 40, '#3ddc97')
      c.restore()
      glow(c, b.head.x * this.W, b.head.y * this.H, 80, '#3ddc97', 0.25)
    }

    // 教师与震屏
    c.save()
    if (this.shakeT > 0) {
      const amp = 6 * (this.shakeT / 0.4)
      c.translate(Math.sin(this.t * 60) * amp, Math.cos(this.t * 55) * amp * 0.6)
    }
    c.restore()

    // 出局横幅
    if (this.bannerT > 0) {
      c.save()
      c.globalAlpha = Math.min(1, this.bannerT / 0.3)
      outlineTxt(c, this.bannerBig, this.W / 2, this.H * 0.3, 52, '#ff8fa3')
      if (this.bannerSub) txt(c, this.bannerSub, this.W / 2, this.H * 0.3 + 46, 22, 'rgba(255,255,255,.9)')
      c.restore()
    }
  }

  /** 教师小人画在骨架之下（重写 draw，在基类绘制流程前先画教师并按 paint 间隔推进插值） */
  private lastPaintT = 0

  draw(c: CanvasRenderingContext2D) {
    const dt = Math.max(0.001, this.t - this.lastPaintT)
    this.lastPaintT = this.t
    this.drawTeacher(c, dt)
    super.draw(c)
  }
}

export default function create(ctx: GameContext) {
  return new SimonSays(ctx)
}
