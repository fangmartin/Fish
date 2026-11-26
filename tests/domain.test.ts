import { describe, expect, it } from 'vitest'
import {
  DAILY_RATION_LIMIT, EMPTY_STATS, LEVEL_XP_COSTS, MAX_ACTIVE_FISH_PER_KEEPER, MAX_EXPERIENCE,
  MAX_LEVEL, MAX_STAT_VALUE, REPORT_HIDE_THRESHOLD, STAT_KEYS, TANK_VIEW_LIMIT,
  EYE_STYLES, GOLDEN_FEAST_BONUS_XP, GOLDEN_FEAST_EVERY_FEEDS, GOLDEN_FEAST_LIFETIME_MS, MAX_FISH_EYES,
  allocateStats, applyGoldenFeast, canRespec, dailyCount, feedFish, formatDuration,
  getBellyCapacity, getBellyMovementFactor, getBellyState, getBuildTitle, getDigestIntervalMs,
  getGoldenFeastBellyCost, getGrowth, getStuffedComaMs, remainingRations,
  shanghaiDate, unspentPoints, validateEyes, type FeedingState, type StatKey,
} from '../shared/domain'

const beforeMidnight = Date.parse('2026-03-04T15:59:59.999Z')
const midnight = beforeMidnight + 1
const newFish: FeedingState = {
  experience: 0, appetite: 0, rawBellyLoad: 0, rawStuffedFull: false, bellyUpdatedAt: midnight,
}

