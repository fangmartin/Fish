export type TideMode = 'auto' | 'dawn' | 'day' | 'dusk' | 'night'
type TidePhase = Exclude<TideMode, 'auto'>
const shanghaiHour = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai', hour: '2-digit', hourCycle: 'h23',
})

export function resolveTidePhase(nowMs: number, mode: TideMode): TidePhase {
  if (mode !== 'auto') return mode
  const hour = Number(shanghaiHour.format(nowMs))
  if (hour >= 5 && hour <= 9) return 'dawn'
  if (hour >= 10 && hour <= 16) return 'day'
  if (hour >= 17 && hour <= 19) return 'dusk'
  return 'night'
}

const palettes = {
  dawn: { water: ['#245867', '#123b52', '#112944', '#0b1a31'], glow: ['#ffca9e63', '#a0c3b349'],
    ray: '#ffe1aa', bubble: '#c6eff5', floor: ['#18434b', '#103d41', '#082a35'], plants: ['#206263b5', '#194c5b92', '#39766a79'] },
  day: { water: ['#19637a', '#115067', '#0a2f52', '#061c39'], glow: ['#9ff5e962', '#80e3eb45'],
    ray: '#c7fff5', bubble: '#d5fff5', floor: ['#1b4a58', '#124552', '#092b3f'], plants: ['#277768b5', '#1c656592', '#23866779'] },
  dusk: { water: ['#683a56', '#362c50', '#172846', '#0d172f'], glow: ['#ffc58b66', '#d77f9b40'],
    ray: '#ffca9d', bubble: '#fbd1e8', floor: ['#323856', '#24324d', '#14233f'], plants: ['#594f66b5', '#445b6992', '#69536979'] },
  night: { water: ['#123252', '#0c2445', '#07152e', '#040d20'], glow: ['#5484d34d', '#424ca136'],
    ray: '#92b7ff', bubble: '#a0ceff', floor: ['#132c47', '#0d263e', '#081a30'], plants: ['#1c4867b5', '#23527a92', '#254e6c79'] },
}

const noise = Array.from({ length: 1200 }, (_, seed) => {
  const value = Math.sin(seed * 127.1 + 311.7) * 43758.5453
  return value - Math.floor(value)
})

export function paintWater(ctx: CanvasRenderingContext2D, width: number, height: number, seconds: number, phase: TidePhase) {
  const palette = palettes[phase]
  const blue = ctx.createLinearGradient(0, 0, width * 0.24, height)
  blue.addColorStop(0, palette.water[0])
  blue.addColorStop(0.36, palette.water[1])
  blue.addColorStop(0.79, palette.water[2])
  blue.addColorStop(1, palette.water[3])
  ctx.fillStyle = blue
  ctx.fillRect(0, 0, width, height)

  const glow = ctx.createRadialGradient(width * 0.37, -height * 0.16, 0, width * 0.37, 0, width * 0.74)
  glow.addColorStop(0, palette.glow[0])
  glow.addColorStop(0.36, palette.glow[1])
  glow.addColorStop(1, '#05213300')
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, width, height)

  for (let i = 0; i < 9; i++) {
    const source = width * (0.07 + noise[i + 30] * 0.71)
    const tilt = (noise[i + 40] - 0.41) * width * 0.64 + Math.sin(seconds * 0.23 + i) * 28
    const spread = 15 + noise[i + 50] * 96
    const depth = height * (0.55 + noise[i + 60] * 0.33)
    const ray = ctx.createLinearGradient(0, 0, 0, depth)
    ray.addColorStop(0, palette.ray + (i % 2 ? '14' : '20'))
    ray.addColorStop(1, palette.ray + '00')
    ctx.fillStyle = ray
    ctx.beginPath()
    ctx.moveTo(source - spread * 0.22, 0)
    ctx.lineTo(source + spread * 0.22, 0)
    ctx.lineTo(source + tilt + spread, depth)
    ctx.lineTo(source + tilt - spread, depth)
    ctx.fill()
  }

  for (let i = 0; i < 86; i++) {
    const speed = 4 + noise[i + 81] * 19
    const y = height - ((noise[i] * height + seconds * speed) % height)
    const x = noise[i + 501] * width + Math.sin(y / 46 + i + seconds * 0.39) * 10
    const radius = i % 6 ? 0.45 + noise[i + 97] * 1.15 : 2.3 + noise[i + 97] * 3
    ctx.beginPath()
    ctx.arc(x, y, radius, 0, 2 * Math.PI)
    if (i % 6) {
      ctx.fillStyle = palette.bubble + (i % 3 ? '40' : '79')
      ctx.fill()
    } else {
      ctx.strokeStyle = palette.bubble + '4c'
      ctx.lineWidth = 0.7
      ctx.stroke()
    }
  }

  if (phase === 'night' || phase === 'dusk') {
    for (let i = 0; i < 4; i++) {
      const x = width * (0.14 + i * 0.23) + Math.sin(seconds * 0.15 + i) * 24
      const y = height * (0.22 + noise[i + 105] * 0.48) + Math.cos(seconds * 0.3 + i) * 18
      const r = 8 + noise[i + 13] * 10
      ctx.beginPath()
      ctx.ellipse(x, y, r, r * 0.53, 0, Math.PI, Math.PI * 2)
      ctx.quadraticCurveTo(x, y + r * 0.3, x - r, y)
      ctx.fillStyle = palette.bubble + '22'
      ctx.fill()
      ctx.strokeStyle = palette.bubble + '42'
      ctx.lineWidth = 0.9
      ctx.beginPath()
      for (const offset of [-5, 0, 5]) {
        ctx.moveTo(x + offset, y)
        ctx.quadraticCurveTo(x + offset - 4, y + 7, x + offset + Math.sin(seconds + i) * 4, y + r + 7)
      }
      ctx.stroke()
    }
  }

  for (const [i, color] of palette.floor.entries()) {
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
    const x = noise[i + 750] * width
    const y = height * (0.945 + noise[i + 763] * 0.065)
    const leafHeight = (32 + noise[i + 5] * 98) * Math.min(1.15, height / 650)
    ctx.fillStyle = palette.plants[i % 3]
    for (let leaf = 0; leaf < 4; leaf++) {
      const motion = Math.sin(seconds * 0.72 + i + leaf * 0.65) * 12
      const reach = (leaf - 1.5) * 24 + motion
      const tip = y - leafHeight * (0.54 + noise[i * 4 + leaf] * 0.55)
      ctx.beginPath()
      ctx.moveTo(x, y)
      ctx.quadraticCurveTo(x + reach * 0.87, (tip + y) / 2, x + reach, tip)
      ctx.quadraticCurveTo(x + reach * 1.13 + 8, (tip + y) / 2, x + 4, y)
      ctx.fill()
    }
  }

  for (let i = 0; i < 69; i++) {
    const y = height * (0.93 + noise[i + 841] * 0.071)
    ctx.fillStyle = i % 4 ? '#19505a36' : '#215a6475'
    ctx.beginPath()
    ctx.ellipse(noise[i + 911] * width, y, 1 + noise[i + 1010] * 8, 0.7 + noise[i + 1030] * 2.2, 0, 0, Math.PI * 2)
    ctx.fill()
  }
}
