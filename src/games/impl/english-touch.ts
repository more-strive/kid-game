import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { emoji, glow, outlineTxt, rr, star, txt } from '@/core/draw'

/**
 * 英语摸摸看（对齐 dongdongpark 真实规则）：
 * 几张单词卡（emoji 图）挂在身体两侧固定挂点上，小喇叭只说英语，伸手摸对那张。
 *
 * 站点原样保留的四条规则：
 * 1. 纯听力模式：medium/hard 答题时指令条只显示「Listen!」，文字只在提示或结算时露出（easy 常显）。
 * 2. 摸错不喊「错了」，而是**把你摸到的那个词念出来**，卡片下方同时打出这个词。
 * 3. 相邻两题不重复抽同一个词；3/5 张时两套挂点组合交替，防止靠肌肉记忆刷分。
 * 4. block 防碰瓷：入场动画期间手已压在卡上的，这只手对这张卡失效（2.5 秒后目标卡解锁）。
 *
 * 与站点的差异：站点用 `motion` 里的连续 squat 与手半径，本框架只有骨骼点，
 * 手半径统一取 0.12×卡片半径、「手在肩下」改用「手没有举过肩上方 0.25T」判定（同 touch-color）。
 */

const DIFF = [
  { n: 3, two: false, mixed: false, repeat: 4.5, giveUp: 10, textAt: 0, cheer: 1.1, penalty: 0 },
  { n: 4, two: false, mixed: true, repeat: 5, giveUp: 11, textAt: 1, cheer: 1, penalty: 0 },
  { n: 5, two: true, mixed: true, repeat: 6.5, giveUp: 14, textAt: 1, cheer: 1, penalty: 1 },
]

interface Word {
  en: string
  zh: string
  ch: string
  topic: number
}

/** 36 词 / 三主题各 12（动物 / 食物 / 物品） */
const WORDS: Word[] = [
  { en: 'cat', zh: '猫', ch: '🐱', topic: 0 },
  { en: 'dog', zh: '狗', ch: '🐶', topic: 0 },
  { en: 'fish', zh: '鱼', ch: '🐟', topic: 0 },
  { en: 'bird', zh: '鸟', ch: '🐦', topic: 0 },
  { en: 'duck', zh: '鸭子', ch: '🦆', topic: 0 },
  { en: 'pig', zh: '猪', ch: '🐷', topic: 0 },
  { en: 'rabbit', zh: '兔子', ch: '🐰', topic: 0 },
  { en: 'monkey', zh: '猴子', ch: '🐵', topic: 0 },
  { en: 'panda', zh: '熊猫', ch: '🐼', topic: 0 },
  { en: 'tiger', zh: '老虎', ch: '🐯', topic: 0 },
  { en: 'elephant', zh: '大象', ch: '🐘', topic: 0 },
  { en: 'bear', zh: '熊', ch: '🐻', topic: 0 },

  { en: 'apple', zh: '苹果', ch: '🍎', topic: 1 },
  { en: 'banana', zh: '香蕉', ch: '🍌', topic: 1 },
  { en: 'orange', zh: '橘子', ch: '🍊', topic: 1 },
  { en: 'pear', zh: '梨', ch: '🍐', topic: 1 },
  { en: 'grapes', zh: '葡萄', ch: '🍇', topic: 1 },
  { en: 'watermelon', zh: '西瓜', ch: '🍉', topic: 1 },
  { en: 'egg', zh: '鸡蛋', ch: '🥚', topic: 1 },
  { en: 'cake', zh: '蛋糕', ch: '🍰', topic: 1 },
  { en: 'bread', zh: '面包', ch: '🍞', topic: 1 },
  { en: 'milk', zh: '牛奶', ch: '🥛', topic: 1 },
  { en: 'ice cream', zh: '冰淇淋', ch: '🍦', topic: 1 },
  { en: 'rice', zh: '米饭', ch: '🍚', topic: 1 },

  { en: 'ball', zh: '球', ch: '⚽', topic: 2 },
  { en: 'book', zh: '书', ch: '📖', topic: 2 },
  { en: 'car', zh: '汽车', ch: '🚗', topic: 2 },
  { en: 'bus', zh: '公交车', ch: '🚌', topic: 2 },
  { en: 'bike', zh: '自行车', ch: '🚲', topic: 2 },
  { en: 'hat', zh: '帽子', ch: '🎩', topic: 2 },
  { en: 'bag', zh: '书包', ch: '🎒', topic: 2 },
  { en: 'pencil', zh: '铅笔', ch: '✏️', topic: 2 },
  { en: 'clock', zh: '时钟', ch: '🕐', topic: 2 },
  { en: 'balloon', zh: '气球', ch: '🎈', topic: 2 },
  { en: 'umbrella', zh: '雨伞', ch: '☂️', topic: 2 },
  { en: 'key', zh: '钥匙', ch: '🔑', topic: 2 },
]

