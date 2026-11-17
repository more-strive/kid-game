import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { bg, circle, outlineTxt, rr, txt } from '@/core/draw'

/**
 * 倾斜迷宫（对齐 dongdongpark 真实规则）：
 * 身体左右歪 → 板子左右倾；双手抬高/放低 → 板子前后倾；靠重力把球滚到出口，别掉进洞。
 *
 * 物理全部沿用站点字面量：加速度 = g × 倾角，指数阻尼 friction，硬上限 7 格/秒，
 * 位移按 0.15 格一步推进 + 3×3 邻格矩形推挤（法向只留 15% 反弹，切向自由滑动）。
 *
 * 与站点的三处偏差：
 * 1) 站点是 7 张手绘关卡图（e1/e2/m1/m2/h1-h3），本实现改为程序生成
 *    （随机 DFS 迷宫 + 拆墙成环 + 洞只放在最短路径之外），尺寸与洞数按站点档位还原，每次进关图案不同。
 * 2) 站点读连续量 motion.lean / motion.armLift，本框架没有，改由「肩髋横向偏移」和
 *    「手相对肩的高度」换算，量纲差异已在下面 FULL_LEAN / FULL_ARM 处标注。
 * 3) 加了 0.35 格/秒² 的极弱「自动向北」加速度：正面单摄像头下前后控制信号天然偏弱，
 *    没有这个保底，手一放平球就彻底不动会卡死。量级远小于玩家可控的 g（≥9），不夺主导权。
 */

interface LevelDef {
  cols: number
  rows: number
  holes: number
}

const LEVEL_DEF: Record<string, LevelDef> = {
  e1: { cols: 9, rows: 7, holes: 0 },
  e2: { cols: 9, rows: 7, holes: 1 },
  m1: { cols: 11, rows: 9, holes: 1 },
  m2: { cols: 11, rows: 9, holes: 3 },
  h1: { cols: 13, rows: 11, holes: 2 },
  h2: { cols: 13, rows: 11, holes: 2 },
  h3: { cols: 13, rows: 11, holes: 2 },
}

/** 站点三档难度字面量：g（格/秒²）、hole（掉洞半径，格）、friction（阻尼 1/秒）、关卡序列 */
const DIFF = [
  { g: 9, hole: 0.3, friction: 1.4, levels: ['e1', 'e2', 'm1', 'm2', 'h1', 'h2', 'h3'] },
  { g: 11, hole: 0.34, friction: 1.1, levels: ['m1', 'm2', 'h1', 'h2', 'h3', 'e2'] },
  { g: 13, hole: 0.38, friction: 0.9, levels: ['h1', 'h2', 'h3', 'm2', 'm1'] },
]

const DEAD = 0.08 // 倾斜死区
const FULL_LEAN = 0.7 // 左右满舵（站点 0.7）
const FULL_ARM = 0.5 // 前后满舵（站点 0.5）
const BALL_R = 0.3 // 球半径 = 墙体推挤半径（格）
const SPEED_CAP = 7 // 球速硬上限（格/秒）
const SMOOTH = 8 // 倾角平滑（1-exp(-dt*8)，时间常数 0.125s）
const BOUNCE = 1.15 // 法向反弹系数（法向保留 15%）
const FALL_T = 0.55 // 掉洞动画时长
const CLEAR_T = 1.3 // 过关动画时长
const GOAL_R = 0.45 // 到达终点判定半径（格）
const SUBSTEP = 0.15 // 子步长上限（格）
const NUDGE = 0.35 // 见文件头偏差 3

const WALL_COLOR = '#7b5237'
const ROAD_COLOR = '#fdf4e6'

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)

/** 身体左右倾：肩中心相对髋中心的横向偏移 / 躯干长，×2.2 拉满 */
function leanOf(b: Body | null) {
  if (!b) return 0
  const t = Math.max(0.08, b.scale)
  return clamp(((b.shoulderC.x - b.hipC.x) / t) * 2.2, -1, 1)
}

