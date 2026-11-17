import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, outlineTxt, txt } from '@/core/draw'

/**
 * 荡绳飞跃 / rope-swing（对齐 dongdongpark 真实规则）：
 * 举手（手高过肩 0.4/0.5 躯干）射绳挂上楼缝气球钩做**无损钟摆**（幅值恒定伺服），
 * 荡到「绿区」角度（预计算：1° 扫描 + 900 子步前瞻模拟，能落到下一栋楼顶的角度区间）
 * 放下手（低于肩 0.15/0.1 躯干）凭切线速度飞出去，落到下一栋楼顶 +1 栋（一次飞 ≥2 栋 +n 高风险高收益），
 * 飞不到被楼缝蹦床接住弹回（不扣分）。迟松手回溯 late 秒、提前松手 early 秒自动等待。
 *
 * 全部字面量沿用站点：楼缝宽 [2.8,3.6]/[3.4,4.4]/[4,5.2]（+0.4×min(1,序号/24) 递增）、
 * 高度差 ±0.8/1.2/1.6（楼高 6.5~12.5）、挂钩高 2.3~2.6/2~2.4/1.8~2.2 于较高楼顶、
 * 摆幅 52~60/55~66/58~72°（窄楼 +8°，夹 20~80°）、窄楼概率 0.1/0.25/0.3（宽 1.7~2.2）、
 * 重力 11/13/16、举手 grab 0.4/0.5 躯干、松手 release 0.15/0.1 躯干（迟滞双阈值防抖）、
 * 提前宽限 0.15/0.08/0s、迟松回溯 0.2/0.12/0.06s（历史 36 条=0.3s）、射绳 0.24s、
 * 落地站稳 0.32s、蹦床弹回 1.15s、屋顶行走 3.2m/s、撞墙半宽 0.28、子步 1/120（≤12 步/帧）、
 * 首楼 x=-7 w=7 h=9、蹦床高度 = 较低楼顶 −2.3、挂钩挂缝内 42~50%、保底 60 次迭代可解。
 *
 * 与站点的差异（写明待实测）：
 * 1) 手部输入 = 双手取 lift 最大值（lift = (肩心y − 手y)/躯干），无手势/握拳（站点同款）；
 * 2) 精灵（角色/楼/气球/蹦床）→ 几何绘制；绿区弧带按扫描区间画；
 * 3) 双人各一座独立城市（rng 种子错位）、共享一个分数（仓库口径，站点各自计分）；
 * 4) ai() 演示替身未实装。
 */
interface Building {
  x: number
  w: number
  h: number
  narrow: boolean
}

interface Hook {
  ax: number // 挂钩 x（米，世界坐标）
  ay: number // 挂钩 y（米，向上为正）
  L: number // 绳长
  th0: number // 起始角（弧度，负=身后）
  thM: number // 摆幅
  gap: number // 缝宽
  zones: { lo: number; hi: number; land: number }[] // 预计算绿/黄区（弧度区间）
  balloonSeed: number
}

type Mode = 'walk' | 'ready' | 'zip' | 'swing' | 'fly' | 'land' | 'bounce'

interface City {
  buildings: Building[]
  hooks: Hook[]
  k: number // 当前楼序号
  mode: Mode
  modeAt: number
  x: number // 角色 x
  y: number // 角色脚 y
  th: number
  om: number
  thM: number
  L: number
  ax: number
  ay: number
  hist: { th: number; om: number }[]
  swings: number
  up: boolean
  lift: number
  pending: number
  vx: number
  vy: number
  streak: number
  best: number
  good: number
  releases: number
  skips: number
  falls: number
  bonk: number
  spot: number
}

/** 站点三档 */
const DIFF = [
  { gap: [2.8, 3.6] as [number, number], dh: 0.8, hook: [2.3, 2.6] as [number, number], amp: [52, 60] as [number, number], narrow: 0.1, g: 11, grab: 0.4, release: 0.15, early: 0.15, late: 0.2, hint: true },
  { gap: [3.4, 4.4] as [number, number], dh: 1.2, hook: [2, 2.4] as [number, number], amp: [55, 66] as [number, number], narrow: 0.25, g: 13, grab: 0.5, release: 0.1, early: 0.08, late: 0.12, hint: true },
  { gap: [4, 5.2] as [number, number], dh: 1.6, hook: [1.8, 2.2] as [number, number], amp: [58, 72] as [number, number], narrow: 0.3, g: 16, grab: 0.5, release: 0.1, early: 0, late: 0.06, hint: false },
]

