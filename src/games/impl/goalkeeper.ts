import { BaseGame } from '@/core/base'
import type { Game, GameContext, PoseFrame } from '@/core/types'
import { circle, glow, outlineTxt, txt } from '@/core/draw'

/**
 * 守门员（对齐 dongdongpark 真实规则，报告 _reverse/reports/goalkeeper.md）：
 * 对方球员从不同角度射门，用手/脚/头/膝把球挡出去；边角球要横扑、高吊球必须真跳起来（站着手碰无效）。
 * 定时到达型：球按 fly 秒从底线飞向落点，t/fly ≥ 0.86 开放扑救判定，≥ 1.08 判失球。连扑 3 个金手套。
 */

/** 对齐站点难度表：射门间隔 / 飞行时长 / 踢前待机 / 球判定半径 px×unit / 同屏在途上限 / 四种射门概率 / 中位散布(躯干) */
const DIFF = [
  { every: 2.7, fly: 1.9, wait: 0.8, r: 52, max: 1, mix: [0.3, 0.25, 0.35, 0.1] as const, spread: 1.2 },
  { every: 2.2, fly: 1.5, wait: 0.7, r: 46, max: 1, mix: [0.3, 0.1, 0.42, 0.18] as const, spread: 1.45 },
  { every: 1.8, fly: 1.15, wait: 0.6, r: 42, max: 2, mix: [0.3, 0.05, 0.4, 0.25] as const, spread: 1.6 },
]
const SAVE_OPEN = 0.86 // 扑救判定开放点（球飞过 86% 路程）
const GOAL_AT = 1.08 // 失球判定（球越过落点 8% 才判进）
const GOLD_LINE = 3 // 金手套连击线
const JUMP_NEED = 0.08 // 跳起判定：髋高于基线 0.08 躯干
const BASE_CATCH = 0.95 // 扑救判定半径系数（×r）
const AWAY_T = 0.9 // 扑出后球飞走的存活时长 s
const FLASH_DECAY = 1.6 // 失球红闪衰减 /s

type ShotKind = 'low' | 'center' | 'mid' | 'high'

interface Shot {
  kind: ShotKind
  /** 落点（屏幕 px） */
  tx: number
  ty: number
  /** 起点（踢球者脚边，屏幕 px） */
  sx: number
  sy: number
  /** 弧高 px */
  arc: number
  t: number
  fly: number
  state: 'wait' | 'fly' | 'away' | 'goal'
  /** 球当前真实位置（px） */
  x: number
  y: number
  r: number
  /** away 状态的速度 */
  vx: number
  vy: number
  awayT: number
  /** 踢球者站位与踢脚动画 */
  kx: number
  kickT: number
  saved: boolean
  /** 触碰部位冷却（防一帧多次） */
  done: boolean
}

interface Deck {
  /** 下一 shots 的倒计时 */
  timer: number
  shots: Shot[]
  saves: number
  goals: number
  streak: number
  maxStreak: number
  dives: number
  jumps: number
  /** 髋位基线（平滑：下蹲快跟 τ=2、起立慢 τ=0.15） */
  hipBase: number
  /** 失球红闪位置 */
  flash: number
  fx: number
  fy: number
  /** 提示语音冷却 */
  sayCd: number
}

function newDeck(): Deck {
  return { timer: 1.2, shots: [], saves: 0, goals: 0, streak: 0, maxStreak: 0, dives: 0, jumps: 0, hipBase: 0, flash: 0, fx: 0, fy: 0, sayCd: 0 }
}

function pickKind(mix: readonly number[]) {
  const roll = Math.random()
  let acc = 0
  const names: ShotKind[] = ['low', 'center', 'mid', 'high']
  for (let i = 0; i < 4; i++) {
    acc += mix[i]
    if (roll < acc) return names[i]
  }
  return 'mid'
}

