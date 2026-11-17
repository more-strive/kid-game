import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, glow, outlineTxt, star, txt } from '@/core/draw'

/**
 * 蹦床摘星（对齐 dongdongpark 真实规则，逆向报告 _reverse/reports/trampoline.md）：
 * 小人站在蹦床上，看它快落回蹦床（剩余落网时间 ≤ cue，白圈变小）时原地跳一下；
 * 跳得准 power 连升弹得更高，逐层穿过 1~8 层星星层摘星（第 s 层 +s 分）；
 * 空中下蹲蓄力 +0.5×gap；彩虹星 8s 起每 12s 刷一颗（层号×2 分，9s 内穿过可得）。
 *
 * 站点框架行为等价代理说明：
 * - 站点大屏/儿童双模式（e.big）：本框架无该标志，按儿童模式（!big）实现（同 swim-race 惯例）：
 *   pre+0.2 / post+0.16 / cue=max(原,0.3) / keep=max(原,0.6) / tick 强制 true。
 * - events.has('jump') → body.jumping 上升沿；髋基线抬升通道（>0.24×torso 且 0.75s 内下蹲过，
 *   冷却 0.45s）照抄报告。
 * - motion.squat（蓄力判定 >0.3）：膝关节平均弯曲角折算（站直≈172°、深蹲≈92°）。
 * - 报告 §8 的演示 AI 起跳阈值 g（0.26/0.22/0.18）只作用于站点 AI 槽位，本框架不实现。
 * - miss 清 picked 后星星可重复摘 = 可重复得分（报告 §2.2/§8 的站点行为）。
 * - 音效映射：boing→play('pop', 变调)、note→play('pop', 音阶变调)、sparkle→good、
 *   whoosh→jump、tick→tick、tada→win、boop→click(低增益)。
 * - 音乐 happy：BGM 由外壳统一管理。
 */

// ---- 难度表 m（报告 §1 全部字面量） ----
const RAW = [
  { gap: 0.75, layers: 8, pre: 0.45, post: 0.34, cue: 0.3, keep: 0.4, tick: true },
  { gap: 0.9, layers: 8, pre: 0.3, post: 0.24, cue: 0.25, keep: 0, tick: true },
  { gap: 1.05, layers: 8, pre: 0.22, post: 0.17, cue: 0.22, keep: 0, tick: false },
]
// 儿童宽容叠加（!big → 生效）：pre+0.2 / post+0.16 / cue=max(原,0.3) / keep=max(原,0.6) / tick=true
const CHILD = { pre: 0.2, post: 0.16, cue: 0.3, keep: 0.6 }

const GRAV = 12 // 重力（米/s²）；vy=√(24×power)
const BODY_H = 1 // 小人身高（米），层判定基准
const FIRST_LAYER = 1.9 // y：L(1)=1.9；L(s)=1.9+(s-1)×gap
const BASE_POWER = 1.25 // b：基础弹跳力
const LAYER_TOL = 0.12 // x：层判定容差（米）：power ≥ L(s)-1-0.12
const CHARGE_BONUS = 0.5 // S：蓄力 power 额外 +0.5×gap
const CHARGE_TH = 0.3 // 蓄力阈值：squat>0.3
const REST_P = 0.3 // C：结算后 power<0.3 回 rest 态
const VIEW0 = 4.3 // w：初始镜头视野（米）
const VIEW_TAU = 0.46 // 镜头逼近 τ
const RB_FIRST = 8 // T：彩虹星首次 8s
const RB_EVERY = 12 // E：之后每 12s
const RB_LIFE = 9 // D：彩虹星存活 9s
const RB_OFF = 0.95 // 彩虹星挂在层旁 ±0.95 米（纯视觉偏移）
const HIGH_POWER = 1.24 // 「高弹」阈值：结算 power≥1.24 → 下次 +gap 连升
const HIP_JUMP = 0.24 // 髋部抬升跳检测（×torso）
const HIP_CD = 0.45 // 起跳冷却
const SQUAT_WINDOW = 0.75 // 起跳前 0.75s 内下蹲过
const PRESS_LAG = 0.06 // buffered 落网后 0.06s 自动算跳准
const LATE_RESCUE = 0.45 // 上升段距起跳 <0.45s 且上次晚跳 → 补救
const NOTES = [60, 62, 64, 65, 67, 69, 71, 72, 74, 76, 77, 79] // O：各层摘星音高

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v))
}