/** 三个挂点相对肩心的偏移（单位=躯干长）；0~2 在右，3~5 是左边的镜像 */
const SLOTS = [
  { x: 0.98, y: -0.65 },
  { x: 1.6, y: -0.08 },
  { x: 1.22, y: 0.58 },
]

/** 每种卡片数的挂点组合（按题号轮换，防止靠位置记忆） */
const COMBOS: Record<number, number[][]> = {
  3: [[0, 1, 4], [1, 3, 4]],
  4: [[0, 1, 3, 4]],
  5: [[0, 1, 2, 3, 4], [0, 1, 3, 4, 5]],
}

const BORN_T = 0.35 // 入场动画（秒）
const OUT_T = 0.25 // 退场动画（秒）
const CARD_R = 0.28 // 卡片半径系数（× 躯干长）
const HAND_R = 0.12 // 手半径（× 卡片半径）
const WRONG_R = 0.45 // 误触判定半径的手半径系数
const WRONG_HOLD = 0.55 // 误触驻留（秒）
const WRONG_SHAKE = 0.6 // 误触抖动持续（秒）
const UNLOCK = 2.5 // 目标卡 block 解锁（秒）
const AFTER_ONE = 3.5 // 有人完成后本题最多再等（秒）
const TAU = Math.PI * 2
const PRAISE = ['Great!', 'Good job!', 'Well done!', 'Yes!']

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v))
}

