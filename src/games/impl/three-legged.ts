import { BaseGame, PLAYER_COLORS } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { bg, outlineTxt, rr } from '@/core/draw'

/**
 * 两人三足（对齐 dongdongpark 真实规则）：
 * 横向卷轴跑道，按鼓点交替抬腿前进，每拍只认一条腿（红＝左/绑着的里侧腿，蓝＝右/外侧腿）；
 * 双人时两人必须同时抬同一条腿才算一步。跑到终点，用时越短分越高；隔壁班同时陪跑。
 *
 * 站点原样保留的七条规则：
 * 1. 拍点 `k(i) = 1 + 4D + i·D`（D = 60/bpm）：先 4 个预备拍，拍 0 起跑并开始计时。
 * 2. 命中窗 ±0.28/±0.23/±0.19 秒；评级 |o| ≤ 0.08 perfect、≤ 0.15 good、否则 ok（系数 1 / 0.9 / 0.78）。
 * 3. 网格自动校准：每次踩准都按误差把整张网格挪 20%，范围 [−0.1, +0.2] 秒（「跟着孩子的节奏走」）。
 * 4. 必须换脚：第一次成功踩点决定交替基准，之后乱序即「换脚！」并绊倒。
 * 5. 绊倒三重惩罚：停 0.4~0.6 秒、丢掉一半待释放距离、连步清零。
 * 6. 连步加成：`stride × 判定系数 × (0.9 + 0.04×min(连步,5))`，5 步封顶 1.1 倍。
 * 7. 计分只看用时：到终点 `round(10000 / 秒)`；50 秒还没走完按进度折算 `round(200 × 进度)`。
 *
 * 与站点的差异（本框架限制，都写在这里）：
 * - 站点用 `kneeLift[i] > 0.6` 的宿主指标，本框架按 counter-kit 同口径换算：
 *   `(髋y − 膝y) / 肩髋距 + 0.45`，站姿≈0、抬到髋高≈0.45、抬过髋继续涨。
 * - 站点双人模式只判「两人同步」，不判跟拍（`ke` 里没有鼓点误差）；这里保持一致，
 *   所以双人模式的难点是合作而不是节奏，步幅另有 ×1.2 补偿。
 * - 站点赛道是 7 张手绘图；这里全部程序绘制，刻度与终点按米数换算。
 * - 站点 `duration: 0` 且内置 50 秒软上限，本框架同样不自动结束，由本文件自己 `finish()`。
 */

const DIFF = [
  { length: 40, bpm: 100, stride: 2, win: 0.28, sync: 0.33, trip: 0.4, rival: 2.7 },
  { length: 50, bpm: 120, stride: 2.1, win: 0.23, sync: 0.25, trip: 0.5, rival: 3.3 },
  { length: 60, bpm: 138, stride: 2.3, win: 0.19, sync: 0.2, trip: 0.6, rival: 4.4 },
]
const GRADE = { perfect: 1, good: 0.9, ok: 0.78 }
const PRE_BEATS = 4 // 预备拍数
const INTRO = 1 // 开局静默
const LIMIT = 50 // 时间上限（秒）
const VIEW = 12 // 可视赛道宽度（米）
const LIFT_UP = 0.6
const LIFT_DOWN = 0.45
const DEBOUNCE = 0.25
const RELEASE = 8 // 待释放距离转化速率（1/秒）
const FINISH_T = 2.6
const RIVAL_BUCKET = 1.5

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v))
}
function rnd(a: number, b: number) {
  return a + Math.random() * (b - a)
}

type Mark = 'hit' | 'miss'
type Phase = 'count' | 'run' | 'done'

interface LegState {
  up: [boolean, boolean]
  at: [number, number]
}