function kneeAngle(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }) {
  const v1x = a.x - b.x
  const v1y = a.y - b.y
  const v2x = c.x - b.x
  const v2y = c.y - b.y
  const d = v1x * v2x + v1y * v2y
  const m = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) || 1
  return (Math.acos(Math.max(-1, Math.min(1, d / m))) * 180) / Math.PI
}

/** motion.squat 代理：膝关节平均弯曲角折算蹲深 0~1 */
function squatDepth(b: Body): number {
  const okL = (b.lm[25]?.visibility ?? 0) >= 0.3 && (b.lm[27]?.visibility ?? 0) >= 0.3
  const okR = (b.lm[26]?.visibility ?? 0) >= 0.3 && (b.lm[28]?.visibility ?? 0) >= 0.3
  const angs: number[] = []
  if (okL) angs.push(kneeAngle(b.lHip, b.lKnee, b.lFoot))
  if (okR) angs.push(kneeAngle(b.rHip, b.rKnee, b.rFoot))
  if (!angs.length) return 0
  const avg = angs.reduce((n, v) => n + v, 0) / angs.length
  return clamp01((172 - avg) / 80)
}

function torsoOf(b: Body): number {
  const shY = (b.lm[11].y + b.lm[12].y) / 2
  const hipY = (b.lm[23].y + b.lm[24].y) / 2
  return Math.max(0.06, Math.abs(hipY - shY))
}

interface RBStar {
  layer: number
  side: number
  bornAt: number
}

interface TS {
  phase: 'rest' | 'air' | 'press'
  y: number // 高度（米，0=网面）
  vy: number // 速度（米/s，向上为正）
  power: number
  takeoffAt: number
  pressAt: number
  hipBase: number
  prevJump: boolean
  lastInputAt: number
  lastSquatAt: number
  charged: boolean
  buffered: boolean
  early: boolean
  cueTicked: boolean
  lastLate: boolean
  chain: number
  bestChain: number
  good: number
  tries: number
  missRun: number
  lastCoachAt: number
  picked: boolean[]
  bestLayer: number
  saw8: boolean
  flip: boolean
  flipT: number
  rb: RBStar | null
  nextRbAt: number
  view: number
}

function newTS(): TS {
  return {
    phase: 'rest',
    y: 0,
    vy: 0,
    power: BASE_POWER,
    takeoffAt: -9,
    pressAt: -9,
    hipBase: NaN,
    prevJump: false,
    lastInputAt: -9,
    lastSquatAt: -9,
    charged: false,
    buffered: false,
    early: false,
    cueTicked: false,
    lastLate: false,
    chain: 0,
    bestChain: 0,
    good: 0,
    tries: 0,
    missRun: 0,
    lastCoachAt: -9,
    picked: new Array(8).fill(false),
    bestLayer: 0,
    saw8: false,
    flip: false,
    flipT: 0,
    rb: null,
    nextRbAt: RB_FIRST,
    view: VIEW0,
  }
}

class Trampoline extends BaseGame implements Game {
  cfg = {
    gap: (RAW[this.ctx.difficulty] ?? RAW[1]).gap,
    layers: 8,
    pre: (RAW[this.ctx.difficulty] ?? RAW[1]).pre + CHILD.pre,
    post: (RAW[this.ctx.difficulty] ?? RAW[1]).post + CHILD.post,
    cue: Math.max((RAW[this.ctx.difficulty] ?? RAW[1]).cue, CHILD.cue),
    keep: Math.max((RAW[this.ctx.difficulty] ?? RAW[1]).keep, CHILD.keep),
    tick: true,
  }
  ps: TS[] = [newTS(), newTS()]
  bannerText = ''
  bannerT = 0
  popT = 0
  popAt = -9
  started = false
  private realClock = 0