function shuffled<T>(arr: T[]): T[] {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

interface Card {
  word: number
  x: number
  y: number
  r: number
  hit: boolean
  /** 每只手是否被 block（入场时手已压在卡上） */
  blocked: boolean[]
  /** 每只手的误触停留计时（按手分开，否则另一只手扫过会清零） */
  dwell: number[]
  wrong: number
  pop: number
}

interface PState {
  cards: Card[]
  /** 已摸对的目标数 */
  hit: number
  wrongCount: number
  rightCount: number
  penalized: boolean
  streak: number
  best: number
  /** 累计答对用时（秒） */
  time: number
  doneAt: number
  zone: { x0: number; x1: number }
}

type Phase = 'ready' | 'ask' | 'cheer' | 'out'

class EnglishTouch extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[0]
  phase: Phase = 'ready'
  phaseAt = 0
  qAt = 0
  qn = 0
  targets: number[] = []
  items: number[] = []
  combo: number[] = []
  hinted = false
  /** 超时收题后把答案摊开显示 */
  revealed = false
  private firstDone = -1
  private cheerTimeout = false
  private praised = 0
  private deck: number[] = []
  private lastWord = -1
  ps: PState[] = []

  constructor(ctx: GameContext) {
    super(ctx)
    const versus = ctx.meta.mode === 'versus'
    for (let i = 0; i < 2; i++) {
      const zone = versus
        ? { x0: i === 0 ? 0 : this.W / 2, x1: i === 0 ? this.W / 2 : this.W }
        : { x0: 0, x1: this.W }
      this.ps.push({
        cards: [],
        hit: 0,
        wrongCount: 0,
        rightCount: 0,
        penalized: false,
        streak: 0,
        best: 0,
        time: 0,
        doneAt: -1,
        zone,
      })
    }
    this.newQuestion()
  }

  // ---------------------------------------------------------------- 抽词 / 出题

  /** 牌堆：抽完一轮再洗；相邻两题不重复 */
  private nextWord(): number {
    if (!this.deck.length) this.deck = shuffled(WORDS.map((_, i) => i))
    let w = this.deck.pop()!
    if (w === this.lastWord && this.deck.length) {
      // 与上一题重了 → 换成牌堆里另一张，把这张放回去
      const j = Math.floor(Math.random() * this.deck.length)
      const alt = this.deck[j]
      this.deck[j] = w
      w = alt
    }
    this.lastWord = w
    return w
  }

  private newQuestion() {
    const cfg = this.cfg
    const targets = [this.nextWord()]
    if (cfg.two) {
      let w = this.nextWord()
      let guard = 0
      while (targets.includes(w) && guard++ < 24) w = this.nextWord()
      targets.push(w)
    }
    // 干扰项：不在 targets 里；非 mixed 时限定同一主题（语义场最窄）
    const pool = shuffled(
      WORDS.map((_, i) => i).filter(
        (i) => !targets.includes(i) && (cfg.mixed || WORDS[i].topic === WORDS[targets[0]].topic),
      ),
    )
    const items = shuffled(targets.concat(pool.slice(0, Math.max(0, cfg.n - targets.length))))
    const combos = COMBOS[items.length] ?? COMBOS[3]

    this.targets = targets
    this.items = items
    this.combo = combos[this.qn % combos.length]
    this.hinted = false
    this.revealed = false
    this.firstDone = -1
    this.cheerTimeout = false
    this.qAt = this.t
    this.phase = 'ready'
    this.phaseAt = this.t

    for (const st of this.ps) {
      st.cards = items.map((w) => ({
        word: w,
        x: this.W / 2,
        y: this.H / 2,
        r: 40,
        hit: false,
        blocked: [false, false],
        dwell: [0, 0],
        wrong: 0,
        pop: 0,
      }))
      st.hit = 0
      st.wrongCount = 0
      st.penalized = false
      st.doneAt = -1
    }
    this.qn++
    this.sayQuestion()
  }

  private sayQuestion() {
    const en = this.targets.map((w) => WORDS[w].en)
    if (en.length > 1) this.ctx.audio.speakEn(`Touch the ${en[0]}! Then the ${en[1]}!`)
    else this.ctx.audio.speakEn(`Touch the ${en[0]}!`)
  }

  // ---------------------------------------------------------------- 主循环

  tick(f: PoseFrame, dt: number) {
    const born = clamp((this.t - this.qAt) / BORN_T, 0, 1)

    for (let i = 0; i < 2; i++) {
      const st = this.ps[i]
      const b = f.bodies[i] ?? null
      if (!b || !st.cards.length) continue
      this.layout(st, b, dt)
      for (const card of st.cards) {
        card.pop = Math.max(0, card.pop - dt * 2.2)
        card.wrong = Math.max(0, card.wrong - dt)
      }
      if (this.phase === 'ask') this.judgeHands(st, b, born, dt)
    }

    if (this.phase === 'ready' && this.t >= this.phaseAt + BORN_T) {
      this.phase = 'ask'
      this.phaseAt = this.t
    }

    if (this.phase === 'ask') {
      const active = this.ps.filter((_, i) => this.player(i).body)
      const done = active.filter((p) => p.doneAt >= 0)
      if (active.length && done.length === active.length) this.cheer(false)
      else if (done.length > 0 && this.firstDone >= 0 && this.t - this.firstDone > AFTER_ONE) this.cheer(true)
      else if (this.t - this.qAt > this.cfg.giveUp) {
        this.revealed = true
        this.ctx.audio.play('drop', 0.6)
        this.ctx.audio.speakEn(`Look! ${WORDS[this.targets[0]].en}!`, 0.85)
        this.cheer(true)
      }
      this.maybeHint()
    }

    if (this.phase === 'cheer' && this.t >= this.phaseAt + this.cfg.cheer + (this.cheerTimeout ? 1.2 : 0)) {
      this.phase = 'out'
      this.phaseAt = this.t
    }
    if (this.phase === 'out' && this.t >= this.phaseAt + OUT_T) this.newQuestion()
    this.publishStats()
  }

  private layout(st: PState, b: Body, dt: number) {
    const T = Math.max(70, (b.hipC.y - b.shoulderC.y) * this.H * 1.1)
    const r = clamp(T * CARD_R, 30, 70)
    const sx = b.shoulderC.x * this.W
    const sy = b.shoulderC.y * this.H
    // 答题中 4/s 跟随身体，其余阶段 1.5/s 慢慢归位
    const k = 1 - Math.exp(-dt * (this.phase === 'ask' ? 4 : 1.5))
    const top = this.targets.length > 1 ? 112 : 84
    for (let i = 0; i < st.cards.length; i++) {
      const anchor = this.combo[i] ?? i
      const slot = SLOTS[anchor % 3]
      const side = anchor < 3 ? 1 : -1
      const tx = clamp(sx + side * slot.x * T, st.zone.x0 + 1.2 * r, st.zone.x1 - 1.2 * r)
      const ty = clamp(sy + slot.y * T, top + 1.2 * r, this.H - 150 - r)
      const card = st.cards[i]
      card.r = card.r < 1 ? r : card.r + (r - card.r) * 0.2
      card.x += (tx - card.x) * k
      card.y += (ty - card.y) * k
    }
  }

  /** 当前该摸第几个目标 */
  private currentTarget(st: PState): number | null {
    return st.hit < this.targets.length ? this.targets[st.hit] : null
  }

  private judgeHands(st: PState, b: Body, born: number, dt: number) {
    if (st.doneAt >= 0) return
    const T = Math.max(70, (b.hipC.y - b.shoulderC.y) * this.H * 1.1)
    const shoulderY = b.shoulderC.y * this.H
    const hands = [
      { x: b.lHand.x * this.W, y: b.lHand.y * this.H },
      { x: b.rHand.x * this.W, y: b.rHand.y * this.H },
    ]
    const cur = this.currentTarget(st)

    for (let hi = 0; hi < 2; hi++) {
      const h = hands[hi]
      let hitIdx = -1
      for (let ci = 0; ci < st.cards.length; ci++) {
        const card = st.cards[ci]
        const handR = card.r * HAND_R
        const d = Math.hypot(h.x - card.x, h.y - card.y)
        const isTarget = cur !== null && card.word === cur
        // 站点写的是「手在肩下 0.85T」，但最高一排卡片在肩上方 0.65T，按字面摸顶排永远不会判误触。
        // 这里放宽到「手没有举过肩上方 0.9T」：既保住「举着手掠过不算误触」，也让顶排能判。
        const belowShoulder = h.y > shoulderY - 0.9 * T

        if (d > card.r + handR) {
          card.blocked[hi] = false
          card.dwell[hi] = 0
          continue
        }
        // 入场动画期间已压在卡上 → 这只手对这张卡失效
        if (born < 1) {
          card.blocked[hi] = true
          continue
        }
        if (isTarget && !card.hit && (!card.blocked[hi] || this.t - this.qAt > UNLOCK)) {
          hitIdx = ci
          break
        }
        if (!isTarget && belowShoulder && d < card.r + handR * WRONG_R) {
          card.dwell[hi] += dt
          if (card.dwell[hi] >= WRONG_HOLD && card.wrong <= 0) this.wrongTouch(st, ci, hi)
        }
      }
      if (hitIdx >= 0) {
        this.correct(st, hitIdx)
        return
      }
    }
  }

  private correct(st: PState, ci: number) {
    const card = st.cards[ci]
    card.hit = true
    card.pop = 1
    st.hit++
    this.particles.burst(card.x, card.y, '#ffe066', 12, 300, 6)
    this.ctx.audio.play('score', 0.55, 1 + st.hit * 0.12)

    if (st.hit >= this.targets.length) {
      st.doneAt = this.t
      st.rightCount++
      st.streak++
      st.best = Math.max(st.best, st.streak)
      st.time += this.t - this.qAt
      this.ctx.setCombo(st.streak)
      this.ctx.addScore(1)
      this.ctx.audio.win()
      if (this.firstDone < 0) this.firstDone = this.t
      if (this.targets.length > 1) this.particles.confetti(this.W, 22)
      this.say(st.streak % 2 === 0 ? PRAISE[this.praised++ % PRAISE.length] : '对啦！', card.x, card.y - card.r - 26, '#ffd43b', 38)
      if (st.streak % 2 === 0) this.ctx.audio.speakEn(PRAISE[(this.praised - 1) % PRAISE.length])
    } else {
      const next = this.targets[st.hit]
      this.ctx.audio.speakEn(`Now the ${WORDS[next].en}!`)
    }
  }

  private wrongTouch(st: PState, ci: number, hi: number) {
    const card = st.cards[ci]
    card.wrong = WRONG_SHAKE
    card.dwell[hi] = 0
    card.blocked[hi] = true
    st.wrongCount++
    st.streak = 0
    this.ctx.audio.pop()
    this.particles.burst(card.x, card.y, '#d9d2e3', 9, 200, 4)

    // 顺序错（摸到了后面的目标）只提示不扣分
    const later = this.targets.some((w, k) => k > st.hit && w === card.word)
    if (later) this.ctx.audio.speakEn(`Touch the ${WORDS[this.targets[st.hit]].en}!`)
    else this.ctx.audio.speakEn(`${WORDS[card.word].en}!`, 0.85)

    if (later) return
    if (this.cfg.penalty > 0 && !st.penalized && this.ctx.hud().score > 0) {
      st.penalized = true
      this.ctx.addScore(-this.cfg.penalty)
    }
  }

  private maybeHint() {
    if (this.hinted || this.t - this.qAt < this.cfg.repeat) return
    const pending = this.ps.filter((p, i) => this.player(i).body && p.doneAt < 0)
    if (!pending.length) return
    this.hinted = true
    this.sayQuestion()
  }

  private cheer(timeout: boolean) {
    this.phase = 'cheer'
    this.phaseAt = this.t
    this.cheerTimeout = timeout
    for (const st of this.ps) if (st.doneAt < 0) st.streak = 0
  }

  private publishStats() {
    const best = Math.max(...this.ps.map((p) => p.best))
    const right = this.ps.reduce((s, p) => s + p.rightCount, 0)
    const wrong = this.ps.reduce((s, p) => s + p.wrongCount, 0)
    const time = this.ps.reduce((s, p) => s + p.time, 0)
    this.ctx.setExtra('最多连对', best)
    this.ctx.setExtra('答对', right)
    this.ctx.setExtra('准确率', right + wrong > 0 ? Math.round((right / (right + wrong)) * 100) : 100)
    if (right > 0) this.ctx.setExtra('平均用时', Number((time / right).toFixed(1)))
  }

  // ---------------------------------------------------------------- 绘制

  paint(c: CanvasRenderingContext2D) {
    const active = [0, 1].filter((i) => this.player(i).body)
    if (!active.length) {
      outlineTxt(c, '站到画面中间，单词卡会挂在你身体两边', this.W / 2, this.H * 0.12, 32, 'rgba(255,255,255,.9)')
      return
    }
    for (const i of active) {
      const st = this.ps[i]
      for (const card of st.cards) this.drawCard(c, st, card)
    }
    this.drawBar(c)
  }

  private drawCard(c: CanvasRenderingContext2D, st: PState, card: Card) {
    const cur = this.currentTarget(st)
    const isTarget = cur !== null && card.word === cur
    const born = clamp((this.t - this.qAt) / BORN_T, 0, 1)
    const back = 1 - Math.pow(1 - born, 3)
    const r = card.r * back * (1 + card.pop * 0.25)
    if (r < 2) return

    c.save()
    c.translate(card.x, card.y)
    if (card.wrong > 0) c.rotate(Math.sin(card.wrong * 32) * 0.3 * (card.wrong / WRONG_SHAKE))
    c.beginPath()
    c.arc(0, 0, r, 0, TAU)
    c.fillStyle = 'rgba(255,253,243,.95)'
    c.fill()
    c.lineWidth = 5
    c.strokeStyle = card.hit ? '#3ddc97' : '#e8dccf'
    c.stroke()
    emoji(c, WORDS[card.word].ch, 0, r * 0.04, r * 1.15)
    if (card.hit) {
      c.globalAlpha = 0.85
      glow(c, 0, 0, r * 2.2, '#ffe066', 0.45)
      c.globalAlpha = 1
      star(c, r * 0.72, -r * 0.72, r * 0.24, '#ffd43b')
    }
    c.restore()

    // 单词：命中或超时揭示时才显示（纯听力模式）
    if (card.hit || this.revealed) {
      txt(c, WORDS[card.word].en, card.x, card.y + r + 20, Math.max(18, r * 0.4), card.hit ? '#3ddc97' : '#ffffffdd')
    }
    // 提示态：目标卡脉冲黄环
    if (this.hinted && isTarget && !card.hit) {
      const p = 0.5 + 0.5 * Math.sin(this.t * 8)
      c.beginPath()
      c.arc(card.x, card.y, r * (1.2 + p * 0.12), 0, TAU)
      c.lineWidth = Math.max(4, r * 0.14)
      c.strokeStyle = `rgba(255,212,59,${0.55 + p * 0.4})`
      c.stroke()
    }
  }

  /** 顶部指令条：喇叭 + 英文指令（纯听力模式下只显示 Listen!） */
  private drawBar(c: CanvasRenderingContext2D) {
    const show = this.cfg.textAt === 0 || this.hinted || this.phase !== 'ask' || this.revealed
    const lines = show
      ? this.targets.map((w, i) => (i === 0 ? `Touch the ${WORDS[w].en}!` : `Then the ${WORDS[w].en}!`))
      : ['Listen!']
    const speaking = this.phase === 'ask' && this.t - this.qAt < 1.8
    const w = Math.max(300, Math.min(760, Math.max(...lines.map((l) => l.length)) * 22 + 150))
    const h = lines.length > 1 ? 118 : 92
    const x = this.W / 2 - w / 2
    const y = 16

    c.save()
    c.shadowColor = 'rgba(20,24,60,.3)'
    c.shadowBlur = 16
    c.shadowOffsetY = 6
    rr(c, x, y, w, h, 30)
    c.fillStyle = 'rgba(255,253,243,.95)'
    c.fill()
    c.restore()

    const cy = y + h / 2
    c.save()
    c.translate(x + 48, cy)
    if (speaking) c.scale(1 + Math.sin(this.t * 14) * 0.1, 1 + Math.sin(this.t * 14) * 0.1)
    emoji(c, '🔊', 0, 0, 42)
    c.restore()

    const tx = x + 88
    for (let i = 0; i < lines.length; i++) {
      const ly = lines.length > 1 ? y + 38 + i * 42 : cy
      const done = i < this.targets.length && this.ps.every((p, k) => !this.player(k).body || p.hit > i)
      txt(c, lines[i], tx, ly, 34, done ? '#3ddc97' : '#3b3552', 'left')
    }
    if (this.hinted && this.phase === 'ask') {
      txt(c, '💡', x + w - 40, cy, 34)
    }
  }
}

export function createEnglishTouch(ctx: GameContext): Game {
  return new EnglishTouch(ctx)
}


export default createEnglishTouch
