const SLICES = 16

export interface MeshPose {
  x: number
  y: number
  size: number
  time: number
  facing?: number
  tilt?: number
  sprinting?: boolean
  stuffedStacks?: number
  opacity?: number
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
  ctx.save()
  ctx.globalAlpha *= pose.opacity ?? 1
  ctx.translate(pose.x, pose.y)
  ctx.rotate(pose.tilt ?? 0)
  const facing = pose.facing ?? 1
  ctx.scale(Math.sign(facing || 1) * Math.max(0.065, Math.abs(facing)), 1)
  for (let strip = 0; strip < SLICES; strip++) {
    const vertical = Math.sin(pose.time * speed - strip * 0.39) * amplitude * (strip / (SLICES - 1)) ** 1.65
    const overlap = strip < SLICES - 1 ? Math.min(0.9, step * 0.2) : 0
    ctx.drawImage(image, strip * sourceStep, 0, sourceStep + overlap / scale, sourceHeight,
      -width / 2 + strip * step, -height / 2 + vertical, step + overlap, height)
  }
  ctx.restore()
}
