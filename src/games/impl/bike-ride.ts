import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, glow, outlineTxt, rr, txt } from '@/core/draw'

/**
 * 骑自行车（对齐 dongdongpark 真实规则，逆向报告 _reverse/reports/bike-ride.md）：
 * 75 秒横向卷轴骑行——高抬腿踩踏板（踏频=车速），身体左右歪控制车道（±2.65 米），
 * 吃金币、躲水坑和小猫、冲山坡；里程分每 10 米 +1、金币 +1、坡顶 +3。
 * 双人垂直分屏（左右各半独立相机），金币/障碍共享同一路书、各自 got/hit 独立判定。
 *
 * 站点框架行为等价代理说明：
 * - 本框架无 e.big 大屏标志，按儿童模式（A=!big）实现；大屏差异值在常量处注释：
 *   cadFull ×0.8、水坑/小猫概率 ×0.55、金币吸附半径 0.85（大屏 0.62）、
 *   上坡速度保留 0.85（大屏 0.7）、打湿/撞猫时长 0.6s（大屏 1s）、水坑判定边距 −0.1（大屏 +0.12）、
 *   撞猫判定半径 0.45（大屏 0.62）、湿身/晕眩减速取模块表 ×0.6/×0.4（§4 另有 ×0.75/×0.55 口径）。
 * - motion.stepRate / motion.run：用双膝抬升沿频率做步频代理（引擎侧定义未随报告给出）。
 * - motion.lean（−1~1 侧倾）：用肩线在画面里的倾斜量（dy/肩宽）做代理，死区 0.06。
 * - 速度减益：加速 τ=1.6 / 减速 τ=0.9、踏频平滑 τ=3、横速平滑 τ=6，均照抄报告。
 * - 终点拱门无绝对里程（时长制结算在外壳），按“始终保持在 78m 前瞻处”绘制（等价代理）。
 * - 音效映射：whoosh→jump、splash→drop、oops→fail、tada→fanfare、coin→score（带音高）。
 * - 站点玩家 AI（{run,lean}）依赖 AI 槽位，本框架玩家全部来自摄像头，缺席骑手自然滑行减速。
 */

// ---- 难度表 h（基础值，全部字面量） ----
const DIFF = [
  { vmax: 8, cadFull: 2.2, lat: 4.4, gap: [17, 23], puddle: 0.26, cat: 0.12, hillGap: [150, 210], slope: [0.07, 0.09] },
  { vmax: 9, cadFull: 2.6, lat: 4.8, gap: [14, 19], puddle: 0.3, cat: 0.18, hillGap: [100, 150], slope: [0.08, 0.11] },
  { vmax: 10, cadFull: 3, lat: 5.2, gap: [11, 15], puddle: 0.32, cat: 0.24, hillGap: [70, 110], slope: [0.1, 0.13] },
]
// 儿童模式折扣 g（A=!big）：cad ×0.8、障碍概率 ×0.55、coinR 0.85、uphill 0.85
const KID_CAD = 0.8
const KID_OBSTACLE = 0.55
const KID_COIN_R = 0.85 // 大屏 0.62
const KID_UPHILL = 0.85 // 大屏 0.7

// ---- 模块级字面量 ----
const CURB_W = 3 // 路缘渲染宽度（px）
const LANE_MAX = 2.65 // 车道横向边界（±米），撞墙 vx=0
const CAM_H = 2.4 // 相机投影基线高度（米）
const CLIP_NEAR = 4.6 // 相机后方裁剪距离（米）
const LOOKAHEAD = 78 // 前方绘制/生成前瞻（米）
const TERRAIN_STEP = 1.5 // 地形采样步长（米）
const CAT_FLEE_V = 1.3 // 小猫横向逃跑速度（米/秒）
const CAT_SENSE = 20 // 小猫感知距离（米，越近跑越快）
const RIDER_H = 1.45 // 骑手渲染身高比例（米）
const ROAD_HALF = 3.05 // 路面半宽（米，车道 ±2.65 + 路缘余量）
const NEAR = 2.2 // 投影近平面（米）
const GAP_COMPRESS_D = 700 // 该里程处事件间距收紧 18%
const ACCEL_TAU = 1.6 // 加速时间常数
const DECEL_TAU = 0.9 // 减速时间常数
const CAD_TAU = 3 // 踏频平滑 τ
const LEAN_DEADZONE = 0.06 // 侧倾死区
const STEER_VEL_TAU = 6 // 横速平滑 τ
const DIZZY_STEER = 0.4 // 眩晕转向 ×0.4
const DIZZY_SLOW = 0.4 // 眩晕减速 ×0.4
const WET_SLOW = 0.6 // 打湿减速 ×0.6
const PEDAL_MAX = 1.15 // pedal 可超转 15%
const CRANK_RATE = 12 // crank += dt × pedal × 12
const COIN_GAP = 2.2 // 金币串间距（米）
const MILE_STEP = 10 // 每前进 10 米 +1 分（静默）
const CREST_PTS = 3 // 冲上坡顶 +3
const WET_DUR = 0.6 // 打湿时长（大屏 1）
const DIZZY_DUR = 0.6 // 撞猫晕眩时长（大屏 1）
const WET_INVULN = 0.6 // 打湿无敌
const CAT_INVULN = 1.5 // 撞猫无敌
const KID_PUDDLE_MARGIN = -0.1 // 水坑判定边距（大屏 +0.12）
const KID_CAT_HIT = 0.45 // 撞猫判定半径（大屏 0.62）
const UP_HINT_T = 2.5 // 上坡提示显示窗口（秒）
const SLOW_HINT_T = 1.5 // 慢速提示显示阈值
const SLOW_VOICE_T = 2.5 // 慢速语音阈值
const VOICE_CD_SLOW = 8 // 慢速语音冷却
const VOICE_CD_UP = 6 // 上坡语音冷却
const HILL_CREST = 8 // 坡顶平段（米）
const STAND_TAU = 4 // 上坡站立马式平滑 τ
const SPEED_LINE_N = 6 // 高速气流线条数

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v))
}
/** 平滑阶梯 D(x)=x²(3−2x) */
function smoothstep(x: number) {
  const t = clamp(x, 0, 1)
  return t * t * (3 - 2 * t)
}

