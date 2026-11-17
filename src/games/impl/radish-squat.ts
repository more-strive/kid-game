import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, emoji, outlineTxt, rr, txt } from '@/core/draw'

/**
 * 萝卜蹲（对齐 dongdongpark radish-squat 真实规则，逆向报告 _reverse/reports/radish-squat.md）：
 * 玩家被分到一个颜色的萝卜位（其余为 AI 萝卜），兔主持人喊「X萝卜蹲，X萝卜蹲，X萝卜蹲完Y萝卜蹲」；
 * 被喊到的颜色要在 3 个「蹲」节拍上各蹲一次（每次 +1 分）；没被喊到却蹲了算上当；
 * 该蹲不蹲算错过；hard 会中途喊「换颜色！」交换身份。
 * 站点框架黑盒量（注释注明）：
 * - motion.squat 归一蹲深 → 1−(踝中y−髋中y)/(0.45×肩踝距)（与 counter-kit 同标尺）
 * - 站点分大屏(big)/手机两套阈值，本工程按手机版：蹲深 0.3 / 判定窗尾 +0.4 / 上当持续 0.3s / 上当不扣分
 * - heat（框架热度）→ min(1, t/60) 线性升温代理
 * - AI 萝卜为程序性动画（不参与计分），行为哈希照抄站点 noise 函数
 */

/** 难度表（报告 §1 字面量）：萝卜位数/节拍基础秒/节拍下限/喊到人类的概率[单人,双人]/是否换颜色 */
const DIFF = [
  { count: 3, beat: 1.15, fast: 0.9, mine: [0.7, 0.8], swap: false },
  { count: 4, beat: 1.0, fast: 0.75, mine: [0.65, 0.8], swap: false },
  { count: 5, beat: 0.88, fast: 0.66, mine: [0.65, 0.8], swap: true },
]
const E_DUO_STAY = 0.5 // 双人：当前喊的是人类 → 下句仍喊人类的概率
const SQUAT_DEEP = 0.3 // 手机版有效蹲深阈值（大屏 0.45，本工程按手机版）
const UP_K = 0.25 // 站起判定基准偏移 k
const BASE_DECAY = 0.02 // 蹲基线衰减 ee（0.02/s，防长期半蹲）
const FOOLED_HOLD = 0.3 // 上当判定的持续蹲时长（手机 0.3 / 大屏 0.15）
const WIN_TAIL = 0.4 // 每个蹲拍判定窗尾部延长（手机 0.4 / 大屏 0.2）
const DUN_AT = 0.72 // 每拍「蹲」字落点偏移 A
const SWAP_REST = 2.3 // 换颜色后的休整 ae
const TEACH_REST = 2 // 教学提示后的休整 oe
const FIRST_CALL = 3.2 // 开局到第一句喊话 se
const WHITE_IDX = 4 // 白萝卜位特殊高亮为黄色 j
const PHRASE_LEN = 4.35 // 一句喊话总长（拍）
const SAFE_T = 0.4 // 结算后上当保护秒数
const EARLY_LEAD = 0.3 // 抢跑：预告拍提前 0.3 拍
const MAX_SWAPS = 8 // 换色次数上限
const GROUND_Y = 0.8 // 萝卜排的地面高度（屏幕比例）

const COLORS: { name: string; c: string }[] = [
  { name: '红', c: '#ff5c5c' },
  { name: '黄', c: '#ffd54a' },
  { name: '绿', c: '#3ddc97' },
  { name: '紫', c: '#a78bfa' },
  { name: '白', c: '#f4f4f8' },
  { name: '蓝', c: '#4cc9f0' },
]

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v))
}

/** 站点 noise 哈希（源码 k 函数，AI 行为用） */
function noise(x: number) {
  const v = Math.sin(x * 127.1 + 311.7) * 43758.5453
  return v - Math.floor(v)
}