  constructor(ctx: GameContext) {
    super(ctx)
    this.ctx.setStage('小人快落回蹦床、白圈变小时跳！')
  }

  update(f: PoseFrame, dt: number) {
    this.realClock += dt
    this.bannerT = Math.max(0, this.bannerT - dt)
    this.popT = Math.max(0, this.popT - dt)
    super.update(f, dt)
  }

  private banner(text: string, sec: number) {
    this.bannerText = text
    this.bannerT = sec
  }

  private layerY(s: number) {
    return FIRST_LAYER + (s - 1) * this.cfg.gap
  }

  tick(f: PoseFrame, dt: number) {
    if (!this.started) {
      this.started = true
      this.ctx.speak('站在蹦床上跳一跳！')
    }
    for (let pi = 0; pi < 2; pi++) {
      const b = f.bodies[pi] ?? null
      const st = this.ps[pi]
      if (!b) continue // 缺席玩家物理冻结
      this.tickPlayer(pi, st, b, dt)
    }
    const best = this.ps.reduce((m, s) => Math.max(m, s.bestLayer), 0)
    this.ctx.setExtra('最高到(层)', best)
    this.ctx.setExtra('跳准(次)', this.ps.reduce((n, s) => n + s.good, 0))
    this.ctx.setExtra('最长连跳', this.ps.reduce((m, s) => Math.max(m, s.bestChain), 0))
    const tries = this.ps.reduce((n, s) => n + s.tries, 0)
    const good = this.ps.reduce((n, s) => n + s.good, 0)
    this.ctx.setExtra('跳准率(%)', tries ? Math.round((100 * good) / tries) : 100)
    this.ctx.setCombo(this.ps.reduce((m, s) => Math.max(m, s.chain), 0))
  }

  /** 起跳输入：框架 jumping 上升沿，或髋基线抬升 >0.24×torso 且 0.75s 内下蹲过（冷却 0.45s） */
  private input(st: TS, b: Body, dt: number): boolean {
    const jEdge = b.jumping && !st.prevJump
    st.prevJump = b.jumping
    if (!Number.isFinite(st.hipBase)) st.hipBase = b.hipC.y
    const torso = torsoOf(b)
    if (st.phase !== 'air') st.hipBase += (b.hipC.y - st.hipBase) * Math.min(1, dt * 1.5)
    const rise = (st.hipBase - b.hipC.y) / torso
    if (squatDepth(b) > CHARGE_TH) st.lastSquatAt = this.t
    const hipJump = rise > HIP_JUMP && this.t - st.lastSquatAt <= SQUAT_WINDOW && this.t - st.lastInputAt > HIP_CD
    if (jEdge || hipJump) {
      st.lastInputAt = this.t
      return true
    }
    return false
  }

