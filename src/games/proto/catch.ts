import { BaseGame } from '@/core/base'
import type { Game, GameContext, PoseFrame } from '@/core/types'
import { circle, glow, outlineTxt, txt } from '@/core/draw'
import { drawItem, preloadItems } from '@/core/sprites'

/**
 * 接物类原型（对齐 dongdongpark 真实规则）：
 * plain  = 接礼物（金礼物 10% +3，手/头 42% 半径命中，落地不扣分）
 * math   = 算一算（泡泡循环下落，答对清场停 1.6s，拍错需举过肩或快拍 +0.22s 驻留）
 * letter = 拼字（按序接字母，每词 3 心，拍错扣心，心尽跳词）
 */
type Shape = 'gift' | 'number' | 'letter' | 'drop' | 'star' | 'coin' | 'fish'

const ITEM_OF: Record<Shape, string> = {
  gift: 'gift',
  drop: 'bubble',
  fish: 'fish',
  star: 'star',
  number: '',
  letter: '',
  coin: '',
}
const ITEM_BY_SLUG: Record<string, string> = {
  'bounce-ball': 'basketball',
  'llama-treat': 'cookie',
  'sea-lion': 'note',
  firefly: 'sparkle',
}

interface Theme {
  shape: Shape
  color: string
  mode: 'plain' | 'math' | 'letter'
  hint: string
}

const THEMES: Record<string, Theme> = {
  'santa-catch': { shape: 'gift', color: '#ff5c8a', mode: 'plain', hint: '接住掉下来的礼物，金色的 +3' },
  'math-catch': { shape: 'number', color: '#4cc9f0', mode: 'math', hint: '接住正确答案的泡泡' },
  'spell-catch': { shape: 'letter', color: '#9b5de5', mode: 'letter', hint: '按顺序接字母，拼出单词' },
  'water-flowers': { shape: 'drop', color: '#4cc9f0', mode: 'plain', hint: '接住水滴浇花' },
  fishing: { shape: 'fish', color: '#ffb703', mode: 'plain', hint: '接住跳上来的小鱼' },
  firefly: { shape: 'star', color: '#ffe066', mode: 'plain', hint: '接住发光的萤火虫' },
  'star-muncher': { shape: 'star', color: '#ffd54a', mode: 'plain', hint: '接住星星' },
  'sea-lion': { shape: 'coin', color: '#ffd54a', mode: 'plain', hint: '接住抛来的圈' },
  'llama-treat': { shape: 'coin', color: '#7bc950', mode: 'plain', hint: '接住零食' },
  'bounce-ball': { shape: 'coin', color: '#ff7a45', mode: 'plain', hint: '拍球' },
}

interface Item {
  x: number
  y: number
  vy: number
  vx: number
  r: number
  label: string
  color: string
  alive: boolean
  correct: boolean
  wob: number
  phase: number
  owner: number
  /** math/letter：拍错驻留计时 */
  dwell: number
  wrong: number
  gold: boolean
}

/** 形近字母干扰表（对齐站点 m 表） */
const LOOKALIKE: Record<string, string> = {
  a: 'oe', b: 'dp', c: 'eo', d: 'bq', e: 'ca', f: 't', g: 'qy', h: 'nk', i: 'lj', j: 'ig',
  k: 'hx', l: 'it', m: 'nw', n: 'mu', o: 'ac', p: 'qb', q: 'pg', r: 'nv', s: 'zc', t: 'fl',
  u: 'vn', v: 'uw', w: 'vm', x: 'kz', y: 'gv', z: 'sx',
}
const WORDS = [
  'CAT', 'DOG', 'SUN', 'BEE', 'FISH', 'MILK', 'BIRD', 'CAKE', 'STAR', 'MOON',
  'TREE', 'BOOK', 'RAIN', 'SNOW', 'DUCK', 'FROG', 'APPLE', 'HOUSE', 'WATER', 'SMILE',
]