const FOOT_OFF = 0.6 // 角色脚底距楼顶
const WALL_HALF = 0.28 // 撞墙角色半宽（米）
const SUB = 1 / 120 // 物理子步
const SUB_MAX = 12
const WALL_PAD = 0.22 // 落楼横向裕量
const WALK_V = 3.2 // 屋顶行走速度
const ZIP_T = 0.24 // 射绳时长
const LAND_T = 0.32 // 落地站稳
const BOUNCE_T = 1.15 // 蹦床抛物线
const HIST_N = 36 // 摆动历史（0.3s）
const ROPE_COL = '#ffb347'
const DEG = Math.PI / 180
const DUR = 75

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

/** 城市生成 + 绿区预计算 + 摆/飞物理（每玩家一座独立实例） */
class City {
  buildings: Building[] = []
  hooks: Hook[] = []
  k = 0
  mode: Mode = 'walk'
  modeAt = 0
  x = -0.35
  y = 9 + FOOT_OFF
  th = 0
  om = 0
  thM = 0
  L = 1
  ax = 0
  ay = 0
  hist: { th: number; om: number }[] = []
  swings = 0
  up = false
  lift = -1
  pending = 0
  vx = 0
  vy = 0
  streak = 0
  best = 0
  good = 0
  releases = 0
  skips = 0
  falls = 0
  bonk = 0
  spot = -7 + 7 - 0.35
  lastOmSign = 1

  constructor(rng: () => number, cfg: (typeof DIFF)[number]) {
    // 首楼
    this.buildings.push({ x: -7, w: 7, h: 9, narrow: false })
    let i = 1
    let prevNarrow = false
    let guard = 0
    while (guard++ < 40 && i < 40) {
      this.genNext(i, rng, cfg)
      i++
      prevNarrow = this.buildings[i - 1].narrow
      void prevNarrow
    }
    this.x = this.buildings[0].x + this.buildings[0].w - 0.35
    this.y = this.buildings[0].h + FOOT_OFF
    this.spot = this.x
  }

  /** 生成下一栋楼 + 缝挂钩 + 绿区 */
  private genNext(i: number, rng: () => number, cfg: (typeof DIFF)[number]) {
    const prev = this.buildings[i - 1]
    const gap = (cfg.gap[0] + rng() * (cfg.gap[1] - cfg.gap[0])) + 0.4 * Math.min(1, i / 24)
    const prevNarrow = prev.narrow
    const narrow = i >= 4 && !prevNarrow && rng() < cfg.narrow
    const w = narrow ? 1.7 + rng() * 0.5 : 3.8 + rng() * 2.4
    const h = clamp(prev.h + (rng() * 2 - 1) * cfg.dh - (narrow ? 1 : 0), 6.5, 12.5)
    const x = prev.x + prev.w + gap
    this.buildings.push({ x, w, h, narrow })
    // 挂钩：缝内 42~50%、高于较高楼顶 hook 范围
    const hx = prev.x + prev.w + gap * (0.42 + rng() * 0.08)
    const higher = Math.max(prev.h, h)
    const hy = higher + cfg.hook[0] + rng() * (cfg.hook[1] - cfg.hook[0])
    // 起始点 = 前楼右缘 +0.1，楼顶 +0.95
    const sx = prev.x + prev.w + 0.1
    const sy = prev.h + 0.95
    const L = Math.hypot(sx - hx, sy - hy)
    const th0 = Math.atan2(sx - hx, hy - sy) // 身后为负
    // thM：max(amp, 摆到对面楼沿 +0.5m 的角度, |th0|+12°)，夹 20~80°
    const edgeAngle = Math.asin(clamp((x + 0.5 - hx) / L, -1, 1))
    const thM = clamp(Math.max(cfg.amp[0] + rng() * (cfg.amp[1] - cfg.amp[0]), Math.abs(edgeAngle) * (180 / Math.PI), Math.abs(th0) / DEG + 12) * DEG, 20 * DEG, 80 * DEG)
    // 绿区预计算：1° 扫描 + 前瞻模拟
    const zones: { lo: number; hi: number; land: number }[] = []
    const k = i - 1 // 此缝连接 k 与 k+1
    let cur: { lo: number; hi: number; land: number } | null = null
    for (let deg = -Math.round(thM / DEG); deg <= Math.round(thM / DEG); deg++) {
      const th = deg * DEG
      const om = Math.sign(1) * Math.sqrt(Math.max(0, (2 * cfg.g / L) * (Math.cos(th) - Math.cos(thM))))
      const px = hx + L * Math.sin(th)
      const py = hy - L * Math.cos(th)
      const vx = L * om * Math.cos(th)
      const vy = L * om * Math.sin(th)
      const land = this.predict(px, py, vx, vy, k, cfg.g)
      if (land > k) {
        if (cur && deg - cur.hi / DEG <= 1.5) cur.hi = th
        else {
          cur = { lo: th, hi: th, land }
          zones.push(cur)
        }
        if (cur && land > cur.land) cur.land = land
      } else cur = null
    }
    // 边界 ±0.5° 收缩
    for (const z of zones) {
      z.lo += 0.5 * DEG
      z.hi -= 0.5 * DEG
    }
    this.hooks.push({ ax: hx, ay: hy, L, th0, thM, gap, zones, balloonSeed: i })
    void k
  }

