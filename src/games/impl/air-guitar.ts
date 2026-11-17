import { BaseGame } from '@/core/base'
import type { Game, GameContext, PoseFrame } from '@/core/types'
import { glow, outlineTxt, rr, txt } from '@/core/draw'

/**
 * 摇滚吉他（对齐 dongdongpark 真实规则）：
 * 一只手按琴颈品位（手高度三档：肩上=高音、肩下 .42T=低音，0.05 磁滞），
 * 另一只手腰前上下扫弦（方向必须交替，阈值 2 躯干/秒）。
 * 音符横向滚入判定线（每拍走 3 个半径）；匹配窗 e.ok=.24；
 * 分值 3/2/1 + min(3, floor(combo/10))；品位不对断连击、5 连空扫断连击；
 * 连击 ≥5 起火；内置鼓机（2×BPM 时钟）伴奏。
 */

type Judge = 'perfect' | 'good' | 'ok' | 'miss'

const WIN = { perfect: 0.08, good: 0.16, ok: 0.24 }
const WIN_OK = 0.24
const SCORE_OF: Record<Judge, number> = { perfect: 3, good: 2, ok: 1, miss: 0 }
const JUDGE_TEXT: Record<Judge, string> = { perfect: '完美！', good: '很好', ok: '还行', miss: '错过' }
const JUDGE_COLOR: Record<Judge, string> = { perfect: '#ffd93d', good: '#6bcb77', ok: '#4d96ff', miss: '#9a8ba8' }

function grade(delta: number): Judge {
  const a = Math.abs(delta)
  if (a <= WIN.perfect) return 'perfect'
  if (a <= WIN.good) return 'good'
  if (a <= WIN.ok) return 'ok'
  return 'miss'
}
function comboBonus(combo: number) {
  return Math.min(3, Math.floor(combo / 10))
}
function mulberry(seed: number) {
  let s = seed | 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let z = Math.imul(s ^ (s >>> 15), 1 | s)
    z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) ^ z
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296
  }
}

/** 对齐站点难度表 S */
const DIFF = [
  { bpm: 80, seg: 4, first: 1, fill: 0.5, half: 0, approach: 2.3 },
  { bpm: 96, seg: 2, first: 1, fill: 0.4, half: 0, approach: 1.9 },
  { bpm: 116, seg: 1, first: 0.8, fill: 0.8, half: 0.18, approach: 1.5 },
]

const DURATION = 75
const OFFSET = 3 // Beat 时钟偏移（秒）
const STRUM_DOWN = 2 // 下扫触发：扫弦手竖直速度阈值（躯干/秒）
const STROKE_RESET = 0.8 // |速度| 低于该值时清空 stroke 状态
const STRUM_CD = 0.1 // 两次扫弦最小间隔（秒）
const IDLE_LIMIT = 5 // 连续空扫次数达该值 → 断连击并提示「别乱扫」
const ROOT_CYCLE = 32 // 和弦根音循环周期（每 32 拍换根音）
const ROOTS = [52, 57, 50, 55] // 根音 MIDI 循环（E3/A3/D3/G3）
const FRET_HI = -0.12 // 品位分区：l < -.12 → lane2（高）
const FRET_LO = 0.42 // l > .42 → lane0（低）
const FRET_HYST = 0.05 // 磁滞带宽
const SWAP_GAP = 0.3 // 换琴颈手：差距 > .3×躯干
const SWAP_T = 0.35 // 持续 .35s 才切换

/** 3 条品位 lane：屏上高度偏移 oy、音高步进 step、颜色 */
const LANES = [
  { oy: 0.68, step: 0, color: '#4cc9f0' },
  { oy: 0.15, step: 5, color: '#3ddc97' },
  { oy: -0.42, step: 7, color: '#ff9f43' },
]

/** 和弦进行库 C：8 组 × 4 个品位 lane */
const PROGS: number[][] = [
  [0, 1, 2, 1],
  [0, 2, 1, 0],
  [1, 2, 0, 1],
  [2, 1, 0, 2],
  [0, 1, 0, 2],
  [2, 0, 1, 0],
  [1, 0, 2, 1],
  [0, 2, 0, 1],
]

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