  private tickPlayer(pi: number, st: TS, b: Body, dt: number) {
    const inp = this.input(st, b, dt)
    const z = this.zone(pi)

    if (st.phase === 'rest') {
      if (inp) this.launch(st)
    } else if (st.phase === 'air') {
      // 物理（米）：vy 向上为正，重力 12
      st.y += st.vy * dt
      st.vy -= GRAV * dt
      // 蓄力：air 中 squat>0.3 置位，一次有效
      if (!st.charged && squatDepth(b) > CHARGE_TH) st.charged = true
      // 输入时机
      if (inp) {
        if (st.vy < 0) {
          // 剩余落网时间 W = (vy+√(vy²+24h))/12
          const w = (st.vy + Math.sqrt(st.vy * st.vy + 24 * Math.max(0, st.y))) / GRAV
          if (w <= this.cfg.pre) st.buffered = true
          else {
            st.early = true
            this.say('早了一点', z.cx, this.bedY() - 120, '#c3a6ff', 30)
            this.ctx.audio.play('click', 0.7, 0.9) // boop
          }
        } else if (this.t - st.takeoffAt < LATE_RESCUE && st.lastLate) {
          // 上升段补跳：「晚了一点」并把 power 拉回 ≥1.25
          this.say('晚了一点', z.cx, this.bedY() - 120, '#7dd3fc', 30)
          st.power = Math.max(st.power, BASE_POWER)
        }
      }
      // 摘星：y+1 ≥ L(s)-0.12 的未摘层立刻摘取
      for (let s = 1; s <= this.cfg.layers; s++) {
        if (!st.picked[s - 1] && st.y + BODY_H >= this.layerY(s) - LAYER_TOL) {
          st.picked[s - 1] = true
          this.ctx.addScore(s)
          const midi = NOTES[Math.min(NOTES.length - 1, s - 1)]
          this.ctx.audio.play('pop', 0.75, Math.pow(2, (midi - 60) / 12))
          const sy = this.bedY() - this.layerY(s) * this.kpx(st)
          this.particles.burst(z.cx, sy, '#ffd54a', 5 + s, 300, 5)
          this.say(`+${s}`, z.cx + 60, sy, '#fff36b', 30)
          st.bestLayer = Math.max(st.bestLayer, s)
          if (s >= 4) {
            this.popAt = this.realClock
            this.popT = s / 3 // highlight(s/3)
          }
          if (s === this.cfg.layers && !st.saw8) {
            st.saw8 = true
            st.flip = true
            st.flipT = 0
            this.banner('弹到最高层啦！', 1.6)
            this.ctx.audio.win() // tada
            this.particles.confetti(this.W, 30)
            this.popAt = this.realClock
            this.popT = 4 // highlight(4)
          }
        }
      }
      // 彩虹星
      this.tickRainbow(st, z)
      // 镜头
      st.view += (Math.max(VIEW0, st.y + 3.2) - st.view) * (1 - Math.exp(-dt / VIEW_TAU))
      // 落网提示（cue 圈 + 滴答）
      if (st.vy < 0) {
        const w = (st.vy + Math.sqrt(st.vy * st.vy + 24 * Math.max(0, st.y))) / GRAV
        if (w <= this.cfg.cue && !st.cueTicked) {
          st.cueTicked = true
          if (this.cfg.tick) this.ctx.audio.tick()
        }
      }
      // 落网
      if (st.y <= 0 && st.vy < 0) {
        st.y = 0
        st.vy = 0
        st.phase = 'press'
        st.pressAt = this.t
      }
      if (st.flip) st.flipT += dt
    } else {
      // press：t-pressAt ≤ post 内跳 → good；buffered 且 ≥0.06s → good；超时 → early/none
      if (inp && this.t - st.pressAt <= this.cfg.post) this.settle(pi, st, true)
      else if (st.buffered && this.t - st.pressAt >= PRESS_LAG) this.settle(pi, st, true)
      else if (this.t - st.pressAt > this.cfg.post) this.settle(pi, st, false)
    }
  }

  private tickRainbow(st: TS, z: { cx: number }) {
    if (this.t >= st.nextRbAt && !st.rb) {
      st.rb = { layer: 3 + Math.floor(Math.random() * 6), side: Math.random() < 0.5 ? -1 : 1, bornAt: this.t }
      st.nextRbAt = this.t + RB_EVERY
    }
    if (st.rb && this.t - st.rb.bornAt > RB_LIFE) st.rb = null
    if (st.rb && st.phase === 'air' && st.y + BODY_H >= this.layerY(st.rb.layer)) {
      const pts = st.rb.layer * 2
      this.ctx.addScore(pts)
      this.ctx.audio.good() // sparkle
      this.say(`彩虹星 +${pts}`, z.cx + st.rb.side * 90, this.bedY() - this.layerY(st.rb.layer) * this.kpx(st), '#7dd3fc', 30)
      this.particles.burst(z.cx + st.rb.side * 90, this.bedY() - this.layerY(st.rb.layer) * this.kpx(st), '#7dd3fc', 14, 320, 5)
      st.rb = null
    }
  }

