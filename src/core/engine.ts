import { audio } from './audio'
import { H, W, outlineTxt } from './draw'
import { tracker } from './pose'
import type { Game, GameContext, HudSnapshot } from './types'
import type { GameMeta } from '@/data/games'
import { createGame } from '@/games'

export type HostState = 'idle' | 'loading' | 'countdown' | 'playing' | 'paused' | 'finished' | 'error'

export interface FinishResult extends HudSnapshot {
  stars: number
  durationPlayed: number
}

export interface HostHooks {
  onHud?: (h: HudSnapshot) => void
  onState?: (s: HostState) => void
  onFinish?: (r: FinishResult) => void
  onError?: (msg: string) => void
}

export class GameHost {
  canvas: HTMLCanvasElement
  video: HTMLVideoElement
  meta: GameMeta
  difficulty = 0
  hooks: HostHooks = {}
  state: HostState = 'idle'
  game: Game | null = null
  hud: HudSnapshot = {
    score: 0,
    best: 0,
    combo: 0,
    timeLeft: 0,
    progress: 0,
    stage: '',
    running: false,
    finished: false,
    stars: 0,
    extra: {},
  }
  private raf = 0
  private lastT = 0
  private countdown = 3
  private elapsed = 0
  private duration = 60
  private hudT = 0
  private sim = false
  private bgKey = ''
  private bgImg: HTMLImageElement | null = null
  private bgReady = false

  constructor(canvas: HTMLCanvasElement, video: HTMLVideoElement, meta: GameMeta) {
    this.canvas = canvas
    this.video = video
    this.meta = meta
    this.duration = meta.duration || 0
    this.hud.timeLeft = this.duration
  }

  private setState(s: HostState) {
    this.state = s
    this.hooks.onState?.(s)
  }

  /** 加载场景装饰背景（SVG，仅在上下边缘作画，不遮摄像头） */
  private setBackground(key: string) {
    if (!key || this.bgKey === key) return
    this.bgKey = key
    this.bgReady = false
    const img = new Image()
    const base = import.meta.env.BASE_URL || '/'
    img.onload = () => {
      if (this.bgKey !== key) return
      this.bgImg = img
      this.bgReady = true
    }
    img.src = `${base}bg/${key}.svg`
  }

  private paintSceneBg(c: CanvasRenderingContext2D) {
    if (!this.bgReady || !this.bgImg) return
    c.drawImage(this.bgImg, 0, 0, W, H)
  }

  private emitHud(force = false) {
    const now = performance.now()
    if (!force && now - this.hudT < 80) return
    this.hudT = now
    this.hooks.onHud?.({ ...this.hud })
  }

  async boot(sim = false) {
    this.sim = sim
    this.setState('loading')
    if (sim) {
      tracker.simulate = true
      await this.startRound()
      return
    }
    tracker.simulate = false
    try {
      if (!tracker.ready) await tracker.init()
      if (!tracker.stream) await tracker.openCamera(this.video)
      await this.video.play().catch(() => undefined)
    } catch (e: any) {
      const msg =
        e?.name === 'NotAllowedError'
          ? '需要允许摄像头权限才能玩哦'
          : e?.name === 'NotFoundError'
            ? '没有找到摄像头，请接一个摄像头再试'
            : `设备初始化失败：${e?.message || e}`
      this.setState('error')
      this.hooks.onError?.(msg)
      return
    }
    await this.startRound()
  }

  async startRound() {
    const ctx: GameContext = {
      w: W,
      h: H,
      meta: this.meta,
      audio,
      difficulty: this.difficulty,
      hud: () => ({ ...this.hud }),
      setScore: (n) => {
        this.hud.score = n
        this.emitHud()
      },
      addScore: (n) => {
        this.hud.score += n
        this.emitHud()
      },
      setCombo: (n) => {
        this.hud.combo = n
        this.emitHud()
      },
      setStage: (s) => {
        this.hud.stage = s
        this.emitHud(true)
      },
      setExtra: (k, v) => {
        this.hud.extra[k] = v
        this.emitHud()
      },
      speak: (t) => audio.speak(t),
      finish: () => this.finish(),
    }
    this.game = await createGame(this.meta.slug, ctx)
    if (this.game?.bg) this.setBackground(this.game.bg)
    this.hud.score = 0
    this.hud.combo = 0
    this.hud.stage = ''
    this.hud.extra = {}
    this.hud.finished = false
    this.hud.running = true
    this.hud.timeLeft = this.duration
    this.hud.progress = 0
    this.elapsed = 0
    this.countdown = 3.2
    this.emitHud(true)
    this.setState('countdown')
    audio.speak(`准备，${this.meta.name}`)
    if (!this.raf) {
      this.lastT = performance.now()
      this.raf = requestAnimationFrame(this.loop)
    }
  }

