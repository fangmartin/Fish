import { useEffect, useRef, type MouseEvent } from 'react'
import type { Fish } from '../../shared/contracts'
import { getDigestionState, type FeedOutcome } from '../../shared/domain'
import { paintWater } from './ambient'
import { drawFishMesh } from './meshRenderer'
import { createSwimmer, displayedSize, floorY, pitch, stepTank, type Food, type Swimmer, type Water } from './physics'

export interface LocalPellet {
  id: string
  x: number
  y: number
  expiresAt: number
  busy: boolean
  retryAt: number
}

export interface TankEffect {
  fishId: string
  outcome: FeedOutcome
}

interface Props {
  fish: Fish[]
  keeperId?: string
  feeding: boolean
  spotlight: string
  pellets: Map<string, LocalPellet>
  effects: TankEffect[]
  onWaterClick: (x: number, y: number) => void
  onFishClick: (id: string) => void
  onContact: (pelletId: string, fishId: string) => void
}

type VisualFish = {
  fish: Fish; swimmer: Swimmer; image: HTMLImageElement; clockOffset: number
}

const floatText: Record<FeedOutcome, string> = {
  grew: '+1 成长', leveled_up: '✨ Lv.Up! 获得属性点', stuffed: '🫧 嗝~ 吃撑了', stuffed_full: '💤 撑不动啦',
}

function caption(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, fill: string, color: string) {
  ctx.save()
  ctx.font = '11px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const width = ctx.measureText(text).width + 16
  ctx.fillStyle = fill
  ctx.beginPath()
  ctx.roundRect(x - width / 2, y - 10, width, 20, 9)
  ctx.fill()
  ctx.fillStyle = color
  ctx.fillText(text, x, y + 0.5)
  ctx.restore()
}

