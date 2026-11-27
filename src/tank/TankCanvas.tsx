import { useEffect, useRef, type MouseEvent } from 'react'
import type { Fish, GoldenFeast } from '../../shared/contracts'
import { formatDuration, getBellyState, type FeedOutcome } from '../../shared/domain'
import { playSound, unlockSound } from '../audio/sound'
import { getTankImage } from '../bootLoader'
import { paintWater, resolveTidePhase, type TideMode } from './ambient'
import { burst, createNightGlow, glassRipple, sparkle } from './effects'
import { drawFishMesh, fishWaveSpeed } from './meshRenderer'
import {
  createSwimmer, displayedSize, floorY, GOLDEN_SINK_SPEED, KNOCK_RADIUS, knockTank, mouthPosition, pitch, stepTank,
  type CollisionEvent, type Food, type Swimmer, type Water,
} from './physics'

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
  golden?: boolean
  xpGained?: number
}

interface Props {
  tankName: string
  fish: Fish[]
  keeperId?: string
  feeding: boolean
  spotlight: string
  pellets: Map<string, LocalPellet>
  effects: TankEffect[]
  goldenFeast: GoldenFeast | null
  tideMode: TideMode
  onWaterClick: (x: number, y: number) => void
  onFishClick: (id: string) => void
  onContact: (pelletId: string, fishId: string) => void
  onGoldenContact: (feastId: string, fishId: string) => void
  onKnockout: (hit: CollisionEvent) => void
}

type Point = { x: number; y: number }
type VisualFish = {
  fish: Fish; swimmer: Swimmer; image: HTMLImageElement; clockOffset: number; speechSeed: number
  wavePhase: number; digestionRemainingSec: number
}