interface Coin {
  id: number
  d: number
  x: number
  got: [boolean, boolean]
}
interface Puddle {
  id: number
  d: number
  x: number
  w: number
  hit: [boolean, boolean]
}
interface Cat {
  id: number
  d: number
  x: number
  hit: [boolean, boolean]
  bumpAt: number
}
interface Hill {
  start: number
  up: number
  down: number
  h: number
}
interface Decor {
  d: number
  side: number
  kind: 0 | 1 | 2 // 树 / 房 / 灌木
  size: number
}

type Seg = 'flat' | 'up' | 'crest' | 'down'

interface Rider {
  x: number // 横向（米）
  vx: number // 平滑横速
  v: number // 车速（米/秒）
  d: number // 里程（米）
  cad: number // 平滑踏频
  steps: number[] // 膝抬升沿时间戳（1s 窗）
  wasL: boolean
  wasR: boolean
  crank: number
  coins: number
  top: number // 全程最高速
  wetT: number
  dizzyT: number
  invulnT: number
  stand: number // 上坡站立马式 0~1
  slowT: number // 慢速持续
  upT: number // 上坡持续
  mile: number // 已计里程碑
  upAnnounced: number // 已语音的上坡（hill 序号）
  lastSeg: Seg
  lastWhoosh: Seg
  dripCd: number
}

function newRider(): Rider {
  return {
    x: 0,
    vx: 0,
    v: 0,
    d: 0,
    cad: 0,
    steps: [],
    wasL: false,
    wasR: false,
    crank: 0,
    coins: 0,
    top: 0,
    wetT: 0,
    dizzyT: 0,
    invulnT: 0,
    stand: 0,
    slowT: 0,
    upT: 0,
    mile: 0,
    upAnnounced: -1,
    lastSeg: 'flat',
    lastWhoosh: 'flat',
    dripCd: 0,
  }
}

class BikeRide extends BaseGame implements Game {
  /** 儿童模式生效值（A=!big） */
  cadFull = (DIFF[this.ctx.difficulty] ?? DIFF[1]).cadFull * KID_CAD
  pPuddle = (DIFF[this.ctx.difficulty] ?? DIFF[1]).puddle * KID_OBSTACLE
  pCat = (DIFF[this.ctx.difficulty] ?? DIFF[1]).cat * KID_OBSTACLE
  vmax = (DIFF[this.ctx.difficulty] ?? DIFF[1]).vmax
  lat = (DIFF[this.ctx.difficulty] ?? DIFF[1]).lat
  gap = (DIFF[this.ctx.difficulty] ?? DIFF[1]).gap
  hillGap = (DIFF[this.ctx.difficulty] ?? DIFF[1]).hillGap
  slope = (DIFF[this.ctx.difficulty] ?? DIFF[1]).slope
  uphillKeep = KID_UPHILL

  riders = [newRider(), newRider()]
  coins: Coin[] = []
  puddles: Puddle[] = []
  cats: Cat[] = []
  hills: Hill[] = []
  decor: Decor[] = []
  private nextD = 25
  private nextHillD = 0
  private nextDecorD = 6
  private idSeq = 0
  score = 0
  /** 全局语音冷却（站点 Y 时间戳） */
  lastVoiceSlow = -9
  lastVoiceUp = -9
  shakeT = 0
  crestFlash = 0

  constructor(ctx: GameContext) {
    super(ctx)
    this.nextHillD = this.hillGap[0]
    // 开局预置 5 枚金币（s=12+i×2.2）
    for (let i = 0; i < 5; i++) {
      this.coins.push({ id: this.idSeq++, d: 12 + i * COIN_GAP, x: 0, got: [false, false] })
    }
    this.ctx.setStage('踩起来！身体歪着拐弯')
  }

  // ---------- 地形 ----------

  private hillAt(d: number): Hill | null {
    for (const h of this.hills) {
      if (d >= h.start && d <= h.start + h.up + HILL_CREST + h.down) return h
    }
    return null
  }

  /** 地形高度（米） */
  private hAt(d: number) {
    const h = this.hillAt(d)
    if (!h) return 0
    const local = d - h.start
    if (local < h.up) return smoothstep(local / h.up) * h.h
    if (local < h.up + HILL_CREST) return h.h
    return h.h * (1 - smoothstep((local - h.up - HILL_CREST) / h.down))
  }

  private segAt(d: number): Seg {
    const h = this.hillAt(d)
    if (!h) return 'flat'
    const local = d - h.start
    if (local < h.up) return 'up'
    if (local < h.up + HILL_CREST) return 'crest'
    return 'down'
  }

  /** 上坡段（含 4m 缓冲）内不出水坑/小猫 */
  private nearHill(d: number) {
    for (const h of this.hills) {
      if (d > h.start - 4 && d < h.start + h.up + HILL_CREST + h.down + 4) return true
    }
    return false
  }

  // ---------- 路书生成 ----------

  private compress(d: number) {
    return 1 - 0.18 * clamp(d / GAP_COMPRESS_D, 0, 1)
  }

  private addCoin(d: number, x: number) {
    this.coins.push({ id: this.idSeq++, d, x, got: [false, false] })
  }

