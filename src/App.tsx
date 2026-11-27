import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type { Fish, FishRelease, GoldenFeast, GoldenFeastClaim, KeeperResponse, RationState, TankEvents, TankSummary, TankTicker, TankView } from '../shared/contracts'
import { MAX_RATIONS, PELLET_LIFETIME_MS, PUBLIC_TANK_ID, TANK_VIEW_LIMIT, getBellyState, normalizeInviteCode, type FeedOutcome } from '../shared/domain'
import { ApiError, api, copyText, tankLink, type TankList, type TankScope } from './api'
import { playSound, setSoundMuted, unlockSound } from './audio/sound'
import { finishBoot, showBootError, startBoot } from './bootLoader'
import { Icon } from './icons'
import { KeeperModal } from './KeeperModal'
import { Studio } from './studio/Studio'
import { FishProfileModal } from './tank/FishProfileModal'
import { LeaderboardModal } from './tank/LeaderboardModal'
import { TankCanvas, type LocalPellet, type TankEffect } from './tank/TankCanvas'
import { TankManagerModal } from './tank/TankManagerModal'
import type { TideMode } from './tank/ambient'
import type { CollisionEvent } from './tank/physics'

const unloaded: KeeperResponse = { keeper: null }
const emptyJar = '鱼食已用完，留在页面每分钟恢复 1 颗'
const soundKey = 'fish-sound-muted'
const tideKey = 'fish-tide-mode'
const tideModes: TideMode[] = ['auto', 'dawn', 'day', 'dusk', 'night']
const tideLabels: Record<TideMode, string> = { auto: '自动昼夜', dawn: '清晨', day: '午后', dusk: '黄昏', night: '深夜' }
const feedingSounds = { leveled_up: 'level', grew: 'eat', fed: 'eat', stuffed: 'burp', stuffed_full: 'burp' } as const satisfies Record<FeedOutcome, string>
const publicScope = { tankId: PUBLIC_TANK_ID }
const missingTank = '这个鱼缸链接已失效，已回到公共鱼缸'
const errorMessage = (error: unknown) => error instanceof Error ? error.message : '暂时无法连接鱼缸'
const isAccessError = (error: unknown) => error instanceof ApiError && [400, 403, 404].includes(error.status)

type TankAccess = { tank: TankSummary; keeperId?: string }
type FishChange = { fish: Fish; insert: boolean } | { removedId: string }
type ViewRead = { tankId?: string; changes: FishChange[]; tankUpdate?: TankSummary }

function scopeFor(access: TankAccess | null, keeperId?: string): TankScope {
  if (!access || access.tank.isPublic) return publicScope
  const { id, inviteCode } = access.tank
  return keeperId && keeperId === access.keeperId ? { tankId: id } : { tankId: id, inviteCode }
}

function fishInTank(fish: Fish, tank: TankSummary) {
  if (tank.isPublic || fish.tankId !== tank.id || !tank.inviteCode) return fish
  const asset = new URL(fish.assetUrl, window.location.origin)
  if (fish.tankName === tank.name && asset.searchParams.get('invite') === tank.inviteCode) return fish
  asset.searchParams.set('invite', tank.inviteCode)
  return { ...fish, tankName: tank.name, assetUrl: asset.pathname + asset.search }
}

function applyFishChange(previous: Fish[], change: FishChange, ownerId: string | undefined, focus: string) {
  if ('removedId' in change) return previous.filter(item => item.id !== change.removedId)
  const updated = change.fish
  const known = previous.find(item => item.id === updated.id)
  if (known && known.serverNow > updated.serverNow) return previous
  if (updated.isHidden || updated.status !== 'active') return previous.filter(item => item.id !== updated.id)
  if (known) return previous.map(item => item.id === updated.id ? updated : item)
  if (!change.insert) return previous
  const entries = [updated, ...previous]
  if (updated.tankId !== PUBLIC_TANK_ID || entries.length <= TANK_VIEW_LIMIT) return entries
  const remove = entries.findLastIndex(item => item.keeperId !== ownerId && item.id !== focus)
  return entries.filter((_, index) => index !== remove)
}

function savedMute() {
  try { return localStorage.getItem(soundKey) === 'true' } catch { return false }
}

function savedTide(): TideMode {
  try {
    const saved = localStorage.getItem(tideKey)
    return tideModes.find(mode => mode === saved) ?? 'auto'
  } catch {
    return 'auto'
  }
}