describe('共享领域规则', () => {
  it('眼球限制数量、样式及每个有限坐标和半径范围', () => {
    const eye = { x: 0, y: 1, radius: 0.02, style: 'googly' }
    expect(MAX_FISH_EYES).toBe(4)
    expect(validateEyes(undefined)).toEqual([])
    expect(validateEyes([])).toEqual([])
    const allowed = [...EYE_STYLES.map(style => ({ ...eye, style })), { ...eye, radius: 0.2 }]
    expect(validateEyes(allowed)).toEqual(allowed)
    for (const invalid of [null, {}, [null], [4], Array(5).fill(eye),
      [{ ...eye, style: 'unknown' }], [{ ...eye, x: '0.2' }], [{ ...eye, x: Infinity }],
      [{ ...eye, x: -0.01 }], [{ ...eye, y: 1.01 }], [{ ...eye, radius: 0.01 }], [{ ...eye, radius: 0.21 }]]) {
      expect(validateEyes(invalid)).toBeNull()
    }
  })

  it('流派称号覆盖各单项、初生和并列最高', () => {
    expect(getBuildTitle(EMPTY_STATS, 1)).toBe('初生萌鱼')
    expect(getBuildTitle(EMPTY_STATS, 2)).toBe('全能游侠')
    const titles: Record<StatKey, string> = {
      burst: '深海鱼雷', stamina: '永动机', sense: '顺风耳', agility: '深海泥鳅', brawn: '全缸恶霸', appetite: '深海无底洞',
    }
    for (const [key, title] of Object.entries(titles)) {
      expect(getBuildTitle({ ...EMPTY_STATS, [key]: 3 }, 4)).toBe(title)
    }
    expect(getBuildTitle({ ...EMPTY_STATS, brawn: 2, appetite: 2 }, 5)).toBe('霸王餐恶霸')
    expect(getBuildTitle({ ...EMPTY_STATS, burst: 2, appetite: 2 }, 5)).toBe('深海吸尘器')
    expect(getBuildTitle({ ...EMPTY_STATS, sense: 2, appetite: 2 }, 5)).toBe('干饭雷达')
    expect(getBuildTitle({ ...EMPTY_STATS, burst: 2, brawn: 2 }, 5)).toBe('深海泥头车')
    expect(getBuildTitle({ ...EMPTY_STATS, burst: 2, agility: 2 }, 5)).toBe('水中幽灵')
    expect(getBuildTitle({ ...EMPTY_STATS, brawn: 2, sense: 2 }, 5)).toBe('全能游侠')
    expect(getBuildTitle(EMPTY_STATS, MAX_LEVEL)).toBe('六边形战神')
    expect(getBuildTitle({ burst: 2, stamina: 2, sense: 2, agility: 2, brawn: 2, appetite: 2 }, MAX_LEVEL))
      .toBe('六边形战神')
  })

  it('固定每日配额、在缸容量、水域切片与举报门槛', () => {
    expect([DAILY_RATION_LIMIT, MAX_ACTIVE_FISH_PER_KEEPER, TANK_VIEW_LIMIT, REPORT_HIDE_THRESHOLD])
      .toEqual([20, 3, 35, 3])
    expect(remainingRations(0)).toBe(20)
    expect(remainingRations(1)).toBe(19)
    expect(remainingRations(19)).toBe(1)
    expect(remainingRations(20)).toBe(0)
    expect(remainingRations(21)).toBe(0)
  })

  it('阶梯经验曲线每升一级加一点，在 33 经验和 18 级封顶', () => {
    expect(LEVEL_XP_COSTS).toEqual([1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3])
    expect(MAX_LEVEL).toBe(18)
    expect(MAX_EXPERIENCE).toBe(33)
    let total = 0
    for (const [index, cost] of LEVEL_XP_COSTS.entries()) {
      const level = index + 1
      expect(getGrowth(total)).toMatchObject({ level, progress: 0, nextLevelXp: cost })
      expect(getGrowth(total + cost - 1)).toMatchObject({ level, progress: cost - 1 })
      total += cost
      expect(getGrowth(total).level).toBe(level + 1)
      expect(unspentPoints(level + 1, EMPTY_STATS)).toBe(level)
    }
    expect(total).toBe(MAX_EXPERIENCE)
    expect(getGrowth(33)).toEqual({ level: 18, stage: 'emperor', progress: 0, nextLevelXp: 0, size: 275 })
    expect(getGrowth(55)).toEqual(getGrowth(33))
    expect(getGrowth(-10)).toEqual(getGrowth(0))
  })

  it('在阶段边界正确切换，且每颗有效鱼食都增加尺寸', () => {
    expect([0, 2, 3, 7, 8, 15, 16, 29, 30, 33].map(xp => getGrowth(xp).stage))
      .toEqual(['fry', 'fry', 'juvenile', 'juvenile', 'adult', 'adult', 'leviathan', 'leviathan', 'emperor', 'emperor'])
    expect(getGrowth(0).size).toBe(40)
    for (let xp = 0; xp < MAX_EXPERIENCE; xp++) {
      const growth = getGrowth(xp + 1).size - getGrowth(xp).size
      expect(growth).toBeGreaterThan(0)
      expect(growth).toBeCloseTo(235 / 33)
    }
  })

  it('使用上海时区零点重置每日计数与洗点', () => {
    expect(shanghaiDate(beforeMidnight)).toBe('2026-03-04')
    expect(shanghaiDate(midnight)).toBe('2026-03-05')
    expect(dailyCount(6, '2026-03-04', beforeMidnight)).toBe(6)
    expect(dailyCount(6, '2026-03-04', midnight)).toBe(0)
    expect(canRespec(null, beforeMidnight)).toBe(true)
    expect(canRespec('2026-03-04', beforeMidnight)).toBe(false)
    expect(canRespec('2026-03-04', midnight)).toBe(true)
  })

  it('胃口增加容量并缩短消化与休眠时间，等级和胃口受边界约束', () => {
    expect([getBellyCapacity(1), getBellyCapacity(12), getBellyCapacity(18), getBellyCapacity(18, 6)])
      .toEqual([2, 19, 38, 50])
    expect([getDigestIntervalMs(1), getDigestIntervalMs(18), getDigestIntervalMs(18, 6)])
      .toEqual([120_000, 18_000, 9_000])
    expect([getStuffedComaMs(1), getStuffedComaMs(18), getStuffedComaMs(18, 6)])
      .toEqual([240_000, 70_000, 36_000])
    expect([getBellyCapacity(-3, -2), getBellyCapacity(18.9, 9), getBellyCapacity(4.8, 1)])
      .toEqual([2, 50, 7])
    expect([getGoldenFeastBellyCost(2), getGoldenFeastBellyCost(20), getGoldenFeastBellyCost(50)])
      .toEqual([4, 7, 18])
  })

  it('饱腹影响移动系数并按秒格式化时间', () => {
    expect(getBellyMovementFactor(0.55, 0)).toBe(1)
    expect(getBellyMovementFactor(0.775, 0)).toBeCloseTo(0.84)
    expect(getBellyMovementFactor(1, 0)).toBeCloseTo(0.68)
    expect(getBellyMovementFactor(1.1, 0)).toBeCloseTo(0.68)
    expect(getBellyMovementFactor(1, 1)).toBe(0.45)
    expect(getBellyMovementFactor(1, 2)).toBe(0.25)
    expect([-1, 0.01, 59, 59.1, 60.1, 120].map(formatDuration))
      .toEqual(['0 秒', '1 秒', '59 秒', '1 分钟', '1 分 1 秒', '2 分钟'])
  })

  it('每到一个消化间隔释放一格，保留消化中的小数时间和贪吃状态', () => {
    expect(getBellyState(-3, false, midnight, 1, 0, midnight)).toEqual({
      bellyUsed: 0, bellyCapacity: 2, bellyFillRatio: 0, bellyOverload: 0, isStuffedFull: false,
      digestionRemainingSec: 0, currentLoad: 0, nextAnchorMs: midnight,
    })
    expect(getBellyState(1.9, false, midnight, 1, 0, midnight - 100)).toMatchObject({
      bellyUsed: 1, bellyFillRatio: 0.5, digestionRemainingSec: 120, currentLoad: 1, nextAnchorMs: midnight,
    })
    expect(getBellyState(3, false, midnight, 1, 0, midnight + 119_999)).toEqual({
      bellyUsed: 2, bellyCapacity: 2, bellyFillRatio: 1, bellyOverload: 1, isStuffedFull: false,
      digestionRemainingSec: 1, currentLoad: 3, nextAnchorMs: midnight,
    })
    expect(getBellyState(3, false, midnight, 1, 0, midnight + 120_000)).toMatchObject({
      bellyUsed: 2, bellyFillRatio: 1, bellyOverload: 0, digestionRemainingSec: 120, currentLoad: 2,
      nextAnchorMs: midnight + 120_000,
    })
    expect(getBellyState(3, false, midnight, 1, 0, midnight + 245_000)).toMatchObject({
      bellyUsed: 1, bellyFillRatio: 0.5, digestionRemainingSec: 115, currentLoad: 1, nextAnchorMs: midnight + 240_000,
    })
    expect(getBellyState(3, false, midnight, 1, 0, midnight + 360_001)).toMatchObject({
      bellyUsed: 0, digestionRemainingSec: 0, currentLoad: 0, nextAnchorMs: midnight + 360_001,
    })
  })

  it('普通进食增加经验，升级缩短间隔时保留原消化进度', () => {
    expect(feedFish(newFish, midnight + 100)).toEqual({
      ...newFish, experience: 1, rawBellyLoad: 1, bellyUpdatedAt: midnight + 100, levelDelta: 1, outcome: 'leveled_up',
    })
    const grew = feedFish({ ...newFish, experience: 6, rawBellyLoad: 2 }, midnight + 85_000)!
    expect(grew).toMatchObject({
      experience: 7, rawBellyLoad: 2, bellyUpdatedAt: midnight + 84_000, outcome: 'grew', levelDelta: 0,
    })
    const now = grew.bellyUpdatedAt + 83_000
    const upgraded = feedFish(grew, now)!
    expect(upgraded).toMatchObject({
      experience: 8, rawBellyLoad: 3, bellyUpdatedAt: now - 77_999, outcome: 'leveled_up', levelDelta: 1,
    })
    expect(getBellyState(upgraded.rawBellyLoad, upgraded.rawStuffedFull, upgraded.bellyUpdatedAt, 8, 0, now))
      .toMatchObject({ currentLoad: 3, bellyCapacity: 11, digestionRemainingSec: 1 })
    expect(getBellyState(upgraded.rawBellyLoad, upgraded.rawStuffedFull, upgraded.bellyUpdatedAt, 8, 0, now + 1))
      .toMatchObject({ currentLoad: 2, bellyCapacity: 11, digestionRemainingSec: 78 })
    expect(feedFish({ ...newFish, experience: MAX_EXPERIENCE }, midnight))
      .toMatchObject({ experience: 33, rawBellyLoad: 1, outcome: 'fed', levelDelta: 0 })
    expect(feedFish({ ...newFish, experience: 55 }, midnight))
      .toMatchObject({ experience: 55, rawBellyLoad: 1, outcome: 'fed', levelDelta: 0 })
  })

  it('满格硬塞先微撑后翻肚皮，休眠到期清空并恢复进食', () => {
    const warning = feedFish({ ...newFish, rawBellyLoad: 2 }, midnight + 200)!
    expect(warning).toEqual({ ...newFish, rawBellyLoad: 3, levelDelta: 0, outcome: 'stuffed' })
    const fellAsleepAt = midnight + 300
    const coma = feedFish(warning, fellAsleepAt)!
    expect(coma).toEqual({
      ...newFish, rawBellyLoad: 4, rawStuffedFull: true, bellyUpdatedAt: fellAsleepAt, levelDelta: 0, outcome: 'stuffed_full',
    })
    const stillAsleepAt = fellAsleepAt + 239_999
    expect(getBellyState(coma.rawBellyLoad, coma.rawStuffedFull, coma.bellyUpdatedAt, 1, 0, stillAsleepAt)).toEqual({
      bellyUsed: 2, bellyCapacity: 2, bellyFillRatio: 1, bellyOverload: 2, isStuffedFull: true,
      currentLoad: 4, digestionRemainingSec: 1, nextAnchorMs: fellAsleepAt,
    })
    expect(feedFish(coma, stillAsleepAt)).toBeNull()
    const wokeAt = stillAsleepAt + 1
    expect(getBellyState(coma.rawBellyLoad, coma.rawStuffedFull, coma.bellyUpdatedAt, 1, 0, wokeAt)).toEqual({
      bellyUsed: 0, bellyCapacity: 2, bellyFillRatio: 0, bellyOverload: 0, isStuffedFull: false,
      currentLoad: 0, digestionRemainingSec: 0, nextAnchorMs: wokeAt,
    })
    expect(feedFish(coma, wokeAt)).toMatchObject({
      experience: 1, rawBellyLoad: 1, rawStuffedFull: false, bellyUpdatedAt: wokeAt, outcome: 'leveled_up',
    })
  })

  it('黄金大餐能连跳三级，撑翻时保留升级与经验', () => {
    expect([GOLDEN_FEAST_EVERY_FEEDS, GOLDEN_FEAST_BONUS_XP, GOLDEN_FEAST_LIFETIME_MS]).toEqual([15, 3, 120_000])
    expect(applyGoldenFeast(newFish, midnight)).toMatchObject({
      experience: 3, levelDelta: 3, outcome: 'leveled_up', rawBellyLoad: 4, rawStuffedFull: false, bellyUpdatedAt: midnight,
    })
    const coma = applyGoldenFeast({ ...newFish, rawBellyLoad: 3 }, midnight + 500)!
    expect(coma).toMatchObject({
      experience: 3, levelDelta: 3, outcome: 'stuffed_full', rawBellyLoad: 7, rawStuffedFull: true, bellyUpdatedAt: midnight + 500,
    })
    expect(applyGoldenFeast(coma, midnight + 500)).toBeNull()
  })

  it('黄金大餐保留消化进度，满级时照常入肚或微撑', () => {
    const now = midnight + 83_000
    expect(applyGoldenFeast({ ...newFish, experience: 6, rawBellyLoad: 1 }, now)).toMatchObject({
      experience: 9, levelDelta: 1, outcome: 'leveled_up', rawBellyLoad: 5, bellyUpdatedAt: now - 77_999,
    })
    const emperor = { ...newFish, experience: 33 }
    expect(applyGoldenFeast(emperor, midnight)).toMatchObject({ experience: 33, levelDelta: 0, outcome: 'fed', rawBellyLoad: 14 })
    expect(applyGoldenFeast({ ...emperor, rawBellyLoad: 25 }, midnight + 900)).toMatchObject({
      experience: 33, levelDelta: 0, outcome: 'stuffed', rawBellyLoad: 39, rawStuffedFull: false, bellyUpdatedAt: midnight,
    })
    expect(applyGoldenFeast({ ...newFish, experience: 32 }, midnight)).toMatchObject({
      experience: 33, levelDelta: 1, outcome: 'leveled_up', rawBellyLoad: 12,
    })
    // Stored negative experience still grows even when the visible level remains at 1.
    expect(applyGoldenFeast({ ...newFish, experience: -5, appetite: 1 }, midnight)).toMatchObject({
      experience: -2, levelDelta: 0, outcome: 'grew', rawBellyLoad: 4,
    })
  })

  it('六维只接受有效增量且受 17 点总上限与单维点数上限约束', () => {
    const increments = { burst: 6, stamina: 2, sense: 1, agility: 1, brawn: 1, appetite: 6 }
    const allocated = allocateStats(EMPTY_STATS, increments, MAX_LEVEL)!
    expect(STAT_KEYS).toEqual(['burst', 'stamina', 'sense', 'agility', 'brawn', 'appetite'])
    expect(MAX_STAT_VALUE).toBe(6)
    expect(unspentPoints(MAX_LEVEL, EMPTY_STATS)).toBe(17)
    expect(allocated).toEqual(increments)
    expect(unspentPoints(MAX_LEVEL, allocated)).toBe(0)
    expect(allocateStats(EMPTY_STATS, { appetite: 1 }, 2)).toEqual({ ...EMPTY_STATS, appetite: 1 })
    for (const invalid of [null, 1, [], {}, { health: 1 }, { appetite: '1' }, { appetite: 0.5 },
      { appetite: -1 }, { appetite: 7 }, { burst: 6, brawn: 6, appetite: 6 }, { burst: 0 }]) {
      expect(allocateStats(EMPTY_STATS, invalid, MAX_LEVEL)).toBeNull()
    }
    expect(allocateStats(allocated, { stamina: 1 }, MAX_LEVEL)).toBeNull()
    expect(allocateStats({ ...EMPTY_STATS, appetite: 6 }, { appetite: 1 }, MAX_LEVEL)).toBeNull()
  })
})
