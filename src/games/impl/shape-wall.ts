import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, LM, PoseFrame } from '@/core/types'
import { glow, outlineTxt, txt } from '@/core/draw'

/**
 * 穿墙洞（对齐逆向报告 shape-wall.md）：
 * 一面带人形姿势洞的砖墙按周期推过来，摆出同款姿势即"穿过"；
 * 逐臂角度比对（大臂/小臂目标角 ± 容差）+ 腿部标记三选一（张开/蹲下/抬膝），
 * 全部墙打完即结束（catalog duration 0，由墙数驱动终局）。
 */

/** 难度表（报告 §1）：period 单墙周期 / walls 总墙数 / tol 判定容差（度）/ pool 姿势池 */
const DIFF = [
  { period: 7.5, walls: 8, tol: 40, pool: ['t', 'y', 'up', 'leftUp', 'rightUp'] },
  { period: 6, walls: 10, tol: 32, pool: ['t', 'y', 'up', 'leftUp', 'rightUp', 'star', 'muscle', 'hips'] },
  {
    period: 5,
    walls: 12,
    tol: 25,
    pool: ['t', 'y', 'up', 'leftUp', 'rightUp', 'star', 'muscle', 'hips', 'squat', 'kneeL'],
  },
]

/**
 * 姿势模板：报告 §8 说明目标角 la/lf/ra/rf 在黑盒 poses 模块（数值不可见），
 * 这里按角度约定自行设计：m()=atan2((t.x-e.x)*n, t.y-e.y)，0°=垂下、90°=侧平举、180°=举直
 */
const POSES: Record<string, PoseTpl> = {
  t: { name: 'T 字', say: '摆出 T 字', la: 90, lf: 90, ra: 90, rf: 90, legs: 0, crouch: false, knee: false },
  y: { name: 'Y 字', say: '摆出 Y 字', la: 135, lf: 150, ra: 135, rf: 150, legs: 0, crouch: false, knee: false },
  up: { name: '举高高', say: '把双手举高高', la: 170, lf: 170, ra: 170, rf: 170, legs: 0, crouch: false, knee: false },
  leftUp: { name: '举一只手', say: '举起一只手', la: 165, lf: 165, ra: 15, rf: 5, legs: 0, crouch: false, knee: false },
  rightUp: { name: '举一只手', say: '举起另一只手', la: 15, lf: 5, ra: 165, rf: 165, legs: 0, crouch: false, knee: false },
  star: { name: '大星星', say: '变成大星星', la: 130, lf: 135, ra: 130, rf: 135, legs: 26, crouch: false, knee: false },
  muscle: { name: '大力士', say: '秀出大力士肌肉', la: 85, lf: 150, ra: 85, rf: 150, legs: 0, crouch: false, knee: false },
  hips: { name: '叉腰', say: '双手叉腰', la: 55, lf: -35, ra: 55, rf: -35, legs: 0, crouch: false, knee: false },
  squat: { name: '蹲下', say: '蹲下来', la: 75, lf: 120, ra: 75, rf: 120, legs: 0, crouch: true, knee: false },
  kneeL: { name: '金鸡独立', say: '抬起一条腿', la: 60, lf: 60, ra: 60, rf: 60, legs: 0, crouch: false, knee: true },
}

interface PoseTpl {
  name: string
  say: string
  /** 左侧大臂/小臂目标角（度） */
  la: number
  lf: number
  /** 右侧大臂/小臂目标角（度） */
  ra: number
  rf: number
  /** 双腿张开目标角（度），0 = 不查腿（报告：star 类 legs >= 14） */
  legs: number
  /** 蹲下判定 */
  crouch: boolean
  /** 金鸡独立判定 */
  knee: boolean
}

/** 单次匹配结果：ok 全部误差达标 / acc 相似度 0~1 / armOk 逐臂着色 / legOk 腿部着色（null = 该姿势不查腿） */
interface MatchResult {
  ok: boolean
  acc: number
  armOk: [boolean, boolean]
  legOk: boolean | null
}

/** 报告 §2：m() 相对竖直方向的角度（镜像系数 n=±1），0°=垂下 */
function ang(ax: number, ay: number, bx: number, by: number, n: number) {
  return (Math.atan2((bx - ax) * n, by - ay) * 180) / Math.PI
}

/** 报告 §2：h() 环形最短角差 */
function ringDiff(e: number, t: number) {
  return Math.abs(((e - t + 540) % 360) - 180)
}

function vis(p: LM | undefined) {
  return (p?.visibility ?? 0) > 0.5
}