  private gen(dMax: number) {
    while (this.nextHillD < dMax + LOOKAHEAD + 40) {
      const up = 26 + Math.random() * 12
      const down = 22 + Math.random() * 8
      const h = up * (this.slope[0] + Math.random() * (this.slope[1] - this.slope[0]))
      this.hills.push({ start: this.nextHillD, up, down, h })
      const gap = this.hillGap[0] + Math.random() * (this.hillGap[1] - this.hillGap[0])
      this.nextHillD += up + HILL_CREST + down + gap
    }
    while (this.nextDecorD < dMax + LOOKAHEAD) {
      this.decor.push({
        d: this.nextDecorD,
        side: Math.random() < 0.5 ? -1 : 1,
        kind: (Math.floor(Math.random() * 3) as 0 | 1 | 2),
        size: 0.8 + Math.random() * 0.6,
      })
      this.nextDecorD += 12 + Math.random() * 16
    }
    while (this.nextD < dMax + LOOKAHEAD) {
      const d = this.nextD
      const free = !this.nearHill(d)
      const roll = Math.random()
      if (free && roll < this.pPuddle) {
        // 水坑（宽 1.1~1.8m）+ 两侧伴随两列金币
        const w = 1.1 + Math.random() * 0.7
        const x = (Math.random() * 2 - 1) * 2.1
        this.puddles.push({ id: this.idSeq++, d, x, w, hit: [false, false] })
        for (const sd of [-1, 1]) {
          const cx = clamp(x + sd * (w / 2 + 0.7), -LANE_MAX, LANE_MAX)
          this.addCoin(d, cx)
          this.addCoin(d + COIN_GAP, cx)
        }
      } else if (free && roll < this.pPuddle + this.pCat) {
        // 小猫（靠边生成，朝路中走，身后拖金币）
        const side = Math.random() < 0.5 ? -1 : 1
        const x = side * 2.2
        this.cats.push({ id: this.idSeq++, d, x, hit: [false, false], bumpAt: -9 })
        this.addCoin(d - COIN_GAP, x)
        this.addCoin(d - COIN_GAP * 2, x)
      } else {
        // 4 枚金币串：直线 45% / 渐变漂移 35% / 正弦弯 20%
        const r = Math.random()
        const x0 = (Math.random() * 2 - 1) * 1.6
        const drift = (Math.random() < 0.5 ? -1 : 1) * 0.35
        for (let i = 0; i < 4; i++) {
          let x = x0
          if (r < 0.45) x = x0
          else if (r < 0.8) x = clamp(x0 + drift * i, -LANE_MAX, LANE_MAX)
          else x = clamp(x0 + Math.sin(i * 1.3) * 0.9, -LANE_MAX, LANE_MAX)
          this.addCoin(d + i * COIN_GAP, x)
        }
      }
      this.nextD += (this.gap[0] + Math.random() * (this.gap[1] - this.gap[0])) * this.compress(d)
    }
    // 清理身后（只按在场骑手；单人时 P1 停在 0 不参与）
    const L = this.players.filter((p) => p.body).length
    const dBack = L > 1 ? Math.min(this.riders[0].d, this.riders[1].d) : this.riders[0].d
    const minD = dBack - CLIP_NEAR - 12
    this.coins = this.coins.filter((o) => o.d > minD)
    this.puddles = this.puddles.filter((o) => o.d > minD)
    this.cats = this.cats.filter((o) => o.d > minD)
    this.decor = this.decor.filter((o) => o.d > minD)
    this.hills = this.hills.filter((o) => o.start + o.up + HILL_CREST + o.down > minD)
  }

  // ---------- 输入代理 ----------

  /** 步频代理：双膝抬升沿频率（步/秒）；motion.run 无框架特征，并入同一来源 */
  private stepRate(r: Rider, b: Body) {
    const lUp = b.lKnee.y < b.lHip.y - 0.02
    const rUp = b.rKnee.y < b.rHip.y - 0.02
    if (lUp && !r.wasL) r.steps.push(this.t)
    if (rUp && !r.wasR) r.steps.push(this.t)
    r.wasL = lUp
    r.wasR = rUp
    while (r.steps.length && this.t - r.steps[0] > 1) r.steps.shift()
    return r.steps.length
  }

  /** 侧倾代理：肩线倾斜量 dy/肩宽（玩家左倾 → 屏幕右移，与镜像画面一致） */
  private leanOf(b: Body) {
    const width = Math.max(0.05, Math.abs(b.lShoulder.x - b.rShoulder.x))
    return clamp((b.lShoulder.y - b.rShoulder.y) / width, -1, 1)
  }

  // ---------- 主循环 ----------

  tick(f: PoseFrame, dt: number) {
    this.shakeT = Math.max(0, this.shakeT - dt)
    this.crestFlash = Math.max(0, this.crestFlash - dt)
    const L = this.players.filter((p) => p.body).length
    for (let pi = 0; pi < 2; pi++) {
      const r = this.riders[pi]
      const b = f.bodies[pi] ?? null
      const active = L <= 1 ? pi === 0 : true
      if (!active) continue
      this.tickRider(pi, r, b, dt)
    }
    // 小猫逃跑（按最近骑手距离感知）
    const dMin = Math.min(this.riders[0].d, this.riders[1].d)
    for (const cat of this.cats) {
      const near = 1 - clamp(Math.abs(dMin - cat.d) / CAT_SENSE, 0, 1)
      const dir = -Math.sign(cat.x) || 1
      cat.x = clamp(cat.x + dir * CAT_FLEE_V * near * dt, -LANE_MAX, LANE_MAX)
    }
    this.gen(Math.max(this.riders[0].d, this.riders[1].d))
    this.ctx.setScore(this.score)
    const dMax = Math.max(this.riders[0].d, this.riders[1].d)
    const top = Math.max(this.riders[0].top, this.riders[1].top)
    this.ctx.setExtra('骑行距离(米)', Math.floor(dMax))
    this.ctx.setExtra('吃到金币', this.riders[0].coins + this.riders[1].coins)
    this.ctx.setExtra('最高时速(公里/时)', Math.round(top * 3.6))
  }

