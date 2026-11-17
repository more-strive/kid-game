import { BaseGame } from '@/core/base'
import type { Game, GameContext, PoseFrame } from '@/core/types'
import { circle, outlineTxt, txt } from '@/core/draw'

/**
 * 踢足球（对齐 dongdongpark 真实规则，见 _reverse/reports/soccer-kick.md）：
 * 球从屏幕两侧按抛物线飞到身前，用脚/膝盖/头（easy 额外允许手）触球，
 * 触球后 0.7s 补间缩小飞向球门；进球 +100，踢满 need 球给速度奖励并结束，150 s 硬上限。
 */

/** 对齐站点难度表：need 需进球 / every 发球间隔 / fly 来球飞行基准 / r 球半径(×unit) /
 *  par 速度奖励基准(s) / height 来球瞄准高度(×torso) / hands 允许手拍 / max 同屏在飞上限 */
const DIFF = [
  { need: 8, every: 3.2, fly: 2.6, r: 54, par: 70, height: 0.35, hands: true, max: 1 },
  { need: 12, every: 2.6, fly: 2.1, r: 48, par: 95, height: 0.6, hands: false, max: 1 },
  { need: 16, every: 2.0, fly: 1.7, r: 42, par: 120, height: 0.85, hands: false, max: 2 },
]
const GRAV = 300 // 重力 ×unit (px/s²)，对齐站点 d=300
const KICK_T = 0.7 // 踢出后飞向球门的补间时长，对齐站点 f=0.7
const HARD_STOP = 150 // 硬超时 s（catalog duration:0，站点代码内 150s 上限）
const GOAL_SCORE = 100 // 每球分值
/** 肢体判定半径 ×torso（站点 touch 模块 part.r 黑盒，等价代理） */
const PART_R: Record<string, number> = { foot: 0.1, knee: 0.1, head: 0.17, hand: 0.08 }

type BallState = 'in' | 'loose' | 'kicked' | 'net'

interface Ball {
  state: BallState
  owner: number // 发球目标玩家
  kicker: number // 触球玩家（得分归属）
  side: number // 来球方向 -1 左 +1 右
  x: number
  y: number
  vx: number
  vy: number
  r: number
  rot: number
  t: number // 状态计时
  arrive: number // in 状态的飞行总时长
  from: { x: number; y: number }
  to: { x: number; y: number }
  scale: number
}

interface RingFx {
  x: number
  y: number
  r: number
  life: number
}

