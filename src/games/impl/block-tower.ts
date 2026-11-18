import { BaseGame, updateSeats } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, txt } from '@/core/draw'

/**
 * 搭积木 / block-tower（对齐 dongdongpark 真实规则）：
 * 斜传送带（0.36 rad）送来积木，握拳（伸指数 0，充能 0.12s）抓住、挪到塔顶、张开手（伸指数 ≥4）
 * 放下；放得越正塔越「稳」——塔是弹簧弯梁（sway 弹簧+风推），永不倒塌，纯堆高比层数。
 *
 * 全部字面量沿用站点：黄区（可放）容差 tol 1.12/1/1（×顶块半宽）、完美 <20% 半宽、
 * 混合比 mix：easy [.45,.4,.15,0] / med [.4,.22,.22,.16] / hard [.3,.15,.25,.3]
 * （四种块 brick .6×.28 / long .9×.22 / cube .42×.36 / narrow .28×.4 躯干）、scale 1.12/1/0.92、
 * 带速 0.3/0.4/0.52 躯干/s（×(1+.15heat)）、出块间隔 4.4/3.8/3.3s ×(0.88+rng×.24)×(1−.12heat)、
 * 风 0/0.45/0.9（时刻表 [99,99]/[12,18]/[7,11] 预生成 30 场、每场 3.2s sin 包络）、
 * 抓取距离 0.3 躯干、手势充能 0.12s（衰减 0.15/0.5）、手持偏移 (h/2+0.08)T、
 * 搬运换手 1.2T、跟丢 0.7s 强制放、放置后冷却 0.35s、塔摆弹簧 −48·sway−1.7·swayV+wind×8×p
 * （clamp ±0.45，p=clamp(塔高/2.2)）、弯梁 Y=sway×(高/2.2)^1.3、重力 12 躯干/s²、
 * 皮带角 0.36 rad、块出生 r=len+0.35、可抓 r≤len−0.1、滑出 r≤−0.06（不罚）、
 * 放置音阶 11 音上行、每 5 层 tada、出生保护 0.21s 不适用（本作无）。
 *
 * 与站点的差异（写明待实测）：
 * 1) 站点手势 gestures[0/1]（fist/thumb/open/none 黑盒）→ 本框架用 HandDet.fingers 自建分类：
 *    0 根伸直=fist（thumb≡fist 同权照抄）、≥4 根=open、其余=none；
 * 2) 手点=掌心（lHandDet/rHandDet.palm，无则退化腕点）；hand.r 按躯干 0.28 估算；
 * 3) 精灵（积木脸/皮带/送块机）→ 几何绘制；双人共享一个分数（仓库口径）；ai() 未实装。
 */
type BlockKind = 'brick' | 'long' | 'cube' | 'narrow'

const KIND_DIM: Record<BlockKind, [number, number]> = {
  brick: [0.6, 0.28], // w×h（躯干）
  long: [0.9, 0.22],
  cube: [0.42, 0.36],
  narrow: [0.28, 0.4],
}
const MIX: BlockKind[][] = [
  ['brick', 'brick', 'brick', 'long', 'cube'], // 权重近似 [.45,.4,.15,0]
  ['brick', 'brick', 'long', 'cube', 'narrow', 'brick', 'cube', 'narrow', 'brick'],
  ['brick', 'long', 'cube', 'narrow', 'long', 'narrow', 'cube', 'narrow', 'brick', 'narrow'],
]
/** 站点三档：黄区容差 / 尺寸倍率 / 带速 / 出块间隔 / 风 / 风时刻表 / 引导 */
const DIFF = [
  { tol: 1.12, scale: 1.12, speed: 0.3, every: 4.4, wind: 0, gap: [99, 99] as [number, number], guide: true },
  { tol: 1, scale: 1, speed: 0.4, every: 3.8, wind: 0.45, gap: [12, 18] as [number, number], guide: true },
  { tol: 1, scale: 0.92, speed: 0.52, every: 3.3, wind: 0.9, gap: [7, 11] as [number, number], guide: false },
]

