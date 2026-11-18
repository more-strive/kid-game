import { BaseGame, segHit } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { glow, outlineTxt, ring, txt } from '@/core/draw'

type Kind = 'round' | 'oval' | 'crescent'

interface FruitType {
  name: string
  color: string
  color2: string
  flesh: string
  kind: Kind
  leaf: boolean
  points: number
  /** 果汁量 0~1：影响切开的粒子数与滴汁频率（对齐站点 per-fruit wet 值） */
  juice: number
}

/** 对齐站点真实水果表：苹果/橙子 3 分、猕猴桃 4 分、西瓜 5 分；冰冻香蕉单独处理 */
const FRUITS: FruitType[] = [
  { name: '苹果', color: '#ff4d6d', color2: '#c9184a', flesh: '#fff6dc', kind: 'round', leaf: true, points: 3, juice: 0.4 },
  { name: '橙子', color: '#ff9f1c', color2: '#e85d04', flesh: '#ffd27a', kind: 'round', leaf: false, points: 3, juice: 1 },
  { name: '西瓜', color: '#3f8f22', color2: '#1e6e18', flesh: '#ff6b81', kind: 'round', leaf: false, points: 5, juice: 1 },
  { name: '香蕉', color: '#ffd166', color2: '#e8b800', flesh: '#fff3b0', kind: 'crescent', leaf: false, points: 3, juice: 0.12 },
  { name: '猕猴桃', color: '#8a7a4e', color2: '#6b5d38', flesh: '#9ad66b', kind: 'oval', leaf: false, points: 4, juice: 0.85 },
]
const ICE: FruitType = { name: '冰冻香蕉', color: '#8fd3ff', color2: '#5db6e8', flesh: '#e6f7ff', kind: 'crescent', leaf: false, points: 3, juice: 0.2 }

/** 对齐站点真实难度表：投掷间隔 / 每波数量 / 手速门槛 / 炸弹率 / 冰冻率 / 半径 / 滞空秒数 */
const DIFF = [
  { every: 2.3, burst: [1, 2], minSpeed: 0.35, bomb: 0.07, ice: 0.07, r: 62, hang: 2.1 },
  { every: 2.0, burst: [1, 3], minSpeed: 0.5, bomb: 0.13, ice: 0.06, r: 54, hang: 1.9 },
  { every: 1.6, burst: [2, 4], minSpeed: 0.6, bomb: 0.2, ice: 0.05, r: 46, hang: 1.7 },
]

const COMBO_WIN = 0.35 // 连击时间窗：窗内连切 ≥2 个，结束时奖励 n×3（对齐站点）
const SLOW_T = 3.2 // 冰冻慢动作时长（秒）
const SLOW_K = 0.45 // 慢动作全局时间流速
const RECUT_MIN = 0.12 // 补刀最早：切开后 0.12s 内不可再切
const RECUT_MAX = 2.2 // 补刀最晚：块龄超过 2.2s 不可再切
const HAND_R = 20 // 手部判定半径（与手光标圆环一致，避免“看着碰到却不切”）
const HAND_FWD = 0.3 // 判定点从手腕沿肘→腕方向前移的比例（×前臂长），逼近手掌中心
const SPEED_K = 0.6 // 速度门槛放宽系数（归一化速度横向天然偏小）
const TOUCH_HOLD = 0.1 // 手贴住水果超过该秒数也触发切割（慢手兜底，秒）

/** 一个切面：a 是切线在水果局部坐标里的角度，s 表示保留哪一侧（1 保留 y>0，-1 保留 y<0） */
interface Clip {
  a: number
  s: number
}

interface Fruit {
  x: number
  y: number
  vx: number
  vy: number
  /** 该水果自己的重力（由滞空时长反推，对齐站点 per-difficulty hang） */
  g0: number
  r: number
  fullR: number
  type: FruitType
  rot: number
  spin: number
  alive: boolean
  bomb: boolean
  life: number
  /** 0=整果 1=半块 2=小块；≥2 不可再切 */
  gen: number
  clips: Clip[]
  /** 创建这块的刀的 stroke id；补刀必须换刀（不同 stroke） */
  stroke: number
  /** 出生后的块龄（秒），补刀窗口用 */
  age: number
  /** 湿度：>0 时空中滴汁并指数衰减 */
  wet: number
  dripT: number
  /** 归属玩家：只能切自己那波（对齐站点 owner 隔离） */
  owner: number
  /** 手持续贴住的累计秒数：慢速按上去也能切（兜底容错） */
  touchT: number
}

