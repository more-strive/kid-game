import { BaseGame } from '@/core/base'
import type { Game, GameContext, PoseFrame } from '@/core/types'
import { outlineTxt, txt } from '@/core/draw'
import { JackCounter, KneePairCounter, SquatCounter } from './counter-kit'

/**
 * 体能循环（对齐 dongdongpark 真实规则）：
 * 深蹲→开合跳→高抬腿 三站各 20 秒，站序固定；深蹲 +2/其余 +1；
 * 每站 goal 达标横幅「达标！」（不封顶）；换站全部检测器重置。
 */
const STATIONS = [
  { name: '深蹲', weight: 2, tips: '蹲到大腿差不多平' },
  { name: '开合跳', weight: 1, tips: '跳开时双手举过头' },
  { name: '高抬腿', weight: 1, tips: '左右膝轮流抬到胯高' },
]
const STATION_T = 20
const GOALS = [
  [8, 12, 10],
  [12, 18, 14],
  [15, 24, 18],
]
const PAIR_MAX = [1.4, 1.1, 0.85]
const NUM_CN = ['一', '二', '三']

class FitnessCircuit extends BaseGame implements Game {
  goal = GOALS[this.ctx.difficulty] ?? GOALS[1]
  station = 0
  stationT = 0
  score = 0
  counts = [
    [0, 0, 0], // 玩家0 每站计数
    [0, 0, 0], // 玩家1
  ]
  /** 每站检测器（换站重建） */
  kits = [this.mkKits(), this.mkKits()]
  tip = ''
  tipUntil = 0
  tipAt = -9
  bannerText = ''
  bannerT = 0
  private realClock = 0

  private mkKits() {
    const pm = PAIR_MAX[this.ctx.difficulty] ?? 1.1
    return [new SquatCounter(), new JackCounter(), new KneePairCounter(pm)]
  }

  tick(f: PoseFrame, dt: number) {
    this.stationT += dt
    // 换站
    if (this.stationT >= STATION_T && this.station < 2) {
      this.station++
      this.stationT = 0
      this.kits = [this.mkKits(), this.mkKits()]
      const s = STATIONS[this.station]
      this.bannerText = `第${NUM_CN[this.station]}站：${s.name}`
      this.bannerT = 1.8
      this.ctx.audio.play('win', 0.6, 1)
      this.ctx.speak(`${s.name}，开始！`)
      this.ctx.setStage(`${s.name}，开始！`)
    }

    for (let pi = 0; pi < 2; pi++) {
      const b = f.bodies[pi]
      if (!b) continue
      const t = this.t
      const kit = this.kits[pi][this.station]
      let r: { rep: boolean; tip?: string } = { rep: false }
      if (kit instanceof SquatCounter) r = kit.update(b)
      else if (kit instanceof JackCounter) r = kit.update(b, dt)
      else if (kit instanceof KneePairCounter) r = kit.update(b, t)
      if (r.tip && t - this.tipAt > 2.5) {
        this.tipAt = t
        this.tip = r.tip
        this.tipUntil = t + 1.6
        this.ctx.audio.play('click', 0.6, 0.8)
      }
      if (r.rep) {
        const w = STATIONS[this.station].weight
        this.score += w
        this.counts[pi][this.station]++
        const c = this.counts[pi][this.station]
        this.ctx.audio.play('score', 1, 1 + Math.min(0.5, c * 0.02))
        const anchor = this.anchor(pi)
        this.say(`+${w}`, anchor.x, anchor.y, '#fff36b', 30)
        const goal = this.goal[this.station]
        if (c === goal) {
          this.sayText(`${STATIONS[this.station].name}达标！`)
          this.ctx.audio.good()
        } else if (c % 5 === 0) {
          this.ctx.audio.play('score', 0.7, 1.2)
        }
      }
      if (this.tip && t > this.tipUntil) this.tip = ''
    }

    this.ctx.setScore(this.score)
    this.ctx.setExtra('深蹲', this.counts[0][0] + this.counts[1][0])
    this.ctx.setExtra('开合跳', this.counts[0][1] + this.counts[1][1])
    this.ctx.setExtra('高抬腿', this.counts[0][2] + this.counts[1][2])
  }

  private anchor(pi: number) {
    const b = this.players[pi].body
    if (!b) return { x: this.W / 2, y: this.H / 2 }
    const torso = Math.max(0.05, b.scale) * this.H
    return { x: b.shoulderC.x * this.W, y: b.shoulderC.y * this.H + torso * 0.45 }
  }

  private sayText(text: string) {
    this.bannerText = text
    this.bannerT = 1
  }

  update(f: PoseFrame, dt: number) {
    this.realClock += dt
    this.bannerT = Math.max(0, this.bannerT - dt)
    super.update(f, dt)
  }

  paint(c: CanvasRenderingContext2D) {
    // 三站牌
    const bw = 150
    for (let i = 0; i < 3; i++) {
      const x = this.W / 2 + (i - 1) * (bw + 14)
      const active = i === this.station
      const done = i < this.station
      c.save()
      c.globalAlpha = active ? 1 : 0.55
      c.fillStyle = active ? STATION_COLORS[i] : 'rgba(255,255,255,.85)'
      c.beginPath()
      c.roundRect(x - bw / 2, 18, bw, 52, 26)
      c.fill()
      outlineTxt(c, `${STATIONS[i].name}${done ? ' ✓' : ''}`, x, 44, 26, active ? '#0e1a3a' : '#3a4568')
      c.restore()
    }
    // 剩余时间 + 目标
    const remain = Math.ceil(STATION_T * (this.station + 1) - this.t)
    const s = STATIONS[this.station]
    for (let pi = 0; pi < 2; pi++) {
      if (!this.players[pi].body) continue
      const n = this.counts[pi][this.station]
      const anchor = this.anchor(pi)
      outlineTxt(c, String(n), anchor.x, this.H * 0.42, 96, STATION_COLORS[this.station])
      txt(c, `${s.name} · 目标 ${this.goal[this.station]} · 还剩 ${Math.max(0, remain)} 秒`, this.W / 2, this.H * 0.52, 24, 'rgba(255,255,255,.85)', 'center', 'bold')
      if (this.tip) outlineTxt(c, this.tip, anchor.x, anchor.y - 60, 38, '#ff8a8a')
    }
    if (this.bannerT > 0) {
      c.globalAlpha = Math.min(1, this.bannerT / 0.3)
      outlineTxt(c, this.bannerText, this.W / 2, this.H * 0.24, 48, '#ffd54a')
      c.globalAlpha = 1
    }
    txt(c, s.tips, this.W / 2, this.H - 30, 20, 'rgba(255,255,255,.8)', 'center', 'bold')
  }
}

const STATION_COLORS = ['#4d96ff', '#ffa940', '#ff8fb1']

export default function create(ctx: GameContext) {
  return new FitnessCircuit(ctx)
}
