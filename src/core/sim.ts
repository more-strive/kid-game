import type { Body, LM } from './types'

/**
 * 虚拟人体：不接摄像头也能演示/调试。
 * 生成 MediaPipe Pose 的 33 个关键点（归一化坐标）。
 */
const IDLE = 0.5

function P(x: number, y: number, v = 1): LM {
  return { x, y, z: 0, visibility: v }
}

export interface SimPose {
  lm: LM[]
  /** 用于游戏演示的动作提示 */
  action: 'wave' | 'jump' | 'squat' | 'arms' | 'tpose' | 'idle'
}

export function simPose(t: number, variant = 0): SimPose {
  const phase = t * 0.001
  const wob = Math.sin(phase * 1.1 + variant) * 0.006
  // 每 6 秒一个循环：挥手 → 跳 → 蹲 → 举手
  const cycle = (phase + variant * 2.3) % 9
  let action: SimPose['action'] = 'idle'
  if (cycle < 2.6) action = 'wave'
  else if (cycle < 4.1) action = 'jump'
  else if (cycle < 5.6) action = 'squat'
  else if (cycle < 7) action = 'arms'
  else action = 'tpose'

  const jumpK = action === 'jump' ? Math.max(0, Math.sin((cycle - 3) * Math.PI * 1.6)) : 0
  const squatK = action === 'squat' ? (Math.sin((cycle - 4.6) * Math.PI * 0.9) + 1) / 2 : 0

  const baseX = variant === 0 ? 0.5 : 0.72
  const lift = jumpK * 0.13
  const drop = squatK * 0.1
  const dy = -lift + drop + wob

  const cx = baseX
  const headY = 0.205 + dy
  const shY = 0.305 + dy
  const hipY = 0.53 + dy
  const kneeY = 0.71 + dy + drop * 0.35
  const ankleY = 0.9 + dy - lift * 0.35

  const shX = 0.055
  const hipX = 0.042
  const kneeX = 0.05 + (action === 'squat' ? 0.04 : 0)

  const wave = action === 'wave' ? Math.sin(phase * 7) : 0
  const armsUpK = action === 'arms' ? 1 : 0.0

  // 左右（玩家自身）手腕位置
  // 举手：腕高于肩
  const lw = {
    x: cx - shX - 0.055 - armsUpK * 0.02 + wave * 0.03,
    y: shY + 0.14 - armsUpK * 0.29 - wave * 0.02,
  }
  const rw = {
    x: cx + shX + 0.055 + armsUpK * 0.02 - wave * 0.03,
    y: shY + 0.14 - armsUpK * 0.29 + wave * 0.02,
  }
  // 木头人/挥手时抬高右手
  if (action === 'wave') {
    rw.y = shY - 0.06 + wave * 0.05
    rw.x = cx + shX + 0.1 + wave * 0.07
  }
  if (action === 'jump') {
    lw.y = shY - 0.02 - jumpK * 0.12
    rw.y = shY - 0.02 - jumpK * 0.12
  }
  if (action === 'tpose') {
    lw.x = cx - 0.3
    lw.y = shY
    rw.x = cx + 0.3
    rw.y = shY
  }

  const lm: LM[] = Array.from({ length: 33 }, () => P(0.5, 0.5, 0))
  lm[0] = P(cx, headY, 1) // nose
  lm[1] = P(cx - 0.018, headY - 0.03, 1)
  lm[2] = P(cx, headY - 0.045, 1)
  lm[3] = P(cx + 0.018, headY - 0.03, 1)
  lm[4] = P(cx - 0.03, headY - 0.005, 1)
  lm[5] = P(cx + 0.03, headY - 0.005, 1)
  lm[6] = P(cx - 0.038, headY + 0.005, 1)
  lm[7] = P(cx + 0.038, headY + 0.005, 1)
  lm[8] = P(cx - 0.03, headY - 0.09, 1)
  lm[9] = P(cx + 0.03, headY - 0.09, 1)
  lm[10] = P(cx - 0.04, headY - 0.1, 1)
  lm[11] = P(cx - shX, shY, 1)
  lm[12] = P(cx + shX, shY, 1)
  const mid = (a: { x: number; y: number }, b: { x: number; y: number }) => ({
    x: (a.x + b.x) / 2 + 0.012,
    y: (a.y + b.y) / 2 + 0.012,
  })
  const le = mid(lm[11], lw)
  const re = mid(lm[12], rw)
  lm[13] = P(le.x, le.y, 1)
  lm[14] = P(re.x, re.y, 1)
  lm[15] = P(lw.x, lw.y, 1)
  lm[16] = P(rw.x, rw.y, 1)
  lm[17] = P(lw.x, lw.y + 0.01, 1)
  lm[18] = P(rw.x, rw.y + 0.01, 1)
  lm[19] = P(lw.x, lw.y + 0.02, 1)
  lm[20] = P(rw.x, rw.y + 0.02, 1)
  lm[21] = P(lw.x, lw.y + 0.025, 1)
  lm[22] = P(rw.x, rw.y + 0.025, 1)
  lm[23] = P(cx - hipX, hipY, 1)
  lm[24] = P(cx + hipX, hipY, 1)
  lm[25] = P(cx - kneeX, kneeY, 1)
  lm[26] = P(cx + kneeX, kneeY, 1)
  lm[27] = P(cx - hipX - 0.01, ankleY, 1)
  lm[28] = P(cx + hipX + 0.01, ankleY, 1)
  lm[29] = P(cx - hipX - 0.01, ankleY + 0.03, 1)
  lm[30] = P(cx + hipX + 0.01, ankleY + 0.03, 1)
  lm[31] = P(cx - hipX - 0.01, ankleY + 0.045, 1)
  lm[32] = P(cx + hipX + 0.01, ankleY + 0.045, 1)
  return { lm, action }
}

/** 由关键点构建一份最小 Body（复用 PoseTracker 的计算逻辑不划算，这里独立算） */
export function buildSimBody(lm: LM[], id: number): Body {
  const pt = (i: number) => ({ x: lm[i].x, y: lm[i].y })
  const lShoulder = pt(11)
  const rShoulder = pt(12)
  const lHip = pt(23)
  const rHip = pt(24)
  const shoulderC = { x: (lShoulder.x + rShoulder.x) / 2, y: (lShoulder.y + rShoulder.y) / 2 }
  const hipC = { x: (lHip.x + rHip.x) / 2, y: (lHip.y + rHip.y) / 2 }
  const lHand = pt(15)
  const rHand = pt(16)
  const lFoot = pt(27)
  const rFoot = pt(28)
  const head = pt(0)
  return {
    id,
    visible: true,
    lm,
    lHand,
    rHand,
    lElbow: pt(13),
    rElbow: pt(14),
    lShoulder,
    rShoulder,
    lHip,
    rHip,
    lKnee: pt(25),
    rKnee: pt(26),
    lFoot,
    rFoot,
    head,
    shoulderC,
    hipC,
    center: { x: (shoulderC.x + hipC.x) / 2, y: (shoulderC.y + hipC.y) / 2 },
    scale: Math.max(0.14, Math.hypot(shoulderC.x - hipC.x, shoulderC.y - hipC.y) * 2.1),
    lHandV: 0,
    rHandV: 0,
    hipV: 0,
    armsUp: lHand.y < shoulderC.y - 0.015 && rHand.y < shoulderC.y - 0.015,
    squat: false,
    jumping: false,
    feetSpread: Math.abs(lFoot.x - rFoot.x),
    lHandAboveHead: lHand.y < head.y,
    rHandAboveHead: rHand.y < head.y,
  }
}

export const SIM_IDLE = IDLE