/** 单只手的挥刀状态：方向反转（点积 < 0）或停手后重新挥动 → 新的一刀 */
interface StrokeState {
  dir: { x: number; y: number } | null
  id: number
}

function drawFruit(c: CanvasRenderingContext2D, r: number, t: FruitType) {
  const g = c.createRadialGradient(-r * 0.3, -r * 0.35, r * 0.15, 0, 0, r)
  g.addColorStop(0, t.color)
  g.addColorStop(1, t.color2)

  if (t.kind === 'crescent') {
    c.beginPath()
    c.arc(0, 0, r * 1.05, 0.35 * Math.PI, 1.65 * Math.PI)
    c.arc(-r * 0.15, 0, r * 0.72, 1.5 * Math.PI, 0.5 * Math.PI, true)
    c.closePath()
    c.fillStyle = g
    c.fill()
    if (t === ICE) {
      // 冰冻香蕉：加一点雪花高光
      c.fillStyle = 'rgba(255,255,255,.8)'
      c.beginPath()
      c.arc(-r * 0.1, -r * 0.75, r * 0.14, 0, Math.PI * 2)
      c.fill()
    }
    return
  }

  const rx = t.kind === 'oval' ? r * 0.78 : r
  const ry = t.kind === 'oval' ? r * 1.06 : r
  c.beginPath()
  c.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2)
  c.fillStyle = g
  c.fill()

  // 西瓜条纹
  if (t.name === '西瓜') {
    c.strokeStyle = '#1e6e18'
    c.lineWidth = r * 0.09
    for (const k of [-0.55, 0, 0.55]) {
      c.beginPath()
      c.ellipse(k * r, 0, r * 0.16, ry * 0.92, 0, 0, Math.PI * 2)
      c.stroke()
    }
  }

  // 高光
  c.beginPath()
  c.ellipse(-rx * 0.34, -ry * 0.36, rx * 0.22, ry * 0.16, -0.6, 0, Math.PI * 2)
  c.fillStyle = 'rgba(255,255,255,.5)'
  c.fill()

  // 叶子/梗
  if (t.leaf) {
    c.strokeStyle = '#6b3e26'
    c.lineWidth = r * 0.12
    c.lineCap = 'round'
    c.beginPath()
    c.moveTo(0, -ry * 0.85)
    c.lineTo(0, -ry * 1.12)
    c.stroke()
    c.beginPath()
    c.ellipse(r * 0.34, -ry * 1.02, r * 0.3, r * 0.14, -0.5, 0, Math.PI * 2)
    c.fillStyle = '#4caf50'
    c.fill()
  }
}

/** 画水果块：没切过（clips 为空）就是整果；切过则按每个切面裁掉另一半，并沿切线画出果肉截面 */
function drawPiece(c: CanvasRenderingContext2D, fullR: number, t: FruitType, clips: Clip[]) {
  if (!clips.length) {
    drawFruit(c, fullR, t)
    return
  }
  const M = fullR * 2.4
  c.save()
  c.beginPath()
  for (const cl of clips) {
    c.save()
    c.rotate(cl.a)
    c.rect(-M, cl.s > 0 ? 0 : -M, M * 2, M)
    c.restore()
  }
  c.clip()
  drawFruit(c, fullR, t)
  for (const cl of clips) {
    c.save()
    c.rotate(cl.a)
    c.beginPath()
    c.ellipse(0, 0, fullR * 0.8, fullR * 0.15, 0, 0, Math.PI * 2)
    c.fillStyle = t.flesh
    c.fill()
    c.beginPath()
    c.ellipse(0, 0, fullR * 0.55, fullR * 0.08, 0, 0, Math.PI * 2)
    c.fillStyle = 'rgba(255,255,255,.5)'
    c.fill()
    c.restore()
  }
  c.restore()
}

