import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, ring, txt } from '@/core/draw'

/**
 * 过马路 / cross-road（对齐 dongdongpark 真实规则）：
 * 红灯站定（乱动吹哨）、绿灯先「向左看、再向右看」再原地踏步过斑马线（每条 +1 分）；
 * 没看左右就抢跑会被按喇叭、起步取消；红灯时长随 heat 收紧（越投入节奏越快）。
 *
 * 全部字面量沿用站点：turn 检测阈值 0.4/0.45/0.5、看左右有效期 4.5/3.5/3s、run 起步阈值 0.2/0.25、
 * 起步需累计 0.3s（2× 衰减）、红灯乱动 energy 阈值 0.62/0.5/0.45（累计 0.4s、calm 宽限 0.8s）、
 * 红灯时长区间 ×(1−0.2×heat)（首局 60%）、绿灯 9-11/7-9/6.5-8s、闪绿仅 hard 2.2s（起步宽限 0.6s）、
 * 黄灯 2/1.6/1.2s、过街速度 2.2×clamp(.55+run,0,1.2)、到达态前进 2.1、喇叭冷却 2.2s、哨子冷却 2.5s、
 * 马路宽 6.4 间距 10、等待点近缘前 0.55、相机跟身后 3.6（速率 2.5/s）；
 * 车辆纯演出无碰撞：两车道相向而行、巡航 6.5~9.5、红灯行车/绿灯停车让行（幼教语义，站点原样）、
 * 每 1.2~2.6s 一辆、60% 小车/25% 面包/15% 巴士。
 *
 * 与站点的差异（写明待实测）：
 * 1) 站点 motion.turn/run/energy 黑盒 → turn 用「头相对肩中点横偏 ÷ 肩宽」、run 用「髋部竖直速度÷躯干」
 *    （forest-run 同款）、energy 用「髋+双手速度聚合」代理，阈值沿用站点字面量，量纲需真机校准；
 * 2) heat 用本框架 ctx.heat（局内时长线性）；
 * 3) 精灵（小人/车/树/房）全部几何图形绘制；双人共享一个分数（仓库口径）；
 * 4) ai() 演示替身未实装；e.big 倒计时数字不实现（无 big 概念）。
 */
type Light = 'red' | 'green' | 'blink' | 'yellow'
type Mode = 'wait' | 'cross' | 'arrive'

interface Car {
  x: number
  lane: 0 | 1
  len: number
  v: number
  cruise: number
  col: string
  honk: number
}

interface Zone {
  x0: number
  x1: number
  cx: number
}

interface Walker {
  road: number
  z: number
  camZ: number
  mode: Mode
  v: number
  light: Light
  lightLeft: number
  nextGreen: number
  calmUntil: number
  lookL: number
  lookR: number
  goT: number
  moveT: number
  honkCool: number
  whistleCool: number
  honkT: number
  saidBoth: boolean
  saidGreen: boolean
  lookFT: number
  lookRT: number
  marchT: number
  crossed: number
  starts: number
  honks: number
  whistles: number
  runSm: number
  energySm: number
  prev: { hipY: number; hx: number; hy: number; rx: number; ry: number } | null
  rng1: () => number
  rng2: () => number
  cars: Car[]
  spawnIn: [number, number]
  zone: Zone
}

/** 站点三档：转头阈值 / 看左右有效期 / 起步阈值 / 乱动阈值 / 红灯区间 / 绿灯区间 / 闪绿 / 黄灯 */
const DIFF = [
  { look: 0.4, win: 4.5, go: 0.2, still: 0.62, red: [2.2, 3.6] as [number, number], green: [9, 11] as [number, number], blink: 0, yellow: 2 },
  { look: 0.45, win: 3.5, go: 0.25, still: 0.5, red: [2.2, 4] as [number, number], green: [7, 9] as [number, number], blink: 0, yellow: 1.6 },
  { look: 0.5, win: 3, go: 0.25, still: 0.45, red: [2.6, 4.4] as [number, number], green: [6.5, 8] as [number, number], blink: 2.2, yellow: 1.2 },
]

