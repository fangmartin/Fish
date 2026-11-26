import type { BellyOverload, EyeStyle, FishEye } from '../../shared/domain'

const SLICES = 16
const weights = Array.from({ length: SLICES }, (_, index) => (index / (SLICES - 1)) ** 1.65)
const bellyWeights = Array.from({ length: SLICES }, (_, index) => Math.exp(-(((index / (SLICES - 1) - 0.38) / 0.24) ** 2)))
const CROWN_POSITION = 0.22
const waveFactor = (fill: number, overload: BellyOverload) => 1 - fill * 0.24 - overload * 0.16
export const fishWaveSpeed = (sprinting = false, fill = 0, overload: BellyOverload = 0) =>
  (sprinting ? 14 : 6.9) * waveFactor(fill, overload)
type Point = { x: number; y: number }

export interface MeshPose {
  x: number
  y: number
  size: number
  time: number
  wavePhase?: number
  facing?: number
  tilt?: number
  scaleY?: number
  sprinting?: boolean
  bellyFillRatio?: number
  bellyOverload?: BellyOverload
  isEmperor?: boolean
  opacity?: number
  eyes?: FishEye[]
  lookTarget?: Point
}

export function drawFishEye(
  ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, style: EyeStyle,
  direction: Point = { x: -1, y: 0 }, sleepy = false,
) {
  if (sleepy) {
    ctx.save()
    ctx.beginPath()
    ctx.moveTo(x - radius * 0.8, y)
    ctx.quadraticCurveTo(x, y - radius * 0.72, x + radius * 0.8, y)
    ctx.lineCap = 'round'
    ctx.strokeStyle = '#e8f1e5'
    ctx.lineWidth = Math.max(1.3, radius * 0.42)
    ctx.stroke()
    ctx.strokeStyle = '#192a3d'
    ctx.lineWidth *= 0.55
    ctx.stroke()
    ctx.restore()
    return
  }
  const distance = Math.hypot(direction.x, direction.y)
  const offset = Math.min(0.29, distance / Math.max(radius * 4, 1)) * radius
  const pupilX = distance ? direction.x / distance * offset : 0
  const pupilY = distance ? direction.y / distance * offset : 0
  ctx.save()
  ctx.translate(x, y)
  ctx.beginPath()
  ctx.arc(0, 0, radius, 0, Math.PI * 2)
  ctx.fillStyle = style === 'fierce' ? '#fff1d8' : '#f3fffe'
  ctx.fill()
  ctx.strokeStyle = '#111c2d'
  ctx.lineWidth = Math.max(0.65, radius * 0.14)
  ctx.stroke()
  ctx.clip()
  ctx.beginPath()
  const pupil = radius * (style === 'googly' ? 0.48 : 0.35)
  ctx.arc(pupilX, pupilY, pupil, 0, Math.PI * 2)
  ctx.fillStyle = '#101d32'
  ctx.fill()
  ctx.beginPath()
  ctx.arc(pupilX - pupil * 0.28, pupilY - pupil * 0.32, pupil * 0.27, 0, Math.PI * 2)
  ctx.fillStyle = '#fff'
  ctx.fill()
  if (style === 'deadpan') {
    ctx.fillStyle = '#9aafbe'
    ctx.fillRect(-radius, -radius, radius * 2, radius * 0.9)
    ctx.fillStyle = '#172a3e'
    ctx.fillRect(-radius, -radius * 0.12, radius * 2, radius * 0.11)
  } else if (style === 'fierce') {
    ctx.fillStyle = '#23314c'
    ctx.beginPath()
    ctx.moveTo(-radius, -radius)
    ctx.lineTo(radius, -radius)
    ctx.lineTo(radius, -radius * 0.62)
    ctx.lineTo(-radius, -radius * 0.05)
    ctx.fill()
  }
  ctx.restore()
}

