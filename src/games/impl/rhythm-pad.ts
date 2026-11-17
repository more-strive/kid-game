import { BaseGame } from '@/core/base'
import type { Game, GameContext, PoseFrame } from '@/core/types'
import { glow, outlineTxt, txt } from '@/core/draw'

/**
 * 节奏踏板（对齐 dongdongpark 真实规则）：
 * 四条轨道掉箭头，到判定线做对应动作：←左跨 →右跨 ↑跳 ↓蹲。
 * 跨步=重心横移 ±.4（回中 |shift|<.25 才能再跨）、蹲=深度 ≥.4（<.2 起身复位）、跳=框架跳跃事件。
 * 判定窗 perfect ≤.08 / good ≤.16 / ok ≤.24；分值 3/2/1/0 + min(3, floor(combo/10))。
 * 音效分档：perfect→chime、good→coin、ok/空触发→click；每拍节拍器 tick。
 */

type Judge = 'perfect' | 'good' | 'ok' | 'miss'

const WIN = { perfect: 0.08, good: 0.16, ok: 0.24 }
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

/** 共享音符生成器 r(count, lanes, density, rng)（beat 模块真实算法） */
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

/** 对齐站点难度表 g：bpm/密度/最小间隔(拍)/提前量 */
const DIFF = [
  { bpm: 90, density: 0.25, minGap: 2, approach: 1.8 },
  { bpm: 110, density: 0.5, minGap: 1, approach: 1.5 },
  { bpm: 130, density: 0.85, minGap: 1, approach: 1.25 },
]

const DURATION = 75
const OFFSET = 2.5 // Beat 时钟偏移（秒）
const SHIFT_ON = 0.4 // 跨步触发：身体横移量
const SHIFT_OFF = 0.25 // 跨步回中阈值：|shift| < .25 才允许下一次跨步
const SQUAT_ON = 0.4 // 蹲触发：motion.squat ≥ .4
const SQUAT_OFF = 0.2 // 起身释放阈值：squat < .2 才允许再次蹲
const LINE_Y = 0.78 // 判定线 y（×H）

/** lane：0=左跨 1=蹲 2=跳 3=右跨（label/色/箭头朝向；基础箭头朝上） */
const LANES = [
  { label: '左跨', color: '#ff3385', rot: -Math.PI / 2 },
  { label: '蹲', color: '#ffd54a', rot: Math.PI },
  { label: '跳', color: '#3ddc97', rot: 0 },
  { label: '右跨', color: '#3390fc', rot: Math.PI / 2 },
]

interface Note {
  beat: number
  lane: number
  t: number
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
  side: number // -1/0/1 跨步单边锁定
  squatDown: boolean
  prevJump: boolean
  anchorX: number
  anchorReady: boolean
  hipBase: number
  hipBaseReady: boolean
  banner: { text: string; at: number } | null
  lanePop: number[]
  missLane: number[]
}

function newP(): PState {
  return {
    score: 0, combo: 0, maxCombo: 0, perfect: 0, hit: 0, passed: 0, missPtr: 0,
    side: 0, squatDown: false, prevJump: false, anchorX: 0, anchorReady: false,
    hipBase: 0, hipBaseReady: false, banner: null, lanePop: [0, 0, 0, 0], missLane: [0, 0, 0, 0],
  }
}

class RhythmPad extends BaseGame implements Game {
  bg = 'stage'
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  period = 60 / this.cfg.bpm
  /** 总拍数 T = floor((75 - 2.5 - 1.5)/period)：easy 106 / medium 130 / hard 153 */
  beats = Math.floor((DURATION - OFFSET - 1.5) / this.period)
  notes: Note[] = []
  ps = [newP(), newP()]
  floats: { text: string; x: number; y: number; at: number; color: string }[] = []
  nextTickAt = OFFSET - this.period * 1.01 // 节拍器从 offset - period×1.01 起