/**
 * 手掌判定点相对手腕的偏移（归一化坐标）。
 * 姿态检测只给到手腕，而孩子眼里的“手”是手掌/手指，比手腕靠前半个手掌，
 * 沿肘→腕方向外推 ~0.3 个前臂长（夹在 0.012~0.05 之间，手臂朝镜头时不至于乱飞）。
 */
function palmOffset(b: Body, side: 0 | 1) {
  const w = side === 0 ? b.lHand : b.rHand
  const e = side === 0 ? b.lElbow : b.rElbow
  const dx = w.x - e.x
  const dy = w.y - e.y
  const len = Math.hypot(dx, dy)
  if (len < 1e-4) return { x: 0, y: 0 }
  const k = Math.min(0.05, Math.max(0.012, len * HAND_FWD))
  return { x: (dx / len) * k, y: (dy / len) * k }
}

function drawBomb(c: CanvasRenderingContext2D, r: number, t: number) {
  const g = c.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.1, 0, 0, r)
  g.addColorStop(0, '#4a4a5c')
  g.addColorStop(1, '#16161f')
  c.beginPath()
  c.arc(0, 0, r, 0, Math.PI * 2)
  c.fillStyle = g
  c.fill()
  c.beginPath()
  c.ellipse(-r * 0.32, -r * 0.34, r * 0.18, r * 0.12, -0.6, 0, Math.PI * 2)
  c.fillStyle = 'rgba(255,255,255,.35)'
  c.fill()
  // 引信
  c.strokeStyle = '#8a6a3a'
  c.lineWidth = r * 0.15
  c.lineCap = 'round'
  c.beginPath()
  c.moveTo(r * 0.12, -r * 0.9)
  c.quadraticCurveTo(r * 0.5, -r * 1.35, r * 0.2, -r * 1.55)
  c.stroke()
  // 火花
  const spark = 0.7 + Math.sin(t * 18) * 0.3
  c.beginPath()
  c.arc(r * 0.2, -r * 1.55, r * 0.26 * spark, 0, Math.PI * 2)
  c.fillStyle = '#ffcc33'
  c.fill()
  c.beginPath()
  c.arc(r * 0.2, -r * 1.55, r * 0.13 * spark, 0, Math.PI * 2)
  c.fillStyle = '#fff6cc'
  c.fill()
}

class FruitSlash extends BaseGame implements Game {
  fruits: Fruit[] = []
  score = 0
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  /** 每个玩家的投掷倒计时 */
  spawnT = [1.0, 1.01]
  /** 连击：0.35s 窗内连切计数 + 剩余窗口 */
  comboN = 0
  comboT = 0
  /** 冰冻慢动作剩余时长（真实时间） */
  slowT = 0
  /** 大横幅剩余时长 / 文案 / 颜色 */
  bannerT = 0
  bannerText = ''
  bannerColor = '#fff'
  /** 炸弹震屏剩余时长 */
  shakeT = 0
  /** 每玩家每只手的挥刀状态 */
  strokes: StrokeState[][] = [
    [{ dir: null, id: 0 }, { dir: null, id: 0 }],
    [{ dir: null, id: 0 }, { dir: null, id: 0 }],
  ]
  /** 结算统计（对齐站点：切中率/一刀最多/补刀/碰炸弹） */
  stats = [
    { thrown: 0, cut: 0, cut2: 0, bombs: 0, maxCombo: 0 },
    { thrown: 0, cut: 0, cut2: 0, bombs: 0, maxCombo: 0 },
  ]
  sliceFx: { x: number; y: number; a: number; life: number; color: string }[] = []

