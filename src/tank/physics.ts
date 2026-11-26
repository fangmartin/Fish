import { getBellyMovementFactor, type BellyOverload, type Stats } from '../../shared/domain'

export interface Body {
  id: string
  size: number
  stats: Stats
  bellyFillRatio: number
  bellyOverload: BellyOverload
}

export interface Swimmer {
  body: Body
  x: number
  y: number
  heading: number
  speed: number
  energy: number
  rest: number
  stun: number
  alertTimer: number
  scaredTimer: number
  targetId: string | null
  reaction: number
  phase: number
  facing: number
  pushX: number
  pushY: number
  sprinting: boolean
}

export interface Food {
  id: string
  x: number
  y: number
  age: number
  claiming: boolean
  golden?: boolean
}

export interface CollisionEvent {
  attackerId: string
  victimId: string
  x: number
  y: number
  brawn: number
  force: number
}

interface TankStepEvents {
  onCollision?: (hit: CollisionEvent) => void
  onAlert?: (fishId: string) => void
}

export interface Water {
  width: number
  height: number
}

const baseCruiseSpeed = (size: number) => 49 - (size - 40) * 0.055
export const cruiseSpeed = (body: Body) => baseCruiseSpeed(body.size) * getBellyMovementFactor(body.bellyFillRatio, body.bellyOverload)
export const sightRadius = (sense: number) => 185 + sense * 48
const SPLASH_SECONDS = 0.48
const energyLimit = (stamina: number) => 2.3 + stamina * 0.49
export const displayedSize = (size: number, water: Water) => Math.min(size, water.width * 0.35, water.height * 0.48)
export const floorY = ({ height }: Water) => height * 0.91
export const KNOCK_RADIUS = 320
export const GOLDEN_SINK_SPEED = 23
const wrap = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle))
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

export function createSwimmer(body: Body, x: number, y: number, heading: number, phase: number): Swimmer {
  return {
    body, x, y, heading, phase, speed: cruiseSpeed(body), energy: energyLimit(body.stats.stamina),
    rest: 0, stun: 0, alertTimer: 0, scaredTimer: 0, targetId: null, reaction: 0, facing: Math.cos(heading) > 0 ? -1 : 1,
    pushX: 0, pushY: 0, sprinting: false,
  }
}

export function knockTank(fish: Swimmer[], x: number, y: number, water: Water): string[] {
  const startled: string[] = []
  const pointX = clamp(x, 0, water.width)
  const pointY = clamp(y, 0, water.height)
  for (const swimmer of fish) {
    if (swimmer.body.bellyOverload === 2) continue
    const dx = swimmer.x - pointX
    const dy = swimmer.y - pointY
    const distance = Math.hypot(dx, dy)
    if (distance > KNOCK_RADIUS) continue
    if (distance > 0) swimmer.heading = Math.atan2(dy, dx)
    const force = 45 + (1 - distance / KNOCK_RADIUS) * 220
    swimmer.pushX += Math.cos(swimmer.heading) * force
    swimmer.pushY += Math.sin(swimmer.heading) * force
    swimmer.scaredTimer = 1.1
    swimmer.alertTimer = 0
    swimmer.targetId = null
    swimmer.sprinting = false
    startled.push(swimmer.body.id)
  }
  return startled
}

export function pitch(fish: Swimmer) {
  const headSide = -Math.sign(fish.facing || 1)
  const vertical = Math.sin(fish.heading) * headSide
  return fish.targetId && !fish.stun
    ? Math.atan2(vertical, Math.max(0.12, Math.abs(Math.cos(fish.heading))))
    : vertical * 0.37
}

export function mouthPosition(fish: Swimmer, water: Water) {
  const reach = displayedSize(fish.body.size, water) * 0.42
    * Math.sign(fish.facing || 1) * Math.max(0.065, Math.abs(fish.facing))
  const slope = pitch(fish)
  return {
    x: fish.x - reach * Math.cos(slope),
    y: fish.y - reach * Math.sin(slope),
  }
}

