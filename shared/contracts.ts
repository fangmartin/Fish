import type { BellyOverload, FeedOutcome, FishEye, GrowthStage, Stats } from './domain'

export interface Fish {
  id: string
  keeperId: string
  nickname: string
  name: string
  tagline: string
  eyes: FishEye[]
  assetUrl: string
  isSystem: boolean
  isHidden: boolean
  status: 'active' | 'archived'
  createdAt: number
  experience: number
  level: number
  stage: GrowthStage
  progress: number
  nextLevelXp: number
  size: number
  stats: Stats
  unspentPoints: number
  lastRespecDate: string | null
  dailyEatsCount: number
  totalKnockouts: number
  rawBellyLoad: number
  rawStuffedFull: boolean
  bellyUpdatedAt: number
  bellyUsed: number
  bellyCapacity: number
  bellyFillRatio: number
  bellyOverload: BellyOverload
  isStuffedFull: boolean
  digestionRemainingSec: number
  digestIntervalSec: number
  serverNow: number
}

export interface FeedingRecord {
  consumedAt: number
  outcome: FeedOutcome
}

export interface FishProfile extends Fish {
  feedingHistory: FeedingRecord[]
  totalEats: number
}

export interface FishRelease {
  name: string
  pngBase64: string
  eyes: FishEye[]
  tagline: string
}

export interface Keeper {
  id: string
  nickname: string
  passcode: string
}

export type KeeperResponse = { keeper: null } | {
  keeper: Keeper
  remainingRations: number
  activeFish: Fish[]
  archivedFish: Fish[]
}

export interface Pellet {
  pelletId: string
  x: number
  y: number
  expiresAt: number
  remainingRations: number
}

export interface Claim {
  outcome: FeedOutcome
  fish: Fish
  remainingRations: number
  levelDelta: number
}

export interface GoldenFeast {
  id: string
  x: number
  y: number
  createdAt: number
  expiresAt: number
}

export interface GoldenFeastClaim {
  feastId: string
  fish: Fish
  outcome: FeedOutcome
  levelDelta: number
  xpGained: number
}

export interface TankView {
  fish: Fish[]
  goldenFeast: GoldenFeast | null
}

export interface Leaderboard {
  gluttons: Fish[]
  bullies: Fish[]
  giants: Fish[]
}

export interface TankTicker {
  id: string
  kind: 'knockout' | 'stuffed' | 'golden_feast'
  text: string
  fishId: string
  createdAt: number
}

export interface TankEvents {
  fish_released: { fish: Fish }
  fish_archived: { fishId: string }
  fish_hidden: { fishId: string }
  fish_updated: { fish: Fish }
  pellet_consumed: { pelletId: string; fish: Fish; outcome: FeedOutcome; levelDelta: number }
  golden_feast_spawned: { goldenFeast: GoldenFeast }
  golden_feast_consumed: GoldenFeastClaim
  tank_ticker: TankTicker
}