  tick(_f: PoseFrame, dtE: number) {
    // 慢动作剩余时长按真实时间递减（对齐站点：q 用未缩放 dt 递减）
    const realDt = this.lastRealDt
    this.slowT = Math.max(0, this.slowT - realDt)
    this.bannerT = Math.max(0, this.bannerT - realDt)
    this.shakeT = Math.max(0, this.shakeT - realDt)

    // 连击窗口到期 → 结算奖励（≥2 个才有，n×3 分）
    if (this.comboT > 0) {
      this.comboT -= realDt
      if (this.comboT <= 0) this.settleCombo()
    }

    // 投掷（每个玩家独立节奏：every ×(1−0.25×heat)×(0.75~1.25 随机)）
    const heat = Math.min(1, this.t / 60)
    for (let pi = 0; pi < 2; pi++) {
      this.spawnT[pi] -= dtE
      if (this.spawnT[pi] <= 0) {
        this.throwWave(pi)
        this.spawnT[pi] = this.cfg.every * (1 - 0.25 * heat) * (0.75 + Math.random() * 0.5)
      }
    }

    // 物理（慢动作时 dtE 已缩放）
    for (const fr of this.fruits) {
      if (!fr.alive) continue
      fr.vy += fr.g0 * dtE
      fr.x += fr.vx * dtE
      fr.y += fr.vy * dtE
      fr.rot += fr.spin * dtE
      fr.life -= dtE
      if (fr.gen > 0) {
        fr.age += dtE
        // 湿块在空中滴汁（每秒 30×wet 滴，湿度指数衰减）
        if (fr.wet > 0.03) {
          fr.dripT += dtE * 30 * fr.wet
          fr.wet *= Math.exp(-3.4 * dtE)
          while (fr.dripT >= 1) {
            fr.dripT--
            this.particles.burst(fr.x, fr.y, fr.type.flesh, 1, 90, 2.5)
          }
        }
      }
      if (fr.y > this.H + 130 || fr.life <= 0) fr.alive = false
    }

    // 手部轨迹先统一算好（含手掌前移）：命中判定与“贴住计时”共用，避免两只手互相抵消
    const present = this.players.filter((p) => p.body).length
    const solo = present <= 1
    const minSpeed = this.cfg.minSpeed * SPEED_K
    const paths: {
      pi: number
      stroke: number
      speed: number
      ax: number
      ay: number
      zx: number
      zy: number
      swipe: number
      dir: { x: number; y: number }
    }[] = []
    for (const pv of this.players) {
      const b = pv.body
      if (!b) continue
      for (let hi = 0; hi < 2; hi++) {
        const c = hi === 0 ? pv.lHand : pv.rHand
        const speed = hi === 0 ? b.lHandV : b.rHandV
        const strokeId = this.updateStroke(pv.id, hi, speed, c.trail)
        if (c.trail.length < 2) continue
        // 判定点 = 手掌中心（手腕沿前臂方向外移），与孩子看到的手一致
        const off = palmOffset(b, hi === 0 ? 0 : 1)
        const ox = off.x * this.W
        const oy = off.y * this.H
        const a = c.trail[c.trail.length - 2]
        const z = c.trail[c.trail.length - 1]
        const ax = a.x + ox
        const ay = a.y + oy
        const zx = z.x + ox
        const zy = z.y + oy
        const len = Math.hypot(zx - ax, zy - ay) || 1
        paths.push({
          pi: pv.id,
          stroke: strokeId,
          speed,
          ax,
          ay,
          zx,
          zy,
          swipe: Math.atan2(zy - ay, zx - ax),
          dir: { x: (zx - ax) / len, y: (zy - ay) / len },
        })
      }
    }

    // 贴住计时：任意一只手压在上面就累加，全部离开才衰减（慢手兜底，不靠挥速）
    for (const fr of this.fruits) {
      if (!fr.alive || fr.bomb) continue
      const touching = paths.some((p) => segHit(p.ax, p.ay, p.zx, p.zy, fr.x, fr.y, fr.r + HAND_R))
      fr.touchT = touching ? fr.touchT + this.lastRealDt : Math.max(0, fr.touchT - this.lastRealDt * 3)
    }

    // 命中判定（炸弹无手速门槛；水果要够快或贴住够久；补刀要换刀方向 + 时间窗）
    for (const p of paths) {
      const fast = p.speed >= minSpeed
      for (const fr of this.fruits) {
        if (!fr.alive) continue
        // 单人时忽略归属：误检出第二个人也不会让自己的水果变成“切不动”
        if (!solo && fr.owner !== p.pi) continue
        // 炸弹判定单独收窄：不该因为放宽水果手感而让人更容易误炸
        if (fr.bomb) {
          if (segHit(p.ax, p.ay, p.zx, p.zy, fr.x, fr.y, fr.r * 0.9 + HAND_R * 0.5)) this.explode(fr)
          continue
        }
        const hit = segHit(p.ax, p.ay, p.zx, p.zy, fr.x, fr.y, fr.r + HAND_R)
        if (fr.gen === 0) {
          if (!hit) continue
          if (!fast && fr.touchT < TOUCH_HOLD) continue
          this.cutFruit(fr, p.pi, p.swipe, p.dir, Math.max(p.speed, minSpeed), p.stroke)
        } else {
          // 补刀：块龄窗口 + 必须换刀方向
          if (!hit || !fast) continue
          if (fr.gen >= 2) continue
          if (fr.age < RECUT_MIN || fr.age > RECUT_MAX) continue
          if (fr.stroke === p.stroke) continue
          this.recutPiece(fr, p.pi, p.swipe, p.dir, p.speed, p.stroke)
        }
      }
    }

    this.fruits = this.fruits.filter((fr) => fr.alive)
    for (let i = this.sliceFx.length - 1; i >= 0; i--) {
      const s = this.sliceFx[i]
      s.life -= dtE
      if (s.life <= 0) this.sliceFx.splice(i, 1)
    }
    this.ctx.setScore(this.score)
    this.ctx.setCombo(this.comboN)
    this.ctx.setExtra('补刀', this.stats.reduce((n, s) => n + s.cut2, 0))
    this.ctx.setExtra('炸弹', this.stats.reduce((n, s) => n + s.bombs, 0))
  }