/** plain 模式难度表（接礼物）：间隔/上限/速度/尺寸 */
const PLAIN = [
  { every: 1.5, max: 3, speed: 115, size: 96 },
  { every: 1.1, max: 4, speed: 160, size: 84 },
  { every: 0.8, max: 6, speed: 215, size: 72 },
]
/** math 模式难度表：泡泡数/半径/速度 */
const MATH = [
  { answers: 3, r: 72, speed: 45 },
  { answers: 3, r: 64, speed: 58 },
  { answers: 4, r: 58, speed: 70 },
]
/** letter 模式难度表：泡泡数/半径/速度 */
const LETTER = [
  { answers: 2, r: 70, speed: 40 },
  { answers: 3, r: 64, speed: 50 },
  { answers: 4, r: 58, speed: 60 },
]
const WRONG_DWELL = 0.22 // 拍错判定：持续 0.22s 才算（对齐站点）
const WRONG_GUARD_TORSO = 1.5 // 快拍手速门槛（×躯干/s）

class CatchGame extends BaseGame implements Game {
  theme: Theme
  mode: 'plain' | 'math' | 'letter'
  cfg: { answers?: number; r?: number; speed?: number; every?: number; max?: number; size?: number }
  items: Item[] = []
  score = 0
  spawnT = 0.5
  spawnCount = 0
  /** math/letter 共用 */
  pauseT = 0
  correctCount = 0
  sum = { a: 0, b: 0, answer: 0, op: 'add', kind: 'apple' }
  word = ''
  wordIdx = 0
  done = 0
  hearts = 3

  constructor(ctx: GameContext) {
    super(ctx)
    this.theme = THEMES[ctx.meta.slug] ?? { shape: 'star', color: '#ffd54a', mode: 'plain', hint: '接住落下来的东西' }
    this.mode = this.theme.mode
    this.cfg = this.mode === 'plain' ? PLAIN[ctx.difficulty] : this.mode === 'math' ? MATH[ctx.difficulty] : LETTER[ctx.difficulty]
    preloadItems(['gift', 'bubble', 'fish', 'star', 'sparkle'])
    if (this.mode === 'math') this.newQuestion()
    if (this.mode === 'letter') this.newWord()
  }

  private zone(pi: number) {
    if (this.present() <= 1) return { x0: this.W * 0.1, x1: this.W * 0.9 }
    return pi === 0 ? { x0: this.W * 0.03, x1: this.W * 0.47 } : { x0: this.W * 0.53, x1: this.W * 0.97 }
  }

  private present() {
    return this.players.filter((p) => p.body).length
  }

  private newQuestion() {
    const d = this.ctx.difficulty
    const ops = d >= 1 ? ['add', 'sub', 'mul', 'count'] : ['count', 'add']
    this.sum.op = ops[Math.floor(Math.random() * ops.length)]
    let a = 1
    let b = 1
    if (this.sum.op === 'count') {
      a = 1 + Math.floor(Math.random() * (d === 0 ? 5 : d === 1 ? 10 : 15))
      b = a
    } else if (this.sum.op === 'add') {
      const max = d === 0 ? 5 : d === 1 ? 10 : 20
      a = 1 + Math.floor(Math.random() * (max - 2))
      b = 1 + Math.floor(Math.random() * (max - a))
    } else if (this.sum.op === 'sub') {
      a = 2 + Math.floor(Math.random() * (d === 0 ? 4 : d === 1 ? 9 : 15))
      b = 1 + Math.floor(Math.random() * (a - 1))
    } else {
      const m1 = d === 0 ? [1, 2] : d === 1 ? [1, 5] : [2, 9]
      const m2 = d === 0 ? [1, 5] : [2, 9]
      a = m1[0] + Math.floor(Math.random() * (m1[1] - m1[0] + 1))
      b = m2[0] + Math.floor(Math.random() * (m2[1] - m2[0] + 1))
    }
    const answer = this.sum.op === 'add' ? a + b : this.sum.op === 'sub' ? a - b : this.sum.op === 'mul' ? a * b : a
    this.sum = { a, b, answer, op: this.sum.op, kind: ['apple', 'star', 'heart', 'flower'][Math.floor(Math.random() * 4)] }
    this.spawnSet()
  }

