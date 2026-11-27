export const MAX_RATIONS = 20
export const RATION_REGEN_INTERVAL_MS = 60_000
export const PUBLIC_TANK_ID = 'public'
export const MAX_ACTIVE_FISH_PER_KEEPER = 3
export const MAX_CUSTOM_TANKS_PER_KEEPER = 2
export const MAX_OWNER_FISH_IN_CUSTOM_TANK = 10
export const MAX_GUEST_FISH_IN_CUSTOM_TANK = 3
export const MAX_TOTAL_FISH_IN_CUSTOM_TANK = 20
export const TANK_VIEW_LIMIT = 35
export const REPORT_HIDE_THRESHOLD = 3
export const LEVEL_XP_COSTS = [1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3] as const
export const MAX_LEVEL = LEVEL_XP_COSTS.length + 1
export const MAX_EXPERIENCE = LEVEL_XP_COSTS.reduce<number>((total, cost) => total + cost, 0)
export const MAX_STAT_VALUE = 6
export const MIN_ART_PIXELS = 24
export const MAX_ART_EDGE = 512
export const MAX_ART_BYTES = 256 * 1024
export const PELLET_LIFETIME_MS = 90_000
export const GOLDEN_FEAST_EVERY_FEEDS = 15
export const GOLDEN_FEAST_BONUS_XP = 3
export const GOLDEN_FEAST_LIFETIME_MS = 120_000

export function getKeeperTankFishLimit(tankId: string, isTankOwner: boolean) {
  if (tankId === PUBLIC_TANK_ID) return MAX_ACTIVE_FISH_PER_KEEPER
  return isTankOwner ? MAX_OWNER_FISH_IN_CUSTOM_TANK : MAX_GUEST_FISH_IN_CUSTOM_TANK
}

export function canPlaceFishInTank(input: {
  tankId: string
  isTankOwner: boolean
  keeperFishInTank: number
  totalFishInTank: number
}) {
  const keeperLimit = getKeeperTankFishLimit(input.tankId, input.isTankOwner)
  if (input.keeperFishInTank >= keeperLimit) {
    return { ok: false as const, reason: 'keeper_limit' as const, limit: keeperLimit }
  }
  if (input.tankId !== PUBLIC_TANK_ID && input.totalFishInTank >= MAX_TOTAL_FISH_IN_CUSTOM_TANK) {
    return { ok: false as const, reason: 'tank_full' as const, limit: MAX_TOTAL_FISH_IN_CUSTOM_TANK }
  }
  return { ok: true as const }
}

export function normalizeInviteCode(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const codePattern = /^[A-Z2-9]{8}$/i
  const value = input.trim()
  if (codePattern.test(value)) return value.toUpperCase()
  try {
    const code = (new URL(value).searchParams.get('tank') ?? '').trim()
    return codePattern.test(code) ? code.toUpperCase() : null
  } catch {
    return null
  }
}

export const EYE_STYLES = ['googly', 'deadpan', 'fierce'] as const
export const MAX_FISH_EYES = 4
export type EyeStyle = typeof EYE_STYLES[number]
export type FishEye = { x: number; y: number; radius: number; style: EyeStyle }

function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}

export function validateEyes(input: unknown): FishEye[] | null {
  if (input === undefined) return []
  if (!Array.isArray(input) || input.length > MAX_FISH_EYES) return null
  const eyes: FishEye[] = []
  for (const eye of input) {
    if (!eye || typeof eye !== 'object') return null
    const { x, y, radius, style } = eye
    if (!EYE_STYLES.includes(style) || !inRange(x, 0, 1) || !inRange(y, 0, 1) || !inRange(radius, 0.02, 0.2)) {
      return null
    }
    eyes.push({ x, y, radius, style })
  }
  return eyes
}

