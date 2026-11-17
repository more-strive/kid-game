import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, glow, outlineTxt, ring, rr, txt } from '@/core/draw'

/**
 * 拳击训练（对齐 dongdongpark 真实规则，见 _reverse/reports/boxing.md）：
 * 教练举靶——左靶用左拳、右靶用右拳、高靶上勾；快速正确 +3 / 普通 +2 / 错手 +1 /
 * 双靶全对 +1 / 每 5 连击 +3；红手套飞来侧身躲（|lean|≥0.35）、横杆扫来蹲下，躲开 +2；
 * 超时/被击中不扣分只断连击。
 * 框架无 punchLeft/punchRight/duck 事件，用等价代理：
 * 出拳 = 手速上升沿（≥2.2 躯干/s，节流 0.35s），命中窗仍为事件后 0.25s；
 * duck = squat 上升沿记录时刻（0.6s 宽限窗不变）。
 */

type Kind = 'left' | 'right' | 'highLeft' | 'highRight' | 'double' | 'glove' | 'bar'
const KINDS: Kind[] = ['left', 'right', 'highLeft', 'highRight', 'double', 'glove', 'bar']

/** 对齐站点难度表：出靶间隔 / 靶停留 / 飞行时长 / 各类型权重（总权重 10/13/16） */
const DIFF = [
  { every: 2, hold: 1, fly: 1.5, weights: { left: 3, right: 3, highLeft: 1, highRight: 1, double: 0, glove: 1, bar: 1 } },
  { every: 1.55, hold: 0.75, fly: 1.2, weights: { left: 3, right: 3, highLeft: 1.5, highRight: 1.5, double: 1, glove: 1.5, bar: 1.5 } },
  { every: 1.2, hold: 0.6, fly: 0.95, weights: { left: 3, right: 3, highLeft: 2, highRight: 2, double: 2, glove: 2, bar: 2 } },
]

const POP = 0.3 // 靶子浮现时长（也是「快拳」窗口起点：age < 0.3+hold×0.5 得 +3）
const PUNCH_WIN = 0.25 // 出拳事件后的有效命中窗
const LEAN_DUCK = 0.35 // 侧身躲避阈值 |lean| ≥ 0.35
const LAST = 0.4 // 躲避判定只在最后 0.4 秒检查
const DUCK_GRACE = 0.6 // duck 事件宽限窗（横杆：squat 或 0.6s 内蹲过）
const FADE = 0.6 // 结算后飞行物飞出画面的时长
const HAND_R = 20 // 拳头判定半径
const PUNCH_SPEED = 2.2 // 出拳事件代理阈值（躯干/s）
const PUNCH_CD = 0.35 // 出拳事件节流

interface Pad {
  side: 0 | 1 // 应该用哪只手：0=屏幕左拳 1=屏幕右拳
  x: number
  y: number
  r: number
  arrow: string
  hitAt: number // -1 = 未命中
  wrong: boolean
}

interface Target {
  owner: number
  kind: Kind
  age: number
  life: number
  pads: Pad[] // 拳靶（手套/横杆为空）
  flying: boolean // 手套/横杆
  dir: number // 飞行方向 1=从左往右
  x: number
  y: number
  sx: number
  sy: number // 出生点（飞行物）
  hx: number
  hy: number // 追踪的头部实时位置
  torso: number // 生成时躯干像素
  rot: number
  resolved: 'none' | 'hit' | 'miss' | 'dodged' | 'bopped'
  fadeT: number // 结算后飞出计时
}

interface PState {
  spawnT: number // 出靶倒计时（首靶 1s）
  planAt: number // 共享计划队列游标
  armed: [number, number] // 左/右拳命中窗截止时刻
  punchCd: [number, number]
  duckAt: number // 最近一次 duck（squat 上升沿）时刻
  wasSquat: boolean
  combo: number
  maxCombo: number
  hits: number // 命中率分子（含错手）
  targets: number // 命中率分母（出过的拳靶 pad 数）
  dodged: number
  attacks: number // 飞行物总数
}

function newPS(): PState {
  return {
    spawnT: 1, // 开局 1 秒出首靶
    planAt: 0,
    armed: [-1, -1],
    punchCd: [-9, -9],
    duckAt: -9,
    wasSquat: false,
    combo: 0,
    maxCombo: 0,
    hits: 0,
    targets: 0,
    dodged: 0,
    attacks: 0,
  }
}

