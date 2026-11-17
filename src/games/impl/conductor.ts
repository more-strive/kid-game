import { BaseGame } from '@/core/base'
import type { Game, GameContext, PoseFrame } from '@/core/types'
import { glow, outlineTxt, rr, star, txt } from '@/core/draw'

/**
 * 小指挥家（对齐 dongdongpark 真实规则，独立实时指挥引擎，非 beat 共享谱面）：
 * 上下挥手=定乐队速度（挥动反转测速，EMA 平滑、上限 3.5Hz、停挥 2.2s 归零），
 * 手举高=定音量（lift=(肩-手)/躯干，音量=clamp((lift+.55)/1.15)）。
 * 要求卡：速度卡（slow/fast/mid）+ 音量卡（soft/loud），hard 按概率出组合卡；
 * 符合要求每 0.2s +1；5 只动物按音量分层醒来；69s「双手举高收！」+10。
 */

interface Card {
  kind: 'warm' | 'req' | 'end'
  start: number
  end: number
  speed?: 'slow' | 'fast' | 'mid'
  vol?: 'soft' | 'loud'
  label: string
}

/** 对齐站点难度配置 ne：卡长基准/组合卡概率/慢速线/快速线/中速区间/轻响线 */
const DIFF = [
  { seg: 10, combo: 0, slow: 88, fast: 104, mid: [76, 124], useMid: false, soft: 0.45, loud: 0.55 },
  { seg: 8, combo: 0.35, slow: 80, fast: 114, mid: [84, 110], useMid: true, soft: 0.4, loud: 0.6 },
  { seg: 7, combo: 0.7, slow: 74, fast: 124, mid: [88, 112], useMid: true, soft: 0.34, loud: 0.66 },
]

// 全局字面量（源码照抄）
const DURATION = 75
const WARM = 5 // 开场热身段时长
const END_AT = 69 // 结尾段：t = duration - 6
const SCORE_TICK = 0.2 // 符合要求每 0.2s +1
const WAVE_DEAD = 0.2 // 挥动检测死区（×torso）
const WAVE_DEBOUNCE = 0.22 // 挥动去抖最小间隔（秒）
const STOP_TIMEOUT = 2.2 // 停挥超时：>2.2s 没挥 → 速度归零
const BPM_MIN = 40 // BPM 表刻度范围
const BPM_MAX = 180
const LAYERS = [0, 0.2, 0.4, 0.6, 0.8] // 音量分层阈值：5 只动物依次醒来
const UP_LIFT = 0.45 // 收尾「双手举高」：(肩-手)/torso > .45
const UP_HOLD = 0.25 // 持续 .25s
const RATE_CAP = 3.5 // 单次挥动频率上限（Hz）

