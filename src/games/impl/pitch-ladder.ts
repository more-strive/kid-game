import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { outlineTxt, rr, star, txt } from '@/core/draw'

/**
 * 音高爬梯（对齐 dongdongpark 真实规则）：
 * 先用嗓子稳定唱一个音定 do（归一到 MIDI [55,66)），再沿 8 级梯子从低到高逐级唱准
 * （re→高音 do，共 7 级）；在容差内保持 0.5s 算唱准、小人上一级；
 * 超过 help+8s 宽限后"小鸟代爬"（0 分）；最高音（12 半音）唱准才 +1 颗星；
 * hard 第 2 条梯起换成随机大跳音程（|音级差| ≥ 2）。
 *
 * 【音高输入等价代理】站点由引擎语音检测提供 e.pitch（MIDI 浮点）；本项目没有麦克风
 * 音高输入，改用"手部高度变化近似唱声"：抬手高度（肩中点到高手的竖距 ×span）线性映射成
 * 半音值，手停在舒服高度 = 稳定唱音。所有判定/校准/八度归一逻辑照抄报告，只是输入源不同。
 */

/** 难度表 h：判定容差(半音) / 参考音重播间隔(s) / 宽松宽限(s) / 跳音旋律 */
const DIFF = [
  { tol: 0.8, replay: 4.5, help: 10, jumps: false },
  { tol: 0.6, replay: 5, help: 12, jumps: false },
  { tol: 0.45, replay: 5.5, help: 14, jumps: true },
]
const OE = 0.5 // 判定保持时长：容差内须累计保持 0.5s
const SE = 0.8 // 参考音播放后的静音窗（s），期间不采集玩家音高
const G = 0.5 // 校准滑动中值窗（s）
const OUTLIER = 0.75 // 校准离群阈值（半音）：偏离中值 >0.75 视为杂音重置计时
const V = 7 // 校准阶段闲置提示间隔：7s 无声播 MIDI 60 邀请
const Y = 1.3 // found 态到第一级提示的停顿（s）
const B = 0.9 // 每唱准一级后到下一级提示的停顿（s）
const X = 0.45 // 目标横条移动动画时长（s）
const S = 0.6 // 目标跳变 >2 半音时的移动动画时长（s）
const CE = 1.3 // 摘星庆祝后目标条降回 do 的延时（s）
const LE = 0.7 // 降回 do 的动画时长（s）
const C = 2.9 // 摘星庆祝总时长（s），之后开新梯
const UE = 8 // help 之后额外等待：超 help+8s 未唱准则"小鸟代爬"
const DE = 2.4 // 音高轨迹显示窗（s）
const FE = 130 // 轨迹向右滚动速度（px ×unit /s）
const W = [0, 2, 4, 5, 7, 9, 11, 12] // do–高do 半音偏移表（大调八度）
const SOLFA = ['do', 're', 'mi', 'fa', 'sol', 'la', 'si', 'do'] // 唱名
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
/** 星级门槛（catalog：easy 6/12/18、medium 6/12/18、hard 6/11/16 级）——引擎层星级用 */
const STARS = [
  [6, 12, 18],
  [6, 12, 18],
  [6, 11, 16],
]
void STARS

/** 手部高度 → 半音值的映射系数：抬手从肩到位约 0.75×span 覆盖一个八度 */
const SEMI_PER_SPAN = 16
const K0 = 60 // 代理音高基准（手与肩同高 = MIDI 60）

/** 唱声代理：取更高的那只手，pitch = K0 + (肩中y − 手y)/span × SEMI_PER_SPAN；手在胸口以上算"出声" */
function voiceOf(b: Body) {
  const span = Math.max(0.1, b.scale)
  const handY = Math.min(b.lHand.y, b.rHand.y)
  const pitch = K0 + ((b.shoulderC.y - handY) / span) * SEMI_PER_SPAN
  const active = handY < b.shoulderC.y + 0.2 * span
  return { pitch, active }
}

function noteName(m: number) {
  const n = Math.round(m)
  return `${NOTE_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`
}

