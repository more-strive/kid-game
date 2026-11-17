import { BaseGame } from '@/core/base'
import type { Game, GameContext, PoseFrame } from '@/core/types'
import { circle, glow, outlineTxt, txt } from '@/core/draw'

/**
 * 空中架子鼓（对齐 dongdongpark 真实规则）：
 * 身边一套 5 件鼓（军鼓/通鼓/踩镲/镲/底鼓），音符掉到哪个鼓敲哪个。
 * 鼓=手向下砸（>2 躯干/秒）、镲=快速挥（>2.5）、底鼓=跳或跺脚（>2.5）；
 * 判定窗 perfect ≤.08 / good ≤.16 / ok ≤.24（共享 beat 模块真实数值），
 * 分值 3/2/1/0 + 连击加成 min(3, floor(combo/10))。
 */

type Judge = 'perfect' | 'good' | 'ok' | 'miss'

/** beat-CD3o6w1X.js 共享模块窗口配置 e = {perfect:.08, good:.16, ok:.24} */
const WIN = { perfect: 0.08, good: 0.16, ok: 0.24 }
/** 分值表 i = {perfect:3, good:2, ok:1, miss:0} */
const SCORE_OF: Record<Judge, number> = { perfect: 3, good: 2, ok: 1, miss: 0 }
/** 判定文案与配色（beat 模块真实值） */
const JUDGE_TEXT: Record<Judge, string> = { perfect: '完美！', good: '很好', ok: '还行', miss: '错过' }
const JUDGE_COLOR: Record<Judge, string> = { perfect: '#ffd93d', good: '#6bcb77', ok: '#4d96ff', miss: '#9a8ba8' }

/** static judge：|Δ|≤.08 perfect / ≤.16 good / ≤.24 ok / 否则 miss */
function grade(delta: number): Judge {
  const a = Math.abs(delta)
  if (a <= WIN.perfect) return 'perfect'
  if (a <= WIN.good) return 'good'
  if (a <= WIN.ok) return 'ok'
  return 'miss'
}
/** 连击加成：min(3, floor(combo/10)) */
function comboBonus(combo: number) {
  return Math.min(3, Math.floor(combo / 10))
}

/** 种子随机（原站 rng(k) 语义近似） */
function mulberry(seed: number) {
  let s = seed | 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let z = Math.imul(s ^ (s >>> 15), 1 | s)
    z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) ^ z
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 共享音符生成器 r(count, lanes, density, rng)：
 * 逐整数拍以 .35 + density×.6 概率撒点，lane 随机；同 lane 60% 重派；
 * density > .6 时每拍再以 (density-.6)×1.2 概率追加 beat+.5 半拍音符（lane 异于前一个）
 */
function genNotes(count: number, lanes: number, density: number, rng: () => number) {
  const out: { beat: number; lane: number }[] = []
  let prev = -1
  for (let beat = 0; beat < count; beat++) {
    if (rng() < 0.35 + density * 0.6) {
      let lane = Math.floor(rng() * lanes)
      if (lane === prev && rng() < 0.6) lane = (lane + 1 + Math.floor(rng() * (lanes - 1))) % lanes
      out.push({ beat, lane })
      prev = lane
      if (density > 0.6 && rng() < (density - 0.6) * 1.2) {
        let l2 = Math.floor(rng() * lanes)
        if (l2 === prev) l2 = (l2 + 1 + Math.floor(rng() * (lanes - 1))) % lanes
        out.push({ beat: beat + 0.5, lane: l2 })
        prev = l2
      }
    }
  }
  return out.sort((a, b) => a.beat - b.beat)
}

/** 对齐站点难度表：bpm / 密度 / 下落提前量 / 底鼓保留率 */
const DIFF = [
  { bpm: 90, density: 0.3, approach: 1.7, kickRate: 0.35 },
  { bpm: 110, density: 0.55, approach: 1.4, kickRate: 0.6 },
  { bpm: 130, density: 0.85, approach: 1.15, kickRate: 1 },
]
const DURATION = 75
/** Beat 时钟偏移（秒）：音乐/音符从 2.5s 起算 */
const OFFSET = 2.5
const KICK_LANE = 4 // 底鼓 lane 索引
/** 鼓触发：手竖直向下速度阈值（躯干长/秒） */
const DRUM_DOWN = 2
/** 镲触发：手任意方向速度阈值 */
const CYM_SPEED = 2.5
/** 底鼓触发：脚竖直速度阈值 */
const KICK_SPEED = 2.5
/** 同一只手对同一个鼓的重复触发冷却（秒） */
const HAND_CD = 0.25
/** 两次底鼓（跳）之间的最小间隔（秒） */
const KICK_CD = 0.45

