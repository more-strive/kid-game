import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { emoji, outlineTxt, ring, rr, txt } from '@/core/draw'

/**
 * 天平称一称（对齐 dongdongpark 真实规则）：
 * 两只手臂就是秤杆，手之间横着一根横杆、每只手下方吊一只托盘；题目问"哪边重"，
 * 把重的一侧放低、保持约 1 秒即判定，一样重就端平。
 *
 * 与站点的差异（见 _reverse/reports/balance-scale.md §8）：
 * - 站点用 config.big 决定题型分布，非 big 时算术题概率恒为 0、数数题上限压到 5。
 *   本实现按「儿童模式」（kidMix）实现：只有 pic / count 两种题，无 math。
 * - 站点读 motion 手位做平滑，这里直接用 Body 的双手关键点（已含框架平滑）。
 * - 触屏无摄像头时不做判定，只提示把手伸出来。
 */
type QKind = 'pic' | 'count'

interface Pic {
  ch: string
  w: number
}

/** 站点常识重量表：羽毛 0 < 草莓 1 < 苹果/老鼠 2 < 西瓜/猫 4 < 熊 6 < 象 8 */
const PIC: Pic[] = [
  { ch: '🪶', w: 0 },
  { ch: '🍓', w: 1 },
  { ch: '🍎', w: 2 },
  { ch: '🐭', w: 2 },
  { ch: '🍉', w: 4 },
  { ch: '🐱', w: 4 },
  { ch: '🐻', w: 6 },
  { ch: '🐘', w: 8 },
]
const COUNT_ITEMS = ['🍎', '🍓', '🟦']

/** 对齐站点难度表（kidMix：pic / count 概率；gap 个数差上限；tilt/flat 手高差阈值；hold 保持；read 保护期） */
const DIFF = [
  { mix: [1, 0], gap: 2, countMax: 5, tilt: 0.32, flat: 0.17, hold: 1, read: 1 },
  { mix: [0.75, 0.25], gap: 2, countMax: 5, tilt: 0.35, flat: 0.15, hold: 1, read: 0.9 },
  { mix: [0.5, 0.5], gap: 1, countMax: 5, tilt: 0.35, flat: 0.15, hold: 0.9, read: 0.8 },
]

const P_EQUAL = { pic: 0.15, count: 0.25 } // 两边一样重的出现概率
const LIMIT = 14 // 单题超时（秒）
const REVEAL_OK = 1.4 // 答对停留
const REVEAL_BAD = 2.4 // 答错/超时停留（多留一秒看答案）

interface Side {
  ch: string
  n: number
}

interface Question {
  kind: QKind
  left: Side
  right: Side
  /** -1 左重 / 0 一样重 / 1 右重 */
  answer: -1 | 0 | 1
}

const SIGN: Record<number, string> = { '-1': '>', 0: '=', 1: '<' }
const WORDS: Record<number, string> = { '-1': '左边重', 0: '一样重', 1: '右边重' }
const FIX: Record<number, string> = { '-1': '是左边重哦', 0: '两边一样重哦', 1: '是右边重哦' }

