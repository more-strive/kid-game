export interface Pt {
  x: number
  y: number
}

export interface LM {
  x: number
  y: number
  z: number
  visibility: number
}

/** 一帧里单个玩家的姿态（坐标已镜像成“屏幕坐标”，0~1） */
export interface Body {
  id: number
  visible: boolean
  lm: LM[]
  /** 屏幕左/右手（玩家自己的右手会出现在屏幕左侧） */
  lHand: Pt
  rHand: Pt
  lElbow: Pt
  rElbow: Pt
  lShoulder: Pt
  rShoulder: Pt
  lHip: Pt
  rHip: Pt
  lKnee: Pt
  rKnee: Pt
  lFoot: Pt
  rFoot: Pt
  head: Pt
  shoulderC: Pt
  hipC: Pt
  center: Pt
  /** 肩到踝的距离，用作尺度单位 */
  scale: number
  /** 帧间移动速度（归一化单位/秒），缺失时按屏幕像素感受换算 */
  lHandV: number
  rHandV: number
  hipV: number
  /** 派生动作 */
  armsUp: boolean
  squat: boolean
  jumping: boolean
  feetSpread: number
  lHandAboveHead: boolean
  rHandAboveHead: boolean
  /** 手部检测（屏幕左/右手；仅 enableHands 的游戏有值） */
  lHandDet?: HandDet
  rHandDet?: HandDet
  /** 脸部表情（仅 enableFace 的游戏有值） */
  face?: FaceState
}

/** 单只手的检测结果（HandLandmarker，仅 enableHands 的游戏有值） */
export interface HandDet {
  /** 食指尖（屏幕坐标，已镜像） */
  index: Pt
  /** 拇指尖 */
  thumb: Pt
  /** 掌心（腕 + 四指根的平均） */
  palm: Pt
  /** 捏合度：拇指尖-食指尖距离 ÷ 手长（0=捏死，>1=张开） */
  pinch: number
  /** 伸直手指数 0~4（四指，不含拇指；按「指尖离腕 > 指关节离腕」判定，旋转不敏感） */
  fingers: number
}

/** 脸部表情状态（FaceLandmarker blendShapes，仅 enableFace 的游戏有值，全部 0~1） */
export interface FaceState {
  /** 张嘴（jawOpen） */
  jaw: number
  blinkL: number
  blinkR: number
  /** 鼓腮（cheekPuff） */
  puff: number
  /** 嘟嘴（mouthPucker） */
  pucker: number
  /** 微笑（mouthSmileLeft/Right 均值） */
  smile: number
  /** 挑眉（browInnerUp） */
  browUp: number
  /** 皱眉（browDownLeft/Right 均值） */
  browDown: number
}

export interface PoseFrame {
  t: number
  dt: number
  bodies: Body[]
}

export type Mode = 'solo' | 'versus' | 'coop'

export interface HudSnapshot {
  score: number
  best: number
  combo: number
  timeLeft: number
  progress: number
  stage: string
  running: boolean
  finished: boolean
  stars: number
  extra: Record<string, number>
}

export interface GameContext {
  w: number
  h: number
  meta: import('@/data/games').GameMeta
  audio: import('./audio').AudioKit
  hud: () => HudSnapshot
  setScore(n: number): void
  addScore(n: number): void
  setCombo(n: number): void
  setStage(s: string): void
  setExtra(k: string, v: number): void
  speak(text: string): void
  finish(): void
  /** 难度档位 0/1/2，对应拿星标准的三个档 */
  difficulty: number
  /** 局内热力 0~1：随游戏时长线性爬升（站点由宿主黑盒维护，按「局内进度」推断口径对齐） */
  readonly heat: number
  /** 麦克风音量检测（吹气/喊话类游戏用）：工厂里调 mic.ensure()，帧循环读 mic.level（0~1） */
  mic: import('./mic').MicKit
  /** 启用手部检测（HandLandmarker）：Body.lHandDet/rHandDet 在模型就绪后生效 */
  enableHands(): Promise<void>
  /** 启用脸部表情（FaceLandmarker blendShapes）：Body.face 在模型就绪后生效 */
  enableFace(): Promise<void>
}

export interface Game {
  update(f: PoseFrame, dt: number): void
  draw(c: CanvasRenderingContext2D): void
  /** 场景装饰背景（public/bg/<name>.svg），只画在画面上下边缘，不挡摄像头 */
  bg?: string
  reset?(): void
  destroy?(): void
}

export interface GameFactory {
  (ctx: GameContext): Game
}
