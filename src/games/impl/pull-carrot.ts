import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, emoji, glow, outlineTxt, rr, txt } from '@/core/draw'

/**
 * 小兔子拔萝卜（对齐 dongdongpark pull-carrot 真实规则，逆向报告 _reverse/reports/pull-carrot.md）：
 * 每人一块 3 洞萝卜地；洞里随机长出萝卜（普通 1 次/大萝卜 3 次）或石头。
 * 玩家横向挪到发亮的洞前 → 深蹲 + 手放低抓住叶子 → 干脆地站直发力拔出；
 * 抓着半蹲僵持会脱手滑落；误拔石头算失误（不扣分）；萝卜久不拔会跳洞逃跑；篮子堆萝卜。
 * 站点框架黑盒量的等价代理（注释注明）：
 * - motion.squat 归一蹲深 → 1−(踝中y−髋中y)/(0.45×肩踝距)，站姿≈0、深蹲→1（与 counter-kit 同标尺）
 * - motion.shift（走位补偿）→ 地块锚点钉在首次标定站位，人丢失 ≥1.5s 才重新标定
 * - heat（框架热度）→ min(1, t/60) 线性升温（fruit-slash 同款代理）
 * - 站点专属音效 appear/wobble/boing/whoosh/thud/chime → 用最近似采样等价代理
 */

/** 难度表（报告 §1 全部字面量）：大萝卜率/石头率/等待秒/起身时限/蹲下阈值/站直阈值/手低阈值/同洞率 */
const DIFF = [
  { big: 0.15, stone: 0.15, stay: 9, window: 2.2, squat: 0.4, stand: 0.2, low: 0.4, same: 0.25 },
  { big: 0.25, stone: 0.28, stay: 6.5, window: 1.5, squat: 0.45, stand: 0.15, low: 0.25, same: 0.2 },
  { big: 0.33, stone: 0.4, stay: 4.5, window: 1.2, squat: 0.45, stand: 0.15, low: 0.15, same: 0.15 },
]
const HOLES = 3 // 每块地 3 个洞（源码 x=3）
const NEED = 3 // 大萝卜需要拉拽次数（源码 S=3）
const GROW = 0.45 // 长出动画时长（源码 C）
const HOP = 0.32 // 跳洞/石头下沉动画时长（源码 w）
const NEXT_CD = 0.45 // 拔出到下一个萝卜的冷却（源码 T）
const FLY = 0.75 // 萝卜飞进篮子的时长（源码 E）
const CHEERS = ['真棒！', '好多萝卜呀！', '你真有力气！', '加油加油！'] // 每拔满 5 个轮播（源码 D）
const FIRST_AT = 0.5 // 开局到第一个萝卜（源码 nextAt=0.5）
const STOOP_T = 1.2 // 弯腰教学：超 1.2s 语音纠正
const EMPTY_GAP = 1 // 空洞抓取反馈间隔（手指提示）
const STONE_VOICE_MAX = 2 // 误拔石头语音只说前 2 次
const MATCH_K = 0.5 // 洞匹配半径 = gap×0.5
const MATCH_EDGE_K = 0.85 // 端洞向外侧放宽到 gap×0.85
const RELEASE_K = 0.75 // 脱手水平距离 = gap×0.75
const STOOP_SQUAT = 0.25 // 弯腰判定：squat<0.25 视为没蹲（弯腰）
const HAND_KNEE_K = 0.1 // 弯腰检测：手低于「膝上 0.1×torso」
const AT_SQUAT = 0.25 // 逃跑豁免：站在洞上且 squat>0.25 不计时
const OUT_BACK = 1.70158 // outBack 弹出系数

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v))
}

/** 站点 motion.squat 的等价代理（见文件头注释），标尺与 counter-kit SquatCounter 一致 */
function squatMetric(b: Body) {
  const ankleY = (b.lm[27].y + b.lm[28].y) / 2
  const shY = (b.lm[11].y + b.lm[12].y) / 2
  const span = Math.max(0.06, Math.abs(ankleY - shY))
  return clamp(1 - Math.max(0, ankleY - b.hipC.y) / (0.45 * span), 0, 1)
}

function outBack(x: number) {
  const p = clamp(x, 0, 1) - 1
  return 1 + (OUT_BACK + 1) * p * p * p + OUT_BACK * p * p
}

interface Carrot {
  hole: number
  big: boolean
  need: number
  pulls: number
  state: 'grow' | 'ready' | 'hop' | 'fly'
  t: number // 当前状态计时
  wait: number // 逃跑等待累计
  stay: number // 本次等待上限
  hopFrom: number // 跳洞起点 x（px）
  hopTo: number // 跳洞终点 x（px）
  flyT: number
  alive: boolean
}

interface Stone {
  hole: number
  state: 'grow' | 'ready' | 'sink' | 'fly'
  t: number
  flyT: number
  x0: number // 抛飞起点（px）
  y0: number
  vx: number
  vy: number
  alive: boolean
}

