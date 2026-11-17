import { BaseGame } from '@/core/base'
import type { Game, GameContext, PoseFrame } from '@/core/types'
import { glow, outlineTxt, rr, txt } from '@/core/draw'

/**
 * 空中钢琴（对齐 dongdongpark 真实规则）：
 * 胸前一排彩色琴键，音符落到键上用手往下按（下压 >1.2 躯干/秒，抬手重新武装）。
 * 8 首简谱儿歌循环；过密装饰音系统自动代弹（auto）；hard 单人长音插和弦加键；
 * 双人四手联弹：键盘左右分工 + 系统给对方插伴奏和弦。
 * 判定：匹配窗 = .24×loose，偏差按 d/loose 压缩后分级（perfect ≤.08 / good ≤.16 / ok ≤.24）。
 */

type Judge = 'perfect' | 'good' | 'ok' | 'miss'

const WIN = { perfect: 0.08, good: 0.16, ok: 0.24 }
const SCORE_OF: Record<Judge, number> = { perfect: 3, good: 2, ok: 1, miss: 0 }
const JUDGE_TEXT: Record<Judge, string> = { perfect: '完美！', good: '很好', ok: '还行', miss: '错过' }
const JUDGE_COLOR: Record<Judge, string> = { perfect: '#ffd93d', good: '#6bcb77', ok: '#4d96ff', miss: '#9a8ba8' }
/** 连击加成步长 N=10、封顶 3 */
const COMBO_STEP = 10

