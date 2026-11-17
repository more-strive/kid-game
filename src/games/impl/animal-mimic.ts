import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, emoji, glow, outlineTxt, ring, star, txt } from '@/core/draw'

/**
 * 动物模仿秀（对齐逆向报告 animal-mimic.md）：
 * 小喇叭喊动物，限时做出该动物的标志性动作；做对动物跑出来排队 +1 分，
 * 超时记「没学出来」并更快进入下一题；60s 时长由外层驱动，无限循环出题。
 */

/** 难度表（报告 §1）：window 作答时限 / gap 间隔(答错 ×0.6) / swings 大象甩鼻次数 / bearHits 小熊摇摆次数 / hold 长颈鹿保持 / squat 乌龟深度 / flap 小鸟频率 */
const DIFF = [
  { window: 6, gap: 1.4, swings: 2, bearHits: 3, hold: 0.6, squat: 0.4, flap: 1.2 },
  { window: 5, gap: 1.2, swings: 3, bearHits: 4, hold: 1, squat: 0.5, flap: 1.5 },
  { window: 4.5, gap: 1, swings: 4, bearHits: 4, hold: 1.2, squat: 0.55, flap: 1.8 },
]

/** 动物清单（黑盒 sprites 元数据顺序按 AI case 推断为 6 种，报告 §8） */
const ANIMALS = [
  { id: 'rabbit', name: '小兔子', hint: '跳一跳', emoji: '🐰' },
  { id: 'elephant', name: '大象', hint: '一只手当鼻子甩一甩', emoji: '🐘' },
  { id: 'bird', name: '小鸟', hint: '扇扇翅膀', emoji: '🐦' },
  { id: 'bear', name: '小熊', hint: '左右摇摆走', emoji: '🐻' },
  { id: 'giraffe', name: '长颈鹿', hint: '双手举高高', emoji: '🦒' },
  { id: 'turtle', name: '乌龟', hint: '蹲下缩起来', emoji: '🐢' },
]

const FIRST_DELAY = 0.8 // 开局首只动物延迟（报告 L131）
const ANNOUNCE_GRACE = 0.5 // 宣布后 0.5s 才开始判动作（报告 L217）
const AWAY_RESET = 0.6 // 大象：手离开鼻子区 > 0.6s 进度清零（报告 L168）
const ELE_ARM = 0.15 // 甩到位的归一化距离（报告 L166）
const ELE_VX = 0.5 // 找方向的水平速度门槛（报告 L165）
const ELE_BACK = -0.5 // 收回速度阈值（报告 L167）
const LEAN_THR = 0.3 // 小熊倾倒阈值（报告 L45）

/** 每玩家的运动判定状态（跨帧累积） */
interface Motion {
  prevHandY: [number | null, number | null]
  prevDySign: [number, number]
  /** 扇翅方向反转时间戳（最近 1.2s 窗口） */
  flapMarks: number[]
  /** 本帧是否出现大幅上挥（框架 events('flap') 的代理，事件可降 0.5 频率门槛） */
  flapEvt: boolean
  giraffeHold: number
  bearNeed: number // 0=未定向，±1=上一侧
  bearHits: number
  ele: {
    awayT: number
    dir: number // 0=未定向
    anchor: number
    armed: boolean
    swings: number
    prevX: number | null
    prevT: number
  }
}

function newMotion(): Motion {
  return {
    prevHandY: [null, null],
    prevDySign: [0, 0],
    flapMarks: [],
    flapEvt: false,
    giraffeHold: 0,
    bearNeed: 0,
    bearHits: 0,
    ele: { awayT: 0, dir: 0, anchor: 0, armed: false, swings: 0, prevX: null, prevT: 0 },
  }
}

/** 乌龟下蹲深度代理（框架无 motion.squat：用膝-髋竖直距/躯干比折算，站直≈0、深蹲≈1） */
function squatMetric(b: Body) {
  if (b.squat) return 1
  const s = Math.max(0.05, b.scale)
  const ratio = ((b.lKnee.y - b.lHip.y) / s + (b.rKnee.y - b.rHip.y) / s) / 2
  return Math.max(0, Math.min(1, 1 - ratio / 0.7))
}

/** 长颈鹿手臂抬起度代理（框架无 motion.armLift：双手相对头顶的高度均值） */
function armLift(b: Body) {
  const s = Math.max(0.05, b.scale)
  const lift = ((b.head.y - b.lHand.y) / s + (b.head.y - b.rHand.y) / s) / 2
  return Math.max(0, Math.min(1, lift))
}

