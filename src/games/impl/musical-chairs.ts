import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, glow, outlineTxt, rr, txt } from '@/core/draw'

/**
 * 抢椅子（对齐 dongdongpark 真实规则）：
 * 音乐起停反应游戏——音乐响着原地踏步绕椅子走，音乐一停快蹲下坐椅子；
 * 音乐还在放时蹲下（大屏 .15s）即判犯规失去本轮资格；双人共享"第一个坐下 +2"；
 * 每赢一轮撤一把椅子、淘汰一只动物，连胜 easy/medium/hard 3/4/5 轮夺冠并重置整套动物。
 *
 * 框架差异（等价代理，数值均照抄报告）：
 * - 站点的 motion.run / stepRate / squat(0~1) 由引擎层给出，这里从 BlazePose 关键点直接计算：
 *   蹲深 = 1 − 踝髋距/(0.45×肩踝距)；踏步 = 左右膝交替抬起步频（滞回）+ 髋横移速度。
 * - 站点内置 MIDI 音序器合成音乐，这里用每拍 tick + 节拍推进近似（BPM/区间/量化拍照抄）。
 * - 站点有 大屏/小屏 双档（小屏 need 下限 .3、反应窗 +0.8、犯规保持 .3s）；
 *   本画布固定 1280×720 大屏，按大屏档实现，小屏常量以注释保留（AE_SMALL/IE_SMALL/CE_SMALL）。
 */

/** 难度表 re：反应窗(秒) / 音乐时长区间(秒) / 停止量化拍 / BPM / 参赛动物数（=连胜轮数） */
const DIFF = [
  { window: 2, music: [3, 6.5], quant: 2, bpm: 108, animals: 3 },
  { window: 1.5, music: [3, 7.5], quant: 1, bpm: 120, animals: 4 },
  { window: 1.1, music: [2.5, 7.5], quant: 0.5, bpm: 132, animals: 5 },
]
const J = 0.45 // 蹲下达标 need 上限 / 防作弊基准（停止瞬间已蹲 → need = max(need, J)）
const SMALL = false // 站点双档开关：小屏（手机）true / 大屏（本画布 1280×720）false
const IE_SMALL = 0.3 // 小屏 need 下限（大屏为 .45，与上限相同 → 大屏 need 恒 .45）
const AE_SMALL = 0.8 // 小屏反应窗加成 window + .8（大屏不加）
const M = 0.25 // "站起"基准：squat < max(.25, base+.1)
const OE = 0.02 // 玩家基线 base 向常态蹲深收敛速率（每秒）
const SE = 1 // 每轮开始后犯规检查的宽限期（秒）
const CE_BIG = 0.15 // 音乐中"蹲着不动"判犯规保持时长：大屏 .15s / 小屏 .3s
const CE_SMALL = 0.3
const UE = 2.2 // 停止踏步多久后语音提醒"继续走哦"（秒）
const STAND_STALL = 1.6 // 蹲着不起提醒（秒）
const DE = 1.8 // 每轮结果展示时长（秒；夺冠轮 3.2）
const DE_CHAMP = 3.2
const FE = 9 // 动物绕圈角速度分母：2π/9 rad/s
const NEED_CAP = 0.45 // 大屏 need = clamp(base+.25, .45, .45)

/** 蹲深 0~1：站姿≈0，深蹲→1（=1 − 踝髋距/(0.45×肩踝距)，下限防抖） */
function squatDepth(b: Body) {
  const shY = (b.lm[11].y + b.lm[12].y) / 2
  const hipY = (b.lm[23].y + b.lm[24].y) / 2
  const ankY = (b.lm[27].y + b.lm[28].y) / 2
  const span = Math.max(0.06, Math.abs(ankY - shY))
  return Math.max(0, Math.min(1, 1 - Math.max(0, ankY - hipY) / (0.45 * span)))
}

/** 踏步检测（站点 run/stepRate 等价代理）：run = 髋中心横移速度（归一化/s）；stepRate = 最近 2s 左右膝交替抬起的步频 */
class StepMeter {
  midX = NaN
  run = 0
  rate = 0
  private up = [false, false] // 膝抬起滞回（参考 counter-kit KneePairCounter 写法）
  private stamps: number[] = []

