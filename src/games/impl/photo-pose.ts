import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, emoji, glow, outlineTxt, rr, star, txt } from '@/core/draw'

/**
 * 咔嚓合影（对齐逆向报告 photo-pose.md）：
 * 小摄影师报姿势 → 3、2、1 倒数 → 快门瞬间按「姿势 / 笑容 / 静止」三项判定出 0~3 星，
 * 每张照片飞入侧边相册；时长 75s 拍满 k 张后进入相册收尾。
 */

/** 难度表（报告 §1）：intro 报姿势铺垫 / tick 倒数拍距 / smile 笑容阈值 / energy 静止阈值 / tol 姿势容差 / pool 姿势池 / first 首张姿势 */
const DIFF = [
  {
    intro: 1.6, tick: 1.2, review: 1.5, smile: 0.3, energy: 0.5,
    k: 1.15, starSpan: 1.6, starFeet: 0.8,
    pool: ['up', 'oneHand', 'hips', 'heart'], first: 'up',
  },
  {
    intro: 1.4, tick: 1.05, review: 1.5, smile: 0.35, energy: 0.4,
    k: 1, starSpan: 1.8, starFeet: 0.9,
    pool: ['up', 'oneHand', 'hips', 'heart', 'oneLeg', 'star'], first: 'up',
  },
  {
    intro: 1.2, tick: 0.9, review: 1.3, smile: 0.4, energy: 0.32,
    k: 0.9, starSpan: 1.9, starFeet: 0.9,
    pool: ['oneHand', 'hips', 'heart', 'oneLeg', 'star', 'plane', 'muscle'], first: 'oneHand',
  },
]

const POSE_NAME: Record<string, string> = {
  up: '举高高',
  oneHand: '举一只手',
  hips: '叉腰',
  heart: '比个爱心',
  oneLeg: '金鸡独立',
  star: '大星星',
  plane: '开飞机',
  muscle: '大力士',
}

/** 规则常量（报告 L164-168）：首张延迟 / 结尾相册预留 / 姿势窗 / 笑容窗 / 静止窗 */
const FIRST_DELAY = 0.8
const ALBUM_RESERVE = 3
const POSE_WIN = 0.45
const SMILE_WIN = 0.6
const STILL_WIN = 0.3
const FLASH_T = 0.8 // 快门白屏闪光时长
const COACH_T = 0.5 // 快门后语音评语延迟（单人）

/** 关节快照：拍下快门瞬间的身体点位，用于渲染相片 */
interface Snap {
  pts: { x: number; y: number }[]
  color: string
  stars: number
}

/** 一张照片的时间轴与结果 */
interface Photo {
  pose: string
  at: number
  count: number
  shutter: number
  end: number
  done: boolean
  /** 每玩家结果 */
  poseOk: boolean[]
  smile: boolean[]
  still: boolean[]
  stars: number[]
  snap: (Snap | null)[]
  beat: number
  commented: boolean
}

/** 每帧采样（保留最近 1s，报告 B()） */
interface Sample {
  t: number
  pose: boolean
  smile: number
  energy: number
}