const BELT_ANG = 0.36
const SPAWN_OFF = 0.35
const GRABBABLE_OFF = 0.1
const GONE_R = -0.06
const GRAB_DIST = 0.3 // 抓取距离（×躯干）
const CHARGE_T = 0.12 // 手势充能（秒）
const HELD_OFF = 0.08 // 手持偏移 (h/2+.08)T
const SWITCH_T = 1.2 // 换手距离（×躯干）
const LOST_T = 0.7 // 跟丢强制放（秒）
const COOL = 0.35 // 放置后冷却
const PERFECT_F = 0.2
const GRAVITY = 12 // 塔空间重力（躯干/s²）
const SWAY_K = 48
const SWAY_D = 1.7
const WIND_TOWER = 8
const SWAY_CAP = 0.45
const BEND_H = 2.2
const WIND_EVENT_T = 3.2
const FIVE_TADA = 5
const DUR = 90

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

const COLS = ['#ff6b6b', '#4cc9f0', '#ffd54a', '#9be15d', '#b088f0', '#ff9f43']

interface StackBlock {
  kind: BlockKind
  x: number // 塔空间横向偏移（躯干）
  col: number
  pop: number // 放置回弹动画
}

interface BeltBlock {
  kind: BlockKind
  r: number // 沿带位置
  col: number
}

interface FlyBlock {
  kind: BlockKind
  x: number
  y: number
  vx: number
  vy: number
  col: number
}

interface Scene {
  blocks: StackBlock[]
  belt: BeltBlock[]
  fly: FlyBlock[]
  anchor: { x: number; y: number }
  T: number
  endL: number
  endR: number
  beltLen: number
  sway: number
  swayV: number
  fist: number
  open: number
  held: { kind: BlockKind; col: number; hx: number; hy: number; lost: number } | null
  cool: number
  spawnIn: number
  nextSpawn: number
  placed: number
  perfect: number
  fallen: number
  lastCol: number
  view: number
  side: number
  hintGrabT: number
  hintHoverT: number
  windPhase: number
  windDir: number
  windUntil: number
  windIdx: number
  windTable: number[]
}

