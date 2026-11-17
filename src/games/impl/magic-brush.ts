import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { outlineTxt, txt } from '@/core/draw'

/**
 * 魔法画笔 / magic-brush（对齐 dongdongpark 真实规则）：
 * 一幅虚线画悬浮在肩上方（大小随臂展自适应），举起一只手（腕过肩 0.03T）当画笔、沿虚线慢速描线，
 * 描到的段被点亮；「最长连续未描段 ≤ gap（≤2 点缺口自动桥接）且覆盖率 ≥ ratio」→ 整幅上色 +1 分换下一幅。
 *
 * 全部字面量沿用站点：命中容差 0.25/0.2/0.16（画布归一化，下限 7×unit/画布尺寸）、覆盖率 0.88/0.92/0.95、
 * 最长缺口 4/3/2、点阵间距 0.05、画布尺寸 0.45×臂展、锚点肩上 0.62×臂展、庆祝 1.7s、
 * 速度闸 3 画布尺寸/秒（0.1s 窗口，超速整帧无覆盖）、涂鸦 0.35s 黄字/0.8s 语音、
 * 覆盖 60% 后未描段黄闪、停滞 5s+冷却 20s 提示、平滑跟随 2.5/s（缩小 ×0.15）。
 *
 * 与站点的差异（写明待实测）：
 * 1) 站点笔尖 = 食指尖（leftIndex/rightIndex）→ 本框架无手指，**笔尖用腕点**（站点食尖不可见时同样退化为
 *    腕点+旧偏移）；easy/medium 容差宽可用，hard ratio 0.95 精度风险高（待实测）；
 * 2) 画册 6 幅（sprites 黑盒）→ 自绘 6 幅折线稿（苹果/小鱼/星星/爱心/房子/小花），彩色成品用粗彩线近似；
 * 3) 2P 合作分半（x<0 归 P0、x≥0 归 P1）按站点实现，但共享分数只加一次（仓库口径，站点两人各 +1）；
 * 4) ai() 演示替身未实装；progress 覆盖率条用 setExtra 替代。
 */
interface Stroke {
  pts: { x: number; y: number }[]
  closed: boolean
  col: string
}

interface Pic {
  name: string
  emoji: string
  strokes: Stroke[]
}

interface Dot {
  x: number
  y: number
  line: number
  covered: boolean
  owner: number
}

interface Zone {
  x0: number
  x1: number
}

interface Painter {
  anchor: { x: number; y: number; S: number }
  picIdx: number
  dots: Dot[]
  covered: number
  longestRun: number
  celebrating: number
  done: number
  prevTip: { x: number; y: number } | null
  velWindow: { t: number; x: number; y: number }[]
  scribble: number
  scribbleWarn: number
  scribbleSaid: boolean
  lastCover: number
  lastHint: number
  zone: Zone
}

/** 站点三档：容差 / 覆盖率 / 最长缺口 */
const DIFF = [
  { tol: 0.25, ratio: 0.88, gap: 4 },
  { tol: 0.2, ratio: 0.92, gap: 3 },
  { tol: 0.16, ratio: 0.95, gap: 2 },
]

const STEP = 0.05 // 点阵间距（画布归一化）
const SIZE_K = 0.45 // 画布尺寸 = 0.45 × 臂展
const ANCHOR_K = 0.62 // 锚点肩上 0.62 × 臂展
const CELEBRATE = 1.7 // 完成庆祝（秒）
const SPEED_MAX = 3 // 涂鸦速度阈值（画布尺寸/秒）
const SPEED_WIN = 0.1 // 速度采样窗口
const TOL_PX = 7 // 容差像素下限（×unit）
const DOWN_LINE = 0.03 // 落笔：腕高于肩 0.03T
const SCRIBBLE_WARN = 0.35
const SCRIBBLE_SAY = 0.8
const BLINK_AT = 0.6 // 覆盖 60% 后未描段闪烁
const IDLE_T = 5
const IDLE_COOL = 20

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)

function circlePts(n = 24, ry = 1): { x: number; y: number }[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = (i / n) * Math.PI * 2
    return { x: 0.5 + Math.cos(a) * 0.35, y: 0.5 + Math.sin(a) * 0.35 * ry }
  })
}

function starPts(): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = []
  for (let i = 0; i <= 10; i++) {
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2
    const r = i % 2 === 0 ? 0.45 : 0.2
    out.push({ x: 0.5 + Math.cos(a) * r, y: 0.5 + Math.sin(a) * r })
  }
  return out
}