/** 姿势达标判定（黑盒 d(poseId, body, motion, tol) 的本地实现，几何阈值自行设计并注明） */
function checkPose(pose: string, b: Body, cfg: (typeof DIFF)[number], side: number): boolean {
  const k = cfg.k
  const s = Math.max(0.06, b.scale)
  switch (pose) {
    case 'up':
      return b.lHandAboveHead && b.rHandAboveHead
    case 'oneHand':
      // 报告 J()：oneHand → leftUp/rightUp 按 (玩家idx+照片idx)%2 轮换
      return side === 0 ? b.lHandAboveHead : b.rHandAboveHead
    case 'hips':
      return (
        Math.hypot(b.lHand.x - b.lHip.x, b.lHand.y - b.lHip.y) < s * 0.55 * k &&
        Math.hypot(b.rHand.x - b.rHip.x, b.rHand.y - b.rHip.y) < s * 0.55 * k
      )
    case 'heart': {
      // 报告 J()：双手放鼻子上方（x±torso*0.1, y - torso*0.36）
      const lx = b.head.x - s * 0.1
      const rx = b.head.x + s * 0.1
      const hy = b.head.y - s * 0.36
      return (
        Math.hypot(b.lHand.x - lx, b.lHand.y - hy) < s * 0.35 * k &&
        Math.hypot(b.rHand.x - rx, b.rHand.y - hy) < s * 0.35 * k
      )
    }
    case 'oneLeg':
    case 'plane':
      // 报告 J()：oneLeg/plane → kneeL（抬一条腿）
      return (b.lKnee.y < b.rKnee.y - 0.045 || b.rKnee.y < b.lKnee.y - 0.045) && !b.jumping
    case 'star':
      // starSpan/starFeet：大字姿势双臂/双腿展开容差（黑盒，本地按 scale 折算）
      return (
        Math.abs(b.lHand.x - b.rHand.x) > (s * 0.9) / k &&
        b.lHand.y < b.shoulderC.y - s * 0.1 / k &&
        b.rHand.y < b.shoulderC.y - s * 0.1 / k &&
        b.feetSpread > (s * cfg.starFeet) / 2.2 / k
      )
    case 'muscle':
      // 大力士：双手收在肩旁、肘部外撑
      return (
        Math.abs(b.lHand.x - b.lShoulder.x) < s * 0.45 * k &&
        Math.abs(b.rHand.x - b.rShoulder.x) < s * 0.45 * k &&
        Math.abs(b.lHand.y - b.shoulderC.y) < s * 0.4 * k &&
        Math.abs(b.rHand.y - b.shoulderC.y) < s * 0.4 * k &&
        b.lElbow.x < b.lHand.x - s * 0.15 &&
        b.rElbow.x > b.rHand.x + s * 0.15
      )
    default:
      return false
  }
}

/** 目标姿势简笔小人（取景框内示范用） */
function drawPoseHint(c: CanvasRenderingContext2D, pose: string, size: number) {
  const h = size
  c.lineCap = 'round'
  c.lineJoin = 'round'
  c.beginPath()
  c.arc(0, -h * 0.42, h * 0.1, 0, Math.PI * 2)
  c.fill()
  c.beginPath()
  c.moveTo(0, -h * 0.3)
  c.lineTo(0, h * 0.14)
  c.stroke()
  const arm = (sx: number, ex: number, ey: number, hx: number, hy: number) => {
    c.beginPath()
    c.moveTo(sx * h, -h * 0.26)
    c.lineTo(ex * h, ey * h)
    c.lineTo(hx * h, hy * h)
    c.stroke()
  }
  const leg = (sx: number, kx: number, ky: number, fx: number, fy: number) => {
    c.beginPath()
    c.moveTo(sx * h, h * 0.14)
    c.lineTo(kx * h, ky * h)
    c.lineTo(fx * h, fy * h)
    c.stroke()
  }
  switch (pose) {
    case 'up':
      arm(-0.09, -0.2, -0.44, -0.28, -0.62)
      arm(0.09, 0.2, -0.44, 0.28, -0.62)
      leg(-0.07, -0.13, 0.38, -0.15, 0.6)
      leg(0.07, 0.13, 0.38, 0.15, 0.6)
      break
    case 'oneHand':
      arm(-0.09, -0.2, -0.44, -0.28, -0.62)
      arm(0.09, 0.2, -0.1, 0.26, 0.16)
      leg(-0.07, -0.13, 0.38, -0.15, 0.6)
      leg(0.07, 0.13, 0.38, 0.15, 0.6)
      break
    case 'hips':
      arm(-0.09, -0.26, -0.14, -0.19, 0.06)
      arm(0.09, 0.26, -0.14, 0.19, 0.06)
      leg(-0.07, -0.13, 0.38, -0.15, 0.6)
      leg(0.07, 0.13, 0.38, 0.15, 0.6)
      break
    case 'heart':
      arm(-0.09, -0.2, -0.42, -0.05, -0.5)
      arm(0.09, 0.2, -0.42, 0.05, -0.5)
      leg(-0.07, -0.13, 0.38, -0.15, 0.6)
      leg(0.07, 0.13, 0.38, 0.15, 0.6)
      break
    case 'oneLeg':
    case 'plane':
      arm(-0.09, -0.3, -0.26, -0.48, -0.14)
      arm(0.09, 0.3, -0.26, 0.48, -0.14)
      leg(-0.07, -0.15, 0.38, -0.16, 0.6)
      leg(0.07, 0.28, 0.26, 0.05, 0.34)
      break
    case 'star':
      arm(-0.09, -0.36, -0.32, -0.6, -0.2)
      arm(0.09, 0.36, -0.32, 0.6, -0.2)
      leg(-0.07, -0.26, 0.36, -0.4, 0.58)
      leg(0.07, 0.26, 0.36, 0.4, 0.58)
      break
    default: // muscle
      arm(-0.09, -0.3, -0.36, -0.24, -0.1)
      arm(0.09, 0.3, -0.36, 0.24, -0.1)
      leg(-0.07, -0.13, 0.38, -0.15, 0.6)
      leg(0.07, 0.13, 0.38, 0.15, 0.6)
      break
  }
}

