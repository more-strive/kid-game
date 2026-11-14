import { BaseGame } from '@/core/base'
import type { Game, GameContext, PoseFrame } from '@/core/types'
import { circle, glow, outlineTxt, rr, txt } from '@/core/draw'
import { drawItem, preloadItems } from '@/core/sprites'

/** 节奏类原型：音符落到判定线，用手/脚在对应位置打中 */
interface Theme {
  lanes: number
  colors: string[]
  label: string
  hint: string
  /** 顶部还是底部判定 */
  keys: 'pads' | 'keys'
}

const THEMES: Record<string, Theme> = {
  'air-drums': { lanes: 3, colors: ['#ff5c8a', '#ffd54a', '#4cc9f0'], label: '架子鼓', hint: '音符到线就敲', keys: 'pads' },
  'air-piano': { lanes: 4, colors: ['#ff8fa3', '#ffd166', '#7bc950', '#4cc9f0'], label: '钢琴', hint: '音符到琴键就按下去', keys: 'keys' },
  'air-guitar': { lanes: 3, colors: ['#ff9f1c', '#9b5de5', '#3ddc97'], label: '吉他', hint: '到线时扫一下', keys: 'pads' },
  'rhythm-pad': { lanes: 4, colors: ['#ff3385', '#ffd54a', '#3ddc97', '#3390fc'], label: '踏板', hint: '踩着节拍动', keys: 'pads' },
  conductor: { lanes: 3, colors: ['#ffd54a', '#ff8fa3', '#4cc9f0'], label: '指挥', hint: '跟着拍子挥', keys: 'pads' },
  'musical-chairs': { lanes: 3, colors: ['#ff9f1c', '#4cc9f0', '#9b5de5'], label: '抢椅子', hint: '音乐停就坐下去', keys: 'pads' },
  'pitch-ladder': { lanes: 4, colors: ['#3ddc97', '#4cc9f0', '#ffd166', '#ff8fa3'], label: '音高', hint: '手举到对应高度', keys: 'keys' },
  diabolo: { lanes: 3, colors: ['#ff5c8a', '#ffd54a', '#3ddc97'], label: '空竹', hint: '节奏到了就抖一下', keys: 'pads' },
  'lion-dance': { lanes: 3, colors: ['#ff9f1c', '#ff4d4d', '#ffd54a'], label: '舞狮', hint: '鼓点到了就跳', keys: 'pads' },
  'saw-log': { lanes: 2, colors: ['#9b5de5', '#4cc9f0'], label: '拉锯', hint: '一推一拉跟上节奏', keys: 'pads' },
  'dragon-boat': { lanes: 3, colors: ['#3ddc97', '#4cc9f0', '#ffd54a'], label: '划船', hint: '鼓点到了就划', keys: 'pads' },
  rhythm: { lanes: 3, colors: ['#ff5c8a', '#ffd54a', '#4cc9f0'], label: '节奏', hint: '跟着节拍打', keys: 'pads' },
}

interface Note {
  lane: number
  y: number
  hit: boolean
  judged: boolean
  color: string
  alive: boolean
}

const LINE_Y = 560

class RhythmGame extends BaseGame implements Game {
  theme: Theme
  notes: Note[] = []
  score = 0
  combo = 0
  best = 0
  beat = 0
  bpm = 96
  spawnT = 0
  private laneX: number[] = []
  private hitFlash = [0, 0, 0, 0]
  private laneWas = [false, false, false, false]

  constructor(ctx: GameContext) {
    super(ctx)
    this.theme = THEMES[ctx.meta.slug] ?? THEMES.rhythm
    preloadItems(['note'])
    const n = this.theme.lanes
    const span = 780
    const start = this.W / 2 - span / 2
    for (let i = 0; i < n; i++) this.laneX.push(start + (span / (n - 1 || 1)) * i)
    this.bpm = 92 + ctx.difficulty * 14
  }

  tick(f: PoseFrame, dt: number) {
    const beatDur = 60 / this.bpm
    this.beat += dt
    this.spawnT -= dt
    if (this.spawnT <= 0) {
      this.spawnT = beatDur
      this.spawn()
      if (Math.random() < 0.25) this.spawn()
    }

    const speed = 420
    for (const nt of this.notes) {
      if (!nt.alive) continue
      nt.y += speed * dt
      if (!nt.judged && nt.y > LINE_Y + 60) {
        nt.judged = true
        nt.alive = false
        this.combo = 0
        this.ctx.setCombo(0)
        this.ctx.audio.fail()
      }
    }

    // 手打判定
    const hands = f.bodies.flatMap((b) => [b.lHand, b.rHand]).map((h) => ({ x: h.x * this.W, y: h.y * this.H }))
    for (let i = 0; i < this.laneX.length; i++) {
      const lx = this.laneX[i]
      const near = hands.some((h) => Math.abs(h.x - lx) < 130 && Math.abs(h.y - LINE_Y) < 110)
      if (near && !this.laneWas[i]) {
        // 找该轨道上最接近判定线的音符
        let target: Note | null = null
        let bestD = 1e9
        for (const nt of this.notes) {
          if (!nt.alive || nt.judged || nt.lane !== i) continue
          const d = Math.abs(nt.y - LINE_Y)
          if (d < 120 && d < bestD) {
            bestD = d
            target = nt
          }
        }
        if (target) this.hitNote(target, bestD)
      }
      this.laneWas[i] = near
      this.hitFlash[i] = Math.max(0, this.hitFlash[i] - dt * 3)
    }

    this.notes = this.notes.filter((n) => n.alive)
    this.ctx.setScore(this.score)
  }