export const STAT_KEYS = ['burst', 'stamina', 'sense', 'agility', 'brawn', 'appetite'] as const
export type StatKey = typeof STAT_KEYS[number]
export type Stats = Record<StatKey, number>
export const EMPTY_STATS: Readonly<Stats> = { burst: 0, stamina: 0, sense: 0, agility: 0, brawn: 0, appetite: 0 }
const buildTitles: Record<StatKey, string> = {
  burst: '深海鱼雷', stamina: '永动机', sense: '顺风耳', agility: '深海泥鳅', brawn: '全缸恶霸', appetite: '深海无底洞',
}
const doubleBuildTitles: Partial<Record<string, string>> = {
  'brawn+appetite': '霸王餐恶霸',
  'burst+appetite': '深海吸尘器',
  'sense+appetite': '干饭雷达',
  'burst+brawn': '深海泥头车',
  'burst+agility': '水中幽灵',
}

export function getBuildTitle(stats: Stats, level: number) {
  const highest = Math.max(...STAT_KEYS.map(key => stats[key]))
  if (!highest && level === 1) return '初生萌鱼'
  const leaders = STAT_KEYS.filter(key => stats[key] === highest)
  if (leaders.length === 1) return buildTitles[leaders[0]]
  if (highest > 0 && leaders.length === 2) {
    const title = doubleBuildTitles[leaders.join('+')]
    if (title) return title
  }
  return level === MAX_LEVEL ? '六边形战神' : '全能游侠'
}

const shanghai = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
})

export function shanghaiDate(nowMs: number) {
  const parts = shanghai.formatToParts(nowMs)
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value
  return `${get('year')}-${get('month')}-${get('day')}`
}

export function dailyCount(count: number, recordedDate: string | null, nowMs: number) {
  return recordedDate === shanghaiDate(nowMs) ? count : 0
}

function clampRations(rations: number) {
  return Math.min(MAX_RATIONS, Math.max(0, Math.floor(rations)))
}

export function settleOnlineRations(rations: number, progressMs: number, elapsedOnlineMs: number) {
  const current = clampRations(rations)
  if (current === MAX_RATIONS) return { rations: MAX_RATIONS, progressMs: 0, gained: 0, nextRationInSec: 0 }
  const totalMs = Math.max(0, Math.floor(progressMs)) + Math.max(0, Math.floor(elapsedOnlineMs))
  const gained = Math.min(MAX_RATIONS - current, Math.floor(totalMs / RATION_REGEN_INTERVAL_MS))
  const nextRations = current + gained
  const full = nextRations === MAX_RATIONS
  const nextProgressMs = full ? 0 : totalMs % RATION_REGEN_INTERVAL_MS
  return {
    rations: nextRations, progressMs: nextProgressMs, gained,
    nextRationInSec: full ? 0 : Math.ceil((RATION_REGEN_INTERVAL_MS - nextProgressMs) / 1000),
  }
}

export function consumeRation(rations: number, progressMs: number) {
  const current = clampRations(rations)
  if (!current) return null
  const nextProgressMs = current === MAX_RATIONS ? 0 : progressMs
  return {
    rations: current - 1, progressMs: nextProgressMs,
    nextRationInSec: Math.ceil((RATION_REGEN_INTERVAL_MS - nextProgressMs) / 1000),
  }
}

export type GrowthStage = 'fry' | 'juvenile' | 'adult' | 'leviathan' | 'emperor'

export function getGrowth(experience: number) {
  const xp = Math.max(0, Math.min(MAX_EXPERIENCE, experience))
  let level = 1
  let progress = xp
  while (level < MAX_LEVEL && progress >= LEVEL_XP_COSTS[level - 1]) {
    progress -= LEVEL_XP_COSTS[level - 1]
    level++
  }
  const stage: GrowthStage = level <= 3 ? 'fry' : level <= 7 ? 'juvenile'
    : level <= 11 ? 'adult' : level <= 16 ? 'leviathan' : 'emperor'
  return { level, stage, progress, nextLevelXp: level === MAX_LEVEL ? 0 : LEVEL_XP_COSTS[level - 1], size: 40 + 235 * xp / MAX_EXPERIENCE }
}

export function unspentPoints(level: number, stats: Stats) {
  return level - 1 - STAT_KEYS.reduce((used, key) => used + stats[key], 0)
}

