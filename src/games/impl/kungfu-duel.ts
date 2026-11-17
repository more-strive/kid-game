import { BaseGame, PLAYER_COLORS } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { outlineTxt, rr } from '@/core/draw'

/**
 * 功夫对决（对齐 dongdongpark 真实规则）：
 * 一人一边，出拳 / 踢腿打掉对方 60 点血条；双手护胸格挡减伤、蹲下躲直拳、跳起躲踢腿；打空血条赢下这一回合。
 *
 * 站点原样保留的七条规则：
 * 1. 伤害：直拳 8、踢腿 12；踢腿有 0.3 秒前摇（给了对方「看到再跳」的时间）。
 * 2. 冷却：拳 0.38 秒、腿 0.9 秒；命中即让对方硬直 0.35 秒（容易连段）。
 * 3. 三种防御分工：抱架全招式减伤 80%、蹲下只躲直拳、跳跃 0.55 秒空中无敌只躲踢腿——猜错照样吃满伤害。
 * 4. 重复惩罚：同一种招式 1.2 秒内连用，伤害按 0.75^n 递减（下限 40%），第 3 次起提示「老是一招，没劲了」。
 * 5. 被躲开时攻击方连击清零（`maxCombo` 只统计真正打中的连续次数）。
 * 6. 电脑每 0.5 秒决策一次抱架 / 蹲下；出手间隔 easy 1.7~2.6 秒、hard 0.7~1.2 秒；hard 有 60% 概率躲掉可预判的踢腿。
 * 7. 每回合满血重置，赢一回合 +1 分；KO 后 2.4 秒开下一回合。
 *
 * 与站点的差异（本框架限制，都写在这里）：
 * - 出拳用「单手水平速度 > 3.0 躯干/秒」代理站点的 `punchLeft/punchRight` 事件；踢腿用「膝盖抬到髋高以上的上升沿」
 *   代理 `kick` 事件（阈值 0.8，与 counter-kit 的高抬腿同口径但更严，避免走路误触）。
 * - 站点允许「抱架/蹲着同时出招」（报告 §8 记为疑似漏洞），这里**禁止**：抱架与蹲下期间不能出招，
 *   否则「一直护胸 + 继续输出」会变成最优且无趣的解。
 * - 站点回合没有独立计时（只靠全局 90 秒），这里补了 30 秒回合上限、到点按剩余血量判胜，
 *   否则单回合可能拖到整局结束、玩家一分未得。
 */

const DIFF = [
  { attack: [1.7, 2.6], guardP: 0.12, dodgeP: 0.15, kickP: 0.3 },
  { attack: [1.1, 1.8], guardP: 0.28, dodgeP: 0.35, kickP: 0.35 },
  { attack: [0.7, 1.2], guardP: 0.48, dodgeP: 0.6, kickP: 0.4 },
]

const MAX_HP = 60
const DMG = { punch: 8, kick: 12 }
const KICK_WINDUP = 0.3
const CD = { punch: 0.38, kick: 0.9 }
const AIR_T = 0.55
const HIT_STUN = 0.35
const REPEAT_WIN = 1.2
const REPEAT_FLOOR = 0.4
const GUARD_TAKE = 0.2
const ROUND_GAP = 2.4
const READY_T = 0.8
const ROUND_LIMIT = 30
const PUNCH_V = 3.0
/** 单帧位移超过 30 躯干/秒 ⇒ 跟踪跳变（手被遮挡后突然出现在别处），不当作动作 */
const JUMP_V = 15
const KICK_LIFT = 0.8
const KICK_LIFT_DOWN = 0.55

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v))
}
function rnd(a: number, b: number) {
  return a + Math.random() * (b - a)
}

type Kind = 'punch' | 'kick'
type Move = 'idle' | 'punch' | 'kick' | 'guard' | 'squat' | 'jump' | 'hit' | 'ko' | 'win'
type Phase = 'ready' | 'fight' | 'ko'

