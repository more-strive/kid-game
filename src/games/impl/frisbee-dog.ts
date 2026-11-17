import { BaseGame } from '@/core/base'
import type { Game, GameContext, PoseFrame } from '@/core/types'
import { circle, outlineTxt, rr, txt } from '@/core/draw'

/**
 * 飞盘与小狗（对齐 dongdongpark 真实规则，见 _reverse/reports/frisbee-dog.md）：
 * 接住朋友扔来的飞盘（+1），看准时机横甩给奔跑的小狗（+2）——判定的不是弹道而是"何时松手"；
 * 判定线 = 掷出 flight 秒后狗嘴位置与 markX 的距离窗口；早/晚以秒计反馈。
 */

/** 对齐站点难度表：inT 来球飞行基准 / hover 悬停可接时长 / reach 接球点随机偏移(×torso) /
 *  curve 弧线幅度 / dog 狗速(×unit px/s) / vary 狗速波动 / win 判定窗口(×unit) /
 *  flight 掷出飞行时长 / swing 挥臂触发速度(躯干/s) / ghost 幽灵狗透明度 / cue 辅助提示等级 */
const DIFF = [
  { inT: 1.5, hover: 1.6, reach: [0.3, 0.8] as [number, number], curve: 0.12, dog: 230, vary: 0, win: 115, flight: 0.9, swing: 2.0, ghost: 0.38, cue: 2 },
  { inT: 1.2, hover: 1.1, reach: [0.35, 1] as [number, number], curve: 0.22, dog: 300, vary: 0.1, win: 85, flight: 0.8, swing: 2.4, ghost: 0.22, cue: 1 },
  { inT: 0.95, hover: 0.75, reach: [0.4, 1.15] as [number, number], curve: 0.32, dog: 370, vary: 0.18, win: 65, flight: 0.75, swing: 2.7, ghost: 0, cue: 0 },
]
const GROUND = 0.955 // 地面线 = H×0.955
const GRASS = 0.84 // 草地起始线 = H×0.84
const DOG_SIZE = 100 // 狗体型基准 ×unit
const DISC_R = 34 // 飞盘半径 ×unit
const NPC_SIZE = 92 // 朋友 NPC 体型 ×unit
const JUMP_HALF = 0.32 // 狗跳跃半程时长 s（总跳 0.64）
const JUMP_H = 95 // 跳跃高度 ×unit
const HOLD_MIN = 0.6 // 接住后至少持盘 0.6s 才允许掷出（防误触）
const DROP_GRAV = 700 // 漏接坠落重力 ×unit
const HAND_R = 18 // 手判定半径 px（站点 hand.r 等价代理）
const DISC_COLORS = ['#ff6b6b', '#ffd54a', '#4cc9f0', '#3ddc97', '#a78bfa']
const DOG_PALETTES = [
  { body: '#c98d4e', belly: '#f3d9ad', ear: '#8a5a2b' },
  { body: '#9aa7b5', belly: '#e8edf3', ear: '#5c6b7d' },
]

interface Pt {
  x: number
  y: number
}

/** 二次贝塞尔（对齐站点 O(p0,p1,p2,t)） */
function bez(p0: Pt, p1: Pt, p2: Pt, t: number): Pt {
  const a = 1 - t
  return {
    x: a * a * p0.x + 2 * a * t * p1.x + t * t * p2.x,
    y: a * a * p0.y + 2 * a * t * p1.y + t * t * p2.y,
  }
}

type DiscPhase = 'gap' | 'incoming' | 'hold' | 'fly' | 'drop'

interface Disc {
  phase: DiscPhase
  t: number
  from: Pt
  ctrl: Pt
  to: Pt
  x: number
  y: number
  scale: number
  colorIdx: number
  spin: number
  vx: number
  vy: number
  /** 掷出结果 */
  ok: boolean
  errS: number
  holdHand: 0 | 1
  holdPt: Pt
}

interface Dog {
  state: 'idle' | 'run' | 'leap' | 'happy' | 'away' | 'puzzled' | 'fetch'
  t: number
  u: number // 巡逻里程
  v: number
  dir: number
  L: number
  R: number
  markX: number
  pal: number
  phase: number // 跑步动画相位
  targetX: number
}

interface PState {
  disc: Disc
  dog: Dog
  inN: number // 接住次数（飞盘颜色循环）
  thrown: number // 掷出次数（含漏接来球）
  throws: number // 主动掷出次数
  caught: number
  dogOk: number
  earlyLate: number
  firstMissTip: boolean
  tipT: number // 教学提示冷却
  holdTipAt: number
}