interface DrumDef {
  ox: number
  oy: number
  r: number
  color: string
  kind: 'drum' | 'cymbal' | 'kick'
}

/** 鼓位定义 _：5 件套（真人游玩两只手均可敲任意手鼓；0/2 左手倾向、1/3 右手倾向） */
const DRUMS: DrumDef[] = [
  { ox: -1, oy: 0.45, r: 0.42, color: '#ff6b6b', kind: 'drum' },
  { ox: 1, oy: 0.45, r: 0.42, color: '#ff9f43', kind: 'drum' },
  { ox: -1.02, oy: -0.5, r: 0.36, color: '#ffd93d', kind: 'cymbal' },
  { ox: 1.02, oy: -0.5, r: 0.4, color: '#f0b429', kind: 'cymbal' },
  { ox: 0, oy: 1.75, r: 0.5, color: '#4d96ff', kind: 'kick' },
]

interface Note {
  beat: number
  lane: number
  t: number
  /** done[pi]：每玩家独立判定（同一音符表、判定按玩家隔离） */
  done: [Judge | '', Judge | '']
  missAt: [number, number]
}

interface PState {
  score: number
  combo: number
  maxCombo: number
  perfect: number
  hit: number
  passed: number
  missPtr: number
  /** cd[drum][hand] = 上次触发时刻 */
  cd: number[][]
  lastKick: number
  prevFootY: number
  prevFootOk: boolean
  bounce: number[]
  banner: { text: string; at: number } | null
}

function newP(): PState {
  return {
    score: 0,
    combo: 0,
    maxCombo: 0,
    perfect: 0,
    hit: 0,
    passed: 0,
    missPtr: 0,
    cd: DRUMS.map(() => [-10, -10]),
    lastKick: -10,
    prevFootY: 0,
    prevFootOk: false,
    bounce: [0, 0, 0, 0, 0],
    banner: null,
  }
}

class AirDrums extends BaseGame implements Game {
  bg = 'stage'
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  period = 60 / this.cfg.bpm
  /** 总拍数 O = floor((duration - offset - 1.5)/period)：easy 106 / medium 130 / hard 153 */
  beats = Math.floor((DURATION - OFFSET - 1.5) / this.period)
  notes: Note[] = []
  ps = [newP(), newP()]
  floats: { text: string; x: number; y: number; at: number; color: string }[] = []
  rings: { x: number; y: number; r: number; at: number }[] = []
  anchor = [
    { x: this.W * 0.5, y: this.H * 0.42, ready: false },
    { x: this.W * 0.25, y: this.H * 0.42, ready: false },
  ]
  lastBeat = -99

  constructor(ctx: GameContext) {
    super(ctx)
    const rng = mulberry(11)
    let lastKept: { beat: number; lane: number } | null = null
    let lastHandBeat = [-1, -1] // 同手（0/2 左手、1/3 右手）上次音符拍位
    let lastKickBeat = -1
    for (const g of genNotes(this.beats, 5, this.cfg.density, rng)) {
      // lane 重派：底鼓按 kickRate 保留为“跳”，否则改派为手鼓（floor(rng()*4)）
      let lane = g.lane
      if (lane === KICK_LANE && rng() > this.cfg.kickRate) lane = Math.floor(rng() * 4)
      // 间距过滤（不满足则丢弃）
      if (lastKept && g.beat - lastKept.beat < 0.5) continue // 全局最密半拍连打
      if (lane === KICK_LANE) {
        if (g.beat - lastKickBeat < 2) continue // 距上次底鼓 <2 拍（体力保护）
        if (lastKept && g.beat - lastKept.beat < 1) continue // 距前一音符 <1 拍
      } else {
        const hand = lane % 2
        if (lastHandBeat[hand] >= 0 && g.beat - lastHandBeat[hand] < 1) continue // 距同手上次 <1 拍
        if (lastKickBeat >= 0 && g.beat - lastKickBeat < 1) continue // 距上次底鼓 <1 拍
      }
      this.notes.push({ beat: g.beat, lane, t: OFFSET + g.beat * this.period, done: ['', ''], missAt: [0, 0] })
      lastKept = { beat: g.beat, lane }
      if (lane === KICK_LANE) lastKickBeat = g.beat
      else lastHandBeat[lane % 2] = g.beat
    }
    this.ctx.speak('音符掉到哪个鼓，就敲哪个！')
  }

