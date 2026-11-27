import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { getCookie, setCookie } from 'hono/cookie'
import { HTTPException } from 'hono/http-exception'
import { streamSSE } from 'hono/streaming'
import type { FeedingRecord, GoldenFeast, RationState, TankEvents, TankSummary, TankTicker } from '../shared/contracts'
import {
  GOLDEN_FEAST_EVERY_FEEDS, GOLDEN_FEAST_LIFETIME_MS, MAX_ART_BYTES, MAX_ART_EDGE, MAX_CUSTOM_TANKS_PER_KEEPER,
  MAX_RATIONS, MAX_TOTAL_FISH_IN_CUSTOM_TANK, PELLET_LIFETIME_MS, PUBLIC_TANK_ID, RATION_REGEN_INTERVAL_MS,
  REPORT_HIDE_THRESHOLD, TANK_VIEW_LIMIT, allocateStats, applyGoldenFeast, canPlaceFishInTank, canRespec, consumeRation,
  feedFish, getBellyCapacity, getBellyState, getDigestIntervalMs, getGrowth, getKeeperTankFishLimit, normalizeInviteCode,
  settleOnlineRations, shanghaiDate, validateEyes,
} from '../shared/domain'
import { parseArtwork } from './art'
import { openStorage, presentFish, type AfterCommit, type FishRow, type KeeperRow } from './storage'

interface Options {
  dataDir: string
  dbPath?: string
  adminSecret?: string
  registerLimit?: number
  dropLimit?: number
  now?: () => number
  ip?: (c: Context) => string
}

interface PelletRow {
  id: string
  keeper_id: string
  tank_id: string
  expires_at: number
  status: 'pending' | 'consumed' | 'cancelled' | 'expired'
}

type TankRow = {
  id: string
  name: string
  owner_id: string
  owner_nickname: string
  invite_code: string
  created_at: number
}

interface TankScope { tankId?: unknown; inviteCode?: unknown; requireMemberForWrite?: boolean }
type EventListener = (event: keyof TankEvents, data: string) => void
type TankSubscriber = { keeperId?: string; send: EventListener; close: () => void }
interface OnlinePresence {
  streams: Set<EventListener>
  lastSettledAt: number
  nextRegenAt: number | null
}
type RationRow = { rations: number; ration_progress_ms: number }
const safeId = /^[a-z0-9-]{1,64}$/
const cookieName = 'fish_keeper'
const passcodeAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const inTank = "f.tank_id = ? AND f.status = 'active' AND f.is_hidden = 0"
const publicTank = {
  id: PUBLIC_TANK_ID, name: '公共鱼缸', owner_id: null, owner_nickname: null, invite_code: null, created_at: null,
}
type Tank = TankRow | typeof publicTank

function randomCode(length: number) {
  return Array.from(randomBytes(length), byte => passcodeAlphabet[byte & 31]).join('')
}

function createPasscode() {
  const letters = randomCode(12)
  return `FISH-${letters.slice(0, 4)}-${letters.slice(4, 8)}-${letters.slice(8)}`
}

function fail(status: 400 | 401 | 403 | 404 | 409 | 413 | 429, message: string): never {
  throw new HTTPException(status, { message })
}

function shortName(value: unknown) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text.length && [...text].length <= 16 && !/\p{Cc}/u.test(text) ? text : null
}

async function readBody(c: Context, allowEmpty = false): Promise<Record<string, unknown>> {
  if (allowEmpty && !(await c.req.text())) return {}
  const value: unknown = await c.req.json().catch(() => null)
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, '请求内容需要是 JSON 对象')
  return value as Record<string, unknown>
}

function coordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