class ThreeLegged extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[0]
  D = 60 / this.cfg.bpm
  O = INTRO + PRE_BEATS * (60 / this.cfg.bpm)
  phase: Phase = 'count'
  /** 网格偏移（自动校准量） */
  gridOff = 0.06
  private baseLeg = -1
  private baseBeat = -99
  private marks = new Map<number, Mark>()
  private judged = -1
  private ring = -PRE_BEATS
  private tripUntil = 0
  private pending: { leg: number; at: number; player: number } | null = null
  private legs: LegState[] = [
    { up: [false, false], at: [-9, -9] },
    { up: [false, false], at: [-9, -9] },
  ]
  private done = false
  private doneAt = 0
  private rivalBucketAt = 0
  private rivalSpeed = 1
  private rivalPause = 0
  private samples: { t: number; p: number }[] = []

  B = 0 // 踩准数
  V = 0 // 绊倒次数
  missed = 0 // 漏拍 / 不同步
  z = 0 // 连步
  bestZ = 0
  P = 0 // 已跑距离
  oe = 0 // 待释放距离
  rivalPos = 0
  startAt = 0
  endAt = 0
  duo = false
  private banner = ''
  private bannerSub = ''
  private bannerColor = '#ffd54a'
  private bannerT = 0

  constructor(ctx: GameContext) {
    super(ctx)
    this.banner = '预备……'
    this.bannerSub = '跟着鼓点抬腿'
    this.bannerT = 2.2
    this.ctx.setStage('预备')
    this.ctx.speak('预备，跟着鼓点抬腿')
  }

  private beatTime(i: number) {
    return this.O + i * this.D
  }

  // ------------------------------------------------------------------ 主循环

  tick(f: PoseFrame, dt: number) {
    this.duo = f.bodies.length > 1
    if (this.bannerT > 0) this.bannerT -= dt

    // 鼓点
    while (this.beatTime(this.ring) <= this.t) {
      const i = this.ring
      if (i === -PRE_BEATS) {
        this.ctx.audio.play('tick', 0.7, 0.8)
        this.ctx.speak('预备')
      } else if (i === 0) {
        this.ctx.audio.play('start', 0.9)
        this.ctx.audio.play('tick', 0.8, 1.1)
        this.phase = 'run'
        this.startAt = this.beatTime(0)
        this.banner = '走！'
        this.bannerSub = ''
        this.bannerColor = '#3ddc97'
        this.bannerT = 0.9
        this.ctx.setStage('跑起来')
      } else if (i < 0) {
        this.ctx.audio.play('tick', 0.6, 0.9)
      } else {
        this.ctx.audio.play('tick', 0.7, 1)
      }
      this.ring++
    }

    if (this.phase === 'count') return

    if (this.phase === 'done') {
      if (!this.done) {
        this.done = true
        this.doneAt = this.t
      }
      if (this.t - this.doneAt >= FINISH_T) this.ctx.finish()
      return
    }

    // 抬腿输入
    for (let i = 0; i < 2; i++) {
      if (i === 1 && !this.duo) continue
      this.readLegs(i, f.bodies[i] ?? null, dt)
    }

    // 拍点漏判
    this.flushMisses()

    // 双人配对超时
    if (this.pending && this.t - this.pending.at > this.cfg.sync) {
      const p = this.pending
      this.pending = null
      this.missed++
      this.z = 0
      this.say('等等我！', this.playerX(p.player), this.H * 0.42, '#ff9f43', 30)
    }

    // 前进
    if (this.t >= this.tripUntil) {
      const d = this.oe * (1 - Math.exp(-RELEASE * dt))
      this.oe -= d
      this.P += d
    } else {
      this.oe = Math.max(0, this.oe * (1 - 0.6 * dt))
    }

    this.stepRival(dt)
    this.sample(dt)
    this.checkEnd()
    this.publishStats()
  }

  private readLegs(i: number, b: Body | null, dt: number) {
    const s = this.legs[i]
    if (!b) {
      s.up = [false, false]
      return
    }
    void dt
    for (const leg of [0, 1] as const) {
      const lift = this.kneeLift(b, leg)
      if (!s.up[leg] && lift > LIFT_UP) {
        s.up[leg] = true
        if (this.t - s.at[leg] >= DEBOUNCE) {
          s.at[leg] = this.t
          this.onLift(i, leg)
        }
      } else if (s.up[leg] && lift < LIFT_DOWN) {
        s.up[leg] = false
      }
    }
  }

  /** 抬膝幅度：站姿≈0，抬到髋高≈0.45（与 counter-kit 的高抬腿同口径） */
  private kneeLift(b: Body, leg: 0 | 1) {
    const hipY = (b.lHip.y + b.rHip.y) / 2
    const shY = (b.lShoulder.y + b.rShoulder.y) / 2
    const span = Math.max(0.06, Math.abs(hipY - shY))
    const kneeY = leg === 0 ? b.lKnee.y : b.rKnee.y
    return (hipY - kneeY) / span + 0.45
  }

  private onLift(player: number, leg: number) {
    if (this.phase !== 'run') return
    if (this.t >= this.tripUntil) {
      // 绊倒期间抬腿不算
    }
    if (!this.duo) {
      const a = Math.round((this.t - this.O - this.gridOff) / this.D)
      this.judgeBeat(a, leg, this.t)
      return
    }
    // 双人：只判两人是否同步抬同一条腿
    const p = this.pending
    if (!p || p.player === player) {
      this.pending = { leg, at: this.t, player }
      return
    }
    const gap = this.t - p.at
    if (gap > this.cfg.sync) {
      this.pending = { leg, at: this.t, player }
      this.missed++
      this.z = 0
      this.say('等等我！', this.playerX(p.player), this.H * 0.42, '#ff9f43', 30)
      return
    }
    this.pending = null
    if (p.leg !== leg) {
      this.tripUp('步子乱了！')
      return
    }
    const g = gap <= 0.08 ? GRADE.perfect : gap <= 0.16 ? GRADE.good : GRADE.ok
    this.advance(g)
  }

  /** 单人：跟拍判定 */
  private judgeBeat(a: number, leg: number, t: number) {
    if (a < 0) return // 还在预备拍
    const prev = this.marks.get(a)
    if (prev === 'hit') return this.tripUp('抢拍啦！')
    if (prev === 'miss') return this.tripUp('慢了！')
    const err = t - this.beatTime(a) - this.gridOff
    if (Math.abs(err) > this.cfg.win) {
      this.marks.set(a, 'miss')
      this.missed++
      return this.tripUp('没踩上鼓点')
    }
    if (leg !== this.expectLeg(a)) return this.tripUp('换脚！')

    this.marks.set(a, 'hit')
    this.gridOff = clamp(this.gridOff + err * 0.2, -0.1, 0.2)
    if (this.baseLeg < 0) {
      this.baseLeg = leg
      this.baseBeat = a
    }
    const ae = Math.abs(err)
    const g = ae <= 0.08 ? GRADE.perfect : ae <= 0.15 ? GRADE.good : GRADE.ok
    this.advance(g)
  }

  private expectLeg(a: number) {
    if (this.baseLeg < 0) return ((a % 2) + 2) % 2
    return (((this.baseLeg + (a - this.baseBeat)) % 2) + 2) % 2
  }

  private advance(g: number) {
    this.B++
    this.z++
    this.bestZ = Math.max(this.bestZ, this.z)
    const bonus = 0.9 + 0.04 * Math.min(this.z, 5)
    this.oe += this.cfg.stride * (this.duo ? 1.2 : 1) * g * bonus
    if (this.z % 10 === 0) {
      this.ctx.audio.play('score', 0.7, 1 + Math.min(0.4, this.z * 0.01))
      this.particles.burst(this.playerX(0), this.H * 0.78, '#ffd54a', 12, 300, 5)
    } else {
      this.ctx.audio.play('click', 0.5, g === GRADE.perfect ? 1.5 : 1.2)
    }
    if (g === GRADE.perfect) this.say(this.z % 2 ? '一！' : '二！', this.playerX(0), this.H * 0.62, '#ffd54a', 38)
  }

  private tripUp(reason: string) {
    if (this.t < this.tripUntil) return
    this.tripUntil = this.t + this.cfg.trip
    this.oe *= 0.5
    this.z = 0
    this.V++
    this.ctx.audio.play('drop', 0.7)
    this.say(reason, this.playerX(0), this.H * 0.5, '#ff5252', 40)
    this.particles.burst(this.playerX(0), this.H * 0.7, '#ff8a8a', 8, 240, 5)
    if (this.V === 1) this.ctx.speak(this.duo ? '绊了一下，一起喊一、二' : '绊了一下，跟着鼓点走')
  }

  /** 把「再也无法命中」的拍记成漏拍 */
  private flushMisses() {
    while (this.beatTime(this.judged + 1) + this.gridOff + this.cfg.win < this.t) {
      const b = this.judged + 1
      this.judged = b
      if (b < 0) continue
      if (this.marks.get(b) === 'hit') continue
      if (this.marks.get(b) !== 'miss') this.missed++
      this.marks.set(b, 'miss')
      this.z = 0
    }
  }

  // ------------------------------------------------------------------ 隔壁班

  private stepRival(dt: number) {
    if (this.t >= this.rivalBucketAt) {
      this.rivalBucketAt = this.t + RIVAL_BUCKET
      this.rivalSpeed = rnd(0.85, 1.15)
      if (Math.random() < 0.14 && this.rivalPos < this.cfg.length) this.rivalPause = 0.8
    }
    let v: number
    if (this.rivalPos >= this.cfg.length) v = 1.2
    else if (this.rivalPause > 0) {
      this.rivalPause = Math.max(0, this.rivalPause - dt)
      v = 0
    } else v = this.cfg.rival * this.rivalSpeed
    this.rivalPos += v * dt
  }

  private sample(dt: number) {
    this.samples.push({ t: this.t, p: this.P })
    while (this.samples.length > 2 && this.t - this.samples[0].t > 1) this.samples.shift()
    void dt
  }

  /** 最近 1 秒的平均速度（米/秒） */
  private speed() {
    const a = this.samples[0]
    const b = this.samples[this.samples.length - 1]
    if (!a || !b || b.t - a.t < 0.15) return 0
    return (b.p - a.p) / (b.t - a.t)
  }

  // ------------------------------------------------------------------ 结束

  private checkEnd() {
    const elapsed = Math.max(0.001, this.t - this.startAt)
    if (this.P >= this.cfg.length) {
      const used = Math.max(0.5, elapsed)
      const score = Math.round(10000 / used)
      this.ctx.addScore(score)
      this.ctx.audio.win()
      this.ctx.audio.play('score', 1, 1.2)
      this.particles.confetti(this.W, 50)
      const beatRival = this.rivalPos < this.cfg.length
      this.banner = beatRival ? '赢了隔壁班！' : '冲过终点！'
      this.bannerColor = beatRival ? '#ffd54a' : '#3ddc97'
      this.bannerSub = `${used.toFixed(2)} 秒`
      this.bannerT = FINISH_T
      this.say(`${used.toFixed(2)} 秒`, this.W / 2, this.H * 0.3, '#ffd54a', 48)
      this.ctx.speak(beatRival ? '赢了隔壁班！' : '冲过终点！')
      this.endAt = this.t
      this.phase = 'done'
      this.ctx.setStage('完成')
      this.publishStats()
      return
    }
    if (elapsed >= LIMIT) {
      const score = Math.round((200 * this.P) / this.cfg.length)
      this.ctx.addScore(score)
      this.ctx.audio.fail()
      this.banner = '时间到'
      this.bannerColor = '#ff9f43'
      this.bannerSub = `没走完（${Math.floor(this.P)} 米）`
      this.bannerT = FINISH_T
      this.endAt = this.t
      this.phase = 'done'
      this.ctx.setStage('时间到')
      this.publishStats()
    }
  }

  private publishStats() {
    this.ctx.setExtra('已跑米数', Math.floor(this.P))
    this.ctx.setExtra('用时(0.01秒)', this.phase === 'done' ? Math.round((this.endAt - this.startAt) * 100) : 0)
    this.ctx.setExtra('踩准率', this.B ? Math.round((this.B / Math.max(1, this.B + this.V + this.missed)) * 100) : 0)
    this.ctx.setExtra('最长连步', this.bestZ)
    this.ctx.setExtra('绊倒', this.V)
  }

  // ------------------------------------------------------------------ 绘制

  private ppm() {
    return this.W / VIEW
  }
  /** 玩家固定站位（世界滚动） */
  private playerX(i: number) {
    return this.W * (this.duo ? (i === 0 ? 0.34 : 0.46) : 0.4)
  }
  private floorY() {
    return this.H * 0.78
  }

  paint(c: CanvasRenderingContext2D) {
    bg(c, '#8fd3f0', '#e3f5fc')
    const fy = this.floorY()
    const ppm = this.ppm()

    // 跑道
    c.fillStyle = '#7cc47f'
    c.fillRect(0, fy - 10, this.W, this.H - fy + 10)
    c.fillStyle = '#b2704f'
    c.fillRect(0, fy - 2, this.W, this.H * 0.16)
    c.fillStyle = 'rgba(255,255,255,.25)'
    c.fillRect(0, fy - 6, this.W, 4)

    // 米数刻度
    c.textAlign = 'center'
    const stepM = 10
    const from = Math.floor((this.P - VIEW) / stepM) * stepM
    for (let m = Math.max(0, from); m <= this.P + VIEW && m <= this.cfg.length; m += stepM) {
      const x = this.playerX(0) + (m - this.P) * ppm
      if (x < -40 || x > this.W + 40) continue
      const isEnd = m >= this.cfg.length
      c.strokeStyle = isEnd ? '#ffffff' : 'rgba(255,255,255,.5)'
      c.lineWidth = isEnd ? 8 : 2
      c.beginPath()
      c.moveTo(x, fy - 8)
      c.lineTo(x, fy + 12)
      c.stroke()
      if (!isEnd) outlineTxt(c, `${m}`, x, fy + 34, 18, 'rgba(255,255,255,.75)')
    }
    // 终点旗
    const ex = this.playerX(0) + (this.cfg.length - this.P) * ppm
    if (ex > -100 && ex < this.W + 100) {
      c.fillStyle = '#ffffff'
      c.fillRect(ex - 6, fy - 150, 12, 150)
      c.fillStyle = '#ffffff'
      for (let r = 0; r < 3; r++) {
        for (let k = 0; k < 3; k++) {
          if ((r + k) % 2 === 0) continue
          c.fillStyle = '#2b3555'
          c.fillRect(ex + k * 14, fy - 150 + r * 14, 14, 14)
        }
      }
      c.fillStyle = '#ffffff'
      c.fillRect(ex, fy - 152, 58, 46)
      c.fillStyle = '#ffd54a'
      c.font = '900 20px "PingFang SC","Microsoft YaHei",system-ui,sans-serif'
      c.textAlign = 'center'
      c.fillText('终点', ex + 29, fy - 122)
    }

    // 隔壁班
    const rx = this.playerX(0) + (this.rivalPos - this.P) * ppm
    if (rx > -80 && rx < this.W + 80) {
      this.drawPair(c, rx, fy, '#ff8a8a', 0, 0, '隔壁班')
    }

    // 主队
    if (this.duo) {
      for (let i = 0; i < 2; i++) {
        const b = this.players[i].body
        const lift = b ? [this.kneeLift(b, 0), this.kneeLift(b, 1)] : [0, 0]
        this.drawRunner(c, this.playerX(i), fy, PLAYER_COLORS[i], lift[0], lift[1], this.t < this.tripUntil)
        outlineTxt(c, i === 0 ? '左边' : '右边', this.playerX(i), fy + 62, 20, PLAYER_COLORS[i])
      }
    } else {
      const b = this.players[0].body
      const lift = b ? [this.kneeLift(b, 0), this.kneeLift(b, 1)] : [0, 0]
      this.drawPair(c, this.playerX(0), fy, PLAYER_COLORS[0], lift[0], lift[1], '我')
    }

    this.drawPanel(c)
    this.drawHud(c)

    if (this.bannerT > 0 && this.banner) {
      c.globalAlpha = Math.min(1, this.bannerT * 1.6)
      outlineTxt(c, this.banner, this.W / 2, this.H * 0.22, 62, this.bannerColor)
      if (this.bannerSub) outlineTxt(c, this.bannerSub, this.W / 2, this.H * 0.22 + 58, 30, '#ffffffd0')
      c.globalAlpha = 1
    }
  }

  /** 单人模式：两个并排的小人（小伙伴 + 我） */
  private drawPair(c: CanvasRenderingContext2D, x: number, fy: number, color: string, liftL: number, liftR: number, label: string) {
    const sz = this.H * 0.055
    this.drawRunner(c, x - sz * 1.1, fy, color, liftL, liftR, false)
    this.drawRunner(c, x + sz * 1.1, fy, color, liftR, liftL, false)
    if (label) outlineTxt(c, label, x, fy + 56, 18, color)
  }

  private drawRunner(
    c: CanvasRenderingContext2D,
    x: number,
    fy: number,
    color: string,
    liftA: number,
    liftB: number,
    dizzy: boolean,
  ) {
    const sz = this.H * 0.062
    const wob = dizzy ? Math.sin(this.t * 18) * 0.08 : 0
    const bob = Math.sin(this.t * 6) * sz * 0.04
    const hipY = fy - sz * 1.15 + bob
    const bodyY = hipY - sz * 0.72
    c.save()
    c.translate(x, fy)
    c.rotate(wob)
    c.translate(-x, -fy)

    // 影子
    c.beginPath()
    c.ellipse(x, fy + 2, sz * 0.72, sz * 0.14, 0, 0, Math.PI * 2)
    c.fillStyle = 'rgba(20,30,20,.22)'
    c.fill()

    // 腿：抬得越高，膝盖越往前上方
    c.strokeStyle = color
    c.lineCap = 'round'
    c.lineWidth = sz * 0.26
    for (const [k, l] of [[-1, liftA], [1, liftB]] as const) {
      const up = Math.max(0, Math.min(1, (l - 0.2) / 1.1))
      c.beginPath()
      c.moveTo(x + k * sz * 0.18, hipY)
      c.lineTo(x + k * sz * 0.18 + up * sz * 0.55, hipY + sz * 0.5 - up * sz * 0.5)
      c.lineTo(x + k * sz * 0.24 + up * sz * 0.7, fy - up * sz * 0.62)
      c.stroke()
    }
    // 躯干
    c.beginPath()
    c.ellipse(x, bodyY, sz * 0.34, sz * 0.5, 0, 0, Math.PI * 2)
    c.fillStyle = color
    c.fill()
    // 头
    c.beginPath()
    c.arc(x, bodyY - sz * 0.66, sz * 0.26, 0, Math.PI * 2)
    c.fillStyle = '#ffdfc0'
    c.fill()
    c.lineWidth = 3
    c.strokeStyle = 'rgba(30,40,30,.35)'
    c.stroke()
    if (dizzy) {
      for (let i = 0; i < 3; i++) {
        const a = this.t * 6 + (i * Math.PI * 2) / 3
        c.beginPath()
        c.arc(x + Math.cos(a) * sz * 0.5, bodyY - sz * 1.05 + Math.sin(a) * sz * 0.2, 4, 0, Math.PI * 2)
        c.fillStyle = '#ffd54a'
        c.fill()
      }
    }
    c.restore()
  }

  /** 脚步面板：显示当前拍前后各几拍的期望腿 */
  private drawPanel(c: CanvasRenderingContext2D) {
    const w = 420
    const h = 76
    const x = this.W / 2 - w / 2
    const y = this.H - h - 26
    rr(c, x, y, w, h, 18)
    c.fillStyle = 'rgba(255,255,255,.86)'
    c.fill()
    c.strokeStyle = 'rgba(30,40,30,.15)'
    c.lineWidth = 2
    c.stroke()

    const base = this.phase === 'run' ? Math.round((this.t - this.O) / this.D) : -1
    for (let k = -3; k <= 3; k++) {
      const beat = base + k
      const cx = x + w / 2 + k * 50
      const leg = this.expectLeg(beat)
      const mark = this.marks.get(beat)
      const isNow = k === 0
      c.beginPath()
      c.ellipse(cx, y + h / 2 - 6, 18, 22, 0, 0, Math.PI * 2)
      c.fillStyle = mark === 'hit' ? '#ffd54a' : mark === 'miss' ? 'rgba(160,160,160,.5)' : leg === 0 ? '#ff6b6b' : '#4cc9f0'
      c.globalAlpha = isNow ? 1 : 0.62
      c.fill()
      c.globalAlpha = 1
      if (isNow) {
        c.lineWidth = 4
        c.strokeStyle = '#2b3555'
        c.stroke()
      }
      c.fillStyle = '#ffffff'
      c.font = '900 20px "PingFang SC","Microsoft YaHei",system-ui,sans-serif'
      c.textAlign = 'center'
      c.textBaseline = 'middle'
      c.fillText(leg === 0 ? '左' : '右', cx, y + h / 2 - 6)
    }
    outlineTxt(c, '脚印滑到中间时抬那只脚：红 = 左（绑着的）　蓝 = 右', this.W / 2, y + h + 22, 20, 'rgba(255,255,255,.9)')
  }

  private drawHud(c: CanvasRenderingContext2D) {
    const elapsed = Math.max(0, (this.phase === 'done' ? this.endAt : this.t) - this.startAt)
    outlineTxt(c, `${this.P.toFixed(1)} / ${this.cfg.length} 米`, this.W - 40, 96, 36, '#ffffff')
    outlineTxt(c, `${this.speed().toFixed(1)} 米/秒 · ${elapsed.toFixed(1)} 秒`, this.W - 40, 140, 22, '#ffffffcc')
    outlineTxt(c, `踩准 ${this.B} · 连 ${this.z} 步 · 绊倒 ${this.V}`, 40, 96, 22, '#ffffffcc')
    if (this.phase === 'run' && this.P < this.cfg.length) {
      const lead = this.rivalPos - this.P
      const text = lead > 0.5 ? `▶ 隔壁班 领先 ${lead.toFixed(0)} 米` : lead < -0.5 ? `◀ 落后 ${(-lead).toFixed(0)} 米` : '并排！'
      rr(c, this.W / 2 - 150, 84, 300, 40, 20)
      c.fillStyle = 'rgba(90,50,140,.55)'
      c.fill()
      outlineTxt(c, text, this.W / 2, 104, 22, '#ffffff')
    }
    // 时间条
    const bx = 40
    const bw = 240
    const by = 130
    rr(c, bx, by, bw, 12, 6)
    c.fillStyle = 'rgba(20,30,20,.35)'
    c.fill()
    const pct = clamp(1 - elapsed / LIMIT, 0, 1)
    if (pct > 0.01) {
      rr(c, bx, by, bw * pct, 12, 6)
      c.fillStyle = pct < 0.25 ? '#ff5252' : '#3ddc97'
      c.fill()
    }
    // 进度条
    const py = this.H - 16
    rr(c, 40, py, this.W - 80, 8, 4)
    c.fillStyle = 'rgba(20,30,20,.28)'
    c.fill()
    const pp = clamp(this.P / this.cfg.length, 0, 1)
    if (pp > 0.01) {
      rr(c, 40, py, (this.W - 80) * pp, 8, 4)
      c.fillStyle = '#ffd54a'
      c.fill()
    }
  }
}

export function createThreeLegged(ctx: GameContext): Game {
  return new ThreeLegged(ctx)
}

export default createThreeLegged
