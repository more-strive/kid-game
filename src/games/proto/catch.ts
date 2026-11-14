import { BaseGame } from '@/core/base'
import type { Game, GameContext, PoseFrame } from '@/core/types'
import { circle, glow, outlineTxt, star, txt } from '@/core/draw'
import { drawItem, preloadItems } from '@/core/sprites'

/** 接物类原型：东西掉下来，用手接住 */
type Shape = 'gift' | 'number' | 'letter' | 'drop' | 'star' | 'coin' | 'fish'

/** 每种形状用的贴图素材；空串表示保留矢量绘制（数字/字母要写字） */
const ITEM_OF: Record<Shape, string> = {
  gift: 'gift',
  drop: 'bubble',
  fish: 'fish',
  star: 'star',
  number: '',
  letter: '',
  coin: '',
}

/** 个别游戏换成更贴切的素材 */
const ITEM_BY_SLUG: Record<string, string> = {
  'bounce-ball': 'basketball',
  'llama-treat': 'cookie',
  'sea-lion': 'note',
  firefly: 'sparkle',
}

interface Theme {
  shape: Shape
  color: string
  unit: string
  mode: 'plain' | 'math' | 'letter'
  hint: string
}

const THEMES: Record<string, Theme> = {
  'santa-catch': { shape: 'gift', color: '#ff5c8a', unit: '个礼物', mode: 'plain', hint: '左右移动接住礼物' },
  'math-catch': { shape: 'number', color: '#4cc9f0', unit: '题', mode: 'math', hint: '接住正确答案' },
  'spell-catch': { shape: 'letter', color: '#9b5de5', unit: '个字母', mode: 'letter', hint: '按顺序接字母' },
  'water-flowers': { shape: 'drop', color: '#4cc9f0', unit: '滴水', mode: 'plain', hint: '接住水滴浇花' },
  'fishing': { shape: 'fish', color: '#ffb703', unit: '条鱼', mode: 'plain', hint: '接住跳上来的小鱼' },
  'firefly': { shape: 'star', color: '#ffe066', unit: '只萤火虫', mode: 'plain', hint: '接住发光的萤火虫' },
  'star-muncher': { shape: 'star', color: '#ffd54a', unit: '颗星星', mode: 'plain', hint: '用嘴和手接星星' },
  'sea-lion': { shape: 'coin', color: '#ffd54a', unit: '个圈', mode: 'plain', hint: '接住抛来的圈' },
  'llama-treat': { shape: 'coin', color: '#7bc950', unit: '份零食', mode: 'plain', hint: '把零食喂给羊驼' },
  'bounce-ball': { shape: 'coin', color: '#ff7a45', unit: '下', mode: 'plain', hint: '把球拍起来别落地' },
}

interface Item {
  x: number
  y: number
  vy: number
  vx: number
  r: number
  label: string
  color: string
  alive: boolean
  correct: boolean
  wob: number
}

const WORD_BANK = ['CAT', 'DOG', 'SUN', 'BEE', 'FISH', 'MILK', 'BIRD', 'CAKE']

class CatchGame extends BaseGame implements Game {
  theme: Theme
  items: Item[] = []
  score = 0
  combo = 0
  spawnT = 0.6
  sum = { a: 0, b: 0, answer: 0 }
  word = ''
  wordIdx = 0

  constructor(ctx: GameContext) {
    super(ctx)
    this.theme = THEMES[ctx.meta.slug] ?? { shape: 'star', color: '#ffd54a', unit: '个', mode: 'plain', hint: '接住落下来的东西' }
    preloadItems(['gift', 'bubble', 'fish', 'star', 'sparkle', 'basketball', 'cookie', 'note'])
    this.newQuestion()
  }

  private newQuestion() {
    if (this.theme.mode === 'math') {
      const max = this.ctx.difficulty >= 2 ? 12 : this.ctx.difficulty >= 1 ? 9 : 6
      const a = 1 + Math.floor(Math.random() * (max - 2))
      const b = 1 + Math.floor(Math.random() * (max - a))
      this.sum = { a, b, answer: a + b }
    } else if (this.theme.mode === 'letter') {
      this.word = WORD_BANK[Math.floor(Math.random() * WORD_BANK.length)]
      this.wordIdx = 0
    }
  }