export function allocateStats(stats: Stats, increments: unknown, level: number): Stats | null {
  if (!increments || typeof increments !== 'object' || Array.isArray(increments)) return null
  const values = increments as Record<string, unknown>
  if (Object.keys(values).some(key => !STAT_KEYS.includes(key as StatKey))) return null
  const next = { ...stats }
  let total = 0
  for (const key of STAT_KEYS) {
    const amount = key in values ? values[key] : 0
    if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0) return null
    next[key] += amount
    if (next[key] > MAX_STAT_VALUE) return null
    total += amount
  }
  return total > 0 && total <= unspentPoints(level, stats) ? next : null
}

export function canRespec(lastRespecDate: string | null, nowMs: number) {
  return lastRespecDate !== shanghaiDate(nowMs)
}

export const BASE_BELLY_BY_LEVEL = [2, 3, 4, 5, 6, 7, 9, 11, 13, 15, 17, 19, 22, 25, 28, 31, 34, 38] as const
export const APPETITE_CAPACITY_BONUS = 2

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function clampLevel(level: number) {
  return clamp(Math.floor(level), 1, MAX_LEVEL)
}

function clampAppetite(appetite: number) {
  return clamp(appetite, 0, MAX_STAT_VALUE)
}

export function getBellyCapacity(level: number, appetite = 0) {
  return BASE_BELLY_BY_LEVEL[clampLevel(level) - 1] + clampAppetite(appetite) * APPETITE_CAPACITY_BONUS
}

export function getDigestIntervalMs(level: number, appetite = 0) {
  const baseSec = 120 - (clampLevel(level) - 1) * 6
  return Math.max(8, Math.round(baseSec * (1 - clampAppetite(appetite) * 0.08))) * 1000
}

export function getStuffedComaMs(level: number, appetite = 0) {
  const baseSec = 240 - (clampLevel(level) - 1) * 10
  return Math.max(25, Math.round(baseSec * (1 - clampAppetite(appetite) * 0.08))) * 1000
}

export function getGoldenFeastBellyCost(capacity: number) {
  return Math.max(4, Math.ceil(capacity * 0.35))
}

export type BellyOverload = 0 | 1 | 2

export function getBellyMovementFactor(bellyFillRatio: number, bellyOverload: BellyOverload) {
  if (bellyOverload === 2) return 0.25
  if (bellyOverload === 1) return 0.45
  if (bellyFillRatio <= 0.55) return 1
  return 1 - (clamp(bellyFillRatio, 0, 1) - 0.55) / 0.45 * 0.32
}

export function formatDuration(seconds: number) {
  const total = Math.max(0, Math.ceil(seconds))
  if (total < 60) return `${total} 秒`
  const minutes = Math.floor(total / 60)
  const remainder = total % 60
  return remainder === 0 ? `${minutes} 分钟` : `${minutes} 分 ${remainder} 秒`
}

export function getBellyState(rawBellyLoad: number, rawStuffedFull: boolean, bellyUpdatedAt: number, level: number, appetite: number, nowMs: number) {
  const elapsed = Math.max(0, nowMs - bellyUpdatedAt)
  const bellyCapacity = getBellyCapacity(level, appetite)
  if (rawStuffedFull) {
    const comaMs = getStuffedComaMs(level, appetite)
    if (elapsed < comaMs) {
      return {
        bellyUsed: bellyCapacity, bellyCapacity, bellyFillRatio: 1, bellyOverload: 2 as const, isStuffedFull: true,
        digestionRemainingSec: Math.ceil((comaMs - elapsed) / 1000), currentLoad: bellyCapacity + 2, nextAnchorMs: bellyUpdatedAt,
      }
    }
  }

  const intervalMs = getDigestIntervalMs(level, appetite)
  const normalized = rawStuffedFull ? 0 : Math.max(0, Math.floor(rawBellyLoad))
  const digested = normalized > 0 ? Math.floor(elapsed / intervalMs) : 0
  const currentLoad = Math.max(0, normalized - digested)
  const bellyUsed = Math.min(bellyCapacity, currentLoad)
  const bellyOverload: BellyOverload = currentLoad > bellyCapacity ? 1 : 0
  return {
    bellyUsed, bellyCapacity, bellyFillRatio: Math.min(1, bellyUsed / bellyCapacity), bellyOverload, isStuffedFull: false,
    digestionRemainingSec: currentLoad > 0 ? Math.ceil((intervalMs - elapsed % intervalMs) / 1000) : 0,
    currentLoad,
    nextAnchorMs: currentLoad > 0 ? bellyUpdatedAt + digested * intervalMs : nowMs,
  }
}

