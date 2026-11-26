const noise = (seed: number) => {
  const value = Math.sin(seed * 127.1 + 311.7) * 43758.5453
  return value - Math.floor(value)
}

export function paintWater(ctx: CanvasRenderingContext2D, width: number, height: number, seconds: number) {
  const blue = ctx.createLinearGradient(0, 0, width * 0.24, height)
  blue.addColorStop(0, '#123a52')
  blue.addColorStop(0.36, '#0a2b40')
  blue.addColorStop(0.79, '#071b30')
  blue.addColorStop(1, '#071421')
  ctx.fillStyle = blue
  ctx.fillRect(0, 0, width, height)

  const glow = ctx.createRadialGradient(width * 0.37, -height * 0.16, 0, width * 0.37, 0, width * 0.74)
  glow.addColorStop(0, '#559eaa57')
  glow.addColorStop(0.36, '#3a829744')
  glow.addColorStop(1, '#05213300')
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, width, height)

  for (let i = 0; i < 9; i++) {
    const source = width * (0.07 + noise(i + 30) * 0.71)
    const tilt = (noise(i + 40) - 0.41) * width * 0.64 + Math.sin(seconds * 0.23 + i) * 28
    const spread = 15 + noise(i + 50) * 96
    const depth = height * (0.55 + noise(i + 60) * 0.33)
    const ray = ctx.createLinearGradient(0, 0, 0, depth)
    ray.addColorStop(0, i % 2 ? '#c9fbf515' : '#81ebed20')
    ray.addColorStop(1, '#81ebed00')
    ctx.fillStyle = ray
    ctx.beginPath()
    ctx.moveTo(source - spread * 0.22, 0)
    ctx.lineTo(source + spread * 0.22, 0)
    ctx.lineTo(source + tilt + spread, depth)
    ctx.lineTo(source + tilt - spread, depth)
    ctx.fill()
  }

  for (let i = 0; i < 86; i++) {
    const speed = 4 + noise(i + 81) * 19
    const y = height - ((noise(i) * height + seconds * speed) % height)
    const x = noise(i + 501) * width + Math.sin(y / 46 + i + seconds * 0.39) * 10
    const radius = i % 6 ? 0.45 + noise(i + 97) * 1.15 : 2.3 + noise(i + 97) * 3
    ctx.beginPath()
    ctx.arc(x, y, radius, 0, 2 * Math.PI)
    if (i % 6) {
      ctx.fillStyle = i % 3 ? '#b9e9e440' : '#d9f9f279'
      ctx.fill()
    } else {
      ctx.strokeStyle = '#b1f1ee4c'
      ctx.lineWidth = 0.7
      ctx.stroke()
    }
  }

  for (const [i, color] of ['#0b2d3d', '#092333', '#071a29'].entries()) {
    const y = height * (0.87 + i * 0.048)
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.bezierCurveTo(width * 0.27, y - 34, width * 0.44, y + 24, width * 0.66, y - 2)
    ctx.quadraticCurveTo(width * 0.85, y - 29, width, y - 10)
    ctx.lineTo(width, height)
    ctx.lineTo(0, height)
    ctx.fill()
  }

  for (let i = 0; i < 17; i++) {
    const x = noise(i + 750) * width
    const y = height * (0.945 + noise(i + 763) * 0.065)
    const leafHeight = (32 + noise(i + 5) * 98) * Math.min(1.15, height / 650)
    ctx.fillStyle = ['#0b3340b5', '#0c394492', '#10434a79'][i % 3]
    for (let leaf = 0; leaf < 4; leaf++) {
      const motion = Math.sin(seconds * 0.72 + i + leaf * 0.65) * 12
      const reach = (leaf - 1.5) * 24 + motion
      const tip = y - leafHeight * (0.54 + noise(i * 4 + leaf) * 0.55)
      ctx.beginPath()
      ctx.moveTo(x, y)
      ctx.quadraticCurveTo(x + reach * 0.87, (tip + y) / 2, x + reach, tip)
      ctx.quadraticCurveTo(x + reach * 1.13 + 8, (tip + y) / 2, x + 4, y)
      ctx.fill()
    }
  }

  for (let i = 0; i < 69; i++) {
    const y = height * (0.93 + noise(i + 841) * 0.071)
    ctx.fillStyle = i % 4 ? '#19505a36' : '#215a6475'
    ctx.beginPath()
    ctx.ellipse(noise(i + 911) * width, y, 1 + noise(i + 1010) * 8, 0.7 + noise(i + 1030) * 2.2, 0, 0, Math.PI * 2)
    ctx.fill()
  }
}