/** 画册（站点 6 幅黑盒 → 自绘折线稿） */
const ALBUM: Pic[] = [
  {
    name: '苹果', emoji: '🍎',
    strokes: [
      { pts: circlePts(20, 1.1), closed: true, col: '#ff6b6b' },
      { pts: [{ x: 0.5, y: 0.15 }, { x: 0.55, y: 0.05 }], closed: false, col: '#8a5a2b' },
    ],
  },
  {
    name: '小鱼', emoji: '🐟',
    strokes: [
      { pts: [{ x: 0.2, y: 0.5 }, { x: 0.45, y: 0.25 }, { x: 0.75, y: 0.4 }, { x: 0.75, y: 0.6 }, { x: 0.45, y: 0.75 }, { x: 0.2, y: 0.5 }], closed: false, col: '#4cc9f0' },
      { pts: [{ x: 0.75, y: 0.35 }, { x: 0.95, y: 0.25 }, { x: 0.95, y: 0.75 }, { x: 0.75, y: 0.65 }], closed: false, col: '#4cc9f0' },
    ],
  },
  {
    name: '星星', emoji: '⭐',
    strokes: [{ pts: starPts(), closed: true, col: '#ffd54a' }],
  },
  {
    name: '爱心', emoji: '❤️',
    strokes: [
      { pts: [{ x: 0.5, y: 0.85 }, { x: 0.15, y: 0.5 }, { x: 0.2, y: 0.25 }, { x: 0.42, y: 0.28 }, { x: 0.5, y: 0.42 }], closed: false, col: '#ff6b81' },
      { pts: [{ x: 0.5, y: 0.42 }, { x: 0.58, y: 0.28 }, { x: 0.8, y: 0.25 }, { x: 0.85, y: 0.5 }, { x: 0.5, y: 0.85 }], closed: false, col: '#ff6b81' },
    ],
  },
  {
    name: '房子', emoji: '🏠',
    strokes: [
      { pts: [{ x: 0.2, y: 0.9 }, { x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }, { x: 0.8, y: 0.9 }, { x: 0.2, y: 0.9 }], closed: false, col: '#e8963c' },
      { pts: [{ x: 0.15, y: 0.5 }, { x: 0.5, y: 0.15 }, { x: 0.85, y: 0.5 }], closed: false, col: '#ff6b6b' },
    ],
  },
  {
    name: '小花', emoji: '🌸',
    strokes: [
      { pts: circlePts(16, 1), closed: true, col: '#ff8fab' },
      { pts: [{ x: 0.5, y: 0.62 }, { x: 0.5, y: 0.95 }], closed: false, col: '#5cae6e' },
    ],
  },
]

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 折线按间距重采样成点阵 */
function dotify(strokes: Stroke[]): Dot[] {
  const dots: Dot[] = []
  strokes.forEach((st, line) => {
    for (let i = 0; i < st.pts.length - 1; i++) {
      const a = st.pts[i]
      const b = st.pts[i + 1]
      const d = Math.hypot(b.x - a.x, b.y - a.y)
      const n = Math.max(1, Math.round(d / STEP))
      for (let k = 0; k < n; k++) {
        const t = k / n
        dots.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, line, covered: false, owner: 0 })
      }
    }
    dots.push({ x: st.pts[st.pts.length - 1].x, y: st.pts[st.pts.length - 1].y, line, covered: false, owner: 0 })
  })
  return dots
}

