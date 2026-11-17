import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { glow, outlineTxt, rr, star, txt } from '@/core/draw'

/**
 * 镜子舞对决（对齐逆向报告 mirror-duel.md）：
 * 轮流领舞，对方像照镜子一样跟做；每 0.25s 判一次「跟上」，跟舞者攒 credit 满 1 计 1 分
 * （多人 2 分/秒、单人跟教练 1 分/秒），领舞者让对手脱靶且自己在动 → 1 分/秒「难倒」分。
 * 核心：相似度先减「站立基线」再归一化，防站桩得分。
 */

/** 难度表（报告 §1）：thr 跟上阈值 / lag 反应宽限(s) / move 单人教练每姿势时长 / blend 过渡 / turn 每轮秒数 / ghost 幽灵提示透明度 / lib 姿势库 */
const DIFF = [
  { thr: 0.45, lag: 1.2, move: 2.8, blend: 0.6, turn: 12, ghost: 0.4, lib: ['up', 't', 'star', 'leftUp', 'rightUp', 'muscle', 'squat'] },
  { thr: 0.6, lag: 0.8, move: 2.2, blend: 0.5, turn: 10, ghost: 0.3, lib: ['up', 't', 'star', 'leftUp', 'rightUp', 'muscle', 'squat', 'y', 'wave', 'kneeL'] },
  { thr: 0.72, lag: 0.6, move: 1.6, blend: 0.4, turn: 8, ghost: 0, lib: ['up', 't', 'star', 'leftUp', 'rightUp', 'muscle', 'squat', 'y', 'wave', 'kneeL'] },
]

/** 规则常量（报告 L171-181）：判定节拍 0.25s / 难倒系数 0.5 / 多人跟舞倍率 2 / 教练开始 1.2s / 换轮免判 1.2s / 在动能量阈值 0.3 / 换姿势视作在动 1.5s / 参考更新阈值 0.035 / 里程碑 5s */
const TICK = 0.25
const STUMP_K = 0.5
const MULTI_RATE = 2
const COACH_START = 1.2
const ROUND_GRACE = 1.2
const MOVE_ENERGY = 0.3
const MOVE_REF_T = 1.5
const REF_THR = 0.035
const MILESTONE = 5

/** 手位特征（相对肩心，scale 单位，dy 正=肩上方） */
interface Spec {
  l: { x: number; y: number }
  r: { x: number; y: number }
}

const STAND: Spec = { l: { x: -0.18, y: -0.5 }, r: { x: 0.18, y: -0.5 } }

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n))
}

/** 玩家实时手位特征 */
function specOf(b: Body): Spec {
  const s = Math.max(0.05, b.scale)
  return {
    l: { x: (b.lHand.x - b.shoulderC.x) / s, y: (b.shoulderC.y - b.lHand.y) / s },
    r: { x: (b.rHand.x - b.shoulderC.x) / s, y: (b.shoulderC.y - b.rHand.y) / s },
  }
}

function lerpSpec(a: Spec, b: Spec, k: number): Spec {
  return {
    l: { x: a.l.x + (b.l.x - a.l.x) * k, y: a.l.y + (b.l.y - a.l.y) * k },
    r: { x: a.r.x + (b.r.x - a.r.x) * k, y: a.r.y + (b.r.y - a.r.y) * k },
  }
}

/** 手位特征-目标相似度 0~1（黑盒 l(feat,spec) 的本地实现） */
function handScore(p: Spec, t: Spec) {
  return (
    (clamp01(1 - Math.hypot(p.l.x - t.l.x, p.l.y - t.l.y) / 0.55) +
      clamp01(1 - Math.hypot(p.r.x - t.r.x, p.r.y - t.r.y) / 0.55)) /
    2
  )
}

/** 镜像准确度 x(feat, target)（报告 L34-43）：减站立基线后归一化；目标太接近站立（1-base<0.1）返回 null 不计 */
function mirrorAcc(feat: Spec, target: Spec): number | null {
  const base = handScore(STAND, target)
  if (1 - base < 0.1) return null
  return clamp01((handScore(feat, target) - base) / (1 - base))
}

