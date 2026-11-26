import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type { Fish, KeeperResponse, TankEvents } from '../shared/contracts'
import { DAILY_RATION_LIMIT, PELLET_LIFETIME_MS, TANK_VIEW_LIMIT, getDigestionState } from '../shared/domain'
import { api } from './api'
import { playSound, setSoundMuted, unlockSound } from './audio/sound'
import { Icon } from './icons'
import { KeeperModal } from './KeeperModal'
import { Studio } from './studio/Studio'
import { FishProfileModal } from './tank/FishProfileModal'
import { TankCanvas, type LocalPellet, type TankEffect } from './tank/TankCanvas'

const unloaded: KeeperResponse = { keeper: null }
const dailyRations = DAILY_RATION_LIMIT
const soundKey = 'fish-sound-muted'
const startingFocus = new URLSearchParams(window.location.search).get('fish') ?? ''
const errorMessage = (error: unknown) => error instanceof Error ? error.message : '暂时无法连接鱼缸'

function savedMute() {
  try { return localStorage.getItem(soundKey) === 'true' } catch { return false }
}

export function App() {
  const [fish, setFish] = useState<Fish[]>([])
  const [loaded, setLoaded] = useState(false)
  const [keeper, setKeeper] = useState<KeeperResponse>(unloaded)
  const [rations, setRations] = useState(dailyRations)
  const [studio, setStudio] = useState(false)
  const [identity, setIdentity] = useState<'keeper' | 'food' | 'release' | null>(null)
  const [profileId, setProfileId] = useState(startingFocus)
  const [feeding, setFeeding] = useState(false)
  const [immersive, setImmersive] = useState(false)
  const [muted, setMuted] = useState(savedMute)
  const [spotlight, setSpotlight] = useState(startingFocus)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Fish[]>([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [searching, setSearching] = useState(false)
  const [toast, setToast] = useState('')
  const [viewLoading, setViewLoading] = useState(false)

  const pellets = useRef(new Map<string, LocalPellet>())
  const localDrops = useRef(new Map<string, number>())
  const effects = useRef<TankEffect[]>([])
  const waterEpoch = useRef(0)
  const viewRequest = useRef(0)
  const keeperRequest = useRef(0)
  const defocus = useRef<number | undefined>(undefined)
  const dropping = useRef(0)
  const focus = useRef(startingFocus)
  const ownerId = useRef<string | undefined>(undefined)
  const requestedExclusions = useRef<string[]>([])
  const searchBox = useRef<HTMLDivElement>(null)
  const ownIndex = useRef(0)

  async function refreshKeeper() {
    const request = ++keeperRequest.current
    const state = await api.keeper()
    if (request !== keeperRequest.current) return
    ownerId.current = state.keeper?.id
    setKeeper(state)
    setRations(state.keeper ? state.remainingRations : dailyRations)
  }

  async function loadView(nextFocus: string, exclude: string[] = []) {
    const request = ++viewRequest.current
    const result = await api.tank(nextFocus, exclude)
    if (request !== viewRequest.current) return
    setLoaded(true)
    setFish(result.fish)
    if (nextFocus && !result.fish.some(item => item.id === nextFocus)) setSpotlight('')
    return result.fish
  }

  function applyFish(updated: Fish, insert = false) {
    setFish(previous => {
      const known = previous.find(item => item.id === updated.id)
      if (known && known.serverNow > updated.serverNow) return previous
      if (updated.isHidden || updated.status !== 'active') return previous.filter(item => item.id !== updated.id)
      if (known) return previous.map(item => item.id === updated.id ? updated : item)
      if (!insert) return previous
      const entries = [updated, ...previous]
      if (entries.length <= TANK_VIEW_LIMIT) return entries
      const remove = entries.findLastIndex(item => item.keeperId !== ownerId.current && item.id !== focus.current)
      return entries.filter((_, index) => index !== remove)
    })
  }

  function removeFish(id: string) {
    setFish(previous => previous.filter(item => item.id !== id))
  }

  function markSpotlight(id: string) {
    setSpotlight(id)
    window.clearTimeout(defocus.current)
    defocus.current = window.setTimeout(() => setSpotlight(''), 7000)
  }

  function cancelPellets() {
    waterEpoch.current++
    const previous = [...pellets.current.keys()]
    pellets.current.clear()
    return Promise.allSettled(previous.map(api.cancel))
  }

  async function moveView(id = '', shuffle = false) {
    const epoch = waterEpoch.current + 1
    const cancellation = cancelPellets()
    focus.current = id
    setFeeding(false)
    setViewLoading(true)
    requestedExclusions.current = []
    try {
      // A small shared tank has no alternate slice, so keep its available fish visible.
      const excludes = shuffle && fish.length >= TANK_VIEW_LIMIT ? fish.map(item => item.id) : []
      const request = ++viewRequest.current
      let result = await api.tank(id, excludes)
      if (excludes.length && result.fish.length < TANK_VIEW_LIMIT) {
        const fallback = await api.tank(id)
        const byId = new Map(result.fish.map(item => [item.id, item]))
        for (const item of fallback.fish) {
          if (byId.size >= TANK_VIEW_LIMIT) break
          if (!byId.has(item.id)) byId.set(item.id, item)
        }
        result = { fish: [...byId.values()] }
      } else requestedExclusions.current = excludes
      if (request !== viewRequest.current || epoch !== waterEpoch.current) return
      setLoaded(true)
      setFish(result.fish)
      if (id && result.fish.some(item => item.id === id)) markSpotlight(id)
      else setSpotlight('')
    } catch (error) {
      setToast(errorMessage(error))
    } finally {
      await cancellation
      if (epoch === waterEpoch.current) {
        setViewLoading(false)
        void refreshKeeper().catch(() => {})
      }
    }
  }

  function selectFish(item: Fish) {
    setQuery('')
    setSearchOpen(false)
    setProfileId(item.id)
    void moveView(item.id)
  }

  async function locateOwn() {
    if (!keeper.keeper) { setIdentity('keeper'); return }
    const own = keeper.activeFish.filter(item => !item.isHidden)
    if (!own.length) { setToast('还没有在水域中可见的鱼'); return }
    await moveView(own[ownIndex.current++ % own.length].id)
  }

  function canFeedView(currentFish = fish) {
    const now = Date.now()
    if (currentFish.some(item => getDigestionState(item.rawStuffedStacks, item.stuffedUpdatedAt, now).stuffedStacks < 3)) {
      return true
    }
    setToast(currentFish.length ? '这片水域的鱼都撑不动了，换片水域或稍后再喂吧' : '鱼缸里还没有鱼，先画一条下水吧')
    return false
  }

  async function drop(x: number, y: number) {
    if (!canFeedView()) return
    if (!keeper.keeper) { setFeeding(false); setIdentity('food'); return }
    if (rations - dropping.current <= 0) {
      setToast('今天的投喂配额已用完')
      return
    }
    unlockSound()
    dropping.current++
    const epoch = waterEpoch.current
    const started = Date.now()
    try {
      const item = await api.drop(x, y)
      setRations(item.remainingRations)
      localDrops.current.set(item.pelletId, started + PELLET_LIFETIME_MS + 25_000)
      if (epoch !== waterEpoch.current) {
        await api.cancel(item.pelletId)
        return
      }
      pellets.current.set(item.pelletId, {
        id: item.pelletId, x: item.x, y: item.y,
        expiresAt: started + PELLET_LIFETIME_MS, busy: false, retryAt: 0,
      })
      playSound('drop')
    } catch (error) {
      setToast(errorMessage(error))
    } finally {
      dropping.current--
      void refreshKeeper().catch(() => {})
    }
  }

  async function claim(id: string, fishId: string) {
    const pellet = pellets.current.get(id)
    if (!pellet || pellet.busy || pellet.expiresAt <= Date.now()) return
    pellet.busy = true
    try {
      const result = await api.claim(id, fishId)
      const stillHere = pellets.current.delete(id)
      applyFish(result.fish)
      if (stillHere) {
        effects.current.push({ fishId, outcome: result.outcome })
        playSound(result.outcome === 'leveled_up' ? 'level' : result.outcome === 'grew' ? 'eat' : 'burp')
      }
      void refreshKeeper().catch(() => {})
    } catch {
      if (pellets.current.has(id)) {
        pellet.busy = false
        pellet.retryAt = Date.now() + 900
        const row = await api.fish(fishId).catch(() => null)
        if (row) applyFish(row.fish)
      }
    }
  }

  async function onIdentity() {
    await refreshKeeper()
    const currentFish = await loadView(focus.current)
    if (identity === 'food' && canFeedView(currentFish)) setFeeding(true)
  }

  async function release(name: string, pngBase64: string) {
    unlockSound()
    const result = await api.release(name, pngBase64)
    applyFish(result.fish, true)
    setStudio(false)
    markSpotlight(result.fish.id)
    playSound('release')
    setToast(`${result.fish.name}下水了`)
    void refreshKeeper().catch(() => {})
  }

  const setup = useEffectEvent(() => {
    let ready = false
    const eventSource = new EventSource('/api/events')
    function on<K extends keyof TankEvents>(name: K, consume: (data: TankEvents[K]) => void) {
      eventSource.addEventListener(name, (event: MessageEvent<string>) => {
        try { consume(JSON.parse(event.data) as TankEvents[K]) } catch { /* Ignore malformed stream messages. */ }
      })
    }
    eventSource.addEventListener('ready', () => {
      if (ready) {
        void loadView(focus.current, requestedExclusions.current).catch(() => {})
        void refreshKeeper().catch(() => {})
      }
      ready = true
    })
    on('fish_released', ({ fish }) => applyFish(fish, true))
    on('fish_archived', ({ fishId }) => removeFish(fishId))
    on('fish_hidden', ({ fishId }) => removeFish(fishId))
    on('fish_updated', ({ fish }) => applyFish(fish))
    on('pellet_consumed', ({ pelletId, fish, outcome }) => {
      applyFish(fish)
      if (!localDrops.current.has(pelletId)) effects.current.push({ fishId: fish.id, outcome })
    })
    void loadView(startingFocus).catch(error => setToast(errorMessage(error)))
    void refreshKeeper().catch(() => {})

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
      if (expired) void refreshKeeper().catch(() => {})
    }
    const expiry = window.setInterval(checkRations, 1200)
    const refresh = window.setInterval(() => {
      if (ownerId.current) void refreshKeeper().catch(() => {})
    }, 20_000)
    window.addEventListener('pagehide', leave)
    return () => {
      eventSource.close()
      window.removeEventListener('pagehide', leave)
      window.clearInterval(expiry)
      window.clearInterval(refresh)
      window.clearTimeout(defocus.current)
    }
  })
  useEffect(() => setup(), [])

  useEffect(() => {
    setSoundMuted(muted)
    try { localStorage.setItem(soundKey, String(muted)) } catch { /* Sound still works without persistence. */ }
  }, [muted])

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
      void api.search(cleaned, controller.signal)
        .then(({ fish }) => { setResults(fish); setSearching(false) })
        .catch(() => { if (!controller.signal.aborted) { setResults([]); setSearching(false) } })
    }, 160)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [query])

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape' || identity || profileId || studio) return
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
  }, [identity, profileId, immersive, searchOpen, studio])

  const profile = fish.find(item => item.id === profileId)
  const keeperId = keeper.keeper?.id
  const shownRations = keeper.keeper ? rations : dailyRations

  return <>
    <main className="tank-page" hidden={studio}>
      <TankCanvas fish={fish} keeperId={keeperId} feeding={feeding} spotlight={spotlight} pellets={pellets.current} effects={effects.current}
        onWaterClick={(x, y) => void drop(x, y)} onFishClick={setProfileId} onContact={(id, winner) => void claim(id, winner)} />
      {!immersive && <>
        <header className="tank-header">
          <div className="brand"><span className="brand-mark"><Icon name="fish" /></span>
            <div><h1>潮汐鱼缸</h1><p>公共鱼缸 <span>·</span> {loaded ? `${fish.length} 条鱼` : '连接中'}</p></div>
          </div>
          <div className="tank-toolbar">
            <button className="button subtle" onClick={() => void moveView('', true)} disabled={viewLoading}>
              <Icon name="shuffle" /> <span>换一片水域</span></button>
            <div className="tank-search" ref={searchBox}>
              <Icon name="search" />
              <input type="search" placeholder="搜索鱼名或养鱼人" aria-label="搜索鱼名或养鱼人"
                value={query} onFocus={() => setSearchOpen(true)}
                onChange={event => { setQuery(event.target.value); setSearchOpen(true) }}
                onKeyDown={event => {
                  if (event.key === 'Enter' && results.length && !searching) selectFish(results[0])
                }} />
              {searchOpen && query.trim() && <div className="search-results" aria-label="搜索结果">
                {searching ? <p>寻找中…</p> : results.length ? results.map(item =>
                  <button className="fish-row" key={item.id} onClick={() => selectFish(item)}>
                    <img src={item.assetUrl} alt="" /><span>{item.name}<small>{item.nickname}</small></span><strong>Lv.{item.level}</strong>
                  </button>) : <p>这片水域没有匹配的鱼</p>}
              </div>}
            </div>
            <button className="icon-button" aria-label="定位我的鱼" title="定位我的鱼" onClick={() => void locateOwn()} disabled={viewLoading}><Icon name="locate" /></button>
          </div>
          <div className="tank-actions">
            <button className="icon-button" aria-label={muted ? '打开音效' : '静音'} title={muted ? '打开音效' : '静音'}
              onClick={() => { setSoundMuted(!muted); setMuted(!muted); if (muted) unlockSound() }}><Icon name={muted ? 'mute' : 'sound'} /></button>
            <button className="icon-button" aria-label="沉浸模式" title="沉浸模式"
              onClick={() => { setFeeding(false); setImmersive(true) }}><Icon name="expand" /></button>
            <button className="button subtle keeper-button" onClick={() => setIdentity('keeper')}>
              <Icon name="keeper" /><span>{keeper.keeper?.nickname ?? '养鱼人'}</span></button>
            <button className="button primary" onClick={() => {
              unlockSound()
              setFeeding(false)
              void cancelPellets().then(() => refreshKeeper()).catch(() => {})
              setStudio(true)
            }}><Icon name="pen" /> <span>画一条新鱼</span></button>
          </div>
        </header>
        {loaded && !fish.length && <div className="empty-tank"><Icon name="fish" /><p>成为第一个下水画鱼的人</p></div>}
        <footer className="tank-dock">
          <button className="feed-button" aria-pressed={feeding}
            onClick={() => {
              if (feeding) { setFeeding(false); return }
              if (!canFeedView()) return
              unlockSound()
              if (!keeper.keeper) { setIdentity('food'); return }
              if (!shownRations) { setToast('今天的投喂配额已用完'); return }
              setFeeding(true)
            }}>
            <span className="feed-icon"><Icon name="jar" /></span>
            <span className="feed-label"><strong>{feeding ? '退出投喂模式' : '鱼食罐'}</strong>
              <small>剩余 {shownRations}/{dailyRations}</small></span>
            <span className="ration-dots" aria-hidden="true">{Array.from({ length: dailyRations }, (_, index) =>
              <i className={index < shownRations ? 'filled' : ''} key={index} />)}</span>
          </button>
          {feeding && <p className="feed-hint" role="status">点击水面撒食</p>}
        </footer>
      </>}
      {immersive && <button className="icon-button immersion-exit" onClick={() => setImmersive(false)}
        aria-label="退出沉浸模式" title="退出沉浸模式 (Esc)"><Icon name="expand" /></button>}
    </main>
    {studio && <Studio onClose={() => setStudio(false)} canRelease={!!keeperId} onNeedKeeper={() => setIdentity('release')} onRelease={release} />}
    {identity && <KeeperModal state={keeper} message={identity === 'food' ? '先设置一个昵称，就可以撒食。' :
      identity === 'release' ? '设置昵称后，这幅手绘可以以你的名字下水。' : undefined} onClose={() => setIdentity(null)}
      onIdentity={onIdentity} onFish={id => { setIdentity(null); setProfileId(id) }} />}
    {profileId && !identity && <FishProfileModal key={profileId} id={profileId} live={profile} keeperId={keeperId}
      onClose={() => setProfileId('')} onChange={updated => {
        applyFish(updated)
        void refreshKeeper().catch(() => {})
      }} onReport={hidden => {
        if (hidden) { removeFish(profileId); setProfileId(''); setToast('这条鱼已从公共水域隐藏') }
      }} />}
    {toast && <div className="toast" role="status">{toast}</div>}
  </>
}