/** 抬手量：双手平均高度高出肩多少 / 躯干长，×1.3 后举过头约 0.6，垂下约 -0.4 */
function armLiftOf(b: Body | null) {
  if (!b) return 0
  const t = Math.max(0.08, b.scale)
  const handY = (b.lHand.y + b.rHand.y) / 2
  return clamp(((b.shoulderC.y - handY) / t) * 1.3, -1, 1)
}

/** 死区内归零、满舵饱和、中段线性（对应站点的 y(v, r)） */
function axis(v: number, full: number) {
  const a = Math.abs(v)
  if (a < DEAD) return 0
  return Math.sign(v) * Math.min(1, (a - DEAD) / (full - DEAD))
}

interface Level {
  cols: number
  rows: number
  /** 1 = 墙 */
  wall: Uint8Array
  holes: { x: number; y: number }[]
  sx: number
  sy: number
  gx: number
  gy: number
}

/** 随机 DFS 迷宫 + 拆墙成环；洞只放在「最短路径之外」的格子上，保证一定有解 */
function genLevel(cols: number, rows: number, holeCount: number): Level {
  const N = cols * rows
  const wall = new Uint8Array(N).fill(1)
  const idx = (x: number, y: number) => y * cols + x
  const rw = (cols - 1) >> 1
  const rh = (rows - 1) >> 1

  // 1. 房间在奇数坐标，DFS 打通相邻房间
  const seen = new Uint8Array(rw * rh)
  const stack: number[] = [0]
  seen[0] = 1
  wall[idx(1, 1)] = 0
  while (stack.length) {
    const cur = stack[stack.length - 1]
    const cx = cur % rw
    const cy = (cur - cx) / rw
    const cand: number[] = []
    if (cx > 0 && !seen[cur - 1]) cand.push(cur - 1)
    if (cx < rw - 1 && !seen[cur + 1]) cand.push(cur + 1)
    if (cy > 0 && !seen[cur - rw]) cand.push(cur - rw)
    if (cy < rh - 1 && !seen[cur + rw]) cand.push(cur + rw)
    if (!cand.length) {
      stack.pop()
      continue
    }
    const nx = cand[(Math.random() * cand.length) | 0]
    const nxc = nx % rw
    const nyc = (nx - nxc) / rw
    wall[idx(2 * cx + 1 + (nxc - cx), 2 * cy + 1 + (nyc - cy))] = 0
    wall[idx(2 * nxc + 1, 2 * nyc + 1)] = 0
    seen[nx] = 1
    stack.push(nx)
  }

  // 2. 拆 18% 的内部墙形成环路（走错也能绕回来，对应站点图里的环形回廊）
  for (let y = 1; y < rows - 1; y++) {
    for (let x = 1; x < cols - 1; x++) {
      if (!wall[idx(x, y)]) continue
      const hOpen = !wall[idx(x - 1, y)] && !wall[idx(x + 1, y)]
      const vOpen = !wall[idx(x, y - 1)] && !wall[idx(x, y + 1)]
      if ((hOpen || vOpen) && Math.random() < 0.18) wall[idx(x, y)] = 0
    }
  }

  // 3. 起点左下、终点右上（配合「抬手 = 球向远处滚」的物理直觉）
  const sx = 1
  const sy = rows - 2
  const gx = cols - 2
  const gy = 1

  // 4. BFS 求最短路径，洞只放路径外
  const prev = new Int32Array(N).fill(-2)
  const q: number[] = [idx(sx, sy)]
  prev[q[0]] = -1
  for (let i = 0; i < q.length; i++) {
    const cur = q[i]
    const x = cur % cols
    const y = (cur - x) / cols
    if (cur === idx(gx, gy)) break
    const nb = [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
    ]
    for (const [nx, ny] of nb) {
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue
      if (wall[idx(nx, ny)]) continue
      const ni = idx(nx, ny)
      if (prev[ni] !== -2) continue
      prev[ni] = cur
      q.push(ni)
    }
  }
  const path = new Set<number>()
  let p = idx(gx, gy)
  let guard = 0
  while (p >= 0 && guard++ < N) {
    path.add(p)
    p = prev[p]
  }

  const cands: number[] = []
  for (let y = 1; y < rows - 1; y++) {
    for (let x = 1; x < cols - 1; x++) {
      const i = idx(x, y)
      if (wall[i] || path.has(i)) continue
      if (Math.abs(x - sx) + Math.abs(y - sy) <= 1) continue
      if (Math.abs(x - gx) + Math.abs(y - gy) <= 1) continue
      cands.push(i)
    }
  }
  for (let i = cands.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0
    const tmp = cands[i]
    cands[i] = cands[j]
    cands[j] = tmp
  }
  const holes: { x: number; y: number }[] = []
  for (let i = 0; i < Math.min(holeCount, cands.length); i++) {
    const c = cands[i]
    const x = c % cols
    holes.push({ x, y: (c - x) / cols })
  }

  return { cols, rows, wall, holes, sx, sy, gx, gy }
}