/** 站点 motion.squat 的等价代理（见文件头注释） */
function squatMetric(b: Body) {
  const ankleY = (b.lm[27].y + b.lm[28].y) / 2
  const shY = (b.lm[11].y + b.lm[12].y) / 2
  const span = Math.max(0.06, Math.abs(ankleY - shY))
  return clamp(1 - Math.max(0, ankleY - b.hipC.y) / (0.45 * span), 0, 1)
}

/** 人类玩家的蹲下感知（报告 §2.2）：基线衰减 + 站起/有效蹲状态机 */
class SquatSense {
  base = 0
  up = false
  vis = 0 // 平滑蹲深（画压缩用）
  /** 返回本帧是否完成一次「有效蹲」事件 */
  update(b: Body, dt: number) {
    const sq = squatMetric(b)
    this.vis += (sq - this.vis) * Math.min(1, dt * 8)
    this.base = Math.min(this.base + BASE_DECAY * dt, sq)
    if (sq < Math.max(UP_K, this.base + 0.1)) this.up = true
    const th = Math.max(SQUAT_DEEP, Math.min(0.45, this.base + 0.25))
    let dun = false
    if (this.up && sq > th) {
      dun = true
      this.up = false
    }
    return { sq, th, dun }
  }
}

interface AiSquat {
  pos: number
  start: number
  dur: number
}

interface Phrase {
  idx: number // 被喊的萝卜位
  next: number // 下一位预告
  startT: number
  beat: number
  hits: boolean[] // 被喊人类玩家 3 个蹲拍是否已中
  dunDone: boolean[] // 4 个节拍点是否已播
  fooled: boolean[] // 每玩家本句是否已上当
  early: boolean // 预告抢蹲是否已用
  earlyBy: number // 抢蹲玩家（下一句 hits[0] 直接置中）
  ai: AiSquat[]
  pulse: { t: number; x: number; y: number }[] // 蹲拍光环
}

interface HumanState {
  sense: SquatSense
  combo: number
  fooled: number
  fooledUntil: number // 头顶转星星剩余
  hold: number // 持续蹲计时（上当判定）
}