export function TankCanvas(props: Props) {
  const ref = useRef<HTMLCanvasElement>(null)
  const state = useRef(props)
  const swimmers = useRef(new Map<string, VisualFish>())
  const water = useRef<Water>({ width: 0, height: 0 })

  useEffect(() => { state.current = props }, [props])

  useEffect(() => {
    const canvas = ref.current!
    const ctx = canvas.getContext('2d', { alpha: false })!
    const food = new Map<string, Food>()
    const floats: (TankEffect & { start: number })[] = []
    let frame = 0
    let previous = 0
    let ratio = 1
    let visible = false
    const pool = swimmers.current

    function resize() {
      const { width, height } = canvas.getBoundingClientRect()
      visible = width > 0 && height > 0
      if (!width || !height) return
      ratio = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(width * ratio)
      canvas.height = Math.round(height * ratio)
      const before = water.current
      if (before.width) {
        for (const item of pool.values()) {
          item.swimmer.x *= width / before.width
          item.swimmer.y *= height / before.height
        }
        for (const pellet of food.values()) {
          pellet.x *= width / before.width
          pellet.y *= height / before.height
        }
      }
      water.current = { width, height }
    }
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    resize()

    function tick(time: number) {
      frame = requestAnimationFrame(tick)
      const bounds = water.current
      if (!visible) { previous = 0; return }
      const dt = previous ? Math.min(0.034, (time - previous) / 1000) : 0
      previous = time
      const seconds = time / 1000
      const current = state.current
      const wallTime = Date.now()
      const ids = new Set(current.fish.map(fish => fish.id))
      for (const id of pool.keys()) if (!ids.has(id)) pool.delete(id)
      for (const fish of current.fish) {
        let visual = pool.get(fish.id)
        if (!visual) {
          const image = new Image()
          image.src = fish.assetUrl
          const index = pool.size
          const swimmer = createSwimmer(fish,
            bounds.width * (0.24 + (index * 0.236) % 0.59), bounds.height * (0.26 + (index * 0.151) % 0.5),
            index % 2 ? 0.12 : Math.PI - 0.1, Math.random() * 20)
          visual = { fish, image, swimmer, clockOffset: fish.serverNow - wallTime }
          pool.set(fish.id, visual)
        } else if (visual.fish !== fish) {
          visual.fish = fish
          visual.clockOffset = fish.serverNow - wallTime
        }
        const { stuffedStacks } = getDigestionState(fish.rawStuffedStacks, fish.stuffedUpdatedAt, wallTime + visual.clockOffset)
        const body = visual.swimmer.body
        if (body.stuffedStacks !== stuffedStacks || body.stats !== fish.stats || body.size !== fish.size) {
          visual.swimmer.body = { id: fish.id, size: fish.size, stats: fish.stats, stuffedStacks }
        }
      }

      for (const id of food.keys()) if (!current.pellets.has(id)) food.delete(id)
      for (const pellet of current.pellets.values()) {
        if (pellet.expiresAt <= wallTime) {
          food.delete(pellet.id)
          continue
        }
        let local = food.get(pellet.id)
        if (!local) {
          local = { id: pellet.id, x: pellet.x * bounds.width,
            y: Math.min(pellet.y * bounds.height, floorY(bounds)), age: 0, claiming: false }
          food.set(pellet.id, local)
        }
        local.claiming = pellet.busy || pellet.retryAt > wallTime
      }

      const actors = [...pool.values()]
      const contacts = stepTank(actors.map(item => item.swimmer), [...food.values()], bounds, dt)
      for (const contact of contacts) current.onContact(contact.pelletId, contact.fishId)
      for (const effect of current.effects.splice(0)) floats.push({ ...effect, start: time })
      while (floats[0] && time - floats[0].start > 2200) floats.shift()

      ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
      paintWater(ctx, bounds.width, bounds.height, seconds)
      for (const pellet of food.values()) {
        ctx.save()
        ctx.translate(pellet.x, pellet.y)
        ctx.shadowColor = '#ffd560'
        ctx.shadowBlur = 12
        ctx.fillStyle = '#ffce76'
        ctx.beginPath()
        ctx.ellipse(0, 0, 4, 3, 0.5, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = '#fff3bd'
        ctx.fillRect(-1.5, -1.7, 1.8, 1)
        ctx.restore()
      }
      for (const visual of actors) {
        const { swimmer, image, fish } = visual
        const { x, y, phase, body } = swimmer
        const size = displayedSize(fish.size, bounds)
        const stuffed = body.stuffedStacks
        const height = size * (image.naturalHeight || 1) / Math.max(image.naturalWidth || 1, image.naturalHeight || 1)
        const labelY = y - height / 2 - 11
        if (current.spotlight === fish.id) {
          const glow = ctx.createRadialGradient(x, y, 3, x, y, Math.max(34, size * 0.79))
          glow.addColorStop(0, '#88f9cb38')
          glow.addColorStop(1, '#88f9cb00')
          ctx.fillStyle = glow
          ctx.fillRect(x - size, y - size, size * 2, size * 2)
        }
        if (swimmer.sprinting) {
          const tail = x + swimmer.facing * size * 0.49
          for (let i = 1; i < 6; i++) {
            const distance = ((seconds * 47 + i * 8) % 46) + 4
            ctx.strokeStyle = `rgba(177,239,240,${0.47 * (1 - distance / 48)})`
            ctx.lineWidth = 0.7
            ctx.beginPath()
            ctx.arc(tail + swimmer.facing * distance, y + Math.sin(phase * 8 + i) * 9, 1 + i * 0.37, 0, Math.PI * 2)
            ctx.stroke()
          }
        }
        if (image.complete && image.naturalWidth) drawFishMesh(ctx, image, image.naturalWidth, image.naturalHeight, {
          x, y, size, time: phase, facing: swimmer.facing, tilt: pitch(swimmer),
          sprinting: swimmer.sprinting, stuffedStacks: stuffed,
        })
        if (fish.keeperId === current.keeperId) {
          ctx.save()
          ctx.fillStyle = '#abffe7'
          ctx.shadowColor = '#6ceac1'
          ctx.shadowBlur = 11
          ctx.beginPath()
          ctx.arc(x, labelY - (stuffed === 3 ? 16 : 1), 3, 0, Math.PI * 2)
          ctx.fill()
          ctx.restore()
        }
        if (stuffed === 3) {
          const { digestionRemainingSec } = getDigestionState(fish.rawStuffedStacks, fish.stuffedUpdatedAt, wallTime + visual.clockOffset)
          caption(ctx, `撑不动了 · ${Math.ceil(digestionRemainingSec / 60)} 分钟`, x, labelY, '#102238ea', '#e9caf3')
        }
        if (stuffed > 0 && stuffed < 3 && Math.sin(phase * 1.25) > 0.91) {
          caption(ctx, '嗝~', x, labelY - 4, '#102b3cb5', '#cdf1eb')
        }
        if (current.spotlight === fish.id) caption(ctx, fish.name, x, y + height / 2 + 15, '#123947e8', '#c6ffec')
      }
      for (const effect of floats) {
        const visual = pool.get(effect.fishId)
        if (!visual) continue
        const elapsed = (time - effect.start) / 2200
        ctx.save()
        ctx.globalAlpha = Math.min(1, (1 - elapsed) * 2)
        caption(ctx, floatText[effect.outcome], visual.swimmer.x, visual.swimmer.y - 32 - 34 * elapsed, '#102a3deb', '#deffe8')
        ctx.restore()
      }
    }
    frame = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      pool.clear()
    }
  }, [])

  function click(event: MouseEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    if (props.feeding) {
      props.onWaterClick(x / rect.width, y / rect.height)
      return
    }
    const list = [...swimmers.current.values()].reverse()
    for (const { swimmer, fish, image } of list) {
      const size = displayedSize(fish.size, water.current)
      const scale = Math.max(image.naturalWidth, image.naturalHeight, 1)
      const width = size * (image.naturalWidth || scale) / scale * Math.max(0.5, Math.abs(swimmer.facing))
      const height = size * (image.naturalHeight || scale) / scale
      if (((x - swimmer.x) / (width / 2 + 12)) ** 2 + ((y - swimmer.y) / (height / 2 + 12)) ** 2 <= 1) {
        props.onFishClick(fish.id)
        return
      }
    }
  }

  return <canvas ref={ref} className={`tank-canvas${props.feeding ? ' feeding' : ''}`} aria-label="公共鱼缸水域"
    onClick={click} />
}
