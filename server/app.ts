import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { getCookie, setCookie } from 'hono/cookie'
import { HTTPException } from 'hono/http-exception'
import { streamSSE } from 'hono/streaming'
import type { FeedingRecord, GoldenFeast, TankEvents, TankTicker } from '../shared/contracts'
import {
  DAILY_RATION_LIMIT, GOLDEN_FEAST_EVERY_FEEDS, GOLDEN_FEAST_LIFETIME_MS, MAX_ACTIVE_FISH_PER_KEEPER,
  MAX_ART_BYTES, MAX_ART_EDGE, PELLET_LIFETIME_MS, REPORT_HIDE_THRESHOLD, TANK_VIEW_LIMIT,
  allocateStats, applyGoldenFeast, canRespec, feedFish, getBellyCapacity, getBellyState, getDigestIntervalMs,
  getGrowth, remainingRations, shanghaiDate, validateEyes,
} from '../shared/domain'
import { parseArtwork } from './art'
import { openStorage, presentFish, type FishRow, type KeeperRow } from './storage'

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
  expires_at: number
  status: 'pending' | 'consumed' | 'cancelled' | 'expired'
}

type EventListener = (event: keyof TankEvents, data: string) => void
const safeId = /^[a-z0-9-]{1,64}$/
const cookieName = 'fish_keeper'
const passcodeAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const inTank = "f.status = 'active' AND f.is_hidden = 0"

