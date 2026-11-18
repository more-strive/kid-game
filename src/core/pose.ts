import {
  FaceLandmarker,
  FilesetResolver,
  HandLandmarker,
  PoseLandmarker,
  type FaceLandmarkerResult,
  type HandLandmarkerResult,
  type PoseLandmarkerResult,
} from '@mediapipe/tasks-vision'
import type { Body, FaceState, HandDet, LM, PoseFrame, Pt } from './types'
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

/** 槽位匹配门限：与上一帧同一人的预测中心距离超过这个值就不认为是同一个人（归一化坐标） */
const MATCH_GATE = 0.18
/** 短暂丢帧时继续沿用上一次的骨架，避免编号在 0/1 之间抖动（毫秒，与 detect 的 now 同单位） */
const HOLD_T = 350
/** 超过这么久没再见到人，才释放槽位；期间回来仍算同一个人（毫秒） */
const SLOT_LOST = 1000
/** 槽位被新人顶替前的最短静默时间，防止误检槽位长期占位（毫秒） */
const STEAL_T = 300

/** 部署到子路径（GitHub Pages 的 /<repo>/）时，静态资源必须跟着 base 走 */
const BASE = import.meta.env.BASE_URL

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
  /** 平滑后的躯干中心，用于跨帧匹配 */
  cx: number
  cy: number
  /** 中心速度（归一化/秒），用于预测下一帧位置，孩子快速走动时匹配更稳 */
  vx: number
  vy: number
  /** 最近一次真正检测到的时刻 */
  seen: number
  /** 最近一次发布的骨架，短暂丢帧时补位用 */
  body?: Body
}

/** 一帧检测结果（已换算到屏幕坐标，未平滑） */
interface Det {
  lm: LM[]
  cx: number
  cy: number
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
  /** 手部/脸部检测：游戏通过 ctx.enableHands()/enableFace() 按需开启（纯增量，不影响未开启的游戏） */
  handsOn = false
  faceOn = false
  handsReady = false
  faceReady = false
  private handLm: HandLandmarker | null = null
  private faceLm: FaceLandmarker | null = null
  private simPrev = new Map<number, { lm: LM[]; t: number }>()
  private fpsT = 0
  private fpsN = 0