  constructor(ctx: GameContext) {
    super(ctx)
    // 生成 D = r(T, 4, density, rng(7))，只保留整数拍 + 间距过滤
    const rng = mulberry(7)
    let lastKept: { beat: number; lane: number } | null = null
    let lastLaneBeat = [-1, -1, -1, -1]
    for (const g of genNotes(this.beats, 4, this.cfg.density, rng)) {
      if (g.beat % 1 !== 0) continue // 只保留整数拍（hard 半拍产出全被过滤）
      const prev = lastKept
      if (prev && g.beat - prev.beat < this.cfg.minGap) continue // minGap（拍）
      if (lastLaneBeat[g.lane] >= 0 && g.beat - lastLaneBeat[g.lane] < 2) continue // 同 lane 至少隔 2 拍
      if (prev && prev.lane === 1 && g.lane === 2 && g.beat - prev.beat < 2) continue // 蹲→跳 2 拍隔离
      this.notes.push({ beat: g.beat, lane: g.lane, t: OFFSET + g.beat * this.period, done: ['', ''], missAt: [0, 0] })
      lastKept = { beat: g.beat, lane: g.lane }
      lastLaneBeat[g.lane] = g.beat
    }
    this.ctx.speak('左跨右跨、下蹲跳跃，踩准节拍！')
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
    // 节拍器：Beat.tick 每拍 sfx('tick')
    while (now >= this.nextTickAt) {
      this.nextTickAt += this.period
      this.ctx.audio.tick()
    }

    for (let pi = 0; pi < 2; pi++) {
      const st = this.ps[pi]
      const b = this.players[pi].body
      if (!b) continue
      const torso = Math.max(40, b.scale * this.H)
      const hipX = b.hipC.x * this.W
      // 重心横移 shift：相对锚点，躯干为单位；回中时锚点快速跟随、跨步时慢跟随
      if (!st.anchorReady) {
        st.anchorReady = true
        st.anchorX = hipX
      }
      const shift = Math.max(-1.5, Math.min(1.5, (hipX - st.anchorX) / torso))
      st.anchorX += (hipX - st.anchorX) * Math.min(1, dt * (Math.abs(shift) < SHIFT_OFF ? 4 : 0.6))
      // 蹲深度：髋相对基准线下降量（0.1 屏幕高 = 1.0）
      if (!st.hipBaseReady) {
        st.hipBaseReady = true
        st.hipBase = b.hipC.y
      }
      st.hipBase = st.hipBase * 0.97 + b.hipC.y * 0.03
      const squat = Math.max(0, Math.min(1, (b.hipC.y - st.hipBase) / 0.1))

      // ---- 跨步状态机：单边锁定，回中 |shift| < .25 归零 ----
      if (st.side === 0 && shift <= -SHIFT_ON) {
        st.side = -1
        this.trigger(pi, 0, now)
      } else if (st.side === 0 && shift >= SHIFT_ON) {
        st.side = 1
        this.trigger(pi, 3, now)
      } else if (Math.abs(shift) < SHIFT_OFF) {
        st.side = 0
      }
      // ---- 蹲：未蹲 && (squat ≥ .4 || 框架 squat 事件)；squat < .2 起身复位 ----
      if (!st.squatDown && (squat >= SQUAT_ON || b.squat)) {
        st.squatDown = true
        this.trigger(pi, 1, now)
      } else if (st.squatDown && squat < SQUAT_OFF && !b.squat) {
        st.squatDown = false
      }
      // ---- 跳：框架跳跃事件上升沿 ----
      if (b.jumping && !st.prevJump) this.trigger(pi, 2, now)
      st.prevJump = Boolean(b.jumping)

      for (let k = 0; k < 4; k++) st.lanePop[k] = Math.max(0, st.lanePop[k] - dt * 5)
    }

    // ---- 漏拍：note.t < now - .24 未判 → miss、断连击 ----
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
          st.missLane[n.lane]++
          st.combo = 0
        }
        st.missPtr++
      }
    }

    for (let i = this.floats.length - 1; i >= 0; i--) if (now - this.floats[i].at > 0.7) this.floats.splice(i, 1)

    const tot = this.ps.reduce((n, p) => n + p.score, 0)
    this.ctx.setScore(tot)
    this.ctx.setCombo(Math.max(this.ps[0].combo, this.ps[1].combo))
    this.ctx.setExtra('最大连击', Math.max(this.ps[0].maxCombo, this.ps[1].maxCombo))
    this.ctx.setExtra('完美', this.ps.reduce((n, p) => n + p.perfect, 0))
    const hit = this.ps.reduce((n, p) => n + p.hit, 0)
    const passed = this.ps.reduce((n, p) => n + p.passed, 0)
    this.ctx.setExtra('准确率', passed ? Math.round((hit / passed) * 100) : 100)
  }

  /** 命中匹配：按 lane 找「未判定 + |now - t| ≤ .24 + 最近」（扫描止于 .54s） */
  private trigger(pi: number, lane: number, now: number) {
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
    const geom = this.geom(pi)
    const cx = geom.cx + (lane - 1.5) * geom.laneW
    if (!target) {
      // 无匹配触发 → click（与 ok 档同音）
      this.ctx.audio.click()
      st.lanePop[lane] = 0.6
      return
    }
    const judge = grade(now - target.t)
    target.done[pi] = judge
    target.missAt[pi] = now
    st.combo++
    st.maxCombo = Math.max(st.maxCombo, st.combo)
    st.hit++
    st.passed++
    if (judge === 'perfect') st.perfect++
    st.score += SCORE_OF[judge] + comboBonus(st.combo)
    st.lanePop[lane] = 1
    this.floats.push({ text: JUDGE_TEXT[judge], x: cx, y: geom.lineY - 56, at: now, color: JUDGE_COLOR[judge] })
    // 音效按档位分流：perfect→chime、good→coin、ok→click
    if (judge === 'perfect') this.ctx.audio.combo()
    else if (judge === 'good') this.ctx.audio.coin()
    else this.ctx.audio.click()
    // 粒子：perfect 12 星 / good 6 点，速度 260×unit，颜色 = lane 色 + 白
    if (judge === 'perfect') {
      this.particles.burst(cx, geom.lineY, LANES[lane].color, 6, 260 * this.unit(), 5, 620, '⭐')
      this.particles.burst(cx, geom.lineY, '#ffffff', 6, 260 * this.unit(), 4)
    } else if (judge === 'good') {
      this.particles.burst(cx, geom.lineY, LANES[lane].color, 6, 260 * this.unit(), 4)
    }
    if (st.combo > 0 && st.combo % 10 === 0) {
      st.banner = { text: `连击 ×${st.combo}！`, at: now }
      this.ctx.audio.combo()
    }
    this.ctx.setCombo(st.combo)
  }

  /** 轨道几何：单轨宽 min(zone宽/5, 120unit)，判定线 .78H，目标环半径 .38×laneW */
  private geom(pi: number) {
    const z = this.zoneOf(pi)
    const laneW = Math.min((z.x1 - z.x0) / 5, 120 * this.unit())
    const total = laneW * 4
    const cx = (z.x0 + z.x1) / 2
    const lineY = LINE_Y * this.H
    return { z, laneW, total, cx, lineY, startX: cx - total / 2 }
  }

  paint(c: CanvasRenderingContext2D) {
    const now = this.t
    const present = this.present()
    // 拍脉冲
    const frac = ((now - OFFSET) / this.period) % 1
    const pulse = frac < 0 ? 0 : Math.max(0, 1 - frac * 2.2)

    for (let pi = 0; pi < 2; pi++) {
      if (!this.players[pi].body && pi > 0) continue
      const st = this.ps[pi]
      const g = this.geom(pi)
      // 轨道淡色柱（alpha .13）+ 白色分隔线（.35）
      for (let lane = 0; lane < 4; lane++) {
        const x = g.startX + lane * g.laneW
        c.globalAlpha = 0.13
        c.fillStyle = LANES[lane].color
        c.fillRect(x, 0, g.laneW, g.lineY)
        c.globalAlpha = 0.35
        c.strokeStyle = '#fff'
        c.lineWidth = 2
        c.strokeRect(x, 0, g.laneW, g.lineY)
      }
      c.globalAlpha = 1
      // 判定线白线随节拍脉动（宽 5→10）
      c.beginPath()
      c.moveTo(g.startX - 10, g.lineY)
      c.lineTo(g.startX + g.total + 10, g.lineY)
      c.strokeStyle = '#ffffff'
      c.lineWidth = 5 + 5 * pulse
      c.stroke()

      // 音符箭头从屏幕顶落到判定线
      const r = g.laneW * 0.38
      for (const n of this.notes) {
        const dn = n.done[pi]
        if (dn === 'perfect' || dn === 'good' || dn === 'ok') continue
        const alpha = dn === 'miss' ? Math.max(0, 1 - (now - n.missAt[pi]) / 0.5) : 1
        if (alpha <= 0) continue
        const x = g.cx + (n.lane - 1.5) * g.laneW
        const y = g.lineY * (1 - Math.max(0, n.t - now) / this.cfg.approach)
        c.save()
        c.globalAlpha = alpha
        c.translate(x, y)
        c.rotate(LANES[n.lane].rot)
        glow(c, 0, 0, r * 2.2, dn === 'miss' ? '#9a8ba8' : LANES[n.lane].color, 0.3)
        this.drawArrow(c, r * 2.4, dn === 'miss' ? '#9a8ba8' : LANES[n.lane].color)
        c.restore()
      }

      // 判定目标箭头环：命中弹跳（+15% + 拍脉冲 4%）
      for (let lane = 0; lane < 4; lane++) {
        const x = g.cx + (lane - 1.5) * g.laneW
        const pop = st.lanePop[lane]
        const rr0 = r * (1 + pop * 0.15 + pulse * 0.04)
        c.save()
        c.translate(x, g.lineY)
        glow(c, 0, 0, rr0 * 2.2, LANES[lane].color, pop > 0.05 ? 0.5 : 0.18)
        c.rotate(LANES[lane].rot)
        c.globalAlpha = 0.4 + pop * 0.6
        this.drawArrow(c, rr0 * 2.4, pop > 0.05 ? '#ffffff' : LANES[lane].color)
        c.restore()
        // lane 文字（判定线下）
        txt(c, LANES[lane].label, x, g.lineY + 26, 16, 'rgba(255,255,255,.75)', 'center', 'bold')
      }

      // 判定浮字 0.7s 上浮（38→32 unit）
      for (const fl of this.floats) {
        if (fl.x < g.z.x0 || fl.x > g.z.x1) continue
        const k = (now - fl.at) / 0.7
        c.save()
        c.globalAlpha = 1 - k
        outlineTxt(c, fl.text, fl.x, fl.y - k * 30, 38 - 6 * k, fl.color)
        c.restore()
      }
      // 连击 ≥2 判定线下方「连击 N」（30+min(14,combo)）
      if (st.combo >= 2) {
        outlineTxt(c, `连击 ${st.combo}`, (g.z.x0 + g.z.x1) / 2, g.lineY + 70, 30 + Math.min(14, st.combo), '#ffd54a')
      }
      if (st.banner && now - st.banner.at < 0.9) {
        outlineTxt(c, st.banner.text, (g.z.x0 + g.z.x1) / 2, this.H * 0.22, 50, '#ffd54a')
      }
    }

    if (present === 0) {
      outlineTxt(c, '站到镜头前，跟着箭头做动作', this.W / 2, this.H * 0.5, 34, '#ffffff')
    }
    txt(c, '箭头到线就做动作：←左跨 →右跨 ↑跳 ↓蹲；踩准节拍连击越高', this.W / 2, this.H - 22, 20, 'rgba(255,255,255,.8)', 'center', 'bold')
  }

  /** 画箭头（宽 size 的四向箭头贴图回退：三角形+杆） */
  private drawArrow(c: CanvasRenderingContext2D, size: number, color: string) {
    const s = size / 2
    c.fillStyle = color
    c.beginPath()
    c.moveTo(0, -s)
    c.lineTo(s * 0.72, -s * 0.1)
    c.lineTo(s * 0.3, -s * 0.1)
    c.lineTo(s * 0.3, s * 0.9)
    c.lineTo(-s * 0.3, s * 0.9)
    c.lineTo(-s * 0.3, -s * 0.1)
    c.lineTo(-s * 0.72, -s * 0.1)
    c.closePath()
    c.fill()
    c.strokeStyle = 'rgba(255,255,255,.85)'
    c.lineWidth = 2.5
    c.stroke()
  }
}

export default function create(ctx: GameContext): Game {
  return new RhythmPad(ctx)
}
