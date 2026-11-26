import { describe, expect, it } from 'vitest'
import {
  DAILY_RATION_LIMIT, DAILY_SATIETY_CAP, EMPTY_STATS, MAX_ACTIVE_FISH_PER_KEEPER, MAX_EXPERIENCE,
  MAX_LEVEL, MAX_STAT_VALUE, REPORT_HIDE_THRESHOLD, STUFFED_MOVEMENT, TANK_VIEW_LIMIT,
  EYE_STYLES, GOLDEN_FEAST_BONUS_XP, GOLDEN_FEAST_EVERY_FEEDS, GOLDEN_FEAST_LIFETIME_MS, MAX_FISH_EYES,
  allocateStats, applyGoldenFeast, canRespec, dailyCount, feedFish, getBuildTitle, getDigestionState, getGrowth, remainingRations,
  shanghaiDate, unspentPoints, validateEyes, type FeedingState, type StatKey,
} from '../shared/domain'

const beforeMidnight = Date.parse('2026-03-04T15:59:59.999Z')
const midnight = beforeMidnight + 1
const newFish: FeedingState = {
  experience: 0, dailyFedCount: 0, dailyFedDate: null, rawStuffedStacks: 0, stuffedUpdatedAt: 0,
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

  it('黄金大餐能连跳两级，封顶、叠吃撑及拒绝三层撑瘫', () => {
    expect([GOLDEN_FEAST_EVERY_FEEDS, GOLDEN_FEAST_BONUS_XP, GOLDEN_FEAST_LIFETIME_MS]).toEqual([15, 3, 120_000])
    expect(applyGoldenFeast({ ...newFish, dailyFedCount: 6 }, midnight))
      .toMatchObject({ experience: 3, levelDelta: 2, outcome: 'leveled_up', dailyFedCount: 6 })
    expect(applyGoldenFeast({ ...newFish, experience: 22 }, midnight))
      .toMatchObject({ experience: 25, levelDelta: 0, outcome: 'grew' })
    expect(applyGoldenFeast({ ...newFish, experience: 54 }, midnight))
      .toMatchObject({ experience: 55, levelDelta: 1, rawStuffedStacks: 0 })
    expect(applyGoldenFeast({ ...newFish, experience: 55 }, midnight))
      .toMatchObject({ experience: 55, levelDelta: 0, outcome: 'stuffed', rawStuffedStacks: 1, stuffedUpdatedAt: midnight })
    expect(applyGoldenFeast({ ...newFish, experience: 55, rawStuffedStacks: 2, stuffedUpdatedAt: midnight }, midnight))
      .toMatchObject({ outcome: 'stuffed_full', rawStuffedStacks: 3 })
    expect(applyGoldenFeast({ ...newFish, rawStuffedStacks: 3, stuffedUpdatedAt: midnight }, midnight)).toBeNull()
  })

  it('流派称号覆盖各单项、初生和并列最高', () => {
    expect(getBuildTitle(EMPTY_STATS, 1)).toBe('初生萌鱼')
    expect(getBuildTitle(EMPTY_STATS, 2)).toBe('全能游侠')
    const titles: Record<StatKey, string> = {
      burst: '深海鱼雷', stamina: '永动机', sense: '顺风耳', agility: '深海泥鳅', brawn: '全缸恶霸',
    }
    for (const [key, title] of Object.entries(titles)) {
      expect(getBuildTitle({ ...EMPTY_STATS, [key]: 3 }, 4)).toBe(title)
    }
    expect(getBuildTitle({ ...EMPTY_STATS, brawn: 2, sense: 2 }, 5)).toBe('全能游侠')
    expect(getBuildTitle({ burst: 2, stamina: 2, sense: 2, agility: 2, brawn: 2 }, MAX_LEVEL)).toBe('深海全能王')
  })

  it('固定每日配额、在缸容量、水域切片与举报门槛', () => {
    expect([DAILY_RATION_LIMIT, MAX_ACTIVE_FISH_PER_KEEPER, TANK_VIEW_LIMIT, DAILY_SATIETY_CAP, REPORT_HIDE_THRESHOLD])
      .toEqual([10, 3, 35, 6, 3])
    expect(remainingRations(0)).toBe(10)
    expect(remainingRations(1)).toBe(9)
    expect(remainingRations(9)).toBe(1)
    expect(remainingRations(10)).toBe(0)
    expect(remainingRations(11)).toBe(0)
  })

  it('阶梯经验曲线每升一级加一点，55 颗封顶', () => {
    let total = 0
    for (let level = 1; level < MAX_LEVEL; level++) {
      expect(getGrowth(total)).toMatchObject({ level, progress: 0, nextLevelXp: level })
      expect(getGrowth(total + level - 1).level).toBe(level)
      total += level
      expect(getGrowth(total).level).toBe(level + 1)
      expect(unspentPoints(level + 1, EMPTY_STATS)).toBe(level)
    }
    expect(total).toBe(MAX_EXPERIENCE)
    expect(getGrowth(55)).toMatchObject({ level: 11, progress: 0, nextLevelXp: 0, size: 260 })
    expect(getGrowth(100)).toEqual(getGrowth(55))
    expect(getGrowth(-10)).toEqual(getGrowth(0))
  })

  it('在阶段边界正确切换，且每颗有效鱼食都增加尺寸', () => {
    expect([0, 1, 3, 10, 15, 36, 45, 55].map(xp => getGrowth(xp).stage))
      .toEqual(['fry', 'fry', 'juvenile', 'juvenile', 'adult', 'adult', 'leviathan', 'leviathan'])
    expect(getGrowth(0).size).toBe(40)
    for (let xp = 0; xp < MAX_EXPERIENCE; xp++) {
      const growth = getGrowth(xp + 1).size - getGrowth(xp).size
      expect(growth).toBeGreaterThan(0)
      expect(growth).toBeCloseTo(4)
    }
  })

  it('使用上海时区零点重置饱食与洗点', () => {
    expect(shanghaiDate(beforeMidnight)).toBe('2026-03-04')
    expect(shanghaiDate(midnight)).toBe('2026-03-05')
    expect(dailyCount(6, '2026-03-04', beforeMidnight)).toBe(6)
    expect(dailyCount(6, '2026-03-04', midnight)).toBe(0)
    expect(canRespec(null, beforeMidnight)).toBe(true)
    expect(canRespec('2026-03-04', beforeMidnight)).toBe(false)
    expect(canRespec('2026-03-04', midnight)).toBe(true)
    expect(feedFish({ ...newFish, dailyFedCount: 6, dailyFedDate: '2026-03-04' }, midnight)).toMatchObject({
      experience: 1, dailyFedCount: 1, dailyFedDate: '2026-03-05', rawStuffedStacks: 0,
    })
  })

  it('非满级累计 6 颗有效饱食，第 7 到 9 颗逐层吃撑', () => {
    let state = newFish
    for (let step = 1; step <= 9; step++) {
      const result = feedFish(state, beforeMidnight)!
      expect(result.experience).toBe(Math.min(6, step))
      expect(result.dailyFedCount).toBe(Math.min(6, step))
      expect(result.rawStuffedStacks).toBe(Math.max(0, step - 6))
      expect(result.outcome).toBe(step === 9 ? 'stuffed_full' : step >= 7 ? 'stuffed' :
        [1, 3, 6].includes(step) ? 'leveled_up' : 'grew')
      expect(result.levelDelta).toBe([1, 3, 6].includes(step) ? 1 : 0)
      state = result
    }
    expect(feedFish(state, beforeMidnight)).toBeNull()
    expect(feedFish(state, beforeMidnight + 3_599_999)).toBeNull()
    expect(feedFish(state, beforeMidnight + 3_600_000)).toMatchObject({ experience: 7, dailyFedCount: 1, outcome: 'grew' })
  })

  it('满级直接叠吃撑，未撑瘫的层数消退后以有效层重新叠加', () => {
    const first = feedFish({ ...newFish, experience: 55 }, midnight)!
    const second = feedFish(first, midnight + 1)!
    const third = feedFish(second, midnight + 2)!
    expect([first, second, third].map(item => item.rawStuffedStacks)).toEqual([1, 2, 3])
    for (const item of [first, second, third]) {
      expect(item).toMatchObject({ experience: 55, dailyFedCount: 0, levelDelta: 0 })
    }
    expect(feedFish(second, midnight + 1_200_001)).toMatchObject({
      rawStuffedStacks: 2, stuffedUpdatedAt: midnight + 1_200_001,
    })
    expect(feedFish(third, midnight + 3_600_002)).toMatchObject({ rawStuffedStacks: 1 })
  })

  it('20 分钟逐层消化，满 3 层锁定 60 分钟', () => {
    expect(STUFFED_MOVEMENT).toEqual([1, 0.65, 0.3, 0.25])
    expect(getDigestionState(0, midnight, midnight)).toEqual({ stuffedStacks: 0, digestionRemainingSec: 0 })
    expect(getDigestionState(1, midnight, midnight - 30)).toEqual({ stuffedStacks: 1, digestionRemainingSec: 1200 })
    expect(getDigestionState(1, midnight, midnight + 1_199_999)).toEqual({ stuffedStacks: 1, digestionRemainingSec: 1 })
    expect(getDigestionState(1, midnight, midnight + 1_200_000)).toEqual({ stuffedStacks: 0, digestionRemainingSec: 0 })
    expect(getDigestionState(2, midnight, midnight + 1_200_000)).toEqual({ stuffedStacks: 1, digestionRemainingSec: 1200 })
    expect(getDigestionState(2, midnight, midnight + 2_400_000)).toEqual({ stuffedStacks: 0, digestionRemainingSec: 0 })
    expect(getDigestionState(3, midnight, midnight + 1_200_000)).toEqual({ stuffedStacks: 3, digestionRemainingSec: 2400 })
    expect(getDigestionState(3, midnight, midnight + 3_599_999)).toEqual({ stuffedStacks: 3, digestionRemainingSec: 1 })
    expect(getDigestionState(3, midnight, midnight + 3_600_000)).toEqual({ stuffedStacks: 0, digestionRemainingSec: 0 })
  })

  it('五维只接受有效增量且受可用点数、单维点数上限约束', () => {
    const allocated = allocateStats(EMPTY_STATS, { burst: 6, stamina: 1, sense: 1, agility: 1, brawn: 1 }, MAX_LEVEL)!
    expect(MAX_STAT_VALUE).toBe(6)
    expect(allocated).toEqual({ burst: 6, stamina: 1, sense: 1, agility: 1, brawn: 1 })
    expect(unspentPoints(MAX_LEVEL, allocated)).toBe(0)
    expect(allocateStats(EMPTY_STATS, { brawn: 1 }, 2)).toEqual({ ...EMPTY_STATS, brawn: 1 })
    for (const invalid of [null, 1, [], {}, { health: 1 }, { brawn: '1' }, { brawn: 0.5 },
      { brawn: -1 }, { brawn: 7 }, { burst: 6, brawn: 5 }, { burst: 0 }]) {
      expect(allocateStats(EMPTY_STATS, invalid, MAX_LEVEL)).toBeNull()
    }
    expect(allocateStats(allocated, { stamina: 1 }, MAX_LEVEL)).toBeNull()
    expect(allocateStats(allocated, { burst: 1 }, MAX_LEVEL)).toBeNull()
  })
})