  private unit() {
    return this.H / 720
  }

  private present() {
    return this.players.filter((p) => p.body).length
  }

  tick(_f: PoseFrame, dt: number) {
    const now = this.t
    // 节拍器：每拍 tick（给听觉参照）
    const bi = Math.floor((now - OFFSET) / this.period)
    if (bi !== this.lastBeat && bi >= 0) {
      this.lastBeat = bi
      this.ctx.audio.tick()
    }

    const present = this.present()

    for (let pi = 0; pi < 2; pi++) {
      const st = this.ps[pi]
      const pv = this.players[pi]
      const b = pv.body
      if (!b) {
        st.prevFootOk = false
        continue
      }
      const z = this.zoneOf(present, pi)
      // 鼓组锚点：肩中心；躯干长下限 40px、鼓组缩放 clamp(躯干, 70unit, 260unit)
      const torsoPx = Math.max(40, b.scale * this.H)
      const T = Math.min(260 * this.unit(), Math.max(70 * this.unit(), torsoPx))
      const a = this.anchor[pi]
      if (!a.ready) {
        a.ready = true
        a.x = b.shoulderC.x * this.W
        a.y = b.shoulderC.y * this.H
      }
      a.x += (b.shoulderC.x * this.W - a.x) * Math.min(1, dt * 10)
      a.y += (b.shoulderC.y * this.H - a.y) * Math.min(1, dt * 10)
      const ax = a.x
      const ay = a.y

      // ---- 手鼓/镲触发：手在环内 + 方向/速度阈值 +（手，鼓）冷却 0.25s ----
      const handR = Math.min(26 * this.unit(), Math.max(12 * this.unit(), torsoPx * 0.14))
      const hands = [pv.lHand, pv.rHand]
      const torsoNorm = Math.max(0.05, torsoPx / this.H)
      const vy = [handVyTorso(pv.lHand.trail, dt, torsoNorm), handVyTorso(pv.rHand.trail, dt, torsoNorm)]
      const spd = [handSpeedTorso(pv.lHand.trail, dt, torsoNorm), handSpeedTorso(pv.rHand.trail, dt, torsoNorm)]
      for (let d = 0; d < 4; d++) {
        const def = DRUMS[d]
        const { x, y } = this.drumPos(d, ax, ay, T, z)
        const r = def.r * T
        for (let hi = 0; hi < 2; hi++) {
          if (Math.hypot(hands[hi].x - x, hands[hi].y - y) > r + handR * 0.7) continue
          const v = def.kind === 'drum' ? vy[hi] : spd[hi]
          if (v <= (def.kind === 'drum' ? DRUM_DOWN : CYM_SPEED)) continue
          if (now - st.cd[d][hi] < HAND_CD) continue
          st.cd[d][hi] = now
          this.trigger(pi, d, now, x, y, r)
        }
      }
      // 底鼓：跳跃事件 或 任一脚竖直速度 > 2.5（跺脚）；冷却 0.45s
      const fy = Math.max(b.lFoot.y, b.rFoot.y)
      let footVy = 0
      if (st.prevFootOk && dt > 0) footVy = ((fy - st.prevFootY) * this.H) / dt / torsoNorm
      st.prevFootY = fy
      st.prevFootOk = true
      if ((b.jumping || footVy > KICK_SPEED) && now - st.lastKick >= KICK_CD) {
        st.lastKick = now
        const { x, y } = this.drumPos(KICK_LANE, ax, ay, T, z)
        this.trigger(pi, KICK_LANE, now, x, y, DRUMS[KICK_LANE].r * T)
      }

      for (let d = 0; d < 5; d++) st.bounce[d] = Math.max(0, st.bounce[d] - dt * 5)
    }

    // ---- 漏拍：note.t < now - .24 仍未判定 → miss、连击清零 ----
    for (let pi = 0; pi < 2; pi++) {
      const st = this.ps[pi]
      const has = Boolean(this.players[pi].body)
      while (st.missPtr < this.notes.length) {
        const n = this.notes[st.missPtr]
        if (n.t >= now - WIN.ok) break
        if (has && !n.done[pi]) {
          n.done[pi] = 'miss'
          n.missAt[pi] = now
          st.passed++
          st.combo = 0
        }
        st.missPtr++
      }
    }

    for (let i = this.floats.length - 1; i >= 0; i--) if (now - this.floats[i].at > 0.7) this.floats.splice(i, 1)
    for (let i = this.rings.length - 1; i >= 0; i--) if (now - this.rings[i].at > 0.24) this.rings.splice(i, 1)

    const tot = this.ps.reduce((n, p) => n + p.score, 0)
    this.ctx.setScore(tot)
    this.ctx.setCombo(Math.max(this.ps[0].combo, this.ps[1].combo))
    this.ctx.setExtra('最大连击', Math.max(this.ps[0].maxCombo, this.ps[1].maxCombo))
    this.ctx.setExtra('完美', this.ps.reduce((n, p) => n + p.perfect, 0))
    const hit = this.ps.reduce((n, p) => n + p.hit, 0)
    const passed = this.ps.reduce((n, p) => n + p.passed, 0)
    this.ctx.setExtra('准确率', passed ? Math.round((hit / passed) * 100) : 100)
  }