class SoccerKick extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  unit = this.H / 720
  balls: Ball[] = []
  rings: RingFx[] = []
  spawnT = [1.2, 1.21]
  soloSeq = 0 // 单人左右交替计数器（站点 C++%2）
  goals = 0 // 总进球 h
  done = false
  bannerT = 0
  bannerText = ''
  bannerSub = ''
  bannerColor = '#fff'
  bannerDur = 1
  netV = 0 // 球网震动幅度（-1.8/s 衰减）
  netHitX = 0.5 // 命中点归一化横坐标
  score = 0

  tick(_f: PoseFrame, dt: number) {
    const u = this.unit
    this.bannerT = Math.max(0, this.bannerT - dt)
    this.netV = Math.max(0, this.netV - 1.8 * dt)
    for (let i = this.rings.length - 1; i >= 0; i--) {
      this.rings[i].life -= dt
      if (this.rings[i].life <= 0) this.rings.splice(i, 1)
    }

    // 发球节流：计时器归零 且 该玩家在飞球 < max 且 总球数 < need（对齐站点 D()/b[t]）
    const flying = (pi: number) => this.balls.filter((b) => b.owner === pi && (b.state === 'in' || b.state === 'loose')).length
    const totalOut = this.goals + this.balls.filter((b) => b.state !== 'net').length
    const duo = this.players.filter((p) => p.body).length >= 2
    for (let pi = 0; pi < 2; pi++) {
      this.spawnT[pi] -= dt
      // 计时器归零后持续检查：条件满足即发球并重设间隔；不满足则保持 0 等待
      if (this.spawnT[pi] <= 0 && flying(pi) < this.cfg.max && totalOut < this.cfg.need) {
        this.spawn(pi, duo)
        this.spawnT[pi] = this.cfg.every * (0.85 + Math.random() * 0.3) * (duo ? 1.25 : 1)
      }
    }

    // 球状态机
    for (const b of this.balls) {
      b.t += dt
      if (b.state === 'in' || b.state === 'loose') {
        b.vy += GRAV * u * dt
        b.x += b.vx * dt
        b.y += b.vy * dt
        b.rot += (b.vx / b.r) * dt
        if (b.state === 'in' && b.t > b.arrive) b.state = 'loose' // 错过目标点后继续按物理飞
        // 落地反弹（恢复系数 0.5，|vy|<60u 停止，触地摩擦 ×0.9）
        if (b.y > this.H - b.r) {
          b.y = this.H - b.r
          b.vy = Math.abs(b.vy) < 60 * u ? 0 : -Math.abs(b.vy) * 0.5
          b.vx *= 0.9
        }
      } else if (b.state === 'kicked') {
        // 0.7s outCubic 补间 + 抛物拱顶 + 缩小（对齐站点 kicked 弹道）
        const e = Math.min(1, b.t / KICK_T)
        const ease = 1 - (1 - e) * (1 - e) * (1 - e)
        b.x = b.from.x + (b.to.x - b.from.x) * ease
        b.y = b.from.y + (b.to.y - b.from.y) * ease + Math.sin(e * Math.PI) * 110 * u
        b.scale = 1 - 0.55 * e
        b.rot += 14 * dt
        if (e >= 1) {
          b.state = 'net'
          b.t = 0
          this.netV = 1
          const g = this.goal()
          this.netHitX = Math.min(1, Math.max(0, (b.x - (g.x - g.w / 2)) / g.w))
          this.onGoal(b)
        }
      } else if (b.state === 'net') {
        b.y += 30 * u * dt // 入网下沉
      }
    }
    // 清理：net 淡出完 / loose 飞出屏幕 ±3r
    this.balls = this.balls.filter((b) => {
      if (b.state === 'net') return b.t < 1
      if (b.state === 'loose') return b.x > -3 * b.r && b.x < this.W + 3 * b.r
      return true
    })

    // 触球判定：in/loose 的球，全身部位扫描（脚/膝/头，easy 加手），最近部位触发踢出
    if (!this.done) {
      for (const b of this.balls) {
        if (b.state !== 'in' && b.state !== 'loose') continue
        let best: { pi: number; kind: string; d: number } | null = null
        for (const pv of this.players) {
          const body = pv.body
          if (!body) continue
          const torso = Math.max(40, body.scale * this.H)
          const pts: [string, { x: number; y: number }][] = [
            ['foot', body.lFoot],
            ['foot', body.rFoot],
            ['knee', body.lKnee],
            ['knee', body.rKnee],
            ['head', body.head],
          ]
          if (this.cfg.hands) {
            pts.push(['hand', body.lHand], ['hand', body.rHand])
          }
          for (const [kind, p] of pts) {
            const px = p.x * this.W
            const py = p.y * this.H
            const d = Math.hypot(b.x - px, b.y - py)
            const reach = b.r * 0.9 + PART_R[kind] * torso
            if (d < reach && (!best || d < best.d)) best = { pi: pv.id, kind, d }
          }
        }
        if (best) this.kick(b, best.pi, best.kind)
      }
    }

    // 硬超时
    if (!this.done && this.t > HARD_STOP) {
      this.done = true
      this.ctx.finish()
    }

    this.ctx.setScore(this.score)
    // 站点 progress(kind:'balls', value:[h], max:need) 由宿主渲染，等价代理：进度写进 stage
    this.ctx.setStage(`⚽ 进球 ${this.goals}/${this.cfg.need}`)
    this.ctx.setExtra('进球', this.goals)
  }

  private goal() {
    const u = this.unit
    const w = Math.min(this.W * 0.4, 420 * u)
    return { x: this.W / 2, y: Math.max(160, 150 * u), w, h: w * 0.32 }
  }

  /** 发球 D(pi)：起点屏幕外，抛物线初速反解恰好命中目标点（对齐站点） */
  private spawn(pi: number, duo: boolean) {
    const u = this.unit
    const cfg = this.cfg
    const r = cfg.r * u
    const side = duo ? (pi === 0 ? -1 : 1) : this.soloSeq++ % 2 === 0 ? -1 : 1
    const b = this.players[pi].body
    const z = this.zone(pi)
    const torso = b ? Math.max(40, b.scale * this.H) : this.H * 0.2
    let tx: number
    let ty: number
    if (b) {
      tx = b.hipC.x * this.W + side * torso * 0.75
      ty = Math.min(this.H - r * 1.1, b.hipC.y * this.H + torso * cfg.height)
    } else {
      tx = (z.x0 + z.x1) / 2 + side * 80 * u
      ty = this.H * 0.75
    }
    const sx = side < 0 ? -r : this.W + r
    const sy = ty - 120 * u
    const fly = cfg.fly * (0.9 + Math.random() * 0.2)
    const g = GRAV * u
    this.balls.push({
      state: 'in',
      owner: pi,
      kicker: pi,
      side,
      x: sx,
      y: sy,
      vx: (tx - sx) / fly,
      vy: (ty - sy - 0.5 * g * fly * fly) / fly,
      r,
      rot: 0,
      t: 0,
      arrive: fly,
      from: { x: 0, y: 0 },
      to: { x: 0, y: 0 },
      scale: 1,
    })
  }

  /** 触球踢出 O(b)：头球/膝盖顶浮动字 + star 粒子 + 白圈 + 0.7s 补间飞向门内随机点 */
  private kick(b: Ball, pi: number, kind: string) {
    const u = this.unit
    b.state = 'kicked'
    b.kicker = pi
    b.t = 0
    b.from = { x: b.x, y: b.y }
    const g = this.goal()
    b.to = { x: g.x + (Math.random() - 0.5) * g.w * 0.7, y: g.y + g.h * (0.35 + Math.random() * 0.4) }
    this.particles.burst(b.x, b.y, '#ffd54a', 8, 260 * u, 14 * u)
    this.rings.push({ x: b.x, y: b.y, r: b.r * 1.2, life: 0.35 })
    this.ctx.audio.play('hit', 0.8, 1.1) // 站点 sfx('kick')，采样库无 kick → hit 等价代理
    if (kind === 'head') this.say('头球！', b.x, b.y - 20, '#4cc9f0', 40)
    else if (kind === 'knee') this.say('膝盖顶！', b.x, b.y - 20, '#a78bfa', 36)
  }

  /** 进球 k()：+100、音高循环、纸屑 34、进度；踢满给速度奖励并结束 */
  private onGoal(b: Ball) {
    const u = this.unit
    this.goals++
    this.score += GOAL_SCORE
    this.ctx.audio.play('score', 0.9, 1 + (this.goals % 6) * 0.12) // 站点 chime 音高 h%6 → score 变速等价
    const confetti = ['#ff3385', '#ffd54a', '#3ddc97', '#3390fc']
    for (const col of confetti) this.particles.burst(b.x, b.y, col, 9, 460 * u, 13 * u, 500)
    if (this.goals >= this.cfg.need) {
      // 通关：bonus = max(0, round(par − t)) × 10，横幅 + 语音 + 结束（对齐站点）
      const bonus = Math.max(0, Math.round(this.cfg.par - this.t)) * 10
      this.score += bonus
      this.say(`快! +${bonus}`, this.W / 2, this.H * 0.42, '#ffd54a', 44)
      this.showBanner('全部踢进啦！', `速度奖励 +${bonus}`, '#3ddc97', 1.8)
      this.ctx.speak('全部踢进啦！')
      this.particles.confetti(this.W, 80)
      this.done = true
      this.ctx.finish()
    } else {
      this.showBanner(this.goals === this.cfg.need - 1 ? '还差一个！' : '进球啦！', '', '#ff5c5c', 0.9)
    }
  }

  private showBanner(text: string, sub: string, color: string, sec: number) {
    this.bannerText = text
    this.bannerSub = sub
    this.bannerColor = color
    this.bannerT = sec
    this.bannerDur = sec
  }

  /** 玩家区域：单人 0.08~0.92，双人 P0 0.03~0.47 / P1 0.53~0.97 */
  private zone(pi: number) {
    const duo = this.players.filter((p) => p.body).length >= 2
    if (!duo) return { x0: this.W * 0.08, x1: this.W * 0.92 }
    return pi === 0 ? { x0: this.W * 0.03, x1: this.W * 0.47 } : { x0: this.W * 0.53, x1: this.W * 0.97 }
  }

  paint(c: CanvasRenderingContext2D) {
    const u = this.unit
    const g = this.goal()

    // 球门：门框 + 球网（受击震动，震动横向偏移随高度衰减）
    c.save()
    c.strokeStyle = '#ffffff'
    c.lineWidth = 6 * u
    c.strokeRect(g.x - g.w / 2, g.y, g.w, g.h)
    c.lineWidth = 1.5 * u
    c.strokeStyle = 'rgba(255,255,255,.55)'
    const step = g.w / 10
    for (let i = 1; i < 10; i++) {
      const sway = Math.sin(this.t * 30 + i) * this.netV * 6 * u * (i / 10)
      c.beginPath()
      c.moveTo(g.x - g.w / 2 + i * step + sway, g.y)
      c.lineTo(g.x - g.w / 2 + i * step + sway, g.y + g.h)
      c.stroke()
    }
    for (let j = 1; j * step < g.h; j++) {
      c.beginPath()
      c.moveTo(g.x - g.w / 2, g.y + j * step)
      c.lineTo(g.x + g.w / 2, g.y + j * step)
      c.stroke()
    }
    c.restore()
    if (this.netV > 0.05) {
      c.save()
      c.globalAlpha = this.netV * 0.5
      circle(c, g.x - g.w / 2 + this.netHitX * g.w, g.y + g.h * 0.6, 14 * u, '#fff')
      c.restore()
    }

    // 足球（in/loose 贴地阴影 + 自转；kicked 缩小；net 淡出）
    for (const b of this.balls) {
      const fade = b.state === 'net' ? Math.max(0, 1 - b.t) : 1
      c.save()
      c.globalAlpha = fade
      if (b.state !== 'net' && b.state !== 'kicked' && b.y > this.H - b.r * 3) {
        c.globalAlpha = fade * 0.35
        c.beginPath()
        c.ellipse(b.x, this.H - b.r * 0.18, b.r * 0.8, b.r * 0.18, 0, 0, Math.PI * 2)
        c.fillStyle = '#4a3b5c22'
        c.fill()
        c.globalAlpha = fade
      }
      c.translate(b.x, b.y)
      c.rotate(b.rot)
      const r = b.r * (b.state === 'kicked' || b.state === 'net' ? b.scale : 1)
      circle(c, 0, 0, r, '#ffffff')
      c.strokeStyle = 'rgba(40,44,70,.6)'
      c.lineWidth = 2 * u
      c.stroke()
      // 五边形花纹（简化足球）
      c.fillStyle = '#2b2e44'
      c.beginPath()
      for (let i = 0; i < 5; i++) {
        const a = (Math.PI * 2 * i) / 5 - Math.PI / 2
        const px = Math.cos(a) * r * 0.34
        const py = Math.sin(a) * r * 0.34
        i === 0 ? c.moveTo(px, py) : c.lineTo(px, py)
      }
      c.closePath()
      c.fill()
      for (let i = 0; i < 5; i++) {
        const a = (Math.PI * 2 * i) / 5 - Math.PI / 2
        c.beginPath()
        c.arc(Math.cos(a) * r * 0.75, Math.sin(a) * r * 0.75, r * 0.14, 0, Math.PI * 2)
        c.fill()
      }
      c.restore()
    }

    // 踢球白圈特效
    for (const rf of this.rings) {
      c.save()
      c.globalAlpha = Math.max(0, rf.life / 0.35)
      c.strokeStyle = '#fff'
      c.lineWidth = 4 * u
      c.beginPath()
      c.arc(rf.x, rf.y, rf.r, 0, Math.PI * 2)
      c.stroke()
      c.restore()
    }

    // 横幅
    if (this.bannerT > 0) {
      c.globalAlpha = Math.min(1, this.bannerT / 0.3, (this.bannerDur - this.bannerT) / 0.15 + 1)
      outlineTxt(c, this.bannerText, this.W / 2, this.H * 0.3, 56, this.bannerColor)
      if (this.bannerSub) outlineTxt(c, this.bannerSub, this.W / 2, this.H * 0.3 + 58, 30, '#fff')
      c.globalAlpha = 1
    }

    txt(c, '球飞到身前时，用脚踢 / 膝盖顶 / 头顶，把它送进球门', this.W / 2, this.H - 30, 20, 'rgba(255,255,255,.85)', 'center', 'bold')
  }
}

export default function create(ctx: GameContext) {
  return new SoccerKick(ctx)
}