const ROAD_W = 6.4 // 马路 z 向宽
const ROAD_GAP = 10 // 相邻马路间距
const MARGIN = 0.55 // 路缘缓冲
const GO_NEED = 0.3 // 起步累计（秒）
const MOVE_NEED = 0.4 // 乱动累计（秒）
const CALM = 0.8 // 灯切换宽限（秒）
const CROSS_V = 2.2 // 过街基础速度
const ARRIVE_V = 2.1 // 到达态前进速度
const CAM_BACK = 3.6 // 相机跟在身后
const BLINK_GRACE = 0.6 // 闪绿起步宽限
const HONK_COOL = 2.2
const WHISTLE_COOL = 2.5
const STOMP_T = 0.7 // 抢跑跺脚跳
const PHRASES = ['过马路啦！', '安全到达，真棒！', '走得好！', '又过了一条！']
const LANE_Z = [1.6, 4.8] // 两车道中心（相对路近缘）
const STOP_X = 2.8 // 车辆排队线
const CAR_SPAWN: [number, number] = [1.2, 2.6]
const CRUISE: [number, number] = [6.5, 9.5]

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)

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

const CAR_COLS = ['#ff6b6b', '#4cc9f0', '#ffd54a', '#9be15d', '#b088f0', '#ff9f43']

