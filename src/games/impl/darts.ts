import { BaseGame } from '@/core/base'
import type { Game, GameContext, PoseFrame } from '@/core/types'
import { circle, outlineTxt, rr, txt } from '@/core/draw'

/**
 * 投飞镖（对齐 dongdongpark 真实规则，见 _reverse/reports/darts.md）：
 * 手举到耳锚点武装（手相对耳朵的偏移即瞄准点），静止蓄力压缩散布，
 * 快甩过门槛后按峰值回落出手；慢甩落点下坠最多 0.5 靶半径；每轮 3 镖 × 5 轮记分板。
 */

/** 对齐站点难度表：r 靶半径(×unit) / k 瞄准增益 / flick 出手最低甩速(躯干/s) /
 *  good 满散布补偿的好甩速度 / tol 持稳速度阈值 / focus 蓄满需时(s) /
 *  sMin 稳定满时散布(靶半径比) / sMax 未稳定散布比 */
const DIFF = [
  { r: 150, k: 0.5, flick: 1.9, good: 2.8, tol: 0.6, focus: 0.6, sMin: 0.17, sMax: 0.5 },
  { r: 135, k: 0.42, flick: 2.2, good: 3.2, tol: 0.45, focus: 0.8, sMin: 0.2, sMax: 0.6 },
  { r: 120, k: 0.36, flick: 2.5, good: 3.6, tol: 0.35, focus: 1, sMin: 0.24, sMax: 0.75 },
]
const ROUNDS = 5 // 轮数
const DARTS = 3 // 每轮镖数
const FLIGHT_T = 0.42 // 飞镖飞行时长 s
const HOLD_CAP = 1.3 // 进入持稳状态的速度上限（躯干/s）
const SLOW_MAX = 0.5 // 慢甩最大下坠惩罚（靶半径）
const DART_GAP = 0.55 // 每镖间隔 s
const NEXT_ROUND_T = 0.9 // 下一轮延迟 s
const SOLO_LIMIT = 260 // 单人超时 s
const DUO_LIMIT = 480 // 双人超时 s

interface StuckDart {
  x: number
  y: number
  t: number // 插靶抖动计时
  score: number
}

interface FlyingDart {
  from: { x: number; y: number }
  ctrl: { x: number; y: number }
  to: { x: number; y: number }
  ring: number
  slow: boolean
}

interface PState {
  scores: number[] // 每轮得分（5 轮）
  round: number // 当前轮 0-based
  roundPts: number[] // 本轮已投各镖得分
  armed: boolean
  aim: { x: number; y: number } // 瞄准点（靶半径单位，相对靶心）
  focus: number
  ready: boolean
  peak: number
  peakVy: number
  fastT: number // 速度升破 1.3 后的计时
  phase: 'wait' | 'aim' | 'fly'
  flyT: number
  dartFly: FlyingDart | null
  clearT: number // 本轮结束后清插靶镖倒计时
  cooldown: number // 提示冷却
  noArmT: number // 未武装计时
  stuck: StuckDart[]
  bull: number
  onBoard: number
  darts: number
  bestRound: number
}