interface Fighter {
  hp: number
  shown: number
  wins: number
  move: Move
  moveUntil: number
  cool: number
  stunUntil: number
  airUntil: number
  pendingAt: number
  pendingSide: number
  guard: boolean
  squat: boolean
  inAir: boolean
  flash: number
  combo: number
  maxCombo: number
  thrown: number
  landed: number
  dealt: number
  lastKind: Kind | ''
  lastAt: number
  repeat: number
  punchAnim: number
  kickAnim: number
  lift: [boolean, boolean]
  hands: { x: number; y: number; ok: boolean }[]
  jumpWas: boolean
}

interface Cpu {
  next: number
  decideAt: number
  guardUntil: number
  squatUntil: number
}

class KungfuDuel extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  phase: Phase = 'ready'
  phaseAt = 0
  round = 1
  roundT = 0
  duel = false
  f: Fighter[] = []
  cpu: Cpu = { next: 1.2, decideAt: 0, guardUntil: -1, squatUntil: -1 }
  private banner = ''
  private bannerSub = ''
  private bannerColor = '#ffd54a'
  private bannerT = 0

  constructor(ctx: GameContext) {
    super(ctx)
    this.f = [this.blank(), this.blank()]
    this.banner = 'VS'
    this.bannerSub = '准备……'
    this.bannerT = READY_T
    this.ctx.speak('两位选手，准备！')
    this.ctx.setStage('准备')
  }

  private blank(): Fighter {
    return {
      hp: MAX_HP,
      shown: MAX_HP,
      wins: 0,
      move: 'idle',
      moveUntil: 0,
      cool: 0,
      stunUntil: 0,
      airUntil: 0,
      pendingAt: -1,
      pendingSide: 0,
      guard: false,
      squat: false,
      inAir: false,
      flash: 0,
      combo: 0,
      maxCombo: 0,
      thrown: 0,
      landed: 0,
      dealt: 0,
      lastKind: '',
      lastAt: -99,
      repeat: 0,
      punchAnim: 0,
      kickAnim: 0,
      lift: [false, false],
      hands: [0, 1].map(() => ({ x: 0, y: 0, ok: false })),
      jumpWas: false,
    }
  }

  private sideX(i: number) {
    return this.W * (i === 0 ? 0.28 : 0.7)
  }
  private floorY() {
    return this.H * 0.82
  }
  private dir(i: number) {
    return i === 0 ? 1 : -1
  }

  // ------------------------------------------------------------------ 主循环

  tick(f: PoseFrame, dt: number) {
    this.duel = f.bodies.length > 1
    if (this.bannerT > 0) this.bannerT -= dt
    for (const s of this.f) {
      s.flash = Math.max(0, s.flash - dt * 4)
      s.punchAnim = Math.max(0, s.punchAnim - dt * 4)
      s.kickAnim = Math.max(0, s.kickAnim - dt * 4)
      s.shown += (s.hp - s.shown) * (1 - Math.exp(-3 * dt))
    }

    if (this.phase === 'ready') {
      if (this.t - this.phaseAt >= READY_T) this.startRound()
      return
    }

    if (this.phase === 'ko') {
      if (this.t - this.phaseAt >= ROUND_GAP) this.startRound()
      return
    }

    // ---- 战斗中
    this.roundT += dt
    for (let i = 0; i < 2; i++) {
      if (i === 1 && !this.duel) continue
      this.readPlayer(i, f.bodies[i] ?? null, dt)
    }
    if (!this.duel) this.cpuStep(f, dt)

    // 踢腿前摇到点结算
    for (let i = 0; i < 2; i++) {
      const s = this.f[i]
      if (s.pendingAt >= 0 && this.t >= s.pendingAt) {
        s.pendingAt = -1
        this.resolve(i, 'kick')
      }
    }
    // 状态回 idle
    for (let i = 0; i < 2; i++) {
      const s = this.f[i]
      if (s.moveUntil && this.t >= s.moveUntil) {
        s.moveUntil = 0
        if (s.move !== 'ko' && s.move !== 'win') s.move = 'idle'
      }
      s.inAir = this.t < s.airUntil
      if (s.inAir) s.move = 'jump'
      else if (s.move === 'jump') s.move = 'idle'
    }

    // 判断 KO / 时间到
    for (let i = 0; i < 2; i++) {
      if (this.f[i].hp <= 0) {
        this.endRound(1 - i, 'ko')
        return
      }
    }
    if (this.roundT >= ROUND_LIMIT) {
      const a = this.f[0].hp
      const b = this.f[1].hp
      this.endRound(Math.abs(a - b) < 0.5 ? -1 : a > b ? 0 : 1, 'time')
    }
    this.publishStats()
  }

  private startRound() {
    this.phase = 'fight'
    this.phaseAt = this.t
    this.roundT = 0
    for (const s of this.f) {
      s.hp = MAX_HP
      s.shown = MAX_HP
      s.move = 'idle'
      s.moveUntil = 0
      s.cool = 0
      s.stunUntil = 0
      s.airUntil = 0
      s.pendingAt = -1
      s.combo = 0
      s.repeat = 0
      s.lastKind = ''
      s.lastAt = -99
      s.thrown = 0
      s.landed = 0
      s.dealt = 0
      s.jumpWas = false
    }
    this.cpu = { next: this.t + 1.2, decideAt: this.t, guardUntil: -1, squatUntil: -1 }
    this.banner = `第 ${this.round} 回合`
    this.bannerSub = this.duel ? '出拳、踢腿、护胸' : '打败电脑对手！'
    this.bannerColor = '#ffd54a'
    this.bannerT = 1.6
    this.ctx.audio.play('start', 0.8)
    this.ctx.setStage(`第 ${this.round} 回合`)
    this.publishStats()
  }

  // ------------------------------------------------------------------ 玩家输入

  private readPlayer(i: number, b: Body | null, dt: number) {
    const s = this.f[i]
    if (!b) {
      s.guard = false
      s.squat = false
      for (const h of s.hands) h.ok = false
      return
    }
    const T = Math.max(0.05, b.hipC.y - b.shoulderC.y)
    const pts = [b.lHand, b.rHand]
    let punch = false

    for (let k = 0; k < 2; k++) {
      const h = s.hands[k]
      const p = pts[k]
      if (!h.ok) {
        Object.assign(h, { x: p.x, y: p.y, ok: true })
        continue
      }
      const dx = p.x - h.x
      const dy = p.y - h.y
      h.x = p.x
      h.y = p.y
      if (Math.hypot(dx, dy) / (T * Math.max(1e-3, dt)) > JUMP_V) continue
      const vx = dx / Math.max(1e-3, dt)
      const vy = dy / Math.max(1e-3, dt)
      // 有向速度：只有朝对手方向推手才算出拳，收手不算
      const level = (vx * this.dir(i)) / T
      const band = p.y > b.shoulderC.y + 0.1 * T && p.y < b.hipC.y + 0.3 * T
      if (level > PUNCH_V && band && Math.abs(vx) > Math.abs(vy) * 0.7) punch = true
    }

    s.guard = b.armsUp
    s.squat = b.squat
    if (!s.jumpWas && b.jumping) s.airUntil = Math.max(s.airUntil, this.t + AIR_T)
    s.jumpWas = b.jumping
    s.inAir = this.t < s.airUntil

    // 踢腿：膝盖抬到髋高以上
    let kick = false
    for (const leg of [0, 1] as const) {
      const lift = this.kneeLift(b, leg)
      if (!s.lift[leg] && lift > KICK_LIFT) {
        s.lift[leg] = true
        kick = true
      } else if (s.lift[leg] && lift < KICK_LIFT_DOWN) {
        s.lift[leg] = false
      }
    }

    if (punch) this.attack(i, 'punch')
    if (kick) this.attack(i, 'kick')
  }

  /** 抬膝幅度：站姿≈0，抬到髋高≈0.45，抬过髋继续涨（与 counter-kit 同口径） */
  private kneeLift(b: Body, leg: 0 | 1) {
    const hipY = (b.lHip.y + b.rHip.y) / 2
    const shY = (b.lShoulder.y + b.rShoulder.y) / 2
    const span = Math.max(0.06, Math.abs(hipY - shY))
    const kneeY = leg === 0 ? b.lKnee.y : b.rKnee.y
    return (hipY - kneeY) / span + 0.45
  }

  private attack(i: number, kind: Kind) {
    const s = this.f[i]
    if (this.phase !== 'fight') return
    if (this.t < s.cool || this.t < s.stunUntil || this.t < s.airUntil) return
    // 抱架与蹲下期间不能出招（站点允许，这里按直觉收紧，见文件头）
    if (s.guard || s.squat) return
    if (s.pendingAt >= 0) return

    s.thrown++
    s.cool = this.t + CD[kind]
    if (kind === 'punch') {
      s.move = 'punch'
      s.moveUntil = this.t + 0.16
      s.punchAnim = 1
      this.ctx.audio.play('hit', 0.3, 1.5)
      this.resolve(i, 'punch')
    } else {
      s.move = 'kick'
      s.moveUntil = this.t + KICK_WINDUP + 0.15
      s.kickAnim = 1
      s.pendingAt = this.t + KICK_WINDUP
      s.pendingSide = Math.random() < 0.5 ? 0 : 1
      this.ctx.audio.play('hit', 0.25, 1.1)
    }
  }

  // ------------------------------------------------------------------ 命中结算

  private resolve(i: number, kind: Kind) {
    const a = this.f[i]
    const d = this.f[1 - i]
    const dir = this.dir(i)

    // 1. 被躲开
    if (kind === 'kick' && this.t < d.airUntil) {
      this.say('躲开！', this.sideX(1 - i), this.floorY() - 240, '#4cc9f0', 34)
      a.combo = 0
      this.ctx.audio.play('miss', 0.5)
      return
    }
    if (kind === 'punch' && d.squat) {
      this.say('躲开！', this.sideX(1 - i), this.floorY() - 200, '#4cc9f0', 34)
      a.combo = 0
      this.ctx.audio.play('miss', 0.5)
      return
    }

    // 2. 重复惩罚
    if (a.lastKind === kind && this.t - a.lastAt < REPEAT_WIN) a.repeat++
    else a.repeat = 0
    a.lastKind = kind
    a.lastAt = this.t
    const mul = Math.max(REPEAT_FLOOR, Math.pow(0.75, a.repeat))
    if (a.repeat === 2) this.say('老是一招，没劲了', this.sideX(i), this.floorY() - 300, '#ffb74d', 28)

    // 3. 格挡
    const guarded = d.guard
    let dmg = DMG[kind] * mul
    if (guarded) {
      dmg *= GUARD_TAKE
      this.say('格挡！', this.sideX(1 - i), this.floorY() - 250, '#c9a0ff', 32)
      this.ctx.audio.play('click', 0.8, 1.1)
      this.particles.burst(this.sideX(1 - i), this.floorY() - 150, '#ffffff', 6, 180, 4)
    } else {
      this.particles.burst(this.sideX(1 - i), this.floorY() - 150, kind === 'kick' ? '#ffd54a' : '#ffb74d', 8, 260, 5)
      this.ctx.audio.play('hit', kind === 'kick' ? 0.9 : 0.6, kind === 'kick' ? 0.8 : 1.1)
    }

    d.hp = Math.max(0, d.hp - dmg)
    d.flash = 1
    a.landed++
    a.dealt += dmg
    if (!guarded) {
      a.combo++
      a.maxCombo = Math.max(a.maxCombo, a.combo)
    }
    // 只有「真的吃到伤害」才进受击硬直；格挡只是减伤，站点里也不进 hit 状态
    if (!guarded) {
      d.stunUntil = Math.max(d.stunUntil, this.t + HIT_STUN)
      if (d.move !== 'ko') {
        d.move = 'hit'
        d.moveUntil = this.t + HIT_STUN
      }
    }
    this.say(`-${Math.round(dmg)}`, this.sideX(1 - i) + dir * 20, this.floorY() - 210, guarded ? '#c9a0ff' : '#ff6b6b', 34)
  }

  // ------------------------------------------------------------------ 电脑

  private cpuStep(f: PoseFrame, dt: number) {
    const c = this.cpu
    const s = this.f[1]
    const me = this.f[0]
    void f
    void dt

    // 决策：每 0.5 秒一次
    if (this.t >= c.decideAt) {
      c.decideAt = this.t + 0.5
      const r = Math.random()
      if (r < this.cfg.guardP) c.guardUntil = this.t + rnd(0.45, 0.75)
      else if (r < this.cfg.guardP + this.cfg.dodgeP * 0.35) c.squatUntil = this.t + 0.5
    }
    // 被动躲踢腿：看到玩家踢腿前摇的 0.12~0.22 秒时起跳
    if (me.pendingAt >= 0) {
      const left = me.pendingAt - this.t
      if (left > 0.12 && left < 0.22 && Math.random() < this.cfg.dodgeP) {
        s.airUntil = this.t + AIR_T
        this.ctx.audio.jump()
      }
    }

    const guarding = this.t < c.guardUntil
    const squatting = !guarding && this.t < c.squatUntil
    s.guard = guarding
    s.squat = squatting
    s.move = guarding ? 'guard' : squatting ? 'squat' : s.move === 'guard' || s.move === 'squat' ? 'idle' : s.move
    s.inAir = this.t < s.airUntil

    // 出手
    if (this.t >= c.next && !guarding && !squatting && !s.inAir && this.t >= s.cool && this.t >= s.stunUntil) {
      const kick = Math.random() < this.cfg.kickP
      s.thrown++
      s.cool = this.t + CD[kick ? 'kick' : 'punch']
      if (kick) {
        s.move = 'kick'
        s.moveUntil = this.t + KICK_WINDUP + 0.15
        s.kickAnim = 1
        s.pendingAt = this.t + KICK_WINDUP
        s.pendingSide = Math.random() < 0.5 ? 0 : 1
      } else {
        s.move = 'punch'
        s.moveUntil = this.t + 0.16
        s.punchAnim = 1
        this.resolve(1, 'punch')
      }
      c.next = this.t + rnd(this.cfg.attack[0], this.cfg.attack[1])
    }
  }

  // ------------------------------------------------------------------ 回合结算

  private endRound(winner: number, how: 'ko' | 'time') {
    this.phase = 'ko'
    this.phaseAt = this.t
    for (let i = 0; i < 2; i++) {
      const s = this.f[i]
      s.pendingAt = -1
      if (i === winner) {
        s.move = 'win'
        s.moveUntil = 0
      } else if (winner >= 0) {
        s.move = 'ko'
        s.moveUntil = 0
      }
    }
    if (winner < 0) {
      this.banner = '平局'
      this.bannerSub = ''
      this.bannerColor = '#ff9f43'
      this.bannerT = ROUND_GAP
      this.ctx.audio.play('drop', 0.6)
      this.round++
      return
    }
    this.f[winner].wins++
    const human = winner === 0 || this.duel
    if (human) {
      this.ctx.addScore(1)
      this.ctx.audio.win()
      this.ctx.audio.play('score', 1, 1.15)
      this.particles.confetti(this.W, 30)
      this.banner = how === 'ko' ? 'K.O.！+1 胜' : '时间到！+1 胜'
      this.bannerColor = '#3ddc97'
      this.say('+1 胜', this.W / 2, this.H * 0.34, '#ffd54a', 48)
      this.ctx.speak('赢了！')
    } else {
      this.ctx.audio.lose()
      this.banner = how === 'ko' ? 'K.O.！' : '时间到！'
      this.bannerSub = '电脑赢了这回合'
      this.bannerColor = '#c98a4b'
      this.ctx.speak('这回合被电脑拿下了')
    }
    this.bannerSub = `${this.f[0].wins} : ${this.f[1].wins}`
    this.bannerT = ROUND_GAP
    this.round++
    this.ctx.setStage('')
    this.publishStats()
  }

  private publishStats() {
    const a = this.f[0]
    this.ctx.setExtra('回合胜', a.wins)
    this.ctx.setExtra('回合负', this.f[1].wins)
    this.ctx.setExtra('命中率', a.thrown ? Math.round((a.landed / a.thrown) * 100) : 0)
    this.ctx.setExtra('最大连击', a.maxCombo)
    this.ctx.setExtra('造成伤害', Math.round(a.dealt))
  }

  // ------------------------------------------------------------------ 绘制

  paint(c: CanvasRenderingContext2D) {
    const fy = this.floorY()
    this.drawArena(c, fy)
    for (let i = 0; i < 2; i++) {
      if (i === 1 && !this.duel) {
        this.drawFighter(c, this.sideX(1), fy, '#ff9f68', this.f[1], -1)
        continue
      }
      this.drawFighter(c, this.sideX(i), fy, PLAYER_COLORS[i], this.f[i], this.dir(i))
    }
    this.drawHud(c)
    if (this.phase === 'ready' || (this.phase === 'ko' && this.bannerT > 0)) {
      const zoom = this.phase === 'ready' ? 1 : 0.75
      c.globalAlpha = 0.9
      outlineTxt(c, 'VS', this.W / 2, this.H * 0.42, 74 * zoom, '#ff5252')
      c.globalAlpha = 1
      outlineTxt(c, this.phase === 'ready' ? '准备……' : '下一回合马上开始', this.W / 2, this.H * 0.42 + 70, 30, '#ffffffcc')
    }
    if (this.bannerT > 0 && this.banner && this.phase === 'ko') {
      c.globalAlpha = Math.min(1, this.bannerT * 1.8)
      outlineTxt(c, this.banner, this.W / 2, this.H * 0.24, 58, this.bannerColor)
      if (this.bannerSub) outlineTxt(c, this.bannerSub, this.W / 2, this.H * 0.24 + 56, 28, '#ffffffd0')
      c.globalAlpha = 1
    }
    if (this.bannerT > 0 && this.phase === 'fight') {
      c.globalAlpha = Math.min(1, this.bannerT * 1.8)
      outlineTxt(c, this.banner, this.W / 2, this.H * 0.2, 48, this.bannerColor)
      c.globalAlpha = 1
    }
  }

  private drawArena(c: CanvasRenderingContext2D, fy: number) {
    const g = c.createLinearGradient(0, fy - 220, 0, fy + 30)
    g.addColorStop(0, 'rgba(64,42,96,.35)')
    g.addColorStop(1, 'rgba(28,20,52,.7)')
    c.fillStyle = g
    c.fillRect(0, fy - 220, this.W, this.H - fy + 220)
    // 地面
    c.fillStyle = 'rgba(16,12,34,.55)'
    c.fillRect(0, fy, this.W, this.H - fy)
    c.strokeStyle = 'rgba(255,255,255,.28)'
    c.lineWidth = 3
    c.beginPath()
    c.moveTo(0, fy)
    c.lineTo(this.W, fy)
    c.stroke()
    // 中线
    c.strokeStyle = 'rgba(255,255,255,.12)'
    c.setLineDash([12, 14])
    c.beginPath()
    c.moveTo(this.W / 2, fy - 200)
    c.lineTo(this.W / 2, fy)
    c.stroke()
    c.setLineDash([])
  }

  private drawFighter(c: CanvasRenderingContext2D, x: number, fy: number, color: string, s: Fighter, face: number) {
    const sz = this.H * 0.125
    const ko = s.move === 'ko'
    const crouch = s.move === 'squat' ? 0.3 : 0
    const air = s.inAir ? Math.min(1, (s.airUntil - this.t) / AIR_T) : 0
    const lift = air > 0.15 ? -sz * 1.0 * Math.sin(Math.min(1, air) * Math.PI) : 0
    const hit = s.move === 'hit' ? 0.16 : 0
    const hipY = fy - sz * (0.62 - crouch * 0.7) + lift
    const bodyY = hipY - sz * (0.46 - crouch * 0.2) + lift * 0.2

    // 影子
    c.beginPath()
    c.ellipse(x, fy + 3, sz * (0.62 - (lift ? 0.12 : 0)), sz * 0.12, 0, 0, Math.PI * 2)
    c.fillStyle = 'rgba(10,8,24,.35)'
    c.fill()

    c.save()
    if (ko) {
      c.translate(x, fy)
      c.rotate(face * 1.35)
      c.translate(-x, -fy)
    }

    // 腿
    c.strokeStyle = color
    c.lineCap = 'round'
    c.lineWidth = sz * 0.2
    const kickLift = s.move === 'kick' ? 1 : 0
    for (const k of [-1, 1]) {
      c.beginPath()
      c.moveTo(x + k * sz * 0.13, hipY)
      if (kickLift && k === (s.pendingSide ? 1 : -1)) {
        c.lineTo(x + face * sz * 0.62, hipY - sz * 0.5)
      } else {
        c.lineTo(x + k * sz * 0.26, fy - sz * 0.02)
      }
      c.stroke()
    }

    // 躯干
    c.beginPath()
    c.ellipse(x + face * hit * sz * 0.5, bodyY, sz * 0.32, sz * 0.42, face * hit, 0, Math.PI * 2)
    c.fillStyle = color
    c.fill()

    // 头
    const headY = bodyY - sz * 0.56
    c.beginPath()
    c.arc(x + face * hit * sz * 0.9, headY, sz * 0.23, 0, Math.PI * 2)
    c.fillStyle = '#ffdfc0'
    c.fill()
    c.lineWidth = 3
    c.strokeStyle = 'rgba(24,18,44,.4)'
    c.stroke()
    // 表情
    c.strokeStyle = '#2b2340'
    c.lineWidth = 3
    const ex = x + face * hit * sz * 0.9
    if (s.move === 'ko') {
      for (const k of [-1, 1]) {
        c.beginPath()
        c.moveTo(ex + k * sz * 0.09 - 4, headY - 4)
        c.lineTo(ex + k * sz * 0.09 + 4, headY + 4)
        c.moveTo(ex + k * sz * 0.09 + 4, headY - 4)
        c.lineTo(ex + k * sz * 0.09 - 4, headY + 4)
        c.stroke()
      }
    } else if (s.move === 'hit') {
      c.beginPath()
      c.arc(ex - sz * 0.09, headY - 2, 4, 0, Math.PI * 2)
      c.stroke()
      c.beginPath()
      c.arc(ex + sz * 0.09, headY - 2, 4, 0, Math.PI * 2)
      c.stroke()
    } else {
      for (const k of [-1, 1]) {
        c.beginPath()
        if (s.move === 'squat' || s.move === 'guard') {
          c.moveTo(ex + k * sz * 0.09 - 5, headY - 2)
          c.lineTo(ex + k * sz * 0.09 + 5, headY - 2)
        } else {
          c.arc(ex + k * sz * 0.09, headY - 2, 3.2, 0, Math.PI * 2)
        }
        c.stroke()
      }
    }

    // 手臂
    c.strokeStyle = color
    c.lineWidth = sz * 0.16
    const guard = s.move === 'guard'
    for (const k of [0, 1]) {
      const sx = x + (k ? 1 : -1) * sz * 0.22
      const sy = bodyY - sz * 0.16
      c.beginPath()
      c.moveTo(sx, sy)
      if (guard) {
        c.lineTo(x + face * sz * 0.42, bodyY - sz * 0.02)
      } else if (s.move === 'punch' && k === 1) {
        c.lineTo(x + face * sz * 1.05, bodyY - sz * 0.08)
      } else if (s.move === 'win') {
        c.lineTo(x + (k ? 1 : -1) * sz * 0.5, bodyY - sz * 0.85)
      } else {
        c.lineTo(x + face * sz * 0.34 + (k ? 1 : -1) * sz * 0.18, bodyY + sz * 0.18)
      }
      c.stroke()
      // 拳
      c.beginPath()
      const hx = guard ? x + face * sz * 0.42 : s.move === 'punch' && k === 1 ? x + face * sz * 1.05 : x + face * sz * 0.34 + (k ? 1 : -1) * sz * 0.18
      const hy = guard ? bodyY - sz * 0.02 : s.move === 'win' ? bodyY - sz * 0.85 : bodyY + sz * 0.18
      c.arc(hx, hy, sz * 0.11, 0, Math.PI * 2)
      c.fillStyle = '#ffdfc0'
      c.fill()
    }

    // 抱架气罩
    if (guard) {
      c.beginPath()
      c.arc(x, bodyY, sz * 0.58, -Math.PI * 0.62, Math.PI * 0.62)
      c.lineWidth = 5
      c.strokeStyle = `rgba(255,255,255,${0.35 + Math.sin(this.t * 12) * 0.1})`
      c.stroke()
    }
    c.restore()

    if (s.flash > 0) {
      c.globalAlpha = s.flash * 0.4
      c.beginPath()
      c.arc(x, bodyY, sz * 0.62, 0, Math.PI * 2)
      c.fillStyle = '#ff4d4d'
      c.fill()
      c.globalAlpha = 1
    }
  }

  private drawHud(c: CanvasRenderingContext2D) {
    const y = 112
    const w = this.W * 0.27
    const h = 26
    for (let i = 0; i < 2; i++) {
      const s = this.f[i]
      const dir = i === 0 ? 1 : -1
      const left = i === 0 ? this.W * 0.06 : this.W * 0.94 - w
      rr(c, left, y, w, h, h / 2)
      c.fillStyle = 'rgba(14,12,30,.55)'
      c.fill()
      const pct = clamp(s.hp / MAX_HP, 0, 1)
      const shown = clamp(s.shown / MAX_HP, 0, 1)
      if (shown > 0.002) {
        c.save()
        c.beginPath()
        rr(c, left, y, w, h, h / 2)
        c.clip()
        rr(c, left + (dir > 0 ? 0 : w * (1 - shown)), y, w * shown, h, h / 2)
        c.fillStyle = 'rgba(255,255,255,.35)'
        c.fill()
        if (pct > 0.002) {
          rr(c, left + (dir > 0 ? 0 : w * (1 - pct)), y, w * pct, h, h / 2)
          c.fillStyle = pct < 0.25 ? '#ff5252' : i === 0 ? '#3ddc97' : '#ff9f68'
          c.fill()
        }
        c.restore()
      }
      // 血量数字在外侧
      const tx = i === 0 ? left - 26 : left + w + 26
      outlineTxt(c, String(Math.ceil(s.hp)), tx, y + h / 2, 22, '#ffffffdd')
      // 胜点
      const dots = Math.max(3, s.wins)
      for (let k = 0; k < dots; k++) {
        const dx = left + (dir > 0 ? 12 + k * 18 : w - 12 - k * 18)
        c.beginPath()
        c.arc(dx, y + h + 16, 6, 0, Math.PI * 2)
        c.fillStyle = k < s.wins ? '#ffd54a' : 'rgba(255,255,255,.28)'
        c.fill()
      }
      // 名字
      const name = this.duel ? (i === 0 ? '左边' : '右边') : i === 0 ? '你' : '电脑'
      outlineTxt(c, name, left + w / 2, y + h + 40, 20, i === 0 ? PLAYER_COLORS[0] : '#ff9f68')
    }
    outlineTxt(c, `第 ${this.round} 回合`, this.W / 2, 108, 26, '#ffffffdd')
    const left = this.W * 0.36
    const bw = this.W * 0.28
    const by = this.H - 44
    rr(c, left, by, bw, 12, 6)
    c.fillStyle = 'rgba(14,12,30,.5)'
    c.fill()
    const pct = this.phase === 'fight' ? clamp(1 - this.roundT / ROUND_LIMIT, 0, 1) : 1
    if (pct > 0.01) {
      rr(c, left, by, bw * pct, 12, 6)
      c.fillStyle = pct < 0.25 ? '#ff5252' : '#4cc9f0'
      c.fill()
    }
  }
}

export function createKungfuDuel(ctx: GameContext): Game {
  return new KungfuDuel(ctx)
}

export default createKungfuDuel
