import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, glow, outlineTxt, ring, txt } from '@/core/draw'

/** 姿势类原型：摆出目标姿势穿过墙洞 / 跟着做 */
type PoseKey = 'armsUp' | 'tpose' | 'squat' | 'oneLeg' | 'hip' | 'ypos'

interface PoseDef {
  key: PoseKey
  label: string
  check: (b: Body) => boolean
}

const POSES: Record<PoseKey, PoseDef> = {
  armsUp: {
    key: 'armsUp',
    label: '双手举高',
    check: (b) => b.lHandAboveHead && b.rHandAboveHead,
  },
  tpose: {
    key: 'tpose',
    label: '双手张开',
    check: (b) => {
      const spread = Math.abs(b.lHand.x - b.rHand.x)
      const shoulderW = Math.abs(b.lShoulder.x - b.rShoulder.x)
      const level =
        Math.abs(b.lHand.y - b.shoulderC.y) < b.scale * 0.4 &&
        Math.abs(b.rHand.y - b.shoulderC.y) < b.scale * 0.4
      return spread > Math.max(shoulderW * 2.1, b.scale * 0.9) && level
    },
  },
  squat: { key: 'squat', label: '蹲下来', check: (b) => b.squat },
  oneLeg: {
    key: 'oneLeg',
    label: '单脚站',
    check: (b) => {
      const l = b.lKnee.y < b.rKnee.y - 0.045
      const r = b.rKnee.y < b.lKnee.y - 0.045
      return (l || r) && !b.jumping
    },
  },
  hip: {
    key: 'hip',
    label: '双手叉腰',
    check: (b) => {
      const dl = Math.hypot(b.lHand.x - b.lHip.x, b.lHand.y - b.lHip.y)
      const dr = Math.hypot(b.rHand.x - b.rHip.x, b.rHand.y - b.rHip.y)
      return dl < b.scale * 0.55 && dr < b.scale * 0.55
    },
  },
  ypos: {
    key: 'ypos',
    label: '双手斜上举',
    check: (b) =>
      b.lHand.y < b.shoulderC.y - b.scale * 0.25 &&
      b.rHand.y < b.shoulderC.y - b.scale * 0.25 &&
      Math.abs(b.lHand.x - b.rHand.x) > b.scale * 0.9,
  },
}

interface Theme {
  poses: PoseKey[]
  /** 墙洞模式 */
  wall: boolean
  color: string
  hint: string
}

const THEMES: Record<string, Theme> = {
  'shape-wall': { poses: ['armsUp', 'tpose', 'squat', 'oneLeg', 'ypos'], wall: true, color: '#7c5cff', hint: '摆出洞口的形状，穿过去' },
  'photo-pose': { poses: ['armsUp', 'tpose', 'hip', 'ypos'], wall: false, color: '#ff8fa3', hint: '咔嚓前摆好姿势' },
  'yoga': { poses: ['armsUp', 'tpose', 'oneLeg', 'hip'], wall: false, color: '#3ddc97', hint: '慢慢做到位，保持住' },
  'taichi': { poses: ['tpose', 'ypos', 'hip', 'armsUp'], wall: false, color: '#4cc9f0', hint: '跟着慢慢摆' },
  'animal-mimic': { poses: ['armsUp', 'squat', 'oneLeg', 'tpose'], wall: false, color: '#ff9f1c', hint: '学小动物的动作' },
  'simon-says': { poses: ['armsUp', 'squat', 'tpose', 'hip', 'oneLeg'], wall: false, color: '#9b5de5', hint: '老师说，跟着做' },
  'opposite': { poses: ['armsUp', 'squat', 'tpose'], wall: false, color: '#ff5c8a', hint: '反着做！' },
  'english-moves': { poses: ['armsUp', 'squat', 'tpose', 'hip'], wall: false, color: '#4cc9f0', hint: '听英语口令做动作' },
  'dance-along': { poses: ['armsUp', 'tpose', 'hip', 'ypos'], wall: false, color: '#ff3385', hint: '跟着节拍摆姿势' },
  'mirror-duel': { poses: ['armsUp', 'tpose', 'hip'], wall: false, color: '#7c5cff', hint: '像镜子一样跟着做' },
  'silent': { poses: ['armsUp', 'tpose', 'squat'], wall: false, color: '#4cc9f0', hint: '摆出姿势' },
}

