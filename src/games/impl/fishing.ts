import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, glow, outlineTxt, rr, txt } from '@/core/draw'

/**
 * 钓小鱼（对齐 dongdongpark 真实规则，见 _reverse/reports/fishing.md）：
 * 手放低 0.15s 自动抛竿 → 等浮标沉（之前有 0~3 次假咬）→ 真咬后 window 秒内快速上提（≥jerk 躯干/s）
 * 即钓上 +1；提早了鱼吓跑、提慢了鱼溜走，均不扣分。
 * 六态状态机 ready→cast→wait→bite→reel→home（escape/scared 回退）；
 * 儿童辅助挂在 easy 档（窗口 +0.7s、慢提 0.4×躯干 也算）。
 */

type Phase = 'ready' | 'cast' | 'wait' | 'bite' | 'reel' | 'home' | 'escape' | 'scared'

/** 对齐站点难度表：真咬等待区间 / 假咬上限 / 假咬加时 / 咬钩窗口 / 提竿速度门槛 / 靴子率 / 金鱼率 */
const DIFF = [
  { wait: [1.4, 3.2], fakes: 1, fakeAdd: 0.5, window: 1.2, jerk: 1.6, boot: 0.1, gold: 0.1 },
  { wait: [1.6, 3.8], fakes: 2, fakeAdd: 0.5, window: 0.9, jerk: 2, boot: 0.1, gold: 0.08 },
  { wait: [1.4, 3.4], fakes: 3, fakeAdd: 0.45, window: 0.7, jerk: 2, boot: 0.1, gold: 0.06 },
]

const WATER = 0.8 // 水面高度 = H×0.8
const FLOAT = 18 // 浮标绘制尺寸基准 C=18
const CAST_HOLD = 0.15 // 双手低于线持续 0.15s → 自动抛竿
const CAST_FLY = 0.42 // 抛竿飞行动画时长
const FAKE_DUR = 0.6 // 假咬持续（浮标抖动 + 小涟漪 + bubble 音）
const ESCAPE_DUR = 0.8 // 鱼溜走动画时长
const SCARED_DUR = 0.9 // 吓跑动画时长
const REEL_DUR = 0.9 // 收线动画时长
const HOME_FISH = 0.6 // 飞鱼入桶时长
const HOME_BOOT = 0.9 // 靴子飞出场外时长
const EARLY_GRACE = 0.15 // 提前宽限：t ≥ wait-0.15 提竿仍算成功
const CHILD_WIN = 0.7 // 儿童咬钩窗口加成
const CHILD_LIFT = 0.4 // 儿童慢提判定：低点累计抬升 ≥0.4×躯干
const HIST = 0.8 // 手位置历史滚动窗口
const LOW_LINE = 0.55 // 双手低于 肩+0.55×躯干 判「放下」
const HIGH_LINE = 0.2 // 立即触发线：手抬过 肩+0.2×躯干（代理报告的立即触发）
const ROD_LEN = 120 // 鱼竿长度 px×unit
const FISH_COLORS = ['#ff8fab', '#ffa94d', '#74c0fc', '#b197fc']

interface Item {
  kind: 'fish' | 'gold' | 'boot'
  color: string
  size: number
}

interface Plan {
  wait: number // 真咬总等待（基础 + 假咬加时）
  fakes: number[] // 假咬时刻表
  item: Item
}

interface PState {
  phase: Phase
  t: number // 当前阶段计时
  rod: 0 | 1 // 持竿手（抛竿时较高的那只）
  lowT: number // 双手放低累计
  plan: Plan | null
  fakeIdx: number
  fakeFx: number // 假咬动画剩余
  biteAt: number // 咬钩开始时刻（反应计时用）
  hist: { t: number; y: number }[] // 武装手 y 历史（归一化，0.8s 滚动窗）
  biteLow: number // 低点（归一化最大 y，慢提判定用）
  caught: number // 桶计数（鱼 + 金鱼）
  boots: number
  early: number
  best: number // 最快反应 ms
  casts: number
  streak: number
  spokeBite: number // 「快提！」语音次数（前 2 次）
  jarPop: number // 桶弹跳动画
  hintAt: number // 溜走提示节流
  item: Item | null // 收线/入桶动画中的物品
}