  /** 飞行前瞻：返回落点楼序号（trampoline/出界 → −1） */
  private predict(px: number, py: number, vx: number, vy: number, k: number, g: number): number {
    let x = px
    let y = py
    let cvx = vx
    let cvy = vy
    for (let s = 0; s < 900; s++) {
      cvy -= g * SUB
      x += cvx * SUB
      y += cvy * SUB
      for (let i = Math.max(0, k - 2); i <= Math.min(k + 4, this.buildings.length - 1); i++) {
        const b = this.buildings[i]
        if (x > b.x - WALL_PAD && x < b.x + b.w + WALL_PAD && y - FOOT_OFF <= b.h && y > b.h - 0.3) return i
      }
      if (y < -2) return -1
    }
    return -1
  }

  roofAt(i: number) {
    return this.buildings[clamp(i, 0, this.buildings.length - 1)].h
  }
  roofLeftEdge(i: number) {
    return this.buildings[clamp(i, 0, this.buildings.length - 1)].x
  }
  roofRightEdge(i: number) {
    const b = this.buildings[clamp(i, 0, this.buildings.length - 1)]
    return b.x + b.w
  }
  buildingAt(x: number) {
    for (let i = 0; i < this.buildings.length; i++) {
      const b = this.buildings[i]
      if (x >= b.x && x <= b.x + b.w) return i
    }
    return -1
  }
}