class Darts extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  unit = this.H / 720
  ps: [PState, PState]
  groups = 0 // 已完成的投掷组（轮）数
  orderIdx = 0 // 双人轮换指针
  bannerT = 0
  bannerText = ''
  bannerColor = '#fff'
  roundGap = 0.4 // 首轮前 0.4s，后续轮 0.9s
  endT = 0
  started = false
  finished = false
  score = 0

  constructor(ctx: GameContext) {
    super(ctx)
    this.ps = [this.newPS(), this.newPS()]
  }

  private newPS(): PState {
    return {
      scores: [0, 0, 0, 0, 0],
      round: 0,
      roundPts: [],
      armed: false,
      aim: { x: 0, y: 0 },
      focus: 0,
      ready: false,
      peak: 0,
      peakVy: 0,
      fastT: 0,
      phase: 'wait',
      flyT: 0,
      dartFly: null,
      clearT: 0,
      cooldown: 0,
      noArmT: 0,
      stuck: [],
      bull: 0,
      onBoard: 0,
      darts: 0,
      bestRound: 0,
    }
  }

  /** 当前该谁投：单人始终 P0；双人轮流（每轮一人 3 镖） */
  private active(): number {
    const duo = this.players.filter((p) => p.body).length >= 2
    return duo ? this.orderIdx % 2 : 0
  }

  /** 靶几何：R = r×unit×(双人 0.92)；y = max(H×0.42, R×1.4+105u)；x 单人 min(W×0.76, W−R×1.25)，双人居中 */
  private target(pi: number) {
    const u = this.unit
    const duo = this.players.filter((p) => p.body).length >= 2
    const R = this.cfg.r * u * (duo ? 0.92 : 1)
    const y = Math.max(this.H * 0.42, R * 1.4 + 105 * u)
    const x = duo ? (pi === 0 ? this.W * 0.25 : this.W * 0.75) : Math.min(this.W * 0.76, this.W - R * 1.25)
    return { x, y, R }
  }

  /** 耳锚点：肩心 ± 侧向×0.4×torso，肩y − 0.5×torso（持镖侧） */
  private earAnchor(body: import('@/core/types').Body) {
    const torso = Math.max(0.05, body.scale) * this.H
    const sx = body.shoulderC.x * this.W
    const sy = body.shoulderC.y * this.H
    // 持镖侧：取离肩心更远的那只手的方向（站点按手相对肩心 x 判断持镖侧）
    const side = body.lHand.x <= body.rHand.x ? -1 : 1
    return { x: sx + side * 0.4 * torso, y: sy - 0.5 * torso }
  }

  tick(f: PoseFrame, dt: number) {
    this.bannerT = Math.max(0, this.bannerT - dt)
    const duo = this.players.filter((p) => p.body).length >= 2

    // 全部组数完成 → 横幅后写统计并结束（对齐站点 ee()/finish）
    if (!this.finished && this.groups >= ROUNDS * (duo ? 2 : 1)) {
      this.endT -= dt
      if (this.endT <= 0) {
        this.finished = true
        this.ctx.finish()
        return
      }
    }
    // 超时：t > 480（双人）/ 260（单人）
    if (!this.finished && this.t > (duo ? DUO_LIMIT : SOLO_LIMIT)) {
      this.finished = true
      this.ctx.finish()
      return
    }

    // 回合推进：等待期倒计时归零 → 开轮/下一镖
    if (!this.started && !this.finished && this.groups < ROUNDS * (duo ? 2 : 1)) {
      this.roundGap -= dt
      if (this.roundGap <= 0) {
        this.started = true
        this.startGroup()
      }
    }

    const ai = this.active()
    for (let pi = 0; pi < 2; pi++) {
      const st = this.ps[pi]
      st.cooldown = Math.max(0, st.cooldown - dt)
      if (st.clearT > 0) {
        st.clearT -= dt
        if (st.clearT <= 0) st.stuck.length = 0
      }
      for (const d of st.stuck) d.t += dt
      if (pi === ai && this.started && !this.finished) this.tickAim(st, pi, f, dt)
    }

    // 飞行镖推进
    for (let pi = 0; pi < 2; pi++) {
      const st = this.ps[pi]
      if (st.phase !== 'fly') continue
      st.flyT += dt
      if (st.flyT >= FLIGHT_T) this.dartLand(st)
    }

    this.ctx.setScore(this.score)
  }

  /** 组开启（一轮或轮内下一镖）：轮首播横幅+语音 Q()，轮内直接回瞄准 */
  private startGroup() {
    const ai = this.active()
    const st = this.ps[ai]
    if (st.roundPts.length === 0) {
      const duo = this.players.filter((p) => p.body).length >= 2
      st.phase = 'aim'
      const last = st.round === ROUNDS - 1
      this.bannerText = duo ? `轮到玩家 ${ai + 1} · 第 ${st.round + 1} 轮` : `第 ${st.round + 1} 轮`
      if (last) this.bannerText = `最后一轮！`
      this.bannerColor = '#ffd54a'
      this.bannerT = 1.6
      this.ctx.speak(last ? '最后一轮！' : duo ? `轮到玩家 ${ai + 1}，手举到耳朵边，瞄准，往前一甩` : '手举到耳朵边，瞄准，往前一甩！')
      this.ctx.audio.play('pop', 0.7, 1.1) // 站点 appear
    } else {
      st.phase = 'aim' // 轮内下一镖（间隔 0.55s 已在 roundGap 走完）
    }
  }

  private handSpeedT(body: import('@/core/types').Body): number {
    // 手速（躯干/s）：取两手较大值（站点 speed = |hand.vel| / max(40, torso) 等价）
    const torso = Math.max(0.05, body.scale)
    return Math.max(body.lHandV, body.rHandV) / torso
  }

  /** 武装/蓄力/出手（对齐站点 §2.2-2.5） */
  private tickAim(st: PState, pi: number, f: PoseFrame, dt: number) {
    const body = f.bodies[pi]
    if (!body) return
    const cfg = this.cfg
    const t = this.target(pi)
    const torso = Math.max(0.05, body.scale) * this.H
    const speed = this.handSpeedT(body)

    if (st.phase === 'aim') {
      const ear = this.earAnchor(body)
      // 持镖手：离耳锚更近的手
      const hx = body.lHand.x * this.W
      const hy = body.lHand.y * this.H
      const rx = body.rHand.x * this.W
      const ry = body.rHand.y * this.H
      const useLeft = Math.hypot(hx - ear.x, hy - ear.y) <= Math.hypot(rx - ear.x, ry - ear.y)
      const px = useLeft ? hx : rx
      const py = useLeft ? hy : ry
      const dx = px - ear.x
      const dy = py - ear.y
      const inWin = Math.abs(dx) < 0.62 * t.R && dy > -0.62 * t.R && dy < 0.42 * t.R

      if (!st.armed) {
        // 武装：手进耳锚窗 + 速度 <1.3 躯干/s
        st.noArmT += dt
        if (inWin && speed < HOLD_CAP) {
          st.armed = true
          st.noArmT = 0
          st.peak = 0
          st.fastT = 0
          st.focus = Math.min(st.focus, 0.99)
        } else if (st.noArmT > 6 && st.cooldown <= 0) {
          st.cooldown = 8
          st.noArmT = 0
          this.say('手举到耳朵边，拿好飞镖', ear.x, ear.y - 60, '#ff9f43', 30)
        }
        return
      }

      // 已武装
      if (!inWin) {
        // 手离耳锚区：曾快甩未达门槛 → 取消并提示
        if (st.peak > 0 && st.peak < cfg.flick && st.cooldown <= 0) {
          st.cooldown = 2.5
          this.say('甩快一点才飞得出去！', px, py - 60, '#ff9f43', 30)
        }
        st.armed = false
        st.focus *= 0.5
        return
      }

      // 瞄准点 = 手相对耳朵的偏移 ÷(k×torso)（靶半径单位）
      st.aim = { x: dx / (cfg.k * torso), y: dy / (cfg.k * torso) }
      // 稳定蓄力：armed 且速度 <tol → focus += dt/T.focus；超速按 2×(speed/tol−1) 衰减（上限 3）
      if (speed < cfg.tol) {
        st.focus = Math.min(3, st.focus + dt / cfg.focus)
        if (st.focus >= 1 && !st.ready) {
          st.ready = true
          this.ctx.audio.tick() // 蓄满提示
        }
      } else {
        st.focus = Math.max(0, st.focus - dt * 2 * (speed / cfg.tol - 1))
        if (st.focus < 0.6) st.ready = false
      }

      // 出手：速度升破 1.3 → 记录 peak 与峰值方向；峰值 ≥flick 且向前且回落 → 发射
      if (speed > HOLD_CAP) {
        st.fastT += dt
        if (speed > st.peak) {
          st.peak = speed
          const vy = this.handVyT(f, pi)
          st.peakVy = vy
        }
        const forward = st.peakVy > -0.45 * st.peak
        if (st.peak >= cfg.flick && forward && (speed < st.peak * 0.7 || st.fastT > 0.22)) {
          this.fire(st, pi, body)
          return
        }
        // 取消：0.4s 超时或速度 <0.91×peak 且未达 flick
        if (st.fastT > 0.4 || (speed < st.peak * 0.91 && st.peak < cfg.flick)) {
          st.armed = false
          st.focus *= 0.5
          st.peak = 0
          st.fastT = 0
        }
      } else {
        st.fastT = 0
        if (st.peak > 0 && speed < st.peak * 0.91 && st.peak < cfg.flick) {
          st.peak = 0
        }
      }
    }
  }

  /** 竖直手速（躯干/s，向下为正），trail 前后帧 */
  private handVyT(f: PoseFrame, pi: number): number {
    const body = f.bodies[pi]
    if (!body) return 0
    const torso = Math.max(0.05, body.scale) * this.H
    const dt = Math.max(0.016, f.dt || 1 / 30)
    const l = this.players[pi].lHand.trail
    const r = this.players[pi].rHand.trail
    let vy = 0
    let n = 0
    if (l.length >= 2) {
      vy += l[l.length - 1].y - l[l.length - 2].y
      n++
    }
    if (r.length >= 2) {
      vy += r[r.length - 1].y - r[r.length - 2].y
      n++
    }
    return n === 0 ? 0 : vy / n / dt / torso
  }

  /** 落点计算 ne()：散布 + 慢甩下坠 → 靶面坐标 → 环数 */
  private fire(st: PState, pi: number, body: import('@/core/types').Body) {
    const cfg = this.cfg
    const t = this.target(pi)
    const snapFocus = Math.min(1, st.focus)
    const Z = cfg.sMin + (cfg.sMax - cfg.sMin) * (1 - snapFocus)
    const ang = Math.random() * Math.PI * 2
    const dist = Math.random() * Z * t.R // rng 直接产生（内密外疏，对齐站点）
    // 慢甩下坠：clamp((good−peak)/(good−flick),0,1)×0.5 靶半径
    const drop = Math.max(0, Math.min(1, (cfg.good - st.peak) / (cfg.good - cfg.flick))) * SLOW_MAX * t.R
    const sx = t.x + st.aim.x * t.R + Math.cos(ang) * dist
    const sy = t.y + st.aim.y * t.R + Math.sin(ang) * dist + drop
    const ring = this.ringScore(Math.hypot(sx - t.x, sy - t.y) / t.R)

    st.phase = 'fly'
    st.flyT = 0
    const hand = body.rHandV >= body.lHandV ? body.rHand : body.lHand
    const from = { x: hand.x * this.W, y: hand.y * this.H }
    const distPx = Math.hypot(sx - from.x, sy - from.y)
    const arc = Math.min(120 * this.unit, distPx * 0.18)
    st.dartFly = {
      from,
      ctrl: { x: (from.x + sx) / 2, y: Math.min(from.y, sy) - arc },
      to: { x: sx, y: sy },
      ring,
      slow: drop > 0.12 * t.R,
    }
    st.armed = false
    st.peak = 0
    st.fastT = 0
    this.ctx.audio.slash() // 站点 whoosh
  }

  /** 环数（站点 p(dist/R) 黑盒 → 等价分档代理：靶心 50 / 内环 25 / 依次递减 / 出靶 0） */
  private ringScore(distR: number): number {
    if (distR <= 0.1) return 50
    if (distR <= 0.3) return 25
    if (distR <= 0.55) return 10
    if (distR <= 0.8) return 5
    if (distR <= 1) return 1
    return 0
  }

  private dartLand(st: PState) {
    const fly = st.dartFly!
    const s = fly.ring
    st.stuck.push({ x: fly.to.x, y: fly.to.y, t: 0, score: s })
    st.darts++
    st.roundPts.push(s)
    if (s > 0) st.onBoard++
    if (s === 50) st.bull++
    this.score += s
    const tx = fly.to.x
    const ty = fly.to.y
    if (s === 50) {
      this.say('正中靶心！', tx, ty - 50, '#ffd54a', 40)
      this.ctx.audio.play('win', 0.8) // tada
      this.ctx.audio.pop()
      this.particles.confetti(this.W, 30)
      this.particles.burst(tx, ty, '#ffd54a', 8, 320 * this.unit, 12 * this.unit)
      this.shakeT = 0.35
    } else if (s === 25) {
      this.say('+25', tx, ty - 40, '#ff9f43', 34)
      this.ctx.audio.good() // chime
      this.particles.burst(tx, ty, '#ff9f43', 6, 260 * this.unit, 10 * this.unit)
    } else if (s === 10) {
      this.say('+10', tx, ty - 36, '#4cc9f0', 30)
      this.ctx.audio.coin()
    } else if (s > 0) {
      this.say(`+${s}`, tx, ty - 32, '#fff', 26)
      this.ctx.audio.pop()
    } else {
      this.say('脱靶！', tx, ty, '#9aa7b5', 28)
      this.ctx.audio.fail() // boing
    }
    st.phase = 'wait'
    st.dartFly = null
    if (fly.slow) this.say('再快一点甩！', tx, ty + 40, '#ff9f43', 28)

    // 一轮投完 → 横幅 + 推进；否则 0.55s 后下一镖
    const roundSum = st.roundPts.reduce((a, b) => a + b, 0)
    if (st.roundPts.length >= DARTS) {
      st.scores[st.round] = roundSum
      st.bestRound = Math.max(st.bestRound, roundSum)
      this.bannerT = 1.9
      if (roundSum >= 100) {
        this.bannerText = `本轮 ${roundSum} 分 · 神投手！`
        this.ctx.audio.play('win', 0.9)
      } else if (roundSum >= 75) {
        this.bannerText = '太棒了！'
        this.ctx.audio.play('win', 0.7)
      } else if (roundSum >= 60) {
        this.bannerText = `本轮 ${roundSum} 分 · 真准！`
        this.ctx.audio.good()
      } else if (roundSum >= 30) {
        this.bannerText = '真不错！'
        this.ctx.audio.good()
      } else {
        this.bannerText = `投完啦！本轮 ${roundSum} 分`
        this.ctx.audio.pop()
      }
      this.bannerColor = '#ffd54a'
      st.round++
      this.groups++
      this.roundGap = NEXT_ROUND_T
      this.started = false
      this.endT = 2.2 // 全部组数完成后 2.2s 结束（横幅可见）
      const duo = this.players.filter((p) => p.body).length >= 2
      if (duo) this.orderIdx++
      st.clearT = 1.5 // 清掉上一轮的插靶镖（下一轮新靶）
    } else {
      this.roundGap = DART_GAP
      this.started = false
    }
  }

  private shakeT = 0

  update(f: PoseFrame, dt: number) {
    this.shakeT = Math.max(0, this.shakeT - dt)
    super.update(f, dt)
  }

  paint(c: CanvasRenderingContext2D) {
    const u = this.unit
    const duo = this.players.filter((p) => p.body).length >= 2
    c.save()
    if (this.shakeT > 0) {
      const amp = 7 * (this.shakeT / 0.35)
      c.translate(Math.sin(this.t * 70) * amp, Math.cos(this.t * 63) * amp * 0.5)
    }

    const ai = this.active()
    for (let pi = 0; pi < 2; pi++) {
      if (pi === 1 && !duo) continue
      const st = this.ps[pi]
      const t = this.target(pi)
      const active = pi === ai && this.started

      // 靶面：同心环（红白经典配色），回合中外圈用玩家色脉动
      const ringDefs: [number, string][] = [
        [1.0, '#f4f1ea'],
        [0.8, '#e63946'],
        [0.55, '#f4f1ea'],
        [0.3, '#e63946'],
        [0.1, '#ffd54a'],
      ]
      c.save()
      c.translate(t.x, t.y)
      for (const [k, col] of ringDefs) {
        circle(c, 0, 0, t.R * k, col)
        c.strokeStyle = 'rgba(60,50,60,.35)'
        c.lineWidth = 2 * u
        c.stroke()
      }
      c.beginPath()
      c.arc(0, 0, t.R * 0.05, 0, Math.PI * 2)
      c.fillStyle = '#e63946'
      c.fill()
      c.restore()
      if (active) {
        c.save()
        c.globalAlpha = 0.5 + Math.sin(this.t * 5) * 0.2
        c.strokeStyle = this.players[pi].color
        c.lineWidth = 5 * u
        c.beginPath()
        c.arc(t.x, t.y, t.R * 1.08, 0, Math.PI * 2)
        c.stroke()
        c.restore()
      }

      // 插靶镖（抖动衰减 sin(t×38)×exp(−t×7)×0.35 rad）
      for (const d of st.stuck) {
        c.save()
        c.translate(d.x, d.y)
        c.rotate(Math.sin(d.t * 38) * Math.exp(-d.t * 7) * 0.35)
        this.drawDart(c, 62 * u, d.score >= 50 ? '#ffd54a' : '#e63946')
        c.restore()
        if (d.score > 0) txt(c, `${d.score}`, d.x + 30 * u, d.y - 20 * u, 20, 'rgba(255,255,255,.9)')
      }

      // 瞄准预览：虚线抛物线 + 落点圈 + 十字准星（ready 变绿）
      if (st.armed && st.phase === 'aim') {
        const px = t.x + st.aim.x * t.R
        const py = t.y + st.aim.y * t.R
        const Z = cfgZ(this.cfg, Math.min(1, st.focus))
        const body = this.players[pi].body
        if (body) {
          const ear = this.earAnchor(body)
          const hx = body.lHand.x * this.W
          const hy = body.lHand.y * this.H
          const rx = body.rHand.x * this.W
          const ry = body.rHand.y * this.H
          const useLeft = Math.hypot(hx - ear.x, hy - ear.y) <= Math.hypot(rx - ear.x, ry - ear.y)
          const fx = useLeft ? hx : rx
          const fy = useLeft ? hy : ry
          c.save()
          c.setLineDash([8, 10])
          c.lineDashOffset = -this.t * 60
          c.strokeStyle = st.ready ? 'rgba(61,220,151,.9)' : 'rgba(255,255,255,.6)'
          c.lineWidth = 3 * u
          c.beginPath()
          c.moveTo(fx, fy)
          c.quadraticCurveTo((fx + px) / 2, Math.min(fy, py) - 90 * u, px, py)
          c.stroke()
          c.setLineDash([])
          // 散布圈
          c.beginPath()
          c.arc(px, py, Math.max(6 * u, Z * t.R), 0, Math.PI * 2)
          c.stroke()
          // 十字准星
          c.beginPath()
          c.moveTo(px - 14 * u, py)
          c.lineTo(px - 4 * u, py)
          c.moveTo(px + 4 * u, py)
          c.lineTo(px + 14 * u, py)
          c.moveTo(px, py - 14 * u)
          c.lineTo(px, py - 4 * u)
          c.moveTo(px, py + 4 * u)
          c.lineTo(px, py + 14 * u)
          c.strokeStyle = st.ready ? '#3ddc97' : '#ffffff'
          c.lineWidth = 3 * u
          c.stroke()
          c.restore()
        }
        // 蓄力环
        c.save()
        c.globalAlpha = 0.9
        c.beginPath()
        c.arc(t.x, t.y, t.R * 1.16, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, st.focus))
        c.strokeStyle = st.ready ? '#3ddc97' : 'rgba(255,255,255,.4)'
        c.lineWidth = 6 * u
        c.lineCap = 'round'
        c.stroke()
        c.restore()
        // 耳锚引导圈（未武装时）
        if (!st.armed) {
          const body2 = this.players[pi].body
          if (body2) {
            const ear = this.earAnchor(body2)
            c.save()
            c.setLineDash([6, 8])
            c.strokeStyle = 'rgba(255,255,255,.55)'
            c.lineWidth = 3 * u
            c.beginPath()
            c.arc(ear.x, ear.y, 0.5 * t.R, 0, Math.PI * 2)
            c.stroke()
            c.restore()
          }
        }
      }

      // 飞行镖
      if (st.phase === 'fly' && st.dartFly) {
        const fly = st.dartFly
        const e = Math.min(1, st.flyT / FLIGHT_T)
        const a = 1 - e
        const x = a * a * fly.from.x + 2 * a * e * fly.ctrl.x + e * e * fly.to.x
        const y = a * a * fly.from.y + 2 * a * e * fly.ctrl.y + e * e * fly.to.y
        const ang = Math.atan2(fly.to.y - fly.ctrl.y, fly.to.x - fly.ctrl.x)
        c.save()
        c.translate(x, y)
        c.rotate(ang + Math.PI / 2)
        this.drawDart(c, 120 * u, '#e63946')
        c.restore()
      }
    }
    c.restore()

    // 记分板：轮号列 + 每人得分列，当前轮黄色高亮（未投轮 ·，防偷看）
    const bw = duo ? 210 * u : 170 * u
    const bh = (ROUNDS + 2) * 40 * u
    const bx = this.W - bw - 24 * u
    const by = 24 * u
    rr(c, bx, by, bw, bh, 14 * u)
    c.fillStyle = 'rgba(20,26,60,.6)'
    c.fill()
    txt(c, '轮', bx + 34 * u, by + 26 * u, 20, '#ffffffaa')
    if (duo) {
      txt(c, 'P1', bx + bw * 0.45, by + 26 * u, 20, this.players[0].color)
      txt(c, 'P2', bx + bw * 0.8, by + 26 * u, 20, this.players[1].color)
    } else {
      txt(c, '得分', bx + bw * 0.6, by + 26 * u, 20, '#ffffffaa')
    }
    for (let r = 0; r < ROUNDS; r++) {
      const ry = by + 60 * u + r * 40 * u
      txt(c, `${r + 1}`, bx + 34 * u, ry, 20, '#ffffffaa')
      for (let pi = 0; pi < (duo ? 2 : 1); pi++) {
        const st = this.ps[pi]
        const playing = st.round === r && this.started && pi === ai
        const played = st.round > r || (st.round === r && st.roundPts.length >= DARTS)
        const show = played ? `${st.scores[r]}` : '·'
        const px = duo ? (pi === 0 ? bx + bw * 0.45 : bx + bw * 0.8) : bx + bw * 0.6
        if (playing) {
          rr(c, px - 28 * u, ry - 16 * u, 56 * u, 32 * u, 8 * u)
          c.fillStyle = 'rgba(255,213,74,.2)'
          c.fill()
        }
        txt(c, show, px, ry, 20, played || playing ? this.players[pi].color : '#ffffff77')
      }
    }
    // 总分行
    const ty2 = by + 60 * u + ROUNDS * 40 * u + 6 * u
    txt(c, '总', bx + 34 * u, ty2, 20, '#ffd54a')
    for (let pi = 0; pi < (duo ? 2 : 1); pi++) {
      const total = this.ps[pi].scores.reduce((a, b) => a + b, 0)
      const px = duo ? (pi === 0 ? bx + bw * 0.45 : bx + bw * 0.8) : bx + bw * 0.6
      txt(c, `${total}`, px, ty2, 22, '#ffd54a')
    }

    if (this.bannerT > 0) {
      c.globalAlpha = Math.min(1, this.bannerT / 0.3)
      outlineTxt(c, this.bannerText, this.W / 2, this.H * 0.2, 48, this.bannerColor)
      c.globalAlpha = 1
    }
    txt(c, '手举到耳锚点瞄准，停稳缩小散布，快甩出手——甩慢了会往下坠', this.W / 2, this.H - 26, 20, 'rgba(255,255,255,.85)', 'center', 'bold')
  }

  /** 飞镖造型：镖杆 + 镖翼 */
  private drawDart(c: CanvasRenderingContext2D, len: number, flightColor: string) {
    c.strokeStyle = '#c9c9d4'
    c.lineWidth = Math.max(3, len * 0.05)
    c.lineCap = 'round'
    c.beginPath()
    c.moveTo(0, -len * 0.5)
    c.lineTo(0, len * 0.5)
    c.stroke()
    // 针头
    c.strokeStyle = '#8a8a99'
    c.beginPath()
    c.moveTo(0, len * 0.5)
    c.lineTo(0, len * 0.62)
    c.stroke()
    // 镖翼
    c.fillStyle = flightColor
    c.beginPath()
    c.moveTo(0, -len * 0.5)
    c.lineTo(-len * 0.16, -len * 0.72)
    c.lineTo(0, -len * 0.58)
    c.lineTo(len * 0.16, -len * 0.72)
    c.closePath()
    c.fill()
  }
}

/** 散布半径 Z = sMin + (sMax−sMin)×(1−focus) */
function cfgZ(cfg: (typeof DIFF)[number], focus: number) {
  return cfg.sMin + (cfg.sMax - cfg.sMin) * (1 - focus)
}

export default function create(ctx: GameContext) {
  return new Darts(ctx)
}