  private tickRider(pi: number, r: Rider, b: Body | null, dt: number) {
    const prevD = r.d
    // 踏频：u = max(stepRate, run×3) → cad τ=3 平滑
    const u = b ? this.stepRate(r, b) : 0
    r.cad += (u - r.cad) * Math.min(1, dt / CAD_TAU)
    const pedal = clamp(r.cad / this.cadFull, 0, PEDAL_MAX)
    r.crank += dt * pedal * CRANK_RATE

    // 目标速度与减益
    const seg = this.segAt(r.d)
    let fv = this.vmax * pedal
    if (seg === 'up') fv *= this.uphillKeep
    if (seg === 'down') fv = Math.max(fv * 1.12, this.vmax * 0.75)
    if (r.dizzyT > 0) fv *= DIZZY_SLOW
    if (r.wetT > 0) fv *= WET_SLOW
    const tau = fv > r.v ? ACCEL_TAU : DECEL_TAU
    r.v += (fv - r.v) * Math.min(1, dt / tau)
    r.d += r.v * dt
    r.top = Math.max(r.top, r.v)

    // 里程分：每 10 米 +1（静默）
    const mile = Math.floor(r.d / MILE_STEP)
    if (mile > r.mile) {
      this.score += mile - r.mile
      r.mile = mile
    }

    // 转向：lean 死区 0.06 → 目标横速 = eff×1.1×lat×clamp(v/3,.35,1)（眩晕 ×0.4），τ=6
    const leanRaw = b ? this.leanOf(b) : 0
    const eff = Math.abs(leanRaw) < LEAN_DEADZONE ? 0 : leanRaw
    const gain = clamp(r.v / 3, 0.35, 1) * (r.dizzyT > 0 ? DIZZY_STEER : 1)
    const targetVx = eff * 1.1 * this.lat * gain
    r.vx += (targetVx - r.vx) * Math.min(1, dt / STEER_VEL_TAU)
    r.x += r.vx * dt
    if (Math.abs(r.x) > LANE_MAX) {
      r.x = clamp(r.x, -LANE_MAX, LANE_MAX)
      r.vx = 0 // 撞墙
    }

    // 状态计时
    r.wetT = Math.max(0, r.wetT - dt)
    r.dizzyT = Math.max(0, r.dizzyT - dt)
    r.invulnT = Math.max(0, r.invulnT - dt)
    // 上坡站立马式：上坡且 pedal>0.3（τ=4）
    const wantStand = seg === 'up' && pedal > 0.3 ? 1 : 0
    r.stand += (wantStand - r.stand) * Math.min(1, dt / STAND_TAU)
    // 湿身滴水
    r.dripCd -= dt
    if (r.wetT > 0 && r.v > 1 && r.dripCd <= 0) {
      r.dripCd = 0.09
      const p = this.riderScreen(pi)
      this.particles.burst(p.x, p.y, '#6ec1ff', 1, 60, 3, 900)
    }

    // 上坡提示 / 语音（6s 冷却）；进入上坡与下坡各一次 whoosh
    if (seg === 'up') {
      r.upT += dt
      if (r.lastSeg !== 'up') {
        this.ctx.audio.jump() // whoosh
        if (this.t - this.lastVoiceUp > VOICE_CD_UP) {
          this.lastVoiceUp = this.t
          this.ctx.speak('上坡啦，使劲踩！')
        }
        r.upAnnounced = this.hills.findIndex((h) => r.d >= h.start && r.d <= h.start + h.up + HILL_CREST + h.down)
      }
    } else {
      r.upT = 0
      if (seg === 'down' && r.lastSeg !== 'down') this.ctx.audio.jump() // whoosh
    }
    r.lastSeg = seg
    // 慢速提示 / 语音（8s 冷却）
    if (r.v < 1.5) {
      r.slowT += dt
      if (r.slowT > SLOW_VOICE_T && this.t - this.lastVoiceSlow > VOICE_CD_SLOW) {
        this.lastVoiceSlow = this.t
        this.ctx.speak('高抬腿，踩起来！')
      }
    } else {
      r.slowT = 0
    }

    // 坡顶跨越（s1 = start+up）一次性 +3
    for (const h of this.hills) {
      const s1 = h.start + h.up
      if (prevD < s1 && r.d >= s1) {
        this.score += CREST_PTS
        this.crestFlash = 0.6
        const p = this.riderScreen(pi)
        this.say(`冲上坡顶 +${CREST_PTS}`, p.x, p.y - RIDER_H * p.sc * 1.3, '#ffd54a', 30)
        this.ctx.audio.fanfare() // tada
        this.particles.confetti(this.W, 24)
        if (this.players.filter((q) => q.body).length <= 1) this.ctx.speak('冲上坡顶啦，真棒！')
      }
    }

    // 碰撞：金币（吸附半径 coinR）
    const hf = this.presentHalf()[pi]
    for (const coin of this.coins) {
      if (coin.got[pi]) continue
      if (Math.abs(coin.d - r.d) > 1) continue
      if (Math.abs(r.x - coin.x) <= KID_COIN_R) {
        coin.got[pi] = true
        r.coins++
        this.score += 1
        const p = this.projHalf(hf.x0, hf.w, pi, coin.d - r.d, coin.x, this.hAt(coin.d))
        this.say('+1', p.x, p.y - 30 * (this.H / 720), '#ffd54a', 26)
        this.ctx.audio.play('score', 0.85, 1 + (r.coins % 5) * 0.06)
        this.particles.burst(p.x, p.y, '#ffd54a', 6, 240, 4)
      }
    }
    // 水坑
    for (const pd of this.puddles) {
      if (pd.hit[pi]) continue
      if (Math.abs(pd.d - r.d) > 0.5) continue
      pd.hit[pi] = true
      if (r.invulnT <= 0 && Math.abs(r.x - pd.x) <= pd.w / 2 + KID_PUDDLE_MARGIN) {
        r.wetT = WET_DUR
        r.invulnT = WET_INVULN
        this.ctx.audio.drop() // splash
        this.shakeT = 0.3
        const p = this.riderScreen(pi)
        this.particles.burst(p.x, p.y, '#6ec1ff', 22, 340, 4)
        this.say('溅水啦！', p.x, p.y - 90 * (this.H / 720), '#6ec1ff', 34)
      }
    }
    // 小猫
    for (const cat of this.cats) {
      if (cat.hit[pi]) continue
      if (Math.abs(cat.d - r.d) > 0.5) continue
      cat.hit[pi] = true
      if (r.invulnT <= 0 && Math.abs(r.x - cat.x) <= KID_CAT_HIT) {
        cat.bumpAt = this.t
        r.dizzyT = DIZZY_DUR
        r.invulnT = CAT_INVULN
        this.ctx.audio.fail() // oops
        this.shakeT = 0.5
        const p = this.riderScreen(pi)
        this.particles.burst(p.x, p.y, '#a78bfa', 9, 300, 5)
        this.say('小心小猫！', p.x, p.y - 90 * (this.H / 720), '#a78bfa', 34)
      }
    }
  }