/** 领舞者历史样本（2.5s 环形缓冲，报告 oe()） */
interface Hist {
  t: number
  spec: Spec
}

interface CoachSeg {
  pose: Spec
  start: number
  end: number
}

/** 镜子舞对决 */
class MirrorDuel extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  unit = this.H / 720
  D = this.ctx.meta.duration || 80
  /** 轮数 R = max(2, 2×round(T/(2×turn)))，轮长 = D/R（报告 §2） */
  rounds = Math.max(2, 2 * Math.round(this.D / (2 * this.cfg.turn)))
  roundLen = this.D / this.rounds
  score = 0
  solo = true
  /** 每玩家判定统计 */
  hits = [0, 0]
  judged = [0, 0]
  streak = [0, 0]
  bestStreak = [0, 0]
  credit = [0, 0]
  stumpCredit = [0, 0]
  stumps = [0, 0]
  milestone = [0, 0]
  missFor = [0, 0]
  private lastMissFor = [0, 0]
  /** 领舞特征历史 */
  hist: Hist[][] = [[], []]
  /** 参考姿势（变化 > 0.035 更新，1.5s 内视作"在动"） */
  ref: (Spec | null)[] = [null, null]
  refAt = [-10, -10]
  /** 运动能量代理（motion.energy：帧间关节均速 / 躯干长） */
  energy = [0, 0]
  private prevLm: ({ x: number; y: number } | null)[][] = [[], []]
  /** 当前轮 */
  round = -1
  bannerT = 0
  bannerBig = '照镜子！'
  bannerSub = '教练做什么，你就像镜子一样做什么'
  bannerColor = '#ffd54a'
  /** 跟舞计量（镜框亮度）：目标 min(1, 0.35 + streak/5)，升 5/s 降 2/s */
  meter = 0.35
  /** 单人教练脚本（预生成，rng 种子语义本地用 Math.random 近似） */
  coachScript: CoachSeg[] = []
  private lastTick = 0

  constructor(ctx: GameContext) {
    super(ctx)
    this.buildCoach()
    ctx.setStage('照镜子！')
    this.bannerT = 2
  }

  /** 单人教练脚本：从 1.2s 起，每姿势时长 move×(0.85+0.3×rng)×(1−0.2×进度)，不与上一姿势重复且相似 <0.95（报告 L228-243） */
  private buildCoach() {
    let t = COACH_START
    let prev: Spec = STAND
    while (t < this.D - 1) {
      const progress = t / this.D
      const dur = this.cfg.move * (0.85 + Math.random() * 0.3) * (1 - 0.2 * progress)
      let pose = prev
      for (let tries = 0; tries < 12; tries++) {
        const cand = LIB_SPECS[this.cfg.lib[Math.floor(Math.random() * this.cfg.lib.length)]]
        if (handScore(prev, cand) < 0.95) {
          pose = cand
          break
        }
      }
      this.coachScript.push({ pose, start: t, end: t + dur })
      prev = pose
      t += dur
    }
  }

  /** 教练当前姿势（blend 秒内平滑过渡，报告 §1 blend） */
  private coachAt(now: number): Spec {
    let idx = -1
    for (let i = 0; i < this.coachScript.length; i++) {
      if (now >= this.coachScript[i].start) idx = i
      else break
    }
    if (idx < 0) return STAND
    const cur = this.coachScript[idx]
    const prev = idx > 0 ? this.coachScript[idx - 1].pose : STAND
    const k = clamp01((now - cur.start) / this.cfg.blend)
    const smooth = k * k * (3 - 2 * k)
    return lerpSpec(prev, cur.pose, smooth)
  }

  /** 当前领舞者（多人：轮次奇偶；单人：-1 表示教练） */
  private leaderId(now: number): number {
    const present = this.players.filter((p) => p.body).length
    if (present > 1) return Math.floor(now / this.roundLen) % 2
    return -1
  }

  /** 领舞者是否"在动"：能量 > 0.3 或 1.5s 内换过参考姿势（报告 §2.3） */
  private isMoving(pi: number, now: number) {
    return this.energy[pi] > MOVE_ENERGY || now - this.refAt[pi] < MOVE_REF_T
  }

  tick(_f: PoseFrame, dt: number) {
    this.bannerT = Math.max(0, this.bannerT - dt)
    const now = this.t
    const present = this.players.filter((p) => p.body)
    this.solo = present.length <= 1
    const leaderPi = this.leaderId(now)

    // 特征历史采样 + 参考姿势更新（阈值 0.035）
    for (const pv of this.players) {
      const b = pv.body
      if (!b) continue
      const spec = specOf(b)
      const buf = this.hist[pv.id]
      buf.push({ t: now, spec })
      while (buf.length && buf[0].t < now - 2.5) buf.shift()
      const ref = this.ref[pv.id]
      if (
        !ref ||
        Math.hypot(ref.l.x - spec.l.x, ref.l.y - spec.l.y) + Math.hypot(ref.r.x - spec.r.x, ref.r.y - spec.r.y) >
          REF_THR
      ) {
        this.ref[pv.id] = spec
        this.refAt[pv.id] = now
      }
    }

    // 多人：换轮横幅（报告 §2 轮换）
    if (!this.solo && present.length > 1) {
      const r = Math.min(this.rounds - 1, Math.floor(now / this.roundLen))
      if (r !== this.round) {
        this.round = r
        this.streak = [0, 0]
        this.milestone = [0, 0]
        this.missFor = [0, 0]
        const name = `玩家${leaderPi + 1}`
        if (r === 0) {
          this.bannerT = 2
          this.bannerBig = `${name} 先领舞`
          this.bannerSub = '另一个人像照镜子一样跟着做'
        } else {
          this.bannerT = 1.8
          this.bannerBig = '换人领舞！'
          this.bannerSub = `${name} 来领舞`
        }
        this.bannerColor = '#ffd54a'
        this.ctx.audio.good() // chime → good 兜底
        this.ctx.speak(r === 0 ? `${name} 先领舞` : `换${name}领舞`)
        this.ctx.setStage(`${name} 领舞`)
      }
    }

    // 判定节拍 0.25s（报告 O = 0.25）
    if (now - this.lastTick < TICK) return
    this.lastTick = now

    if (this.solo) {
      // 单人：跟教练，credit 0.25/tick → 1 分/秒；教练无难倒分（报告 §8）
      const fb = this.players[0].body
      if (fb) this.judge(0, fb, this.coachAt(now), -1, 1)
    } else if (present.length > 1) {
      const follower = leaderPi >= 0 ? 1 - leaderPi : 0
      const lb = this.players[leaderPi].body
      const fb = this.players[follower].body
      const roundStart = this.round * this.roundLen
      if (now - roundStart >= ROUND_GRACE && lb) {
        // 换轮免判宽限 1.2s（报告 M = 1.2）
        if (!fb) {
          // 跟舞者不在镜头前：领舞姿势离站立差 ≥0.1 即记脱靶（报告 L312-314）
          const lastSpec = this.hist[leaderPi][this.hist[leaderPi].length - 1]?.spec
          if (lastSpec && 1 - handScore(STAND, lastSpec) >= 0.1) {
            this.judged[follower]++
            this.streak[follower] = 0
            this.missFor[follower] += TICK
          }
        } else {
          this.judge(follower, fb, specOf(lb), leaderPi, MULTI_RATE)
        }
      }
    }

    // 结算用 extras（报告 §6）
    const fpi = leaderPi >= 0 ? 1 - leaderPi : 0
    this.ctx.setExtra(
      '跟舞准确率',
      this.judged[fpi] ? Math.round((this.hits[fpi] / this.judged[fpi]) * 100) : 0,
    )
    this.ctx.setExtra('最长同步', Math.round(this.bestStreak[fpi] * 10) / 10)
    this.ctx.setExtra('难倒对方', this.stumps.reduce((a, b) => a + b, 0))

    // 计量条平滑（升 5/s 降 2/s，报告 L413-419）
    const targetMeter = Math.min(1, 0.35 + this.streak[fpi] / 5)
    const rate = targetMeter > this.meter ? 5 : 2
    this.meter += clamp01(targetMeter - this.meter) * Math.min(1, rate * dt)
  }

  update(f: PoseFrame, dt: number) {
    for (const b of f.bodies) this.updateEnergy(b, dt)
    super.update(f, dt)
    // 多人未跟上（missFor 在本帧增长）→ 领舞者在动则攒难倒分（0.25×0.5×2 = 0.25/tick → 1 分/秒）
    if (!this.solo && this.players.filter((p) => p.body).length > 1) {
      const leaderPi = this.leaderId(this.t)
      const follower = leaderPi >= 0 ? 1 - leaderPi : 0
      if (this.missFor[follower] !== this.lastMissFor[follower]) {
        this.lastMissFor[follower] = this.missFor[follower]
        if (leaderPi >= 0 && this.isMoving(leaderPi, this.t)) {
          this.stumpCredit[leaderPi] += TICK * STUMP_K * MULTI_RATE
          if (this.stumpCredit[leaderPi] >= 1) {
            this.stumpCredit[leaderPi] -= 1
            this.stumps[leaderPi]++
            this.score++
            const b = this.players[leaderPi].body
            this.say('难倒 +1', b ? b.head.x * this.W : this.W / 2, this.H * 0.4, '#ff9f1c', 30)
            this.ctx.audio.jump() // boing → jump 兜底
            this.ctx.setScore(this.score)
          }
        }
      }
    }
  }

  /** 跟舞判定（报告 §2）：在 lag 窗口内以 0.1s 步长查领舞历史特征（|Δt|<0.12 最近样本），镜像准确度取最大 */
  private judge(followerPi: number, fb: Body, nowSpec: Spec, leaderPi: number, rate: number) {
    const now = this.t
    const feat = specOf(fb)
    let best: number | null = null
    const buf = leaderPi >= 0 ? this.hist[leaderPi] : []
    for (let d = 0; d <= this.cfg.lag + 0.001; d += 0.1) {
      const want = now - d
      let sample: Spec | null = null
      for (let i = buf.length - 1; i >= 0; i--) {
        if (Math.abs(buf[i].t - want) < 0.12) {
          sample = buf[i].spec
          break
        }
      }
      const acc = mirrorAcc(feat, sample ?? nowSpec)
      if (acc !== null && (best === null || acc > best)) best = acc
    }
    if (best === null) return
    this.judged[followerPi]++
    if (best >= this.cfg.thr) {
      // 跟上：hits++、streak += 0.25、credit += 0.25×倍率（报告 §2.3）
      this.hits[followerPi]++
      this.streak[followerPi] += TICK
      this.bestStreak[followerPi] = Math.max(this.bestStreak[followerPi], this.streak[followerPi])
      this.missFor[followerPi] = 0
      this.credit[followerPi] += TICK * rate
      if (this.credit[followerPi] >= 1) {
        this.credit[followerPi] -= 1
        this.score++
        this.ctx.audio.pop()
        this.ctx.setScore(this.score)
      }
      // 里程碑：每持续 5s 提示「同步 {n} 秒！」/ 单人「真像！」（报告 §2.3）
      const ms = Math.floor(this.streak[followerPi] / MILESTONE)
      if (ms > this.milestone[followerPi]) {
        this.milestone[followerPi] = ms
        this.say(this.solo ? '真像！' : `同步 ${Math.floor(this.streak[followerPi])} 秒！`, this.W / 2, this.H * 0.3, '#ffd54a', 40)
        this.particles.burst(this.W / 2, this.H * 0.32, '#ffd54a', 12, 360, 6)
        this.ctx.audio.combo() // sparkle → combo 兜底
      }
    } else {
      // 未跟上：streak 清零、missFor 累积（难倒分在 update 钩子结算）
      this.streak[followerPi] = 0
      this.missFor[followerPi] += TICK
    }
  }

  /** 运动能量代理：帧间可见关节均速（躯干长/秒），τ=0.15 平滑（框架无 motion.energy，本地代理） */
  private updateEnergy(b: Body, dt: number) {
    const id = b.id
    const prev = this.prevLm[id]
    if (prev.length !== b.lm.length) {
      this.prevLm[id] = b.lm.map((p) => ({ x: p.x, y: p.y }))
      return
    }
    let sum = 0
    let n = 0
    const scale = Math.max(0.05, b.scale)
    for (let i = 0; i < b.lm.length; i++) {
      const p = b.lm[i]
      const q = prev[i]
      if (!q || (p.visibility ?? 1) < 0.5) continue
      sum += Math.hypot(p.x - q.x, p.y - q.y) / Math.max(0.016, dt) / scale
      n++
      prev[i] = { x: p.x, y: p.y }
    }
    const raw = n ? sum / n : 0
    const k = 1 - Math.exp(-dt / 0.15)
    this.energy[id] += (raw - this.energy[id]) * k
  }

  paint(c: CanvasRenderingContext2D) {
    const now = this.t
    const leaderPi = this.leaderId(now)
    const followerPi = leaderPi >= 0 ? 1 - leaderPi : 0
    const lb = leaderPi >= 0 ? this.players[leaderPi].body : null
    const fb = this.players[followerPi].body

    // 中央大镜框（计量驱动发亮，报告 §4 ne()）
    const mw = 130 * this.unit
    const mh = 320 * this.unit
    const mx = this.W / 2
    const my = this.H * 0.5
    c.save()
    c.globalAlpha = 0.25 + this.meter * 0.3
    c.strokeStyle = '#dff6ff'
    c.lineWidth = 8
    rr(c, mx - mw / 2, my - mh / 2, mw, mh, 26)
    c.stroke()
    if (this.meter > 0.5) glow(c, mx, my, 200, '#8fd3ff', (this.meter - 0.5) * 0.5)
    c.restore()

    // 幽灵镜像提示：领舞（教练）当前特征绕屏幕中线镜像画白色剪影（hard ghost=0 关闭，报告 §4）
    if (this.cfg.ghost > 0) {
      const ghostSpec = this.solo ? this.coachAt(now) : this.hist[leaderPi]?.[this.hist[leaderPi].length - 1]?.spec
      if (ghostSpec) {
        const refB = lb ?? fb
        const anchorX = this.solo ? this.W * 0.74 : refB ? this.W - refB.shoulderC.x * this.W : this.W * 0.74
        const anchorY = refB ? refB.shoulderC.y * this.H : this.H * 0.5
        const s = (refB?.scale ?? 0.5) * this.H
        c.save()
        c.globalAlpha = this.cfg.ghost
        c.strokeStyle = '#fff'
        c.fillStyle = '#fff'
        c.lineWidth = 9
        c.beginPath()
        c.arc(anchorX, anchorY - s * 0.55, s * 0.14, 0, Math.PI * 2)
        c.fill()
        const hand = (h: { x: number; y: number }, side: number) => {
          c.beginPath()
          c.moveTo(anchorX, anchorY - s * 0.35)
          c.lineTo(anchorX + side * h.x * s * 0.9, anchorY - s * 0.35 - h.y * s * 0.55)
          c.stroke()
        }
        hand(ghostSpec.l, -1)
        hand(ghostSpec.r, 1)
        txt(c, '镜像', anchorX, anchorY + s * 0.4, 14, 'rgba(255,255,255,.7)')
        c.restore()
      }
    }

    // 跟舞者黄色径向光晕（计量高时，报告 L413-419）
    if (fb && this.meter > 0.45) {
      glow(c, fb.shoulderC.x * this.W, fb.shoulderC.y * this.H, 190, '#ffd54a', (this.meter - 0.45) * 0.7)
    }

    // 领舞者皇冠（报告 §4 v()）
    if (lb) {
      const hx = lb.head.x * this.W
      const hy = lb.head.y * this.H - 46
      c.save()
      c.globalAlpha = 0.9
      star(c, hx, hy, 13, '#ffd54a')
      star(c, hx - 13, hy + 3, 8, '#ffd54a')
      star(c, hx + 13, hy + 3, 8, '#ffd54a')
      c.restore()
    }

    // 名牌与实时信息（报告 §4）
    if (!this.solo) {
      txt(c, `玩家${leaderPi + 1} · 领舞`, this.W * 0.25, this.H * 0.94, 18, '#ffd166')
      txt(c, `玩家${followerPi + 1} · 照镜子`, this.W * 0.75, this.H * 0.94, 18, '#8fd3ff')
      txt(c, `难倒 ${this.stumps[leaderPi]} 分`, this.W * 0.25, this.H * 0.08, 20, '#ff9f1c')
    } else {
      txt(c, '教练 · 领舞', this.W * 0.26, this.H * 0.94, 18, '#ffd166')
      txt(c, '你 · 照镜子', this.W * 0.74, this.H * 0.94, 18, '#8fd3ff')
    }
    const acc = this.judged[followerPi] ? Math.round((this.hits[followerPi] / this.judged[followerPi]) * 100) : 100
    txt(c, `跟上 ${acc}%`, this.W * (this.solo ? 0.74 : 0.75), this.H * 0.08, 20, '#dff6ff')

    // 提示文案（报告 L480-496）
    if (this.missFor[followerPi] > 1.5) {
      outlineTxt(c, this.solo ? '看教练，照镜子！' : '看对面，照镜子！', this.W / 2, this.H * 0.16, 30, '#ff6b6b')
    }
    if (!this.solo && lb) {
      const roundStart = this.round * this.roundLen
      if (now - roundStart > 1.7 && !this.isMoving(leaderPi, now)) {
        outlineTxt(c, '动起来！不动不得分', this.W * 0.25, this.H * 0.12, 24, '#ff6b6b')
      }
    }

    // 横幅
    if (this.bannerT > 0) {
      c.save()
      c.globalAlpha = Math.min(1, this.bannerT / 0.3)
      outlineTxt(c, this.bannerBig, this.W / 2, this.H * 0.26, 50, this.bannerColor)
      if (this.bannerSub) txt(c, this.bannerSub, this.W / 2, this.H * 0.26 + 44, 20, 'rgba(255,255,255,.9)')
      c.restore()
    }
  }
}

