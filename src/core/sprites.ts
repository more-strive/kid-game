/**
 * 游戏素材贴图：道具（public/icons/items）与游戏图标（public/icons/games）
 * 来源 OpenMoji（CC BY-SA 4.0），本地打包，离线可用
 * 未加载完成时返回 null，调用方回退到 canvas 矢量绘制，保证首帧不空
 */
const cache = new Map<string, HTMLImageElement>()
const failed = new Set<string>()

function base() {
  return import.meta.env.BASE_URL || '/'
}

function load(key: string, url: string): HTMLImageElement | null {
  if (failed.has(key)) return null
  let img = cache.get(key)
  if (!img) {
    img = new Image()
    img.onerror = () => failed.add(key)
    img.src = url
    cache.set(key, img)
  }
  return img.complete && img.naturalWidth > 0 ? img : null
}

export function item(name: string): HTMLImageElement | null {
  if (!name) return null
  return load(`item:${name}`, `${base()}icons/items/${name}.svg`)
}

export function gameIcon(slug: string): HTMLImageElement | null {
  if (!slug) return null
  return load(`game:${slug}`, `${base()}icons/games/${slug}.svg`)
}

export function preloadItems(names: string[]) {
  for (const n of names) item(n)
}

function blit(
  c: CanvasRenderingContext2D,
  pic: HTMLImageElement,
  x: number,
  y: number,
  size: number,
  rotate: number,
) {
  c.save()
  if (rotate) {
    c.translate(x, y)
    c.rotate(rotate)
    c.drawImage(pic, -size / 2, -size / 2, size, size)
  } else {
    c.drawImage(pic, x - size / 2, y - size / 2, size, size)
  }
  c.restore()
}

/** 在 (x,y) 处以 size 为边长绘制道具，未就绪返回 false */
export function drawItem(
  c: CanvasRenderingContext2D,
  name: string,
  x: number,
  y: number,
  size: number,
  rotate = 0,
): boolean {
  const pic = item(name)
  if (!pic) return false
  blit(c, pic, x, y, size, rotate)
  return true
}

/** 绘制某个游戏的图标素材，未就绪返回 false */
export function drawGameIcon(
  c: CanvasRenderingContext2D,
  slug: string,
  x: number,
  y: number,
  size: number,
  rotate = 0,
): boolean {
  const pic = gameIcon(slug)
  if (!pic) return false
  blit(c, pic, x, y, size, rotate)
  return true
}