class PoseGame extends BaseGame implements Game {
  theme: Theme
  current: PoseKey = 'armsUp'
  hold = 0
  holdNeed = 0.8
  targetT = 0
  cleared = 0
  score = 0
  combo = 0
  wallHp = 1

  constructor(ctx: GameContext) {
    super(ctx)
    this.theme =
      THEMES[ctx.meta.slug] ?? { poses: ['armsUp', 'tpose', 'squat'], wall: false, color: '#4cc9f0', hint: '摆出姿势' }
    this.pick()
  }

  private pick() {
    const pool = this.theme.poses.filter((p) => p !== this.current)
    this.current = pool[Math.floor(Math.random() * pool.length)] ?? 'armsUp'
    this.targetT = 0
    this.hold = 0
    this.wallHp = 1
    this.ctx.audio.countdown(false)
    this.ctx.setStage(POSES[this.current].label)
  }

  tick(f: PoseFrame, dt: number) {
    const b = f.bodies[0] ?? null
    this.targetT += dt
    if (!b) return
    const ok = POSES[this.current].check(b)
    if (ok) {
      this.hold += dt
      if (this.hold === 0) this.ctx.audio.tick()
      // 持续的粒子
      this.particles.burst(this.W / 2, 360, this.theme.color, 1, 200, 4, 200)
      if (this.hold >= this.holdNeed) this.pass()
    } else {
      this.hold = Math.max(0, this.hold - dt * 1.8)
    }
  }

  private pass() {
    this.cleared++
    this.combo++
    const gain = 20 + Math.min(30, this.combo * 4)
    this.score += gain
    this.ctx.setScore(this.score)
    this.ctx.setCombo(this.combo)
    this.ctx.setExtra('cleared', this.cleared)
    this.ctx.audio.good()
    this.particles.burst(this.W / 2, 330, this.theme.color, 26, 520, 8)
    this.particles.burst(this.W / 2, 330, '#ffffff', 10, 380, 5)
    this.say(`+${gain}`, this.W / 2, 260, '#fff36b', 44)
    if (this.cleared % 3 === 0) this.ctx.speak('做得好')
    this.hold = 0
    this.pick()
  }

  private drawFigure(c: CanvasRenderingContext2D, cx: number, cy: number, key: PoseKey, color: string) {
    const h = 150
    c.save()
    c.translate(cx, cy)
    c.strokeStyle = color
    c.lineWidth = 16
    c.lineCap = 'round'
    c.lineJoin = 'round'
    // 头
    circle(c, 0, -h * 0.78, h * 0.19, color)
    // 躯干
    c.beginPath()
    c.moveTo(0, -h * 0.58)
    c.lineTo(0, h * 0.18)
    c.stroke()

    const arm = (sx: number, hand: [number, number], elbow: [number, number]) => {
      c.beginPath()
      c.moveTo(sx, -h * 0.5)
      c.lineTo(elbow[0], elbow[1])
      c.lineTo(hand[0], hand[1])
      c.stroke()
    }
    const leg = (hx: number, knee: [number, number], foot: [number, number]) => {
      c.beginPath()
      c.moveTo(hx, h * 0.18)
      c.lineTo(knee[0], knee[1])
      c.lineTo(foot[0], foot[1])
      c.stroke()
    }

    if (key === 'armsUp') {
      arm(-18, [-58, -h * 1.02], [-40, -h * 0.72])
      arm(18, [58, -h * 1.02], [40, -h * 0.72])
      leg(-14, [-26, h * 0.62], [-30, h * 1.02])
      leg(14, [26, h * 0.62], [30, h * 1.02])
    } else if (key === 'tpose') {
      arm(-18, [-h * 0.72, -h * 0.5], [-h * 0.42, -h * 0.5])
      arm(18, [h * 0.72, -h * 0.5], [h * 0.42, -h * 0.5])
      leg(-14, [-26, h * 0.62], [-30, h * 1.02])
      leg(14, [26, h * 0.62], [30, h * 1.02])
    } else if (key === 'squat') {
      arm(-18, [-52, -h * 0.16], [-40, -h * 0.42])
      arm(18, [52, -h * 0.16], [40, -h * 0.42])
      leg(-14, [-56, h * 0.5], [-22, h * 0.92])
      leg(14, [56, h * 0.5], [22, h * 0.92])
    } else if (key === 'oneLeg') {
      arm(-18, [-62, -h * 0.52], [-40, -h * 0.5])
      arm(18, [62, -h * 0.52], [40, -h * 0.5])
      leg(-14, [-30, h * 0.6], [-32, h * 1.02])
      leg(14, [58, h * 0.42], [8, h * 0.52])
    } else if (key === 'hip') {
      arm(-18, [-38, h * 0.16], [-58, -h * 0.1])
      arm(18, [38, h * 0.16], [58, -h * 0.1])
      leg(-14, [-28, h * 0.62], [-32, h * 1.02])
      leg(14, [28, h * 0.62], [32, h * 1.02])
    } else {
      arm(-18, [-h * 0.55, -h * 0.95], [-h * 0.3, -h * 0.7])
      arm(18, [h * 0.55, -h * 0.95], [h * 0.3, -h * 0.7])
      leg(-14, [-26, h * 0.62], [-30, h * 1.02])
      leg(14, [26, h * 0.62], [30, h * 1.02])
    }
    c.restore()
  }