  update(b: Body, t: number, dt: number) {
    const shY = (b.lm[11].y + b.lm[12].y) / 2
    const hipY = (b.lm[23].y + b.lm[24].y) / 2
    const span = Math.max(0.06, Math.abs(hipY - shY))
    const hipX = (b.lm[23].x + b.lm[24].x) / 2
    if (!Number.isFinite(this.midX)) this.midX = hipX
    const rv = Math.abs(hipX - this.midX) / Math.max(0.016, dt)
    this.midX += (hipX - this.midX) * Math.min(1, dt * 6)
    this.run += (rv - this.run) * Math.min(1, dt * 4)

    let fired = false
    for (const leg of [0, 1] as const) {
      const kneeY = leg === 0 ? b.lm[25].y : b.lm[26].y
      const lift = (hipY - kneeY) / span
      if (!this.up[leg] && lift > 0.22) {
        this.up[leg] = true
        fired = true
      } else if (this.up[leg] && lift < 0.1) {
        this.up[leg] = false
      }
      if (fired && t - (this.stamps[this.stamps.length - 1] ?? -9) >= 0.18) {
        this.stamps.push(t)
      }
    }
    while (this.stamps.length && this.stamps[0] < t - 2) this.stamps.shift()
    this.rate = this.stamps.length / 2
  }
}

type Phase = 'music' | 'grab' | 'result'

interface Animal {
  theta: number
  /** 本轮是否坐进了椅子 */
  seated: boolean
  /** 已被淘汰进观众席 */
  evicted: boolean
  /** 抢椅反应时刻（rand(.3, min(1.3, window×.8)) 秒） */
  react: number
  color: string
}

interface PState {
  phase: Phase
  phaseT: number
  stopBeat: number // 本轮停止拍（Infinity = 音乐不停，拖到时间结束）
  beat: number
  beatTick: number
  base: number // 玩家常态蹲深基线
  squat: number
  stoodUp: boolean // 本轮音乐中站起过（"音乐在放时蹲下可不算"）
  foul: boolean
  foulT: number
  peak: number // grab 期蹲深峰值
  seated: boolean
  seatedAt: number // 反应时长 V（秒）
  judged: boolean
  missReason: string
  champFx: boolean // 本轮是夺冠庆祝（结果期 3.2s）
  chairs: number
  animals: Animal[]
  march: number
  idleWalkT: number
  standStallT: number
  saidWalk: boolean
  saidStand: boolean
  reactMs: number[]
  foulCount: number
  wins: number
  streak: number // 当前连赢（heat：音乐每点加速 8%）
  theta: number // 小孩绕圈角
  musicColor: number
  sitFx: number // 坐垫弹入动画 0→1
}

const ANIMAL_COLORS = ['#ff8fab', '#ffd166', '#8fd3ff', '#b8f2a9', '#d9b8ff']

function newAnimals(n: number): Animal[] {
  return Array.from({ length: n }, (_, i) => ({
    theta: (i / n) * Math.PI * 2,
    seated: false,
    evicted: false,
    react: 0,
    color: ANIMAL_COLORS[i % ANIMAL_COLORS.length],
  }))
}

function newPS(animals: number): PState {
  return {
    phase: 'music',
    phaseT: 0,
    stopBeat: Infinity,
    beat: 0,
    beatTick: -1,
    base: 0.05,
    squat: 0,
    stoodUp: false,
    foul: false,
    foulT: 0,
    peak: 0,
    seated: false,
    seatedAt: 0,
    judged: false,
    missReason: '',
    champFx: false,
    chairs: animals + 1,
    animals: newAnimals(animals),
    march: 0.6,
    idleWalkT: 0,
    standStallT: 0,
    saidWalk: false,
    saidStand: false,
    reactMs: [],
    foulCount: 0,
    wins: 0,
    streak: 0,
    theta: 0,
    musicColor: 0,
    sitFx: 0,
  }
}