  async init() {
    const fileset = await FilesetResolver.forVisionTasks(`${BASE}wasm`)
    const opts = (delegate: 'GPU' | 'CPU') => ({
      baseOptions: { modelAssetPath: `${BASE}models/pose_landmarker_lite.task`, delegate },
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

  /** 惰性创建手部识别器（模型 public/models/hand_landmarker.task） */
  async enableHands() {
    this.handsOn = true
    if (this.handsReady || !this.ready) return
    const fileset = await FilesetResolver.forVisionTasks(`${BASE}wasm`)
    const opts = (delegate: 'GPU' | 'CPU') => ({
      baseOptions: { modelAssetPath: `${BASE}models/hand_landmarker.task`, delegate },
      runningMode: 'VIDEO' as const,
      numHands: 4, // 双人 × 双手
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.45,
    })
    try {
      this.handLm = await HandLandmarker.createFromOptions(fileset, opts('GPU'))
    } catch {
      this.handLm = await HandLandmarker.createFromOptions(fileset, opts('CPU'))
    }
    this.handsReady = true
  }

  /** 惰性创建脸部识别器（模型 public/models/face_landmarker.task，输出 blendShapes） */
  async enableFace() {
    this.faceOn = true
    if (this.faceReady || !this.ready) return
    const fileset = await FilesetResolver.forVisionTasks(`${BASE}wasm`)
    const opts = (delegate: 'GPU' | 'CPU') => ({
      baseOptions: { modelAssetPath: `${BASE}models/face_landmarker.task`, delegate },
      runningMode: 'VIDEO' as const,
      numFaces: 2,
      outputFaceBlendshapes: true,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
    })
    try {
      this.faceLm = await FaceLandmarker.createFromOptions(fileset, opts('GPU'))
    } catch {
      this.faceLm = await FaceLandmarker.createFromOptions(fileset, opts('CPU'))
    }
    this.faceReady = true
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
    this.handLm?.close()
    this.faceLm?.close()
    this.landmarker = null
    this.handLm = null
    this.faceLm = null
    this.ready = false
    this.handsReady = false
    this.faceReady = false
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

    // 一帧内先把所有骨架换算到屏幕坐标（cover 裁剪 + 镜像），先不平滑
    const dets: Det[] = res.landmarks.map((raw) => {
      const lm: LM[] = raw.map((p) => {
        const nx = (p.x - ox) / fx
        const ny = (p.y - oy) / fy
        const x = this.mirrored ? 1 - nx : nx
        return { x, y: ny, z: p.z, visibility: p.visibility ?? 1 }
      })
      return {
        lm,
        cx: (lm[P.lShoulder].x + lm[P.rShoulder].x + lm[P.lHip].x + lm[P.rHip].x) / 4,
        cy: (lm[P.lShoulder].y + lm[P.rShoulder].y + lm[P.lHip].y + lm[P.rHip].y) / 4,
      }
    })
    // 关键：编号跟着“人”走，不跟 MediaPipe 的返回顺序、也不再按 x 重排。
    // 否则两个孩子左右交叉一次，各游戏的分数/连击/进度就会瞬间串位。
    const assign = this.matchSlots(dets, now)
    const live = new Map<number, Body>()
    for (const [di, si] of assign) {
      const det = dets[di]
      const prev = this.tracks.get(si)
      // 平滑用同一槽位上一帧的骨架（按人平滑；混用别人的关键点会抖动、手速也会误判）
      const lm: LM[] = det.lm.map((p, idx) => {
        const q = prev?.lm[idx]
        if (!q) return p
        return {
          x: q.x + (p.x - q.x) * SMOOTH,
          y: q.y + (p.y - q.y) * SMOOTH,
          z: p.z,
          visibility: p.visibility,
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

      const kneeAvg = (angle(lHip, pt(P.lKnee), lFoot) + angle(rHip, pt(P.rKnee), rFoot)) / 2
      const armsUp = lHand.y < shoulderC.y - 0.015 && rHand.y < shoulderC.y - 0.015
      const squat = kneeAvg < 133 || hipC.y > hipBase + 0.07
      const jumping = Math.min(lFoot.y, rFoot.y) < footBase - 0.05 * (scale / 0.5)

      const body: Body = {
        id: si,
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
      }
      // 中心速度用于下一帧的预测位置；断帧太久就把速度清掉，避免预测飞出去
      const pdt = prev ? (now - prev.t) / 1000 : 0
      const fresh = !!prev && pdt > 0 && pdt < 0.25
      this.tracks.set(si, {
        lm,
        t: now,
        footBase,
        hipBase,
        cx: det.cx,
        cy: det.cy,
        vx: fresh ? (det.cx - prev!.cx) / Math.max(0.016, pdt) : 0,
        vy: fresh ? (det.cy - prev!.cy) / Math.max(0.016, pdt) : 0,
        seen: now,
        body,
      })
      live.set(si, body)
    }

    // 4. 掉帧补位 + 过期释放：短暂丢失（< HOLD_T）仍按原位置发布，
    //    免得一个人眨眼丢一帧就把另一个人的编号挤到 0；超过 SLOT_LOST 才真正放掉身份。
    for (const [si, tr] of [...this.tracks]) {
      const gone = now - tr.seen
      if (gone > SLOT_LOST) {
        this.tracks.delete(si)
        continue
      }
      if (!live.has(si) && gone <= HOLD_T && tr.body) live.set(si, tr.body)
    }

    // 5. 按槽位顺序发布：id 即阵位下标（与 syncPlayers / f.bodies[i] 的位置语义一致）
    for (let si = 0; si < this.numPoses; si++) {
      const b = live.get(si)
      if (!b) continue
      b.id = bodies.length
      bodies.push(b)
    }
    // 手部/脸部检测（按需开启；坐标用与姿态相同的 cover 裁剪 + 镜像换算）
    if (this.handsOn && this.handLm && bodies.length) {
      try {
        const hres = this.handLm.detectForVideo(v, ts)
        this.mergeHands(hres, bodies, fx, ox, fy, oy)
      } catch {
        // 单帧检测失败忽略
      }
    }
    if (this.faceOn && this.faceLm && bodies.length) {
      try {
        const fres = this.faceLm.detectForVideo(v, ts)
        this.mergeFace(fres, bodies, fx, ox, fy, oy)
      } catch {
        // 单帧检测失败忽略
      }
    }
    return { t: now, dt: 1 / 30, bodies }
  }

  /**
   * 把本帧检出的骨架分配给已有槽位（= 玩家编号）。
   * 用“上一帧中心 + 速度预测”做最近邻匹配，而不是按 x 排序：
   * 按 x 排序在两人交叉、或误检到第三个影子时会瞬间交换编号，各游戏按编号存的
   * 分数/连击/进度就会串到另一个人身上（站点框架给的是稳定席位，见 _reverse 里
   * players[i] + present 的用法）。
   */
  private matchSlots(dets: Det[], now: number) {
    const pair: { d: number; di: number; si: number }[] = []
    for (let di = 0; di < dets.length; di++) {
      for (const [si, tr] of this.tracks) {
        const dt = Math.min(0.25, Math.max(0, (now - tr.t) / 1000))
        const px = tr.cx + tr.vx * dt
        const py = tr.cy + tr.vy * dt
        const d = Math.hypot(dets[di].cx - px, dets[di].cy - py)
        if (d <= MATCH_GATE) pair.push({ d, di, si })
      }
    }
    pair.sort((a, b) => a.d - b.d)
    const out = new Map<number, number>()
    const usedDet = new Set<number>()
    const usedSlot = new Set<number>()
    for (const p of pair) {
      if (usedDet.has(p.di) || usedSlot.has(p.si)) continue
      out.set(p.di, p.si)
      usedDet.add(p.di)
      usedSlot.add(p.si)
    }
    // 没匹配上的是新人：优先空槽；槽满时顶替最久没见的（真实的人走了，别被幽灵槽位挡着）。
    // 同一帧同时出现两个新人时按 x 从左到右占槽，保持“0 号在左”的空间约定。
    const fresh = dets
      .map((d, di) => ({ di, x: d.cx }))
      .filter((v) => !usedDet.has(v.di))
      .sort((a, b) => a.x - b.x)
    for (const { di } of fresh) {
      let slot = -1
      for (let si = 0; si < this.numPoses; si++) {
        if (usedSlot.has(si) || this.tracks.has(si)) continue
        slot = si
        break
      }
      if (slot < 0) {
        let oldest = -1
        let age = STEAL_T
        for (let si = 0; si < this.numPoses; si++) {
          if (usedSlot.has(si)) continue
          const tr = this.tracks.get(si)
          if (!tr) continue
          if (now - tr.seen > age) {
            age = now - tr.seen
            oldest = si
          }
        }
        slot = oldest
      }
      if (slot < 0) continue
      this.tracks.delete(slot)
      out.set(di, slot)
      usedSlot.add(slot)
    }
    return out
  }

  /** 手 → 就近绑定到某玩家的屏幕左/右手（覆盖 lHandDet/rHandDet） */
  private mergeHands(res: HandLandmarkerResult, bodies: Body[], fx: number, ox: number, fy: number, oy: number) {
    const mir = (x: number) => (this.mirrored ? 1 - ((x - ox) / fx) : (x - ox) / fx)
    const my = (y: number) => (y - oy) / fy
    for (const lm of res.landmarks) {
      const wrist = { x: mir(lm[0].x), y: my(lm[0].y) }
      const det: HandDet = {
        index: { x: mir(lm[8].x), y: my(lm[8].y) },
        thumb: { x: mir(lm[4].x), y: my(lm[4].y) },
        palm: {
          x: (mir(lm[0].x) + mir(lm[5].x) + mir(lm[9].x) + mir(lm[13].x) + mir(lm[17].x)) / 5,
          y: (my(lm[0].y) + my(lm[5].y) + my(lm[9].y) + my(lm[13].y) + my(lm[17].y)) / 5,
        },
        pinch: dist({ x: lm[8].x, y: lm[8].y }, { x: lm[4].x, y: lm[4].y }) / Math.max(1e-3, dist({ x: lm[0].x, y: lm[0].y }, { x: lm[9].x, y: lm[9].y })),
        fingers: [
          [8, 6],
          [12, 10],
          [16, 14],
          [20, 18],
        ].filter(([tip, pip]) => dist({ x: lm[tip].x, y: lm[tip].y }, wrist) > dist({ x: lm[pip].x, y: lm[pip].y }, wrist)).length,
      }
      // 绑定到腕距最近的玩家
      let best: { b: Body; side: 0 | 1; d: number } | null = null
      for (const b of bodies) {
        const dl = dist(wrist, b.lHand)
        const dr = dist(wrist, b.rHand)
        const side: 0 | 1 = dl <= dr ? 0 : 1
        const d = Math.min(dl, dr)
        if (!best || d < best.d) best = { b, side, d }
      }
      if (best && best.d < 0.3) {
        if (best.side === 0) best.b.lHandDet = det
        else best.b.rHandDet = det
      }
    }
  }

  /** 脸 → 就近绑定到某玩家（覆盖 body.face） */
  private mergeFace(res: FaceLandmarkerResult, bodies: Body[], fx: number, ox: number, fy: number, oy: number) {
    const mir = (x: number) => (this.mirrored ? 1 - ((x - ox) / fx) : (x - ox) / fx)
    const my = (y: number) => (y - oy) / fy
    const cat = (list: { categoryName: string; score: number }[], name: string) => list.find((c) => c.categoryName === name)?.score ?? 0
    res.faceLandmarks.forEach((lm, fi) => {
      const nose = { x: mir(lm[1]?.x ?? 0.5), y: my(lm[1]?.y ?? 0.5) }
      let best: { b: Body; d: number } | null = null
      for (const b of bodies) {
        const d = dist(nose, b.center)
        if (!best || d < best.d) best = { b, d }
      }
      if (!best) return
      const shapes = res.faceBlendshapes?.[fi]?.categories ?? []
      const face: FaceState = {
        jaw: cat(shapes, 'jawOpen'),
        blinkL: cat(shapes, 'eyeBlinkLeft'),
        blinkR: cat(shapes, 'eyeBlinkRight'),
        puff: cat(shapes, 'cheekPuff'),
        pucker: cat(shapes, 'mouthPucker'),
        smile: (cat(shapes, 'mouthSmileLeft') + cat(shapes, 'mouthSmileRight')) / 2,
        browUp: cat(shapes, 'browInnerUp'),
        browDown: (cat(shapes, 'browDownLeft') + cat(shapes, 'browDownRight')) / 2,
      }
      best.b.face = face
    })
  }
}

/** 全局复用同一个识别器，避免每次进游戏重新加载模型 */
export const tracker = new PoseTracker()
