import {
  FilesetResolver,
  PoseLandmarker,
  type PoseLandmarkerResult,
} from '@mediapipe/tasks-vision'
import type { Body, LM, PoseFrame, Pt } from './types'
import { buildSimBody, simPose } from './sim'

const P = {
  nose: 0,
  lShoulder: 11,
  rShoulder: 12,
  lElbow: 13,
  rElbow: 14,
  lWrist: 15,
  rWrist: 16,
  lHip: 23,
  rHip: 24,
  lKnee: 25,
  rKnee: 26,
  lAnkle: 27,
  rAnkle: 28,
} as const

const SMOOTH = 0.45

function dist(a: Pt, b: Pt) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function angle(a: Pt, b: Pt, c: Pt) {
  const v1 = { x: a.x - b.x, y: a.y - b.y }
  const v2 = { x: c.x - b.x, y: c.y - b.y }
  const d = v1.x * v2.x + v1.y * v2.y
  const m = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y) || 1
  return (Math.acos(Math.max(-1, Math.min(1, d / m))) * 180) / Math.PI
}

interface Track {
  lm: LM[]
  t: number
  footBase: number
  hipBase: number
}

export class PoseTracker {
  landmarker: PoseLandmarker | null = null
  video: HTMLVideoElement | null = null
  stream: MediaStream | null = null
  lastTs = -1
  tracks = new Map<number, Track>()
  ready = false
  error = ''
  mirrored = true
  numPoses = 2
  fps = 0
  simulate = false
  private simPrev = new Map<number, { lm: LM[]; t: number }>()
  private fpsT = 0
  private fpsN = 0

  async init() {
    const fileset = await FilesetResolver.forVisionTasks('/wasm')
    const opts = (delegate: 'GPU' | 'CPU') => ({
      baseOptions: { modelAssetPath: '/models/pose_landmarker_lite.task', delegate },
      runningMode: 'VIDEO' as const,
      numPoses: this.numPoses,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.45,
    })
    try {
      this.landmarker = await PoseLandmarker.createFromOptions(fileset, opts('GPU'))
    } catch (e: any) {
      // 模型文件损坏（未下载完整 / 被截断）时，换 CPU 也救不回来，直接给可读的提示
      const raw = String(e?.message ?? e)
      if (/zip archive|Initialize was not ok|StartGraph failed/i.test(raw)) {
        throw new Error(
          '姿态模型文件损坏（多半是下载不完整），请重新下载 public/models/pose_landmarker_lite.task',
        )
      }
      this.landmarker = await PoseLandmarker.createFromOptions(fileset, opts('CPU'))
    }
    this.ready = true
  }

