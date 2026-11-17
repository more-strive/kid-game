import { BaseGame, PLAYER_COLORS } from '@/core/base'
import type { Game, GameContext, PoseFrame, Pt } from '@/core/types'
import { outlineTxt, rr, star } from '@/core/draw'

/**
 * 击剑（对齐 dongdongpark 真实规则）：
 * 对面一名电脑剑手。它抬手预告 → 出剑；你要在它出剑时把手上架格挡（或蹲下躲开），
 * 它收剑后露「破绽」，此时持剑手快速前刺得分。先刺中 5 剑赢一场，场次不断累积。
 *
 * 站点原样保留的六条规则：
 * 1. 电脑必先 `windup`（抬手预告 0.58~1.10 秒，随 heat 加速）再 `lunge`（0.40~0.55 秒判定窗）。
 * 2. 格挡有效窗 = `[出剑时刻 − 0.2, 出剑结束]`；且必须是「新举起」的手势（松开 ≥0.3 秒），两次格挡间隔 ≥0.5 秒。
 * 3. 破绽 `open` 是唯一稳定得分窗口；高难度下 25%~35% 的破绽是「诱饵」，盲刺有 55%~90% 被格挡。
 * 4. 假动作：medium 起 20%/33% 的抬手是假的，`fake` 0.3 秒后再真抬手 0.5 秒——抬手期间出剑必被反打。
 * 5. 刺击冷却 0.55 秒；被格挡/被反打后硬直 0.35~0.60 秒（期间不能刺也不能挡）。
 * 6. 每剑结算后定帧 1.5 秒；先到 5 剑赢一场，2.8 秒后比分清零开下一场。
 *
 * 与站点的差异（本框架限制，都写在这里）：
 * - 站点用 `hand.vel` 的 z 分量判断「往前刺」（>3.2 躯干/秒），2D 关键点拿不到 z；
 *   这里改用「水平手速 > 3.2 躯干/秒 且手在肩下髋上」代理。
 * - 站点「后仰闪身」用 `motion.shift × 朝向 < −0.5`，本框架没有 shift；改用「蹲下」代理低头躲剑，
 *   且闪避窗沿用站点的 0.45 秒（比格挡宽），换来的破绽只有 0.7 倍时长。
 * - 站点 `motion.guard`(双手护胸) 用「任一只手举到肩线以上」代理。
 * - 双人模式站点用飞行剑招对象+剑碰剑，这里同样实现了，但被格挡硬直取单人的 0.5 秒而非站点双人的 1.0 秒。
 */

const DIFF = [
  { windup: 1.1, win: 0.55, open: 1.6, gap: [1.5, 2.5], feint: 0, bait: 0.35, block: 0.55, rip: 0.25, stun: 0.35 },
  { windup: 0.8, win: 0.45, open: 1.15, gap: [1.2, 2.1], feint: 0.2, bait: 0.3, block: 0.75, rip: 0.45, stun: 0.5 },
  { windup: 0.58, win: 0.4, open: 0.8, gap: [0.9, 1.6], feint: 0.33, bait: 0.25, block: 0.9, rip: 0.65, stun: 0.6 },
]

const SET_POINTS = 5 // 先到 5 剑赢一场
const PARRY_WIN = 0.2 // 格挡有效窗（相对出剑时刻，秒）
const PARRY_CD = 0.5 // 两次有效格挡的最小间隔
const GUARD_RELEASE = 0.3 // 必须松开多久才算「新手势」
const DODGE_WIN = 0.45 // 闪避有效窗
const LUNGE_CD = 0.55 // 出剑冷却
const LUNGE_V = 3.2 // 前刺手速阈值（躯干/秒）
/** 单帧位移超过 30 躯干/秒 ⇒ 跟踪跳变（手被遮挡后突然出现在别处），不当作动作 */
const JUMP_V = 15
const GUARD_UP = 2.0 // 上架手速阈值（躯干/秒，站点同值，备用）
const HALT = 1.5 // 单剑结算后的定帧
const SET_GAP = 2.8 // 一场结束到下一场
const FAKE_T = 0.3 // 假动作本身时长
const FAKE_2 = 0.5 // 假动作之后的第二次抬手
const STAGGER_T = 0.3 // 被格挡后的踉跄
const CPU_BLOCK_T = 0.35 // 电脑格挡姿态时长
const READY_T = 0.6 // 开局等待
const BLADE = 1.45 // 剑长（躯干倍数）
const TAU = Math.PI * 2

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v))
}
function rnd(a: number, b: number) {
  return a + Math.random() * (b - a)
}

