import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, rr, star } from '@/core/draw'

/**
 * 森林跑酷 / forest-run（对齐 dongdongpark 真实规则）：
 * 原地跑步驱动小狮子前进（run≥0.8 吃满 vmax），跨步变道躲动物、跳过木头、顺路吃水果。
 *
 * 全部字面量沿用站点：车道 ±1.25 米、相机高 1.7、近平面 3.2、跳跃总时长 0.8s 最高 1.05m、
 * 速度跟随 τ≈0.55s（1−e^(−1.8dt)）、变道平滑 1−e^(−9dt)、滞回 0.55/0.35、
 * 路段分布：木头 logP / 动物恒 0.5 / 纯水果 0.5−logP、动物 55% 羊驼、double 概率加第二只并补 3 水果在空道、
 * 间隔 gap[]、同道判定 0.72 米、跳木高度 >0.3m、跳猴高度 >0.45m、
 * 撞击 dizzy 1.2s / invuln 1.6s / v×0.3、吃水果 +5（音高循环上浮）、跳木 +3、每米 +1。
 *
 * 与站点的差异（写明待实测）：
 * 1) 站点读 motion.run / motion.shift（黑盒归一量）；本框架用「髋部竖直速度 ÷ 躯干」当 run、
 *    「髋部横向速度 ÷ 躯干 ÷1.6」当 shift，阈值沿用站点字面量，量纲需真机校准；
 * 2) 举手跳保留双通道：jumping 上升沿 或 armLift>0.8（回落 <0.5 重新武装）；
 * 3) 站点是精灵贴图（fr-tree/fr-log/fr-llama…），这里全部几何图形绘制；
 * 4) 关卡用种子 rng(2)（站点同款种子），双人共享同一条障碍序列，各按各自 dist 结算。
 */

interface Item {
  id: number
  s: number // 距起点米数
  type: 'log' | 'animal' | 'fruit'
  lane: number
  kind?: 'llama' | 'monkey'
  look?: number
}

interface Zone {
  cx: number
  w: number
  f: number
  hy: number
}

interface Runner {
  dist: number
  prevDist: number
  v: number
  run: number
  lane: number
  laneX: number
  jumpT: number
  dizzy: number
  invuln: number
  slowT: number
  meters: number
  got: Set<number>
  hit: Set<number>
  armed: boolean
  prevY: number
  prevX: number
  wasJump: boolean
  zone: Zone
}

/** 站点三档：速度上限 / 路段间隔 / 木头概率 / 双动物概率 */
const DIFF = [
  { vmax: 7.5, gap: [15, 21] as [number, number], logP: 0.14, double: 0 },
  { vmax: 8.5, gap: [12, 17] as [number, number], logP: 0.2, double: 0.12 },
  { vmax: 9.5, gap: [10, 14] as [number, number], logP: 0.24, double: 0.25 },
]

const LANE_W = 1.25 // 车道间距（米）
const CAM_H = 1.7 // 相机高度（米）
const NEAR = 3.2 // 近平面偏移
const JUMP_T = 0.8 // 一次跳跃总时长（秒）
const JUMP_H = 1.05 // 跳跃最高点（米）
const LANE_TOL = 0.72 // 同道判定（米）
const LOG_NEED = 0.3 // 跳过木头所需高度（米）
const MONKEY_NEED = 0.45 // 跳过猴子所需高度（米）
const ROAD_HALF = 2.075 // 路半宽（米）
const RAIL = 0.625 // 护栏（米）

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)

/** 站点同款种子随机：mulberry32，保证两人同一关卡序列 */
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