  /** 上次 tick 收到的真实 dt（慢动作缩放前的），供倒计时类状态使用 */
  private lastRealDt = 0
  private realClock = 0

  update(f: PoseFrame, dt: number) {
    // 慢动作：全局时间流速 ×0.45（对齐站点），slowT 本身用真实时间走
    this.lastRealDt = dt
    this.realClock += dt
    const k = this.slowT > 0 ? SLOW_K : 1
    super.update(f, dt * k)
  }

  /** 更新挥刀 stroke：够快才记录；方向反转或停手重挥 → 新刀。返回当前 stroke id */
  private updateStroke(pi: number, hi: number, speed: number, trail: { x: number; y: number }[]) {
    const st = this.strokes[pi][hi]
    if (speed < this.cfg.minSpeed * 0.7) {
      st.dir = null
      return st.id
    }
    if (trail.length < 2) return st.id
    const a = trail[trail.length - 2]
    const z = trail[trail.length - 1]
    let dx = z.x - a.x
    let dy = z.y - a.y
    const len = Math.hypot(dx, dy)
    if (len < 1) return st.id
    dx /= len
    dy /= len
    if (!st.dir || dx * st.dir.x + dy * st.dir.y < 0) st.id++
    st.dir = { x: dx, y: dy }
    return st.id
  }

  /** 该玩家的投掷区：实际只 detected 到一个人 → 宽区；两人各占一半（对齐站点 solo/duo 分区） */
  private zone(pi: number) {
    const present = this.players.filter((p) => p.body).length
    if (present <= 1) {
      const cx = this.players[pi].body ? this.players[pi].body!.shoulderC.x * this.W : this.W / 2
      return { x0: Math.max(this.W * 0.08, cx - this.W * 0.38), x1: Math.min(this.W * 0.92, cx + this.W * 0.38) }
    }
    return pi === 0 ? { x0: this.W * 0.05, x1: this.W * 0.47 } : { x0: this.W * 0.53, x1: this.W * 0.95 }
  }