  private qText() {
    const { a, b, op } = this.sum
    if (op === 'count') return `有几个？`
    const sym = op === 'add' ? '+' : op === 'sub' ? '−' : '×'
    return `${a} ${sym} ${b} = ?`
  }

  private newWord() {
    this.word = WORDS[Math.floor(Math.random() * WORDS.length)]
    this.wordIdx = this.wordIdx + 1
    this.done = 0
    this.hearts = 3
    this.spawnSet()
  }

  /** 生成一组泡泡/字母（math/letter） */
  private spawnSet() {
    const n = this.cfg.answers ?? 3
    const r = (this.cfg.r ?? 64) * (this.H / 720)
    for (let pi = 0; pi < 2; pi++) {
      const z = this.zone(pi)
      const slotW = (z.x1 - z.x0) / n
      const values = this.mode === 'math' ? this.mathChoices(n) : this.letterChoices(n)
      for (let i = 0; i < n; i++) {
        const label = values[i].label
        this.items.push({
          x: z.x0 + slotW * (i + 0.5) + (Math.random() - 0.5) * slotW * 0.4,
          y: -(60 + i * 90 + Math.random() * 40),
          vy: this.cfg.speed ?? 50,
          vx: 0,
          r: r * (0.95 + Math.random() * 0.1),
          label,
          color: values[i].correct ? this.theme.color : '#ff8fa3',
          alive: true,
          correct: values[i].correct,
          wob: Math.random() * 6.28,
          phase: i * 1.7,
          owner: pi,
          dwell: 0,
          wrong: 0,
          gold: false,
        })
      }
    }
  }

  private mathChoices(n: number) {
    const ans = this.sum.answer
    const offsets = this.sum.op === 'mul' ? [1, -1, this.sum.a, -this.sum.a, 2, -2, this.sum.b, -this.sum.b] : [1, -1, 2, -2, 3, -3, 4]
    const wrongs: number[] = []
    for (const o of offsets) {
      const v = ans + o
      if (v >= (this.sum.op === 'count' ? 1 : 0) && v !== ans && !wrongs.includes(v)) wrongs.push(v)
      if (wrongs.length >= n - 1) break
    }
    let extra = 5
    while (wrongs.length < n - 1) wrongs.push(ans + extra++)
    const list = [{ label: String(ans), correct: true }, ...wrongs.slice(0, n - 1).map((w) => ({ label: String(w), correct: false }))]
    return this.shuffle(list)
  }

  private letterChoices(n: number) {
    const target = this.word[this.done] ?? 'A'
    const rest = this.word.slice(this.done + 1).split('')
    const look = (LOOKALIKE[target.toLowerCase()] ?? '').split('')
    const picks: string[] = []
    for (const src of [rest, look]) {
      for (const ch of src) {
        const up = ch.toUpperCase()
        if (up !== target && !picks.includes(up)) picks.push(up)
        if (picks.length >= n - 1) break
      }
      if (picks.length >= n - 1) break
    }
    const az = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    while (picks.length < n - 1) {
      const ch = az[Math.floor(Math.random() * 26)]
      if (ch !== target && !picks.includes(ch)) picks.push(ch)
    }
    const list = [{ label: target, correct: true }, ...picks.slice(0, n - 1).map((ch) => ({ label: ch, correct: false }))]
    return this.shuffle(list)
  }