  private spawn() {
    const r = 46 + Math.random() * 8
    const x = 130 + Math.random() * (this.W - 260)
    let label = ''
    let correct = true
    let color = this.theme.color

    if (this.theme.mode === 'math') {
      const ans = this.sum.answer
      const wrong = Math.max(1, ans + (Math.random() < 0.5 ? -1 : 1) * (1 + Math.floor(Math.random() * 3)))
      correct = Math.random() < 0.45
      label = String(correct ? ans : wrong)
      color = correct ? '#4cc9f0' : '#ff8fa3'
    } else if (this.theme.mode === 'letter') {
      const target = this.word[this.wordIdx] ?? 'A'
      correct = Math.random() < 0.45
      label = correct ? target : String.fromCharCode(65 + Math.floor(Math.random() * 26))
      color = correct ? '#9b5de5' : '#ff8fa3'
    }

    this.items.push({
      x,
      y: -60,
      vy: 130 + Math.random() * 90 + this.ctx.difficulty * 20,
      vx: (Math.random() - 0.5) * 40,
      r,
      label,
      color,
      alive: true,
      correct,
      wob: Math.random() * 6.28,
    })
  }

  tick(f: PoseFrame, dt: number) {
    this.spawnT -= dt
    if (this.spawnT <= 0) {
      this.spawnT = Math.max(0.5, 1.05 - this.ctx.difficulty * 0.1) * (0.75 + Math.random() * 0.5)
      this.spawn()
    }

    const hands = f.bodies.flatMap((b) => [
      { x: b.lHand.x * this.W, y: b.lHand.y * this.H },
      { x: b.rHand.x * this.W, y: b.rHand.y * this.H },
    ])

    for (const it of this.items) {
      if (!it.alive) continue
      it.wob += dt * 3
      it.vy += 60 * dt
      it.y += it.vy * dt
      it.x += it.vx * dt + Math.sin(it.wob) * 12 * dt

      for (const h of hands) {
        if (Math.hypot(h.x - it.x, h.y - it.y) < it.r + 34) {
          this.collect(it)
          break
        }
      }
      if (it.y > this.H + 80) {
        it.alive = false
        if (this.theme.mode !== 'plain' && it.correct) this.miss()
        else if (this.theme.mode === 'plain') {
          this.combo = 0
          this.ctx.setCombo(0)
        }
      }
    }
    this.items = this.items.filter((i) => i.alive)
    this.ctx.setScore(this.score)
  }

  private collect(it: Item) {
    it.alive = false
    if (this.theme.mode !== 'plain' && !it.correct) {
      this.ctx.audio.fail()
      this.score = Math.max(0, this.score - 10)
      this.combo = 0
      this.ctx.setCombo(0)
      this.say('接错啦', it.x, it.y, '#ff6b6b', 34)
      return
    }
    this.combo++
    this.ctx.setCombo(this.combo)
    const gain = 10 + Math.min(25, this.combo * 3)
    this.score += gain
    this.ctx.audio.coin()
    this.particles.burst(it.x, it.y, it.color, 12, 320, 6)
    this.say(`+${gain}`, it.x, it.y - 20, '#fff36b', 30)
    if (this.theme.mode === 'letter') {
      this.wordIdx++
      if (this.wordIdx >= this.word.length) {
        this.ctx.audio.good()
        this.score += 20
        this.say(`拼出 ${this.word}！`, this.W / 2, 190, '#ffd54a', 46)
        this.newQuestion()
      }
    } else if (this.theme.mode === 'math') {
      this.newQuestion()
    }
  }

  private miss() {
    this.ctx.audio.fail()
    this.combo = 0
    this.ctx.setCombo(0)
    this.say('漏掉了', this.W / 2, 200, '#ff9f9f', 32)
  }

