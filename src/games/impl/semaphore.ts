import { BaseGame, updateSeats } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, outlineTxt, ring, rr, txt } from '@/core/draw'

/**
 * 旗语密码 / semaphore（对齐 dongdongpark 真实规则）：
 * 屏幕按词序给出目标字母，双臂伸直指向 8 方向码表规定的方向并保持 0.7~0.8 秒 = 摆出 1 个字母（+1 分），
 * 整词拼完庆祝 1.7 秒换下一个词；难度阶梯是「照着摆 → 凭记忆摆」（hard 无 ghost、重复字母延迟 4s 提示）。
 *
 * 全部字面量沿用站点：hold 保持 0.7/0.8/0.8s、tol 角度容差 28/25/22°、ghost easy/medium 常开、
 * guide always/always/new、hintAfter 0/0/4（重复字母 4s 后才提示）、ext 门槛腕距肩 > 0.45 躯干
 * （腕弱用肘 > 0.28 躯干替代）、hold 未命中按 2×dt 衰减、整词庆祝 1.7s、摆错确认 1s、
 * 同字母连排必须先放下（非命中 0.2s 解除）、音阶按词内位置递升（站点 MIDI 72/74/76/79/81/84 → 音高倍率代理）。
 *
 * 与站点的差异（写明待实测）：
 * 1) 站点的字母↔方向码表在 sprites 黑盒（43 词分档词库也黑盒）→ 这里用**自洽的 8 方向旗语表**
 *    （ghost 臂会把目标画在肩上，任意自洽表都可教学），词库用自备 3~6 字母常见词，不重复连词；
 * 2) 站点 note 音（MIDI 音阶）→ 本框架无音符合成，用 pop 音高倍率近似；
 * 3) 双人共享一个分数（仓库口径），站点各自计分；
 * 4) ai() 演示替身未实装。
 */
type ArmState = { ext: boolean; ang: number; len: number } | null

interface Zone {
  x0: number
  x1: number
}

interface Speller {
  arms: [ArmState, ArmState]
  hold: number
  offT: number
  release: boolean
  since: number
  wordIdx: number
  pos: number
  letters: number
  words: number
  spent: number
  flips: number
  wrongT: number
  wrongLetter: string | null
  wrongTold: boolean
  seen: Set<string>
  pauseUntil: number
  lastDone: string
  zone: Zone
}

/** 站点三档：保持时长 / 角度容差 / ghost / 提示策略 / 提示延迟 */
const DIFF = [
  { hold: 0.7, tol: 28, ghost: true, guide: 'always', hintAfter: 0 },
  { hold: 0.8, tol: 25, ghost: true, guide: 'always', hintAfter: 0 },
  { hold: 0.8, tol: 22, ghost: false, guide: 'new', hintAfter: 4 },
]

const WORD_PAUSE = 1.7 // 整词庆祝暂停（秒）
const WRONG_CONFIRM = 1 // 摆错确认时长（秒）
const RELEASE_DROP = 0.2 // 同字母连排需「放下」0.2s
const EXT_WRIST = 0.45 // 举旗门槛：腕距肩 > 0.45 躯干
const EXT_ELBOW = 0.28 // 腕不可见时肘替代门槛
const DIR_STEP = Math.PI / 4 // 8 方向，45° 一档

/**
 * 自洽 8 方向旗语表（站点码表黑盒，见文件头差异 1）。
 * 方向索引：0=↓ 1=↘ 2=→ 3=↗ 4=↑ 5=↖ 6=← 7=↙；[屏幕左臂, 屏幕右臂]。
 */
const CODE: Record<string, [number, number]> = {
  A: [7, 1], B: [7, 2], C: [7, 3], D: [7, 4], E: [7, 5], F: [7, 6], G: [7, 0],
  H: [1, 2], I: [1, 3], J: [1, 4], K: [1, 5], L: [1, 6], M: [1, 0],
  N: [2, 3], O: [2, 4], P: [2, 5], Q: [2, 6], R: [2, 0],
  S: [3, 4], T: [3, 5], U: [3, 6], V: [3, 0],
  W: [5, 7], X: [4, 7], Y: [3, 7], Z: [2, 7],
}
const REV: Record<string, string> = {}
for (const [letter, [a, b]] of Object.entries(CODE)) REV[`${a},${b}`] = letter

