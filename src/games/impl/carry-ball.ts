import { BaseGame, updateSeats } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, outlineTxt, txt } from '@/core/draw'

/**
 * 合力运球 / carry-ball（对齐 dongdongpark 真实规则）：
 * 一块长木板横在画面中央，两端各由一只手「托」着——手多高板就多高（手高映射：髋上 0.3~1.6 躯干
 * 线性 → 板端 0.72H~0.30H），倾角完全由两手高度差决定；球在板上随倾斜滚动（d = g·sinθ − 1.0·v + 风）；
 * 卷轴持续推进，过检查旗 +1 分；树枝（板端须低于枝尖）/刺球坑（须高于刺顶）/风区碰上或球滚出板端
 * （|s|>1.08）都掉球——回检查点重来、不掉分。
 *
 * 全部字面量沿用站点：卷轴速度 0.13/0.15/0.17 屏宽/s（每 tier ×(1+0.1×tier)）、球加速度 g 1.8/2.2/2.8、
 * 阻尼 1.0、掉球阈值 |s|>1.08、手高映射下限 0.3/跨度 1.3 躯干、板端跟手平滑 14/s、
 * 障碍间距 0.55 屏宽、风宽 0.34W/双端 0.14W/单端 0.12W、碰撞余量 14×unit、球半径 0.04H、
 * 板半长 0.2W（cx=0.46W）、板厚 18×unit、板端范围 0.72H~0.30H、掉球重生 1.4s（卷轴冻结）、
 * 上抛 −120×unit 重力 900×unit、每 4 关一 tier（限位带 ±0.05/tier、slack −0.02/tier）、
 * 风推力 0.4/0.6/0.8（×(1+0.3×tier)）、收尾 +0.495 间距、双端错位 0.4。
 *
 * 与站点的差异（写明待实测）：
 * 1) 站点 body.hands[] = {ok, pos} → 本框架 1P 用 lHand/rHand 腕点（缺失回中 0.5）、2P 用各自玩家
 *    更高的一只手；只消费 pos.y（x 不参与，站点同款）；
 * 2) 关卡生成 4 模式按关号%4 轮换（双端坑/枝/风组合与左右错位照抄，限位带按 tier 外扩）；
 * 3) 精灵（木板/树枝/刺球/球/风扇/小孩）→ 几何绘制；双人共享一个分数（仓库口径）；
 * 4) ai() 演示替身未实装。
 */
interface Obstacle {
  x: number // 世界 x（屏宽单位）
  w: number
  kind: 'branch' | 'pit' | 'wind'
  limit: number // 板端通过限位（枝=须低于、刺=须高于）
  dir: number // 风：±1
  passed: boolean
  flag: boolean // 检查旗
  lv: number
}


/** 站点三档：卷轴速度 / 球加速度 / 安全余量 / 风推力 */
const DIFF = [
  { speed: 0.13, g: 1.8, slack: 0.1, wind: 0.4 },
  { speed: 0.15, g: 2.2, slack: 0.06, wind: 0.6 },
  { speed: 0.17, g: 2.8, slack: 0.03, wind: 0.8 },
]

const DROP_S = 1.08 // 掉球阈值
const MAP_LOW = 0.3 // 手高映射下限（髋上 0.3 躯干）
const MAP_SPAN = 1.3 // 映射跨度
const SMOOTH = 14 // 板端跟手（1/s）
const OB_GAP = 0.55 // 障碍间距（屏宽）
const WIND_W = 0.34
const DUAL_W = 0.14
const SINGLE_W = 0.12
const COLLIDE_PAD = 14 // 碰撞余量（px）
const BALL_R = 0.04 // 球半径（H 比）
const BOARD_HALF = 0.2 // 板半长（W）
const BOARD_TH = 18 // 板厚（px）
const END_LOW = 0.72 // 板端最低（H 比）
const END_SPAN = 0.42
const RESPAWN_T = 1.4
const THROW_V = -120
const GRAV = 900
const TIER_N = 4
const END_PAD = 0.495

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)


