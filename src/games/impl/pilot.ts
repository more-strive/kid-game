import { BaseGame, updateSeats } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, outlineTxt, txt } from '@/core/draw'

/**
 * 飞行员 / pilot（对齐 dongdongpark 真实规则）：
 * 纸飞机自动前飞，歪身（lean）转弯、抬/放双臂（armLift）升降；穿金环 +1 分（连穿每 5 个横幅），
 * 气球/飞鸟撞上眩晕减速断连穿；双臂放下 0.9 秒进「张翅」被迫下坠（张开即解除，不清分）。
 *
 * 全部字面量沿用站点（实玩参数：ringR×1.35、速度×0.88）：
 * easy v0 7.04→v1 8.8、环半径 2.295；medium 8.36/10.56/1.8225；hard 9.68/12.32/1.4175；
 * 环距 [15,18]/[12,15]/[9.5,12]、障碍概率 .45/.6/.75（锚在两环间 35~65% 处、距航线 ≥2 米 8 次重试）、
 * lean 无死区 ×lat 4.2/4.8/5.4、armLift 死区 0.08 ×vert×1.6 饱和 ±vert（3.2/3.6/4）、
 * 张翅阈值 肩腕距/躯干 ≥0.6（任一臂）、宽限 0.9s、下坠 −1.6、横控 ×0.3、速度 ×0.8、
 * 穿环判定半径 +0.25、障碍深度窗 ±0.6、撞障碍眩晕 0.7/无敌 1.8/slow 0.65/击退 ±2、
 * 50 秒内 v0→v1 线性、种子 rng(7) 双人共赛道、首环 18 米。
 *
 * 与站点的差异（写明待实测）：
 * 1) 站点 motion.lean / motion.armLift 黑盒 → 「肩髋横向偏移」「双腕相对肩高度」代理（与 slalom-ski 同款）；
 * 2) 站点 `big` 大屏演示参数不存在 → 只按实玩参数实现；boost:'sprint' 框架增益站点未出现，不实现
 *    （注意：站点 easy 3★=34 环理论上限约 29，需真机验证可达性）；
 * 3) 精灵全部几何图形绘制；双人共享一个分数（仓库口径）；
 * 4) ai() 演示替身未实装。
 */

interface Ring {
  id: number
  s: number
  x: number
  y: number
  state?: 'passed' | 'missed'
}

interface Hazard {
  id: number
  s: number
  x: number
  y: number
  ax: number
  ay: number
  kind: 'balloon' | 'bird'
  col: string
  dir: number
}

interface Zone {
  cx: number
  w: number
}

interface Flyer {
  s: number
  prevS: number
  x: number
  y: number
  vx: number
  vy: number
  bank: number
  stallT: number
  slow: number
  dizzy: number
  invuln: number
  combo: number
  best: number
  rings: number
  missed: number
  bumps: number
  hit: Set<number>
  saidStall: boolean
  zone: Zone
}

/** 站点三档（已乘实玩修正 ringR×1.35 / v×0.88） */
const DIFF = [
  { v0: 7.04, v1: 8.8, ringR: 2.295, gap: [15, 18] as [number, number], hazard: 0.45, lat: 4.2, vert: 3.2 },
  { v0: 8.36, v1: 10.56, ringR: 1.8225, gap: [12, 15] as [number, number], hazard: 0.6, lat: 4.8, vert: 3.6 },
  { v0: 9.68, v1: 12.32, ringR: 1.4175, gap: [9.5, 12] as [number, number], hazard: 0.75, lat: 5.4, vert: 4 },
]

const BOUND_X = 4.5 // 横向边界
const BOUND_Y0 = 0.3 // 纵向下界
const BOUND_Y1 = 6 // 纵向上界
const STALL_GRACE = 0.9 // 张翅宽限（秒）
const STALL_VY = -1.6 // 张翅下坠速度
const STALL_LAT = 0.3 // 张翅横控倍率
const STALL_SPEED = 0.8 // 张翅速度倍率
const WING_NEED = 0.6 // 张臂阈值：肩腕距/躯干 ≥0.6
const RING_MARGIN = 0.25 // 穿环判定余量
const HZ_WIN = 0.6 // 障碍深度窗
const HZ_R = 0.7 // 障碍碰撞半径
const DIZZY_T = 0.7 // 撞障碍眩晕
const INVULN_T = 1.8 // 无敌
const SLOW_HIT = 0.65 // 撞障碍减速
const FIRST_RING = 18 // 首环距离
const BALLOON_COLS = ['#ff6b6b', '#b08f0f', '#ffa94d', '#ff8fab']

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)

