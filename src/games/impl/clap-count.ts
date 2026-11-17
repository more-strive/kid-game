import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, emoji, outlineTxt, ring, rr, txt } from '@/core/draw'

/**
 * 拍拍数一数（对齐 dongdongpark 真实规则）：
 * 草地上跳出几只小动物，数清后拍同样多下手，然后**停住**——判定靠「拍完静默 pause 秒」。
 *
 * 三条关键规则（站点原样保留）：
 * 1. 没有部分分：多一拍、少一拍都算错；拍够 total+5 立刻判负（防乱拍蹭对）。
 * 2. 「拍完停一下」是核心：不是拍够就过，而是停手 pause 秒才判，给儿童自我纠正的余地。
 * 3. easy 有「手口一致」辅助：每拍一下，第 N 只动物跳起并亮数字，把拍手与点数绑定。
 *
 * 与站点的差异：站点有 `events.has('clap')` 的单帧脉冲事件，本框架没有，
 * 这里用「双手间距」做边沿检测（合拢 < 0.34 肩宽 → 拍手，张开 > 0.78 肩宽复位，最小间隔 0.22 秒）。
 */

type Phase = 'gap' | 'in' | 'ask' | 'count' | 'settle' | 'out'

/** 对齐站点难度表 */
const DIFF = [
  { min: 1, max: 4, pause: 1.5, aid: true, add: 0, wait: 9, count: 0.32 },
  { min: 2, max: 6, pause: 1.3, aid: false, add: 0, wait: 9, count: 0.26 },
  { min: 3, max: 8, pause: 1.3, aid: false, add: 0.4, wait: 10, count: 0.25 },
]

const ANIMALS = [
  { ch: '🐤', name: '小鸡' },
  { ch: '🐷', name: '小猪' },
  { ch: '🐰', name: '小兔子' },
  { ch: '🐸', name: '小青蛙' },
  { ch: '🐱', name: '小猫' },
  { ch: '🐑', name: '小羊' },
]

const STAGGER = 0.16 // 同批入场错峰
const CLAP_GAP = 0.22 // 两次拍手的最小间隔（秒）
const CLOSE_K = 0.34 // 合拢阈值（肩宽的倍数）
const OPEN_K = 0.78 // 复位阈值（肩宽的倍数）
const OVER = 5 // 超过 total + 5 直接判负
const EXIT_T = 0.45

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v))
}
function lerp(a: number, b: number, k: number) {
  return a + (b - a) * k
}

interface Animal {
  kind: number
  batch: 0 | 1
  at: number
  dur: number
  fromX: number
  x: number
  /** aid 模式下拍手点亮，或结算报数时的跳跃时刻 */
  popAt: number
}

interface Question {
  idx: number
  kind: number
  total: number
  a: number
  b: number
  startAt: number
  landA: number
  arriveB: number
  openAt: number
  clapFrom: number
  saidB: boolean
  animals: Animal[]
  area: { x0: number; x1: number }
}

interface PState {
  claps: number
  lastClap: number
  near: boolean
  judgedAt: number
  right: boolean
  gaveUp: boolean
  doneAt: number
  /** aid 模式下第几拍点亮了哪只 */
  lit: number
}