  private presentHalf() {
    const duo = this.players.filter((p) => p.body).length > 1
    return duo
      ? [
          { x0: 0, w: this.W / 2 },
          { x0: this.W / 2, w: this.W / 2 },
        ]
      : [
          { x0: this.W * 0.08, w: this.W * 0.84 },
          { x0: this.W * 0.08, w: this.W * 0.84 },
        ]
  }

  /** 相机横向前瞻：单人 0.35 / 双人 0.6 × 骑手横坐标 */
  private camX(pi: number) {
    const duo = this.players.filter((p) => p.body).length > 1
    return this.riders[pi].x * (duo ? 0.6 : 0.35)
  }

  /** 投影：半屏 (x0,w)、距离差 dd、横坐标 x、高度 h（米）→ 屏幕 */
  private projHalf(x0: number, w: number, pi: number, dd: number, x: number, h: number) {
    const u = this.H / 720
    const F = (w / this.W) * 360 * u + 60 * u // 半屏焦距
    const ddc = clamp(dd, NEAR, LOOKAHEAD)
    const sc = F / ddc
    const cx = x0 + w / 2
    const horizon = this.H * 0.3
    return { x: cx + (x - this.camX(pi)) * sc, y: horizon + (CAM_H - h) * sc, sc, horizon }
  }

  private proj(pi: number, dd: number, x: number, h: number) {
    const half = this.presentHalf()[pi]
    return this.projHalf(half.x0, half.w, pi, dd, x, h)
  }

  /** 骑手自身屏幕位置 */
  private riderScreen(pi: number) {
    const r = this.riders[pi]
    return this.proj(pi, 0, r.x, this.hAt(r.d))
  }

  // ---------- 渲染 ----------

  paint(c: CanvasRenderingContext2D) {
    const duo = this.players.filter((p) => p.body).length > 1
    const halves = this.presentHalf()
    for (let pi = 0; pi < (duo ? 2 : 1); pi++) {
      this.paintHalf(c, halves[pi].x0, halves[pi].w, pi)
    }
    if (duo) {
      // 中缝白线 + 姓名牌
      c.fillStyle = 'rgba(255,255,255,.85)'
      c.fillRect(this.W / 2 - 2, 0, 4, this.H)
      for (let pi = 0; pi < 2; pi++) {
        const hx = pi === 0 ? 18 : this.W / 2 + 18
        c.fillStyle = 'rgba(10,16,44,.5)'
        rr(c, hx, 14, 64, 34, 17)
        c.fill()
        outlineTxt(c, `${pi + 1}P`, hx + 32, 31, 20, this.players[pi].color)
      }
    }
    if (this.shakeT > 0) {
      c.save()
      c.globalAlpha = Math.min(0.3, this.shakeT)
      c.fillStyle = '#6ec1ff'
      c.fillRect(0, 0, this.W, this.H)
      c.restore()
    }
    // 冲上坡顶高光（站点 highlight(1.5) 的等价实现：金色边缘泛光淡出）
    if (this.crestFlash > 0) {
      c.save()
      const edge = c.createRadialGradient(this.W / 2, this.H / 2, this.H * 0.35, this.W / 2, this.H / 2, this.H * 0.9)
      edge.addColorStop(0, 'rgba(255,213,74,0)')
      edge.addColorStop(1, `rgba(255,213,74,${0.4 * (this.crestFlash / 0.6)})`)
      c.fillStyle = edge
      c.fillRect(0, 0, this.W, this.H)
      c.restore()
    }
  }