  private launch(st: TS) {
    st.phase = 'air'
    st.y = 0
    st.vy = Math.sqrt(24 * st.power)
    st.takeoffAt = this.t
    st.charged = false
    st.buffered = false
    st.early = false
    st.cueTicked = false
    st.tries++
    // boing 音高随 chain 升（1+min(0.6, chain×0.06)）
    this.ctx.audio.play('pop', 0.9, 1 + Math.min(0.6, st.chain * 0.06))
  }

  /** 结算 X（报告 §2.1） */
  private settle(pi: number, st: TS, good: boolean) {
    const z = this.zone(pi)
    if (good) {
      st.chain++
      st.good++
      st.bestChain = Math.max(st.bestChain, st.chain)
      st.power = (st.power >= HIGH_POWER ? st.power + this.cfg.gap : BASE_POWER) + (st.charged ? CHARGE_BONUS * this.cfg.gap : 0)
      st.power = Math.min(st.power, this.layerY(this.cfg.layers))
      if (st.charged) {
        this.say('蓄力跳！', z.cx, this.bedY() - 150, '#ffd54a', 34)
        this.ctx.audio.jump() // whoosh
        this.particles.burst(z.cx, this.bedY() - 60, '#ffe97a', 12, 340, 5)
      }
      if (st.chain === 3) this.say('跳得准！', z.cx, this.bedY() - 190, '#3ddc97', 34)
      if (st.chain === 6) this.banner('太棒了！', 1.2)
      st.lastLate = false
    } else if (st.early) {
      // 跳早：keep 保底 power = 1.25 + max(0, power-1.25)×keep；断连击 + 清空已摘星
      st.chain = 0
      st.missRun++
      st.picked = new Array(8).fill(false)
      st.power = BASE_POWER + Math.max(0, st.power - BASE_POWER) * this.cfg.keep
      st.lastLate = true
    } else {
      // 漏跳：原 power≥1.24（高弹）→ 断连击 + missRun + 清空已摘星；弱弹漏跳只断 chain
      if (st.power >= HIGH_POWER) {
        st.chain = 0
        st.missRun++
        st.picked = new Array(8).fill(false)
      } else {
        st.chain = 0
      }
      st.lastLate = true
    }
    st.early = false
    st.buffered = false
    st.charged = false
    // missRun≥3 语音教学（15s 节流，儿童模式可重复）
    if (st.missRun >= 3 && this.t - st.lastCoachAt > 15) {
      st.lastCoachAt = this.t
      this.ctx.speak('小人快落到蹦床上，就跳！')
    }
    void pi
    // 结算后立即再弹（power<0.3 回 rest，实际 keep≥0.6 不会发生）
    if (st.power < REST_P) {
      st.phase = 'rest'
      st.vy = 0
      st.y = 0
    } else {
      this.launch(st)
    }
  }

  private zone(pi: number) {
    const duo = this.players.filter((p) => p.body).length > 1
    if (!duo) return { x0: this.W * 0.08, x1: this.W * 0.92, cx: this.W / 2 }
    return pi === 0
      ? { x0: this.W * 0.03, x1: this.W * 0.47, cx: this.W * 0.25 }
      : { x0: this.W * 0.53, x1: this.W * 0.97, cx: this.W * 0.75 }
  }

  private bedY() {
    return this.H * 0.84
  }

  /** 镜头比例：视野 view 米 → 62% 画布高 */
  private kpx(st: TS) {
    return (this.H * 0.62) / st.view
  }

  // ---------- 绘制 ----------

