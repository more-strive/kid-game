import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, txt } from '@/core/draw'

/**
 * 小鸟飞飞 / flap-race（对齐 dongdongpark 真实规则）：
 * 扇一次翅膀 +0.42 升力并积累 boost（+1.1/次、1.6s 衰减、上限 5）推高巡航速度（贴地 1 / 空中 2.2 +
 * boost，最高 7.2 格/秒）；低树枝上方 / 垂枝下方穿过，撞上晕 1s 击退 0.4 格清 boost；吃红心 +10；
 * 飞回鸟窝（x ≥ length）结算 1000 + 速通奖（比 1.35×理论用时每快 1 秒 +6），150 秒兜底按距离给
 * ≤800 分。站点 duration: 0（无倒计时，到家即终局）。
 *
 * 全部字面量沿用站点：重力 0.62、扇翅升力 0.42（vy=min(.85, max(vy,−.1)+.42)）、boost 衰减 exp(−t/1.6)、
 * 赛程 190/235/280、树枝距 [19,25]/[13,18]/[9.5,13]、每间隙红心 2/2/1（间隙 35%/65% 处、alt 0.25~0.75、
 * 末 8 格不放）、低枝沿 0.34~0.50 / 垂枝沿 0.52~0.66（±0.03 容差）、首枝 x=16、种 55% 概率与上一根相反、
 * 教学红心 x=7/10、seed rng(1) 每局同图、碰撞粗筛 1.5×0.4+鸟半径、晕 1s/无敌 1.6s/低枝弹上 .35 垂枝压下 −.25、
 * 红心判定半径 R×1.7、150 秒兜底、双人上下分带、首个到家者把全局结束压到 +12 秒、晚到者纯距离分。
 *
 * 与站点的差异（写明待实测）：
 * 1) **flap 事件站点在 stage 黑盒**（AI 佐证为 0.6~3Hz 的扇翅频率）→ 自研：armLift 从 <0.2 上穿 >0.45
 *    记一次扇翅（冷却 0.2s），「举一下手 = 扇一下翅」，量纲需真机校准；
 * 2) motion.armLift 用「双腕相对肩高度」代理（与 slalom-ski 同款）；红心像素判定用带宽近似站点的 ppm；
 * 3) 精灵全部几何图形绘制；双人共享一个分数（仓库口径），站点各自计分；voice 的「左边/右边第一个到家」
 *    站点文案与上下分带矛盾，这里只说「第一个到家啦」；
 * 4) ai() 演示替身未实装；progress race 竞速条用 setExtra 替代。
 */
interface Branch {
  x: number
  kind: 'low' | 'high'
  edge: number
  look: number
}

interface Heart {
  id: number
  x: number
  alt: number
}

interface Zone {
  top: number
  h: number
}

interface Birder {
  x: number
  alt: number
  vy: number
  boost: number
  wing: number
  dizzy: number
  invuln: number
  finished: boolean
  finishT: number
  hearts: number
  taken: Set<number>
  wasLow: boolean
  lastFlap: number
  zone: Zone
}

/** 站点三档：赛程 / 树枝距区间 / 每间隙红心数 */
const DIFF = [
  { length: 190, gap: [19, 25] as [number, number], heartsPerGap: 2 },
  { length: 235, gap: [13, 18] as [number, number], heartsPerGap: 2 },
  { length: 280, gap: [9.5, 13] as [number, number], heartsPerGap: 1 },
]