export function createApp(options: Options) {
  const now = options.now ?? Date.now
  const { db, transaction, findFish, fishSelect, assetPath } = openStorage(
    options.dataDir, options.dbPath ?? join(options.dataDir, 'tank.sqlite'),
  )
  const root = new Hono()
  const api = new Hono()
  const tankSubscribers = new Map<string, Set<TankSubscriber>>()
  const onlineKeepers = new Map<string, OnlinePresence>()
  let regenTimer: ReturnType<typeof setInterval> | undefined
  const readRations = db.prepare('SELECT rations, ration_progress_ms FROM keepers WHERE id = ?')
  const writeRations = db.prepare('UPDATE keepers SET rations = ?, ration_progress_ms = ? WHERE id = ?')
  const tankSelect = 'SELECT t.*, k.nickname AS owner_nickname FROM tanks t JOIN keepers k ON k.id = t.owner_id'
  const findTank = (id: string) => db.prepare(`${tankSelect} WHERE t.id = ?`).get(id) as TankRow | undefined
  const findInvite = (code: string) => db.prepare(`${tankSelect} WHERE t.invite_code = ?`).get(code) as TankRow | undefined
  const readTankCounts = db.prepare(`
    SELECT COUNT(*) AS fishCount, COUNT(CASE WHEN keeper_id = ? THEN 1 END) AS myFishCount
    FROM fish WHERE tank_id = ? AND status = 'active'
  `)

  function broadcastToTank<K extends Exclude<keyof TankEvents, 'rations_updated'>>(tankId: string, event: K, value: TankEvents[K]) {
    const data = JSON.stringify(value)
    for (const subscriber of tankSubscribers.get(tankId) ?? []) subscriber.send(event, data)
  }

  function keeperFor(c: Context) {
    const session = getCookie(c, cookieName)
    if (!session || !/^[a-f0-9]{64}$/.test(session)) return undefined
    return db.prepare('SELECT id, nickname, passcode FROM keepers WHERE session = ?').get(session) as KeeperRow | undefined
  }

  function requireKeeper(c: Context) {
    return keeperFor(c) ?? fail(401, '请先设置养鱼人昵称')
  }

  function tankCounts(tankId: string, keeperId?: string) {
    return readTankCounts.get(keeperId ?? null, tankId) as { fishCount: number; myFishCount: number }
  }

  function presentTank(tank: Tank, keeperId?: string): TankSummary {
    const isPublic = tank.id === PUBLIC_TANK_ID
    const isOwner = tank.owner_id === keeperId
    return {
      id: tank.id, name: tank.name, isPublic, isOwner, ...tankCounts(tank.id, keeperId),
      ownerId: tank.owner_id ?? undefined, ownerNickname: tank.owner_nickname ?? undefined,
      inviteCode: tank.invite_code ?? undefined, createdAt: tank.created_at ?? undefined,
      maxFish: isPublic ? null : MAX_TOTAL_FISH_IN_CUSTOM_TANK, myFishLimit: getKeeperTankFishLimit(tank.id, isOwner),
    }
  }

  function isTankMember(tankId: string, keeperId: string) {
    return !!db.prepare('SELECT 1 FROM tank_members WHERE tank_id = ? AND keeper_id = ?').get(tankId, keeperId)
  }

  function joinTank(tank: TankRow, keeperId: string) {
    if (tank.owner_id === keeperId) return
    db.prepare('INSERT OR IGNORE INTO tank_members(tank_id, keeper_id, joined_at) VALUES (?, ?, ?)')
      .run(tank.id, keeperId, now())
  }

  function tankForInvite(value: unknown) {
    const code = normalizeInviteCode(value)
    return (code ? findInvite(code) : undefined) ?? fail(404, '这个鱼缸链接已失效')
  }

  function resolveTankAccess(c: Context, { tankId, inviteCode, requireMemberForWrite }: TankScope): Tank {
    const keeper = requireMemberForWrite ? requireKeeper(c) : keeperFor(c)
    if (tankId === PUBLIC_TANK_ID || (tankId === undefined && inviteCode === undefined)) return publicTank
    const tank = tankId === undefined
      ? tankForInvite(inviteCode)
      : (typeof tankId === 'string' ? findTank(tankId) : undefined) ?? fail(404, '找不到这个鱼缸')
    if (inviteCode !== undefined) {
      if (tankId !== undefined && tankForInvite(inviteCode).id !== tank.id) fail(403, '需要邀请链接才能进入这个鱼缸')
      if (keeper) joinTank(tank, keeper.id)
    } else if (!keeper || (tank.owner_id !== keeper.id && !isTankMember(tank.id, keeper.id))) {
      fail(403, '需要邀请链接才能进入这个鱼缸')
    }
    return tank
  }

  function queryTank(c: Context) {
    return resolveTankAccess(c, { tankId: c.req.query('tankId'), inviteCode: c.req.query('inviteCode') })
  }

  function ownedTank(id: string, keeper: KeeperRow) {
    if (id === PUBLIC_TANK_ID) fail(403, '只有鱼缸主人可以操作')
    const tank = findTank(id) ?? fail(404, '找不到这个鱼缸')
    if (tank.owner_id !== keeper.id) fail(403, '只有鱼缸主人可以操作')
    return tank
  }

  function newInviteCode() {
    let code = randomCode(8)
    while (findInvite(code)) code = randomCode(8)
    return code
  }

  function broadcastTankUpdate(tank: TankRow) {
    for (const subscriber of tankSubscribers.get(tank.id) ?? []) {
      subscriber.send('tank_updated', JSON.stringify({ tank: presentTank(tank, subscriber.keeperId) }))
    }
  }

  function verifyPlacement(tank: Tank, keeperId: string, moving = false) {
    const { fishCount, myFishCount } = tankCounts(tank.id, keeperId)
    const placement = canPlaceFishInTank({
      tankId: tank.id, isTankOwner: tank.owner_id === keeperId, keeperFishInTank: myFishCount, totalFishInTank: fishCount,
    })
    if (placement.ok) return
    if (placement.reason === 'tank_full') fail(409, '这个自建鱼缸已经游满 20 条鱼啦')
    fail(409, moving ? `你在目标鱼缸的在缸鱼已达上限（最多 ${placement.limit} 条）`
      : `在缸鱼已满（最多 ${placement.limit} 条），请先深海归档一条鱼`)
  }

  function requireAdmin(c: Context) {
    const expected = Buffer.from(options.adminSecret ?? '')
    const provided = Buffer.from(c.req.header('X-Admin-Secret') ?? '')
    if (!expected.length || provided.length !== expected.length || !timingSafeEqual(provided, expected)) fail(403, '无管理员权限')
  }

  function activeFish(id: string) {
    const row = findFish(id)
    if (!row || row.status !== 'active' || row.is_hidden) fail(409, '这条鱼已离开鱼缸')
    return row
  }

  function ticker(tankId: string, kind: TankTicker['kind'], text: string, fishId: string, createdAt: number) {
    broadcastToTank(tankId, 'tank_ticker', { id: randomUUID(), kind, text, fishId, createdAt })
  }

  function activeFeast(tankId: string, time: number) {
    return (db.prepare(`
      SELECT id, x, y, created_at AS createdAt, expires_at AS expiresAt
      FROM golden_feasts WHERE tank_id = ? AND status = 'active' AND expires_at > ?
    `).get(tankId, time) as GoldenFeast | undefined) ?? null
  }

  function spawnFeast(tankId: string, time: number) {
    const existing = activeFeast(tankId, time)
    if (existing) return { goldenFeast: existing, spawned: false }
    db.prepare("UPDATE golden_feasts SET status = 'expired' WHERE tank_id = ? AND status = 'active' AND expires_at <= ?")
      .run(tankId, time)
    const goldenFeast = {
      id: randomUUID(), x: 0.2 + Math.random() * 0.6, y: 0.14, createdAt: time, expiresAt: time + GOLDEN_FEAST_LIFETIME_MS,
    }
    db.prepare(`INSERT INTO golden_feasts(id, x, y, created_at, expires_at, status, tank_id)
      VALUES (?, ?, ?, ?, ?, 'active', ?)`).run(goldenFeast.id, goldenFeast.x, goldenFeast.y, time, goldenFeast.expiresAt, tankId)
    return { goldenFeast, spawned: true }
  }

  function settleFish(row: FishRow, time: number, feed: typeof feedFish | typeof applyGoldenFeast) {
    const next = feed({
      experience: row.experience, appetite: row.appetite,
      rawBellyLoad: row.belly_load, rawStuffedFull: !!row.belly_full, bellyUpdatedAt: row.belly_updated_at,
    }, time)
    if (!next) fail(409, '这条鱼撑不动了')
    const today = shanghaiDate(time)
    // Growth is capped in the domain. Keep XP earned under the old level curve.
    const experience = Math.max(row.experience, next.experience)
    db.prepare(`UPDATE fish SET experience = ?, belly_load = ?, belly_full = ?, belly_updated_at = ?, updated_at = ?,
      daily_eats_count = CASE WHEN daily_eats_date = ? THEN daily_eats_count + 1 ELSE 1 END, daily_eats_date = ?
      WHERE id = ?`).run(experience, next.rawBellyLoad, Number(next.rawStuffedFull), next.bellyUpdatedAt, time, today, today, row.id)
    return { outcome: next.outcome, levelDelta: next.levelDelta, fish: presentFish(findFish(row.id)!, time) }
  }

  function issueCookie(c: Context, session: string) {
    setCookie(c, cookieName, session, {
      httpOnly: true, path: '/', sameSite: 'Lax', maxAge: 365 * 24 * 60 * 60,
      secure: c.req.url.startsWith('https://'),
    })
  }

  function useRateLimit(c: Context, action: string, bucket: string, limit: number) {
    const ip = options.ip?.(c) ?? 'local'
    db.prepare('DELETE FROM rate_limits WHERE action = ? AND bucket <> ?').run(action, bucket)
    const result = db.prepare(`
      INSERT INTO rate_limits(action, ip, bucket, count) VALUES (?, ?, ?, 1)
      ON CONFLICT(action, ip, bucket) DO UPDATE SET count = count + 1 WHERE count < ?
    `).run(action, ip, bucket, limit)
    if (!result.changes) fail(429, action === 'register' ? '这个网络今天创建的养鱼人已达上限' : '操作有点频繁，请稍后再试')
  }

  function syncKeeperRations(
    keeperId: string, time: number,
    { afterCommit = effect => effect(), spend = false }: { afterCommit?: AfterCommit; spend?: boolean } = {},
  ): RationState {
    const row = readRations.get(keeperId) as RationRow
    const presence = onlineKeepers.get(keeperId)
    const settledAt = presence ? Math.max(time, presence.lastSettledAt) : time
    const elapsed = presence ? settledAt - presence.lastSettledAt : 0
    const settled = settleOnlineRations(row.rations, row.ration_progress_ms, elapsed)
    const next = spend ? consumeRation(settled.rations, settled.progressMs) : settled
    if (!next) fail(409, '鱼食已用完，留在页面每分钟恢复 1 颗')
    if (next.rations !== row.rations || next.progressMs !== row.ration_progress_ms) {
      writeRations.run(next.rations, next.progressMs, keeperId)
    }
    const state = { remainingRations: next.rations, nextRationInSec: next.nextRationInSec }
    if (presence) afterCommit(() => {
      presence.lastSettledAt = settledAt
      presence.nextRegenAt = next.rations < MAX_RATIONS ? settledAt + RATION_REGEN_INTERVAL_MS - next.progressMs : null
      if (settled.gained) {
        const data = JSON.stringify(state)
        for (const listener of presence.streams) listener('rations_updated', data)
      }
    })
    return state
  }

  function checkRationRegen() {
    const time = now()
    for (const [keeperId, presence] of onlineKeepers) {
      if (presence.nextRegenAt === null || time < presence.nextRegenAt) continue
      try { syncKeeperRations(keeperId, time) } catch (error) { console.error(error) }
    }
  }

  function connectKeeper(keeperId: string, listener: EventListener) {
    let presence = onlineKeepers.get(keeperId)
    if (!presence) {
      const time = now()
      const row = readRations.get(keeperId) as RationRow
      presence = {
        streams: new Set(), lastSettledAt: time,
        nextRegenAt: row.rations < MAX_RATIONS ? time + RATION_REGEN_INTERVAL_MS - row.ration_progress_ms : null,
      }
      onlineKeepers.set(keeperId, presence)
      regenTimer ??= setInterval(checkRationRegen, 1000).unref()
    }
    presence.streams.add(listener)
  }

  function disconnectKeeper(keeperId: string, listener: EventListener) {
    const presence = onlineKeepers.get(keeperId)
    if (!presence || !presence.streams.delete(listener) || presence.streams.size) return
    try {
      syncKeeperRations(keeperId, now())
    } catch (error) {
      console.error(error)
    } finally {
      onlineKeepers.delete(keeperId)
      if (!onlineKeepers.size) {
        clearInterval(regenTimer)
        regenTimer = undefined
      }
    }
  }

  function pauseRationRegen() {
    for (const [keeperId, presence] of onlineKeepers) {
      for (const listener of presence.streams) disconnectKeeper(keeperId, listener)
    }
  }

  function ensureTankCanEat(tankId: string, time: number) {
    const swimmers = db.prepare(`
      SELECT experience, appetite, belly_load, belly_full, belly_updated_at FROM fish f WHERE ${inTank}
    `).iterate(tankId) as Iterable<Pick<FishRow, 'experience' | 'appetite' | 'belly_load' | 'belly_full' | 'belly_updated_at'>>
    let hasFish = false
    for (const fish of swimmers) {
      hasFish = true
      const level = getGrowth(fish.experience).level
      if (!getBellyState(fish.belly_load, !!fish.belly_full, fish.belly_updated_at, level, fish.appetite, time).isStuffedFull) return
    }
    fail(409, hasFish ? '鱼缸里的鱼都撑不动了，稍后再喂吧' : '鱼缸里还没有鱼，先画一条下水吧')
  }

  function adjustBellyForAppetite(fish: FishRow, level: number, appetite: number, time: number) {
    const belly = getBellyState(fish.belly_load, !!fish.belly_full, fish.belly_updated_at, level, fish.appetite, time)
    if (belly.isStuffedFull) return
    const load = Math.min(belly.currentLoad, getBellyCapacity(level, appetite) + 1)
    const interval = getDigestIntervalMs(level, appetite)
    const partial = Math.min(time - belly.nextAnchorMs, interval - 1)
    db.prepare('UPDATE fish SET belly_load = ?, belly_full = 0, belly_updated_at = ? WHERE id = ?')
      .run(load, time - partial, fish.id)
  }

  function ownedFish(id: string, keeper: KeeperRow) {
    const fish = findFish(id) ?? fail(404, '找不到这条鱼')
    if (fish.keeper_id !== keeper.id) fail(403, '只有鱼的养鱼人可以操作')
    return fish
  }

  function visibleFish(id: string, c: Context) {
    const fish = findFish(id) ?? fail(404, '找不到这条鱼')
    const keeper = keeperFor(c)
    if (keeper?.id === fish.keeper_id) return fish
    if (fish.is_hidden || fish.status !== 'active') fail(404, '找不到这条鱼')
    if (fish.tank_id !== PUBLIC_TANK_ID) {
      const tank = findTank(fish.tank_id) ?? fail(404, '找不到这条鱼')
      if (keeper && (tank.owner_id === keeper.id || isTankMember(tank.id, keeper.id))) return fish
      const invite = c.req.query('invite') ?? c.req.query('inviteCode')
      if (normalizeInviteCode(invite) !== tank.invite_code) fail(404, '找不到这条鱼')
      if (keeper) joinTank(tank, keeper.id)
    }
    return fish
  }

  function ownedPellet(id: string, keeper: KeeperRow) {
    const pellet = db.prepare('SELECT * FROM pellets WHERE id = ?').get(id) as PelletRow | undefined
    if (!pellet) fail(404, '找不到这颗鱼食')
    if (pellet.keeper_id !== keeper.id) fail(403, '只有投放者可以结算鱼食')
    return pellet
  }

  api.use('*', bodyLimit({
    maxSize: Math.ceil(MAX_ART_BYTES / 3) * 4 + 4096,
    onError: c => c.json({ error: '请求体过大' }, 413),
  }))
  api.use('*', async (c, next) => {
    if (!c.req.path.startsWith('/api/assets/')) c.header('Cache-Control', 'no-store')
    await next()
  })

  api.get('/keeper/me', c => {
    const keeper = keeperFor(c)
    if (!keeper) return c.json({ keeper: null })
    const time = now()
    const fish = (db.prepare(`${fishSelect} WHERE f.keeper_id = ? ORDER BY f.created_at DESC`).all(keeper.id) as FishRow[])
      .map(row => presentFish(row, time))
    return c.json({
      keeper, ...syncKeeperRations(keeper.id, time),
      activeFish: fish.filter(item => item.status === 'active'),
      archivedFish: fish.filter(item => item.status === 'archived'),
    })
  })

  api.post('/keeper/register', async c => {
    const nickname = shortName((await readBody(c)).nickname)
    if (!nickname) fail(400, '养鱼人昵称需要 1～16 字')
    if (keeperFor(c)) fail(409, '当前浏览器已有养鱼人身份')
    const time = now()
    const id = randomUUID()
    const session = randomBytes(32).toString('hex')
    const passcode = transaction(() => {
      useRateLimit(c, 'register', shanghaiDate(time), options.registerLimit ?? 8)
      let code = createPasscode()
      while (db.prepare('SELECT 1 FROM keepers WHERE passcode = ?').get(code)) code = createPasscode()
      db.prepare('INSERT INTO keepers(id, nickname, passcode, session) VALUES (?, ?, ?, ?)').run(id, nickname, code, session)
      return code
    })
    issueCookie(c, session)
    return c.json({ keeper: { id, nickname, passcode }, remainingRations: MAX_RATIONS, nextRationInSec: 0 }, 201)
  })

  api.post('/keeper/recover', async c => {
    const { passcode } = await readBody(c)
    if (typeof passcode !== 'string' || !/^FISH-(?:[A-Z2-9]{4}-){2}[A-Z2-9]{4}$/i.test(passcode.trim())) {
      fail(400, '通行码格式有误')
    }
    useRateLimit(c, 'recover', String(Math.floor(now() / 60_000)), 20)
    const row = db.prepare('SELECT id, nickname, passcode, session FROM keepers WHERE passcode = ?')
      .get(passcode.trim().toUpperCase()) as (KeeperRow & { session: string }) | undefined
    if (!row) fail(404, '通行码不存在')
    const { session, ...keeper } = row
    issueCookie(c, session)
    return c.json({ keeper, ...syncKeeperRations(keeper.id, now()) })
  })

  api.post('/keeper/nickname', async c => {
    const keeper = requireKeeper(c)
    const nickname = shortName((await readBody(c)).nickname)
    if (!nickname) fail(400, '养鱼人昵称需要 1～16 字')
    db.prepare('UPDATE keepers SET nickname = ? WHERE id = ?').run(nickname, keeper.id)
    const time = now()
    const fish = db.prepare(`${fishSelect} WHERE f.keeper_id = ? AND f.status = 'active' AND f.is_hidden = 0`)
      .all(keeper.id) as FishRow[]
    for (const row of fish) broadcastToTank(row.tank_id, 'fish_updated', { fish: presentFish(row, time) })
    return c.json({ keeper: { ...keeper, nickname } })
  })

  api.get('/tanks', c => {
    const keeperId = keeperFor(c)?.id
    const owned = keeperId
      ? db.prepare(`${tankSelect} WHERE t.owner_id = ? ORDER BY t.created_at, t.id`).all(keeperId) as TankRow[]
      : []
    const joined = keeperId
      ? db.prepare(`${tankSelect} JOIN tank_members m ON m.tank_id = t.id
        WHERE m.keeper_id = ? ORDER BY m.joined_at, t.id`).all(keeperId) as TankRow[]
      : []
    return c.json({
      publicTank: presentTank(publicTank, keeperId),
      ownedTanks: owned.map(tank => presentTank(tank, keeperId)),
      joinedTanks: joined.map(tank => presentTank(tank, keeperId)),
    })
  })

  api.post('/tanks', async c => {
    const keeper = requireKeeper(c)
    const name = shortName((await readBody(c)).name)
    if (!name) fail(400, '鱼缸名需要 1～16 字')
    const time = now()
    const id = randomUUID()
    const tank = transaction(() => {
      const { count } = db.prepare('SELECT COUNT(*) AS count FROM tanks WHERE owner_id = ?').get(keeper.id) as { count: number }
      if (count >= MAX_CUSTOM_TANKS_PER_KEEPER) fail(409, '每位养鱼人最多只能创建 2 个自建鱼缸')
      db.prepare('INSERT INTO tanks(id, owner_id, name, invite_code, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, keeper.id, name, newInviteCode(), time, time)
      return presentTank(findTank(id)!, keeper.id)
    })
    return c.json({ tank }, 201)
  })

  api.post('/tanks/join', async c => {
    const keeper = requireKeeper(c)
    const { inviteCode } = await readBody(c)
    const tank = transaction(() => {
      const row = tankForInvite(inviteCode)
      joinTank(row, keeper.id)
      return presentTank(row, keeper.id)
    })
    return c.json({ tank })
  })

  api.patch('/tanks/:id', async c => {
    const keeper = requireKeeper(c)
    const name = shortName((await readBody(c)).name)
    if (!name) fail(400, '鱼缸名需要 1～16 字')
    const tank = transaction(() => {
      const row = ownedTank(c.req.param('id'), keeper)
      db.prepare('UPDATE tanks SET name = ?, updated_at = ? WHERE id = ?').run(name, now(), row.id)
      return { ...row, name }
    })
    broadcastTankUpdate(tank)
    return c.json({ tank: presentTank(tank, keeper.id) })
  })

  api.post('/tanks/:id/rotate-invite', c => {
    const keeper = requireKeeper(c)
    const tank = transaction(() => {
      const row = ownedTank(c.req.param('id'), keeper)
      const inviteCode = newInviteCode()
      db.prepare('UPDATE tanks SET invite_code = ?, updated_at = ? WHERE id = ?').run(inviteCode, now(), row.id)
      return { ...row, invite_code: inviteCode }
    })
    for (const subscriber of tankSubscribers.get(tank.id) ?? []) {
      if (!subscriber.keeperId) subscriber.close()
    }
    broadcastTankUpdate(tank)
    return c.json({ tank: presentTank(tank, keeper.id) })
  })

  api.post('/tanks/:id/leave', c => {
    const keeper = requireKeeper(c)
    const id = c.req.param('id')
    transaction(() => {
      const tank = findTank(id) ?? fail(404, '找不到这个鱼缸')
      if (tank.owner_id === keeper.id || !isTankMember(id, keeper.id)) fail(403, '只有受邀加入的养鱼人可以退出鱼缸')
      if (tankCounts(id, keeper.id).myFishCount) fail(409, '请先将你在这个鱼缸里的鱼搬走或归档，再退出鱼缸')
      db.prepare('DELETE FROM tank_members WHERE tank_id = ? AND keeper_id = ?').run(id, keeper.id)
    })
    for (const subscriber of tankSubscribers.get(id) ?? []) {
      if (subscriber.keeperId === keeper.id) subscriber.close()
    }
    return c.json({ left: true })
  })

  api.delete('/tanks/:id', c => {
    const keeper = requireKeeper(c)
    const id = c.req.param('id')
    const archivedCount = transaction(() => {
      ownedTank(id, keeper)
      const { changes } = db.prepare("UPDATE fish SET status = 'archived', tank_id = ?, updated_at = ? WHERE tank_id = ? AND status = 'active'")
        .run(PUBLIC_TANK_ID, now(), id)
      db.prepare("UPDATE fish SET tank_id = ? WHERE tank_id = ? AND status = 'archived'").run(PUBLIC_TANK_ID, id)
      db.prepare("UPDATE pellets SET status = 'expired' WHERE tank_id = ? AND status = 'pending'").run(id)
      db.prepare("UPDATE golden_feasts SET status = 'expired' WHERE tank_id = ? AND status = 'active'").run(id)
      db.prepare('DELETE FROM tanks WHERE id = ?').run(id)
      return Number(changes)
    })
    broadcastToTank(id, 'tank_deleted', { tankId: id })
    return c.json({ deleted: true, archivedCount })
  })

  api.post('/tanks/:id/eject/:fishId', c => {
    const keeper = requireKeeper(c)
    const id = c.req.param('id')
    const time = now()
    const fish = transaction(() => {
      ownedTank(id, keeper)
      const row = findFish(c.req.param('fishId'))
      if (!row || row.tank_id !== id || row.status !== 'active') fail(404, '这条鱼已离开鱼缸')
      if (row.keeper_id === keeper.id) fail(403, '自己的鱼请直接归档')
      db.prepare("UPDATE fish SET status = 'archived', tank_id = ?, updated_at = ? WHERE id = ?").run(PUBLIC_TANK_ID, time, row.id)
      return presentFish(findFish(row.id)!, time)
    })
    broadcastToTank(id, 'fish_left', { fishId: fish.id })
    return c.json({ fish })
  })

  api.get('/tank/view', c => {
    const keeper = keeperFor(c)
    const tank = queryTank(c)
    const time = now()
    const response = { tank: presentTank(tank, keeper?.id), goldenFeast: activeFeast(tank.id, time) }
    if (tank.id !== PUBLIC_TANK_ID) {
      const rows = db.prepare(`${fishSelect} WHERE ${inTank} ORDER BY f.updated_at DESC, f.id LIMIT ?`)
        .all(tank.id, MAX_TOTAL_FISH_IN_CUSTOM_TANK) as FishRow[]
      return c.json({ ...response, fish: rows.map(row => presentFish(row, time)) })
    }
    const selected = new Map<string, FishRow>()
    const focus = c.req.query('focusFishId')
    if (focus && safeId.test(focus)) {
      const row = findFish(focus)
      if (row?.tank_id === tank.id && row.status === 'active' && !row.is_hidden) selected.set(row.id, row)
    }
    if (keeper) {
      const own = db.prepare(`${fishSelect} WHERE ${inTank} AND f.keeper_id = ? ORDER BY f.created_at DESC`)
        .all(tank.id, keeper.id) as FishRow[]
      for (const row of own) selected.set(row.id, row)
    }
    const excluded = (c.req.query('excludeIds') ?? '').split(',').filter(id => safeId.test(id)).slice(0, TANK_VIEW_LIMIT)
    function fill(limit: number, order: string) {
      if (limit <= 0) return
      const omit = [...new Set([...selected.keys(), ...excluded])]
      const filter = omit.length ? `AND f.id NOT IN (${omit.map(() => '?').join(',')})` : ''
      const rows = db.prepare(`${fishSelect} WHERE ${inTank} ${filter} ORDER BY ${order} LIMIT ?`)
        .all(tank.id, ...omit, limit) as FishRow[]
      for (const row of rows) selected.set(row.id, row)
    }
    fill(Math.min(12, TANK_VIEW_LIMIT - selected.size), 'f.updated_at DESC, RANDOM()')
    fill(TANK_VIEW_LIMIT - selected.size, 'RANDOM()')
    return c.json({ ...response, fish: [...selected.values()].map(row => presentFish(row, time)) })
  })

  api.get('/tank/leaderboard', c => {
    const tank = queryTank(c)
    const time = now()
    function top(order: string, ...params: string[]) {
      const rows = db.prepare(`${fishSelect} WHERE ${inTank} ORDER BY ${order}, f.id LIMIT 5`).all(tank.id, ...params) as FishRow[]
      return rows.map(row => presentFish(row, time))
    }
    return c.json({
      gluttons: top('CASE WHEN f.daily_eats_date = ? THEN f.daily_eats_count ELSE 0 END DESC, f.experience DESC', shanghaiDate(time)),
      bullies: top('f.total_knockouts DESC, f.brawn DESC'),
      giants: top('f.experience DESC, f.created_at'),
    })
  })

  api.post('/tank/knockout', async c => {
    requireKeeper(c)
    const { attackerFishId, victimFishId, inviteCode } = await readBody(c)
    if (typeof attackerFishId !== 'string' || !safeId.test(attackerFishId) ||
        typeof victimFishId !== 'string' || !safeId.test(victimFishId) || attackerFishId === victimFishId) {
      fail(400, '请选择两条不同的鱼')
    }
    const time = now()
    useRateLimit(c, 'knockout', String(Math.floor(time / 60_000)), 40)
    const { fish, victim } = transaction(() => {
      const attacker = activeFish(attackerFishId)
      const victim = activeFish(victimFishId)
      if (attacker.tank_id !== victim.tank_id) fail(409, '两条鱼需要在同一个鱼缸')
      resolveTankAccess(c, { tankId: attacker.tank_id, inviteCode, requireMemberForWrite: true })
      db.prepare('UPDATE fish SET total_knockouts = total_knockouts + 1 WHERE id = ?').run(attacker.id)
      return { fish: presentFish(findFish(attacker.id)!, time), victim }
    })
    broadcastToTank(fish.tankId, 'fish_updated', { fish })
    ticker(fish.tankId, 'knockout', `💥 ${fish.name} 把 ${victim.name} 撞晕了！`, fish.id, time)
    return c.json({ fish })
  })

  api.get('/fish/search', c => {
    const tank = queryTank(c)
    const query = (c.req.query('q') ?? '').trim().slice(0, 80)
    if (!query) return c.json({ fish: [] })
    const rows = db.prepare(`${fishSelect}
      WHERE ${inTank} AND
        (instr(lower(f.name), lower(?)) > 0 OR instr(lower(k.nickname), lower(?)) > 0)
      ORDER BY f.updated_at DESC LIMIT 20`).all(tank.id, query, query) as FishRow[]
    const time = now()
    return c.json({ fish: rows.map(row => presentFish(row, time)) })
  })

  api.get('/fish/:id', c => {
    const fish = visibleFish(c.req.param('id'), c)
    const feedingHistory = db.prepare(`
      SELECT consumed_at AS consumedAt, outcome FROM pellets
      WHERE winner_fish_id = ? AND status = 'consumed' ORDER BY consumed_at DESC, rowid DESC LIMIT 10
    `).all(fish.id) as unknown as FeedingRecord[]
    const { totalEats } = db.prepare(`
      SELECT (SELECT COUNT(*) FROM pellets WHERE winner_fish_id = ? AND status = 'consumed') +
        (SELECT COUNT(*) FROM golden_feasts WHERE winner_fish_id = ? AND status = 'consumed') AS totalEats
    `).get(fish.id, fish.id) as { totalEats: number }
    return c.json({ fish: { ...presentFish(fish, now()), feedingHistory, totalEats } })
  })

  api.post('/fish', async c => {
    const keeper = requireKeeper(c)
    const { name, pngBase64, eyes: rawEyes, tagline: rawTagline = '', tankId, inviteCode } = await readBody(c)
    const fishName = shortName(name)
    if (!fishName) fail(400, '鱼名需要 1～16 字')
    const eyes = validateEyes(rawEyes)
    if (!eyes) fail(400, '活眼球参数无效，最多可放置 4 只')
    if (typeof rawTagline !== 'string') fail(400, '口头禅需要是文字，最多 12 字')
    const tagline = rawTagline.trim()
    if ([...tagline].length > 12 || /\p{Cc}/u.test(tagline)) fail(400, '口头禅最多 12 字，且不能包含控制字符')
    const artwork = parseArtwork(pngBase64)
    if (!artwork) fail(400, `鱼图需为透明 PNG，最长边不超过 ${MAX_ART_EDGE} 像素，体积不超过 ${MAX_ART_BYTES / 1024} KB`)
    const id = randomUUID()
    const path = assetPath(id)
    const time = now()
    let wroteFile = false
    try {
      transaction(() => {
        const tank = resolveTankAccess(c, { tankId, inviteCode, requireMemberForWrite: true })
        verifyPlacement(tank, keeper.id)
        wroteFile = true
        writeFileSync(path, artwork, { flag: 'wx' })
        db.prepare('INSERT INTO fish(id, keeper_id, name, created_at, updated_at, eyes_json, tagline, tank_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, keeper.id, fishName, time, time, JSON.stringify(eyes), tagline, tank.id)
      })
    } catch (error) {
      if (wroteFile && (error as NodeJS.ErrnoException).code !== 'EEXIST') rmSync(path, { force: true })
      throw error
    }
    const fish = presentFish(findFish(id)!, time)
    broadcastToTank(fish.tankId, 'fish_released', { fish })
    return c.json({ fish }, 201)
  })

  api.get('/assets/fish/:filename', c => {
    const filename = c.req.param('filename')
    const id = filename.replace(/\.png$/, '')
    if (id === filename || !safeId.test(id)) fail(404, '找不到鱼的画作')
    visibleFish(id, c)
    try {
      return c.body(new Uint8Array(readFileSync(assetPath(id))), 200, {
        'Content-Type': 'image/png', 'Cache-Control': 'private, no-cache',
        'X-Content-Type-Options': 'nosniff',
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail(404, '找不到鱼的画作')
      throw error
    }
  })

  api.post('/fish/:id/archive', c => {
    const keeper = requireKeeper(c)
    const time = now()
    const row = transaction(() => {
      const fish = ownedFish(c.req.param('id'), keeper)
      if (fish.status === 'archived') fail(409, '这条鱼已深海归档')
      db.prepare("UPDATE fish SET status = 'archived', tank_id = ?, updated_at = ? WHERE id = ?").run(PUBLIC_TANK_ID, time, fish.id)
      return fish
    })
    broadcastToTank(row.tank_id, 'fish_archived', { fishId: row.id })
    return c.json({ fish: presentFish(findFish(row.id)!, time) })
  })

  api.post('/fish/:id/move', async c => {
    const keeper = requireKeeper(c)
    const { targetTankId, inviteCode } = await readBody(c)
    const time = now()
    const { fish, sourceTankId } = transaction(() => {
      const row = ownedFish(c.req.param('id'), keeper)
      if (row.status !== 'active' || row.is_hidden) fail(409, '只有在缸鱼可以搬家')
      const target = resolveTankAccess(c, { tankId: targetTankId, inviteCode, requireMemberForWrite: true })
      if (row.tank_id === target.id) return { fish: presentFish(row, time), sourceTankId: row.tank_id }
      verifyPlacement(target, keeper.id, true)
      db.prepare('UPDATE fish SET tank_id = ?, updated_at = ? WHERE id = ?').run(target.id, time, row.id)
      return { fish: presentFish(findFish(row.id)!, time), sourceTankId: row.tank_id }
    })
    if (sourceTankId !== fish.tankId) {
      broadcastToTank(sourceTankId, 'fish_left', { fishId: fish.id })
      broadcastToTank(fish.tankId, 'fish_released', { fish })
    }
    return c.json({ fish })
  })

  api.post('/fish/:id/stats', async c => {
    const keeper = requireKeeper(c)
    const increments = await readBody(c)
    const time = now()
    const row = transaction(() => {
      const fish = ownedFish(c.req.param('id'), keeper)
      const level = getGrowth(fish.experience).level
      const next = allocateStats(fish, increments, level)
      if (!next) fail(400, '属性增量、可用点数或单项上限不符')
      if (next.appetite !== fish.appetite) adjustBellyForAppetite(fish, level, next.appetite, time)
      db.prepare('UPDATE fish SET burst = ?, stamina = ?, sense = ?, agility = ?, brawn = ?, appetite = ?, updated_at = ? WHERE id = ?')
        .run(next.burst, next.stamina, next.sense, next.agility, next.brawn, next.appetite, time, fish.id)
      return findFish(fish.id)!
    })
    const fish = presentFish(row, time)
    if (fish.status === 'active' && !fish.isHidden) broadcastToTank(fish.tankId, 'fish_updated', { fish })
    return c.json({ fish })
  })

  api.post('/fish/:id/stats/reset', c => {
    const keeper = requireKeeper(c)
    const time = now()
    const row = transaction(() => {
      const fish = ownedFish(c.req.param('id'), keeper)
      if (!canRespec(fish.last_respec_date, time)) fail(409, '今天已经免费洗点过了')
      adjustBellyForAppetite(fish, getGrowth(fish.experience).level, 0, time)
      db.prepare(`UPDATE fish SET burst = 0, stamina = 0, sense = 0, agility = 0, brawn = 0, appetite = 0,
        last_respec_date = ?, updated_at = ? WHERE id = ?`).run(shanghaiDate(time), time, fish.id)
      return findFish(fish.id)!
    })
    const fish = presentFish(row, time)
    if (fish.status === 'active' && !fish.isHidden) broadcastToTank(fish.tankId, 'fish_updated', { fish })
    return c.json({ fish })
  })

  api.post('/fish/:id/report', async c => {
    const keeper = requireKeeper(c)
    const id = c.req.param('id')
    const { inviteCode } = await readBody(c, true)
    const { hidden, tankId } = transaction(() => {
      const row = findFish(id) ?? fail(404, '找不到这条鱼')
      if (row.status !== 'active' || row.is_hidden) fail(404, '找不到这条鱼')
      resolveTankAccess(c, { tankId: row.tank_id, inviteCode, requireMemberForWrite: true })
      const result = db.prepare('INSERT OR IGNORE INTO reports(fish_id, keeper_id) VALUES (?, ?)').run(id, keeper.id)
      if (!result.changes) fail(409, '你已经举报过这条鱼')
      const { count } = db.prepare('SELECT COUNT(*) AS count FROM reports WHERE fish_id = ?').get(id) as { count: number }
      if (count < REPORT_HIDE_THRESHOLD) return { hidden: false, tankId: row.tank_id }
      db.prepare('UPDATE fish SET is_hidden = 1 WHERE id = ?').run(id)
      return { hidden: true, tankId: row.tank_id }
    })
    if (hidden) broadcastToTank(tankId, 'fish_hidden', { fishId: id })
    return c.json({ hidden })
  })

  api.delete('/admin/fish/:id', c => {
    requireAdmin(c)
    const id = c.req.param('id')
    const row = db.prepare('UPDATE fish SET is_hidden = 1 WHERE id = ? RETURNING tank_id').get(id) as { tank_id: string } | undefined
    if (!row) fail(404, '找不到这条鱼')
    broadcastToTank(row.tank_id, 'fish_hidden', { fishId: id })
    return c.json({ hidden: true })
  })

  api.post('/admin/golden-feast', async c => {
    requireAdmin(c)
    const { tankId = PUBLIC_TANK_ID } = await readBody(c, true)
    const time = now()
    const { goldenFeast, spawned, id } = transaction(() => {
      const tank = tankId === PUBLIC_TANK_ID ? publicTank
        : (typeof tankId === 'string' ? findTank(tankId) : undefined) ?? fail(404, '找不到这个鱼缸')
      return { ...spawnFeast(tank.id, time), id: tank.id }
    })
    if (spawned) broadcastToTank(id, 'golden_feast_spawned', { goldenFeast })
    return c.json({ goldenFeast }, spawned ? 201 : 200)
  })

  api.post('/pellets/drop', async c => {
    const keeper = requireKeeper(c)
    const { x, y, tankId, inviteCode } = await readBody(c)
    if (!coordinate(x) || !coordinate(y)) fail(400, '鱼食坐标需要在 0～1 之间')
    const time = now()
    const pelletId = randomUUID()
    const expiresAt = time + PELLET_LIFETIME_MS
    useRateLimit(c, 'drop', String(Math.floor(time / 60_000)), options.dropLimit ?? 30)
    const rationState = transaction(afterCommit => {
      const tank = resolveTankAccess(c, { tankId, inviteCode, requireMemberForWrite: true })
      ensureTankCanEat(tank.id, time)
      db.prepare("UPDATE pellets SET status = 'expired' WHERE tank_id = ? AND status = 'pending' AND expires_at <= ?")
        .run(tank.id, time)
      const rationState = syncKeeperRations(keeper.id, time, { afterCommit, spend: true })
      db.prepare(`INSERT INTO pellets(id, keeper_id, x, y, expires_at, dropped_date, status, tank_id)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`).run(pelletId, keeper.id, x, y, expiresAt, shanghaiDate(time), tank.id)
      return rationState
    })
    return c.json({ pelletId, x, y, expiresAt, ...rationState }, 201)
  })

  api.post('/pellets/:pelletId/claim', async c => {
    const keeper = requireKeeper(c)
    const pelletId = c.req.param('pelletId')
    const { winnerFishId, inviteCode } = await readBody(c)
    if (typeof winnerFishId !== 'string' || !safeId.test(winnerFishId)) fail(400, '需要指定有效的鱼')
    const time = now()
    const result = transaction(afterCommit => {
      const pellet = ownedPellet(pelletId, keeper)
      if (pellet.status !== 'pending') fail(409, '这颗鱼食已失效')
      const rationState = syncKeeperRations(keeper.id, time, { afterCommit })
      if (pellet.expires_at <= time) {
        db.prepare("UPDATE pellets SET status = 'expired' WHERE id = ?").run(pelletId)
        return null
      }
      const row = activeFish(winnerFishId)
      if (row.tank_id !== pellet.tank_id) fail(409, '这条鱼已离开投放鱼食的鱼缸')
      resolveTankAccess(c, { tankId: pellet.tank_id, inviteCode, requireMemberForWrite: true })
      const { fish, outcome, levelDelta } = settleFish(row, time, feedFish)
      db.prepare(`UPDATE pellets SET status = 'consumed', consumed_date = ?, consumed_at = ?, winner_fish_id = ?, outcome = ?
        WHERE id = ?`).run(shanghaiDate(time), time, row.id, outcome, pelletId)
      const counter = pellet.tank_id === PUBLIC_TANK_ID ? 'normal_feeds_total' : `normal_feeds_total:${pellet.tank_id}`
      const { value } = db.prepare(`
        INSERT INTO tank_state(key, value) VALUES (?, 1)
        ON CONFLICT(key) DO UPDATE SET value = value + 1 RETURNING value
      `).get(counter) as { value: number }
      return {
        claim: { outcome, fish, levelDelta, ...rationState },
        feast: value % GOLDEN_FEAST_EVERY_FEEDS === 0 ? spawnFeast(pellet.tank_id, time) : null,
      }
    })
    if (!result) fail(409, '这颗鱼食已失效')
    const { fish, outcome, levelDelta } = result.claim
    broadcastToTank(fish.tankId, 'pellet_consumed', { pelletId, fish, outcome, levelDelta })
    if (outcome === 'stuffed_full') ticker(fish.tankId, 'stuffed', `🫧 ${fish.name} 彻底吃撑翻肚皮了！`, fish.id, time)
    if (result.feast?.spawned) broadcastToTank(fish.tankId, 'golden_feast_spawned', { goldenFeast: result.feast.goldenFeast })
    return c.json(result.claim)
  })

  api.post('/pellets/:pelletId/cancel', c => {
    const keeper = requireKeeper(c)
    const time = now()
    const state = transaction(afterCommit => {
      const pellet = ownedPellet(c.req.param('pelletId'), keeper)
      if (pellet.status === 'pending') {
        db.prepare('UPDATE pellets SET status = ? WHERE id = ?')
          .run(pellet.expires_at > time ? 'cancelled' : 'expired', pellet.id)
      }
      return syncKeeperRations(keeper.id, time, { afterCommit })
    })
    return c.json(state)
  })

  api.post('/golden-feast/:id/claim', async c => {
    requireKeeper(c)
    const { winnerFishId, inviteCode } = await readBody(c)
    if (typeof winnerFishId !== 'string' || !safeId.test(winnerFishId)) fail(400, '需要指定有效的鱼')
    const feastId = c.req.param('id')
    const time = now()
    const result = transaction(() => {
      const row = activeFish(winnerFishId)
      if (activeFeast(row.tank_id, time)?.id !== feastId) fail(409, '这颗黄金大餐已失效或不在同一个鱼缸')
      resolveTankAccess(c, { tankId: row.tank_id, inviteCode, requireMemberForWrite: true })
      const { fish, outcome, levelDelta } = settleFish(row, time, applyGoldenFeast)
      db.prepare("UPDATE golden_feasts SET status = 'consumed', winner_fish_id = ?, consumed_at = ? WHERE id = ?")
        .run(row.id, time, feastId)
      return { feastId, fish, outcome, levelDelta, xpGained: fish.experience - row.experience }
    })
    broadcastToTank(result.fish.tankId, 'golden_feast_consumed', result)
    const text = result.outcome === 'stuffed_full'
      ? `👑 ${result.fish.name} 一口吞下黄金大餐，直接撑翻了！`
      : `👑 ${result.fish.name} 抢走了天降黄金大餐！`
    ticker(result.fish.tankId, 'golden_feast', text, result.fish.id, time)
    return c.json(result)
  })

  api.get('/events', c => {
    const keeper = keeperFor(c)
    const { id: tankId } = queryTank(c)
    c.header('X-Accel-Buffering', 'no')
    return streamSSE(c, async stream => {
      await new Promise<void>(resolve => {
        const send: EventListener = (event, data) => {
          const written = stream.writeSSE({ event, data })
          if (event === 'tank_deleted') void written.then(finish)
        }
        const subscriber = { keeperId: keeper?.id, send, close: () => stream.abort() }
        const subscribers = tankSubscribers.get(tankId) ?? new Set<TankSubscriber>()
        subscribers.add(subscriber)
        tankSubscribers.set(tankId, subscribers)
        if (keeper) connectKeeper(keeper.id, send)
        const heartbeat = setInterval(() => void stream.writeSSE({ event: 'heartbeat', data: '{}' }), 25_000).unref()
        function finish() {
          if (!subscribers.delete(subscriber)) return
          clearInterval(heartbeat)
          if (!subscribers.size) tankSubscribers.delete(tankId)
          if (keeper) disconnectKeeper(keeper.id, send)
          resolve()
        }
        stream.onAbort(finish)
        void stream.writeSSE({ event: 'ready', data: '{}' })
      })
    })
  })

  api.all('*', c => c.json({ error: '接口不存在' }, 404))
  root.route('/api', api)
  root.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status)
    console.error(error)
    return c.json({ error: '鱼缸暂时无法处理这次请求' }, 500)
  })

  return { app: root, db, pauseRationRegen }
}