  private drawItem(c: CanvasRenderingContext2D, it: Item) {
    c.save()
    c.translate(it.x, it.y)
    glow(c, 0, 0, it.r * 1.8, it.color, 0.3)
    const t = this.theme.shape
    const pic = ITEM_BY_SLUG[this.ctx.meta.slug] || ITEM_OF[t]
    if (pic && drawItem(c, pic, 0, 0, it.r * 2.15)) {
      c.restore()
      return
    }
    if (t === 'gift') {
      c.fillStyle = it.color
      c.beginPath()
      c.roundRect(-it.r * 0.8, -it.r * 0.7, it.r * 1.6, it.r * 1.5, 8)
      c.fill()
      c.fillStyle = '#ffe066'
      c.fillRect(-it.r * 0.12, -it.r * 0.7, it.r * 0.24, it.r * 1.5)
      c.fillRect(-it.r * 0.8, -it.r * 0.16, it.r * 1.6, it.r * 0.22)
    } else if (t === 'drop') {
      c.beginPath()
      c.moveTo(0, -it.r)
      c.bezierCurveTo(it.r * 0.9, -it.r * 0.1, it.r * 0.7, it.r * 0.85, 0, it.r * 0.85)
      c.bezierCurveTo(-it.r * 0.7, it.r * 0.85, -it.r * 0.9, -it.r * 0.1, 0, -it.r)
      c.fillStyle = it.color + 'dd'
      c.fill()
      c.strokeStyle = 'rgba(255,255,255,.8)'
      c.lineWidth = 3
      c.stroke()
    } else if (t === 'fish') {
      c.beginPath()
      c.ellipse(0, 0, it.r * 0.8, it.r * 0.55, 0, 0, Math.PI * 2)
      c.fillStyle = it.color
      c.fill()
      c.beginPath()
      c.moveTo(it.r * 0.7, 0)
      c.lineTo(it.r * 1.25, -it.r * 0.4)
      c.lineTo(it.r * 1.25, it.r * 0.4)
      c.closePath()
      c.fill()
      circle(c, -it.r * 0.35, -it.r * 0.1, it.r * 0.1, '#2b2b3d')
    } else if (t === 'star') {
      star(c, 0, 0, it.r * 0.95, it.color)
      circle(c, 0, 0, it.r * 0.35, 'rgba(255,255,255,.55)')
    } else {
      // number / letter / coin
      circle(c, 0, 0, it.r, 'rgba(255,255,255,.95)')
      c.strokeStyle = it.color
      c.lineWidth = 6
      c.stroke()
      c.fillStyle = '#1b2a4a'
      c.font = `900 ${it.r * 1.05}px "PingFang SC",system-ui`
      c.textAlign = 'center'
      c.textBaseline = 'middle'
      c.fillText(it.label, 0, it.r * 0.04)
    }
    c.restore()
  }

  paint(c: CanvasRenderingContext2D) {
    if (this.theme.mode === 'math') {
      c.fillStyle = 'rgba(10,14,40,.4)'
      c.beginPath()
      c.roundRect(this.W / 2 - 210, 10, 420, 68, 30)
      c.fill()
      outlineTxt(c, `${this.sum.a} + ${this.sum.b} = ?`, this.W / 2, 44, 40, '#ffffff')
    } else if (this.theme.mode === 'letter') {
      c.fillStyle = 'rgba(10,14,40,.4)'
      c.beginPath()
      c.roundRect(this.W / 2 - 250, 10, 500, 70, 32)
      c.fill()
      const shown = this.word.split('').map((ch, i) => (i < this.wordIdx ? ch : '_')).join(' ')
      outlineTxt(c, shown, this.W / 2, 46, 36, '#ffffff')
    }

    for (const it of this.items) this.drawItem(c, it)

    if (this.combo >= 3) {
      c.fillStyle = 'rgba(10,14,40,.42)'
      c.beginPath()
      c.roundRect(24, 24, 190, 52, 26)
      c.fill()
      outlineTxt(c, `连击 ${this.combo}`, 119, 50, 28, '#ffd54a')
    }
    if (this.theme.mode === 'plain') {
      txt(c, this.theme.hint, this.W / 2, this.H - 34, 20, 'rgba(255,255,255,.8)', 'center', 'bold')
    }
  }
}

export default function create(ctx: GameContext) {
  return new CatchGame(ctx)
}