class BlockTower extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[0]
  scenes: Scene[] = []
  seats = 1
  private seatActive = [false, false]
  /** 每个席位最后一次检测到人的时刻（配合 updateSeats 判断离场） */
  private seatSeen = [-9, -9]
  private rng = mulberry32(11)
  private firstGrabSaid = false
  private windSaid = false
  private U = Math.min(this.W, this.H) / 720

  constructor(ctx: GameContext) {
    super(ctx)
    ctx.enableHands().catch(() => undefined)
    // 风时刻表：rng(2) 预生成 30 场
    for (let i = 0; i < 2; i++) {
      const rng2 = mulberry32(2 + i * 40)
      const table: number[] = []
      let acc = this.cfg.gap[0]
      for (let k = 0; k < 30; k++) {
        table.push(acc)
        acc += this.cfg.gap[0] + rng2() * (this.cfg.gap[1] - this.cfg.gap[0])
      }
      const s = this.blankScene(i === 0 ? -1 : 1)
      s.windTable = table
      this.scenes.push(s)
    }
  }

  private blankScene(side: number): Scene {
    const rng0 = mulberry32(1)
    void rng0
    return {
      blocks: [], belt: [], fly: [],
      anchor: { x: this.W / 2, y: this.H * 0.5 },
      T: 160, endL: 0, endR: 0, beltLen: 1.8,
      sway: 0, swayV: 0, fist: 0, open: 0, held: null, cool: 0,
      spawnIn: 0, nextSpawn: 1, placed: 0, perfect: 0, fallen: 0, lastCol: 0,
      view: 0, side, hintGrabT: 0, hintHoverT: 0,
      windPhase: 0, windDir: 0, windUntil: -1, windIdx: 0, windTable: [],
    }
  }

  tick(f: PoseFrame, dt: number) {
    if (this.seats === 1 && f.bodies[1]) this.seats = 2
    updateSeats(this.seatActive, this.seatSeen, f.bodies, this.t)
    const duo = this.seats > 1
    for (let i = 0; i < (duo ? 2 : 1); i++) {
      if (!this.seatActive[i] && !(i === 0)) continue
      this.step(this.scenes[i], f.bodies[i] ?? null, dt)
    }
    if (this.t >= DUR) this.ctx.finish()
  }

  private step(s: Scene, b: Body | null, dt: number) {
    const T = clamp(b ? b.scale * this.H * 1.1 : 160, 70 * this.U, 300 * this.U)
    s.T = T
    if (b) {
      const ax = (b.hipC.x * 0.6 + b.shoulderC.x * 0.4) * this.W
      const ay = (b.hipC.y * 0.6 + b.shoulderC.y * 0.4) * this.H - T
      const k = Math.min(1, dt * 2)
      s.anchor.x += (ax - s.anchor.x) * k
      s.anchor.y += (ay - s.anchor.y) * k
    }
    // —— 风（全局表驱动）——
    let wind = 0
    if (this.cfg.wind > 0) {
      const wt = s.windTable
      if (s.windIdx < wt.length && this.t >= wt[s.windIdx] && this.t > wt[s.windIdx]) {
        if (s.windUntil < this.t) {
          s.windDir = this.rng() < 0.5 ? -1 : 1
          s.windUntil = this.t + WIND_EVENT_T
          s.windIdx++
          if (!this.windSaid) {
            this.windSaid = true
            this.say('起风啦！塔会晃，看准了再放', this.W / 2, this.H * 0.16, '#4cc9f0', 26)
            this.ctx.audio.play('click', 0.5, 0.6)
          }
        }
      }
      if (this.t < s.windUntil) {
        const ph = Math.sin(((s.windUntil - this.t) / WIND_EVENT_T) * Math.PI)
        wind = this.cfg.wind * ph * s.windDir
      }
    }

    // —— 手势充能（fist=0 根伸直，open=≥4 根）——
    const gestureOf = (side: 0 | 1): 'fist' | 'open' | 'none' => {
      const b2 = this.player(side).body as Body | null
      if (!b2) return 'none'
      const det = side === 0 ? b2.lHandDet : b2.rHandDet
      if (!det) return 'none'
      if (det.fingers === 0) return 'fist'
      if (det.fingers >= 4) return 'open'
      return 'none'
    }
    const g0 = gestureOf(0)
    s.fist = g0 === 'fist' ? Math.min(0.999, s.fist + dt / CHARGE_T) : g0 !== 'none' ? Math.max(0, s.fist - dt / 0.15) : Math.max(0, s.fist - dt / 0.5)
    const g1 = gestureOf(1)
    s.open = g1 === 'open' ? Math.min(0.999, s.open + dt / CHARGE_T) : g1 !== 'none' ? Math.max(0, s.open - dt / 0.15) : Math.max(0, s.open - dt / 0.5)

    // 手点（掌心，退化腕点）
    const b0 = this.player(0).body as Body | null
    void b0
    const palmOf = (side: 0 | 1): { x: number; y: number } | null => {
      const b2 = this.player(side).body as Body | null
      if (!b2) return null
      const det = side === 0 ? b2.lHandDet : b2.rHandDet
      const p = det ? det.palm : side === 0 ? b2.lHand : b2.rHand
      return { x: p.x * this.W, y: p.y * this.H }
    }
    const palm0 = palmOf(0)
    const palm1 = palmOf(1)

    // 塔顶（含摆动）
    const towerH = s.blocks.reduce((a, blk) => a + KIND_DIM[blk.kind][1], 0)
    const p = clamp(towerH / BEND_H, 0, 1)
    // 塔摆弹簧
    s.swayV += (-SWAY_K * s.sway - SWAY_D * s.swayV + Math.abs(wind) * WIND_TOWER * p * Math.sign(wind || 1)) * dt
    s.sway = clamp(s.sway + s.swayV * dt, -SWAY_CAP, SWAY_CAP)
    // —— 场景逻辑 ——
    if (s.cool > 0) s.cool -= dt

    if (s.held) {
      // 搬运：跟随最近手
      const candidates = [palm0, palm1].filter(Boolean) as { x: number; y: number }[]
      let bestP: { x: number; y: number } | null = null
      let bd = Infinity
      for (const pp of candidates) {
        const d = Math.hypot(pp.x - s.held.hx, pp.y - s.held.hy)
        if (d < SWITCH_T * T && d < bd) {
          bd = d
          bestP = pp
        }
      }
      if (bestP) {
        s.held.hx = bestP.x
        s.held.hy = bestP.y
        s.held.lost = 0
      } else {
        s.held.lost += dt
        if (s.held.lost > LOST_T) this.releaseInPlace(s, T, wind)
      }
      // 张手放下
      if (s.held && s.open >= 0.999) this.releaseInPlace(s, T, wind)
    } else if (s.cool <= 0 && s.fist >= 0.999 && palm0) {
      // 抓取：最近可抓块
      const side = s.side
      const towerX = s.anchor.x - side * 0.12 * T
      const beltEndX = s.anchor.x + side * 0.72 * T
      const beltEndY = s.anchor.y - 0.25 * T
      let best: { blk: BeltBlock; d: number } | null = null
      for (const blk of s.belt) {
        if (blk.r > s.beltLen - GRABBABLE_OFF * 0 - 0.1) continue // r ≤ len−0.1
        const bx = beltEndX + Math.sin(BELT_ANG) * side * blk.r * T
        const by = beltEndY + Math.cos(BELT_ANG) * blk.r * T
        const d = Math.hypot(palm0.x - bx, palm0.y - by)
        if (d < GRAB_DIST * T && (!best || d < best.d)) best = { blk, d }
      }
      if (best) {
        s.belt.splice(s.belt.indexOf(best.blk), 1)
        s.held = { kind: best.blk.kind, col: best.blk.col, hx: palm0.x, hy: palm0.y, lost: 0 }
        s.cool = 0
        this.ctx.audio.play('pop', 0.3, 1.2)
        if (!this.firstGrabSaid) {
          this.firstGrabSaid = true
          this.ctx.speak('抓住啦，挪到塔顶，张开手')
        }
        void towerX
      }
    }

    // 传送带推进 + 生成
    for (const blk of s.belt) {
      blk.r -= this.cfg.speed * (1 + 0.15 * this.ctx.heat) * dt
    }
    const slid = s.belt.filter((blk) => blk.r <= GONE_R)
    if (slid.length) {
      s.belt = s.belt.filter((blk) => blk.r > GONE_R)
      for (const _ of slid) {
        this.particles.burst(s.anchor.x + s.side * 0.75 * T, s.anchor.y - 0.25 * T, '#cccccc', 4, 160, 3)
      }
    }
    s.nextSpawn -= dt
    if (s.nextSpawn <= 0 && !s.held) {
      s.nextSpawn = this.cfg.every * (0.88 + this.rng() * 0.24) * (1 - 0.12 * this.ctx.heat)
      const kinds = MIX[this.ctx.difficulty] ?? MIX[0]
      const kind = kinds[Math.floor(Math.random() * kinds.length)]
      let col = (s.lastCol + 1 + Math.floor(Math.random() * (COLS.length - 1))) % COLS.length
      s.lastCol = col
      s.belt.push({ kind, r: KIND_DIM[kind][0] + SPAWN_OFF, col })
    }

    // —— 松手后的自由落体块 ——
    for (const fb of s.fly) {
      fb.vy -= GRAVITY * T * dt
      fb.x += wind * 1.6 * T * dt
      fb.x += fb.vx * dt
      fb.y += fb.vy * dt
    }
    this.settleFly(s, T)
    s.fly = s.fly.filter((fb) => fb.y > -4 * T)
  }

  /** 松手：塔顶平面以上 → 预检吸附；以下 → 自由落体 */
  private releaseInPlace(s: Scene, T: number, wind: number) {
    if (!s.held) return
    const [bw, bh] = KIND_DIM[s.held.kind]
    const towerHX = s.anchor.x - s.side * 0.12 * T + s.sway * pOf(s.blocks.length) * T
    const towerTopY = s.anchor.y + 0.85 * T - stackH(s.blocks) * T
    const dim = KIND_DIM[s.held.kind]
    s.cool = COOL
    const blockX = s.held.hx
    const blockY = s.held.hy + (bh / 2 + HELD_OFF) * T
    const topHalf = topW(s.blocks) / 2
    const above = blockY <= towerTopY + 4
    const dxT = (blockX - towerHX) / T
    if (above && Math.abs(dxT) < (topHalf + dim[0] / 2)) {
      // 放上
      const f = Math.abs(dxT) / topHalf
      s.blocks.push({ kind: s.held.kind, x: dxT, col: s.held.col, pop: this.t })
      s.placed++
      if (f < PERFECT_F) {
        s.perfect++
        this.say('完美 +1', blockX, blockY - 30, '#ffd54a', 26)
        this.ctx.audio.play('win', 0.35)
      } else {
        this.ctx.audio.play('score', 0.3, 1 + (s.blocks.length % 11) * 0.06)
      }
      s.swayV += Math.sign(dxT) * f * f * 1.5
      if (s.blocks.length % FIVE_TADA === 0) {
        this.say(`${s.blocks.length} 层啦！`, this.W / 2, this.H * 0.2, this.players[0].color, 34)
        this.ctx.audio.play('win', 0.6)
        this.particles.burst(this.W / 2, this.H * 0.3, '#ffd54a', 30, 420, 5)
      }
    } else if (above) {
      // 预检失败：判歪
      s.fallen++
      this.ctx.audio.play('miss', 0.5, 1.1)
      this.say('歪啦', blockX, blockY - 30, '#ff5d5d', 28)
      s.swayV += Math.sign(dxT) * 0.5
    } else {
      // 顶面以下松手 → 自由落体
      s.fly.push({ kind: s.held.kind, x: blockX, y: blockY, vx: 0, vy: 0, col: s.held.col })
    }
    s.held = null
    void wind
    void bw
  }

  /** 自由落体块下穿塔顶面 → 放置判定 */
  private settleFly(s: Scene, T: number) {
    const towerHX = s.anchor.x - s.side * 0.12 * T + s.sway * pOf(s.blocks.length) * T
    const towerTopY = s.anchor.y + 0.85 * T - stackH(s.blocks) * T
    for (const fb of s.fly) {
      const dim = KIND_DIM[fb.kind]
      const prevY = fb.y - fb.vy * (1 / 120)
      if (prevY <= towerTopY && fb.y >= towerTopY && Math.abs(fb.x - towerHX) < (topW(s.blocks) + dim[0]) / 2) {
        const dxT = (fb.x - towerHX) / T
        const f = Math.abs(dxT) / (topW(s.blocks) / 2)
        if (f <= this.cfg.tol) {
          s.blocks.push({ kind: fb.kind, x: dxT, col: fb.col, pop: this.t })
          s.placed++
          s.swayV += Math.sign(dxT) * f * f * 1.5
        } else {
          s.fallen++
          s.swayV += Math.sign(dxT) * 0.5
        }
        fb.y = -10 * T // 移除
      }
    }
    s.fly = s.fly.filter((fb) => fb.y > -4 * T)
  }

  paint(c: CanvasRenderingContext2D) {
    const duo = this.seats > 1
    const n = duo ? 2 : 1
    for (let pi = 0; pi < n; pi++) {
      const s = this.scenes[pi]
      const z: { x0: number; x1: number } = { x0: (pi * this.W) / n, x1: ((pi + 1) * this.W) / n }
      c.save()
      c.beginPath()
      c.rect(z.x0, 0, z.x1 - z.x0, this.H)
      c.clip()
      const T = s.T
      const towerX = s.anchor.x - s.side * 0.12 * T
      const baseY = Math.min(s.anchor.y + 0.85 * T, this.H - 0.3 * T)
      // 基座
      c.fillStyle = '#8a7cc0'
      c.fillRect(towerX - 0.55 * T, baseY, 1.1 * T, 0.1 * T)
      // 皮带
      const endX = s.anchor.x + s.side * 0.72 * T
      const endY = s.anchor.y - 0.25 * T
      const beltStartX = towerX + s.side * 0.35 * T
      const beltStartY = baseY - 0.1 * T
      c.strokeStyle = '#5a4632'
      c.lineWidth = 6
      c.beginPath()
      c.moveTo(beltStartX, beltStartY)
      c.lineTo(endX, endY)
      c.stroke()
      // 带上的块
      const beltEndXp = s.anchor.x + s.side * 0.72 * T
      const beltEndYp = s.anchor.y - 0.25 * T
      for (const blk of s.belt) {
        const bx = beltEndXp - Math.sin(BELT_ANG) * s.side * blk.r * T
        const by = beltEndYp + Math.cos(BELT_ANG) * blk.r * T
        const dim = KIND_DIM[blk.kind]
        c.save()
        c.translate(bx, by)
        c.rotate(-BELT_ANG * s.side)
        c.fillStyle = COLS[blk.col]
        c.fillRect(-dim[0] * T * 0.5, -dim[1] * T * 0.5, dim[0] * T, dim[1] * T)
        c.restore()
      }
      // 塔（弯梁弯曲）
      let accH = 0
      for (let i = 0; i < s.blocks.length; i++) {
        const blk = s.blocks[i]
        const dim = KIND_DIM[blk.kind]
        const bend = s.sway * Math.pow(clamp(accH / BEND_H, 0, 1), 1.3) * T
        const popK = this.t - blk.pop < 0.3 ? Math.sin(((this.t - blk.pop) / 0.3) * Math.PI) * 0.16 : 0
        const bx = towerX + blk.x * T + bend
        const by = baseY - accH * T
        c.save()
        c.translate(bx, by - dim[1] * T * 0.5)
        c.rotate(Math.atan2((s.sway * Math.pow(clamp((accH + dim[1]) / BEND_H, 0, 1), 1.3) - Math.pow(clamp(accH / BEND_H, 0, 1), 1.3)) * T, dim[1] * T))
        c.scale(1 + popK * 0.5, 1 - popK)
        c.fillStyle = COLS[blk.col]
        c.fillRect(-dim[0] * T * 0.5, -dim[1] * T * 0.5, dim[0] * T, dim[1] * T)
        c.fillStyle = 'rgba(255,255,255,.35)'
        c.fillRect(-dim[0] * T * 0.5, -dim[1] * T * 0.5, dim[0] * T, dim[1] * T * 0.3)
        c.restore()
        accH += dim[1]
      }
      // 层数
      txt(c, `${s.blocks.length}`, towerX + 0.5 * T, baseY - accH * T - 16 * this.U, 18 * this.U, this.players[pi].color, 'left', 'bold')
      // 持块
      if (s.held) {
        const dim = KIND_DIM[s.held.kind]
        c.save()
        c.translate(s.held.hx, s.held.hy + (dim[1] / 2 + HELD_OFF) * T)
        c.rotate(windTilt(s.windUntil, s.windDir, this.t))
        c.fillStyle = COLS[s.held.col]
        c.fillRect(-dim[0] * T * 0.5, -dim[1] * T * 0.5, dim[0] * T, dim[1] * T)
        c.restore()
      }
      // 手势徽章
      if (s.fist > 0.6 || s.open > 0.6) {
        const palmP = this.palmAt(s.fist > 0.6 ? 0 : 1)
        if (palmP) circle(c, palmP.x, palmP.y, 12 * this.U, s.fist > 0.6 ? 'rgba(76,201,240,.5)' : 'rgba(155,225,93,.5)')
      }
      // 风丝
      if (this.t < s.windUntil) {
        c.globalAlpha = 0.4
        for (let k = 0; k < 12; k++) {
          const wy = (k / 12) * this.H
          c.strokeStyle = '#fff'
          c.lineWidth = 2
          c.beginPath()
          c.moveTo(z.x0 + ((k * 53) % 100) * 3, wy)
          c.lineTo(z.x0 + ((k * 53) % 100) * 3 + 40 * this.U, wy)
          c.stroke()
        }
        c.globalAlpha = 1
      }
      txt(c, `${s.placed} 块`, z.x1 - 16, 40, 22, this.players[pi].color, 'right', 'bold')
      c.restore()
    }
    if (duo) {
      c.fillStyle = '#fffdf3'
      c.fillRect(this.W / 2 - 3, 0, 6, this.H)
    }
  }

  private palmAt(side: 0 | 1): { x: number; y: number } | null {
    const b = this.player(side).body as import('@/core/types').Body | null
    if (!b) return null
    const det = side === 0 ? b.lHandDet : b.rHandDet
    const p = det ? det.palm : side === 0 ? b.lHand : b.rHand
    return { x: p.x * this.W, y: p.y * this.H }
  }
}

function windTilt(windUntil: number, windDir: number, now: number) {
  return windUntil > now ? 0.12 * windDir : 0
}
function pOf(layers: number) {
  return clamp(layers / BEND_H, 0, 1)
}
function topW(layers: StackBlock[]) {
  if (!layers.length) return 0.6
  return KIND_DIM[layers[layers.length - 1].kind][0]
}
function stackH(layers: StackBlock[]) {
  return layers.reduce((a, b) => a + KIND_DIM[b.kind][1], 0)
}

export default function create(ctx: GameContext) {
  return new BlockTower(ctx)
}