  private paintHalf(c: CanvasRenderingContext2D, x0: number, w: number, pi: number) {
    const u = this.H / 720
    const r = this.riders[pi]
    c.save()
    c.beginPath()
    c.rect(x0, 0, w, this.H)
    c.clip()

    // 天空 / 地面（半透明，保留摄像头画面）
    c.fillStyle = 'rgba(168,212,240,.42)'
    c.fillRect(x0, 0, w, this.H * 0.3)
    c.fillStyle = 'rgba(150,196,116,.45)'
    c.fillRect(x0, this.H * 0.3, w, this.H * 0.7)

    // 太阳与云
    circle(c, x0 + w * 0.82, 64 * u, 34 * u, 'rgba(255,224,130,.85)')
    glow(c, x0 + w * 0.82, 64 * u, 60 * u, '#ffe082', 0.3)
    for (let i = 0; i < 3; i++) {
      const cxp = x0 + ((i * 260 + 90 - r.d * 1.4) % (w + 220) + w + 220) % (w + 220) - 110
      const cyp = (44 + i * 34) * u
      c.fillStyle = 'rgba(255,255,255,.75)'
      circle(c, cxp, cyp, 20 * u, 'rgba(255,255,255,.75)')
      circle(c, cxp + 22 * u, cyp + 5 * u, 15 * u, 'rgba(255,255,255,.75)')
      circle(c, cxp - 22 * u, cyp + 6 * u, 14 * u, 'rgba(255,255,255,.75)')
    }

    // 视差远山两层（#b5ddb0 / #8fcf86，正弦山脊）
    const horizon = this.H * 0.3
    const layers = [
      { color: 'rgba(181,221,176,.8)', base: 46 * u, amp: 26 * u, k: 0.012, par: 0.06 },
      { color: 'rgba(143,207,134,.85)', base: 20 * u, amp: 20 * u, k: 0.02, par: 0.14 },
    ]
    for (const ly of layers) {
      c.fillStyle = ly.color
      c.beginPath()
      c.moveTo(x0, horizon + 4)
      for (let px = 0; px <= w; px += 24) {
        const yy = horizon - ly.base + Math.sin((px + r.d * ly.par * 100) * ly.k) * ly.amp
        c.lineTo(x0 + px, yy)
      }
      c.lineTo(x0 + w, horizon + 4)
      c.closePath()
      c.fill()
    }

    // 路面（远 → 近条带，坡面明暗 + 顶面高光）
    const nStrips = Math.ceil((LOOKAHEAD - NEAR) / TERRAIN_STEP)
    for (let i = nStrips; i >= 0; i--) {
      const dd0 = NEAR + i * TERRAIN_STEP
      const dd1 = dd0 + TERRAIN_STEP
      const d0 = r.d + dd0
      const d1 = r.d + dd1
      const p00 = this.projHalf(x0, w, pi, dd0, -ROAD_HALF, this.hAt(d0))
      const p01 = this.projHalf(x0, w, pi, dd0, ROAD_HALF, this.hAt(d0))
      const p10 = this.projHalf(x0, w, pi, dd1, -ROAD_HALF, this.hAt(d1))
      const p11 = this.projHalf(x0, w, pi, dd1, ROAD_HALF, this.hAt(d1))
      if (p00.y < 0 && p10.y < 0) continue
      const h0 = this.hAt(d0)
      const seg = this.segAt(d0)
      // 坡越高越亮；坡顶平段高光
      const shade = 0.42 + clamp(h0 / 3, 0, 0.16) + (seg === 'crest' ? 0.12 : 0)
      c.fillStyle = `rgba(${Math.round(96 + shade * 60)},${Math.round(102 + shade * 60)},${Math.round(118 + shade * 60)},${0.62 + shade * 0.25})`
      c.beginPath()
      c.moveTo(p00.x, p00.y)
      c.lineTo(p01.x, p01.y)
      c.lineTo(p11.x, p11.y)
      c.lineTo(p10.x, p10.y)
      c.closePath()
      c.fill()
      // 路缘（宽 CURB_W）
      c.strokeStyle = 'rgba(255,255,255,.55)'
      c.lineWidth = CURB_W
      c.beginPath()
      c.moveTo(p00.x, p00.y)
      c.lineTo(p10.x, p10.y)
      c.moveTo(p01.x, p01.y)
      c.lineTo(p11.x, p11.y)
      c.stroke()
      // 中缝虚线（稀疏条带画）
      if (i % 2 === 0) {
        const m0 = this.projHalf(x0, w, pi, dd0, 0, this.hAt(d0))
        const m1 = this.projHalf(x0, w, pi, dd1, 0, this.hAt(d1))
        c.strokeStyle = 'rgba(255,255,255,.4)'
        c.lineWidth = 3
        c.beginPath()
        c.moveTo(m0.x, m0.y)
        c.lineTo(m1.x, m1.y)
        c.stroke()
      }
    }

    // 景深装饰（树/房/灌木）
    for (const dc of this.decor) {
      const dd = dc.d - r.d
      if (dd < NEAR || dd > LOOKAHEAD) continue
      const p = this.projHalf(x0, w, pi, dd, dc.side * (ROAD_HALF + 2.2), 0)
      const sz = dc.size * p.sc
      if (dc.kind === 0) {
        // 树
        c.fillStyle = 'rgba(110,72,40,.8)'
        c.fillRect(p.x - sz * 0.06, p.y - sz * 0.5, sz * 0.12, sz * 0.5)
        circle(c, p.x, p.y - sz * 0.72, sz * 0.3, 'rgba(74,150,84,.9)')
        circle(c, p.x - sz * 0.16, p.y - sz * 0.56, sz * 0.2, 'rgba(88,168,96,.9)')
        circle(c, p.x + sz * 0.16, p.y - sz * 0.58, sz * 0.2, 'rgba(88,168,96,.9)')
      } else if (dc.kind === 1) {
        // 房
        c.fillStyle = 'rgba(214,160,120,.85)'
        c.fillRect(p.x - sz * 0.24, p.y - sz * 0.4, sz * 0.48, sz * 0.4)
        c.fillStyle = 'rgba(180,72,60,.85)'
        c.beginPath()
        c.moveTo(p.x - sz * 0.3, p.y - sz * 0.4)
        c.lineTo(p.x, p.y - sz * 0.66)
        c.lineTo(p.x + sz * 0.3, p.y - sz * 0.4)
        c.closePath()
        c.fill()
      } else {
        circle(c, p.x, p.y - sz * 0.12, sz * 0.18, 'rgba(96,168,88,.9)')
        circle(c, p.x + sz * 0.14, p.y - sz * 0.08, sz * 0.13, 'rgba(110,182,98,.9)')
      }
    }

    // 终点拱门（保持在 78m 前瞻处，周期 78m 掠过）与告示牌
    {
      const dd = LOOKAHEAD - (r.d % LOOKAHEAD)
      if (dd > 10) {
        const p = this.projHalf(x0, w, pi, dd, 0, this.hAt(r.d + dd))
      const sc = p.sc
      c.strokeStyle = 'rgba(255,255,255,.7)'
      c.lineWidth = 5 * u
      c.beginPath()
      c.moveTo(p.x - sc * 2.6, p.y)
      c.lineTo(p.x - sc * 2.6, p.y - sc * 1.6)
      c.quadraticCurveTo(p.x, p.y - sc * 2.3, p.x + sc * 2.6, p.y - sc * 1.6)
      c.lineTo(p.x + sc * 2.6, p.y)
      c.stroke()
      c.fillStyle = '#ffd54a'
      rr(c, p.x - sc * 1.2, p.y - sc * 2.2, sc * 2.4, sc * 0.4, 4 * u)
      c.fill()
      // 告示牌
      c.fillStyle = 'rgba(90,60,30,.85)'
      c.fillRect(p.x + sc * 3.2, p.y - sc * 0.9, sc * 0.1, sc * 0.9)
      c.fillStyle = 'rgba(255,255,255,.9)'
      rr(c, p.x + sc * 2.9, p.y - sc * 1.3, sc * 0.7, sc * 0.42, 3 * u)
      c.fill()
      }
    }

    // 金币 / 水坑 / 小猫
    for (const coin of this.coins) {
      if (coin.got[pi]) continue
      const dd = coin.d - r.d
      if (dd < NEAR - 1 || dd > LOOKAHEAD) continue
      const p = this.projHalf(x0, w, pi, dd, coin.x, this.hAt(coin.d))
      const cr = 0.32 * p.sc
      const bob = Math.sin(this.t * 5 + coin.id) * cr * 0.15
      circle(c, p.x, p.y - cr - bob, cr, '#ffd54a')
      circle(c, p.x - cr * 0.3, p.y - cr - bob - cr * 0.3, cr * 0.28, 'rgba(255,255,255,.85)')
    }
    for (const pd of this.puddles) {
      const dd = pd.d - r.d
      if (dd < NEAR - 1 || dd > LOOKAHEAD) continue
      const p = this.projHalf(x0, w, pi, dd, pd.x, this.hAt(pd.d))
      c.fillStyle = 'rgba(70,150,220,.75)'
      c.beginPath()
      c.ellipse(p.x, p.y, pd.w * p.sc, pd.w * p.sc * 0.3, 0, 0, Math.PI * 2)
      c.fill()
      c.fillStyle = 'rgba(255,255,255,.35)'
      c.beginPath()
      c.ellipse(p.x - pd.w * p.sc * 0.25, p.y, pd.w * p.sc * 0.3, pd.w * p.sc * 0.1, 0, 0, Math.PI * 2)
      c.fill()
    }
    for (const cat of this.cats) {
      const dd = cat.d - r.d
      if (dd < NEAR - 1 || dd > LOOKAHEAD) continue
      const p = this.projHalf(x0, w, pi, dd, cat.x, this.hAt(cat.d))
      const sz = 0.5 * p.sc
      const bump = this.t - cat.bumpAt < 0.4 ? Math.sin(((this.t - cat.bumpAt) / 0.4) * Math.PI) * sz * 0.8 : 0
      c.fillStyle = '#3a3a4c'
      c.beginPath()
      c.ellipse(p.x, p.y - sz * 0.4 - bump, sz * 0.5, sz * 0.34, 0, 0, Math.PI * 2)
      c.fill()
      circle(c, p.x + sz * 0.42, p.y - sz * 0.66 - bump, sz * 0.22, '#3a3a4c')
      c.fillStyle = '#f2a7b3'
      c.beginPath()
      c.moveTo(p.x, p.y - sz * 0.4 - bump)
      c.quadraticCurveTo(p.x - sz * 0.7, p.y - sz * 0.55 - bump, p.x - sz * 0.6, p.y - bump)
      c.strokeStyle = '#3a3a4c'
      c.lineWidth = sz * 0.12
      c.stroke()
    }

    // 骑手
    this.paintRider(c, x0, w, pi)

    // 高速气流线：v/vmax > 0.85 时屏幕两侧 6 条
    if (r.v / this.vmax > 0.85) {
      const a = clamp((r.v / this.vmax - 0.85) / 0.3, 0, 1) * 0.5
      c.strokeStyle = `rgba(255,255,255,${a})`
      c.lineWidth = 2.5 * u
      for (let i = 0; i < SPEED_LINE_N; i++) {
        const yy = (this.H * 0.18 + i * 62) * u + ((this.t * 900 + i * 130) % 120)
        const len = (70 + (i % 3) * 40) * u
        const sx = i % 2 === 0 ? x0 + 14 * u : x0 + w - 14 * u
        c.beginPath()
        c.moveTo(sx, yy)
        c.lineTo(sx + (i % 2 === 0 ? len : -len), yy + 8 * u)
        c.stroke()
      }
    }

    // 速度仪表盘（半圆表盘，五段彩弧；大屏才有数字，儿童模式只画表）
    this.paintGauge(c, x0, w, pi, u)

    // 提示文字
    if (r.upT > 0.4 && r.upT < UP_HINT_T) {
      outlineTxt(c, '上坡！使劲踩！', x0 + w / 2, this.H * 0.42, 34 * u, '#ffd54a')
    }
    if (r.slowT > SLOW_HINT_T) {
      outlineTxt(c, '高抬腿，踩起来！', x0 + w / 2, this.H * 0.5, 30 * u, '#ffffff')
    }

    c.restore()
  }

