import { describe, expect, it } from 'vitest'
import { EMPTY_STATS, type BellyOverload, type Stats } from '../shared/domain'
import { createSwimmer, cruiseSpeed, floorY, knockTank, mouthPosition, stepTank, type CollisionEvent, type Food, type Swimmer } from '../src/tank/physics'
import { resolveTidePhase } from '../src/tank/ambient'

const water = { width: 960, height: 600 }
const body = (id: string, stats: Partial<Stats> = {}, bellyOverload: BellyOverload = 0, size = 40) => ({
  id, size, stats: { ...EMPTY_STATS, ...stats }, bellyFillRatio: bellyOverload ? 1 : 0, bellyOverload,
})
const pellet = (x: number, y: number): Food => ({ id: 'pellet', x, y, age: 0, claiming: false })
const simulate = (fish: Swimmer[], food: Food[], seconds: number) => {
  for (let step = 0; step < Math.round(seconds * 60); step++) stepTank(fish, food, water, 1 / 60)
}

describe('公共鱼缸物理', () => {
  it('敲玻璃让半径内的鱼朝反方向逃逸，并跳过撑瘫和半径外的鱼', () => {
    const near = createSwimmer(body('near'), 450, 300, 0, 0)
    const edge = createSwimmer(body('edge', {}, 1), 820, 300, Math.PI, 0)
    const outside = createSwimmer(body('outside'), 821, 300, 0, 0)
    const full = createSwimmer(body('full', {}, 2), 480, 300, 0, 0)
    near.targetId = 'pellet'
    near.sprinting = true
    const group = [near, edge, outside, full]
    expect(knockTank(group, 500, 300, water)).toEqual(['near', 'edge'])
    expect(near).toMatchObject({ scaredTimer: 1.1, heading: Math.PI, targetId: null, sprinting: false })
    expect(-near.pushX).toBeGreaterThan(edge.pushX)
    expect([outside.pushX, full.pushX, full.scaredTimer]).toEqual([0, 0, 0])
    stepTank(group, [pellet(490, 300)], water, 0.02)
    expect(near.x).toBeLessThan(450)
    expect(near.targetId).toBeNull()
  })

  it('高感知第一次锁定鱼食时惊觉，持续锁定不重复触发', () => {
    const scout = createSwimmer(body('scout', { sense: 2 }), 300, 300, 0, 0)
    const alerts: string[] = []
    const food = { ...pellet(510, 150), golden: true }
    stepTank([scout], [food], water, 0.02, { onAlert: id => alerts.push(id) })
    expect(alerts).toEqual(['scout'])
    expect(scout.alertTimer).toBe(0.75)
    expect(food.y).toBeCloseTo(150.46)
    stepTank([scout], [food], water, 0.12, { onAlert: id => alerts.push(id) })
    expect(alerts).toEqual(['scout'])
    expect(scout.alertTimer).toBeCloseTo(0.63)
  })

  it('撑翻的鱼以四分之一速度漂浮，鱼嘴接触鱼食时也无法追食或吃食', () => {
    const fish = createSwimmer(body('full', { sense: 6, burst: 6 }, 2), 285, 260, 0, 0)
    fish.targetId = 'pellet'
    fish.sprinting = true
    const mouth = mouthPosition(fish, water)
    const food = { ...pellet(mouth.x, mouth.y), age: 1 }
    expect(stepTank([fish], [food], water, 0)).toEqual([])
    expect(fish.targetId).toBeNull()
    expect(fish.sprinting).toBe(false)
    const awake = createSwimmer(body('awake'), 285, 260, 0, 0)
    expect(stepTank([awake], [food], water, 0)).toEqual([{ pelletId: food.id, fishId: 'awake' }])
    simulate([fish], [food], 0.8)
    expect(fish.targetId).toBeNull()
    expect(fish.sprinting).toBe(false)
    expect(fish.x).toBeGreaterThan(285)
    expect(fish.speed).toBeCloseTo(cruiseSpeed(body('base')) * 0.25)
  })

  it('饱腹 55% 前保持满速，之后逐渐减速，微撑进一步降低移速与转向', () => {
    const bodies = [0, 0.4, 0.55, 0.775, 1].map(bellyFillRatio => ({
      ...body(String(bellyFillRatio)), bellyFillRatio,
    }))
    bodies.push(body('overloaded', {}, 1))
    const fish = bodies.map(item => createSwimmer(item, 450, 250, 0, 1.1))
    for (const item of fish) simulate([item], [], 0.6)
    const [hungry, half, threshold, satisfied, full, overloaded] = fish
    expect(half.speed).toBeCloseTo(hungry.speed)
    expect(threshold.speed).toBeCloseTo(hungry.speed)
    expect(satisfied.speed / hungry.speed).toBeCloseTo(0.84)
    expect(full.speed / hungry.speed).toBeCloseTo(0.68)
    expect(overloaded.speed / hungry.speed).toBeCloseTo(0.45)
    const turn = bodies.slice(2).map(item => createSwimmer(item, 450, 250, 0, 0))
    for (const item of turn) { item.targetId = 'pellet'; simulate([item], [pellet(449, 360)], 0.16) }
    expect(Math.abs(turn[3].heading)).toBeLessThan(Math.abs(turn[2].heading))
    expect(Math.abs(turn[2].heading)).toBeLessThan(Math.abs(turn[1].heading))
    expect(Math.abs(turn[1].heading)).toBeLessThan(Math.abs(turn[0].heading))
  })

  it('感知力扩大快速响应的范围并缩短反应延迟', () => {
    const baseline = createSwimmer(body('baseline'), 190, 220, 0, 0)
    const scout = createSwimmer(body('scout', { sense: 6 }), 190, 220, 0, 0)
    simulate([baseline], [pellet(525, 220)], 0.38)
    simulate([scout], [pellet(525, 220)], 0.38)
    expect(baseline.targetId).toBe('pellet')
    expect(baseline.sprinting).toBe(false)
    expect(scout.targetId).toBe('pellet')
    expect(scout.sprinting).toBe(true)
    const slow = createSwimmer(body('slow'), 190, 220, 0, 0)
    simulate([slow], [pellet(310, 220)], 0.38)
    expect(slow.targetId).toBe('pellet')
    expect(slow.sprinting).toBe(true)
  })

  it('爆发力提升速度，灵巧度缩短转弯，耐力延后冲刺耗尽', () => {
    const slow = createSwimmer(body('slow', { sense: 6 }), 160, 220, 0, 0)
    const fast = createSwimmer(body('fast', { sense: 6, burst: 6 }), 160, 220, 0, 0)
    for (const item of [slow, fast]) simulate([item], [pellet(480, 210)], 0.72)
    expect(fast.sprinting).toBe(true)
    expect(fast.speed).toBeGreaterThan(slow.speed + 70)

    const agile = createSwimmer(body('agile', { agility: 6 }), 450, 250, 0, 0)
    const heavy = createSwimmer(body('heavy', {}, 0, 220), 450, 250, 0, 0)
    for (const item of [agile, heavy]) { item.targetId = 'pellet'; simulate([item], [pellet(450, 405)], 0.12) }
    expect(agile.heading).toBeGreaterThan(heavy.heading * 2)

    const standard = createSwimmer(body('standard', { sense: 6 }), 495, 210, Math.PI, 0)
    const strong = createSwimmer(body('strong', { sense: 6, stamina: 6 }), 495, 210, Math.PI, 0)
    for (const item of [standard, strong]) {
      const food = pellet(78, 355)
      for (let i = 0; i < 165; i++) stepTank([item], [food], water, 1 / 60)
    }
    expect(standard.rest).toBeGreaterThan(0)
    expect(strong.rest).toBe(0)
    expect(strong.energy).toBeGreaterThan(standard.energy + 1)
  })

  it('追食冲刺时冲撞力增加挤推和打断，日常错身无冲量', () => {
    function collision(brawn: number, feeding: boolean) {
      const attacker = createSwimmer(body('attacker', { brawn }), 418, 251, 0, 0)
      const victim = createSwimmer(body('victim'), 451, 252, 0, 0)
      attacker.targetId = victim.targetId = 'pellet'
      stepTank([attacker, victim], feeding ? [pellet(572, 250)] : [], water, 1 / 60)
      return victim
    }
    const peaceful = collision(6, false)
    expect(peaceful.stun).toBe(0)
    expect(peaceful.pushX).toBe(0)
    const mild = collision(0, true)
    const powerful = collision(6, true)
    expect(mild.pushX).toBeGreaterThan(0)
    expect(powerful.pushX).toBeGreaterThan(mild.pushX * 2)
    expect(powerful.stun).toBeGreaterThan(mild.stun)
    expect(powerful.sprinting).toBe(false)
  })

  it('两条 275 像素大鱼相距 200 像素时可以发生追食冲撞', () => {
    const attacker = createSwimmer(body('attacker', { brawn: 6 }, 0, 275), 400, 300, 0, 0)
    const peer = createSwimmer(body('peer', {}, 0, 275), 600, 300, 0, 0)
    attacker.targetId = peer.targetId = 'pellet'
    const hits: CollisionEvent[] = []

    const food = [pellet(800, 300)]
    stepTank([attacker, peer], food, water, 1 / 60, { onCollision: hit => hits.push(hit) })

    expect(attacker.sprinting).toBe(true)
    expect(peer.pushX).toBeGreaterThan(0)
    expect(peer.stun).toBeGreaterThan(0)
    expect(peer.sprinting).toBe(false)
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ attackerId: 'attacker', victimId: 'peer', brawn: 6, force: expect.any(Number) })
    expect(hits[0].x).toBeCloseTo((attacker.x + peer.x) / 2)
    expect(hits[0].y).toBeCloseTo((attacker.y + peer.y) / 2)
    stepTank([attacker, peer], food, water, 1 / 60, { onCollision: hit => hits.push(hit) })
    expect(hits).toHaveLength(1)
  })

  it('鱼食下沉停留在缸底，鱼嘴接触时只选择一个赢家', () => {
    const food = pellet(400, floorY(water) - 2)
    stepTank([], [food], water, 0.1)
    expect(food.y).toBe(floorY(water))
    stepTank([], [food], water, 0.1)
    expect(food.y).toBe(floorY(water))
    const smallest = createSwimmer(body('fry'), 383, food.y, 0, 0)
    const another = createSwimmer(body('other'), 373, food.y, 0, 0)
    expect(stepTank([smallest, another], [food], water, 1 / 60)).toEqual([])
    stepTank([], [food], water, 0.28)
    expect(stepTank([smallest, another], [food], water, 1 / 60)).toEqual([{ pelletId: 'pellet', fishId: 'fry' }])
    food.claiming = true
    expect(stepTank([smallest], [food], water, 1 / 60)).toEqual([])
  })

  it('一颗鱼食让水域各处还能吃的鱼一起转向并冲刺', () => {
    const near = createSwimmer(body('near'), 358, 400, 0, 0)
    const far = createSwimmer(body('far'), 75, 400, 0, 0)
    const across = createSwimmer(body('across', {}, 1), 880, 380, Math.PI, 0)
    const full = createSwimmer(body('full', {}, 2), 380, 430, 0, 0)
    const fish = [near, far, across, full]
    const food = pellet(400, 400)
    expect(stepTank(fish, [food], water, 1 / 60)).toEqual([])
    expect(fish.map(item => item.targetId)).toEqual(['pellet', 'pellet', 'pellet', null])
    expect(across.heading).toBeLessThan(Math.PI)

    let winner: string | undefined
    for (let frame = 0; frame < 90 && !winner; frame++) {
      winner = stepTank(fish, [food], water, 1 / 60)[0]?.fishId
    }
    expect(winner).toBe('near')
    expect(far.sprinting).toBe(true)
    expect(across.sprinting).toBe(true)
    expect(full.sprinting).toBe(false)
  })

  it('沉底鱼食可由上方鱼接近并吃掉', () => {
    for (const size of [40, 150, 275]) {
      const fish = createSwimmer(body('chaser', {}, 0, size), 450, 388, 0, 0)
      const food = pellet(452, floorY(water))
      let winner: string | undefined
      for (let frame = 0; frame < 1200 && !winner; frame++) {
        winner = stepTank([fish], [food], water, 1 / 60)[0]?.fishId
      }
      expect(winner, `${size}px 鱼要能在 20 秒内吃掉缸底的鱼食`).toBe('chaser')
    }
  })
})

it('昼夜自动按上海时间边界切换，手动选择覆盖自动', () => {
  const local = (time: string) => Date.parse(`2026-03-04T${time}:00+08:00`)
  const times = ['00:00', '04:59', '05:00', '09:59', '10:00', '16:59', '17:00', '19:59', '20:00', '23:59']
  expect(times.map(time => resolveTidePhase(local(time), 'auto')))
    .toEqual(['night', 'night', 'dawn', 'dawn', 'day', 'day', 'dusk', 'dusk', 'night', 'night'])
  expect(resolveTidePhase(local('13:00'), 'night')).toBe('night')
  expect(resolveTidePhase(local('03:00'), 'day')).toBe('day')
})