const floatText: Record<FeedOutcome, string> = {
  grew: '+1 成长', leveled_up: '✨ Lv.Up! 胃口变大了', fed: '😋 干饭 +1',
  stuffed: '🫧 嗝~ 肚子塞满啦', stuffed_full: '💤 撑翻啦',
}
const CROWDED_TANK_SIZE = 24

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
  const pointer = useRef<Point | null>(null)
  const lastKnock = useRef<(Point & { start: number }) | null>(null)

  useEffect(() => { state.current = props }, [props])

  useEffect(() => {
    const canvas = ref.current!
    const ctx = canvas.getContext('2d', { alpha: false })!
    const backdrop = document.createElement('canvas')
    const backdropContext = backdrop.getContext('2d', { alpha: false })!
    const nightGlow = createNightGlow()
    const food = new Map<string, Food>()
    const floats: (TankEffect & { start: number })[] = []
    const hits: (CollisionEvent & { start: number })[] = []
    let frame = 0
    let previous = 0
    let ratio = 1
    let visible = false
    let crowded = false
    let lastBackdrop = -Infinity
    let lastShake = -Infinity
    let tidePhase = resolveTidePhase(Date.now(), state.current.tideMode)
    let tideMinute = -1
    let tideMode: TideMode | undefined
    const pool = swimmers.current

    function resize() {
      const { width, height } = canvas.getBoundingClientRect()
      crowded = state.current.fish.length >= CROWDED_TANK_SIZE
      visible = width > 0 && height > 0
      if (!width || !height) return
      ratio = Math.min(window.devicePixelRatio || 1, crowded ? 1 : 2)
      canvas.width = Math.round(width * ratio)
      canvas.height = Math.round(height * ratio)
      backdrop.width = Math.ceil(width * 0.66)
      backdrop.height = Math.ceil(height * 0.66)
      backdropContext.setTransform(backdrop.width / width, 0, 0, backdrop.height / height, 0, 0)
      lastBackdrop = -Infinity
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
      const current = state.current
      if ((current.fish.length >= CROWDED_TANK_SIZE) !== crowded) resize()
      const bounds = water.current
      if (!visible) { previous = 0; return }
      const dt = previous ? Math.min(0.034, (time - previous) / 1000) : 0
      previous = time
      const seconds = time / 1000
      const wallTime = Date.now()
      const minute = Math.floor(wallTime / 60_000)
      if (minute !== tideMinute || tideMode !== current.tideMode) {
        tideMode = current.tideMode
        tideMinute = minute
        const phase = resolveTidePhase(wallTime, tideMode)
        if (phase !== tidePhase) lastBackdrop = -Infinity
        tidePhase = phase
      }
      const ids = new Set(current.fish.map(fish => fish.id))
      for (const id of pool.keys()) if (!ids.has(id)) pool.delete(id)
      for (const fish of current.fish) {
        let visual = pool.get(fish.id)
        if (!visual) {
          const image = getTankImage(fish.assetUrl)
          const index = pool.size
          const { id, size, stats, bellyFillRatio, bellyOverload } = fish
          const swimmer = createSwimmer({ id, size, stats, bellyFillRatio, bellyOverload },
            bounds.width * (0.24 + (index * 0.236) % 0.59), bounds.height * (0.26 + (index * 0.151) % 0.5),
            index % 2 ? 0.12 : Math.PI - 0.1, Math.random() * 20)
          let speechSeed = 0
          for (const character of fish.id) speechSeed = (speechSeed * 31 + character.charCodeAt(0)) >>> 0
          visual = { fish, image, swimmer, clockOffset: fish.serverNow - wallTime, speechSeed,
            wavePhase: swimmer.phase, digestionRemainingSec: fish.digestionRemainingSec }
          pool.set(fish.id, visual)
        } else if (visual.fish !== fish) {
          if (visual.fish.assetUrl !== fish.assetUrl) visual.image = getTankImage(fish.assetUrl)
          visual.fish = fish
          visual.clockOffset = fish.serverNow - wallTime
        }
        const belly = getBellyState(fish.rawBellyLoad, fish.rawStuffedFull, fish.bellyUpdatedAt,
          fish.level, fish.stats.appetite, wallTime + visual.clockOffset)
        const body = visual.swimmer.body
        body.size = fish.size
        body.stats = fish.stats
        body.bellyFillRatio = belly.bellyFillRatio
        body.bellyOverload = belly.bellyOverload
        visual.digestionRemainingSec = belly.digestionRemainingSec
      }

      const feast = current.goldenFeast
      const activeFeast = feast && feast.expiresAt > wallTime ? feast : null
      for (const id of food.keys()) if (!current.pellets.has(id) && id !== activeFeast?.id) food.delete(id)
      if (activeFeast && !food.has(activeFeast.id)) {
        const age = Math.max(0, (wallTime - activeFeast.createdAt) / 1000)
        food.set(activeFeast.id, { id: activeFeast.id, x: activeFeast.x * bounds.width,
          y: Math.min(activeFeast.y * bounds.height + age * GOLDEN_SINK_SPEED, floorY(bounds)),
          age, claiming: false, golden: true })
      }
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
      const contacts = stepTank(actors.map(item => item.swimmer), [...food.values()], bounds, dt, {
        onCollision(hit) {
          if (hits.length >= 28) hits.shift()
          hits.push({ ...hit, start: time })
          if (hit.brawn >= 3 && time - lastShake > 120) {
            lastShake = time
            playSound('bonk')
          }
          const target = pool.get(hit.attackerId)?.swimmer.targetId
          const local = target ? current.pellets.get(target) : undefined
          if (local && !local.busy && local.expiresAt > wallTime) current.onKnockout(hit)
        },
      })
      for (const contact of contacts) {
        if (contact.pelletId === activeFeast?.id) {
          if (current.keeperId) current.onGoldenContact(contact.pelletId, contact.fishId)
        } else current.onContact(contact.pelletId, contact.fishId)
      }
      for (const effect of current.effects.splice(0)) floats.push({ ...effect, start: time })
      while (floats[0] && time - floats[0].start > 2200) floats.shift()
      while (hits[0] && time - hits[0].start > 650) hits.shift()

      ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
      // Slow ambient motion can reuse the backdrop while fish advance on every frame.
      if (time - lastBackdrop >= 1000 / 24) {
        paintWater(backdropContext, bounds.width, bounds.height, seconds, tidePhase)
        lastBackdrop = time
      }
      ctx.drawImage(backdrop, 0, 0, bounds.width, bounds.height)
      const shake = Math.max(0, 1 - (time - lastShake) / 180) * 3.7
      ctx.save()
      if (shake) ctx.translate(Math.sin(time * 0.093) * shake, Math.cos(time * 0.124) * shake * 0.6)
      for (const pellet of food.values()) {
        ctx.save()
        ctx.translate(pellet.x, pellet.y)
        if (pellet.golden) {
          const pulse = 1 + Math.sin(seconds * 7) * 0.2
          const glow = ctx.createRadialGradient(0, 0, 3, 0, 0, 34 * pulse)
          glow.addColorStop(0, '#ffce69ca')
          glow.addColorStop(1, '#ffb12900')
          ctx.fillStyle = glow
          ctx.fillRect(-43, -43, 86, 86)
          ctx.fillStyle = '#ffe6a1'
          sparkle(ctx, 0, 0, 11 * pulse, seconds * 0.8)
          for (let i = 0; i < 5; i++) {
            const angle = i * 2.4 + seconds * 1.25
            sparkle(ctx, Math.cos(angle) * (17 + i * 2), Math.sin(angle) * (17 + i * 2),
              2 + (1 + Math.sin(seconds * 9 + i)) * 1.1, angle)
          }
          ctx.restore()
          continue
        }
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
      let speaking = 0
      const knock = lastKnock.current
      const knockAge = knock ? (time - knock.start) / 1000 : Infinity
      for (const visual of actors) {
        const { swimmer, image, fish } = visual
        const { x, phase, body } = swimmer
        const size = displayedSize(fish.size, bounds)
        const { bellyFillRatio, bellyOverload } = body
        const sleeping = bellyOverload === 2
        const y = swimmer.y + (sleeping ? Math.sin(seconds * 1.65 + phase * 0.16) * 5 : 0)
        const height = size * (image.naturalHeight || 1) / Math.max(image.naturalWidth || 1, image.naturalHeight || 1)
        const labelY = Math.max(11, y - height * (sleeping ? 0.9 : 0.5) - 11)
        if (tidePhase === 'night') {
          const glowHeight = Math.max(12, height * 1.26)
          ctx.drawImage(nightGlow, x - size * 0.52, y - glowHeight / 2, size * 1.04, glowHeight)
        }
        if (current.spotlight === fish.id) {
          const glow = ctx.createRadialGradient(x, y, 3, x, y, Math.max(34, size * 0.79))
          glow.addColorStop(0, '#88f9cb38')
          glow.addColorStop(1, '#88f9cb00')
          ctx.fillStyle = glow
          ctx.fillRect(x - size, y - size, size * 2, size * 2)
        }
        if (swimmer.sprinting) {
          const tail = x + swimmer.facing * size * 0.49
          const turbo = body.stats.burst >= 3
          const bubbles = turbo ? 12 : 5
          if (turbo) {
            ctx.strokeStyle = '#97f5ff7c'
            ctx.lineWidth = 1.3
            ctx.beginPath()
            for (const offset of [-6, 3, 11]) {
              ctx.moveTo(tail + swimmer.facing * 9, y + offset)
              ctx.lineTo(tail + swimmer.facing * (25 + Math.sin(seconds * 13 + offset) * 8), y + offset)
            }
            ctx.stroke()
          }
          for (let i = 1; i <= bubbles; i++) {
            const distance = ((seconds * 47 + i * 8) % 46) + 4
            ctx.strokeStyle = `rgba(${turbo ? '118,238,255' : '177,239,240'},${(turbo ? 0.86 : 0.47) * (1 - distance / 52)})`
            ctx.lineWidth = turbo ? 1.1 : 0.7
            ctx.beginPath()
            ctx.arc(tail + swimmer.facing * distance, y + Math.sin(phase * 8 + i) * 9, 1 + (i % 6) * 0.37, 0, Math.PI * 2)
            ctx.stroke()
          }
        }
        let lookTarget = pointer.current ?? { x: x + Math.cos(swimmer.heading) * 120, y: y + Math.sin(swimmer.heading) * 120 }
        if (!sleeping && fish.eyes?.length) {
          let nearest = Infinity
          for (const pellet of food.values()) {
            const gap = (x - pellet.x) ** 2 + (y - pellet.y) ** 2
            if (gap < nearest) { nearest = gap; lookTarget = pellet }
          }
        }
        const rocked = sleeping && knock && knockAge >= 0 && knockAge < 0.45 &&
          (x - knock.x) ** 2 + (y - knock.y) ** 2 <= KNOCK_RADIUS ** 2
        const tilt = pitch(swimmer) + (rocked ? Math.sin(knockAge * 34) * (0.45 - knockAge) * 0.18 : 0)
        visual.wavePhase += dt * fishWaveSpeed(swimmer.sprinting, bellyFillRatio, bellyOverload)
        if (image.complete && image.naturalWidth) drawFishMesh(ctx, image, image.naturalWidth, image.naturalHeight, {
          x, y, size, time: phase, wavePhase: visual.wavePhase, facing: swimmer.facing, tilt,
          sprinting: swimmer.sprinting, bellyFillRatio, bellyOverload, isEmperor: fish.stage === 'emperor',
          eyes: fish.eyes, lookTarget,
        })
        if (fish.keeperId === current.keeperId) {
          ctx.save()
          ctx.fillStyle = '#abffe7'
          ctx.shadowColor = '#6ceac1'
          ctx.shadowBlur = 11
          ctx.beginPath()
          ctx.arc(x, labelY - (sleeping ? 16 : 1), 3, 0, Math.PI * 2)
          ctx.fill()
          ctx.restore()
        }
        if (sleeping) {
          caption(ctx, `撑不动了 · ${formatDuration(visual.digestionRemainingSec)}`, x, labelY, '#102238ea', '#e9caf3')
          const snore = (seconds + visual.speechSeed % 9) % 4.6
          if (snore < 1.8) {
            ctx.save()
            ctx.globalAlpha *= Math.min(1, (1.8 - snore) * 0.9)
            caption(ctx, '💤', x + 22 + snore * 8, labelY - 22 - snore * 13, '#203956b9', '#e7eaff')
            ctx.restore()
          }
        }
        const burping = !sleeping && (bellyOverload === 1 || bellyFillRatio >= 0.75)
          && (phase + visual.speechSeed % 13) % (bellyOverload === 1 ? 3.2 : 9.5) < 0.65
        if (burping) {
          caption(ctx, '嗝~', x, labelY - 4, '#102b3cb5', '#cdf1eb')
        }
        if (current.spotlight === fish.id) caption(ctx, fish.name, x, y + height / 2 + 15, '#123947e8', '#c6ffec')
        if (swimmer.alertTimer || swimmer.scaredTimer) {
          const head = mouthPosition(swimmer, bounds)
          caption(ctx, '！', head.x, Math.min(labelY, head.y - 14), '#ffe17b', '#533c15')
        }
        if (swimmer.stun > 0) {
          ctx.fillStyle = '#ffeab0'
          for (let i = 0; i < 3; i++) {
            const angle = seconds * 8 + i * 2.1
            sparkle(ctx, x + Math.cos(angle) * 14, labelY - 17 + Math.sin(angle) * 5, 4, angle)
          }
        }
        if (fish.tagline && !sleeping && !burping && !swimmer.targetId && !swimmer.stun && !swimmer.scaredTimer && speaking < 2) {
          const period = 14 + visual.speechSeed % 11
          const progress = (seconds + (visual.speechSeed % 997) / 997 * period) % period
          if (progress < 3.6) {
            speaking++
            ctx.save()
            ctx.globalAlpha *= Math.min(1, progress / 0.4, (3.6 - progress) / 0.65)
            caption(ctx, fish.tagline, x, labelY - 12 - 4 * progress, '#173f59e0', '#e5faff')
            ctx.restore()
          }
        }
      }
      if (knock && knockAge >= 0 && knockAge < 0.94) glassRipple(ctx, knock, knockAge / 0.94)
      for (const hit of hits) {
        const progress = (time - hit.start) / 650
        burst(ctx, hit, progress, false)
        ctx.save()
        ctx.globalAlpha *= 1 - progress
        caption(ctx, '💥 咣！', hit.x, hit.y - 13 - progress * 15, '#48293bed', '#ffedbd')
        ctx.restore()
      }
      for (const effect of floats) {
        const visual = pool.get(effect.fishId)
        if (!visual && !effect.golden) continue
        const elapsed = (time - effect.start) / 2200
        const x = visual?.swimmer.x ?? bounds.width / 2
        const y = visual?.swimmer.y ?? bounds.height * 0.36
        if (effect.golden && elapsed < 0.7) burst(ctx, { x, y }, elapsed / 0.7, true)
        ctx.save()
        ctx.globalAlpha = Math.min(1, (1 - elapsed) * 2)
        let message = floatText[effect.outcome]
        if (effect.golden) {
          const growth = effect.xpGained ? `+${effect.xpGained} 成长` : ''
          if (effect.outcome === 'stuffed_full') message = `👑 黄金大餐！${growth ? `${growth} · ` : ''}直接撑翻！`
          else if (effect.outcome === 'stuffed') message = `👑 黄金大餐！${growth ? `${growth} · ` : ''}吃撑啦`
          else message = `👑 黄金大餐！${growth || '美味！'}`
        }
        caption(ctx, message, x, y - 32 - 34 * elapsed,
          effect.golden ? '#493922ed' : '#102a3deb', effect.golden ? '#ffe9a2' : '#deffe8')
        ctx.restore()
      }
      ctx.restore()
    }
    frame = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      pool.clear()
    }
  }, [])

  function coordinates(event: MouseEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top, width: rect.width, height: rect.height }
  }

  function hitFish(x: number, y: number) {
    const list = [...swimmers.current.values()].reverse()
    for (const { swimmer, fish, image } of list) {
      const size = displayedSize(fish.size, water.current)
      const scale = Math.max(image.naturalWidth, image.naturalHeight, 1)
      const width = size * (image.naturalWidth || scale) / scale * Math.max(0.5, Math.abs(swimmer.facing))
      const height = size * (image.naturalHeight || scale) / scale
      if (((x - swimmer.x) / (width / 2 + 12)) ** 2 + ((y - swimmer.y) / (height / 2 + 12)) ** 2 <= 1) {
        return fish.id
      }
    }
  }

  function click(event: MouseEvent<HTMLCanvasElement>) {
    const { x, y, width, height } = coordinates(event)
    if (props.feeding) { props.onWaterClick(x / width, y / height); return }
    const id = hitFish(x, y)
    if (id) props.onFishClick(id)
  }

  function knock(event: MouseEvent<HTMLCanvasElement>) {
    if (props.feeding) return
    const { x, y } = coordinates(event)
    if (hitFish(x, y)) return
    knockTank([...swimmers.current.values()].map(item => item.swimmer), x, y, water.current)
    lastKnock.current = { x, y, start: performance.now() }
    unlockSound()
    playSound('knock')
  }

  return <canvas ref={ref} className={`tank-canvas${props.feeding ? ' feeding' : ''}`} aria-label={`${props.tankName}水域`}
    onClick={click} onDoubleClick={knock} onPointerMove={event => { pointer.current = coordinates(event) }}
    onPointerLeave={() => { pointer.current = null }} />
}