/** 咔嚓合影 */
class PhotoPose extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  unit = this.H / 720
  /** 总时长（含 0.8 首延迟与 3s 相册预留，报告 L187-189） */
  D = this.ctx.meta.duration || 75
  /** 每张周期 O = intro + 3*tick */
  O = 0
  /** 实际均摊周期 A */
  A = 0
  photos: Photo[] = []
  score = 0
  /** 每玩家采样缓冲（1s）与运动能量平滑 */
  samples: Sample[][] = [[], []]
  private prevLm: ({ x: number; y: number } | null)[][] = [[], []]
  private energySm = [0, 0]
  /** 笑容代理：双手上举开心姿势（见 tick 内注释） */
  album: Snap[] = []
  flashT = 0
  bannerT = 0
  bannerText = ''
  bannerColor = '#fff'
  albumShown = false
  stats = {
    shots: 0,
    perfect: 0,
    smiles: 0,
    duoPerfect: 0,
  }

  constructor(ctx: GameContext) {
    super(ctx)
    const cfg = this.cfg
    this.O = cfg.intro + 3 * cfg.tick
    // 照片数 k = max(1, floor((D - y - b) / (O + review)))，实际周期 A = (D-y-b)/k（报告 L187-189）
    const span = this.D - FIRST_DELAY - ALBUM_RESERVE
    const n = Math.max(1, Math.floor(span / (this.O + cfg.review)))
    this.A = span / n
    let prev: string | null = null
    for (let i = 0; i < n; i++) {
      // 抽姿势避免与上一张相同（报告 L219）
      let pool = cfg.pool.filter((p) => p !== prev)
      if (!pool.length) pool = cfg.pool
      const pose = i === 0 ? cfg.first : pool[Math.floor(Math.random() * pool.length)]
      prev = pose
      const at = FIRST_DELAY + i * this.A
      this.photos.push({
        pose,
        at,
        count: at + cfg.intro,
        shutter: at + this.O,
        end: at + this.A,
        done: false,
        poseOk: [false, false],
        smile: [false, false],
        still: [false, false],
        stars: [0, 0],
        snap: [null, null],
        beat: 0,
        commented: false,
      })
    }
    ctx.setStage('小摄影师准备……')
  }

  private current(): Photo | null {
    let cur: Photo | null = null
    for (const p of this.photos) if (this.t >= p.at) cur = p
    return cur
  }

  tick(f: PoseFrame, dt: number) {
    void f
    this.flashT = Math.max(0, this.flashT - dt)
    this.bannerT = Math.max(0, this.bannerT - dt)

    const photo = this.current()
    if (!photo) return

    // 报姿势
    if (!photo.done && this.t < photo.count && photo.beat === 0 && this.t - dt < photo.at) {
      this.bannerT = 1.2
      this.bannerText = POSE_NAME[photo.pose]
      this.bannerColor = '#ff8fa3'
      this.ctx.speak(POSE_NAME[photo.pose])
      this.ctx.setStage(`${POSE_NAME[photo.pose]}，准备……`)
    }

    // 采样：从倒数后半段（count - intro*0.5）开始记录（报告 L470）
    if (this.t >= photo.count - this.cfg.intro * 0.5 && this.t <= photo.shutter) {
      for (const pv of this.players) {
        const b = pv.body
        const buf = this.samples[pv.id]
        if (!b) {
          buf.push({ t: this.t, pose: false, smile: 0, energy: 1 })
        } else {
          buf.push({
            t: this.t,
            pose: checkPose(photo.pose, b, this.cfg, (pv.id + this.photos.indexOf(photo)) % 2),
            // 笑容代理：框架无 face.smile 数据 → 用「双手上举张开的开心姿势」作 smile=1 的代理，
            // 数值过阈值 w.smile（0.3/0.35/0.4）；代理为 0 时不过（原站点此时会看真实脸部）
            smile: b.lHandAboveHead && b.rHandAboveHead ? 1 : 0,
            energy: this.energySm[pv.id],
          })
        }
        while (buf.length && buf[0].t < this.t - 1) buf.shift()
      }
    }

    // 倒数三拍：count + (r-1)*tick（报告 L469），播 三/二/一 + sfx tick
    for (let r = 1; r <= 3; r++) {
      const bt = photo.count + (r - 1) * this.cfg.tick
      if (this.t >= bt && photo.beat < r) {
        photo.beat = r
        this.ctx.audio.tick()
        this.ctx.speak(['三', '二', '一'][r - 1])
      }
    }

    // 快门
    if (!photo.done && this.t >= photo.shutter) {
      photo.done = true
      this.shoot(photo)
    }
  }

  /** 快门判定 V()（报告 §2）：三项各自取窗，星级 = pose ? 1 + smile + still : 0 */
  private shoot(photo: Photo) {
    this.stats.shots++
    this.flashT = FLASH_T
    // sfx click + pop（报告 L314）
    this.ctx.audio.play('click', 0.7)
    this.ctx.audio.pop()
    this.say('咔嚓！', this.W / 2, this.H * 0.3, '#ffffff', 44)

    const duo = this.players.filter((p) => p.body).length > 1
    for (const pv of this.players) {
      const buf = this.samples[pv.id].filter((s2) => s2.t >= this.t - POSE_WIN)
      const recent = this.samples[pv.id]
      const b = pv.body
      // 姿势：0.45s 窗达标率 >= 0.4 或最后一帧达标（报告 L282）
      const poseOk = buf.length > 0 && (buf.filter((s2) => s2.pose).length / buf.length >= 0.4 || buf[buf.length - 1].pose)
      // 笑容：最近 0.6s 内任一帧过阈值（报告 L284）；镜头里没见过人 → 采样即空，视为未见过脸不判（这里按不过处理，0 星）
      const smileWin = recent.filter((s2) => s2.t >= this.t - SMILE_WIN)
      const smile = smileWin.some((s2) => s2.smile >= this.cfg.smile)
      // 静止：最近 0.3s 平均能量 < 阈值（报告 L286）
      const stillWin = recent.filter((s2) => s2.t >= this.t - STILL_WIN)
      const still = stillWin.length > 0 && stillWin.reduce((n, s2) => n + s2.energy, 0) / stillWin.length < this.cfg.energy
      const stars = poseOk ? 1 + (smile ? 1 : 0) + (still ? 1 : 0) : 0
      photo.poseOk[pv.id] = poseOk
      photo.smile[pv.id] = smile
      photo.still[pv.id] = still
      photo.stars[pv.id] = stars
      photo.snap[pv.id] = b && stars > 0 ? this.snapshot(b, stars, pv.color) : null
      if (b && stars > 0) this.album.push(photo.snap[pv.id]!)

      this.score += stars
      if (stars >= 3) {
        this.stats.perfect++
        // 3 星：星星粒子 16 颗 speed 380*unit（报告 §3）
        this.particles.burst(pv.lHand.x, this.H * 0.35, '#ffd54a', 16, 380 * this.unit, 6)
      }
      if (smile) this.stats.smiles++

      // 结果音效按星级（报告 L355）：3 tada / 2 chime / 1 coin / 0 boop
      if (stars >= 3) this.ctx.audio.win()
      else if (stars === 2) this.ctx.audio.good()
      else if (stars === 1) this.ctx.audio.pop()
      else this.ctx.audio.fail()

      // 大屏提示语义（报告 L500-508）：缺什么提示什么
      const hx = b ? b.head.x * this.W : (pv.id ? 0.75 : 0.25) * this.W
      const hy = b ? b.head.y * this.H - 70 : this.H * 0.4
      if (!poseOk) this.say(POSE_NAME[photo.pose], hx, hy, '#ffd54a', 30)
      else if (!smile) this.say('笑一笑', hx, hy, '#ff8fa3', 30)
      else if (!still) this.say('别动', hx, hy, '#7dd3fc', 30)

      // 单人语音教练（报告 L371-378）：快门后 0.5s 播评语
      if (!duo && !photo.commented) {
        photo.commented = true
        const idx = this.photos.indexOf(photo)
        const msg = stars >= 3 ? ['完美！', '真好看！', '太棒啦！'][idx % 3]
          : stars === 2 ? (smile ? '别动哦' : '要笑一笑哦')
          : '摆好姿势哦'
        window.setTimeout(() => this.ctx.speak(msg), COACH_T * 1000)
      }
    }

    // 双人双 3 星 → 完美合照（报告 L356-369）
    const present = this.players.filter((p) => p.body)
    if (duo && present.length === 2 && present.every((p) => photo.stars[p.id] >= 3)) {
      this.stats.duoPerfect++
      this.bannerT = 1.4
      this.bannerText = '完美合照！'
      this.bannerColor = '#ff8fa3'
      this.particles.burst(this.W / 2, this.H * 0.4, '#ff8fa3', 6, 300, 9)
      this.ctx.audio.fanfare()
    }

    // 清采样缓冲，进入回看
    this.samples = [[], []]
    this.ctx.setScore(this.score)
    this.ctx.setExtra('拍了', this.stats.shots)
    this.ctx.setExtra('三星', this.stats.perfect)
    this.ctx.setExtra('笑脸', this.stats.smiles)
    if (duo) this.ctx.setExtra('合照', this.stats.duoPerfect)
    const last = this.photos[this.photos.length - 1]
    if (photo === last) {
      this.albumShown = true
      this.bannerT = 1.6
      this.bannerText = '拍完啦，看看相册！'
      this.bannerColor = '#ffd54a'
      // sfx sparkle（本地无素材，用 fanfare 兜底）
      this.ctx.audio.play('fanfare', 0.7)
      this.ctx.setStage('拍完啦，看看相册！')
    }
  }

  /** 关节快照（渲染相片用） */
  private snapshot(b: Body, stars: number, color: string): Snap {
    const pts: { x: number; y: number }[] = []
    const keys: (keyof Body)[] = [
      'head', 'shoulderC', 'hipC', 'lHand', 'rHand', 'lElbow', 'rElbow',
      'lShoulder', 'rShoulder', 'lHip', 'rHip', 'lKnee', 'rKnee', 'lFoot', 'rFoot',
    ]
    for (const key of keys) {
      const p = b[key] as { x: number; y: number }
      pts.push({ x: p.x * this.W, y: p.y * this.H })
    }
    return { pts, color, stars }
  }

  /** 运动能量代理：帧间关节均速 / 躯干长的指数平滑（框架无 motion.energy，本地代理并注明） */
  private updateEnergy(b: Body, dt: number) {
    const id = b.id
    const prev = this.prevLm[id]
    if (prev.length !== b.lm.length) {
      this.prevLm[id] = b.lm.map((p) => ({ x: p.x, y: p.y }))
      this.energySm[id] = 0
      return
    }
    let sum = 0
    let n = 0
    const scale = Math.max(0.05, b.scale)
    for (let i = 0; i < b.lm.length; i++) {
      const p = b.lm[i]
      const q = prev[i]
      if (!q || (p.visibility ?? 1) < 0.5) continue
      sum += Math.hypot(p.x - q.x, p.y - q.y) / Math.max(0.016, dt) / scale
      n++
      prev[i] = { x: p.x, y: p.y }
    }
    const raw = n ? sum / n : 0
    const k = 1 - Math.exp(-dt / 0.15)
    this.energySm[id] += (raw - this.energySm[id]) * k
  }

  update(f: PoseFrame, dt: number) {
    for (const b of f.bodies) this.updateEnergy(b, dt)
    super.update(f, dt)
  }

  paint(c: CanvasRenderingContext2D) {
    const photo = this.current()

    // 取景框（solo 0.08~0.92 / duo 0.03~0.47 · 0.53~0.97）
    const duo = this.players.filter((p) => p.body).length > 1
    for (const pv of this.players) {
      const x0 = duo ? (pv.id === 0 ? 0.03 : 0.53) : 0.08
      const x1 = duo ? (pv.id === 0 ? 0.47 : 0.97) : 0.92
      if (!duo && pv.id === 1) continue
      const fx = x0 * this.W + 12
      const fy = this.H * 0.16
      const fw = (x1 - x0) * this.W - 24
      const fh = this.H * 0.56
      const live = !!pv.body

      // 最新三项状态图标（pose/smile/still，报告 L496-500）
      const latest = this.samples[pv.id][this.samples[pv.id].length - 1]
      const tri = latest ? [latest.pose, latest.smile >= this.cfg.smile, latest.energy < this.cfg.energy] : [false, false, false]
      const allGreen = tri.every(Boolean)

      c.save()
      c.strokeStyle = allGreen ? '#3ddc97' : 'rgba(255,255,255,.5)'
      c.lineWidth = 5
      c.fillStyle = 'rgba(12,18,44,.36)'
      rr(c, fx, fy, fw, fh, 26)
      c.fill()
      c.stroke()

      if (!live) {
        txt(c, '站到镜头前', fx + fw / 2, fy + fh / 2, 24, 'rgba(255,255,255,.6)')
      } else if (photo) {
        // 目标姿势示范
        c.save()
        c.translate(fx + fw / 2, fy + fh / 2)
        c.globalAlpha = 0.6
        c.fillStyle = pv.color
        c.strokeStyle = pv.color
        c.lineWidth = 9
        drawPoseHint(c, photo.pose, fh * 0.6)
        c.restore()

        // 倒数大数字（快门前）
        if (this.t >= photo.count && this.t < photo.shutter) {
          const r = Math.min(3, Math.floor((this.t - photo.count) / this.cfg.tick) + 1)
          const frac = 1 - ((this.t - photo.count) % this.cfg.tick) / this.cfg.tick
          const cx = fx + fw / 2
          const cy = fy + fh * 0.32
          circle(c, cx, cy, 52, 'rgba(255,255,255,.92)')
          c.strokeStyle = '#ff4d6d'
          c.lineWidth = 6
          c.beginPath()
          c.arc(cx, cy, 52, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac)
          c.stroke()
          outlineTxt(c, String(4 - r), cx, cy + 2, 56, '#ff4d6d', 'rgba(255,255,255,.9)')
        }

        // 三状态勾叉
        const icons = ['姿势', '笑容', '不动']
        for (let i = 0; i < 3; i++) {
          const ix = fx + fw * (0.25 + i * 0.25)
          const iy = fy + fh - 30
          c.globalAlpha = tri[i] ? 1 : 0.4
          outlineTxt(c, tri[i] ? '✓' : '✗', ix, iy, 26, tri[i] ? '#3ddc97' : '#ff6b6b')
          txt(c, icons[i], ix, iy + 22, 14, 'rgba(255,255,255,.75)')
          c.globalAlpha = 1
        }
        if (allGreen) glow(c, fx + fw / 2, fy + fh / 2, 150, '#3ddc97', 0.2)
      }
      c.restore()
    }

    // 相机 + 闪光
    const camX = this.W / 2
    const camY = 70
    c.save()
    c.fillStyle = '#2b2f4a'
    rr(c, camX - 64, camY - 30, 128, 60, 14)
    c.fill()
    c.fillStyle = '#1a1d33'
    circle(c, camX, camY, 22, '#1a1d33')
    c.fillStyle = '#8fd3ff'
    circle(c, camX, camY, 13, '#8fd3ff')
    if (this.flashT > 0.45) {
      circle(c, camX + 44, camY - 18, 9, '#fff6cc')
      glow(c, camX + 44, camY - 18, 26, '#fff6cc', 0.7)
    }
    c.restore()

    // 快门白屏闪光 0.8s（α = 1 - r²，报告 L314）
    if (this.flashT > 0) {
      const r = 1 - this.flashT / FLASH_T
      c.save()
      c.globalAlpha = Math.max(0, 1 - r * r)
      c.fillStyle = '#fff'
      c.fillRect(0, 0, this.W, this.H)
      c.restore()
    }

    // 横幅
    if (this.bannerT > 0) {
      c.save()
      c.globalAlpha = Math.min(1, this.bannerT / 0.3)
      outlineTxt(c, this.bannerText, this.W / 2, this.H * 0.12, 48, this.bannerColor)
      c.restore()
    }

    // 相册胶卷：右侧竖排最近 5 张，第 5 张淡出（报告 §4 相册系统，本地以缩略卡呈现）
    const n = Math.min(5, this.album.length)
    for (let i = 0; i < n; i++) {
      const snap = this.album[this.album.length - 1 - i]
      const w = 92
      const h = 112
      const x = this.W - 62
      const y = this.H * 0.24 + i * (h + 14)
      c.save()
      c.globalAlpha = i === 4 ? 0.4 : 1 - i * 0.08
      c.translate(x, y)
      c.rotate((i % 2 ? 1 : -1) * 0.05)
      c.fillStyle = '#fff'
      rr(c, -w / 2, -h / 2, w, h, 8)
      c.fill()
      const py0 = -h / 2 + 8
      c.save()
      c.beginPath()
      c.rect(-w / 2 + 6, py0, w - 12, h - 30)
      c.clip()
      const sc = 0.32
      c.strokeStyle = snap.color
      c.fillStyle = snap.color
      c.lineWidth = 2.5
      const segs: [number, number][] = [
        [0, 1], [1, 2], [3, 5], [5, 7], [4, 6], [6, 8], [1, 4], [2, 8], [9, 11], [11, 13], [10, 12], [12, 14],
      ]
      for (const [a, b2] of segs) {
        c.beginPath()
        c.moveTo(snap.pts[a].x * sc, py0 + snap.pts[a].y * sc)
        c.lineTo(snap.pts[b2].x * sc, py0 + snap.pts[b2].y * sc)
        c.stroke()
      }
      c.restore()
      for (let s2 = 0; s2 < 3; s2++) star(c, -18 + s2 * 18, h / 2 - 10, 7, s2 < snap.stars ? '#ffd54a' : 'rgba(0,0,0,.15)')
      c.restore()
    }
    if (this.album.length) emoji(c, '📷', this.W - 62, this.H * 0.24 - 34, 30)

    if (!photo && !this.albumShown) {
      txt(c, '小摄影师马上开始拍照，听口令摆姿势！', this.W / 2, this.H / 2, 26, 'rgba(255,255,255,.85)')
    }
  }
}

export default function create(ctx: GameContext) {
  return new PhotoPose(ctx)
}
