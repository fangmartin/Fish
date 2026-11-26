import type { EyeStyle, FishEye } from '../../shared/domain'

const SLICES = 16
const weights = Array.from({ length: SLICES }, (_, index) => (index / (SLICES - 1)) ** 1.65)
type Point = { x: number; y: number }

export interface MeshPose {
  x: number
  y: number
  size: number
  time: number
  facing?: number
  tilt?: number
  scaleY?: number
  sprinting?: boolean
  stuffedStacks?: number
  opacity?: number
  eyes?: FishEye[]
  lookTarget?: Point
}

export function drawFishEye(
  ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, style: EyeStyle,
  direction: Point = { x: -1, y: 0 }, sleepy = false,
) {
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
  if (sleepy || style === 'deadpan') {
    ctx.fillStyle = sleepy ? '#36546d' : '#9aafbe'
    ctx.fillRect(-radius, -radius, radius * 2, radius * (sleepy ? 1.08 : 0.9))
    ctx.fillStyle = '#172a3e'
    ctx.fillRect(-radius, radius * (sleepy ? 0.05 : -0.12), radius * 2, radius * 0.11)
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
  const stuffed = pose.stuffedStacks ?? 0
  const height = sourceHeight * scale * (1 + stuffed * 0.075)
  const speed = (pose.sprinting ? 14 : 6.9) * (1 - stuffed * 0.2)
  const amplitude = Math.min(13, width * (pose.sprinting ? 0.087 : 0.06)) * (1 - stuffed * 0.17)
  const sourceStep = sourceWidth / SLICES
  const step = width / SLICES
  const tilt = pose.tilt ?? 0
  const facing = pose.facing ?? 1
  const scaleX = Math.sign(facing || 1) * Math.max(0.065, Math.abs(facing))
  const scaleY = pose.scaleY ?? (stuffed === 3 ? -1 : 1)
  const phase = pose.time * speed
  const offset = (strip: number) => Math.sin(phase - strip * 0.39) * amplitude * weights[strip]
  ctx.save()
  ctx.globalAlpha *= pose.opacity ?? 1
  ctx.translate(pose.x, pose.y)
  ctx.rotate(tilt)
  ctx.scale(scaleX, scaleY)
  for (let strip = 0; strip < SLICES; strip++) {
    const overlap = strip < SLICES - 1 ? Math.min(0.9, step * 0.2) : 0
    ctx.drawImage(image, strip * sourceStep, 0, sourceStep + overlap / scale, sourceHeight,
      -width / 2 + strip * step, -height / 2 + offset(strip), step + overlap, height)
  }
  if (pose.eyes?.length) {
    const dx = (pose.lookTarget?.x ?? pose.x) - pose.x
    const dy = (pose.lookTarget?.y ?? pose.y) - pose.y
    const targetX = (dx * Math.cos(tilt) + dy * Math.sin(tilt)) / scaleX
    const targetY = (dy * Math.cos(tilt) - dx * Math.sin(tilt)) / scaleY
    for (const eye of pose.eyes) {
      const x = (eye.x - 0.5) * width
      const y = (eye.y - 0.5) * height + offset(Math.min(SLICES - 1, Math.floor(eye.x * SLICES)))
      const direction = pose.lookTarget ? { x: targetX - x, y: targetY - y } : undefined
      drawFishEye(ctx, x, y, eye.radius * pose.size, eye.style, direction, stuffed === 3)
    }
  }
  ctx.restore()
}