export type FeedOutcome = 'grew' | 'leveled_up' | 'fed' | 'stuffed' | 'stuffed_full'
export interface FeedingState {
  experience: number
  appetite: number
  rawBellyLoad: number
  rawStuffedFull: boolean
  bellyUpdatedAt: number
}

function preserveDigestionProgress(nowMs: number, nextAnchorMs: number, nextLevel: number, appetite: number) {
  const nextIntervalMs = getDigestIntervalMs(nextLevel, appetite)
  // Preserve partial digestion without consuming another slot on level-up.
  return nowMs - Math.min(nowMs - nextAnchorMs, nextIntervalMs - 1)
}

export function feedFish(state: FeedingState, nowMs: number) {
  const { level } = getGrowth(state.experience)
  const belly = getBellyState(state.rawBellyLoad, state.rawStuffedFull, state.bellyUpdatedAt, level, state.appetite, nowMs)
  if (belly.isStuffedFull) return null
  if (belly.currentLoad < belly.bellyCapacity) {
    const experience = level === MAX_LEVEL ? state.experience : state.experience + 1
    const nextLevel = getGrowth(experience).level
    const levelDelta = nextLevel - level
    const outcome: FeedOutcome = levelDelta ? 'leveled_up' : level === MAX_LEVEL ? 'fed' : 'grew'
    return {
      ...state, experience, rawBellyLoad: belly.currentLoad + 1, rawStuffedFull: false, outcome, levelDelta,
      bellyUpdatedAt: preserveDigestionProgress(nowMs, belly.nextAnchorMs, nextLevel, state.appetite),
    }
  }

  const rawStuffedFull = belly.bellyOverload >= 1
  const outcome: FeedOutcome = rawStuffedFull ? 'stuffed_full' : 'stuffed'
  return {
    ...state, rawStuffedFull, outcome, levelDelta: 0,
    rawBellyLoad: belly.bellyCapacity + (rawStuffedFull ? 2 : 1),
    bellyUpdatedAt: rawStuffedFull ? nowMs : belly.nextAnchorMs,
  }
}

export function applyGoldenFeast(state: FeedingState, nowMs: number) {
  const { level } = getGrowth(state.experience)
  const belly = getBellyState(state.rawBellyLoad, state.rawStuffedFull, state.bellyUpdatedAt, level, state.appetite, nowMs)
  if (belly.isStuffedFull) return null
  const experience = Math.min(MAX_EXPERIENCE, state.experience + GOLDEN_FEAST_BONUS_XP)
  const nextLevel = getGrowth(experience).level
  const levelDelta = nextLevel - level
  const nextCapacity = getBellyCapacity(nextLevel, state.appetite)
  const totalLoad = belly.currentLoad + getGoldenFeastBellyCost(belly.bellyCapacity)
  if (totalLoad >= nextCapacity + 2) {
    return { ...state, experience, rawBellyLoad: nextCapacity + 2, rawStuffedFull: true, bellyUpdatedAt: nowMs, outcome: 'stuffed_full' as const, levelDelta }
  }
  const outcome: FeedOutcome = levelDelta ? 'leveled_up' : experience > state.experience ? 'grew' : totalLoad > nextCapacity ? 'stuffed' : 'fed'
  return {
    ...state, experience, rawBellyLoad: Math.min(totalLoad, nextCapacity + 1), rawStuffedFull: false, outcome, levelDelta,
    bellyUpdatedAt: preserveDigestionProgress(nowMs, belly.nextAnchorMs, nextLevel, state.appetite),
  }
}