/** 跳音序列生成（hard 第 2 条梯起）：随机游走 6 音（|索引差| ≥ 2 且 ≠ 上一索引），结尾固定补 12 */
function makeSeq(jumps: boolean, salt: number): number[] {
  if (!jumps) return W.slice(1)
  const rnd = (n: number) => {
    const x = Math.sin(n * 127.1 + 311.7) * 43758.5453
    return x - Math.floor(x)
  }
  const seq: number[] = []
  let cur = 0 // w 索引 0 = do
  let prev = -1
  for (let i = 0; i < 6; i++) {
    const cands: number[] = []
    for (let j = 0; j <= 6; j++) {
      if (j === prev || Math.abs(j - cur) < 2) continue
      cands.push(j)
    }
    const pick = cands[Math.floor(rnd(salt * 31 + i) * cands.length) % cands.length]
    seq.push(W[pick])
    prev = cur
    cur = pick
  }
  seq.push(12)
  return seq
}

/** 校准器：滑动中值窗 + 离群重置 + 稳定 0.5s 定 do */
class Calib {
  samples: { t: number; p: number }[] = []
  firstVoice = -1
  lastOutlier = -1
  /** @returns 稳定进度 0~1（≥1 即可定 do，返回中值） */
  update(t: number, pitch: number, active: boolean): { n: number; median: number } {
    if (active && this.firstVoice < 0) this.firstVoice = t
    if (active) {
      this.samples.push({ t, p: pitch })
      while (this.samples.length && this.samples[0].t < t - G) this.samples.shift()
      const med = this.median()
      if (Math.abs(pitch - med) > OUTLIER) this.lastOutlier = t
    }
    const anchor = Math.max(this.firstVoice, this.lastOutlier)
    const n = anchor < 0 ? 0 : Math.max(0, Math.min(1, (t - anchor) / OE))
    return { n, median: this.median() }
  }
  median() {
    if (!this.samples.length) return 0
    const arr = this.samples.map((s) => s.p).sort((a, b) => a - b)
    return arr[Math.floor(arr.length / 2)]
  }
}

type Phase = 'calib' | 'found' | 'prompt' | 'move' | 'star'

const RUNG_COLORS = ['#e76f51', '#f4a261', '#e9c46a', '#8ab17d', '#2a9d8f', '#457b9d', '#5d8fd6', '#9b5de5']

