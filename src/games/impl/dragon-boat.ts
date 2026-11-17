import { BaseGame } from '@/core/base'
import type { Game, GameContext, PoseFrame } from '@/core/types'
import { circle, outlineTxt, rr, txt } from '@/core/draw'

/**
 * 划龙舟（对齐 dongdongpark 真实规则）：
 * 跟随鼓点做"双手举高→往下一拉"的划桨动作，踩点越准船越快；与一条分段随机配速的
 * AI 蓝龙舟比谁先划完 200/260/320 米。双人各划一个桨位（得分独立、船速共享），
 * 单人配一位永远踩点的熊猫队友（每拍自动计入 pc=0.5 保底）。
 * 双结局：先到终点按完赛时间得分（K/秒），或 90s 时限到按里程折分。
 *
 * 【框架差异】站点 Beat.judge 的 perfect/ok 具体阈值在共享模块（黑盒），此处取推断值
 * perfect ±0.15s / ok ±0.3s；儿童模式 miss 且 |delta| ≤ 0.34s 按 ok 计（报告已确认该宽容）。
 * 儿童模式覆盖表 A 生效（站点 j=!big，本画布为普通/儿童模式）：window .34 / off .5 /
 * rival ×1.15 / up .15 / down .6 / fast=bpm（不变速）。
 */

/** 难度表 S：初始 BPM / 半程后 BPM / 赛程(米) / 完赛分数基数 / 蓝舟基准(s) / 举手阈值 / 拉下阈值 */
const DIFF = [
  { bpm: 56, fast: 56, dist: 200, K: 28000, rival: 42, up: 0.15, down: 0.6 },
  { bpm: 64, fast: 72, dist: 260, K: 31800, rival: 45, up: 0.05, down: 0.7 },
  { bpm: 72, fast: 84, dist: 320, K: 36900, rival: 48.5, up: -0.05, down: 0.75 },
]
/** 儿童模式覆盖表 A（站点 j=!big 时叠加；本画布为普通/儿童模式 → 生效） */
const KID_MODE = {
  kid: true,
  window: 0.34, // 判定宽容：miss 且 |delta| ≤ .34 按 ok
  off: 0.5, // 失拍保底分
  rivalMul: 1.15, // 对手减速 15%
}
void KID_MODE
/** 分值权重 C：on[re]（re = +!!duo → 单人 1 / 双人 .8）、perfect 额外 .1、off[re]、sync[re]、pc 单人熊猫保底 */
const C = { on: [1, 0.8], perfect: 0.1, off: [0.3, 0.24], sync: [0.5, 0.4], pc: 0.5 }
const W_SPD = 2 // 得分→船速增益
const T_DRAG = 0.6 // 船速基础衰减率（阻力）
const E0 = 1 // 首拍时刻（s）
const D_DELAY = 0.1 // 输入延迟补偿（判定时刻 −0.1s）
const LIMIT = 90 // 时限（s），超时按里程折分
const PX_PER_M = 34 // 像素/米换算（×unit）
const SEGMENTS = 6 // 蓝舟配速分段数
const PERFECT_WIN = 0.15 // perfect 判定窗（推断）
const OK_WIN = 0.3 // ok 判定窗（推断）
const Z_MAX = 1.6 // 混乱度上限

type SeatHit = { hit: boolean; delta: number; panda: boolean; settled: boolean }

interface SeatState {
  s: number // 平均((腕y−肩心y)/scale)：高位≈负、拉下≈正
  prevS: number
  prevT: number
  armed: boolean
  lastBeatIdx: number // 该座位上次划中的拍（防重复划）
}