interface Note {
  beat: number
  t: number
  lane: number
  midi: number
  name: string
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
  fret: number
  stroke: number // 1 下扫 / -1 上扫 / 0 无
  lastStrum: number
  idle: number
  badLane: number
  badUntil: number
  neckHand: number // 0 左 1 右
  swapT: number
  laneFlash: number[]
  missPtr: number
  fire: number
  boomUntil: number
  pickupAt: number
  banner: { text: string; at: number } | null
  anchor: { x: number; y: number; hip: number; ready: boolean }
}

function newP(): PState {
  return {
    score: 0, combo: 0, maxCombo: 0, perfect: 0, hit: 0, passed: 0,
    fret: 1, stroke: 0, lastStrum: -10, idle: 0, badLane: -1, badUntil: 0,
    neckHand: 0, swapT: 0, laneFlash: [0, 0, 0], missPtr: 0, fire: 0, boomUntil: 0,
    pickupAt: -10, banner: null, anchor: { x: 0, y: 0, hip: 0, ready: false },
  }
}

class AirGuitar extends BaseGame implements Game {
  bg = 'stage'
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  period = 60 / this.cfg.bpm
  /** 总拍数 L = floor((75 - 3 - 1.5)/period) */
  beats = Math.floor((DURATION - OFFSET - 1.5) / this.period)
  notes: Note[] = []
  ps = [newP(), newP()]
  /** 琶音声部队列：到点播放（14ms 逐根触发） */
  soundQ: { midi: number; at: number; player: number }[] = []
  drumHalf = -99 // 鼓机 2×BPM 半拍步进游标
  preTick = -99

  constructor(ctx: GameContext) {
    super(ctx)
    // 音符生成：每 4 个 seg 块换一组和弦进行；和弦 = 进行[blockIdx % 4]
    const rng = mulberry(41)
    let prog = PROGS[Math.floor(rng() * PROGS.length)]
    const push = (beat: number) => {
      const blockIdx = Math.floor(beat / this.cfg.seg)
      if (blockIdx % 4 === 0 && !this.notes.some((n) => Math.floor(n.beat / this.cfg.seg) === blockIdx)) {
        prog = PROGS[Math.floor(rng() * PROGS.length)]
      }
      const lane = prog[blockIdx % 4]
      const p = beat % this.cfg.seg === 0 ? this.cfg.first : this.cfg.fill
      if (rng() >= p) return
      const rootIdx = Math.floor(beat / ROOT_CYCLE) % 4
      const midi = ROOTS[rootIdx] + LANES[lane].step
      this.notes.push({
        beat, t: OFFSET + beat * this.period, lane, midi, name: NOTE_NAMES[midi % 12],
        done: ['', ''], missAt: [0, 0],
      })
    }
    for (let beat = 0; beat < this.beats; beat++) {
      push(beat)
      // hard：half=.18 概率在 beat+.5 加八分音符（同一品位）
      if (this.cfg.half > 0 && rng() < this.cfg.half) push(beat + 0.5)
    }
    this.notes.sort((a, b) => a.t - b.t)
    this.ctx.speak('一手按品位，一手上下扫弦！')
  }

  private unit() {
    return this.H / 720
  }
  private present() {
    return this.players.filter((p) => p.body).length
  }
  private zoneOf(pi: number) {
    const present = this.present()
    if (present <= 1) return { x0: this.W * 0.08, x1: this.W * 0.92 }
    return pi === 0 ? { x0: this.W * 0.03, x1: this.W * 0.47 } : { x0: this.W * 0.53, x1: this.W * 0.97 }
  }