  private loop = (now: number) => {
    this.raf = requestAnimationFrame(this.loop)
    const dt = Math.min(0.05, (now - this.lastT) / 1000)
    this.lastT = now
    const c = this.canvas.getContext('2d')
    if (!c) return
    c.setTransform(1, 0, 0, 1, 0, 0)
    c.clearRect(0, 0, this.canvas.width, this.canvas.height)
    const k = this.canvas.width / W
    c.setTransform(k, 0, 0, k, 0, 0)
    if (this.sim) this.paintSimBg(c)
    this.paintSceneBg(c)

    if (this.state === 'countdown') {
      const frame = tracker.detect(now)
      if (this.sim) this.drawSimBody(c, frame)
      this.countdown -= dt
      const n = Math.ceil(this.countdown)
      const prev = Math.ceil(this.countdown + dt)
      if (n !== prev && n > 0) audio.countdown(false)
      if (this.countdown <= 0) {
        audio.whistle()
        this.setState('playing')
      } else {
        const frac = this.countdown - Math.floor(this.countdown)
        c.globalAlpha = Math.min(1, frac * 2.2)
        const scale = 1 + (1 - frac) * 0.25
        c.save()
        c.translate(W / 2, H / 2)
        c.scale(scale, scale)
        outlineTxt(c, String(n), 0, 0, 180, '#fff')
        c.restore()
        c.globalAlpha = 1
        outlineTxt(c, '准备好，站到镜头前', W / 2, H / 2 + 140, 36, '#fff9')
      }
      this.drawHint(c, frame.bodies.length)
      return
    }

    if (this.state !== 'playing' && this.state !== 'paused') {
      if (this.state === 'finished') this.drawFinishedScene(c)
      return
    }

    const frame = tracker.detect(now)
    if (this.sim) this.drawSimBody(c, frame)
    this.drawHint(c, frame.bodies.length)

    if (this.state === 'paused') {
      c.fillStyle = 'rgba(8,12,32,.55)'
      c.fillRect(0, 0, W, H)
      outlineTxt(c, '已暂停', W / 2, H / 2 - 20, 72)
      outlineTxt(c, '按空格或点“继续”接着玩', W / 2, H / 2 + 70, 30, '#ffffffcc')
      this.game?.draw(c)
      return
    }

    if (this.duration > 0) {
      this.elapsed += dt
      this.hud.timeLeft = Math.max(0, this.duration - this.elapsed)
      this.hud.progress = Math.min(1, this.elapsed / this.duration)
      if (this.hud.timeLeft <= 0) {
        this.finish()
        return
      }
    } else {
      this.elapsed += dt
      this.hud.timeLeft = this.elapsed
      this.hud.progress = 0
    }
    this.emitHud()

    try {
      this.game?.update(frame, dt)
      this.game?.draw(c)
    } catch (e) {
      console.error('[game] runtime error', e)
    }
  }

  /** 演示模式的底色：只有天空渐变，场景元素交给装饰背景 */
  private paintSimBg(c: CanvasRenderingContext2D) {
    const g = c.createLinearGradient(0, 0, 0, H)
    g.addColorStop(0, '#cfe6ff')
    g.addColorStop(0.55, '#eaf4ff')
    g.addColorStop(1, '#eef7ff')
    c.fillStyle = g
    c.fillRect(0, 0, W, H)
  }