/** 词库（自备常见词，站点 43 词分档词库黑盒） */
const WORDS: [string, string, string][] = [
  ['CAT', '小猫', '🐱'], ['DOG', '小狗', '🐶'], ['SUN', '太阳', '☀️'], ['HAT', '帽子', '🎩'],
  ['BEE', '蜜蜂', '🐝'], ['STAR', '星星', '⭐'], ['MOON', '月亮', '🌙'], ['TREE', '大树', '🌳'],
  ['BOOK', '书本', '📖'], ['KING', '国王', '👑'], ['CAKE', '蛋糕', '🎂'], ['MILK', '牛奶', '🥛'],
  ['FROG', '青蛙', '🐸'], ['DUCK', '鸭子', '🦆'], ['BOAT', '小船', '⛵'], ['SHIP', '轮船', '🚢'],
  ['FISH', '小鱼', '🐟'], ['BIRD', '小鸟', '🐦'], ['LAMB', '小羊', '🐑'], ['WOLF', '大灰狼', '🐺'],
  ['PIG', '小猪', '🐷'], ['COW', '奶牛', '🐮'], ['FOX', '狐狸', '🦊'], ['RAIN', '下雨', '🌧️'],
  ['SNOW', '下雪', '❄️'], ['WIND', '大风', '💨'], ['ROAD', '马路', '🛣️'], ['DOOR', '门', '🚪'],
  ['BALL', '皮球', '⚽'], ['GIFT', '礼物', '🎁'], ['MOUSE', '老鼠', '🐭'], ['HORSE', '小马', '🐴'],
  ['APPLE', '苹果', '🍎'], ['GRAPE', '葡萄', '🍇'], ['HOUSE', '房子', '🏠'], ['CLOUD', '云朵', '☁️'],
  ['FLOWER', '花朵', '🌸'], ['ROCKET', '火箭', '🚀'], ['ROBOT', '机器人', '🤖'], ['TRAIN', '火车', '🚂'],
]