class CarryBall extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[0]
  seats = 1
  private seatActive = [false, false]
  /** 每个席位最后一次检测到人的时刻（配合 updateSeats 判断离场） */
  private seatSeen = [-9, -9]
  private endL = 0.5 // 左板端高度 0~1
  private endR = 0.5
  private s = 0 // 球沿板位置（-1~1）
  private v = 0
  private scroll = 0 // 卷轴推进（屏宽）
  private obstacles: Obstacle[] = []
  private genX = 0.9 // 生成游标
  private level = 0
  private checkpoint = 0 // 回卷基准（卷轴位置）
  private dropT = 0 // 掉球冻结剩余
  private dropX = 0
  private dropY = 0
  private dropVY = 0
  private drops = 0
  private passed = 0
  private fastest = Infinity
  private levelStartAt = 0
  private U = Math.min(this.W, this.H) / 720

  constructor(ctx: GameContext) {
    super(ctx)
    this.genLevel(0)
  }

  /** 生成一关障碍（4 模式按 lv%4 轮换） */
  private genLevel(lv: number) {
    const tier = Math.min(3, Math.floor(lv / TIER_N))
    const slack = Math.max(0.01, this.cfg.slack - tier * 0.02)
    const bandHi = 0.62 + 0.05 * tier
    const bandLo = 0.38 - 0.05 * tier
    const mode = lv % 4
    const baseX = this.genX
    const add = (dx: number, kind: Obstacle['kind'], limit: number, w: number, dir = 1, flag = false) => {
      this.obstacles.push({ x: baseX + dx, w, kind, limit, dir, passed: false, flag, lv })
    }
    switch (mode) {
      case 0:
        add(0, 'pit', bandLo - slack, DUAL_W)
        add(OB_GAP, 'branch', bandHi + slack, DUAL_W)
        add(OB_GAP * 2, 'wind', 0, WIND_W, 1)
        add(OB_GAP * 3, 'pit', bandHi - slack, DUAL_W)
        break
      case 1:
        add(0, 'branch', bandLo + slack, DUAL_W)
        add(OB_GAP, 'pit', bandLo - slack, SINGLE_W)
        add(OB_GAP + 0.4, 'branch', bandHi + slack, SINGLE_W)
        add(OB_GAP * 2, 'wind', 0, WIND_W, -1)
        add(OB_GAP * 3, 'pit', bandHi - slack, DUAL_W)
        break
      case 2:
        add(0, 'wind', 0, WIND_W, -1)
        add(OB_GAP, 'pit', bandLo - slack, SINGLE_W)
        add(OB_GAP + 0.4, 'branch', bandHi + slack, SINGLE_W)
        add(OB_GAP * 2, 'branch', bandLo + slack, DUAL_W)
        break
      default:
        add(0, 'pit', bandLo - slack, SINGLE_W)
        add(0.4, 'branch', bandHi + slack, SINGLE_W)
        add(OB_GAP, 'pit', bandHi - slack, SINGLE_W)
        add(OB_GAP + 0.4, 'branch', bandLo + slack, SINGLE_W)
        add(OB_GAP * 2, 'branch', bandHi + slack, DUAL_W, 1, true)
    }
    // 检查旗在关尾
    const endX = baseX + OB_GAP * 3 + END_PAD
    this.obstacles.push({ x: endX, w: 0.1, kind: 'wind', limit: 0, dir: 1, passed: false, flag: true, lv })

    this.genX = endX + OB_GAP
    this.levelStartAt = this.t
  }

  tick(f: PoseFrame, dt: number) {
    if (this.seats === 1 && f.bodies[1]) this.seats = 2
    updateSeats(this.seatActive, this.seatSeen, f.bodies, this.t)
    const duo = this.seats > 1

    // —— 板端跟手 ——
    const heightOf = (b: Body | null, side: 0 | 1) => {
      if (!b) return 0.5
      const T = Math.max(20 * this.U, b.scale * this.H * 1.1)
      const hipY = b.hipC.y * this.H
      let handY: number
      if (duo) {
        // 2P：取该玩家更高的可见手（腕点兜底）
        const ly = b.lHand.y * this.H
        const ry = b.rHand.y * this.H
        handY = Math.min(ly, ry)
      } else {
        handY = side === 0 ? b.lHand.y * this.H : b.rHand.y * this.H
      }
      return clamp((hipY - handY) / T - MAP_LOW, 0, 1) / MAP_SPAN
    }
    const tL = duo
      ? heightOf(f.bodies[0], 0)
      : heightOf(f.bodies[0], 0)
    const tR = duo
      ? heightOf(f.bodies[1], 1)
      : heightOf(f.bodies[0], 1)
    const k = 1 - Math.exp(-dt * SMOOTH)
    if (!duo || this.seatActive[0]) this.endL += (tL - this.endL) * k
    if (!duo || this.seatActive[1]) this.endR += (tR - this.endR) * k

    // —— 卷轴 ——
    if (this.dropT > 0) {
      this.dropT -= dt
      // 掉球坠落动画
      this.dropVY += GRAV * this.U * dt
      this.dropY += this.dropVY * dt
      return
    }
    const tier = Math.min(3, Math.floor(this.level / TIER_N))
    const speed = this.cfg.speed * (1 + 0.1 * tier)
    this.scroll += speed * dt

    // —— 球物理 ——
    const endLY = END_LOW - this.endL * END_SPAN
    const endRY = END_LOW - this.endR * END_SPAN
    const theta = Math.atan2(endRY - endLY, 2 * BOARD_HALF)
    let d = this.cfg.g * Math.sin(theta) - 1.0 * this.v
    // 风
    for (const o of this.obstacles) {
      if (o.kind !== 'wind' || o.passed) continue
      const rel = o.x - this.scroll - 0.46
      if (Math.abs(rel) < WIND_W / 2) {
        d += this.cfg.wind * (1 + 0.3 * tier) * o.dir
        if (Math.random() < dt * 6) this.particles.burst(this.W * 0.46 + rel * this.W, this.H * 0.5, '#ffffff', 2, 100, 3)
      }
    }
    this.v += d * dt
    this.s += this.v * dt
    // 掉球判定
    if (Math.abs(this.s) > DROP_S) {
      this.doDrop('球掉了！')
      return
    }
    // 障碍碰撞（板端进入带内）
    const cx = 0.46
    for (const o of this.obstacles) {
      if (o.kind === 'wind' || o.flag || o.passed) continue
      const rel = o.x - this.scroll
      const endInBand = Math.abs(rel) <= o.w / 2 + COLLIDE_PAD / this.W
      if (!endInBand) continue
      // 树枝垂下：两端都「高于」枝尖（v 都 > limit）才撞；刺球升起：任一端「低于」刺顶即撞
      if (o.kind === 'branch' && Math.min(this.endL, this.endR) > o.limit) {
        this.doDrop('撞到树枝了！')
        return
      }
      if (o.kind === 'pit' && Math.max(this.endL, this.endR) < o.limit) {
        this.doDrop('碰到刺球了！')
        return
      }
      void cx
    }
    // 过旗
    for (const o of this.obstacles) {
      if (!o.flag || o.passed) continue
      if (o.x - this.scroll <= cx) {
        o.passed = true
        this.level++
        this.ctx.addScore(1)
        const t = this.t - this.levelStartAt
        this.fastest = Math.min(this.fastest, t)
        this.checkpoint = o.x
        this.ctx.audio.play('win', 0.6)
        this.say(`过了第 ${this.level} 关！`, this.W / 2, this.H * 0.2, '#6bcb77', 34)
        this.particles.burst(this.W / 2, this.H * 0.3, '#ffd54a', 30, 420, 5)
        this.levelStartAt = this.t
        this.genLevel(this.level)
      }
    }
    // 清理过屏障碍
    this.obstacles = this.obstacles.filter((o) => o.x - this.scroll > -1.5)

    this.ctx.setExtra('drops', this.drops)
    this.ctx.setExtra('obstacles', this.passed)
  }

  private doDrop(text: string) {
    this.drops++
    this.dropT = RESPAWN_T
    this.dropX = this.W * 0.46
    this.dropY = this.H * 0.5
    this.dropVY = THROW_V * this.U
    this.s = 0
    this.v = 0
    this.ctx.audio.play('miss', 0.7)
    this.say(text, this.W / 2, this.H * 0.35, '#ff5d5d', 40)
    this.ctx.speak(text)
    // 回检查点：卷轴回退
    this.scroll = this.checkpoint
    this.obstacles.forEach((o) => {
      if (o.lv === this.level) o.passed = false
    })
    this.levelStartAt = this.t
  }

  paint(c: CanvasRenderingContext2D) {
    const U = this.U
    // 天空
    const g = c.createLinearGradient(0, 0, 0, this.H)
    g.addColorStop(0, '#8ed0f5')
    g.addColorStop(0.55, '#d9f1ff')
    g.addColorStop(1, '#fff4d6')
    c.fillStyle = g
    c.fillRect(0, 0, this.W, this.H)
    // 山丘视差
    c.fillStyle = '#b8e0b0'
    for (let k = 0; k < 8; k++) {
      const bx = ((k * 210 - this.scroll * 0.15 * this.W) % (this.W + 300)) - 150
      c.beginPath()
      c.ellipse(bx, this.H * 0.62, 160 * U, this.H * 0.12 * (1 + (k % 2) * 0.4), 0, Math.PI, 0)
      c.fill()
    }
    // 草地
    c.fillStyle = '#6bcb77'
    c.fillRect(0, this.H * 0.8, this.W, this.H * 0.2)
    // 障碍
    for (const o of this.obstacles) {
      const sx = (o.x - this.scroll) * this.W
      if (sx < -100 || sx > this.W + 100) continue
      if (o.flag) {
        // 检查旗
        c.fillStyle = '#5a4632'
        c.fillRect(sx - 2, this.H * 0.55, 4, this.H * 0.25)
        c.fillStyle = o.passed ? '#9aa4b5' : '#ff6b81'
        c.beginPath()
        c.moveTo(sx + 2, this.H * 0.55)
        c.lineTo(sx + 40 * U, this.H * 0.575)
        c.lineTo(sx + 2, this.H * 0.6)
        c.closePath()
        c.fill()
        continue
      }
      const wPx = o.w * this.W
      const cxx = sx + wPx / 2
      if (o.kind === 'branch') {
        // 树枝：从上方垂下
        c.fillStyle = '#8a5a2b'
        c.fillRect(cxx - wPx / 2, 0, wPx, this.H * 0.4 + o.limit * this.H * 0.42)
        c.fillStyle = '#4f9d58'
        circle(c, cxx, this.H * 0.4 + o.limit * this.H * 0.42, 10 * U, '#4f9d58')
        c.strokeStyle = '#3f9a6a'
        c.setLineDash([8 * U, 8 * U])
        c.beginPath()
        c.moveTo(cxx - wPx / 2, this.H * 0.4 + o.limit * this.H * 0.42)
        c.lineTo(cxx + wPx / 2, this.H * 0.4 + o.limit * this.H * 0.42)
        c.stroke()
        c.setLineDash([])
      } else if (o.kind === 'pit') {
        // 刺球/坑：从地面升起
        c.fillStyle = '#b0576b'
        const top = this.H * 0.8 - (0.4 - o.limit) * this.H * 0.6
        for (let k = 0; k < 4; k++) {
          const spx = cxx - wPx / 2 + (k + 0.5) * (wPx / 4)
          c.beginPath()
          c.moveTo(spx - 8 * U, this.H * 0.8)
          c.lineTo(spx, top)
          c.lineTo(spx + 8 * U, this.H * 0.8)
          c.closePath()
          c.fill()
        }
        c.strokeStyle = '#b088f0'
        c.setLineDash([8 * U, 8 * U])
        c.beginPath()
        c.moveTo(cxx - wPx / 2, top)
        c.lineTo(cxx + wPx / 2, top)
        c.stroke()
        c.setLineDash([])
      } else {
        // 风扇
        circle(c, cxx, this.H * 0.55, 24 * U, '#8fa3d0')
        txt(c, o.dir > 0 ? '→' : '←', cxx, this.H * 0.55, 30 * U, '#26152c')
        for (let k = 0; k < 5; k++) {
          c.globalAlpha = 0.4
          circle(c, cxx + o.dir * (30 + k * 26) * U, this.H * 0.55 + Math.sin(this.t * 4 + k) * 20 * U, 6 * U, '#9be15d')
          c.globalAlpha = 1
        }
      }
    }
    // —— 木板 ——
    const cx = this.W * 0.46
    const L = BOARD_HALF * this.W
    const endLY = END_LOW * this.H - this.endL * END_SPAN * this.H
    const endRY = END_LOW * this.H - this.endR * END_SPAN * this.H
    const lx = cx - L
    const rx = cx + L
    const tilt = Math.atan2(endRY - endLY, 2 * L)
    c.save()
    c.translate(cx, (endLY + endRY) / 2)
    c.rotate(tilt)
    c.fillStyle = '#c98850'
    c.fillRect(-L, -BOARD_TH * U / 2, 2 * L, BOARD_TH * U)
    c.strokeStyle = '#8a5a2b'
    c.lineWidth = 2
    c.strokeRect(-L, -BOARD_TH * U / 2, 2 * L, BOARD_TH * U)
    c.restore()
    // 球
    const ballR = BALL_R * this.H
    let ballX: number
    let ballY: number
    if (this.dropT > 0) {
      ballX = this.dropX
      ballY = this.dropY
    } else {
      ballX = cx + this.s * L
      const endLY2 = END_LOW * this.H - this.endL * END_SPAN * this.H
      const endRY2 = END_LOW * this.H - this.endR * END_SPAN * this.H
      ballY = endLY2 + (endRY2 - endLY2) * ((this.s + 1) / 2) - ballR
    }
    circle(c, ballX, ballY, ballR, '#ff6b81')
    circle(c, ballX - ballR * 0.3, ballY - ballR * 0.3, ballR * 0.25, 'rgba(255,255,255,.5)')
    // 小孩（板端）
    for (const [ex, ey, col, label] of [
      [lx, endLY, this.players[0].color, this.seats > 1 ? 'P1' : '左手'],
      [rx, endRY, this.seats > 1 ? this.players[1].color : this.players[0].color, this.seats > 1 ? 'P2' : '右手'],
    ] as [number, number, string, string][]) {
      circle(c, ex, ey - 46 * U, 12 * U, col)
      c.strokeStyle = col
      c.lineWidth = 4
      c.beginPath()
      c.moveTo(ex, ey - 34 * U)
      c.lineTo(ex, ey - 10 * U)
      c.stroke()
      txt(c, label, ex, ey + 16 * U, 13 * U, col, 'center', 'bold')
    }
    // 掉球红字
    if (this.dropT > RESPAWN_T - 0.8) {
      outlineTxt(c, '球掉了！', this.W / 2, this.H * 0.35, 44, '#ff5d5d')
    }
    // HUD
    txt(c, `第 ${this.level + 1} 关 · 掉球 ${this.drops}`, this.W / 2, 30, 18, '#26152c', 'center', 'bold')
    const tiltDeg = Math.round((tilt * 180) / Math.PI)
    txt(c, tiltDeg > 2 ? '↘' : tiltDeg < -2 ? '↗' : '—', this.W - 40, 40, 26, '#26152c')
  }
}

export default function create(ctx: GameContext) {
  return new CarryBall(ctx)
}