class CrossRoad extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[0]
  walkers: Walker[] = []
  seats = 1
  private seatActive = [false, false]
  private greenBannerShown = false

  constructor(ctx: GameContext) {
    super(ctx)
    for (let i = 0; i < 2; i++) {
      const rng1 = mulberry32(11 + i * 7)
      const rng2 = mulberry32(13 + i * 7)
      this.walkers.push({
        road: 0, z: 2 - MARGIN, camZ: -CAM_BACK, mode: 'wait', v: 0,
        light: 'red', lightLeft: 0, nextGreen: 0, calmUntil: 0,
        lookL: -99, lookR: -99, goT: 0, moveT: 0, honkCool: 0, whistleCool: 0, honkT: 0,
        saidBoth: false, saidGreen: false, lookFT: -99, lookRT: -99, marchT: 0,
        crossed: 0, starts: 0, honks: 0, whistles: 0,
        runSm: 0, energySm: 0, prev: null, rng1, rng2,
        cars: [], spawnIn: [0.4 + rng2(), 1.1 + rng2()],
        zone: { x0: 0, x1: this.W, cx: this.W / 2 },
      })
    }
    this.layout()
    for (const w of this.walkers) this.spawnInitialCars(w)
    // 首局红灯取随机值的 60%（快速开局），绿灯时长预存
    for (const w of this.walkers) {
      w.lightLeft = (w.rng1() * (this.cfg.red[1] - this.cfg.red[0]) + this.cfg.red[0]) * 0.6
      w.nextGreen = w.rng1() * (this.cfg.green[1] - this.cfg.green[0]) + this.cfg.green[0]
    }
  }

  private layout() {
    const duo = this.seats > 1
    for (let i = 0; i < 2; i++) {
      const z = duo
        ? { x0: (i * this.W) / 2, x1: ((i + 1) * this.W) / 2 }
        : { x0: 0, x1: this.W }
      this.walkers[i].zone = { ...z, cx: (z.x0 + z.x1) / 2 }
    }
  }

  private spawnInitialCars(w: Walker) {
    w.cars.push(this.makeCar(w, 0, -7))
    w.cars.push(this.makeCar(w, 1, 4))
  }

  private makeCar(w: Walker, lane: 0 | 1, x: number): Car {
    const r = w.rng2()
    const kind = r < 0.6 ? 1.9 : r < 0.85 ? 2.6 : 3.6 // 车/面包/巴士车长
    return {
      x, lane, len: kind, v: 0,
      cruise: CRUISE[0] + w.rng2() * (CRUISE[1] - CRUISE[0]),
      col: CAR_COLS[Math.floor(w.rng2() * CAR_COLS.length)],
      honk: 0,
    }
  }

  private roadZ0(e: number) {
    return 2 + ROAD_GAP * e
  }
  private waitZ(e: number) {
    return this.roadZ0(e) - MARGIN
  }
  private doneZ(e: number) {
    return this.roadZ0(e) + ROAD_W + MARGIN
  }

  tick(f: PoseFrame, dt: number) {
    if (this.seats === 1 && f.bodies[1]) {
      this.seats = 2
      this.layout()
    }
    for (let i = 0; i < 2; i++) if (f.bodies[i]) this.seatActive[i] = true
    for (let i = 0; i < 2; i++) {
      const w = this.walkers[i]
      if (!this.seatActive[i]) continue
      this.step(w, f.bodies[i] ?? null, dt, i)
      this.ctx.setExtra(`crossed${i}`, w.crossed)
    }
  }

  private step(w: Walker, b: Body | null, dt: number, idx: number) {
    const now = this.t
    if (w.honkCool > 0) w.honkCool -= dt
    if (w.whistleCool > 0) w.whistleCool -= dt
    if (w.honkT > 0) w.honkT -= dt

    // —— 输入代理 ——
    let turn = 0
    let run = 0
    let energy = 0
    if (b) {
      const sw = Math.max(0.06, Math.abs(b.lShoulder.x - b.rShoulder.x))
      turn = clamp(((b.head.x - b.shoulderC.x) / sw) * 1.4, -1, 1)
      const Tn = Math.max(0.1, b.scale)
      const hipVy = Math.abs((b.hipC.y - (w.prev?.hipY ?? b.hipC.y)) / Math.max(dt, 1e-3)) / Tn
      const handV = ((Math.hypot(b.lHand.x - (w.prev?.hx ?? b.lHand.x), b.lHand.y - (w.prev?.hy ?? b.lHand.y)) +
        Math.hypot(b.rHand.x - (w.prev?.rx ?? b.rHand.x), b.rHand.y - (w.prev?.ry ?? b.rHand.y))) / 2 / Math.max(dt, 1e-3)) / Tn
      run = clamp(hipVy / 2.2, 0, 1)
      energy = clamp((hipVy + handV) / 4, 0, 1)
      w.prev = { hipY: b.hipC.y, hx: b.lHand.x, hy: b.lHand.y, rx: b.rHand.x, ry: b.rHand.y }
    } else {
      w.prev = null
    }
    w.runSm += (run - w.runSm) * Math.min(1, dt * 6)
    w.energySm += (energy - w.energySm) * Math.min(1, dt * 6)

    // —— 灯状态机 ——
    w.lightLeft -= dt
    if (w.lightLeft <= 0) this.nextLight(w, idx)

    // —— 车辆 ——
    this.stepCars(w, dt)

    // —— 玩家状态机 ——
    if (w.mode === 'wait') {
      this.stepWait(w, b, dt, turn, run)
    } else if (w.mode === 'cross') {
      const target = w.runSm > 0.1 ? CROSS_V * clamp(0.55 + w.runSm, 0, 1.2) : 0
      w.v += (target - w.v) * (1 - Math.exp(-dt * 4))
      w.z += w.v * dt
      w.marchT += dt * (4 + 6 * clamp(w.runSm * 1.6, 0, 1))
      if (w.z >= this.doneZ(w.road)) {
        w.crossed++
        this.ctx.addScore(1)
        this.ctx.audio.play('win', 0.7)
        this.say(PHRASES[w.crossed % PHRASES.length], w.zone.cx, this.H * 0.3, '#6bcb77', 40)
        this.particles.burst(w.zone.cx, this.H * 0.4, '#ffd54a', 26, 420, 5)
        w.mode = 'arrive'
        w.lookL = -99
        w.lookR = -99
        w.goT = 0
      }
    } else {
      // arrive：自动走到下一条马路等待点
      w.z += ARRIVE_V * dt
      if (w.z >= this.waitZ(w.road + 1)) {
        w.road++
        w.mode = 'wait'
        w.calmUntil = now + CALM
        w.moveT = 0
        w.goT = 0
      }
    }
    // 相机跟身后 3.6
    w.camZ += (w.z - CAM_BACK - w.camZ) * (1 - Math.exp(-dt * 2.5))
  }

  private nextLight(w: Walker, idx: number) {
    const heat = this.ctx.heat
    if (w.light === 'red') {
      // 红 → 绿（绿灯总时长预存在 nextGreen）
      w.light = 'green'
      w.lightLeft = w.nextGreen - this.cfg.blink
      w.saidBoth = false
      if (!w.saidGreen) {
        w.saidGreen = true
        this.ctx.audio.play('score', 0.6, 1.2)
        if (!this.greenBannerShown) {
          this.greenBannerShown = true
          this.say('绿灯亮了！先看看左边，再看看右边', this.W / 2, this.H * 0.2, '#6bcb77', 32)
          this.ctx.speak('绿灯亮了，先看看左边，再看看右边')
        } else if (this.seats === 1 && idx === 0) {
          this.say('绿灯！', this.W / 2, this.H * 0.2, '#6bcb77', 30)
        }
        // 车道排队区无车则强制补一辆
        for (const lane of [0, 1] as const) {
          if (!w.cars.some((c) => c.lane === lane && c.x < -2.5 && c.x > -20)) {
            w.cars.push(this.makeCar(w, lane, -11))
          }
        }
      }
    } else if (w.light === 'green' && this.cfg.blink > 0) {
      w.light = 'blink'
      w.lightLeft = this.cfg.blink
    } else {
      // → 黄 → 红
      if (w.light !== 'yellow') {
        w.light = 'yellow'
        w.lightLeft = this.cfg.yellow
      } else {
        w.light = 'red'
        const dur = (w.rng1() * (this.cfg.red[1] - this.cfg.red[0]) + this.cfg.red[0]) * (1 - 0.2 * heat)
        w.lightLeft = dur
        w.nextGreen = w.rng1() * (this.cfg.green[1] - this.cfg.green[0]) + this.cfg.green[0]
        w.saidBoth = false
      }
    }
  }

  /** 车辆：release（非红灯 ∨ 过街中 ∨ 红灯剩 <1.3s）→ 排队让行；否则穿过斑马线 */
  private stepCars(w: Walker, dt: number) {
    const release = w.light !== 'red' || w.mode === 'cross' || (w.light === 'red' && w.lightLeft < 1.3)
    w.spawnIn[0] -= dt
    w.spawnIn[1] -= dt
    const lanes: (0 | 1)[] = [0, 1]
    lanes.forEach((lane, li) => {
      if (w.spawnIn[li] <= 0) {
        w.spawnIn[li] = CAR_SPAWN[0] + w.rng2() * (CAR_SPAWN[1] - CAR_SPAWN[0])
        const x = lane === 0 ? -22 : 22
        if (!w.cars.some((c) => c.lane === lane && Math.abs(c.x - x) < 6)) w.cars.push(this.makeCar(w, lane, x))
      }
    })
    for (const lane of lanes) {
      const dir = lane === 0 ? 1 : -1
      const cars = w.cars.filter((c) => c.lane === lane).sort((a, b2) => (dir > 0 ? a.x - b2.x : b2.x - a.x))
      for (let i = 0; i < cars.length; i++) {
        const c = cars[i]
        const front = dir > 0 ? c.x + c.len / 2 : c.x - c.len / 2
        let target = c.cruise
        // 跟车：保持与前车尾 0.9
        const ahead = cars[i - 1]
        if (ahead) {
          const frontAhead = dir > 0 ? ahead.x - ahead.len / 2 : ahead.x + ahead.len / 2
          const gap = Math.abs(frontAhead - front) - 0.9
          target = Math.min(target, Math.sqrt(14 * Math.max(0, gap)))
        }
        // 排队：release 且还没到停止线 → 在线前刹停
        if (release && (dir > 0 ? front < -STOP_X : front > STOP_X)) {
          const dist = dir > 0 ? -STOP_X - front : front - STOP_X
          target = Math.min(target, Math.sqrt(14 * Math.max(0, dist - 0.3)))
        }
        if (!release && (dir > 0 ? front < -STOP_X : front > STOP_X)) target = c.cruise // 红灯行车穿过
        c.v += clamp(target - c.v, -14 * dt, 4 * dt)
        c.x += dir * c.v * dt
        if (c.honk > 0) c.honk -= dt
        // 回收
        if (Math.abs(c.x) > 24) c.x = dir > 0 ? -24 : 24
      }
    }
    w.cars = w.cars.filter((c) => Math.abs(c.x) <= 24)
  }

  private stepWait(w: Walker, b: Body | null, dt: number, turn: number, run: number) {
    const now = this.t
    if (w.calmUntil > 0) w.calmUntil -= dt
    const greenGo = w.light === 'green' || (w.light === 'blink' && w.lightLeft >= this.cfg.blink - BLINK_GRACE)
    // 看左右
    if (b) {
      if (turn < -this.cfg.look && now - w.lookFT > 0.5) {
        if (now - w.lookL > this.cfg.win) this.ctx.audio.play('pop', 0.4, 0.9)
        w.lookL = now
        w.lookFT = now
      }
      if (turn > this.cfg.look && now - w.lookRT > 0.5) {
        if (now - w.lookR > this.cfg.win) this.ctx.audio.play('pop', 0.4, 1.1)
        w.lookR = now
        w.lookRT = now
      }
    }
    const fresh = (t: number) => now - t <= this.cfg.win
    const bothFresh = fresh(w.lookL) && fresh(w.lookR)
    if (w.light === 'green' && bothFresh && !w.saidBoth) {
      w.saidBoth = true
      this.ctx.audio.play('combo', 0.5)
      if (this.seats === 1) this.say('看好了，走吧！', w.zone.cx, this.H * 0.24, '#6bcb77', 30)
    }
    // 红灯/黄灯乱动
    const redWait = w.light === 'red' || w.light === 'yellow' || w.light === 'blink'
    if (redWait && now > w.calmUntil && b) {
      if (w.energySm > this.cfg.still || w.runSm > this.cfg.go) w.moveT += dt
      else w.moveT = Math.max(0, w.moveT - dt)
      if (w.moveT >= MOVE_NEED && w.whistleCool <= 0) {
        w.moveT = 0
        w.whistleCool = WHISTLE_COOL
        w.whistles++
        this.ctx.audio.play('tick', 0.8, 1.6)
        this.say(w.light === 'red' ? '红灯停！' : '等一等！', w.zone.cx, this.H * 0.24, '#ff8fa8', 32)
      }
    } else if (!redWait) {
      w.moveT = Math.max(0, w.moveT - dt)
    }
    // 起步
    if (greenGo && run > this.cfg.go) {
      w.goT += dt
      if (w.goT >= GO_NEED && w.honkCool <= 0) {
        if (bothFresh) {
          w.starts++
          w.mode = 'cross'
          w.goT = 0
          w.v = 0
          this.ctx.audio.play('pop', 0.6, 1.3)
        } else if (w.honkCool <= 0) {
          // 抢跑：没看两侧
          w.honks++
          w.honkCool = HONK_COOL
          w.honkT = STOMP_T
          w.goT = 0
          this.ctx.audio.play('miss', 0.7, 0.7)
          this.say('先看左右！', w.zone.cx, this.H * 0.26, '#ff5d5d', 34)
          // 未看侧最近的车回按喇叭
          const dir = fresh(w.lookL) ? 1 : -1
          const lane = dir > 0 ? 1 : 0
          const near = w.cars.filter((c) => c.lane === lane).sort((a, b2) => Math.abs(a.x) - Math.abs(b2.x))[0]
          if (near) near.honk = 1
        }
      }
    } else {
      w.goT = Math.max(0, w.goT - dt * 2)
    }
    if (w.honkT > 0) {
      // 跺脚跳动画占位：原地小跳
      void 0
    }
  }

  // ---------- 绘制 ----------
  paint(c: CanvasRenderingContext2D) {
    const duo = this.seats > 1
    if (duo) {
      c.fillStyle = '#fffdf3'
      c.fillRect(this.W / 2 - 3, 0, 6, this.H)
    }
    for (let i = 0; i < 2; i++) {
      const w = this.walkers[i]
      if (!this.seatActive[i]) continue
      const z = w.zone
      c.save()
      c.beginPath()
      c.rect(z.x0, 0, z.x1 - z.x0, this.H)
      c.clip()
      this.sky(c, z)
      const f = Math.min(this.H * 0.92, (z.x1 - z.x0) * 0.78)
      const hy = this.H * 0.3
      const cx = (z.x0 + z.x1) / 2
      const proj = (worldX: number, worldZ: number) => {
        const depth = Math.max(0.35, worldZ - w.camZ)
        const s = f / depth
        return { x: cx + worldX * s, y: hy + 2.1 * s, s }
      }
      // 马路 [road−1, road+3]
      for (let e = Math.max(0, w.road - 1); e <= w.road + 3; e++) {
        const z0 = this.roadZ0(e)
        const z1 = z0 + ROAD_W
        const near = proj(-3.6, z0)
        const far = proj(-3.6, z1)
        const nearR = proj(3.6, z0)
        const farR = proj(3.6, z1)
        // 路面
        c.fillStyle = '#6b6580'
        c.beginPath()
        c.moveTo(near.x, near.y)
        c.lineTo(nearR.x, nearR.y)
        c.lineTo(farR.x, farR.y)
        c.lineTo(far.x, far.y)
        c.closePath()
        c.fill()
        // 斑马纹
        c.fillStyle = '#fffdf6'
        for (let sz = z0 + 0.3; sz < z1 - 0.3; sz += 0.82) {
          const a1 = proj(-1.7, sz)
          const a2 = proj(1.7, sz)
          const b1 = proj(-1.7, Math.min(sz + 0.46, z1 - 0.3))
          const b2 = proj(1.7, Math.min(sz + 0.46, z1 - 0.3))
          c.beginPath()
          c.moveTo(a1.x, a1.y)
          c.lineTo(a2.x, a2.y)
          c.lineTo(b2.x, b2.y)
          c.lineTo(b1.x, b1.y)
          c.closePath()
          c.fill()
        }
        // 双黄中线
        c.strokeStyle = '#ffd93d'
        c.lineWidth = Math.max(2, proj(0, z0).s * 0.08)
        c.beginPath()
        const m1 = proj(0, z0)
        const m2 = proj(0, z1)
        c.moveTo(m1.x, m1.y)
        c.lineTo(m2.x, m2.y)
        c.stroke()
        // 人行道
        c.fillStyle = '#efe2cf'
        const w1 = proj(-3.6, z0 - 2.2)
        const w2 = proj(-3.6, z0)
        const w3 = proj(3.6, z0)
        const w4 = proj(3.6, z0 - 2.2)
        c.beginPath()
        c.moveTo(w1.x, w1.y)
        c.lineTo(w2.x, w2.y)
        c.lineTo(w3.x, w3.y)
        c.lineTo(w4.x, w4.y)
        c.closePath()
        c.fill()
      }
      // 车辆
      for (const car of w.cars) {
        const laneZ = this.roadZ0(w.road) + LANE_Z[car.lane]
        const p = proj(0, laneZ)
        const cw = car.len * p.s * 0.55
        const ch = Math.max(8, p.s * 0.5)
        const shake = car.honk > 0 ? Math.abs(Math.sin(car.honk * 18)) * 4 : 0
        c.fillStyle = car.col
        c.fillRect(car.x * p.s + cx - cw / 2, p.y - ch - shake, cw, ch)
        c.fillStyle = 'rgba(255,255,255,.5)'
        c.fillRect(car.x * p.s + cx - cw / 4, p.y - ch * 0.8 - shake, cw / 2, ch * 0.35)
      }
      // 信号灯（当前路的真实灯色）
      const lightZ = this.roadZ0(w.road) + 0.3
      const lp = proj(2.9, lightZ)
      const col = w.light === 'red' ? '#ff5d5d' : w.light === 'yellow' ? '#ffd54a' : '#6bcb77'
      const blinkOn = w.light !== 'blink' || Math.floor(this.t * 3) % 2 === 0
      if (blinkOn) circle(c, lp.x, lp.y - 60, Math.max(6, lp.s * 0.25), col)
      c.fillStyle = '#3a3a55'
      c.fillRect(lp.x - 3, lp.y - 60, 6, 60)
      // 玩家小人
      const pp = proj(0, w.z)
      const scale = pp.s / 40
      const stomp = w.honkT > 0 ? Math.abs(Math.sin(w.honkT * 9)) : 0
      const bob = Math.abs(Math.sin(w.marchT)) * (w.mode === 'wait' ? 6 : 10)
      const py = pp.y - stomp * 18
      circle(c, pp.x, py - 66 * scale - bob, 11 * scale, this.players[i].color) // 头
      c.strokeStyle = this.players[i].color
      c.lineWidth = 5 * scale
      c.beginPath()
      c.moveTo(pp.x, py - 55 * scale - bob)
      c.lineTo(pp.x, py - 20 * scale - bob * 0.4)
      c.moveTo(pp.x, py - 20 * scale - bob * 0.4)
      c.lineTo(pp.x - 8 * scale, pp.y)
      c.moveTo(pp.x, py - 20 * scale - bob * 0.4)
      c.lineTo(pp.x + 8 * scale, pp.y)
      c.stroke()
      // 看左右新鲜度环
      const fresh = (t: number) => this.t - t <= this.cfg.win
      for (const [side, look] of [[-1, w.lookL], [1, w.lookR]] as [number, number][]) {
        const ix = pp.x + side * 26 * scale
        const iy = py - 66 * scale
        const freshNow = fresh(look)
        c.globalAlpha = freshNow ? 0.9 : 0.25
        ring(c, ix, iy, 9 * scale, freshNow ? Math.max(0.15, 1 - (this.t - look) / this.cfg.win) : 0, freshNow ? '#6bcb77' : '#ffffff', 3)
        c.globalAlpha = 1
        txt(c, side < 0 ? '👈' : '👉', ix, iy, 12 * scale, '#fff')
      }
      // 灯色氛围
      const glow = { red: '255,107,107', yellow: '255,200,60', green: '107,203,119', blink: '107,203,119' }[w.light]
      c.fillStyle = `rgba(${glow},${0.2 + Math.sin(this.t * 5) * 0.05})`
      c.fillRect(z.x0, 0, 26, this.H)
      c.fillRect(z.x1 - 26, 0, 26, this.H)
      // 分数
      txt(c, `${w.crossed} 条`, z.x1 - 16, 40, 20, this.players[i].color, 'right', 'bold')
      c.restore()
    }
  }

  private sky(c: CanvasRenderingContext2D, z: Zone) {
    const g = c.createLinearGradient(0, 0, 0, this.H * 0.35)
    g.addColorStop(0, '#8fd3f5')
    g.addColorStop(1, '#eaf8ff')
    c.fillStyle = g
    c.fillRect(z.x0, 0, z.x1 - z.x0, this.H * 0.42)
    // 地面（路间人行道底色）
    c.fillStyle = '#efe2cf'
    c.fillRect(z.x0, this.H * 0.4, z.x1 - z.x0, this.H)
    // 云
    for (let k = 0; k < 3; k++) {
      const cx2 = z.x0 + ((k * 0.45 + 0.1 + this.t * 0.004) % 1) * (z.x1 - z.x0)
      circle(c, cx2, 40 + k * 26, 18, 'rgba(255,255,255,.9)')
      circle(c, cx2 + 22, 44 + k * 26, 14, 'rgba(255,255,255,.9)')
    }
  }
}

export default function create(ctx: GameContext) {
  return new CrossRoad(ctx)
}