const dirAngle = (d: number) => d * DIR_STEP // atan2(dx,dy) 口径：0=↓ 顺时针
const angDiff = (a: number, b: number) => Math.abs(((a - b + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI)
const quant = (a: number) => ((Math.round(a / DIR_STEP) % 8) + 8) % 8

class Semaphore extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[0]
  spellers: Speller[] = []
  seats = 1
  private seatActive = [false, false]
  /** 每个席位最后一次检测到人的时刻（配合 updateSeats 判断离场） */
  private seatSeen = [-9, -9]
  private order: [string, string, string][] = []
  private oi = 0

  constructor(ctx: GameContext) {
    super(ctx)
    for (let i = 0; i < 2; i++) {
      this.spellers.push({
        arms: [null, null], hold: 0, offT: 0, release: false, since: 0,
        wordIdx: 0, pos: 0, letters: 0, words: 0, spent: 0, flips: 0,
        wrongT: 0, wrongLetter: null, wrongTold: false, seen: new Set(),
        pauseUntil: 0, lastDone: '',
        zone: { x0: 0, x1: this.W },
      })
    }
    this.layout()
    this.speakWord(0)
  }

  private layout() {
    const duo = this.seats > 1
    for (let i = 0; i < 2; i++) {
      this.spellers[i].zone = duo
        ? { x0: (i * this.W) / 2, x1: ((i + 1) * this.W) / 2 }
        : { x0: 0, x1: this.W }
    }
  }

  /** 词序：顺序取词，避免与上一词重复（站点用 rng 批量取+换首，这里等价简化） */
  private wordAt(idx: number): [string, string, string] {
    while (this.order.length <= idx) {
      const w = WORDS[this.oi % WORDS.length]
      this.oi++
      const prev = this.order[this.order.length - 1]
      this.order.push(prev && w[0] === prev[0] ? WORDS[(WORDS.indexOf(w) + 1) % WORDS.length] : w)
    }
    return this.order[idx]
  }

  private speakWord(playerIdx: number) {
    const sp = this.spellers[playerIdx]
    if (this.seats === 1 && playerIdx === 0) {
      const w = this.wordAt(sp.wordIdx)
      this.ctx.speak(sp.wordIdx === 0 ? `第一个词：${w[1]}` : `下一个：${w[1]}`)
    }
  }

  tick(f: PoseFrame, dt: number) {
    if (this.seats === 1 && f.bodies[1]) {
      this.seats = 2
      this.layout()
    }
    updateSeats(this.seatActive, this.seatSeen, f.bodies, this.t)
    for (let i = 0; i < 2; i++) {
      const sp = this.spellers[i]
      if (!this.seatActive[i]) continue
      this.step(sp, f.bodies[i] ?? null, dt)
      this.ctx.setExtra(`letters${i}`, sp.letters)
      this.ctx.setExtra(`words${i}`, sp.words)
      this.ctx.setExtra(`flips${i}`, sp.flips)
    }
  }

  /** 手臂状态 M(body)：按肩屏幕 x 排序为 [左臂, 右臂]，ext 门槛 0.45T（肘替代 0.28T） */
  private armStates(b: Body): [ArmState, ArmState] {
    const X = (n: number) => n * this.W
    const Y = (n: number) => n * this.H
    const T = Math.max(60, b.scale * this.H * 1.1)
    const raw = [
      { sh: b.lShoulder, el: b.lElbow, wr: b.lHand, shV: 1, elV: 1, wrV: 1 },
      { sh: b.rShoulder, el: b.rElbow, wr: b.rHand, shV: 1, elV: 1, wrV: 1 },
    ]
    if (X(b.lShoulder.x) > X(b.rShoulder.x)) raw.reverse() // 屏幕左臂在前
    const out = raw.map((a) => {
      const sx = X(a.sh.x)
      const sy = Y(a.sh.y)
      const wx = X(a.wr.x)
      const wy = Y(a.wr.y)
      const ex = X(a.el.x)
      const ey = Y(a.el.y)
      const dW = Math.hypot(wx - sx, wy - sy)
      const dE = Math.hypot(ex - sx, ey - sy)
      if (dW > T * EXT_WRIST) {
        return { ext: true, ang: Math.atan2(wx - sx, wy - sy), len: dW / T }
      }
      if (dE > T * EXT_ELBOW) {
        return { ext: true, ang: Math.atan2(ex - sx, ey - sy), len: dE / T }
      }
      if (dW > T * 0.12) {
        return { ext: false, ang: Math.atan2(wx - ex || 0, wy - ey || 1), len: dW / T }
      }
      return null
    })
    return [out[0], out[1]]
  }

  private step(sp: Speller, b: Body | null, dt: number) {
    const now = this.t
    if (now < sp.pauseUntil) return
    const word = this.wordAt(sp.wordIdx)
    const target = word[0][sp.pos]
    sp.arms = b ? this.armStates(b) : [null, null]

    const hit = this.judge(sp.arms, target)
    // release：同字母连排，必须先「放下」
    if (sp.release) {
      if (!hit.ok) {
        sp.offT += dt
        if (sp.offT > RELEASE_DROP) sp.release = false
      }
      sp.hold = 0
      return
    }
    if (hit.ok) {
      sp.hold += dt
      sp.offT = 0
      if (sp.hold >= this.cfg.hold) this.doneLetter(sp, target)
      return
    }
    sp.hold = Math.max(0, sp.hold - dt * 2)
    // 摆错检测：双臂都伸直、量化方向对查得到字母
    const [a0, a1] = sp.arms
    if (a0?.ext && a1?.ext) {
      const u = REV[`${quant(a0.ang)},${quant(a1.ang)}`]
      if (u && u !== target) {
        sp.wrongT += dt
        if (u === this.mirrorLetter(target) && sp.wrongT <= dt) sp.flips++
        if (sp.wrongT >= WRONG_CONFIRM && !sp.wrongTold) {
          sp.wrongTold = true
          sp.wrongLetter = u
          this.ctx.audio.play('miss', 0.5, 0.8)
        }
      } else {
        sp.wrongT = 0
        sp.wrongTold = false
        sp.wrongLetter = null
      }
    } else {
      sp.wrongT = 0
      sp.wrongTold = false
      sp.wrongLetter = null
    }
  }

  /** 姿势判定 W：单臂 ext + 角差 ≤ tol；双竖直方向自动换边取优 */
  private judge(arms: [ArmState, ArmState], letter: string): { ok: boolean; arms: [boolean, boolean] } {
    const t = CODE[letter]
    if (!t) return { ok: false, arms: [false, false] }
    const one = (swapped: boolean): [boolean, boolean] => {
      const pair: [number, number] = swapped ? [t[1], t[0]] : [t[0], t[1]]
      const hit = (arm: ArmState | null, d: number) =>
        !!arm?.ext && angDiff(arm.ang, dirAngle(d)) <= (this.cfg.tol * Math.PI) / 180
      return [hit(arms[0], pair[0]), hit(arms[1], pair[1])]
    }
    let res = one(false)
    if (t[0] % 4 === 0 && t[1] % 4 === 0) {
      const swapped = one(true)
      if (Number(swapped[0]) + Number(swapped[1]) > Number(res[0]) + Number(res[1])) res = swapped
    }
    return { ok: res[0] && res[1], arms: res }
  }

  private mirrorLetter(letter: string) {
    const t = CODE[letter]
    if (!t) return ''
    return REV[`${t[1]},${t[0]}`] ?? ''
  }

  private doneLetter(sp: Speller, letter: string) {
    sp.letters++
    sp.spent += this.t - sp.since
    sp.lastDone = letter
    sp.seen.add(letter)
    this.ctx.addScore(1)
    this.ctx.audio.play('pop', 0.6, 1 + Math.min(5, sp.pos) * 0.12) // 音阶递升代理
    sp.pos++
    if (sp.pos >= this.wordAt(sp.wordIdx)[0].length) {
      sp.words++
      sp.wordIdx++
      sp.pos = 0
      sp.pauseUntil = this.t + WORD_PAUSE
      this.ctx.audio.play('win', 0.7)
      const w = this.wordAt(sp.wordIdx - 1)
      if (this.seats === 1) {
        this.say(`${w[1]}，拼好啦！`, this.W / 2, this.H * 0.3, '#6bcb77', 44)
        this.ctx.speak(`${w[1]}，拼好啦`)
      }
      this.particles.burst(this.W / 2, this.H * 0.35, '#ffd54a', this.seats > 1 ? 24 : 36, 420, 5)
      sp.since = sp.pauseUntil
      this.speakWord(0)
    } else {
      const next = this.wordAt(sp.wordIdx)[0][sp.pos]
      sp.release = next === letter // 同字母连排必须先放下
      sp.offT = 0
      sp.since = this.t
    }
    sp.hold = 0
  }

  paint(c: CanvasRenderingContext2D) {
    const duo = this.seats > 1
    if (duo) {
      c.fillStyle = 'rgba(255,255,255,.12)'
      c.fillRect(this.W / 2 - 1, 0, 2, this.H)
    }
    for (let i = 0; i < 2; i++) {
      const sp = this.spellers[i]
      const z = sp.zone
      const b = this.player(i).body
      if (!this.seatActive[i]) continue
      const word = this.wordAt(sp.wordIdx)
      const target = word[0][sp.pos]
      const T = b ? Math.max(60, b.scale * this.H * 1.1) : 140
      const shX = b ? b.shoulderC.x * this.W : (z.x0 + z.x1) / 2
      const shY = b ? b.shoulderC.y * this.H : this.H * 0.4

      // ghost 目标臂（easy/medium）
      const paused = this.t < sp.pauseUntil
      if (this.cfg.ghost && !paused && b && CODE[target]) {
        const pair: [number, number] = CODE[target]
        const hit = this.judge(sp.arms, target).arms
        for (let a = 0; a < 2; a++) {
          const ang = dirAngle(pair[a])
          const ex = shX + Math.sin(ang) * T
          const ey = shY + Math.cos(ang) * T
          c.strokeStyle = hit[a] ? 'rgba(107,203,119,.85)' : 'rgba(255,255,255,.7)'
          c.lineWidth = T * 0.14
          c.globalAlpha = 0.75
          c.beginPath()
          c.moveTo(shX, shY)
          c.lineTo(ex, ey)
          c.stroke()
          c.globalAlpha = 1
          // 旗
          c.fillStyle = this.players[i].color
          c.beginPath()
          c.moveTo(ex, ey)
          c.lineTo(ex + 18, ey - 7)
          c.lineTo(ex, ey - 14)
          c.closePath()
          c.fill()
        }
      }

      // 玩家臂线
      if (b) {
        const hit = this.judge(sp.arms, target).arms
        const lines: [[{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }], boolean][] = [
          [[b.lShoulder, b.lElbow, b.lHand].map((p) => ({ x: p.x * this.W, y: p.y * this.H })) as any, hit[0]],
          [[b.rShoulder, b.rElbow, b.rHand].map((p) => ({ x: p.x * this.W, y: p.y * this.H })) as any, hit[1]],
        ]
        for (const [pts, ok2] of lines) {
          c.strokeStyle = ok2 ? '#6bcb77' : this.players[i].color
          c.lineWidth = Math.max(4, T * 0.1)
          c.globalAlpha = 0.5
          c.beginPath()
          c.moveTo(pts[0].x, pts[0].y)
          c.lineTo(pts[1].x, pts[1].y)
          c.lineTo(pts[2].x, pts[2].y)
          c.stroke()
          c.globalAlpha = 1
        }
        // 头顶保持进度环
        const headY = b.head.y * this.H
        const headR = Math.max(14, b.scale * this.H * 0.06)
        ring(c, b.center.x * this.W, headY - headR * 1.6, headR * 1.25, sp.hold / this.cfg.hold, '#6bcb77', 5)
      }

      // 词卡：目标字母 + 词进度
      const cx = z.x0 + 24
      const cy = 110
      rr(c, cx, cy, 210, 150, 16)
      c.fillStyle = 'rgba(255,253,243,.92)'
      c.fill()
      c.strokeStyle = this.players[i].color
      c.lineWidth = 4
      c.stroke()
      txt(c, word[2] + ' ' + word[1], cx + 105, cy + 30, 20, '#5a4632')
      // 字母进度片
      const letters = word[0]
      const cw = Math.min(30, 170 / letters.length)
      for (let k = 0; k < letters.length; k++) {
        const state = k < sp.pos ? 'done' : k === sp.pos ? 'next' : 'todo'
        const x = cx + 105 + (k - (letters.length - 1) / 2) * (cw + 6)
        circle(c, x, cy + 66, cw / 2, state === 'done' ? '#6bcb77' : state === 'next' ? '#ffd54a' : 'rgba(0,0,0,.12)')
        txt(c, letters[k], x, cy + 66, 16, state === 'todo' ? '#ffffff' : '#26152c')
      }
      // 当前目标大字母（hard：重复字母等 hintAfter 秒才提示，首次见到立即提示）
      const showHint = this.cfg.guide === 'always' || !sp.seen.has(target) || this.t - sp.since >= this.cfg.hintAfter
      txt(c, showHint ? target : '?', cx + 105, cy + 116, 44, showHint ? '#26152c' : '#c4b8d0', 'center', '900')
      if (!showHint) txt(c, '凭记忆摆', cx + 105, cy + 138, 14, '#c4b8d0')

      // 反馈文字
      const fx = (z.x0 + z.x1) / 2
      const fy = shY + T * 0.42
      if (sp.release) {
        if (this.t - sp.since > 0.25) outlineTxt(c, '放下，再摆一次 ⬇', fx, fy, 24, '#ffb24d')
      } else if (sp.wrongLetter) {
        outlineTxt(c, `这是 ${sp.wrongLetter}`, fx, fy, 24, '#ff8fa8')
      }
      // 分数小字
      txt(c, `${sp.letters} 字母 · ${sp.words} 词`, z.x1 - 16, 40, 18, this.players[i].color, 'right', 'bold')
    }
  }
}

export default function create(ctx: GameContext) {
  return new Semaphore(ctx)
}
