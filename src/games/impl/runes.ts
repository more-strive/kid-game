import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, outlineTxt, ring, txt } from '@/core/draw'

/**
 * 魔法符文 / runes（对齐 dongdongpark 真实规则）：
 * 怪物头顶浮着符文从远处走来；把手举过肩 0.3s 进入作画、用腕当笔在空中**一笔**画出同符号、
 * 手放到肩下 0.5T 收笔即识别——画对放闪电消灭（+1/只），画错法杖降回 Lv.1；怪到跟前扣 1 血（共 5 血），
 * 全员破界提前结束。连对 3 笔 Lv2 一笔劈 2 只同符号、6 笔 Lv3 劈全部同符号。
 *
 * 全部字面量沿用站点：walk 行走 12/10/9s、生成间隔 4.2/3.5/3.1s ×(0.85+rng×0.3)（首只 1.2s）、
 * 同屏上限 2/3/3、符号池 4/6/9 种、双符文怪击杀 8/5 后概率 0.3/0.45（easy 永不）、
 * 举手 0.3s 进作画 / 肩下 0.5T 收笔 / 丢手 0.25s 宽限、笔画下限 0.45T 且 ≥6 点（0.25T 以下提示画大点）、
 * 识别分 0.75 置信 / 0.7 在场怪宽容 / 0.6 认出线、教学保护（0 杀且 <30s 怪到达不扣血）、
 * 连对 3/6 升 Lv2/3、失误降 Lv1、到达清连画不降法杖。
 *
 * 与站点的差异（写明待实测）：
 * 1) 站点符号识别器是 sprites 黑盒（$1 家族推断）→ 自研轻量识别器：重采样 32 点 + 质心/最大边归一 +
 *    闭合循环移位 + 直线压扁特判，score = 1 − 平均点距×3，三档阈值沿用站点字面量（需真机校准）；
 * 2) 站点笔尖 = 食指尖（Hand Landmarker 融合进 body）→ 本框架无手指，**笔尖直接用腕点**（站点在食尖
 *    不可见时同样退化为腕点）；举臂/收笔/丢失阈值全部照抄；
 * 3) 怪物/符文/闪电精灵 → 几何绘制；双人共享一个分数（仓库口径）；ai() 演示替身未实装。
 */
type Sym = 'circle' | 'triangle' | 'hline' | 'vline' | 'vee' | 'zigzag' | 'caret' | 'bolt' | 'star'

const POOLS: Sym[][] = [
  ['circle', 'triangle', 'hline', 'vline'],
  ['circle', 'triangle', 'hline', 'vline', 'vee', 'zigzag'],
  ['circle', 'triangle', 'hline', 'vline', 'vee', 'zigzag', 'caret', 'bolt', 'star'],
]

/** 站点三档：行走时长 / 生成间隔 / 同屏上限 / 双符文门槛 / 双符文概率 */
const DIFF = [
  { walk: 12, every: 4.2, maxOn: 2, twoAfter: Infinity, twoP: 0 },
  { walk: 10, every: 3.5, maxOn: 3, twoAfter: 8, twoP: 0.3 },
  { walk: 9, every: 3.1, maxOn: 3, twoAfter: 5, twoP: 0.45 },
]

const HP_MAX = 5
const UP_NEED = 0.3 // 举手进入作画（秒）
const DOWN_LINE = 0.5 // 腕低于肩下 0.5T 收笔
const LOSE_GRACE = 0.25 // 丢骨架宽限（秒）
const STROKE_MIN = 0.45 // 笔画长度下限（×躯干）
const STROKE_HINT = 0.25 // 过小提示线
const SCORE_CONF = 0.75 // 置信分
const SCORE_LENIENT = 0.7 // 在场怪宽容分
const SCORE_MIN = 0.6 // 认出线
const PROTECT_T = 30 // 教学保护（0 杀且 t<30 不扣血）
const WAND_COL = ['#b088f0', '#4cc9f0', '#ffd54a'] // Lv1/2/3 法杖色
const MON_COLS = ['#8f6bd0', '#5aa86b', '#d0805a', '#5a8fd0', '#c05a8f']

interface Pt {
  x: number
  y: number
}

interface Monster {
  id: number
  runes: Sym[]
  col: string
  side: number
  born: number
  hurt: number
  dead: number
}