  private shuffle<T>(arr: T[]): T[] {
    const a = [...arr]
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[a[i], a[j]] = [a[j], a[i]]
    }
    return a
  }

  /** plain 模式：生成一个掉落物（对齐站点 santa 规则） */
  private spawnPlain() {
    const size = (this.cfg.size ?? 84) * (this.H / 720)
    const owner = this.spawnCount % Math.max(1, this.present())
    this.spawnCount++
    const z = this.zone(owner)
    const b = this.players[owner].body
    let xMin = z.x0 + size / 2
    let xMax = z.x1 - size / 2
    if (b) {
      const sc = b.shoulderC.x * this.W
      const torsoPx = Math.max(0.05, b.scale) * this.H
      xMin = Math.max(xMin, sc - torsoPx * 1.7)
      xMax = Math.min(xMax, sc + torsoPx * 1.7)
    }
    if (xMax <= xMin) {
      xMin = z.x0 + size / 2
      xMax = z.x1 - size / 2
    }
    const heat = Math.min(1, this.t / 45)
    this.items.push({
      x: xMin + Math.random() * (xMax - xMin),
      y: -size,
      vy: (this.cfg.speed ?? 160) * (1 + 0.3 * heat) * (0.85 + Math.random() * 0.3),
      vx: (Math.random() - 0.5) * 30,
      r: size * (0.9 + Math.random() * 0.25) * 0.5,
      label: '',
      color: this.theme.color,
      alive: true,
      correct: true,
      wob: Math.random() * 6.28,
      phase: 0,
      owner,
      dwell: 0,
      wrong: 0,
      gold: Math.random() < 0.1,
    })
  }

  tick(f: PoseFrame, dt: number) {
    const heat = Math.min(1, this.t / 45)
    const duo = this.present() > 1

    if (this.mode === 'plain') {
      this.spawnT -= dt
      if (this.spawnT <= 0) {
        const airborne = this.items.filter((i) => i.alive).length
        if (airborne < (this.cfg.max ?? 4) * (duo ? 1.6 : 1)) this.spawnPlain()
        this.spawnT = (this.cfg.every ?? 1.1) * (0.75 + Math.random() * 0.5) / (duo ? 1.5 : 1)
      }
    } else if (this.pauseT > 0) {
      this.pauseT -= dt
      if (this.pauseT <= 0) {
        // 拍错后重出同一题/词；答对/拼完/跳词才换新的
        if (this.pendingRegen) {
          this.pendingRegen = false
          this.spawnSet()
        } else if (this.mode === 'math') this.newQuestion()
        else this.newWord()
      }
      this.items = []
      return
    }

    // 掉落/循环运动
    for (const it of this.items) {
      if (!it.alive) continue
      it.wob += dt * 3
      if (this.mode === 'plain') {
        it.vy += 0 * dt
        it.y += it.vy * (1 + 0.35 * heat) * dt
        it.x += it.vx * dt
        if (it.y > this.H - it.r * 1.6) {
          it.alive = false // 落地即消失（站点钉地 1.2s 渐隐，简化为直接回收）
          this.ctx.audio.play('drop', 0.5, 0.8)
        }
      } else {
        // math/letter：循环下落，出屏回顶
        it.y += (this.cfg.speed ?? 50) * dt
        it.x += Math.sin(this.t * 1.3 + it.phase) * 10 * dt
        if (it.y > this.H + it.r) {
          it.y = this.H * 0.18
          it.wrong = 0
          it.dwell = 0
        }
      }
    }

    // 命中判定
    for (let pi = 0; pi < 2; pi++) {
      const b = f.bodies[pi]
      if (!b) continue
      const torsoPx = Math.max(0.05, b.scale) * this.H
      const shoulderY = b.shoulderC.y * this.H
      const parts: { x: number; y: number; r: number; head: boolean; speed: number }[] = [
        { x: b.lHand.x * this.W, y: b.lHand.y * this.H, r: 20, head: false, speed: b.lHandV },
        { x: b.rHand.x * this.W, y: b.rHand.y * this.H, r: 20, head: false, speed: b.rHandV },
      ]
      if (this.mode === 'plain') {
        parts.push({ x: b.head.x * this.W, y: b.head.y * this.H, r: torsoPx * 0.16, head: true, speed: 0 })
      }
      for (const p of parts) {
        for (const it of this.items) {
          if (!it.alive) continue
          if (this.mode !== 'plain' && it.owner !== pi) continue
          const catchR = this.mode === 'plain' ? it.r * 0.84 + p.r : it.r * 0.85 + p.r
          const d = Math.hypot(p.x - it.x, p.y - it.y)
          if (it.correct && d < catchR) {
            this.collect(it, pi, p.head)
            continue
          }
          if (!it.correct && this.mode !== 'plain') {
            // 拍错守卫：手要举过肩 +0.55 躯干，或快拍（站点 torso*1.5）
            const highEnough = p.y < shoulderY + torsoPx * 0.55
            const fast = p.speed > WRONG_GUARD_TORSO * Math.max(0.05, b.scale)
            if (d < it.r + p.r && (highEnough || fast)) {
              it.dwell += dt
              if (it.dwell >= WRONG_DWELL) this.wrongPick(it)
            } else {
              it.dwell = Math.max(0, it.dwell - dt)
            }
          }
        }
      }
    }

    this.items = this.items.filter((i) => i.alive)
    this.ctx.setScore(this.score)
    this.ctx.setExtra('答对', this.correctCount)
    if (this.mode === 'letter') this.ctx.setExtra('接错', 3 - this.hearts)
  }

  private collect(it: Item, _pi: number, byHead: boolean) {
    it.alive = false
    this.particles.burst(it.x, it.y, it.color, 12, 320, 5)
    if (this.mode === 'plain') {
      const gain = it.gold ? 3 : 1
      this.score += gain
      this.correctCount++
      this.ctx.audio.play('score', 1, it.gold ? 1.25 : 1)
      this.say(`+${gain}`, it.x, it.y - 20, it.gold ? '#ffd54a' : '#fff36b', 32)
      if (byHead) this.say('用鼻子接住啦！', it.x, it.y - 60, '#ff8fa3', 30)
    } else if (this.mode === 'math') {
      this.score++
      this.correctCount++
      this.pauseT = 1.6
      this.ctx.audio.good()
      this.say(this.correctCount % 3 === 0 ? '真聪明！' : '答对啦！', this.W / 2, this.H * 0.35, '#3ddc97', 44)
      this.say(`${this.sum.a} ${this.sum.op === 'add' ? '+' : this.sum.op === 'sub' ? '−' : '×'} ${this.sum.b} = ${this.sum.answer}`, this.W / 2, this.H * 0.42, '#bfe6ff', 30)
      for (const o of this.items) {
        if (o.alive) this.particles.burst(o.x, o.y, o.color, 8, 260, 4)
        o.alive = false
      }
    } else {
      // letter：接对一个字母
      this.done++
      this.correctCount++
      this.ctx.audio.play('pop', 1, 1 + (this.done % 5) * 0.08)
      this.say(it.label, it.x, it.y - 20, '#b6ffdd', 44)
      for (const o of this.items) {
        if (o.alive && o !== it) this.particles.burst(o.x, o.y, o.color, 6, 200, 3)
        o.alive = false
      }
      if (this.done >= this.word.length) {
        this.score++
        this.pauseT = 1.7
        this.ctx.audio.good()
        this.say(`拼出 ${this.word}！`, this.W / 2, this.H * 0.35, '#ffd54a', 46)
      } else {
        this.pauseT = 0.35
      }
    }
  }

  private wrongPick(it: Item) {
    it.alive = false
    it.wrong = 1
    this.ctx.audio.fail()
    this.say('再想想', it.x, it.y - 20, '#c9a6ff', 34)
    this.particles.burst(it.x, it.y, it.color, 12, 260, 4)
    if (this.mode === 'letter') {
      this.hearts--
      if (this.hearts <= 0) {
        // 心耗尽跳词
        this.pauseT = 1.8
        this.say(`是 ${this.word}`, this.W / 2, this.H * 0.35, '#ffb703', 40)
        for (const o of this.items) o.alive = false
      }
    } else {
      // math：0.45s 后补一组（简化：立即由 spawnSet 在暂停后补）
      this.items = this.items.filter((o) => o.correct)
      this.pauseT = 0.45
      this.pendingRegen = true
    }
  }

  private pendingRegen = false

  paint(c: CanvasRenderingContext2D) {
    // 题板（math/letter）
    if (this.mode === 'math') {
      c.fillStyle = 'rgba(10,14,40,.4)'
      c.beginPath()
      c.roundRect(this.W / 2 - 210, 10, 420, 68, 30)
      c.fill()
      outlineTxt(c, this.qText(), this.W / 2, 44, 40, '#ffffff')
    } else if (this.mode === 'letter') {
      c.fillStyle = 'rgba(10,14,40,.4)'
      c.beginPath()
      c.roundRect(this.W / 2 - 250, 10, 500, 76, 32)
      c.fill()
      const shown = this.word.split('').map((ch, i) => (i < this.done ? ch : '_')).join(' ')
      outlineTxt(c, shown, this.W / 2, 40, 36, '#ffffff')
      // 3 颗心
      for (let i = 0; i < 3; i++) {
        c.globalAlpha = i < this.hearts ? 1 : 0.25
        txt(c, '♥', this.W / 2 - 60 + i * 40, 72, 24, i < this.hearts ? '#ff5c8a' : '#888', 'center', '900')
        c.globalAlpha = 1
      }
    }

    for (const it of this.items) {
      if (!it.alive) continue
      c.save()
      c.translate(it.x + (this.mode !== 'plain' ? Math.sin(this.t * 1.3 + it.phase) * 10 : 0), it.y)
      glow(c, 0, 0, it.r * 1.8, it.gold ? '#ffd54a' : it.color, it.gold ? 0.45 : 0.3)
      const t = this.theme.shape
      const pic = ITEM_BY_SLUG[this.ctx.meta.slug] || ITEM_OF[t]
      if (this.mode === 'plain' && pic && drawItem(c, pic, 0, 0, it.r * 2.3)) {
        c.restore()
        continue
      }
      if (this.mode === 'plain' && t === 'gift') {
        c.fillStyle = it.gold ? '#ffd54a' : it.color
        c.beginPath()
        c.roundRect(-it.r * 0.8, -it.r * 0.7, it.r * 1.6, it.r * 1.5, 8)
        c.fill()
        c.fillStyle = '#ffe066'
        c.fillRect(-it.r * 0.12, -it.r * 0.7, it.r * 0.24, it.r * 1.5)
        c.fillRect(-it.r * 0.8, -it.r * 0.16, it.r * 1.6, it.r * 0.22)
      } else {
        // 数字/字母泡泡
        circle(c, 0, 0, it.r, 'rgba(255,255,255,.95)')
        c.strokeStyle = it.correct ? it.color : '#ff8fa3'
        c.lineWidth = 6
        c.stroke()
        c.fillStyle = '#1b2a4a'
        c.font = `900 ${it.r * 1.05}px "PingFang SC",system-ui`
        c.textAlign = 'center'
        c.textBaseline = 'middle'
        c.fillText(it.label, 0, it.r * 0.04)
      }
      c.restore()
    }

    if (this.mode === 'plain') {
      txt(c, this.theme.hint, this.W / 2, this.H - 34, 20, 'rgba(255,255,255,.8)', 'center', 'bold')
    }
  }
}

export default function create(ctx: GameContext) {
  return new CatchGame(ctx)
}