class DragonBoat extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  seats: SeatState[] = [
    { s: 0, prevS: 0, prevT: 0, armed: false, lastBeatIdx: -1 },
    { s: 0, prevS: 0, prevT: 0, armed: false, lastBeatIdx: -1 },
  ]
  period = 60 / 56
  halfSwitched = false
  /** 拍序列：beats[i] = 第 i 拍时刻；info 同索引 */
  beats: number[] = []
  info: SeatHit[] = []
  nextBeatT = E0
  /** 船速模型 */
  L = 0
  R = 0
  z = 0
  topSpeed = 0
  /** 统计 */
  on = 0
  off = 0
  miss = 0
  me = 0 // 一起划齐
  combo = 0 // 连准连击（过期/失拍清零）
  bestStreak = 0 // 单人最长连准
  streakG = 0 // 双人连齐
  deltas: number[] = []
  /** 蓝舟对手 */
  rivalR = 0
  rivalV = 0
  rivalSeg = 0
  rivalFactors: number[] = []
  rivalDone = false
  saidPass = false
  saidCaught = false
  announceT = -9
  /** 结局 */
  ended = false
  endMsg = ''
  endSub = ''
  finishAt = -1
  rank = 1
  q = 0 // 完赛用时
  drumFlip = 0
  lastDrumIdx = -1
  drumPulse = 0
  splash: { x: number; y: number; t: number; color: string }[] = []

  constructor(ctx: GameContext) {
    super(ctx)
    this.period = 60 / this.cfg.bpm
    // 蓝舟基准配速：dist/(rival − 1.5)（−1.5 = 配速平滑的尾部时间修正，站点字面量）
    const rivalEff = KID_MODE.kid ? this.cfg.rival * KID_MODE.rivalMul : this.cfg.rival
    this.rivalV = this.cfg.dist / (rivalEff - 1.5)
  }

  tick(f: PoseFrame, dt: number) {
    const duo = f.bodies.length > 1
    const re = duo ? 1 : 0
    const dist = this.cfg.dist

    // ---- 节拍推进 ----
    if (!this.ended) {
      while (this.nextBeatT <= this.t + 1.5) {
        this.beats.push(this.nextBeatT)
        this.info.push({ hit: false, delta: 0, panda: false, settled: false })
        this.nextBeatT += this.period
      }
    }
    // 中程提速：里程过半切换 fast BPM（儿童模式 fast=bpm 不变速）
    if (!this.halfSwitched && this.R >= dist / 2) {
      this.halfSwitched = true
      const fast = KID_MODE.kid ? this.cfg.bpm : this.cfg.fast
      if (fast !== this.cfg.bpm) {
        this.period = 60 / fast
        this.say('鼓点变快啦！跟上，冲啊！', this.W / 2, this.H * 0.2, '#ffd54a', 40)
      }
    }
    // 每拍：鼓点（交替 .95/.7）+ 单人熊猫自动踩点（pc=0.5 计入该拍 → 熊猫永远踩点）
    if (this.t >= E0) {
      const curBeat = Math.floor((this.t - E0) / this.period)
      if (curBeat !== this.lastDrumIdx && curBeat >= 0 && curBeat < this.beats.length) {
        this.lastDrumIdx = curBeat
        this.drumFlip = 1 - this.drumFlip
        this.ctx.audio.play('pop', this.drumFlip === 0 ? 0.95 : 0.7, 0.7) // drum
        this.drumPulse = 1
        if (!duo) this.info[curBeat].panda = true
      }
    }
    this.drumPulse = Math.max(0, this.drumPulse - dt * 4)

    // ---- 拍过期判定 ----
    for (let i = 0; i < this.beats.length; i++) {
      const inf = this.info[i]
      if (inf.settled) continue
      const bt = this.beats[i]
      const nextT = this.beats[i + 1] ?? bt + this.period
      const expireAt = (bt + nextT) / 2 + 0.02 - D_DELAY
      if (this.t <= expireAt) continue
      inf.settled = true
      if (!duo) {
        // 单人：玩家没踩中该拍（熊猫的保底不算玩家）→ miss
        if (!inf.hit) {
          this.miss++
          this.combo = 0
          this.z = Math.min(Z_MAX, this.z + 0.45)
        } else if (inf.panda) {
          // sync 在玩家划中时已处理
        }
      } else {
        const h0 = inf.hit
        // hit 记在座位 0 通道；座位 1 存 panda 字段复用（见划桨判定）
        const h1 = inf.panda
        if (!h0 && !h1) {
          this.miss++
          this.combo = 0
          this.z = Math.min(Z_MAX, this.z + 0.45)
        } else if (h0 !== h1) {
          this.say('没划齐！', this.W / 2, this.H * 0.26, '#8fd3ff', 34)
          this.z = Math.min(Z_MAX, this.z + 0.5)
          this.streakG = 0
        }
      }
    }

    // ---- 划桨检测（ke）：s < up 蓄力；armed 且 s ≥ down 触发；跨越中点线性插值取亚帧时刻 ----
    for (let pi = 0; pi < 2; pi++) {
      const b = f.bodies[pi]
      const st = this.seats[pi]
      if (!b) continue
      const span = Math.max(0.1, b.scale)
      const sNow = ((b.lHand.y - b.shoulderC.y) / span + (b.rHand.y - b.shoulderC.y) / span) / 2
      const upTh = KID_MODE.kid ? 0.15 : this.cfg.up
      const downTh = KID_MODE.kid ? 0.6 : this.cfg.down
      const mid = (upTh + downTh) / 2
      if (sNow < upTh) st.armed = true
      let strokeT = -1
      if (st.armed && sNow >= downTh) {
        // 跨越中点帧间线性插值（0.5s 内有效，否则 t−0.12），再减延迟补偿 D
        let midAt = this.t - 0.12
        if (st.prevS < mid && sNow >= mid && sNow > st.prevS) {
          const k = (mid - st.prevS) / (sNow - st.prevS)
          midAt = st.prevT + k * (this.t - st.prevT)
          if (this.t - midAt > 0.5) midAt = this.t - 0.12
        }
        strokeT = midAt - D_DELAY
        st.armed = false
      }
      st.prevS = sNow
      st.prevT = this.t
      st.s = sNow
      if (strokeT >= 0 && !this.ended) this.stroke(pi, strokeT, duo, re)
    }

    // ---- 船速模型 ----
    this.L *= Math.exp(-(T_DRAG + this.z * 0.35) * dt)
    this.z *= Math.exp(-1.6 * dt)
    if (!this.ended) {
      this.R += this.L * dt
      this.topSpeed = Math.max(this.topSpeed, this.L)
    }

    // ---- 蓝舟对手（分段随机配速，速度平滑 τ≈1.1s）----
    if (!this.rivalDone) {
      const segLen = dist / SEGMENTS
      const segIdx = Math.min(SEGMENTS - 1, Math.floor(this.rivalR / segLen))
      if (segIdx !== this.rivalSeg) {
        this.rivalSeg = segIdx
        const rivalEff = KID_MODE.kid ? this.cfg.rival * KID_MODE.rivalMul : this.cfg.rival
        this.rivalV = (dist / (rivalEff - 1.5)) * this.rivalFactors[segIdx]
      }
      this.rivalR += this.rivalV * dt
      if (this.rivalR >= dist && !this.rivalDone) {
        this.rivalDone = true
        if (!this.ended) this.say('蓝龙舟先到终点了！', this.W / 2, this.H * 0.18, '#7db8ff', 38)
      }
    }
    // 领先/落后 3m 播报（5s 冷却）
    const diffM = this.R - this.rivalR
    if (!this.ended && Math.abs(diffM) > 3 && this.t - this.announceT > 5) {
      if (diffM > 0 && !this.saidPass) {
        this.saidPass = true
        this.announceT = this.t
        this.ctx.audio.slash() // whoosh 首超
        this.say('超过啦！', this.W / 2, this.H * 0.18, '#3ddc97', 40)
      } else if (diffM < 0 && this.saidPass && !this.saidCaught) {
        this.saidCaught = true
        this.announceT = this.t
        this.say('蓝龙舟追上来了！', this.W / 2, this.H * 0.18, '#7db8ff', 36)
      }
    }

    // ---- 结局 ----
    if (!this.ended) {
      if (this.R >= dist) {
        // 完赛 Me：按当前速度回推完赛用时
        this.ended = true
        this.q = Math.max(1, this.t - (this.R - dist) / Math.max(this.L, 0.1))
        const gain = Math.round(this.cfg.K / this.q)
        this.score += gain
        this.rank = !this.rivalDone || this.q < this.rivalFinishTime() ? 1 : 2
        this.endMsg = `${this.q.toFixed(1)} 秒完赛！`
        this.endSub = this.rank === 1 ? '第一名！超过蓝龙舟啦' : '第二名，蓝龙舟快了一步'
        this.ctx.speak(this.rank === 1 ? '第一名！' : '到终点啦！')
        this.ctx.audio.win()
        this.particles.confetti(this.W, 50)
        this.finishAt = this.t + 2.6
      } else if (this.t > LIMIT) {
        // 超时 Ne：按里程折分
        this.ended = true
        const gain = Math.round((this.cfg.K / this.t) * (this.R / dist))
        this.score += gain
        this.q = 0
        this.rank = this.R >= this.rivalR ? 1 : 2
        this.endMsg = '时间到！'
        this.endSub = `没划完（${Math.round(this.R)} 米）`
        this.ctx.speak('没划完，下次跟上鼓点！')
        this.finishAt = this.t + 2.2
      }
    } else if (this.finishAt > 0 && this.t >= this.finishAt) {
      this.finishAt = -1
      this.ctx.finish()
    }

    // 水花粒子
    for (let i = this.splash.length - 1; i >= 0; i--) {
      this.splash[i].t -= dt
      if (this.splash[i].t <= 0) this.splash.splice(i, 1)
    }

    // HUD
    this.ctx.setScore(Math.round(this.score))
    this.ctx.setCombo(this.combo)
    const total = this.on + this.off + this.miss
    this.ctx.setExtra('划准', total ? Math.round((this.on / total) * 100) : 100)
    if (duo) this.ctx.setExtra('一起划齐', this.me)
    else this.ctx.setExtra('最多连着划准', this.bestStreak)
    if (this.deltas.length >= 5) {
      this.ctx.setExtra('节奏', Math.round(this.deltas.reduce((a, d) => a + d, 0) / this.deltas.length))
    }
    this.ctx.setExtra('最快船速', Math.round(this.topSpeed * 10) / 10)
  }

  /** 蓝舟完赛时刻（用分段配速近似回推） */
  private rivalFinishTime() {
    return this.t - (this.rivalR - this.cfg.dist) / Math.max(0.1, this.rivalV)
  }

  /** 一次划桨判定 Oe：取最近拍 → extra/on/off → 得分 → 船速 */
  private stroke(pi: number, tj: number, duo: boolean, re: number) {
    const b = this.players[pi].body
    const px = b ? b.shoulderC.x * this.W : this.W / 2
    // 水花
    this.splash.push({ x: px, y: this.H * 0.7, t: 0.4, color: this.players[pi].color })
    // 取最近拍：当前最后已过拍 vs 下一拍
    let bestIdx = -1
    let bestD = Infinity
    for (let i = 0; i < this.beats.length; i++) {
      const d = tj - this.beats[i]
      if (Math.abs(d) < Math.abs(bestD)) {
        bestD = d
        bestIdx = i
      }
    }
    if (bestIdx < 0) return
    const inf = this.info[bestIdx]
    const seatKey: 'hit' | 'panda' = duo && pi === 1 ? 'panda' : 'hit'
    // 同一拍重复划 → extra（"慢一点"，无分）
    if (inf[seatKey]) {
      this.say('慢一点', px, this.H * 0.3, '#8fd3ff', 30)
      this.z = Math.min(Z_MAX, this.z + 0.25)
      return
    }
    inf[seatKey] = true
    inf.delta = bestD
    // judge：perfect/ok/off（儿童模式 miss 且 |delta| ≤ .34 按 ok）
    const ad = Math.abs(bestD)
    let kind: 'perfect' | 'ok' | 'off' = 'off'
    if (ad <= PERFECT_WIN) kind = 'perfect'
    else if (ad <= OK_WIN) kind = 'ok'
    else if (KID_MODE.kid && ad <= KID_MODE.window) kind = 'ok'
    if (kind === 'off') {
      // 失拍：儿童模式 A.off×(双人?0.8:1)，big 模式 C.off[re]
      const gain = KID_MODE.kid ? KID_MODE.off * (duo ? 0.8 : 1) : C.off[re]
      this.score += gain
      this.off++
      this.combo = 0
      this.L += W_SPD * gain
      this.say(`+${gain.toFixed(1)}`, px, this.H * 0.32, '#9fb4d8', 26)
    } else {
      const gain = C.on[re] + (kind === 'perfect' ? C.perfect : 0)
      this.score += gain
      this.on++
      this.combo++
      this.bestStreak = Math.max(this.bestStreak, this.combo)
      this.L += W_SPD * gain
      this.deltas.push(Math.abs(bestD) * 1000)
      this.say(kind === 'perfect' ? '完美！' : '准！', px, this.H * 0.32, kind === 'perfect' ? '#ffd54a' : '#3ddc97', kind === 'perfect' ? 40 : 36)
      if (kind === 'perfect') this.ctx.audio.good()
      else this.ctx.audio.play('score', 0.8, 1.1)
      // 连准横幅：单人每 10 次；≥3 屏显
      if (!duo && this.combo >= 3 && this.combo % 10 === 0) {
        this.say(`连着划准 ${this.combo} 下！`, this.W / 2, this.H * 0.22, '#ffd54a', 42)
        this.ctx.audio.combo() // chime
      }
    }
    // 齐（sync）：双桨位都踩中同一拍（duo）或玩家+熊猫（solo）
    if (inf.hit && inf.panda) {
      const gain = C.sync[duo ? 1 : 0]
      this.score += gain
      if (!inf.settled && !this.synced.has(bestIdx)) {
        this.synced.add(bestIdx)
        this.me++
        if (duo) {
          this.streakG++
          this.say('齐！', this.W / 2, this.H * 0.36, '#ff9f43', 40)
          if (this.streakG % 8 === 0) {
            this.say(`一起划 ${this.streakG} 下！`, this.W / 2, this.H * 0.22, '#ff9f43', 42)
            this.ctx.audio.combo()
          }
        }
      }
    }
  }

  synced = new Set<number>()
  score = 0

  paint(c: CanvasRenderingContext2D) {
    const U = this.H / 720
    const duo = this.players.filter((p) => p.body).length > 1
    const dist = this.cfg.dist

    // 水面
    c.save()
    const g = c.createLinearGradient(0, this.H * 0.4, 0, this.H)
    g.addColorStop(0, 'rgba(60,140,220,.4)')
    g.addColorStop(1, 'rgba(30,90,180,.55)')
    c.fillStyle = g
    c.fillRect(0, this.H * 0.4, this.W, this.H * 0.6)
    c.restore()

    // 顶部进度条（progress: max = dist）
    const prog = Math.min(1, this.R / dist)
    const rivalProg = Math.min(1, this.rivalR / dist)
    c.save()
    rr(c, this.W * 0.2, 26 * U, this.W * 0.6, 16 * U, 8 * U)
    c.fillStyle = 'rgba(255,255,255,.2)'
    c.fill()
    rr(c, this.W * 0.2, 26 * U, this.W * 0.6 * prog, 16 * U, 8 * U)
    c.fillStyle = '#ff9f43'
    c.fill()
    // 蓝舟标记
    circle(c, this.W * 0.2 + this.W * 0.6 * rivalProg, 34 * U, 9 * U, '#5b9cff')
    txt(c, `${Math.round(this.R)}m / ${dist}m`, this.W * 0.2, 56 * U, 18 * U, 'rgba(255,255,255,.85)', 'left')
    if (!this.ended) txt(c, `${Math.max(0, Math.ceil(LIMIT - this.t))}s`, this.W * 0.8, 56 * U, 18 * U, 'rgba(255,255,255,.85)', 'right')
    c.restore()

    // 我方龙舟（居中偏下，龙首 + 鼓 + 桨位）
    const boatY = this.H * 0.66
    const bob = Math.sin(this.t * 2.4) * 4 * U + this.z * Math.sin(this.t * 9) * 8 * U // 混乱度→螺旋晃动
    c.save()
    c.translate(this.W / 2, boatY + bob)
    // 船体
    c.fillStyle = '#e05252'
    c.beginPath()
    c.ellipse(0, 10 * U, 300 * U, 42 * U, 0, 0, Math.PI * 2)
    c.fill()
    // 龙首
    c.fillStyle = '#f4a261'
    circle(c, 290 * U, -26 * U + Math.sin(this.t * 3) * 4 * U, 30 * U, '#f4a261')
    circle(c, 300 * U, -34 * U, 5 * U, '#222')
    // 鼓
    const pulse = 1 + 0.12 * this.drumPulse
    c.save()
    c.scale(pulse, pulse)
    circle(c, 0, -34 * U, 34 * U, '#c0392b')
    circle(c, 0, -34 * U, 27 * U, '#f6d55c')
    if (this.drumPulse > 0.5) txt(c, '咚', 0, -34 * U, 22 * U, '#7a4a1f')
    c.restore()
    // 桨位（duo：两位玩家；solo：玩家 + 熊猫）
    const paddlers = duo ? [0, 1] : [0]
    paddlers.forEach((pi, idx) => {
      const x = (duo ? (idx === 0 ? -120 : 120) : 120) * U
      const b = this.players[pi].body
      // 划桨动画：拍相位驱动（0–0.15 满桨→0.7 回位）
      const phase = ((this.t - E0) / this.period) % 1
      const rowK = phase < 0.15 ? 1 : phase < 0.7 ? 1 - (phase - 0.15) / 0.55 : 0
      circle(c, x, -20 * U, 22 * U, b ? this.players[pi].color : '#ddd')
      c.strokeStyle = '#8d5b34'
      c.lineWidth = 6 * U
      c.beginPath()
      c.moveTo(x, -20 * U)
      c.lineTo(x + 30 * U, (-20 + rowK * 26) * U)
      c.stroke()
      txt(c, duo ? `P${pi + 1}` : '', x, -58 * U, 16 * U, this.players[pi].color)
    })
    if (!duo) {
      // 熊猫队友（白衬衫，永远踩点）
      const x = -120 * U
      circle(c, x, -20 * U, 22 * U, '#e8e8f0')
      circle(c, x - 8 * U, -26 * U, 4 * U, '#333')
      circle(c, x + 8 * U, -26 * U, 4 * U, '#333')
      txt(c, '熊猫', x, -58 * U, 16 * U, '#dfe6ff')
    }
    c.restore()

    // 水花
    for (const s of this.splash) {
      c.save()
      c.globalAlpha = s.t / 0.4
      circle(c, s.x, s.y, 10 * U, s.color)
      c.restore()
    }

    // 蓝舟（画在屏幕外时显示箭头牌：领先/落后 n 米）
    const rel = this.R - this.rivalR
    const rivalX = this.W / 2 + rel * PX_PER_M * U
    if (rivalX > -120 * U && rivalX < this.W + 120 * U) {
      c.save()
      c.translate(rivalX, this.H * 0.34)
      c.fillStyle = '#5b9cff'
      c.beginPath()
      c.ellipse(0, 0, 150 * U, 26 * U, 0, 0, Math.PI * 2)
      c.fill()
      circle(c, 130 * U, -14 * U, 16 * U, '#8fc3ff')
      txt(c, '蓝龙舟', 0, -44 * U, 20 * U, '#dceaff')
      c.restore()
    } else {
      const ahead = rel < 0
      c.save()
      c.fillStyle = 'rgba(20,30,60,.6)'
      rr(c, ahead ? this.W - 210 * U : 20 * U, this.H * 0.3, 190 * U, 60 * U, 12 * U)
      c.fill()
      txt(c, `${ahead ? '→' : '←'} 蓝龙舟 ${ahead ? '领先' : '落后'} ${Math.round(Math.abs(rel))} 米`, ahead ? this.W - 115 * U : 115 * U, this.H * 0.3 + 30 * U, 20 * U, '#dceaff')
      c.restore()
    }

    // 双桨位仪表（Ve）：黄线=举高阈值、绿线=拉下阈值、虚线=肩线、指针=当前手位
    const upTh = KID_MODE.kid ? 0.15 : this.cfg.up
    const downTh = KID_MODE.kid ? 0.6 : this.cfg.down
    for (let pi = 0; pi < 2; pi++) {
      const b = this.players[pi].body
      if (!b) continue
      const gx = duo ? (pi === 0 ? 70 * U : this.W - 70 * U) : 70 * U
      const gy = this.H * 0.72
      const gh = 170 * U
      c.save()
      rr(c, gx - 26 * U, gy - gh, 52 * U, gh, 10 * U)
      c.fillStyle = 'rgba(16,22,52,.4)'
      c.fill()
      // 阈值线（s 从 -0.6 到 1.2 线性映射）
      const toY = (v: number) => gy - ((Math.max(-0.6, Math.min(1.2, v)) + 0.6) / 1.8) * gh
      c.strokeStyle = '#ffd54a'
      c.lineWidth = 3
      c.beginPath()
      c.moveTo(gx - 22 * U, toY(upTh))
      c.lineTo(gx + 22 * U, toY(upTh))
      c.stroke()
      c.strokeStyle = '#3ddc97'
      c.beginPath()
      c.moveTo(gx - 22 * U, toY(downTh))
      c.lineTo(gx + 22 * U, toY(downTh))
      c.stroke()
      c.setLineDash([4, 4])
      c.strokeStyle = 'rgba(255,255,255,.4)'
      c.beginPath()
      c.moveTo(gx - 22 * U, toY(0))
      c.lineTo(gx + 22 * U, toY(0))
      c.stroke()
      c.setLineDash([])
      // 指针
      circle(c, gx, toY(this.seats[pi].s), 7 * U, this.players[pi].color)
      if (this.seats[pi].armed) {
        c.strokeStyle = '#ffd54a'
        c.lineWidth = 2
        circle(c, gx, toY(this.seats[pi].s), 12 * U, 'transparent')
        c.beginPath()
        c.arc(gx, toY(this.seats[pi].s), 12 * U, 0, Math.PI * 2)
        c.stroke()
      }
      txt(c, duo ? `P${pi + 1}` : '你', gx, gy + 18 * U, 16 * U, this.players[pi].color)
      c.restore()
    }

    // 结束横幅
    if (this.ended) {
      c.save()
      c.fillStyle = 'rgba(8,12,32,.45)'
      c.fillRect(0, this.H * 0.3, this.W, 150 * U)
      c.restore()
      outlineTxt(c, this.endMsg, this.W / 2, this.H * 0.34 + 40 * U, 48, '#ffd54a')
      txt(c, this.endSub, this.W / 2, this.H * 0.34 + 96 * U, 26 * U, '#fff')
    } else {
      if (this.combo >= 3 && !duo) outlineTxt(c, `连着划准 ×${this.combo}`, this.W / 2, 84 * U, 30, '#3ddc97')
    }
    txt(c, '双手举高→往下一拉 = 划一桨；跟着鼓点划，齐了船才快！', this.W / 2, this.H - 26, 20, 'rgba(255,255,255,.85)', 'center', 'bold')
  }
}

export default function create(ctx: GameContext) {
  return new DragonBoat(ctx)
}
