export const DAILY_RATION_LIMIT = 10
export const MAX_ACTIVE_FISH_PER_KEEPER = 3
export const TANK_VIEW_LIMIT = 35
export const DAILY_SATIETY_CAP = 6
export const REPORT_HIDE_THRESHOLD = 3
export const MAX_LEVEL = 11
export const MAX_EXPERIENCE = 55
export const MAX_STAT_VALUE = 6
export const MIN_ART_PIXELS = 24
export const MAX_ART_EDGE = 512
export const MAX_ART_BYTES = 256 * 1024
export const PELLET_LIFETIME_MS = 90_000

export const STAT_KEYS = ['burst', 'stamina', 'sense', 'agility', 'brawn'] as const
export type StatKey = typeof STAT_KEYS[number]
export type Stats = Record<StatKey, number>
export const EMPTY_STATS: Readonly<Stats> = { burst: 0, stamina: 0, sense: 0, agility: 0, brawn: 0 }

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

export function remainingRations(droppedCount: number) {
  return Math.max(0, DAILY_RATION_LIMIT - droppedCount)
}

export type GrowthStage = 'fry' | 'juvenile' | 'adult' | 'leviathan'

export function getGrowth(experience: number) {
  const xp = Math.max(0, Math.min(MAX_EXPERIENCE, experience))
  let level = 1
  let progress = xp
  while (level < MAX_LEVEL && progress >= level) {
    progress -= level
    level++
  }
  const stage: GrowthStage = level <= 2 ? 'fry' : level <= 5 ? 'juvenile' : level <= 9 ? 'adult' : 'leviathan'
  return { level, stage, progress, nextLevelXp: level === MAX_LEVEL ? 0 : level, size: 40 + 220 * xp / MAX_EXPERIENCE }
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

export const STUFFED_MOVEMENT = [1, 0.65, 0.3, 0.25] as const
export type StuffedStacks = 0 | 1 | 2 | 3
const DIGEST_LAYER_MS = 1_200_000
const DIGEST_FULL_MS = 3_600_000

export function getDigestionState(rawStacks: number, stuffedUpdatedAt: number, nowMs: number) {
  const elapsed = Math.max(0, nowMs - stuffedUpdatedAt)
  if (rawStacks >= 3 && elapsed < DIGEST_FULL_MS) {
    return { stuffedStacks: 3 as const, digestionRemainingSec: Math.ceil((DIGEST_FULL_MS - elapsed) / 1000) }
  }
  if (rawStacks === 0 || rawStacks >= 3) return { stuffedStacks: 0 as const, digestionRemainingSec: 0 }
  const stuffedStacks = Math.max(0, rawStacks - Math.floor(elapsed / DIGEST_LAYER_MS)) as StuffedStacks
  return {
    stuffedStacks,
    digestionRemainingSec: stuffedStacks ? Math.ceil((DIGEST_LAYER_MS - elapsed % DIGEST_LAYER_MS) / 1000) : 0,
  }
}

export type FeedOutcome = 'grew' | 'leveled_up' | 'stuffed' | 'stuffed_full'
export interface FeedingState {
  experience: number
  dailyFedCount: number
  dailyFedDate: string | null
  rawStuffedStacks: number
  stuffedUpdatedAt: number
}

export function feedFish(state: FeedingState, nowMs: number) {
  const { stuffedStacks } = getDigestionState(state.rawStuffedStacks, state.stuffedUpdatedAt, nowMs)
  if (stuffedStacks === 3) return null
  const dailyFedCount = dailyCount(state.dailyFedCount, state.dailyFedDate, nowMs)
  if (state.experience < MAX_EXPERIENCE && dailyFedCount < DAILY_SATIETY_CAP) {
    const experience = state.experience + 1
    const levelDelta = getGrowth(experience).level - getGrowth(state.experience).level
    const outcome: FeedOutcome = levelDelta ? 'leveled_up' : 'grew'
    return { ...state, experience, dailyFedCount: dailyFedCount + 1, dailyFedDate: shanghaiDate(nowMs), outcome, levelDelta }
  }
  const rawStuffedStacks = stuffedStacks + 1
  const outcome: FeedOutcome = rawStuffedStacks === 3 ? 'stuffed_full' : 'stuffed'
  return { ...state, rawStuffedStacks, stuffedUpdatedAt: nowMs, outcome, levelDelta: 0 }
}
