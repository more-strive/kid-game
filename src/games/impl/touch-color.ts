import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, glow, outlineTxt, rr, star, txt } from '@/core/draw'

/**
 * 颜色摸摸看（对齐 dongdongpark 真实规则）：
 * 6 件玩具挂在身体两侧（每侧 3 件，肩—腰—髋三档高度），听口令伸手去摸对的那件。
 * easy 只说颜色；medium/hard 说「红色的圆形」；hard 要按顺序摸两件。
 *
 * 三条关键规则（站点原样保留）：
 * 1. 「同色异形 / 同形异色」干扰：medium 起强制塞这两类，逼孩子同时处理两个属性。
 * 2. 误触要「停留」：手指扫过（< 0.55 秒）不判错，只有贴着错物才扣。
 * 3. block 防碰瓷：玩具出生 0.35 秒内手已经压在它上面，这只手对这件失效，必须先离开再摸。
 *
 * 与站点的差异：站点用 `motion` 里的手半径做判定尺寸，本框架只有骨骼点，
 * 手半径统一取 0.08×躯干长；判定半径因此比站点略保守，真机手感需实测校准。
 */

const DIFF = [
  { hint: 4.5, giveUp: 11, cheer: 1.1, penalty: 0, aiReact: 2 },
  { hint: 5.5, giveUp: 12, cheer: 1, penalty: 0, aiReact: 2.4 },
  { hint: 7, giveUp: 15, cheer: 1, penalty: 1, aiReact: 3 },
]

const COLORS = [
  { name: '红色', hex: '#ff4d4d' },
  { name: '橙色', hex: '#ff922b' },
  { name: '黄色', hex: '#ffd43b' },
  { name: '绿色', hex: '#3ddc97' },
  { name: '蓝色', hex: '#4dabf7' },
  { name: '紫色', hex: '#b197fc' },
]
const SHAPES = ['圆形', '三角形', '正方形', '星星', '爱心', '月亮']

/** 三个挂点相对肩心的偏移（单位=躯干长），左列取负 */
const SLOTS = [
  { x: 0.98, y: -0.65 },
  { x: 1.6, y: -0.08 },
  { x: 1.22, y: 0.58 },
]

const BORN_T = 0.35 // 出生动画（秒）
const HIT_R = 0.08 // 手半径（× 躯干长）
const WRONG_HOLD = 0.55 // 误触驻留（秒）
const WRONG_R = 0.45 // 误触半径的手半径系数
const HINT_BOOST = 1.35 // 提示态判定半径放大
const REACH_T = 1.2 // 「够不着」累计时长
const AFTER_ONE = 4 // 有人完成后最多再等（秒）
const IDLE_ANGLE = Math.PI * 2

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v))
}

interface Item {
  color: number
  shape: number
}

interface Toy extends Item {
  x: number
  y: number
  r: number
  hit: boolean
  /** 每只手是否被 block（开局手就压在上面） */
  blocked: boolean[]
  /** 每只手的误触停留计时（必须按手分开，否则另一只手扫过会清零） */
  dwell: number[]
  /** 误触抖动剩余 */
  wrong: number
  /** 命中弹一下 */
  pop: number
}

interface PState {
  toys: Toy[]
  hit: number
  wrongCount: number
  penalized: boolean
  streak: number
  best: number
  times: number
  /** 累计贴近目标的时间（「再伸过去一点点」用） */
  reach: number
  saidReach: boolean
  doneAt: number
  right: boolean
  zone: { x0: number; x1: number }
}

type Phase = 'ready' | 'ask' | 'cheer' | 'out'