class TiltMaze extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[0]
  lv!: Level
  levelIdx = 0
  bx = 0
  by = 0
  cell = 40
  /** 球在格子坐标里的位置（格子 (c,r) 的中心是 c+0.5, r+0.5） */
  cx = 1.5
  cy = 1.5
  vx = 0
  vy = 0
  /** 平滑后的实际倾角 */
  k = 0
  a = 0
  state: 'play' | 'fall' | 'clear' = 'play'
  st = 0
  cleared = 0
  falls = 0
  best = Infinity
  levelStart = 0
  trail: { x: number; y: number }[] = []
  private fallFrom = { x: 0, y: 0 }
  private fallTo = { x: 0, y: 0 }

  constructor(ctx: GameContext) {
    super(ctx)
    this.loadLevel()
  }

  private loadLevel() {
    const key = this.cfg.levels[this.levelIdx % this.cfg.levels.length]
    const def = LEVEL_DEF[key] ?? LEVEL_DEF.e1
    this.lv = genLevel(def.cols, def.rows, def.holes)
    this.cell = Math.min((this.W * 0.72) / def.cols, (this.H * 0.72) / def.rows)
    this.bx = (this.W - def.cols * this.cell) / 2
    this.by = this.H * 0.54 - (def.rows * this.cell) / 2
    this.cx = this.lv.sx + 0.5
    this.cy = this.lv.sy + 0.5
    this.vx = 0
    this.vy = 0
    this.k = 0
    this.a = 0
    this.trail = []
    this.state = 'play'
    this.st = 0
    this.levelStart = this.t
    this.ctx.setStage(`第 ${this.cleared + 1} 关`)
  }

  tick(f: PoseFrame, dt: number) {
    const b0 = f.bodies[0] ?? null
    const b1 = f.bodies[1] ?? null
    // 双人协作：P1 管左右、P2 管前后（对齐站点 coop 分工）；单人时两轴都由自己给
    const duo = !!(b0 && b1)
    const tx = axis(leanOf(b0), FULL_LEAN)
    const ty = -axis(armLiftOf(duo ? b1 : b0), FULL_ARM)

    if (this.state === 'fall') {
      this.st += dt
      if (this.st >= FALL_T) this.respawn()
      return
    }
    if (this.state === 'clear') {
      this.st += dt
      if (this.st >= CLEAR_T) {
        this.levelIdx++
        this.loadLevel()
      }
      return
    }

    const kk = 1 - Math.exp(-dt * SMOOTH)
    this.k += (tx - this.k) * kk
    this.a += (ty - this.a) * kk

    this.vx += this.cfg.g * this.k * dt
    this.vy += this.cfg.g * this.a * dt
    this.vy -= NUDGE * dt

    const damp = Math.exp(-dt * this.cfg.friction)
    this.vx *= damp
    this.vy *= damp
    const sp = Math.hypot(this.vx, this.vy)
    if (sp > SPEED_CAP) {
      const r = SPEED_CAP / sp
      this.vx *= r
      this.vy *= r
    }

    const steps = Math.max(1, Math.ceil((sp * dt) / SUBSTEP))
    for (let i = 0; i < steps; i++) {
      this.cx += (this.vx * dt) / steps
      this.cy += (this.vy * dt) / steps
      this.collide()
    }

    const last = this.trail[this.trail.length - 1]
    if (!last || Math.hypot(this.cx - last.x, this.cy - last.y) > 0.12) {
      this.trail.push({ x: this.cx, y: this.cy })
      if (this.trail.length > 40) this.trail.shift()
    }

    // 掉洞
    for (const h of this.lv.holes) {
      if (Math.hypot(this.cx - (h.x + 0.5), this.cy - (h.y + 0.5)) < this.cfg.hole) {
        this.startFall(h.x + 0.5, h.y + 0.5)
        return
      }
    }

    // 过关
    if (Math.hypot(this.cx - (this.lv.gx + 0.5), this.cy - (this.lv.gy + 0.5)) < GOAL_R) {
      this.clearLevel()
    }
  }

  /** 3×3 邻格矩形推挤：把球推到最近点外 BALL_R，法向速度按 1.15 反弹（切向保留） */
  private collide() {
    const { cols, rows, wall } = this.lv
    const gx = Math.floor(this.cx)
    const gy = Math.floor(this.cy)
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const wx = gx + dx
        const wy = gy + dy
        const solid = wx < 0 || wy < 0 || wx >= cols || wy >= rows || wall[wy * cols + wx] === 1
        if (!solid) continue
        const nearX = clamp(this.cx, wx, wx + 1)
        const nearY = clamp(this.cy, wy, wy + 1)
        const ddx = this.cx - nearX
        const ddy = this.cy - nearY
        const c = Math.hypot(ddx, ddy)
        let nxv: number
        let nyv: number
        let push: number
        if (c < 1e-6) {
          // 球心落在墙格内（数值极端情况）：朝最近的边推出去
          const left = this.cx - wx
          const right = wx + 1 - this.cx
          const top = this.cy - wy
          const bottom = wy + 1 - this.cy
          const m = Math.min(left, right, top, bottom)
          if (m === left) {
            nxv = -1
            nyv = 0
          } else if (m === right) {
            nxv = 1
            nyv = 0
          } else if (m === top) {
            nxv = 0
            nyv = -1
          } else {
            nxv = 0
            nyv = 1
          }
          push = BALL_R
        } else {
          if (c >= BALL_R) continue
          nxv = ddx / c
          nyv = ddy / c
          push = BALL_R - c
        }
        this.cx += nxv * push
        this.cy += nyv * push
        const vn = this.vx * nxv + this.vy * nyv
        if (vn < 0) {
          this.vx -= vn * BOUNCE * nxv
          this.vy -= vn * BOUNCE * nyv
        }
      }
    }
  }

  private startFall(hx: number, hy: number) {
    this.state = 'fall'
    this.st = 0
    this.fallFrom = { x: this.cx, y: this.cy }
    this.fallTo = { x: hx, y: hy }
    this.falls++
    this.vx = 0
    this.vy = 0
    this.trail = []
    this.ctx.audio.play('drop', 0.8, 0.7)
    this.ctx.speak('掉洞里啦，回起点')
    this.ctx.setExtra('falls', this.falls)
    const word = ['哎呀！', '掉下去啦', '再来！'][this.falls % 3]
    this.say(word, this.bx + hx * this.cell, this.by + hy * this.cell - 30, '#ff6b8a', 44)
  }

  private respawn() {
    this.cx = this.lv.sx + 0.5
    this.cy = this.lv.sy + 0.5
    this.vx = 0
    this.vy = 0
    this.trail = []
    this.state = 'play'
    this.st = 0
    this.ctx.audio.play('pop', 0.5, 1.3)
  }

  private clearLevel() {
    const used = this.t - this.levelStart
    this.state = 'clear'
    this.st = 0
    this.cleared++
    this.best = Math.min(this.best, used)
    this.ctx.addScore(1)
    this.ctx.setStage(`第 ${this.cleared + 1} 关`)
    this.ctx.setExtra('cleared', this.cleared)
    this.ctx.setExtra('falls', this.falls)
    this.ctx.audio.coin()
    this.ctx.speak(`第${this.cleared}关过啦`)
    this.say(`第 ${this.cleared} 关过啦！`, this.W / 2, this.H * 0.2, '#2ec4a6', 52)
    this.say(`用了 ${used.toFixed(1)} 秒`, this.W / 2, this.H * 0.2 + 54, '#7a5233', 32)
    const px = this.bx + (this.lv.gx + 0.5) * this.cell
    const py = this.by + (this.lv.gy + 0.5) * this.cell
    this.particles.burst(px, py, '#ffd54a', 40, 320, 6)
  }

  paint(c: CanvasRenderingContext2D) {
    bg(c, '#f6e7d2', '#e2c8a6')
    c.fillStyle = 'rgba(0,0,0,.045)'
    for (let i = 0; i < 12; i++) c.fillRect(0, (i + 0.5) * (this.H / 12), this.W, 3)

    const { cols, rows, wall } = this.lv
    const cell = this.cell
    const bw = cols * cell
    const bh = rows * cell
    const midX = this.bx + bw / 2
    const midY = this.by + bh / 2

    // 板下阴影
    c.save()
    c.globalAlpha = 0.18
    c.fillStyle = '#000'
    rr(c, this.bx - 14 + this.k * 18, this.by - 10 + this.a * 16, bw + 28, bh + 28, 22)
    c.fill()
    c.restore()

    // 板：随倾角旋转 + 轻微透视缩放（伪 3D）
    c.save()
    c.translate(midX, midY)
    c.rotate(this.k * 0.015)
    c.scale(1 + this.a * 0.012, 1 - this.a * 0.012)
    c.translate(-midX, -midY)

    c.fillStyle = '#c9a179'
    rr(c, this.bx - 10, this.by - 10, bw + 20, bh + 20, 18)
    c.fill()

    // 格子
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const px = this.bx + x * cell
        const py = this.by + y * cell
        if (wall[y * cols + x]) {
          c.fillStyle = WALL_COLOR
          c.fillRect(px + 0.5, py + 0.5, cell - 1, cell - 1)
          c.fillStyle = 'rgba(255,255,255,.08)'
          c.fillRect(px + 0.5, py + 0.5, cell - 1, 3)
        } else {
          c.fillStyle = ROAD_COLOR
          c.fillRect(px, py, cell, cell)
        }
      }
    }

    // 洞
    for (const h of this.lv.holes) {
      const cx = this.bx + (h.x + 0.5) * cell
      const cy = this.by + (h.y + 0.5) * cell
      circle(c, cx, cy, cell * 0.34, '#2b1d15')
      circle(c, cx, cy, cell * 0.34, 'rgba(0,0,0,.55)')
      c.strokeStyle = 'rgba(0,0,0,.35)'
      c.lineWidth = 2
      c.beginPath()
      c.arc(cx, cy, cell * 0.34, 0, Math.PI * 2)
      c.stroke()
    }

    // 终点
    const gx = this.bx + (this.lv.gx + 0.5) * cell
    const gy = this.by + (this.lv.gy + 0.5) * cell
    const pulse = 0.5 + 0.5 * Math.sin(this.t * 4)
    circle(c, gx, gy, cell * (0.36 + 0.04 * pulse), 'rgba(46,196,166,.25)')
    circle(c, gx, gy, cell * 0.22, '#2ec4a6')
    txt(c, '🏁', gx, gy, Math.max(14, cell * 0.5))

    // 起点标记
    const sx = this.bx + (this.lv.sx + 0.5) * cell
    const sy = this.by + (this.lv.sy + 0.5) * cell
    c.strokeStyle = 'rgba(122,82,55,.4)'
    c.lineWidth = 2
    c.setLineDash([4, 4])
    c.beginPath()
    c.arc(sx, sy, cell * 0.3, 0, Math.PI * 2)
    c.stroke()
    c.setLineDash([])

    // 拖尾
    if (this.trail.length > 1) {
      c.strokeStyle = 'rgba(255,255,255,.55)'
      c.lineWidth = Math.max(2, cell * 0.08)
      c.lineCap = 'round'
      c.beginPath()
      this.trail.forEach((p, i) => {
        const px = this.bx + p.x * cell
        const py = this.by + p.y * cell
        i ? c.lineTo(px, py) : c.moveTo(px, py)
      })
      c.stroke()
      c.lineCap = 'butt'
    }

    // 球
    let bx2 = this.bx + this.cx * cell
    let by2 = this.by + this.cy * cell
    let br = cell * BALL_R
    if (this.state === 'fall') {
      const e = Math.min(1, this.st / FALL_T)
      // 向洞心收缩 + 淡出（对应站点 0.55 秒的坠落动画）
      const t2 = 1 - Math.pow(1 - e, 3)
      bx2 = this.bx + (this.fallFrom.x + (this.fallTo.x - this.fallFrom.x) * t2) * cell
      by2 = this.by + (this.fallFrom.y + (this.fallTo.y - this.fallFrom.y) * t2) * cell
      br *= 1 - e * 0.85
      c.globalAlpha = 1 - e * 0.85
    } else if (this.state === 'clear') {
      br *= 1 + Math.sin(this.st * 12) * 0.12
    }
    circle(c, bx2, by2, br, this.players[0].color)
    circle(c, bx2 - br * 0.28, by2 - br * 0.28, br * 0.34, 'rgba(255,255,255,.75)')
    c.globalAlpha = 1

    c.restore()

    // HUD
    outlineTxt(c, `第 ${this.cleared + 1} 关`, 28, 34, 26, '#fff', 'rgba(60,40,25,.75)', 'left')
    txt(
      c,
      `${(this.t - this.levelStart).toFixed(1)} 秒 · 掉洞 ${this.falls}`,
      this.W - 28,
      34,
      20,
      'rgba(80,55,35,.8)',
      'right',
    )

    // 倾斜指示器（左下）
    this.paintTilt(c, 90, this.H - 78, 54)

    // 首关前 4 秒教学提示
    if (this.cleared === 0 && this.t - this.levelStart < 4 && this.state === 'play') {
      c.globalAlpha = 0.55 + 0.45 * Math.sin(this.t * 4)
      outlineTxt(c, '两只手平举，板就放平啦', this.W / 2, this.H * 0.95, 30)
      c.globalAlpha = 1
    }
  }

  /** 小方块随倾角倾斜，直观告诉玩家"板子现在是往哪边翘的" */
  private paintTilt(c: CanvasRenderingContext2D, x: number, y: number, r: number) {
    c.save()
    c.translate(x, y)
    c.rotate(this.k * 0.5)
    c.fillStyle = 'rgba(255,255,255,.35)'
    rr(c, -r, -r * 0.42, r * 2, r * 0.84, 10)
    c.fill()
    c.strokeStyle = 'rgba(122,82,55,.72)'
    c.lineWidth = 3
    rr(c, -r, -r * 0.42, r * 2, r * 0.84, 10)
    c.stroke()
    circle(c, 0, 0, r * 0.2, '#ff8a3d')
    c.restore()
    txt(
      c,
      `左右 ${this.k >= 0 ? '→' : '←'}   前后 ${this.a >= 0 ? '↑' : '↓'}`,
      x,
      y + r * 0.95,
      18,
      'rgba(90,62,40,.85)',
    )
  }
}

export default function create(ctx: GameContext) {
  return new TiltMaze(ctx)
}