  private paintRider(c: CanvasRenderingContext2D, x0: number, w: number, pi: number) {
    const u = this.H / 720
    const r = this.riders[pi]
    const h0 = this.hAt(r.d)
    const p = this.projHalf(x0, w, pi, 0, r.x, h0)
    const sc = p.sc
    // 无敌闪烁：invuln>0 && dizzy<=0 → 10Hz 隐藏
    if (r.invulnT > 0 && r.dizzyT <= 0 && Math.floor(this.t * 10) % 2 === 0) return
    // 影子
    c.save()
    c.globalAlpha = 0.25
    c.beginPath()
    c.ellipse(p.x, p.y, 0.9 * sc, 0.22 * sc, 0, 0, Math.PI * 2)
    c.fillStyle = '#000'
    c.fill()
    c.restore()
    const leanTilt = clamp(r.vx / (this.lat * 1.2), -1, 1) * 0.3
    c.save()
    c.translate(p.x, p.y)
    c.rotate(leanTilt)
    const wheelR = 0.34 * sc
    // 车轮（crank 旋转辐条）
    for (const sd of [-1, 1]) {
      const wx = sd * 0.55 * sc
      c.strokeStyle = '#2c3444'
      c.lineWidth = 4 * u
      c.beginPath()
      c.arc(wx, -wheelR, wheelR, 0, Math.PI * 2)
      c.stroke()
      c.save()
      c.translate(wx, -wheelR)
      c.rotate(r.crank)
      c.strokeStyle = 'rgba(255,255,255,.5)'
      c.lineWidth = 2 * u
      c.beginPath()
      c.moveTo(-wheelR * 0.8, 0)
      c.lineTo(wheelR * 0.8, 0)
      c.moveTo(0, -wheelR * 0.8)
      c.lineTo(0, wheelR * 0.8)
      c.stroke()
      c.restore()
    }
    // 车架
    c.strokeStyle = this.players[pi].color
    c.lineWidth = 5 * u
    c.beginPath()
    c.moveTo(-0.55 * sc, -wheelR)
    c.lineTo(0.1 * sc, -0.85 * sc)
    c.lineTo(0.55 * sc, -wheelR)
    c.moveTo(0.1 * sc, -0.85 * sc)
    c.lineTo(0.32 * sc, -1.15 * sc)
    c.stroke()
    // 车把
    c.beginPath()
    c.moveTo(0.32 * sc, -1.15 * sc)
    c.lineTo(0.42 * sc, -1.25 * sc)
    c.stroke()
    // 躯干与头（站立马式 stand 抬高）
    const bodyLift = r.stand * 0.25 * sc
    const hipX = 0.05 * sc
    const hipY = -0.85 * sc - bodyLift
    const shX = 0.3 * sc
    const shY = -1.4 * sc - bodyLift
    c.strokeStyle = this.players[pi].color
    c.lineWidth = 9 * u
    c.lineCap = 'round'
    c.beginPath()
    c.moveTo(hipX, hipY)
    c.lineTo(shX, shY)
    c.stroke()
    circle(c, shX + 0.06 * sc, shY - 0.22 * sc, 0.17 * sc, '#ffd9b3')
    // 腿（蹬踏板：crank 相位）
    c.strokeStyle = '#2b3a67'
    c.lineWidth = 6 * u
    for (const ph of [0, Math.PI]) {
      const a = r.crank + ph
      const fx = 0.05 * sc + Math.cos(a) * 0.16 * sc
      const fy = -0.62 * sc + Math.sin(a) * 0.16 * sc
      c.beginPath()
      c.moveTo(hipX, hipY)
      c.lineTo((hipX + fx) / 2 - 0.05 * sc, (hipY + fy) / 2)
      c.lineTo(fx, fy)
      c.stroke()
    }
    // 晕眩星星
    if (r.dizzyT > 0) {
      for (let i = 0; i < 3; i++) {
        const a = this.t * 6 + (i * Math.PI * 2) / 3
        txt(c, '✨', shX + Math.cos(a) * 0.5 * sc, shY - 0.5 * sc + Math.sin(a) * 0.16 * sc, 16 * u)
      }
    }
    c.restore()
    glow(c, p.x, p.y - 0.8 * sc, 1.4 * sc, this.players[pi].color, 0.16)
  }