  async openCamera(video: HTMLVideoElement) {
    this.video = video
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: false,
    })
    video.srcObject = this.stream
    await video.play()
    await new Promise<void>((r) => {
      if (video.videoWidth) return r()
      video.onloadedmetadata = () => r()
    })
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.tracks.clear()
  }

  close() {
    this.stop()
    this.landmarker?.close()
    this.landmarker = null
    this.ready = false
  }

  private simLast = 0

  private detectSim(now: number): PoseFrame {
    const dt = this.simLast ? Math.min(0.05, (now - this.simLast) / 1000) : 1 / 30
    this.simLast = now
    const bodies: Body[] = []
    for (let i = 0; i < 1; i++) {
      const { lm } = simPose(now, i)
      const b = buildSimBody(lm, i)
      const prev = this.simPrev.get(i)
      if (prev) {
        const pdt = Math.max(0.016, (now - prev.t) / 1000)
        b.lHandV = Math.hypot(lm[15].x - prev.lm[15].x, lm[15].y - prev.lm[15].y) / pdt
        b.rHandV = Math.hypot(lm[16].x - prev.lm[16].x, lm[16].y - prev.lm[16].y) / pdt
        b.hipV = (b.hipC.y - (prev.lm[23].y + prev.lm[24].y) / 2) / pdt
      }
      this.simPrev.set(i, { lm, t: now })
      b.jumping = Math.min(b.lFoot.y, b.rFoot.y) < 0.876
      b.squat = b.hipC.y > 0.567
      bodies.push(b)
    }
    return { t: now, dt, bodies }
  }

  detect(now: number): PoseFrame {
    if (this.simulate) return this.detectSim(now)
    const v = this.video
    if (!v || !this.landmarker || v.readyState < 2) {
      return { t: now, dt: 0, bodies: [] }
    }
    this.fpsN++
    if (now - this.fpsT > 700) {
      this.fps = Math.round((this.fpsN * 1000) / (now - this.fpsT))
      this.fpsT = now
      this.fpsN = 0
    }
    const ts = Math.max(now, this.lastTs + 1)
    this.lastTs = ts
    let res: PoseLandmarkerResult
    try {
      res = this.landmarker.detectForVideo(v, ts)
    } catch {
      return { t: now, dt: 0, bodies: [] }
    }
    const bodies: Body[] = []
    const seen = new Set<number>()

    // 摄像头画面按 16:9 cover 显示，坐标同步做裁剪换算
    const vw = v.videoWidth || 1280
    const vh = v.videoHeight || 720
    const aspect = 16 / 9
    let fx = 1
    let fy = 1
    let ox = 0
    let oy = 0
    if (vw / vh > aspect) {
      fx = (vh * aspect) / vw
      ox = (1 - fx) / 2
    } else {
      fy = (vw / aspect) / vh
      oy = (1 - fy) / 2
    }

    res.landmarks.forEach((raw, i) => {
      const key = i
      seen.add(key)
      const prev = this.tracks.get(key)
      // 1. cover 裁剪 + 镜像 + 平滑
      const lm: LM[] = raw.map((p, idx) => {
        const nx = (p.x - ox) / fx
        const ny = (p.y - oy) / fy
        const x = this.mirrored ? 1 - nx : nx
        const q = prev?.lm[idx]
        if (!q) return { x, y: ny, z: p.z, visibility: p.visibility ?? 1 }
        return {
          x: q.x + (x - q.x) * SMOOTH,
          y: q.y + (ny - q.y) * SMOOTH,
          z: p.z,
          visibility: p.visibility ?? 1,
        }
      })
      const pt = (idx: number): Pt => ({ x: lm[idx].x, y: lm[idx].y })
      const lShoulder = pt(P.lShoulder)
      const rShoulder = pt(P.rShoulder)
      const lHip = pt(P.lHip)
      const rHip = pt(P.rHip)
      const lHand = pt(P.lWrist)
      const rHand = pt(P.rWrist)
      const shoulderC = { x: (lShoulder.x + rShoulder.x) / 2, y: (lShoulder.y + rShoulder.y) / 2 }
      const hipC = { x: (lHip.x + rHip.x) / 2, y: (lHip.y + rHip.y) / 2 }
      const lFoot = pt(P.lAnkle)
      const rFoot = pt(P.rAnkle)
      const head = pt(P.nose)
      const scale = Math.max(0.14, dist(shoulderC, hipC) * 2.1)

      // 2. 速度
      let lHandV = 0
      let rHandV = 0
      let hipV = 0
      if (prev) {
        const pdt = Math.max(0.016, (now - prev.t) / 1000)
        lHandV = dist(lHand, { x: prev.lm[P.lWrist].x, y: prev.lm[P.lWrist].y }) / pdt
        rHandV = dist(rHand, { x: prev.lm[P.rWrist].x, y: prev.lm[P.rWrist].y }) / pdt
        const ph = (prev.lm[P.lHip].y + prev.lm[P.rHip].y) / 2
        hipV = (hipC.y - ph) / pdt
      }

      // 3. 基准线（用于跳/蹲判断）
      const footY = Math.max(lFoot.y, rFoot.y)
      const footBase = prev ? Math.max(prev.footBase * 0.995, footY) : footY
      const hipBase = prev ? prev.hipBase * 0.97 + hipC.y * 0.03 : hipC.y

      this.tracks.set(key, { lm, t: now, footBase, hipBase })

      const kneeAvg = (angle(lHip, pt(P.lKnee), lFoot) + angle(rHip, pt(P.rKnee), rFoot)) / 2
      const armsUp = lHand.y < shoulderC.y - 0.015 && rHand.y < shoulderC.y - 0.015
      const squat = kneeAvg < 133 || hipC.y > hipBase + 0.07
      const jumping = Math.min(lFoot.y, rFoot.y) < footBase - 0.05 * (scale / 0.5)

      bodies.push({
        id: i,
        visible: true,
        lm,
        lHand,
        rHand,
        lElbow: pt(P.lElbow),
        rElbow: pt(P.rElbow),
        lShoulder,
        rShoulder,
        lHip,
        rHip,
        lKnee: pt(P.lKnee),
        rKnee: pt(P.rKnee),
        lFoot,
        rFoot,
        head,
        shoulderC,
        hipC,
        center: { x: (shoulderC.x + hipC.x) / 2, y: (shoulderC.y + hipC.y) / 2 },
        scale,
        lHandV,
        rHandV,
        hipV,
        armsUp,
        squat,
        jumping,
        feetSpread: Math.abs(lFoot.x - rFoot.x),
        lHandAboveHead: lHand.y < head.y,
        rHandAboveHead: rHand.y < head.y,
      })
    })

    for (const k of [...this.tracks.keys()]) if (!seen.has(k)) this.tracks.delete(k)
    bodies.sort((a, b) => a.center.x - b.center.x)
    bodies.forEach((b, i) => (b.id = i))
    return { t: now, dt: 1 / 30, bodies }
  }
}

/** 全局复用同一个识别器，避免每次进游戏重新加载模型 */
export const tracker = new PoseTracker()