  /** 抛一波（对齐站点：数量/炸弹率/冰冻率按难度，落点贴近玩家，抛物线顶点 0.14H~0.6H） */
  private throwWave(pi: number) {
    const z = this.zone(pi)
    const b = this.players[pi].body
    const cx = b ? b.shoulderC.x * this.W : (z.x0 + z.x1) / 2
    const torso = b ? Math.max(60, b.scale * this.H * 0.5) : this.H * 0.2
    const n = this.cfg.burst[0] + Math.floor(Math.random() * (this.cfg.burst[1] - this.cfg.burst[0] + 1))
    for (let i = 0; i < n; i++) {
      const roll = Math.random()
      const isBomb = roll < this.cfg.bomb
      const isIce = !isBomb && roll < this.cfg.bomb + this.cfg.ice
      const type = isBomb ? FRUITS[0] : isIce ? ICE : FRUITS[Math.floor(Math.random() * FRUITS.length)]
      const r = this.cfg.r * (isBomb ? 0.95 : 1) * (this.H / 720)
      const x = Math.min(z.x1 - r, Math.max(z.x0 + r, cx + (Math.random() * 2 - 1) * torso * 1.4))
      const apexY = this.H * 0.14 + r + Math.random() * (this.H * 0.6 - (this.H * 0.14 + r))
      const y0 = this.H + r * 1.2
      const d = y0 - apexY
      // 由滞空时长反推初速与重力：上升耗时 = hang/2
      const g0 = (8 * d) / (this.cfg.hang * this.cfg.hang)
      const vy = (-4 * d) / this.cfg.hang
      const vx = (cx - x) * 0.25 + (Math.random() - 0.5) * 80
      this.fruits.push({
        x,
        y: y0,
        vx,
        vy,
        g0,
        r,
        fullR: r,
        type,
        rot: Math.random() * 6,
        spin: (Math.random() - 0.5) * 5,
        alive: true,
        bomb: isBomb,
        life: this.cfg.hang * 1.6,
        gen: 0,
        clips: [],
        stroke: -1,
        age: 0,
        wet: type.juice,
        dripT: 0,
        owner: pi,
        touchT: 0,
      })
      if (!isBomb) this.stats[pi].thrown++
    }
    this.ctx.audio.slash()
  }

  private comboPos = { x: 0, y: 0 }

  /** 切中整果（含冰冻香蕉）：按种类计分 + 连击窗计时 */
  private cutFruit(fr: Fruit, pi: number, swipe: number, dir: { x: number; y: number }, speed: number, strokeId: number) {
    fr.alive = false
    this.stats[pi].cut++
    this.sliceFx.push({ x: fr.x, y: fr.y, a: swipe, life: 0.32, color: fr.type.flesh })
    // 果汁粒子：数量随种类湿度（对齐站点 per-fruit drops）
    const drops = Math.round(6 + 22 * fr.type.juice)
    this.particles.burst(fr.x, fr.y, fr.type.flesh, drops, 300 + 160 * fr.type.juice, 5)
    this.particles.burst(fr.x, fr.y, fr.type.color, Math.round(4 + 8 * fr.type.juice), 260, 3.5)

    if (fr.type === ICE) {
      // 冰冻香蕉：慢动作 3.2s
      this.slowT = SLOW_T
      this.showBanner('❄ 时间变慢！', '#7dd3fc', 1.2)
      this.ctx.audio.good()
      this.particles.burst(fr.x, fr.y, '#e6f7ff', 20, 300, 4)
    } else {
      this.ctx.audio.slash()
    }

    // 连击：0.35s 窗内连切 ≥2，窗结束时一次性奖励 n×3
    if (this.realClock - this.lastCutAt <= COMBO_WIN) this.comboN++
    else this.comboN = 1
    this.lastCutAt = this.realClock
    this.comboT = COMBO_WIN
    this.comboPos = { x: fr.x, y: fr.y }
    this.ctx.setCombo(this.comboN)

    this.say(`+${fr.type.points}`, fr.x, fr.y - 10, '#ffffff', 30)
    this.score += fr.type.points
    this.split(fr, swipe, dir, speed, strokeId)
  }

  private lastCutAt = -10

  /** 连击窗口结束：≥2 个补 n×3 分，≥3 个出横幅（对齐站点文案） */
  private settleCombo() {
    const n = this.comboN
    this.comboN = 0
    this.comboT = 0
    this.ctx.setCombo(0)
    if (n < 2) return
    const bonus = n * 3
    this.score += bonus
    for (let pi = 0; pi < 2; pi++) this.stats[pi].maxCombo = Math.max(this.stats[pi].maxCombo, n)
    this.say(`${n} 连切 +${bonus}`, this.comboPos.x, this.comboPos.y - 60, '#ffd54a', 40)
    if (n >= 3) this.showBanner(`一刀 ${n} 个！`, '#ffd54a', 0.9)
    this.ctx.audio.good()
    this.particles.burst(this.comboPos.x, this.comboPos.y, '#ffd54a', 10 + n * 3, 320, 5)
  }

