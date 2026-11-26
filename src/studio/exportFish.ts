import { MAX_ART_BYTES, MAX_ART_EDGE, MIN_ART_PIXELS, type EyeStyle, type FishEye } from '../../shared/domain'

export interface ArtworkBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface CanvasEye {
  x: number
  y: number
  radius: number
  style: EyeStyle
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

export function mapEyesToExport(eyes: CanvasEye[], bounds: ArtworkBounds, maxEdge = MAX_ART_EDGE, padding = 4): FishEye[] {
  const { width, height } = exportGeometry(bounds, maxEdge, padding)
  const scaleX = (width - padding * 2) / bounds.width
  const scaleY = (height - padding * 2) / bounds.height
  return eyes.map(eye => ({
    x: Math.max(0, Math.min(1, (padding + (eye.x - bounds.x) * scaleX) / width)),
    y: Math.max(0, Math.min(1, (padding + (eye.y - bounds.y) * scaleY) / height)),
    radius: Math.max(0.02, Math.min(0.2, eye.radius * Math.min(scaleX, scaleY) / Math.max(width, height))),
    style: eye.style,
  }))
}

function canvasBounds(canvas: HTMLCanvasElement, eyes: CanvasEye[]) {
  const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
  const bounds = getArtworkBounds(pixels, canvas.width, canvas.height)
  if (!bounds) return null
  const left = Math.max(0, Math.min(bounds.x, ...eyes.map(eye => Math.floor(eye.x - eye.radius))))
  const top = Math.max(0, Math.min(bounds.y, ...eyes.map(eye => Math.floor(eye.y - eye.radius))))
  const right = Math.min(canvas.width, Math.max(bounds.x + bounds.width, ...eyes.map(eye => Math.ceil(eye.x + eye.radius))))
  const bottom = Math.min(canvas.height, Math.max(bounds.y + bounds.height, ...eyes.map(eye => Math.ceil(eye.y + eye.radius))))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function drawCrop(canvas: HTMLCanvasElement, bounds: ArtworkBounds, maxEdge: number) {
  const { width, height, padding } = exportGeometry(bounds, maxEdge)
  const output = document.createElement('canvas')
  output.width = width
  output.height = height
  output.getContext('2d')!.drawImage(canvas, bounds.x, bounds.y, bounds.width, bounds.height,
    padding, padding, width - padding * 2, height - padding * 2)
  return output
}

export function cropCanvas(canvas: HTMLCanvasElement, maxEdge: number, eyes: CanvasEye[]) {
  const bounds = canvasBounds(canvas, eyes)
  if (!bounds) return null
  return { canvas: drawCrop(canvas, bounds, maxEdge), eyes: mapEyesToExport(eyes, bounds, maxEdge) }
}

export function exportFish(canvas: HTMLCanvasElement, eyes: CanvasEye[]) {
  const bounds = canvasBounds(canvas, eyes)
  if (!bounds) return null
  let edge = MAX_ART_EDGE
  while (edge >= 96) {
    const cropped = drawCrop(canvas, bounds, edge)
    const png = cropped.toDataURL('image/png').split(',')[1]
    const padding = png.endsWith('==') ? 2 : png.endsWith('=') ? 1 : 0
    if (png.length * 0.75 - padding <= MAX_ART_BYTES) {
      return { pngBase64: png, eyes: mapEyesToExport(eyes, bounds, edge) }
    }
    edge = Math.floor(edge * 0.75)
  }
  return null
}