interface PState {
  ready: boolean // 是否已标定地块
  lostT: number
  anchor: number // 地块锚点 x（px）
  torso: number // 平滑躯干长（px）
  groundY: number
  squat: number // 归一蹲深
  grab: { kind: 'carrot' | 'stone'; hole: number } | null
  heldAt: number // 最近一次深蹲确认时刻（半蹲超时窗起点）
  stoopT: number
  emptyAt: number
  nextAt: number
  lastHole: number // 上个萝卜所在洞
  spawned: number
  stoneVoiceN: number
  slipVoice: boolean
  carrots: number
  bigs: number
  stones: number
  slips: number
  carrot: Carrot | null
  stone: Stone | null
  mood: 'idle' | 'cheer' | 'no'
  moodT: number
}

class PullCarrot extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  score = 0
  ps: PState[] = [this.newPS(), this.newPS()]
  bannerText = ''
  bannerT = 0
  shakeT = 0
  shakeMag = 0

  private newPS(): PState {
    return {
      ready: false,
      lostT: 0,
      anchor: this.W / 2,
      torso: this.H * 0.22,
      groundY: this.H * 0.82,
      squat: 0,
      grab: null,
      heldAt: -9,
      stoopT: 0,
      emptyAt: -9,
      nextAt: FIRST_AT,
      lastHole: 1,
      spawned: 0,
      stoneVoiceN: 0,
      slipVoice: false,
      carrots: 0,
      bigs: 0,
      stones: 0,
      slips: 0,
      carrot: null,
      stone: null,
      mood: 'idle',
      moodT: 0,
    }
  }

  private shake(mag: number, sec = 0.3) {
    this.shakeMag = mag
    this.shakeT = sec
  }

  private banner(text: string, sec = 1.1) {
    if (!text) return
    this.bannerText = text
    this.bannerT = sec
  }

  /** 分屏区（硬性约束）：solo 0.08~0.92，duo 左 0.03~0.47 / 右 0.53~0.97 */
  private zone(pi: number) {
    const present = this.players.filter((p) => p.body).length
    if (present > 1) return pi === 0 ? { x0: this.W * 0.03, x1: this.W * 0.47 } : { x0: this.W * 0.53, x1: this.W * 0.97 }
    return { x0: this.W * 0.08, x1: this.W * 0.92 }
  }

  /** 场地几何（报告 §2.1）：洞半径/洞间距/洞心位置 */
  private layout(ps: PState, pi: number) {
    const z = this.zone(pi)
    const u = this.H / 720
    const r = Math.round(clamp(ps.torso * 0.38, 30 * u, 90 * u) / 2) * 2
    const avail = z.x1 - z.x0
    const duo = this.players.filter((p) => p.body).length > 1
    const gap = Math.max(r * 2.2, Math.min(ps.torso * (duo ? 0.95 : 1.25), avail / 2))
    const holes = [ps.anchor - gap, ps.anchor, ps.anchor + gap].map((x) => clamp(x, z.x0 + r, z.x1 - r))
    return { r, gap, holes }
  }

  tick(f: PoseFrame, dt: number) {
    this.bannerT = Math.max(0, this.bannerT - dt)
    this.shakeT = Math.max(0, this.shakeT - dt)
    for (let pi = 0; pi < 2; pi++) {
      const ps = this.ps[pi]
      const b = f.bodies[pi]
      const pv = this.players[pi]
      if (b && pv.body) {
        this.calibrate(ps, pi, b, dt)
        const ly = this.layout(ps, pi)
        ps.squat = squatMetric(b)
        this.trySpawn(ps)
        this.grabLogic(ps, pi, b, ly, dt)
      } else {
        // 人丢失：等价代理——地块锚点保留，丢失 ≥1.5s 后允许重新标定
        ps.lostT += dt
        if (ps.ready && ps.lostT > 1.5) ps.ready = false
        if (ps.grab) ps.grab = null
        ps.squat = 0
      }
      this.animate(ps, pi, dt)
      if (ps.moodT > 0) ps.moodT -= dt
      else ps.mood = 'idle'
    }
    const totC = this.ps[0].carrots + this.ps[1].carrots
    const totB = this.ps[0].bigs + this.ps[1].bigs
    const totS = this.ps[0].stones + this.ps[1].stones
    this.ctx.setScore(this.score)
    this.ctx.setExtra('拔出萝卜', totC)
    this.ctx.setExtra('大萝卜', totB)
    this.ctx.setExtra('拔到石头', totS)
  }

  /** 身体标定（报告 §2.1）：锚点/躯干长/地面高度 */
  private calibrate(ps: PState, pi: number, b: Body, dt: number) {
    const z = this.zone(pi)
    const blend = (b.hipC.x * 0.6 + b.shoulderC.x * 0.4) * this.W
    const torso = Math.max(60, b.scale * this.H)
    ps.lostT = 0
    if (!ps.ready) {
      ps.ready = true
      ps.anchor = clamp(blend, z.x0 + this.W * 0.08, z.x1 - this.W * 0.08)
      ps.torso = torso
    } else {
      ps.torso += (torso - ps.torso) * Math.min(1, dt * 3)
    }
    const ly = this.layout(ps, pi)
    // 地面高度：脚部有效点最大 y + torso×0.3（无脚时 hip + torso×1.45），clamp [0.6H, H−0.75r]
    const lOk = b.lm[27] && (b.lm[27].visibility ?? 1) >= 0.5
    const rOk = b.lm[28] && (b.lm[28].visibility ?? 1) >= 0.5
    let gy: number
    if (lOk || rOk) {
      const footY = Math.max(lOk ? b.lm[27].y * this.H : -1, rOk ? b.lm[28].y * this.H : -1)
      gy = footY + ps.torso * 0.3
    } else {
      gy = b.hipC.y * this.H + ps.torso * 1.45
    }
    gy = clamp(gy, this.H * 0.6, this.H - ly.r * 0.75)
    ps.groundY += (gy - ps.groundY) * Math.min(1, dt * 4)
  }

  /** 生成规则（报告 §2.2 G 函数） */
  private trySpawn(ps: PState) {
    if (ps.carrot || this.t < ps.nextAt) return
    const k = this.cfg
    const prevHole = ps.lastHole
    // 位置 roll：i<same 复用上个洞，否则在另外两洞中二选一
    const i = Math.random()
    let holeIdx: number
    if (i < k.same) holeIdx = prevHole
    else {
      const others = [0, 1, 2].filter((h) => h !== prevHole)
      holeIdx = others[clamp(Math.floor(((i - k.same) / (1 - k.same)) * 2), 0, 1)]
    }
    const first = ps.spawned === 0
    const big = !first && Math.random() < k.big
    ps.spawned++
    // 等待时长 = stay ×(大萝卜1.4)×(0.85+c*0.3)×(1−0.25×heat)
    const stay = k.stay * (big ? 1.4 : 1) * (0.85 + Math.random() * 0.3) * (1 - 0.25 * Math.min(1, this.t / 60))
    ps.carrot = {
      hole: holeIdx,
      big,
      need: NEED,
      pulls: 0,
      state: 'grow',
      t: 0,
      wait: 0,
      stay,
      hopFrom: 0,
      hopTo: 0,
      flyT: 0,
      alive: true,
    }
    ps.lastHole = holeIdx
    // 石头：独立 roll，洞位避开萝卜洞；萝卜换了洞时 0.7 概率把石头放在「上个萝卜位」（旧萝卜位诱饵）
    let stoneSpawned = false
    if (!first && Math.random() < k.stone && !ps.stone) {
      const s = Math.random()
      let sHole: number
      if (holeIdx !== prevHole && s < 0.7) sHole = prevHole
      else {
        const rest = [0, 1, 2].filter((h) => h !== holeIdx && h !== prevHole)
        sHole = rest.length ? rest[Math.floor(Math.random() * rest.length)] : (holeIdx + 1) % HOLES
      }
      ps.stone = { hole: sHole, state: 'grow', t: 0, flyT: 0, x0: 0, y0: 0, vx: 0, vy: 0, alive: true }
      stoneSpawned = true
    }
    this.ctx.audio.play('pop', 0.55, 0.8) // 站点 sfx('appear') 等价代理
    if (big) this.ctx.speak('大萝卜！要拔三下哦。')
    else if (stoneSpawned) this.ctx.speak('石头不要拔哦。')
  }

  /** 最近洞：|玩家锚点−洞心| < gap×0.5（端洞向外侧放宽 0.85），否则 −1 */
  private nearestHole(b: Body, ly: ReturnType<PullCarrot['layout']>) {
    const x = (b.hipC.x * 0.6 + b.shoulderC.x * 0.4) * this.W
    let best = -1
    for (let h = 0; h < HOLES; h++) {
      const edge = (h === 0 && x < ly.holes[0]) || (h === HOLES - 1 && x > ly.holes[HOLES - 1])
      const th = ly.gap * (edge ? MATCH_EDGE_K : MATCH_K)
      if (Math.abs(x - ly.holes[h]) < th) best = h
    }
    return best
  }

  /** 抓取判定（报告 §2.3 X 函数）+ 拉拽/逃跑（§2.4） */
  private grabLogic(ps: PState, pi: number, b: Body, ly: ReturnType<PullCarrot['layout']>, dt: number) {
    const k = this.cfg
    const near = this.nearestHole(b, ly)
    const carrot = ps.carrot

    // 手低判定：任一有效手（lm15/16，vis 达标）y > min(髋, 膝均) − k.low×torso
    const hipY = b.hipC.y
    const kneeY = (b.lKnee.y + b.rKnee.y) / 2
    const lowLine = Math.min(hipY, kneeY) - k.low * b.scale
    const kneeLine = kneeY - HAND_KNEE_K * b.scale
    let handLow = false
    let handBend = false
    for (const [idx, hand] of [
      [15, b.lHand],
      [16, b.rHand],
    ] as const) {
      const lm = b.lm[idx]
      if (!lm || (lm.visibility ?? 1) < 0.5) continue
      if (hand.y > lowLine) handLow = true
      if (hand.y > kneeLine) handBend = true
    }
    const deep = ps.squat > k.squat

    // 弯腰教学：手够低但没蹲（squat<0.25）持续超 1.2s → 语音纠正
    if (handBend && ps.squat < STOOP_SQUAT) {
      ps.stoopT += dt
      if (ps.stoopT > STOOP_T) {
        ps.stoopT = 0
        this.ctx.speak('腿弯下来，蹲下去抓哦。')
      }
    } else {
      ps.stoopT = 0
    }

    // 逃跑（§2.4 Y）：ready 且没抓住也没站在洞上蹲着 → wait 累计，超 stay 跳洞
    if (carrot && carrot.state === 'ready') {
      const grabbed = ps.grab?.kind === 'carrot' && ps.grab.hole === carrot.hole
      const atHole = near === carrot.hole && ps.squat > AT_SQUAT
      if (!grabbed && !atHole) {
        carrot.wait += dt
        if (carrot.wait > carrot.stay) {
          const blocked = new Set<number>([carrot.hole])
          if (ps.stone && ps.stone.alive && ps.stone.state !== 'fly') blocked.add(ps.stone.hole)
          const opts = [0, 1, 2].filter((h) => !blocked.has(h))
          if (opts.length) {
            carrot.state = 'hop'
            carrot.t = 0
            carrot.hopFrom = ly.holes[carrot.hole]
            carrot.hole = opts[Math.floor(Math.random() * opts.length)]
            carrot.hopTo = ly.holes[carrot.hole]
            carrot.wait = 0
            this.ctx.audio.play('drop', 0.6, 0.7) // 站点 sfx('whoosh') 等价代理
            this.banner('萝卜跑啦，快追！', 1.2)
            this.ctx.speak('萝卜跑啦，快追！')
          }
        }
      }
    }

    if (!ps.grab) {
      // 未抓取：深蹲 + 手低 + 站在 ready 物品的洞上 → 抓住
      if (deep && handLow && near >= 0) {
        const cReady = carrot && carrot.state === 'ready' && carrot.hole === near
        const sReady = ps.stone && ps.stone.state === 'ready' && ps.stone.hole === near
        if (cReady) {
          ps.grab = { kind: 'carrot', hole: near }
          ps.heldAt = this.t
          this.ctx.audio.click() // 站点 sfx('click')
          this.ctx.speak('使劲站起来！')
        } else if (sReady) {
          ps.grab = { kind: 'stone', hole: near }
          ps.heldAt = this.t
          this.ctx.audio.play('drop', 0.7, 1.3) // 站点 sfx('wobble') 等价代理
        } else if (this.t - ps.emptyAt > EMPTY_GAP) {
          ps.emptyAt = this.t // 空抓：只记 finger 提示时刻，无惩罚
        }
      }
      return
    }

    // 已抓取（每帧检查）
    const g = ps.grab
    const stillReady =
      g.kind === 'carrot'
        ? Boolean(carrot && carrot.state === 'ready' && carrot.hole === g.hole)
        : Boolean(ps.stone && ps.stone.state === 'ready' && ps.stone.hole === g.hole)
    const far = Math.abs((b.hipC.x * 0.6 + b.shoulderC.x * 0.4) * this.W - ly.holes[g.hole]) > ly.gap * RELEASE_K
    if (!stillReady || far) {
      ps.grab = null // 脱手无惩罚
      return
    }
    if (deep) {
      ps.heldAt = this.t // 仍深蹲：握持计时刷新
      return
    }
    if (ps.squat < k.stand) {
      // 站直发力
      if (g.kind === 'carrot') this.pull(ps, pi, ly, g.hole)
      else this.stoneMistake(ps, ly, g.hole)
      ps.grab = null
      return
    }
    // 半蹲僵持超 window → 脱手滑落
    if (this.t - ps.heldAt > k.window) {
      ps.grab = null
      ps.slips++
      this.ctx.audio.play('drop', 0.7, 0.8) // 站点 sfx('boing',0.7) 等价代理
      if (!ps.slipVoice) {
        ps.slipVoice = true
        this.ctx.speak('蹲下再抓一次，站直就拔出来啦！')
      }
    }
  }

  /** 拉拽结算（报告 §2.4 q 函数）：每次 +1 分，满 need 拔出飞篮 */
  private pull(ps: PState, _pi: number, ly: ReturnType<PullCarrot['layout']>, hole: number) {
    const carrot = ps.carrot
    if (!carrot) return
    carrot.pulls++
    this.score++
    const hx = ly.holes[hole]
    this.say('+1', hx, ps.groundY - ly.r * 2.2, '#ffd54a', 30)
    if (carrot.pulls < carrot.need) {
      this.say('嘿哟！', hx, ps.groundY - ly.r * 3.1, '#ffb703', 34)
      this.ctx.audio.play('drop', 0.8, 0.8 + carrot.pulls * 0.15) // boing 音高 0.8+pulls*0.15
      this.shake(4, 0.22)
      this.particles.burst(hx, ps.groundY - ly.r * 0.7, '#b98a5a', 10, 220, 4) // 木屑
      return
    }
    // 拔出！飞篮 + 石头下沉
    ps.carrots++
    if (carrot.big) ps.bigs++
    carrot.state = 'fly'
    carrot.flyT = 0
    ps.nextAt = this.t + NEXT_CD
    if (ps.stone && ps.stone.alive && ps.stone.state === 'ready') {
      ps.stone.state = 'sink'
      ps.stone.t = 0
    }
    this.ctx.audio.pop() // 站点 sfx('pop')
    this.ctx.audio.play('score', 0.9, 1 + Math.min(0.4, ps.carrots * 0.02)) // chime 音高 1+min(0.4, carrots*0.02)
    this.shake(carrot.big ? 9 : 5, 0.3)
    this.particles.burst(hx, ps.groundY - ly.r, '#ffd54a', 16, 360, 5) // 星爆
    this.particles.burst(hx, ps.groundY - ly.r * 0.6, '#b98a5a', 12, 260, 4)
    // 站点 highlight(大?2:1.2)：场地高亮的等价代理 → 横幅 + 场地闪光计时
    this.banner(carrot.big ? '大萝卜！' : '拔出来啦！', carrot.big ? 1.4 : 0.9)
    if (carrot.big) this.ctx.audio.good()
    if (ps.carrots % 5 === 0) {
      const cheer = CHEERS[(Math.floor(ps.carrots / 5) - 1) % CHEERS.length]
      this.banner(cheer, 1.2)
      this.ctx.audio.good()
    }
    ps.mood = 'cheer'
    ps.moodT = 1.5
  }

  /** 误拔石头（报告 §2.5 J 函数）：不扣分，计入统计 */
  private stoneMistake(ps: PState, ly: ReturnType<PullCarrot['layout']>, hole: number) {
    const stone = ps.stone
    if (!stone) return
    ps.stones++
    ps.mood = 'no'
    ps.moodT = 1.5
    const sx = ly.holes[hole]
    stone.state = 'fly'
    stone.flyT = 0
    stone.x0 = sx
    stone.y0 = ps.groundY - ly.r * 0.5
    stone.vx = (Math.random() < 0.5 ? -1 : 1) * (150 + Math.random() * 150)
    stone.vy = -(380 + Math.random() * 160)
    this.ctx.audio.play('hit', 0.8) // 站点 sfx('thud') 等价代理
    this.ctx.audio.fail() // 站点 sfx('oops')
    this.shake(6, 0.3)
    this.particles.burst(sx, ps.groundY - ly.r * 0.5, '#9a9a9a', 12, 260, 4) // 灰色木屑
    this.say('✕', sx, ps.groundY - ly.r * 2.6, '#ff6b6b', 46)
    if (ps.stoneVoiceN < STONE_VOICE_MAX) {
      ps.stoneVoiceN++
      this.ctx.speak('哎呀，这是石头…')
    }
  }

  /** 状态动画推进 */
  private animate(ps: PState, pi: number, dt: number) {
    const ly = this.layout(ps, pi)
    const carrot = ps.carrot
    if (carrot) {
      if (carrot.state === 'grow') {
        carrot.t += dt
        if (carrot.t >= GROW) carrot.state = 'ready'
      } else if (carrot.state === 'hop') {
        carrot.t += dt
        carrot.hopTo = ly.holes[carrot.hole] // 洞位跟随场地
        if (carrot.t >= HOP) carrot.state = 'ready'
      } else if (carrot.state === 'fly') {
        carrot.flyT += dt
        if (carrot.flyT >= FLY) {
          carrot.alive = false
          ps.carrot = null
        }
      }
    }
    const stone = ps.stone
    if (stone) {
      if (stone.state === 'grow') {
        stone.t += dt
        if (stone.t >= GROW) stone.state = 'ready'
      } else if (stone.state === 'sink') {
        stone.t += dt
        if (stone.t >= HOP) {
          stone.alive = false
          ps.stone = null
        }
      } else if (stone.state === 'fly') {
        stone.flyT += dt
        if (stone.flyT > 1.6) {
          stone.alive = false
          ps.stone = null
        }
      }
    }
  }

  paint(c: CanvasRenderingContext2D) {
    c.save()
    if (this.shakeT > 0) {
      const amp = this.shakeMag * (this.shakeT / 0.3)
      c.translate(Math.sin(this.t * 71) * amp, Math.cos(this.t * 64) * amp * 0.6)
    }
    for (let pi = 0; pi < 2; pi++) {
      const ps = this.ps[pi]
      if (!ps.ready) continue
      this.paintField(c, ps, pi)
    }
    c.restore()

    if (this.bannerT > 0) {
      c.globalAlpha = Math.min(1, this.bannerT / 0.3)
      outlineTxt(c, this.bannerText, this.W / 2, this.H * 0.2, 52, '#ffd54a')
      c.globalAlpha = 1
    }
    txt(
      c,
      '挪到亮着的洞前，蹲下抓住叶子再站直拔出来；大萝卜要拔三下，石头别拔哦',
      this.W / 2,
      this.H - 30,
      20,
      'rgba(255,255,255,.8)',
      'center',
      'bold',
    )
  }

  private paintField(c: CanvasRenderingContext2D, ps: PState, pi: number) {
    const ly = this.layout(ps, pi)
    const z = this.zone(pi)
    const gy = ps.groundY
    // 土床
    c.save()
    const soil = c.createLinearGradient(0, gy - ly.r * 0.5, 0, this.H)
    soil.addColorStop(0, '#8a5a33')
    soil.addColorStop(1, '#5d3a1e')
    c.fillStyle = soil
    rr(c, z.x0 + 8, gy - ly.r * 0.42, z.x1 - z.x0 - 16, this.H - gy + ly.r * 0.42, 26)
    c.fill()
    c.fillStyle = 'rgba(255,255,255,.12)'
    rr(c, z.x0 + 20, gy - ly.r * 0.3, z.x1 - z.x0 - 40, 6, 3)
    c.fill()
    c.restore()

    // 洞口
    for (const hx of ly.holes) {
      c.beginPath()
      c.ellipse(hx, gy, ly.r, ly.r * 0.3, 0, 0, Math.PI * 2)
      c.fillStyle = '#3a2413'
      c.fill()
      c.strokeStyle = 'rgba(0,0,0,.28)'
      c.lineWidth = 3
      c.stroke()
    }

    // 发亮待拔萝卜的黄色高亮椭圆（脉动 1+sin(t*6)*0.06）
    const carrot = ps.carrot
    if (carrot && carrot.state === 'ready') {
      const hx = ly.holes[carrot.hole]
      const pulse = 1 + Math.sin(this.t * 6) * 0.06
      c.save()
      c.globalAlpha = 0.4
      c.beginPath()
      c.ellipse(hx, gy, ly.r * 1.25 * pulse, ly.r * 0.42 * pulse, 0, 0, Math.PI * 2)
      c.fillStyle = '#ffd54a'
      c.fill()
      c.restore()
    }

    // 石头（在萝卜之后画，压住洞口）
    this.paintStone(c, ps, ly, gy)

    // 萝卜本体（飞篮动画画在最后，压在最上）
    this.paintCarrotLive(c, ps, pi, ly, gy)

    // 篮子
    const bx = clamp(z.x1 - ly.r * 0.9, z.x0 + ly.r, this.W - 30)
    this.paintBasket(c, ps, bx, gy, ly.r)

    // 兔子教练
    this.paintRabbit(c, ps, pi, ly, gy)

    // 空抓后的手指提示（变大指向正确洞）
    if (this.t - ps.emptyAt < 1.2 && carrot && carrot.state === 'ready' && this.players[pi].body) {
      const k = (this.t - ps.emptyAt) / 1.2
      const px = this.players[pi].body!.shoulderC.x * this.W
      const py = (this.players[pi].body!.shoulderC.y - 0.16) * this.H
      const size = 34 + 20 * k
      const toRight = ly.holes[carrot.hole] >= px
      c.save()
      c.translate(px + (toRight ? 52 : -52), py)
      if (!toRight) c.scale(-1, 1)
      c.globalAlpha = 0.9
      emoji(c, '👉', 0, 0, size)
      c.restore()
    }
  }

  private paintCarrot(c: CanvasRenderingContext2D, x: number, y: number, r: number, big: boolean, opts: { grow?: number; wiggle?: boolean; flyK?: number }) {
    const s = (big ? 1.55 : 1) * (opts.grow !== undefined ? outBack(opts.grow) : 1)
    c.save()
    c.translate(x, y)
    if (opts.flyK !== undefined) c.rotate(opts.flyK * 6)
    if (opts.wiggle) c.rotate(Math.sin(this.t * 32) * 0.09)
    c.scale(s, s)
    // 萝卜身：橙色圆锥
    const body = c.createLinearGradient(-r * 0.5, 0, r * 0.5, 0)
    body.addColorStop(0, '#ff9f43')
    body.addColorStop(1, '#e8710a')
    c.beginPath()
    c.moveTo(0, r * 0.9)
    c.quadraticCurveTo(-r * 0.62, r * 0.2, -r * 0.42, -r * 0.5)
    c.quadraticCurveTo(0, -r * 0.78, r * 0.42, -r * 0.5)
    c.quadraticCurveTo(r * 0.62, r * 0.2, 0, r * 0.9)
    c.fillStyle = body
    c.fill()
    // 叶子
    for (const [dx, ang] of [
      [-0.4, -0.5],
      [0, 0],
      [0.4, 0.5],
    ] as const) {
      c.save()
      c.translate(dx * r * 0.5, -r * 0.72)
      c.rotate(ang)
      c.beginPath()
      c.ellipse(0, -r * 0.3, r * 0.16, r * 0.42, 0, 0, Math.PI * 2)
      c.fillStyle = '#3ddc6e'
      c.fill()
      c.restore()
    }
    // 眼睛（大萝卜有脸）
    if (big) {
      c.fillStyle = '#5d3a1e'
      c.beginPath()
      c.arc(-r * 0.16, -r * 0.14, r * 0.06, 0, Math.PI * 2)
      c.arc(r * 0.16, -r * 0.14, r * 0.06, 0, Math.PI * 2)
      c.fill()
      c.strokeStyle = '#5d3a1e'
      c.lineWidth = r * 0.05
      c.beginPath()
      c.arc(0, -r * 0.02, r * 0.12, 0.15 * Math.PI, 0.85 * Math.PI)
      c.stroke()
    }
    c.restore()
  }

  private paintStone(c: CanvasRenderingContext2D, ps: PState, ly: ReturnType<PullCarrot['layout']>, gy: number) {
    const stone = ps.stone
    if (!stone) return
    let x = ly.holes[stone.hole]
    let y = gy - ly.r * 0.28
    let alpha = 1
    let growK: number | undefined
    let shakeX = 0
    if (stone.state === 'grow') growK = stone.t / GROW
    else if (stone.state === 'sink') {
      const k = clamp(stone.t / HOP, 0, 1)
      y += k * ly.r * 0.7
      alpha = 1 - k
    } else if (stone.state === 'fly') {
      const t = stone.flyT
      x = stone.x0 + stone.vx * t
      y = stone.y0 + stone.vy * t + 450 * t * t
      alpha = clamp(1.6 - t, 0, 1)
    }
    if (ps.grab?.kind === 'stone' && ps.grab.hole === stone.hole) shakeX = Math.sin(this.t * 40) * 3 // angry 抖动
    const r = ly.r * 0.72
    c.save()
    c.globalAlpha = alpha
    c.translate(x + shakeX, y)
    if (growK !== undefined) c.scale(outBack(growK), outBack(growK))
    const g = c.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.1, 0, 0, r)
    g.addColorStop(0, '#a8a8b4')
    g.addColorStop(1, '#6b6b78')
    c.beginPath()
    c.ellipse(0, 0, r, r * 0.8, 0, 0, Math.PI * 2)
    c.fillStyle = g
    c.fill()
    // 睡脸 / 被抓时的 angry 脸
    const angry = ps.grab?.kind === 'stone' && ps.grab.hole === stone.hole
    c.strokeStyle = '#3c3c48'
    c.lineWidth = r * 0.09
    if (angry) {
      c.beginPath()
      c.moveTo(-r * 0.34, -r * 0.2)
      c.lineTo(-r * 0.12, -r * 0.08)
      c.moveTo(r * 0.34, -r * 0.2)
      c.lineTo(r * 0.12, -r * 0.08)
      c.stroke()
      c.beginPath()
      c.arc(0, r * 0.22, r * 0.16, Math.PI * 1.15, Math.PI * 1.85)
      c.stroke()
    } else {
      c.beginPath()
      c.arc(-r * 0.22, -r * 0.1, r * 0.07, 0, Math.PI * 2)
      c.arc(r * 0.22, -r * 0.1, r * 0.07, 0, Math.PI * 2)
      c.fillStyle = '#3c3c48'
      c.fill()
    }
    c.restore()
  }

  private paintBasket(c: CanvasRenderingContext2D, ps: PState, bx: number, gy: number, r: number) {
    const bw = r * 1.9
    const bh = r * 1.3
    const by = gy - bh * 0.4
    // 堆叠的小萝卜（最多 16 个，A 表 16 坐标位的等价网格）
    const n = Math.min(16, ps.carrots)
    for (let i = 0; i < n; i++) {
      const col = i % 4
      const row = Math.floor(i / 4)
      const cx = bx - bw * 0.3 + col * (bw * 0.2)
      const cy = by - bh * 0.3 - row * r * 0.34
      c.save()
      c.translate(cx, cy)
      c.rotate((i % 2 ? 1 : -1) * 0.3)
      c.beginPath()
      c.moveTo(0, r * 0.2)
      c.quadraticCurveTo(-r * 0.14, 0, 0, -r * 0.2)
      c.quadraticCurveTo(r * 0.14, 0, 0, r * 0.2)
      c.fillStyle = '#ff9f43'
      c.fill()
      c.restore()
    }
    // 篮身
    c.save()
    const g = c.createLinearGradient(0, by - bh / 2, 0, by + bh / 2)
    g.addColorStop(0, '#b98a5a')
    g.addColorStop(1, '#8a5a33')
    c.fillStyle = g
    rr(c, bx - bw / 2, by - bh / 2, bw, bh, 12)
    c.fill()
    c.strokeStyle = 'rgba(0,0,0,.25)'
    c.lineWidth = 3
    for (let i = 1; i < 4; i++) {
      c.beginPath()
      c.moveTo(bx - bw / 2 + (bw / 4) * i, by - bh / 2 + 4)
      c.lineTo(bx - bw / 2 + (bw / 4) * i, by + bh / 2 - 4)
      c.stroke()
    }
    c.restore()
    outlineTxt(c, String(ps.carrots), bx, by, 30, '#fff')
  }

  /** 兔子教练：idle / cheer / no 反应 + 抓握时举双手 */
  private paintRabbit(c: CanvasRenderingContext2D, ps: PState, pi: number, ly: ReturnType<PullCarrot['layout']>, gy: number) {
    const z = this.zone(pi)
    const rx = clamp(z.x0 + ly.r * 0.6, 20, this.W - 20)
    const ry = gy - ps.torso * 0.92
    const r = Math.max(20, ly.r * 0.55)
    const grabUp = Boolean(ps.grab)
    c.save()
    c.translate(rx, ry)
    // 耳朵
    for (const s of [-1, 1]) {
      c.beginPath()
      c.ellipse(s * r * 0.42, -r * 1.5, r * 0.2, r * 0.62, s * 0.18, 0, Math.PI * 2)
      c.fillStyle = '#f6f2ec'
      c.fill()
      c.beginPath()
      c.ellipse(s * r * 0.42, -r * 1.5, r * 0.09, r * 0.36, s * 0.18, 0, Math.PI * 2)
      c.fillStyle = '#ffc9d4'
      c.fill()
    }
    // 头
    c.beginPath()
    c.arc(0, 0, r, 0, Math.PI * 2)
    c.fillStyle = '#f6f2ec'
    c.fill()
    // 举双手（抓握时）
    if (grabUp) {
      c.strokeStyle = '#f6f2ec'
      c.lineWidth = r * 0.28
      c.lineCap = 'round'
      for (const s of [-1, 1]) {
        c.beginPath()
        c.moveTo(s * r * 0.7, r * 0.3)
        c.lineTo(s * r * 1.2, -r * 0.5)
        c.stroke()
        circle(c, s * r * 1.2, -r * 0.55, r * 0.18, '#f6f2ec')
      }
    }
    // 表情
    c.strokeStyle = '#4a3b32'
    c.fillStyle = '#4a3b32'
    c.lineWidth = Math.max(2, r * 0.08)
    if (ps.mood === 'no') {
      // ✕✕ 眼
      for (const s of [-1, 1]) {
        c.beginPath()
        c.moveTo(s * r * 0.42 - r * 0.1, -r * 0.2)
        c.lineTo(s * r * 0.42 + r * 0.1, 0)
        c.moveTo(s * r * 0.42 + r * 0.1, -r * 0.2)
        c.lineTo(s * r * 0.42 - r * 0.1, 0)
        c.stroke()
      }
      c.beginPath()
      c.arc(0, r * 0.34, r * 0.12, Math.PI, Math.PI * 2)
      c.stroke()
    } else if (ps.mood === 'cheer') {
      for (const s of [-1, 1]) {
        c.beginPath()
        c.arc(s * r * 0.4, -r * 0.12, r * 0.16, Math.PI * 1.1, Math.PI * 1.9)
        c.stroke()
      }
      c.beginPath()
      c.arc(0, r * 0.2, r * 0.2, 0, Math.PI)
      c.fill()
    } else {
      c.beginPath()
      c.arc(-r * 0.34, -r * 0.12, r * 0.09, 0, Math.PI * 2)
      c.arc(r * 0.34, -r * 0.12, r * 0.09, 0, Math.PI * 2)
      c.fill()
      c.beginPath()
      c.arc(0, r * 0.16, r * 0.1, 0.2 * Math.PI, 0.8 * Math.PI)
      c.stroke()
    }
    c.restore()
    // 弯腰教学小字
    if (ps.stoopT > 0.35 && this.players[pi].body) {
      const b = this.players[pi].body!
      outlineTxt(c, '腿弯下来，蹲下去抓哦', b.shoulderC.x * this.W, (b.shoulderC.y - 0.2) * this.H, 26, '#ffb703')
    }
  }

  /** 萝卜本体：洞口上方，含生长弹出 / 抓握抖动 / 跳洞抛物线 / 飞篮弧线 / 大萝卜进度点 */
  private paintCarrotLive(c: CanvasRenderingContext2D, ps: PState, pi: number, ly: ReturnType<PullCarrot['layout']>, gy: number) {
    const carrot = ps.carrot
    if (!carrot) return
    const grabbed = ps.grab?.kind === 'carrot' && ps.grab.hole === carrot.hole
    if (carrot.state === 'fly') {
      // 二次曲线飞向篮子（0.75s，源码 E）
      const z = this.zone(pi)
      const bx = clamp(z.x1 - ly.r * 0.9, z.x0 + ly.r, this.W - 30)
      const k = clamp(carrot.flyT / FLY, 0, 1)
      const x0 = ly.holes[carrot.hole]
      const y0 = gy - ly.r * 0.6
      const x1 = bx
      const y1 = gy - ly.r * 1.7
      const mx = (x0 + x1) / 2
      const my = Math.min(y0, y1) - ly.r * 1.4
      const xx = (1 - k) * (1 - k) * x0 + 2 * (1 - k) * k * mx + k * k * x1
      const yy = (1 - k) * (1 - k) * y0 + 2 * (1 - k) * k * my + k * k * y1
      glow(c, xx, yy, ly.r * 1.3, '#ffd54a', 0.35)
      this.paintCarrot(c, xx, yy, ly.r * 0.6, carrot.big, { flyK: k })
      return
    }
    if (carrot.state === 'hop') {
      const k = clamp(carrot.t / HOP, 0, 1)
      const xx = carrot.hopFrom + (carrot.hopTo - carrot.hopFrom) * k
      const yy = gy - ly.r * 0.6 - Math.sin(Math.PI * k) * ly.gap * 0.5
      this.paintCarrot(c, xx, yy, ly.r * 0.6, carrot.big, { grow: 1 })
      return
    }
    const hx = ly.holes[carrot.hole]
    const growK = carrot.state === 'grow' ? carrot.t / GROW : undefined
    this.paintCarrot(c, hx, gy - ly.r * 0.6, ly.r * 0.6, carrot.big, { grow: growK, wiggle: grabbed })
    // 大萝卜进度点：已拉橙色 / 未拉白色
    if (carrot.big && carrot.state !== 'grow') {
      for (let i = 0; i < carrot.need; i++) {
        circle(c, hx - ly.r * 0.36 + i * ly.r * 0.36, gy - ly.r * 1.9, 5, i < carrot.pulls ? '#ff9f43' : '#fff')
      }
    }
    // 抓握提示：站直就拔出来啦（大萝卜显示）
    if (grabbed && carrot.big) outlineTxt(c, '站起来！', hx, gy - ly.r * 2.4, 26, '#ffb703')
  }
}

export default function create(ctx: GameContext) {
  return new PullCarrot(ctx)
}