  tick(_f: PoseFrame, dt: number) {
    const now = this.t
    // 鼓机伴奏：独立 2×BPM 时钟（偏移同为 3）；开局前 tick 预拍
    const half = Math.floor((now - OFFSET) / (this.period / 2))
    if (half !== this.drumHalf && half >= 0) {
      this.drumHalf = half
      const beat = half / 2
      const a = this.ctx.audio
      if (beat % 4 === 0) a.play('drop', 0.95, 0.8) // 拍 1 底鼓
      else if (beat % 4 === 2) a.play('hit', 0.7, 1.1) // 拍 3 军鼓
      else if (beat % 2 === 1) a.play('click', 0.5, 1.2) // offbeat 踩镲 crack
      if (beat % ROOT_CYCLE >= ROOT_CYCLE - 2 && beat % 1 === 0.5) a.play('hit', 0.45, 0.85) // 尾段过门
    } else {
      const pre = Math.floor((now - OFFSET) / this.period)
      if (pre !== this.preTick && pre < 0) {
        this.preTick = pre
        this.ctx.audio.tick()
      }
    }
    // 琶音声部队列
    while (this.soundQ.length && this.soundQ[0].at <= now) {
      const s = this.soundQ.shift()!
      this.ctx.audio.tonePop(((s.midi - 69) * 12) / 5)
    }

    const duo = this.present() >= 2
    for (let pi = 0; pi < 2; pi++) {
      const st = this.ps[pi]
      const pv = this.players[pi]
      const b = pv.body
      if (!b) {
        st.missPtr = this.notes.length // 不在场不判漏拍
        continue
      }
      const z = this.zoneOf(pi)
      const side = duo ? (pi === 0 ? -1 : 1) : -1 // 琴颈朝 zone 外侧
      const torso = Math.max(40, b.scale * this.H)
      const torsoNorm = Math.max(0.05, torso / this.H)
      const a = st.anchor
      if (!a.ready) {
        a.ready = true
        a.x = b.shoulderC.x * this.W
        a.y = b.shoulderC.y * this.H
        a.hip = b.hipC.x * this.W
      }
      a.x += (b.shoulderC.x * this.W - a.x) * Math.min(1, dt * 8)
      a.y += (b.shoulderC.y * this.H - a.y) * Math.min(1, dt * 8)
      a.hip += (b.hipC.x * this.W - a.hip) * Math.min(1, dt * 8)
      const r = Math.min(96 * this.unit(), Math.max(36 * this.unit(), torso * 0.5)) * 0.4
      // 判定线：肩中心 ± 1.05×躯干，向 zone 边夹紧
      const judgeX = Math.min(z.x1 - r, Math.max(z.x0 + r, a.x + side * 1.05 * torso))
      const laneY = (lane: number) =>
        Math.min(this.H - 80, Math.max(this.H * 0.16, a.y + LANES[lane].oy * torso))

      // ---- 琴颈手认定：离髋水平距离更远者；换手需差距 > .3×躯干 持续 .35s ----
      const dl = Math.abs(b.lHand.x * this.W - a.hip)
      const dr = Math.abs(b.rHand.x * this.W - a.hip)
      const farther = dl >= dr ? 0 : 1
      if (farther !== st.neckHand && Math.abs(dl - dr) > SWAP_GAP * torso) {
        st.swapT += dt
        if (st.swapT >= SWAP_T) {
          st.neckHand = farther
          st.swapT = 0
        }
      } else {
        st.swapT = 0
      }

      // ---- 品位选择（琴颈手高度，肩为原点、躯干为单位，0.05 磁滞）----
      const neckHandY = (st.neckHand === 0 ? b.lHand.y : b.rHand.y) * this.H
      const l = (neckHandY - a.y) / torso
      const hiTh = st.fret === 2 ? FRET_HI + FRET_HYST : FRET_HI
      const loTh = st.fret === 0 ? FRET_LO - FRET_HYST : FRET_LO
      st.fret = l < hiTh ? 2 : l > loTh ? 0 : 1

      // ---- 扫弦触发（非琴颈手；方向必须交替；|n|<.8 复位；冷却 .1s）----
      const strumHand = st.neckHand === 0 ? pv.rHand : pv.lHand
      const strumX = strumHand.x
      const strumY = strumHand.y
      const n = handVyTorso(strumHand.trail, dt, torsoNorm)
      if (Math.abs(n) < STROKE_RESET) st.stroke = 0
      const inWindow =
        Math.abs(strumX - a.hip) < torso && strumY > a.y + 0.15 * torso && strumY < b.hipC.y * this.H + 0.7 * torso
      if (inWindow && now - st.lastStrum >= STRUM_CD) {
        let dir = 0
        if (st.stroke !== 1 && n > STRUM_DOWN) dir = 1
        else if (st.stroke !== -1 && n < -STRUM_DOWN) dir = -1
        if (dir !== 0) {
          st.stroke = dir
          st.lastStrum = now
          this.strum(pi, st.fret, now, strumX, strumY, dir, judgeX, laneY, r)
        }
      }

      // ---- Miss：note.t < now - .24 未判 → miss、断连击（渐隐 0.3s）----
      while (st.missPtr < this.notes.length) {
        const nt = this.notes[st.missPtr]
        if (nt.t >= now - WIN_OK) break
        if (!nt.done[pi]) {
          nt.done[pi] = 'miss'
          nt.missAt[pi] = now
          st.passed++
          st.combo = 0
        }
        st.missPtr++
      }

      // 火焰与特效衰减
      const fireTarget = st.combo >= 5 ? Math.min(1, Math.max(0.2, (st.combo - 2) / 18)) : 0
      st.fire += (fireTarget - st.fire) * Math.min(1, dt * 3)
      for (let k = 0; k < 3; k++) st.laneFlash[k] = Math.max(0, st.laneFlash[k] - dt * 4)
      if (st.badUntil < now) st.badLane = -1
    }

    for (let i = this.floats.length - 1; i >= 0; i--) if (now - this.floats[i].at > 0.7) this.floats.splice(i, 1)
    for (let i = this.sparkles.length - 1; i >= 0; i--) if (now - this.sparkles[i].at > 0.45) this.sparkles.splice(i, 1)

    const tot = this.ps.reduce((n, p) => n + p.score, 0)
    this.ctx.setScore(tot)
    this.ctx.setCombo(Math.max(this.ps[0].combo, this.ps[1].combo))
    this.ctx.setExtra('最大连击', Math.max(this.ps[0].maxCombo, this.ps[1].maxCombo))
    this.ctx.setExtra('完美', this.ps.reduce((n, p) => n + p.perfect, 0))
    const hit = this.ps.reduce((n, p) => n + p.hit, 0)
    const passed = this.ps.reduce((n, p) => n + p.passed, 0)
    this.ctx.setExtra('准确率', passed ? Math.round((hit / passed) * 100) : 100)
  }