function drawCrown(ctx: CanvasRenderingContext2D) {
  const gold = ctx.createLinearGradient(-8, -9, 6, 6)
  gold.addColorStop(0, '#fff4b3')
  gold.addColorStop(0.55, '#ffc64e')
  gold.addColorStop(1, '#dd8c21')
  ctx.fillStyle = gold
  ctx.strokeStyle = '#7f491c'
  ctx.lineWidth = 1.4
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(-12, -6)
  ctx.lineTo(-5, -2)
  ctx.lineTo(0, -10)
  ctx.lineTo(5, -2)
  ctx.lineTo(12, -6)
  ctx.lineTo(9, 6)
  ctx.lineTo(-9, 6)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()
  ctx.fillStyle = '#ff847a'
  ctx.fillRect(-6.5, 1, 2.6, 2.6)
  ctx.fillStyle = '#fff9cd'
  ctx.fillRect(-1.6, 0, 3.2, 3.2)
  ctx.fillStyle = '#86fff0'
  ctx.fillRect(3.9, 1, 2.6, 2.6)
}

export function drawFishMesh(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  pose: MeshPose,
) {
  if (!sourceWidth || !sourceHeight) return
  const scale = pose.size / Math.max(sourceWidth, sourceHeight)
  const width = sourceWidth * scale
  const height = sourceHeight * scale
  const fill = pose.bellyFillRatio ?? 0
  const overload = pose.bellyOverload ?? 0
  const sleeping = overload === 2
  const bulge = height * (fill * 0.24 + (overload === 1 ? 0.14 : sleeping ? 0.22 : 0))
  const amplitude = Math.min(13, width * (pose.sprinting ? 0.087 : 0.06)) * waveFactor(fill, overload)
  const sourceStep = sourceWidth / SLICES
  const step = width / SLICES
  const tilt = pose.tilt ?? 0
  const facing = pose.facing ?? 1
  const scaleX = Math.sign(facing || 1) * Math.max(0.065, Math.abs(facing))
  const scaleY = sleeping ? -1 : pose.scaleY ?? 1
  const phase = pose.wavePhase ?? pose.time * fishWaveSpeed(pose.sprinting, fill, overload)
  const offset = (strip: number) => Math.sin(phase - strip * 0.39) * amplitude * weights[strip]
  ctx.save()
  ctx.globalAlpha *= pose.opacity ?? 1
  ctx.translate(pose.x, pose.y)
  ctx.rotate(tilt)
  ctx.scale(scaleX, scaleY)
  for (let strip = 0; strip < SLICES; strip++) {
    const overlap = strip < SLICES - 1 ? Math.min(0.9, step * 0.2) : 0
    const growth = bulge * bellyWeights[strip]
    ctx.drawImage(image, strip * sourceStep, 0, sourceStep + overlap / scale, sourceHeight,
      -width / 2 + strip * step, -height / 2 + offset(strip) - growth * 0.14, step + overlap, height + growth)
  }
  if (pose.eyes?.length) {
    const dx = (pose.lookTarget?.x ?? pose.x) - pose.x
    const dy = (pose.lookTarget?.y ?? pose.y) - pose.y
    const targetX = (dx * Math.cos(tilt) + dy * Math.sin(tilt)) / scaleX
    const targetY = (dy * Math.cos(tilt) - dx * Math.sin(tilt)) / scaleY
    for (const eye of pose.eyes) {
      const x = (eye.x - 0.5) * width
      const strip = Math.min(SLICES - 1, Math.floor(eye.x * SLICES))
      const y = (eye.y - 0.5) * height + offset(strip) + bulge * bellyWeights[strip] * (eye.y - 0.14)
      const direction = pose.lookTarget ? { x: targetX - x, y: targetY - y } : undefined
      drawFishEye(ctx, x, y, eye.radius * pose.size, eye.style, direction, sleeping)
    }
  }
  ctx.restore()
  if (pose.isEmperor) {
    const crownScale = Math.max(0.55, Math.min(1.65, pose.size / 145))
    const x = ((CROWN_POSITION - 0.5) * width - (sleeping ? crownScale * 12 : 0)) * scaleX
    const y = -height / 2 + Math.sin(pose.time * 2.5) * crownScale * 1.4
      + offset(Math.floor(CROWN_POSITION * SLICES)) * scaleY - crownScale * 8
    ctx.save()
    ctx.globalAlpha *= pose.opacity ?? 1
    ctx.translate(pose.x, pose.y)
    ctx.rotate(tilt)
    ctx.translate(x, y)
    if (sleeping) ctx.rotate(-tilt - 0.2)
    ctx.scale(crownScale, crownScale)
    drawCrown(ctx)
    ctx.restore()
  }
}
