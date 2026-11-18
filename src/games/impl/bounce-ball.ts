import { BaseGame } from '@/core/base'
import type { Game, GameContext, PoseFrame } from '@/core/types'
import { glow, outlineTxt, txt } from '@/core/draw'

/**
 * 拍皮球（对齐 dongdongpark 真实规则）：
 * 球在脚边弹跳，弹到顶点附近往下拍（有下拍手速门槛）；口令「换手/低一点/站起来」要照做，
 * 丢球清连拍，每 10 连拍庆祝。
 */
type Cmd = 'switch' | 'low' | 'high'

/** 对齐站点难度表：周期/加速/球半径/丢球宽限/手速门槛/口令间隔/低球率/首口令时刻 */
const DIFF = [
  { period: 1.15, faster: 0.15, ballR: 0.34, late: 0.5, hitSpeed: 1.2, gap: [10, 13], lowRate: 0.3, firstCmd: 9 },
  { period: 0.95, faster: 0.2, ballR: 0.3, late: 0.4, hitSpeed: 1.5, gap: [7, 10], lowRate: 0.4, firstCmd: 7 },
  { period: 0.8, faster: 0.22, ballR: 0.27, late: 0.35, hitSpeed: 1.6, gap: [5, 8], lowRate: 0.45, firstCmd: 6 },
]
const FIRST_UP = 0.85 // 首次弹起时长 s（固定）
const UP_RATIO = 0.58 // 后续弹起时长 = period×0.58
const DOWN_RATIO = 0.42 // 下落时长 = period×0.42×max(0.6,√h0)
const LOW_RATIO = 0.8 // 低球下落 ×0.8
const HIT_WIN = 0.5 // 顶点命中窗 ±×躯干
const TAP_CD = 0.2 // 拍击冷却
const HAND_R = 16
const LOST_T = 1.3 // 丢球后重开时长
const LEAVE_T = 0.6 // 检测不到该玩家超过该秒数 → 收球（过滤闪现误检留下的“幽灵球”）

interface Ball {
  state: 'up' | 'down' | 'lost'
  t: number
  dur: number
  side: number // -1 左 1 右
  low: boolean
  h: number // 高度比例 0=地面 1=顶点
  wantSwitch: boolean
  crossed: boolean
}

interface PState {
  ball: Ball
  anchorX: number
  hipY: number
  groundY: number
  t: number
  lastTorso: number
  lastTapAt: number
  streak: number
  maxStreak: number
  switches: number
  lows: number
  lostCount: number
  lowMode: boolean
  ready: boolean
  /** 最后一次检测到该玩家的时刻：用于判断“离开画面”并收起球 */
  seenAt: number
}