/**
 * matchPose（报告 §2 g()）：逐臂角度比对 + 腿部三选一。
 * 无可见手臂直接 {ok:false, acc:0}；acc = 各误差 clamp(1 - err/(2.5*tol)) 的平均值。
 */
function matchPose(b: Body, tpl: PoseTpl, tol: number): MatchResult {
  const lm = b.lm
  const errors: number[] = []
  const armOk: [boolean, boolean] = [false, false]
  let anyArm = false

  // 左右归一化：左肩 x > 右肩 x（玩家背对镜头）→ 左右目标互换（报告 L118）
  const away = lm[11] && lm[12] && lm[11].x > lm[12].x
  // 链：物理左 11/13/15（镜像系数 -1）、物理右 12/14/16（+1）
  const chains = [
    { i: [11, 13, 15], n: -1, t: away ? [tpl.ra, tpl.rf] : [tpl.la, tpl.lf] },
    { i: [12, 14, 16], n: 1, t: away ? [tpl.la, tpl.lf] : [tpl.ra, tpl.rf] },
  ]
  for (let s = 0; s < 2; s++) {
    const [si, ei, wi] = chains[s].i
    const [sh, el, wr] = [lm[si], lm[ei], lm[wi]]
    if (!(vis(sh) && vis(el) && vis(wr))) continue
    anyArm = true
    const n = chains[s].n
    let upper = ringDiff(ang(sh.x, sh.y, el.x, el.y, n), chains[s].t[0])
    let fore = ringDiff(ang(el.x, el.y, wr.x, wr.y, n), chains[s].t[1])
    // 高举姿势（肩目标角 |n| > 160）小臂误差 × 0.6（腕部角度不可靠，报告 L130）
    if (Math.abs(chains[s].t[0]) > 160) fore *= 0.6
    errors.push(upper, fore)
    armOk[s] = upper <= tol && fore <= tol
  }
  if (!anyArm) return { ok: false, acc: 0, armOk, legOk: null }

  // 腿部比对：需 4 点髋/膝可见（报告 L135-149），三选一
  let legOk: boolean | null = null
  const needLegs = tpl.legs > 0 || tpl.crouch || tpl.knee
  if (needLegs) {
    const hips = [lm[23], lm[24]]
    const knees = [lm[25], lm[26]]
    if (hips.every(vis) && knees.every(vis)) {
      const shC = { x: (lm[11].x + lm[12].x) / 2, y: (lm[11].y + lm[12].y) / 2 }
      const hipC = { x: (hips[0].x + hips[1].x) / 2, y: (hips[0].y + hips[1].y) / 2 }
      const torso = Math.max(0.02, Math.hypot(shC.x - hipC.x, shC.y - hipC.y))
      let legErr: number
      if (tpl.legs > 0 && !tpl.crouch) {
        // 双腿张开平均角，罚量 = max(0, legs - tol*0.45 - e) × 2
        const e = (ang(hips[0].x, hips[0].y, knees[0].x, knees[0].y, -1) + ang(hips[1].x, hips[1].y, knees[1].x, knees[1].y, 1)) / 2
        legErr = Math.max(0, tpl.legs - tol * 0.45 - e) * 2
      } else if (tpl.crouch) {
        // 蹲下：膝盖-髋竖直距离 / 躯干 均值须 ≤ 0.47，罚量 ×160
        const v = (knees[0].y - hips[0].y + (knees[1].y - hips[1].y)) / 2 / torso
        legErr = Math.max(0, v - 0.47) * 160
      } else {
        // 金鸡独立：min(膝盖抬起比) 须 ≤ 0.33，罚量 ×160
        const v = Math.min(knees[0].y - hips[0].y, knees[1].y - hips[1].y) / torso
        legErr = Math.max(0, v - 0.33) * 160
      }
      errors.push(legErr)
      legOk = legErr <= tol
    } else {
      // 该姿势需要腿部但关键点不可见 → 视为大误差（不可过墙）
      errors.push(tol * 3)
      legOk = false
    }
  }

  const ok = errors.every((e) => e <= tol)
  const acc = errors.reduce((n, e) => n + Math.max(0, Math.min(1, 1 - e / (2.5 * tol))), 0) / errors.length
  return { ok, acc, armOk, legOk }
}

/** 画一根圆头线段 */
function limb(c: CanvasRenderingContext2D, ax: number, ay: number, bx: number, by: number, w: number, color: string) {
  c.strokeStyle = color
  c.lineWidth = w
  c.lineCap = 'round'
  c.beginPath()
  c.moveTo(ax, ay)
  c.lineTo(bx, by)
  c.stroke()
}