interface Zoner {
  hp: number
  broken: boolean
  drawing: boolean
  hand: 0 | 1
  stroke: Pt[]
  upT: number
  lostT: number
  monsters: Monster[]
  spawnAt: number
  kills: number
  tries: number
  streak: number
  bestStreak: number
  misses: number
  flash: number
  hint: { text: string; at: number } | null
  after: { pts: Pt[]; ok: boolean; at: number } | null
  rng: () => number
  nextSide: number
}

/** 符号路径（0~1 归一化坐标，一笔） */
const PATHS: Record<Sym, Pt[]> = {
  circle: Array.from({ length: 33 }, (_, i) => {
    const a = (i / 32) * Math.PI * 2
    return { x: 0.5 + Math.cos(a) * 0.42, y: 0.5 + Math.sin(a) * 0.42 }
  }),
  triangle: [
    { x: 0.5, y: 0.05 }, { x: 0.95, y: 0.9 }, { x: 0.05, y: 0.9 }, { x: 0.5, y: 0.05 },
  ],
  hline: [{ x: 0.05, y: 0.5 }, { x: 0.95, y: 0.5 }],
  vline: [{ x: 0.5, y: 0.05 }, { x: 0.5, y: 0.95 }],
  vee: [{ x: 0.05, y: 0.1 }, { x: 0.5, y: 0.9 }, { x: 0.95, y: 0.1 }],
  zigzag: [
    { x: 0.05, y: 0.85 }, { x: 0.28, y: 0.15 }, { x: 0.5, y: 0.85 }, { x: 0.72, y: 0.15 }, { x: 0.95, y: 0.85 },
  ],
  caret: [{ x: 0.05, y: 0.95 }, { x: 0.5, y: 0.1 }, { x: 0.95, y: 0.95 }],
  bolt: [{ x: 0.62, y: 0.05 }, { x: 0.2, y: 0.5 }, { x: 0.52, y: 0.5 }, { x: 0.3, y: 0.95 }],
  star: [
    { x: 0.5, y: 0.02 }, { x: 0.62, y: 0.38 }, { x: 0.98, y: 0.38 }, { x: 0.69, y: 0.6 },
    { x: 0.8, y: 0.97 }, { x: 0.5, y: 0.73 }, { x: 0.2, y: 0.97 }, { x: 0.31, y: 0.6 },
    { x: 0.02, y: 0.38 }, { x: 0.38, y: 0.38 }, { x: 0.5, y: 0.02 },
  ],
}

// ---------- 轻量符号识别 ----------
function resample(pts: Pt[], n = 32): Pt[] {
  if (pts.length < 2) return []
  const d: number[] = [0]
  for (let i = 1; i < pts.length; i++) {
    d.push(d[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y))
  }
  const total = d[d.length - 1]
  if (total < 1e-6) return []
  const out: Pt[] = []
  for (let k = 0; k < n; k++) {
    const target = (total * k) / (n - 1)
    let i = 1
    while (i < d.length && d[i] < target) i++
    const t = d[i] === d[i - 1] ? 0 : (target - d[i - 1]) / (d[i] - d[i - 1])
    out.push({ x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t })
  }
  return out
}

/** 质心居中 + 最大边归一到 1（保纵横比） */
function normalize(pts: Pt[]): Pt[] {
  let cx = 0
  let cy = 0
  for (const p of pts) {
    cx += p.x
    cy += p.y
  }
  cx /= pts.length
  cy /= pts.length
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of pts) {
    minX = Math.min(minX, p.x - cx)
    maxX = Math.max(maxX, p.x - cx)
    minY = Math.min(minY, p.y - cy)
    maxY = Math.max(maxY, p.y - cy)
  }
  const s = Math.max(maxX - minX, maxY - minY, 1e-6)
  return pts.map((p) => ({ x: (p.x - cx) / s, y: (p.y - cy) / s }))
}

function meanDist(a: Pt[], b: Pt[]) {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y)
  return sum / a.length
}

function strokeLen(pts: Pt[]) {
  let L = 0
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  return L
}

/** 闭合形多圈裁剪：路径中段回到起点附近 → 截到第一圈（孩子多描一圈也能认） */
function trimClosed(pts: Pt[]): Pt[] {
  const L = strokeLen(pts)
  if (L < 1e-6 || pts.length < 8) return pts
  const cum: number[] = [0]
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y))
  let bestJ = -1
  let bestD = Infinity
  for (let i = 2; i < pts.length - 2; i++) {
    const frac = cum[i] / L
    if (frac < 0.3 || frac > 0.97) continue
    const d = Math.hypot(pts[i].x - pts[0].x, pts[i].y - pts[0].y)
    if (d < bestD) {
      bestD = d
      bestJ = i
    }
  }
  if (bestJ > 0 && bestD < L * 0.12) return pts.slice(0, bestJ + 1)
  return pts
}