const GRAV = 0.62 // 重力（alt/秒²）
const LIFT = 0.42 // 单次扇翅升力
const VY_CAP = 0.85
const VY_FLOOR = -0.1
const BOOST_ADD = 1.1
const BOOST_CAP = 5
const BOOST_TAU = 1.6
const CRUISE_AIR = 2.2
const CRUISE_GROUND = 1
const DIZZY_MUL = 0.35
const HARD_CAP = 150 // 强制结算时限（秒）
const NEST_CLEAR = 14 // 末枝距巢净空
const FIRST_X = 16 // 首枝
const BR_HALF = 0.9 // 树枝横向碰撞半宽（≈1.5×0.4+鸟半径折算）
const EDGE_TOL = 0.03 // 枝沿判定容差
const HIT_DIZZY = 1
const HIT_INVULN = 1.6
const CHASE_WINDOW = 12 // 首个到家后，未到者追赶窗口（秒）
const ALL_HOME_LINGER = 1.8 // 全员到家后停留

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)

function armLiftOf(b: Body) {
  const t = Math.max(0.08, b.scale)
  const handY = (b.lHand.y + b.rHand.y) / 2
  return clamp(((b.shoulderC.y - handY) / t) * 1.3, -1, 1)
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

class FlapRace extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[0]
  branches: Branch[] = []
  hearts: Heart[] = []
  birds: Birder[] = []
  seats = 1
  private seatSeen = [false, false]
  private endAt: number | null = null
  private settled = false
  private firstHome = -1

  constructor(ctx: GameContext) {
    super(ctx)
    this.buildLevel()
    for (let i = 0; i < 2; i++) {
      this.birds.push({
        x: 0, alt: 0.4, vy: 0, boost: 0, wing: 0, dizzy: 0, invuln: 0,
        finished: false, finishT: 0, hearts: 0, taken: new Set(),
        wasLow: false, lastFlap: -9,
        zone: { top: 0, h: this.H },
      })
    }
    this.layout()
  }

  /** 关卡生成：seed rng(1)，首枝 16、末枝 ≤ length−14；红心在间隙 35%/65%，教学心 x=7/10 */
  private buildLevel() {
    const rng = mulberry32(1)
    let x = FIRST_X
    let kind: 'low' | 'high' = 'high'
    while (x <= this.cfg.length - NEST_CLEAR) {
      if (this.branches.length > 0 && rng() < 0.55) kind = kind === 'low' ? 'high' : 'low'
      const edge = kind === 'low' ? 0.34 + rng() * 0.16 : 0.52 + rng() * 0.14
      const look = Math.floor(rng() * 3)
      this.branches.push({ x, kind, edge, look })
      if (this.branches.length >= 2) {
        const prev = this.branches[this.branches.length - 2]
        for (let j = 0; j < this.cfg.heartsPerGap; j++) {
          const hx = prev.x + (x - prev.x) * (0.35 + j * 0.3)
          if (hx > this.cfg.length - 8) continue
          this.hearts.push({ id: this.hearts.length, x: hx, alt: 0.25 + rng() * 0.5 })
        }
      }
      x += this.cfg.gap[0] + rng() * (this.cfg.gap[1] - this.cfg.gap[0])
    }
    this.hearts.push({ id: this.hearts.length, x: 7, alt: 0.4 })
    this.hearts.push({ id: this.hearts.length, x: 10, alt: 0.55 })
  }

  private layout() {
    const n = this.seats
    for (let i = 0; i < 2; i++) {
      this.birds[i].zone = { top: (i * this.H) / n, h: this.H / n }
    }
  }

  tick(f: PoseFrame, dt: number) {
    if (this.seats === 1 && f.bodies[1]) {
      this.seats = 2
      this.layout()
    }
    for (let i = 0; i < 2; i++) {
      const bd = this.birds[i]
      this.step(bd, f.bodies[i] ?? null, dt, i)
      this.ctx.setExtra(`race${i}`, Math.round(Math.min(this.cfg.length, bd.x)))
    }
    // 结束条件：全员到家 +1.8s / 首个到家 +12s / 150s 兜底
    const alive = this.birds.filter((_b, i) => i === 0 || this.seats > 1)
    if (this.endAt === null) {
      if (alive.every((b) => b.finished)) {
        this.endAt = Math.max(...alive.map((b) => b.finishT)) + ALL_HOME_LINGER
      } else if (this.t >= HARD_CAP) {
        this.endAt = this.t
      }
    }
    if (this.endAt !== null && this.t >= this.endAt && !this.settled) {
      this.settled = true
      for (let i = 0; i < (this.seats > 1 ? 2 : 1); i++) {
        const bd = this.birds[i]
        if (!bd.finished && this.seatSeen[i]) {
          const dist = Math.round((bd.x / this.cfg.length) * 800)
          if (dist > 0) {
            this.ctx.addScore(dist)
            this.say('加油！', this.W * 0.27, bd.zone.top + bd.zone.h * 0.4, '#ffd54a', 34)
          }
        }
      }
      this.ctx.finish()
    }
  }

  private step(bd: Birder, b: Body | null, dt: number, idx: number) {
    if (b) this.seatSeen[idx] = true
    if (bd.dizzy > 0) bd.dizzy -= dt
    if (bd.invuln > 0) bd.invuln -= dt
    if (bd.finished) return
    if (!b) {
      // 离场：待机扇翅动画，不掉高度（站点 present=false 时不触发 flap）
      bd.wing += (Math.sin(this.t * 6) * 0.5 - bd.wing) * (1 - Math.exp(-dt * 20))
      return
    }
    // 自研 flap 检测：armLift 从 <0.2 上穿 >0.45 记一次（冷却 0.2s）
    const lift = armLiftOf(b)
    if (lift < 0.2) bd.wasLow = true
    else if (bd.wasLow && lift > 0.45 && this.t - bd.lastFlap > 0.2) {
      bd.wasLow = false
      bd.lastFlap = this.t
      bd.vy = Math.min(VY_CAP, Math.max(bd.vy, VY_FLOOR) + LIFT)
      bd.boost = Math.min(BOOST_CAP, bd.boost + BOOST_ADD)
      this.ctx.audio.play('pop', 0.4, 1.2)
    }
    // 物理
    bd.vy -= GRAV * dt
    bd.vy *= Math.exp(-dt)
    bd.alt += bd.vy * dt
    if (bd.alt <= 0) {
      bd.alt = 0
      bd.vy = Math.max(0, bd.vy)
    }
    if (bd.alt >= 1) {
      bd.alt = 1
      bd.vy = Math.min(0, bd.vy)
    }
    bd.boost *= Math.exp(-dt / BOOST_TAU)
    const speed = ((bd.alt > 0.02 ? CRUISE_AIR : CRUISE_GROUND) + bd.boost) * (bd.dizzy > 0 ? DIZZY_MUL : 1)
    bd.x += speed * dt
    // 翅膀动画
    const target = clamp(lift / 0.8, -1, 1)
    bd.wing += (target - bd.wing) * (1 - Math.exp(-dt * 20))

    // 树枝碰撞（无敌帧内免检）
    const d = 0.05 // 鸟半高折算 alt
    if (bd.invuln <= 0) {
      for (const br of this.branches) {
        if (Math.abs(br.x - bd.x) > BR_HALF) continue
        const hit = br.kind === 'low' ? bd.alt - d < br.edge - EDGE_TOL : bd.alt + d > br.edge + EDGE_TOL
        if (!hit) continue
        bd.dizzy = HIT_DIZZY
        bd.invuln = HIT_INVULN
        bd.boost = 0
        bd.vy = br.kind === 'low' ? 0.35 : -0.25
        bd.x = Math.max(0, bd.x - 0.4)
        this.ctx.audio.play('hit', 0.6)
        this.say('哎呀！', this.W * 0.27, bd.zone.top + bd.zone.h * 0.35, '#b088f0', 30)
        break
      }
    }
    // 红心
    const bandPx = bd.zone.h
    const ppm = Math.min(bandPx * 0.12, this.W / 11)
    const R = bandPx * 0.07
    for (const h of this.hearts) {
      if (bd.taken.has(h.id)) continue
      if (Math.abs(h.x - bd.x) > 1.5) continue
      const dx = (h.x - bd.x) * ppm
      const dy = (h.alt - bd.alt) * bandPx * 0.8
      if (Math.hypot(dx, dy) < R * 1.7) {
        bd.taken.add(h.id)
        bd.hearts++
        this.ctx.addScore(10)
        this.ctx.audio.play('score', 0.5, 1 + (bd.hearts % 5) * 0.06)
        this.say('+10', this.W * 0.27 + 40, bd.zone.top + bandPx * 0.3, '#ff6b81', 26)
      }
    }
    // 到家
    if (bd.x >= this.cfg.length) {
      bd.finished = true
      bd.finishT = this.t
      const bonus = Math.max(0, Math.round(((this.cfg.length / 4.8) * 1.35 - this.t) * 6))
      this.ctx.addScore(1000 + bonus)
      this.ctx.audio.play('win')
      this.particles.burst(this.W * 0.27, bd.zone.top + bandPx * 0.5, '#ffd54a', 40, 420, 5)
      if (this.firstHome < 0) {
        this.firstHome = idx
        if (this.seats > 1) this.endAt = this.t + CHASE_WINDOW // 双人追赶窗；单人走「全员到家 +1.8s」
        if (this.seats === 1) {
          this.say('飞回家啦！', this.W / 2, bd.zone.top + bandPx * 0.3, '#6bcb77', 44)
          this.ctx.speak('飞回家啦！')
        } else {
          this.say(`P${idx + 1} 第一个到家！`, this.W / 2, bd.zone.top + bandPx * 0.3, '#6bcb77', 40)
        }
      }
    }
  }

  paint(c: CanvasRenderingContext2D) {
    const n = this.seats
    for (let i = 0; i < 2; i++) {
      const bd = this.birds[i]
      const z = bd.zone
      if (n === 1 && i === 1) continue
      c.save()
      c.beginPath()
      c.rect(0, z.top, this.W, z.h)
      c.clip()
      this.band(c, bd)
      c.restore()
      if (n > 1 && i === 0) {
        c.fillStyle = '#fffdf3'
        c.fillRect(0, z.top + z.h - 3, this.W, 6)
      }
    }
  }

  private band(c: CanvasRenderingContext2D, bd: Birder) {
    const z = bd.zone
    const ppm = Math.min(z.h * 0.12, this.W / 11)
    const R = z.h * 0.07
    const groundY = z.top + z.h * 0.86
    const topY = z.top + Math.max(z.h * 0.06, (150 * Math.min(this.W, this.H)) / 720)
    const span = groundY - topY
    const yOf = (alt: number) => groundY - alt * span
    const birdSX = this.W * 0.27
    // 天空
    const g = c.createLinearGradient(0, z.top, 0, z.top + z.h)
    g.addColorStop(0, '#87ceeb')
    g.addColorStop(0.55, '#c9ecfa')
    g.addColorStop(1, '#fff4d6')
    c.fillStyle = g
    c.fillRect(0, z.top, this.W, z.h)
    // 山丘（视差 ×0.25）
    c.fillStyle = '#b5e3a0'
    c.beginPath()
    c.moveTo(0, groundY)
    for (let px = 0; px <= this.W; px += 20) {
      const wx = px + bd.x * ppm * 0.25
      c.lineTo(px, groundY - z.h * 0.08 * (1 + Math.sin(wx * 0.008) * 0.5 + Math.sin(wx * 0.021 + 1) * 0.3))
    }
    c.lineTo(this.W, groundY)
    c.closePath()
    c.fill()
    // 地面
    c.fillStyle = '#6bcb77'
    c.fillRect(0, groundY, this.W, z.top + z.h - groundY)
    c.fillStyle = '#5bb868'
    const stripe = (bd.x * ppm) % 46
    for (let px = -46; px < this.W + 46; px += 46) {
      c.fillRect(px - stripe, groundY, 23, z.top + z.h - groundY)
    }
    // 树枝
    for (const br of this.branches) {
      const sx = birdSX + (br.x - bd.x) * ppm
      if (sx < -60 || sx > this.W + 60) continue
      const ey = yOf(br.edge)
      c.fillStyle = br.look === 0 ? '#8a5a2b' : br.look === 1 ? '#96683a' : '#7c4f26'
      if (br.kind === 'low') {
        c.fillRect(sx - 12, ey, 24, groundY - ey)
        circle(c, sx, ey + 4, 14, '#4f9d58')
      } else {
        c.fillRect(sx - 12, topY, 24, ey - topY)
        circle(c, sx, ey - 4, 14, '#4f9d58')
      }
    }
    // 鸟巢
    const nx = birdSX + (this.cfg.length - bd.x) * ppm
    if (nx > -80 && nx < this.W + 80) {
      c.fillStyle = '#b07a4f'
      c.beginPath()
      c.ellipse(nx, groundY - 8, 46, 26, 0, Math.PI, 0)
      c.fill()
      c.strokeStyle = '#4a3b5c'
      c.lineWidth = 3
      c.beginPath()
      c.ellipse(nx, groundY - 8, 46, 26, 0, Math.PI, 0)
      c.stroke()
    }
    // 红心
    for (const h of this.hearts) {
      if (bd.taken.has(h.id)) continue
      const sx = birdSX + (h.x - bd.x) * ppm
      if (sx < -30 || sx > this.W + 30) continue
      const sy = yOf(h.alt) + Math.sin(this.t * 3 + h.id) * 0.15 * R
      const s = R * (1 + Math.sin(this.t * 5 + h.id) * 0.06)
      txt(c, '❤', sx, sy, s * 1.6, '#ff4d6d')
    }
    // 小鸟
    if (!(bd.invuln > 0 && Math.floor(this.t * 10) % 2 === 0)) {
      const by = yOf(bd.alt)
      const rot = clamp(-bd.vy * 0.5, -0.35, 0.35)
      c.save()
      c.translate(birdSX, by)
      c.rotate(rot)
      circle(c, 0, 0, R, this.players[0].color)
      circle(c, R * 0.55, -R * 0.35, R * 0.32, this.players[0].color) // 头
      circle(c, R * 0.72, -R * 0.45, R * 0.08, '#26152c') // 眼
      c.fillStyle = '#ffa94d'
      c.beginPath()
      c.moveTo(R * 0.82, -R * 0.3)
      c.lineTo(R * 1.15, -R * 0.2)
      c.lineTo(R * 0.82, -R * 0.1)
      c.closePath()
      c.fill() // 喙
      // 翅膀
      c.strokeStyle = '#26152c'
      c.lineWidth = Math.max(3, R * 0.18)
      c.beginPath()
      c.moveTo(0, 0)
      c.lineTo(-R * 0.7, -bd.wing * R * 1.2)
      c.stroke()
      c.restore()
      if (bd.dizzy > 0) {
        for (let k = 0; k < 3; k++) {
          const a = this.t * 7 + (k * Math.PI * 2) / 3
          circle(c, birdSX + Math.cos(a) * R * 1.4, by - R * 1.5 + Math.sin(a) * R * 0.4, 4, '#ffd54a')
        }
      }
    }
    // 进度条
    const pw = this.W * 0.3
    const px0 = this.W * 0.5 - pw / 2
    const py = z.top + Math.max(10, z.h * 0.04)
    c.fillStyle = 'rgba(255,255,255,.4)'
    c.fillRect(px0, py, pw, 8)
    c.fillStyle = this.players[0].color
    c.fillRect(px0, py, pw * clamp(bd.x / this.cfg.length, 0, 1), 8)
    txt(c, `❤ ${bd.hearts}`, px0 - 16, py + 4, 16, '#ff6b81', 'right', 'bold')
  }
}

export default function create(ctx: GameContext) {
  return new FlapRace(ctx)
}