class TouchColor extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[0]
  phase: Phase = 'ready'
  phaseAt = 0
  qAt = 0
  qn = 0
  items: Item[] = []
  targets: Item[] = []
  hinted = false
  private prevColor = -1
  private firstDone = -1
  private cheerTimeout = false
  ps: PState[] = []

  constructor(ctx: GameContext) {
    super(ctx)
    const versus = ctx.meta.mode === 'versus'
    for (let i = 0; i < 2; i++) {
      const zone = versus
        ? { x0: i === 0 ? 0 : this.W / 2, x1: i === 0 ? this.W / 2 : this.W }
        : { x0: 0, x1: this.W }
      this.ps.push({
        toys: [],
        hit: 0,
        wrongCount: 0,
        penalized: false,
        streak: 0,
        best: 0,
        times: 0,
        reach: 0,
        saidReach: false,
        doneAt: -1,
        right: false,
        zone,
      })
    }
    this.newQuestion()
  }

  // ---------------------------------------------------------------- 出题

  /** medium/hard 里「同一颜色必须不同形状」：同色重复时把形状顺移 */
  private push(items: Item[], color: number, shape: number) {
    let s = ((shape % 6) + 6) % 6
    for (let k = 0; k < 6; k++) {
      const dup = items.some((it) => it.color === color && it.shape === s)
      if (!dup) {
        items.push({ color, shape: s })
        return
      }
      s = (s + 1) % 6
    }
  }

  private newQuestion() {
    const d = this.ctx.difficulty
    const items: Item[] = []
    const targets: Item[] = []

    if (d === 0) {
      // easy：六色各一，各配随机形状，只认颜色
      const order = [0, 1, 2, 3, 4, 5].sort(() => Math.random() - 0.5)
      for (const c of order) this.push(items, c, Math.floor(Math.random() * 6))
      targets.push(items[Math.floor(Math.random() * items.length)])
    } else if (d === 1) {
      // medium：目标 + 2 件同色异形 + 2 件同形异色 + 1 件随机
      let c = Math.floor(Math.random() * 6)
      if (c === this.prevColor) c = (c + 1) % 6
      const s = Math.floor(Math.random() * 6)
      this.push(items, c, s)
      targets.push({ color: c, shape: s })
      for (let k = 1; k <= 2; k++) this.push(items, c, s + k)
      for (let k = 1; k <= 2; k++) this.push(items, c + k, s)
      this.push(items, Math.floor(Math.random() * 6), Math.floor(Math.random() * 6))
    } else {
      // hard：两个目标 + 各自一件同色异形干扰 + 2 件随机，按顺序摸
      let c1 = Math.floor(Math.random() * 6)
      if (c1 === this.prevColor) c1 = (c1 + 1) % 6
      const c2 = (c1 + 1 + Math.floor(Math.random() * 5)) % 6
      const s1 = Math.floor(Math.random() * 6)
      const s2 = (s1 + 1 + Math.floor(Math.random() * 5)) % 6
      this.push(items, c1, s1)
      targets.push({ color: c1, shape: s1 })
      this.push(items, c2, s2)
      targets.push({ color: c2, shape: s2 })
      this.push(items, c1, s1 + 1)
      this.push(items, c2, s2 + 1)
      for (let k = 0; k < 2; k++) this.push(items, Math.floor(Math.random() * 6), Math.floor(Math.random() * 6))
    }
    while (items.length < 6) this.push(items, Math.floor(Math.random() * 6), Math.floor(Math.random() * 6))

    this.items = items.slice(0, 6)
    this.targets = targets
    this.hinted = false
    this.firstDone = -1
    this.cheerTimeout = false
    this.qAt = this.t
    this.phase = 'ready'
    this.phaseAt = this.t

    for (const st of this.ps) {
      st.toys = this.items.map((it) => ({ ...it, x: this.W / 2, y: this.H / 2, r: 40, hit: false, blocked: [false, false], dwell: [0, 0], wrong: 0, pop: 0 }))
      st.hit = 0
      st.wrongCount = 0
      st.penalized = false
      st.reach = 0
      st.saidReach = false
      st.doneAt = -1
      st.right = false
    }
    this.prevColor = targets[0].color
    this.sayQuestion()
  }

  private label(t: Item) {
    return this.ctx.difficulty === 0 ? COLORS[t.color].name : `${COLORS[t.color].name}的${SHAPES[t.shape]}`
  }

  private sayQuestion() {
    const name = this.targets.map((t) => this.label(t)).join('，再摸')
    const forms = ['摸一摸', '在哪里？', '找一找']
    const f = forms[this.qn % 3]
    this.qn++
    this.ctx.speak(this.targets.length > 1 ? `先摸${name.replace('，再摸', '，再摸')}` : `${f}${name}！`)
  }

  // ---------------------------------------------------------------- 主循环

  tick(f: PoseFrame, dt: number) {
    const born = clamp((this.t - this.qAt) / BORN_T, 0, 1)

    for (let i = 0; i < 2; i++) {
      const st = this.ps[i]
      const b = f.bodies[i] ?? null
      if (!b || !st.toys.length) continue
      this.layout(st, b, dt)
      for (const toy of st.toys) {
        toy.pop = Math.max(0, toy.pop - dt * 2.2)
        toy.wrong = Math.max(0, toy.wrong - dt)
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
      else if (this.t - this.qAt > this.cfg.giveUp) this.cheer(true)
      this.maybeHint()
    }

    if (this.phase === 'cheer' && this.t >= this.phaseAt + this.cfg.cheer + (this.cheerTimeout ? 0.6 : 0)) {
      this.phase = 'out'
      this.phaseAt = this.t
    }
    if (this.phase === 'out' && this.t >= this.phaseAt + 0.25) this.newQuestion()
  }

  private layout(st: PState, b: Body, dt: number) {
    const T = Math.max(70, (b.hipC.y - b.shoulderC.y) * this.H * 1.1)
    const r = clamp(T * 0.32, 30, 76)
    const sx = b.shoulderC.x * this.W
    const sy = b.shoulderC.y * this.H
    const k = 1 - Math.exp(-dt * 4)
    for (let i = 0; i < st.toys.length; i++) {
      const slot = i % 3
      const side = i < 3 ? -1 : 1
      const off = SLOTS[slot]
      const tx = clamp(sx + side * off.x * T, st.zone.x0 + 1.2 * r, st.zone.x1 - 1.2 * r)
      const ty = clamp(sy + off.y * T, 64 + 1.6 * r, this.H - 124 - 30 - r)
      const toy = st.toys[i]
      toy.r = toy.r < 1 ? r : toy.r + (r - toy.r) * 0.2
      toy.x += (tx - toy.x) * k
      toy.y += (ty - toy.y) * k
    }
  }

  /** 当前该摸第几个目标 */
  private currentTarget(st: PState): Item | null {
    return st.hit < this.targets.length ? this.targets[st.hit] : null
  }

  private judgeHands(st: PState, b: Body, born: number, dt: number) {
    if (st.doneAt >= 0) return
    const T = Math.max(70, (b.hipC.y - b.shoulderC.y) * this.H * 1.1)
    const handR = T * HIT_R
    const hands = [
      { x: b.lHand.x * this.W, y: b.lHand.y * this.H },
      { x: b.rHand.x * this.W, y: b.rHand.y * this.H },
    ]
    const cur = this.currentTarget(st)
    const shoulderY = b.shoulderC.y * this.H

    for (let hi = 0; hi < 2; hi++) {
      const h = hands[hi]
      let hitIdx = -1
      for (let ti = 0; ti < st.toys.length; ti++) {
        const toy = st.toys[ti]
        const isTarget = !!cur && cur.color === toy.color && cur.shape === toy.shape
        const rEff = (toy.r + handR) * (isTarget && this.hinted ? HINT_BOOST : 1)
        const d = Math.hypot(h.x - toy.x, h.y - toy.y)
        // 站点写「手在肩下 0.85T」，但玩具最高一件在肩上方 0.65T，按字面会永远不成立；
        // 这里改为「手没有举到肩上方 0.25T 以上」，拦掉举手臂掠过顶排的误判。
        const belowShoulder = h.y > shoulderY - 0.25 * T

        if (d > rEff) {
          toy.blocked[hi] = false
          toy.dwell[hi] = 0
          if (isTarget && !toy.hit && belowShoulder && d < rEff + 0.6 * T) {
            if (!st.saidReach) st.reach += dt
          }
          continue
        }
        // 出生动画期间已经压在上面 → 这只手对这件失效
        if (born < 1) {
          toy.blocked[hi] = true
          continue
        }
        if (isTarget && !toy.hit && (!toy.blocked[hi] || this.t - this.qAt > 2.5)) {
          hitIdx = ti
          break
        }
        // 误触：手要在肩下 0.85T 且贴得更近，并累计停留
        if (!isTarget && belowShoulder && d < toy.r + handR * WRONG_R) {
          toy.dwell[hi] += dt
          if (toy.dwell[hi] >= WRONG_HOLD && toy.wrong <= 0) this.wrongTouch(st, ti, hi)
        }
      }
      if (hitIdx >= 0) {
        this.correct(st, hitIdx)
        return
      }
    }

    if (st.reach > REACH_T && !st.saidReach) {
      st.saidReach = true
      this.ctx.speak('再伸过去一点点！')
    }
  }

  private correct(st: PState, ti: number) {
    const toy = st.toys[ti]
    toy.hit = true
    toy.pop = 1
    st.reach = 0
    st.hit++
    this.particles.burst(toy.x, toy.y, COLORS[toy.color].hex, 10, 260, 5)
    this.ctx.audio.play('combo', 0.6, 1 + st.hit * 0.15)

    if (st.hit >= this.targets.length) {
      st.doneAt = this.t
      st.right = true
      st.streak++
      st.best = Math.max(st.best, st.streak)
      st.times += this.t - this.qAt
      this.ctx.addScore(1)
      this.ctx.audio.win()
      if (this.firstDone < 0) this.firstDone = this.t
      if (this.targets.length > 1) this.particles.confetti(this.W, 22)
      const praise = ['对啦！', '真棒！', '找到啦！', '好厉害！']
      this.say(praise[st.streak % praise.length], toy.x, toy.y - toy.r - 30, '#ffd43b', 40)
      this.ctx.setExtra('最多连对', Math.max(...this.ps.map((p) => p.best)))
    } else {
      this.ctx.speak(this.targets[st.hit] ? `再摸${this.label(this.targets[st.hit])}` : '好')
    }
  }

  private wrongTouch(st: PState, ti: number, hi: number) {
    const toy = st.toys[ti]
    toy.wrong = 0.6
    toy.dwell[hi] = 0
    toy.blocked[hi] = true
    st.wrongCount++
    st.streak = 0
    this.ctx.audio.pop()

    // 顺序错（摸到了后面的目标）只提示不扣分
    const later = this.targets.some((t, k) => k > st.hit && t.color === toy.color && t.shape === toy.shape)
    this.ctx.speak(later ? `要先摸${this.label(this.targets[st.hit])}！` : `这是${this.label(toy)}哦！`)
    if (this.targets.length > 1 && later) return
    if (this.cfg.penalty > 0 && !st.penalized && this.ctx.hud().score > 0) {
      st.penalized = true
      this.ctx.addScore(-this.cfg.penalty)
    }
  }

  private maybeHint() {
    if (this.hinted || this.t - this.qAt < this.cfg.hint) return
    const pending = this.ps.filter((p, i) => this.player(i).body && p.doneAt < 0)
    if (!pending.length) return
    this.hinted = true
    const st = pending[0]
    const cur = this.currentTarget(st)
    if (!cur) return
    this.ctx.speak(`${this.label(cur)}在这儿呢！`)
  }

  private cheer(timeout: boolean) {
    this.phase = 'cheer'
    this.phaseAt = this.t
    this.cheerTimeout = timeout
    for (const st of this.ps) if (st.doneAt < 0) st.streak = 0
    this.ctx.setExtra('最多连对', Math.max(...this.ps.map((p) => p.best)))
  }

  // ---------------------------------------------------------------- 绘制

  paint(c: CanvasRenderingContext2D) {
    const seatActive = [0, 1].filter((i) => this.player(i).body)
    if (!seatActive.length) {
      outlineTxt(c, '站到画面中间，玩具会挂在你身体两边', this.W / 2, this.H * 0.12, 32, 'rgba(255,255,255,.9)')
      return
    }
    for (const i of seatActive) {
      const st = this.ps[i]
      for (let ti = 0; ti < st.toys.length; ti++) this.drawToy(c, st, ti)
    }
    this.drawBar(c)
  }

  private drawToy(c: CanvasRenderingContext2D, st: PState, ti: number) {
    const toy = st.toys[ti]
    const cur = this.currentTarget(st)
    const isTarget = !!cur && cur.color === toy.color && cur.shape === toy.shape
    const born = clamp((this.t - this.qAt) / BORN_T, 0, 1)
    const back = 1 - Math.pow(1 - born, 3)
    const pulse = 1 + Math.sin(this.t * 1.7 + ti) * 0.04
    const r = toy.r * back * pulse * (1 + toy.pop * 0.25)
    if (r < 2) return

    c.save()
    c.translate(toy.x, toy.y)
    if (toy.wrong > 0) c.rotate(Math.sin(toy.wrong * 32) * 0.3 * (toy.wrong / 0.6))
    // 白底圆卡
    c.beginPath()
    c.arc(0, 0, r, 0, IDLE_ANGLE)
    c.fillStyle = 'rgba(255,253,243,.94)'
    c.fill()
    c.lineWidth = 4
    c.strokeStyle = COLORS[toy.color].hex
    c.stroke()
    // 形状
    this.drawShape(c, toy.shape, 0, 0, r * 0.62, COLORS[toy.color].hex)
    // 已命中：打勾 + 光晕
    if (toy.hit) {
      c.globalAlpha = 0.9
      glow(c, 0, 0, r * 2, '#ffe066', 0.5)
      txt(c, '✓', 0, -r * 0.72, Math.round(r * 0.8), '#3ddc97')
      c.globalAlpha = 1
    }
    c.restore()

    // 提示态脉冲双环
    if (this.hinted && isTarget && !toy.hit) {
      const p = 0.5 + 0.5 * Math.sin(this.t * 8)
      c.beginPath()
      c.arc(toy.x, toy.y, r * (1.15 + p * 0.12), 0, IDLE_ANGLE)
      c.lineWidth = Math.max(4, r * 0.14)
      c.strokeStyle = `rgba(255,212,59,${0.55 + p * 0.4})`
      c.stroke()
    }
  }

  private drawShape(c: CanvasRenderingContext2D, shape: number, x: number, y: number, s: number, color: string) {
    c.beginPath()
    if (shape === 0) {
      c.arc(x, y, s, 0, IDLE_ANGLE)
    } else if (shape === 1) {
      c.moveTo(x, y - s)
      c.lineTo(x + s * 0.92, y + s * 0.72)
      c.lineTo(x - s * 0.92, y + s * 0.72)
      c.closePath()
    } else if (shape === 2) {
      c.rect(x - s * 0.82, y - s * 0.82, s * 1.64, s * 1.64)
    } else if (shape === 3) {
      star(c, x, y, s, color)
      return
    } else if (shape === 4) {
      c.moveTo(x, y + s * 0.85)
      c.bezierCurveTo(x - s * 1.5, y - s * 0.15, x - s * 0.55, y - s * 1.05, x, y - s * 0.4)
      c.bezierCurveTo(x + s * 0.55, y - s * 1.05, x + s * 1.5, y - s * 0.15, x, y + s * 0.85)
      c.closePath()
    } else {
      // 月亮：外圆 + 反向内圆，用非零环绕规则直接挖出月牙（不能用 destination-out，
      // 那会把下面的摄像头画面一起擦掉）
      c.arc(x, y, s, 0, IDLE_ANGLE)
      c.moveTo(x + s * 0.45 + s * 0.85, y - s * 0.3)
      c.arc(x + s * 0.45, y - s * 0.3, s * 0.85, 0, IDLE_ANGLE, true)
    }
    c.fillStyle = color
    c.fill()
  }

  /** 顶部指令条：目标卡（easy 画色块 / 其他画形状）+ 多目标箭头 */
  private drawBar(c: CanvasRenderingContext2D) {
    const n = this.targets.length
    const cardW = 84
    const w = Math.max(260, 140 + n * (cardW + 34))
    const h = 92
    const x = this.W / 2 - w / 2
    const y = 18
    c.save()
    c.shadowColor = 'rgba(20,24,60,.3)'
    c.shadowBlur = 16
    c.shadowOffsetY = 6
    rr(c, x, y, w, h, 30)
    c.fillStyle = 'rgba(255,253,243,.95)'
    c.fill()
    c.restore()
    txt(c, '📢', x + 46, y + h / 2, 40)
    for (let i = 0; i < n; i++) {
      const t = this.targets[i]
      const cx = x + 110 + i * (cardW + 34) + cardW / 2
      const done = this.ps.every((p, k) => !this.player(k).body || p.hit > i)
      c.beginPath()
      c.arc(cx, y + h / 2, 30, 0, IDLE_ANGLE)
      c.fillStyle = 'rgba(255,255,255,.9)'
      c.fill()
      if (this.ctx.difficulty === 0) {
        circle(c, cx, y + h / 2, 22, COLORS[t.color].hex)
      } else {
        this.drawShape(c, t.shape, cx, y + h / 2, 20, COLORS[t.color].hex)
      }
      if (n > 1) txt(c, String(i + 1), cx - 22, y + h / 2 - 24, 22, '#7c5cff')
      if (done) txt(c, '✓', cx + 22, y + h / 2 + 24, 26, '#3ddc97')
      if (i < n - 1) txt(c, '→', cx + cardW / 2 + 17, y + h / 2, 28, '#9b8fb0')
    }
  }
}

export function createTouchColor(ctx: GameContext): Game {
  return new TouchColor(ctx)
}


export default createTouchColor