class PitchLadder extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  phase: Phase = 'calib'
  phaseT = 0
  /** do 的 MIDI 值（校准中值）与八度归一偏移（站点 A：归一到 [55,66)） */
  k = 0
  kA = 0
  hasDo = false
  ladder = 0 // 第几条梯（hard 第 2 条起跳音）
  seq: number[] = makeSeq(false, 0)
  I = 0 // 当前级（seq 索引）
  hold = [0, 0] // 容差内累计保持（站点 B）
  xe = [0, 0] // 八度归一（站点 xe）
  promptAt = 0 // 本级提示开始时刻（站点 R）
  lastRef = -9 // 上次参考音时刻（站点 z）
  muteUntil = 0 // 参考音后静音窗
  idleAt = 0 // 校准闲置计时
  ke = 0 // 摘到星星
  devs: number[] = [] // 成功级平均偏差（音分）
  calib = [new Calib(), new Calib()]
  /** 小鸟 y 平滑（τ=0.06s）与音高轨迹（2.4s 窗） */
  birdY = [0, 0]
  birdInit = [false, false]
  trail: { t: number; rel: number; ok: boolean }[][] = [[], []]
  targetAnim = { from: 0, to: 0, t0: -9, dur: X }
  moveAt = 0 // move 态到下一级提示的时刻（站点 H）
  starWon = false

  constructor(ctx: GameContext) {
    super(ctx)
    this.targetAnim.t0 = -9
  }

  tick(f: PoseFrame, dt: number) {
    this.phaseT += dt
    const voices = [0, 1].map((pi) => {
      const b = f.bodies[pi]
      return b ? voiceOf(b) : null
    })

    if (this.phase === 'calib') {
      // 闲置（7s 无有效声且进度 0）播 MIDI 60 邀请
      const anyVoice = voices.some((v) => v?.active)
      if (!anyVoice && this.calib.every((c) => c.firstVoice < 0)) {
        this.idleAt += dt
        if (this.idleAt > V) {
          this.idleAt = 0
          this.ctx.audio.tonePop(((60 - 69) * 12) / 5)
        }
      } else this.idleAt = 0

      for (let pi = 0; pi < 2; pi++) {
        const v = voices[pi]
        if (!v || this.t < 0.3) continue // t < 0.3 不采集（站点）
        const { n, median } = this.calib[pi].update(this.t, v.pitch, v.active && this.t >= this.muteUntil)
        if (n >= 1) {
          this.foundDo(median)
          break
        }
      }
    } else if (this.phase === 'found') {
      if (this.phaseT >= Y) this.startPrompt()
    } else if (this.phase === 'prompt') {
      // 参考音重播：超过 replay 且 B < 0.1
      if (this.t - this.lastRef > this.cfg.replay && Math.max(...this.hold) < 0.1) this.playRef()
      const target = this.seq[this.I] ?? 12
      // 实时容差：前 help 秒 = tol，之后 6s 内线性放宽到 1.5×tol（站点 je）
      const tol = this.cfg.tol * (1 + 0.5 * Math.max(0, Math.min(1, (this.t - this.promptAt - this.cfg.help) / 6)))
      for (let pi = 0; pi < 2; pi++) {
        const v = voices[pi]
        if (!v || this.t < this.muteUntil) continue // 静音窗不采集
        const rel = v.pitch - this.k
        // 八度归一：V 始终落在目标附近 ±7 半音内（允许低/高八度唱）
        if (Math.abs(rel - 12 * this.xe[pi] - target) > 7) this.xe[pi] = Math.round((rel - target) / 12)
        const diff = Math.abs(rel - 12 * this.xe[pi] - target)
        this.pushTrail(pi, rel, diff <= tol)
        if (v.active) {
          if (diff <= tol) this.hold[pi] += dt
          else this.hold[pi] = Math.max(0, this.hold[pi] - 1.5 * dt)
        } else {
          this.hold[pi] = Math.max(0, this.hold[pi] - 0.8 * dt)
        }
      }
      if (Math.max(...this.hold) >= OE) this.stepResult(true)
      else if (this.t - this.promptAt > this.cfg.help + UE) this.stepResult(false) // help+8s → 小鸟代爬
    } else if (this.phase === 'move') {
      if (this.t >= this.moveAt) this.startPrompt()
    } else if (this.phase === 'star') {
      // 1.3s（CE）后目标条降回 do（LE 0.7s）、2.05s 重播 do、2.9s（C）后开新梯
      if (this.phaseT >= CE && this.phaseT - dt < CE) this.targetAnim = { from: this.seq[this.seq.length - 1], to: 0, t0: this.t, dur: LE }
      if (this.phaseT >= 2.05 && this.phaseT - dt < 2.05) this.playRef(true)
      if (this.phaseT >= C) {
        this.ladder++
        this.seq = makeSeq(this.cfg.jumps && this.ladder > 0, this.ladder)
        this.I = 0
        this.hold = [0, 0]
        this.xe = [0, 0]
        this.starWon = false
        this.startPrompt()
      }
    }

    // 小鸟 y 平滑（τ=0.06s）
    for (let pi = 0; pi < 2; pi++) {
      const v = voices[pi]
      if (!v) continue
      const rel = v.pitch - this.k
      const y = this.relToY(rel)
      if (!this.birdInit[pi]) {
        this.birdInit[pi] = true
        this.birdY[pi] = y
      }
      this.birdY[pi] += (y - this.birdY[pi]) * Math.min(1, dt / 0.06)
    }
  }

  private pushTrail(pi: number, rel: number, ok: boolean) {
    this.trail[pi].push({ t: this.t, rel, ok })
    while (this.trail[pi].length && this.trail[pi][0].t < this.t - DE) this.trail[pi].shift()
  }

  /** 相对半音 → 屏幕高度（梯子几何见 paint） */
  private relToY(rel: number) {
    return this.H * 0.82 - (Math.max(-2, Math.min(14, rel)) / 12) * this.H * 0.52
  }

  /** 校准成功：k = 中值，A 归一到 [55,66)（站点 for 循环原样实现） */
  private foundDo(median: number) {
    this.k = median
    let a = 0
    for (; this.k + a < 55; ) a += 12
    for (; this.k + a >= 67; ) a -= 12
    this.kA = a
    this.hasDo = true
    this.phase = 'found'
    this.phaseT = 0
    this.ctx.audio.good()
    this.ctx.speak('这就是 do！')
    this.setStageText(`do = ${noteName(this.k + this.kA)}`)
  }

  private startPrompt() {
    this.phase = 'prompt'
    this.phaseT = 0
    this.promptAt = this.t
    this.hold = [0, 0]
    this.playRef()
  }

  /** 播参考音（站点 note(J(目标))；静音窗 se=0.8s 内不采集） */
  private playRef(doRung = false) {
    const n = doRung ? 0 : (this.seq[this.I] ?? 0)
    const midi = this.k + this.kA + n
    // tonePop(lane) = 440×2^(lane/5)：lane = (midi−69)×12/5 时恰为 MIDI 频率
    this.ctx.audio.tonePop(((midi - 69) * 12) / 5)
    this.lastRef = this.t
    this.muteUntil = this.t + SE
  }

  /** 结算一步（站点 Ie）：成功 I++ 全体 +1；失败小鸟代爬（0 分） */
  private stepResult(success: boolean) {
    const lastTarget = this.seq[this.I] ?? 0
    const b0 = this.players.find((p) => p.body)?.body
    const px = b0 ? b0.shoulderC.x * this.W : this.W / 2
    if (success) {
      // 记录平均偏差（窗内 |V−目标| 时间加权均值 → 音分）：取近期轨迹里踩准段误差均值
      const near = this.trail.flatMap((t2) => t2.filter((s) => s.ok))
      if (near.length) {
        const avg = near.reduce((a, s) => a + Math.abs(s.rel - (this.seq[this.I] ?? 0)), 0) / near.length
        this.devs.push(avg * 100)
      }
      this.ctx.addScore(1) // 全体玩家各 +1（合作制，计 1 级）
      this.ctx.audio.good()
      this.particles.burst(px, this.relToY(lastTarget), '#ffd54a', 10, 300, 4)
      this.I++
      if (this.I >= this.seq.length) {
        // 爬完 7 级：最后一级（12 半音）唱准才 +1 星
        this.phase = 'star'
        this.phaseT = 0
        this.starWon = lastTarget === 12
        if (this.starWon) {
          this.ke++
          this.say('摘到星星啦！', this.W / 2, this.H * 0.24, '#ffd54a', 48)
          this.ctx.audio.win()
          this.particles.confetti(this.W, 40)
          for (let i = 0; i < 14; i++) this.particles.burst(this.W / 2, this.H * 0.3, '#ffe08a', 2, 420, 5)
          this.ctx.speak('摘到星星啦！')
        } else {
          this.say('到顶啦！', this.W / 2, this.H * 0.24, '#8fd3ff', 48)
          this.ctx.audio.good()
        }
      } else {
        // move 态：0.9s（B）后下一级提示；目标条动画时长按跳变幅度（>2 半音 0.6s）
        const from = lastTarget
        const to = this.seq[this.I] ?? 0
        this.targetAnim = { from, to, t0: this.t, dur: Math.abs(to - from) > 2 ? S : X }
        this.phase = 'move'
        this.phaseT = 0
        this.moveAt = this.t + B
        this.say(`${SOLFA[this.rungIndexOf(to)]}`, px, this.relToY(to) - 20, '#fff', 34)
      }
    } else {
      // 小鸟代爬：0 分不扣分，保证推进
      this.ctx.audio.fail()
      this.say('小鸟带你上一级', px, this.relToY(lastTarget) - 20, '#b28dff', 30)
      this.I++
      if (this.I >= this.seq.length) {
        this.phase = 'star'
        this.phaseT = 0
        this.starWon = false
        this.say('到顶啦！', this.W / 2, this.H * 0.24, '#8fd3ff', 44)
      } else {
        const from = lastTarget
        const to = this.seq[this.I] ?? 0
        this.targetAnim = { from, to, t0: this.t, dur: Math.abs(to - from) > 2 ? S : X }
        this.phase = 'move'
        this.phaseT = 0
        this.moveAt = this.t + B
      }
    }
  }

  /** seq 半音值 → w 唱名索引 */
  private rungIndexOf(semi: number) {
    const i = W.indexOf(semi)
    return i < 0 ? 7 : i
  }

  private setStageText(s: string) {
    this.ctx.setStage(s)
  }

  paint(c: CanvasRenderingContext2D) {
    const U = this.H / 720
    const present = this.players.filter((p) => p.body)
    const duo = present.length > 1
    const cx = duo
      ? present.reduce((a, p) => a + p.body!.shoulderC.x * this.W, 0) / present.length
      : (present[0]?.body?.shoulderC.x ?? 0.5) * this.W
    // 梯子几何：8 级横档，do 在底部
    const baseY = this.H * 0.82
    const rungGap = (this.H * 0.52) / 12 // 每 1 半音一档高度（8 级横档铺满 12 半音）
    const ladderW = Math.min(360 * U, duo ? 420 * U : 520 * U)
    const lx = cx - ladderW / 2
    // 侧栏
    c.save()
    rr(c, lx - 46 * U, baseY - 12 * rungGap - 40 * U, ladderW + 92 * U, 12 * rungGap + 80 * U, 24 * U)
    c.fillStyle = 'rgba(16,22,52,.35)'
    c.fill()
    c.restore()

    // 梯子两级纵梁
    c.save()
    c.strokeStyle = 'rgba(255,255,255,.75)'
    c.lineWidth = 7 * U
    c.beginPath()
    c.moveTo(lx, baseY + 8 * U)
    c.lineTo(lx, baseY - 12 * rungGap)
    c.moveTo(lx + ladderW, baseY + 8 * U)
    c.lineTo(lx + ladderW, baseY - 12 * rungGap)
    c.stroke()
    c.restore()

    // 当前目标半音（move 动画中插值；star 期按降回动画）
    let target = this.seq[this.I] ?? 12
    if (this.phase === 'move') {
      const k = Math.max(0, Math.min(1, (this.t - this.targetAnim.t0) / this.targetAnim.dur))
      const e = 1 - (1 - k) * (1 - k) // ease-out
      target = this.targetAnim.from + (this.targetAnim.to - this.targetAnim.from) * e
    } else if (this.phase === 'star') {
      if (this.t >= this.targetAnim.t0) {
        const k = Math.max(0, Math.min(1, (this.t - this.targetAnim.t0) / this.targetAnim.dur))
        target = this.targetAnim.from + (0 - this.targetAnim.from) * (1 - (1 - k) * (1 - k))
      } else target = 12
    } else if (this.phase === 'calib') {
      target = -1
    }
    const barY = baseY - (target / 12) * 12 * rungGap

    // 8 级横档 + 唱名
    for (let i = 0; i < 8; i++) {
      const y = baseY - (W[i] / 12) * 12 * rungGap
      const reached = this.phase !== 'calib' && W[i] <= (this.I >= this.seq.length ? 12 : (this.seq[this.I] ?? 0))
      c.save()
      c.strokeStyle = RUNG_COLORS[i]
      c.lineWidth = 9 * U
      c.lineCap = 'round'
      c.globalAlpha = reached ? 1 : 0.42
      c.beginPath()
      c.moveTo(lx + 6 * U, y)
      c.lineTo(lx + ladderW - 6 * U, y)
      c.stroke()
      if (duo || this.phase !== 'calib') {
        txt(c, SOLFA[i], lx - 22 * U, y, 17 * U, reached ? '#fff' : 'rgba(255,255,255,.5)')
      }
      c.restore()
    }

    // 目标横条（脉动 sin(b×6)）+ 容差进度填充
    if (target >= 0) {
      const pulse = 1 + Math.sin(this.t * 6) * 0.04
      c.save()
      c.translate(cx, barY)
      c.scale(pulse, 1)
      c.fillStyle = 'rgba(255,255,255,.22)'
      rr(c, -ladderW / 2 - 14 * U, -14 * U, ladderW + 28 * U, 28 * U, 14 * U)
      c.fill()
      const tolNow = this.cfg.tol * (1 + 0.5 * Math.max(0, Math.min(1, (this.t - this.promptAt - this.cfg.help) / 6)))
      const bandH = Math.max(8 * U, (tolNow / 12) * 12 * rungGap * 2)
      const prog = Math.max(...this.hold) / OE
      if (prog > 0 && this.phase === 'prompt') {
        c.fillStyle = '#3ddc97'
        rr(c, (-ladderW / 2 - 14 * U) * prog, -bandH / 2, (ladderW + 28 * U) * prog, bandH, bandH / 2)
        c.fill()
      }
      c.restore()
      if (this.phase === 'prompt') {
        txt(c, `${SOLFA[this.rungIndexOf(this.seq[this.I] ?? 12)]}`, cx, barY - 30 * U, 26 * U, '#ffe08a')
      }
    }

    // 音高轨迹（小鸟尾迹：2.4s 窗、向右滚动 FE px/s；踩准段染目标色、偏离段灰色）
    for (let pi = 0; pi < 2; pi++) {
      const tr = this.trail[pi]
      if (tr.length < 2) continue
      const bx = cx + (duo ? (pi === 0 ? -46 * U : 46 * U) : 0)
      c.save()
      c.lineWidth = 4 * U
      c.lineCap = 'round'
      for (let i = 1; i < tr.length; i++) {
        const a = tr[i - 1]
        const z = tr[i]
        const age0 = this.t - a.t
        const age1 = this.t - z.t
        c.strokeStyle = z.ok ? '#3ddc97' : 'rgba(160,160,180,.7)'
        c.beginPath()
        c.moveTo(bx - age0 * FE * U, baseY - (Math.max(-2, Math.min(14, a.rel)) / 12) * 12 * rungGap)
        c.lineTo(bx - age1 * FE * U, baseY - (Math.max(-2, Math.min(14, z.rel)) / 12) * 12 * rungGap)
        c.stroke()
      }
      c.restore()
    }

    // 小鸟（随音高上下移动，扑翼）
    for (let pi = 0; pi < 2; pi++) {
      if (!this.players[pi].body || !this.birdInit[pi]) continue
      const bx = cx + (duo ? (pi === 0 ? -46 * U : 46 * U) : 0)
      const by = this.birdY[pi]
      const flap = Math.sin(this.t * 14) * 6 * U
      c.save()
      c.translate(bx, by)
      c.fillStyle = pi === 0 ? '#ffd166' : '#7dd3fc'
      c.beginPath()
      c.ellipse(0, 0, 15 * U, 12 * U, 0, 0, Math.PI * 2)
      c.fill()
      c.beginPath()
      c.moveTo(-4 * U, -6 * U)
      c.lineTo(-18 * U, -12 * U - flap)
      c.lineTo(-2 * U, 2 * U)
      c.closePath()
      c.fill()
      circleFill(c, 6 * U, -3 * U, 2.2 * U, '#222')
      c.restore()
    }

    // 状态大字
    if (this.phase === 'calib') {
      outlineTxt(c, '长按一只手在舒服的高度——这就是你的 do', this.W / 2, this.H * 0.12, 34, '#8fd3ff')
      const n = Math.max(...this.calib.map((cl) => {
        const anchor = Math.max(cl.firstVoice, cl.lastOutlier)
        return anchor < 0 ? 0 : Math.min(1, (this.t - anchor) / OE)
      }))
      if (n > 0) {
        rr(c, this.W / 2 - 120 * U, this.H * 0.16, 240 * U, 14 * U, 7 * U)
        c.fillStyle = 'rgba(255,255,255,.2)'
        c.fill()
        c.fillStyle = '#3ddc97'
        rr(c, this.W / 2 - 120 * U, this.H * 0.16, 240 * U * n, 14 * U, 7 * U)
        c.fill()
      }
    } else if (this.phase === 'found') {
      outlineTxt(c, `do = ${noteName(this.k + this.kA)} 就是这个音，保持住！`, this.W / 2, this.H * 0.12, 34, '#ffe08a')
    } else if (this.phase === 'prompt') {
      outlineTxt(c, `唱准 ${SOLFA[this.rungIndexOf(this.seq[this.I] ?? 12)]}！`, this.W / 2, this.H * 0.12, 38, '#fff')
    } else if (this.phase === 'star' && this.starWon) {
      star(c, this.W / 2, this.H * 0.18, 44 * U, '#ffd54a')
    }

    // 底部信息
    if (this.hasDo) txt(c, `do = ${noteName(this.k + this.kA)}　梯子 ${this.ladder + 1}`, this.W / 2, this.H - 56 * U, 20 * U, 'rgba(255,255,255,.8)')
    txt(c, '抬手当音高：先定 do，再逐级唱准；低八度高八度都算对', this.W / 2, this.H - 28, 20, 'rgba(255,255,255,.8)', 'center', 'bold')

    // 结算统计
    this.ctx.setCombo(this.I)
    this.ctx.setExtra('摘到星星', this.ke)
    if (this.devs.length) {
      this.ctx.setExtra('平均偏差', Math.round(this.devs.reduce((a, d) => a + d, 0) / this.devs.length))
    }
  }
}

/** 局部小圆（鸟眼等细节） */
function circleFill(c: CanvasRenderingContext2D, x: number, y: number, r: number, color: string) {
  c.beginPath()
  c.arc(x, y, r, 0, Math.PI * 2)
  c.fillStyle = color
  c.fill()
}

export default function create(ctx: GameContext) {
  return new PitchLadder(ctx)
}