function leanOf(b: Body) {
  const t = Math.max(0.08, b.scale)
  return clamp(((b.shoulderC.x - b.hipC.x) / t) * 2.2, -1, 1)
}
function armLiftOf(b: Body) {
  const t = Math.max(0.08, b.scale)
  const handY = (b.lHand.y + b.rHand.y) / 2
  return clamp(((b.shoulderC.y - handY) / t) * 1.3, -1, 1)
}
function wingsSpread(b: Body, W: number, H: number) {
  const T = Math.max(60, b.scale * H * 1.1)
  const dl = Math.hypot((b.lHand.x - b.lShoulder.x) * W, (b.lHand.y - b.lShoulder.y) * H)
  const dr = Math.hypot((b.rHand.x - b.rShoulder.x) * W, (b.rHand.y - b.rShoulder.y) * H)
  return dl / T >= WING_NEED || dr / T >= WING_NEED
}

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

class Pilot extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[0]
  rings: Ring[] = []
  hazards: Hazard[] = []
  flyers: Flyer[] = []
  seats = 1
  private seatActive = [false, false]
  /** 每个席位最后一次检测到人的时刻（配合 updateSeats 判断离场） */
  private seatSeen = [-9, -9]
  private rng = mulberry32(7)
  private cursor = 0
  private prevX = 0
  private prevY = 2.5
  private nextId = 1

  constructor(ctx: GameContext) {
    super(ctx)
    for (let i = 0; i < 2; i++) {
      this.flyers.push({
        s: 0, prevS: 0, x: 0, y: 2.5, vx: 0, vy: 0, bank: 0,
        stallT: 0, slow: 1, dizzy: 0, invuln: 0,
        combo: 0, best: 0, rings: 0, missed: 0, bumps: 0, hit: new Set(), saidStall: false,
        zone: { cx: this.W / 2, w: this.W },
      })
    }
    this.layout()
    this.gen(FIRST_RING + 200)
  }

  private layout() {
    const n = this.seats
    for (let i = 0; i < 2; i++) {
      const z = this.flyers[i].zone
      z.w = this.W / n
      z.cx = z.w * i + z.w / 2
    }
  }

  /** 赛道生成：首环固定 18 米，之后环位游走 ±2.5/±1.6，障碍锚两环之间（距航线 ≥2 米，8 次重试兜底） */
  private gen(target: number) {
    let lastS = this.rings.length ? this.rings[this.rings.length - 1].s : 0
    let lx = this.prevX
    let ly = this.prevY
    while (this.cursor < target) {
      const x = clamp(lx + (this.rng() - 0.5) * 5, -3.5, 3.5)
      const y = clamp(ly + (this.rng() - 0.5) * 3.2, 1, 5.2)
      const n = this.rings.length === 0 ? FIRST_RING : this.cfg.gap[0] + this.rng() * (this.cfg.gap[1] - this.cfg.gap[0])
      const s = lastS + n
      this.rings.push({ id: this.nextId++, s, x, y })
      if (this.rng() < this.cfg.hazard) {
        const r = 0.35 + this.rng() * 0.3
        const hs = s - n * (1 - r)
        let hx = 0
        let hy = 2.5
        for (let k = 0; k < 8; k++) {
          hx = (this.rng() * 2 - 1) * 3.7
          hy = 0.8 + this.rng() * 4.4
          if (Math.hypot(hx - x, hy - y) >= 2) break
        }
        const balloon = this.rng() < 0.55
        this.hazards.push({
          id: this.nextId++, s: hs, x: hx, y: hy, ax: hx, ay: hy,
          kind: balloon ? 'balloon' : 'bird',
          col: BALLOON_COLS[Math.floor(this.rng() * BALLOON_COLS.length)],
          dir: this.rng() < 0.5 ? -1 : 1,
        })
      }
      lx = x
      ly = y
      lastS = s
      this.cursor = s
    }
    this.prevX = lx
    this.prevY = ly
  }

  tick(f: PoseFrame, dt: number) {
    if (this.seats === 1 && f.bodies[1]) {
      this.seats = 2
      this.layout()
    }
    updateSeats(this.seatActive, this.seatSeen, f.bodies, this.t)
    let maxS = 0
    for (let i = 0; i < 2; i++) {
      if (!this.seatActive[i]) continue // 缺席席位不飞行、不计分（仓库口径）
      const fl = this.flyers[i]
      this.step(fl, f.bodies[i] ?? null, dt)
      maxS = Math.max(maxS, fl.s)
      this.ctx.setExtra(`best${i}`, fl.best)
      this.ctx.setExtra(`rate${i}`, fl.rings + fl.missed > 0 ? Math.round((100 * fl.rings) / (fl.rings + fl.missed)) : 100)
      this.ctx.setExtra(`bumps${i}`, fl.bumps)
    }
    // 障碍游动（气球竖飘 / 飞鸟横摆）
    for (const h of this.hazards) {
      if (h.kind === 'bird') {
        h.x = clamp(h.ax + h.dir * Math.sin(this.t * 1.1 + h.id) * 1.6, -BOUND_X, BOUND_X)
        h.y = h.ay + Math.sin(this.t * 3 + h.id) * 0.2
      } else {
        h.y = h.ay + Math.sin(this.t * 0.8 + h.id) * 0.35
      }
    }
    const keep = Math.min(...this.flyers.map((fl, i) => (this.seatActive[i] ? fl.s : Infinity))) - 30
    this.rings = this.rings.filter((r) => r.s > keep)
    this.hazards = this.hazards.filter((h) => h.s > keep)
    this.gen((maxS > 0 ? maxS : this.cursor) + 200)
  }

  private step(fl: Flyer, b: Body | null, dt: number) {
    fl.prevS = fl.s
    if (fl.dizzy > 0) fl.dizzy -= dt
    if (fl.invuln > 0) fl.invuln -= dt
    // 张翅状态机
    const spread = b ? wingsSpread(b, this.W, this.H) : true
    if (b && !spread) {
      fl.stallT += dt
      if (!fl.saidStall && fl.stallT > STALL_GRACE) {
        fl.saidStall = true
        this.ctx.audio.play('tick', 0.7, 0.6)
        this.say('张开翅膀！', fl.zone.cx, this.H * 0.18, '#ff8fa8', 34)
      }
    } else {
      fl.stallT = 0
      fl.saidStall = false
    }
    const stalling = fl.stallT > STALL_GRACE

    // lean → 横向（无死区），armLift → 纵向（死区 0.08、饱和 ±vert）
    const lean = b ? leanOf(b) : 0
    const lift = b ? armLiftOf(b) : 0
    const lat = this.cfg.lat * (stalling ? STALL_LAT : 1) * (fl.dizzy > 0 ? 0.5 : 1)
    const hv = lean * lat
    fl.vx += (hv - fl.vx) * (1 - Math.exp(-dt * 4))
    let vv = Math.abs(lift) < 0.08 ? 0 : (lift - Math.sign(lift) * 0.08) * this.cfg.vert * 1.6
    vv = clamp(vv, -this.cfg.vert, this.cfg.vert)
    if (stalling) vv = STALL_VY
    fl.vy += (vv - fl.vy) * (1 - Math.exp(-dt * 4))

    // 前进速度
    const slowRate = fl.dizzy > 0 ? 0.4 : 1.8
    fl.slow += (1 - fl.slow) * (1 - Math.exp(-dt * slowRate))
    const v = (this.cfg.v0 + (this.cfg.v1 - this.cfg.v0) * clamp(this.t / 50, 0, 1)) * fl.slow * (stalling ? STALL_SPEED : 1)
    fl.s += v * dt
    fl.x = clamp(fl.x + fl.vx * dt, -BOUND_X, BOUND_X)
    fl.y = clamp(fl.y + fl.vy * dt, BOUND_Y0, BOUND_Y1)
    if (fl.y <= BOUND_Y0 || fl.y >= BOUND_Y1) fl.vy = 0
    fl.bank += (clamp(fl.vx / this.cfg.lat, -1, 1) - fl.bank) * Math.min(1, dt * 6)

    // 穿环
    for (const r of this.rings) {
      if (r.s <= fl.prevS || r.s > fl.s) continue
      if (Math.hypot(fl.x - r.x, fl.y - r.y) < this.cfg.ringR + RING_MARGIN) {
        r.state = 'passed'
        fl.combo++
        fl.rings++
        fl.best = Math.max(fl.best, fl.combo)
        this.ctx.addScore(1)
        this.ctx.audio.play('score', 0.5, 1 + 0.12 * Math.min(4, fl.combo - 1))
        this.particles.burst(fl.zone.cx, this.H * 0.4, '#ffd54a', 10, 260, 4)
        if (fl.combo % 5 === 0) {
          this.say(`连穿 ${fl.combo} 个环！`, fl.zone.cx, this.H * 0.14, this.players[0].color, 34)
          if (this.seats === 1) this.ctx.speak('飞得真棒！')
        }
      } else {
        r.state = 'missed'
        fl.combo = 0
        fl.missed++
        this.ctx.audio.play('miss', 0.4, 1.1)
        this.say('差一点！', fl.zone.cx, this.H * 0.3, '#7a6b8a', 26)
      }
    }
    // 障碍碰撞
    if (fl.invuln <= 0) {
      for (const h of this.hazards) {
        if (fl.hit.has(h.id)) continue
        if (Math.abs(h.s - fl.s) > HZ_WIN) continue
        if (Math.hypot(fl.x - h.x, fl.y - h.y) > HZ_R) continue
        fl.hit.add(h.id)
        fl.bumps++
        fl.dizzy = DIZZY_T
        fl.invuln = INVULN_T
        fl.slow = SLOW_HIT
        fl.combo = 0
        fl.vx = -Math.sign(h.x - fl.x || 1) * 2
        this.ctx.audio.play('hit', 0.7)
        this.particles.burst(fl.zone.cx, this.H * 0.45, h.kind === 'bird' ? '#9a7452' : h.col, 14, 300, 5)
        this.say(h.kind === 'bird' ? '撞到鸟了！' : '撞到气球了！', fl.zone.cx, this.H * 0.28, '#b088f0', 30)
        break
      }
    }
  }

  paint(c: CanvasRenderingContext2D) {
    const n = this.seats
    for (let i = 0; i < 2; i++) {
      const fl = this.flyers[i]
      const z = fl.zone
      const x0 = z.cx - z.w / 2
      if (n === 1 && i === 1) continue
      c.save()
      c.beginPath()
      c.rect(x0, 0, z.w, this.H)
      c.clip()
      this.scenery(c, fl, z)
      // 远→近绘制
      const ppm = Math.min(z.w, this.H) * (n > 1 ? 0.062 : 0.055)
      const planeY = this.H * 0.52
      const items: { dz: number; draw: () => void }[] = []
      for (const r of this.rings) {
        const dz = r.s - fl.s
        if (dz < -2.5 || dz > 80) continue
        items.push({ dz, draw: () => this.ring(c, r, dz, z.cx, planeY, fl, ppm) })
      }
      for (const h of this.hazards) {
        const dz = h.s - fl.s
        if (dz < -2.5 || dz > 80) continue
        items.push({ dz, draw: () => this.hazard(c, h, dz, z.cx, planeY, fl, ppm) })
      }
      items.sort((a, b) => b.dz - a.dz)
      for (const it of items) it.draw()
      this.plane(c, fl, z.cx, planeY, ppm)
      c.restore()
      if (n > 1 && i === 0) {
        c.fillStyle = '#fffdf3'
        c.fillRect(this.W / 2 - 3, 0, 6, this.H)
      }
    }
  }

  /** 透视：前方 1/(1+dz/11)，身后 1+max(−0.6,−dz/20) */
  private kOf(dz: number) {
    return dz >= 0 ? 1 / (1 + dz / 11) : 1 + Math.max(-0.6, -dz / 20)
  }

  private scenery(c: CanvasRenderingContext2D, fl: Flyer, z: Zone) {
    const x0 = z.cx - z.w / 2
    const hy = this.H * 0.4
    const g = c.createLinearGradient(0, 0, 0, hy)
    g.addColorStop(0, '#5cb3f0')
    g.addColorStop(1, '#d6efff')
    c.fillStyle = g
    c.fillRect(x0, 0, z.w, hy)
    circle(c, x0 + z.w * 0.8, this.H * 0.12, 42 * (Math.min(this.W, this.H) / 720), '#fff2a8')
    // 丘陵（双正弦，随距离轻滚）
    c.fillStyle = '#a7d8b0'
    c.beginPath()
    c.moveTo(x0, hy)
    for (let px = 0; px <= z.w; px += 18) {
      const wx = px + fl.s * 8
      c.lineTo(x0 + px, hy - this.H * 0.06 * (1 + Math.sin(wx * 0.009) * 0.6 + Math.sin(wx * 0.023 + 2) * 0.4))
    }
    c.lineTo(x0 + z.w, hy)
    c.closePath()
    c.fill()
    // 草地 + 交替色带
    const gg = c.createLinearGradient(0, hy, 0, this.H)
    gg.addColorStop(0, '#8fd68a')
    gg.addColorStop(1, '#7fcf7a')
    c.fillStyle = gg
    c.fillRect(x0, hy, z.w, this.H - hy)
    c.fillStyle = '#9ddc8f'
    const band = (fl.s * 14) % 24
    for (let k = -1; k < (this.H - hy) / 24 + 1; k++) {
      c.fillRect(x0, hy + k * 24 + band, z.w, 12)
    }
  }

  private ring(c: CanvasRenderingContext2D, r: Ring, dz: number, cx: number, planeY: number, fl: Flyer, ppm: number) {
    const k = this.kOf(dz)
    const sx = cx + (r.x - fl.x) * ppm * k
    const sy = planeY - (r.y - fl.y) * ppm * k
    const rr2 = this.cfg.ringR * ppm * k
    c.strokeStyle = r.state === 'passed' ? '#9aa4b5' : r.state === 'missed' ? '#ff6b6b' : '#ffd54a'
    c.lineWidth = Math.max(3, rr2 * 0.16)
    c.beginPath()
    c.ellipse(sx, sy, rr2, rr2 * 0.5, 0, 0, Math.PI * 2)
    c.stroke()
  }

  private hazard(c: CanvasRenderingContext2D, h: Hazard, dz: number, cx: number, planeY: number, fl: Flyer, ppm: number) {
    const k = this.kOf(dz)
    const sx = cx + (h.x - fl.x) * ppm * k
    const sy = planeY - (h.y - fl.y) * ppm * k
    const s = ppm * k
    if (h.kind === 'balloon') {
      circle(c, sx, sy, s * 0.8, h.col)
      c.strokeStyle = 'rgba(60,40,60,.5)'
      c.lineWidth = 1.5
      c.beginPath()
      c.moveTo(sx, sy + s * 0.8)
      c.lineTo(sx, sy + s * 1.4)
      c.stroke()
    } else {
      const flap = Math.sin(this.t * 9 + h.id) * 0.5
      circle(c, sx, sy, s * 0.4, '#e8834a')
      c.strokeStyle = '#9a7452'
      c.lineWidth = Math.max(2, s * 0.12)
      for (const side of [-1, 1]) {
        c.beginPath()
        c.moveTo(sx, sy)
        c.lineTo(sx + side * s * 0.7, sy + flap * s * 0.5)
        c.stroke()
      }
    }
  }

  private plane(c: CanvasRenderingContext2D, fl: Flyer, cx: number, planeY: number, ppm: number) {
    if (fl.invuln > 0 && Math.floor(this.t * 10) % 2 === 0) return
    const size = ppm * 1.3
    const shake = this.stallNow(fl) ? Math.sin(this.t * 25) * 4 : 0
    c.save()
    c.translate(cx + shake, planeY + shake)
    c.rotate(fl.bank * 0.5)
    // 纸飞机
    c.fillStyle = '#fffdf3'
    c.strokeStyle = this.players[0].color
    c.lineWidth = 2
    c.beginPath()
    c.moveTo(size, 0)
    c.lineTo(-size * 0.8, -size * 0.5)
    c.lineTo(-size * 0.4, 0)
    c.lineTo(-size * 0.8, size * 0.5)
    c.closePath()
    c.fill()
    c.stroke()
    c.restore()
    if (this.stallNow(fl)) {
      outlineTxt(c, '张开翅膀！', cx, planeY - size - 24, 24, '#ff5d5d')
    }
    if (fl.dizzy > 0) {
      for (let k = 0; k < 3; k++) {
        const a = this.t * 7 + (k * Math.PI * 2) / 3
        circle(c, cx + Math.cos(a) * size, planeY - size + Math.sin(a) * size * 0.3, 4, '#ffd54a')
      }
    }
    if (fl.combo >= 2) {
      txt(c, `连穿 ${fl.combo}！`, cx, planeY - size - 8, 18, this.players[0].color, 'center', 'bold')
    }
  }

  private stallNow(fl: Flyer) {
    return fl.stallT > STALL_GRACE
  }
}

export default function create(ctx: GameContext) {
  return new Pilot(ctx)
}
