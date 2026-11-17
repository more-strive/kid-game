import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, ring, txt } from '@/core/draw'

/**
 * 躲避球 / dodgeball（对齐 dongdongpark 真实规则）：
 * 投手扔球，看地面影子预判落点——低球跳、高球蹲、侧球侧身让、黄色软球伸手接。
 *
 * 全部字面量沿用站点难度表：period 出球节奏（随 heat 收敛）、windup 抬手、flight 飞行
 * （×(1−0.12×heat)）、double 连击二球概率与间隔、fake 假动作（仅 hard 的 side 球）；
 * 前 4 球固定教学序 high→low→side→soft，之后加权 low .27/high .27/side .26/soft .2，
 * 防三连（连续两次同类顺延到下一个）；二球类型选「需要相反动作」的候选表；
 * 球半径 low .32T / soft .36T / high·side .4T，视觉半径 (0.22+0.78×o²) 越飞越大；
 * low/high 前 80% 飞行追踪玩家髋部（假动作后追踪速率 5→9）；
 * 判定表：low=0.6s 内跳过｜双脚踝上 0.15T｜髋升高 0.2T；high=squat｜头低于落点｜头横向偏离；
 * side=髋离落点 0.6T｜肩髋中点 0.75T；软球最后 28% 才能接（手到球心 < 球半径+手半径）；
 * 躲开 +1、接住 +2、被打 0 分（泛红 0.5s）、连躲 ≤1.2s 触发庆祝特效不加分。
 *
 * 与站点的差异（写明待实测）：
 * 1) heat：站点由宿主黑盒注入，本框架 ctx.heat = 局内时长线性 0→1（见 core/engine.ts）；
 * 2) 站点读 motion.squat 连续量（>0.4），本框架只有布尔 squat → true 即判躲过（同 laser-hall）；
 * 3) 站点「无身体按 dodged 放行」，这里放行但不加分（防挂机刷分，与 laser-hall 同约定）；
 * 4) 投手是 db-monster 精灵，这里几何图形绘制。
 */
type Kind = 'high' | 'low' | 'side' | 'soft'

interface Plan {
  seq: number
  kind: Kind
  dir: number
  ox: number
  oy: number
  at: number // 出生时刻
  fake: boolean
  second: boolean // 连击二球
}

interface Ball {
  owner: number
  seq: number
  kind: Kind
  dir: number
  ox: number
  oy: number
  fake: boolean
  born: number
  throwAt: number
  arrive: number
  flight: number
  ix: number // 当前落点 x（low/high 会追踪玩家）
  iy: number
  R: number // 判定半径
  state: 'wind' | 'fly' | 'dodged' | 'hit' | 'caught' | 'dropped'
  doneAt: number
  faked: boolean
  caughtHand: number // -1 无，0 左 1 右
  // hit 弹飞
  bx: number
  by: number
  bvx: number
  bvy: number
}

interface Zone {
  x0: number
  x1: number
}

interface PState {
  balls: Ball[]
  anchor: { hipX: number; hipY: number; headY: number; shoulderY: number; ankleY: number; headX: number; T: number }
  lastJump: number
  wasJump: boolean
  dodged: number
  caught: number
  hits: number
  hurt: number
  firstDodge: boolean
  firstCatch: boolean
  lastDodgeSeq: number
  lastDodgeAt: number
  spot: number
  spotX: number
  pitcherMood: number // 被接住后沮丧 0.8s
  zone: Zone
}

/** 站点三档：出球节奏（起→末）/ 抬手 / 飞行 / 连击概率 / 连击间隔 / 假动作概率 */
const DIFF = [
  { period: [3, 2.4] as [number, number], windup: 0.7, flight: 2.2, double: 0, gap: 1, fake: 0 },
  { period: [2.5, 1.9] as [number, number], windup: 0.55, flight: 1.8, double: 0.15, gap: 0.9, fake: 0 },
  { period: [2.1, 1.5] as [number, number], windup: 0.45, flight: 1.45, double: 0.28, gap: 0.75, fake: 0.4 },
]

