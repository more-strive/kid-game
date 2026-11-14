import { BaseGame } from '@/core/base'
import type { Game, GameContext, PoseFrame } from '@/core/types'
import { outlineTxt, ring, txt } from '@/core/draw'

/** 计数类原型：按动作次数计分（跳绳 / 深蹲 / 高抬腿 / 开合跳 / 波比跳） */
type Action = 'jump' | 'squat' | 'knee' | 'jack' | 'burpee'

interface Theme {
  action: Action
  label: string
  color: string
  /** 画绳子 */
  rope: boolean
  hint: string
}

const THEMES: Record<string, Theme> = {
  'jump-rope': { action: 'jump', label: '跳绳', color: '#ff7a45', rope: true, hint: '绳子扫到脚下就跳' },
  'rope-count': { action: 'jump', label: '跳绳', color: '#4cc9f0', rope: true, hint: '一下一下跳，数你跳了多少' },
  'trampoline': { action: 'jump', label: '蹦床', color: '#9b5de5', rope: false, hint: '跳起来摘星星' },
  'hopscotch': { action: 'jump', label: '跳房子', color: '#ffd54a', rope: false, hint: '一格一格跳过去' },
  'hurdles': { action: 'jump', label: '跨栏', color: '#3ddc97', rope: false, hint: '跳过一个个栏架' },
  'squat-count': { action: 'squat', label: '深蹲', color: '#3ddc97', rope: false, hint: '蹲下去、站起来算一个' },
  'pull-carrot': { action: 'squat', label: '拔萝卜', color: '#ff9f1c', rope: false, hint: '蹲下抓住，站起来拔' },
  'radish-squat': { action: 'squat', label: '萝卜蹲', color: '#7bc950', rope: false, hint: '听口令蹲下起立' },
  'knee-count': { action: 'knee', label: '高抬腿', color: '#ff5c8a', rope: false, hint: '膝盖抬到腰那么高' },
  'jack-count': { action: 'jack', label: '开合跳', color: '#ffd54a', rope: false, hint: '手脚一起打开再收回' },
  'burpee': { action: 'burpee', label: '波比跳', color: '#ff4d4d', rope: false, hint: '蹲下撑地，再跳起来' },
  'fitness-circuit': { action: 'burpee', label: '体能', color: '#ff4d4d', rope: false, hint: '跟着口令做动作' },
  'bamboo-dance': { action: 'jump', label: '跳竹竿', color: '#3ddc97', rope: false, hint: '竹竿分开就跳进去' },
  'sprint': { action: 'jump', label: '冲刺', color: '#4cc9f0', rope: false, hint: '原地快跑，越跑越快' },
  'long-jump': { action: 'jump', label: '立定跳远', color: '#ff9f1c', rope: false, hint: '蹲一下，使劲往前跳' },
  'bike-ride': { action: 'knee', label: '骑车', color: '#4cc9f0', rope: false, hint: '原地高抬腿像蹬车' },
  'swim-race': { action: 'jack', label: '游泳', color: '#4cc9f0', rope: false, hint: '手臂划水，腿打水' },
  'jumping': { action: 'jump', label: '跳', color: '#ff7a45', rope: false, hint: '跟着节拍跳' },
}

class RepGame extends BaseGame implements Game {
  theme: Theme
  reps = 0
  score = 0
  combo = 0
  best = 0
  private was = false
  private kneeWas = [false, false]
  private jackWas = false
  private phase2 = false
  beat = 0
  beatInterval = 0.85
  flash = 0

  constructor(ctx: GameContext) {
    super(ctx)
    this.theme =
      THEMES[ctx.meta.slug] ?? { action: 'jump', label: '跳', color: '#ff7a45', rope: false, hint: '跟着节拍动起来' }
  }