function newPS(): PState {
  return {
    phase: 'ready',
    t: 0,
    rod: 0,
    lowT: 0,
    plan: null,
    fakeIdx: 0,
    fakeFx: 0,
    biteAt: 0,
    hist: [],
    biteLow: 0,
    caught: 0,
    boots: 0,
    early: 0,
    best: 0,
    casts: 0,
    streak: 0,
    spokeBite: 0,
    jarPop: 0,
    hintAt: 0,
    item: null,
  }
}

class Fishing extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  st: PState[] = [newPS(), newPS()]
  score = 0
  bannerText = ''
  bannerT = 0
  ripples: { x: number; y: number; age: number; big: boolean }[] = []
  private spokeStart = false
  private lastStage = ''

  /** 儿童档辅助（站点 ageMin 3 低龄玩家）：窗口 +0.7s、慢提可判 */
  private get easy() {
    return this.ctx.difficulty === 0
  }

  private unit() {
    return this.H / 720
  }

  private present() {
    return this.players.filter((p) => p.body).length
  }

  private zone(pi: number) {
    if (this.present() <= 1) return { x0: this.W * 0.08, x1: this.W * 0.92 }
    return pi === 0 ? { x0: this.W * 0.03, x1: this.W * 0.47 } : { x0: this.W * 0.53, x1: this.W * 0.97 }
  }

  private stage(s: string) {
    if (s !== this.lastStage) {
      this.lastStage = s
      this.ctx.setStage(s)
    }
  }

  /** 物品抽取：首杆必鱼；之后 boot 概率 → 金鱼（rand > 1-gold）→ 普通鱼（4 色 0.85~1.15） */
  private rollItem(pi: number): Item {
    if (this.st[pi].casts === 0) return { kind: 'fish', color: FISH_COLORS[Math.floor(Math.random() * FISH_COLORS.length)], size: 1 }
    if (Math.random() < this.cfg.boot) return { kind: 'boot', color: '#8a5a3b', size: 1 }
    if (Math.random() > 1 - this.cfg.gold) return { kind: 'gold', color: '#ffd700', size: 1.3 }
    return { kind: 'fish', color: FISH_COLORS[Math.floor(Math.random() * FISH_COLORS.length)], size: 0.85 + Math.random() * 0.3 }
  }

  /** 本杆计划：基础等待 + 假咬时刻表（假咬间隔 ≥0.95s、真咬前 0.8s 静默）+ 物品 */
  private buildPlan(pi: number): Plan {
    const [lo, hi] = this.cfg.wait
    const base = lo + Math.random() * (hi - lo)
    const n = Math.min(this.cfg.fakes, Math.floor(Math.random() * (this.cfg.fakes + 1)))
    const fs: number[] = []
    while (fs.length < n) {
      const t0 = fs.length === 0
        ? 0.6 + Math.random() * Math.max(0.2, base - 1.5)
        : fs[fs.length - 1] + 0.95
      if (t0 >= base - 0.8) break
      fs.push(t0)
    }
    return { wait: base + fs.length * this.cfg.fakeAdd, fakes: fs, item: this.rollItem(pi) }
  }

  /** 抛竿：渔场按较高的那只手决定持竿手（whoosh 音） */
  private beginCast(pi: number) {
    const st = this.st[pi]
    const b = this.players[pi].body!
    st.rod = b.lHand.y <= b.rHand.y ? 0 : 1
    st.phase = 'cast'
    st.t = 0
    st.casts++
    st.plan = this.buildPlan(pi)
    st.fakeIdx = 0
    st.hist = []
    this.ctx.audio.slash() // whoosh
    this.stage('抛竿！')
  }

  private bobber(pi: number) {
    const z = this.zone(pi)
    return { x: (z.x0 + z.x1) / 2, y: this.H * WATER }
  }

  /** 咬钩：大涟漪 + 水花 +「咕咚！」+ 语音「快提！」（前 2 次） */
  private doBite(pi: number) {
    const st = this.st[pi]
    st.phase = 'bite'
    st.t = 0
    st.biteAt = this.t
    const p = this.bobber(pi)
    this.ripples.push({ x: p.x, y: p.y, age: 0, big: true })
    this.ctx.audio.play('hit', 0.5, 1.4) // splash
    const u = this.unit()
    this.particles.burst(p.x, p.y, '#bde0fe', 10, 260 * u, 4 * u)
    this.say('咕咚！', p.x, p.y - 70 * u, '#e0fbfc', 46)
    if (st.spokeBite < 2) {
      st.spokeBite++
      this.ctx.speak('快提！')
    }
    this.stage('咬钩了！快提！')
  }

  /** 收线成功：反应毫秒（仅真咬后）入账 */
  private startReel(pi: number, fromBite: boolean) {
    const st = this.st[pi]
    st.phase = 'reel'
    st.t = 0
    if (fromBite) {
      const ms = Math.round((this.t - st.biteAt) * 1000)
      st.best = st.best === 0 ? ms : Math.min(st.best, ms)
    }
    st.item = st.plan?.item ?? { kind: 'fish', color: '#74c0fc', size: 1 }
    this.ctx.audio.play('pop', 0.7, 1.2) // splash
    this.stage('收线！')
  }

  /** 提太早：鱼吓跑（首次有教学语音，之后每 3 次提醒一次） */
  private scare(pi: number) {
    const st = this.st[pi]
    st.phase = 'scared'
    st.t = 0
    st.early++
    st.streak = 0
    const p = this.bobber(pi)
    this.say('太早啦！', p.x, p.y - 60 * this.unit(), '#ff6b6b', 40)
    this.ctx.audio.fail()
    if (st.early === 1 || st.early % 3 === 0) this.ctx.speak('浮标一沉，马上往上提')
    if (st.early === 1) {
      this.bannerText = '太早啦！等浮标沉了再提'
      this.bannerT = 1.4
    }
  }

  /** 提太慢：鱼溜走（儿童每 6s 提示一次） */
  private escape(pi: number) {
    const st = this.st[pi]
    st.phase = 'escape'
    st.t = 0
    st.streak = 0
    const p = this.bobber(pi)
    this.say('鱼溜走啦', p.x, p.y - 60 * this.unit(), '#8ecae6', 36)
    this.ctx.audio.play('pop', 0.5, 0.7) // bubble
    if (this.t - st.hintAt > 6) {
      st.hintAt = this.t
      this.ctx.speak(this.easy ? '手再往上提高一点' : '浮标一沉，马上往上提')
    }
  }

  /** 提竿检测 G：立即触发（手抬过 肩+0.2×躯干 线）/ 速度触发（≥jerk 躯干/s + 0.6s 峰值条件）/ 儿童慢提 */
  private jerked(pi: number, b: Body): boolean {
    const st = this.st[pi]
    const torsoN = Math.max(0.06, b.scale)
    const h = st.rod === 0 ? b.lHand : b.rHand
    const now = this.t
    st.hist.push({ t: now, y: h.y })
    while (st.hist.length && now - st.hist[0].t > HIST) st.hist.shift()
    if (st.hist.length < 2) return false
    const last = st.hist[st.hist.length - 1]
    const prev = st.hist[st.hist.length - 2]
    const vShort = (last.y - prev.y) / Math.max(0.001, last.t - prev.t)
    // 0.2s 回看斜率
    let slope = vShort
    for (let i = st.hist.length - 1; i >= 0; i--) {
      if (last.t - st.hist[i].t >= 0.2 || i === 0) {
        slope = (last.y - st.hist[i].y) / Math.max(0.001, last.t - st.hist[i].t)
        break
      }
    }
    st.biteLow = Math.max(st.biteLow, last.y) // 低点跟踪（慢提判定）
    // 立即触发：手抬到 肩+0.2×躯干 线以上（明确的抬竿动作）
    if (h.y < b.shoulderC.y + HIGH_LINE * torsoN) return true
    // 速度触发：max(瞬时速度, 0.2s 斜率)/躯干 ≥ jerk，且 0.6s 内峰值比当前高 ≥0.35×躯干
    const up = Math.max(-vShort, -slope) / torsoN
    if (up >= this.cfg.jerk) {
      let minY = last.y
      for (const q of st.hist) {
        if (last.t - q.t <= 0.6 && q.y < minY) minY = q.y
      }
      if (last.y - minY >= 0.35 * torsoN) return true
    }
    // 儿童慢提：低点累计抬升 ≥0.4×躯干 也算
    if (this.easy && last.y < st.biteLow - CHILD_LIFT * torsoN) return true
    return false
  }

  tick(_f: PoseFrame, dt: number) {
    this.bannerT = Math.max(0, this.bannerT - dt)
    if (!this.spokeStart && this.t > 0.5) {
      this.spokeStart = true
      this.ctx.speak('手放下，开始钓鱼啦')
    }
    // 涟漪动画
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      this.ripples[i].age += dt
      if (this.ripples[i].age > 0.8) this.ripples.splice(i, 1)
    }

    for (let pi = 0; pi < 2; pi++) {
      const st = this.st[pi]
      const b = this.players[pi].body
      if (st.fakeFx > 0) st.fakeFx -= dt
      if (st.jarPop > 0) st.jarPop -= dt
      if (!b) continue
      const torsoN = Math.max(0.06, b.scale)
      const shY = b.shoulderC.y
      const handLow = (hi: 0 | 1) => (hi === 0 ? b.lHand.y : b.rHand.y) > shY + LOW_LINE * torsoN
      const bothLow = handLow(0) && handLow(1)

      switch (st.phase) {
        case 'ready': {
          // 双手放低持续 0.15s → 自动抛竿
          st.lowT = Math.max(0, Math.min(0.3, st.lowT + (bothLow ? dt : -dt * 2)))
          if (st.lowT >= CAST_HOLD) this.beginCast(pi)
          this.stage(bothLow ? '鱼竿准备好了…' : '把手放低，准备抛竿')
          break
        }
        case 'cast': {
          st.t += dt
          if (st.t >= CAST_FLY) {
            st.phase = 'wait'
            st.t = 0
            st.hist = []
            st.biteLow = (st.rod === 0 ? b.lHand.y : b.rHand.y)
            this.stage('耐心等鱼咬钩…')
          }
          break
        }
        case 'wait': {
          st.t += dt
          // 假咬：浮标抖动 + 小涟漪 + bubble 音
          const plan = st.plan
          if (plan && st.fakeIdx < plan.fakes.length && st.t >= plan.fakes[st.fakeIdx]) {
            st.fakeIdx++
            st.fakeFx = FAKE_DUR
            const p = this.bobber(pi)
            this.ripples.push({ x: p.x, y: p.y, age: 0, big: false })
            this.ctx.audio.play('pop', 0.5, 1.5) // bubble
          }
          // 提竿检测：提前宽限内算成功，否则吓跑
          if (this.jerked(pi, b)) {
            if (st.t >= (plan?.wait ?? 2) - EARLY_GRACE) this.startReel(pi, false)
            else this.scare(pi)
          } else if (st.t >= (plan?.wait ?? 2)) {
            this.doBite(pi)
          }
          break
        }
        case 'bite': {
          st.t += dt
          if (this.jerked(pi, b)) this.startReel(pi, true)
          else if (st.t >= this.cfg.window + (this.easy ? CHILD_WIN : 0)) this.escape(pi)
          break
        }
        case 'reel': {
          // 0.9s 收线：鱼从浮标拉到竿尖
          st.t += dt
          if (st.t >= REEL_DUR) {
            st.phase = 'home'
            st.t = 0
          }
          break
        }
        case 'home': {
          // 鱼入桶 0.6s / 靴子飞出场外 0.9s
          st.t += dt
          const dur = st.item?.kind === 'boot' ? HOME_BOOT : HOME_FISH
          if (st.t >= dur) {
            const item = st.item
            st.item = null
            if (item && item.kind === 'boot') {
              st.boots++
              this.say('哈哈，钓到一只旧靴子', this.W / 2, this.H * 0.35, '#d9a066', 34)
              this.ctx.audio.play('pop', 0.8, 0.5) // boing
            } else if (item) {
              st.caught++
              st.streak++
              this.score++
              st.jarPop = 0.4
              this.ctx.audio.pop()
              if (item.kind === 'gold') {
                this.say('大金鱼 +1', this.W / 2, this.H * 0.35, '#ffd700', 42)
                this.ctx.audio.play('score', 0.9, 1.3) // 金鱼 ×1.3 音高
                const jp = this.jarPos(pi)
                this.particles.burst(jp.x, jp.y, '#ffe066', 14, 320 * this.unit(), 5 * this.unit())
              }
            }
            // 动画结束双手仍放低 → 自动重新抛竿
            if (bothLow) this.beginCast(pi)
            else {
              st.phase = 'ready'
              st.lowT = 0
            }
          }
          break
        }
        case 'escape': {
          st.t += dt
          if (st.t >= ESCAPE_DUR) {
            if (bothLow) this.beginCast(pi)
            else {
              st.phase = 'ready'
              st.lowT = 0
            }
          }
          break
        }
        case 'scared': {
          st.t += dt
          if (st.t >= SCARED_DUR) {
            if (bothLow) this.beginCast(pi)
            else {
              st.phase = 'ready'
              st.lowT = 0
            }
          }
          break
        }
      }
    }

    const c0 = this.st[0]
    const c1 = this.st[1]
    this.ctx.setScore(this.score)
    this.ctx.setCombo(Math.max(c0.streak, c1.streak))
    this.ctx.setExtra('最快反应(ms)', Math.min(c0.best || 9999, c1.best || 9999) === 9999 ? 0 : Math.min(c0.best || 9999, c1.best || 9999))
    this.ctx.setExtra('太早提竿', c0.early + c1.early)
    this.ctx.setExtra('旧靴子', c0.boots + c1.boots)
  }

  private jarPos(pi: number) {
    const z = this.zone(pi)
    const w = z.x1 - z.x0
    return { x: this.present() > 1 && pi === 1 ? z.x1 - w * 0.82 : z.x0 + w * 0.82, y: this.H * 0.9 }
  }

  paint(c: CanvasRenderingContext2D) {
    const u = this.unit()
    const wy = this.H * WATER
    // 半透明水面渐变（两层）
    let g = c.createLinearGradient(0, wy, 0, this.H)
    g.addColorStop(0, 'rgba(90,170,255,.28)')
    g.addColorStop(1, 'rgba(40,110,220,.16)')
    c.fillStyle = g
    c.fillRect(0, wy, this.W, this.H - wy)
    g = c.createLinearGradient(0, wy + (this.H - wy) * 0.45, 0, this.H)
    g.addColorStop(0, 'rgba(30,90,200,.14)')
    g.addColorStop(1, 'rgba(16,50,130,.3)')
    c.fillStyle = g
    c.fillRect(0, wy + (this.H - wy) * 0.45, this.W, (this.H - wy) * 0.55)
    // 水面波纹线
    c.strokeStyle = 'rgba(255,255,255,.16)'
    c.lineWidth = 2 * u
    for (let i = 0; i < 4; i++) {
      const yy = wy + 18 * u + i * 22 * u
      c.beginPath()
      for (let x = 0; x <= this.W; x += 40) {
        const y = yy + Math.sin(x / 130 + this.t * (1.1 + i * 0.3)) * 4 * u
        x === 0 ? c.moveTo(x, y) : c.lineTo(x, y)
      }
      c.stroke()
    }

    for (let pi = 0; pi < 2; pi++) {
      const st = this.st[pi]
      const b = this.players[pi].body
      // 没人时只画 P0 一片塘做氛围；有人时缺席的 P1 不画
      if (!b && (pi === 1 || this.present() > 0)) continue
      const z = this.zone(pi)
      const zw = z.x1 - z.x0
      // 睡莲（2 片，其一开花）
      for (let k = 0; k < 2; k++) {
        const lx = z.x0 + zw * (0.14 + k * 0.26)
        const ly = wy + (34 + k * 52) * u
        c.save()
        c.translate(lx, ly)
        c.rotate(Math.sin(this.t * 0.5 + k * 2 + pi) * 0.06)
        c.beginPath()
        c.ellipse(0, 0, 34 * u, 22 * u, 0, 0.3, Math.PI * 2 - 0.3)
        c.lineTo(0, 0)
        c.closePath()
        c.fillStyle = 'rgba(46,124,74,.8)'
        c.fill()
        if (k === 0) {
          circle(c, 0, -6 * u, 8 * u, '#ff8fab')
          circle(c, 0, -6 * u, 3.5 * u, '#ffe066')
        }
        c.restore()
      }
      // 游鱼影子（折返游动）
      const shY = wy + (74 + pi * 30) * u
      const shX = z.x0 + zw * 0.5 + Math.sin(this.t * 0.45 + pi * 2.4) * zw * 0.3
      c.save()
      c.globalAlpha = 0.16
      c.translate(shX, shY + Math.sin(this.t * 1.3 + pi) * 6 * u)
      c.scale(Math.cos(this.t * 0.45 + pi * 2.4) >= 0 ? 1 : -1, 1)
      c.beginPath()
      c.ellipse(0, 0, 26 * u, 8 * u, 0, 0, Math.PI * 2)
      c.fillStyle = '#083358'
      c.fill()
      c.beginPath()
      c.moveTo(-24 * u, 0)
      c.lineTo(-34 * u, -7 * u)
      c.lineTo(-34 * u, 7 * u)
      c.closePath()
      c.fill()
      c.restore()
      // 涟漪（小 60px / 大 110px 双环）
      for (const r of this.ripples) {
        if (r.x < z.x0 - 40 || r.x > z.x1 + 40) continue
        const p = Math.min(1, r.age / 0.8)
        const rr0 = (r.big ? 110 : 60) * u * p
        c.save()
        c.globalAlpha = 0.7 * (1 - p)
        c.strokeStyle = '#dbe9ff'
        c.lineWidth = 3 * u
        c.beginPath()
        c.ellipse(r.x, r.y, rr0, rr0 * 0.34, 0, 0, Math.PI * 2)
        c.stroke()
        c.beginPath()
        c.ellipse(r.x, r.y, rr0 * 0.6, rr0 * 0.2, 0, 0, Math.PI * 2)
        c.stroke()
        c.restore()
      }

      const bob = this.bobber(pi)
      // 鱼竿（抛竿后竿线在水里才画：从持竿手伸向浮标）
      if (b && st.phase !== 'ready') {
        const hp = st.rod === 0 ? { x: b.lHand.x * this.W, y: b.lHand.y * this.H } : { x: b.rHand.x * this.W, y: b.rHand.y * this.H }
        const dx = bob.x - hp.x
        const dy = bob.y - hp.y
        const d = Math.hypot(dx, dy) || 1
        const tip = { x: hp.x + (dx / d) * ROD_LEN * u, y: hp.y + (dy / d) * ROD_LEN * u }
        c.strokeStyle = '#8a5a3b'
        c.lineWidth = 6 * u
        c.lineCap = 'round'
        c.beginPath()
        c.moveTo(hp.x, hp.y)
        c.lineTo(tip.x, tip.y)
        c.stroke()
        c.strokeStyle = '#e5383b'
        c.lineWidth = 2 * u
        c.beginPath()
        c.moveTo(tip.x, tip.y)
        c.lineTo(bob.x, bob.y)
        c.stroke()
        // 浮标（假咬抖动 / 真咬下沉）
        let by = bob.y + Math.sin(this.t * 2) * 3 * u
        if (st.fakeFx > 0) by += Math.sin(this.t * 30) * 6 * u
        if (st.phase === 'bite') by += 13 * u
        circle(c, bob.x, by, FLOAT * 0.5 * u, '#ffd54a')
        c.fillStyle = '#e5383b'
        c.beginPath()
        c.arc(bob.x, by, FLOAT * 0.5 * u, Math.PI, Math.PI * 2)
        c.fill()
        c.strokeStyle = '#4a3b5c'
        c.lineWidth = 5 * u
        c.beginPath()
        c.moveTo(bob.x, by - FLOAT * 0.5 * u)
        c.lineTo(bob.x, by - FLOAT * 1.1 * u)
        c.stroke()
        // 收线：鱼从浮标拉向竿尖
        if (st.phase === 'reel' && st.item && st.item.kind !== 'boot') {
          const p = Math.min(1, st.t / REEL_DUR)
          const fx = bob.x + (tip.x - bob.x) * p
          const fy = bob.y + (tip.y - bob.y) * p
          this.drawFish(c, fx, fy, st.item, u, 0.35)
        }
        // 入桶/飞走动画
        if (st.phase === 'home' && st.item) {
          const dur = st.item.kind === 'boot' ? HOME_BOOT : HOME_FISH
          const p = Math.min(1, st.t / dur)
          if (st.item.kind === 'boot') {
            const dir = tip.x < this.W / 2 ? -1 : 1
            const bx = tip.x + dir * (this.W * 0.6) * p
            const byy = tip.y - 120 * u * Math.sin(p * Math.PI)
            this.drawBoot(c, bx, byy, u, st.item.size)
          } else {
            const jp = this.jarPos(pi)
            const mx = (tip.x + jp.x) / 2
            const my = Math.min(tip.y, jp.y) - 110 * u
            const q = 1 - p
            const fx = q * q * tip.x + 2 * q * p * mx + p * p * jp.x
            const fy = q * q * tip.y + 2 * q * p * my + p * p * jp.y
            if (st.item.kind === 'gold') glow(c, fx, fy, 40 * u, '#ffd700', 0.5)
            this.drawFish(c, fx, fy, st.item, u, 0.1)
          }
        }
        // 首杆教学：前 3 杆显示「耐心等…」
        if (st.phase === 'wait' && st.casts <= 3) {
          txt(c, '耐心等…', bob.x, bob.y - 110 * u, 30 * u, 'rgba(255,255,255,.85)')
        }
      }
      // 桶（记数 + 弹跳）
      const jp = this.jarPos(pi)
      const pop = st.jarPop > 0 ? 1 + Math.sin((st.jarPop / 0.4) * Math.PI) * 0.12 : 1
      c.save()
      c.translate(jp.x, jp.y)
      c.scale(pop, pop)
      rr(c, -34 * u, -36 * u, 68 * u, 74 * u, 10 * u)
      c.fillStyle = '#5c6b8a'
      c.fill()
      c.strokeStyle = '#3d4a66'
      c.lineWidth = 4 * u
      c.stroke()
      rr(c, -40 * u, -46 * u, 80 * u, 14 * u, 7 * u)
      c.fillStyle = '#8a99b8'
      c.fill()
      txt(c, `${st.caught}`, 0, 4 * u, 30 * u, '#fff')
      txt(c, '条', 0, 32 * u, 16 * u, 'rgba(255,255,255,.75)')
      c.restore()
    }

    if (this.bannerT > 0) {
      c.globalAlpha = Math.min(1, this.bannerT / 0.3)
      outlineTxt(c, this.bannerText, this.W / 2, this.H * 0.22, 44, '#ffd54a')
      c.globalAlpha = 1
    }
    txt(c, '手放低自动抛竿；浮标「咕咚」一沉，马上把手往上一提！', this.W / 2, this.H - 30, 20, 'rgba(255,255,255,.8)', 'center', 'bold')
  }

  /** 鱼形：身体 + 尾 + 眼（收线时半透明在水里） */
  private drawFish(c: CanvasRenderingContext2D, x: number, y: number, item: Item, u: number, alpha: number) {
    const s = item.size * u
    c.save()
    c.translate(x, y)
    c.globalAlpha = 1 - alpha
    glow(c, 0, 0, 30 * s, item.color, 0.35)
    c.beginPath()
    c.ellipse(0, 0, 22 * s, 12 * s, 0, 0, Math.PI * 2)
    c.fillStyle = item.color
    c.fill()
    c.beginPath()
    c.moveTo(18 * s, 0)
    c.lineTo(32 * s, -9 * s)
    c.lineTo(32 * s, 9 * s)
    c.closePath()
    c.fillStyle = item.color
    c.fill()
    circle(c, -10 * s, -3 * s, 2.6 * s, '#1d3557')
    c.restore()
  }

  private drawBoot(c: CanvasRenderingContext2D, x: number, y: number, u: number, size: number) {
    const s = size * u
    c.save()
    c.translate(x, y)
    c.rotate(Math.sin(this.t * 9) * 0.3)
    rr(c, -14 * s, -26 * s, 24 * s, 30 * s, 5 * s)
    c.fillStyle = '#8a5a3b'
    c.fill()
    rr(c, -14 * s, 0, 40 * s, 18 * s, 7 * s)
    c.fillStyle = '#6d4630'
    c.fill()
    c.strokeStyle = '#4a2f1e'
    c.lineWidth = 3 * s
    c.beginPath()
    c.moveTo(-14 * s, 0)
    c.lineTo(26 * s, 0)
    c.stroke()
    c.restore()
  }
}

export default function create(ctx: GameContext) {
  return new Fishing(ctx)
}