const TEACH: Kind[] = ['high', 'low', 'side', 'soft'] // 前 4 球固定顺序
const WEIGHT: [Kind, number][] = [['low', 0.27], ['high', 0.27], ['side', 0.26], ['soft', 0.2]]
const ORDER: Kind[] = ['low', 'high', 'side', 'soft'] // 防三连顺延顺序
const NEXT: Record<Kind, Kind[]> = { low: ['high', 'side'], high: ['side'], side: ['low', 'high'], soft: ['side'] }
const LOW_GRACE = 0.6 // 低球起跳宽限（秒）
const CLEAN = 1.1 // 结算后残留（秒）
const RADIUS: Record<Kind, number> = { low: 0.32, high: 0.4, side: 0.4, soft: 0.36 } // ×T
const HINT: Record<Kind, string> = { low: '低球，跳起来', high: '高球，蹲下', side: '侧球，闪开', soft: '软球，接住' }
const ICON: Record<Kind, string> = { low: '↓跳', high: '↑蹲', side: '↔闪', soft: '✋接' }

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)

class Dodgeball extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[0]
  plans: Plan[] = []
  states: PState[] = []
  seats = 1
  private seq = 0
  private nextAt = 1.2
  private recent: Kind[] = [] // 最近两次类型（防三连）
  private seatActive = [false, false]

  constructor(ctx: GameContext) {
    super(ctx)
    for (let i = 0; i < 2; i++) {
      this.states.push({
        balls: [],
        anchor: { hipX: 0, hipY: 0, headY: 0, shoulderY: 0, ankleY: 0, headX: 0, T: 120 },
        lastJump: -9, wasJump: false, dodged: 0, caught: 0, hits: 0, hurt: 0,
        firstDodge: true, firstCatch: true, lastDodgeSeq: -1, lastDodgeAt: -9,
        spot: 0, spotX: 0, pitcherMood: 0,
        zone: { x0: 0, x1: this.W },
      })
    }
    this.layout()
  }

  private layout() {
    const duo = this.seats > 1
    for (let i = 0; i < 2; i++) {
      this.states[i].zone = duo
        ? { x0: (i * this.W) / 2, x1: ((i + 1) * this.W) / 2 }
        : { x0: 0, x1: this.W }
    }
  }

  tick(f: PoseFrame, dt: number) {
    if (this.seats === 1 && f.bodies[1]) {
      this.seats = 2
      this.layout()
    }
    for (let i = 0; i < 2; i++) if (f.bodies[i]) this.seatActive[i] = true

    // 出球调度（全局一份计划，按玩家各生成一份球）
    if (this.t >= this.nextAt) this.schedule()

    for (let i = 0; i < 2; i++) {
      const st = this.states[i]
      if (!this.seatActive[i]) continue
      const b = f.bodies[i] ?? null
      if (st.hurt > 0) st.hurt -= dt
      if (st.pitcherMood > 0) st.pitcherMood -= dt
      if (b) this.track(st, b, dt)
      // 投手换位平滑（站点 0.35s）
      st.spotX += (this.pitcherX(st) - st.spotX) * Math.min(1, dt * 3)
      // 到点的新计划 → 生成这颗球
      for (const p of this.plans) {
        if (p.at > this.t || st.balls.some((bl) => bl.seq === p.seq)) continue
        st.balls.push(this.makeBall(st, p, i))
      }
      for (const bl of st.balls) this.stepBall(st, bl, b, dt)
      st.balls = st.balls.filter((bl) => bl.state === 'wind' || bl.state === 'fly' || this.t - bl.doneAt < CLEAN)
      this.ctx.setExtra(`dodged${i}`, st.dodged)
      this.ctx.setExtra(`caught${i}`, st.caught)
      this.ctx.setExtra(`hits${i}`, st.hits)
      const total = st.dodged + st.hits
      if (total > 0) this.ctx.setExtra(`rate${i}`, Math.round((100 * st.dodged) / total))
    }
    this.plans = this.plans.filter((p) => this.t - p.at < 12)
  }

  /** 出球计划：前 4 固定教学序，之后加权 + 防三连 + 连击 + 假动作 */
  private schedule() {
    const heat = this.ctx.heat
    let kind: Kind
    if (this.seq < 4) {
      kind = TEACH[this.seq]
    } else {
      const last = this.recent[this.recent.length - 1]
      const prev = this.recent[this.recent.length - 2]
      if (last !== undefined && last === prev) {
        // 防三连：顺延到权重表的下一个类型
        kind = ORDER[(ORDER.indexOf(last) + 1) % ORDER.length]
      } else {
        let r = Math.random()
        kind = 'soft'
        for (const [k, w] of WEIGHT) {
          if (r < w) { kind = k; break }
          r -= w
        }
      }
    }
    const p: Plan = {
      seq: this.seq++,
      kind,
      dir: Math.random() < 0.5 ? -1 : 1,
      ox: Math.random(),
      oy: Math.random(),
      at: this.t,
      fake: this.seq > 4 && kind === 'side' && Math.random() < this.cfg.fake,
      second: false,
    }
    this.recent.push(kind)
    if (this.recent.length > 2) this.recent.shift()

    // 连击二球（类型刻意选「需要相反动作」的）
    let extraGap = 0
    if (this.seq >= 4 && kind !== 'soft' && Math.random() < this.cfg.double) {
      const k2 = NEXT[kind][Math.floor(Math.random() * NEXT[kind].length)]
      this.plans.push({
        seq: this.seq++, kind: k2, dir: Math.random() < 0.5 ? -1 : 1,
        ox: Math.random(), oy: Math.random(), at: this.t + this.cfg.gap,
        fake: false, second: true,
      })
      extraGap = this.cfg.gap
      this.recent.push(k2)
      if (this.recent.length > 2) this.recent.shift()
    }
    this.plans.push(p)

    if (this.seq <= 4 || this.seq % 5 === 0) this.ctx.speak(HINT[kind])
    const period = this.cfg.period[0] + (this.cfg.period[1] - this.cfg.period[0]) * heat
    this.nextAt = this.t + extraGap + period * (0.9 + 0.2 * Math.random())
    // 投手换位
    for (let i = 0; i < 2; i++) {
      if (!this.seatActive[i]) continue
      this.states[i].spot = Math.random() < 0.5 ? 0 : 1
    }
  }

  private makeBall(st: PState, p: Plan, owner: number): Ball {
    const heat = this.ctx.heat
    const flight = this.cfg.flight * (1 - 0.12 * heat)
    const T = st.anchor.T
    const z = st.zone
    // 落点（side/soft 出生时定死，low/high 之后追踪）
    let ix = st.anchor.hipX
    let dir = p.dir
    if (p.kind === 'side') {
      if (st.anchor.hipX + dir * T < z.x0 + 0.3 * T || st.anchor.hipX + dir * T > z.x1 - 0.3 * T) dir = -dir
      ix = st.anchor.hipX - dir * 0.3 * T
    } else if (p.kind === 'soft') {
      const e = (0.62 + 0.28 * p.ox) * T
      if (st.anchor.hipX + dir * e < z.x0 + 0.2 * T || st.anchor.hipX + dir * e > z.x1 - 0.2 * T) dir = -dir
      ix = clamp(st.anchor.hipX + dir * e, z.x0 + 0.2 * T, z.x1 - 0.2 * T)
    } else {
      ix = clamp(st.anchor.hipX, z.x0 + 0.55 * T, z.x1 - 0.55 * T)
    }
    const iy = this.landY(p.kind, p.oy, st)
    return {
      owner, seq: p.seq, kind: p.kind, dir, ox: p.ox, oy: p.oy, fake: p.fake,
      born: p.at, throwAt: p.at + this.cfg.windup, arrive: p.at + this.cfg.windup + flight,
      flight, ix, iy, R: RADIUS[p.kind] * T,
      state: 'wind', doneAt: 0, faked: false, caughtHand: -1,
      bx: 0, by: 0, bvx: 0, bvy: 0,
    }
  }

  /** 落点高度（随玩家骨架实时刷新） */
  private landY(kind: Kind, oy: number, st: PState) {
    const T = st.anchor.T
    switch (kind) {
      case 'low': return st.anchor.ankleY - 0.3 * T
      case 'high': return st.anchor.headY + 0.12 * T
      case 'side': return st.anchor.shoulderY + 0.45 * T
      case 'soft': return st.anchor.shoulderY + (-0.3 + 0.55 * oy) * T
    }
  }

  private pitcherX(st: PState) {
    const z = st.zone
    const w = z.x1 - z.x0
    const target = z.x0 + w * (st.spot === 0 ? 0.15 : 0.85)
    return target
  }

  /** 锚点：髋/头/肩/踝快速跟随（低球与落点都瞄准当前身体） */
  private track(st: PState, b: Body | null, dt: number) {
    if (!b) return
    const k = Math.min(1, dt * 5)
    st.anchor.hipX += (b.hipC.x * this.W - st.anchor.hipX) * k
    st.anchor.hipY += (b.hipC.y * this.H - st.anchor.hipY) * k
    st.anchor.headX += (b.head.x * this.W - st.anchor.headX) * k
    st.anchor.headY += (b.head.y * this.H - st.anchor.headY) * k
    st.anchor.shoulderY += (b.shoulderC.y * this.H - st.anchor.shoulderY) * k
    st.anchor.ankleY += (Math.max(b.lFoot.y, b.rFoot.y) * this.H - st.anchor.ankleY) * k
    st.anchor.T = Math.max(70, b.scale * this.H * 1.1)
    if (b.jumping && !st.wasJump) st.lastJump = this.t
    st.wasJump = b.jumping
  }

  private stepBall(st: PState, bl: Ball, b: Body | null, dt: number) {
    if (bl.state === 'hit') {
      // 弹飞物理
      bl.bvy += 2.4 * this.H * dt
      bl.by += bl.bvy * dt
      bl.bx += bl.bvx * dt
      return
    }
    if (bl.state === 'wind') {
      if (this.t >= bl.throwAt) bl.state = 'fly'
      return
    }
    if (bl.state !== 'fly') return
    const o = clamp((this.t - bl.throwAt) / bl.flight, 0, 1.2)

    // 假动作：半程按玩家位移反向（仅 hard side 球）
    if (bl.fake && !bl.faked && o >= 0.5 && b) {
      bl.faked = true
      bl.dir = -bl.dir
      bl.ix = clamp(st.anchor.hipX + bl.dir * 0.3 * bl.R * 2.5, st.zone.x0 + 0.2 * st.anchor.T, st.zone.x1 - 0.2 * st.anchor.T)
      this.ctx.audio.play('tick', 0.7, 0.5)
      this.say('假动作！', bl.ix, bl.iy - 60, '#ff8fa8', 30)
    }
    // low/high 前 80% 追踪髋部
    if ((bl.kind === 'low' || bl.kind === 'high') && o < 0.8) {
      const target = clamp(st.anchor.hipX, st.zone.x0 + 0.55 * st.anchor.T, st.zone.x1 - 0.55 * st.anchor.T)
      bl.ix += (target - bl.ix) * (1 - Math.exp(-dt * (bl.faked ? 9 : 5)))
      bl.iy = this.landY(bl.kind, bl.oy, st)
      bl.R = RADIUS[bl.kind] * st.anchor.T
    } else if (bl.kind !== 'low' && bl.kind !== 'high') {
      bl.iy = this.landY(bl.kind, bl.oy, st)
      bl.R = RADIUS[bl.kind] * st.anchor.T
    }

    // 接软球：最后 28% 开放
    if (bl.kind === 'soft' && b && o >= 0.72 && o <= 1.0) {
      const pos = this.ballPos(st, bl, Math.min(1, o))
      const handR = st.anchor.T * 0.12
      const hands = [{ x: b.lHand.x * this.W, y: b.lHand.y * this.H }, { x: b.rHand.x * this.W, y: b.rHand.y * this.H }]
      for (let hi = 0; hi < 2; hi++) {
        if (Math.hypot(pos.x - hands[hi].x, pos.y - hands[hi].y) < bl.R + handR) {
          bl.state = 'caught'
          bl.doneAt = this.t
          bl.caughtHand = hi
          st.caught++
          this.ctx.addScore(2)
          this.ctx.audio.coin()
          this.particles.burst(pos.x, pos.y, '#ffd54a', 12, 260, 4)
          if (st.firstCatch || Math.random() < 0.3) {
            this.say('接住啦！', pos.x, pos.y - 50, '#ffd54a', 40)
            st.firstCatch = false
          }
          st.pitcherMood = 0.8
          return
        }
      }
    }
    // 软球漏接
    if (bl.kind === 'soft' && o >= 1.06) {
      bl.state = 'dropped'
      bl.doneAt = this.t
      this.ctx.audio.play('click', 0.5, 0.6)
      return
    }
    // 到达：判定
    if (this.t >= bl.arrive) {
      const dodged = bl.kind === 'soft' ? false : this.judge(st, bl, b)
      if (bl.kind !== 'soft' && dodged) {
        bl.state = 'dodged'
        bl.doneAt = this.t
        if (b) {
          st.dodged++
          this.ctx.addScore(1)
          this.ctx.audio.play('pop', 0.6, 1.3)
          // 连躲特效（上一球也躲开且出生间隔 <1.2s）
          if (st.lastDodgeSeq === bl.seq - 1 && this.t - st.lastDodgeAt < 1.2) {
            const pos = this.ballPos(st, bl, 1)
            this.particles.burst(pos.x, pos.y - 60, '#ffd54a', 18, 300, 5)
          } else if (st.firstDodge) {
            this.say('躲开啦！', st.anchor.hipX, st.anchor.headY - 60, '#9be15d', 40)
            st.firstDodge = false
          }
          st.lastDodgeSeq = bl.seq
          st.lastDodgeAt = this.t
        }
      } else if (bl.kind !== 'soft') {
        // 被打中：0 分，泛红 + 弹飞
        bl.state = 'hit'
        bl.doneAt = this.t
        const pos = this.ballPos(st, bl, 1)
        bl.bx = pos.x
        bl.by = pos.y
        bl.bvx = (Math.random() < 0.5 ? -1 : 1) * this.W * 0.3
        bl.bvy = -this.H * 0.9
        if (b) {
          st.hits++
          st.hurt = 0.5
          this.ctx.audio.fail()
          this.particles.burst(pos.x, pos.y, '#ff6b8a', 10, 300, 5)
          this.say('哎哟！', pos.x, pos.y - 50, '#ff6b8a', 40)
        }
      }
    }
  }

  /** true = 躲开（站点判定表） */
  private judge(st: PState, bl: Ball, b: Body | null): boolean {
    if (!b) return true // 放行但不加分（见文件头差异 3）
    const T = st.anchor.T
    const headR = Math.max(12, b.scale * this.H * 0.06)
    if (bl.kind === 'low') {
      if (this.t - st.lastJump < LOW_GRACE) return true
      const feet = [b.lFoot.y * this.H, b.rFoot.y * this.H]
      if (feet.every((y) => y < st.anchor.ankleY - 0.15 * T)) return true
      if (b.hipC.y * this.H < st.anchor.hipY - 0.2 * T) return true
      return false
    }
    if (bl.kind === 'high') {
      if (b.squat) return true
      if (b.head.y * this.H > bl.iy + bl.R + 0.15 * T) return true
      if (Math.abs(b.head.x * this.W - bl.ix) > bl.R + 0.8 * headR) return true
      return false
    }
    // side
    const midX = (b.shoulderC.x + b.hipC.x) / 2 * this.W
    if (Math.abs(b.hipC.x * this.W - bl.ix) > 0.6 * T) return true
    if (Math.abs(midX - bl.ix) > 0.75 * T) return true
    return false
  }

  /** 球当前位置：投手 → 落点线性插值（o≤1），命中后走弹飞物理 */
  private ballPos(st: PState, bl: Ball, o: number) {
    if (bl.state === 'hit') {
      return { x: bl.bx, y: bl.by }
    }
    if (bl.state === 'caught') {
      const b = this.player(bl.owner).body
      const hand = bl.caughtHand === 0 ? b?.lHand : b?.rHand
      if (hand) return { x: hand.x * this.W, y: hand.y * this.H }
      return { x: bl.ix, y: bl.iy }
    }
    const px = this.pitcherX(st)
    const py = this.H * 0.32
    return { x: px + (bl.ix - px) * o, y: py + (bl.iy - py) * o }
  }

  paint(c: CanvasRenderingContext2D) {
    const duo = this.seats > 1
    if (duo) {
      c.strokeStyle = 'rgba(255,255,255,.5)'
      c.lineWidth = 6
      c.setLineDash([12, 12])
      c.beginPath()
      c.moveTo(this.W / 2, 0)
      c.lineTo(this.W / 2, this.H)
      c.stroke()
      c.setLineDash([])
    }
    for (let i = 0; i < 2; i++) {
      const st = this.states[i]
      if (!this.seatActive[i]) continue
      const z = st.zone
      c.save()
      c.beginPath()
      c.rect(z.x0, 0, z.x1 - z.x0, this.H)
      c.clip()

      // 投手
      const px = this.pitcherX(st)
      const py = this.H * 0.32 + Math.sin(this.t * 3 + i) * this.H * 0.006
      const winding = st.balls.some((bl) => bl.state === 'wind')
      const moodCol = st.pitcherMood > 0 ? '#8fa3d0' : '#b0576b'
      circle(c, px, py, 34, moodCol) // 身体
      circle(c, px, py - 40, 22, moodCol) // 头
      // 角 + 眼
      c.fillStyle = '#f2e2c4'
      c.beginPath()
      c.moveTo(px - 14, py - 58)
      c.lineTo(px - 22, py - 74)
      c.lineTo(px - 8, py - 62)
      c.closePath()
      c.fill()
      c.beginPath()
      c.moveTo(px + 14, py - 58)
      c.lineTo(px + 22, py - 74)
      c.lineTo(px + 8, py - 62)
      c.closePath()
      c.fill()
      circle(c, px - 8, py - 44, 4, '#26152c')
      circle(c, px + 8, py - 44, 4, '#26152c')
      // 手臂：预备时举高
      c.strokeStyle = moodCol
      c.lineWidth = 10
      c.beginPath()
      if (winding) {
        c.moveTo(px, py - 16)
        c.lineTo(px + 26, py - 60)
      } else {
        c.moveTo(px, py - 16)
        c.lineTo(px + 26, py + 6)
      }
      c.stroke()

      // 影子 + 球
      for (const bl of st.balls) {
        if (bl.state === 'wind') continue
        const o = bl.state === 'fly' ? clamp((this.t - bl.throwAt) / bl.flight, 0, 1) : 1
        const pos = bl.state === 'hit' ? { x: bl.bx, y: bl.by } : this.ballPos(st, bl, o)
        const rv = bl.R * (0.22 + 0.78 * o * o)
        // hit 后弹飞
        if (bl.state === 'hit') {
          circle(c, bl.bx, bl.by, rv, '#e8e4f0')
          continue
        }
        // 地面影子（arrive 前显示）
        if (bl.state === 'fly') {
          const floorY = clamp(st.anchor.ankleY + 0.1 * st.anchor.T, 40, this.H - 16)
          c.fillStyle = `rgba(10,14,40,${0.15 + 0.3 * o})`
          c.beginPath()
          c.ellipse(bl.ix, floorY, rv * (1 + 0.5 * o), rv * 0.35, 0, 0, Math.PI * 2)
          c.fill()
          ring(c, bl.ix, floorY, rv * 1.3, o, '#ffffffcc', 4)
          txt(c, ICON[bl.kind], bl.ix, floorY - rv * 1.6 - 14, 22, bl.kind === 'soft' ? '#ffb24d' : '#fff', 'center', 'bold')
        }
        // 球体
        const ballCol = bl.kind === 'soft' ? '#ffd54a' : '#e8e4f0'
        circle(c, pos.x, pos.y, rv, ballCol)
        if (bl.kind !== 'soft') {
          c.strokeStyle = 'rgba(70,60,90,.4)'
          c.lineWidth = 2
          c.beginPath()
          c.arc(pos.x, pos.y, rv * 0.7, this.t * 6 + bl.seq, this.t * 6 + bl.seq + 2)
          c.stroke()
        } else {
          c.strokeStyle = 'rgba(120,90,20,.5)'
          c.lineWidth = 3
          c.beginPath()
          c.moveTo(pos.x - rv * 0.5, pos.y)
          c.lineTo(pos.x + rv * 0.5, pos.y)
          c.stroke()
        }
        if (bl.state === 'caught') {
          ring(c, pos.x, pos.y, rv * 1.5, 1, '#ffd54a', 4)
        }
      }

      // 被打中泛红
      if (st.hurt > 0) {
        c.fillStyle = `rgba(255,70,90,${st.hurt * 0.5})`
        c.fillRect(z.x0, 0, z.x1 - z.x0, this.H)
      }
      c.restore()

      // 战绩小字
      const total = st.dodged + st.hits
      const rate = total > 0 ? Math.round((100 * st.dodged) / total) : 100
      txt(c, `躲 ${st.dodged} · 接 ${st.caught} · 中 ${st.hits} · ${rate}%`, z.x0 + 16, this.H - 20, 18, '#ffffffcc', 'left', 'bold')
    }
  }
}

export default function create(ctx: GameContext) {
  return new Dodgeball(ctx)
}