  private zoneOf(present: number, pi: number) {
    if (present <= 1) return { x0: this.W * 0.08, x1: this.W * 0.92 }
    return pi === 0 ? { x0: this.W * 0.03, x1: this.W * 0.47 } : { x0: this.W * 0.53, x1: this.W * 0.97 }
  }

  /** 鼓位：锚点 + ox/oy×T，x 夹在 zone 内（预留半径），底鼓贴地 min(y, H-r-8unit) */
  private drumPos(d: number, ax: number, ay: number, T: number, z: { x0: number; x1: number }) {
    const def = DRUMS[d]
    const r = def.r * T
    const x = Math.min(z.x1 - r, Math.max(z.x0 + r, ax + def.ox * T))
    let y = ay + def.oy * T
    if (def.kind === 'kick') y = Math.min(y, this.H - r - 8 * this.unit())
    return { x, y }
  }

  /** 命中判定：按 lane 找「未判定 + |now - t| ≤ ok + 最近」的音符（扫描止于 0.54s） */
  private trigger(pi: number, lane: number, now: number, x: number, y: number, r: number) {
    const st = this.ps[pi]
    let target: Note | null = null
    let best = 1e9
    for (const n of this.notes) {
      if (n.lane !== lane || n.done[pi]) continue
      if (n.t - now > WIN.ok + 0.3) break
      const d = Math.abs(now - n.t)
      if (d <= WIN.ok && d < best) {
        best = d
        target = n
      }
    }
    const color = DRUMS[lane].color
    st.bounce[lane] = 1
    this.playDrum(lane)
    if (!target) return // 敲错鼓/敲空：静默忽略（原站行为，不计 ok/miss）
    const judge = grade(now - target.t)
    target.done[pi] = judge
    target.missAt[pi] = now
    st.combo++
    st.maxCombo = Math.max(st.maxCombo, st.combo)
    st.hit++
    st.passed++
    if (judge === 'perfect') st.perfect++
    st.score += SCORE_OF[judge] + comboBonus(st.combo)
    this.floats.push({ text: JUDGE_TEXT[judge], x, y: y - r - 8, at: now, color: JUDGE_COLOR[judge] })
    this.rings.push({ x, y, r: r * 1.2, at: now })
    // 粒子：perfect 12 颗星形 / good 6 颗圆点，速度 280×unit，颜色 = 鼓色+白
    if (judge === 'perfect') {
      this.particles.burst(x, y, color, 6, 280 * this.unit(), 5, 620, '⭐')
      this.particles.burst(x, y, '#ffffff', 6, 280 * this.unit(), 4)
    } else if (judge === 'good') {
      this.particles.burst(x, y, color, 6, 280 * this.unit(), 4)
    }
    if (st.combo > 0 && st.combo % 10 === 0) {
      st.banner = { text: `连击 ×${st.combo}！`, at: now }
      this.ctx.audio.combo()
    }
    this.ctx.setCombo(st.combo)
  }