class ClapCount extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[0]
  phase: Phase = 'gap'
  phaseAt = 0
  nextAt = 0.6
  q: Question | null = null
  /** 进入逐只报数的时刻 */
  countAt = 0
  qn = 0
  P = 0
  F = 0
  ps: PState[] = []
  /** 玩家 0 的拍手数（HUD 用） */
  private lastKind = -1

  constructor(ctx: GameContext) {
    super(ctx)
    for (let i = 0; i < 2; i++) this.ps.push({ claps: 0, lastClap: 0, near: false, judgedAt: -1, right: false, gaveUp: false, doneAt: -1, lit: 0 })
  }

  // ---------------------------------------------------------------- 出题

  private open() {
    const d = this.cfg
    const n = d.max - d.min + 1
    let total = d.min + Math.floor(Math.random() * n)
    // 防重复：与上一题总数相同就换一个
    if (this.q && total === this.q.total && n > 1) total = d.min + ((total - d.min + 1 + Math.floor(Math.random() * (n - 1))) % n)
    let kind = Math.floor(Math.random() * ANIMALS.length)
    if (kind === this.lastKind) kind = (kind + 1 + Math.floor(Math.random() * (ANIMALS.length - 1))) % ANIMALS.length
    this.lastKind = kind

    // 分批：仅 hard 且总数 ≥ 4
    let b = 0
    if (d.add > 0 && total >= 4 && Math.random() < d.add) b = 1 + Math.floor(Math.random() * Math.min(3, total - 2))
    const a = total - b

    const area = { x0: 40, x1: this.W - 40 }
    const pad = b > 0 ? 0.7 : 0
    const slot = (area.x1 - area.x0) / (total + pad)
    const animals: Animal[] = []
    for (let i = 0; i < total; i++) {
      const isB = i >= a
      const at = isB ? 0 : this.t + i * STAGGER
      const x = area.x0 + (i + 0.5 + (isB ? pad : 0)) * slot
      animals.push({
        kind,
        batch: isB ? 1 : 0,
        at,
        dur: 0.35 + 0.45 * Math.min(1, Math.abs(x - (i % 2 ? area.x1 : area.x0)) / (area.x1 - area.x0)),
        fromX: i % 2 ? area.x1 + 80 : area.x0 - 80,
        x,
        popAt: -1,
      })
    }
    const landA = Math.max(...animals.filter((x) => x.batch === 0).map((x) => x.at + x.dur))
    const arriveB = b > 0 ? landA + 0.9 : 0
    for (const an of animals) if (an.batch === 1) an.at = arriveB + (animals.indexOf(an) - a) * STAGGER
    const lastLand = b > 0 ? Math.max(...animals.map((x) => x.at + x.dur)) : landA
    const openAt = lastLand + 0.1

    this.q = {
      idx: this.qn++,
      kind,
      total,
      a,
      b,
      startAt: this.t,
      landA,
      arriveB,
      openAt,
      clapFrom: b > 0 ? openAt : this.t + 0.5,
      saidB: false,
      animals,
      area,
    }
    for (const p of this.ps) {
      p.claps = 0
      p.lastClap = 0
      p.near = false
      p.judgedAt = -1
      p.right = false
      p.gaveUp = false
      p.doneAt = -1
      p.lit = 0
    }
    this.phase = 'in'
    this.phaseAt = this.t
    this.ctx.audio.play('drop', 0.6, 1.4)
    if (b > 0) this.ctx.speak(`${a}${ANIMALS[kind].name}来啦！`)
    else if (this.qn === 1) this.ctx.speak(`数一数，有几只${ANIMALS[kind].name}？拍几下手！`)
    else this.ctx.speak(`有几只${ANIMALS[kind].name}？`)
  }

  // ---------------------------------------------------------------- 主循环

  tick(f: PoseFrame, _dt: number) {
    const q = this.q
    if (this.phase === 'gap') {
      if (this.t >= this.nextAt) this.open()
      return
    }
    if (!q) return

    // 分批到达提示
    if (q.b > 0 && !q.saidB && this.t >= q.arriveB) {
      q.saidB = true
      this.ctx.speak(`又来了 ${q.b} 只！一共几只？`)
      this.ctx.audio.play('drop', 0.7, 1.2)
    }

    // 拍手计数（入场阶段只要过了 clapFrom 就计数，和站点一致）
    if (this.phase === 'in' || this.phase === 'ask') {
      for (let i = 0; i < 2; i++) {
        const b = f.bodies[i]
        if (!b) continue
        this.countClap(this.ps[i], b, q)
      }
    }

    if (this.phase === 'in' && this.t >= q.openAt) {
      this.phase = 'ask'
      this.phaseAt = this.t
    }

    if (this.phase === 'ask') {
      for (let i = 0; i < 2; i++) {
        const st = this.ps[i]
        const b = f.bodies[i]
        if (!b || st.judgedAt >= 0) continue
        // 判定三条触发条件：静默满 pause / 拍够 total+5 / 一拍没拍等到 wait
        const silent = st.claps > 0 && this.t - st.lastClap >= this.cfg.pause && this.t >= q.openAt
        const over = st.claps >= q.total + OVER
        const giveUp = st.claps === 0 && this.t - q.openAt >= this.cfg.wait
        if (silent || over || giveUp) this.judge(st, i, giveUp)
      }
      if (this.ps.every((p, i) => !f.bodies[i] || p.judgedAt >= 0)) this.startCount()
    }

    if (this.phase === 'count' && this.t >= this.countEnd()) this.phase = 'settle'
    if (this.phase === 'settle' && this.t >= this.settleEnd()) {
      this.phase = 'out'
      this.phaseAt = this.t
      this.ctx.audio.play('drop', 0.5, 0.9)
    }
    if (this.phase === 'out' && this.t >= this.phaseAt + EXIT_T) {
      this.phase = 'gap'
      this.nextAt = this.t + 0.3
    }
  }

  private countClap(st: PState, b: Body, q: Question) {
    if (this.t < q.clapFrom) return
    const sw = Math.max(60, Math.abs(b.lShoulder.x - b.rShoulder.x) * this.W)
    const d = Math.hypot((b.lHand.x - b.rHand.x) * this.W, (b.lHand.y - b.rHand.y) * this.H)
    const near = st.near ? d < OPEN_K * sw : d < CLOSE_K * sw
    if (near && !st.near && this.t - st.lastClap >= CLAP_GAP) {
      st.claps++
      st.lastClap = this.t
      this.ctx.audio.play('score', 0.7, 1 + Math.min(0.6, st.claps * 0.05))
      this.particles.burst(b.lHand.x * this.W, b.lHand.y * this.H, '#ffe066', 6, 180, 4)
      if (this.cfg.aid && st.claps <= q.total) {
        st.lit = st.claps
        const an = q.animals[st.claps - 1]
        if (an) an.popAt = this.t
      }
    }
    st.near = near
  }

  private judge(st: PState, seat: number, gaveUp: boolean) {
    const q = this.q!
    st.judgedAt = this.t
    st.gaveUp = gaveUp
    st.right = !gaveUp && st.claps === q.total
    this.F++
    if (st.right) {
      this.P++
      this.ctx.addScore(1)
      this.ctx.audio.win()
    } else {
      this.ctx.audio.fail()
      const msg = gaveUp ? `一共 ${q.total} 只` : `是 ${q.total} 只`
      if (seat === 0) this.say(msg, this.W / 2, this.H * 0.4, '#ffd43b', 52)
      this.ctx.speak(gaveUp ? `一共 ${q.total} 只${ANIMALS[q.kind].name}，下次拍出来哦` : `是 ${q.total} 只哦`)
    }
    this.ctx.setExtra('答对', this.P)
    this.ctx.setExtra('题数', this.F)
    this.ctx.setExtra('准确率', Math.round((this.P / Math.max(1, this.F)) * 100))
  }

  private startCount() {
    const q = this.q!
    this.phase = 'count'
    this.phaseAt = this.t
    this.countAt = this.t
    const t0 = Math.max(...this.ps.map((p) => p.judgedAt))
    // 逐只报数：第 i 只在 t0 + 0.2 + i × count 跳一下
    q.animals.forEach((an, i) => (an.popAt = t0 + 0.2 + i * this.cfg.count))
    const anyRight = this.ps.some((p) => p.right)
    if (anyRight) {
      this.ctx.audio.play('fanfare', 0.5)
      this.particles.confetti(this.W, 28)
    } else {
      this.ctx.audio.play('miss', 0.8)
    }
  }

  private countEnd() {
    const q = this.q!
    return this.countAt + 0.2 + q.total * this.cfg.count + 0.4
  }

  private settleEnd() {
    return this.countEnd() + (this.ps.some((p) => p.right) ? 1.1 : 0.9)
  }

  // ---------------------------------------------------------------- 绘制

  paint(c: CanvasRenderingContext2D) {
    const q = this.q
    if (!q) return
    const bandH = Math.min(this.H * 0.27, 190)
    const groundY = this.H - bandH * 0.5
    // 草地
    const g = c.createLinearGradient(0, this.H - bandH, 0, this.H)
    g.addColorStop(0, 'rgba(120,212,120,.95)')
    g.addColorStop(1, 'rgba(64,160,92,.97)')
    c.fillStyle = g
    c.fillRect(0, this.H - bandH, this.W, bandH)
    // 草叶
    c.strokeStyle = 'rgba(255,255,255,.22)'
    c.lineWidth = 3
    for (let i = 0; i < 26; i++) {
      const x = (i / 26) * this.W + 12
      c.beginPath()
      c.moveTo(x, this.H - bandH + 6)
      c.quadraticCurveTo(x + 6, this.H - bandH - 14, x + 14, this.H - bandH - 4)
      c.stroke()
    }

    const size = Math.min(118, ((q.area.x1 - q.area.x0) * 0.88) / Math.max(1, q.total + (q.b > 0 ? 0.7 : 0)))
    for (const an of q.animals) this.drawAnimal(c, an, size, groundY)

    // 题目提示条（分批时画加号）
    if (q.b > 0 && this.t < q.arriveB) {
      txt(c, '+', (q.area.x0 + q.area.x1) / 2, groundY - size * 1.1, 56, '#ff922b')
    }

    // 拍手面板
    if (this.phase === 'ask' || this.phase === 'in') {
      const seats = this.ps.filter((_, i) => this.player(i).body).length || 1
      for (let i = 0; i < 2; i++) {
        if (!this.player(i).body) continue
        const w = seats > 1 ? this.W / 2 : this.W
        this.drawPanel(c, i, i * w + w / 2, this.H - 52)
      }
    }

    if (this.phase === 'ask' && this.ps[0].claps === 0 && this.t - q.openAt > 2) {
      outlineTxt(c, '数一数，拍几下手～', this.W / 2, this.H * 0.12, 34, 'rgba(255,255,255,.92)')
    }
  }

  private drawAnimal(c: CanvasRenderingContext2D, an: Animal, size: number, groundY: number) {
    const p = clamp((this.t - an.at) / an.dur, 0, 1)
    if (p <= 0) return
    const ease = 1 - (1 - p) * (1 - p)
    const x = lerp(an.fromX, an.x, ease)
    // 入场抛物线 + 落地后的待机呼吸
    const hop = p < 1 ? Math.abs(Math.sin(p * Math.PI * 2)) * size * 0.32 : 0
    let y = groundY - hop
    let sx = 1
    let sy = 1
    if (p >= 1) {
      const idle = Math.sin(this.t * 2.6 + an.x) * 0.012
      y += -Math.abs(idle) * size
    } else if (this.t - (an.at + an.dur) < 0.18) {
      const k = Math.sin(((this.t - an.at - an.dur + 0.18) / 0.18) * Math.PI)
      sx = 1 + k * 0.16
      sy = 1 - k * 0.16
    }
    // aid 点亮 / 报数跳动
    if (an.popAt >= 0) {
      const d = this.t - an.popAt
      if (d >= 0 && d < 0.55) y -= Math.abs(Math.sin((d / 0.55) * Math.PI)) * size * 0.35
    }
    // 答对：全体一起跳
    if (this.phase === 'count' || this.phase === 'settle') {
      if (this.ps.some((s) => s.right)) y -= Math.abs(Math.sin(this.t * 8 + an.x * 0.01)) * size * 0.2
    }
    c.save()
    c.globalAlpha = this.phase === 'out' ? clamp(1 - (this.t - this.phaseAt) / EXIT_T, 0, 1) : 1
    c.translate(x, y)
    c.scale(sx, sy)
    emoji(c, ANIMALS[an.kind].ch, 0, -size * 0.5, size)
    c.restore()
    c.globalAlpha = 1

    // 序号徽章（aid 已点到，或结算报数）
    const idx = this.q!.animals.indexOf(an) + 1
    const showAid = this.cfg.aid && idx <= this.ps[0].lit
    const showCount = (this.phase === 'count' || this.phase === 'settle') && an.popAt >= 0 && this.t >= an.popAt
    if (showAid || showCount) {
      const bx = x
      const by = groundY - size * 1.02 - (an.popAt >= 0 && this.t - an.popAt < 0.5 ? 26 * (1 - (this.t - an.popAt) / 0.5) : 0)
      circle(c, bx, by, 20, 'rgba(255,212,59,.95)')
      txt(c, String(idx), bx, by + 1, 24, '#4a3200')
    }
  }

  private drawPanel(c: CanvasRenderingContext2D, seat: number, cx: number, cy: number) {
    const st = this.ps[seat]
    const w = 240
    const h = 74
    c.save()
    c.shadowColor = 'rgba(20,24,60,.28)'
    c.shadowBlur = 16
    c.shadowOffsetY = 6
    rr(c, cx - w / 2, cy - h / 2, w, h, h / 2)
    c.fillStyle = 'rgba(255,253,243,.95)'
    c.fill()
    c.restore()
    txt(c, '👏', cx - w / 2 + 40, cy + 2, 34)
    txt(c, st.claps > 0 ? `${st.claps} 下` : '？', cx + 6, cy + 2, 34, '#2f2a44')
    // 距判定的进度环
    const pct = st.claps > 0 ? clamp((this.t - st.lastClap) / this.cfg.pause, 0, 1) : 0
    ring(c, cx + w / 2 - 34, cy, 20, pct, pct >= 1 ? '#3ddc97' : '#ffa94d', 6)
    if (this.ctx.meta.mode === 'versus') txt(c, `P${seat + 1}`, cx - w / 2 + 22, cy - 42, 20, this.player(seat).color)
  }
}

export function createClapCount(ctx: GameContext): Game {
  return new ClapCount(ctx)
}


export default createClapCount