  paint(c: CanvasRenderingContext2D) {
    // 全局最低视角决定天空（越飞越高天变紫、出现雪花点）
    const view = Math.min(...this.ps.map((s) => s.view))
    const altK = clamp01((view - VIEW0) / 7)
    const top = lerpColor('#8ec9ff', '#7b5cd6', altK)
    const bottom = lerpColor('#dff1ff', '#b9a0ec', altK)
    const g = c.createLinearGradient(0, 0, 0, this.H)
    g.addColorStop(0, top)
    g.addColorStop(1, bottom)
    c.fillStyle = g
    c.fillRect(0, 0, this.W, this.H)
    // 雪花点（高空）
    if (altK > 0.3) {
      c.globalAlpha = (altK - 0.3) * 1.2
      c.fillStyle = '#ffffff'
      for (let i = 0; i < 40; i++) {
        const sx = ((i * 173) % this.W + Math.sin(this.realClock * 0.7 + i) * 30 + this.W) % this.W
        const sy = (i * 229 + this.realClock * 26) % (this.H * 0.8)
        c.fillRect(sx, sy, 3, 3)
      }
      c.globalAlpha = 1
    }

    for (let pi = 0; pi < 2; pi++) {
      const b = this.players[pi].body
      const st = this.ps[pi]
      if (!b) continue
      const z = this.zone(pi)
      const k = this.kpx(st)
      const bedY = this.bedY()

      // 世界装饰：云 / 风筝 / 热气球按高度分层（固定世界高度）
      this.paintDecor(c, st, z, k)

      // 虚线层线（随高度淡出）+ 星星（picked 变暗）
      for (let s = 1; s <= this.cfg.layers; s++) {
        const sy = bedY - this.layerY(s) * k
        if (sy < -30) continue
        c.save()
        c.globalAlpha = Math.max(0.12, 0.5 - s * 0.045)
        c.strokeStyle = '#ffffff'
        c.lineWidth = 2
        c.setLineDash([10, 12])
        c.beginPath()
        c.moveTo(z.x0 + 20, sy)
        c.lineTo(z.x1 - 20, sy)
        c.stroke()
        c.restore()
        // 星星（第 s 层 +s 分）
        const picked = st.picked[s - 1]
        c.save()
        c.globalAlpha = picked ? 0.28 : 1
        if (!picked) glow(c, z.cx, sy, 34, '#ffd54a', 0.25)
        star(c, z.cx, sy, picked ? 14 : 20, picked ? '#9a8a55' : '#ffd54a')
        c.restore()
        txt(c, `+${s}`, z.cx + 38, sy, 17, picked ? 'rgba(255,255,255,.35)' : '#fff36b', 'left', 'bold')
      }

      // 彩虹星
      if (st.rb) {
        const sy = bedY - this.layerY(st.rb.layer) * k
        const sx = z.cx + st.rb.side * RB_OFF * k
        const age = (this.t - st.rb.bornAt) / RB_LIFE
        c.save()
        c.globalAlpha = age > 0.7 ? Math.max(0, (1 - age) / 0.3) : 1
        glow(c, sx, sy, 44, '#7dd3fc', 0.35)
        star(c, sx, sy, 22, `hsl(${(this.realClock * 120) % 360} 90% 60%)`)
        c.restore()
        // 提示线
        c.save()
        c.globalAlpha = 0.4
        c.strokeStyle = '#7dd3fc'
        c.setLineDash([4, 6])
        c.beginPath()
        c.moveTo(z.cx, sy)
        c.lineTo(sx, sy)
        c.stroke()
        c.restore()
      }

      // 蹦床 + 草地 + 栅栏
      this.paintBed(c, z, unit(this.H))

      // 玩家小人（翻转特技 / 蓄力姿势）
      this.paintJumper(c, st, z, k)

      // 落网前白圈收缩提示 + 「跳！」
      if (st.phase === 'air' && st.vy < 0) {
        const w = (st.vy + Math.sqrt(st.vy * st.vy + 24 * Math.max(0, st.y))) / GRAV
        if (w <= this.cfg.cue + 0.7) {
          const p = clamp01(1 - w / (this.cfg.cue + 0.7))
          const rx = (60 + 90 * (1 - p)) * (this.H / 720)
          c.beginPath()
          c.ellipse(z.cx, bedY, rx, rx * 0.32, 0, 0, Math.PI * 2)
          c.strokeStyle = `rgba(255,255,255,${0.35 + 0.55 * p})`
          c.lineWidth = 4 + 3 * p
          c.stroke()
          if (w <= this.cfg.cue) {
            outlineTxt(c, '跳！', z.cx, bedY + 46, 40, '#ffffff')
          }
        }
      }

      // 每区独立「第 N 层」显示
      outlineTxt(c, `第 ${st.bestLayer} 层`, z.cx, this.H * 0.12, 34, '#ffffff')
      txt(c, `连跳 ${st.chain} · 弹力 ${st.power.toFixed(1)}`, z.cx, this.H * 0.12 + 34, 18, 'rgba(255,255,255,.8)', 'center', 'bold')
    }

    if (this.bannerT > 0) {
      c.globalAlpha = Math.min(1, this.bannerT / 0.3)
      outlineTxt(c, this.bannerText, this.W / 2, this.H * 0.24, 48, '#ffd54a')
      c.globalAlpha = 1
    }
    txt(
      c,
      '小人快落回蹦床、白圈变小的时候跳，弹得更高；空中下蹲蓄力加分；越高的星星越值钱',
      this.W / 2,
      this.H - 28,
      20,
      'rgba(255,255,255,.85)',
      'center',
      'bold',
    )
  }