function bbox(pts: Pt[]) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of pts) {
    minX = Math.min(minX, p.x)
    maxX = Math.max(maxX, p.x)
    minY = Math.min(minY, p.y)
    maxY = Math.max(maxY, p.y)
  }
  return { w: maxX - minX, h: maxY - minY, minX, minY, maxX, maxY }
}

/** 对一笔画打 0~1 分（相对模板）：闭合循环移位 + 直线压扁两层特判（站点识别器等价简化） */
function scoreStroke(raw0: Pt[], sym: Sym): number {
  if (raw0.length < 6) return 0
  const raw = trimClosed(raw0)
  const tmpl = normalize(resample(PATHS[sym], 32))
  let input = normalize(resample(raw, 32))
  if (!input.length) return 0
  const bb = bbox(raw)
  const straight = Math.min(bb.w, bb.h) < Math.max(bb.w, bb.h) * 0.4
  const isLine = sym === 'hline' || sym === 'vline'
  if (straight && !isLine) return 0 // 直线笔迹只跟直线模板比（站点特判同款）
  if (straight && isLine) {
    // 把短轴压向中心线再比
    const long = bb.w >= bb.h ? 'x' : 'y'
    input = input.map((p) => ({ x: long === 'x' ? p.x : (p.x * 0.3), y: long === 'x' ? p.y * 0.3 : p.y }))
    input = normalize(input)
  }
  let best = meanDist(input, tmpl)
  best = Math.min(best, meanDist(input, [...tmpl].reverse()))
  // 循环移位起笔（任意位置起笔画同一形状 = 同一符号；站点只对闭合形做，这里无条件做更宽容）
  for (let s = 1; s < 8; s++) {
    const shifted = [...tmpl.slice(s * 4), ...tmpl.slice(0, s * 4)]
    best = Math.min(best, meanDist(input, shifted))
    best = Math.min(best, meanDist(input, [...shifted].reverse()))
  }
  return clamp(1 - best * 3, 0, 1)
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

class Runes extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[0]
  pool = POOLS[this.ctx.difficulty] ?? POOLS[0]
  zoner: Zoner[] = []
  seats = 1
  private seatActive = [false, false]
  U = Math.min(this.W, this.H) / 720

  constructor(ctx: GameContext) {
    super(ctx)
    // 手部检测可用时笔尖升级为食指尖（站点口径；不可用则维持腕点兜底）
    ctx.enableHands().catch(() => undefined)
    for (let i = 0; i < 2; i++) {
      this.zoner.push({
        hp: HP_MAX, broken: false, drawing: false, hand: 0, stroke: [], upT: 0, lostT: 0,
        monsters: [], spawnAt: 1.2, kills: 0, tries: 0, streak: 0, bestStreak: 0, misses: 0,
        flash: 0, hint: null, after: null, rng: mulberry32(7 + i * 100), nextSide: 1,
      })
    }
  }

  tick(f: PoseFrame, dt: number) {
    if (this.seats === 1 && f.bodies[1]) {
      this.seats = 2
    }
    for (let i = 0; i < 2; i++) if (f.bodies[i]) this.seatActive[i] = true
    let allBroken = true
    let anyActive = false
    for (let i = 0; i < 2; i++) {
      const p = this.zoner[i]
      if (!this.seatActive[i]) continue
      anyActive = true
      if (p.flash > 0) p.flash -= dt
      if (p.hint && this.t - p.hint.at > 2.2) p.hint = null
      if (p.after && this.t - p.after.at > 0.8) p.after = null
      this.step(p, f.bodies[i] ?? null, dt, i)
      this.ctx.setExtra(`kills${i}`, p.kills)
      this.ctx.setExtra(`accuracy${i}`, p.tries > 0 ? Math.round((100 * p.kills) / Math.max(1, p.tries)) : 100)
      if (!p.broken) allBroken = false
    }
    if (anyActive && allBroken) this.ctx.finish()
  }

  private step(p: Zoner, b: Body | null, dt: number, idx: number) {
    const T = b ? Math.max(90 * this.U, b.scale * this.H * 1.1) : 120 * this.U
    // —— 怪物行走 / 到达 ——
    for (const m of p.monsters) {
      if (m.dead > 0) {
        m.dead -= dt
        continue
      }
      if (m.hurt > 0) m.hurt -= dt
      const l = (this.t - m.born) / this.cfg.walk
      if (l >= 1) {
        m.dead = 0.4
        if (p.kills === 0 && this.t < PROTECT_T) {
          this.ctx.audio.play('miss', 0.5, 1.2)
          p.hint = { text: '挡住了！举手画' + CN[m.runes[0]], at: this.t }
        } else {
          p.hp--
          p.streak = 0 // 到达清连画（法杖不降）
          p.flash = 0.6
          this.ctx.audio.play('hit', 0.8)
          this.say('-1 ❤', this.W / 2, this.H * 0.3, '#ff5d5d', 40)
          if (p.hp <= 0) {
            p.broken = true
            this.say(this.seats > 1 ? `P${idx + 1} 的结界破了！` : '结界破了！', this.W / 2, this.H * 0.35, '#ff5d5d', 46)
          }
        }
      }
    }
    p.monsters = p.monsters.filter((m) => m.dead > 0 || (this.t - m.born) / this.cfg.walk < 1)
    // —— 生成 ——
    const alive = p.monsters.filter((m) => m.dead <= 0).length
    if (!p.broken && this.t >= p.spawnAt && alive < this.cfg.maxOn) {
      const main = this.pool[Math.floor(p.rng() * this.pool.length)]
      const runes: Sym[] = [main]
      if (p.kills >= this.cfg.twoAfter && p.rng() < this.cfg.twoP) {
        let second = this.pool[Math.floor(p.rng() * this.pool.length)]
        if (second === main) second = this.pool[(this.pool.indexOf(main) + 1) % this.pool.length]
        runes.push(second)
      }
      p.monsters.push({
        id: Math.floor(this.t * 1000) + idx * 100000,
        runes, col: MON_COLS[Math.floor(p.rng() * MON_COLS.length)],
        side: p.nextSide, born: this.t, hurt: 0, dead: 0,
      })
      p.nextSide = -p.nextSide
      p.spawnAt = this.t + this.cfg.every * (0.85 + p.rng() * 0.3)
      this.ctx.audio.play('pop', 0.5, 0.7)
    }

    // —— 作画状态机 ——
    if (!b) {
      p.lostT += dt
      if (p.drawing && p.lostT > LOSE_GRACE) this.stopDraw(p, T)
      return
    }
    p.lostT = 0
    const shY = b.shoulderC.y * this.H
    const wrists = [b.lHand.y * this.H, b.rHand.y * this.H]
    if (!p.drawing) {
      // 选更高的手腕
      p.hand = wrists[0] <= wrists[1] ? 0 : 1
      const wy = wrists[p.hand]
      p.upT = wy < shY ? p.upT + dt : 0
      if (p.upT >= UP_NEED) {
        p.drawing = true
        p.stroke = []
      }
    } else {
      const wy = wrists[p.hand]
      if (wy > shY + T * DOWN_LINE) {
        this.stopDraw(p, T)
        return
      }
      const tip = p.hand === 0 ? b.lHandDet?.index ?? b.lHand : b.rHandDet?.index ?? b.rHand
      const last = p.stroke[p.stroke.length - 1]
      const px = { x: tip.x * this.W, y: tip.y * this.H }
      if (!last || Math.hypot(px.x - last.x, px.y - last.y) > 5) p.stroke.push(px)
    }
  }

  private stopDraw(p: Zoner, T: number) {
    p.drawing = false
    p.upT = 0
    const pts = p.stroke
    p.stroke = []
    p.after = { pts, ok: false, at: this.t }
    const L = strokeLen(pts)
    if (pts.length < 5 || L < T * STROKE_HINT) return // 太小不计
    if (pts.length < 6 || L < T * STROKE_MIN) {
      p.hint = { text: '画大一点！', at: this.t }
      return
    }
    // —— 识别 + 命中选择 ——
    p.tries++
    const scores = this.pool.map((s) => ({ sym: s, score: scoreStroke(pts, s) }))
    scores.sort((a, b2) => b2.score - a.score)
    const best = scores[0]
    if (best.score <= SCORE_MIN) {
      // 低于认出线：什么都没画出来
      p.streak = 0
      p.misses++
      p.hint = { text: '没认出来，画大一点', at: this.t }
      this.ctx.audio.play('miss', 0.5, 0.8)
      return
    }
    const aliveMon = p.monsters.filter((m) => m.dead <= 0)
    // ① 置信候选里优先在场怪符号；② 在场怪符号宽容线；③ 最高分（无怪可打 → 失误）
    let target: Sym | null = null
    const monSyms = new Set(aliveMon.flatMap((m) => m.runes))
    if (best.score >= SCORE_CONF) {
      const monHit = scores.find((s) => s.score >= best.score - 0.06 && monSyms.has(s.sym))
      target = monHit ? monHit.sym : best.sym
    } else {
      const lenient = scores.find((s) => monSyms.has(s.sym) && s.score >= SCORE_LENIENT && s.score >= best.score - 0.04)
      target = lenient ? lenient.sym : best.score >= SCORE_CONF ? best.sym : null
    }
    if (!target) {
      // 没认出来
      p.streak = 0
      p.misses++
      p.hint = { text: '没认出来，画大一点', at: this.t }
      this.ctx.audio.play('miss', 0.5, 0.8)
      return
    }
    const monsters = aliveMon.filter((m) => m.runes[0] === target || (m.runes.length > 0 && m.runes.includes(target)))
    const onField = monsters.length > 0
    if (!onField) {
      // 画得对但没有这样的怪
      p.streak = 0
      p.misses++
      p.hint = { text: `画的是${CN[target]}，可没有这样的怪`, at: this.t }
      this.ctx.audio.play('miss', 0.5, 0.8)
      return
    }
    // —— 命中：按法杖等级劈 N 只同符号怪 ——
    p.after = { pts, ok: true, at: this.t }
    p.streak++
    p.bestStreak = Math.max(p.bestStreak, p.streak)
    const level = 1 + Math.min(2, Math.floor(p.streak / 3))
    const before = 1 + Math.min(2, Math.floor((p.streak - 1) / 3))
    if (level > before) {
      this.say(`法杖升级 Lv.${level}！`, this.W / 2, this.H * 0.2, WAND_COL[level - 1], 36)
      this.ctx.audio.play('combo', 0.7)
    } else {
      this.ctx.audio.play('score', 0.5, 1.1)
    }
    let victims = aliveMon.filter((m) => m.runes.includes(target))
    victims = victims.slice(0, level === 1 ? 1 : level === 2 ? 2 : victims.length)
    let killed = 0
    for (const m of victims) {
      // 只劈「当前待画符文」命中的（双符文怪按顺序）
      if (m.runes[0] !== target) continue
      m.runes.shift()
      if (m.runes.length === 0) {
        m.dead = 0.5
        p.kills++
        killed++
        this.ctx.addScore(1)
        const l = clamp((this.t - m.born) / this.cfg.walk, 0, 1)
        const r = (16 + 52 * (l * l * 0.6 + l * 0.4)) * this.U
        const mx = this.W / 2 + m.side * (0.2 + 0.12 * l) * this.W
        const my = this.H * (0.25 + 0.37 * l)
        void r
        this.particles.burst(mx, my, '#ffd54a', 14, 360, 5)
        this.ctx.audio.play('pop', 0.6, 1.3)
      } else {
        m.hurt = 0.6
        p.hint = { text: '再画一个！', at: this.t }
      }
    }
    if (killed === 0 && victims.length > 0) {
      // 只劈中了双符文怪的副符文 → 按失误处理
      p.streak = 0
    }
  }

  paint(c: CanvasRenderingContext2D) {
    const duo = this.seats > 1
    if (duo) {
      c.strokeStyle = 'rgba(255,255,255,.5)'
      c.lineWidth = 4
      c.setLineDash([12, 12])
      c.beginPath()
      c.moveTo(this.W / 2, this.H * 0.14)
      c.lineTo(this.W / 2, this.H)
      c.stroke()
      c.setLineDash([])
    }
    for (let i = 0; i < 2; i++) {
      const p = this.zoner[i]
      if (!this.seatActive[i]) continue
      const z: Zone = { x0: (i * this.W) / (duo ? 2 : 1), x1: ((i + 1) * this.W) / (duo ? 2 : 1) }
      const cx = (z.x0 + z.x1) / 2
      c.save()
      c.beginPath()
      c.rect(z.x0, 0, z.x1 - z.x0, this.H)
      c.clip()
      // 血量
      for (let h = 0; h < HP_MAX; h++) {
        c.globalAlpha = h < p.hp ? 1 : 0.2
        txt(c, '❤', z.x0 + 26 + h * 30, 40, 24, '#ff6b8a')
        c.globalAlpha = 1
      }
      // 怪物
      for (const m of p.monsters) {
        if (m.dead > 0) continue
        const l = clamp((this.t - m.born) / this.cfg.walk, 0, 1)
        const ease = l * l * 0.6 + l * 0.4
        const r = (16 + 52 * ease) * this.U
        const mx = cx + m.side * (0.2 + 0.12 * l) * (z.x1 - z.x0)
        const my = this.H * (0.25 + 0.37 * l) + Math.sin(this.t * 5 + m.id) * 0.08 * r
        circle(c, mx, my, r, m.hurt > 0 ? '#ffffff' : m.col)
        // 眼睛
        circle(c, mx - r * 0.3, my - r * 0.15, r * 0.12, '#26152c')
        circle(c, mx + r * 0.3, my - r * 0.15, r * 0.12, '#26152c')
        // 头顶符文
        const iconSize = Math.max(16 * this.U, r * 0.55)
        const n = m.runes.length
        m.runes.forEach((sym, ri) => {
          const ix = mx + (ri - (n - 1) / 2) * iconSize * 1.3
          const active = ri === 0
          drawSymbol(c, sym, ix, my - r - iconSize * 0.9, iconSize, active ? '#ffd54a' : '#ffffffaa', 3)
        })
        // 最后 1/4 路程警告环
        if (l > 0.75) {
          c.globalAlpha = 0.4 + Math.sin(this.t * 10) * 0.3
          ring(c, mx, my, r * 1.3, 1, '#ff5d5d', 5)
          c.globalAlpha = 1
        }
      }
      // 笔迹（实时 + 残影）
      if (p.drawing && p.stroke.length > 1) {
        c.strokeStyle = WAND_COL[1 + Math.min(2, Math.floor(p.streak / 3)) - 1]
        c.lineWidth = 8
        c.beginPath()
        c.moveTo(p.stroke[0].x, p.stroke[0].y)
        for (const pt of p.stroke) c.lineTo(pt.x, pt.y)
        c.stroke()
      }
      if (p.after) {
        c.globalAlpha = Math.max(0, 1 - (this.t - p.after.at) / 0.8)
        c.strokeStyle = p.after.ok ? '#6bcb77' : '#9a8ba8'
        c.lineWidth = 8
        c.beginPath()
        c.moveTo(p.after.pts[0].x, p.after.pts[0].y)
        for (const pt of p.after.pts) c.lineTo(pt.x, pt.y)
        c.stroke()
        c.globalAlpha = 1
      }
      // 提示
      if (p.hint) outlineTxt(c, p.hint.text, cx, this.H * 0.62, 26, '#ffffff')
      // 法杖文本
      const lvl = 1 + Math.min(2, Math.floor(p.streak / 3))
      txt(c, `法杖 Lv.${lvl}${p.streak >= 2 ? ` · 连画 ${p.streak}` : ''}`, cx, this.H - 24, 20, WAND_COL[lvl - 1], 'center', 'bold')
      // 红闪
      if (p.flash > 0) {
        c.fillStyle = `rgba(255,80,80,${p.flash * 0.45})`
        c.fillRect(z.x0, 0, z.x1 - z.x0, this.H)
      }
      if (p.broken) {
        c.fillStyle = 'rgba(0,0,0,.25)'
        c.fillRect(z.x0, 0, z.x1 - z.x0, this.H)
      }
      c.restore()
    }
  }
}

interface Zone {
  x0: number
  x1: number
}

/** 符号中文名（识别提示用，站点黑盒表的自拟等价） */
const CN: Record<Sym, string> = {
  circle: '圆圈', triangle: '三角', hline: '横线', vline: '竖线',
  vee: 'V 字', zigzag: 'Z 字', caret: '尖角', bolt: '闪电', star: '星星',
}

/** 在画布上画一个符号（图标用） */
function drawSymbol(c: CanvasRenderingContext2D, sym: Sym, x: number, y: number, size: number, col: string, lw: number) {
  const path = PATHS[sym]
  c.strokeStyle = col
  c.lineWidth = lw
  c.beginPath()
  path.forEach((p, i) => {
    const px = x - size / 2 + p.x * size
    const py = y - size / 2 + p.y * size
    if (i === 0) c.moveTo(px, py)
    else c.lineTo(px, py)
  })
  if (sym === 'circle' || sym === 'star') c.closePath()
  c.stroke()
}

export default function create(ctx: GameContext) {
  return new Runes(ctx)
}