class BalanceScale extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[0]
  q: Question
  phase: 'read' | 'answer' | 'reveal' = 'read'
  timer = 0
  hold = 0
  cand: -1 | 0 | 1 | null = null
  result: 'ok' | 'bad' | 'timeout' | null = null
  correct = 0
  answered = 0
  streak = 0
  best = 0
  rtSum = 0
  private idle = 0
  private hinted = false

  constructor(ctx: GameContext) {
    super(ctx)
    this.q = this.makeQuestion()
    this.timer = 0
  }

  tick(f: PoseFrame, dt: number) {
    const b = f.bodies[0] ?? null
    this.timer += dt

    if (this.phase === 'read') {
      if (this.timer >= this.cfg.read) {
        this.phase = 'answer'
        this.timer = 0
        this.ctx.speak(this.prompt())
      }
      return
    }

    if (this.phase === 'reveal') {
      const wait = this.result === 'ok' ? REVEAL_OK : REVEAL_BAD
      if (this.timer >= wait) this.nextQuestion()
      return
    }

    // 采样期：先看"举秤"姿态，再看手高差
    const ans = this.readPose(b)
    if (ans === null) {
      this.hold = Math.max(0, this.hold - 2 * dt)
      this.idle += dt
      if (this.idle > 4 && !this.hinted) {
        this.hinted = true
        this.ctx.speak('把两只手伸出来，当天平')
      }
      return
    }
    this.idle = 0
    if (ans === this.cand) {
      this.hold += dt
      if (this.hold >= this.cfg.hold) this.resolve(ans)
    } else {
      this.cand = ans
      this.hold = dt
    }
    if (this.timer >= LIMIT) this.resolve(null)
  }

  /** 举秤 + 手高差 → 答案；死区返回 null */
  private readPose(b: Body | null): -1 | 0 | 1 | null {
    if (!b) return null
    const T = Math.max(40, b.scale * this.H * 1.1)
    const ly = b.lHand.y * this.H
    const ry = b.rHand.y * this.H
    const hipY = b.hipC.y * this.H
    const raised = Math.min(ly, ry) < hipY - 0.45 * T // 双手抬到髋上 0.45T
    const spread = Math.abs(b.lHand.x - b.rHand.x) * this.W > 0.6 * T // 双手张开 0.6T
    if (!raised || !spread) return null
    const s = (ry - ly) / T // 正 = 右手更低（右盘更重）
    if (s > this.cfg.tilt) return 1
    if (s < -this.cfg.tilt) return -1
    if (Math.abs(s) < this.cfg.flat) return 0
    return null
  }

  private resolve(ans: -1 | 0 | 1 | null) {
    this.phase = 'reveal'
    this.timer = 0
    this.answered++
    this.rtSum += Math.min(this.timer, LIMIT)
    const ok = ans === this.q.answer
    if (ok) {
      this.result = 'ok'
      this.correct++
      this.streak++
      this.best = Math.max(this.best, this.streak)
      this.ctx.addScore(1)
      this.ctx.setCombo(this.streak)
      this.ctx.setExtra('correct', this.correct)
      this.ctx.setExtra('best', this.best)
      this.ctx.audio.good()
      this.particles.burst(this.W / 2, this.H / 2, '#3ddc97', 14, 380, 5)
      this.say('答对啦 +1', this.W / 2, 200, '#3ddc97', 42)
      if (this.streak === 3 || this.streak === 6 || this.streak === 10) {
        this.ctx.speak(this.streak < 6 ? '连对三题，真棒' : '太厉害了')
      }
    } else {
      this.result = ans === null ? 'timeout' : 'bad'
      this.streak = 0
      this.ctx.setCombo(0)
      this.ctx.audio.fail()
      this.say(ans === null ? '时间到' : '再想想', this.W / 2, 200, '#c9a6ff', 40)
      this.ctx.speak(FIX[this.q.answer])
    }
  }

  private nextQuestion() {
    this.q = this.makeQuestion()
    this.phase = 'read'
    this.timer = 0
    this.hold = 0
    this.cand = null
    this.result = null
  }

  private prompt() {
    return this.q.kind === 'pic' ? '哪边更重？重的那边手放低' : '数一数，哪边更多？'
  }

  /** 出题（对齐站点：pic 保证重量差 ≥2；count 保证个数差 1~gap） */
  private makeQuestion(): Question {
    const [pPic] = this.cfg.mix
    const kind: QKind = Math.random() < pPic ? 'pic' : 'count'
    const equal = Math.random() < P_EQUAL[kind]
    const max = this.cfg.countMax
    let left: Side
    let right: Side
    if (kind === 'pic') {
      const a = PIC[Math.floor(Math.random() * PIC.length)]
      let bItem = a
      if (!equal) {
        const pool = PIC.filter((p) => Math.abs(p.w - a.w) >= 2)
        bItem = pool[Math.floor(Math.random() * pool.length)] ?? a
      }
      const swap = Math.random() < 0.5 // 避免正确答案总在同一侧
      left = { ch: swap ? bItem.ch : a.ch, n: 1 }
      right = { ch: swap ? a.ch : bItem.ch, n: 1 }
      const lw = PIC.find((p) => p.ch === left.ch)?.w ?? 0
      const rw = PIC.find((p) => p.ch === right.ch)?.w ?? 0
      return { kind, left, right, answer: lw > rw ? -1 : lw < rw ? 1 : 0 }
    }
    const ch = COUNT_ITEMS[Math.floor(Math.random() * COUNT_ITEMS.length)]
    const ln = 1 + Math.floor(Math.random() * max)
    let diff = 1 + Math.floor(Math.random() * this.cfg.gap)
    if (Math.random() < 0.5) diff = -diff
    if (ln + diff < 1 || ln + diff > max) diff = -diff
    const rn = Math.max(1, Math.min(max, ln + diff))
    left = { ch, n: ln }
    right = { ch, n: equal ? ln : rn }
    const answer: -1 | 0 | 1 = equal ? 0 : left.n > right.n ? -1 : 1
    return { kind, left, right, answer }
  }

  /** 秤杆两端：手位（画不出人时给个默认摆放，方便看题） */
  private ends(b: Body | null) {
    const mid = this.W / 2
    const y = this.H * 0.46
    if (!b) return { lx: mid - 190, ly: y, rx: mid + 190, ry: y }
    return {
      lx: b.lHand.x * this.W,
      ly: b.lHand.y * this.H,
      rx: b.rHand.x * this.W,
      ry: b.rHand.y * this.H,
    }
  }

  paint(c: CanvasRenderingContext2D) {
    const b = this.bodies()[0] ?? null
    const e = this.ends(b)
    const mx = (e.lx + e.rx) / 2
    const my = (e.ly + e.ry) / 2
    const revealed = this.phase === 'reveal' ? this.q.answer : null
    const shown = revealed ?? this.cand

    // 秤杆
    c.save()
    c.lineCap = 'round'
    c.strokeStyle = '#ffd54a'
    c.lineWidth = 8
    c.beginPath()
    c.moveTo(e.lx, e.ly)
    c.lineTo(e.rx, e.ry)
    c.stroke()
    c.restore()

    // 两端托盘 + 物品
    for (const side of [0, 1] as const) {
      const x = side === 0 ? e.lx : e.rx
      const y = side === 0 ? e.ly : e.ry
      const s = side === 0 ? this.q.left : this.q.right
      c.strokeStyle = 'rgba(255,255,255,.55)'
      c.lineWidth = 2
      c.beginPath()
      c.moveTo(x, y)
      c.lineTo(x, y + 34)
      c.stroke()
      rr(c, x - 34, y + 34, 68, 12, 6)
      c.fillStyle = 'rgba(255,255,255,.85)'
      c.fill()
      this.paintItems(c, s, x, y + 10)
    }

    // 中央读数徽章
    const badgeR = 34
    const color =
      this.phase === 'reveal'
        ? this.result === 'ok'
          ? '#3ddc97'
          : '#7a8bff'
        : this.cand !== null
          ? '#ffd54a'
          : '#ffffff'
    c.beginPath()
    c.arc(mx, my, badgeR, 0, Math.PI * 2)
    c.fillStyle = 'rgba(12,18,42,.72)'
    c.fill()
    c.strokeStyle = color
    c.lineWidth = 4
    c.stroke()
    const symbol = shown === null ? '?' : SIGN[shown]
    outlineTxt(c, symbol, mx, my + 2, 40, color)
    if (this.phase === 'answer' && this.cand !== null) {
      ring(c, mx, my, badgeR + 12, Math.min(1, this.hold / this.cfg.hold), '#3ddc97', 8)
    }
    if (revealed !== null) {
      outlineTxt(c, WORDS[revealed], mx, my + 78, 30, '#ffffffcc')
    }

    // 顶部提示
    const tip =
      this.phase === 'read'
        ? '看题…'
        : this.phase === 'answer'
          ? this.q.kind === 'pic'
            ? '哪边重，那边的手放低'
            : '哪边多，那边的手放低'
          : this.result === 'ok'
            ? '答对啦！'
            : this.q.kind === 'count'
              ? `答案是 ${WORDS[this.q.answer]}`
              : WORDS[this.q.answer]
    outlineTxt(c, tip, this.W / 2, 96, 34, '#fff')
    txt(c, `答对 ${this.correct} 题`, this.W - 40, 48, 22, 'rgba(255,255,255,.85)', 'right', 'bold')
  }

  private paintItems(c: CanvasRenderingContext2D, s: Side, cx: number, cy: number) {
    if (s.n === 1) {
      emoji(c, s.ch, cx, cy + 22, 46)
      return
    }
    const cols = s.n <= 4 ? 2 : 3
    const size = s.n <= 4 ? 26 : 22
    for (let i = 0; i < s.n; i++) {
      const col = i % cols
      const row = Math.floor(i / cols)
      emoji(c, s.ch, cx + (col - (cols - 1) / 2) * (size + 4), cy + 10 + row * (size + 2), size)
    }
  }

  private bodies(): Body[] {
    return this.players.map((p) => p.body).filter((x): x is Body => !!x)
  }
}

export default function create(ctx: GameContext) {
  return new BalanceScale(ctx)
}