function grade(delta: number): Judge {
  const a = Math.abs(delta)
  if (a <= WIN.perfect) return 'perfect'
  if (a <= WIN.good) return 'good'
  if (a <= WIN.ok) return 'ok'
  return 'miss'
}
function comboBonus(combo: number) {
  return Math.min(3, Math.floor(combo / COMBO_STEP))
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

/** 对齐站点难度表 E：键数/键宽×躯干/bpm/提前量/最小间隔/判定放宽/和弦开关/曲库 */
const DIFF = [
  {
    keys: 5, kw: 0.42, bpm: 80, approach: 2.4, minGap: 0.55, loose: 1.4, chords: false,
    pool: ['joy', 'bee', 'lamb', 'bells'],
  },
  {
    keys: 6, kw: 0.38, bpm: 96, approach: 2, minGap: 0.45, loose: 1.2, chords: false,
    pool: ['twinkle', 'tigers', 'bridge', 'joy', 'bells'],
  },
  {
    keys: 7, kw: 0.34, bpm: 104, approach: 1.6, minGap: 0.27, loose: 1, chords: true,
    pool: ['newyear', 'twinkle', 'tigers', 'joy', 'bells'],
  },
]

// 全局字面量（源码照抄）
const D = 1.2 // 按键触发：手竖直下压速度阈值（躯干长/秒）
const O = 0.3 // 重新武装：手上抬/减速到该值以下才允许再次按
const K_CD = 0.1 // 同手两次按键冷却（秒）
const A_OFF = 0.38 // 键盘顶边相对锚点的纵向偏移（×T）
const KH = 0.42 // 琴键高度（×T）
const M_TOL = 0.2 // 手指纵向容差（×T）：键顶上方 0.2T 内仍算按在键上
const DURATION = 75
/** MIDI 基音 72（C5）+ 大调音阶半音表：T(deg,oct) = 72 + C[deg-1] + 12*oct */
const MIDI_BASE = 72
const SCALE = [0, 2, 4, 5, 7, 9, 11]

/** 和弦表 x：音级 → 三和弦音级（含八度偏移） */
const CHORDS: Record<number, [number, number][]> = {
  1: [[1, 0], [3, 0], [5, 0]],
  2: [[2, 0], [4, 0], [6, 0]],
  3: [[3, 0], [5, 0], [7, 0]],
  4: [[4, 0], [6, 0], [1, 1]],
  5: [[5, 0], [7, 0], [2, 1]],
  6: [[6, 0], [1, 1], [3, 1]],
  7: [[7, 0], [2, 1], [4, 1]],
}

const KEY_COLORS = ['#ff5c8a', '#ff9f43', '#ffd93d', '#6bcb77', '#4cc9f0', '#9b5de5', '#ff8fb1']

interface Song {
  name: string
  bar: number
  tempo?: number
  notes: string
}

/** 曲库 _：8 首简谱曲。记谱 ^([0-7])([,']*)(_*)(\.?)(-*)$：_ 半拍、. 附点、- 延音 +1 拍 */
const SONGS: Record<string, Song> = {
  twinkle: {
    name: '小星星', bar: 4,
    notes: '1 1 5 5 6 6 5- 4 4 3 3 2 2 1- 5 5 4 4 3 3 2- 5 5 4 4 3 3 2- 1 1 5 5 6 6 5- 4 4 3 3 2 2 1-',
  },
  tigers: {
    name: '两只老虎', bar: 4,
    notes: "1 2 3 1 1 2 3 1 3 4 5- 3 4 5- 5' 6' 5' 4' 3 1 5' 6' 5' 4' 3 1 2 5, 1- 2 5, 1-",
  },
  joy: {
    name: '欢乐颂', bar: 4,
    notes: '3 3 4 5 5 4 3 2 1 1 2 3 3. 2 2- 3 3 4 5 5 4 3 2 1 1 2 3 2. 1 1-',
  },
  bee: {
    name: '小蜜蜂', bar: 4,
    notes: '5 3 3 4 2 2 1 2 3 4 5 5 5- 5 3 3 4 2 2 1 2 3 4 5 5 1-',
  },
  lamb: {
    name: '玛丽有只小羊羔', bar: 4,
    notes: '3 2 1 2 3 3 3- 2 2 2- 3 5 5- 3 2 1 2 3 3 3 3 2 2 3 2 1-',
  },
  bells: {
    name: '铃儿响叮当', bar: 4,
    notes: '3 3 3- 3 3 3- 3 5 1 2 3-- 4 4 4- 4 4 3- 3 3 2- 2 3 2-- 3 3 3- 3 3 3- 3 5 1 2 3-- 4 4 4- 4 4 3- 5 5 4- 2 1--',
  },
  bridge: {
    name: '伦敦桥', bar: 4,
    notes: '5 6 5 4 3 4 5- 2 3 4- 3 4 5- 5 6 5 4 3 4 5- 2 5, 3 1-',
  },
  newyear: {
    name: '新年好', bar: 4, tempo: 1.5,
    notes: '1 1 1 5 3 3 3 1 1 3 5 5 4 3 2- 2 3 4 4 4 3 2 5 1 2 3 2 1--',
  },
}

const TOKEN_RE = /^([0-7])([,']*)(_*)(\.?)(-*)$/

interface RawNote {
  beat: number
  deg: number
  oct: number
  len: number
}

function parseSong(song: Song): RawNote[] {
  const out: RawNote[] = []
  let beat = 0
  for (const tok of song.notes.split(/\s+/)) {
    const m = TOKEN_RE.exec(tok)
    if (!m) continue
    const deg = Number(m[1])
    const oct = (m[2].match(/'/g)?.length ?? 0) - (m[2].match(/,/g)?.length ?? 0)
    const half = 0.5 ** m[3].length
    const len = half * (m[4] ? 1.5 : 1) + m[5].length
    if (deg >= 1) out.push({ beat, deg, oct, len })
    beat += len
  }
  return out
}

interface Note {
  id: number
  t: number
  lane: number
  midi: number
  beat: number
  len: number
  songIdx: number
  auto: boolean
  lead: number
  extra: boolean
  owner: number
  done: Judge | ''
  missAt: number
}

interface FloatFx {
  text: string
  x: number
  y: number
  at: number
  color: string
  size: number
}

interface PState {
  score: number
  combo: number
  maxCombo: number
  perfect: number
  hit: number
  judged: number
  armed: [boolean, boolean]
  lastPress: number[]
  keyFlash: number[]
  songs: Set<string>
  anchor: { x: number; y: number; ready: boolean }
}

function newP(): PState {
  return {
    score: 0, combo: 0, maxCombo: 0, perfect: 0, hit: 0, judged: 0,
    armed: [true, true], lastPress: [-10, -10], keyFlash: [0, 0, 0, 0, 0, 0, 0],
    songs: new Set(), anchor: { x: 0, y: 0, ready: false },
  }
}

class AirPiano extends BaseGame implements Game {
  bg = 'stage'
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  notes: Note[] = []
  /** 曲目时间轴（进度条 + 曲名横幅） */
  spans: { name: string; start: number; end: number }[] = []
  ps = [newP(), newP()]
  floats: FloatFx[] = []
  ringsFx: { x: number; y: number; at: number }[] = []
  banner: { text: string; at: number } | null = null
  curSpan = -1
  flashT = 0
  lastComboMilestone = 0

  constructor(ctx: GameContext) {
    super(ctx)
    this.buildChart()
    this.ctx.speak('音符落到琴键上，用手往下按！')
  }

  private unit() {
    return this.H / 720
  }

  private present() {
    return this.players.filter((p) => p.body).length
  }

  /** 曲目调度 + 音符展开（auto 代弹 / hard 和弦加键 / 双人伴奏分配） */
  private buildChart() {
    const cfg = this.cfg
    const duo = this.ctx.meta.mode !== 'solo'
    const order0 = cfg.pool.filter((id) => {
      const maxDeg = Math.max(...parseSong(SONGS[id]).map((n) => n.deg))
      return maxDeg <= cfg.keys
    })
    const rng = mulberry(1)
    const order: Song[] = []
    const bag = order0.map((id) => SONGS[id])
    while (bag.length) order.push(...bag.splice(Math.floor(rng() * bag.length), 1))

    const keys = cfg.keys
    const B = Math.ceil(keys / 2) // 双人分工：lane < B 归 P0
    let start = cfg.approach + 1 // 第一首开始于 approach + 1 秒
    let count = 0
    let songIdx = 0
    const lastExtraAt = [-10, -10]
    while (start < DURATION - 6 && count < 20 && order.length) {
      const song = order[count % order.length]
      const raw = parseSong(song)
      const spb = 60 / (cfg.bpm * (song.tempo ?? 1))
      const lastRaw = raw[raw.length - 1]
      const end = raw.length ? start + (lastRaw.beat + lastRaw.len) * spb : start
      this.spans.push({ name: song.name, start, end })
      const kept: Note[] = []
      for (const rn of raw) {
        const t = start + rn.beat * spb
        if (t > DURATION - 0.4) continue // 单音符 t > S-.4 丢弃
        const n: Note = {
          id: this.notes.length,
          t,
          lane: rn.deg - 1,
          midi: MIDI_BASE + SCALE[rn.deg - 1] + 12 * rn.oct,
          beat: rn.beat,
          len: rn.len,
          songIdx,
          auto: false,
          lead: -1,
          extra: false,
          owner: duo ? (rn.deg - 1 < B ? 0 : 1) : 0,
          done: '',
          missAt: 0,
        }
        // auto：与前一个保留音符间隔 < minGap → 转自动播放（系统代弹）
        const prev = kept[kept.length - 1]
        if (prev && n.t - prev.t < cfg.minGap) {
          n.auto = true
          n.lead = prev.id
        } else {
          kept.push(n)
        }
        this.notes.push(n)
      }
      // auto 规则二：半拍连音且与下一个音符间隔 < minGap → auto（lead 指向主导音）
      for (const n of this.notes) {
        if (n.auto || n.songIdx !== songIdx) continue
        const next = this.notes[n.id + 1]
        if (next && next.t - n.t < cfg.minGap && n.beat % 1 !== 0) {
          n.auto = true
          n.lead = next.id
        }
      }
      // hard 单人和弦加键：长音/乐句头同拍加一键（距原音 ≥2 键）
      if (cfg.chords && !duo) {
        for (const n of [...this.notes]) {
          if (n.auto || n.extra || n.songIdx !== songIdx) continue
          const prevN = this.notes[n.id - 1]
          const nextN = this.notes[n.id + 1]
          if (prevN && n.t - prevN.t < 0.5) continue
          if (nextN && nextN.t - n.t < 0.5) continue
          if (!(n.len >= 2 || n.beat % (song.bar * 2) === 0)) continue
          const cand = CHORDS[n.lane + 1]?.find(([d2]) => {
            const lane2 = d2 - 1
            return lane2 < keys && Math.abs(lane2 - n.lane) >= 2
          })
          if (!cand) continue
          this.notes.push({
            id: this.notes.length,
            t: n.t,
            lane: cand[0] - 1,
            midi: MIDI_BASE + SCALE[cand[0] - 1] + 12 * (cand[1] + (n.midi - MIDI_BASE - SCALE[n.lane]) / 12),
            beat: n.beat,
            len: n.len,
            songIdx,
            auto: false, lead: -1, extra: true, owner: 0, done: '', missAt: 0,
          })
        }
      }
      // 双人四手联弹：整拍强拍给对方加伴奏和弦音（P0 侧低一个八度）
      if (duo) {
        for (const n of [...this.notes]) {
          if (n.auto || n.extra || n.songIdx !== songIdx) continue
          if (!(n.beat % 1 === 0 && n.beat % song.bar === 0)) continue
          const other = 1 - n.owner
          if (n.t - lastExtraAt[other] < 0.5) continue
          // 对方该时刻无主音符
          const clash = this.notes.some((m) => m.owner === other && !m.auto && Math.abs(m.t - n.t) < 0.25)
          if (clash) continue
          const span = keys - B
          const lane2 = other === 0 ? n.lane % B : B + ((n.lane - B + 1) % span)
          this.notes.push({
            id: this.notes.length,
            t: n.t,
            lane: lane2,
            midi: n.midi + (other === 0 ? -12 : 0),
            beat: n.beat, len: n.len, songIdx,
            auto: false, lead: -1, extra: true, owner: other, done: '', missAt: 0,
          })
          lastExtraAt[other] = n.t
        }
      }
      this.notes.sort((a, b) => a.t - b.t || a.id - b.id)
      start += end - start + (180 / cfg.bpm) // 曲间固定间隔 180/bpm（=3 拍）
      songIdx++
      count++
    }
  }

  tick(_f: PoseFrame, dt: number) {
    const now = this.t
    const cfg = this.cfg
    const C = WIN.ok * cfg.loose // 匹配扫描窗口：easy .336 / medium .288 / hard .24
    const duo = this.present() >= 2

    // 曲目进度 / 曲名横幅
    const spanIdx = this.spans.findIndex((s) => now >= s.start - 1.6 && now < s.end)
    if (spanIdx !== this.curSpan && spanIdx >= 0) {
      this.curSpan = spanIdx
      const s = this.spans[spanIdx]
      this.banner = { text: `♪ ${s.name}`, at: now }
      this.ctx.speak(s.name)
      this.ctx.setStage(s.name)
    }

    this.flashT = Math.max(0, this.flashT - dt)
    for (let pi = 0; pi < 2; pi++) {
      const st = this.ps[pi]
      const pv = this.players[pi]
      const b = pv.body
      if (!b) continue
      const lay = this.layout(pi, dt, duo)
      if (!lay) continue
      const torsoNorm = Math.max(0.05, (b.scale * this.H) / this.H)
      const trails = [pv.lHand.trail, pv.rHand.trail]
      for (let hi = 0; hi < 2; hi++) {
        const vy = handVyTorso(trails[hi], dt, torsoNorm)
        // 重新武装：手上抬/减速到 .3 以下才置位（防按住不放连吃）
        if (!st.armed[hi] && vy < O) st.armed[hi] = true
        if (!st.armed[hi] || vy < D) continue
        if (now - st.lastPress[hi] < K_CD) continue
        const key = this.keyAt(lay, hi === 0 ? b.lHand : b.rHand, lay.torso)
        if (key < 0) continue
        st.armed[hi] = false
        st.lastPress[hi] = now
        this.press(pi, key, now, C, lay)
      }
      for (let k = 0; k < st.keyFlash.length; k++) st.keyFlash[k] = Math.max(0, st.keyFlash[k] - dt * 4)

      // Miss：now > t + C 未判定 → miss、连击清零（auto 音符不计）
      const duoNow = this.present() >= 2
      for (const n of this.notes) {
        if (n.auto || (duoNow && n.owner !== pi) || n.done) continue
        if (now > n.t + C) {
          n.done = 'miss'
          n.missAt = now
          st.judged++
          st.combo = 0
        }
      }
    }

    for (let i = this.floats.length - 1; i >= 0; i--) if (now - this.floats[i].at > 0.7) this.floats.splice(i, 1)
    for (let i = this.ringsFx.length - 1; i >= 0; i--) if (now - this.ringsFx[i].at > 0.3) this.ringsFx.splice(i, 1)

    const tot = this.ps.reduce((n, p) => n + p.score, 0)
    this.ctx.setScore(tot)
    this.ctx.setCombo(Math.max(this.ps[0].combo, this.ps[1].combo))
    this.ctx.setExtra('最大连击', Math.max(this.ps[0].maxCombo, this.ps[1].maxCombo))
    this.ctx.setExtra('完美', this.ps.reduce((n, p) => n + p.perfect, 0))
    const hit = this.ps.reduce((n, p) => n + p.hit, 0)
    const judged = this.ps.reduce((n, p) => n + p.judged, 0)
    this.ctx.setExtra('准确率', judged ? Math.round((hit / judged) * 100) : 100)
    this.ctx.setExtra('曲子', Math.max(this.ps[0].songs.size, this.ps[1].songs.size))
  }

  /** 键盘布局：锚点 = (shoulderC+hipC)/2 的 x、肩 y；指数平滑 1-exp(-dt*3) */
  private layout(pi: number, dt: number, duo: boolean) {
    const b = this.players[pi].body
    if (!b) return null
    const st = this.ps[pi]
    const z = this.zoneOf(this.present(), pi)
    const torso = Math.min(260 * this.unit(), Math.max(70 * this.unit(), Math.max(40, b.scale * this.H)))
    const ax0 = ((b.shoulderC.x + b.hipC.x) / 2) * this.W
    const ay0 = b.shoulderC.y * this.H
    const a = st.anchor
    if (!a.ready) {
      a.ready = true
      a.x = ax0
      a.y = ay0
    }
    const k = 1 - Math.exp(-dt * 3)
    a.x += (ax0 - a.x) * k
    a.y += (ay0 - a.y) * k
    const kw = (duo ? Math.min(0.5, 2 / this.cfg.keys) : this.cfg.kw) * torso
    const total = kw * this.cfg.keys
    const startX = Math.min(z.x1 - total, Math.max(z.x0, a.x - total / 2))
    const top = Math.min(this.H - KH * torso - 10, Math.max(this.H * 0.3, a.y + A_OFF * torso))
    return { torso, kw, total, startX, top, kh: KH * torso, keys: this.cfg.keys, z }
  }

  /** 手 → 键映射 F：y ∈ [top-.2T, top+kh] 且 x 落在第几格；两端 .15T 越界宽容 */
  private keyAt(lay: NonNullable<ReturnType<AirPiano['layout']>>, hand: { x: number; y: number }, torso: number) {
    const { startX, top, kh, kw, keys } = lay
    if (hand.y < top - M_TOL * torso || hand.y > top + kh) return -1
    const x = hand.x
    const tol = 0.15 * torso
    if (x < startX - tol || x > startX + kw * keys + tol) return -1
    const col = Math.floor((x - startX) / kw)
    return Math.min(keys - 1, Math.max(0, col))
  }

  /** 按键判定：扫描窗 C = ok×loose；分级时偏差按 d/loose 压缩 */
  private press(pi: number, key: number, now: number, C: number, lay: NonNullable<ReturnType<AirPiano['layout']>>) {
    const st = this.ps[pi]
    const duoNow = this.present() >= 2 // 单人游玩时不受 owner 分工限制
    let target: Note | null = null
    let best = 1e9
    for (const n of this.notes) {
      if (n.auto || (duoNow && n.owner !== pi) || n.done) continue
      if (n.t - now > C) break
      const d = Math.abs(now - n.t)
      if (d <= C && n.lane === key && d < best) {
        best = d
        target = n
      }
    }
    const keyX = lay.startX + (key + 0.5) * lay.kw
    if (!target) {
      // 弹空键：正反馈但零分（自由演奏彩蛋）
      this.ctx.audio.tonePop(((MIDI_BASE + SCALE[key] - 69) * 12) / 5)
      st.keyFlash[key] = 1
      this.ringsFx.push({ x: keyX, y: lay.top, at: now })
      return
    }
    const judge = grade((now - target.t) / this.cfg.loose)
    target.done = judge
    target.missAt = now
    st.hit++
    st.judged++
    if (judge === 'perfect') st.perfect++
    st.combo++
    st.maxCombo = Math.max(st.maxCombo, st.combo)
    st.score += SCORE_OF[judge] + comboBonus(st.combo)
    st.keyFlash[key] = 1
    this.ctx.audio.tonePop(((target.midi - 69) * 12) / 5)
    const song = this.spans[target.songIdx]
    if (song) st.songs.add(song.name)
    const y = lay.top - lay.kh * 0.5
    this.floats.push({ text: JUDGE_TEXT[judge], x: keyX, y: y - 30, at: now, color: JUDGE_COLOR[judge], size: 34 })
    if (judge === 'perfect') {
      this.particles.burst(keyX, y, KEY_COLORS[target.lane], 6, 240 * this.unit(), 5, 600, '⭐')
      this.particles.burst(keyX, y, '#ffffff', 4, 240 * this.unit(), 4)
      this.floats.push({ text: '♪', x: keyX + 30, y: y - 60, at: now, color: KEY_COLORS[target.lane], size: 26 })
      this.flashT = Math.max(this.flashT, 0.35)
    } else if (judge === 'good') {
      this.particles.burst(keyX, y, KEY_COLORS[target.lane], 5, 240 * this.unit(), 4)
    }
    // auto 音符跟随主导音：主导音命中且非 miss 时自动出声 + 闪键
    if (judge !== 'miss') {
      for (const n of this.notes) {
        if (!n.auto || n.lead !== target.id) continue
        this.ctx.audio.tonePop(((n.midi - 69) * 12) / 5)
        st.keyFlash[n.lane] = 1
      }
    }
    if (st.combo > 0 && st.combo % COMBO_STEP === 0 && st.combo !== this.lastComboMilestone) {
      this.lastComboMilestone = st.combo
      this.banner = { text: `连击 ×${st.combo}！`, at: now }
      this.ctx.audio.combo()
      this.flashT = Math.max(this.flashT, 0.5)
    }
    this.ctx.setCombo(st.combo)
  }

  private zoneOf(present: number, pi: number) {
    if (present <= 1) return { x0: this.W * 0.08, x1: this.W * 0.92 }
    return pi === 0 ? { x0: this.W * 0.03, x1: this.W * 0.47 } : { x0: this.W * 0.53, x1: this.W * 0.97 }
  }

  paint(c: CanvasRenderingContext2D) {
    const now = this.t
    const duo = this.present() >= 2

    for (let pi = 0; pi < 2; pi++) {
      const hasBody = Boolean(this.players[pi].body)
      if (!hasBody && pi > 0) continue
      const st = this.ps[pi]
      const lay = this.layout(pi, 1 / 60, duo) ?? this.fallbackLayout(pi, duo)
      // 落轨渐变柱
      for (let k = 0; k < lay.keys; k++) {
        const x = lay.startX + k * lay.kw
        const g = c.createLinearGradient(0, 0, 0, lay.top)
        g.addColorStop(0, 'rgba(255,255,255,0)')
        g.addColorStop(1, KEY_COLORS[k] + '55')
        c.fillStyle = g
        c.fillRect(x, 0, lay.kw, lay.top)
      }
      // 琴键
      for (let k = 0; k < lay.keys; k++) {
        const x = lay.startX + k * lay.kw
        rr(c, x + 2, lay.top, lay.kw - 4, lay.kh, 10)
        c.fillStyle = KEY_COLORS[k]
        c.fill()
        c.strokeStyle = 'rgba(255,255,255,.6)'
        c.lineWidth = 2
        c.stroke()
        if (st.keyFlash[k] > 0) {
          c.save()
          c.globalAlpha = st.keyFlash[k] * 0.55
          rr(c, x + 2, lay.top, lay.kw - 4, lay.kh, 10)
          c.fillStyle = '#fff'
          c.fill()
          c.restore()
        }
        txt(c, String(k + 1), x + lay.kw / 2, lay.top + lay.kh + 16, 16, '#5d4e6d', 'center', 'bold')
      }
      // 音符：从屏幕顶落到键顶（approach 秒）
      const duoNow = this.present() >= 2
      for (const n of this.notes) {
        if (duoNow && n.owner !== pi) continue
        if (n.done === 'perfect' || n.done === 'good' || n.done === 'ok') continue
        const alpha = n.done === 'miss' ? Math.max(0, 1 - (now - n.missAt) / 0.45) : n.auto ? 0.55 : 1
        if (alpha <= 0) continue
        const r0 = Math.min(44 * this.unit(), Math.max(14 * this.unit(), lay.kw * 0.4))
        const r = n.auto ? r0 * 0.6 : r0
        const keyX = lay.startX + (n.lane + 0.5) * lay.kw
        const p = lay.top - (Math.max(0, n.t - now) / this.cfg.approach) * (lay.top + r * 2)
        c.save()
        c.globalAlpha = alpha
        c.translate(keyX, p)
        glow(c, 0, 0, r * 2, n.done === 'miss' ? '#b8adc4' : KEY_COLORS[n.lane], 0.3)
        c.beginPath()
        c.arc(0, 0, r, 0, Math.PI * 2)
        c.fillStyle = n.done === 'miss' ? '#b8adc4' : '#fff'
        c.fill()
        c.strokeStyle = n.done === 'miss' ? '#b8adc4' : KEY_COLORS[n.lane]
        c.lineWidth = 4
        c.stroke()
        txt(c, String(n.lane + 1), 0, 1, r * 0.9, n.done === 'miss' ? '#7a6f8a' : KEY_COLORS[n.lane], 'center', '900')
        c.restore()
      }
      // 空按白圈
      for (const fx of this.ringsFx) {
        const k2 = (now - fx.at) / 0.3
        c.save()
        c.globalAlpha = (1 - k2) * 0.8
        c.strokeStyle = '#fff'
        c.lineWidth = 3
        c.beginPath()
        c.arc(fx.x, fx.y, 20 + k2 * 40, 0, Math.PI * 2)
        c.stroke()
        c.restore()
      }
      // 判定浮字 0.7s 上浮
      for (const fl of this.floats) {
        if (fl.x < lay.z.x0 || fl.x > lay.z.x1) continue
        const k2 = (now - fl.at) / 0.7
        c.save()
        c.globalAlpha = 1 - k2
        outlineTxt(c, fl.text, fl.x, fl.y - k2 * 26, fl.size, fl.color)
        c.restore()
      }
      // 连击 ≥3：双人放 zone 内侧防重叠
      if (st.combo >= 3) {
        const cx = duo ? (pi === 0 ? lay.z.x1 - 90 : lay.z.x0 + 90) : (lay.z.x0 + lay.z.x1) / 2
        outlineTxt(c, `连击 ${st.combo}`, cx, this.H - 70, 26 + Math.min(12, st.combo / 2), '#ffd54a')
      }
      if (this.banner && now - this.banner.at < 0.9) {
        outlineTxt(c, this.banner.text, (lay.z.x0 + lay.z.x1) / 2, this.H * 0.2, 46, '#ffd54a')
      }
    }

    // 曲名横幅（开演前 1.6s）+ 进度条
    const span = this.curSpan >= 0 ? this.spans[this.curSpan] : null
    if (span) {
      if (now < span.start) {
        outlineTxt(c, `♪ ${span.name}`, this.W / 2, this.H * 0.12, 44, '#ffd93d')
      } else if (span.end > span.start) {
        const pct = Math.min(1, (now - span.start) / (span.end - span.start))
        const w = this.W * 0.4
        rr(c, this.W / 2 - w / 2, 14, w, 10, 5)
        c.fillStyle = 'rgba(255,255,255,.2)'
        c.fill()
        rr(c, this.W / 2 - w / 2, 14, w * pct, 10, 5)
        c.fillStyle = '#ffd93d'
        c.fill()
      }
    }
    // highlight 白闪
    if (this.flashT > 0) {
      c.save()
      c.globalAlpha = Math.min(0.25, this.flashT * 0.3)
      c.fillStyle = '#fff'
      c.fillRect(0, 0, this.W, this.H)
      c.restore()
    }
    if (this.present() === 0) {
      outlineTxt(c, '站到镜头前，胸前一排琴键', this.W / 2, this.H * 0.5, 34, '#ffffff')
    }
    txt(c, '音符落到键上就往下按；抬手再按下一击；过密的音系统帮你弹', this.W / 2, this.H - 24, 20, 'rgba(255,255,255,.8)', 'center', 'bold')
  }

  private fallbackLayout(pi: number, duo: boolean) {
    const z = this.zoneOf(this.present(), pi)
    const torso = 180 * this.unit()
    const kw = (duo ? Math.min(0.5, 2 / this.cfg.keys) : this.cfg.kw) * torso
    const total = kw * this.cfg.keys
    return {
      torso, kw, total,
      startX: Math.min(z.x1 - total, Math.max(z.x0, (z.x0 + z.x1) / 2 - total / 2)),
      top: this.H * 0.55,
      kh: KH * torso,
      keys: this.cfg.keys,
      z,
    }
  }
}

function handVyTorso(trail: { x: number; y: number }[], dt: number, torsoNorm: number) {
  if (trail.length < 2 || dt <= 0) return 0
  const a = trail[trail.length - 2]
  const b = trail[trail.length - 1]
  return (b.y - a.y) / dt / torsoNorm
}

export default function create(ctx: GameContext): Game {
  return new AirPiano(ctx)
}