  tick(f: PoseFrame, dt: number) {
    const b = f.bodies[0] ?? null
    this.beat += dt
    if (this.beat > this.beatInterval) {
      this.beat = 0
      this.flash = 1
      this.ctx.audio.tick()
      if (this.theme.rope) this.beatInterval = Math.max(0.42, this.beatInterval - 0.012)
    }
    this.flash = Math.max(0, this.flash - dt * 3)
    if (!b) return

    let now = false
    if (this.theme.action === 'jump') now = b.jumping
    else if (this.theme.action === 'squat') now = b.squat
    else if (this.theme.action === 'knee') {
      const l = b.lKnee.y < b.lHip.y + 0.03
      const r = b.rKnee.y < b.rHip.y + 0.03
      // 单侧抬腿即可
      if (l && !this.kneeWas[0]) this.count()
      if (r && !this.kneeWas[1]) this.count()
      this.kneeWas = [l, r]
      return
    } else if (this.theme.action === 'jack') {
      now = b.armsUp && b.feetSpread > Math.max(0.16, b.scale * 0.5)
      if (now && !this.jackWas) this.count()
      this.jackWas = now
      return
    } else {
      // 波比：蹲到底 → 起跳
      if (b.squat) this.phase2 = true
      if (this.phase2 && b.jumping) {
        this.phase2 = false
        this.count()
      }
      return
    }

    if (now && !this.was) this.count()
    this.was = now
  }

  private count() {
    this.reps++
    this.combo++
    this.best = Math.max(this.best, this.combo)
    const gain = 10 + Math.min(30, Math.floor(this.combo / 4) * 5)
    this.score += gain
    this.ctx.setScore(this.score)
    this.ctx.setCombo(this.combo)
    this.ctx.setExtra('reps', this.reps)
    this.ctx.setExtra('best', this.best)
    this.ctx.audio.jump()
    this.particles.burst(this.W / 2, this.H * 0.8, this.theme.color, 8, 260, 5, 400)
    this.say(`+${gain}`, this.W / 2, this.H * 0.62, '#fff36b', 34)
    if (this.reps % 10 === 0) {
      this.ctx.audio.good()
      this.say(`${this.reps} ${this.theme.label}！`, this.W / 2, 210, '#ffd54a', 50)
    }
  }

  paint(c: CanvasRenderingContext2D) {
    // 节拍脉冲
    const B = 132
    const pct = Math.min(1, this.beat / this.beatInterval)
    ring(c, B, 112, 62, pct, this.theme.color, 9)
    const scale = 1 + this.flash * 0.12
    c.save()
    c.translate(B, 112)
    c.scale(scale, scale)
    outlineTxt(c, String(this.reps), 0, 0, 56, '#fff')
    c.restore()

    // 跳绳弧线
    if (this.theme.rope) {
      const b = this.players[0].body
      const cx = b ? b.center.x * this.W : B
      const top = 120
      const bottom = b ? Math.max(b.lFoot.y, b.rFoot.y) * this.H + 20 : this.H * 0.9
      const t = this.beat / this.beatInterval
      const swing = Math.sin(t * Math.PI)
      const lh = b ? { x: b.lHand.x * this.W, y: b.lHand.y * this.H } : { x: cx - 150, y: top + 30 }
      const rh = b ? { x: b.rHand.x * this.W, y: b.rHand.y * this.H } : { x: cx + 150, y: top + 30 }
      c.beginPath()
      c.moveTo(lh.x, lh.y)
      c.quadraticCurveTo(cx, top + (bottom - top) * (0.2 + swing * 1.2), rh.x, rh.y)
      c.strokeStyle = 'rgba(255,255,255,.75)'
      c.lineWidth = 7
      c.lineCap = 'round'
      c.stroke()
      // 脚边提示
      const near = t > 0.72 && t < 0.98
      if (near) {
        c.beginPath()
        c.ellipse(cx, bottom + 6, 150, 22, 0, 0, Math.PI * 2)
        c.strokeStyle = 'rgba(255,212,74,.9)'
        c.lineWidth = 5
        c.stroke()
      }
    }

    if (this.combo >= 5) {
      c.fillStyle = 'rgba(10,14,40,.4)'
      c.beginPath()
      c.roundRect(this.W - 234, 26, 210, 52, 26)
      c.fill()
      outlineTxt(c, `连击 ${this.combo}`, this.W - 129, 52, 28, '#ffd54a')
    }
    txt(c, this.theme.hint, this.W / 2, this.H - 34, 20, 'rgba(255,255,255,.82)', 'center', 'bold')
  }
}

export default function create(ctx: GameContext) {
  return new RepGame(ctx)
}