  floats: { text: string; x: number; y: number; at: number; color: string }[] = []
  sparkles: { x: number; y: number; at: number }[] = []

  /** 扫弦命中处理：①品位匹配 → 判定 ②有音符但品位错 → 「品位不对」断连 ③空扫计数 */
  private strum(
    pi: number,
    fret: number,
    now: number,
    sx: number,
    sy: number,
    dir: number,
    judgeX: number,
    laneY: (lane: number) => number,
    r: number,
  ) {
    const st = this.ps[pi]
    let anyNote: Note | null = null
    let laneNote: Note | null = null
    let bestAny = 1e9
    let bestLane = 1e9
    for (const n of this.notes) {
      if (n.done[pi]) continue
      if (n.t - now > WIN_OK) break
      const d = Math.abs(now - n.t)
      if (d > WIN_OK) continue
      if (n.lane === fret && d < bestLane) {
        bestLane = d
        laneNote = n
      }
      if (d < bestAny) {
        bestAny = d
        anyNote = n
      }
    }
    this.sparkles.push({ x: sx, y: sy, at: now })
    if (laneNote) {
      const judge = grade(now - laneNote.t)
      laneNote.done[pi] = judge
      laneNote.missAt[pi] = now
      st.combo++
      st.maxCombo = Math.max(st.maxCombo, st.combo)
      st.hit++
      st.passed++
      st.idle = 0
      if (judge === 'perfect') st.perfect++
      st.score += SCORE_OF[judge] + comboBonus(st.combo)
      st.laneFlash[laneNote.lane] = 1
      this.floats.push({
        text: JUDGE_TEXT[judge], x: judgeX, y: laneY(laneNote.lane) - r - 10, at: now, color: JUDGE_COLOR[judge],
      })
      // 粒子：perfect 12 星 / 非 perfect 6 点 + 扫弦处 6 星
      if (judge === 'perfect') {
        this.particles.burst(judgeX, laneY(laneNote.lane), LANES[laneNote.lane].color, 6, 300 * this.unit(), 5, 620, '⭐')
        this.particles.burst(judgeX, laneY(laneNote.lane), '#fff', 6, 300 * this.unit(), 4)
      } else {
        this.particles.burst(judgeX, laneY(laneNote.lane), LANES[laneNote.lane].color, 6, 300 * this.unit(), 4)
      }
      this.particles.burst(sx, sy, '#fff', 3, 260 * this.unit(), 4, 500, '⭐')
      this.arpeggio(pi, laneNote.midi, dir)
      st.pickupAt = now
      if (st.combo > 0 && st.combo % 10 === 0) {
        st.banner = { text: `连击 ×${st.combo}！`, at: now }
        st.boomUntil = now + 1.4 // 每 10 连击火焰爆发
        this.ctx.audio.combo()
        this.particles.burst(judgeX, this.H * 0.4, '#ff9f43', 10, 420 * this.unit(), 5, 400, '🔥')
      }
      this.ctx.setCombo(st.combo)
      return
    }
    if (anyNote) {
      // ②品位不对：不扣分不判定，但连击清零 + 目标 lane 红色抖动 0.5s
      st.combo = 0
      st.idle = 0
      st.badLane = anyNote.lane
      st.badUntil = now + 0.5
      this.floats.push({ text: '品位不对', x: judgeX, y: laneY(anyNote.lane) - r - 10, at: now, color: '#ff5c5c' })
      this.arpeggio(pi, this.fretRoot(now, fret), dir)
      this.ctx.setCombo(0)
      return
    }
    // ③空扫：连续 5 次 → 若连击 > 0 清零并提示「别乱扫」
    st.idle++
    if (st.idle >= IDLE_LIMIT) {
      if (st.combo > 0) {
        st.combo = 0
        this.ctx.setCombo(0)
        this.floats.push({ text: '别乱扫', x: sx, y: sy - 40, at: now, color: '#ff5c5c' })
      }
      st.idle = 0
    }
    this.arpeggio(pi, this.fretRoot(now, fret), dir)
  }

