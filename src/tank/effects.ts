type Point = { x: number; y: number }

export function createNightGlow() {
  const glow = document.createElement('canvas')
  glow.width = 128
  glow.height = 64
  const ctx = glow.getContext('2d')!
  ctx.fillStyle = '#81d6f519'
  ctx.shadowColor = '#85d4f6a6'
  ctx.shadowBlur = 16
  ctx.beginPath()
  ctx.ellipse(64, 32, 40, 15, 0, 0, Math.PI * 2)
  ctx.fill()
  return glow
}

export function sparkle(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, angle = 0) {
  ctx.beginPath()
  for (let vertex = 0; vertex < 8; vertex++) {
    const theta = angle + vertex * Math.PI / 4
    const reach = radius * (vertex % 2 ? 0.28 : 1)
    const px = x + Math.cos(theta) * reach
    const py = y + Math.sin(theta) * reach
    if (!vertex) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.closePath()
  ctx.fill()
}

export function burst(ctx: CanvasRenderingContext2D, point: Point, progress: number, golden: boolean) {
  ctx.save()
  ctx.globalAlpha *= Math.max(0, 1 - progress)
  const count = golden ? 22 : 9
  for (let i = 0; i < count; i++) {
    const angle = i * 2.39996
    const spread = (golden ? 125 : 58) * (0.36 + (i % 5) * 0.14) * progress
    ctx.fillStyle = i % 3 === 0 ? '#fff3c1' : golden ? '#ffc658' : '#ff9878'
    sparkle(ctx, point.x + Math.cos(angle) * spread, point.y + Math.sin(angle) * spread,
      (i % 4 + 3) * (1 - progress * 0.4), angle + progress * 2)
  }
  ctx.restore()
}

export function glassRipple(ctx: CanvasRenderingContext2D, point: Point, progress: number) {
  ctx.save()
  for (const delay of [0, 0.18]) {
    const wave = Math.max(0, progress - delay)
    if (!wave) continue
    ctx.strokeStyle = `rgba(195,237,255,${Math.max(0, 0.54 - wave * 0.52)})`
    ctx.lineWidth = 1 + (1 - wave) * 1.5
    ctx.beginPath()
    ctx.arc(point.x, point.y, 4 + wave * 134, 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.restore()
}