class RadishSquat extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  score = 0
  missed = 0
  bestCombo = 0
  reacts: number[] = []
  /** 萝卜位（延迟到首帧按在场上人数搭建）：{color 池索引, human -1|0|1} */
  pos: { color: number; human: number }[] = []
  built = false
  humans: HumanState[] = [
    { sense: new SquatSense(), combo: 0, fooled: 0, fooledUntil: 0, hold: 0 },
    { sense: new SquatSense(), combo: 0, fooled: 0, fooledUntil: 0, hold: 0 },
  ]
  phrase: Phrase | null = null
  phraseSeq = 0
  queued = -1 // 上一句预告的下一位
  calledWasHuman = false
  nextCallAt = FIRST_CALL
  safeUntil = 0
  phraseCount = 0
  nextSwapAt = 4 + Math.floor(Math.random() * 3) // 首个换色句数 ∈[4,6]
  swaps = 0
  taughtFooled = false
  taughtMiss = false
  teachRest = false
  bannerText = ''
  bannerSub = ''
  bannerT = 0
  swapFlashT = 0

  private buildPositions() {
    const duo = this.players.filter((p) => p.body).length > 1
    const R = this.cfg.count + (duo ? 1 : 0)
    const pool = [0, 1, 2, 3, 4, 5].sort(() => Math.random() - 0.5)
    this.pos = []
    for (let i = 0; i < R; i++) this.pos.push({ color: pool[i], human: -1 })
    // 单人：随机分色（占最左位）；双人：左右分色（占两端）
    if (duo) {
      this.pos[0].human = 0
      this.pos[R - 1].human = 1
    } else {
      this.pos[0].human = 0
    }
    this.built = true
    const name0 = this.colorName(this.pos[0].color)
    if (duo) {
      const name1 = this.colorName(this.pos[R - 1].color)
      this.ctx.speak(`左边的小朋友是${name0}萝卜，右边的小朋友是${name1}萝卜！叫到你就蹲一下。`)
    } else {
      this.ctx.speak(`你是${name0}萝卜！叫到${name0}萝卜，就蹲一下。`)
    }
  }

  private colorName(ci: number) {
    return COLORS[ci]?.name ?? '红'
  }

  private colorHex(ci: number) {
    return COLORS[ci]?.c ?? '#ff5c5c'
  }

  private posOf(human: number) {
    return this.pos.findIndex((p) => p.human === human)
  }

  /** 喊话目标选择（报告 §2.6 ke）：候选=全部位−当前被喊位，按人类概率选类后组内均匀 */
  private pickCalled(current: number) {
    const cands = this.pos.map((_, i) => i).filter((i) => i !== current)
    const hu = cands.filter((i) => this.pos[i].human >= 0)
    const ai = cands.filter((i) => this.pos[i].human < 0)
    const duo = this.players.filter((p) => p.body).length > 1
    if (hu.length && ai.length) {
      const pHuman = this.calledWasHuman ? E_DUO_STAY : this.cfg.mine[duo ? 1 : 0]
      const wantHuman = Math.random() < pHuman
      const list = wantHuman ? hu : ai
      return list[Math.floor(Math.random() * list.length)]
    }
    if (hu.length) return hu[Math.floor(Math.random() * hu.length)]
    return ai[Math.floor(Math.random() * ai.length)]
  }

  /** 开新句（双人第一句必喊玩家 2 的颜色） */
  private beginPhrase() {
    let idx: number
    if (this.phraseSeq === 0) {
      const duo = this.players.filter((p) => p.body).length > 1
      idx = duo ? this.posOf(1) : this.pickCalled(-1)
      if (idx < 0) idx = this.pickCalled(-1)
    } else {
      idx = this.queued >= 0 ? this.queued : this.pickCalled(-1)
    }
    this.queued = -1
    this.calledWasHuman = this.pos[idx].human >= 0
    const next = this.pickCalled(idx)
    const heat = Math.min(1, this.t / 60)
    const beat = this.cfg.beat + (this.cfg.fast - this.cfg.beat) * heat
    const startT = Math.max(this.t, this.nextCallAt)
    const ph: Phrase = {
      idx,
      next,
      startT,
      beat,
      hits: [false, false, false],
      dunDone: [false, false, false, false],
      fooled: this.pos.map(() => false),
      early: false,
      earlyBy: -1,
      ai: [],
      pulse: [],
    }
    // 上一句被预告抢蹲的玩家：本句第 1 拍直接置已中（分数已计）
    if (this.lastEarlyBy >= 0 && this.pos[idx]?.human === this.lastEarlyBy) ph.hits[0] = true
    this.lastEarlyBy = -1
    // AI 程序性动作（纯视觉，报告 §7）：被喊 12% 漏 / 8% 迟到 0.8 拍 / 其余 P−0.08~+0.17s 起蹲
    const P = (t: number) => startT + (t + DUN_AT) * beat
    for (let p = 0; p < this.pos.length; p++) {
      if (this.pos[p].human >= 0) continue
      if (p === idx) {
        for (let t = 0; t < 3; t++) {
          const r = noise(p * 97 + this.phraseSeq * 131 + t * 7 + 0.5)
          if (r >= 0.88) continue // 12% 漏蹲
          const late = r >= 0.8 ? 0.8 * beat : -0.08 + noise(p + t * 3.7) * 0.25
          ph.ai.push({ pos: p, start: P(t) + late, dur: Math.min(0.42, beat * 0.5) })
        }
      } else if (p === next) {
        if (noise(p * 13 + this.phraseSeq * 7) < 0.5) ph.ai.push({ pos: p, start: P(3) + 0.05, dur: 0.4 })
      } else if (noise(p * 29 + this.phraseSeq * 17) < 0.1) {
        // 10% 在别人喊话第 1 拍窗口乱蹲（当众上当示范）
        ph.ai.push({ pos: p, start: P(1) + noise(p + 0.3) * 0.3, dur: 0.45 })
      }
    }
    this.phrase = ph
    this.phraseSeq++
    const n1 = this.colorName(this.pos[idx].color)
    const n2 = this.colorName(this.pos[next].color)
    this.ctx.speak(`${n1}萝卜蹲，${n1}萝卜蹲，${n1}萝卜蹲完${n2}萝卜蹲`)
  }

  lastEarlyBy = -1

  /** 第 t 蹲拍命中（报告 §2.3 Ne） */
  private onHit(hi: number, ph: Phrase, t: number, now: number) {
    this.score++
    this.humans[hi].combo++
    this.bestCombo = Math.max(this.bestCombo, this.humans[hi].combo)
    this.reacts.push(now - (ph.startT + (t + DUN_AT) * ph.beat))
    this.ctx.audio.pop()
    const px = this.posX(this.pos.findIndex((p) => p.human === hi))
    this.particles.burst(px, this.posY() - 60, '#ffd54a', 8, 300, 5)
  }

  private posX(i: number) {
    const R = this.pos.length
    return this.W * (0.1 + (0.8 * i) / Math.max(1, R - 1))
  }

  private posY() {
    return this.H * GROUND_Y
  }

  /** 上当判定（报告 §2.4 Pe） */
  private checkFooled(hi: number, ph: Phrase, now: number, l: boolean, dt: number) {
    const h = this.humans[hi]
    const hp = this.posOf(hi)
    if (hp < 0 || hp === ph.idx || hp === ph.next || now < this.safeUntil) {
      h.hold = 0
      return
    }
    h.hold = l ? h.hold + dt : 0
    if (h.hold >= FOOLED_HOLD && !ph.fooled[hi]) {
      ph.fooled[hi] = true
      h.fooled++
      h.combo = 0
      h.fooledUntil = 1.5
      this.ctx.audio.fail() // 站点 sfx('oops')
      this.shake(3, 0.25)
      const b = this.players[hi].body
      if (b) this.say('上当啦！', b.shoulderC.x * this.W, (b.shoulderC.y - 0.18) * this.H, '#ff8a8a', 36)
      if (!this.taughtFooled) {
        this.taughtFooled = true
        this.teachRest = true
        this.ctx.speak('没叫到你，可别蹲哦')
      }
    }
  }

  /** 结算（报告 §2.5 Me）+ 换颜色（hard） */
  private resolvePhrase(ph: Phrase) {
    const now = ph.startT + PHRASE_LEN * ph.beat
    const hi = this.pos[ph.idx].human
    if (hi >= 0) {
      const got = ph.hits.filter(Boolean).length
      this.missed += 3 - got
      this.safeUntil = now + SAFE_T
      if (got === 3) {
        // 站点 highlight(2)：场地高亮的等价代理 → 金色横幅 + 撒星
        this.banner('三连蹲，漂亮！', 1)
        this.ctx.audio.good()
        this.particles.burst(this.posX(ph.idx), this.posY() - 80, '#ffd54a', 14, 340, 5)
      } else if (got === 0 && this.players[hi].body) {
        const b = this.players[hi].body!
        this.say('该你蹲啦', b.shoulderC.x * this.W, (b.shoulderC.y - 0.2) * this.H, '#ffb703', 34)
        if (!this.taughtMiss) {
          this.taughtMiss = true
          this.teachRest = true
          this.ctx.speak(`叫到${this.colorName(this.pos[ph.idx].color)}萝卜，你就蹲一下`)
        }
      }
    }
    // 换颜色（hard 专属）：每 4~6 句一次，最多 8 次
    this.phraseCount++
    let gap = 0
    if (this.teachRest) {
      gap = TEACH_REST
      this.teachRest = false
    }
    if (this.cfg.swap && this.phraseCount >= this.nextSwapAt && this.swaps < MAX_SWAPS) {
      this.swaps++
      this.nextSwapAt += 4 + Math.floor(Math.random() * 3)
      this.doSwap()
      gap = SWAP_REST
    }
    this.queued = ph.next
    this.nextCallAt = now + gap
    this.phrase = null
  }

  private doSwap() {
    const duo = this.players.filter((p) => p.body).length > 1
    this.ctx.audio.combo() // 站点 sfx('sparkle') 等价代理
    this.swapFlashT = 1
    if (duo) {
      const a = this.posOf(0)
      const b = this.posOf(1)
      if (a >= 0 && b >= 0) {
        this.pos[a].human = 1
        this.pos[b].human = 0
      }
      this.banner('换颜色！两个人换一换！', 1.4)
      this.ctx.speak('换颜色！两个人换一换！')
    } else {
      const old = this.posOf(0)
      const opts = this.pos.map((_, i) => i).filter((i) => i !== old)
      if (old >= 0 && opts.length) {
        this.pos[old].human = -1
        this.pos[opts[Math.floor(Math.random() * opts.length)]].human = 0
      }
      const np = this.posOf(0)
      this.banner(`换颜色！你是${this.colorName(this.pos[np]?.color ?? 0)}萝卜！`, 1.4)
      this.ctx.speak(`换颜色！你是${this.colorName(this.pos[np]?.color ?? 0)}萝卜！`)
    }
    // 换色瞬间全体 early/hold 复位
    this.lastEarlyBy = -1
    for (const h of this.humans) h.hold = 0
    if (this.phrase) this.phrase.early = false
  }

  private banner(text: string, sec: number, sub = '') {
    this.bannerText = text
    this.bannerSub = sub
    this.bannerT = sec
  }

  private shakeT = 0
  private shakeMag = 0

  private shake(mag: number, sec: number) {
    this.shakeMag = mag
    this.shakeT = sec
  }

  tick(f: PoseFrame, dt: number) {
    if (!this.built && (this.players.some((p) => p.body) || this.t > 2)) this.buildPositions()
    this.bannerT = Math.max(0, this.bannerT - dt)
    this.shakeT = Math.max(0, this.shakeT - dt)
    this.swapFlashT = Math.max(0, this.swapFlashT - dt)
    if (!this.built) return
    const timeLeft = this.ctx.hud().timeLeft

    // 开新句（timeLeft > 1.5s 才继续喊）
    if (!this.phrase && this.t >= this.nextCallAt && timeLeft > 1.5) this.beginPhrase()

    const ph = this.phrase
    const now = this.t
    // 人类蹲下感知
    for (let hi = 0; hi < 2; hi++) {
      const b = f.bodies[hi]
      const h = this.humans[hi]
      if (!b) {
        h.hold = 0
        h.sense.vis += (0 - h.sense.vis) * Math.min(1, dt * 4)
        continue
      }
      const r = h.sense.update(b, dt)
      if (h.fooledUntil > 0) h.fooledUntil -= dt
      if (!ph) continue
      const P = (t: number) => ph.startT + (t + DUN_AT) * ph.beat
      // 判定窗：第 t 拍 (P−0.5beat, P+0.5beat+0.4]，第 0 拍左端 −∞（可抢第 1 蹲）
      const hp = this.posOf(hi)
      if (hp === ph.idx) {
        for (let t = 0; t < 3; t++) {
          if (ph.hits[t]) continue
          const lo = t === 0 ? -Infinity : P(t) - 0.5 * ph.beat
          const hiT = P(t) + 0.5 * ph.beat + WIN_TAIL
          if (r.dun && now >= lo && now <= hiT) {
            ph.hits[t] = true
            this.onHit(hi, ph, t, now)
          }
        }
      } else if (hp === ph.next) {
        // 抢跑：预告拍提前 0.3 拍内的有效蹲 → 预支下一句第 1 蹲
        if (!ph.early && r.dun && now > P(3) - EARLY_LEAD * ph.beat) {
          ph.early = true
          ph.earlyBy = hi
          this.lastEarlyBy = hi
          this.onHit(hi, ph, 3, now)
        }
      }
      this.checkFooled(hi, ph, now, r.sq > r.th, dt)
    }
    if (ph) {
      // 节拍点：每蹲拍 drum + 「蹲！」大字 + 光环；第 4 拍 tick（下一位预告）
      for (let t = 0; t < 4; t++) {
        const at = ph.startT + (t + DUN_AT) * ph.beat
        if (!ph.dunDone[t] && now >= at) {
          ph.dunDone[t] = true
          if (t < 3) {
            this.ctx.audio.play('tick', 0.45) // 站点 sfx('drum', 0.45)
            const x = this.posX(ph.idx)
            const y = this.posY()
            ph.pulse.push({ t: now, x, y })
            this.say('蹲！', x, y - 170, this.colorHex(this.pos[ph.idx].color), 44)
          } else {
            this.ctx.audio.tick() // 站点 sfx('tick')
          }
        }
      }
      if (now >= ph.startT + PHRASE_LEN * ph.beat) this.resolvePhrase(ph)
    }

    this.ctx.setScore(this.score)
    this.ctx.setCombo(Math.max(this.humans[0].combo, this.humans[1].combo))
    this.ctx.setExtra('上当', this.humans[0].fooled + this.humans[1].fooled)
    this.ctx.setExtra('错过', this.missed)
  }

  paint(c: CanvasRenderingContext2D) {
    c.save()
    if (this.shakeT > 0) {
      const amp = this.shakeMag * (this.shakeT / 0.25)
      c.translate(Math.sin(this.t * 71) * amp, Math.cos(this.t * 64) * amp * 0.6)
    }
    // 换色白闪
    if (this.swapFlashT > 0) {
      c.save()
      c.globalAlpha = this.swapFlashT * 0.35
      c.fillStyle = '#fff'
      c.fillRect(-20, -20, this.W + 40, this.H + 40)
      c.restore()
    }
    if (this.built) {
      this.paintRow(c)
      this.paintHost(c)
    }
    c.restore()

    if (this.bannerT > 0) {
      c.globalAlpha = Math.min(1, this.bannerT / 0.3)
      outlineTxt(c, this.bannerText, this.W / 2, this.H * 0.3, 48, '#ffd54a')
      if (this.bannerSub) outlineTxt(c, this.bannerSub, this.W / 2, this.H * 0.3 + 52, 26, '#ffffffcc')
      c.globalAlpha = 1
    }
    txt(
      c,
      '喊到你的颜色，每个「蹲」字蹲一下；没喊到你，可千万别动哦',
      this.W / 2,
      this.H - 28,
      20,
      'rgba(255,255,255,.8)',
      'center',
      'bold',
    )
  }

  /** AI 萝卜的程序性压缩量（0~1） */
  private aiSquats(p: number) {
    const ph = this.phrase
    if (!ph) return 0
    let a = 0
    for (const s of ph.ai) {
      if (s.pos !== p) continue
      const t = this.t - s.start
      if (t < 0 || t > s.dur) continue
      a += clamp(t / 0.12, 0, 1) * clamp((s.dur - t) / 0.12, 0, 1)
    }
    return clamp(a, 0, 1)
  }

  private paintRow(c: CanvasRenderingContext2D) {
    const gy = this.posY()
    const R = this.pos.length
    const rx = 46 // 萝卜半径
    // 地面
    const g = c.createLinearGradient(0, gy - 20, 0, this.H)
    g.addColorStop(0, '#7a5a3a')
    g.addColorStop(1, '#5d3a1e')
    c.fillStyle = g
    c.fillRect(0, gy - 10, this.W, this.H - gy + 10)
    for (let i = 0; i < R; i++) {
      const x = this.posX(i)
      const col = this.pos[i]
      const isCalled = this.phrase?.idx === i
      const isNext = this.phrase?.next === i
      // 被喊位脚下光圈脉动 / 预告位淡光圈
      if (isCalled || isNext) {
        const alpha = isCalled ? 0.4 + Math.sin(this.t * 6) * 0.15 : 0.16
        c.save()
        c.globalAlpha = alpha
        c.beginPath()
        c.ellipse(x, gy - 6, rx * 1.7, rx * 0.5, 0, 0, Math.PI * 2)
        c.fillStyle = '#ffd54a'
        c.fill()
        c.restore()
      }
      // 蹲拍光环
      for (const p of this.phrase?.pulse ?? []) {
        const age = this.t - p.t
        if (age > 0.5) continue
        c.save()
        c.globalAlpha = (1 - age / 0.5) * 0.7
        c.beginPath()
        c.arc(p.x, p.y - 60, 30 + age * 160, 0, Math.PI * 2)
        c.strokeStyle = '#ffd54a'
        c.lineWidth = 6 * (1 - age / 0.5)
        c.stroke()
        c.restore()
      }
      // 萝卜本体：真人驻守 → 实时蹲姿压缩；AI → 程序性压缩
      const hi = col.human
      const sq = hi >= 0 ? this.humans[hi].sense.vis : this.aiSquats(i)
      const squash = 1 - sq * 0.45
      const bw = rx * (1 + sq * 0.25)
      const bh = rx * 1.35 * squash
      const present = hi < 0 || this.players[hi].body
      c.save()
      c.globalAlpha = present ? 1 : 0.35
      c.translate(x, gy - bh * 0.6)
      const body = c.createRadialGradient(-bw * 0.3, -bh * 0.3, bw * 0.15, 0, 0, bw)
      body.addColorStop(0, this.colorHex(col.color))
      body.addColorStop(1, col.color === WHITE_IDX ? '#d8d8e2' : this.colorHex(col.color))
      c.beginPath()
      c.ellipse(0, 0, bw, bh, 0, 0, Math.PI * 2)
      c.fillStyle = body
      c.fill()
      // 叶子
      for (const [dx, ang] of [
        [-0.5, -0.5],
        [0, 0],
        [0.5, 0.5],
      ] as const) {
        c.save()
        c.translate(dx * bw * 0.5, -bh * 0.85)
        c.rotate(ang)
        c.beginPath()
        c.ellipse(0, -rx * 0.3, rx * 0.14, rx * 0.38, 0, 0, Math.PI * 2)
        c.fillStyle = '#2e9e52'
        c.fill()
        c.restore()
      }
      // 眼睛
      c.fillStyle = '#4a3b32'
      c.beginPath()
      c.arc(-bw * 0.28, -bh * 0.1, rx * 0.09, 0, Math.PI * 2)
      c.arc(bw * 0.28, -bh * 0.1, rx * 0.09, 0, Math.PI * 2)
      c.fill()
      c.strokeStyle = '#4a3b32'
      c.lineWidth = 2.5
      c.beginPath()
      c.arc(0, bh * 0.16, rx * 0.18, sq > 0.5 ? Math.PI * 1.1 : 0.15 * Math.PI, sq > 0.5 ? Math.PI * 1.9 : 0.85 * Math.PI)
      c.stroke()
      c.restore()
      // 玩家名牌（emoji+你/左/右），白萝卜位文字用黄色特殊标记
      if (hi >= 0) {
        const tagY = gy - rx * 3.2 - sq * rx * 0.5
        emoji(c, '🧒', x - 22, tagY, 30)
        const label = `${this.players.filter((p) => p.body).length > 1 ? (hi === 0 ? '左' : '右') : '你'}·${this.colorName(col.color)}萝卜`
        outlineTxt(c, label, x + 12, tagY, 20, col.color === WHITE_IDX ? '#ffd54a' : '#fff')
        // 头转星星（上当 1.5s）
        const h = this.humans[hi]
        if (h.fooledUntil > 0) {
          for (let s = 0; s < 3; s++) {
            const a = this.t * 6 + (s * Math.PI * 2) / 3
            c.save()
            c.translate(x + Math.cos(a) * 42, tagY - 34 + Math.sin(a) * 12)
            c.rotate(a)
            c.fillStyle = '#ffd54a'
            c.beginPath()
            for (let k = 0; k < 10; k++) {
              const rr2 = k % 2 === 0 ? 8 : 3.5
              const aa = (Math.PI / 5) * k - Math.PI / 2
              const px2 = Math.cos(aa) * rr2
              const py2 = Math.sin(aa) * rr2
              k === 0 ? c.moveTo(px2, py2) : c.lineTo(px2, py2)
            }
            c.closePath()
            c.fill()
            c.restore()
          }
        }
      }
    }
  }

  /** 兔主持人 + 气泡（手机版样式：色块 + 3 进度点 + 下一位箭头） */
  private paintHost(c: CanvasRenderingContext2D) {
    const ph = this.phrase
    const bx = this.W * 0.5
    const by = this.H * 0.12
    // 兔子
    const rx = this.W * 0.1
    const ry = by + 26
    const r = 34
    c.save()
    c.translate(rx, ry)
    for (const s of [-1, 1]) {
      c.beginPath()
      c.ellipse(s * r * 0.45, -r * 1.4, r * 0.2, r * 0.6, s * 0.2, 0, Math.PI * 2)
      c.fillStyle = '#f6f2ec'
      c.fill()
    }
    c.beginPath()
    c.arc(0, 0, r, 0, Math.PI * 2)
    c.fillStyle = '#f6f2ec'
    c.fill()
    // 小旗
    c.strokeStyle = '#8a6a3a'
    c.lineWidth = 5
    c.beginPath()
    c.moveTo(r * 0.7, -r * 0.6)
    c.lineTo(r * 1.5, -r * 1.5)
    c.stroke()
    c.beginPath()
    c.moveTo(r * 1.5, -r * 1.5)
    c.lineTo(r * 2.2, -r * 1.15)
    c.lineTo(r * 1.5, -r * 0.8)
    c.closePath()
    c.fillStyle = '#ff5c5c'
    c.fill()
    c.fillStyle = '#4a3b32'
    c.beginPath()
    c.arc(-r * 0.32, -r * 0.1, r * 0.09, 0, Math.PI * 2)
    c.arc(r * 0.32, -r * 0.1, r * 0.09, 0, Math.PI * 2)
    c.fill()
    c.beginPath()
    c.arc(0, r * 0.2, r * 0.12, 0.15 * Math.PI, 0.85 * Math.PI)
    c.strokeStyle = '#4a3b32'
    c.lineWidth = 3
    c.stroke()
    c.restore()

    if (!ph) return
    // 气泡
    const bw = 560
    const bh = 84
    c.save()
    c.fillStyle = 'rgba(14,18,44,.78)'
    rr(c, bx - bw / 2, by - bh / 2, bw, bh, 26)
    c.fill()
    c.strokeStyle = 'rgba(255,255,255,.25)'
    c.lineWidth = 2
    c.stroke()
    // 被喊色块
    const chip = (cx: number, ci: number, dim: boolean) => {
      const cw = 96
      c.save()
      c.globalAlpha = dim ? 0.45 : 1
      c.fillStyle = this.colorHex(ci)
      rr(c, cx - cw / 2, by - 22, cw, 44, 14)
      c.fill()
      const labelColor = ci === WHITE_IDX ? '#ffd54a' : '#fff'
      outlineTxt(c, `${this.colorName(ci)}萝卜`, cx, by, 22, labelColor)
      c.restore()
    }
    chip(bx - bw / 2 + 84, ph.idx, false)
    // 3 个进度点（被喊人类玩家命中则点亮）
    const hi = this.pos[ph.idx].human
    for (let t = 0; t < 3; t++) {
      const hit = hi >= 0 && ph.hits[t]
      const passed = ph.dunDone[t]
      circle(c, bx - bw / 2 + 168 + t * 26, by, 8, hit ? '#3ddc97' : passed ? 'rgba(255,255,255,.5)' : 'rgba(255,255,255,.22)')
    }
    // 下一位箭头 + 色块
    outlineTxt(c, '→', bx + 60, by, 30, '#ffffffcc')
    chip(bx + bw / 2 - 84, ph.next, true)
    c.restore()
  }
}

export default function create(ctx: GameContext) {
  return new RadishSquat(ctx)
}