class ForestRun extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[0]
  items: Item[] = []
  runners: Runner[] = []
  seats = 1
  private rng = mulberry32(2)
  private cursor = 16 // 生成游标（站点从 16 开始，开局先铺到 80）
  private nextId = 1

  constructor(ctx: GameContext) {
    super(ctx)
    for (let i = 0; i < 2; i++) {
      this.runners.push({
        dist: 0, prevDist: 0, v: 0, run: 0, lane: 0, laneX: 0, jumpT: -1,
        dizzy: 0, invuln: 0, slowT: 0, meters: 0, got: new Set(), hit: new Set(),
        armed: true, prevY: 0.5, prevX: 0.5, wasJump: false,
        zone: { cx: this.W / 2, w: this.W, f: 0, hy: 0 },
      })
    }
    this.layout()
    // 开局固定 4 个水果（8 / 9.8 / 11.6 / 13.4，车道 0）
    for (let i = 0; i < 4; i++) this.items.push({ id: this.nextId++, s: 8 + i * 1.8, type: 'fruit', lane: 0 })
    this.gen(80)
  }

  private layout() {
    const n = this.seats
    for (let i = 0; i < 2; i++) {
      const z = this.runners[i].zone
      z.w = this.W / n
      z.cx = z.w * i + z.w / 2
      z.f = Math.min(this.H * 0.92, z.w * 0.78)
      z.hy = this.H * 0.36
    }
  }

  /** 站点投影 k：scale = f/(z+3.2)，y = hy + (1.7 − r)×scale */
  private proj(z: Zone, xM: number, depth: number, r: number) {
    if (depth + NEAR < 0.35) return null
    const s = z.f / (depth + NEAR)
    return { x: z.cx + xM * s, y: z.hy + (CAM_H - r) * s, s }
  }

  /** 关卡生成：保持 100 米前瞻，动物段必留一条空道并补 3 个水果 */
  private gen(target: number) {
    while (this.cursor < target) {
      const roll = this.rng()
      const T0 = this.cursor
      if (roll < this.cfg.logP) {
        this.items.push({ id: this.nextId++, s: T0, type: 'log', lane: 0 })
      } else if (roll < this.cfg.logP + 0.5) {
        const lane = Math.floor(this.rng() * 3) - 1
        const kind = this.rng() < 0.55 ? 'llama' : 'monkey'
        const look = Math.floor(this.rng() * 3)
        this.items.push({ id: this.nextId++, s: T0, type: 'animal', lane, kind, look })
        const others = [-1, 0, 1].filter((l) => l !== lane)
        if (this.rng() < this.cfg.double) {
          const l2 = others[Math.floor(this.rng() * others.length)]
          this.items.push({ id: this.nextId++, s: T0, type: 'animal', lane: l2, kind: this.rng() < 0.55 ? 'llama' : 'monkey' })
          const free = others.filter((l) => l !== l2)[0]
          for (let i = 0; i < 3; i++) this.items.push({ id: this.nextId++, s: T0 - 1.5 + i * 1.6, type: 'fruit', lane: free })
        } else {
          const free = others[Math.floor(this.rng() * others.length)]
          for (let i = 0; i < 3; i++) this.items.push({ id: this.nextId++, s: T0 - 1.5 + i * 1.6, type: 'fruit', lane: free })
        }
      } else {
        const lane = Math.floor(this.rng() * 3) - 1
        for (let i = 0; i < 4; i++) this.items.push({ id: this.nextId++, s: T0 + i * 1.8, type: 'fruit', lane })
      }
      this.cursor += this.cfg.gap[0] + this.rng() * (this.cfg.gap[1] - this.cfg.gap[0])
    }
  }

  tick(f: PoseFrame, dt: number) {
    if (this.seats === 1 && f.bodies[1]) {
      this.seats = 2
      this.layout()
    }
    let maxDist = 0
    for (let i = 0; i < 2; i++) {
      const r = this.runners[i]
      const b = f.bodies[i] ?? null
      this.step(r, b, dt)
      maxDist = Math.max(maxDist, r.dist)
    }
    this.gen(maxDist + 100)
    const keep = Math.min(...this.runners.map((r) => r.dist)) - 6
    this.items = this.items.filter((it) => it.s > keep)
  }

  private step(r: Runner, b: Body | null, dt: number) {
    r.prevDist = r.dist
    if (r.invuln > 0) r.invuln -= dt
    if (r.dizzy > 0) r.dizzy -= dt
    if (!b) {
      // 没人时目标速度归 0， world 继续滚动到停
      r.v += (0 - r.v) * (1 - Math.exp(-dt * 1.8))
      r.dist += r.v * dt
      return
    }
    const Tn = Math.max(0.1, b.scale)

    // run：髋部竖直速度 ÷ 躯干（站点 motion.run 黑盒，量纲待校准）
    const vy = Math.abs((b.hipC.y - r.prevY) / Math.max(dt, 1e-3)) / Tn
    r.prevY = b.hipC.y
    const raw = clamp(vy / 2.2, 0, 1)
    r.run += (raw - r.run) * Math.min(1, dt * 6)

    // 前进
    let c = r.run > 0.05 ? this.cfg.vmax * Math.min(1, r.run * 1.25) : 0
    if (r.dizzy > 0) c *= 0.35
    r.v += (c - r.v) * (1 - Math.exp(-dt * 1.8))
    r.dist += r.v * dt
    // 每满 1 米 +1
    while (Math.floor(r.dist) > r.meters) {
      r.meters++
      this.ctx.addScore(1)
    }
    // 太久没跑提示
    if (r.v < 1.2 && r.dizzy <= 0) {
      r.slowT += dt
      if (r.slowT > 1.5) {
        r.slowT = 0
        this.say('原地跑起来！', r.zone.cx, r.zone.hy + 80, '#ffe066', 34)
      }
    } else r.slowT = 0

    // 变道：横向速度 ÷ 躯干 → shift，滞回 0.55/0.35
    this.laneInput(r, b, dt)

    // 跳跃：jumping 上升沿 或 举手（armLift>0.8 触发一次，<0.5 重新武装）
    const arm = armLiftOf(b)
    if (arm > 0.8) r.armed = false
    else if (arm < 0.5) r.armed = true
    const wantJump = (b.jumping && !r.wasJump) || (arm > 0.8 && r.armed)
    r.wasJump = b.jumping
    if (wantJump && (r.jumpT < 0 || r.jumpT >= JUMP_T)) {
      r.jumpT = 0
      this.ctx.audio.play('click', 0.4, 1.4)
    }
    if (r.jumpT >= 0 && r.jumpT < JUMP_T) r.jumpT += dt
    r.laneX += (r.lane * LANE_W - r.laneX) * (1 - Math.exp(-dt * 9))

    // 穿越结算：本帧越过才判一次
    const jumpH = r.jumpT >= 0 && r.jumpT < JUMP_T ? JUMP_H * Math.sin((Math.PI * r.jumpT) / JUMP_T) : 0
    for (const it of this.items) {
      if (it.s <= r.prevDist || it.s > r.dist) continue
      const sameLane = Math.abs(r.laneX - it.lane * LANE_W) < LANE_TOL
      if (it.type === 'fruit') {
        if (sameLane && !r.got.has(it.id)) {
          r.got.add(it.id)
          this.ctx.addScore(5)
          this.ctx.audio.play('score', 0.5, 1 + (r.got.size % 4) * 0.07)
          const p = this.proj(r.zone, it.lane * LANE_W, it.s - r.dist, 0.5)
          if (p) {
            this.say('+5', p.x, p.y - 20, '#ffd54a', 34)
            this.particles.burst(p.x, p.y, '#ffd54a', 6, 200, 4)
          }
        }
        continue
      }
      if (it.type === 'log') {
        if (jumpH < LOG_NEED) this.hurt(r, it.s, '要跳哦！')
        else {
          this.ctx.addScore(3)
          this.ctx.audio.play('win', 0.5)
          this.say('跳过去啦！', r.zone.cx, r.zone.hy + 60, '#9be15d', 36)
        }
        continue
      }
      // 动物：羊驼只能绕、猴子可跳过；躲开不加分
      const jumpedOver = it.kind === 'monkey' && jumpH > MONKEY_NEED
      if (sameLane && !jumpedOver) this.hurt(r, it.s, '哎呀！')
    }
  }

  /** 滞回变道状态机（站点原样） */
  private laneInput(r: Runner, b: Body, dt: number) {
    const Tn = Math.max(0.1, b.scale)
    const shift = clamp((((b.hipC.x - r.prevX) / Math.max(dt, 1e-3)) / Tn) / 1.6, -1, 1)
    r.prevX = b.hipC.x
    const old = r.lane
    if (r.lane === 0) {
      if (shift > 0.55) r.lane = 1
      else if (shift < -0.55) r.lane = -1
    } else if (r.lane === 1) {
      if (shift < 0.35) r.lane = shift < -0.55 ? -1 : 0
    } else {
      if (shift > -0.35) r.lane = shift > 0.55 ? 1 : 0
    }
    if (r.lane !== old) this.ctx.audio.play('click', 0.4, 0.8)
  }

  private hurt(r: Runner, atS: number, text: string) {
    if (r.invuln > 0 || r.hit.has(atS)) return
    r.hit.add(atS)
    r.dizzy = 1.2
    r.invuln = 1.6
    r.v *= 0.3
    this.ctx.audio.play('miss')
    this.say(text, r.zone.cx, r.zone.hy + 40, '#ff8fa8', 38)
    this.particles.burst(r.zone.cx, r.zone.hy + 120, '#ffe066', 9, 260, 4)
  }

  paint(c: CanvasRenderingContext2D) {
    const n = this.seats
    for (let i = 0; i < 2; i++) {
      const r = this.runners[i]
      const z = r.zone
      const x0 = z.cx - z.w / 2
      if (n === 1 && i === 1) continue
      c.save()
      c.beginPath()
      c.rect(x0, 0, z.w, this.H)
      c.clip()
      this.scenery(c, r, z)
      this.road(c, r, z)
      this.itemsLayer(c, r, z)
      this.lion(c, r, z)
      c.restore()
      if (n > 1 && i === 0) {
        c.fillStyle = '#fff'
        c.fillRect(this.W / 2 - 3, 0, 6, this.H)
      }
    }
  }

  /** 天空 / 太阳 / 远山 / 地面 */
  private scenery(c: CanvasRenderingContext2D, r: Runner, z: Zone) {
    const x0 = z.cx - z.w / 2
    const g = c.createLinearGradient(0, 0, 0, z.hy)
    g.addColorStop(0, '#8fd3f0')
    g.addColorStop(1, '#e6f7e0')
    c.fillStyle = g
    c.fillRect(x0, 0, z.w, z.hy)
    // 太阳
    circle(c, x0 + z.w * 0.8, z.hy * 0.45, 36, '#ffe680')
    // 两层远山（正弦叠加，随距离轻微滚动）
    const hill = (base: number, amp: number, col: string, ph: number) => {
      c.fillStyle = col
      c.beginPath()
      c.moveTo(x0, z.hy)
      for (let px = 0; px <= z.w; px += 16) {
        const wx = px + r.dist * 6 + ph
        const y = z.hy - base + Math.sin(wx * 0.011) * amp + Math.sin(wx * 0.031 + 1.7) * amp * 0.5
        c.lineTo(x0 + px, y)
      }
      c.lineTo(x0 + z.w, z.hy)
      c.closePath()
      c.fill()
    }
    hill(this.H * 0.16, 26, '#9ad18b', 0)
    hill(this.H * 0.09, 18, '#6fbf73', 900)
    // 地面
    const gg = c.createLinearGradient(0, z.hy, 0, this.H)
    gg.addColorStop(0, '#6cbf6a')
    gg.addColorStop(1, '#3f9a52')
    c.fillStyle = gg
    c.fillRect(x0, z.hy, z.w, this.H - z.hy)
  }

  /** 路面梯形 + 每 4 米横条纹 + 护栏 */
  private road(c: CanvasRenderingContext2D, r: Runner, z: Zone) {
    const near = this.proj(z, 0, -2.8, 0)!
    const far = this.proj(z, 0, 90, 0)!
    c.fillStyle = '#d9b382'
    c.beginPath()
    c.moveTo(near.x - ROAD_HALF * near.s, near.y)
    c.lineTo(near.x + ROAD_HALF * near.s, near.y)
    c.lineTo(far.x + ROAD_HALF * far.s, far.y)
    c.lineTo(far.x - ROAD_HALF * far.s, far.y)
    c.closePath()
    c.fill()
    // 条纹：每 4 米一道浅色横线
    c.strokeStyle = '#e7c79b'
    c.lineWidth = 2
    const from = Math.ceil((r.dist - 2) / 4) * 4
    for (let s = from; s < r.dist + 90; s += 4) {
      const p = this.proj(z, 0, s - r.dist, 0)
      if (!p) continue
      c.beginPath()
      c.moveTo(p.x - ROAD_HALF * p.s, p.y)
      c.lineTo(p.x + ROAD_HALF * p.s, p.y)
      c.stroke()
    }
    // 两条护栏线
    c.strokeStyle = '#b98f5e'
    c.lineWidth = 3
    for (const side of [-1, 1]) {
      c.beginPath()
      let first = true
      for (let d = 90; d >= -2.5; d -= 6) {
        const p = this.proj(z, side * RAIL, d, 0)
        if (!p) continue
        if (first) {
          c.moveTo(p.x, p.y)
          first = false
        } else c.lineTo(p.x, p.y)
      }
      c.stroke()
    }
  }

  /** 障碍 / 水果 */
  private itemsLayer(c: CanvasRenderingContext2D, r: Runner, z: Zone) {
    const list = [...this.items].sort((a, b) => b.s - a.s) // 远的先画
    for (const it of list) {
      const depth = it.s - r.dist
      if (depth < 0.4 || depth > 90) continue
      const p = this.proj(z, it.lane * LANE_W, depth, 0)
      if (!p) continue
      if (it.type === 'log') {
        // 木头横跨全路
        const l = this.proj(z, -ROAD_HALF + 0.2, depth, 0.18)
        const rr2 = this.proj(z, ROAD_HALF - 0.2, depth, 0.18)
        if (!l || !rr2) continue
        c.fillStyle = '#8a5a2b'
        rr(c, l.x, l.y - p.s * 0.3, rr2.x - l.x, Math.max(6, p.s * 0.42), Math.max(3, p.s * 0.18))
        c.fillStyle = '#a9743d'
        rr(c, l.x, l.y - p.s * 0.3, rr2.x - l.x, Math.max(4, p.s * 0.2), Math.max(2, p.s * 0.09))
      } else if (it.type === 'animal') {
        const size = p.s * (it.kind === 'llama' ? 1.1 : 0.85)
        const x = p.x
        const y = p.y
        if (it.kind === 'llama') {
          circle(c, x, y - size * 0.55, size * 0.42, '#fff6e8') // 身体
          rr(c, x - size * 0.08, y - size * 1.15, size * 0.18, size * 0.7, size * 0.08) // 脖子
          circle(c, x, y - size * 1.25, size * 0.19, '#fff6e8') // 头
          circle(c, x - size * 0.07, y - size * 1.28, size * 0.035, '#3a2d2d')
          circle(c, x + size * 0.07, y - size * 1.28, size * 0.035, '#3a2d2d')
        } else {
          circle(c, x, y - size * 0.5, size * 0.36, '#9c6b3f') // 身体
          circle(c, x, y - size * 0.95, size * 0.26, '#b98957') // 头
          circle(c, x - size * 0.09, y - size * 0.98, size * 0.04, '#3a2d2d')
          circle(c, x + size * 0.09, y - size * 0.98, size * 0.04, '#3a2d2d')
          circle(c, x, y - size * 1.18, size * 0.1, '#d8b27a') // 脸
        }
      } else {
        // 水果：左右摇摆
        const sway = Math.sin(this.t * 3 + it.id) * 0.2 * p.s
        circle(c, p.x + sway, p.y - p.s * 0.3, Math.max(4, p.s * 0.22), '#ff6b6b')
        c.fillStyle = '#4caf50'
        c.beginPath()
        c.ellipse(p.x + sway + p.s * 0.12, p.y - p.s * 0.52, p.s * 0.09, p.s * 0.05, -0.5, 0, Math.PI * 2)
        c.fill()
      }
    }
  }

  /** 玩家小狮子 */
  private lion(c: CanvasRenderingContext2D, r: Runner, z: Zone) {
    if (r.invuln > 0 && Math.floor(this.t * 10) % 2 === 0) return // 无敌帧闪烁
    const jumpH = r.jumpT >= 0 && r.jumpT < JUMP_T ? JUMP_H * Math.sin((Math.PI * r.jumpT) / JUMP_T) : 0
    const base = this.proj(z, r.laneX, 0, 0)
    if (!base) return
    const p = this.proj(z, r.laneX, 0, jumpH) ?? base
    const size = base.s
    // 阴影
    c.fillStyle = 'rgba(0,0,0,.22)'
    c.beginPath()
    c.ellipse(base.x, base.y, size * 0.5 * (1 - (jumpH / JUMP_H) * 0.4), size * 0.14, 0, 0, Math.PI * 2)
    c.fill()
    c.save()
    c.translate(p.x, p.y)
    c.rotate((r.lane * LANE_W - r.laneX) * 0.12)
    const bob = Math.sin(this.t * (6 + r.v * 1.7)) * size * 0.04
    circle(c, 0, -size * 0.62 + bob, size * 0.6, '#e8963c') // 鬃毛
    circle(c, 0, -size * 0.58 + bob, size * 0.44, '#f7c948') // 脸
    circle(c, -size * 0.14, -size * 0.66 + bob, size * 0.05, '#3a2d2d')
    circle(c, size * 0.14, -size * 0.66 + bob, size * 0.05, '#3a2d2d')
    c.strokeStyle = '#3a2d2d'
    c.lineWidth = Math.max(2, size * 0.04)
    c.beginPath()
    c.arc(0, -size * 0.5 + bob, size * 0.12, 0.15 * Math.PI, 0.85 * Math.PI)
    c.stroke()
    c.restore()
    if (r.dizzy > 0) {
      for (let k = 0; k < 3; k++) {
        const a = this.t * 6 + (k * Math.PI * 2) / 3
        star(c, p.x + Math.cos(a) * size * 0.7, p.y - size * 1.2 + Math.sin(a) * size * 0.18, size * 0.1, '#ffe066')
      }
    }
  }
}

function armLiftOf(b: Body) {
  const t = Math.max(0.08, b.scale)
  const handY = (b.lHand.y + b.rHand.y) / 2
  return clamp(((b.shoulderC.y - handY) / t) * 1.3, -1, 1)
}

export default function create(ctx: GameContext) {
  return new ForestRun(ctx)
}
