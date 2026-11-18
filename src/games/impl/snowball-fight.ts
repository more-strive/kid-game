import { BaseGame, updateSeats } from '@/core/base'
import type { Game, GameContext, PoseFrame } from '@/core/types'
import { circle, txt } from '@/core/draw'

/**
 * 打雪仗 / snowball-fight（对齐 dongdongpark 真实规则）：
 * 雪人蓄力 0.45s 后朝玩家肩部附近扔追踪雪球（瞄准圈虚线常驻跟随），玩家把手掌放进圈里、
 * 在最后 28% 飞行窗口内圆相交（球.r + 手.r×0.9）即挡住——雪球自动反弹回雪人 +1 分。
 * 全程零惩罚（被砸中无代价），玩家不扔球。判定遍历所有玩家（跨位帮挡有效，分归挡球者）。
 *
 * 全部字面量沿用站点：雪人数 1/2/3（2P = min(3, +1)）、投掷间隔 2.4/1.7/1.25s
 * ×(1−0.3×heat)×(0.8~1.2)（2P ÷1.5）、飞行 2/1.5/1.2s、同目标在飞上限 1/2/2、
 * 反弹 0.55s（弧顶 0.12H、半径缩至 28%）、雪人脚底 0.28H / 高 0.21H、蓄力 0.45s、
 * 受击硬直 1.2s（hitT≤0.3 不可选中）、瞄准偏移 ox ±0.85T / oy −0.75~+0.35T、
 * 落点圈 max(40u, 0.3T)、可挡窗口 72%、挡距 < 球.r + 手.r×0.9、雪人移速 0.28W/s、
 * 同侧间距 ≥0.12W、首投 1s、雪花 50 片、「挡住啦！」首挡必出后 20% 概率。
 *
 * 与站点的差异（写明待实测）：
 * 1) 站点 body.hands[] = {ok, pos, r} 黑盒 → 本框架用 lHandDet/rHandDet 的掌心（无则退化腕点），
 *    手半径按躯干 0.28 估算（站点 r 黑盒，取值影响容错，需真机校准）；
 * 2) 瞄准锚点 shoulderC / 比例 torso 来自姿态骨架（本框架已有）；精灵全部几何绘制；
 * 3) 分数记给实际挡球者 → 仓库共享分数口径下等效合作；ai() 演示替身未实装。
 */
interface Snowman {
  x: number
  side: 0 | 1
  goalX: number
  chargeT: number
  hitT: number
  phase: number
  pendingTarget: number // 蓄力时锁定的目标玩家
}

interface Ball {
  target: number
  snowman: number
  ox: number
  oy: number
  p: number
  state: 'fly' | 'back' | 'done'
  bp: number
  R: number
  x: number
  y: number
  r: number
  blocker: number
  blockX: number
  blockY: number
  aimX: number
  aimY: number
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)

/** 站点三档：雪人数 / 投掷间隔 / 飞行时长 / 在飞上限 */
const DIFF = [
  { snowmen: 1, every: 2.4, flight: 2, inAir: 1 },
  { snowmen: 2, every: 1.7, flight: 1.5, inAir: 2 },
  { snowmen: 3, every: 1.25, flight: 1.2, inAir: 2 },
]

const BACK_T = 0.55
const SNOW_Y = 0.28
const SNOW_E = 0.21
const CHARGE_T = 0.45
const HIT_STUN = 1.2
const WALK_V = 0.28
const FIRST_AT = 1
const BLOCK_P = 0.72
const DUR = 60

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