  /** 世界装饰：云（每 4m）/ 风筝（3m）/ 热气球（9m），按镜头高度进出画面 */
  private paintDecor(c: CanvasRenderingContext2D, st: TS, z: { x0: number; x1: number; cx: number }, k: number) {
    const bedY = this.bedY()
    const w = z.x1 - z.x0
    // 栅栏 + 草丘（世界 0m 附近）
    c.fillStyle = 'rgba(110,180,90,.5)'
    c.beginPath()
    c.ellipse(z.cx - w * 0.3, bedY + 6, w * 0.28, 26, 0, 0, Math.PI * 2)
    c.ellipse(z.cx + w * 0.34, bedY + 8, w * 0.22, 20, 0, 0, Math.PI * 2)
    c.fill()
    // 云
    for (let m = 4; m <= 30; m += 4) {
      const sy = bedY - m * k
      if (sy < -40 || sy > this.H + 40) continue
      const sx = z.x0 + w * 0.18 + ((m * 37) % Math.max(1, w * 0.6))
      c.fillStyle = 'rgba(255,255,255,.75)'
      c.beginPath()
      c.ellipse(sx, sy, 44, 16, 0, 0, Math.PI * 2)
      c.ellipse(sx + 30, sy + 6, 30, 12, 0, 0, Math.PI * 2)
      c.fill()
    }
    // 风筝（3m）
    const ky = bedY - 3 * k
    if (ky > -30 && ky < this.H + 30) {
      c.fillStyle = '#ff8a3d'
      c.beginPath()
      c.moveTo(z.x1 - 60, ky - 22)
      c.lineTo(z.x1 - 78, ky)
      c.lineTo(z.x1 - 60, ky + 22)
      c.lineTo(z.x1 - 42, ky)
      c.closePath()
      c.fill()
    }
    // 热气球（9m）
    const by = bedY - 9 * k
    if (by > -40 && by < this.H + 40) {
      c.fillStyle = '#ff5c8a'
      c.beginPath()
      c.ellipse(z.x0 + 70, by, 26, 32, 0, 0, Math.PI * 2)
      c.fill()
      c.fillStyle = '#8a5a2b'
      c.fillRect(z.x0 + 64, by + 36, 12, 10)
    }
    void st
  }