  /** 五件套音效：crack / boop / tick / chime / thud（用采样库近似） */
  private playDrum(lane: number) {
    const a = this.ctx.audio
    if (lane === 0) a.play('hit', 0.8, 1.2)
    else if (lane === 1) a.pop()
    else if (lane === 2) a.tick()
    else if (lane === 3) a.play('combo', 0.5, 1.4)
    else a.play('drop', 0.9, 0.8)
  }

  paint(c: CanvasRenderingContext2D) {
    const now = this.t
    const present = this.present()
    // Beat.pulse 驱动鼓面随拍微缩放（±2%）
    const frac = ((now - OFFSET) / this.period) % 1
    const pulse = frac < 0 ? 0 : Math.max(0, 1 - frac * 2.2)

    for (let pi = 0; pi < 2; pi++) {
      const b = this.players[pi].body
      if (!b && pi > 0) continue
      const st = this.ps[pi]
      const z = this.zoneOf(present, pi)
      const a = this.anchor[pi]
      const ax = b && a.ready ? a.x : (z.x0 + z.x1) / 2
      const ay = b && a.ready ? a.y : this.H * 0.42
      const torsoPx = b ? Math.max(40, b.scale * this.H) : this.H * 0.22
      const T = Math.min(260 * this.unit(), Math.max(70 * this.unit(), torsoPx))
      const handR = Math.min(26 * this.unit(), Math.max(12 * this.unit(), torsoPx * 0.14))

      // 竖直虚线引导（alpha .22）
      c.save()
      c.setLineDash([10, 12])
      c.lineWidth = 3
      for (let d = 0; d < 5; d++) {
        const { x, y } = this.drumPos(d, ax, ay, T, z)
        c.globalAlpha = 0.22
        c.strokeStyle = DRUMS[d].color
        c.beginPath()
        c.moveTo(x, 0)
        c.lineTo(x, y)
        c.stroke()
      }
      c.restore()

      // 鼓件
      for (let d = 0; d < 5; d++) {
        const def = DRUMS[d]
        const { x, y } = this.drumPos(d, ax, ay, T, z)
        const r = def.r * T
        const scale = 1 + 0.02 * pulse + 0.14 * st.bounce[d]
        c.save()
        c.translate(x, y)
        c.scale(scale, scale)
        glow(c, 0, 0, r * 1.6, def.color, 0.22)
        if (def.kind === 'cymbal') {
          c.beginPath()
          c.ellipse(0, 0, r, r * 0.4, 0, 0, Math.PI * 2)
          c.fillStyle = def.color
          c.fill()
          c.strokeStyle = 'rgba(120,80,0,.55)'
          c.lineWidth = 3
          c.stroke()
          c.fillStyle = 'rgba(255,255,255,.35)'
          c.beginPath()
          c.ellipse(-r * 0.3, -r * 0.12, r * 0.4, r * 0.14, -0.3, 0, Math.PI * 2)
          c.fill()
        } else {
          const g = c.createRadialGradient(-r * 0.3, -r * 0.4, r * 0.1, 0, 0, r)
          g.addColorStop(0, def.kind === 'kick' ? '#7db4ff' : '#ff9d9d')
          g.addColorStop(1, def.color)
          circle(c, 0, 0, r, '#000')
          c.beginPath()
          c.arc(0, 0, r, 0, Math.PI * 2)
          c.fillStyle = g
          c.fill()
          c.strokeStyle = 'rgba(20,24,60,.45)'
          c.lineWidth = 4
          c.stroke()
          c.beginPath()
          c.ellipse(0, -r * 0.28, r * 0.66, r * 0.34, 0, 0, Math.PI * 2)
          c.fillStyle = 'rgba(255,255,255,.32)'
          c.fill()
        }
        c.restore()
        // 判定环
        c.globalAlpha = 0.4
        c.beginPath()
        c.arc(x, y, r + handR * 0.4, 0, Math.PI * 2)
        c.strokeStyle = 'rgba(255,255,255,.4)'
        c.lineWidth = 2.5
        c.stroke()
        c.globalAlpha = 1
      }

      // 音符从屏幕顶落向鼓面：p = drumY - (剩余/approach)×(drumY + 2r)；miss 灰化渐隐 0.45s
      for (const n of this.notes) {
        const dn = n.done[pi]
        if (dn === 'perfect' || dn === 'good' || dn === 'ok') continue
        const { x, y } = this.drumPos(n.lane, ax, ay, T, z)
        const nr = Math.min(44 * this.unit(), Math.max(16 * this.unit(), DRUMS[n.lane].r * T * 0.55))
        const alpha = dn === 'miss' ? Math.max(0, 1 - (now - n.missAt[pi]) / 0.45) : 1
        if (alpha <= 0) continue
        const p = y - (Math.max(0, n.t - now) / this.cfg.approach) * (y + nr * 2)
        c.save()
        c.globalAlpha = alpha
        c.translate(x, p)
        glow(c, 0, 0, nr * 2, dn === 'miss' ? '#9a8ba8' : DRUMS[n.lane].color, dn === 'miss' ? 0.1 : 0.32)
        c.beginPath()
        c.arc(0, 0, nr, 0, Math.PI * 2)
        c.fillStyle = dn === 'miss' ? '#9a8ba8' : '#ffffff'
        c.fill()
        c.strokeStyle = dn === 'miss' ? '#9a8ba8' : DRUMS[n.lane].color
        c.lineWidth = 4
        c.stroke()
        if (dn !== 'miss') this.drawNoteGlyph(c, 0, 0, nr * 2.4, DRUMS[n.lane].color)
        c.restore()
      }

      // 命中白圈扩散（半径 ×1.2）
      for (const rg of this.rings) {
        const k = (now - rg.at) / 0.24
        c.save()
        c.globalAlpha = (1 - k) * 0.8
        c.strokeStyle = '#ffffff'
        c.lineWidth = 5 * (1 - k) + 2
        c.beginPath()
        c.arc(rg.x, rg.y, rg.r * (1 + k * 0.5), 0, Math.PI * 2)
        c.stroke()
        c.restore()
      }

      // 判定浮字：0.7s 上浮渐隐（36→30×unit）
      for (const fl of this.floats) {
        const k = (now - fl.at) / 0.7
        c.save()
        c.globalAlpha = 1 - k
        outlineTxt(c, fl.text, fl.x, fl.y - k * 30 * this.unit(), 36 - 6 * k, fl.color)
        c.restore()
      }

      // 连击：≥2 底部显示「连击 N」（字号 30+min(14,combo)）；每 10 连击横幅 900ms
      if (st.combo >= 2) {
        outlineTxt(c, `连击 ${st.combo}`, (z.x0 + z.x1) / 2, this.H - 64, 30 + Math.min(14, st.combo), '#ffd54a')
      }
      if (st.banner && now - st.banner.at < 0.9) {
        outlineTxt(c, st.banner.text, (z.x0 + z.x1) / 2, this.H * 0.24, 52, '#ffd54a')
      }
    }

    if (present === 0) {
      outlineTxt(c, '站到镜头前，身边会出现一套鼓', this.W / 2, this.H * 0.5, 34, '#ffffff')
    }
    txt(c, '音符掉到哪个鼓敲哪个：鼓往下砸、镲快挥、底鼓就跳', this.W / 2, this.H - 26, 20, 'rgba(255,255,255,.8)', 'center', 'bold')
  }