/** 简笔姿势小人（打洞剪影 / 底部姿势牌共用），h 为全高像素 */
function drawFigure(c: CanvasRenderingContext2D, key: string, h: number) {
  const s = h / 150
  c.lineCap = 'round'
  c.lineJoin = 'round'
  c.beginPath()
  c.arc(0, -h * 0.82, 20 * s, 0, Math.PI * 2)
  c.fill()
  c.beginPath()
  c.moveTo(0, -h * 0.6)
  c.lineTo(0, h * 0.2)
  c.stroke()
  const arm = (sx: number, ex: number, ey: number, hx: number, hy: number) => {
    c.beginPath()
    c.moveTo(sx * s, -h * 0.5)
    c.lineTo(ex * s, ey * s)
    c.lineTo(hx * s, hy * s)
    c.stroke()
  }
  const leg = (sx: number, kx: number, ky: number, fx: number, fy: number) => {
    c.beginPath()
    c.moveTo(sx * s, h * 0.2)
    c.lineTo(kx * s, ky * s)
    c.lineTo(fx * s, fy * s)
    c.stroke()
  }
  switch (key) {
    case 't':
      arm(-18, -66, -75, -120, -75)
      arm(18, 66, -75, 120, -75)
      leg(-14, -26, 92, -30, 148)
      leg(14, 26, 92, 30, 148)
      break
    case 'y':
      arm(-18, -50, -95, -95, -125)
      arm(18, 50, -95, 95, -125)
      leg(-14, -26, 92, -30, 148)
      leg(14, 26, 92, 30, 148)
      break
    case 'up':
      arm(-18, -40, -95, -58, -145)
      arm(18, 40, -95, 58, -145)
      leg(-14, -26, 92, -30, 148)
      leg(14, 26, 92, 30, 148)
      break
    case 'leftUp':
      arm(-18, -40, -95, -58, -145)
      arm(18, 40, -20, 52, 45)
      leg(-14, -26, 92, -30, 148)
      leg(14, 26, 92, 30, 148)
      break
    case 'rightUp':
      arm(-18, -40, -20, -52, 45)
      arm(18, 40, -95, 58, -145)
      leg(-14, -26, 92, -30, 148)
      leg(14, 26, 92, 30, 148)
      break
    case 'star':
      arm(-18, -70, -60, -125, -30)
      arm(18, 70, -60, 125, -30)
      leg(-14, -55, 80, -85, 140)
      leg(14, 55, 80, 85, 140)
      break
    case 'muscle':
      arm(-18, -62, -70, -48, -18)
      arm(18, 62, -70, 48, -18)
      leg(-14, -26, 92, -30, 148)
      leg(14, 26, 92, 30, 148)
      break
    case 'hips':
      arm(-18, -55, -25, -40, 22)
      arm(18, 55, -25, 40, 22)
      leg(-14, -26, 92, -30, 148)
      leg(14, 26, 92, 30, 148)
      break
    case 'squat':
      arm(-18, -48, -45, -72, -12)
      arm(18, 48, -45, 72, -12)
      leg(-14, -50, 62, -20, 118)
      leg(14, 50, 62, 20, 118)
      break
    default: // kneeL
      arm(-18, -62, -60, -100, -35)
      arm(18, 62, -60, 100, -35)
      leg(-14, -30, 92, -32, 148)
      leg(14, 52, 70, 10, 82)
      break
  }
}

interface Wall {
  poses: (string | null)[]
  phase: 'approach' | 'pass' | 'crash'
  t: number
  tex: HTMLCanvasElement
}