  /** 当前拍位的品位根音 */
  private fretRoot(now: number, fret: number) {
    const beat = Math.max(0, (now - OFFSET) / this.period)
    return ROOTS[Math.floor(beat / ROOT_CYCLE) % 4] + LANES[fret].step
  }

  /** 扫弦琶音：P1 低音组 [root-12, root-5]，P0/单人 [root, root+7, root+12]；上扫反向 */
  private arpeggio(pi: number, root: number, dir: number) {
    const low = pi === 1 && this.present() >= 2
    const midis = low ? [root - 12, root - 5] : [root, root + 7, root + 12]
    if (dir < 0) midis.reverse()
    const t0 = this.t
    midis.forEach((m, i) => this.soundQ.push({ midi: m, at: t0 + i * 0.014, player: pi }))
  }

  paint(c: CanvasRenderingContext2D) {
    const now = this.t
    const duo = this.present() >= 2
    for (let pi = 0; pi < 2; pi++) {
      const pv = this.players[pi]
      const b = pv.body
      if (!b && pi > 0) continue
      const st = this.ps[pi]
      const z = this.zoneOf(pi)
      const side = duo ? (pi === 0 ? -1 : 1) : -1
      const torso = b ? Math.max(40, b.scale * this.H) : this.H * 0.24
      const a = st.anchor
      const ax = b && a.ready ? a.x : (z.x0 + z.x1) / 2
      const ay = b && a.ready ? a.y : this.H * 0.4
      const r = Math.min(96 * this.unit(), Math.max(36 * this.unit(), torso * 0.5)) * 0.4
      const judgeX = Math.min(z.x1 - r, Math.max(z.x0 + r, ax + side * 1.05 * torso))
      const startX = side === -1 ? z.x0 - r * 1.4 : z.x1 + r * 1.4
      const approach = Math.min(this.cfg.approach, Math.max(0.9, (Math.abs(judgeX - startX) * this.period) / (3 * r)))
      const laneY = (lane: number) =>
        Math.min(this.H - 80, Math.max(this.H * 0.16, ay + LANES[lane].oy * torso))

      // 三条品位带（当前品位 alpha .32、其余 .18）+ 白描边
      for (let lane = 0; lane < 3; lane++) {
        const y = laneY(lane)
        const shake = st.badLane === lane ? Math.sin(now * 50) * 8 * this.unit() : 0
        c.save()
        c.globalAlpha = st.fret === lane ? 0.32 : 0.18
        rr(c, z.x0 + 16, y - r * 0.45, z.x1 - z.x0 - 32, r * 0.9, r * 0.45)
        c.fillStyle = st.badLane === lane ? '#ff5c5c' : LANES[lane].color
        c.fill()
        c.restore()
        c.save()
        c.translate(shake, 0)
        rr(c, z.x0 + 16, y - r * 0.45, z.x1 - z.x0 - 32, r * 0.9, r * 0.45)
        c.strokeStyle = st.badLane === lane ? '#ff5c5c' : 'rgba(255,255,255,.4)'
        c.lineWidth = 2
        c.stroke()
        c.restore()
        // 判定目标环
        const flash = st.laneFlash[lane]
        const ringR = r * 0.55 * (1 + flash * 0.3)
        c.save()
        if (st.fret === lane) {
          glow(c, judgeX, y, ringR * 2, LANES[lane].color, 0.4)
          c.beginPath()
          c.arc(judgeX, y, ringR, 0, Math.PI * 2)
          c.fillStyle = LANES[lane].color
          c.globalAlpha = 0.85
          c.fill()
        }
        c.globalAlpha = 1
        c.beginPath()
        c.arc(judgeX, y, ringR, 0, Math.PI * 2)
        c.strokeStyle = flash > 0 ? '#fff' : 'rgba(255,255,255,.6)'
        c.lineWidth = 3 + flash * 3
        c.stroke()
        c.restore()
      }

      // 未来节拍竖线（每 4 拍一条亮线 alpha .6，其余 .28）
      const nowBeat = (now - OFFSET) / this.period
      for (let bt = Math.ceil(nowBeat); bt < nowBeat + this.cfg.approach / this.period + 1; bt++) {
        const rem = bt * this.period - (now - OFFSET)
        if (rem <= 0 || rem > approach) continue
        const x = startX + (1 - rem / approach) * (judgeX - startX)
        c.save()
        c.globalAlpha = bt % 4 === 0 ? 0.6 : 0.28
        c.strokeStyle = '#fff'
        c.lineWidth = bt % 4 === 0 ? 3 : 1.5
        c.beginPath()
        c.moveTo(x, laneY(2) - r)
        c.lineTo(x, laneY(0) + r)
        c.stroke()
        c.restore()
      }

      // 音符：lane 色圆形 + 音名字母，横向滚入；miss 渐隐 0.3s
      for (const n of this.notes) {
        const dn = n.done[pi]
        if (dn === 'perfect' || dn === 'good' || dn === 'ok') continue
        const alpha = dn === 'miss' ? Math.max(0, 1 - (now - n.missAt[pi]) / 0.3) : 1
        if (alpha <= 0) continue
        const rem = n.t - now
        const x = startX + (1 - Math.min(approach, Math.max(0, rem)) / approach) * (judgeX - startX)
        const y = laneY(n.lane)
        c.save()
        c.globalAlpha = alpha
        glow(c, x, y, r * 1.8, dn === 'miss' ? '#9a8ba8' : LANES[n.lane].color, 0.35)
        c.beginPath()
        c.arc(x, y, r * 0.8, 0, Math.PI * 2)
        c.fillStyle = dn === 'miss' ? '#9a8ba8' : LANES[n.lane].color
        c.fill()
        c.strokeStyle = '#fff'
        c.lineWidth = 3
        c.stroke()
        txt(c, n.name, x, y + 1, r * 0.8, '#fff', 'center', '900')
        c.restore()
      }

      // 扫弦拾音光效 0.45s + 扫弦处星点
      if (now - st.pickupAt < 0.45) {
        const k = (now - st.pickupAt) / 0.45
        c.save()
        c.globalAlpha = 1 - k
        glow(c, judgeX, ay, r * 3 * (1 + k), '#fff', 0.4)
        c.restore()
      }
      for (const sp of this.sparkles) {
        const k = (now - sp.at) / 0.45
        if (sp.x < z.x0 || sp.x > z.x1) continue
        c.save()
        c.globalAlpha = (1 - k) * 0.9
        glow(c, sp.x, sp.y, 30 * (1 + k), '#fff', 0.5)
        c.restore()
      }

      // 引导箭头：最近未判音符品位 ≠ 当前品位 → 琴颈手旁小箭头指向目标 lane
      if (b) {
        let pending: Note | null = null
        for (const n of this.notes) {
          if (n.done[pi]) continue
          if (n.t > now) {
            pending = n
            break
          }
        }
        if (pending && pending.lane !== st.fret) {
          const nx = (st.neckHand === 0 ? b.lHand.x : b.rHand.x) * this.W
          const ny = (st.neckHand === 0 ? b.lHand.y : b.rHand.y) * this.H
          const ty = laneY(pending.lane)
          const dirY = ty < ny ? -1 : 1
          c.save()
          c.globalAlpha = 0.5 + 0.3 * Math.sin(now * 8)
          c.fillStyle = LANES[pending.lane].color
          c.beginPath()
          const ax0 = nx + (st.neckHand === 0 ? -34 : 34)
          const ay0 = ny - 30
          c.moveTo(ax0, ay0 + dirY * 16)
          c.lineTo(ax0 - 12, ay0 - dirY * 8)
          c.lineTo(ax0 + 12, ay0 - dirY * 8)
          c.closePath()
          c.fill()
          c.restore()
        }
        // 琴颈手标记：白圈双层描边（当前品位色）
        const nx = (st.neckHand === 0 ? b.lHand.x : b.rHand.x) * this.W
        const ny = (st.neckHand === 0 ? b.lHand.y : b.rHand.y) * this.H
        c.save()
        c.beginPath()
        c.arc(nx, ny, 26, 0, Math.PI * 2)
        c.strokeStyle = LANES[st.fret].color
        c.lineWidth = 5
        c.stroke()
        c.beginPath()
        c.arc(nx, ny, 33, 0, Math.PI * 2)
        c.strokeStyle = 'rgba(255,255,255,.6)'
        c.lineWidth = 2
        c.stroke()
        c.restore()
      }

      // 火焰：连击 ≥5 起火，zone 两缘双火焰柱（72unit 高、sin 抖动）
      if (st.fire > 0.02) {
        for (const ex of [z.x0 + 6, z.x1 - 6]) {
          const h = 72 * this.unit() * st.fire * (1 + Math.sin(now * 13 + ex) * 0.18)
          const g = c.createLinearGradient(0, this.H - 40, 0, this.H - 40 - h)
          g.addColorStop(0, 'rgba(255,120,40,.85)')
          g.addColorStop(0.6, 'rgba(255,200,60,.5)')
          g.addColorStop(1, 'rgba(255,240,180,0)')
          c.fillStyle = g
          const w = 26 * this.unit() * st.fire * (boomK(st.boomUntil, now) + 1)
          c.beginPath()
          c.moveTo(ex - w, this.H - 40)
          c.quadraticCurveTo(ex - w * 0.4 + Math.sin(now * 9) * 6, this.H - 40 - h * 0.6, ex, this.H - 40 - h)
          c.quadraticCurveTo(ex + w * 0.4 + Math.sin(now * 11 + 2) * 6, this.H - 40 - h * 0.6, ex + w, this.H - 40)
          c.closePath()
          c.fill()
        }
      }

      // 判定浮字 / 连击 / 横幅
      for (const fl of this.floats) {
        if (fl.x < z.x0 - 60 || fl.x > z.x1 + 60) continue
        const k = (now - fl.at) / 0.7
        c.save()
        c.globalAlpha = 1 - k
        outlineTxt(c, fl.text, fl.x, fl.y - k * 28, 36 - 6 * k, fl.color)
        c.restore()
      }
      if (st.combo >= 2) {
        outlineTxt(c, `连击 ${st.combo}`, (z.x0 + z.x1) / 2, this.H - 64, 30 + Math.min(14, st.combo), '#ffd54a')
      }
      if (st.banner && now - st.banner.at < 0.9) {
        outlineTxt(c, st.banner.text, (z.x0 + z.x1) / 2, this.H * 0.22, 50, '#ffd54a')
      }
    }

    if (this.present() === 0) {
      outlineTxt(c, '站到镜头前，抱起你的空气吉他', this.W / 2, this.H * 0.5, 34, '#ffffff')
    }
    txt(
      c,
      '琴颈手抬高=高音、放低=低音；扫弦手上下交替扫；音符到线时品位对、扫一下',
      this.W / 2, this.H - 24, 20, 'rgba(255,255,255,.8)', 'center', 'bold',
    )
  }
}

function boomK(boomUntil: number, now: number) {
  return boomUntil > now ? Math.min(1.4, (boomUntil - now) / 1.4) : 0
}

function handVyTorso(trail: { x: number; y: number }[], dt: number, torsoNorm: number) {
  if (trail.length < 2 || dt <= 0) return 0
  const a = trail[trail.length - 2]
  const b = trail[trail.length - 1]
  return (b.y - a.y) / dt / torsoNorm
}

export default function create(ctx: GameContext): Game {
  return new AirGuitar(ctx)
}