  private drawNoteGlyph(c: CanvasRenderingContext2D, x: number, y: number, size: number, color: string) {
    c.fillStyle = color
    c.beginPath()
    c.ellipse(x - size * 0.12, y + size * 0.16, size * 0.16, size * 0.12, -0.4, 0, Math.PI * 2)
    c.fill()
    c.strokeStyle = color
    c.lineWidth = Math.max(2, size * 0.09)
    c.beginPath()
    c.moveTo(x + size * 0.04, y + size * 0.12)
    c.lineTo(x + size * 0.04, y - size * 0.3)
    c.stroke()
  }
}

/** 手竖直速度（躯干/秒）：Cursor.trail 最近两点，向下为正 */
function handVyTorso(trail: { x: number; y: number }[], dt: number, torsoNorm: number) {
  if (trail.length < 2 || dt <= 0) return 0
  const a = trail[trail.length - 2]
  const b = trail[trail.length - 1]
  return (b.y - a.y) / dt / torsoNorm
}

/** 手合成速度（躯干/秒）：任意方向 */
function handSpeedTorso(trail: { x: number; y: number }[], dt: number, torsoNorm: number) {
  if (trail.length < 2 || dt <= 0) return 0
  const a = trail[trail.length - 2]
  const b = trail[trail.length - 1]
  return Math.hypot(b.x - a.x, b.y - a.y) / dt / torsoNorm
}

export default function create(ctx: GameContext): Game {
  return new AirDrums(ctx)
}