function createPasscode() {
  const letters = Array.from(randomBytes(12), byte => passcodeAlphabet[byte & 31]).join('')
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

async function readBody(c: Context): Promise<Record<string, unknown>> {
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
  const listeners = new Set<EventListener>()

  function broadcast<K extends keyof TankEvents>(event: K, value: TankEvents[K]) {
    const data = JSON.stringify(value)
    for (const listener of listeners) listener(event, data)
  }

  function keeperFor(c: Context) {
    const session = getCookie(c, cookieName)
    if (!session || !/^[a-f0-9]{64}$/.test(session)) return undefined
    return db.prepare('SELECT id, nickname, passcode FROM keepers WHERE session = ?').get(session) as KeeperRow | undefined
  }

  function requireKeeper(c: Context) {
    return keeperFor(c) ?? fail(401, '请先设置养鱼人昵称')
  }

  function requireAdmin(c: Context) {
    const expected = Buffer.from(options.adminSecret ?? '')
    const provided = Buffer.from(c.req.header('X-Admin-Secret') ?? '')
    if (!expected.length || provided.length !== expected.length || !timingSafeEqual(provided, expected)) fail(403, '无管理员权限')
  }

  function activeFish(id: string) {
    const row = findFish(id)
    if (!row || row.status !== 'active' || row.is_hidden) fail(409, '这条鱼已离开公共鱼缸')
    return row
  }

  function ticker(kind: TankTicker['kind'], text: string, fishId: string, createdAt: number) {
    broadcast('tank_ticker', { id: randomUUID(), kind, text, fishId, createdAt })
  }

  function activeFeast(time: number) {
    return (db.prepare(`
      SELECT id, x, y, created_at AS createdAt, expires_at AS expiresAt
      FROM golden_feasts WHERE status = 'active' AND expires_at > ?
    `).get(time) as GoldenFeast | undefined) ?? null
  }

  function spawnFeast(time: number) {
    const existing = activeFeast(time)
    if (existing) return { goldenFeast: existing, spawned: false }
    db.prepare("UPDATE golden_feasts SET status = 'expired' WHERE status = 'active' AND expires_at <= ?").run(time)
    const goldenFeast = {
      id: randomUUID(), x: 0.2 + Math.random() * 0.6, y: 0.14, createdAt: time, expiresAt: time + GOLDEN_FEAST_LIFETIME_MS,
    }
    db.prepare(`INSERT INTO golden_feasts(id, x, y, created_at, expires_at, status)
      VALUES (?, ?, ?, ?, ?, 'active')`).run(goldenFeast.id, goldenFeast.x, goldenFeast.y, time, goldenFeast.expiresAt)
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

  function rations(keeperId: string, time: number) {
    const { count } = db.prepare(`
      SELECT COUNT(*) AS count FROM pellets
      WHERE keeper_id = ? AND COALESCE(dropped_date, consumed_date) = ?
    `).get(keeperId, shanghaiDate(time)) as { count: number }
    return remainingRations(count)
  }

  function ensureTankCanEat(time: number) {
    const swimmers = db.prepare(`
      SELECT experience, appetite, belly_load, belly_full, belly_updated_at FROM fish WHERE status = 'active' AND is_hidden = 0
    `).iterate() as Iterable<Pick<FishRow, 'experience' | 'appetite' | 'belly_load' | 'belly_full' | 'belly_updated_at'>>
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
    if ((fish.is_hidden || fish.status !== 'active') && keeperFor(c)?.id !== fish.keeper_id) {
      fail(404, '找不到这条鱼')
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
      keeper, remainingRations: rations(keeper.id, time),
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
    return c.json({ keeper: { id, nickname, passcode }, remainingRations: DAILY_RATION_LIMIT }, 201)
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
    return c.json({ keeper, remainingRations: rations(keeper.id, now()) })
  })

  api.post('/keeper/nickname', async c => {
    const keeper = requireKeeper(c)
    const nickname = shortName((await readBody(c)).nickname)
    if (!nickname) fail(400, '养鱼人昵称需要 1～16 字')
    db.prepare('UPDATE keepers SET nickname = ? WHERE id = ?').run(nickname, keeper.id)
    const time = now()
    const fish = db.prepare(`${fishSelect} WHERE f.keeper_id = ? AND f.status = 'active' AND f.is_hidden = 0`)
      .all(keeper.id) as FishRow[]
    for (const row of fish) broadcast('fish_updated', { fish: presentFish(row, time) })
    return c.json({ keeper: { ...keeper, nickname } })
  })

  api.get('/tank/view', c => {
    const keeper = keeperFor(c)
    const time = now()
    const selected = new Map<string, FishRow>()
    const focus = c.req.query('focusFishId')
    if (focus && safeId.test(focus)) {
      const row = findFish(focus)
      if (row?.status === 'active' && !row.is_hidden) selected.set(row.id, row)
    }
    if (keeper) {
      const own = db.prepare(`${fishSelect} WHERE ${inTank} AND f.keeper_id = ? ORDER BY f.created_at DESC`)
        .all(keeper.id) as FishRow[]
      for (const row of own) selected.set(row.id, row)
    }
    const excluded = (c.req.query('excludeIds') ?? '').split(',').filter(id => safeId.test(id)).slice(0, TANK_VIEW_LIMIT)
    function fill(limit: number, order: string) {
      if (limit <= 0) return
      const omit = [...new Set([...selected.keys(), ...excluded])]
      const filter = omit.length ? `AND f.id NOT IN (${omit.map(() => '?').join(',')})` : ''
      const rows = db.prepare(`${fishSelect} WHERE ${inTank} ${filter} ORDER BY ${order} LIMIT ?`)
        .all(...omit, limit) as FishRow[]
      for (const row of rows) selected.set(row.id, row)
    }
    fill(Math.min(12, TANK_VIEW_LIMIT - selected.size), 'f.updated_at DESC, RANDOM()')
    fill(TANK_VIEW_LIMIT - selected.size, 'RANDOM()')
    return c.json({ fish: [...selected.values()].map(row => presentFish(row, time)), goldenFeast: activeFeast(time) })
  })

  api.get('/tank/leaderboard', c => {
    const time = now()
    function top(order: string, ...params: string[]) {
      const rows = db.prepare(`${fishSelect} WHERE ${inTank} ORDER BY ${order}, f.id LIMIT 5`).all(...params) as FishRow[]
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
    const { attackerFishId, victimFishId } = await readBody(c)
    if (typeof attackerFishId !== 'string' || !safeId.test(attackerFishId) ||
        typeof victimFishId !== 'string' || !safeId.test(victimFishId) || attackerFishId === victimFishId) {
      fail(400, '请选择两条不同的鱼')
    }
    const time = now()
    useRateLimit(c, 'knockout', String(Math.floor(time / 60_000)), 40)
    const { fish, victim } = transaction(() => {
      const attacker = activeFish(attackerFishId)
      const victim = activeFish(victimFishId)
      db.prepare('UPDATE fish SET total_knockouts = total_knockouts + 1 WHERE id = ?').run(attacker.id)
      return { fish: presentFish(findFish(attacker.id)!, time), victim }
    })
    broadcast('fish_updated', { fish })
    ticker('knockout', `💥 ${fish.name} 把 ${victim.name} 撞晕了！`, fish.id, time)
    return c.json({ fish })
  })

  api.get('/fish/search', c => {
    const query = (c.req.query('q') ?? '').trim().slice(0, 80)
    if (!query) return c.json({ fish: [] })
    const rows = db.prepare(`${fishSelect}
      WHERE f.status = 'active' AND f.is_hidden = 0 AND
        (instr(lower(f.name), lower(?)) > 0 OR instr(lower(k.nickname), lower(?)) > 0)
      ORDER BY f.updated_at DESC LIMIT 20`).all(query, query) as FishRow[]
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
    const { name, pngBase64, eyes: rawEyes, tagline: rawTagline = '' } = await readBody(c)
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
        const { count } = db.prepare("SELECT COUNT(*) AS count FROM fish WHERE keeper_id = ? AND status = 'active'")
          .get(keeper.id) as { count: number }
        if (count >= MAX_ACTIVE_FISH_PER_KEEPER) fail(409, '在缸鱼已满，请先深海归档一条鱼')
        wroteFile = true
        writeFileSync(path, artwork, { flag: 'wx' })
        db.prepare('INSERT INTO fish(id, keeper_id, name, created_at, updated_at, eyes_json, tagline) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(id, keeper.id, fishName, time, time, JSON.stringify(eyes), tagline)
      })
    } catch (error) {
      if (wroteFile && (error as NodeJS.ErrnoException).code !== 'EEXIST') rmSync(path, { force: true })
      throw error
    }
    const fish = presentFish(findFish(id)!, time)
    broadcast('fish_released', { fish })
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
    const row = ownedFish(c.req.param('id'), requireKeeper(c))
    if (row.status === 'archived') fail(409, '这条鱼已深海归档')
    const time = now()
    db.prepare("UPDATE fish SET status = 'archived', updated_at = ? WHERE id = ?").run(time, row.id)
    broadcast('fish_archived', { fishId: row.id })
    return c.json({ fish: presentFish(findFish(row.id)!, time) })
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
    if (fish.status === 'active' && !fish.isHidden) broadcast('fish_updated', { fish })
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
    if (fish.status === 'active' && !fish.isHidden) broadcast('fish_updated', { fish })
    return c.json({ fish })
  })

  api.post('/fish/:id/report', c => {
    const keeper = requireKeeper(c)
    const id = c.req.param('id')
    const hidden = transaction(() => {
      const row = findFish(id) ?? fail(404, '找不到这条鱼')
      if (row.status !== 'active' || row.is_hidden) fail(404, '找不到这条鱼')
      const result = db.prepare('INSERT OR IGNORE INTO reports(fish_id, keeper_id) VALUES (?, ?)').run(id, keeper.id)
      if (!result.changes) fail(409, '你已经举报过这条鱼')
      const { count } = db.prepare('SELECT COUNT(*) AS count FROM reports WHERE fish_id = ?').get(id) as { count: number }
      if (count < REPORT_HIDE_THRESHOLD) return false
      db.prepare('UPDATE fish SET is_hidden = 1 WHERE id = ?').run(id)
      return true
    })
    if (hidden) broadcast('fish_hidden', { fishId: id })
    return c.json({ hidden })
  })

  api.delete('/admin/fish/:id', c => {
    requireAdmin(c)
    const id = c.req.param('id')
    const result = db.prepare('UPDATE fish SET is_hidden = 1 WHERE id = ?').run(id)
    if (!result.changes) fail(404, '找不到这条鱼')
    broadcast('fish_hidden', { fishId: id })
    return c.json({ hidden: true })
  })

  api.post('/admin/golden-feast', c => {
    requireAdmin(c)
    const time = now()
    const { goldenFeast, spawned } = transaction(() => spawnFeast(time))
    if (spawned) broadcast('golden_feast_spawned', { goldenFeast })
    return c.json({ goldenFeast }, spawned ? 201 : 200)
  })

  api.post('/pellets/drop', async c => {
    const keeper = requireKeeper(c)
    const { x, y } = await readBody(c)
    if (!coordinate(x) || !coordinate(y)) fail(400, '鱼食坐标需要在 0～1 之间')
    const time = now()
    const pelletId = randomUUID()
    const expiresAt = time + PELLET_LIFETIME_MS
    useRateLimit(c, 'drop', String(Math.floor(time / 60_000)), options.dropLimit ?? 30)
    const remaining = transaction(() => {
      ensureTankCanEat(time)
      db.prepare("UPDATE pellets SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?").run(time)
      const available = rations(keeper.id, time)
      if (!available) fail(409, '今天的投喂配额已用完')
      db.prepare(`INSERT INTO pellets(id, keeper_id, x, y, expires_at, dropped_date, status)
        VALUES (?, ?, ?, ?, ?, ?, 'pending')`).run(pelletId, keeper.id, x, y, expiresAt, shanghaiDate(time))
      return available - 1
    })
    return c.json({ pelletId, x, y, expiresAt, remainingRations: remaining }, 201)
  })

  api.post('/pellets/:pelletId/claim', async c => {
    const keeper = requireKeeper(c)
    const pelletId = c.req.param('pelletId')
    const { winnerFishId } = await readBody(c)
    if (typeof winnerFishId !== 'string' || !safeId.test(winnerFishId)) fail(400, '需要指定有效的鱼')
    const time = now()
    const result = transaction(() => {
      const pellet = ownedPellet(pelletId, keeper)
      if (pellet.status !== 'pending') fail(409, '这颗鱼食已失效')
      if (pellet.expires_at <= time) {
        db.prepare("UPDATE pellets SET status = 'expired' WHERE id = ?").run(pelletId)
        return null
      }
      const row = activeFish(winnerFishId)
      const { fish, outcome, levelDelta } = settleFish(row, time, feedFish)
      db.prepare(`UPDATE pellets SET status = 'consumed', consumed_date = ?, consumed_at = ?, winner_fish_id = ?, outcome = ?
        WHERE id = ?`).run(shanghaiDate(time), time, row.id, outcome, pelletId)
      const { value } = db.prepare("UPDATE tank_state SET value = value + 1 WHERE key = 'normal_feeds_total' RETURNING value")
        .get() as { value: number }
      return {
        claim: { outcome, fish, remainingRations: rations(keeper.id, time), levelDelta },
        feast: value % GOLDEN_FEAST_EVERY_FEEDS === 0 ? spawnFeast(time) : null,
      }
    })
    if (!result) fail(409, '这颗鱼食已失效')
    const { fish, outcome, levelDelta } = result.claim
    broadcast('pellet_consumed', { pelletId, fish, outcome, levelDelta })
    if (outcome === 'stuffed_full') ticker('stuffed', `🫧 ${fish.name} 彻底吃撑翻肚皮了！`, fish.id, time)
    if (result.feast?.spawned) broadcast('golden_feast_spawned', { goldenFeast: result.feast.goldenFeast })
    return c.json(result.claim)
  })

  api.post('/pellets/:pelletId/cancel', c => {
    const keeper = requireKeeper(c)
    const time = now()
    const pellet = ownedPellet(c.req.param('pelletId'), keeper)
    if (pellet.status === 'pending') {
      db.prepare('UPDATE pellets SET status = ? WHERE id = ?')
        .run(pellet.expires_at > time ? 'cancelled' : 'expired', pellet.id)
    }
    return c.json({ remainingRations: rations(keeper.id, time) })
  })

  api.post('/golden-feast/:id/claim', async c => {
    requireKeeper(c)
    const { winnerFishId } = await readBody(c)
    if (typeof winnerFishId !== 'string' || !safeId.test(winnerFishId)) fail(400, '需要指定有效的鱼')
    const feastId = c.req.param('id')
    const time = now()
    const result = transaction(() => {
      if (activeFeast(time)?.id !== feastId) fail(409, '这颗黄金大餐已失效')
      const row = activeFish(winnerFishId)
      const { fish, outcome, levelDelta } = settleFish(row, time, applyGoldenFeast)
      db.prepare("UPDATE golden_feasts SET status = 'consumed', winner_fish_id = ?, consumed_at = ? WHERE id = ?")
        .run(row.id, time, feastId)
      return { feastId, fish, outcome, levelDelta, xpGained: fish.experience - row.experience }
    })
    broadcast('golden_feast_consumed', result)
    const text = result.outcome === 'stuffed_full'
      ? `👑 ${result.fish.name} 一口吞下黄金大餐，直接撑翻了！`
      : `👑 ${result.fish.name} 抢走了天降黄金大餐！`
    ticker('golden_feast', text, result.fish.id, time)
    return c.json(result)
  })

  api.get('/events', c => {
    c.header('X-Accel-Buffering', 'no')
    return streamSSE(c, async stream => {
      await new Promise<void>(resolve => {
        const listener: EventListener = (event, data) => {
          void stream.writeSSE({ event, data })
        }
        listeners.add(listener)
        const heartbeat = setInterval(() => void stream.writeSSE({ event: 'heartbeat', data: '{}' }), 25_000)
        stream.onAbort(() => {
          clearInterval(heartbeat)
          listeners.delete(listener)
          resolve()
        })
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

  return { app: root, db }
}