type CpuState = 'ready' | 'windup' | 'fake' | 'lunge' | 'stagger' | 'open' | 'block'
type Phase = 'wait' | 'bout' | 'halt' | 'setover'

interface HandTrack {
  x: number
  y: number
  vx: number
  vy: number
  ok: boolean
}

interface Side {
  hands: HandTrack[]
  parryAt: number
  backAt: number
  guard: boolean
  guardOffAt: number
  squatWas: boolean
  stunUntil: number
  lungeAt: number
  lungeAnim: number
  hitAnim: number
  thrown: number
  parries: number
  faced: number
  received: number
  reacts: number[]
  /** 双人：这一侧发出的剑招 */
  attackAt: number
  attackUntil: number
  attackTarget: number
}

interface Cpu {
  st: CpuState
  at: number
  until: number
  dur: number
  fake: boolean
  second: boolean
  bait: boolean
  nextAt: number
}

class Fencing extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  phase: Phase = 'wait'
  phaseAt = 0
  score: [number, number] = [0, 0]
  wins: [number, number] = [0, 0]
  set = 1
  duo = false
  sides: Side[] = []
  cpu: Cpu = { st: 'ready', at: 0, until: 0, dur: 0, fake: false, second: false, bait: false, nextAt: READY_T }
  private over = false
  private banner = ''
  private bannerSub = ''
  private bannerColor = '#ffd54a'
  private bannerT = 0
  private flash = 0
  private roundStartVoice = false

  constructor(ctx: GameContext) {
    super(ctx)
    this.sides = [this.blankSide(), this.blankSide()]
    this.phaseAt = 0
    this.banner = '第 1 场'
    this.bannerSub = '它抬手就挡，露破绽就刺'
    this.bannerT = 2
    this.ctx.speak('准备，开始！')
    this.ctx.setStage('准备')
  }

  private blankSide(): Side {
    return {
      hands: [0, 1].map(() => ({ x: 0, y: 0, vx: 0, vy: 0, ok: false })),
      parryAt: -99,
      backAt: -99,
      guard: false,
      guardOffAt: -9,
      squatWas: false,
      stunUntil: -99,
      lungeAt: -99,
      lungeAnim: 0,
      hitAnim: 0,
      thrown: 0,
      parries: 0,
      faced: 0,
      received: 0,
      reacts: [],
      attackAt: -99,
      attackUntil: -99,
      attackTarget: -1,
    }
  }

  /** 电脑与玩家同一条线，玩家在左 */
  private floorY() {
    return this.H * 0.82
  }
  private cpuX() {
    return this.W * 0.72
  }

  // ------------------------------------------------------------------ 主循环

  tick(f: PoseFrame, dt: number) {
    this.duo = f.bodies.length > 1
    if (this.bannerT > 0) this.bannerT -= dt
    this.flash = Math.max(0, this.flash - dt * 3)
    for (const s of this.sides) {
      s.lungeAnim = Math.max(0, s.lungeAnim - dt * 2.6)
      s.hitAnim = Math.max(0, s.hitAnim - dt * 1.8)
    }

    if (this.phase === 'wait') {
      if (this.t - this.phaseAt >= READY_T) this.startBout()
      this.publishStats()
      return
    }

    if (this.phase === 'halt') {
      this.readInputs(f, dt, false)
      if (this.t - this.phaseAt >= HALT) {
        this.phase = 'bout'
        this.phaseAt = this.t
        this.resetCpu()
        this.ctx.audio.play('start', 0.5)
        this.ctx.setStage('继续')
      }
      return
    }

    if (this.phase === 'setover') {
      this.readInputs(f, dt, false)
      if (this.over) return
      if (this.t - this.phaseAt >= SET_GAP) this.startBout()
      return
    }

    // ---- 交战
    this.readInputs(f, dt, true)
    if (!this.duo) this.cpuStep()
    else this.resolvePvp()

    if (this.cpu.st === 'lunge') this.cpuLunge()
    this.publishStats()
  }

  private startBout() {
    this.phase = 'bout'
    this.phaseAt = this.t
    this.score = [0, 0]
    for (const s of this.sides) {
      s.reacts = []
      s.stunUntil = -99
      s.attackAt = -99
      s.attackTarget = -1
    }
    this.resetCpu()
    this.banner = `第 ${this.set} 场`
    this.bannerSub = `先刺中 ${SET_POINTS} 剑`
    this.bannerColor = '#ffd54a'
    this.bannerT = 1.8
    this.ctx.audio.whistle()
    if (this.roundStartVoice) this.ctx.speak(`第 ${this.set} 场，开始！`)
    this.roundStartVoice = true
    this.ctx.setStage(`第 ${this.set} 场`)
  }

  private resetCpu() {
    const c = this.cpu
    c.st = 'ready'
    c.at = this.t
    c.until = 0
    c.fake = false
    c.second = false
    c.bait = false
    c.nextAt = this.t + 0.6
  }

  // ------------------------------------------------------------------ 玩家输入

  private readInputs(f: PoseFrame, dt: number, live: boolean) {
    for (let i = 0; i < 2; i++) {
      const b = f.bodies[i] ?? null
      const s = this.sides[i]
      if (!b) {
        for (const h of s.hands) h.ok = false
        s.guard = false
        continue
      }
      const T = Math.max(0.05, b.hipC.y - b.shoulderC.y)
      const dir = this.duo ? (i === 0 ? 1 : -1) : 1
      const pts = [b.lHand, b.rHand]
      let lunge = false
      let guard = false

      for (let k = 0; k < 2; k++) {
        const h = s.hands[k]
        const p = pts[k]
        if (!h.ok) {
          Object.assign(h, { x: p.x, y: p.y, vx: 0, vy: 0, ok: true })
          continue
        }
        const dx = p.x - h.x
        const dy = p.y - h.y
        h.x = p.x
        h.y = p.y
        h.vx = 0
        h.vy = 0
        if (Math.hypot(dx, dy) / (T * Math.max(1e-3, dt)) > JUMP_V) continue
        const vx = dx / Math.max(1e-3, dt)
        const vy = dy / Math.max(1e-3, dt)
        h.vx = vx
        h.vy = vy

        // 上架：手往上走（站点 vel.y < −2 躯干/秒 且偏竖直）
        if (-vy / T > GUARD_UP && -vy > Math.abs(vx) * 1.1) guard = true

        // 前刺：朝对手方向的水平手速 > 3.2 躯干/秒，且手在肩下、髋附近（2D 视角下的「前伸」代理）
        // 用有向速度而不是绝对速度，否则「出剑后把手收回来」也会被当成一剑
        const level = (vx * dir) / T
        const band = p.y > b.shoulderC.y + 0.1 * T && p.y < b.hipC.y + 0.25 * T
        if (live && level > LUNGE_V && band && Math.abs(vx) > Math.abs(vy) * 0.7) lunge = true
      }

      const upNow = guard || b.lHand.y < b.shoulderC.y - 0.02 || b.rHand.y < b.shoulderC.y - 0.02
      if (!upNow && s.guard) s.guardOffAt = this.t
      if (live && upNow && !s.guard && this.t - s.guardOffAt >= GUARD_RELEASE && this.t - s.parryAt >= PARRY_CD) {
        s.parryAt = this.t
      }
      s.guard = upNow

      if (b.squat && !s.squatWas && live) s.backAt = this.t
      s.squatWas = b.squat

      if (lunge) this.tryLunge(i)
    }
  }

  private tryLunge(i: number) {
    const s = this.sides[i]
    const t = this.t
    if (t < s.stunUntil || t - s.lungeAt < LUNGE_CD) return
    s.lungeAt = t
    s.lungeAnim = 1
    s.thrown++
    this.ctx.audio.play('hit', 0.4, 1.4)

    if (this.duo) {
      const other = 1 - i
      const o = this.sides[other]
      // 剑碰剑：对方同刻也有剑招指向自己
      if (o.attackTarget === i && t < o.attackUntil) {
        o.attackAt = -99
        o.attackTarget = -1
        o.thrown = Math.max(0, o.thrown - 1)
        s.attackAt = -99
        s.attackTarget = -1
        this.say('剑碰剑！', this.W / 2, this.H * 0.42, '#ff9f43', 44)
        this.ctx.audio.play('click', 0.8, 0.9)
        return
      }
      s.attackAt = t
      s.attackUntil = t + 0.35
      s.attackTarget = other
      o.faced++
      return
    }

    // ---- 单人对电脑
    const c = this.cpu
    const cfg = this.cfg
    if (c.st === 'open' || c.st === 'stagger') {
      s.reacts.push((t - c.at) * 1000)
      this.handleHit(0)
    } else if (c.st === 'ready') {
      if (Math.random() < cfg.block) {
        s.stunUntil = t + cfg.stun
        c.st = 'block'
        c.at = t
        c.until = t + CPU_BLOCK_T
        this.say('被挡开了，等它露破绽', this.W * 0.34, this.H * 0.36, '#c9a0ff', 34)
        this.ctx.audio.play('click', 0.7, 0.7)
      } else {
        this.handleHit(0)
      }
    } else if (c.st === 'windup' || c.st === 'fake') {
      s.stunUntil = t + cfg.stun
      this.say('它抬手了，先挡！', this.W * 0.34, this.H * 0.36, '#ff8a8a', 34)
      this.ctx.audio.play('miss', 0.6)
    }
    // lunge / block：空挥，只消耗冷却（站点同）
  }

  /** 玩家刺中一剑 */
  private handleHit(i: number) {
    const s = this.sides[i]
    this.score[i]++
    this.ctx.addScore(1)
    this.ctx.audio.good()
    this.ctx.audio.play('score', 0.9, 1.1)
    this.flash = 1
    const p = s.hands[0].ok ? s.hands[0] : s.hands[1]
    this.say('命中 +1', p.x * this.W, p.y * this.H - 40, '#ffd54a', 40)
    this.particles.burst(p.x * this.W, p.y * this.H, '#ffd54a', 12, 380, 6)
    this.particles.burst(p.x * this.W, p.y * this.H, '#ffffff', 8, 260, 5)
    this.cpu.st = 'stagger'
    this.cpu.at = this.t
    this.cpu.until = this.t + 99
    if (this.score[0] >= SET_POINTS || this.score[1] >= SET_POINTS) this.endSet()
    else this.enterHalt()
  }

  private enterHalt() {
    this.phase = 'halt'
    this.phaseAt = this.t
    this.ctx.setStage('')
  }

  private endSet() {
    this.phase = 'setover'
    this.phaseAt = this.t
    const w = this.score[0] >= this.score[1] ? 0 : 1
    this.wins[w]++
    this.ctx.audio.win()
    this.ctx.audio.play('score', 1, 1.2)
    this.particles.confetti(this.W, 34)
    this.banner = w === 0 ? '你赢了这一场！' : '电脑赢了这一场'
    this.bannerSub = `${this.score[0]} : ${this.score[1]}`
    this.bannerColor = w === 0 ? '#3ddc97' : '#c98a4b'
    this.bannerT = SET_GAP
    this.say('赢一场！', this.W * 0.3, this.H * 0.3, '#ffd54a', 46)
    this.ctx.speak(w === 0 ? '赢了这一场！' : '这一场被它拿下了')
    this.set++
    this.publishStats()
  }

  // ------------------------------------------------------------------ 电脑

  private gap() {
    const [a, b] = this.cfg.gap
    return rnd(a, b)
  }

  private cpuStep() {
    const c = this.cpu
    const cfg = this.cfg
    const t = this.t
    switch (c.st) {
      case 'ready':
        if (t >= c.nextAt) {
          if (Math.random() < cfg.bait) {
            // 诱饵：不出剑，直接亮破绽
            c.st = 'open'
            c.at = t
            c.until = t + cfg.open * rnd(0.8, 1.2)
            c.bait = true
            this.ctx.audio.play('pop', 0.4, 1.5)
          } else {
            this.cpuWindup(cfg.windup * rnd(0.85, 1.15))
          }
        }
        break
      case 'windup':
        if (t >= c.until) {
          if (c.fake) {
            c.st = 'fake'
            c.at = t
            c.until = t + FAKE_T
            this.say('假动作！', this.cpuX(), this.H * 0.34, '#ff9f43', 36)
            this.ctx.audio.play('tick', 0.7, 1.4)
          } else {
            c.st = 'lunge'
            c.at = t
            c.until = t + cfg.win
            c.second = false
            this.sides[0].faced++
            this.ctx.audio.play('hit', 0.5, 0.9)
          }
        }
        break
      case 'fake':
        if (t >= c.until) this.cpuWindup(FAKE_2, true)
        break
      case 'lunge':
        break
      case 'stagger':
        if (t >= c.until) this.cpuOpen(cfg.open)
        break
      case 'open':
        if (t >= c.until) {
          c.st = 'ready'
          c.bait = false
          c.nextAt = t + this.gap() * 0.6
        }
        break
      case 'block':
        if (t >= c.until) {
          if (Math.random() < cfg.rip) this.cpuWindup(cfg.windup * 0.6)
          else {
            c.st = 'ready'
            c.nextAt = t + 0.6
          }
        }
        break
    }
  }

  private cpuWindup(dur: number, second = false) {
    const c = this.cpu
    c.st = 'windup'
    c.at = this.t
    c.until = this.t + dur
    c.dur = dur
    c.second = second
    c.fake = !second && Math.random() < this.cfg.feint
    c.bait = false
    this.ctx.audio.play('tick', 0.5, 1.1)
  }

  private cpuOpen(dur: number) {
    const c = this.cpu
    c.st = 'open'
    c.at = this.t
    c.until = this.t + dur
    this.ctx.audio.play('pop', 0.45, 1.3)
  }

  private cpuLunge() {
    const c = this.cpu
    const s = this.sides[0]
    const t = this.t
    if (s.parryAt >= c.at - PARRY_WIN) {
      s.parries++
      s.parryAt = -99
      s.attackTarget = -1
      this.say('挡住了！', this.W * 0.34, this.H * 0.32, '#4cc9f0', 40)
      this.ctx.audio.play('click', 0.9, 1.2)
      this.ctx.audio.play('pop', 0.5, 1.6)
      this.particles.burst(this.W * 0.42, this.H * 0.55, '#4cc9f0', 10, 300, 5)
      c.st = 'stagger'
      c.at = t
      c.until = t + STAGGER_T
      this.ctx.setStage('破绽出现了，刺！')
      return
    }
    if (s.backAt >= c.at - DODGE_WIN) {
      s.backAt = -99
      this.say('躲开了！', this.W * 0.34, this.H * 0.32, '#4cc9f0', 40)
      this.ctx.audio.jump()
      c.st = 'open'
      c.at = t
      c.until = t + this.cfg.open * 0.7
      return
    }
    if (t >= c.until) {
      s.received++
      s.hitAnim = 1
      this.score[1]++
      this.flash = 1
      this.say('被刺中', this.W * 0.34, this.H * 0.34, '#c9a0ff', 38)
      this.ctx.audio.play('hit', 0.9, 0.8)
      this.ctx.audio.play('miss', 0.5)
      if (s.guard) this.say('一直护着没用，看准了再挡', this.W * 0.34, this.H * 0.42, '#ffb74d', 30)
      c.st = 'stagger'
      c.at = t
      c.until = t + 99
      if (this.score[1] >= SET_POINTS) this.endSet()
      else this.enterHalt()
    }
  }

  // ------------------------------------------------------------------ 双人对刺

  private resolvePvp() {
    for (let i = 0; i < 2; i++) {
      const s = this.sides[i]
      if (s.attackTarget < 0 || this.t < s.attackUntil) continue
      const o = this.sides[1 - i]
      if (o.parryAt >= s.attackAt - PARRY_WIN) {
        o.parries++
        o.parryAt = -99
        s.stunUntil = this.t + 1.0
        this.say('挡住了！', this.W / 2, this.H * 0.3, '#4cc9f0', 38)
        this.ctx.audio.play('click', 0.9, 1.2)
      } else if (o.backAt >= s.attackAt - DODGE_WIN) {
        o.backAt = -99
        this.say('躲开了！', this.W / 2, this.H * 0.3, '#4cc9f0', 38)
      } else {
        this.handleHit(i)
      }
      s.attackTarget = -1
      break
    }
  }

  // ------------------------------------------------------------------ 统计

  private publishStats() {
    const a = this.sides[0]
    this.ctx.setExtra('格挡', a.parries)
    this.ctx.setExtra('被攻', a.faced)
    this.ctx.setExtra('被刺中', a.received)
    this.ctx.setExtra('赢的场次', this.wins[0])
    const ms = a.reacts.length ? Math.round(a.reacts.reduce((x, y) => x + y, 0) / a.reacts.length) : 0
    this.ctx.setExtra('抓破绽(ms)', ms)
  }

  // ------------------------------------------------------------------ 绘制

  paint(c: CanvasRenderingContext2D) {
    const fy = this.floorY()
    this.drawStrip(c, fy)
    if (!this.duo) this.drawCpu(c)
    else {
      for (let i = 0; i < 2; i++) {
        const b = this.players[i].body
        if (b) this.drawFencer(c, b.center.x * this.W, fy, PLAYER_COLORS[i], this.sides[i], i === 0 ? 1 : -1)
      }
    }
    // 玩家自己的剑（跟着真实的手）
    for (let i = 0; i < 2; i++) {
      if (!this.players[i].body) continue
      if (!this.duo && i === 1) continue
      this.drawMyBlade(c, i)
    }
    this.drawHud(c)
    if (this.flash > 0) {
      c.globalAlpha = this.flash * 0.16
      c.fillStyle = '#ffffff'
      c.fillRect(0, 0, this.W, this.H)
      c.globalAlpha = 1
    }
    if (this.bannerT > 0 && this.banner) {
      c.globalAlpha = Math.min(1, this.bannerT * 1.6)
      outlineTxt(c, this.banner, this.W / 2, this.H * 0.2, 60, this.bannerColor)
      if (this.bannerSub) outlineTxt(c, this.bannerSub, this.W / 2, this.H * 0.2 + 58, 28, '#ffffffd0')
      c.globalAlpha = 1
    }
  }

  private drawStrip(c: CanvasRenderingContext2D, fy: number) {
    // 击剑台
    const g = c.createLinearGradient(0, fy - 90, 0, fy + 40)
    g.addColorStop(0, 'rgba(38,48,86,.5)')
    g.addColorStop(1, 'rgba(20,26,52,.75)')
    c.fillStyle = g
    c.fillRect(0, fy - 14, this.W, this.H - fy + 14)
    c.strokeStyle = 'rgba(255,255,255,.5)'
    c.lineWidth = 3
    c.beginPath()
    c.moveTo(this.W * 0.08, fy)
    c.lineTo(this.W * 0.94, fy)
    c.stroke()
    c.strokeStyle = 'rgba(255,255,255,.22)'
    c.lineWidth = 2
    for (let i = 0; i <= 8; i++) {
      const x = this.W * (0.1 + i * 0.1)
      c.beginPath()
      c.moveTo(x, fy - 8)
      c.lineTo(x, fy + 8)
      c.stroke()
    }
  }

  /** 玩家自己的剑：从真实手的位置朝对手方向伸出 */
  private drawMyBlade(c: CanvasRenderingContext2D, i: number) {
    const b = this.players[i].body
    if (!b) return
    const T = Math.max(0.05, b.hipC.y - b.shoulderC.y)
    const s = this.sides[i]
    const dir = this.duo ? (i === 0 ? 1 : -1) : 1
    // 选更靠前的那只手
    const hand: Pt = (b.lHand.x * dir >= b.rHand.x * dir ? b.lHand : b.rHand)
    const len = T * BLADE * (1 + 0.28 * s.lungeAnim)
    const tip = { x: hand.x + (dir * len) / 0.7 * 0.62, y: hand.y - len * 0.22 }
    const hx = hand.x * this.W
    const hy = hand.y * this.H
    const tx = tip.x * this.W
    const ty = tip.y * this.H

    // 拖尾
    if (s.lungeAnim > 0.1) {
      c.globalAlpha = s.lungeAnim * 0.5
      c.strokeStyle = '#9be7ff'
      c.lineWidth = 8
      c.beginPath()
      c.moveTo(hx - 40, hy + 20)
      c.lineTo(tx, ty)
      c.stroke()
      c.globalAlpha = 1
    }
    c.strokeStyle = 'rgba(24,30,60,.55)'
    c.lineWidth = 7
    c.lineCap = 'round'
    c.beginPath()
    c.moveTo(hx, hy)
    c.lineTo(tx, ty)
    c.stroke()
    c.strokeStyle = '#dff6ff'
    c.lineWidth = 3
    c.beginPath()
    c.moveTo(hx, hy)
    c.lineTo(tx, ty)
    c.stroke()
    // 护手
    c.beginPath()
    c.arc(hx, hy, 10, 0, TAU)
    c.fillStyle = '#ffd54a'
    c.fill()
    // 剑尖
    c.beginPath()
    c.arc(tx, ty, 5, 0, TAU)
    c.fillStyle = '#ffffff'
    c.fill()
  }

  private drawFencer(
    c: CanvasRenderingContext2D,
    x: number,
    fy: number,
    color: string,
    s: Side,
    face: number,
    cpuMode = false,
  ) {
    const sz = this.H * 0.115
    const lean = 0.12 + 0.2 * s.lungeAnim - 0.16 * s.hitAnim
    const hipY = fy - sz * 0.62
    const bodyY = hipY - sz * 0.5
    // 影子
    c.beginPath()
    c.ellipse(x, fy + 3, sz * 0.66, sz * 0.12, 0, 0, TAU)
    c.fillStyle = 'rgba(18,22,55,.3)'
    c.fill()
    // 腿（弓步）
    c.strokeStyle = color
    c.lineCap = 'round'
    c.lineWidth = sz * 0.2
    for (const k of [-1, 1]) {
      c.beginPath()
      c.moveTo(x, hipY)
      c.lineTo(x + face * sz * (0.28 * k + 0.1 * lean * 2), fy)
      c.stroke()
    }
    // 躯干
    c.beginPath()
    c.ellipse(x + face * lean * sz * 0.5, bodyY, sz * 0.3, sz * 0.44, face * lean * 0.3, 0, TAU)
    c.fillStyle = color
    c.fill()
    // 面罩
    c.beginPath()
    c.arc(x + face * lean * sz * 0.9, bodyY - sz * 0.52, sz * 0.24, 0, TAU)
    c.fillStyle = '#e9eef8'
    c.fill()
    c.lineWidth = 3
    c.strokeStyle = 'rgba(28,34,64,.45)'
    c.stroke()
    c.beginPath()
    c.moveTo(x + face * lean * sz * 0.9 - sz * 0.2, bodyY - sz * 0.5)
    c.lineTo(x + face * lean * sz * 0.9 + sz * 0.2, bodyY - sz * 0.5)
    c.strokeStyle = 'rgba(28,34,64,.5)'
    c.stroke()

    // 剑
    const reach = cpuMode ? this.cpuReach() : 1 + 0.3 * s.lungeAnim
    const bx = x + face * sz * 0.4
    const by = bodyY + sz * 0.1
    const tx = bx + face * sz * 1.55 * reach
    const ty = by - sz * (cpuMode ? this.cpuBladeY() : 0.16)
    c.strokeStyle = 'rgba(20,26,52,.5)'
    c.lineWidth = 5
    c.beginPath()
    c.moveTo(bx, by)
    c.lineTo(tx, ty)
    c.stroke()
    c.strokeStyle = '#dff6ff'
    c.lineWidth = 2.4
    c.beginPath()
    c.moveTo(bx, by)
    c.lineTo(tx, ty)
    c.stroke()

    if (s.hitAnim > 0) {
      c.globalAlpha = s.hitAnim * 0.45
      c.beginPath()
      c.arc(x + face * lean * sz * 0.5, bodyY, sz * 0.6, 0, TAU)
      c.fillStyle = '#ff4d4d'
      c.fill()
      c.globalAlpha = 1
    }
  }

  private cpuReach() {
    const c = this.cpu
    return c.st === 'lunge' ? 1.9 : c.st === 'windup' || c.st === 'fake' ? 0.75 : 1
  }
  private cpuBladeY() {
    const c = this.cpu
    return c.st === 'windup' ? 0.9 : c.st === 'lunge' ? 0.05 : 0.16
  }

  private drawCpu(c: CanvasRenderingContext2D) {
    const c2 = this.cpu
    const fy = this.floorY()
    const cx = this.cpuX()
    const T = this.H * 0.115
    const side = this.sides[1]
    side.lungeAnim = c2.st === 'lunge' ? 1 : Math.max(0, side.lungeAnim)
    this.drawFencer(c, cx, fy, '#ff9f68', side, -1, true)

    // 抬手进度弧（红/橙）
    if (c2.st === 'windup' || c2.st === 'fake') {
      const p = clamp((this.t - c2.at) / Math.max(0.01, c2.until - c2.at), 0, 1)
      const ay = fy - T * 2.35
      c.beginPath()
      c.arc(cx, ay, T * 0.38, -Math.PI / 2, -Math.PI / 2 + TAU * p)
      c.lineWidth = 7
      c.strokeStyle = c2.second || p > 0.75 ? '#ff4d4d' : '#ff9f43'
      c.stroke()
      outlineTxt(c, c2.fake ? '假？' : '抬手', cx, ay - T * 0.62, 26, '#ff9f43')
    }
    if (c2.st === 'lunge') {
      const pulse = 0.5 + 0.5 * Math.abs(Math.sin(this.t * 16))
      c.globalAlpha = 0.35 + 0.4 * pulse
      c.beginPath()
      c.arc(cx - T * 0.9, fy - T * 1.2, T * 0.9, 0, TAU)
      c.fillStyle = '#ff4d4d'
      c.fill()
      c.globalAlpha = 1
      outlineTxt(c, '挡！', cx, fy - T * 2.4, 34, '#ff6b6b')
    }
    // 破绽：脚下的绿圈
    if (c2.st === 'open' || c2.st === 'stagger') {
      const p = clamp(1 - (this.t - c2.at) / Math.max(0.1, this.cfg.open), 0, 1)
      c.beginPath()
      c.ellipse(cx, fy + 2, T * 0.85, T * 0.22, 0, 0, TAU)
      c.lineWidth = 5
      c.strokeStyle = `rgba(61,220,151,${0.5 + 0.5 * p})`
      c.stroke()
      outlineTxt(c, c2.bait ? '破绽？（小心）' : '破绽！', cx, fy - T * 2.5, 30, '#3ddc97')
    }
    // 玩家的提示箭头
    if (!this.duo && this.phase === 'bout') {
      const b = this.players[0].body
      if (b) {
        const px = b.center.x * this.W
        const py = b.center.y * this.H
        if (c2.st === 'open' || c2.st === 'stagger') this.hint(c, px, py - 90, '刺！', '#3ddc97', 1)
        else if (c2.st === 'windup' || c2.st === 'fake' || c2.st === 'lunge') this.hint(c, px, py - 90, '挡', '#ff9f43', -1)
      }
    }
  }

  /** 手边的小箭头提示：dir 1 = 向右（去刺），−1 = 向上（去挡） */
  private hint(c: CanvasRenderingContext2D, x: number, y: number, text: string, color: string, dir: number) {
    const pulse = 1 + 0.08 * Math.sin(this.t * 9)
    c.save()
    c.translate(x, y)
    c.scale(pulse, pulse)
    c.beginPath()
    if (dir > 0) {
      c.moveTo(-14, -12)
      c.lineTo(14, 0)
      c.lineTo(-14, 12)
    } else {
      c.moveTo(-12, 14)
      c.lineTo(0, -14)
      c.lineTo(12, 14)
    }
    c.closePath()
    c.fillStyle = color
    c.fill()
    outlineTxt(c, text, 0, 40, 30, color)
    c.restore()
  }

  private drawHud(c: CanvasRenderingContext2D) {
    const y = 108
    // 比分
    outlineTxt(c, `${this.score[0]}`, this.W * 0.42, y, 56, PLAYER_COLORS[0])
    outlineTxt(c, ':', this.W * 0.5, y, 44, '#ffffffcc')
    outlineTxt(c, `${this.score[1]}`, this.W * 0.58, y, 56, '#ff9f68')
    outlineTxt(c, this.duo ? '左边' : '你', this.W * 0.42, y + 46, 22, '#ffffffaa')
    outlineTxt(c, this.duo ? '右边' : '电脑', this.W * 0.58, y + 46, 22, '#ffffffaa')
    outlineTxt(c, `第 ${this.set} 场`, this.W * 0.5, y + 96, 24, '#ffffffcc')

    // 场次胜点
    for (let i = 0; i < 2; i++) {
      const x = i === 0 ? this.W * 0.42 : this.W * 0.58
      for (let k = 0; k < Math.max(1, this.wins[i]); k++) {
        if (k >= this.wins[i]) break
        star(c, x + (k - (this.wins[i] - 1) / 2) * 26, y + 78, 9, i === 0 ? PLAYER_COLORS[0] : '#ff9f68')
      }
    }

    // 电脑抬手冷却条（让玩家知道还有多久来袭）
    const left = this.W * 0.32
    const w = this.W * 0.36
    const by = this.H - 48
    rr(c, left, by, w, 12, 6)
    c.fillStyle = 'rgba(18,22,55,.42)'
    c.fill()
    const cfg = this.cfg
    let pct = 0
    if (this.duo) pct = 0
    else if (this.cpu.st === 'windup' || this.cpu.st === 'fake') pct = clamp(1 - (this.cpu.until - this.t) / Math.max(0.01, cfg.windup), 0, 1)
    else if (this.cpu.st === 'ready') pct = clamp((this.t - (this.cpu.nextAt - this.gap())) / Math.max(0.01, this.gap()), 0, 1)
    else if (this.cpu.st === 'open' || this.cpu.st === 'stagger') pct = 1
    if (pct > 0.01) {
      rr(c, left, by, w * pct, 12, 6)
      c.fillStyle = this.cpu.st === 'open' || this.cpu.st === 'stagger' ? '#3ddc97' : pct > 0.7 ? '#ff5252' : '#ffb74d'
      c.fill()
    }
    const label = this.duo ? '看准破绽再刺' : this.cpu.st === 'open' || this.cpu.st === 'stagger' ? '破绽！快刺' : '等它抬手'
    outlineTxt(c, label, this.W / 2, by - 22, 22, '#ffffffb0')
  }
}

export function createFencing(ctx: GameContext): Game {
  return new Fencing(ctx)
}

export default createFencing