  paint(c: CanvasRenderingContext2D) {
    const cx = this.W / 2
    const cy = 420
    const ok = this.hold > 0
    const pct = Math.min(1, this.hold / this.holdNeed)

    if (this.theme.wall) {
      // 墙体
      c.fillStyle = 'rgba(30,38,74,.42)'
      c.fillRect(0, 130, cx - 210, this.H - 130)
      c.fillRect(cx + 210, 130, this.W - cx - 210, this.H - 130)
      // 洞口发光
      const g = c.createLinearGradient(0, 140, 0, this.H)
      g.addColorStop(0, ok ? 'rgba(61,220,151,.35)' : 'rgba(124,92,255,.3)')
      g.addColorStop(1, ok ? 'rgba(61,220,151,.12)' : 'rgba(124,92,255,.1)')
      c.fillStyle = g
      c.fillRect(cx - 210, 130, 420, this.H - 130)
      c.strokeStyle = ok ? '#3ddc97' : 'rgba(255,255,255,.6)'
      c.lineWidth = 5
      c.setLineDash([14, 10])
      c.strokeRect(cx - 210, 130, 420, this.H - 130)
      c.setLineDash([])
    } else {
      c.fillStyle = 'rgba(10,16,44,.35)'
      c.beginPath()
      c.roundRect(cx - 250, 190, 500, 400, 40)
      c.fill()
      c.strokeStyle = ok ? '#3ddc97' : 'rgba(255,255,255,.45)'
      c.lineWidth = 4
      c.stroke()
    }

    if (ok) glow(c, cx, cy, 240, '#3ddc97', 0.35)
    c.globalAlpha = ok ? 0.9 : 0.55
    this.drawFigure(c, cx, cy, this.current, ok ? '#3ddc97' : 'rgba(16,22,50,.55)')
    c.globalAlpha = 1

    // 提示
    outlineTxt(c, POSES[this.current].label, cx, 76, 48, ok ? '#b6ffdd' : '#fff')
    ring(c, cx, this.H - 92, 30, pct, ok ? '#3ddc97' : 'rgba(255,255,255,.55)', 8)
    txt(c, ok ? '保持住！' : this.theme.hint, cx, this.H - 40, 20, 'rgba(255,255,255,.85)', 'center', 'bold')

    // 通过数
    c.fillStyle = 'rgba(10,14,40,.4)'
    c.beginPath()
    c.roundRect(this.W - 224, 24, 200, 52, 26)
    c.fill()
    outlineTxt(c, `通过 ${this.cleared}`, this.W - 124, 50, 26, '#ffd54a')
  }
}

export default function create(ctx: GameContext) {
  return new PoseGame(ctx)
}