class Goalkeeper extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  decks = [newDeck(), newDeck()]

  private duo() {
    return this.players.filter((p) => p.body).length > 1
  }

  /** 球门区（宽 min(区宽×0.92, 单人 920/双人 600×unit)，顶 max(118, 0.17H)，高 0.92H−顶） */
  private goal(pi: number) {
    const U = this.H / 720
    const duo = this.duo()
    const x0 = duo ? (pi === 0 ? 0.03 : 0.53) * this.W : 0.08 * this.W
    const x1 = duo ? (pi === 0 ? 0.47 : 0.97) * this.W : 0.92 * this.W
    const w = Math.min((x1 - x0) * 0.92, (duo ? 600 : 920) * U)
    const cx = (x0 + x1) / 2
    const top = Math.max(118 * U, this.H * 0.17)
    const h = this.H * 0.92 - top
    return { x0, x1, cx, top, h, w, left: cx - w / 2, right: cx + w / 2 }
  }

  tick(f: PoseFrame, dt: number) {
    for (let pi = 0; pi < 2; pi++) {
      const dk = this.decks[pi]
      const b = f.bodies[pi]
      dk.sayCd = Math.max(0, dk.sayCd - dt)
      // 没人在场：清空在途球（防积分挂在缺位玩家）
      if (!b) {
        dk.shots.length = 0
        continue
      }
      const T = Math.max(60, Math.max(0.05, b.scale) * this.H)
      const g = this.goal(pi)
      // 髋位基线：下蹲快速跟随(2/s)、起立慢(0.15/s)
      const hipY = b.hipC.y * this.H
      if (dk.hipBase <= 0) dk.hipBase = hipY
      dk.hipBase += (hipY - dk.hipBase) * Math.min(1, dt * (hipY > dk.hipBase ? 2 : 0.15))
      const jumping = hipY < dk.hipBase - JUMP_NEED * T

      // ---- 射门生成 ----
      const flying = dk.shots.filter((s) => s.state !== 'away').length
      dk.timer -= dt
      if (dk.timer <= 0) {
        dk.timer = this.cfg.every * (0.8 + Math.random() * 0.4)
        if (flying < this.cfg.max) this.spawnShot(pi, dk, b, T, g)
      }

      // ---- 球的更新 ----
      for (const s of dk.shots) {
        if (s.state === 'wait') {
          // 球停在踢球者脚边，踢球者跟随守门员横移 ±14
          s.kickT -= dt
          s.x = s.kx + Math.max(-14, Math.min(14, (b.shoulderC.x * this.W - s.kx) * 0.2))
          s.y = s.sy - Math.sin(Math.min(1, Math.max(0, 1 - s.kickT / this.cfg.wait)) * Math.PI) * 4
          if (s.kickT <= 0) {
            s.state = 'fly'
            s.t = 0
            this.ctx.audio.play('hit', 0.8, 1 + Math.random() * 0.15)
          }
        } else if (s.state === 'fly') {
          s.t += dt
          const k = s.t / s.fly
          // 位置线性插值 + 弧高（low 无弧）
          s.x = s.sx + (s.tx - s.sx) * Math.min(1.08, k)
          s.y = s.sy + (s.ty - s.sy) * Math.min(1.08, k) - Math.sin(Math.min(1, Math.max(0, k)) * Math.PI) * s.arc
          s.r = this.cfg.r * (this.H / 720) * (0.45 + 0.55 * Math.min(1, Math.max(0, k)))
          // 扑救判定：t/fly ≥ 0.86 后每帧
          if (!s.done && k >= SAVE_OPEN) {
            const hit = this.trySave(b, s, T, jumping)
            if (hit) {
              s.done = true
              this.onSave(pi, dk, s, hit, T, jumping)
              continue
            }
          }
          // 失球：t/fly ≥ 1.08
          if (k >= GOAL_AT) {
            s.state = 'goal'
            s.done = true
            this.onGoal(pi, dk, s)
          }
        } else if (s.state === 'away') {
          s.awayT -= dt
          s.x += s.vx * dt
          s.y += s.vy * dt
          s.vy += 1400 * dt
          if (s.awayT <= 0) s.state = 'goal'
        }
      }
      dk.shots = dk.shots.filter((s) => s.state !== 'goal')
      // 失球红闪衰减
      if (dk.flash > 0) dk.flash = Math.max(0, dk.flash - FLASH_DECAY * dt)
    }

    this.ctx.setScore(this.decks.reduce((n, d) => n + d.saves, 0))
    this.ctx.setCombo(Math.max(...this.decks.map((d) => d.streak)))
    const shots = this.decks.reduce((n, d) => n + d.saves + d.goals, 0)
    const saves = this.decks.reduce((n, d) => n + d.saves, 0)
    this.ctx.setExtra('扑救率', shots > 0 ? Math.round((saves / shots) * 100) : 0)
    this.ctx.setExtra('最多连扑', Math.max(...this.decks.map((d) => d.maxStreak)))
    this.ctx.setExtra('飞身/跳起', this.decks.reduce((n, d) => n + d.dives + d.jumps, 0))
  }

  /** 生成一次射门（落点按球种相对身体关节，钳制球门内；踢球者站位区外） */
  private spawnShot(_pi: number, dk: Deck, b: NonNullable<PoseFrame['bodies'][number]>, T: number, g: ReturnType<Goalkeeper['goal']>) {
    const kind = pickKind(this.cfg.mix)
    const shoulderY = b.shoulderC.y * this.H
    const hipY = b.hipC.y * this.H
    const headY = b.head.y * this.H
    const cx = b.shoulderC.x * this.W
    const r = this.cfg.r * (this.H / 720)
    let ty: number
    let spreadT: number
    switch (kind) {
      case 'low':
        ty = hipY + 1.05 * T
        spreadT = 0.3 + Math.random()
        break
      case 'center':
        ty = shoulderY + (0.2 + Math.random() * 0.5) * T
        spreadT = 0.4
        break
      case 'mid':
        ty = shoulderY + (Math.random() * 0.9 - 0.2) * T
        spreadT = 0.7 + Math.random() * (this.cfg.spread - 0.7)
        break
      default:
        ty = headY - 0.62 * T
        spreadT = 0.5
        break
    }
    const side = Math.random() < 0.5 ? -1 : 1
    let tx = cx + side * spreadT * T
    // 落点钳制球门内（缩 r 边距）
    tx = Math.max(g.left + r, Math.min(g.right - r, tx))
    ty = Math.max(g.top + r, Math.min(this.H * 0.92 - r, ty))
    // 踢球者站位：肩心 ∓(1.7+rng×1.2)×torso（区外）
    const kSide = tx > cx ? -1 : 1
    const kx = cx + kSide * (1.7 + Math.random() * 1.2) * T
    const sy = Math.min(this.H * 0.88, hipY + T * 0.75)
    const arc = kind === 'low' ? 0 : kind === 'mid' ? 0.45 * T : 1.1 * T
    dk.shots.push({
      kind,
      tx,
      ty,
      sx: kx,
      sy,
      arc,
      t: 0,
      fly: this.cfg.fly * (0.9 + Math.random() * 0.2),
      state: 'wait',
      x: kx,
      y: sy,
      r: r * 0.45,
      vx: 0,
      vy: 0,
      awayT: AWAY_T,
      kx,
      kickT: this.cfg.wait,
      saved: false,
      done: false,
    })
  }

  /** 触碰检测：球 vs 该球种允许的部位（低球可用脚/膝，高球只能手且必须跳起） */
  private trySave(
    b: NonNullable<PoseFrame['bodies'][number]>,
    s: Shot,
    T: number,
    jumping: boolean,
  ): { part: 'hand' | 'head' | 'foot' | 'knee'; x: number; y: number } | null {
    const rr = s.r * BASE_CATCH
    const jointR = Math.max(24, T * 0.14)
    const pts: { part: 'hand' | 'head' | 'foot' | 'knee'; x: number; y: number }[] = []
    if (s.kind === 'high') {
      // 高吊球只能手且必须真跳起来（站着手碰无效）
      if (!jumping) return null
      pts.push({ part: 'hand', x: b.lHand.x * this.W, y: b.lHand.y * this.H })
      pts.push({ part: 'hand', x: b.rHand.x * this.W, y: b.rHand.y * this.H })
    } else if (s.kind === 'low') {
      pts.push({ part: 'foot', x: b.lFoot.x * this.W, y: b.lFoot.y * this.H })
      pts.push({ part: 'foot', x: b.rFoot.x * this.W, y: b.rFoot.y * this.H })
      pts.push({ part: 'knee', x: b.lKnee.x * this.W, y: b.lKnee.y * this.H })
      pts.push({ part: 'knee', x: b.rKnee.x * this.W, y: b.rKnee.y * this.H })
      pts.push({ part: 'hand', x: b.lHand.x * this.W, y: b.lHand.y * this.H })
      pts.push({ part: 'hand', x: b.rHand.x * this.W, y: b.rHand.y * this.H })
    } else {
      for (const [p, part] of [[b.lHand, 'hand'], [b.rHand, 'hand'], [b.head, 'head'], [b.lFoot, 'foot'], [b.rFoot, 'foot'], [b.lKnee, 'knee'], [b.rKnee, 'knee']] as const) {
        pts.push({ part: part as 'hand' | 'head' | 'foot' | 'knee', x: p.x * this.W, y: p.y * this.H })
      }
    }
    for (const p of pts) {
      if (Math.hypot(p.x - s.x, p.y - s.y) < rr + jointR) return p
    }
    return null
  }

  /** 扑救结算：球被击飞、+1、连击与金手套 */
  private onSave(pi: number, dk: Deck, s: Shot, hit: { part: string; x: number; y: number }, T: number, jumping: boolean) {
    s.state = 'away'
    s.awayT = AWAY_T
    const dirX = Math.sign(s.x - s.sx) || 1
    s.vx = dirX * 520 * (this.H / 720) + (Math.random() - 0.5) * 480
    s.vy = -420 * (this.H / 720)
    dk.saves++
    dk.streak++
    dk.maxStreak = Math.max(dk.maxStreak, dk.streak)
    // 动作命名
    const lateral = Math.abs(hit.x - this.players[pi].body!.shoulderC.x * this.W) / T
    let label = '扑出！'
    if (s.kind === 'high' && jumping) {
      label = '跳起扑出！'
      dk.jumps++
    } else if (hit.part === 'foot' || hit.part === 'knee') {
      label = '脚踢出去！'
    } else if (hit.part === 'head') {
      label = '头球解围！'
    }
    if (lateral > 1) {
      label = '飞身扑救！'
      dk.dives++
    }
    this.say(label, s.x, s.y - 50, '#9be29b', 38)
    this.particles.burst(s.x, s.y, '#ffd54a', 12, 380, 5)
    this.particles.burst(s.x, s.y, '#ffffff', 8, 320, 4)
    // 金手套：连扑 3 → 横幅 + tada；之后每 +5 → 连扑 ×N
    if (dk.streak === GOLD_LINE) {
      this.say('🧤 金手套！', this.W / 2, this.H * 0.24, '#ffd54a', 52)
      this.ctx.audio.play('win', 0.9)
      this.ctx.speak('金手套！连续扑出 3 个')
    } else if (dk.streak > GOLD_LINE && (dk.streak - GOLD_LINE) % 5 === 0) {
      this.say(`连扑 ×${dk.streak}！`, this.W / 2, this.H * 0.24, '#ffd54a', 46)
      this.particles.burst(this.W / 2, this.H * 0.3, '#ffe9a3', 14, 300, 5)
    }
    // 音效：pop 音调随连击上浮
    this.ctx.audio.play('pop', 0.9, 1.1 + Math.min(0.5, dk.streak * 0.06))
    this.ctx.audio.play('hit', 0.5, 1.2)
  }

  /** 失球：红闪 + 连击清 0 + 提示 */
  private onGoal(_pi: number, dk: Deck, s: Shot) {
    dk.goals++
    dk.streak = 0
    dk.flash = 1
    dk.fx = s.tx
    dk.fy = s.ty
    this.ctx.audio.play('hit', 0.8, 0.8)
    this.ctx.audio.fail()
    if (dk.sayCd <= 0) {
      dk.sayCd = 2.4
      if (s.kind === 'high') this.say('要跳起来！', s.tx, s.ty - 60, '#ffb0a0', 36)
      else if (s.kind === 'low') this.say('用脚挡！', s.tx, s.ty - 60, '#ffb0a0', 36)
      else this.say('进了…', s.tx, s.ty - 60, '#ffb0a0', 36)
    }
  }

  paint(c: CanvasRenderingContext2D) {
    const U = this.H / 720
    const duo = this.players.filter((p) => p.body).length > 1
    for (let pi = 0; pi < 2; pi++) {
      const dk = this.decks[pi]
      const b = this.players[pi].body
      if (duo && !b) continue
      const g = this.goal(pi)
      const T = b ? Math.max(60, Math.max(0.05, b.scale) * this.H) : this.H * 0.2

      // 球门框（立柱 + 横梁 + 网）
      c.save()
      c.strokeStyle = '#f4f7ff'
      c.lineWidth = 10 * U
      c.lineCap = 'round'
      c.beginPath()
      c.moveTo(g.left, this.H * 0.92)
      c.lineTo(g.left, g.top)
      c.lineTo(g.right, g.top)
      c.lineTo(g.right, this.H * 0.92)
      c.stroke()
      // 网（淡格线）
      c.globalAlpha = 0.16
      c.lineWidth = 1.5
      c.strokeStyle = '#fff'
      for (let x = g.left; x <= g.right; x += 46 * U) {
        c.beginPath()
        c.moveTo(x, g.top)
        c.lineTo(x, this.H * 0.92)
        c.stroke()
      }
      for (let y = g.top; y <= this.H * 0.92; y += 46 * U) {
        c.beginPath()
        c.moveTo(g.left, y)
        c.lineTo(g.right, y)
        c.stroke()
      }
      c.restore()

      // 失球红闪（按落点）
      if (dk.flash > 0) {
        c.save()
        c.globalAlpha = Math.min(0.5, dk.flash * 0.5)
        c.fillStyle = '#ff3b3b'
        circle(c, dk.fx, dk.fy, 90 * U * (1 + (1 - dk.flash) * 0.8), '#ff3b3b')
        c.restore()
        c.save()
        c.globalAlpha = dk.flash * 0.22
        c.fillStyle = '#ff3b3b'
        c.fillRect(0, 0, this.W, this.H)
        c.restore()
      }

      // 高吊球前 60% 飞行显示虚线落点预告圈
      for (const s of dk.shots) {
        if (s.state !== 'fly' || s.kind !== 'high') continue
        if (s.t / s.fly < 0.6) {
          c.save()
          c.globalAlpha = 0.5 + Math.sin(this.t * 8) * 0.2
          c.setLineDash([10, 8])
          c.strokeStyle = '#ffd54a'
          c.lineWidth = 4
          c.beginPath()
          c.arc(s.tx, s.ty, s.r * 1.5, 0, Math.PI * 2)
          c.stroke()
          c.restore()
        }
      }

      // 金手套：连扑 ≥3 双手画金色手套圈
      if (b && dk.streak >= GOLD_LINE) {
        for (const h of [b.lHand, b.rHand]) {
          c.save()
          glow(c, h.x * this.W, h.y * this.H, 46 * U, '#ffd54a', 0.5 + Math.sin(this.t * 9) * 0.12)
          c.strokeStyle = '#ffd54a'
          c.lineWidth = 4 * U
          c.beginPath()
          c.arc(h.x * this.W, h.y * this.H, 24 * U, 0, Math.PI * 2)
          c.stroke()
          c.restore()
        }
        if (dk.streak >= 2) {
          outlineTxt(c, `🧤 连扑 ${dk.streak}`, g.cx, g.top - 24 * U, 24, '#ffd54a')
        }
      }

      // 踢球者小人（球在脚下待踢）
      for (const s of dk.shots) {
        if (s.state === 'wait') {
          const kick = Math.max(0, s.kickT / this.cfg.wait)
          c.save()
          c.strokeStyle = pi === 0 ? '#b18cff' : '#5ad0d0'
          c.lineWidth = 6 * U
          c.lineCap = 'round'
          // 身体
          c.beginPath()
          c.moveTo(s.kx, s.sy - T * 0.9)
          c.lineTo(s.kx, s.sy - T * 0.15)
          c.stroke()
          // 支撑腿 + 踢腿（kick 1→0 摆出）
          c.beginPath()
          c.moveTo(s.kx, s.sy - T * 0.15)
          c.lineTo(s.kx - 12 * U, s.sy)
          c.stroke()
          c.beginPath()
          c.moveTo(s.kx, s.sy - T * 0.15)
          const swing = (1 - kick) * 0.9
          c.lineTo(s.kx + 16 * U * swing + 10 * U, s.sy - 18 * U * swing + 2)
          c.stroke()
          // 头
          circle(c, s.kx, s.sy - T * 1.02, 14 * U, '#ffd9b3')
          c.restore()
        }
        // 球（影子 + 球体）
        if (s.state === 'wait' || s.state === 'fly' || s.state === 'away') {
          // 影子贴地（wait / 飞行非 low）
          if (s.state === 'wait' || (s.state === 'fly' && s.kind !== 'low')) {
            c.save()
            c.globalAlpha = 0.18
            c.beginPath()
            c.ellipse(s.tx, this.H * 0.9, s.r * 1.1, s.r * 0.32, 0, 0, Math.PI * 2)
            c.fillStyle = '#000'
            c.fill()
            c.restore()
          }
          this.paintSoccerBall(c, s.x, s.y, s.r)
        }
      }
    }

    txt(c, '球飞过来用手、脚、头挡出去；边角球要扑，高球必须跳起来！', this.W / 2, this.H - 30, 20, 'rgba(255,255,255,.85)', 'center', 'bold')
  }

  private paintSoccerBall(c: CanvasRenderingContext2D, x: number, y: number, r: number) {
    c.save()
    c.translate(x, y)
    glow(c, 0, 0, r * 1.7, '#ffffff', 0.16)
    c.beginPath()
    c.arc(0, 0, r, 0, Math.PI * 2)
    c.fillStyle = '#fdfdfd'
    c.fill()
    c.strokeStyle = 'rgba(30,30,50,.55)'
    c.lineWidth = Math.max(1.5, r * 0.09)
    c.stroke()
    // 黑五边形斑（近似）
    c.fillStyle = '#2a2a38'
    c.beginPath()
    c.arc(0, 0, r * 0.32, 0, Math.PI * 2)
    c.fill()
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.3
      c.beginPath()
      c.arc(Math.cos(a) * r * 0.72, Math.sin(a) * r * 0.72, r * 0.2, 0, Math.PI * 2)
      c.fill()
    }
    c.restore()
  }
}

export default function create(ctx: GameContext) {
  return new Goalkeeper(ctx)
}