class SnowballFight extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[0]
  snowmen: Snowman[] = []
  balls: Ball[] = []
  splats: { x: number; y: number; life: number }[] = []
  seats = 1
  private seatActive = [false, false]
  /** 每个席位最后一次检测到人的时刻（配合 updateSeats 判断离场） */
  private seatSeen = [-9, -9]
  private throwIn = FIRST_AT
  private b = 0
  private saidBlock = false
  private flakes: { x: number; y: number; v: number; ph: number }[] = []
  private rng = mulberry32(9)
  private U = Math.min(this.W, this.H) / 720
  private snowE = SNOW_E * this.H
  private lastBodies: (Body0 | null)[] = [null, null]

  constructor(ctx: GameContext) {
    super(ctx)
    for (let i = 0; i < this.cfg.snowmen; i++) this.snowmen.push(this.makeSnowman(i as 0 | 1 | 2))
    for (let k = 0; k < 50; k++) {
      this.flakes.push({ x: Math.random() * this.W, y: Math.random() * this.H, v: (0.03 + Math.random() * 0.05) * this.H, ph: Math.random() * 6 })
    }
  }

  private makeSnowman(i: 0 | 1 | 2): Snowman {
    const side = (i % 2) as 0 | 1
    const duo = this.seats > 1
    const x = (duo ? (side === 0 ? 0.1 : 0.9) : side === 0 ? 0.2 : 0.8) * this.W
    return { x, side, goalX: x, chargeT: 0, hitT: 0, phase: this.rng() * 6, pendingTarget: 0 }
  }

  tick(f: PoseFrame, dt: number) {
    this.lastBodies = [f.bodies[0] ?? null, f.bodies[1] ?? null]
    if (this.seats === 1 && f.bodies[1]) {
      this.seats = 2
      this.layoutSnowmen()
    }
    updateSeats(this.seatActive, this.seatSeen, f.bodies, this.t)
    // 雪花
    for (const fl of this.flakes) {
      fl.y += fl.v * dt
      fl.x += Math.sin(this.t * 2 + fl.ph) * 0.01 * this.W * dt
      if (fl.y > this.H) {
        fl.y = -10
        fl.x = Math.random() * this.W
      }
    }
    for (const s of this.splats) s.life -= dt
    this.splats = this.splats.filter((s) => s.life > 0)

    // 雪人行为
    const duo = this.seats > 1
    for (const sm of this.snowmen) {
      if (sm.hitT > 0) sm.hitT -= dt
      if (sm.chargeT > 0) {
        sm.chargeT -= dt
        if (sm.chargeT <= 0) this.throwFrom(sm)
        continue
      }
      if (sm.hitT > 0.3) continue
      sm.x += clamp(sm.goalX - sm.x, -WALK_V * this.W * dt, WALK_V * this.W * dt)
    }
    // 投掷调度
    this.throwIn -= dt
    if (this.throwIn <= 0) {
      const heat = this.ctx.heat
      this.throwIn = (this.cfg.every * (1 - 0.3 * heat) * (0.8 + this.rng() * 0.4)) / (duo ? 1.5 : 1)
      const nPlayers = duo ? 2 : 1
      this.b++
      const target = (this.b - 1) % nPlayers
      if (!this.seatActive[target]) return
      const cands = this.snowmen.map((s, i) => ({ s, i })).filter(({ s }) => s.chargeT <= 0 && s.hitT <= 0.3)
      const inAir = this.balls.filter((bl) => bl.state === 'fly' && bl.target === target).length
      if (cands.length === 0 || inAir >= this.cfg.inAir) return
      let pick = cands[0]
      if (duo) {
        const zc = this.zoneCx(target)
        let bd = Infinity
        for (const c of cands) {
          const d = Math.abs(c.s.x - zc)
          if (d < bd) {
            bd = d
            pick = c
          }
        }
      } else {
        pick = cands[Math.floor(this.rng() * cands.length)]
      }
      pick.s.chargeT = CHARGE_T
      pick.s.pendingTarget = target
    }

    // 雪球推进 + 挡球判定
    for (const ball of this.balls) {
      const sm = this.snowmen[ball.snowman]
      const b = this.lastBodies[ball.target]
      if (ball.state === 'fly') {
        ball.p += dt / this.cfg.flight
        const p = clamp(ball.p, 0, 1)
        // 落点每帧重算（追着肩打）
        if (b) {
          ball.aimX = b.shoulderC.x * this.W + ball.ox
          ball.aimY = b.shoulderC.y * this.H + ball.oy
        }
        const startX = sm.x + 0.05 * this.snowE
        const startY = this.H * SNOW_Y - 0.9 * this.snowE
        ball.x = startX + (ball.aimX - startX) * Math.pow(p, 1.4)
        ball.y = startY + (ball.aimY - startY) * Math.pow(p, 1.4) - Math.sin(Math.PI * p) * 0.1 * this.H
        ball.r = 6 * this.U + (ball.R - 6 * this.U) * p * p
        // 挡球：p ≥ 0.72，遍历所有玩家的手
        if (p >= BLOCK_P && p < 1) {
          for (let i = 0; i < 2; i++) {
            const bd = this.lastBodies[i]
            if (!bd || !this.seatActive[i]) continue
            const T = Math.max(60, bd.scale * this.H * 1.1)
            const handR = T * 0.28
            const palms = [
              bd.lHandDet ? bd.lHandDet.palm : { x: bd.lHand.x * this.W, y: bd.lHand.y * this.H },
              bd.rHandDet ? bd.rHandDet.palm : { x: bd.rHand.x * this.W, y: bd.rHand.y * this.H },
            ]
            let hit = false
            for (const palm of palms) {
              if (Math.hypot(palm.x - ball.x, palm.y - ball.y) < ball.r + handR * 0.9) {
                hit = true
                break
              }
            }
            if (hit) {
              ball.state = 'back'
              ball.bp = 0
              ball.blocker = i
              ball.blockX = bd.shoulderC.x * this.W
              ball.blockY = bd.shoulderC.y * this.H
              this.ctx.audio.play('click', 0.6, 1.2)
              this.particles.burst(ball.x, ball.y, '#ffffff', 14, 260, 4)
              if (!this.saidBlock || Math.random() < 0.2) {
                this.saidBlock = true
                this.say('挡住啦！', ball.x, ball.y - 40, this.players[i].color, 30)
              }
              break
            }
          }
        }
        if (ball.state === 'fly' && ball.p >= 1) {
          this.splats.push({ x: ball.aimX, y: ball.aimY + 20 * this.U, life: 1.6 })
          this.ctx.audio.play('miss', 0.5)
          ball.state = 'done'
        }
      } else if (ball.state === 'back') {
        ball.bp += dt / BACK_T
        const aimX = sm.x + 0.05 * this.snowE
        const aimY = this.H * SNOW_Y - 0.9 * this.snowE
        ball.x = ball.blockX + (aimX - ball.blockX) * ball.bp
        ball.y = ball.blockY + (aimY - ball.blockY) * ball.bp - Math.sin(Math.PI * ball.bp) * 0.12 * this.H
        ball.r = ball.R * 0.28
        if (ball.bp >= 1) {
          sm.hitT = HIT_STUN
          this.ctx.addScore(ball.blocker)
          this.ctx.audio.play('score', 0.5)
          this.particles.burst(sm.x, aimY, '#ffffff', 24, 320, 4)
          ball.state = 'done'
        }
      }
    }
    this.balls = this.balls.filter((b2) => b2.state !== 'done')

    // 雪人换位（投完且非蓄力非硬直）
    for (const sm of this.snowmen) {
      if (sm.chargeT <= 0 && sm.hitT <= 0.3 && Math.abs(sm.x - sm.goalX) < 4) this.reposition(sm)
    }

    if (this.t >= DUR) this.ctx.finish()
  }

  private layoutSnowmen() {
    for (const sm of this.snowmen) sm.goalX = this.zoneOrSideX(sm)
  }

  private zoneCx(target: number) {
    return this.seats > 1 ? (target === 0 ? this.W * 0.25 : this.W * 0.75) : this.W / 2
  }

  private zoneOrSideX(sm: Snowman) {
    const duo = this.seats > 1
    return (duo ? (sm.side === 0 ? 0.1 : 0.9) : sm.side === 0 ? 0.2 : 0.8) * this.W
  }

  private throwFrom(sm: Snowman) {
    const target = sm.pendingTarget
    const b = this.lastBodies[target]
    const T = b ? Math.max(60, b.scale * this.H * 1.1) : this.H * 0.2
    const ox = (this.rng() * 2 - 1) * 0.85 * T
    const oy = (-0.75 + this.rng() * 1.1) * T
    const idx = this.snowmen.indexOf(sm)
    this.balls.push({
      target, snowman: idx, ox, oy, p: 0, state: 'fly', bp: 0,
      R: Math.max(40 * this.U, T * 0.3),
      x: sm.x + 0.05 * this.snowE,
      y: this.H * SNOW_Y - 0.9 * this.snowE,
      r: 6 * this.U, blocker: 0,
      aimX: b ? b.shoulderC.x * this.W + ox : this.W / 2,
      aimY: b ? b.shoulderC.y * this.H + oy : this.H * 0.45,
      blockX: 0, blockY: 0,
    })
    this.ctx.audio.play('click', 0.4, 0.8)
    this.reposition(sm)
  }

  private reposition(sm: Snowman) {
    const duo = this.seats > 1
    const lo = duo ? (sm.side === 0 ? 0.04 : 0.84) : sm.side === 0 ? 0.06 : 0.64
    const hi = duo ? (sm.side === 0 ? 0.16 : 0.96) : sm.side === 0 ? 0.36 : 0.94
    for (let k = 0; k < 6; k++) {
      const cand = (lo + this.rng() * (hi - lo)) * this.W
      const ok = this.snowmen.every((o) => o === sm || o.side !== sm.side || Math.abs(o.x - cand) > 0.12 * this.W)
      if (ok) {
        sm.goalX = cand
        return
      }
    }
    sm.goalX = sm.x
  }

  paint(c: CanvasRenderingContext2D) {
    const U = this.U
    // 天空罩层
    c.fillStyle = 'rgba(230,244,255,.4)'
    c.fillRect(0, 0, this.W, this.H * 0.35)
    c.fillStyle = 'rgba(223,240,255,.27)'
    c.fillRect(0, this.H * 0.35, this.W, this.H * 0.3)
    c.fillStyle = 'rgba(234,246,255,.2)'
    c.fillRect(0, this.H * 0.65, this.W, this.H * 0.35)
    // 雪花
    for (const fl of this.flakes) {
      c.globalAlpha = 0.8
      circle(c, fl.x, fl.y, 2.2, '#ffffff')
      c.globalAlpha = 1
    }
    // 雪渍
    for (const s of this.splats) {
      c.globalAlpha = Math.min(0.92, s.life / 0.6)
      circle(c, s.x, s.y + (1.6 - s.life) * 20 * U, 26 * U, '#eaf6ff')
      c.globalAlpha = 1
    }
    // 雪人（按 x 排序）
    const sorted = [...this.snowmen].sort((a, b) => a.x - b.x)
    for (const sm of sorted) {
      const footY = this.H * SNOW_Y
      const E = this.snowE
      const shake = sm.hitT > 0 ? Math.sin(sm.hitT * 18) * 0.15 * sm.hitT * 40 : Math.sin(this.t * 14 + sm.phase) * 3
      // 阴影
      c.fillStyle = 'rgba(0,0,0,.12)'
      c.beginPath()
      c.ellipse(sm.x + shake, footY, E * 0.52, E * 0.2, 0, 0, Math.PI * 2)
      c.fill()
      // 身体 + 头
      circle(c, sm.x + shake, footY - E * 0.62, E * 0.38, '#ffffff')
      circle(c, sm.x + shake, footY - E * 1.22, E * 0.28, '#ffffff')
      // 蓄力手（举起）
      const chargeK = sm.chargeT > 0 ? 1 - sm.chargeT / CHARGE_T : 0
      if (sm.chargeT > 0) {
        circle(c, sm.x + shake + E * 0.3, footY - E * (1.4 + chargeK * 0.2), E * 0.12, '#ffffff')
      }
      // 脸
      circle(c, sm.x + shake - E * 0.09, footY - E * 1.28, E * 0.035, '#26152c')
      circle(c, sm.x + shake + E * 0.09, footY - E * 1.28, E * 0.035, '#26152c')
      c.fillStyle = '#ff9f43'
      c.beginPath()
      c.moveTo(sm.x + shake, footY - E * 1.22)
      c.lineTo(sm.x + shake + E * 0.16, footY - E * 1.18)
      c.lineTo(sm.x + shake, footY - E * 1.14)
      c.closePath()
      c.fill()
      if (sm.hitT > 0.6) txt(c, '😵', sm.x + shake, footY - E * 1.6, 26 * U, '#fff')
    }
    // 瞄准圈 + 雪球
    const sortedBalls = [...this.balls].sort((a, b) => a.r - b.r)
    for (const ball of sortedBalls) {
      if (ball.state === 'fly' && ball.p >= 0.25) {
        const p = clamp(ball.p, 0, 1)
        c.strokeStyle = this.players[ball.target].color
        c.globalAlpha = 0.2 + p * 0.5
        c.lineWidth = 3
        c.setLineDash([12 * U, 10 * U])
        c.lineDashOffset = -this.t * 40
        c.beginPath()
        c.arc(ball.aimX, ball.aimY, ball.R * (1.15 + Math.sin(this.t * 5) * 0.05), 0, Math.PI * 2)
        c.stroke()
        c.setLineDash([])
        c.globalAlpha = 1
      }
      circle(c, ball.x, ball.y, ball.r, '#ffffff')
      c.strokeStyle = 'rgba(0,0,0,.1)'
      c.lineWidth = 1
      c.beginPath()
      c.arc(ball.x, ball.y, ball.r, 0, Math.PI * 2)
      c.stroke()
    }
  }
}

type Body0 = import('@/core/types').Body

export default function create(ctx: GameContext) {
  return new SnowballFight(ctx)
}