  private spawn() {
    const lane = Math.floor(Math.random() * this.theme.lanes)
    this.notes.push({
      lane,
      y: -60,
      hit: false,
      judged: false,
      color: this.theme.colors[lane % this.theme.colors.length],
      alive: true,
    })
  }

  private hitNote(nt: Note, err: number) {
    nt.judged = true
    nt.alive = false
    this.hitFlash[nt.lane] = 1
    const perfect = err < 45
    const gain = perfect ? 20 : 12
    this.score += gain
    this.combo++
    this.best = Math.max(this.best, this.combo)
    this.ctx.setCombo(this.combo)
    this.ctx.setExtra('best', this.best)
    this.ctx.audio.tonePop(nt.lane)
    this.particles.burst(this.laneX[nt.lane], LINE_Y, nt.color, perfect ? 12 : 7, 320, 5)
    this.say(perfect ? '完美' : `+${gain}`, this.laneX[nt.lane], LINE_Y - 70, perfect ? '#3ddc97' : '#fff36b', perfect ? 34 : 28)
    if (this.combo > 0 && this.combo % 10 === 0) {
      this.ctx.audio.good()
      this.say(`${this.combo} 连击！`, this.W / 2, 220, '#ffd54a', 50)
    }
  }

  paint(c: CanvasRenderingContext2D) {
    // 轨道
    for (let i = 0; i < this.laneX.length; i++) {
      const x = this.laneX[i]
      const w = 150
      const g = c.createLinearGradient(0, 0, 0, this.H)
      g.addColorStop(0, 'rgba(16,22,50,.04)')
      g.addColorStop(1, this.theme.colors[i % this.theme.colors.length] + '3a')
      c.fillStyle = g
      c.fillRect(x - w / 2, 100, w, this.H - 130)
    }

    // 判定线
    c.strokeStyle = 'rgba(255,255,255,.55)'
    c.lineWidth = 3
    c.setLineDash([12, 10])
    c.beginPath()
    c.moveTo(this.laneX[0] - 100, LINE_Y)
    c.lineTo(this.laneX[this.laneX.length - 1] + 100, LINE_Y)
    c.stroke()
    c.setLineDash([])

    // 音符
    for (const nt of this.notes) {
      const x = this.laneX[nt.lane]
      glow(c, x, nt.y, 64, nt.color, 0.42)
      // 白底 + 音符图标，像乐谱上的音符
      circle(c, x, nt.y, 27, 'rgba(255,255,255,.95)')
      c.strokeStyle = nt.color
      c.lineWidth = 4
      c.beginPath()
      c.arc(x, nt.y, 27, 0, Math.PI * 2)
      c.stroke()
      if (!drawItem(c, 'note', x, nt.y, 40)) {
        rr(c, x - 14, nt.y - 3, 28, 6, 3)
        c.fillStyle = nt.color
        c.fill()
      }
    }

    // 打击区
    for (let i = 0; i < this.laneX.length; i++) {
      const x = this.laneX[i]
      const f = this.hitFlash[i]
      const base = this.theme.colors[i % this.theme.colors.length]
      c.globalAlpha = 1
      rr(c, x - 66, LINE_Y - 34, 132, 68, 22)
      c.fillStyle = f > 0.1 ? base : 'rgba(16,22,50,.32)'
      c.fill()
      c.strokeStyle = f > 0.1 ? '#fff' : 'rgba(255,255,255,.55)'
      c.lineWidth = 3
      c.stroke()
      if (f > 0.1) glow(c, x, LINE_Y, 110, base, f * 0.7)
    }

    if (this.combo >= 5) {
      c.fillStyle = 'rgba(10,14,40,.42)'
      c.beginPath()
      c.roundRect(this.W / 2 - 118, 26, 236, 54, 27)
      c.fill()
      outlineTxt(c, `连击 ${this.combo}`, this.W / 2, 53, 28, '#ffd54a')
    }

    txt(c, this.theme.hint, this.W / 2, this.H - 30, 20, 'rgba(255,255,255,.82)', 'center', 'bold')
  }
}

export default function create(ctx: GameContext) {
  return new RhythmGame(ctx)
}