  private paintBed(c: CanvasRenderingContext2D, z: { x0: number; x1: number; cx: number }, unit: number) {
    const bedY = this.bedY()
    // 草地
    c.fillStyle = '#4c9147'
    c.fillRect(z.x0, bedY, z.x1 - z.x0, this.H - bedY)
    // 蹦床：腿 + 弹力面
    const half = 120 * unit
    c.strokeStyle = '#5a4ae8'
    c.lineWidth = 8 * unit
    c.beginPath()
    c.moveTo(z.cx - half - 26 * unit, bedY + 18 * unit)
    c.lineTo(z.cx - half, bedY)
    c.lineTo(z.cx + half, bedY)
    c.lineTo(z.cx + half + 26 * unit, bedY + 18 * unit)
    c.stroke()
    c.strokeStyle = '#b39dff'
    c.lineWidth = 10 * unit
    c.beginPath()
    c.moveTo(z.cx - half, bedY)
    c.lineTo(z.cx + half, bedY)
    c.stroke()
    // 弹簧
    c.strokeStyle = 'rgba(255,255,255,.6)'
    c.lineWidth = 2.5 * unit
    for (const s of [-1, 1]) {
      c.beginPath()
      c.moveTo(z.cx + s * half * 0.6, bedY)
      c.lineTo(z.cx + s * half * 0.7, bedY + 18 * unit)
      c.stroke()
    }
  }

  private paintJumper(c: CanvasRenderingContext2D, st: TS, z: { cx: number }, k: number) {
    const bedY = this.bedY()
    const s = BODY_H * k // 小人身高像素
    const feetY = bedY - st.y * k
    const press = st.phase === 'press' || st.phase === 'rest'
    c.save()
    c.translate(z.cx, feetY)
    if (st.flip) c.rotate(Math.min(1, st.flipT / 0.7) * Math.PI * 2)
    if (st.charged) glow(c, 0, -s * 0.5, s * 0.9, '#ffd54a', 0.4)
    // 腿（空中伸直、落网微屈）
    c.strokeStyle = '#2b3a67'
    c.lineWidth = Math.max(3, s * 0.07)
    c.lineCap = 'round'
    c.beginPath()
    c.moveTo(0, -s * 0.45)
    c.lineTo(-s * 0.12, 0)
    c.moveTo(0, -s * 0.45)
    c.lineTo(s * 0.12, 0)
    c.stroke()
    // 躯干
    c.strokeStyle = '#9b5de5'
    c.lineWidth = Math.max(4, s * 0.1)
    c.beginPath()
    c.moveTo(0, -s * 0.45)
    c.lineTo(0, -s * 0.85)
    c.stroke()
    // 手臂：空中举起、落网/待机放下
    c.lineWidth = Math.max(3, s * 0.06)
    const ay = press ? -s * 0.5 : -s * 1.02
    c.beginPath()
    c.moveTo(0, -s * 0.8)
    c.lineTo(-s * 0.2, ay)
    c.moveTo(0, -s * 0.8)
    c.lineTo(s * 0.2, ay)
    c.stroke()
    circle(c, 0, -s * 0.98, s * 0.14, '#ffd9b3')
    c.restore()
  }
}

function unit(h: number) {
  return h / 720
}

function lerpColor(a: string, b: string, t: number) {
  const pa = parseInt(a.slice(1), 16)
  const pb = parseInt(b.slice(1), 16)
  const r = Math.round(((pa >> 16) & 255) * (1 - t) + ((pb >> 16) & 255) * t)
  const g = Math.round(((pa >> 8) & 255) * (1 - t) + ((pb >> 8) & 255) * t)
  const bl = Math.round((pa & 255) * (1 - t) + (pb & 255) * t)
  return `rgb(${r},${g},${bl})`
}

export default function create(ctx: GameContext) {
  return new Trampoline(ctx)
}
