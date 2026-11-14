/**
 * 音频：采样音效（Kenney CC0 素材，public/sfx）+ WebAudio 合成兜底 + 程序化 BGM
 * 采样未加载完成时自动退回合成音，保证任何时刻都有反馈
 */
type SfxName =
  | 'click'
  | 'pop'
  | 'score'
  | 'combo'
  | 'miss'
  | 'tick'
  | 'win'
  | 'hit'
  | 'drop'
  | 'fanfare'
  | 'result'
  | 'start'

const FILES: Record<SfxName, string> = {
  click: 'click.ogg',
  pop: 'pop.ogg',
  score: 'score.ogg',
  combo: 'combo.ogg',
  miss: 'miss.ogg',
  tick: 'tick.ogg',
  win: 'win.ogg',
  hit: 'hit.ogg',
  drop: 'drop.ogg',
  fanfare: 'fanfare.ogg',
  result: 'result.ogg',
  start: 'start.ogg',
}

/** C - Am - F - G，每小节 8 个八分音符 */
const PROG = [
  { bass: 130.81, notes: [261.63, 329.63, 392.0, 523.25] },
  { bass: 110.0, notes: [261.63, 329.63, 440.0, 523.25] },
  { bass: 87.31, notes: [261.63, 349.23, 440.0, 523.25] },
  { bass: 98.0, notes: [293.66, 392.0, 493.88, 587.33] },
]
const MELODY = [0, 2, 1, 3, 2, 1, 3, 0]

