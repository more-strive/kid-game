import type * as THREE_NS from 'three'
import type { LM } from './types'

/**
 * 详情页 3D 玩法示范：积木小人（球关节 + 圆柱四肢 + 椭球躯干），
 * 由 intro-pose 的 33 关键点驱动，零模型零素材。
 *
 * three.js 在本函数内部动态 import（独立 chunk，不进首屏；
 * 也不挂在 PlayView，避免与 MediaPipe 的 GPU 推理抢资源）。
 */

export interface IntroHandle {
  /** 推进动作时间并更新骨架（秒） */
  update(t: number): void
  render(): void
  resize(w: number, h: number): void
  dispose(): void
}

export interface IntroOpts {
  /** 游戏主题色（hex），每帧读取，切换游戏时自动跟随 */
  color: () => string
  /** 目标姿态（33 关键点，归一化坐标） */
  pose: (t: number) => LM[]
}

/** 关节球：关键点编号 / 半径 / 材质组 */
const JOINTS: Array<{ i: number; r: number; kind: 'head' | 'body' | 'hand' | 'foot' }> = [
  { i: 0, r: 0.125, kind: 'head' },
  { i: 11, r: 0.055, kind: 'body' },
  { i: 12, r: 0.055, kind: 'body' },
  { i: 13, r: 0.046, kind: 'body' },
  { i: 14, r: 0.046, kind: 'body' },
  { i: 15, r: 0.058, kind: 'hand' },
  { i: 16, r: 0.058, kind: 'hand' },
  { i: 23, r: 0.062, kind: 'body' },
  { i: 24, r: 0.062, kind: 'body' },
  { i: 25, r: 0.052, kind: 'body' },
  { i: 26, r: 0.052, kind: 'body' },
  { i: 27, r: 0.05, kind: 'foot' },
  { i: 28, r: 0.05, kind: 'foot' },
  { i: 31, r: 0.042, kind: 'foot' },
  { i: 32, r: 0.042, kind: 'foot' },
]

/** 肢体圆柱：[起点, 终点, 半径] */
const LIMBS: Array<[number, number, number]> = [
  [11, 13, 0.042],
  [13, 15, 0.038],
  [12, 14, 0.042],
  [14, 16, 0.038],
  [23, 25, 0.052],
  [25, 27, 0.046],
  [24, 26, 0.052],
  [26, 28, 0.046],
  [27, 31, 0.034],
  [28, 32, 0.034],
]

const UP = { x: 0, y: 1, z: 0 }