  /** 半圆速度表：指针角 clamp(v/(vmax×1.15),0,0.97)×π，五段彩弧 */
  private paintGauge(c: CanvasRenderingContext2D, x0: number, w: number, pi: number, u: number) {
    const r = this.riders[pi]
    const gr = 46 * u
    const gx = x0 + w - gr - 26 * u
    const gy = this.H - gr - 46 * u
    const pct = clamp(r.v / (this.vmax * 1.15), 0, 0.97)
    const cols = ['#3390fc', '#3ddc97', '#ffd54a', '#ff9f1c', '#ff4d4d']
    for (let i = 0; i < 5; i++) {
      const a0 = Math.PI * (1 - (i + 1) / 5)
      const a1 = Math.PI * (1 - i / 5)
      c.beginPath()
      c.arc(gx, gy, gr, a0, a1)
      c.strokeStyle = cols[i]
      c.lineWidth = 9 * u
      c.stroke()
    }
    // 指针
    const a = Math.PI * (1 - pct)
    c.strokeStyle = '#fff'
    c.lineWidth = 4 * u
    c.beginPath()
    c.moveTo(gx, gy)
    c.lineTo(gx + Math.cos(a) * gr * 0.82, gy - Math.sin(a) * gr * 0.82)
    c.stroke()
    circle(c, gx, gy, 6 * u, '#fff')
    // 大屏才有 {km/h} 与 {里程} 数字；儿童模式只画表（本框架按儿童模式）
  }
}

export default function create(ctx: GameContext) {
  return new BikeRide(ctx)
}