class MusicalChairs extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  ps = [newPS(this.cfg.animals), newPS(this.cfg.animals)]
  meter = [new StepMeter(), new StepMeter()]
  /** 双人共享"第一个坐下 +2"（站点 G，每轮重置） */
  firstShared = true
  score = 0
  champs = 0
  /** 旋律音符纸屑（上限 24，停止时冻结变灰） */
  notes: { x: number; y: number; vy: number; rot: number; vr: number; life: number; color: string }[] = []

  tick(f: PoseFrame, dt: number) {
    const duo = f.bodies.length > 1
    for (let pi = 0; pi < 2; pi++) {
      const st = this.ps[pi]
      const b = f.bodies[pi]
      // base 每秒向玩家常态蹲深收敛（站点 oe=.02，越爱蹲的人门槛被逐步抬高）
      st.base += ((st.squat > 0.3 ? st.squat : 0.05) - st.base) * Math.min(1, OE * dt * 8)
      if (!b) continue

      st.squat = squatDepth(b)
      const meter = this.meter[pi]
      meter.update(b, this.t, dt)
      const run = meter.run
      const stepRate = meter.rate
      const stepping = run > 0.2 || stepRate > 0.8 // 站点：run > .2 || stepRate > .8
      const marchTarget = Math.max(0.6, Math.min(1.2, Math.max(run / 0.5, stepRate / 2)))
      st.march += (marchTarget - st.march) * Math.min(1, dt * 5)
      const standing = st.squat < Math.max(M, st.base + 0.1)

      st.phaseT += dt
      const period = 60 / (this.cfg.bpm * (1 + 0.08 * st.streak)) // heat：连赢每点音乐 +8% 速度

      if (st.phase === 'music') {
        // 音乐节拍推进 + 鼓点（站点为 MIDI 音序器 + 鼓点，此处 tick 代理）
        st.beat += dt / period
        const bi = Math.floor(st.beat)
        if (bi !== st.beatTick) {
          st.beatTick = bi
          this.ctx.audio.play('tick', 0.22, bi % 2 === 0 ? 1 : 1.15)
          st.musicColor = Math.floor(bi / 4) % 7 // 每 4 拍换色（7 色循环）
        }

        // 开轮随机停止拍：随机时长 ∈ music 区间换算成拍，向上取整到 quant 拍
        if (st.stopBeat === Infinity && st.phaseT > 0.4) {
          const len = this.cfg.music[0] + Math.random() * (this.cfg.music[1] - this.cfg.music[0])
          st.stopBeat = Math.ceil(len / period / this.cfg.quant) * this.cfg.quant
        }

        // 小孩绕圈走：只在踏步时前进（角速度 2π/9 × march）
        st.theta += ((Math.PI * 2) / FE) * dt * st.march * (stepping ? 1 : 0)

        // 犯规（音乐中蹲着 = 抢跑）：每轮开始 SE=1s 宽限；大屏蹲 > .45 保持 .15s（小屏 .3s）
        if (st.phaseT > SE && !standing && st.squat > 0.45 && !st.foul) {
          st.foulT += dt
          if (st.foulT >= (SMALL ? CE_SMALL : CE_BIG)) {
            st.foul = true
            st.foulCount++
            st.sitFx = 0
            this.ctx.audio.whistle()
            this.say('音乐还没停！', b.shoulderC.x * this.W, (b.shoulderC.y - 0.25) * this.H, '#ff6b6b', 38)
          }
        } else if (standing) {
          st.foulT = Math.max(0, st.foulT - dt)
        }
        if (standing) st.stoodUp = true

        // 停滞提醒（每轮各一次）
        if (standing && !stepping) st.idleWalkT += dt
        else st.idleWalkT = 0
        if (!standing) st.standStallT += dt
        else st.standStallT = 0
        if (st.idleWalkT > UE && !st.saidWalk) {
          st.saidWalk = true
          this.ctx.speak('继续走哦！')
          this.say('继续走哦', b.shoulderC.x * this.W, (b.shoulderC.y - 0.25) * this.H, '#ffd54a', 32)
        }
        if (st.standStallT > STAND_STALL && !st.saidStand) {
          st.saidStand = true
          this.ctx.speak('站起来，踏步走！')
          this.say('站起来，踏步走', b.shoulderC.x * this.W, (b.shoulderC.y - 0.25) * this.H, '#4cc9f0', 32)
        }

        // 旋律音符纸屑（每 0.5 拍一个，上限 24；站点在音箱位喷上抛+旋转）
        if (st.beat % 0.5 < dt / period && this.notes.length < 24) {
          const cx = duo ? this.W * 0.5 : this.W * 0.24
          const cy = duo ? this.H * 0.18 : this.H * 0.36
          const cols = ['#ff3385', '#ffd54a', '#3ddc97', '#3390fc', '#a78bfa']
          this.notes.push({
            x: cx + (Math.random() - 0.5) * 60,
            y: cy,
            vy: -(160 + Math.random() * 120),
            rot: Math.random() * 6,
            vr: (Math.random() - 0.5) * 8,
            life: 1.1,
            color: cols[Math.floor(Math.random() * cols.length)],
          })
        }

        // 到停止拍 → grab（whistle + 横幅；共享 +2 标志每轮重置）
        if (st.beat >= st.stopBeat) {
          st.phase = 'grab'
          st.phaseT = 0
          st.peak = st.squat
          this.firstShared = true
          this.ctx.audio.whistle()
          this.say('音乐停了！坐！', b.shoulderC.x * this.W, (b.shoulderC.y - 0.3) * this.H, '#ff6b6b', 42)
        }
      } else if (st.phase === 'grab') {
        st.peak = Math.max(st.peak, st.squat)
        // need = clamp(base + .25, [.45(大屏) / IE_SMALL .3(小屏)], .45)；
        // 停止瞬间已蹲 ≥ need → need 强制抬到 .45（站点 max(need, J) 防提前蹲好，大屏下与上限重合）
        const need = Math.max(J, Math.max(SMALL ? IE_SMALL : NEED_CAP, st.base + 0.25))
        const winSec = this.cfg.window + (SMALL ? AE_SMALL : 0)
        // 坐下条件全部满足：本轮站起过 + V ≤ window（小屏 +AE_SMALL）+ 当前蹲深 > need
        if (!st.foul && !st.seated && st.stoodUp && st.phaseT <= winSec && st.squat > need) {
          st.seated = true
          st.seatedAt = st.phaseT
          st.sitFx = 0.01
          st.reactMs.push(st.phaseT)
          let gain = 1
          if (duo && this.firstShared) {
            gain = 2 // 双人：本反应窗内第一个坐下者 +2
            this.firstShared = false
            this.say('+2 抢先！', b.shoulderC.x * this.W, (b.shoulderC.y - 0.38) * this.H, '#ffd54a', 40)
          }
          this.score += gain
          this.ctx.audio.good()
          this.ctx.audio.pop()
          this.particles.burst(b.shoulderC.x * this.W, b.hipC.y * this.H, '#ffd54a', 12, 320, 5)
          this.say(`+${gain}`, b.shoulderC.x * this.W, (b.shoulderC.y - 0.1) * this.H, '#fff', 36)
        }
        // 到期未坐下 → missed，按原因提示
        if (!st.seated && st.phaseT > winSec) {
          st.judged = true
          st.missReason = !st.stoodUp ? '要先站起来' : st.peak > st.base + 0.08 ? '蹲低一点' : '慢了一点点'
          this.ctx.audio.fail()
          this.say(st.missReason, b.shoulderC.x * this.W, (b.shoulderC.y - 0.2) * this.H, '#ff9f9f', 34)
        }
        if (st.seated || st.judged || st.foul) {
          st.phase = 'result'
          st.phaseT = 0
        }
      } else {
        // result：夺冠庆祝 3.2s / 普通 1.8s 后开下一轮
        if (st.phaseT >= (st.champFx ? DE_CHAMP : DE)) this.nextRound(pi)
      }

      // 坐垫弹入（outBack 0.3s 近似）
      if (st.sitFx > 0 && st.sitFx < 1) st.sitFx = Math.min(1, st.sitFx + dt / 0.3)

      // 动物绕圈（有独立走/站切换，不因音乐停而停）
      for (const a of st.animals) {
        if (!a.seated && !a.evicted) a.theta += ((Math.PI * 2) / FE) * dt
      }
      // 本轮竞争动物：反应时间到且玩家还没坐下 → 坐最后空椅（玩家赢则轮空）
      const contender = st.animals.find((a) => !a.evicted)
      if (contender && st.phase === 'grab' && !contender.seated && st.phaseT >= contender.react && !st.seated) {
        contender.seated = true
        this.ctx.audio.play('click', 0.5)
      }
    }

    // 音符纸屑
    for (let i = this.notes.length - 1; i >= 0; i--) {
      const n = this.notes[i]
      n.life -= dt
      n.y += n.vy * dt
      n.vy += 260 * dt
      n.rot += n.vr * dt
      if (n.life <= 0) this.notes.splice(i, 1)
    }

    this.ctx.setScore(this.score)
    this.ctx.setCombo(Math.max(...this.ps.map((p) => p.streak)))
    this.ctx.setExtra('冠军', this.champs)
    this.ctx.setExtra('犯规', this.ps.reduce((n, p) => n + p.foulCount, 0))
    const all = this.ps.flatMap((p) => p.reactMs)
    if (all.length) {
      this.ctx.setExtra('最快反应', Math.round(Math.min(...all) * 1000))
      this.ctx.setExtra('平均反应', Math.round((all.reduce((a, c) => a + c, 0) / all.length) * 1000))
    }
  }

  /** result 结束 → 撤椅子 / 淘汰动物 / 夺冠判定 / 开下一轮 */
  private nextRound(pi: number) {
    const st = this.ps[pi]
    // 夺冠庆祝期结束 → 直接开下一轮（奖励已在进入庆祝时结算，防止重复计）
    if (st.champFx) {
      st.champFx = false
      this.resetRound(st)
      return
    }
    const contender = st.animals.find((a) => !a.evicted)
    if (st.seated && !st.foul) {
      st.wins++
      st.streak++
      // 玩家赢 → 竞争动物轮空，移入观众席
      if (contender) contender.evicted = true
      // 撤走一把椅子
      st.chairs = Math.max(2, st.chairs - 1)
      const b = this.players[pi].body
      if (b) this.particles.burst(b.hipC.x * this.W, b.hipC.y * this.H, '#c9b29b', 10, 260, 5)
      // 动物清零 → 夺冠（champs++、彩带、冠军横幅/语音，结果期延长 3.2s）并重置整套动物
      if (st.animals.every((a) => a.evicted)) {
        this.champs++
        st.champFx = true
        this.ctx.audio.win()
        this.particles.confetti(this.W, 40)
        this.say('冠军！', this.W / 2, this.H * 0.3, '#ffd54a', 60)
        this.ctx.speak('冠军！')
        st.animals = newAnimals(this.cfg.animals)
        st.chairs = this.cfg.animals + 1
        st.streak = 0
        this.clearRoundFlags(st)
        st.phaseT = 0
        return
      }
    } else {
      st.streak = 0
      // 输家动物补坐空椅（流程继续）
      if (contender) contender.seated = true
    }
    this.resetRound(st)
  }

  /** 清掉本轮判定标志（保留当前 phase，用于夺冠庆祝过渡） */
  private clearRoundFlags(st: PState) {
    st.stoodUp = false
    st.foul = false
    st.foulT = 0
    st.peak = 0
    st.seated = false
    st.judged = false
    st.saidWalk = false
    st.saidStand = false
    st.sitFx = 0
    st.missReason = ''
  }

  /** 开下一轮：重置回合状态回 music 阶段 */
  private resetRound(st: PState) {
    st.phase = 'music'
    st.phaseT = 0
    st.stopBeat = Infinity
    st.beat = 0
    this.clearRoundFlags(st)
    for (const a of st.animals) a.seated = false
  }

  paint(c: CanvasRenderingContext2D) {
    const present = this.players.filter((p) => p.body)
    const duo = present.length > 1
    const U = this.H / 720
    for (let pi = 0; pi < 2; pi++) {
      const st = this.ps[pi]
      const pv = this.players[pi]
      const b = pv.body
      if (!b) continue
      // 舞台椭圆（站点 X 函数：cy = H − unit×144、ry = unit×396 的等比缩放，rx = min(zone宽×.3, 420unit)）
      const cx = b.hipC.x * this.W
      const cy = this.H - 144 * U
      const rx = Math.min((duo ? this.W * 0.44 : this.W * 0.84) * 0.3, 420 * U)
      const ry = 200 * U
      c.save()
      c.beginPath()
      c.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2)
      c.fillStyle = 'rgba(245,230,200,.5)'
      c.fill()
      c.strokeStyle = 'rgba(255,255,255,.7)'
      c.lineWidth = 4
      c.stroke()
      // 橙色虚线椭圆跑道
      c.setLineDash([10, 12])
      c.strokeStyle = 'rgba(255,150,60,.55)'
      c.lineWidth = 3
      c.beginPath()
      c.ellipse(cx, cy, rx * 0.82, ry * 0.82, 0, 0, Math.PI * 2)
      c.stroke()
      c.restore()

      // 椅子一字横排（站点 Z：cx + (i-(n-1)/2)×gap）
      const gap = Math.min(72 * U, (rx * 1.6) / st.chairs)
      const chairColors = ['#e85d75', '#f4a261', '#5db6e8', '#8ac926', '#b5838d', '#e0aaff']
      const freeIdx = st.chairs - 1 // 最后一把是空椅（动物与玩家竞争位）
      for (let i = 0; i < st.chairs; i++) {
        const x = cx + (i - (st.chairs - 1) / 2) * gap
        const seatY = cy + ry * 0.58
        c.save()
        c.translate(x, seatY)
        const seatedAnimal = i === freeIdx ? st.animals.find((a) => a.seated && !a.evicted) : undefined
        c.fillStyle = seatedAnimal ? '#b08968' : chairColors[i % chairColors.length]
        rr(c, -16 * U, -34 * U, 32 * U, 10 * U, 4)
        c.fill()
        rr(c, -16 * U, -56 * U, 7 * U, 26 * U, 3)
        c.fill()
        rr(c, -14 * U, -24 * U, 5 * U, 24 * U, 2)
        c.fill()
        rr(c, 9 * U, -24 * U, 5 * U, 24 * U, 2)
        c.fill()
        if (i === freeIdx && st.phase === 'grab') {
          c.strokeStyle = '#ffd54a'
          c.lineWidth = 3
          c.setLineDash([5, 5])
          c.strokeRect(-19 * U, -60 * U, 38 * U, 66 * U)
        }
        if (seatedAnimal) {
          circle(c, 0, -46 * U, 13 * U, seatedAnimal.color)
          circle(c, -4 * U, -49 * U, 2 * U, '#222')
          circle(c, 4 * U, -49 * U, 2 * U, '#222')
        }
        c.restore()
      }

      // 绕圈的动物（未淘汰未坐下）
      for (const a of st.animals) {
        if (a.seated || a.evicted) continue
        const ax = cx + Math.cos(a.theta) * rx * 0.82
        const ay = cy + Math.sin(a.theta) * ry * 0.82 - 26 * U
        c.save()
        c.translate(ax, ay)
        circle(c, 0, 0, 15 * U, a.color)
        circle(c, -5 * U, -4 * U, 2.4 * U, '#222')
        circle(c, 5 * U, -4 * U, 2.4 * U, '#222')
        c.restore()
      }

      // 玩家坐垫（坐下时臀部画椅子坐垫，蹲得越深越实 alpha = clamp((squat-.15)/.2)）
      if (st.sitFx > 0 && st.squat > 0.15) {
        const alpha = Math.max(0, Math.min(1, (st.squat - 0.15) / 0.2))
        const pop = 1 + 0.25 * Math.sin(Math.min(1, st.sitFx) * Math.PI)
        c.save()
        c.globalAlpha = alpha
        c.translate(b.hipC.x * this.W, b.hipC.y * this.H + 10 * U)
        c.scale(pop, pop)
        glow(c, 0, 0, 46 * U, pv.color, 0.4)
        c.beginPath()
        c.ellipse(0, 0, 34 * U, 16 * U, 0, 0, Math.PI * 2)
        c.fillStyle = pv.color
        c.fill()
        c.restore()
      }

      // 头顶气泡指示（犯规→哨子/蹲着→站起来/停滞→继续走/抢椅→快坐下）
      if (st.foul) this.bubble(c, b, '📣 犯规啦', '#ff6b6b', U)
      else if (st.phase === 'music' && st.standStallT > 1.2) this.bubble(c, b, '⬆️ 站起来', '#4cc9f0', U)
      else if (st.phase === 'music' && st.idleWalkT > 1.2) this.bubble(c, b, '🚶 继续走', '#ffd54a', U)
      else if (st.phase === 'grab' && !st.seated && st.stoodUp) this.bubble(c, b, '快坐下！', '#ffd54a', U)

      // 反应窗倒计时环
      if (st.phase === 'grab') {
        const pct = Math.max(0, 1 - st.phaseT / this.cfg.window)
        c.save()
        c.globalAlpha = 0.85
        c.beginPath()
        c.arc(b.shoulderC.x * this.W, (b.shoulderC.y - 0.32) * this.H, 24 * U, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * pct)
        c.strokeStyle = pct > 0.4 ? '#3ddc97' : '#ff6b6b'
        c.lineWidth = 6
        c.lineCap = 'round'
        c.stroke()
        c.restore()
      }

      // 阶段副标题
      const label = st.phase === 'music' ? '踏步走～' : st.phase === 'grab' ? '坐！' : st.seated ? '抢到了！' : st.champFx ? '冠军！' : '下一轮…'
      txt(c, label, cx, cy - ry - 16 * U, 22 * U, 'rgba(255,255,255,.85)')
    }

    // 音符纸屑（grab 期冻结变灰的语义：phase 切走后不再生成、余下的继续落）
    for (const n of this.notes) {
      c.save()
      c.globalAlpha = Math.min(1, n.life)
      c.translate(n.x, n.y)
      c.rotate(n.rot)
      c.fillStyle = n.color
      c.font = `900 ${22 * U}px system-ui`
      c.fillText('♪', -8 * U, 8 * U)
      c.restore()
    }

    // 音乐进行中：四边渐变光边随节拍呼吸（alpha .18+(1-R%1)²×.3）
    const st0 = this.ps.find((p) => p.phase === 'music')
    if (st0) {
      const frac = st0.beat % 1
      const alpha = 0.18 + (1 - frac) * (1 - frac) * 0.3
      const cols = ['#ff3385', '#ffd54a', '#3ddc97', '#3390fc', '#a78bfa', '#ff8fab', '#8fd3ff']
      const col = cols[st0.musicColor % cols.length]
      c.save()
      c.globalAlpha = alpha
      const g = c.createLinearGradient(0, 0, 0, 90 * U)
      g.addColorStop(0, col)
      g.addColorStop(1, 'rgba(0,0,0,0)')
      c.fillStyle = g
      c.fillRect(0, 0, this.W, 90 * U)
      c.restore()
    }
    // 停止瞬间红色爆闪（sin(V×22) 快闪 .8s）+ 红/黄边
    const grab0 = this.ps.find((p) => p.phase === 'grab' && p.phaseT < 0.8)
    if (grab0) {
      c.save()
      c.globalAlpha = 0.22 + Math.sin(grab0.phaseT * 22) * 0.12
      c.fillStyle = '#ff4444'
      c.fillRect(0, 0, this.W, this.H)
      c.restore()
    }

    // 顶部大字状态
    if (this.ps.some((p) => p.phase === 'music')) {
      outlineTxt(c, '🎵 踏步走～', this.W / 2, 56 * U, 40, '#ffd54a')
    } else if (this.ps.some((p) => p.phase === 'grab')) {
      outlineTxt(c, '音乐停了！快坐下！', this.W / 2, 56 * U, 44, '#ff6b6b')
    }
    if (this.champs > 0) outlineTxt(c, `冠军 ×${this.champs}`, 120 * U, 56 * U, 30, '#ffe08a')
    txt(c, '音乐响着踏步走；一停就蹲下坐椅子；音乐没停就蹲 = 犯规！', this.W / 2, this.H - 30, 20, 'rgba(255,255,255,.8)', 'center', 'bold')
  }

  private bubble(c: CanvasRenderingContext2D, b: Body, text: string, color: string, U: number) {
    const x = b.shoulderC.x * this.W
    const y = (b.shoulderC.y - 0.42) * this.H
    c.save()
    c.fillStyle = 'rgba(255,255,255,.92)'
    rr(c, x - 54 * U, y - 20 * U, 108 * U, 34 * U, 16 * U)
    c.fill()
    txt(c, text, x, y - 3 * U, 20 * U, color)
    c.restore()
  }
}

export default function create(ctx: GameContext) {
  return new MusicalChairs(ctx)
}