/** 小熊左右倾倒代理（框架无 motion.lean：肩心相对髋心的水平偏移/躯干比） */
function leanOf(b: Body) {
  const s = Math.max(0.05, b.scale)
  return (b.shoulderC.x - b.hipC.x) / s
}

/** 动物模仿秀 */
class AnimalMimic extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  unit = this.H / 720
  /** 当前题目（null = 间隔倒计时中） */
  cur: number | null = null
  activeT = 0
  /** 出题倒计时 */
  nextT = FIRST_DELAY
  nextGap = 1
  lastIndex = -1
  /** 每玩家学会只数 */
  learned = [0, 0]
  /** 全场超时次数（共享计数，报告 §6） */
  missed = 0
  score = 0
  bannerT = 0
  bannerText = ''
  bannerSub = ''
  motion: Motion[] = [newMotion(), newMotion()]
  /** 每玩家学会的动物队列（动物索引 + 入场时刻，学会时刻入场小跳 1.5s 衰减） */
  queue: { idx: number; at: number }[][] = [[], []]

  constructor(ctx: GameContext) {
    super(ctx)
    this.nextGap = this.cfg.gap
  }

  tick(_f: PoseFrame, dt: number) {
    this.bannerT = Math.max(0, this.bannerT - dt)

    if (this.cur === null) {
      // 间隔倒计时 → 出题
      this.nextT -= dt
      if (this.nextT <= 0) this.ask()
      return
    }

    this.activeT += dt
    const an = ANIMALS[this.cur]

    // 超时：D++、蓝横幅、boop、间隔 ×0.6（报告 L230）
    if (this.activeT >= this.cfg.window) {
      this.missed++
      this.bannerT = 1.0
      this.bannerText = '再试试别的！'
      this.bannerSub = ''
      this.ctx.audio.fail()
      this.nextT = this.cfg.gap * 0.6
      this.cur = null
      this.activeT = 0
      this.ctx.setExtra('没学出来', this.missed)
      return
    }

    // 宣布后 0.5s 起每帧按玩家顺序检查，第一个达成得分（报告 L217-224）
    if (this.activeT < ANNOUNCE_GRACE) return
    for (const pv of this.players) {
      const b = pv.body
      if (!b) continue
      this.updateMotion(pv.id, b, dt)
      if (this.check(an.id, pv.id, b, dt)) {
        // 达成 j()：+1 分、tada、14 星粒子、动物排队（报告 §2）
        this.learned[pv.id]++
        this.score++
        this.queue[pv.id].push({ idx: this.cur ?? 0, at: this.t })
        this.ctx.audio.win()
        const hx = b.head.x * this.W
        const hy = b.head.y * this.H
        this.particles.burst(hx, hy, '#ffd54a', 14, 380 * this.unit, 6)
        const duo = this.players.filter((p) => p.body).length > 1
        this.say(duo ? `${an.name} 学会啦！` : '学会啦！', hx, Math.max(90, hy - 80), '#ffd54a', 34)
        this.ctx.setScore(this.score)
        this.ctx.setExtra('学会', this.learned[0] + this.learned[1])
        // 下一题：整 gap
        this.nextT = this.cfg.gap
        this.cur = null
        this.activeT = 0
        return
      }
    }
  }

  /** 出题：随机动物，与上一只相同则顺移 +1+floor(rng*(len-1)) 位（报告 L136-137） */
  private ask() {
    let idx = Math.floor(Math.random() * ANIMALS.length)
    if (idx === this.lastIndex) idx = (idx + 1 + Math.floor(Math.random() * (ANIMALS.length - 1))) % ANIMALS.length
    this.lastIndex = idx
    this.cur = idx
    this.activeT = 0
    const an = ANIMALS[idx]
    // 小喇叭宣布：banner + sub + TTS + sfx appear（→ pop 兜底）
    this.bannerT = 1.6
    this.bannerText = `学${an.name}！`
    this.bannerSub = an.hint
    this.ctx.audio.pop()
    this.ctx.speak(`学${an.name}，${an.hint}`)
    this.ctx.setStage(`${an.name}：${an.hint}`)
    // 重置动作进度状态
    for (let i = 0; i < 2; i++) {
      this.motion[i].giraffeHold = 0
      this.motion[i].bearHits = 0
      this.motion[i].bearNeed = 0
      this.motion[i].ele = { awayT: 0, dir: 0, anchor: 0, armed: false, swings: 0, prevX: null, prevT: 0 }
    }
  }

  /** 更新跨帧运动特征（扇翅反转标记 / 大象甩鼻状态机） */
  private updateMotion(pi: number, b: Body, dt: number) {
    const m = this.motion[pi]
    const hands = [b.lHand, b.rHand]
    m.flapEvt = false
    // 扇翅：记录双手 y 速度方向反转时刻（每玩家窗口 1.2s）
    for (let hi = 0; hi < 2; hi++) {
      const y = hands[hi].y
      const prev = m.prevHandY[hi]
      if (prev !== null) {
        const dy = y - prev
        const s = Math.sign(dy)
        if (s !== 0 && m.prevDySign[hi] !== 0 && s !== m.prevDySign[hi]) m.flapMarks.push(this.t)
        if (s !== 0) m.prevDySign[hi] = s
        if (Math.abs(dy) > b.scale * 0.12) m.flapEvt = true
      }
      m.prevHandY[hi] = y
    }
    while (m.flapMarks.length && m.flapMarks[0] < this.t - 1.2) m.flapMarks.shift()

    // 大象甩鼻状态机（报告 L165-168）
    const e = m.ele
    const s = Math.max(0.05, b.scale)
    const noseR = Math.max(20 / this.H, s) * 0.55
    const vxT = this.t - e.prevT > 0 ? (b.rHand.x - (e.prevX ?? b.rHand.x)) / Math.max(0.016, dt) : 0
    const nearNose =
      Math.hypot(b.lHand.x - b.head.x, b.lHand.y - b.head.y) < noseR ||
      Math.hypot(b.rHand.x - b.head.x, b.rHand.y - b.head.y) < noseR
    if (nearNose) {
      e.awayT = 0
      const vx = e.prevX !== null ? vxT : 0
      if (e.dir === 0) {
        // 初始找方向
        if (Math.abs(vx) > ELE_VX) {
          e.dir = Math.sign(vx)
          e.anchor = b.rHand.x
        }
      } else if (!e.armed) {
        // 甩到位
        if ((b.rHand.x - e.anchor) * e.dir >= ELE_ARM) e.armed = true
      } else if (vx * e.dir < ELE_BACK) {
        // 收回来 → +1 次并反向
        e.swings++
        e.dir = -e.dir
        e.anchor = b.rHand.x
        e.armed = false
      }
    } else {
      e.awayT += dt
      if (e.awayT > AWAY_RESET) {
        e.swings = 0
        e.dir = 0
        e.armed = false
        e.awayT = 0
      }
    }
    e.prevX = b.rHand.x
    e.prevT = this.t
  }

  /** 判定（报告 §2），返回是否学会 */
  private check(id: string, pi: number, b: Body, dt: number): boolean {
    const m = this.motion[pi]
    switch (id) {
      case 'rabbit':
        // 跳跃事件代理：框架 events('jump') → Body.jumping 上升沿
        return b.jumping
      case 'bird': {
        const win = Math.min(1.2, Math.max(0.2, this.t - (m.flapMarks[0] ?? this.t)))
        const rate = m.flapMarks.length / 2 / win
        return rate >= this.cfg.flap || (m.flapEvt && rate >= this.cfg.flap - 0.5)
      }
      case 'giraffe': {
        if (armLift(b) >= 0.6) m.giraffeHold += dt
        else m.giraffeHold = 0
        return m.giraffeHold >= this.cfg.hold
      }
      case 'turtle':
        return squatMetric(b) >= this.cfg.squat
      case 'bear': {
        const lean = leanOf(b)
        if (lean >= LEAN_THR && m.bearNeed >= 0) {
          m.bearHits++
          m.bearNeed = -1
        } else if (lean <= -LEAN_THR && m.bearNeed <= 0) {
          m.bearHits++
          m.bearNeed = 1
        }
        return m.bearHits >= this.cfg.bearHits
      }
      case 'elephant':
        return m.ele.swings >= this.cfg.swings
      default:
        return false
    }
  }

  /** 头顶进度星比例（报告 §4：ratio = 进度/需求，亮 floor(ratio*3) 颗） */
  private progressOf(id: string, pi: number, b: Body): number {
    const m = this.motion[pi]
    switch (id) {
      case 'rabbit':
        return b.jumping ? 1 : 0
      case 'bird': {
        const win = Math.min(1.2, Math.max(0.2, this.t - (m.flapMarks[0] ?? this.t)))
        return Math.min(1, m.flapMarks.length / 2 / win / this.cfg.flap)
      }
      case 'giraffe':
        return Math.min(1, m.giraffeHold / this.cfg.hold)
      case 'turtle':
        return Math.min(1, squatMetric(b) / this.cfg.squat)
      case 'bear':
        return m.bearHits / this.cfg.bearHits
      case 'elephant':
        return m.ele.swings / this.cfg.swings
      default:
        return 0
    }
  }

  paint(c: CanvasRenderingContext2D) {
    // 横幅：宣布（黄字紫底横排 name：hint）/ 超时（蓝）
    if (this.bannerT > 0) {
      const a = Math.min(1, this.bannerT / 0.3)
      c.save()
      c.globalAlpha = a
      outlineTxt(c, this.bannerText, this.W / 2, this.H * 0.16, 46, '#ffe27a')
      if (this.bannerSub) txt(c, this.bannerSub, this.W / 2, this.H * 0.16 + 42, 22, 'rgba(255,255,255,.9)')
      c.restore()
    }

    const an = this.cur !== null ? ANIMALS[this.cur] : null

    // 倒计时圈：动物头像坐进白盘，剩余弧绿→红 <1.5s（报告 §4）
    const cx = this.W / 2
    const cy = this.H * 0.34
    if (an) {
      const left = Math.max(0, this.cfg.window - this.activeT)
      const pct = left / this.cfg.window
      circle(c, cx, cy, 64, 'rgba(255,255,255,.92)')
      ring(c, cx, cy, 64, pct, left < 1.5 ? '#ff4d4d' : '#3ddc97', 8)
      const bob = Math.sin(this.t * 6) * 4
      emoji(c, an.emoji, cx, cy + bob, 64)
      glow(c, cx, cy, 96, '#ff9f1c', 0.18 + Math.sin(this.t * 4) * 0.06)
      // 做动作时头顶 3 颗进度星
      for (const pv of this.players) {
        const b = pv.body
        if (!b) continue
        const ratio = this.progressOf(an.id, pv.id, b)
        const lit = Math.floor(ratio * 3)
        const hx = b.head.x * this.W
        const hy = b.head.y * this.H - 52
        for (let i = 0; i < 3; i++) {
          star(c, hx - 30 + i * 30, hy + Math.sin(this.t * 5 + i) * 3, 13, i < lit ? '#ffd54a' : 'rgba(255,255,255,.22)')
        }
      }
    } else {
      // 间隔：小喇叭脉动提示下一只快来了
      const pulse = 0.5 + Math.sin(this.t * 5) * 0.4
      c.save()
      c.globalAlpha = 0.5 + pulse * 0.3
      emoji(c, '📣', cx, cy, 56)
      c.restore()
      txt(c, '听好啦……', cx, cy + 64, 22, 'rgba(255,255,255,.7)')
    }

    // 动物排队：按各自学会顺序排网格（每行 10 只），入场时原地小跳 1.5s 衰减（报告 L176-182）
    for (let pi = 0; pi < 2; pi++) {
      const q = this.queue[pi]
      if (!q.length) continue
      const baseX = pi === 0 ? this.W * 0.06 : this.W * 0.56
      const baseY = this.H - 46
      const size = 34 * this.unit
      for (let i = 0; i < q.length; i++) {
        const col = i % 10
        const row = Math.floor(i / 10)
        const x = baseX + col * size * 1.1
        const y = baseY - row * size * 0.8
        // 最近 1.5s 入场的跳一下
        const age = this.t - q[i].at
        const hop = age < 1.5 ? Math.abs(Math.sin(this.t * 8)) * 14 * (1 - age / 1.5) : 0
        emoji(c, ANIMALS[q[i].idx].emoji, x, y - hop, size)
      }
    }

    txt(c, '听喇叭学动物：跳一跳 / 甩鼻子 / 扇翅膀 / 摇一摇 / 举高高 / 蹲下来', this.W / 2, this.H - 14, 15, 'rgba(255,255,255,.55)')
  }
}

export default function create(ctx: GameContext) {
  return new AnimalMimic(ctx)
}