/** 领舞姿势库的目标手位（黑盒 spec 表按姿势名设计，报告 §1 lib） */
const LIB_SPECS: Record<string, Spec> = {
  up: { l: { x: -0.16, y: 1.0 }, r: { x: 0.16, y: 1.0 } },
  t: { l: { x: -0.95, y: 0 }, r: { x: 0.95, y: 0 } },
  star: { l: { x: -1.05, y: 0.42 }, r: { x: 1.05, y: 0.42 } },
  leftUp: { l: { x: -0.14, y: 1.0 }, r: { x: 0.18, y: -0.5 } },
  rightUp: { l: { x: -0.18, y: -0.5 }, r: { x: 0.14, y: 1.0 } },
  muscle: { l: { x: -0.32, y: 0.12 }, r: { x: 0.32, y: 0.12 } },
  squat: { l: { x: -0.38, y: -0.12 }, r: { x: 0.38, y: -0.12 } },
  y: { l: { x: -0.62, y: 0.8 }, r: { x: 0.62, y: 0.8 } },
  wave: { l: { x: -0.16, y: -0.5 }, r: { x: 0.4, y: 0.95 } },
  kneeL: { l: { x: -0.45, y: 0.05 }, r: { x: 0.45, y: 0.05 } },
}

export default function create(ctx: GameContext) {
  return new MirrorDuel(ctx)
}