function nearestFood(fish: Swimmer, pellets: Food[], water: Water) {
  const mouth = mouthPosition(fish, water)
  let nearest: Food | undefined
  let distance = Infinity
  for (const pellet of pellets) {
    if (pellet.claiming) continue
    const gap = (pellet.x - mouth.x) ** 2 + (pellet.y - mouth.y) ** 2
    if (gap < distance) {
      distance = gap
      nearest = pellet
    }
  }
  return nearest && { pellet: nearest, inSight: distance <= sightRadius(fish.body.stats.sense) ** 2 }
}

export function stepTank(fish: Swimmer[], pellets: Food[], water: Water, dt: number, events?: TankStepEvents) {
  for (const pellet of pellets) {
    pellet.y = Math.min(floorY(water), pellet.y + (pellet.golden ? GOLDEN_SINK_SPEED : 37) * dt)
    pellet.age += dt
  }

  for (const swimmer of fish) {
    const { body } = swimmer
    const { stats } = body
    const movement = getBellyMovementFactor(body.bellyFillRatio, body.bellyOverload)
    const size = displayedSize(body.size, water)
    const weight = (body.size - 40) / 235
    const margin = Math.min(size * 0.47 + 9, water.width * 0.22)
    const ceiling = Math.min(64, water.height * 0.13) + size * 0.12
    const bottom = Math.min(water.height - size * 0.28 - 8, floorY(water) + size * 0.14)
    swimmer.phase += dt
    swimmer.stun = Math.max(0, swimmer.stun - dt)
    swimmer.rest = Math.max(0, swimmer.rest - dt)
    swimmer.alertTimer = Math.max(0, swimmer.alertTimer - dt)
    swimmer.scaredTimer = Math.max(0, swimmer.scaredTimer - dt)

    const food = body.bellyOverload !== 2 && !swimmer.scaredTimer ? nearestFood(swimmer, pellets, water) : undefined
    const target = food?.pellet
    const targetId = target?.id ?? null
    if (swimmer.targetId !== targetId) {
      swimmer.targetId = targetId
      swimmer.reaction = food ? 0.34 - stats.sense * 0.045 + (food.inSight ? 0 : 0.1) : 0
      if (target && stats.sense >= 2) {
        swimmer.alertTimer = 0.75
        events?.onAlert?.(body.id)
      }
    }
    swimmer.reaction = Math.max(0, swimmer.reaction - dt)
    const pursuit = target && swimmer.reaction === 0
    swimmer.sprinting = Boolean(pursuit && swimmer.energy > 0 && !swimmer.rest && !swimmer.stun)
    if (swimmer.sprinting) {
      swimmer.energy = Math.max(0, swimmer.energy - (1 + weight * 0.42) * dt)
      if (!swimmer.energy) swimmer.rest = 0.85
    } else {
      swimmer.energy = Math.min(energyLimit(stats.stamina), swimmer.energy + (0.46 + stats.stamina * 0.15) * dt)
    }

    let heading = swimmer.heading + (Math.sin(swimmer.phase * 1.23) * 0.62 + Math.sin(swimmer.phase * 0.31) * 0.37) * dt
    const distance = target ? Math.hypot(target.x - swimmer.x, target.y - swimmer.y) : Infinity
    if (target && !swimmer.stun) {
      heading = Math.atan2(target.y - swimmer.y, target.x - swimmer.x)
    } else {
      let vx = Math.cos(heading)
      let vy = Math.sin(heading)
      vx += clamp((margin - swimmer.x) / 37, 0, 1) * 2.7
      vx -= clamp((swimmer.x - water.width + margin) / 37, 0, 1) * 2.7
      vy += clamp((ceiling - swimmer.y) / 38, 0, 1) * 2.3
      vy -= clamp((swimmer.y - bottom) / 34, 0, 1) * 2.3
      for (const peer of fish) {
        if (peer === swimmer) continue
        const dx = swimmer.x - peer.x
        const dy = swimmer.y - peer.y
        const gap = Math.hypot(dx, dy)
        const comfort = (size + displayedSize(peer.body.size, water)) * 0.28
        if (gap > 0 && gap < comfort) {
          const avoid = (1 - gap / comfort) / gap
          vx += dx * avoid
          vy += dy * avoid
        }
      }
      heading = Math.atan2(vy, vx)
    }

    const rotation = (2.1 + stats.agility * 0.39) * movement / (1 + weight * 0.65) * dt
    swimmer.heading = wrap(swimmer.heading + clamp(wrap(heading - swimmer.heading), -rotation, rotation))
    const cruising = baseCruiseSpeed(body.size)
    const speed = movement * (swimmer.sprinting
      ? (cruising + 62 + stats.burst * 22) * clamp(distance / (size * 0.56), 0.39, 1)
      : cruising * (swimmer.scaredTimer ? 1 + swimmer.scaredTimer : swimmer.rest || swimmer.stun ? 0.66 : 1))
    const acceleration = (2.8 + stats.agility * 0.62) * movement
    swimmer.speed += (speed - swimmer.speed) * (1 - Math.exp(-acceleration * dt))
    swimmer.x = clamp(swimmer.x + (Math.cos(swimmer.heading) * swimmer.speed + swimmer.pushX) * dt,
      size * 0.36, water.width - size * 0.36)
    swimmer.y = clamp(swimmer.y + (Math.sin(swimmer.heading) * swimmer.speed + swimmer.pushY) * dt,
      size * 0.22, water.height - size * 0.22)
    const direction = Math.cos(swimmer.heading)
    if (Math.abs(direction) > 0.12) {
      swimmer.facing += ((direction > 0 ? -1 : 1) - swimmer.facing) * (1 - Math.exp(-10 * dt))
    }
    swimmer.pushX *= Math.exp(-4.4 * dt)
    swimmer.pushY *= Math.exp(-4.4 * dt)
  }

  for (const attacker of fish) {
    if (!attacker.sprinting || attacker.stun) continue
    for (const peer of fish) {
      if (peer === attacker || peer.stun) continue
      const dx = peer.x - attacker.x
      const dy = peer.y - attacker.y
      const gap = Math.hypot(dx, dy)
      const size = displayedSize(attacker.body.size, water) + displayedSize(peer.body.size, water)
      const ahead = dx * Math.cos(attacker.heading) + dy * Math.sin(attacker.heading)
      if (gap < 0.01 || gap > size * 0.49 || ahead <= 0) continue
      const force = (19 + attacker.body.stats.brawn * 18 + attacker.body.size * 0.17) / (1 + peer.body.size / 160)
      peer.pushX += dx / gap * force
      peer.pushY += dy / gap * force
      peer.stun = 0.24 + attacker.body.stats.brawn * 0.058
      peer.sprinting = false
      events?.onCollision?.({
        attackerId: attacker.body.id, victimId: peer.body.id,
        x: (attacker.x + peer.x) / 2, y: (attacker.y + peer.y) / 2,
        brawn: attacker.body.stats.brawn, force,
      })
    }
  }

  const contacts: { pelletId: string; fishId: string }[] = []
  for (const pellet of pellets) {
    // A splash draws the whole tank before a fish next to the entry point can claim it.
    if (pellet.claiming || pellet.age < SPLASH_SECONDS) continue
    let winner: Swimmer | undefined
    let nearest = Infinity
    for (const swimmer of fish) {
      if (swimmer.body.bellyOverload === 2 || swimmer.stun || swimmer.scaredTimer) continue
      const mouth = mouthPosition(swimmer, water)
      const gap = Math.hypot(mouth.x - pellet.x, mouth.y - pellet.y)
      const reach = (pellet.golden ? 16 : 9) + Math.min(12, displayedSize(swimmer.body.size, water) * 0.075)
      if (gap <= reach && gap < nearest) {
        winner = swimmer
        nearest = gap
      }
    }
    if (winner) contacts.push({ pelletId: pellet.id, fishId: winner.body.id })
  }
  return contacts
}