class FrisbeeDog extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  unit = this.H / 720
  ps: [PState, PState]
  bannerT = 0
  bannerText = ''
  bannerColor = '#fff'
  score = 0
  /** 站点 env.heat（宿主黑盒）等价代理：局内线性爬坡 */
  heat = 0

  constructor(ctx: GameContext) {
    super(ctx)
    this.ps = [this.newPS(0), this.newPS(1)]
    this.ps[0].disc.t = 0.8 // P0 先来球
  }

  private newPS(pi: number): PState {
    return {
      disc: {
        phase: 'gap',
        t: 0,
        from: { x: 0, y: 0 },
        ctrl: { x: 0, y: 0 },
        to: { x: 0, y: 0 },
        x: 0,
        y: 0,
        scale: 1,
        colorIdx: 0,
        spin: 0,
        vx: 0,
        vy: 0,
        ok: false,
        errS: 0,
        holdHand: 0,
        holdPt: { x: 0, y: 0 },
      },
      dog: {
        state: 'idle',
        t: 0,
        u: 0,
        v: 0,
        dir: 1,
        L: 0,
        R: 0,
        markX: 0,
        pal: pi % DOG_PALETTES.length,
        phase: 0,
        targetX: 0,
      },
      inN: 0,
      thrown: 0,
      throws: 0,
      caught: 0,
      dogOk: 0,
      earlyLate: 0,
      firstMissTip: false,
      tipT: 0,
      holdTipAt: 0,
    }
  }

  tick(f: PoseFrame, dt: number) {
    this.heat = Math.min(1, this.t / 40) // 宿主 heat 黑盒 → 线性爬坡等价代理
    this.bannerT = Math.max(0, this.bannerT - dt)
    const duo = this.players.filter((p) => p.body).length >= 2
    for (let pi = 0; pi < 2; pi++) {
      if (pi === 1 && !duo) continue // 单人模式只有 P0 玩
      const st = this.ps[pi]
      st.tipT = Math.max(0, st.tipT - dt)
      this.tickDog(st, dt)
      this.tickDisc(st, pi, f, dt)
    }
    this.ctx.setScore(this.score)
    this.ctx.setExtra('接住飞盘', this.ps[0].caught + this.ps[1].caught)
    this.ctx.setExtra('小狗叼住', this.ps[0].dogOk + this.ps[1].dogOk)
    this.ctx.setExtra('扔早/晚', this.ps[0].earlyLate + this.ps[1].earlyLate)
  }

  // ---- 狗状态机 Z()：run → leap → happy → away；puzzled → fetch → away ----
  private tickDog(st: PState, dt: number) {
    const dog = st.dog
    dog.t += dt
    dog.phase += dt * 2.6 // 步频 2.6/s
    const size = DOG_SIZE * this.unit
    if (dog.state === 'run') {
      dog.u += dog.v * dt * dog.dir
      if (dog.u < dog.L) {
        dog.u = dog.L
        dog.dir = 1
      } else if (dog.u > dog.R) {
        dog.u = dog.R
        dog.dir = -1
      }
    } else if (dog.state === 'leap') {
      if (dog.t >= JUMP_HALF * 2) {
        dog.state = 'happy'
        dog.t = 0
      }
    } else if (dog.state === 'happy') {
      if (dog.t >= 0.9) {
        dog.state = 'away'
        dog.t = 0
        dog.dir = 1
      }
    } else if (dog.state === 'puzzled') {
      if (dog.t >= 0.7) {
        dog.state = 'fetch'
        dog.t = 0
      }
    } else if (dog.state === 'fetch') {
      const dx = dog.targetX - this.dogX(dog).x
      if (Math.abs(dx) < 0.3 * size) {
        this.ctx.audio.play('pop', 0.8, 0.7) // 站点 chomp(0.8)
        dog.state = 'away'
        dog.t = 0
      } else {
        dog.u += dog.v * 1.5 * dt * Math.sign(dx)
      }
    } else if (dog.state === 'away') {
      dog.u += dog.v * 2.2 * dt * dog.dir
      const ax = this.dogX(dog).x
      if (ax < -1.2 * size || ax > this.W + 1.2 * size) dog.state = 'idle'
    }
  }

  /** 里程 → 屏幕坐标（k(dog,u) 折返：L..R 间折叠） */
  private dogX(dog: Dog): { x: number; dir: number } {
    const span = dog.R - dog.L
    if (span <= 0) return { x: dog.L, dir: 1 }
    let m = ((dog.u - dog.L) % (2 * span) + 2 * span) % (2 * span)
    if (m > span) return { x: dog.R - (m - span), dir: -1 }
    return { x: dog.L + m, dir: 1 }
  }

  /** 掷出 flight 秒后狗的位置 u2 = k(dog, u+v×flight) */
  private dogFutureX(dog: Dog, sec: number) {
    const saved = dog.u
    dog.u += dog.v * sec
    const p = this.dogX(dog)
    dog.u = saved
    return p
  }

  // ---- 飞盘状态机：gap → incoming → hold → fly → land → gap；漏接经 drop 回 gap ----
  private tickDisc(st: PState, pi: number, f: PoseFrame, dt: number) {
    const d = st.disc
    const cfg = this.cfg
    const u = this.unit
    d.t += dt
    d.spin += (d.phase === 'fly' ? 18 : d.phase === 'hold' ? 4 : 13) * dt

    if (d.phase === 'gap') {
      const duoNow = this.players.filter((q) => q.body).length >= 2
      if (d.t >= 0.6) this.throwIncoming(st, pi, duoNow)
      return
    }

    if (d.phase === 'incoming') {
      const ease = 1 - Math.pow(1 - Math.min(1, d.t / cfg.inT), 1.7) // 先快后慢
      const p = bez(d.from, d.ctrl, d.to, ease)
      d.scale = 0.7 + 0.3 * ease
      if (d.t < cfg.inT) {
        d.x = p.x
        d.y = p.y
      } else {
        // 悬停：轻微摆动 + 缓慢下沉 14u/s（易接窗口）
        d.x = d.to.x + Math.sin(d.t * 3.1) * 6 * u
        d.y = d.to.y + Math.sin(d.t * 4.3) * 5 * u + (d.t - cfg.inT) * 14 * u
        d.scale = 1
      }
      // 接盘判定：两手逐帧检查
      const body = f.bodies[pi]
      if (body) {
        const hands = [
          { x: body.lHand.x * this.W, y: body.lHand.y * this.H },
          { x: body.rHand.x * this.W, y: body.rHand.y * this.H },
        ]
        for (const h of hands) {
          if (Math.hypot(h.x - d.x, h.y - d.y) < DISC_R * u * d.scale + HAND_R) {
            this.onCatch(st, pi, h)
            return
          }
        }
      }
      if (d.t >= cfg.inT + cfg.hover) {
        // 漏接 → drop：初速 + 700u 重力，落地停
        d.phase = 'drop'
        d.t = 0
        d.vx = (d.to.x - d.ctrl.x) * 0.3
        d.vy = 40 * u
        st.thrown++
        this.say('差一点！', d.x, d.y - 20, '#7a6b8a', 32)
        this.ctx.audio.drop() // 站点 boop(0.8)
        if (!st.firstMissTip) {
          st.firstMissTip = true
          this.ctx.speak('接住飞盘！')
        }
      }
      return
    }

    if (d.phase === 'drop') {
      d.vy += DROP_GRAV * u * dt
      d.x += d.vx * dt
      d.y += d.vy * dt
      if (d.y >= this.H * GROUND - DISC_R * u * 0.4) {
        d.phase = 'gap'
        d.t = 0
      }
      return
    }

    if (d.phase === 'hold') {
      // 跟随持盘手
      const body = f.bodies[pi]
      if (body) {
        const hp = d.holdHand === 0 ? body.lHand : body.rHand
        d.holdPt = { x: hp.x * this.W, y: hp.y * this.H }
      }
      d.x = d.holdPt.x
      d.y = d.holdPt.y
      if (body && d.t >= HOLD_MIN) this.tryThrow(st, pi, body)
      // 新手指引：前 3 次持盘扩散箭头；持盘 >7s 提示
      if (d.t > 7 && this.t - st.holdTipAt > 5) {
        st.holdTipAt = this.t
        this.say('甩手扔出去！', d.x, d.y - 60, '#ffd54a', 30)
      }
      return
    }

    if (d.phase === 'fly') {
      const p = bez(d.from, d.ctrl, d.to, Math.min(1, d.t / cfg.flight))
      d.x = p.x
      d.y = p.y
      // 判定 ok 时狗提前 0.32s 起跳（对齐站点 t ≥ flight−0.32）
      if (d.ok && d.t >= cfg.flight - 0.32 && st.dog.state === 'run') {
        st.dog.state = 'leap'
        st.dog.t = 0
        this.ctx.audio.jump()
      }
      if (d.t >= cfg.flight) this.settle(st, pi)
    }
  }

  /** 来球生成 q()：贝塞尔弧线飞向肩周随机接球点，时长 inT×(1−0.2×heat) */
  private throwIncoming(st: PState, pi: number, duo: boolean) {
    const cfg = this.cfg
    const u = this.unit
    const side = duo ? (pi === 0 ? -1 : 1) : Math.random() < 0.5 ? -1 : 1
    const z = this.zone(pi)
    const body = this.players[pi].body
    const torso = body ? Math.max(40, body.scale * this.H) : this.H * 0.2
    const cx = side * (cfg.reach[0] + (cfg.reach[1] - cfg.reach[0]) * Math.random()) * torso
    const cy = -0.45 + 0.85 * Math.random()
    const curve = (Math.random() * 2 - 1) * cfg.curve
    let tx: number
    let ty: number
    if (body) {
      tx = body.shoulderC.x * this.W + cx
      ty = body.shoulderC.y * this.H + cy * torso
    } else {
      tx = (z.x0 + z.x1) / 2 + cx * (140 * u / torso)
      ty = this.H * 0.42 + cy * 140 * u
    }
    tx = Math.max(z.x0 - 60 * u, Math.min(z.x1 + 60 * u, tx))
    ty = Math.max(this.H * 0.15, Math.min(this.H * 0.72, ty))
    const sx = side < 0 ? -40 * u : this.W + 40 * u
    const sy = ty - 140 * u
    const mid = { x: (sx + tx) / 2, y: (sy + ty) / 2 }
    const dist = Math.hypot(tx - sx, ty - sy)
    const nx = -(ty - sy) / (dist || 1)
    const nyy = (tx - sx) / (dist || 1)
    const d = st.disc
    d.phase = 'incoming'
    d.t = 0
    d.from = { x: sx, y: sy }
    d.ctrl = { x: mid.x + nx * curve * dist, y: mid.y + nyy * curve * dist - dist * 0.12 }
    d.to = { x: tx, y: ty }
    d.colorIdx = st.inN % DISC_COLORS.length
    st.disc.scale = 0.7
  }

  /** 接住：+1、star×8、立即放狗 J()（决定本回合判定线） */
  private onCatch(st: PState, pi: number, h: Pt) {
    const d = st.disc
    const cfg = this.cfg
    const u = this.unit
    d.phase = 'hold'
    d.t = 0
    // 记住用哪只手接的（持盘期跟随这只手）
    const body = this.players[pi].body
    if (body) {
      const dl = Math.hypot(body.lHand.x * this.W - h.x, body.lHand.y * this.H - h.y)
      const dr = Math.hypot(body.rHand.x * this.W - h.x, body.rHand.y * this.H - h.y)
      d.holdHand = dl <= dr ? 0 : 1
    } else {
      d.holdHand = 0
    }
    d.holdPt = { x: h.x, y: h.y }
    st.inN++
    st.caught++
    this.score++
    this.say('+1', d.x, d.y - 16, '#fff', 28)
    this.ctx.audio.play('pop', 1.2)
    this.particles.burst(d.x, d.y, '#ffd54a', 5, 260 * u, 13 * u)
    this.particles.burst(d.x, d.y, '#ffffff', 3, 220 * u, 9 * u)

    // 放狗 J()：狗速 = dog×unit×(双人0.85)×(1+vary 波动)×(1+0.15 heat)
    const duo = this.players.filter((p) => p.body).length >= 2
    const dog = st.dog
    dog.v = cfg.dog * u * (duo ? 0.85 : 1) * (1 + cfg.vary * (Math.random() * 2 - 1)) * (1 + 0.15 * this.heat)
    const runDist = dog.v * cfg.flight
    const z = this.zone(pi)
    const zoneW = z.x1 - z.x0
    const ratio0 = Math.max(0.3, Math.min(0.72, (runDist + 1.2 * runDist - 60 * u) / zoneW))
    const ratio = ratio0 + (0.8 - ratio0) * Math.random()
    const fromLeft = Math.random() < 0.5
    dog.markX = fromLeft ? z.x0 + ratio * zoneW : z.x1 - ratio * zoneW
    dog.L = z.x0 - (runDist + 60 * u)
    dog.R = z.x1 + (runDist + 60 * u)
    dog.u = dog.L + Math.random() * (dog.R - dog.L)
    dog.dir = 1
    dog.state = 'run'
    dog.t = 0
    this.ctx.audio.play('pop', 1.1, 0.8) // 站点 appear(1.1)
  }

  /** 掷出判定 Y()：横甩（|vel.x|/torso > swing 且横向为主）→ 计算狗 flight 秒后位置判 ok */
  private tryThrow(st: PState, pi: number, body: import('@/core/types').Body) {
    const cfg = this.cfg
    const torso = Math.max(0.05, body.scale)
    const hands: [Pt, Pt] = [
      { x: body.lHand.x * this.W, y: body.lHand.y * this.H },
      { x: body.rHand.x * this.W, y: body.rHand.y * this.H },
    ]
    const trailPairs: ([Pt, Pt] | null)[] = [
      this.trailVec(this.players[pi].lHand.trail),
      this.trailVec(this.players[pi].rHand.trail),
    ]
    for (let hi = 0; hi < 2; hi++) {
      const tp = trailPairs[hi]
      if (!tp) continue
      const vx = (tp[1].x - tp[0].x) / Math.max(0.016, this.lastDt) / (torso * this.H)
      const vyPx = (tp[1].y - tp[0].y) / Math.max(0.016, this.lastDt)
      const vxPx = (tp[1].x - tp[0].x) / Math.max(0.016, this.lastDt)
      if (Math.abs(vx) > cfg.swing && Math.abs(vxPx) > 0.8 * Math.abs(vyPx)) {
        this.doThrow(st, pi, hands[hi])
        return
      }
    }
  }

  /** 上次 tick 的真实 dt（供 trail 求速度） */
  private lastDt = 1 / 30

  private trailVec(trail: { x: number; y: number }[]): [Pt, Pt] | null {
    if (trail.length < 2) return null
    return [trail[trail.length - 2], trail[trail.length - 1]]
  }

  /** 掷出：ok → 狗嘴前方；fail → 落在 markX 地面；贝塞尔弧线 flight 秒 */
  private doThrow(st: PState, pi: number, hand: Pt) {
    const cfg = this.cfg
    const u = this.unit
    const d = st.disc
    const dog = st.dog
    const fut = this.dogFutureX(dog, cfg.flight)
    d.ok = dog.state === 'run' && Math.abs(fut.x - dog.markX) <= cfg.win * u
    d.errS = ((fut.x - dog.markX) * fut.dir) / Math.max(1, dog.v)
    st.throws++
    let to: Pt
    const size = DOG_SIZE * u
    if (d.ok) {
      to = { x: fut.x + fut.dir * size * 0.56, y: this.H * GROUND - JUMP_H * u - size * 0.72 }
    } else {
      to = { x: dog.markX, y: this.H * GROUND - DISC_R * u * 0.4 }
    }
    d.phase = 'fly'
    d.t = 0
    d.from = { x: hand.x, y: hand.y }
    const mid = { x: (hand.x + to.x) / 2, y: Math.min(hand.y, to.y) - Math.abs(to.x - hand.x) * 0.3 - 90 * u }
    d.ctrl = mid
    d.to = to
    this.ctx.audio.play('hit', 1.1, 1.3) // 站点 whoosh(1.25) → 噪声等价代理
    this.particles.burst(hand.x, hand.y, this.players[pi].color, 6, 200 * u, 8 * u, 0)
  }

  /** 结算 X()：狗叼住 +2 / 落地失败 + 早/晚秒数反馈 */
  private settle(st: PState, pi: number) {
    const d = st.disc
    const u = this.unit
    if (d.ok) {
      st.dogOk++
      this.score += 2
      this.say(Math.abs(d.errS) < 0.06 ? '正好！+2' : '叼住啦！+2', d.to.x, d.to.y - 30, '#3ddc97', 36)
      this.ctx.audio.play('pop', 1, 1.4) // 站点 chomp
      this.ctx.audio.good() // 站点 chime(2)
      this.particles.burst(d.to.x, d.to.y, '#ffd54a', 8, 300 * u, 12 * u)
      this.particles.burst(d.to.x, d.to.y, '#ff6b8a', 4, 220 * u, 10 * u, 300)
    } else {
      st.earlyLate++
      this.say('盘落地上啦', d.to.x, d.to.y - 20, '#8fbf6b', 30)
      this.ctx.audio.hit() // 站点 thud+oops
      this.ctx.audio.fail()
      this.particles.burst(d.to.x, this.H * GROUND - 10, '#8fbf6b', 8, 240 * u, 9 * u)
      // 狗歪头 → 冲过去叼起再离场
      const dog = st.dog
      dog.state = 'puzzled'
      dog.t = 0
      dog.targetX = d.to.x
      // 早/晚以秒计反馈（|err|<3 显示精确值，否则模糊版）
      const early = d.errS < 0
      const msg = Math.abs(d.errS) < 3
        ? `${early ? '早了' : '晚了'} ${Math.abs(d.errS).toFixed(1)} 秒`
        : early ? '早了一点！' : '晚了一点！'
      this.say(msg, this.zoneCenter(pi), this.H * 0.3, '#ff9f43', 32)
      if (!st.firstMissTip) {
        st.firstMissTip = true
        this.ctx.speak(early ? '早了，等小狗再近一点' : '晚了，小狗跑得快，要提前扔')
      }
    }
    d.phase = 'gap'
    d.t = -0.4 // 落地结算后稍作停顿再发下一球
  }

  private zoneCenter(pi: number) {
    const z = this.zone(pi)
    return (z.x0 + z.x1) / 2
  }

  /** 玩家区域：单人 0.08~0.92，双人 P0 0.03~0.47 / P1 0.53~0.97 */
  private zone(pi: number) {
    const duo = this.players.filter((p) => p.body).length >= 2
    if (!duo) return { x0: this.W * 0.08, x1: this.W * 0.92 }
    return pi === 0 ? { x0: this.W * 0.03, x1: this.W * 0.47 } : { x0: this.W * 0.53, x1: this.W * 0.97 }
  }

  update(f: PoseFrame, dt: number) {
    this.lastDt = dt
    super.update(f, dt)
  }

  paint(c: CanvasRenderingContext2D) {
    const u = this.unit
    const duo = this.players.filter((p) => p.body).length >= 2
    // 草地条带（站点 fd-grass 等价绘制）
    c.fillStyle = '#79b851'
    c.fillRect(0, this.H * GRASS, this.W, this.H * (1 - GRASS))
    c.fillStyle = '#8fce63'
    c.fillRect(0, this.H * GRASS, this.W, 14 * u)
    if (duo) {
      // 中央分隔线（站点 u(i,130u)）
      rr(c, this.W / 2 - 4 * u, this.H / 2 - 130 * u, 8 * u, 260 * u, 4 * u)
      c.fillStyle = 'rgba(255,255,255,.6)'
      c.fill()
    }

    for (let pi = 0; pi < 2; pi++) {
      const st = this.ps[pi]
      const d = st.disc
      const dog = st.dog
      const z = this.zone(pi)
      const size = DOG_SIZE * u
      // 朋友 NPC（扔飞盘的人，装饰）
      const npcX = pi === 0 ? z.x0 + 40 * u : z.x1 - 40 * u
      this.drawNpc(c, npcX, this.H * GROUND, NPC_SIZE * u)

      // 目标圈（hold/fly 期）：椭圆虚线 + 中央叉；窗口内绿圈脉冲（cue 等级）
      if ((d.phase === 'hold' || d.phase === 'fly') && dog.state !== 'idle') {
        const canGreen = d.t >= HOLD_MIN && dog.state === 'run' && Math.abs(this.dogFutureX(dog, this.cfg.flight).x - dog.markX) <= this.cfg.win * u
        const rx = this.cfg.win * u
        const ry = rx * 0.27
        c.save()
        c.setLineDash([10, 8])
        c.lineWidth = 4 * u
        c.strokeStyle = canGreen && this.cfg.cue >= 1 ? `rgba(61,220,151,${0.6 + Math.sin(this.t * 14) * 0.15})` : 'rgba(255,255,255,.65)'
        c.beginPath()
        c.ellipse(dog.markX, this.H * GROUND, rx, ry, 0, 0, Math.PI * 2)
        c.stroke()
        c.setLineDash([])
        c.beginPath()
        c.moveTo(dog.markX - 10 * u, this.H * GROUND - 6 * u)
        c.lineTo(dog.markX + 10 * u, this.H * GROUND + 6 * u)
        c.moveTo(dog.markX + 10 * u, this.H * GROUND - 6 * u)
        c.lineTo(dog.markX - 10 * u, this.H * GROUND + 6 * u)
        c.strokeStyle = 'rgba(255,255,255,.5)'
        c.lineWidth = 3 * u
        c.stroke()
        c.restore()
      }

      // 幽灵狗（持盘期按 flight 秒后预测位置，ghost 透明度）
      if (d.phase === 'hold' && this.cfg.ghost > 0 && dog.state === 'run') {
        const fut = this.dogFutureX(dog, this.cfg.flight)
        c.save()
        c.globalAlpha = this.cfg.ghost
        this.drawDog(c, fut.x, this.H * GROUND, size, dog)
        c.restore()
      }

      // 狗
      if (dog.state !== 'idle') this.drawDog(c, this.dogX(dog).x, this.H * GROUND, size, dog)

      // 飞盘
      if (d.phase !== 'gap') {
        c.save()
        c.translate(d.x, d.y)
        c.rotate(Math.sin(d.spin * 0.3) * 0.15)
        const dr = DISC_R * u * d.scale
        c.beginPath()
        c.ellipse(0, 0, dr, dr * 0.32, 0, 0, Math.PI * 2)
        c.fillStyle = DISC_COLORS[d.colorIdx]
        c.fill()
        c.strokeStyle = 'rgba(20,24,60,.4)'
        c.lineWidth = 2.5 * u
        c.stroke()
        c.beginPath()
        c.ellipse(0, -dr * 0.06, dr * 0.45, dr * 0.13, 0, 0, Math.PI * 2)
        c.fillStyle = 'rgba(255,255,255,.5)'
        c.fill()
        c.restore()
        // 阴影
        c.save()
        c.globalAlpha = 0.16
        c.beginPath()
        c.ellipse(d.x, this.H * GROUND, dr * 0.8, dr * 0.2, 0, 0, Math.PI * 2)
        c.fillStyle = '#000'
        c.fill()
        c.restore()
      }

      // 辅助提示梯度 cue：easy(2) 弹道预览点列 + 扔！；medium(1) 仅目标圈
      if (d.phase === 'hold' && this.cfg.cue >= 2 && d.t >= HOLD_MIN) {
        const pts = 12
        c.save()
        c.fillStyle = 'rgba(255,255,255,.75)'
        for (let i = 1; i <= pts; i++) {
          const e = 0.12 + (0.95 - 0.12) * (i / pts)
          const p = bez({ x: d.x, y: d.y }, d.ctrl, d.to, e)
          c.beginPath()
          c.arc(p.x, p.y, 4 * u * (1 - i / pts / 2), 0, Math.PI * 2)
          c.fill()
        }
        c.restore()
        outlineTxt(c, '扔！', d.x, d.y - 64 * u, 30 + Math.sin(this.t * 14) * 3, '#ffd54a')
      }
    }

    if (this.bannerT > 0) {
      c.globalAlpha = Math.min(1, this.bannerT / 0.3)
      outlineTxt(c, this.bannerText, this.W / 2, this.H * 0.24, 52, this.bannerColor)
      c.globalAlpha = 1
    }
    txt(c, '接住朋友的飞盘，等小狗跑近了再横向快甩！早了等等、晚了提前', this.W / 2, this.H - 26, 20, 'rgba(255,255,255,.9)', 'center', 'bold')
  }

  /** 小狗：8 帧跑步循环（相位采样）、嘴型、跳跃高度、影子缩放（站点精灵等价绘制） */
  private drawDog(c: CanvasRenderingContext2D, x: number, groundY: number, size: number, dog: Dog) {
    const pal = DOG_PALETTES[dog.pal]
    let jumpH = 0
    if (dog.state === 'leap') jumpH = JUMP_H * this.unit * Math.sin(Math.PI * Math.min(1, dog.t / (JUMP_HALF * 2)))
    const runBob = dog.state === 'run' ? Math.abs(Math.sin(dog.phase * Math.PI)) * size * 0.06 : 0
    const y = groundY - jumpH - runBob
    // 影子（跳得越高越小）
    c.save()
    c.globalAlpha = 0.2 * (1 - jumpH / (JUMP_H * this.unit + 1))
    c.beginPath()
    c.ellipse(x, groundY, size * (0.5 - (0.2 * jumpH) / (JUMP_H * this.unit + 1)), size * 0.1, 0, 0, Math.PI * 2)
    c.fillStyle = '#000'
    c.fill()
    c.restore()

    c.save()
    c.translate(x, y)
    const dir = dog.dir
    // 腿（跑步循环）
    c.strokeStyle = pal.ear
    c.lineWidth = size * 0.1
    c.lineCap = 'round'
    const legSwing = dog.state === 'run' ? Math.sin(dog.phase * Math.PI * 2) * size * 0.18 : 0
    for (const [ox, ph] of [
      [-size * 0.3, 0],
      [-size * 0.18, Math.PI],
      [size * 0.2, Math.PI * 0.5],
      [size * 0.32, Math.PI * 1.5],
    ] as const) {
      c.beginPath()
      c.moveTo(ox, size * 0.12)
      c.lineTo(ox + legSwing * Math.sin(ph) * 0.5 + dir * size * 0.04, size * 0.42)
      c.stroke()
    }
    // 身体
    c.beginPath()
    c.ellipse(0, 0, size * 0.46, size * 0.26, 0, 0, Math.PI * 2)
    c.fillStyle = pal.body
    c.fill()
    c.beginPath()
    c.ellipse(-dir * size * 0.05, size * 0.1, size * 0.3, size * 0.13, 0, 0, Math.PI * 2)
    c.fillStyle = pal.belly
    c.fill()
    // 尾巴
    c.beginPath()
    c.moveTo(-dir * size * 0.44, -size * 0.08)
    c.quadraticCurveTo(-dir * size * 0.62, -size * 0.3 + Math.sin(dog.phase * 6) * size * 0.06, -dir * size * 0.5, -size * 0.34)
    c.strokeStyle = pal.body
    c.lineWidth = size * 0.11
    c.stroke()
    // 头（puzzled 歪头 / happy 摇头）
    let tilt = 0
    if (dog.state === 'puzzled') tilt = 0.4
    if (dog.state === 'happy') tilt = Math.sin(this.t * 18) * 0.5
    c.save()
    c.translate(dir * size * 0.4, -size * 0.22)
    c.rotate(tilt * dir)
    c.beginPath()
    c.arc(0, 0, size * 0.2, 0, Math.PI * 2)
    c.fillStyle = pal.body
    c.fill()
    // 耳朵
    c.beginPath()
    c.ellipse(-dir * size * 0.08, -size * 0.16, size * 0.09, size * 0.15, dir * 0.5, 0, Math.PI * 2)
    c.fillStyle = pal.ear
    c.fill()
    // 眼睛 + 鼻子 + 嘴型
    circle(c, dir * size * 0.08, -size * 0.03, size * 0.03, '#243b6b')
    circle(c, dir * size * 0.17, size * 0.02, size * 0.035, '#243b6b')
    if (dog.state === 'happy') {
      // 叼盘（happy 期嘴里画飞盘）
      c.beginPath()
      c.ellipse(dir * size * 0.3, size * 0.08, size * 0.14, size * 0.05, 0, 0, Math.PI * 2)
      c.fillStyle = '#ff6b6b'
      c.fill()
    } else if (dog.state === 'puzzled') {
      c.beginPath()
      c.arc(dir * size * 0.22, size * 0.08, size * 0.04, 0, Math.PI * 2)
      c.fillStyle = '#5c4033'
      c.fill()
      outlineTxt(c, '？', dir * size * 0.1, -size * 0.42, size * 0.3, '#fff')
    } else {
      // 张嘴跑
      c.beginPath()
      c.arc(dir * size * 0.22, size * 0.08, size * 0.05, 0, Math.PI)
      c.fillStyle = '#5c4033'
      c.fill()
    }
    c.restore()
    c.restore()
  }

  /** 朋友 NPC：扔飞盘的人（站点精灵等价绘制，装饰） */
  private drawNpc(c: CanvasRenderingContext2D, x: number, groundY: number, size: number) {
    c.save()
    c.translate(x, groundY)
    // 腿
    c.strokeStyle = '#3d5a80'
    c.lineWidth = size * 0.12
    c.lineCap = 'round'
    c.beginPath()
    c.moveTo(-size * 0.1, -size * 0.4)
    c.lineTo(-size * 0.14, 0)
    c.moveTo(size * 0.1, -size * 0.4)
    c.lineTo(size * 0.14, 0)
    c.stroke()
    // 身体
    rr(c, -size * 0.2, -size * 0.78, size * 0.4, size * 0.44, size * 0.1)
    c.fillStyle = '#ee6c4d'
    c.fill()
    // 投掷手臂（前伸）
    c.strokeStyle = '#ffd9b3'
    c.lineWidth = size * 0.1
    c.beginPath()
    c.moveTo(size * 0.16, -size * 0.7)
    c.lineTo(size * 0.42, -size * 0.62)
    c.stroke()
    // 头
    circle(c, 0, -size * 0.92, size * 0.14, '#ffd9b3')
    c.beginPath()
    c.arc(0, -size * 0.96, size * 0.14, Math.PI, Math.PI * 2)
    c.fillStyle = '#6d4c41'
    c.fill()
    c.restore()
  }
}

export default function create(ctx: GameContext) {
  return new FrisbeeDog(ctx)
}