  /** 补刀半块：+1 分，再分成两小块 */
  private recutPiece(fr: Fruit, pi: number, swipe: number, dir: { x: number; y: number }, speed: number, strokeId: number) {
    fr.alive = false
    this.stats[pi].cut2++
    this.score += 1
    this.say('+1', fr.x, fr.y - 10, '#d9f7be', 26)
    this.sliceFx.push({ x: fr.x, y: fr.y, a: swipe, life: 0.26, color: fr.type.flesh })
    this.ctx.audio.slash()
    this.particles.burst(fr.x, fr.y, fr.type.flesh, Math.round(4 + 10 * fr.type.juice), 260, 4)
    this.split(fr, swipe, dir, speed, strokeId)
  }

  /** 把一块沿切线分成两半（对齐站点分离物理：法线弹开 + 挥动方向平移 + 附加自旋） */
  private split(fr: Fruit, swipe: number, dir: { x: number; y: number }, speed: number, strokeId: number) {
    if (fr.gen >= 2) {
      // 小块再切就碎掉
      this.particles.burst(fr.x, fr.y, fr.type.flesh, 14, 320, 3.5)
      return
    }
    const nx = -Math.sin(swipe)
    const ny = Math.cos(swipe)
    const pushN = Math.min(420, Math.max(240, speed * 250))
    const pushT = Math.min(170, Math.max(70, speed * 60))
    const spinAdd = Math.min(5.5, Math.max(1.2, speed * 2))
    for (const s of [1, -1]) {
      this.fruits.push({
        x: fr.x + nx * s * 10,
        y: fr.y + ny * s * 10,
        vx: fr.vx * 0.5 + nx * s * pushN + dir.x * pushT,
        vy: fr.vy * 0.4 + ny * s * pushN + dir.y * pushT - 80,
        g0: fr.g0,
        r: fr.r,
        fullR: fr.fullR,
        type: fr.type,
        rot: fr.rot,
        spin: fr.spin * 0.5 + s * spinAdd,
        alive: true,
        bomb: false,
        life: Math.max(fr.life, 2.6),
        gen: fr.gen + 1,
        clips: [...fr.clips, { a: swipe - fr.rot, s }],
        stroke: strokeId,
        age: 0,
        wet: Math.min(1, fr.wet + fr.type.juice * 0.5),
        dripT: 0,
        owner: fr.owner,
        touchT: 0,
      })
    }
  }

  /** 炸弹：−10 分 + 连击清零 + 震屏（无手速门槛，碰到就炸） */
  private explode(fr: Fruit) {
    fr.alive = false
    this.stats[fr.owner].bombs++
    this.score = Math.max(0, this.score - 10)
    this.settleCombo()
    this.shakeT = 0.4
    this.showBanner('💣 炸弹！', '#ff6b6b', 0.9)
    this.say('−10', fr.x, fr.y, '#ff6b6b', 40)
    this.ctx.audio.hit()
    this.particles.burst(fr.x, fr.y, '#3d2c4a', 20, 520, 7)
    this.particles.burst(fr.x, fr.y, '#ffb703', 16, 380, 5)
    this.sliceFx.push({ x: fr.x, y: fr.y, a: Math.random() * Math.PI, life: 0.3, color: '#ff5c5c' })
  }

  private showBanner(text: string, color: string, sec: number) {
    this.bannerText = text
    this.bannerColor = color
    this.bannerT = sec
  }