/** MIDI 基音 + 大调音阶 */
const MIDI_BASE = 72
const SCALE = [0, 2, 4, 5, 7, 9, 11]
const TOKEN_RE = /^([1-7])([,']*)(\/+)?(\.?)(-*)$/

interface SongDef {
  name: string
  notes: string
}

/** 曲目：小星星 / 欢乐颂 / 两只老虎 / 玛丽的小羊（简谱：/ ÷2、. ×1.5、- 延音+1拍） */
const SONGS: SongDef[] = [
  { name: '小星星', notes: '1 1 5 5 6 6 5- 4 4 3 3 2 2 1- 5 5 4 4 3 3 2- 5 5 4 4 3 3 2- 1 1 5 5 6 6 5- 4 4 3 3 2 2 1-' },
  { name: '欢乐颂', notes: '3 3 4 5 5 4 3 2 1 1 2 3 3. 2 2- 3 3 4 5 5 4 3 2 1 1 2 3 2. 1 1-' },
  { name: '两只老虎', notes: "1 2 3 1 1 2 3 1 3 4 5- 3 4 5- 5' 6' 5' 4' 3 1 5' 6' 5' 4' 3 1 2 5, 1- 2 5, 1-" },
  { name: '玛丽的小羊', notes: '3 2 1 2 3 3 3- 2 2 2- 3 5 5- 3 2 1 2 3 3 3 3 2 2 3 2 1-' },
]

function parseMelody(song: SongDef): number[] {
  const out: number[] = []
  for (const tok of song.notes.split(/\s+/)) {
    const m = TOKEN_RE.exec(tok)
    if (!m) continue
    const deg = Number(m[1])
    const oct = (m[2].match(/'/g)?.length ?? 0) - (m[2].match(/,/g)?.length ?? 0)
    out.push(MIDI_BASE + SCALE[deg - 1] + 12 * oct)
    // 时值影响演奏长度但不影响旋律音序（pos 按拍推进）
  }
  return out
}

const ANIMALS = ['🐻', '🐰', '🐱', '🐘', '🦆']

const SPEED_LABEL: Record<string, string> = { slow: '慢慢地', fast: '快快地', mid: '不快不慢' }
const VOL_LABEL: Record<string, string> = { soft: '小小声', loud: '大声点' }

interface WaveTrack {
  prevYL: number
  prevYR: number
  ready: boolean
  dir: number
  accum: number
  actL: number
  actR: number
  lead: number
}

class Conductor extends BaseGame implements Game {
  bg = 'stage'
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  cards: Card[] = []
  songName = ''
  melody: number[] = []
  /** 实时节奏引擎状态 */
  wave: WaveTrack = { prevYL: 0, prevYR: 0, ready: false, dir: 0, accum: 0, actL: 0, actR: 0, lead: 0 }
  rate = 0
  eff = 0
  pos = 0
  bpmDisp = 0
  maxBpm = 0
  lastWaveAt = -10
  waves = 0
  lastNoteBeat = -1
  lastStarBeat = 0
  /** 音量 */
  liftS = 0
  vol = 0
  /** 计分 */
  score = 0
  scoreAcc = 0
  contT = 0
  metTime = 0
  flashT = 0
  /** 收尾 */
  endDone = [false, false]
  upT = [0, 0]
  celebrated = false
  celebrateAt = -10
  crackCount = 0
  crackLast = -10
  finished = false
  curCard = -1
  lastHintAt = -10
  hint = ''

  constructor(ctx: GameContext) {
    super(ctx)
    // 曲目随机一首
    const rng = mulberry(Math.floor(Math.random() * 1e9))
    const song = SONGS[Math.floor(rng() * SONGS.length)]
    this.songName = song.name
    this.melody = parseMelody(song)
    // 要求卡序列：0-5 热身 → 5~69 按卡长切分 → 69 起收尾
    const span = DURATION - END_AT - WARM // 64
    const nSeg = Math.round(span / this.cfg.seg)
    const cardDur = span / nSeg
    this.cards.push({ kind: 'warm', start: 0, end: WARM, label: '挥起来！' })
    let prevKey = ''
    for (let i = 0; i < nSeg; i++) {
      const card: Card = { kind: 'req', start: WARM + i * cardDur, end: WARM + (i + 1) * cardDur, label: '' }
      const wantCombo = rng() < this.cfg.combo
      if (wantCombo) {
        card.speed = this.pickSpeed(rng, prevKey, true)
        card.vol = rng() < 0.5 ? 'soft' : 'loud'
        card.label = `${SPEED_LABEL[card.speed]}＋${VOL_LABEL[card.vol]}`
      } else if (rng() < 0.5) {
        card.speed = this.pickSpeed(rng, prevKey, false)
        card.label = SPEED_LABEL[card.speed]
      } else {
        card.vol = rng() < 0.5 ? 'soft' : 'loud'
        card.label = VOL_LABEL[card.vol]
      }
      prevKey = `${card.speed ?? ''}|${card.vol ?? ''}`
      this.cards.push(card)
    }
    this.cards.push({ kind: 'end', start: END_AT, end: DURATION, label: '双手举高，收！' })
    const duo = ctx.meta.mode !== 'solo'
    this.ctx.speak(duo ? '左边挥手管快慢，右边举手管大小声！' : '挥动手臂定速度，手举高声音就大！')
  }

  private pickSpeed(rng: () => number, prevKey: string, combo: boolean): 'slow' | 'fast' | 'mid' {
    for (let tries = 0; tries < 8; tries++) {
      const pool: ('slow' | 'fast' | 'mid')[] = this.cfg.useMid ? ['slow', 'fast', 'mid'] : ['slow', 'fast']
      const pick = pool[Math.floor(rng() * pool.length)]
      // 不与上一张重复（组合卡只看速度部分即可避免完全相同）
      if (`${pick}|` === prevKey && !combo) continue
      return pick
    }
    return this.cfg.useMid ? 'mid' : 'slow'
  }

  private unit() {
    return this.H / 720
  }
  private present() {
    return this.players.filter((p) => p.body).length
  }
  private cardAt(now: number): Card {
    for (const c of this.cards) if (now >= c.start && now < c.end) return c
    return this.cards[this.cards.length - 1]
  }
  private nextCard(now: number): Card | null {
    for (const c of this.cards) if (c.start > now) return c
    return null
  }

  private speedOk(card: Card) {
    if (!card.speed) return true
    if (card.speed === 'slow') return this.bpmDisp <= this.cfg.slow
    if (card.speed === 'fast') return this.bpmDisp >= this.cfg.fast
    return this.bpmDisp >= this.cfg.mid[0] && this.bpmDisp <= this.cfg.mid[1]
  }
  private volOk(card: Card) {
    if (!card.vol) return true
    return card.vol === 'soft' ? this.vol <= this.cfg.soft : this.vol >= this.cfg.loud
  }

  tick(_f: PoseFrame, dt: number) {
    const now = this.t
    const duo = this.present() >= 2

    // ---- 挥手测速（玩家 0；双人时也只由速度位驱动）----
    const b0 = this.players[0].body
    if (b0) {
      const torso = Math.max(40, b0.scale * this.H)
      const torsoNorm = Math.max(0.05, torso / this.H)
      const yl = b0.lHand.y * this.H
      const yr = b0.rHand.y * this.H
      const w = this.wave
      if (!w.ready) {
        w.ready = true
        w.prevYL = yl
        w.prevYR = yr
      }
      const dynL = dt > 0 ? (yl - w.prevYL) / dt / torsoNorm : 0
      const dynR = dt > 0 ? (yr - w.prevYR) / dt / torsoNorm : 0
      w.prevYL = yl
      w.prevYR = yr
      // 领先手自动切到动作更大的那只（act 比 >1.4×+0.15 就切换）
      w.actL += (Math.abs(dynL) - w.actL) * Math.min(1, dt * 6)
      w.actR += (Math.abs(dynR) - w.actR) * Math.min(1, dt * 6)
      if (w.actL > w.actR * 1.4 + 0.15) w.lead = 0
      else if (w.actR > w.actL * 1.4 + 0.15) w.lead = 1
      const chosen = w.lead === 0 ? dynL : dynR
      const sign = chosen > 0 ? 1 : chosen < 0 ? -1 : w.dir
      if (sign !== 0 && sign !== w.dir) {
        // y 方向反转且累计幅度 > 死区 → 一次挥动
        if (Math.abs(w.accum) > WAVE_DEAD && now - this.lastWaveAt >= WAVE_DEBOUNCE) {
          const since = now - this.lastWaveAt
          if (this.lastWaveAt > 0 && since < STOP_TIMEOUT && since > 0.01) {
            const inst = 1 / since
            const capped = Math.min(RATE_CAP, inst)
            const ratio = this.rate > 0 ? capped / this.rate : 2
            const alpha = this.rate > 0 && (ratio > 1.3 || ratio < 0.77) ? 0.85 : 0.5
            this.rate += (capped - this.rate) * alpha
          }
          this.waves++
          // 把 pos 向最近的整数拍半程校正
          this.pos += (Math.round(this.pos) - this.pos) * 0.5
        }
        this.lastWaveAt = now
        w.accum = 0
        w.dir = sign
      } else {
        w.accum += chosen
      }
    }
    // 停挥超时 → 速度归零（乐队渐停）
    this.eff = now - this.lastWaveAt > STOP_TIMEOUT ? 0 : this.rate
    this.pos += this.eff * dt
    // BPM = eff×60（τ=0.3s 平滑显示；<40 直接置位）
    const bpmTarget = this.eff * 60
    if (bpmTarget < 40) this.bpmDisp = bpmTarget
    else this.bpmDisp += (bpmTarget - this.bpmDisp) * Math.min(1, dt / 0.3)
    this.maxBpm = Math.max(this.maxBpm, this.bpmDisp)

    // ---- 手高测音量（单人一人双控；双人玩家 1 管大小声）----
    const vp = duo ? 1 : 0
    const bv = this.players[vp].body
    if (bv) {
      const torso = Math.max(40, bv.scale * this.H)
      const sy = bv.shoulderC.y * this.H
      const lift = Math.max(
        (sy - bv.lHand.y * this.H) / torso,
        (sy - bv.rHand.y * this.H) / torso,
      )
      this.liftS += (lift - this.liftS) * Math.min(1, dt / 0.45)
      this.vol = Math.min(1, Math.max(0, (this.liftS + 0.55) / 1.15))
    }

    // ---- 乐队编曲（音量分层）----
    let layers = 1
    for (let i = 1; i < LAYERS.length; i++) if (this.vol >= LAYERS[i]) layers++
    const beatIdx = Math.floor(this.pos)
    if (this.eff > 0 && beatIdx > this.lastNoteBeat && this.melody.length) {
      this.lastNoteBeat = beatIdx
      const midi = this.melody[((beatIdx % this.melody.length) + this.melody.length) % this.melody.length]
      const lane = ((midi - 69) * 12) / 5
      this.ctx.audio.tonePop(lane) // 旋律（随时播）
      if (layers >= 2 && beatIdx % 2 === 0) this.ctx.audio.tonePop(lane + 5) // 曼陀林拨弦（高八度）
      if (layers >= 3) this.ctx.audio.tonePop(lane + (7 * 12) / 5) // 和声（五度）
      if (layers >= 4 && beatIdx % 2 === 0) this.ctx.audio.play('hit', 0.6, 0.9) // 鼓（偶数拍）
      if (layers >= 5 && beatIdx % 2 === 1) this.ctx.audio.play('click', 0.4, 1.3) // 响板（奇数拍）
      // 每 5 拍星粒子 4
      if (beatIdx - this.lastStarBeat >= 5) {
        this.lastStarBeat = beatIdx
        this.particles.burst(this.W / 2, this.H * 0.62, '#ffd93d', 4, 200 * this.unit(), 5, 500, '⭐')
      }
    }

    // ---- 要求卡判定 + 计分（每 0.2s +1，全员共享）----
    const card = this.cardAt(now)
    const cardIdx = this.cards.indexOf(card)
    if (cardIdx !== this.curCard) {
      this.curCard = cardIdx
      this.ctx.setStage(card.label)
      if (card.kind === 'req') {
        this.ctx.speak(card.label)
        this.ctx.audio.pop()
      } else if (card.kind === 'end') {
        this.ctx.speak('双手举高，收！')
        this.ctx.audio.pop()
      }
    }
    if (card.kind !== 'end') {
      const met = card.kind === 'warm' ? this.eff > 0 : this.speedOk(card) && this.volOk(card)
      if (met) {
        if (now >= WARM) this.metTime += dt // 跟上要求统计只算正式卡段（5s 起）
        this.scoreAcc += dt
        this.contT += dt
        while (this.scoreAcc >= SCORE_TICK) {
          this.scoreAcc -= SCORE_TICK
          this.score++
        }
        if (this.contT >= 2.5) {
          this.contT = 0
          this.flashT = Math.max(this.flashT, 0.45)
        }
      } else {
        this.scoreAcc = 0
        this.contT = 0
      }
    }
    // 偏差提示（1.6s 节流）
    if (now - this.lastHintAt > 1.6) {
      this.lastHintAt = now
      this.hint = ''
      if (this.eff === 0 && now > 4 && card.kind !== 'end') {
        this.hint = '挥挥手！'
      } else {
        if (card.speed === 'slow' && this.bpmDisp > this.cfg.slow) this.hint = '慢一点 ↓'
        else if (card.speed === 'fast' && this.bpmDisp < this.cfg.fast) this.hint = '快一点 ↑'
        else if (card.speed === 'mid') {
          if (this.bpmDisp < this.cfg.mid[0]) this.hint = '快一点 ↑'
          else if (this.bpmDisp > this.cfg.mid[1]) this.hint = '慢一点 ↓'
        }
        if (!this.hint && card.vol === 'soft' && this.vol > this.cfg.soft) this.hint = '放低 ↓'
        else if (!this.hint && card.vol === 'loud' && this.vol < this.cfg.loud) this.hint = '举高 ↑'
      }
    }

    // ---- 收尾：双手举高 0.45×torso 持续 0.25s（或 handsUp 事件）→ +10 ----
    if (now >= END_AT) {
      for (let pi = 0; pi < 2; pi++) {
        const b = this.players[pi].body
        if (!b || this.endDone[pi]) continue
        const torso = Math.max(40, b.scale * this.H)
        const sy = b.shoulderC.y * this.H
        const liftL = (sy - b.lHand.y * this.H) / torso
        const liftR = (sy - b.rHand.y * this.H) / torso
        if ((liftL > UP_LIFT && liftR > UP_LIFT) || b.armsUp) this.upT[pi] += dt
        else this.upT[pi] = 0
        if (this.upT[pi] >= UP_HOLD) {
          this.endDone[pi] = true
          this.score += 10
          const px = ((b.lHand.x + b.rHand.x) / 2) * this.W
          const py = ((b.lHand.y + b.rHand.y) / 2) * this.H
          this.ctx.speak('+10 收！')
          this.ctx.audio.play('combo', 0.9)
          this.particles.burst(px, py, '#ffd93d', 14, 340 * this.unit(), 5, 500, '⭐')
        }
      }
      const presentIds = this.players.filter((p) => p.body).map((p) => p.id)
      const allDone = presentIds.length > 0 && presentIds.every((id) => this.endDone[id])
      if (allDone && !this.celebrated) {
        this.celebrated = true
        this.celebrateAt = now
        this.ctx.speak('演出成功！全场鼓掌')
        this.ctx.audio.fanfare()
        this.ctx.audio.play('drop', 0.9, 0.7)
        this.particles.confetti(this.W, 90)
        this.crackCount = 0
      }
      // 随机掌声 crack ×16
      if (this.celebrated && this.crackCount < 16 && now - this.crackLast > 0.15) {
        this.crackLast = now
        this.crackCount++
        this.ctx.audio.play('hit', 0.35, 1 + Math.random() * 0.4)
      }
      if (this.celebrated && now >= this.celebrateAt + 2.8 && !this.finished) {
        this.finished = true
        this.ctx.finish()
      }
    }

    this.flashT = Math.max(0, this.flashT - dt)
    this.ctx.setScore(this.score)
    this.ctx.setCombo(this.waves)
    this.ctx.setExtra('跟上要求', now > WARM ? Math.round((this.metTime / Math.max(1, Math.min(now, END_AT) - WARM)) * 100) : 0)
    this.ctx.setExtra('挥了几下', this.waves)
    this.ctx.setExtra('最快速度', Math.round(this.maxBpm))
  }

  paint(c: CanvasRenderingContext2D) {
    const now = this.t
    const duo = this.present() >= 2
    const card = this.cardAt(now)
    const layers = 1 + (this.vol >= 0.2 ? 1 : 0) + (this.vol >= 0.4 ? 1 : 0) + (this.vol >= 0.6 ? 1 : 0) + (this.vol >= 0.8 ? 1 : 0)

    // ---- 乐队：5 只动物按音量分层醒来 ----
    const bandY = this.H * 0.6
    for (let i = 0; i < 5; i++) {
      const x = this.W * (0.24 + i * 0.13)
      const awake = i < layers
      const jump = this.celebrated ? Math.abs(Math.sin(now * 6 + i)) * 26 : 0
      c.save()
      c.globalAlpha = awake ? 1 : 0.28
      c.translate(x, bandY - jump)
      c.font = `${52 * this.unit()}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`
      c.textAlign = 'center'
      c.textBaseline = 'middle'
      c.fillText(ANIMALS[i], 0, 0)
      c.restore()
      if (!awake && !this.celebrated) {
        // 睡着 z 字泡
        c.save()
        c.globalAlpha = 0.5 + 0.3 * Math.sin(now * 2 + i * 1.7)
        txt(c, 'z', x + 26, bandY - 40 - ((now * 12 + i * 14) % 22), 16 + ((now * 12 + i * 14) % 22) * 0.2, '#cdd6ff', 'center', 'bold')
        c.restore()
      }
      txt(c, `${i + 1}`, x, bandY + 36, 14, 'rgba(255,255,255,.55)', 'center', 'bold')
    }
    txt(c, `♪ ${this.songName}`, this.W * 0.5, bandY - 76, 24, 'rgba(255,255,255,.85)', 'center', 'bold')
    // 音符粒子从乐队飘起（数量随音量）
    if (this.eff > 0 && Math.random() < this.vol * 0.3) {
      this.particles.burst(this.W * (0.25 + Math.random() * 0.5), bandY - 30, '#ffd93d', 1, 120, 4, -60, '♪')
    }
    if (this.eff === 0 && now > 4) {
      txt(c, '乐队打瞌睡中…快挥手！', this.W / 2, bandY + 70, 22, 'rgba(255,255,255,.7)', 'center', 'bold')
    }

    // ---- 双仪表：BPM 表盘（40-180 刻度、要求区间高亮+指针）+ 音量条 ----
    this.drawGauges(c, card)

    // ---- 要求卡 + 进度条 + 右侧预告卡 ----
    this.drawCard(c, card, now)
    const next = this.nextCard(now)
    const remain = card.end - now
    if (next && remain < 2.2 && next.kind === 'req') {
      const slide = (1 - remain / 2.2) * 140 * this.unit()
      c.save()
      c.globalAlpha = Math.min(1, (2.2 - remain) / 0.5)
      this.drawCardBox(c, this.W - 200 * this.unit() + slide, 30, 190 * this.unit(), 76 * this.unit(), next.label, false, 1, 0, 0.8)
      outlineTxt(c, '下一张', this.W - 105 * this.unit() + slide, 118 * this.unit(), 16, 'rgba(255,255,255,.7)')
      c.restore()
    }

    // ---- 收尾横幅 ----
    if (this.celebrated) {
      outlineTxt(c, '演出成功！全场鼓掌', this.W / 2, this.H * 0.3, 54, '#ffd54a')
      glow(c, this.W / 2, this.H * 0.3, 260 * this.unit(), '#ffd54a', 0.25)
    }
    if (this.hint && !this.celebrated) {
      outlineTxt(c, this.hint, this.W / 2, this.H * 0.4, 34, '#ffb703')
    }
    // 连续符合 2.5s 的 highlight 白闪
    if (this.flashT > 0) {
      c.save()
      c.globalAlpha = Math.min(0.2, this.flashT * 0.3)
      c.fillStyle = '#fff'
      c.fillRect(0, 0, this.W, this.H)
      c.restore()
    }
    if (this.present() === 0) {
      outlineTxt(c, '站到镜头前，挥起你的手臂', this.W / 2, this.H * 0.5, 34, '#ffffff')
    }
    txt(
      c,
      duo ? '玩家1 挥手定快慢，玩家2 手的高低定声音大小' : '挥得快乐队就快，手举得高声音就大；照要求卡指挥',
      this.W / 2, this.H - 22, 20, 'rgba(255,255,255,.8)', 'center', 'bold',
    )
  }

  /** BPM 表盘 + 音量条（要求区间高亮） */
  private drawGauges(c: CanvasRenderingContext2D, card: Card) {
    const u = this.unit()
    const x0 = 46 * u
    const w = 300 * u
    let y = this.H - 118 * u
    // 速度
    txt(c, `速度 ${Math.round(this.bpmDisp)} 拍/分`, x0, y - 14, 18, '#fff', 'left', 'bold')
    rr(c, x0, y, w, 14 * u, 7 * u)
    c.fillStyle = 'rgba(255,255,255,.15)'
    c.fill()
    const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
    // 要求区间高亮
    if (card.speed) {
      const lo = card.speed === 'slow' ? BPM_MIN : card.speed === 'fast' ? this.cfg.fast : this.cfg.mid[0]
      const hi = card.speed === 'slow' ? this.cfg.slow : card.speed === 'fast' ? BPM_MAX : this.cfg.mid[1]
      const rx = x0 + w * ((lo - BPM_MIN) / (BPM_MAX - BPM_MIN))
      const rw = w * ((hi - lo) / (BPM_MAX - BPM_MIN))
      c.fillStyle = 'rgba(107,203,119,.55)'
      c.fillRect(rx, y, rw, 14 * u)
    }
    // 指针
    const nx = x0 + w * clamp01((this.bpmDisp - BPM_MIN) / (BPM_MAX - BPM_MIN))
    c.fillStyle = '#ffd93d'
    c.beginPath()
    c.moveTo(nx, y - 4)
    c.lineTo(nx - 6 * u, y - 14 * u)
    c.lineTo(nx + 6 * u, y - 14 * u)
    c.closePath()
    c.fill()
    txt(c, `${BPM_MIN}`, x0, y + 22, 12, 'rgba(255,255,255,.5)', 'center', 'bold')
    txt(c, `${BPM_MAX}`, x0 + w, y + 22, 12, 'rgba(255,255,255,.5)', 'center', 'bold')
    // 音量
    y += 44 * u
    txt(c, `音量 ${Math.round(this.vol * 100)}%`, x0, y - 14, 18, '#fff', 'left', 'bold')
    rr(c, x0, y, w, 14 * u, 7 * u)
    c.fillStyle = 'rgba(255,255,255,.15)'
    c.fill()
    const g = c.createLinearGradient(x0, 0, x0 + w, 0)
    g.addColorStop(0, '#4cc9f0')
    g.addColorStop(1, '#ff5c8a')
    rr(c, x0, y, w * this.vol, 14 * u, 7 * u)
    c.fillStyle = g
    c.fill()
    if (card.vol) {
      const th = card.vol === 'soft' ? this.cfg.soft : this.cfg.loud
      const tx = x0 + w * th
      c.strokeStyle = '#ffd93d'
      c.lineWidth = 3
      c.beginPath()
      c.moveTo(tx, y - 4)
      c.lineTo(tx, y + 18 * u)
      c.stroke()
      txt(c, card.vol === 'soft' ? `≤${Math.round(th * 100)}%` : `≥${Math.round(th * 100)}%`, tx, y + 32 * u, 13, '#ffd93d', 'center', 'bold')
    }
  }

  /** 要求卡：卡片 + 绿勾 + 底部进度条（<25% 变橙警示） */
  private drawCard(c: CanvasRenderingContext2D, card: Card, now: number) {
    const u = this.unit()
    const met = card.kind === 'warm' ? this.eff > 0 : card.kind === 'req' ? this.speedOk(card) && this.volOk(card) : true
    const w = 330 * u
    const h = 96 * u
    this.drawCardBox(c, this.W / 2 - w / 2, 26, w, h, card.label, met, 1, card.start, card.end, now)
  }

  private drawCardBox(
    c: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    label: string,
    met: boolean,
    alpha: number,
    start: number,
    end: number,
    now?: number,
  ) {
    c.save()
    c.globalAlpha = alpha
    rr(c, x, y, w, h, 20 * this.unit())
    c.fillStyle = 'rgba(16,20,48,.72)'
    c.fill()
    c.strokeStyle = met ? 'rgba(107,203,119,.9)' : 'rgba(255,255,255,.35)'
    c.lineWidth = 3
    c.stroke()
    outlineTxt(c, label, x + w / 2, y + h * 0.42, 30 * this.unit(), met ? '#6bcb77' : '#fff')
    // 绿勾
    if (met) {
      star(c, x + w - 30 * this.unit(), y + 24 * this.unit(), 12 * this.unit(), '#6bcb77')
      txt(c, '✓', x + w - 30 * this.unit(), y + 24 * this.unit(), 16 * this.unit(), '#0d2818', 'center', '900')
    }
    // 卡底进度条（<25% 变橙警示）
    if (now !== undefined && end > start) {
      const pct = Math.min(1, Math.max(0, (now - start) / (end - start)))
      const barW = w - 28 * this.unit()
      rr(c, x + 14 * this.unit(), y + h - 18 * this.unit(), barW, 8 * this.unit(), 4 * this.unit())
      c.fillStyle = 'rgba(255,255,255,.18)'
      c.fill()
      rr(c, x + 14 * this.unit(), y + h - 18 * this.unit(), barW * pct, 8 * this.unit(), 4 * this.unit())
      c.fillStyle = 1 - pct < 0.25 ? '#ff9f43' : '#4cc9f0'
      c.fill()
    }
    c.restore()
  }
}

function mulberry(seed: number) {
  let s = seed | 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let z = Math.imul(s ^ (s >>> 15), 1 | s)
    z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) ^ z
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296
  }
}

export default function create(ctx: GameContext): Game {
  return new Conductor(ctx)
}