  private drawSimBody(c: CanvasRenderingContext2D, frame: ReturnType<typeof tracker.detect>) {
    for (const b of frame.bodies) {
      const X = (n: number) => n * W
      const Y = (n: number) => n * H
      const hr = Math.max(26, b.scale * 88)
      const limb = Math.max(16, b.scale * 46)
      c.lineCap = 'round'
      c.strokeStyle = '#2b5dd7'
      c.lineWidth = limb
      // 躯干
      c.beginPath()
      c.moveTo(X(b.shoulderC.x), Y(b.shoulderC.y))
      c.lineTo(X(b.hipC.x), Y(b.hipC.y))
      c.stroke()
      // 手臂
      c.lineWidth = limb * 0.72
      for (const [s, e, w] of [
        [b.lShoulder, b.lElbow, b.lHand],
        [b.rShoulder, b.rElbow, b.rHand],
      ] as const) {
        c.beginPath()
        c.moveTo(X(s.x), Y(s.y))
        c.lineTo(X(e.x), Y(e.y))
        c.lineTo(X(w.x), Y(w.y))
        c.stroke()
      }
      // 腿
      for (const [h, kn, f] of [
        [b.lHip, b.lKnee, b.lFoot],
        [b.rHip, b.rKnee, b.rFoot],
      ] as const) {
        c.beginPath()
        c.moveTo(X(h.x), Y(h.y))
        c.lineTo(X(kn.x), Y(kn.y))
        c.lineTo(X(f.x), Y(f.y))
        c.stroke()
      }
      // 头
      c.beginPath()
      c.arc(X(b.head.x), Y(b.head.y) - hr * 0.15, hr, 0, Math.PI * 2)
      c.fillStyle = '#ffd9b3'
      c.fill()
      c.lineWidth = 4
      c.strokeStyle = '#2b5dd7'
      c.stroke()
      // 眼睛
      c.fillStyle = '#243b6b'
      c.beginPath()
      c.arc(X(b.head.x) - hr * 0.32, Y(b.head.y) - hr * 0.25, hr * 0.09, 0, Math.PI * 2)
      c.arc(X(b.head.x) + hr * 0.32, Y(b.head.y) - hr * 0.25, hr * 0.09, 0, Math.PI * 2)
      c.fill()
      // 手
      for (const h of [b.lHand, b.rHand]) {
        c.beginPath()
        c.arc(X(h.x), Y(h.y), limb * 0.62, 0, Math.PI * 2)
        c.fillStyle = '#ffd54a'
        c.fill()
        c.lineWidth = 3
        c.strokeStyle = 'rgba(30,50,110,.5)'
        c.stroke()
      }
    }
  }

  private drawHint(c: CanvasRenderingContext2D, n: number) {
    if (n > 0) return
    c.fillStyle = 'rgba(8,12,32,.35)'
    c.fillRect(0, 0, W, H)
    outlineTxt(c, '没看到你，站到摄像头前', W / 2, H / 2 - 20, 52)
    outlineTxt(c, '离摄像头 2～3 米，从头到脚都进画面', W / 2, H / 2 + 56, 30, '#ffffffd0')
  }

  private drawFinishedScene(c: CanvasRenderingContext2D) {
    this.game?.draw(c)
    c.fillStyle = 'rgba(8,12,32,.5)'
    c.fillRect(0, 0, W, H)
  }

  pause() {
    if (this.state !== 'playing') return
    this.setState('paused')
  }

  resume() {
    if (this.state !== 'paused') return
    this.lastT = performance.now()
    this.setState('playing')
  }

  togglePause() {
    if (this.state === 'playing') this.pause()
    else if (this.state === 'paused') this.resume()
  }

  finish() {
    if (this.state === 'finished') return
    this.setState('finished')
    this.hud.running = false
    this.hud.finished = true
    const stars = this.calcStars()
    this.hud.stars = stars
    audio.setVoice(true)
    audio.stopBgm()
    audio.result(stars)
    if (stars >= 3) {
      audio.speak('太棒了，三颗星')
    } else if (stars >= 2) {
      audio.speak('不错哦，两颗星')
    } else {
      audio.speak('完成啦，再试一次吧')
    }
    this.emitHud(true)
    this.hooks.onFinish?.({
      ...this.hud,
      stars,
      durationPlayed: Math.round(this.elapsed),
    })
  }

  private calcStars() {
    const { score } = this.hud
    const s3 = this.meta.star3
    const s2 = this.meta.star2
    if (s3 > 0) {
      if (score >= s3) return 3
      if (score >= s2) return 2
      return 1
    }
    if (score >= 220) return 3
    if (score >= 130) return 2
    return 1
  }

  destroy() {
    cancelAnimationFrame(this.raf)
    this.raf = 0
    this.game?.destroy?.()
    this.game = null
    this.hud.running = false
    tracker.simulate = false
    tracker.stop()
  }
}