export function App() {
  const [fish, setFish] = useState<Fish[]>([])
  const [access, setAccess] = useState<TankAccess | null>(null)
  const [tanks, setTanks] = useState<TankList | null>(null)
  const [tankManager, setTankManager] = useState(false)
  const [bootReady, setBootReady] = useState(false)
  const [keeper, setKeeper] = useState<KeeperResponse>(unloaded)
  const [rations, setRations] = useState(MAX_RATIONS)
  const [nextRationInSec, setNextRationInSec] = useState(0)
  const [streamConnected, setStreamConnected] = useState(false)
  const [studio, setStudio] = useState<TankSummary | null>(null)
  const [identity, setIdentity] = useState<'keeper' | 'food' | 'release' | 'tanks' | null>(null)
  const [profileId, setProfileId] = useState('')
  const [feeding, setFeeding] = useState(false)
  const [immersive, setImmersive] = useState(false)
  const [muted, setMuted] = useState(savedMute)
  const [spotlight, setSpotlight] = useState('')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Fish[]>([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [searching, setSearching] = useState(false)
  const [toast, setToast] = useState('')
  const [viewLoading, setViewLoading] = useState(false)
  const [leaderboard, setLeaderboard] = useState(false)
  const [ticker, setTicker] = useState<TankTicker | null>(null)
  const [goldenFeast, setGoldenFeast] = useState<GoldenFeast | null>(null)
  const [tideMode, setTideMode] = useState<TideMode>(savedTide)
  const keeperId = keeper.keeper?.id
  const tank = access?.tank
  const scope = scopeFor(access, keeperId)
  const scopeTankId = scope.tankId!
  const scopeInvite = scope.inviteCode

  const activeAccess = useRef<TankAccess | null>(null)
  const nextRationDeadline = useRef(0)
  const pellets = useRef(new Map<string, LocalPellet>())
  const localDrops = useRef(new Map<string, number>())
  const effects = useRef<TankEffect[]>([])
  const recentKnockouts = useRef(new Map<string, number>())
  const celebratedFeasts = useRef(new Map<string, number>())
  const feastVersion = useRef(0)
  const feastRequest = useRef({ id: '', busy: false, retryAt: 0 })
  const waterEpoch = useRef(0)
  const viewRead = useRef<ViewRead | null>(null)
  const viewTransition = useRef<TankScope | null>(null)
  const keeperRequest = useRef(0)
  const tankListRequest = useRef(0)
  const defocus = useRef<number | undefined>(undefined)
  const dropping = useRef(0)
  const focus = useRef('')
  const ownerId = useRef<string | undefined>(undefined)
  const requestedExclusions = useRef<string[]>([])
  const searchBox = useRef<HTMLDivElement>(null)
  const ownIndex = useRef(0)

  function updateRations(state: RationState) {
    nextRationDeadline.current = performance.now() + state.nextRationInSec * 1000
    setRations(state.remainingRations)
    setNextRationInSec(state.nextRationInSec)
  }

  async function refreshKeeper(signal?: AbortSignal) {
    const request = ++keeperRequest.current
    const state = await api.keeper(signal)
    if (request !== keeperRequest.current || signal?.aborted) return state
    const id = state.keeper?.id
    if (ownerId.current && ownerId.current !== id) {
      waterEpoch.current++
      pellets.current.clear()
      tankListRequest.current++
      setTanks(null)
      setFeeding(false)
    }
    ownerId.current = id
    setKeeper(state)
    updateRations(state.keeper ? state : { remainingRations: MAX_RATIONS, nextRationInSec: 0 })
    return state
  }

  async function loadTanks(signal?: AbortSignal) {
    const request = ++tankListRequest.current
    const result = await api.tanks(signal)
    if (request !== tankListRequest.current || signal?.aborted) return
    setTanks(result)
    const current = activeAccess.current?.tank
    const latest = [...result.ownedTanks, ...result.joinedTanks].find(item => item.id === current?.id)
    if (latest && current && (latest.name !== current.name || latest.inviteCode !== current.inviteCode)) updateTank(latest)
  }

  function rememberTank(summary: TankSummary) {
    if (!ownerId.current && !summary.isPublic) return
    setTanks(previous => {
      if (!previous) return previous
      if (summary.isPublic) return { ...previous, publicTank: summary }
      const field = summary.isOwner ? 'ownedTanks' : 'joinedTanks'
      const list = previous[field]
      return { ...previous, [field]: list.some(item => item.id === summary.id)
        ? list.map(item => item.id === summary.id ? summary : item)
        : [...list, summary] }
    })
  }

  function syncUrl(summary: TankSummary, fishId?: string) {
    window.history.replaceState(window.history.state, '', tankLink(summary.inviteCode, fishId))
  }

  function updateTank(summary: TankSummary) {
    const previous = activeAccess.current
    if (previous?.tank.id === summary.id) {
      const next = { ...previous, tank: summary }
      activeAccess.current = next
      setAccess(next)
      setFish(previous => previous.map(item => fishInTank(item, summary)))
      if (previous.tank.inviteCode !== summary.inviteCode) {
        syncUrl(summary, new URLSearchParams(window.location.search).get('fish') ?? undefined)
      }
    }
    if (viewRead.current?.tankId === summary.id) viewRead.current.tankUpdate = summary
    tankListRequest.current++
    rememberTank(summary)
  }

  function commitView(result: TankView, updateFeast: boolean) {
    const previous = activeAccess.current
    const changed = previous?.tank.id !== result.tank.id
    const next = { tank: result.tank, keeperId: ownerId.current }
    activeAccess.current = next
    setAccess(next)
    setFish(result.fish)
    rememberTank(result.tank)
    if (changed) {
      feastRequest.current = { id: '', busy: false, retryAt: 0 }
      effects.current.length = 0
      recentKnockouts.current.clear()
      setTicker(null)
      setStreamConnected(false)
    }
    if (changed || updateFeast) setGoldenFeast(result.goldenFeast)
    if (changed) syncUrl(result.tank)
    else if (previous?.tank.inviteCode !== result.tank.inviteCode) {
      syncUrl(result.tank, new URLSearchParams(window.location.search).get('fish') ?? undefined)
    }
  }

  async function loadView(nextScope: TankScope, nextFocus: string, exclude: string[] = [], navigating = false) {
    const request: ViewRead = { tankId: nextScope.tankId, changes: [] }
    viewRead.current = request
    const version = feastVersion.current
    const identity = ownerId.current
    const sourceTankId = activeAccess.current?.tank.id
    try {
      let result = await api.tank(nextScope, nextFocus, exclude)
      if (exclude.length && result.fish.length < TANK_VIEW_LIMIT) {
        const fallback = await api.tank(nextScope, nextFocus)
        const byId = new Map(result.fish.map(item => [item.id, item]))
        for (const item of fallback.fish) {
          if (byId.size >= TANK_VIEW_LIMIT) break
          if (!byId.has(item.id)) byId.set(item.id, item)
        }
        result = { ...fallback, fish: [...byId.values()] }
        exclude = []
      }
      if (request !== viewRead.current || identity !== ownerId.current) return
      const summary = request.tankUpdate ?? result.tank
      const visible = request.changes.reduce((fish, change) => applyFishChange(fish, change, identity, nextFocus), result.fish)
        .map(item => fishInTank(item, summary))
      if (navigating) {
        focus.current = nextFocus
        requestedExclusions.current = exclude
        if (sourceTankId !== summary.id) {
          setProfileId('')
          setLeaderboard(false)
          setQuery('')
          setSearchOpen(false)
          setResults([])
        }
      }
      commitView({ ...result, tank: summary, fish: visible }, version === feastVersion.current)
      if (nextFocus && visible.some(item => item.id === nextFocus)) {
        if (navigating) markSpotlight(nextFocus)
      } else setSpotlight('')
      return visible
    } catch (error) {
      if (request === viewRead.current && identity === ownerId.current) throw error
    } finally {
      if (request === viewRead.current) viewRead.current = null
    }
  }

  function noteFish(change: FishChange, tankId: string) {
    if (viewRead.current?.tankId === tankId) viewRead.current.changes.push(change)
    setFish(previous => applyFishChange(previous, change, ownerId.current, focus.current))
  }

  function applyFish(updated: Fish, insert = false) {
    const current = activeAccess.current?.tank
    if (current && updated.tankId === current.id) noteFish({ fish: fishInTank(updated, current), insert }, current.id)
  }

  function removeFish(id: string) {
    const current = activeAccess.current?.tank
    if (current) noteFish({ removedId: id }, current.id)
  }

  function markSpotlight(id: string) {
    setSpotlight(id)
    window.clearTimeout(defocus.current)
    defocus.current = window.setTimeout(() => setSpotlight(''), 7000)
  }

  async function cancelPellet(id: string) {
    const owner = ownerId.current
    const state = await api.cancel(id)
    if (owner === ownerId.current) updateRations(state)
  }

  function cancelPellets() {
    waterEpoch.current++
    const previous = [...pellets.current.keys()]
    pellets.current.clear()
    return Promise.allSettled(previous.map(cancelPellet))
  }

  async function moveView(nextScope: TankScope, id = '', shuffle = false) {
    const transition = { ...nextScope }
    viewTransition.current = transition
    void cancelPellets()
    setFeeding(false)
    setViewLoading(true)
    try {
      // A small shared tank has no alternate slice, so keep its available fish visible.
      const excludes = shuffle && fish.length >= TANK_VIEW_LIMIT ? fish.map(item => item.id) : []
      return await loadView(nextScope, id, excludes, true)
    } finally {
      if (viewTransition.current === transition) {
        viewTransition.current = null
        setViewLoading(false)
        void refreshKeeper().catch(() => {})
      }
    }
  }

  function notice(error: unknown) {
    setToast(errorMessage(error))
  }

  function fallbackToPublic(message: string) {
    setToast(message)
    setProfileId('')
    if (viewTransition.current?.tankId !== PUBLIC_TANK_ID) void moveView(publicScope).catch(notice)
  }

  function removeTank(id: string, message: string) {
    tankListRequest.current++
    setTanks(previous => previous && {
      ...previous,
      ownedTanks: previous.ownedTanks.filter(item => item.id !== id),
      joinedTanks: previous.joinedTanks.filter(item => item.id !== id),
    })
    if (activeAccess.current?.tank.id === id) fallbackToPublic(message)
  }

  function openTankManager() {
    setTankManager(true)
    void loadTanks().catch(notice)
  }

  async function enterTank(summary: TankSummary) {
    if (await moveView({ tankId: summary.id })) setTankManager(false)
  }

  async function joinTank(inviteCode: string) {
    if (ownerId.current) {
      const { tank } = await api.joinTank(inviteCode)
      rememberTank(tank)
      await enterTank(tank)
    } else if (await moveView({ inviteCode })) setTankManager(false)
  }

  async function selectFish(item: Fish, openProfile = true) {
    setLeaderboard(false)
    setQuery('')
    setSearchOpen(false)
    const current = activeAccess.current
    if (item.status === 'active' && !item.isHidden) {
      const selectedScope = current?.tank.id === item.tankId ? scopeFor(current, ownerId.current) : { tankId: item.tankId }
      if (!await moveView(selectedScope, item.id)) return
    }
    if (openProfile) setProfileId(item.id)
  }

  async function locateOwn() {
    if (!keeper.keeper) { setIdentity('keeper'); return }
    const own = keeper.activeFish.filter(item => !item.isHidden)
    if (!own.length) { setToast('还没有在水域中可见的鱼'); return }
    const inTank = own.filter(item => item.tankId === tank?.id)
    const choices = inTank.length ? inTank : own
    await selectFish(choices[ownIndex.current++ % choices.length], false)
  }

  function canFeedView(currentFish = fish) {
    const now = Date.now()
    if (currentFish.some(item => !getBellyState(item.rawBellyLoad, item.rawStuffedFull,
      item.bellyUpdatedAt, item.level, item.stats.appetite, now).isStuffedFull)) {
      return true
    }
    const retry = activeAccess.current?.tank.isPublic ? '换片水域或稍后再喂吧' : '稍后再喂吧'
    setToast(currentFish.length ? `这片水域的鱼都撑不动了，${retry}` : '鱼缸里还没有鱼，先画一条下水吧')
    return false
  }

  async function drop(x: number, y: number) {
    if (viewTransition.current || !canFeedView()) return
    if (!keeper.keeper) { setFeeding(false); setIdentity('food'); return }
    if (rations - dropping.current <= 0) {
      setToast(emptyJar)
      return
    }
    unlockSound()
    dropping.current++
    const owner = keeper.keeper.id
    const epoch = waterEpoch.current
    const started = Date.now()
    try {
      const item = await api.drop(scopeFor(activeAccess.current, owner), x, y)
      if (owner !== ownerId.current) return
      updateRations(item)
      localDrops.current.set(item.pelletId, started + PELLET_LIFETIME_MS + 25_000)
      if (epoch !== waterEpoch.current) {
        await cancelPellet(item.pelletId)
        return
      }
      pellets.current.set(item.pelletId, {
        id: item.pelletId, x: item.x, y: item.y,
        expiresAt: started + PELLET_LIFETIME_MS, busy: false, retryAt: 0,
      })
      playSound('drop')
    } catch (error) {
      if (epoch === waterEpoch.current && owner === ownerId.current) notice(error)
    } finally {
      dropping.current--
      void refreshKeeper().catch(() => {})
    }
  }

  async function claim(id: string, fishId: string) {
    const pellet = pellets.current.get(id)
    if (!pellet || pellet.busy || pellet.expiresAt <= Date.now()) return
    pellet.busy = true
    const owner = ownerId.current
    const epoch = waterEpoch.current
    const { inviteCode } = scopeFor(activeAccess.current, owner)
    try {
      const result = await api.claim(id, fishId, inviteCode)
      if (owner === ownerId.current) updateRations(result)
      if (epoch !== waterEpoch.current) return
      const stillHere = pellets.current.delete(id)
      applyFish(result.fish)
      if (stillHere) {
        enqueueEffect({ fishId, outcome: result.outcome })
        playSound(feedingSounds[result.outcome])
      }
      void refreshKeeper().catch(() => {})
    } catch {
      if (epoch === waterEpoch.current && pellets.current.has(id)) {
        pellet.busy = false
        pellet.retryAt = Date.now() + 900
        const row = await api.fish(fishId, inviteCode).catch(() => null)
        if (row && epoch === waterEpoch.current) applyFish(row.fish)
      }
    }
  }

  function enqueueEffect(effect: TankEffect) {
    if (effects.current.length >= 24) effects.current.shift()
    effects.current.push(effect)
  }

  function reportKnockout({ attackerId, victimId }: CollisionEvent) {
    if (!ownerId.current || viewTransition.current) return
    const key = [attackerId, victimId].sort().join(':')
    const now = Date.now()
    if ((recentKnockouts.current.get(key) ?? 0) > now) return
    recentKnockouts.current.set(key, now + 3000)
    const epoch = waterEpoch.current
    const { inviteCode } = scopeFor(activeAccess.current, ownerId.current)
    void api.knockout(attackerId, victimId, inviteCode).then(({ fish }) => {
      if (epoch === waterEpoch.current) applyFish(fish)
    }).catch(() => {})
  }

  function celebrateFeast(result: GoldenFeastClaim) {
    if (celebratedFeasts.current.has(result.feastId)) return
    celebratedFeasts.current.set(result.feastId, Date.now() + 120_000)
    feastVersion.current++
    setGoldenFeast(current => current?.id === result.feastId ? null : current)
    applyFish(result.fish)
    enqueueEffect({ fishId: result.fish.id, outcome: result.outcome, xpGained: result.xpGained, golden: true })
    playSound('feast')
  }

  async function claimFeast(id: string, fishId: string) {
    if (!ownerId.current || viewTransition.current || celebratedFeasts.current.has(id)) return
    const previous = feastRequest.current
    if (previous.id === id && (previous.busy || previous.retryAt > Date.now())) return
    const attempt = { id, busy: true, retryAt: 0 }
    feastRequest.current = attempt
    const epoch = waterEpoch.current
    const currentScope = scopeFor(activeAccess.current, ownerId.current)
    try {
      const result = await api.claimFeast(id, fishId, currentScope.inviteCode)
      if (epoch === waterEpoch.current) celebrateFeast(result)
    } catch {
      attempt.retryAt = Date.now() + 900
      if (epoch !== waterEpoch.current) return
      const version = feastVersion.current
      const result = await api.tank(currentScope, focus.current, requestedExclusions.current).catch(() => null)
      if (result && epoch === waterEpoch.current && version === feastVersion.current) {
        setGoldenFeast(result.goldenFeast)
        const updated = result.fish.find(fish => fish.id === fishId)
        if (updated) applyFish(updated)
      }
    } finally {
      attempt.busy = false
    }
  }

  async function onIdentity() {
    const transition = scopeFor(activeAccess.current)
    viewTransition.current = transition
    try {
      await refreshKeeper()
      const currentScope = scopeFor(activeAccess.current, ownerId.current)
      const currentFish = await loadView(currentScope, focus.current)
      requestedExclusions.current = []
      await loadTanks()
      if (identity === 'food' && currentFish && canFeedView(currentFish)) setFeeding(true)
    } catch (error) {
      if (!activeAccess.current?.tank.isPublic && isAccessError(error)) {
        fallbackToPublic(missingTank)
        await loadTanks()
      } else throw error
    } finally {
      if (viewTransition.current === transition) viewTransition.current = null
    }
  }

  async function release(art: FishRelease) {
    if (activeAccess.current?.tank.id !== studio?.id) throw new Error('先前选择的鱼缸已离开，请返回鱼缸后重新选择放生水域')
    unlockSound()
    const epoch = waterEpoch.current
    const result = await api.release({ ...art, ...scopeFor(activeAccess.current, ownerId.current) })
    if (epoch !== waterEpoch.current) return
    applyFish(result.fish, true)
    setStudio(null)
    markSpotlight(result.fish.id)
    playSound('release')
    setToast(`${result.fish.name}下水了`)
    void refreshKeeper().catch(() => {})
  }

  const setupEvents = useEffectEvent((tankId: string, inviteCode: string | undefined, id: string | undefined) => {
    const subscription = { tankId, inviteCode }
    let eventSource: EventSource | undefined
    function matches(source: EventSource) {
      const current = scopeFor(activeAccess.current, ownerId.current)
      return source === eventSource && ownerId.current === id &&
        current.tankId === tankId && current.inviteCode === inviteCode
    }

    function accessFailure(error: unknown) {
      if (tankId !== PUBLIC_TANK_ID && isAccessError(error)) removeTank(tankId, missingTank)
    }

    function connect() {
      const source = new EventSource(api.eventsUrl(subscription))
      eventSource = source
      function on<K extends keyof TankEvents>(name: K, consume: (data: TankEvents[K]) => void) {
        source.addEventListener(name, (event: MessageEvent<string>) => {
          if (!matches(source)) return
          try { consume(JSON.parse(event.data) as TankEvents[K]) } catch { /* Ignore malformed stream messages. */ }
        })
      }
      source.addEventListener('ready', () => {
        if (!matches(source)) return
        setStreamConnected(true)
        if (viewTransition.current) return
        void loadView(subscription, focus.current, requestedExclusions.current).catch(error => {
          if (matches(source)) accessFailure(error)
        })
        void refreshKeeper().catch(() => {})
      })
      source.addEventListener('error', () => {
        if (!matches(source)) return
        setStreamConnected(false)
        if (tankId === PUBLIC_TANK_ID || source.readyState !== EventSource.CLOSED) return
        void api.tank(subscription).catch(error => { if (matches(source)) accessFailure(error) })
      })
      on('fish_released', ({ fish }) => {
        applyFish(fish, true)
        if (id && id === fish.keeperId) void refreshKeeper().catch(() => {})
      })
      on('fish_archived', ({ fishId }) => removeFish(fishId))
      on('fish_hidden', ({ fishId }) => removeFish(fishId))
      on('fish_left', ({ fishId }) => { removeFish(fishId); if (id) void refreshKeeper().catch(() => {}) })
      on('fish_updated', ({ fish }) => applyFish(fish))
      on('pellet_consumed', ({ pelletId, fish, outcome }) => {
        applyFish(fish)
        if (!localDrops.current.has(pelletId)) enqueueEffect({ fishId: fish.id, outcome })
      })
      on('golden_feast_spawned', ({ goldenFeast }) => {
        if (celebratedFeasts.current.has(goldenFeast.id)) return
        feastVersion.current++
        setGoldenFeast(goldenFeast)
      })
      on('golden_feast_consumed', celebrateFeast)
      on('tank_ticker', setTicker)
      on('tank_updated', ({ tank }) => {
        updateTank(tank)
        if (id) void refreshKeeper().catch(() => {})
      })
      on('tank_deleted', ({ tankId }) => removeTank(tankId, '这个鱼缸已删除，已回到公共鱼缸'))
      on('rations_updated', state => {
        if (id && ownerId.current === id) updateRations(state)
      })
    }

    connect()
    function close() {
      eventSource?.close()
      eventSource = undefined
      setStreamConnected(false)
    }
    function restore(event: PageTransitionEvent) {
      if (event.persisted) connect()
    }
    window.addEventListener('pagehide', close)
    window.addEventListener('pageshow', restore)
    return () => {
      close()
      window.removeEventListener('pagehide', close)
      window.removeEventListener('pageshow', restore)
    }
  })
  useEffect(() => {
    if (bootReady) return setupEvents(scopeTankId, scopeInvite, keeperId)
  }, [bootReady, scopeTankId, scopeInvite, keeperId])

  const bootstrap = useEffectEvent((signal: AbortSignal) => {
    const params = new URLSearchParams(window.location.search)
    const entryCode = params.get('tank')
    const entryFish = params.get('fish') ?? ''
    async function initialView() {
      if (entryCode === null) return { view: await api.tank(publicScope, entryFish, [], signal), focusId: entryFish, lost: false }
      const inviteCode = normalizeInviteCode(entryCode)
      if (inviteCode) {
        try {
          return { view: await api.tank({ inviteCode }, entryFish, [], signal), focusId: entryFish, lost: false }
        } catch (error) {
          if (!isAccessError(error)) throw error
        }
      }
      return { view: await api.tank(publicScope, '', [], signal), focusId: '', lost: true }
    }
    async function boot() {
      startBoot()
      try {
        const [entry] = await Promise.all([
          initialView().then(async entry => { await loadTanks(signal); return entry }),
          refreshKeeper(signal),
        ])
        if (signal.aborted) return
        focus.current = entry.focusId
        commitView(entry.view, true)
        syncUrl(entry.view.tank, entry.focusId)
        if (entry.focusId && entry.view.fish.some(item => item.id === entry.focusId)) markSpotlight(entry.focusId)
        await finishBoot(entry.view.fish.map(item => item.assetUrl), signal)
        if (signal.aborted) return
        setBootReady(true)
        setProfileId(entry.focusId)
        if (entry.lost) setToast(missingTank)
      } catch (error) {
        if (!signal.aborted) showBootError(errorMessage(error), () => void boot())
      }
    }
    void boot()
  })
  useEffect(() => {
    const controller = new AbortController()
    bootstrap(controller.signal)
    return () => controller.abort()
  }, [])

  const setupMaintenance = useEffectEvent(() => {
    function leave() { void cancelPellets() }
    function checkRations() {
      let expired = false
      const now = Date.now()
      for (const pellet of pellets.current.values()) {
        if (pellet.expiresAt <= now) { pellets.current.delete(pellet.id); expired = true }
      }
      for (const [id, expiresAt] of localDrops.current) {
        if (expiresAt <= now) localDrops.current.delete(id)
      }
      for (const [key, expiresAt] of recentKnockouts.current) {
        if (expiresAt <= now) recentKnockouts.current.delete(key)
      }
      for (const [id, expiresAt] of celebratedFeasts.current) {
        if (expiresAt <= now) celebratedFeasts.current.delete(id)
      }
      if (expired) void refreshKeeper().catch(() => {})
    }
    const expiry = window.setInterval(checkRations, 1200)
    const refresh = window.setInterval(() => {
      if (ownerId.current && !viewTransition.current) void refreshKeeper().catch(() => {})
    }, 20_000)
    window.addEventListener('pagehide', leave)
    window.addEventListener('pointerdown', unlockSound, { once: true })
    return () => {
      window.removeEventListener('pagehide', leave)
      window.removeEventListener('pointerdown', unlockSound)
      window.clearInterval(expiry)
      window.clearInterval(refresh)
      window.clearTimeout(defocus.current)
    }
  })
  useEffect(() => setupMaintenance(), [])

  useEffect(() => {
    if (!keeperId || !streamConnected || rations >= MAX_RATIONS) return
    const timer = window.setInterval(() => {
      setNextRationInSec(Math.max(0, Math.ceil((nextRationDeadline.current - performance.now()) / 1000)))
    }, 250)
    return () => window.clearInterval(timer)
  }, [keeperId, streamConnected, rations])

  useEffect(() => {
    setSoundMuted(muted)
    try { localStorage.setItem(soundKey, String(muted)) } catch { /* Sound still works without persistence. */ }
  }, [muted])

  useEffect(() => {
    try { localStorage.setItem(tideKey, tideMode) } catch { /* The selected mode still applies. */ }
  }, [tideMode])

  useEffect(() => {
    if (!ticker) return
    const hide = window.setTimeout(() => setTicker(null), 5000)
    return () => window.clearTimeout(hide)
  }, [ticker])

  useEffect(() => {
    if (!toast) return
    const hide = window.setTimeout(() => setToast(''), 3500)
    return () => window.clearTimeout(hide)
  }, [toast])

  useEffect(() => {
    const cleaned = query.trim()
    if (!cleaned) { setResults([]); setSearching(false); return }
    const controller = new AbortController()
    setSearching(true)
    const timer = window.setTimeout(() => {
      void api.search({ tankId: scopeTankId, inviteCode: scopeInvite }, cleaned, controller.signal)
        .then(({ fish }) => {
          const activeScope = scopeFor(activeAccess.current, ownerId.current)
          if (controller.signal.aborted || activeScope.tankId !== scopeTankId || activeScope.inviteCode !== scopeInvite) return
          setResults(fish)
          setSearching(false)
        })
        .catch(() => { if (!controller.signal.aborted) { setResults([]); setSearching(false) } })
    }, 160)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [query, scopeTankId, scopeInvite])

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape' || identity || profileId || studio || leaderboard || tankManager) return
      if (immersive) setImmersive(false)
      else if (searchOpen) setSearchOpen(false)
      else setFeeding(false)
    }
    function outside(event: PointerEvent) {
      if (!searchBox.current?.contains(event.target as Node)) setSearchOpen(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', outside)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('pointerdown', outside) }
  }, [identity, profileId, immersive, searchOpen, studio, leaderboard, tankManager])

  const profile = fish.find(item => item.id === profileId)
    ?? (keeper.keeper && [...keeper.activeFish, ...keeper.archivedFish].find(item => item.id === profileId)) ?? undefined
  const shownRations = keeperId ? rations : MAX_RATIONS
  const currentTank = tank && { ...tank, fishCount: fish.length }
  const keeperTanks = tanks ? [tanks.publicTank, ...tanks.ownedTanks, ...tanks.joinedTanks] : []

  return <>
    {viewLoading && <div className="tank-switch-bar" role="progressbar" aria-label="正在连接鱼缸" />}
    <main className="tank-page" hidden={!!studio}>
      <TankCanvas key={scopeTankId} tankName={tank?.name ?? '公共鱼缸'} fish={fish} keeperId={keeperId} feeding={feeding} spotlight={spotlight} pellets={pellets.current} effects={effects.current}
        goldenFeast={goldenFeast} tideMode={tideMode} onKnockout={reportKnockout} onGoldenContact={(id, winner) => void claimFeast(id, winner)}
        onWaterClick={(x, y) => void drop(x, y)} onFishClick={id => { if (!viewTransition.current) setProfileId(id) }} onContact={(id, winner) => void claim(id, winner)} />
      {!immersive && <>
        <header className="tank-header">
          <div className="brand"><span className="brand-mark"><Icon name="fish" /></span>
            <div><h1>潮汐鱼缸</h1>
              <button className="tank-pill" disabled={!tank || viewLoading} aria-haspopup="dialog" title="切换或管理鱼缸" onClick={openTankManager}>
                <span>{tank?.name ?? '连接中'}</span>
                {tank && <small>{tank.isPublic ? `${fish.length} 条鱼` : `${fish.length}/${tank.maxFish}`}</small>}
                <span aria-hidden="true">▾</span>
              </button>
            </div>
          </div>
          <div className="tank-toolbar">
            {tank?.isPublic ? <button className="button subtle" onClick={() => void moveView(scope, '', true).catch(notice)} disabled={viewLoading}>
              <Icon name="shuffle" /> <span>换一片水域</span></button>
              : tank?.inviteCode && <button className="button subtle" disabled={viewLoading} onClick={() => {
                const link = tankLink(tank.inviteCode).href
                void copyText(link).then(() => setToast('邀请链接已复制')).catch(() => setToast(link))
              }}><Icon name="copy" /> <span>邀请好友</span></button>}
            <div className="tank-search" ref={searchBox}>
              <Icon name="search" />
              <input type="search" placeholder="搜索鱼名或养鱼人" aria-label="搜索鱼名或养鱼人" disabled={viewLoading}
                value={query} onFocus={() => setSearchOpen(true)}
                onChange={event => { setQuery(event.target.value); setSearchOpen(true) }}
                onKeyDown={event => {
                  if (event.key === 'Enter' && results.length && !searching) void selectFish(results[0]).catch(notice)
                }} />
              {searchOpen && query.trim() && <div className="search-results" aria-label="搜索结果">
                {searching ? <p>寻找中…</p> : results.length ? results.map(item =>
                  <button className="fish-row" key={item.id} onClick={() => void selectFish(item).catch(notice)}>
                    <img src={item.assetUrl} alt="" /><span>{item.name}<small>{item.nickname}</small></span><strong>Lv.{item.level}</strong>
                  </button>) : <p>这片水域没有匹配的鱼</p>}
              </div>}
            </div>
            <button className="icon-button" aria-label="定位我的鱼" title="定位我的鱼" onClick={() => void locateOwn().catch(notice)} disabled={viewLoading}><Icon name="locate" /></button>
            <button className="button subtle tank-utility" aria-label="排行榜" title="排行榜" onClick={() => setLeaderboard(true)} disabled={viewLoading}>
              <Icon name="trophy" /> <span>排行榜</span>
            </button>
            <button className="button subtle tank-utility" aria-label={`昼夜氛围 · ${tideLabels[tideMode]}`}
              title={`切换昼夜氛围 · ${tideLabels[tideMode]}`}
              onClick={() => setTideMode(tideModes[(tideModes.indexOf(tideMode) + 1) % tideModes.length])}>
              <Icon name="tide" /> <span>{tideLabels[tideMode]}</span>
            </button>
          </div>
          <div className="tank-actions">
            <button className="icon-button" aria-label={muted ? '打开音效' : '静音'} title={muted ? '打开音效' : '静音'}
              onClick={() => { setSoundMuted(!muted); setMuted(!muted); if (muted) unlockSound() }}><Icon name={muted ? 'mute' : 'sound'} /></button>
            <button className="icon-button" aria-label="沉浸模式" title="沉浸模式"
              onClick={() => { setFeeding(false); setImmersive(true) }}><Icon name="expand" /></button>
            <button className="button subtle keeper-button" onClick={() => setIdentity('keeper')}>
              <Icon name="keeper" /><span>{keeper.keeper?.nickname ?? '养鱼人'}</span></button>
            <button className="button primary" disabled={viewLoading || !tank} onClick={() => {
              if (!tank) return
              unlockSound()
              setFeeding(false)
              void cancelPellets().then(() => refreshKeeper()).catch(() => {})
              setStudio(tank)
            }}><Icon name="pen" /> <span>画一条新鱼</span></button>
          </div>
        </header>
        {tank && !fish.length && <div className="empty-tank"><Icon name="fish" /><p>成为第一个下水画鱼的人</p></div>}
        {ticker && <div key={ticker.id} className="tank-ticker" role="status">{ticker.text}</div>}
        <footer className="tank-dock">
          <button className="feed-button" aria-pressed={feeding} disabled={viewLoading}
            onClick={() => {
              if (feeding) { setFeeding(false); return }
              if (!canFeedView()) return
              unlockSound()
              if (!keeper.keeper) { setIdentity('food'); return }
              if (!shownRations) { setToast(emptyJar); return }
              setFeeding(true)
            }}>
            <span className="feed-icon"><Icon name="jar" /></span>
            <span className="feed-label"><strong>{feeding ? '退出投喂模式' : '鱼食罐'}</strong>
              <small>剩余 {shownRations}/{MAX_RATIONS}{keeperId && shownRations < MAX_RATIONS && ` · ${nextRationInSec}s后+1`}</small></span>
            <span className="ration-dots" aria-hidden="true">{Array.from({ length: MAX_RATIONS }, (_, index) =>
              <i className={index < shownRations ? 'filled' : ''} key={index} />)}</span>
          </button>
          {feeding && <p className="feed-hint" role="status">点击水面撒食</p>}
        </footer>
      </>}
      {immersive && <button className="icon-button immersion-exit" onClick={() => setImmersive(false)}
        aria-label="退出沉浸模式" title="退出沉浸模式 (Esc)"><Icon name="expand" /></button>}
    </main>
    {studio && <Studio tankName={tank?.id === studio.id ? tank.name : studio.name} onClose={() => setStudio(null)}
      canRelease={!!keeperId} onNeedKeeper={() => setIdentity('release')} onRelease={release} />}
    {leaderboard && <LeaderboardModal key={scopeTankId} tankId={scopeTankId} inviteCode={scopeInvite}
      onClose={() => setLeaderboard(false)} onFish={item => void selectFish(item).catch(notice)} />}
    {tankManager && currentTank && tanks && <TankManagerModal tanks={tanks} current={currentTank} hasKeeper={!!keeperId}
      onClose={() => setTankManager(false)} onNeedKeeper={() => { setTankManager(false); setIdentity('tanks') }}
      onEnter={enterTank} onJoin={joinTank} onChange={summary => {
        updateTank(summary)
        void loadTanks().catch(() => {})
      }} onRemove={removeTank} />}
    {identity && <KeeperModal state={keeper} message={identity === 'food' ? '先设置一个昵称，就可以撒食。' :
      identity === 'release' ? '设置昵称后，这幅手绘可以以你的名字下水。' :
        identity === 'tanks' ? '设置一个昵称，就可以创建自己的鱼缸。' : undefined} onClose={() => {
          setIdentity(null)
          if (identity === 'tanks') openTankManager()
        }}
      onIdentity={onIdentity} onFish={item => { setIdentity(null); void selectFish(item).catch(notice) }} />}
    {profileId && !identity && <FishProfileModal key={`${scopeTankId}:${profileId}`} id={profileId}
      live={profile || undefined} keeperId={keeperId} tank={tank} keeperTanks={keeperTanks}
      onClose={() => {
        setProfileId('')
        if (tank && new URLSearchParams(window.location.search).has('fish')) syncUrl(tank)
      }} onChange={updated => {
        if (updated.tankId === activeAccess.current?.tank.id) applyFish(updated)
        else if (profile?.tankId === activeAccess.current?.tank.id) removeFish(updated.id)
        void refreshKeeper().catch(() => {})
      }} onMove={item => {
        setToast(`${item.name}已搬到${item.tankName}`)
        void selectFish(item).catch(notice)
      }} onEject={() => {
        setProfileId('')
        setToast('这条鱼已收入其养鱼人的深海归档图鉴')
      }} onReport={hidden => {
        if (hidden) { removeFish(profileId); setProfileId(''); setToast('这条鱼已从水域隐藏') }
      }} />}
    {toast && <div className="toast" role="status">{toast}</div>}
  </>
}