class BounceBall extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  ps: PState[] = [
    this.newPS(),
    this.newPS(),
  ]
  /** 口令调度 */
  cmdT = 0
  cmdCount = 0
  lastCmd: Cmd | null = null
  bannerText = ''
  bannerT = 0

  private newBall(): Ball {
    return { state: 'up', t: 0, dur: FIRST_UP, side: 1, low: false, h: 0, wantSwitch: false, crossed: false }
  }

  private newPS(): PState {
    return {
      ball: this.newBall(),
      anchorX: this.W / 2,
      hipY: this.H * 0.6,
      groundY: this.H * 0.85,
      t: this.H * 0.22,
      lastTorso: 0.22,
      lastTapAt: -10,
      streak: 0,
      maxStreak: 0,
      switches: 0,
      lows: 0,
      lostCount: 0,
      lowMode: false,
      ready: false,
      seenAt: -10,
    }
  }

  /** 玩家离开画面：收起球与连拍（统计保留），别在屏幕上留一颗没人拍的球 */
  private resetPS(st: PState) {
    st.ready = false
    st.streak = 0
    st.lastTapAt = -10
    st.lowMode = false
    st.ball = this.newBall()
  }

  tick(f: PoseFrame, dt: number) {
    const heat = Math.min(1, this.t / 45)
    // 口令调度（全体共享，对齐站点）
    this.cmdT -= dt
    if (this.cmdT <= 0 && this.cmdCount >= 0) {
      const first = this.cfg.firstCmd
      if (this.lastCmd === null && this.t < first) {
        this.cmdT = first - this.t
      } else {
        this.issueCmd()
        const [lo, hi] = this.cfg.gap
        let gap = lo + Math.random() * (hi - lo)
        if (this.lastCmd === 'low') gap *= 0.75 // low 后下一口令提前 25%
        this.cmdT = gap
      }
    }

    // 横幅计时每帧只走一次（原来放在玩家循环里，双人时会被减两次）
    if (this.bannerT > 0) this.bannerT -= dt

    for (let pi = 0; pi < 2; pi++) {
      const st = this.ps[pi]
      const b = f.bodies[pi]
      if (b) st.seenAt = this.t
      // 这个位置的人已经离开画面：超过 LEAVE_T 就把球收掉，
      // 否则误检出的第二个人会留下一颗永远在弹、谁也拍不到的幽灵球
      if (st.ready && !b && this.t - st.seenAt > LEAVE_T) {
        this.resetPS(st)
        continue
      }
      const ball = st.ball

      // 身体标定
      if (b) {
        const torso = Math.min(this.H * 0.42, Math.max(50, Math.max(0.05, b.scale) * this.H))
        if (!st.ready) {
          st.ready = true
          st.anchorX = b.hipC.x * this.W
          st.hipY = b.hipC.y * this.H
          st.t = torso
        }
        st.lastTorso += (torso - st.lastTorso) * Math.min(1, dt * 3)
        st.anchorX += (b.hipC.x * this.W - st.anchorX) * Math.min(1, dt * 6)
        const hipTarget = b.hipC.y * this.H
        // 下蹲时髋基线慢更新（0.6/s）、站起快（3/s）——对齐站点
        st.hipY += (hipTarget - st.hipY) * Math.min(1, dt * (b.squat ? 0.6 : 3))
        const footY = ((b.lFoot.y + b.rFoot.y) / 2) * this.H
        const g = Math.min(footY > 0 ? footY : st.hipY + 1.35 * st.t, st.hipY + 1.8 * st.t)
        st.groundY += (Math.min(g, this.H - 40) - st.groundY) * Math.min(1, dt * 4)
      }

      // 球位置
      const ballR = Math.min(95, Math.max(22, st.lastTorso * this.H * this.cfg.ballR))
      const peakY = st.lowMode ? st.hipY + 0.22 * st.t : st.hipY - 0.25 * st.t
      const period = this.cfg.period * (1 - this.cfg.faster * heat)
      const ballX = st.anchorX + ball.side * 0.62 * st.t
      const ballY = st.groundY - (st.groundY - peakY) * ball.h

      // 状态机
      if (ball.state === 'up') {
        ball.t += dt
        const n = Math.min(1, ball.t / ball.dur)
        ball.h = 1 - (1 - n) * (1 - n) // ease-out
        if (ball.t > ball.dur + this.cfg.late) {
          // 丢球
          ball.state = 'lost'
          ball.t = 0
          st.streak = 0
          st.lostCount++
          this.ctx.audio.fail()
          if (st.maxStreak >= 5) this.ctx.speak('球跑啦，再来！')
        }
      } else if (ball.state === 'down') {
        ball.t += dt
        ball.h = Math.max(0, 1 - ball.t / ball.dur)
        if (ball.t >= ball.dur) {
          // 落地反弹
          this.ctx.audio.play('drop', 0.3, 0.9)
          this.particles.burst(ballX, st.groundY, '#b8a9c9', 5, 120, 3)
          ball.state = 'up'
          ball.t = 0
          ball.dur = period * UP_RATIO
          if (ball.wantSwitch) {
            ball.side *= -1
            ball.wantSwitch = false
          }
          ball.low = st.lowMode
        }
      } else {
        // lost
        ball.t += dt
        if (ball.t >= LOST_T) {
          ball.state = 'up'
          ball.t = 0
          ball.dur = FIRST_UP
          ball.h = 0
          st.lowMode = false
        }
        continue
      }

      // 拍击判定（顶点窗 ±0.5 躯干；下拍手速门槛；冷却 0.2s）
      if (!b || ball.state !== 'up') continue
      const torsoPx = st.lastTorso
      const sinceTap = this.t - st.lastTapAt
      if (sinceTap < TAP_CD) continue
      if (Math.abs(ballY - peakY) > HIT_WIN * torsoPx) continue
      const hands = [
        { trail: this.players[pi].lHand.trail, x: b.lHand.x * this.W, y: b.lHand.y * this.H },
        { trail: this.players[pi].rHand.trail, x: b.rHand.x * this.W, y: b.rHand.y * this.H },
      ]
      for (const h of hands) {
        if (h.trail.length < 2) continue
        const a = h.trail[h.trail.length - 2]
        const zz = h.trail[h.trail.length - 1]
        const vyTorso = (zz.y - a.y) / Math.max(0.001, dt) / Math.max(0.05, st.lastTorso / this.H)
        if (vyTorso < this.cfg.hitSpeed) continue
        if (Math.hypot(h.x - ballX, h.y - ballY) > ballR + 0.8 * HAND_R + 0.1 * torsoPx) continue
        if (h.y > ballY + ballR) continue
        // 拍中！
        const h0 = ball.h
        ball.state = 'down'
        ball.t = 0
        ball.dur = period * (st.lowMode ? LOW_RATIO : 1) * DOWN_RATIO * Math.max(0.6, Math.sqrt(h0))
        st.lastTapAt = this.t
        st.streak++
        st.maxStreak = Math.max(st.maxStreak, st.streak)
        this.score++
        this.ctx.audio.play('pop', 1, 1 + Math.min(0.35, st.streak * 0.012))
        this.particles.burst(ballX, ballY, '#ffd54a', 6, 220, 4)
        if (ball.crossed) {
          st.switches++
          ball.crossed = false
          this.say('换手成功！', ballX, ballY - 40, '#4cc9f0', 32)
        }
        if (st.streak % 10 === 0) {
          this.sayText(`连拍 ${st.streak} 下！`)
          this.ctx.audio.good()
          this.particles.burst(ballX, ballY, '#ffd54a', 16, 380, 5)
        }
        break
      }
    }

    const best = Math.max(this.ps[0].streak, this.ps[1].streak)
    this.ctx.setScore(this.score)
    this.ctx.setCombo(best)
    this.ctx.setExtra('最多连拍', Math.max(this.ps[0].maxStreak, this.ps[1].maxStreak))
    this.ctx.setExtra('换手成功', this.ps[0].switches + this.ps[1].switches)
    this.ctx.setExtra('低球', this.ps[0].lows + this.ps[1].lows)
    this.ctx.setExtra('丢球', this.ps[0].lostCount + this.ps[1].lostCount)
  }

  private score = 0

  private issueCmd() {
    this.cmdCount++
    let cmd: Cmd
    if (this.lastCmd === 'low') cmd = 'high'
    else if (Math.random() < this.cfg.lowRate) cmd = 'low'
    else cmd = 'switch'
    this.lastCmd = cmd
    const labels: Record<Cmd, string> = { switch: '换手！', low: '低一点！', high: '站起来！' }
    this.bannerText = labels[cmd]
    this.bannerT = 1.4
    this.ctx.speak(labels[cmd])
    for (let pi = 0; pi < 2; pi++) {
      const st = this.ps[pi]
      if (!st.ready) continue
      if (cmd === 'switch') st.ball.wantSwitch = true
      if (cmd === 'low' && !st.lowMode) {
        st.lowMode = true
        st.lows++
      }
      if (cmd === 'high' && st.lowMode) st.lowMode = false
    }
  }

  private sayText(text: string) {
    this.bannerText = text
    this.bannerT = 1
  }

  paint(c: CanvasRenderingContext2D) {
    for (let pi = 0; pi < 2; pi++) {
      const st = this.ps[pi]
      if (!st.ready) continue
      const ballR = Math.min(95, Math.max(22, st.lastTorso * this.H * this.cfg.ballR))
      const peakY = st.lowMode ? st.hipY + 0.22 * st.t : st.hipY - 0.25 * st.t
      const ballX = st.anchorX + st.ball.side * 0.62 * st.t
      const ballY = st.groundY - (st.groundY - peakY) * st.ball.h
      // 影子
      c.save()
      c.globalAlpha = 0.18 + 0.14 * st.ball.h
      c.beginPath()
      c.ellipse(ballX, st.groundY, ballR * (1.1 - 0.4 * st.ball.h), ballR * 0.32, 0, 0, Math.PI * 2)
      c.fillStyle = '#000'
      c.fill()
      c.restore()
      // 球
      c.save()
      c.translate(ballX, ballY)
      const squash = st.ball.state === 'down' && st.ball.h < 0.15 ? 0.86 : 1
      c.scale(2 - squash, squash)
      glow(c, 0, 0, ballR * 1.9, '#ff7a45', 0.3)
      c.beginPath()
      c.arc(0, 0, ballR, 0, Math.PI * 2)
      c.fillStyle = '#ff7a45'
      c.fill()
      c.strokeStyle = 'rgba(255,255,255,.7)'
      c.lineWidth = 3
      c.stroke()
      c.beginPath()
      c.arc(0, 0, ballR, -0.4, 1.2)
      c.strokeStyle = 'rgba(180,80,30,.7)'
      c.lineWidth = 4
      c.stroke()
      c.restore()
      // 顶点手掌虚影（命中窗内）
      if (st.ball.state === 'up') {
        const inWindow = Math.abs(ballY - peakY) < HIT_WIN * st.lastTorso
        c.save()
        c.globalAlpha = inWindow ? 0.5 + 0.2 * Math.sin(this.t * 14) : 0.25
        c.strokeStyle = '#ffffff'
        c.setLineDash([6, 6])
        c.lineWidth = 3
        c.beginPath()
        c.arc(ballX, peakY, ballR * 1.3, 0, Math.PI * 2)
        c.stroke()
        c.restore()
      }
    }

    const best = Math.max(this.ps[0].streak, this.ps[1].streak)
    if (best >= 2) outlineTxt(c, `连拍 ${best}`, 100, 50, 30 + Math.min(14, best), '#ffd54a')
    if (this.bannerT > 0) {
      c.globalAlpha = Math.min(1, this.bannerT / 0.3)
      outlineTxt(c, this.bannerText, this.W / 2, 150, 48, '#ffb703')
      c.globalAlpha = 1
    }
    txt(c, '球弹到顶就往下拍；听口令：换手 / 低一点 / 站起来', this.W / 2, this.H - 30, 20, 'rgba(255,255,255,.8)', 'center', 'bold')
  }
}

export default function create(ctx: GameContext) {
  return new BounceBall(ctx)
}
