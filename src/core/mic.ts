/**
 * 麦克风音量检测（吹气/喊话类游戏用）：
 * getUserMedia + AnalyserNode 取时域数据算 RMS，减噪声底后归一到 0~1。
 *
 * 站点语义对照：站点框架的 `e.mic` 为 0~1 音量黑盒；本实现的量纲为「RMS − 噪声底」× 增益，
 * 吹麦克风（气流冲击拾音器）RMS 通常 0.2~0.6，正常说话 0.05~0.2，安静环境 <0.02——
 * 阈值沿用各游戏报告里的站点字面量，量纲需真机校准（见各游戏文件头）。
 *
 * 纯增量：不请求权限就不启动（只有用到 mic 的游戏会在工厂里调 ensure()），不影响现有游戏。
 */
export class MicKit {
  private stream: MediaStream | null = null
  private audioCtx: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private buf: Float32Array<ArrayBuffer> | null = null

  /** 权限已授予且采样中 */
  ready = false
  /** 归一化音量 0~1（EMA 平滑，减噪声底） */
  level = 0
  /** 原始 RMS（未减底、未平滑） */
  raw = 0
  /** 噪声底：启动校准期的最大 RMS（安静环境的吹进来的风扇/房间噪声） */
  floor = 0.012
  private calibLeft = 0

  /** 请求麦克风权限并开始采样；已启动时直接返回。失败返回 false（游戏侧降级提示） */
  async ensure(): Promise<boolean> {
    if (this.ready) return true
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      })
      this.audioCtx = new AudioContext()
      const src = this.audioCtx.createMediaStreamSource(this.stream)
      this.analyser = this.audioCtx.createAnalyser()
      this.analyser.fftSize = 1024
      src.connect(this.analyser)
      this.buf = new Float32Array(this.analyser.fftSize)
      this.ready = true
      this.calibLeft = 1.2 // 启动校准 1.2s：取最大 RMS 当噪声底
      return true
    } catch {
      this.ready = false
      return false
    }
  }

  /** 每帧调用（引擎循环驱动）：读 RMS → 平滑 */
  update(dt: number) {
    if (!this.ready || !this.analyser || !this.buf) return
    this.analyser.getFloatTimeDomainData(this.buf)
    let sum = 0
    for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i]
    this.raw = Math.sqrt(sum / this.buf.length)
    // 启动校准：噪声底 = 校准期观测到的最大 RMS（吹气一般在校准结束后才开始）
    if (this.calibLeft > 0) {
      this.calibLeft -= dt
      this.floor = Math.max(this.floor, this.raw)
      this.level = 0
      return
    }
    const target = clamp((this.raw - this.floor) * 6, 0, 1)
    this.level += (target - this.level) * Math.min(1, dt * 12)
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.audioCtx?.close().catch(() => undefined)
    this.audioCtx = null
    this.analyser = null
    this.ready = false
    this.level = 0
    this.raw = 0
  }
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)

export const mic = new MicKit()