class Boxing extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  targets: Target[] = []
  /** 两人共享同一条目标计划序列（各自游标错位取用，保证面对同分布目标流） */
  plans: { kind: Kind; dir: number }[] = []
  st: PState[] = [newPS(), newPS()]
  score = 0
  shakeT = 0
  shakeAmp = 0
  bannerText = ''
  bannerT = 0
  /** 教练纠正气泡（1.1s）：错手/被击中提示 */
  hint = [
    { text: '', color: '#fff', until: -1 },
    { text: '', color: '#fff', until: -1 },
  ]
  /** 命中白环冲击波 */
  rings: { x: number; y: number; r: number; life: number }[] = []

  private unit() {
    return this.H / 720
  }

  private present() {
    return this.players.filter((p) => p.body).length
  }

  /** 分屏：solo 0.08~0.92，duo P0 0.03~0.47 / P1 0.53~0.97 */
  private zone(pi: number) {
    if (this.present() <= 1) return { x0: this.W * 0.08, x1: this.W * 0.92 }
    return pi === 0 ? { x0: this.W * 0.03, x1: this.W * 0.47 } : { x0: this.W * 0.53, x1: this.W * 0.97 }
  }

  private torsoPx(b: Body) {
    return Math.max(60, b.scale * this.H * 0.5)
  }

  /** 加权随机选类型 + 防连排（同一特殊类型不连续出现两次） */
  private nextPlan() {
    const w = this.cfg.weights
    let total = 0
    for (const k of KINDS) total += w[k]
    let roll = Math.random() * total
    let kind: Kind = 'left'
    for (const k of KINDS) {
      roll -= w[k]
      if (roll <= 0) {
        kind = k
        break
      }
    }
    const last = this.plans.length ? this.plans[this.plans.length - 1].kind : null
    if (kind === last && kind !== 'left' && kind !== 'right') {
      kind = Math.random() < 0.5 ? 'left' : 'right'
    }
    return { kind, dir: Math.random() < 0.5 ? 1 : -1 }
  }

  /** 飞行物出生 x：单人从区块外一点进场，双人从区块内 0.6r 处（防跨区） */
  private edgeX(pi: number, dir: number, r: number) {
    const z = this.zone(pi)
    const off = this.present() > 1 ? r * 0.6 : -r
    return dir > 0 ? z.x0 + off : z.x1 - off
  }

  private spawn(pi: number) {
    const st = this.st[pi]
    const plan = this.plans[st.planAt] ?? this.nextPlan()
    st.planAt++
    const b = this.players[pi].body
    const u = this.unit()
    const z = this.zone(pi)
    const torso = b ? this.torsoPx(b) : this.H * 0.28
    const cx = b ? b.shoulderC.x * this.W : (z.x0 + z.x1) / 2
    const cy = b ? b.shoulderC.y * this.H : this.H * 0.42
    const hx = b ? b.head.x * this.W : cx
    const hy = b ? b.head.y * this.H : this.H * 0.3
    const tg: Target = {
      owner: pi,
      kind: plan.kind,
      age: 0,
      life: 0,
      pads: [],
      flying: false,
      dir: plan.dir,
      x: 0,
      y: 0,
      sx: 0,
      sy: 0,
      hx,
      hy,
      torso,
      rot: 0,
      resolved: 'none',
      fadeT: 0,
    }
    // 拳靶位置相对肩中心：(ox,oy)×躯干；靶半径 = clamp(躯干×0.42, 40×unit, 110×unit)
    const mkPad = (ox: number, oy: number, side: 0 | 1, arrow: string): Pad => ({
      side,
      arrow,
      x: Math.min(this.W - 30, Math.max(30, cx + ox * torso)),
      y: Math.min(this.H - 40, Math.max(40, cy + oy * torso)),
      r: Math.min(110 * u, Math.max(40 * u, torso * 0.42)),
      hitAt: -1,
      wrong: false,
    })
    if (plan.kind === 'left' || plan.kind === 'right') {
      tg.life = POP + this.cfg.hold
      tg.pads = [plan.kind === 'left' ? mkPad(-1.15, 0.02, 0, '←') : mkPad(1.15, 0.02, 1, '→')]
      st.targets++
      this.ctx.audio.play('pop', 0.6, 0.85) // appear
    } else if (plan.kind === 'highLeft' || plan.kind === 'highRight') {
      tg.life = POP + this.cfg.hold
      tg.pads = [plan.kind === 'highLeft' ? mkPad(-1.05, -0.45, 0, '↑') : mkPad(1.05, -0.45, 1, '↑')]
      st.targets++
      this.ctx.audio.play('pop', 0.6, 0.85)
    } else if (plan.kind === 'double') {
      tg.life = POP + this.cfg.hold + 0.25
      tg.pads = [mkPad(-1.15, 0.02, 0, '←'), mkPad(1.15, 0.02, 1, '→')]
      st.targets += 2
      this.ctx.audio.play('pop', 0.6, 0.85)
    } else {
      // 手套 / 横杆：出生即 attacks++ 并播 whoosh
      tg.flying = true
      const r = torso * (plan.kind === 'glove' ? 0.9 : 0.85)
      tg.life = plan.kind === 'glove' ? this.cfg.fly : this.cfg.fly * 1.1
      tg.sx = this.edgeX(pi, plan.dir, r)
      tg.sy = plan.kind === 'glove' ? hy : hy + torso * 0.35
      tg.x = tg.sx
      tg.y = tg.sy
      st.attacks++
      this.ctx.audio.slash() // whoosh
    }
    this.targets.push(tg)
  }

  /** 出拳事件代理：手速 ≥2.2 躯干/s 的上升沿，武装 0.25s 命中窗 */
  private detectPunch(pi: number, b: Body) {
    const st = this.st[pi]
    const torso = Math.max(0.08, b.scale)
    const vs = [b.lHandV, b.rHandV]
    for (let hi = 0; hi < 2; hi++) {
      if (vs[hi] / torso >= PUNCH_SPEED && this.t - st.punchCd[hi] >= PUNCH_CD) {
        st.punchCd[hi] = this.t
        st.armed[hi] = this.t + PUNCH_WIN
      }
    }
  }

  private shake(amp: number) {
    this.shakeAmp = amp
    this.shakeT = 0.32
  }

  private banner(text: string) {
    this.bannerText = text
    this.bannerT = 1.2
  }

  /** 正确手命中靶：快拳 +3 / 普通 +2，进连击；每满 5 连击 +3 */
  private landHit(tg: Target, pad: Pad, hi: 0 | 1, hx: number, hy: number) {
    const pi = tg.owner
    const st = this.st[pi]
    pad.hitAt = this.t
    pad.wrong = hi !== pad.side
    st.hits++
    if (pad.wrong) {
      // 错手：+1 分、教练提示，不加不清连击
      this.score += 1
      this.say('错手 +1', hx, hy - 34, '#ffab40', 30)
      this.hint[pi] = { text: pad.side === 0 ? '用左手！' : '用右手！', color: '#ffab40', until: this.t + 1.1 }
      this.ctx.audio.play('pop', 0.7, 0.55) // boing
      return
    }
    const fast = tg.age < POP + this.cfg.hold * 0.5
    this.score += fast ? 3 : 2
    this.say(fast ? '+3 快！' : '+2', hx, hy - 34, '#fff36b', 32)
    this.ctx.audio.hit() // crack + thud
    this.shake(4)
    const u = this.unit()
    this.particles.burst(pad.x, pad.y, '#ffd54a', 10, 320 * u, 14 * u)
    this.particles.burst(pad.x, pad.y, '#ffffff', 6, 260 * u, 9 * u)
    this.rings.push({ x: pad.x, y: pad.y, r: pad.r, life: 0.25 })
    st.combo++
    st.maxCombo = Math.max(st.maxCombo, st.combo)
    if (st.combo % 5 === 0) {
      // 每满 5 连击 +3
      this.score += 3
      this.banner(`连击 ×${st.combo}！+3`)
      this.ctx.audio.combo()
    }
    // 双靶两拳全对：组合拳 +1
    if (tg.pads.length > 1 && tg.pads.every((p) => p.hitAt >= 0 && !p.wrong)) {
      this.score += 1
      this.say('组合拳 +1', pad.x, pad.y - 64, '#9be29b', 34)
    }
  }

  /** 出拳窗内拳头碰靶（纯位置判定，不用手速） */
  private checkPunchHit(tg: Target) {
    const pi = tg.owner
    const st = this.st[pi]
    const b = this.players[pi].body
    if (!b) return
    const hands = [
      { x: this.players[pi].lHand.x, y: this.players[pi].lHand.y },
      { x: this.players[pi].rHand.x, y: this.players[pi].rHand.y },
    ]
    for (let hi = 0; hi < 2; hi++) {
      if (st.armed[hi] < 0 || this.t > st.armed[hi]) continue // 必须在出拳窗内
      for (const pad of tg.pads) {
        if (pad.hitAt >= 0) continue
        if (Math.hypot(hands[hi].x - pad.x, hands[hi].y - pad.y) >= pad.r + HAND_R) continue
        st.armed[hi] = -1 // 一次出拳只结算一个靶
        this.landHit(tg, pad, hi as 0 | 1, hands[hi].x, hands[hi].y)
        break
      }
    }
  }

  /** 躲避判定（只在最后 0.4 秒）：手套看侧身，横杆看蹲下/0.6s 内蹲过 */
  private checkDodge(tg: Target, b: Body | null) {
    if (!b) return
    const pi = tg.owner
    const st = this.st[pi]
    const lean = (b.shoulderC.x - b.hipC.x) / Math.max(0.08, b.scale)
    const ok = tg.kind === 'glove'
      ? Math.abs(lean) >= LEAN_DUCK
      : b.squat || this.t - st.duckAt < DUCK_GRACE
    if (!ok) return
    tg.resolved = 'dodged'
    st.dodged++
    this.score += 2
    this.say(tg.kind === 'glove' ? '躲开了 +2' : '蹲得好 +2', tg.x, tg.y - 44, '#9be29b', 34)
    this.ctx.audio.jump()
    st.combo++
    st.maxCombo = Math.max(st.maxCombo, st.combo)
    if (st.combo % 5 === 0) {
      this.score += 3
      this.banner(`连击 ×${st.combo}！+3`)
      this.ctx.audio.combo()
    }
  }

  /** 被击中：清连击、震屏、星星粒子、教练提示（不扣分） */
  private bop(tg: Target) {
    tg.resolved = 'bopped'
    const pi = tg.owner
    this.st[pi].combo = 0
    this.shake(14)
    this.ctx.audio.hit()
    this.ctx.audio.fail()
    this.say('哎哟！', tg.x, tg.y, '#6e5b84', 44)
    this.hint[pi] = { text: tg.kind === 'glove' ? '侧身躲！' : '快蹲下！', color: '#ff6b6b', until: this.t + 1.1 }
    const u = this.unit()
    this.particles.burst(tg.x, tg.y, '#ffd54a', 5, 300 * u, 16 * u)
    this.particles.burst(tg.x, tg.y, '#ffffff', 5, 300 * u, 16 * u)
  }

  tick(_f: PoseFrame, dt: number) {
    this.bannerT = Math.max(0, this.bannerT - dt)
    this.shakeT = Math.max(0, this.shakeT - dt)
    // 计划队列：预生成两人游标之后的目标（防连排依赖队列上一条）
    while (this.plans.length < Math.max(this.st[0].planAt, this.st[1].planAt) + 2) this.plans.push(this.nextPlan())

    for (let pi = 0; pi < 2; pi++) {
      const st = this.st[pi]
      const b = this.players[pi].body
      if (b) {
        this.detectPunch(pi, b)
        if (b.squat && !st.wasSquat) st.duckAt = this.t // duck 事件
        st.wasSquat = b.squat
      }
      // 出靶：每名玩家同一时刻最多 1 个活动目标
      st.spawnT -= dt
      if (st.spawnT <= 0) {
        const busy = this.targets.some((tg) => tg.owner === pi && tg.resolved === 'none')
        if (!busy && b) {
          this.spawn(pi)
          st.spawnT = this.cfg.every * (0.8 + Math.random() * 0.4) // ×0.8~1.2 抖动
        } else {
          st.spawnT = 0.05
        }
      }
    }

    for (const tg of this.targets) {
      const b = this.players[tg.owner].body
      if (b) {
        tg.hx = b.head.x * this.W
        tg.hy = b.head.y * this.H
      }
      tg.age += dt
      if (tg.resolved !== 'none') {
        // 结算后 0.6s 淡出期内按 0.9 屏宽/秒飞出画面
        tg.fadeT += dt
        tg.x += tg.dir * this.W * 0.9 * dt
        continue
      }
      if (tg.flying) {
        // 位移：出生点 → 头部，寿命内匀速
        const k = Math.min(1, tg.age / tg.life)
        tg.x = tg.sx + (tg.hx - tg.sx) * k
        tg.y = tg.kind === 'glove' ? tg.hy + Math.sin(tg.age * 9) * tg.torso * 0.06 : tg.sy
        tg.rot = tg.kind === 'glove' ? Math.sin(tg.age * 9) * 0.08 : Math.sin(tg.age * 7) * 0.04
        if (tg.life - tg.age < LAST) this.checkDodge(tg, b)
        if (tg.age >= tg.life && tg.resolved === 'none') this.bop(tg)
        continue
      }
      this.checkPunchHit(tg)
      if (tg.age >= tg.life) {
        if (tg.pads.some((p) => p.hitAt >= 0)) {
          tg.resolved = 'hit' // 至少中了一个：正常结算（半结算不算 miss 不断连）
        } else {
          // 全部超时：清连击（无扣分）
          tg.resolved = 'miss'
          this.st[tg.owner].combo = 0
          this.say('慢了', tg.pads[0]?.x ?? this.W / 2, tg.pads[0]?.y ?? this.H / 2, '#7a6b8a', 36)
          this.ctx.audio.fail()
        }
      }
    }
    this.targets = this.targets.filter((tg) => (tg.flying ? tg.fadeT < FADE : tg.resolved === 'none'))
    for (let i = this.rings.length - 1; i >= 0; i--) {
      this.rings[i].life -= dt
      if (this.rings[i].life <= 0) this.rings.splice(i, 1)
    }

    const s0 = this.st[0]
    const s1 = this.st[1]
    const hits = s0.hits + s1.hits
    const pads = s0.targets + s1.targets
    this.ctx.setScore(this.score)
    this.ctx.setCombo(Math.max(s0.combo, s1.combo))
    this.ctx.setExtra('最大连击', Math.max(s0.maxCombo, s1.maxCombo))
    this.ctx.setExtra('命中率', pads ? Math.round((hits / pads) * 100) : 0)
    this.ctx.setExtra('躲闪', s0.dodged + s1.dodged)
  }

  /** 简笔教练：头 + 身体 + （可选）伸向靶子的双色持靶臂 */
  private drawCoach(c: CanvasRenderingContext2D, x: number, y: number, color: string, armTo: Pad | null, u: number) {
    const s = 68 * u
    if (armTo) {
      c.lineCap = 'round'
      c.strokeStyle = '#4a3b5c'
      c.lineWidth = 13 * u
      c.beginPath()
      c.moveTo(x, y + s * 0.45)
      c.lineTo(armTo.x, armTo.y)
      c.stroke()
      c.strokeStyle = '#2ec4b6'
      c.lineWidth = 7 * u
      c.beginPath()
      c.moveTo(x, y + s * 0.45)
      c.lineTo(armTo.x, armTo.y)
      c.stroke()
    }
    // 身体
    rr(c, x - s * 0.34, y + s * 0.28, s * 0.68, s * 0.95, s * 0.22)
    c.fillStyle = color
    c.fill()
    c.strokeStyle = 'rgba(40,30,60,.5)'
    c.lineWidth = 3 * u
    c.stroke()
    // 头 + 头带
    circle(c, x, y, s * 0.3, '#ffd9b3')
    c.strokeStyle = 'rgba(40,30,60,.45)'
    c.lineWidth = 3 * u
    c.beginPath()
    c.arc(x, y, s * 0.3, 0, Math.PI * 2)
    c.stroke()
    rr(c, x - s * 0.3, y - s * 0.14, s * 0.6, s * 0.12, s * 0.06)
    c.fillStyle = '#4a3b5c'
    c.fill()
    // 眼睛
    circle(c, x - s * 0.1, y + s * 0.02, s * 0.035, '#3d2c4a')
    circle(c, x + s * 0.1, y + s * 0.02, s * 0.035, '#3d2c4a')
    // 空闲时抱架姿势的双臂
    if (!armTo) {
      c.strokeStyle = '#4a3b5c'
      c.lineWidth = 9 * u
      c.lineCap = 'round'
      c.beginPath()
      c.moveTo(x - s * 0.3, y + s * 0.55)
      c.lineTo(x - s * 0.58, y + s * 0.22)
      c.stroke()
      c.beginPath()
      c.moveTo(x + s * 0.3, y + s * 0.55)
      c.lineTo(x + s * 0.58, y + s * 0.22)
      c.stroke()
    }
  }

  /** 教练白色圆角气泡 */
  private bubble(c: CanvasRenderingContext2D, x: number, y: number, text: string, color: string, u: number) {
    const size = 30 * u
    const w = Math.max(56 * u, text.length * size * 0.95 + 26 * u)
    const h = 46 * u
    rr(c, x - w / 2, y - h / 2, w, h, h / 2)
    c.fillStyle = '#fff'
    c.fill()
    c.strokeStyle = '#4a3b5c'
    c.lineWidth = 3 * u
    c.stroke()
    txt(c, text, x, y + 1, size, color)
  }

  private drawGlove(c: CanvasRenderingContext2D, tg: Target, u: number) {
    c.save()
    c.translate(tg.x, tg.y)
    c.rotate(tg.rot)
    // 身后 3 条白色速度线
    c.globalAlpha = 0.5
    c.strokeStyle = '#fff'
    c.lineWidth = 4 * u
    const back = tg.dir > 0 ? -1 : 1
    for (let i = 0; i < 3; i++) {
      const yy = (-20 + i * 20) * u
      c.beginPath()
      c.moveTo(back * (42 + i * 14) * u, yy)
      c.lineTo(back * (118 + i * 20) * u, yy)
      c.stroke()
    }
    c.globalAlpha = 1
    // 手套本体
    const r = Math.max(16 * u, tg.torso * 0.42)
    glow(c, 0, 0, r * 1.8, '#e5383b', 0.28)
    circle(c, 0, 0, r, '#e5383b')
    c.strokeStyle = '#9d0208'
    c.lineWidth = 4 * u
    c.beginPath()
    c.arc(0, 0, r, 0, Math.PI * 2)
    c.stroke()
    // 拇指
    circle(c, back * -r * 0.72, r * 0.34, r * 0.42, '#e5383b')
    c.strokeStyle = '#9d0208'
    c.beginPath()
    c.arc(back * -r * 0.72, r * 0.34, r * 0.42, 0, Math.PI * 2)
    c.stroke()
    // 系带
    c.strokeStyle = '#fff'
    c.lineWidth = 3 * u
    c.beginPath()
    c.moveTo(back * r * 0.55, -r * 0.3)
    c.lineTo(back * r * 0.55, r * 0.3)
    c.stroke()
    c.restore()
  }

  private drawBar(c: CanvasRenderingContext2D, tg: Target, u: number) {
    c.save()
    c.translate(tg.x, tg.y)
    c.rotate(tg.rot)
    const bw = tg.torso * 1.7 + Math.min(40 * u, Math.max(18 * u, tg.torso * 0.2))
    const bh = Math.max(14 * u, tg.torso * 0.18)
    glow(c, 0, 0, bw * 0.6, '#b02a37', 0.2)
    rr(c, -bw / 2, -bh / 2, bw, bh, bh / 2)
    c.fillStyle = '#b02a37'
    c.fill()
    c.strokeStyle = '#6a1420'
    c.lineWidth = 3 * u
    c.stroke()
    // 黄黑警示条纹
    c.save()
    c.beginPath()
    rr(c, -bw / 2, -bh / 2, bw, bh, bh / 2)
    c.clip()
    c.fillStyle = '#ffd166'
    for (let i = -4; i < 8; i++) {
      const x0 = i * bh * 1.6
      c.beginPath()
      c.moveTo(x0, bh / 2)
      c.lineTo(x0 + bh * 0.7, -bh / 2)
      c.lineTo(x0 + bh * 1.3, -bh / 2)
      c.lineTo(x0 + bh * 0.6, bh / 2)
      c.closePath()
      c.fill()
    }
    c.restore()
    c.restore()
  }

  paint(c: CanvasRenderingContext2D) {
    const u = this.unit()
    c.save()
    // 震屏
    if (this.shakeT > 0) {
      const k = this.shakeT / 0.32
      c.translate(Math.sin(this.t * 71) * this.shakeAmp * k, Math.cos(this.t * 63) * this.shakeAmp * k * 0.6)
    }

    // 教练 + 气泡 + 连击数字
    for (let pi = 0; pi < 2; pi++) {
      const b = this.players[pi].body
      if (!b) continue
      const z = this.zone(pi)
      const zw = z.x1 - z.x0
      const cx = this.present() > 1 && pi === 1 ? z.x1 - zw * 0.14 : z.x0 + zw * 0.14
      const cy = this.H * 0.2
      const active = this.targets.find((tg) => tg.owner === pi && tg.resolved === 'none')
      // 持靶臂指向最近一个未命中的靶
      const armTo = active && !active.flying ? active.pads.find((p) => p.hitAt < 0) ?? null : null
      this.drawCoach(c, cx, cy, this.players[pi].color, armTo, u)
      let text = '来！'
      let color = '#4a3b5c'
      if (active) {
        if (active.kind === 'left') text = '←'
        else if (active.kind === 'right') text = '→'
        else if (active.kind === 'highLeft' || active.kind === 'highRight') text = '↑'
        else if (active.kind === 'double') text = '← →'
        else {
          text = active.kind === 'glove' ? '躲！' : '蹲！'
          color = '#ff6b6b'
        }
      }
      const hint = this.hint[pi]
      if (hint.until > this.t) {
        text = hint.text
        color = hint.color
      }
      this.bubble(c, cx, cy - 100 * u, text, color, u)
      const cb = this.st[pi].combo
      if (cb >= 2) outlineTxt(c, `连击 ${cb}`, cx, cy + 170 * u, (28 + Math.min(14, cb)) * u, this.players[pi].color)
    }

    // 目标
    for (const tg of this.targets) {
      if (tg.flying) {
        c.save()
        c.globalAlpha = tg.resolved !== 'none' ? Math.max(0, 1 - tg.fadeT / FADE) : 1
        if (tg.kind === 'glove') this.drawGlove(c, tg, u)
        else this.drawBar(c, tg, u)
        c.restore()
        continue
      }
      for (const pad of tg.pads) {
        // 0.3s 缓出弹出（scale 0.3→1）+ 临近消失正弦脉动
        const n = Math.min(1, tg.age / POP)
        let scale = 0.3 + 0.7 * (1 - Math.pow(1 - n, 3))
        const remain = Math.max(0, (tg.life - tg.age) / tg.life)
        if (remain < 0.35) scale *= 1 + Math.sin(this.t * 40) * 0.04
        c.save()
        c.translate(pad.x, pad.y)
        c.scale(scale, scale)
        glow(c, 0, 0, pad.r * 1.5, '#e5383b', 0.22)
        circle(c, 0, 0, pad.r, '#e5383b')
        circle(c, 0, 0, pad.r * 0.72, '#fff1f1')
        c.restore()
        // 靶上倒计时环（剩余 <35% 变红）
        ring(c, pad.x, pad.y, pad.r + 7 * u, remain, remain < 0.35 ? '#ff5c5c' : '#ffd54a', 5 * u)
        outlineTxt(c, pad.arrow, pad.x, pad.y, Math.max(22, pad.r * 0.85), '#c1121f')
      }
    }

    // 命中白环冲击波
    for (const r of this.rings) {
      const k = r.life / 0.25
      c.save()
      c.globalAlpha = k
      c.strokeStyle = '#fff'
      c.lineWidth = 6 * u * k
      c.beginPath()
      c.arc(r.x, r.y, r.r * (1.3 - 0.3 * k), 0, Math.PI * 2)
      c.stroke()
      c.restore()
    }
    c.restore()

    if (this.bannerT > 0) {
      c.globalAlpha = Math.min(1, this.bannerT / 0.3)
      outlineTxt(c, this.bannerText, this.W / 2, this.H * 0.28, 50, '#ffd54a')
      c.globalAlpha = 1
    }
    txt(c, '教练举靶：左靶左拳、右靶右拳、高靶上勾；手套侧身躲、横杆快蹲下', this.W / 2, this.H - 30, 20, 'rgba(255,255,255,.8)', 'center', 'bold')
  }
}

export default function create(ctx: GameContext) {
  return new Boxing(ctx)
}