/** 穿墙洞：砖墙推过来，摆同款姿势穿过去（对齐报告全部数值） */
class ShapeWall extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  unit = this.H / 720
  /** 已生成墙数（含进行中的） */
  wallIdx = 0
  /** 判过（穿过）墙数 */
  passed = 0
  score = 0
  wall: Wall | null = null
  /** 下墙/首墙倒计时（首墙延迟 0.6s，报告 L179） */
  spawnT = 0.6
  done = false
  /** 震屏剩余时长（撞墙，对齐站点 shake(22)） */
  shakeT = 0
  bannerT = 0
  bannerText = ''
  bannerColor = '#fff'
  /** 每玩家幽灵剪影位置（1-exp(-dt*4) 平滑跟随，报告 L206-231） */
  ghost = [
    { x: this.W / 2, y: this.H * 0.7 },
    { x: this.W / 2, y: this.H * 0.7 },
  ]
  /** 每玩家最新实时匹配结果（四肢描边绿/白用） */
  lastMatch: (MatchResult | null)[] = [null, null]

  constructor(ctx: GameContext) {
    super(ctx)
    ctx.setStage(`准备 / 共 ${this.cfg.walls} 面`)
  }

  private presentIds() {
    return this.players.filter((p) => p.body).map((p) => p.id)
  }

  tick(f: PoseFrame, dt: number) {
    void f
    this.shakeT = Math.max(0, this.shakeT - dt)
    this.bannerT = Math.max(0, this.bannerT - dt)

    // 幽灵剪影平滑跟随真实髋部
    for (const pv of this.players) {
      const b = pv.body
      if (!b) continue
      const k = 1 - Math.exp(-dt * 4)
      this.ghost[pv.id].x += (b.hipC.x * this.W - this.ghost[pv.id].x) * k
      this.ghost[pv.id].y += (b.hipC.y * this.H - this.ghost[pv.id].y) * k
    }

    // 实时逐帧比对当前墙姿势（四肢描边变绿用）
    if (this.wall && this.wall.phase === 'approach') {
      for (const pv of this.players) {
        const tpl = this.wall.poses[pv.id]
        this.lastMatch[pv.id] = pv.body && tpl ? matchPose(pv.body, POSES[tpl], this.cfg.tol) : null
      }
    } else {
      this.lastMatch = [null, null]
    }

    // 出墙节奏
    if (!this.wall && !this.done) {
      this.spawnT -= dt
      if (this.spawnT <= 0) this.spawnWall()
    } else if (this.wall) {
      this.wall.t += dt
      if (this.wall.phase === 'approach' && this.wall.t >= this.cfg.period - 1.1) this.judge()
      else if (this.wall.phase === 'pass' && this.wall.t >= 0.25) this.endWall()
      else if (this.wall.phase === 'crash' && this.wall.t >= 0.7) this.endWall()
    }
  }

  /** 生成一面墙（首墙固定 T 字；防重复：过滤上一墙首姿势与本墙已分配姿势，报告 §4） */
  private spawnWall() {
    let poses: (string | null)[] = [null, null]
    const present = this.presentIds()
    const prevFirst = this.wallIdx > 0 ? this.lastFirst : null
    for (const id of present) {
      let pool = this.cfg.pool.filter((p) => p !== prevFirst && !poses.includes(p))
      if (!pool.length) pool = this.cfg.pool
      poses[id] = pool[Math.floor(Math.random() * pool.length)]
    }
    if (this.wallIdx === 0) poses[present[0] ?? 0] = 't' // 首墙必为 T 字（报告 L184）
    this.lastFirst = poses[present[0] ?? 0]
    this.wallIdx++
    this.wall = { poses, phase: 'approach', t: 0, tex: this.bakeWall(poses) }
    // 生成墙音效：站点 sfx whoosh（本地无 whoosh 素材，用 drop 兜底）
    this.ctx.audio.drop()
    if (present.length > 1) {
      this.ctx.speak('墙来啦！摆出洞的样子！')
      this.ctx.setStage('墙来啦！摆出洞的样子！')
    } else {
      const tpl = POSES[this.lastFirst ?? 't']
      this.ctx.speak(tpl.say)
      this.ctx.setStage(`第 ${this.wallIdx} 面：${tpl.name} / 共 ${this.cfg.walls} 面`)
    }
  }

  private lastFirst: string | null = null

  /** 到时判定（报告 §2）：全部玩家都过才算过墙；过 = round(acc*100)，撞但 acc>0 = round(acc*30) */
  private judge() {
    const wall = this.wall!
    wall.phase = 'crash'
    wall.t = 0
    const present = this.presentIds()
    const results = present.map((id) => {
      const tpl = wall.poses[id]
      return this.players[id].body && tpl ? matchPose(this.players[id].body!, POSES[tpl], this.cfg.tol) : null
    })
    const valid = results.filter((r): r is MatchResult => !!r)
    const avgAcc = valid.length ? valid.reduce((n, r) => n + r.acc, 0) / valid.length : 0
    const allOk = valid.length > 0 && valid.every((r) => r.ok)
    if (allOk) {
      this.passed++
      this.score += Math.round(avgAcc * 100)
      this.banner('穿过去啦！', '#3ddc97', 1.1)
      // sfx crack + tada（站点）；本地素材映射 hit + win
      this.ctx.audio.play('hit', 0.8, 1.15)
      this.ctx.audio.win()
      // 穿越粒子 14 组 speed 620*unit size 26*unit（半径按直径一半折算）
      this.particles.burst(this.W / 2, this.H * 0.55, '#c98d6b', 14, 620 * this.unit, 13 * this.unit, 600)
      this.particles.burst(this.W / 2, this.H * 0.55, '#8a4a35', 10, 560 * this.unit, 10 * this.unit, 700)
    } else {
      if (avgAcc > 0) this.score += Math.round(avgAcc * 30)
      this.shakeT = 0.45
      const anyPass = valid.some((r) => r.ok)
      this.banner(anyPass ? '差一点点！' : '哎哟！', '#ff9f1c', 1.1)
      // sfx thud（站点）→ hit
      this.ctx.audio.hit()
      // 撞墙粒子 8 组 speed 200*unit
      this.particles.burst(this.W / 2, this.H * 0.6, '#8a4a35', 8, 200 * this.unit, 10 * this.unit, 700)
    }
    this.ctx.setScore(this.score)
    this.ctx.setExtra('穿墙', this.passed)
  }

  private endWall() {
    this.wall = null
    if (this.wallIdx >= this.cfg.walls) {
      // 全部墙判完 → 结束（duration 0 由墙数驱动终局，报告 §1）
      this.done = true
      this.ctx.setStage('完成！')
      this.ctx.finish()
    } else {
      this.spawnT = 0.35 // 下墙间隔 0.35s（报告 L295）
    }
  }

  private banner(text: string, color: string, sec: number) {
    this.bannerText = text
    this.bannerColor = color
    this.bannerT = sec
  }

  /** 离线烤一张砖墙贴图：砖纹 + 各玩家姿势剪影挖洞（报告 §5，destination-out） */
  private bakeWall(poses: (string | null)[]): HTMLCanvasElement {
    const cv = document.createElement('canvas')
    cv.width = this.W
    cv.height = this.H
    const c = cv.getContext('2d')!
    // 砖墙底
    c.fillStyle = '#8a4a35'
    c.fillRect(0, 0, this.W, this.H)
    const bw = 96
    const bh = 44
    c.strokeStyle = 'rgba(60,28,18,.85)'
    c.lineWidth = 5
    for (let row = 0; row * bh < this.H + bh; row++) {
      const y = row * bh
      c.beginPath()
      c.moveTo(0, y)
      c.lineTo(this.W, y)
      c.stroke()
      const off = row % 2 ? bw / 2 : 0
      for (let x = off; x < this.W; x += bw) {
        c.beginPath()
        c.moveTo(x, y)
        c.lineTo(x, y + bh)
        c.stroke()
      }
    }
    // 挖人形洞：剪影 + 微光边
    c.globalCompositeOperation = 'destination-out'
    for (const pv of this.players) {
      const pose = poses[pv.id]
      if (!pose) continue
      const gx = this.ghost[pv.id].x
      const gy = this.ghost[pv.id].y
      c.save()
      c.translate(gx, gy)
      c.fillStyle = '#000'
      c.strokeStyle = '#000'
      c.lineWidth = 26
      drawFigure(c, pose, 300)
      c.restore()
    }
    c.globalCompositeOperation = 'source-over'
    // 洞口虚线描边（在洞边缘，用反色画不出来 → 用浅色内描边替代）
    c.globalCompositeOperation = 'destination-over'
    for (const pv of this.players) {
      const pose = poses[pv.id]
      if (!pose) continue
      c.save()
      c.translate(this.ghost[pv.id].x, this.ghost[pv.id].y)
      c.fillStyle = 'rgba(255,236,190,.28)'
      c.strokeStyle = 'rgba(255,236,190,.4)'
      c.lineWidth = 34
      drawFigure(c, pose, 300)
      c.restore()
    }
    c.globalCompositeOperation = 'source-over'
    return cv
  }

  paint(c: CanvasRenderingContext2D) {
    // 撞墙震屏（对齐站点 shake(22)：幅度按剩余时长线性衰减）
    c.save()
    if (this.shakeT > 0) {
      const amp = 22 * this.unit * (this.shakeT / 0.45)
      c.translate(Math.sin(this.t * 71) * amp, Math.cos(this.t * 63) * amp * 0.6)
    }

    // 砖墙：逼近时整体缩放 1/(5-4*e) 从 1/5 放大到全屏（报告 L309），锚点画面底部中心
    if (this.wall) {
      const e = Math.min(1, this.wall.phase === 'approach' ? this.wall.t / (this.cfg.period - 1.1) : 1)
      const k = 1 / (5 - 4 * e)
      c.save()
      c.translate(this.W / 2, this.H)
      c.scale(k, k)
      c.translate(-this.W / 2, -this.H)
      c.drawImage(this.wall.tex, 0, 0)
      c.restore()
    }

    // 玩家幽灵剪影（墙前一层，帮助对位）
    for (const pv of this.players) {
      const pose = this.wall?.poses[pv.id]
      if (!pv.body || !pose) continue
      c.save()
      c.globalAlpha = 0.22
      c.translate(this.ghost[pv.id].x, this.ghost[pv.id].y)
      c.strokeStyle = pv.color
      c.fillStyle = pv.color
      c.lineWidth = 12
      drawFigure(c, pose, 280)
      c.restore()
    }

    // 实时四肢反馈：匹配肢体绿描边 / 未匹配白描边；全身匹配头顶闪 ✓（报告 §4）
    for (const pv of this.players) {
      const b = pv.body
      const m = this.lastMatch[pv.id]
      if (!b || !m) continue
      const lm = b.lm
      const px = (i: number) => lm[i].x * this.W
      const py = (i: number) => lm[i].y * this.H
      const seg = (a: number, bb: number, good: boolean) =>
        limb(c, px(a), py(a), px(bb), py(bb), 9, good ? 'rgba(107,203,119,.9)' : 'rgba(255,255,255,.55)')
      if (vis(lm[11]) && vis(lm[13])) seg(11, 13, m.armOk[0])
      if (vis(lm[13]) && vis(lm[15])) seg(13, 15, m.armOk[0])
      if (vis(lm[12]) && vis(lm[14])) seg(12, 14, m.armOk[1])
      if (vis(lm[14]) && vis(lm[16])) seg(14, 16, m.armOk[1])
      if (m.legOk !== null) {
        if (vis(lm[23]) && vis(lm[25])) seg(23, 25, m.legOk)
        if (vis(lm[25]) && vis(lm[27])) seg(25, 27, m.legOk)
        if (vis(lm[24]) && vis(lm[26])) seg(24, 26, m.legOk)
        if (vis(lm[26]) && vis(lm[28])) seg(26, 28, m.legOk)
      }
      if (m.ok) {
        c.save()
        c.globalAlpha = 0.85 + Math.sin(this.t * 10) * 0.15
        outlineTxt(c, '✓', b.head.x * this.W, (b.head.y - 0.1) * this.H, 44, '#6bcb77')
        c.restore()
        glow(c, b.head.x * this.W, b.head.y * this.H, 90, '#6bcb77', 0.3)
      }
    }
    c.restore()

    // 大横幅
    if (this.bannerT > 0) {
      c.save()
      c.globalAlpha = Math.min(1, this.bannerT / 0.3)
      outlineTxt(c, this.bannerText, this.W / 2, this.H * 0.24, 54, this.bannerColor)
      c.restore()
    }

    // 底部姿势名大字牌（34*unit，多人玩家色底白字 / 单人米白底紫字，报告 L340-347）
    const present = this.presentIds()
    if (this.wall) {
      if (present.length > 1) {
        for (const id of present) {
          const pose = this.wall.poses[id]
          if (!pose) continue
          const cx = id === 0 ? this.W * 0.25 : this.W * 0.75
          c.fillStyle = this.players[id].color
          c.beginPath()
          c.roundRect(cx - 128, this.H - 96, 256, 64, 32)
          c.fill()
          outlineTxt(c, POSES[pose].name, cx, this.H - 63, 34 * this.unit, '#fff', 'rgba(30,20,10,.5)')
        }
      } else if (present.length === 1) {
        const pose = this.wall.poses[present[0]]
        if (pose) {
          c.fillStyle = '#f7f0e0'
          c.beginPath()
          c.roundRect(this.W / 2 - 128, this.H - 96, 256, 64, 32)
          c.fill()
          outlineTxt(c, POSES[pose].name, this.W / 2, this.H - 63, 34 * this.unit, '#7c5cff', 'rgba(255,250,240,.9)')
        }
      }
    } else if (!this.done) {
      txt(c, '活动活动，墙马上来！', this.W / 2, this.H - 60, 26, 'rgba(255,255,255,.85)')
    }
  }
}

export default function create(ctx: GameContext) {
  return new ShapeWall(ctx)
}