class MagicBrush extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[0]
  painters: Painter[] = []
  seats = 1
  private seatActive = [false, false]
  private order: number[] = []
  private oi = 0
  private U = Math.min(this.W, this.H) / 720

  constructor(ctx: GameContext) {
    super(ctx)
    // 手部检测可用时笔尖升级为食指尖（站点口径；不可用则维持腕点兜底）
    ctx.enableHands().catch(() => undefined)
    for (let i = 0; i < 2; i++) {
      this.painters.push({
        anchor: { x: this.W / 2, y: this.H * 0.3, S: 200 },
        picIdx: 0, dots: [], covered: 0, longestRun: Infinity,
        celebrating: 0, done: 0, prevTip: null, velWindow: [],
        scribble: 0, scribbleWarn: 0, scribbleSaid: false,
        lastCover: 0, lastHint: -20,
        zone: { x0: 0, x1: this.W },
      })
    }
    this.layout()
    this.loadPic(0)
  }

  private layout() {
    const duo = this.seats > 1
    for (let i = 0; i < 2; i++) {
      this.painters[i].zone = duo
        ? { x0: (i * this.W) / 2, x1: ((i + 1) * this.W) / 2 }
        : { x0: 0, x1: this.W }
    }
  }

  /** 出图顺序：seed 1 洗牌循环（站点 u.rng(1) 同款） */
  private nextPicIdx() {
    if (this.oi >= this.order.length) {
      const idxs = ALBUM.map((_, i) => i)
      const rng = mulberry32(1 + this.oi)
      for (let i = idxs.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1))
        ;[idxs[i], idxs[j]] = [idxs[j], idxs[i]]
      }
      this.order = idxs
      this.oi = 0
    }
    return this.order[this.oi++]
  }

  private loadPic(playerIdx: number) {
    const p = this.painters[playerIdx]
    p.picIdx = this.nextPicIdx()
    p.dots = dotify(ALBUM[p.picIdx].strokes)
    if (this.seats > 1) {
      for (const d of p.dots) d.owner = d.x < 0.5 ? 0 : 1
    }
    p.covered = 0
    p.longestRun = Infinity
    p.prevTip = null
    p.velWindow = []
    p.lastCover = this.t
  }

  tick(f: PoseFrame, dt: number) {
    if (this.seats === 1 && f.bodies[1]) {
      this.seats = 2
      this.layout()
      // 双人重新按 owner 分配当前画的点
      for (const p of this.painters) {
        for (const d of p.dots) d.owner = d.x < 0.5 ? 0 : 1
      }
    }
    for (let i = 0; i < 2; i++) if (f.bodies[i]) this.seatActive[i] = true
    for (let i = 0; i < 2; i++) {
      const p = this.painters[i]
      if (!this.seatActive[i]) continue
      if (p.celebrating > 0) {
        p.celebrating -= dt
        if (p.celebrating <= 0) {
          this.loadPic(i)
          this.ctx.audio.play('pop', 0.5, 1.2)
        }
        continue
      }
      this.step(p, f.bodies[i] ?? null, dt, i)
      const pct = p.dots.length ? Math.round((100 * p.covered) / p.dots.length) : 0
      this.ctx.setExtra(`pct${i}`, pct)
      this.ctx.setExtra(`done${i}`, p.done)
    }
  }

  private step(p: Painter, b: Body | null, dt: number, idx: number) {
    // —— 画布锚点（臂展自适应 + 平滑 2.5/s）——
    let T = 90 * this.U
    let reach = T * 1.1
    let shX = (p.zone.x0 + p.zone.x1) / 2
    let shY = this.H * 0.5
    if (b) {
      T = Math.max(90 * this.U, b.scale * this.H * 1.1)
      const chainL = Math.hypot(b.lElbow.x - b.lShoulder.x, b.lElbow.y - b.lShoulder.y) + Math.hypot(b.lHand.x - b.lElbow.x, b.lHand.y - b.lElbow.y)
      const chainR = Math.hypot(b.rElbow.x - b.rShoulder.x, b.rElbow.y - b.rShoulder.y) + Math.hypot(b.rHand.x - b.rElbow.x, b.rHand.y - b.rElbow.y)
      reach = clamp(Math.max(chainL, chainR) * this.W + T * 0.14, T * 0.9, T * 1.6)
      shX = b.shoulderC.x * this.W
      shY = b.shoulderC.y * this.H
    }
    const S = SIZE_K * reach
    const tx = clamp(shX, p.zone.x0 + 1.1 * S, p.zone.x1 - 1.1 * S)
    const ty = Math.max(shY - ANCHOR_K * reach, this.H * 0.12 + S)
    const k = 1 - Math.exp(-dt * 2.5)
    p.anchor.x += (tx - p.anchor.x) * k
    p.anchor.y += (ty - p.anchor.y) * k
    const sk = S > p.anchor.S ? k : k * 0.15
    p.anchor.S += (S - p.anchor.S) * sk

    // —— 笔尖（腕点代理，见文件头差异 1）——
    if (!b) {
      p.prevTip = null
      return
    }
    const useL = b.lHand.y <= b.rHand.y
    const hand = useL ? b.lHand : b.rHand
    const shoulder = useL ? b.lShoulder : b.rShoulder
    // 笔尖：手部检测开启时用食指尖（站点口径），否则腕点兜底
    const det = useL ? b.lHandDet : b.rHandDet
    const tipSource = det?.index ?? hand
    const tipScreen = { x: tipSource.x * this.W, y: tipSource.y * this.H }
    const down = hand.y * this.H < shoulder.y * this.H - T * DOWN_LINE
    // 画布坐标
    const tip = {
      x: (tipScreen.x - p.anchor.x) / p.anchor.S + 0.5,
      y: (tipScreen.y - (p.anchor.y - p.anchor.S / 2)) / p.anchor.S,
    }

    // —— 速度闸（0.1s 窗口，画布尺寸/秒）——
    p.velWindow.push({ t: this.t, x: tip.x, y: tip.y })
    while (p.velWindow.length > 2 && this.t - p.velWindow[0].t > SPEED_WIN) p.velWindow.shift()
    let speed = 0
    if (p.velWindow.length >= 2) {
      const a = p.velWindow[0]
      const z = p.velWindow[p.velWindow.length - 1]
      const dtw = Math.max(1e-3, z.t - a.t)
      speed = Math.hypot(z.x - a.x, z.y - a.y) / dtw // 画布单位 / 秒
    }
    const tooFast = speed > SPEED_MAX
    // 涂鸦检测：超速且在画布中心附近
    if (tooFast && Math.hypot(tip.x - 0.5, tip.y - 0.5) < 1.4 && down) {
      p.scribble += dt
      if (p.scribble > SCRIBBLE_WARN) p.scribbleWarn = 0.9
      if (p.scribble > SCRIBBLE_SAY && !p.scribbleSaid) {
        p.scribbleSaid = true
        this.ctx.speak('慢慢描，线才会亮起来')
      }
    } else {
      p.scribble = Math.max(0, p.scribble - dt)
    }
    if (p.scribbleWarn > 0) p.scribbleWarn -= dt

    if (!down) {
      p.prevTip = null
      return
    }
    // —— 覆盖：上一帧 tip → 当前 tip 线段扫点 ——
    if (p.prevTip && !tooFast) {
      const tol = Math.max(this.cfg.tol, (TOL_PX * this.U) / p.anchor.S)
      const seg = { ax: p.prevTip.x, ay: p.prevTip.y, bx: tip.x, by: tip.y }
      for (const d of p.dots) {
        if (d.covered) continue
        if (this.seats > 1 && d.owner !== idx) continue
        if (segDist(seg, d.x, d.y) <= tol) {
          d.covered = true
          p.covered++
          p.lastCover = this.t
        }
      }
      if (p.covered > 0) this.recompute(p)
    }
    p.prevTip = { ...tip }

    // —— 停滞提示 ——
    const pct = p.dots.length ? p.covered / p.dots.length : 0
    if (pct >= 0.5 && this.t - p.lastCover > IDLE_T && this.t - p.lastHint > IDLE_COOL) {
      p.lastHint = this.t
      this.ctx.speak('还有没亮的地方，找一找')
    }
    // —— 完成判定 ——
    const need = Math.ceil(p.dots.length * this.cfg.ratio)
    if (p.longestRun <= this.cfg.gap && p.covered >= need) {
      p.celebrating = CELEBRATE
      p.done++
      this.ctx.addScore(1) // 站点 2P 两人各 +1；仓库共享分数 → 合作完成共 +1
      this.ctx.audio.play('win', 0.7)
      this.say(`${ALBUM[p.picIdx].name}画好啦！`, p.anchor.x, p.anchor.y - p.anchor.S * 0.7, '#ff8fab', 36)
      this.particles.burst(p.anchor.x, p.anchor.y, '#ffd54a', 30, 420, 5)
    }
  }

  /** 最长连续未描段（带 ≤2 点桥接，桥接永久写回） */
  private recompute(p: Painter) {
    let longest = 0
    for (let line = 0; line < ALBUM[p.picIdx].strokes.length; line++) {
      const dots = p.dots.filter((d) => d.line === line)
      const closed = ALBUM[p.picIdx].strokes[line].closed
      let run = 0
      const gaps: { start: number; len: number }[] = []
      let curStart = -1
      for (let i = 0; i < dots.length; i++) {
        if (!dots[i].covered) {
          if (curStart < 0) curStart = i
          run++
        } else if (curStart >= 0) {
          gaps.push({ start: curStart, len: i - curStart })
          curStart = -1
        }
      }
      if (curStart >= 0) gaps.push({ start: curStart, len: dots.length - curStart })
      // 桥接
      for (const g of gaps) {
        const isEdge = !closed && (g.start === 0 || g.start + g.len === dots.length)
        if (g.len <= 2 && !isEdge) {
          for (let i = g.start; i < g.start + g.len; i++) {
            dots[i].covered = true
            p.covered++
          }
        } else longest = Math.max(longest, g.len)
      }
    }
    p.longestRun = longest
  }

  paint(c: CanvasRenderingContext2D) {
    const duo = this.seats > 1
    if (duo) {
      c.fillStyle = '#fffdf3'
      c.fillRect(this.W / 2 - 3, 0, 6, this.H)
    }
    for (let i = 0; i < 2; i++) {
      const p = this.painters[i]
      if (!this.seatActive[i]) continue
      const z = p.zone
      c.save()
      c.beginPath()
      c.rect(z.x0, 0, z.x1 - z.x0, this.H)
      c.clip()
      const pic = ALBUM[p.picIdx]
      const S = p.anchor.S
      const left = p.anchor.x - S / 2
      const top = p.anchor.y - S / 2
      const toScreen = (pt: { x: number; y: number }) => ({ x: left + pt.x * S, y: top + pt.y * S })
      const blinkOn = p.covered / Math.max(1, p.dots.length) >= BLINK_AT
      const celebrating = p.celebrating > 0
      // 完成动画缩放
      const scalePulse = celebrating ? 1 + Math.sin(this.t * 6) * 0.04 : 1
      c.save()
      c.translate(p.anchor.x, p.anchor.y)
      c.scale(scalePulse, scalePulse)
      c.translate(-p.anchor.x, -p.anchor.y)
      // 线稿
      pic.strokes.forEach((st, line) => {
        const dots = p.dots.filter((d) => d.line === line)
        // 底稿：未描段深色 + 白蚂蚁线；已描段玩家色
        for (let k = 0; k < dots.length - 1; k++) {
          const a = toScreen(dots[k])
          const b2 = toScreen(dots[k + 1])
          const coveredPair = dots[k].covered && dots[k + 1].covered
          if (coveredPair) {
            c.strokeStyle = this.players[i].color
            c.lineWidth = S * 0.12
            c.globalAlpha = 0.9
          } else {
            const dim = duo && dots[k].owner !== i
            c.strokeStyle = dim ? 'rgba(255,255,255,.25)' : blinkOn && !celebrating ? (Math.floor(this.t * 4) % 2 === 0 ? '#ffd54a' : st.col) : st.col
            c.lineWidth = S * 0.055
            c.globalAlpha = dim ? 0.3 : 0.85
          }
          c.beginPath()
          c.moveTo(a.x, a.y)
          c.lineTo(b2.x, b2.y)
          c.stroke()
          c.globalAlpha = 1
        }
        // 完成时的彩色粗线
        if (celebrating) {
          c.strokeStyle = st.col
          c.lineWidth = S * 0.1
          c.beginPath()
          const first = toScreen(dots[0])
          c.moveTo(first.x, first.y)
          for (const d of dots) {
            const s2 = toScreen(d)
            c.lineTo(s2.x, s2.y)
          }
          c.stroke()
        }
      })
      c.restore()
      // 完成标签
      if (celebrating) {
        txt(c, `${pic.emoji} ${pic.name}！`, p.anchor.x, top - 20, 26, '#ffd54a', 'center', 'bold')
      } else {
        txt(c, `描一个${pic.name}`, p.anchor.x, top - 20, 20, '#e8dccf', 'center', 'bold')
      }
      // 慢一点
      if (p.scribbleWarn > 0) {
        outlineTxt(c, '慢一点', p.anchor.x, p.anchor.y + S * 0.75, 24, '#ffd54a')
      }
      // 覆盖率
      const pct = p.dots.length ? Math.round((100 * p.covered) / p.dots.length) : 0
      txt(c, `${pct}%`, z.x1 - 16, 40, 20, this.players[i].color, 'right', 'bold')
      c.restore()
    }
  }
}

function segDist(seg: { ax: number; ay: number; bx: number; by: number }, x: number, y: number) {
  const dx = seg.bx - seg.ax
  const dy = seg.by - seg.ay
  const len2 = dx * dx + dy * dy
  if (len2 < 1e-9) return Math.hypot(x - seg.ax, y - seg.ay)
  let t = ((x - seg.ax) * dx + (y - seg.ay) * dy) / len2
  t = clamp(t, 0, 1)
  return Math.hypot(x - (seg.ax + dx * t), y - (seg.ay + dy * t))
}

export default function create(ctx: GameContext) {
  return new MagicBrush(ctx)
}