  paint(c: CanvasRenderingContext2D) {
    c.save()
    // 震屏（炸弹）
    if (this.shakeT > 0) {
      const amp = 9 * (this.shakeT / 0.4)
      c.translate(Math.sin(this.realClock * 70) * amp, Math.cos(this.realClock * 63) * amp * 0.6)
    }

    // 慢动作蓝色滤镜
    if (this.slowT > 0) {
      c.save()
      c.globalAlpha = Math.min(0.28, this.slowT * 0.4)
      c.fillStyle = '#8fd3ff'
      c.fillRect(-20, -20, this.W + 40, this.H + 40)
      c.restore()
    }

    // 切开的块（块龄越大越淡，对齐站点 3s 淡出）
    for (const fr of this.fruits) {
      if (fr.gen === 0) continue
      c.save()
      c.globalAlpha = Math.min(1, Math.max(0, 3 - fr.age))
      c.translate(fr.x, fr.y)
      glow(c, 0, 0, fr.fullR * 1.15, fr.type.color, 0.18)
      c.rotate(fr.rot)
      drawPiece(c, fr.fullR, fr.type, fr.clips)
      c.restore()
    }

    // 整果与炸弹
    for (const fr of this.fruits) {
      if (fr.gen > 0) continue
      c.save()
      c.translate(fr.x, fr.y)
      if (fr.bomb) {
        // 炸弹红色脉冲预警圈（对齐站点 sin 闪动）
        c.save()
        c.globalAlpha = 0.25 + Math.sin(this.realClock * 12) * 0.12
        c.fillStyle = '#ff5c5c'
        c.beginPath()
        c.arc(0, 0, fr.r * 1.35, 0, Math.PI * 2)
        c.fill()
        c.restore()
        glow(c, 0, 0, fr.fullR * 1.9, '#ff5c5c', 0.42)
      } else if (fr.type === ICE) {
        c.save()
        c.globalAlpha = 0.3 + Math.sin(this.realClock * 6) * 0.1
        c.fillStyle = '#cfefff'
        c.beginPath()
        c.arc(0, 0, fr.r * 1.3, 0, Math.PI * 2)
        c.fill()
        c.restore()
        glow(c, 0, 0, fr.fullR * 1.6, '#8fd3ff', 0.3)
      } else {
        glow(c, 0, 0, fr.fullR * 1.5, fr.type.color, 0.2)
      }
      c.rotate(fr.bomb ? Math.sin(fr.rot) * 0.2 : fr.rot)
      if (fr.bomb) drawBomb(c, fr.fullR, this.realClock)
      else drawPiece(c, fr.fullR, fr.type, fr.clips)
      c.restore()
    }

    // 刀光
    for (const s of this.sliceFx) {
      const k = s.life / 0.32
      c.save()
      c.translate(s.x, s.y)
      c.rotate(s.a)
      c.globalAlpha = k
      c.strokeStyle = '#fff'
      c.lineWidth = 9 * k
      c.lineCap = 'round'
      c.beginPath()
      c.moveTo(-110 * (1 - k), 0)
      c.lineTo(110 * (1 - k), 0)
      c.stroke()
      c.globalAlpha = 1
      c.restore()
    }
    c.restore()

    // 连击条（0.35s 窗倒计时）
    if (this.comboN >= 2) {
      const pct = Math.max(0, this.comboT / COMBO_WIN)
      c.fillStyle = 'rgba(10,14,40,.42)'
      c.beginPath()
      c.roundRect(this.W / 2 - 118, 22, 236, 56, 28)
      c.fill()
      outlineTxt(c, `连击 ${this.comboN}`, this.W / 2 - 16, 50, 30, '#ffd54a')
      ring(c, this.W / 2 + 86, 50, 18, pct, '#ffd54a', 5)
    }

    // 大横幅（时间变慢 / 一刀 N 个 / 炸弹）
    if (this.bannerT > 0) {
      c.globalAlpha = Math.min(1, this.bannerT / 0.3)
      outlineTxt(c, this.bannerText, this.W / 2, this.H * 0.28, 54, this.bannerColor)
      c.globalAlpha = 1
    }

    if (this.slowT > 0) {
      outlineTxt(c, '❄ 慢动作', this.W / 2, 112, 36, '#7dd3fc')
    }

    txt(c, '半块还能再切一刀（要换个方向挥），冰冻香蕉让时间变慢，炸弹别碰', this.W / 2, this.H - 34, 20, 'rgba(255,255,255,.8)', 'center', 'bold')
  }
}

export default function create(ctx: GameContext) {
  return new FruitSlash(ctx)
}
