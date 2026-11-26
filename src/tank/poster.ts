import type { FishProfile } from '../../shared/contracts'
import { getBuildTitle, MAX_STAT_VALUE, STAT_KEYS, type StatKey } from '../../shared/domain'
import { drawFishMesh } from './meshRenderer'

export const statNames: Record<StatKey, string> = {
  burst: '爆发力', stamina: '耐力', sense: '感知力', agility: '灵巧度', brawn: '冲撞力', appetite: '胃口',
}

export async function downloadFishPoster(fish: FishProfile, shareUrl: string) {
  const image = new Image()
  image.src = fish.assetUrl
  await image.decode()

  const canvas = document.createElement('canvas')
  canvas.width = 720
  canvas.height = 960
  const ctx = canvas.getContext('2d')!
  const background = ctx.createLinearGradient(0, 0, 320, 960)
  background.addColorStop(0, '#174859')
  background.addColorStop(0.52, '#102c46')
  background.addColorStop(1, '#071528')
  ctx.fillStyle = background
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.strokeStyle = '#a1dfdc61'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.roundRect(29, 29, 662, 902, 32)
  ctx.stroke()

  const halo = ctx.createRadialGradient(360, 226, 12, 360, 226, 246)
  halo.addColorStop(0, '#8fede840')
  halo.addColorStop(1, '#8fede800')
  ctx.fillStyle = halo
  ctx.fillRect(54, 67, 612, 338)
  for (let i = 0; i < 29; i++) {
    const x = 62 + (i * 137) % 600
    const y = 107 + (i * 61) % 258
    ctx.beginPath()
    ctx.arc(x, y, 1.4 + i % 4, 0, Math.PI * 2)
    ctx.strokeStyle = '#9bdfe43d'
    ctx.lineWidth = 1
    ctx.stroke()
  }

  function label(text: string, x: number, y: number, size: number, color: string, maxWidth = 596, bold = false) {
    ctx.fillStyle = color
    ctx.font = `${bold ? 700 : 400} ${size}px system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, x, y, maxWidth)
  }

  label('潮汐鱼缸 · 鱼类档案', 360, 80, 20, '#b5e9e3')
  const size = Math.min(430, 216 * Math.max(1, image.naturalWidth / image.naturalHeight))
  drawFishMesh(ctx, image, image.naturalWidth, image.naturalHeight, {
    x: 360, y: 229, size, time: 0, isEmperor: fish.stage === 'emperor', eyes: fish.eyes, lookTarget: { x: 140, y: 200 },
  })
  label(fish.name, 360, 382, 52, '#f1fffc', 578, true)
  if (fish.tagline) label(`「${fish.tagline}」`, 360, 428, 24, '#baf0e5')
  label(`养鱼人 ${fish.nickname} · Lv.${fish.level}`, 360, 464, 20, '#a4c6d6')
  ctx.fillStyle = '#94f0d927'
  ctx.beginPath()
  ctx.roundRect(246, 488, 228, 42, 21)
  ctx.fill()
  label(getBuildTitle(fish.stats, fish.level), 360, 509, 22, '#a8f4dc', 216, true)

  function point(index: number, radius: number) {
    const angle = index * Math.PI * 2 / STAT_KEYS.length - Math.PI / 2
    return [360 + Math.cos(angle) * radius, 682 + Math.sin(angle) * radius] as const
  }

  function polygon(radiusAt: (index: number) => number) {
    ctx.beginPath()
    for (let index = 0; index < STAT_KEYS.length; index++) {
      const [x, y] = point(index, radiusAt(index))
      if (index === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.closePath()
  }

  ctx.strokeStyle = '#a1dfdc4f'
  ctx.lineWidth = 1.25
  for (const radius of [30, 60, 90]) {
    polygon(() => radius)
    ctx.stroke()
  }
  polygon(index => fish.stats[STAT_KEYS[index]] / MAX_STAT_VALUE * 90)
  ctx.fillStyle = '#63d6bd55'
  ctx.fill()
  ctx.strokeStyle = '#8be9cf'
  ctx.lineWidth = 2.5
  ctx.stroke()
  STAT_KEYS.forEach((key, index) => {
    const [x, y] = point(index, 122)
    label(`${statNames[key]} ${fish.stats[key]}`, x, y, 19, '#d9eeee', 135)
  })

  label(`累计吃食 ${fish.totalEats} 颗   ·   撞晕 ${fish.totalKnockouts} 次`, 360, 825, 21, '#def4f4', 580, true)
  ctx.strokeStyle = '#b2e1df3c'
  ctx.beginPath()
  ctx.moveTo(76, 855)
  ctx.lineTo(644, 855)
  ctx.stroke()
  label(shareUrl, 360, 891, 17, '#adcbd8', 590)

  const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => {
    if (blob) resolve(blob)
    else reject(new Error('生成海报失败，请重试'))
  }, 'image/png'))
  const url = URL.createObjectURL(png)
  const download = document.createElement('a')
  download.href = url
  download.download = `${fish.name} · 潮汐鱼缸.png`
  document.body.append(download)
  download.click()
  download.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 3000)
}