export class AudioKit {
  ctx: AudioContext | null = null
  private master: GainNode | null = null
  muted = false
  private voiceOn = true
  private buffers = new Map<SfxName, AudioBuffer>()
  private loading: Promise<void> | null = null
  private sfxGainValue = 0.55
  private bgmOn = false
  private bgmGain: GainNode | null = null
  private bgmTimer = 0
  private bgmStep = 0
  private bgmNext = 0

  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || (window as any).webkitAudioContext
      if (!AC) return null
      this.ctx = new AC()
      this.master = this.ctx.createGain()
      this.master.gain.value = 0.6
      this.master.connect(this.ctx.destination)
    }
    if (this.ctx.state === 'suspended') this.ctx.resume()
    return this.ctx
  }

  /** 预加载全部采样音效，失败静默降级 */
  preload(): Promise<void> {
    if (this.loading) return this.loading
    const ctx = this.ensure()
    if (!ctx) return Promise.resolve()
    const base = import.meta.env.BASE_URL || '/'
    this.loading = Promise.all(
      (Object.keys(FILES) as SfxName[]).map(async (name) => {
        try {
          const res = await fetch(`${base}sfx/${FILES[name]}`)
          if (!res.ok) return
          const buf = await res.arrayBuffer()
          const decoded = await ctx.decodeAudioData(buf)
          this.buffers.set(name, decoded)
        } catch {
          /* 忽略单个失败 */
        }
      }),
    ).then(() => undefined)
    return this.loading
  }

  /** 播放采样音效，返回是否成功（false 时调用方走合成兜底） */
  play(name: SfxName, gain = 1, rate = 1): boolean {
    if (this.muted) return true
    const buf = this.buffers.get(name)
    if (!buf) return false
    const ctx = this.ensure()
    if (!ctx || !this.master) return false
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.playbackRate.value = rate
    const g = ctx.createGain()
    g.gain.value = gain * this.sfxGainValue
    src.connect(g)
    g.connect(this.master)
    src.start()
    return true
  }

  private tone(
    freq: number,
    dur = 0.12,
    type: OscillatorType = 'sine',
    gain = 0.5,
    slideTo?: number,
    dest?: AudioNode,
  ) {
    if (this.muted) return
    const ctx = this.ensure()
    if (!ctx || !this.master) return
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.type = type
    o.frequency.setValueAtTime(freq, ctx.currentTime)
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(40, slideTo), ctx.currentTime + dur)
    g.gain.setValueAtTime(0.0001, ctx.currentTime)
    g.gain.exponentialRampToValueAtTime(gain, ctx.currentTime + 0.012)
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur)
    o.connect(g)
    g.connect(dest ?? this.master)
    o.start()
    o.stop(ctx.currentTime + dur + 0.02)
  }

  private noise(dur = 0.16, gain = 0.4, hp = 800) {
    if (this.muted) return
    const ctx = this.ensure()
    if (!ctx || !this.master) return
    const len = Math.floor(ctx.sampleRate * dur)
    const buf = ctx.createBuffer(1, len, ctx.sampleRate)
    const d = buf.getChannelData(0)
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2
    const src = ctx.createBufferSource()
    src.buffer = buf
    const f = ctx.createBiquadFilter()
    f.type = 'highpass'
    f.frequency.value = hp
    const g = ctx.createGain()
    g.gain.value = gain
    src.connect(f)
    f.connect(g)
    g.connect(this.master)
    src.start()
  }

  // ---- 语义音效：优先采样，缺素材时用合成补 ----
  pop() {
    if (this.play('pop', 0.9)) return
    this.tone(520 + Math.random() * 240, 0.09, 'sine', 0.45, 900)
  }
  coin() {
    if (this.play('score', 0.85, 1.05)) return
    this.tone(880, 0.07, 'triangle', 0.4)
    setTimeout(() => this.tone(1320, 0.1, 'triangle', 0.35), 60)
  }
  good() {
    if (this.play('score', 0.8)) return
    this.tone(660, 0.1, 'triangle', 0.4)
    setTimeout(() => this.tone(990, 0.14, 'triangle', 0.36), 90)
  }
  combo() {
    if (this.play('combo', 0.75)) return
    this.tone(784, 0.12, 'triangle', 0.38)
    setTimeout(() => this.tone(1175, 0.16, 'triangle', 0.3), 70)
  }
  slash() {
    this.noise(0.1, 0.32, 2200)
    if (this.play('hit', 0.6, 1.25)) return
    this.tone(300, 0.08, 'sawtooth', 0.18, 120)
  }
  hit() {
    if (this.play('hit', 0.9)) return
    this.noise(0.1, 0.55, 500)
    this.tone(140, 0.12, 'square', 0.25, 60)
  }
  jump() {
    this.tone(380, 0.12, 'sine', 0.3, 760)
  }
  fail() {
    if (this.play('miss', 0.85)) return
    this.tone(300, 0.2, 'sawtooth', 0.22, 110)
  }
  tick() {
    if (this.play('tick', 0.7)) return
    this.tone(1100, 0.035, 'square', 0.16)
  }
  whistle() {
    this.tone(1600, 0.18, 'sine', 0.2, 2100)
    setTimeout(() => this.tone(2100, 0.22, 'sine', 0.2, 1700), 170)
  }
  win() {
    if (this.play('win', 0.9)) return
    ;[523, 659, 784, 1047].forEach((f, i) => setTimeout(() => this.tone(f, 0.2, 'triangle', 0.35), i * 110))
  }
  lose() {
    if (this.play('miss', 0.9, 0.85)) return
    ;[440, 370, 294].forEach((f, i) => setTimeout(() => this.tone(f, 0.24, 'triangle', 0.3), i * 150))
  }
  fanfare() {
    if (this.play('fanfare', 0.85)) return
    this.win()
  }
  result(stars: number) {
    if (this.play('result', 0.8)) return
    if (stars >= 2) this.win()
    else this.good()
  }
  startSound() {
    if (this.play('start', 0.8)) return
    this.whistle()
  }
  click() {
    if (this.play('click', 0.6)) return
    this.tone(720, 0.05, 'triangle', 0.2)
  }
  drop() {
    if (this.play('drop', 0.8)) return
    this.tone(240, 0.1, 'sine', 0.28, 90)
  }
  tonePop(lane = 0) {
    this.tone(440 * Math.pow(2, lane / 5), 0.12, 'triangle', 0.4)
  }
  countdown(last = false) {
    if (this.play(last ? 'start' : 'tick', last ? 0.85 : 0.7)) return
    this.tone(last ? 880 : 520, last ? 0.3 : 0.12, 'square', 0.28)
  }

  // ---- 程序化 BGM：4 小节循环，轻快的木琴 + 低音 + 沙锤 ----
  startBgm() {
    const ctx = this.ensure()
    if (!ctx || !this.master || this.bgmOn || this.muted) return
    this.bgmOn = true
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, ctx.currentTime)
    g.gain.exponentialRampToValueAtTime(0.16, ctx.currentTime + 1.2)
    g.connect(this.master)
    this.bgmGain = g
    this.bgmStep = 0
    this.bgmNext = ctx.currentTime + 0.12
    this.scheduleBgm()
  }

  private scheduleBgm() {
    const ctx = this.ctx
    if (!ctx || !this.bgmOn || !this.bgmGain) return
    const stepDur = 60 / 112 / 2
    while (this.bgmNext < ctx.currentTime + 0.7) {
      this.bgmNote(this.bgmStep, this.bgmNext, stepDur)
      this.bgmNext += stepDur
      this.bgmStep = (this.bgmStep + 1) % 32
    }
    this.bgmTimer = window.setTimeout(() => this.scheduleBgm(), 220)
  }

  private bgmNote(step: number, time: number, stepDur: number) {
    const ctx = this.ctx
    const out = this.bgmGain
    if (!ctx || !out) return
    const bar = Math.floor(step / 8)
    const beat = step % 8
    const chord = PROG[bar % PROG.length]

    // 低音：每小节 1、5 拍
    if (beat === 0 || beat === 4) {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = 'sine'
      o.frequency.value = chord.bass
      g.gain.setValueAtTime(0.0001, time)
      g.gain.exponentialRampToValueAtTime(beat === 0 ? 0.5 : 0.34, time + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, time + stepDur * 2.4)
      o.connect(g)
      g.connect(out)
      o.start(time)
      o.stop(time + stepDur * 2.6)
    }

    // 木琴旋律：偶数拍走和弦音，音量轻
    if (beat % 2 === 0) {
      const idx = MELODY[(beat / 2 + bar) % MELODY.length]
      const f = chord.notes[idx % chord.notes.length] * 2
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = 'triangle'
      o.frequency.value = f
      g.gain.setValueAtTime(0.0001, time)
      g.gain.exponentialRampToValueAtTime(0.16, time + 0.008)
      g.gain.exponentialRampToValueAtTime(0.0001, time + stepDur * 1.6)
      o.connect(g)
      g.connect(out)
      o.start(time)
      o.stop(time + stepDur * 1.8)
    }

    // 沙锤：每拍一下，给节奏感
    if (beat % 2 === 1) {
      const len = Math.floor(ctx.sampleRate * 0.06)
      const buf = ctx.createBuffer(1, len, ctx.sampleRate)
      const d = buf.getChannelData(0)
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3
      const src = ctx.createBufferSource()
      src.buffer = buf
      const f = ctx.createBiquadFilter()
      f.type = 'highpass'
      f.frequency.value = 5200
      const g = ctx.createGain()
      g.gain.value = 0.1
      src.connect(f)
      f.connect(g)
      g.connect(out)
      src.start(time)
    }
  }

  stopBgm() {
    if (!this.bgmOn) return
    this.bgmOn = false
    clearTimeout(this.bgmTimer)
    const ctx = this.ctx
    const g = this.bgmGain
    this.bgmGain = null
    if (!ctx || !g) return
    g.gain.cancelScheduledValues(ctx.currentTime)
    g.gain.setValueAtTime(g.gain.value, ctx.currentTime)
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.4)
    setTimeout(() => g.disconnect(), 600)
  }

  setBgm(on: boolean) {
    if (on) this.startBgm()
    else this.stopBgm()
  }

  speak(text: string, rate = 1) {
    if (this.muted || !this.voiceOn) return
    const synth = window.speechSynthesis
    if (!synth) return
    try {
      synth.cancel()
      const u = new SpeechSynthesisUtterance(text)
      u.lang = 'zh-CN'
      u.rate = rate
      u.pitch = 1.15
      synth.speak(u)
    } catch {
      /* ignore */
    }
  }

  setVoice(on: boolean) {
    this.voiceOn = on
  }
  setMuted(m: boolean) {
    this.muted = m
    if (m) {
      window.speechSynthesis?.cancel()
      this.stopBgm()
    }
  }
}

export const audio = new AudioKit()
