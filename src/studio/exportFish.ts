import { MAX_ART_BYTES, MAX_ART_EDGE, MIN_ART_PIXELS } from '../../shared/domain'

export interface ArtworkBounds {
  x: number
  y: number
  width: number
  height: number
}

export function getArtworkBounds(pixels: ArrayLike<number>, width: number, height: number): ArtworkBounds | null {
  let left = width
  let top = height
  let right = -1
  let bottom = -1
  let painted = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!pixels[(y * width + x) * 4 + 3]) continue
      painted++
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x)
      bottom = Math.max(bottom, y)
    }
  }
  if (painted < MIN_ART_PIXELS) return null
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 }
}

export function exportGeometry(bounds: ArtworkBounds, maxEdge = MAX_ART_EDGE, padding = 4) {
  const scale = Math.min(1, (maxEdge - padding * 2) / Math.max(bounds.width, bounds.height))
  return {
    width: Math.max(1, Math.round(bounds.width * scale)) + padding * 2,
    height: Math.max(1, Math.round(bounds.height * scale)) + padding * 2,
    padding,
  }
}

export function cropCanvas(canvas: HTMLCanvasElement, maxEdge = MAX_ART_EDGE) {
  const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
  const bounds = getArtworkBounds(pixels, canvas.width, canvas.height)
  if (!bounds) return null
  const { width, height, padding } = exportGeometry(bounds, maxEdge)
  const output = document.createElement('canvas')
  output.width = width
  output.height = height
  output.getContext('2d')!.drawImage(canvas, bounds.x, bounds.y, bounds.width, bounds.height,
    padding, padding, width - padding * 2, height - padding * 2)
  return output
}

export function exportFish(canvas: HTMLCanvasElement) {
  let edge = MAX_ART_EDGE
  while (edge >= 96) {
    const cropped = cropCanvas(canvas, edge)
    if (!cropped) break
    const png = cropped.toDataURL('image/png').split(',')[1]
    const padding = png.endsWith('==') ? 2 : png.endsWith('=') ? 1 : 0
    if (png.length * 0.75 - padding <= MAX_ART_BYTES) return png
    edge = Math.floor(edge * 0.75)
  }
  return null
}