class RopeSwing extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[0]
  cities: City[] = []
  seats = 1
  private seatActive = [false, false]
  private U = Math.min(this.W, this.H) / 720
  private stars: { x: number; y: number; vx: number; vy: number }[] = []

  constructor(ctx: GameContext) {
    super(ctx)
    for (let i = 0; i < 2; i++) {
      this.cities.push(new City(mulberry32(1 + i * 100), this.cfg))
    }
  }

  tick(f: PoseFrame, dt: number) {
    if (this.seats === 1 && f.bodies[1]) {
      this.seats = 2
    }
    for (let i = 0; i < 2; i++) if (f.bodies[i]) this.seatActive[i] = true
    const duo = this.seats > 1
    for (let i = 0; i < (duo ? 2 : 1); i++) {
      if (!this.seatActive[i] && !(i === 0)) continue
      this.step(this.cities[i], f.bodies[i] ?? null, dt, i)
    }
    // 统计
    for (let i = 0; i < 2; i++) {
      const c = this.cities[i]
      if (i === 1 && !duo) continue
      this.ctx.setExtra(`good${i}`, c.good)
      this.ctx.setExtra(`best${i}`, c.best)
      this.ctx.setExtra(`skips${i}`, c.skips)
      this.ctx.setExtra(`falls${i}`, c.falls)
    }
    // 粒子
    for (const s of this.stars) {
      s.vy += 900 * this.U * dt
      s.x += s.vx * dt
      s.y += s.vy * dt
    }
    this.stars = this.stars.filter((s) => s.y < this.H + 30)
    if (this.t >= DUR) this.ctx.finish()
  }

  private step(c: City, b: Body | null, dt: number, idx: number) {
    void idx
    // —— 手部 lift 与迟滞双阈值 ——
    if (b) {
      const T = Math.max(60, b.scale * this.H * 1.1)
      const lifts = [
        b.lHandDet ? (b.shoulderC.y * this.H - b.lHandDet.palm.y) / T : (b.shoulderC.y * this.H - b.lHand.y * this.H) / T,
        b.rHandDet ? (b.shoulderC.y * this.H - b.rHandDet.palm.y) / T : (b.shoulderC.y * this.H - b.rHand.y * this.H) / T,
      ]
      c.lift = Math.max(...lifts)
      if (!c.up && c.lift > this.cfg.grab) c.up = true
      else if (c.up && c.lift < this.cfg.release) c.up = false
    } else {
      c.lift = -1
    }

    const hook = c.hooks[c.k]
    const elapsed = this.t - c.modeAt

    switch (c.mode) {
      case 'walk': {
        c.x += Math.min(WALK_V * dt, Math.max(0, c.spot - c.x))
        c.y = c.roofAt(c.k) + FOOT_OFF
        if (c.x >= c.spot - 0.01) {
          c.mode = 'ready'
          c.modeAt = this.t
          if (this.cfg.hint && this.cities[0] === c && c.k === 0 && this.seats === 1) this.ctx.speak('举起一只手，射出绳子！')
        }
        break
      }
      case 'ready': {
        c.x = c.spot
        c.y = c.roofAt(c.k) + FOOT_OFF
        if (c.up) {
          // 射绳
          c.mode = 'zip'
          c.modeAt = this.t
          this.ctx.audio.play('click', 0.4, 0.8)
          if (this.cfg.hint && this.cities[0] === c && c.k === 0 && this.seats === 1) this.ctx.speak('到绿色的地方，放下手！')
        }
        break
      }
      case 'zip': {
        if (elapsed >= ZIP_T) {
          c.mode = 'swing'
          c.modeAt = this.t
          c.ax = hook.ax
          c.ay = hook.ay
          c.L = hook.L
          c.thM = hook.thM
          c.th = hook.th0
          c.om = Math.sign(1) * Math.sqrt(Math.max(0, (2 * this.cfg.g / c.L) * (Math.cos(c.th) - Math.cos(c.thM))))
          c.hist = []
          c.swings = 0
          c.lastOmSign = 1
        }
        break
      }
      case 'swing': {
        // 固定子步物理 + 能量伺服
        let steps = Math.min(SUB_MAX, Math.ceil(dt / SUB))
        while (steps-- > 0) {
          c.om += (-(this.cfg.g / c.L)) * Math.sin(c.th) * SUB
          const prevTh = c.th
          c.th += c.om * SUB
          // 能量伺服：幅值恒等 thM
          if (Math.abs(c.th) < c.thM - 0.03) {
            c.om = Math.sign(c.om || 1) * Math.sqrt(Math.max(0, (2 * this.cfg.g / c.L) * (Math.cos(c.th) - Math.cos(c.thM))))
          }
          const sign = Math.sign(c.om)
          if (sign !== c.lastOmSign && sign !== 0) {
            c.swings++
            this.ctx.audio.play('click', 0.25, 1.1)
            c.lastOmSign = sign
          }
          c.hist.push({ th: c.th, om: c.om })
          if (c.hist.length > HIST_N) c.hist.shift()
          void prevTh
        }
        // 角色位置
        c.x = c.ax + c.L * Math.sin(c.th)
        c.y = c.ay - c.L * Math.cos(c.th) + FOOT_OFF
        // 松手判定 B
        if (!c.up) this.release(c, hook, dt)
        break
      }
      case 'fly': {
        let steps = Math.min(SUB_MAX, Math.ceil(dt / SUB))
        while (steps-- > 0) {
          c.vy -= this.cfg.g * SUB
          c.x += c.vx * SUB
          c.y += c.vy * SUB
          // 撞侧墙
          const bi = c.buildingAt(c.x)
          if (bi >= 0) {
            const bld = c.buildings[bi]
            if (c.y - FOOT_OFF < bld.h - 0.05) {
              if (c.x < bld.x + WALL_HALF && c.vx < 0) {
                c.x = bld.x - WALL_HALF
                c.vx = Math.abs(c.vx) * 0.25
                this.wallHit(c)
              } else if (c.x > bld.x + bld.w - WALL_HALF && c.vx > 0) {
                c.x = bld.x + bld.w + WALL_HALF
                c.vx = -Math.abs(c.vx) * 0.25
                this.wallHit(c)
              }
            }
          }
          // 落楼顶
          for (let i = Math.max(0, c.k - 2); i <= Math.min(c.k + 4, c.buildings.length - 1); i++) {
            const bld = c.buildings[i]
            if (c.x > bld.x - WALL_PAD && c.x < bld.x + bld.w + WALL_PAD && c.y - FOOT_OFF <= bld.h && c.vy <= 0.5) {
              // 落顶
              this.landOn(c, i)
              return
            }
          }
          // 蹦床（缝内，低于较低楼顶 −2.3）
          const low = Math.min(c.roofAt(c.k), c.roofAt(c.k + 1)) - 2.3
          const gapCx = (c.roofLeftEdge(c.k + 1) + c.roofRightEdge(c.k)) / 2
          if (c.x > c.roofRightEdge(c.k) && c.x < c.roofLeftEdge(c.k + 1) && c.y - FOOT_OFF <= low) {
            // 蹦床接住
            c.falls++
            c.streak = 0
            this.ctx.audio.play('pop', 0.5, 1.5)
            this.say('弹回去！', this.W / 2, this.H * 0.4, '#4cc9f0', 28)
            c.mode = 'bounce'
            c.modeAt = this.t
            return
          }
          void gapCx
          if (c.y < -3) {
            // 隐形安全网
            c.falls++
            c.streak = 0
            c.mode = 'bounce'
            c.modeAt = this.t
            return
          }
        }
        break
      }
      case 'land': {
        if (elapsed >= LAND_T) {
          c.mode = 'walk'
          c.modeAt = this.t
          c.spot = c.buildings[c.k].x + c.buildings[c.k].w - 0.35
        }
        break
      }
      case 'bounce': {
        if (elapsed >= BOUNCE_T) {
          c.mode = 'walk'
          c.modeAt = this.t
          c.x = c.buildings[c.k].x + c.buildings[c.k].w - 0.35
          c.spot = c.x
          c.y = c.roofAt(c.k) + FOOT_OFF
        }
        break
      }
    }
  }

  private wallHit(c: City) {
    this.ctx.audio.play('hit', 0.5)
    c.bonk = 0.9
  }

  /** 松手判定 B：区内前向 → 放；迟松回溯；提前宽限；否则照放 */
  private release(c: City, hook: Hook, _dt: number) {
    void _dt
    const k = c.k
    const forward = c.om > 0
    const inZone = (th: number) => hook.zones.find((z) => th >= z.lo && th <= z.hi && z.land > k)
    // ① 当前在区内且向前
    const zNow = forward ? inZone(c.th) : undefined
    if (zNow) {
      this.doRelease(c, c.th, c.om, zNow.land, k)
      return
    }
    // ② 迟松手回溯
    const lookback = this.cfg.late
    if (lookback > 0 && forward) {
      const n = Math.min(c.hist.length, Math.round(lookback / (1 / 120)))
      for (let i = c.hist.length - 1; i >= c.hist.length - n && i >= 0; i--) {
        const hSample = c.hist[i]
        const z2 = inZone(hSample.th)
        if (z2 && hSample.om > 0) {
          this.doRelease(c, hSample.th, hSample.om, z2.land, k)
          return
        }
      }
    }
    // ③ 提前宽限：向前、某区入口可达 → pending 等待
    if (forward && this.cfg.early > 0) {
      const entry = hook.zones.find((z) => z.land > k && c.th <= z.lo && z.lo - c.th <= this.cfg.early * c.om * 1.2)
      if (entry && c.pending <= 0) c.pending = this.cfg.early + 0.02
    }
    if (c.pending > 0) {
      c.pending -= 1 / 120 * SUB_MAX
      const zNow2 = forward ? inZone(c.th) : undefined
      if (zNow2 || c.om <= 0 || c.pending <= 0) {
        c.pending = 0
        this.doRelease(c, c.th, c.om, forward ? zNow2?.land ?? -1 : -1, k)
        return
      }
    }
    // ④ 都不满足：照样放（乱放多半被蹦床接）
    this.doRelease(c, c.th, c.om, forward ? inZone(c.th)?.land ?? -1 : -1, k)
  }

  private doRelease(c: City, th: number, om: number, land: number, k: number) {
    c.releases++
    c.vx = c.L * om * Math.cos(th)
    c.vy = c.L * om * Math.sin(th)
    c.mode = 'fly'
    c.modeAt = this.t
    c.pending = 0
    this.ctx.audio.play('click', 0.5, 1.3)
    void land
    void k
  }

  private landOn(c: City, i: number) {
    const a = i
    c.mode = 'land'
    c.modeAt = this.t
    c.x = clamp(c.x, c.buildings[i].x + 0.2, c.buildings[i].x + c.buildings[i].w - 0.2)
    c.y = c.buildings[i].h + FOOT_OFF
    c.vx = 0
    c.vy = 0
    if (a > c.k) {
      const inc = a - c.k
      c.good++
      c.streak++
      c.best = Math.max(c.best, c.streak)
      this.ctx.addScore(inc)
      if (inc > 1) {
        c.skips++
        this.say(`+${inc} 飞过一栋！`, this.W / 2, this.H * 0.25, '#ffd54a', 36)
        this.ctx.audio.play('win', 0.5)
      } else {
        this.ctx.audio.play('score', 0.4, 1 + Math.min(8, c.streak) * 0.04)
        this.particles.burst(this.W / 2, this.H * 0.4, '#ffd54a', 8, 240, 4)
      }
      c.k = a
      c.spot = c.buildings[c.k].x + c.buildings[c.k].w - 0.35
      if (c.good % 5 === 0) this.say(`${c.good} 栋！`, this.W / 2, this.H * 0.2, this.players[0].color, 34)
    } else {
      // 落回原楼
      c.streak = 0
      this.ctx.audio.play('miss', 0.4, 1.1)
      this.say('再荡一次', this.W / 2, this.H * 0.3, '#b088f0', 26)
    }
  }

  paint(c: CanvasRenderingContext2D) {
    const duo = this.seats > 1
    const n = duo ? 2 : 1
    for (let pi = 0; pi < n; pi++) {
      const city = this.cities[pi]
      const z: { x0: number; x1: number } = { x0: (pi * this.W) / n, x1: ((pi + 1) * this.W) / n }
      c.save()
      c.beginPath()
      c.rect(z.x0, 0, z.x1 - z.x0, this.H)
      c.clip()
      // 天空
      const g = c.createLinearGradient(0, 0, 0, this.H)
      g.addColorStop(0, '#7cc8ff')
      g.addColorStop(0.6, '#c6ebff')
      g.addColorStop(1, '#ffe3ef')
      c.fillStyle = g
      c.fillRect(z.x0, 0, z.x1 - z.x0, this.H)
      // 相机：跟随角色（简单像素映射：角色保持在 0.42W/0.55H）
      const camX = city.x - (z.x1 - z.x0) * 0.42 / this.ppm(pi)
      const camY = city.y - this.H * 0.55 / this.ppm(pi)
      const ppm = this.ppm(pi)
      const w2s = (wx: number, wy: number) => ({ x: z.x0 + (wx - camX) * ppm, y: this.H - (wy - camY) * ppm })
      // 剪影楼群
      c.fillStyle = '#d8d0f4'
      for (let k = 0; k < 12; k++) {
        const bx = ((k * 97) % 140) * 3 - camX * 0.2 * ppm + z.x0
        const bw = 120 * (1 + (k % 3) * 0.3)
        c.fillRect(bx, this.H * 0.55 - k * 6, bw, this.H)
      }
      // 实体楼
      for (let i = 0; i < city.buildings.length; i++) {
        const b = city.buildings[i]
        const p1 = w2s(b.x, 0)
        const p2 = w2s(b.x + b.w, b.h)
        if (p2.x < z.x0 - 60 || p1.x > z.x1 + 60) continue
        c.fillStyle = i === city.k ? '#8a7cc0' : '#a99ad4'
        c.fillRect(p2.x, p2.y, p1.x - p2.x, p1.y - p2.y)
        // 窗户
        c.fillStyle = 'rgba(255,255,255,.25)'
        const cols = Math.max(1, Math.floor((p1.x - p2.x) / 26))
        const rows = Math.max(1, Math.floor((p1.y - p2.y) / 30))
        for (let wx = 0; wx < cols; wx++) {
          for (let wy = 0; wy < rows; wy++) {
            if ((wx + wy + i) % 3 === 0) c.fillRect(p2.x + 8 + wx * 26, p2.y + 10 + wy * 30, 10, 12)
          }
        }
      }
      // 当前缝的挂钩气球 + 瞄准弧 + 绿/黄区
      const hook = city.hooks[city.k]
      if (hook) {
        const hp = w2s(hook.ax, hook.ay)
        circle(c, hp.x, hp.y, 14 * this.U, '#ff8fab')
        txt(c, '🎈', hp.x, hp.y - 4, 26 * this.U, '#fff')
        // 瞄准弧（白虚线全幅 + 绿/黄区着色）
        const cxp = w2s(hook.ax, hook.ay)
        const drawArc = (lo: number, hi: number, col: string, width: number) => {
          c.strokeStyle = col
          c.lineWidth = width
          c.beginPath()
          c.arc(cxp.x, cxp.y, hook.L * ppm, -Math.PI / 2 - hook.thM + (lo + hook.thM), -Math.PI / 2 - hook.thM + (hi + hook.thM))
          c.stroke()
        }
        c.setLineDash([10, 12])
        drawArc(-hook.thM, hook.thM, 'rgba(255,255,255,.5)', 2)
        c.setLineDash([])
        for (const z2 of hook.zones) {
          const green = z2.land === city.k + 1
          drawArc(z2.lo, z2.hi, green ? '#5fe070' : '#ffd93d', green ? 8 : 6)
        }
        // 松手提示
        if (city.mode === 'swing' && this.cfg.hint) {
          const zNow = hook.zones.find((z3) => city.th >= z3.lo && city.th <= z3.hi && city.om > 0)
          if (zNow) outlineTxt(c, '松手！', cxp.x, cxp.y - 30, 24, '#5fe070')
        }
      }
      // 绳索
      if (city.mode === 'swing' || city.mode === 'zip' || city.mode === 'fly') {
        const hp = w2s(city.ax, city.ay)
        const handX = city.x
        const handY = city.y + 20 * this.U / ppm
        const hp2 = w2s(handX, handY)
        c.strokeStyle = 'rgba(60,40,20,.9)'
        c.lineWidth = Math.max(3, ppm * 0.09)
        c.beginPath()
        c.moveTo(hp.x, hp.y)
        c.lineTo(hp2.x, hp2.y)
        c.stroke()
        c.strokeStyle = ROPE_COL
        c.lineWidth = Math.max(1.5, ppm * 0.045)
        c.stroke()
      }
      // 蹦床
      {
        const low = Math.min(city.roofAt(city.k), city.roofAt(city.k + 1)) - 2.3
        const x1 = w2s(city.roofRightEdge(city.k), low)
        const x2 = w2s(city.roofLeftEdge(city.k + 1), low)
        c.strokeStyle = '#4cc9f0'
        c.lineWidth = 5
        c.beginPath()
        c.moveTo(x1.x, x1.y)
        c.lineTo(x2.x, x2.y)
        c.stroke()
        c.strokeStyle = '#26152c'
        c.lineWidth = 2
        for (const px of [x1.x, x2.x]) {
          c.beginPath()
          c.moveTo(px, x1.y)
          c.lineTo(px, this.groundLine())
          c.stroke()
        }
      }
      // 角色
      const cp = w2s(city.x, city.y)
      const bodyH = 26 * this.U
      circle(c, cp.x, cp.y - bodyH - 8 * this.U, 9 * this.U, this.players[0].color)
      c.strokeStyle = this.players[0].color
      c.lineWidth = 4
      c.beginPath()
      c.moveTo(cp.x, cp.y - bodyH)
      c.lineTo(cp.x, cp.y)
      c.stroke()
      // 分数
      txt(c, `${city.good} 栋`, z.x0 + 16, 40, 22, this.players[pi].color, 'left', 'bold')
      c.restore()
    }
    if (duo) {
      c.fillStyle = '#fffdf3'
      c.fillRect(this.W / 2 - 3, 0, 6, this.H)
    }
  }

  private groundLine() {
    return this.H + 60
  }

  private ppm(n: number) {
    return Math.min(this.W / n, this.H) * (n > 1 ? 0.075 : 0.068)
  }
}

export default function create(ctx: GameContext) {
  return new RopeSwing(ctx)
}