export async function createIntroScene(
  canvas: HTMLCanvasElement,
  opts: IntroOpts,
): Promise<IntroHandle | null> {
  const THREE = await import('three')
  let renderer: THREE_NS.WebGLRenderer
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true })
  } catch {
    return null // WebGL 不可用：调用方保持静态兜底图
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 20)
  scene.add(new THREE.HemisphereLight(0xffffff, 0xbcd8ff, 1.2))
  const sun = new THREE.DirectionalLight(0xffffff, 1.6)
  sun.position.set(2, 3, 4)
  scene.add(sun)

  const matHead = new THREE.MeshStandardMaterial({ color: 0xffd9b5, roughness: 0.85 })
  const matBody = new THREE.MeshStandardMaterial({ color: 0x7aa7ff, roughness: 0.85 })
  const matHand = new THREE.MeshStandardMaterial({ color: 0x4a5a9e, roughness: 0.85 })
  const matFoot = new THREE.MeshStandardMaterial({ color: 0x4a5a9e, roughness: 0.85 })
  const matOf = (kind: string) =>
    kind === 'head' ? matHead : kind === 'hand' ? matHand : kind === 'foot' ? matFoot : matBody

  const sphereGeo = new THREE.SphereGeometry(1, 18, 14)
  const cylGeo = new THREE.CylinderGeometry(1, 1, 1, 10)

  const group = new THREE.Group()
  scene.add(group)

  const jointMesh = new Map<number, THREE_NS.Mesh>()
  for (const j of JOINTS) {
    const m = new THREE.Mesh(sphereGeo, matOf(j.kind))
    m.scale.setScalar(j.r)
    group.add(m)
    jointMesh.set(j.i, m)
  }

  const limbMeshes: Array<{ mesh: THREE_NS.Mesh; a: number; b: number; r: number }> = []
  for (const [a, b, r] of LIMBS) {
    const m = new THREE.Mesh(cylGeo, matBody)
    group.add(m)
    limbMeshes.push({ mesh: m, a, b, r })
  }

  // 躯干：椭球，两端贴合肩心/髋心
  const torso = new THREE.Mesh(sphereGeo, matBody)
  group.add(torso)

  // 地面柔影
  const blobMat = new THREE.MeshBasicMaterial({ color: 0x24355e, transparent: true, opacity: 0.12 })
  const blob = new THREE.Mesh(new THREE.CircleGeometry(1, 28), blobMat)
  blob.rotation.x = -Math.PI / 2
  blob.position.y = -1.22
  blob.scale.set(0.85, 1, 0.4)
  scene.add(blob)

  // 归一化坐标 → 世界坐标（y 向下翻转为 y 向上）
  const W = 3
  const cur = new Map<number, THREE_NS.Vector3>()
  for (const j of JOINTS) cur.set(j.i, new THREE.Vector3())
  const tmp = new THREE.Vector3()
  const dir = new THREE.Vector3()
  const yAxis = new THREE.Vector3(UP.x, UP.y, UP.z)

  let lastT = -1
  let lastColor = ''
  let colorDirty = true

  const applyColor = () => {
    const c = opts.color()
    if (c === lastColor && !colorDirty) return
    lastColor = c
    colorDirty = false
    // 游戏主色通常较饱和，往白偏一点更像玩具
    matBody.color.set(c).lerp(new THREE.Color(1, 1, 1), 0.3)
  }

  const update = (t: number) => {
    applyColor()
    const lms = opts.pose(t)
    const dt = lastT < 0 ? 0.016 : Math.min(0.05, Math.max(0.001, t - lastT))
    lastT = t
    const k = 1 - Math.exp(-dt * 14) // 指数平滑，与体感引擎一致
    for (const j of JOINTS) {
      const lm = lms[j.i]
      tmp.set((lm.x - 0.5) * W, (0.55 - lm.y) * W, lm.z * W * 0.6)
      const v = cur.get(j.i)!
      v.lerp(tmp, k)
      jointMesh.get(j.i)!.position.copy(v)
    }
    for (const l of limbMeshes) {
      const pa = cur.get(l.a)!
      const pb = cur.get(l.b)!
      dir.subVectors(pb, pa)
      const len = Math.max(dir.length(), 0.01)
      l.mesh.position.copy(pa).addScaledVector(dir, 0.5)
      l.mesh.quaternion.setFromUnitVectors(yAxis, dir.divideScalar(len))
      l.mesh.scale.set(l.r, len, l.r)
    }
    // 躯干：肩心中点 → 髋心中点
    const ls = cur.get(11)!
    const rs = cur.get(12)!
    const lh = cur.get(23)!
    const rh = cur.get(24)!
    const top = tmp.clone().addVectors(ls, rs).multiplyScalar(0.5)
    const bottom = new THREE.Vector3().addVectors(lh, rh).multiplyScalar(0.5)
    const mid = top.clone().add(bottom).multiplyScalar(0.5)
    dir.subVectors(bottom, top)
    const h = Math.max(dir.length(), 0.01)
    torso.position.copy(mid)
    torso.quaternion.setFromUnitVectors(yAxis, dir.divideScalar(h))
    torso.scale.set(0.17, h * 0.52, 0.12)
  }

  let clockT = 0
  const render = () => {
    clockT = lastT < 0 ? 0 : lastT
    // 轻微环绕视角，强调立体感
    camera.position.set(0.55 * Math.sin(clockT * 0.32), 0.55, 3.35)
    camera.lookAt(0, -0.05, 0)
    renderer.render(scene, camera)
  }

  const resize = (w: number, h: number) => {
    if (w <= 0 || h <= 0) return
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }

  const dispose = () => {
    scene.traverse((o) => {
      const m = o as THREE_NS.Mesh
      if (m.geometry) m.geometry.dispose()
    })
    sphereGeo.dispose()
    cylGeo.dispose()
    matHead.dispose()
    matBody.dispose()
    matHand.dispose()
    matFoot.dispose()
    blobMat.dispose()
    renderer.dispose()
  }

  return { update, render, resize, dispose }
}
