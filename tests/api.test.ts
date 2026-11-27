import { randomBytes } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Claim, Fish, FishProfile, GoldenFeast, GoldenFeastClaim, Keeper, KeeperResponse, Leaderboard, Pellet, RationState, TankSummary, TankView } from '../shared/contracts'
import { GOLDEN_FEAST_LIFETIME_MS, MAX_ART_BYTES, MAX_ART_EDGE, MAX_RATIONS, PUBLIC_TANK_ID, RATION_REGEN_INTERVAL_MS, getStuffedComaMs } from '../shared/domain'
import { createApp } from '../server/app'

const date = Date.parse('2026-03-04T15:58:00Z')
let time: number
let temp: string
let service: ReturnType<typeof createApp>

function png(width = 12, height = 10, mode: 'transparent' | 'opaque' | 'blank' = 'transparent') {
  const image = new PNG({ width, height })
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      if (mode === 'blank' || (mode === 'transparent' && (x < 2 || y < 2))) continue
      image.data.set([92, 211, 189, 255], i)
    }
  }
  return PNG.sync.write(image).toString('base64')
}

function request(path: string, options: { cookie?: string; body?: object; method?: string; ip?: string; secret?: string } = {}) {
  const headers = new Headers()
  if (options.cookie) headers.set('Cookie', options.cookie)
  if (options.body) headers.set('Content-Type', 'application/json')
  if (options.ip) headers.set('Test-IP', options.ip)
  if (options.secret) headers.set('X-Admin-Secret', options.secret)
  return Promise.resolve(service.app.request('/api' + path, {
    method: options.method ?? (options.body ? 'POST' : 'GET'),
    body: options.body && JSON.stringify(options.body), headers,
  }))
}

async function JSONresponse<T>(response: Response, status = 200) {
  expect(response.status).toBe(status)
  return await response.json() as T
}

async function register(nickname: string, ip?: string) {
  const response = await request('/keeper/register', { body: { nickname }, ip })
  const created = await JSONresponse<{ keeper: Keeper } & RationState>(response, 201)
  expect(created).toMatchObject({ remainingRations: 20, nextRationInSec: 0 })
  const header = response.headers.get('set-cookie')!
  return { cookie: header.split(';')[0], header, keeper: created.keeper }
}

async function release(cookie: string, name: string, extra: object = {}) {
  const response = await request('/fish', { cookie, body: { name, pngBase64: png(), ...extra } })
  return (await JSONresponse<{ fish: Fish }>(response, 201)).fish
}

async function drop(cookie: string, ip?: string, scope: { tankId?: string; inviteCode?: string } = {}) {
  return JSONresponse<Pellet>(await request('/pellets/drop', { cookie, body: { x: 0.38, y: 0.44, ...scope }, ip }), 201)
}

function claim(cookie: string, pelletId: string, winnerFishId: string) {
  return request(`/pellets/${pelletId}/claim`, { cookie, body: { winnerFishId } })
}

const jar = async (cookie: string) => {
  const state = await JSONresponse<RationState>(await request('/keeper/me', { cookie }))
  return { remainingRations: state.remainingRations, nextRationInSec: state.nextRationInSec }
}

async function openEvents(cookie?: string, query = '') {
  const response = await request('/events' + query, { cookie })
  expect(response.headers.get('content-type')).toContain('text/event-stream')
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffered = ''

  async function next() {
    while (!buffered.includes('\n\n')) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error('Unexpected end of event stream')
      buffered += decoder.decode(chunk.value, { stream: true })
    }
    const boundary = buffered.indexOf('\n\n')
    const entry = buffered.slice(0, boundary)
    buffered = buffered.slice(boundary + 2)
    return { name: entry.match(/^event: (.*)$/m)![1], data: JSON.parse(entry.match(/^data: (.*)$/m)![1]) as object }
  }

  async function event(name: string) {
    for (;;) {
      const message = await next()
      if (message.name === name) return message.data
    }
  }

  expect((await next()).name).toBe('ready')
  return { next, event, close: () => reader.cancel() }
}

const view = (query = '', cookie?: string) =>
  request('/tank/view' + query, { cookie }).then(response => JSONresponse<TankView>(response))

const manualFeast = (secret?: string, tankId?: string) =>
  request('/admin/golden-feast', { method: 'POST', secret, body: tankId ? { tankId } : undefined })
const claimFeast = (id: string, winnerFishId: string, cookie?: string) =>
  request(`/golden-feast/${id}/claim`, { cookie, body: { winnerFishId } })

function openTestApp(dropLimit = 30) {
  return createApp({
    dataDir: join(temp, 'data'), dbPath: join(temp, 'db', 'test.sqlite'),
    adminSecret: 'test-only-secret', registerLimit: 3, dropLimit, now: () => time,
    ip: c => c.req.header('Test-IP') ?? 'default-ip',
  })
}

beforeEach(() => {
  time = date
  temp = mkdtempSync(join(tmpdir(), 'fish-api-'))
  service = openTestApp()
})

afterEach(() => {
  service.db.close()
  rmSync(temp, { recursive: true, force: true })
})

describe('SQLite API', () => {
  it('下水时保存活眼球与裁剪空格后的口头禅，并拒绝非法输入', async () => {
    const { cookie } = await register('贴纸作者')
    const eye = { x: 0.32, y: 0.48, radius: 0.06, style: 'deadpan' }
    const fish = await release(cookie, '会说话的鱼', { eyes: [eye], tagline: '  看我摆尾  ' })
    expect(fish).toMatchObject({ eyes: [eye], tagline: '看我摆尾', dailyEatsCount: 0, totalKnockouts: 0 })
    expect((await view()).fish[0]).toMatchObject({ eyes: [eye], tagline: '看我摆尾' })
    expect(await JSONresponse(await request(`/fish/${fish.id}`))).toMatchObject({ fish: { eyes: [eye], tagline: '看我摆尾', totalEats: 0 } })
    for (const invalid of [{ eyes: [{ ...eye, x: 2 }] }, { eyes: Array(5).fill(eye) },
      { eyes: [{ ...eye, style: 'invalid' }] }, { tagline: '🐠'.repeat(13) }, { tagline: '喂\n鱼' }, { tagline: null }]) {
      expect((await request('/fish', { cookie, body: { name: '无效元数据', pngBase64: png(), ...invalid } })).status).toBe(400)
    }
  })

  it('旧鱼表自动补迁肚子和进食列，保留历史经验、休眠时间和进食记录', async () => {
    const { cookie } = await register('旧鱼主人')
    const fish = await release(cookie, '旧鱼儿')
    const stuffed = await release(cookie, '旧库撑翻鱼')
    const pellet = await drop(cookie)
    await JSONresponse(await claim(cookie, pellet.pelletId, fish.id))
    const legacyAnchor = time - 1234
    service.db.prepare("UPDATE fish SET daily_fed_count = 6, daily_fed_date = '2026-03-04', stuffed_stacks = 2, stuffed_updated_at = ? WHERE id = ?")
      .run(legacyAnchor, fish.id)
    service.db.prepare('UPDATE fish SET experience = 55, brawn = 6, stuffed_stacks = 4, stuffed_updated_at = ? WHERE id = ?')
      .run(legacyAnchor, stuffed.id)
    const columns = ['tagline', 'eyes_json', 'daily_eats_count', 'daily_eats_date', 'total_knockouts',
      'appetite', 'belly_load', 'belly_full', 'belly_updated_at']
    for (const column of columns) service.db.exec(`ALTER TABLE fish DROP COLUMN ${column}`)
    service.db.exec('DROP TABLE golden_feasts; DROP TABLE tank_state')
    service.db.close()
    service = openTestApp()

    const names = service.db.prepare('PRAGMA table_info(fish)').all().map(row => row.name)
    expect(names).toEqual(expect.arrayContaining([
      ...columns, 'daily_fed_count', 'daily_fed_date', 'stuffed_stacks', 'stuffed_updated_at',
    ]))
    expect(service.db.prepare('SELECT * FROM fish WHERE id = ?').get(fish.id)).toMatchObject({
      daily_fed_count: 6, daily_fed_date: '2026-03-04', stuffed_stacks: 2, stuffed_updated_at: legacyAnchor,
      appetite: 0, belly_load: 0, belly_full: 0, belly_updated_at: 0,
    })
    expect(service.db.prepare('SELECT * FROM fish WHERE id = ?').get(stuffed.id)).toMatchObject({
      experience: 55, brawn: 6, stuffed_stacks: 4, stuffed_updated_at: legacyAnchor,
      appetite: 0, belly_load: 0, belly_full: 1, belly_updated_at: legacyAnchor,
    })
    expect(await JSONresponse(await request(`/fish/${fish.id}`))).toMatchObject({
      fish: { eyes: [], tagline: '', experience: 1, dailyEatsCount: 1, totalKnockouts: 0, totalEats: 1,
        bellyUsed: 0, stats: { appetite: 0 } },
    })
    expect(service.db.prepare("SELECT value FROM tank_state WHERE key = 'normal_feeds_total'").get()).toMatchObject({ value: 1 })
    expect((await view()).goldenFeast).toBeNull()
    const profile = () => request(`/fish/${stuffed.id}`).then(response => JSONresponse<{ fish: Fish }>(response))
    expect((await profile()).fish).toMatchObject({
      experience: 55, level: 18, stage: 'emperor', size: 275, unspentPoints: 11, stats: { brawn: 6, appetite: 0 },
      rawStuffedFull: true, isStuffedFull: true, bellyUpdatedAt: legacyAnchor, bellyUsed: 38,
      bellyCapacity: 38, bellyOverload: 2, bellyFillRatio: 1, digestIntervalSec: 18, digestionRemainingSec: 69,
    })
    time = legacyAnchor + 69_999
    expect((await profile()).fish).toMatchObject({ isStuffedFull: true, digestionRemainingSec: 1 })
    time++
    expect((await profile()).fish).toMatchObject({ isStuffedFull: false, bellyUsed: 0, digestionRemainingSec: 0 })
    const nextPellet = await drop(cookie)
    expect(await JSONresponse<Claim>(await claim(cookie, nextPellet.pelletId, stuffed.id))).toMatchObject({
      outcome: 'fed', fish: { experience: 55, rawStuffedFull: false, rawBellyLoad: 1, bellyUpdatedAt: time },
    })
    service.db.close()
    service = openTestApp()
    expect(service.db.prepare('SELECT * FROM fish WHERE id = ?').get(stuffed.id)).toMatchObject({
      stuffed_stacks: 4, stuffed_updated_at: legacyAnchor, belly_full: 0, belly_load: 1, belly_updated_at: time,
    })
  })

  it('撞晕累计与三张榜单按各自规则取前五，隐藏鱼及归档鱼不参与', async () => {
    const { cookie } = await register('辣鱼主人')
    const a = await release(cookie, '鱼甲')
    const b = await release(cookie, '鱼乙')
    const c = await release(cookie, '鱼丙')
    const other = await register('小鱼主人')
    const hidden = await release(other.cookie, '隐藏鱼')
    const archived = await release(other.cookie, '归档鱼')
    const fixture = service.db.prepare(`UPDATE fish SET experience = ?, daily_eats_count = ?, daily_eats_date = ?,
      total_knockouts = ?, brawn = ?, created_at = ? WHERE id = ?`)
    fixture.run(25, 2, '2026-03-04', 1, 2, time - 9, a.id)
    fixture.run(30, 2, '2026-03-04', 1, 5, time, b.id)
    fixture.run(25, 99, '2026-03-03', 2, 4, time - 10, c.id)
    for (const id of [hidden.id, archived.id]) fixture.run(55, 999, '2026-03-04', 999, 6, time - 20, id)
    service.db.prepare('UPDATE fish SET is_hidden = 1 WHERE id = ?').run(hidden.id)
    await JSONresponse(await request(`/fish/${archived.id}/archive`, { method: 'POST', cookie: other.cookie }))
    const fill = await register('其余鱼主人')
    for (let index = 0; index < 3; index++) await release(fill.cookie, '鱼' + index)

    const hit = { attackerFishId: a.id, victimFishId: b.id }
    expect((await request('/tank/knockout', { body: hit })).status).toBe(401)
    expect((await request('/tank/knockout', { cookie, body: { ...hit, victimFishId: a.id } })).status).toBe(400)
    expect((await request('/tank/knockout', { cookie, body: { ...hit, victimFishId: hidden.id } })).status).toBe(409)
    expect(await JSONresponse(await request('/tank/knockout', { cookie, body: hit })))
      .toMatchObject({ fish: { id: a.id, totalKnockouts: 2 } })
    const boards = await JSONresponse<Leaderboard>(await request('/tank/leaderboard'))
    const ids = (list: Fish[]) => list.slice(0, 3).map(fish => fish.id)
    expect(ids(boards.gluttons)).toEqual([b.id, a.id, c.id])
    expect(boards.gluttons[2].dailyEatsCount).toBe(0)
    expect(ids(boards.bullies)).toEqual([c.id, a.id, b.id])
    expect(ids(boards.giants)).toEqual([b.id, c.id, a.id])
    for (const board of [boards.gluttons, boards.bullies, boards.giants]) {
      expect(board).toHaveLength(5)
      expect(board.some(fish => fish.id === hidden.id || fish.id === archived.id)).toBe(false)
    }
  })

  it('累计 15 颗普通鱼食触发黄金大餐，并发只令一条鱼加 3 经验并连升', async () => {
    const first = await register('第一位投喂者')
    const second = await register('第二位投喂者')
    const fish = [await release(first.cookie, '鱼一'), await release(first.cookie, '鱼二'), await release(first.cookie, '鱼三')]
    const winner = await release(second.cookie, '黄金赢家')
    for (let index = 0; index < 15; index++) {
      const cookie = index < 10 ? first.cookie : second.cookie
      const pellet = await drop(cookie)
      await JSONresponse(await claim(cookie, pellet.pelletId, fish[index % fish.length].id))
      if (index < 14) expect((await view()).goldenFeast).toBeNull()
    }
    const meal = (await view()).goldenFeast!
    expect(meal).toMatchObject({ y: 0.14, createdAt: time, expiresAt: time + GOLDEN_FEAST_LIFETIME_MS })
    expect(meal.x).toBeGreaterThanOrEqual(0.2)
    expect(meal.x).toBeLessThanOrEqual(0.8)
    expect((await claimFeast(meal.id, winner.id)).status).toBe(401)

    const attempts = await Promise.all([claimFeast(meal.id, winner.id, first.cookie),
      claimFeast(meal.id, winner.id, second.cookie), claimFeast(meal.id, winner.id, second.cookie)])
    expect(attempts.map(result => result.status).sort()).toEqual([200, 409, 409])
    expect(await JSONresponse<GoldenFeastClaim>(attempts.find(result => result.ok)!)).toMatchObject({
      feastId: meal.id, xpGained: 3, levelDelta: 3, outcome: 'leveled_up',
      fish: { id: winner.id, experience: 3, level: 4, unspentPoints: 3, dailyEatsCount: 1 },
    })
    expect((await view()).goldenFeast).toBeNull()
    expect(await JSONresponse(await request('/keeper/me', { cookie: second.cookie }))).toMatchObject({ remainingRations: 15 })
  })

  it('管理员可触发黄金大餐，同一时间只保留一颗，过期拒绝结算', async () => {
    const { cookie } = await register('黄金鱼主人')
    const fish = await release(cookie, '满级金鱼')
    service.db.prepare('UPDATE fish SET experience = 55 WHERE id = ?').run(fish.id)
    expect((await manualFeast()).status).toBe(403)
    const { goldenFeast: first } = await JSONresponse<{ goldenFeast: GoldenFeast }>(await manualFeast('test-only-secret'), 201)
    expect(await JSONresponse(await manualFeast('test-only-secret'))).toEqual({ goldenFeast: first })
    expect(await JSONresponse(await claimFeast(first.id, fish.id, cookie))).toMatchObject({
      outcome: 'fed', xpGained: 0,
      fish: { experience: 55, level: 18, stage: 'emperor', size: 275, rawBellyLoad: 14, bellyOverload: 0, dailyEatsCount: 1 },
    })
    const { goldenFeast: second } = await JSONresponse<{ goldenFeast: GoldenFeast }>(await manualFeast('test-only-secret'), 201)
    time += GOLDEN_FEAST_LIFETIME_MS
    expect((await claimFeast(second.id, fish.id, cookie)).status).toBe(409)
    expect((await view()).goldenFeast).toBeNull()
    const { goldenFeast: third } = await JSONresponse<{ goldenFeast: GoldenFeast }>(await manualFeast('test-only-secret'), 201)
    expect(third.id).not.toBe(second.id)
  })

  it('空缸不会生成鱼，重启后隐藏旧演示鱼并保留进食历史', async () => {
    expect(await view()).toEqual({
      tank: { id: PUBLIC_TANK_ID, name: '公共鱼缸', isPublic: true, isOwner: false, fishCount: 0, maxFish: null, myFishCount: 0, myFishLimit: 3 },
      fish: [], goldenFeast: null,
    })
    const assets = join(temp, 'data', 'fish')
    expect(readdirSync(assets)).toEqual([])
    const { cookie } = await register('访客')
    const real = await release(cookie, '我的鱼')
    service.db.exec("INSERT INTO keepers(id, nickname) VALUES ('system', '深海管理员')")
    service.db.prepare(`
      INSERT INTO fish(id, keeper_id, name, is_system, created_at, updated_at)
      VALUES ('seed-1', 'system', '旧演示鱼', 1, ?, ?)
    `).run(time, time)
    writeFileSync(join(assets, 'seed-1.png'), Buffer.from(png(), 'base64'))
    const pellet = await drop(cookie)
    await JSONresponse(await claim(cookie, pellet.pelletId, 'seed-1'))

    service.db.close()
    service = openTestApp()

    expect((await view('?focusFishId=seed-1')).fish.map(item => item.id)).toEqual([real.id])
    expect((await request('/assets/fish/seed-1.png')).status).toBe(404)
    expect(readdirSync(assets)).toContain('seed-1.png')
    expect(service.db.prepare('SELECT winner_fish_id FROM pellets WHERE id = ?').get(pellet.pelletId))
      .toMatchObject({ winner_fish_id: 'seed-1' })
  })

  it('免登录围观、通行码跨会话恢复、昵称修改和每日 IP 限流', async () => {
    expect(await JSONresponse(await request('/keeper/me'))).toEqual({ keeper: null })
    expect((await request('/keeper/register', { body: { nickname: ' ' } })).status).toBe(400)
    const first = await register('小满', 'one')
    expect(first.header).toContain('HttpOnly')
    expect(first.header).toContain('SameSite=Lax')
    expect(first.header).toContain('Path=/')
    expect(first.keeper.passcode).toMatch(/^FISH-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    expect((await request('/keeper/register', { cookie: first.cookie, body: { nickname: '重复' } })).status).toBe(409)
    const recovered = await request('/keeper/recover', { body: { passcode: first.keeper.passcode.toLowerCase() } })
    expect(await JSONresponse(recovered)).toMatchObject({ keeper: first.keeper, remainingRations: 20, nextRationInSec: 0 })
    const secondSession = recovered.headers.get('set-cookie')!.split(';')[0]
    expect(await JSONresponse(await request('/keeper/nickname', { cookie: secondSession, body: { nickname: '  海风  ' } })))
      .toMatchObject({ keeper: { id: first.keeper.id, nickname: '海风' } })
    expect(await JSONresponse(await request('/keeper/me', { cookie: first.cookie }))).toMatchObject({
      keeper: { nickname: '海风' }, activeFish: [], archivedFish: [],
    })
    expect((await request('/keeper/recover', { body: { passcode: 'bogus' } })).status).toBe(400)
    await register('潮', 'one')
    await register('沙', 'one')
    expect((await request('/keeper/register', { body: { nickname: '第四位' }, ip: 'one' })).status).toBe(429)
    await register('另一地址', 'two')
    time += 120_000
    await register('第二天的同一地址', 'one')
  })

  it('验证手绘 PNG 与在缸槽位，归档后第 4 条可以下水', async () => {
    const { cookie } = await register('岸')
    expect((await request('/fish', { body: { name: '无人鱼', pngBase64: png() } })).status).toBe(401)
    for (const invalid of ['not an image', png().slice(0, 44), png(MAX_ART_EDGE + 1, 10), png(12, 10, 'opaque'),
      png(12, 10, 'blank'), png(3, 3), Buffer.alloc(MAX_ART_BYTES + 1).toString('base64')]) {
      expect((await request('/fish', { cookie, body: { name: '坏图', pngBase64: invalid } })).status).toBe(400)
    }
    expect((await request('/fish', { cookie, body: { name: '🐠'.repeat(17), pngBase64: png() } })).status).toBe(400)
    const first = await release(cookie, '🐠'.repeat(16))
    const second = await release(cookie, '远岸')
    const third = await release(cookie, '沙洲')
    expect(first).toMatchObject({ level: 1, size: 40, status: 'active', isSystem: false })
    const artwork = await request(first.assetUrl.slice(4))
    expect(artwork.status).toBe(200)
    expect(artwork.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await artwork.arrayBuffer()).toString('base64')).toBe(png())
    expect((await request('/assets/fish/%2e%2e%2fGLOSSARY.png')).status).toBe(404)
    const { cookie: other } = await register('他人')
    expect((await request(`/fish/${first.id}/archive`, { cookie: other, method: 'POST' })).status).toBe(403)
    expect((await request('/fish', { cookie, body: { name: '第 4 条', pngBase64: png() } })).status).toBe(409)
    expect(readdirSync(join(temp, 'data', 'fish'))).toHaveLength(3)
    expect(await JSONresponse(await request(`/fish/${first.id}/archive`, { cookie, method: 'POST' })))
      .toMatchObject({ fish: { id: first.id, status: 'archived' } })
    const fourth = await release(cookie, '接潮')
    const owner = await JSONresponse<KeeperResponse>(await request('/keeper/me', { cookie }))
    if (!owner.keeper) throw new Error('Expected an authenticated Keeper')
    expect(owner.activeFish.map(fish => fish.id).sort()).toEqual([second.id, third.id, fourth.id].sort())
    expect(owner.archivedFish[0].id).toBe(first.id)
    expect((await request(`/fish/${first.id}`)).status).toBe(404)
    expect((await request(`/fish/${first.id}`, { cookie })).status).toBe(200)
  })

  it('放生图片接受 512 像素边界，拒绝边长合规但体积过大的有效 PNG', async () => {
    const { cookie } = await register('画鱼')
    const limit = await request('/fish', { cookie, body: { name: '细长鱼', pngBase64: png(MAX_ART_EDGE, 12) } })
    expect(limit.status).toBe(201)

    const noisy = new PNG({ width: MAX_ART_EDGE, height: MAX_ART_EDGE })
    noisy.data = randomBytes(noisy.data.length)
    noisy.data[3] = 0
    const large = PNG.sync.write(noisy)
    expect(large.length).toBeGreaterThan(MAX_ART_BYTES)
    const response = await request('/fish', { cookie, body: { name: '大图', pngBase64: large.toString('base64') } })
    expect(response.status).toBe(413)
  })

  it('水域限 35 条且优先定焦和本人，支持排除与鱼名或昵称搜索', async () => {
    const { cookie, keeper } = await register('寻鱼人')
    const own = [await release(cookie, '青一'), await release(cookie, '青二'), await release(cookie, '青三')]
    const neighbor = await register('另一位养鱼人')
    const add = service.db.prepare(`INSERT INTO fish(id, keeper_id, name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)`)
    for (let i = 0; i < 42; i++) add.run(`filler-${i}`, neighbor.keeper.id, `深海鱼 ${i}`, time - i, time - i)
    service.db.prepare("UPDATE fish SET is_hidden = 1 WHERE id = 'filler-0'").run()
    const { fish } = await view('?focusFishId=filler-41&excludeIds=filler-2,filler-4', cookie)
    expect(fish).toHaveLength(35)
    expect(fish[0].id).toBe('filler-41')
    expect(fish.slice(1, 4).map(item => item.id).sort()).toEqual(own.map(item => item.id).sort())
    expect(fish.map(item => item.id)).not.toEqual(expect.arrayContaining(['filler-0']))
    expect(fish.some(item => ['filler-0', 'filler-2', 'filler-4'].includes(item.id))).toBe(false)
    expect(new Set(fish.map(item => item.id)).size).toBe(35)
    expect((await view('?focusFishId=filler-0')).fish.some(item => item.id === 'filler-0')).toBe(false)
    const byName = await JSONresponse<{ fish: Fish[] }>(await request('/fish/search?q=' + encodeURIComponent('青二')))
    expect(byName.fish.map(item => item.id)).toEqual([own[1].id])
    const byKeeper = await JSONresponse<{ fish: Fish[] }>(await request('/fish/search?q=' + encodeURIComponent(keeper.nickname)))
    expect(byKeeper.fish).toHaveLength(3)
    const byNeighbor = await JSONresponse<{ fish: Fish[] }>(await request('/fish/search?q=' + encodeURIComponent(neighbor.keeper.nickname)))
    expect(byNeighbor.fish).toHaveLength(20)
  })

  it('投放即扣减，结算防重复，取消或超时不返还鱼食', async () => {
    const { cookie } = await register('投喂者')
    const { cookie: other } = await register('围观者')
    const fish = await release(cookie, '绿光')
    expect((await request('/pellets/drop', { cookie, body: { x: 1.1, y: 0 } })).status).toBe(400)
    const a = await drop(cookie)
    const b = await drop(cookie)
    const c = await drop(cookie)
    expect([a.remainingRations, b.remainingRations, c.remainingRations]).toEqual([19, 18, 17])
    expect(a).toMatchObject({ x: 0.38, y: 0.44, expiresAt: time + 90_000, nextRationInSec: 60 })
    expect((await claim(other, b.pelletId, fish.id)).status).toBe(403)
    expect((await claim(cookie, a.pelletId, 'missing')).status).toBe(409)
    expect(await JSONresponse(await request(`/pellets/${b.pelletId}/cancel`, { method: 'POST', cookie })))
      .toEqual({ remainingRations: 17, nextRationInSec: 60 })
    expect((await claim(cookie, b.pelletId, fish.id)).status).toBe(409)
    const submissions = await Promise.all([
      claim(cookie, a.pelletId, fish.id), claim(cookie, a.pelletId, fish.id), claim(cookie, a.pelletId, fish.id),
    ])
    expect(submissions.map(res => res.status).sort()).toEqual([200, 409, 409])
    const growth = await JSONresponse<Claim>(submissions.find(res => res.ok)!)
    expect(growth).toMatchObject({ outcome: 'leveled_up', remainingRations: 17, nextRationInSec: 60, levelDelta: 1,
      fish: { experience: 1, level: 2, dailyEatsCount: 1, bellyUsed: 1, bellyCapacity: 3, unspentPoints: 1 } })
    time += 90_000
    expect(await JSONresponse(await request('/keeper/me', { cookie }))).toMatchObject({ remainingRations: 17 })
    expect((await claim(cookie, c.pelletId, fish.id)).status).toBe(409)
    expect(service.db.prepare('SELECT status FROM pellets WHERE id = ?').get(c.pelletId))
      .toMatchObject({ status: 'expired' })
    expect(await JSONresponse(await request(`/pellets/${c.pelletId}/cancel`, { method: 'POST', cookie })))
      .toEqual({ remainingRations: 17, nextRationInSec: 60 })
    for (let index = 16; index >= 0; index--) {
      expect((await drop(cookie)).remainingRations).toBe(index)
    }
    expect(await JSONresponse(await request('/pellets/drop', { cookie, body: { x: 0, y: 0 } }), 409))
      .toMatchObject({ error: '鱼食已用完，留在页面每分钟恢复 1 颗' })
    const profile = await JSONresponse<{ fish: FishProfile }>(await request(`/fish/${fish.id}`))
    expect(profile.fish.feedingHistory).toHaveLength(1)
  })

  it('离线时鱼食和进度不随上海午夜或时长变化，跨午夜正常结算进食', async () => {
    const { cookie } = await register('午夜投喂者')
    const fish = await release(cookie, '夜光')
    time = Date.parse('2026-03-04T15:59:00Z')
    const across = await drop(cookie)
    expect(across.remainingRations).toBe(19)
    time += 60_000
    expect(await jar(cookie)).toEqual({ remainingRations: 19, nextRationInSec: 60 })
    expect(await JSONresponse<Claim>(await claim(cookie, across.pelletId, fish.id)))
      .toMatchObject({ outcome: 'leveled_up', fish: { dailyEatsCount: 1, experience: 1 }, remainingRations: 19, nextRationInSec: 60 })
    expect(service.db.prepare('SELECT dropped_date, consumed_date FROM pellets WHERE id = ?').get(across.pelletId))
      .toMatchObject({ dropped_date: '2026-03-04', consumed_date: '2026-03-05' })
    const profile = await JSONresponse<{ fish: FishProfile }>(await request(`/fish/${fish.id}`))
    expect(profile.fish.feedingHistory[0].consumedAt).toBe(time)
    const viewer = await openEvents()
    try {
      time += 6 * 60 * 60_000
      expect(await jar(cookie)).toEqual({ remainingRations: 19, nextRationInSec: 60 })
      expect((await drop(cookie)).remainingRations).toBe(18)
    } finally {
      await viewer.close()
    }
  })

  it('登录 SSE 后按实际在线毫秒积累，跨上海午夜继续，最多恢复到 20 颗', async () => {
    const { cookie, keeper } = await register('在线养鱼人')
    await release(cookie, '在线鱼')
    expect(await jar(cookie)).toEqual({ remainingRations: 20, nextRationInSec: 0 })
    time = Date.parse('2026-03-04T15:59:35Z')
    const first = await drop(cookie)
    await drop(cookie)
    const stream = await openEvents(cookie)
    try {
      time += 35_000
      expect(await jar(cookie)).toEqual({ remainingRations: 18, nextRationInSec: 25 })
      expect(await JSONresponse(await request('/keeper/recover', { body: { passcode: keeper.passcode } })))
        .toMatchObject({ remainingRations: 18, nextRationInSec: 25 })
      expect(await JSONresponse(await request(`/pellets/${first.pelletId}/cancel`, { cookie, method: 'POST' })))
        .toEqual({ remainingRations: 18, nextRationInSec: 25 })
      time += 25_000
      expect(await jar(cookie)).toEqual({ remainingRations: 19, nextRationInSec: 60 })
      time += 30 * RATION_REGEN_INTERVAL_MS
      expect(await jar(cookie)).toEqual({ remainingRations: 20, nextRationInSec: 0 })
      expect(await drop(cookie)).toMatchObject({ remainingRations: 19, nextRationInSec: 60 })
    } finally {
      await stream.close()
    }
  })

  it('最后一个 SSE 关闭时保存 40 秒进度，十分钟离线后只需再在线 20 秒', async () => {
    const { cookie, keeper } = await register('暂停养鱼人')
    await release(cookie, '暂停鱼')
    const stream = await openEvents(cookie)
    try {
      await drop(cookie)
      time += 40_000
    } finally {
      await stream.close()
    }
    expect(service.db.prepare('SELECT ration_progress_ms FROM keepers WHERE id = ?').get(keeper.id))
      .toEqual({ ration_progress_ms: 40_000 })
    time += 10 * RATION_REGEN_INTERVAL_MS
    expect(await jar(cookie)).toEqual({ remainingRations: 19, nextRationInSec: 20 })
    const reopened = await openEvents(cookie)
    try {
      time += 20_000
      expect(await jar(cookie)).toEqual({ remainingRations: 20, nextRationInSec: 0 })
    } finally {
      await reopened.close()
    }
  })

  it('同一养鱼人的多个 SSE 合并计时，关闭一个后继续恢复', async () => {
    const { cookie } = await register('多标签养鱼人')
    await release(cookie, '多标签鱼')
    for (let index = 0; index < 3; index++) await drop(cookie)
    const first = await openEvents(cookie)
    let second: Awaited<ReturnType<typeof openEvents>> | undefined
    try {
      time += 35_000
      second = await openEvents(cookie)
      time += 25_000
      expect(await jar(cookie)).toEqual({ remainingRations: 18, nextRationInSec: 60 })
      await first.close()
      time += RATION_REGEN_INTERVAL_MS
      expect(await jar(cookie)).toEqual({ remainingRations: 19, nextRationInSec: 60 })
    } finally {
      await first.close()
      await second?.close()
    }
    time += RATION_REGEN_INTERVAL_MS
    expect(await jar(cookie)).toEqual({ remainingRations: 19, nextRationInSec: 60 })
  })

  it('服务停止前保存在线进度，重启期间不累计', async () => {
    const { cookie } = await register('重启养鱼人')
    await release(cookie, '重启鱼')
    const stream = await openEvents(cookie)
    try {
      await drop(cookie)
      time += 31_000
      service.pauseRationRegen()
    } finally {
      await stream.close()
    }
    service.db.close()
    time += 10 * RATION_REGEN_INTERVAL_MS
    service = openTestApp()
    expect(await jar(cookie)).toEqual({ remainingRations: 19, nextRationInSec: 29 })
  })

  it('周期恢复仅向对应养鱼人的全部 SSE 推送私有补给', async () => {
    const { cookie } = await register('补给养鱼人')
    const other = await register('无关养鱼人')
    await release(cookie, '补给鱼')
    await drop(cookie)
    const streams: Awaited<ReturnType<typeof openEvents>>[] = []
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      for (const session of [cookie, cookie, other.cookie, undefined]) streams.push(await openEvents(session))
      time += 59_000
      vi.advanceTimersByTime(1000)
      const early = await release(cookie, '到期前的标记鱼')
      for (const stream of streams) {
        expect(await stream.next()).toMatchObject({ name: 'fish_released', data: { fish: { id: early.id } } })
      }
      time += 1000
      vi.advanceTimersByTime(1000)
      const marker = await release(other.cookie, '广播标记鱼')
      for (const stream of streams.slice(0, 2)) {
        expect(await stream.next()).toEqual({
          name: 'rations_updated', data: { remainingRations: 20, nextRationInSec: 0 },
        })
      }
      for (const stream of streams.slice(2)) {
        expect(await stream.next()).toMatchObject({ name: 'fish_released', data: { fish: { id: marker.id } } })
      }
    } finally {
      for (const stream of streams) await stream.close()
      vi.useRealTimers()
    }
  })

  it('进食结算回滚时不会提前推进在线恢复时间', async () => {
    const { cookie, keeper } = await register('事务养鱼人')
    await release(cookie, '事务鱼')
    const pellet = await drop(cookie)
    const stream = await openEvents(cookie)
    try {
      time += 35_000
      expect((await claim(cookie, pellet.pelletId, 'missing')).status).toBe(409)
      expect(service.db.prepare('SELECT rations, ration_progress_ms FROM keepers WHERE id = ?').get(keeper.id))
        .toEqual({ rations: 19, ration_progress_ms: 0 })
      time += 25_000
      expect(await jar(cookie)).toEqual({ remainingRations: 20, nextRationInSec: 0 })
    } finally {
      await stream.close()
    }
  })

  it('空缸和全缸鱼都撑不动时拒绝投放，鱼只在消化完成后恢复投喂', async () => {
    const { cookie } = await register('等鱼的养鱼人')
    const attempt = () => request('/pellets/drop', { cookie, body: { x: 0, y: 0 } })
    expect(await JSONresponse(await attempt(), 409)).toMatchObject({ error: '鱼缸里还没有鱼，先画一条下水吧' })
    expect(await JSONresponse(await request('/keeper/me', { cookie }))).toMatchObject({ remainingRations: 20 })
    expect(service.db.prepare('SELECT COUNT(*) AS count FROM pellets').get()).toMatchObject({ count: 0 })

    const stuffed = await release(cookie, '已经吃撑')
    const hidden = await release(cookie, '已隐藏')
    const archived = await release(cookie, '已归档')
    service.db.prepare('UPDATE fish SET belly_load = 4, belly_full = 1, belly_updated_at = ? WHERE id = ?').run(time, stuffed.id)
    service.db.prepare('UPDATE fish SET is_hidden = 1 WHERE id = ?').run(hidden.id)
    service.db.prepare("UPDATE fish SET status = 'archived' WHERE id = ?").run(archived.id)
    time += getStuffedComaMs(1) - 1
    expect(await JSONresponse(await attempt(), 409)).toMatchObject({ error: '鱼缸里的鱼都撑不动了，稍后再喂吧' })
    expect(await JSONresponse(await request('/keeper/me', { cookie }))).toMatchObject({ remainingRations: 20 })
    expect(service.db.prepare('SELECT COUNT(*) AS count FROM pellets').get()).toMatchObject({ count: 0 })
    time++
    expect((await drop(cookie)).remainingRations).toBe(19)
  })

  it('启动迁移没有 dropped_date 的旧鱼食表，并保留食物记录', async () => {
    const { cookie } = await register('升级前养鱼人')
    const fish = await release(cookie, '旧库鱼')
    const legacy = await drop(cookie)
    await JSONresponse(await claim(cookie, legacy.pelletId, fish.id))
    service.db.exec('DROP INDEX pellet_drop_date; ALTER TABLE pellets DROP COLUMN dropped_date')
    expect(service.db.prepare('PRAGMA table_info(pellets)').all().some(column => column.name === 'dropped_date')).toBe(false)
    service.db.close()
    service = openTestApp()

    expect(service.db.prepare('PRAGMA table_info(pellets)').all().some(column => column.name === 'dropped_date')).toBe(true)
    expect(service.db.prepare('PRAGMA index_list(pellets)').all().some(index => index.name === 'pellet_drop_date')).toBe(true)
    expect(service.db.prepare('SELECT dropped_date, consumed_date FROM pellets WHERE id = ?').get(legacy.pelletId))
      .toMatchObject({ dropped_date: null, consumed_date: '2026-03-04' })
    expect(await JSONresponse(await request('/keeper/me', { cookie }))).toMatchObject({ remainingRations: 19 })
    const modern = await drop(cookie)
    expect(modern.remainingRations).toBe(18)
    expect(service.db.prepare('SELECT dropped_date FROM pellets WHERE id = ?').get(modern.pelletId))
      .toMatchObject({ dropped_date: '2026-03-04' })
  })

  it('旧 keeper 表迁移后从满罐开始，保留身份、鱼和已结算记录', async () => {
    const { cookie, keeper } = await register('旧罐养鱼人')
    const fish = await release(cookie, '旧罐鱼')
    const pellet = await drop(cookie)
    await JSONresponse(await claim(cookie, pellet.pelletId, fish.id))
    service.db.exec('ALTER TABLE keepers DROP COLUMN rations; ALTER TABLE keepers DROP COLUMN ration_progress_ms')
    service.db.close()
    service = openTestApp()
    expect(await JSONresponse<KeeperResponse>(await request('/keeper/me', { cookie }))).toMatchObject({
      keeper, remainingRations: MAX_RATIONS, nextRationInSec: 0, activeFish: [{ id: fish.id, experience: 1 }],
    })
    expect(service.db.prepare('SELECT status, winner_fish_id FROM pellets WHERE id = ?').get(pellet.pelletId))
      .toEqual({ status: 'consumed', winner_fish_id: fish.id })
    await drop(cookie)
    service.db.close()
    service = openTestApp()
    expect(await jar(cookie)).toEqual({ remainingRations: 19, nextRationInSec: 60 })
  })

  it('一人养一条鱼，当天升鱼王，次日升到满级鱼皇', async () => {
    time = Date.parse('2026-03-04T01:00:00Z')
    const { cookie } = await register('养鱼人')
    const fish = await release(cookie, '浪潮')
    const feed = async () => {
      time += 120_000
      const pellet = await drop(cookie)
      return JSONresponse<Claim>(await claim(cookie, pellet.pelletId, fish.id))
    }
    for (let i = 1; i <= 15; i++) expect((await feed()).fish.experience).toBe(i)
    const feast = (await view()).goldenFeast!
    expect(await JSONresponse<GoldenFeastClaim>(await claimFeast(feast.id, fish.id, cookie))).toMatchObject({
      xpGained: 3, fish: { experience: 18, level: 13, stage: 'leviathan' },
    })
    for (let xp = 19; xp <= 23; xp++) expect((await feed()).fish.experience).toBe(xp)
    expect(await JSONresponse(await request('/keeper/me', { cookie }))).toMatchObject({ remainingRations: 0 })
    time = Date.parse('2026-03-05T01:00:00Z')
    expect(await jar(cookie)).toEqual({ remainingRations: 0, nextRationInSec: 60 })
    const stream = await openEvents(cookie)
    time += MAX_RATIONS * RATION_REGEN_INTERVAL_MS
    await stream.close()
    for (let xp = 24; xp <= 32; xp++) expect((await feed()).fish.experience).toBe(xp)
    expect(await feed()).toMatchObject({
      remainingRations: 10, fish: { experience: 33, level: 18, stage: 'emperor', size: 275, unspentPoints: 17 },
    })
    expect(await feed()).toMatchObject({ outcome: 'fed', fish: { experience: 33, dailyEatsCount: 11 } })
  })

  it('鱼吃满后两次硬塞进入休眠，到期前禁食，到期清空后可进食', async () => {
    const { cookie } = await register('海一')
    const fish = await release(cookie, '浪潮')
    await release(cookie, '另一条能吃的鱼')
    service.db.prepare('UPDATE fish SET experience = 6, belly_load = 8, belly_updated_at = ? WHERE id = ?').run(time, fish.id)
    const eat = async () => JSONresponse<Claim>(await claim(cookie, (await drop(cookie)).pelletId, fish.id))
    expect(await eat()).toMatchObject({
      outcome: 'grew', fish: { experience: 7, bellyCapacity: 9, bellyUsed: 9, bellyOverload: 0, dailyEatsCount: 1 },
    })
    expect(await eat()).toMatchObject({
      outcome: 'stuffed', fish: { experience: 7, rawBellyLoad: 10, bellyUsed: 9, bellyOverload: 1, dailyEatsCount: 2 },
    })
    expect(await eat()).toMatchObject({
      outcome: 'stuffed_full', fish: { experience: 7, rawBellyLoad: 11, bellyOverload: 2,
        isStuffedFull: true, bellyUpdatedAt: time, dailyEatsCount: 3 },
    })
    const pellet = await drop(cookie)
    expect((await claim(cookie, pellet.pelletId, fish.id)).status).toBe(409)
    time += getStuffedComaMs(7) - 1
    expect((await JSONresponse<{ fish: Fish }>(await request(`/fish/${fish.id}`))).fish).toMatchObject({
      dailyEatsCount: 0, bellyOverload: 2, digestionRemainingSec: 1,
    })
    const nearRecovery = await drop(cookie)
    expect((await claim(cookie, nearRecovery.pelletId, fish.id)).status).toBe(409)
    time++
    expect(await JSONresponse<Claim>(await claim(cookie, nearRecovery.pelletId, fish.id))).toMatchObject({
      outcome: 'leveled_up', fish: { experience: 8, dailyEatsCount: 1, rawBellyLoad: 1, bellyOverload: 0,
        rawStuffedFull: false, bellyUpdatedAt: time },
    })
  })

  it('投喂 IP 频控拦截仍有每日配额的高频请求', async () => {
    service.db.close()
    service = openTestApp(8)
    const { cookie } = await register('海浪')
    await release(cookie, '浪花')
    for (let i = 0; i < 8; i++) {
      const pellet = await drop(cookie, 'same-drop-ip')
      expect((await request(`/pellets/${pellet.pelletId}/cancel`, { cookie, method: 'POST' })).status).toBe(200)
    }
    expect((await request('/pellets/drop', { cookie, body: { x: 0, y: 0 }, ip: 'same-drop-ip' })).status).toBe(429)
    time += 60_000
    expect((await drop(cookie, 'same-drop-ip')).remainingRations).toBe(11)
  })

  it('只有本人可分配六维共 17 点，胃口提速保留消化进度，洗点缩胃安全钳制', async () => {
    const { cookie } = await register('点数一')
    const { cookie: other } = await register('点数二')
    const fish = await release(cookie, '逆流')
    const endpoint = `/fish/${fish.id}/stats`
    expect((await request(endpoint, { cookie: other, body: { agility: 1 } })).status).toBe(403)
    expect((await request(endpoint, { cookie, body: { agility: 1 } })).status).toBe(400)
    service.db.prepare('UPDATE fish SET experience = 33, belly_load = 8, belly_updated_at = ? WHERE id = ?')
      .run(time - 18_000 - 17_500, fish.id)
    expect((await request(endpoint, { cookie, body: { stamina: 6, brawn: 6, appetite: 6 } })).status).toBe(400)
    expect((await request(endpoint, { cookie, body: { appetite: 7 } })).status).toBe(400)
    expect((await request(endpoint, { cookie, body: { appetite: -1 } })).status).toBe(400)
    const stats = { burst: 1, stamina: 2, sense: 1, agility: 1, brawn: 6, appetite: 6 }
    expect(await JSONresponse(await request(endpoint, { cookie, body: stats }))).toMatchObject({
      fish: { unspentPoints: 0, stats, bellyCapacity: 50, rawBellyLoad: 7, bellyUsed: 7,
        bellyUpdatedAt: time - 8999, digestIntervalSec: 9, digestionRemainingSec: 1 },
    })
    time++
    expect(await JSONresponse(await request(`/fish/${fish.id}`))).toMatchObject({
      fish: { rawBellyLoad: 7, bellyUsed: 6, digestionRemainingSec: 9 },
    })
    service.db.prepare('UPDATE fish SET belly_load = 49, belly_updated_at = ? WHERE id = ?').run(time - 2000, fish.id)
    expect((await request(endpoint + '/reset', { cookie: other, method: 'POST' })).status).toBe(403)
    expect(await JSONresponse(await request(endpoint + '/reset', { cookie, method: 'POST' })))
      .toMatchObject({ fish: { unspentPoints: 17, lastRespecDate: '2026-03-04',
        stats: { burst: 0, stamina: 0, sense: 0, agility: 0, brawn: 0, appetite: 0 },
        bellyCapacity: 38, rawBellyLoad: 39, bellyUsed: 38, bellyOverload: 1, isStuffedFull: false,
        bellyUpdatedAt: time - 2000, digestIntervalSec: 18, digestionRemainingSec: 16 } })
    expect((await request(endpoint + '/reset', { cookie, method: 'POST' })).status).toBe(409)
    time += 120_000
    expect((await request(endpoint + '/reset', { cookie, method: 'POST' })).status).toBe(200)
  })

  it('休眠时洗点保留原时间，已经到期时洗点清除旧休眠标志', async () => {
    const { cookie } = await register('休眠鱼主人')
    const sleeping = await release(cookie, '睡鱼')
    const awake = await release(cookie, '醒鱼')
    const prep = service.db.prepare(`UPDATE fish SET experience = 33, appetite = 6,
      belly_full = 1, belly_load = 52, belly_updated_at = ? WHERE id = ?`)
    prep.run(time - 1000, sleeping.id)
    prep.run(time - 36_000, awake.id)
    const reset = (id: string) => request(`/fish/${id}/stats/reset`, { cookie, method: 'POST' })
      .then(response => JSONresponse<{ fish: Fish }>(response))
    expect((await reset(sleeping.id)).fish).toMatchObject({
      rawStuffedFull: true, isStuffedFull: true, rawBellyLoad: 52, bellyUpdatedAt: time - 1000, digestionRemainingSec: 69,
    })
    expect((await reset(awake.id)).fish).toMatchObject({
      rawStuffedFull: false, isStuffedFull: false, rawBellyLoad: 0, bellyUpdatedAt: time, digestionRemainingSec: 0,
    })
  })

  it('同人重复举报无效，三人后隐藏；管理员通过请求头操作', async () => {
    const owner = await register('养鱼人')
    const reporters = await Promise.all([register('甲', 'a'), register('乙', 'b'), register('丙', 'c')])
    const fish = await release(owner.cookie, '隐居')
    const report = (cookie: string) => request(`/fish/${fish.id}/report`, { cookie, method: 'POST' })
    expect((await request(`/fish/${fish.id}/report`, { method: 'POST' })).status).toBe(401)
    expect(await JSONresponse(await report(reporters[0].cookie))).toEqual({ hidden: false })
    expect((await report(reporters[0].cookie)).status).toBe(409)
    expect(await JSONresponse(await report(reporters[1].cookie))).toEqual({ hidden: false })
    expect(await JSONresponse(await report(reporters[2].cookie))).toEqual({ hidden: true })
    expect((await view(`?focusFishId=${fish.id}`, owner.cookie)).fish.some(item => item.id === fish.id)).toBe(false)
    expect((await request(`/fish/${fish.id}`)).status).toBe(404)
    expect((await request(fish.assetUrl.slice(4))).status).toBe(404)
    const adminFish = await release(owner.cookie, '待管理员处理')
    const admin = (secret?: string) => request(`/admin/fish/${adminFish.id}`, { method: 'DELETE', secret })
    expect((await admin()).status).toBe(403)
    expect((await admin('wrong')).status).toBe(403)
    expect(await JSONresponse(await admin('test-only-secret'))).toEqual({ hidden: true })
    expect((await view(`?focusFishId=${adminFish.id}`)).fish.some(item => item.id === adminFish.id)).toBe(false)
  })

  it('SSE 连接推送下水、更新、进食、归档和隐藏事件', async () => {
    const { cookie } = await register('观测者')
    const { event, close } = await openEvents()

    try {
      const fish = await release(cookie, '光谱')
      expect(await event('fish_released')).toMatchObject({ fish: { id: fish.id } })
      const pellet = await drop(cookie)
      await JSONresponse(await claim(cookie, pellet.pelletId, fish.id))
      expect(await event('pellet_consumed')).toMatchObject({ pelletId: pellet.pelletId, outcome: 'leveled_up', fish: { id: fish.id } })
      await JSONresponse(await request(`/fish/${fish.id}/stats`, { cookie, body: { burst: 1 } }))
      expect(await event('fish_updated')).toMatchObject({ fish: { id: fish.id, stats: { burst: 1 } } })
      service.db.prepare('UPDATE fish SET experience = 33, belly_load = 39, belly_updated_at = ? WHERE id = ?')
        .run(time, fish.id)
      const lastMeal = await drop(cookie)
      await JSONresponse(await claim(cookie, lastMeal.pelletId, fish.id))
      expect(await event('tank_ticker')).toMatchObject({ kind: 'stuffed', fishId: fish.id })
      await JSONresponse(await request(`/fish/${fish.id}/archive`, { method: 'POST', cookie }))
      expect(await event('fish_archived')).toEqual({ fishId: fish.id })
      const adminFish = await release(cookie, '待隐藏')
      await JSONresponse(await request(`/admin/fish/${adminFish.id}`, { method: 'DELETE', secret: 'test-only-secret' }))
      expect(await event('fish_hidden')).toEqual({ fishId: adminFish.id })
      const goldenFish = await release(cookie, '来吃金鱼食')
      const victim = await release(cookie, '被撞晕的小鱼')
      await JSONresponse(await request('/tank/knockout', { cookie, body: { attackerFishId: goldenFish.id, victimFishId: victim.id } }))
      expect(await event('tank_ticker')).toMatchObject({ kind: 'knockout', fishId: goldenFish.id, createdAt: time })
      const { goldenFeast } = await JSONresponse<{ goldenFeast: GoldenFeast }>(await manualFeast('test-only-secret'), 201)
      expect(await event('golden_feast_spawned')).toEqual({ goldenFeast })
      await JSONresponse(await claimFeast(goldenFeast.id, goldenFish.id, cookie))
      expect(await event('golden_feast_consumed')).toMatchObject({ feastId: goldenFeast.id, xpGained: 3, fish: { id: goldenFish.id } })
      expect(await event('tank_ticker')).toMatchObject({
        kind: 'golden_feast', text: `👑 ${goldenFish.name} 抢走了天降黄金大餐！`, fishId: goldenFish.id, createdAt: time,
      })
      service.db.prepare('UPDATE fish SET experience = 6, belly_load = 9, belly_updated_at = ? WHERE id = ?')
        .run(time, goldenFish.id)
      const { goldenFeast: oversized } = await JSONresponse<{ goldenFeast: GoldenFeast }>(await manualFeast('test-only-secret'), 201)
      expect(await event('golden_feast_spawned')).toEqual({ goldenFeast: oversized })
      const eaten = await JSONresponse<GoldenFeastClaim>(await claimFeast(oversized.id, goldenFish.id, cookie))
      expect(eaten).toMatchObject({ feastId: oversized.id, outcome: 'stuffed_full', xpGained: 3, levelDelta: 1,
        fish: { id: goldenFish.id, experience: 9, bellyCapacity: 11, rawBellyLoad: 13, isStuffedFull: true } })
      expect(await event('golden_feast_consumed')).toEqual(eaten)
      expect(await event('tank_ticker')).toMatchObject({
        kind: 'golden_feast', text: `👑 ${goldenFish.name} 一口吞下黄金大餐，直接撑翻了！`, fishId: goldenFish.id, createdAt: time,
      })
    } finally {
      await close()
    }
  })
})

describe('协作鱼缸', () => {
  const createTank = (cookie: string, name: string) =>
    request('/tanks', { cookie, body: { name } }).then(response => JSONresponse<{ tank: TankSummary }>(response, 201))
      .then(result => result.tank)
  const joinTank = (cookie: string, inviteCode: string) => request('/tanks/join', { cookie, body: { inviteCode } })
    .then(response => JSONresponse<{ tank: TankSummary }>(response)).then(result => result.tank)
  const tankQuery = (tank: TankSummary) => '?tankId=' + tank.id
  const inviteQuery = (tank: TankSummary) => '?inviteCode=' + tank.inviteCode
  const tanks = (cookie?: string) => request('/tanks', { cookie })
    .then(response => JSONresponse<{ publicTank: TankSummary; ownedTanks: TankSummary[]; joinedTanks: TankSummary[] }>(response))

  it('自建缸限两个，邀请允许匿名围观并为登录的协作者保存成员身份', async () => {
    const owner = await register('房主')
    const guest = await register('受邀访客')
    const stranger = await register('路人')
    expect((await request('/tanks', { body: { name: '匿名缸' } })).status).toBe(401)
    expect((await request('/tanks', { cookie: owner.cookie, body: { name: '🐠'.repeat(17) } })).status).toBe(400)
    const livingRoom = await createTank(owner.cookie, ' 客厅缸 ')
    const study = await createTank(owner.cookie, '书房缸')
    expect(livingRoom).toMatchObject({
      name: '客厅缸', isOwner: true, ownerId: owner.keeper.id, ownerNickname: owner.keeper.nickname,
      fishCount: 0, maxFish: 20, myFishCount: 0, myFishLimit: 10, createdAt: time,
    })
    expect(livingRoom.inviteCode).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ2-9]{8}$/)
    expect(study.inviteCode).not.toBe(livingRoom.inviteCode)
    expect((await request('/tanks', { cookie: owner.cookie, body: { name: '第三个缸' } })).status).toBe(409)
    expect((await tanks(owner.cookie)).ownedTanks.map(tank => tank.id)).toEqual(expect.arrayContaining([livingRoom.id, study.id]))
    expect(await tanks()).toMatchObject({ publicTank: { id: PUBLIC_TANK_ID }, ownedTanks: [], joinedTanks: [] })
    expect((await request('/tank/view' + tankQuery(livingRoom))).status).toBe(403)
    expect((await request('/events' + tankQuery(livingRoom), { cookie: stranger.cookie })).status).toBe(403)
    expect((await request('/tanks/join', { cookie: stranger.cookie, body: { inviteCode: livingRoom.id } })).status).toBe(404)
    expect((await request('/tank/view' + tankQuery(livingRoom) + '&inviteCode=' + study.inviteCode)).ok).toBe(false)
    expect((await view(inviteQuery(livingRoom))).tank).toMatchObject({ id: livingRoom.id, isOwner: false, myFishLimit: 3 })
    expect((await view(inviteQuery(livingRoom), guest.cookie)).tank.id).toBe(livingRoom.id)
    expect((await view(tankQuery(livingRoom), guest.cookie)).tank.id).toBe(livingRoom.id)
    const link = 'https://fish.example/?tank=' + livingRoom.inviteCode!.toLowerCase()
    expect(await joinTank(guest.cookie, link)).toMatchObject({ id: livingRoom.id, isOwner: false })
    expect((await tanks(guest.cookie)).joinedTanks.map(tank => tank.id)).toEqual([livingRoom.id])
    expect((await tanks(stranger.cookie)).joinedTanks).toEqual([])
  })

  it('每缸放生额度独立，支持十条主人鱼、三条协作者鱼及全缸二十条', async () => {
    const owner = await register('房主')
    const tank = await createTank(owner.cookie, '二十条缸')
    const scope = { tankId: tank.id }
    const tryRelease = (cookie: string, body: object = scope) =>
      request('/fish', { cookie, body: { name: '候补鱼', pngBase64: png(), ...body } })
    const publicFish = await Promise.all([release(owner.cookie, '海鱼一'), release(owner.cookie, '海鱼二'), release(owner.cookie, '海鱼三')])
    expect((await tryRelease(owner.cookie, {})).status).toBe(409)
    const ownerFish = await Promise.all(Array.from({ length: 10 }, (_, index) => release(owner.cookie, `主人鱼 ${index}`, scope)))
    expect((await tryRelease(owner.cookie)).status).toBe(409)
    expect((await request(`/fish/${publicFish[0].id}/move`, { cookie: owner.cookie, body: { targetTankId: tank.id } })).status).toBe(409)

    for (let index = 0; index < 3; index++) {
      const guest = await register('朋友 ' + index, 'guest-' + index)
      const migrant = await release(guest.cookie, '搬去朋友家的鱼')
      expect(await JSONresponse(await request(`/fish/${migrant.id}/move`, {
        cookie: guest.cookie, body: { inviteCode: tank.inviteCode },
      }))).toMatchObject({ fish: { id: migrant.id, tankId: tank.id } })
      await Promise.all(Array.from({ length: 2 }, (_, number) => release(guest.cookie, `朋友鱼 ${number}`, { inviteCode: tank.inviteCode })))
      expect((await tryRelease(guest.cookie)).status).toBe(409)
    }
    const lateGuest = await register('第四位朋友', 'guest-4')
    await joinTank(lateGuest.cookie, tank.inviteCode!)
    const results = await Promise.all([tryRelease(lateGuest.cookie), tryRelease(lateGuest.cookie)])
    expect(results.map(response => response.status).sort()).toEqual([201, 409])
    expect(await JSONresponse(results.find(response => !response.ok)!, 409)).toMatchObject({
      error: '这个自建鱼缸已经游满 20 条鱼啦',
    })
    const another = await release(lateGuest.cookie, '等候搬家的鱼')
    expect(await JSONresponse(await request(`/fish/${another.id}/move`, {
      cookie: lateGuest.cookie, body: { targetTankId: tank.id },
    }), 409)).toMatchObject({ error: '这个自建鱼缸已经游满 20 条鱼啦' })
    const custom = await view(inviteQuery(tank) + '&excludeIds=' + ownerFish[0].id, owner.cookie)
    expect(custom.fish).toHaveLength(20)
    expect(custom.fish.map(fish => fish.id)).toContain(ownerFish[0].id)
    expect(custom.tank).toMatchObject({ fishCount: 20, myFishCount: 10, myFishLimit: 10 })
    expect((await view()).fish.map(fish => fish.id).sort()).toEqual([...publicFish, another].map(fish => fish.id).sort())
    expect(readdirSync(join(temp, 'data', 'fish'))).toHaveLength(24)
  })

  it('按缸隔离鱼图、详情、搜索、榜单和互动，鱼食罐跨缸共享', async () => {
    const owner = await register('房主')
    const guest = await register('访客')
    const stranger = await register('路人')
    const tank = await createTank(owner.cookie, '私家鱼缸')
    const publicFish = await release(owner.cookie, '公共游鱼')
    expect((await request('/pellets/drop', {
      cookie: owner.cookie, body: { tankId: tank.id, x: 0.4, y: 0.4 },
    })).status).toBe(409)
    expect(await jar(owner.cookie)).toMatchObject({ remainingRations: 20 })
    const first = await release(owner.cookie, '私家秘密鱼一', { tankId: tank.id })
    const second = await release(owner.cookie, '私家秘密鱼二', { tankId: tank.id })
    expect(first).toMatchObject({ tankId: tank.id, tankName: tank.name, assetUrl: `/api/assets/fish/${first.id}.png?invite=${tank.inviteCode}` })
    const profile = '/fish/' + first.id
    const artwork = '/assets/fish/' + first.id + '.png'
    for (const path of [profile, artwork]) {
      expect((await request(path, { cookie: stranger.cookie })).ok).toBe(false)
      expect((await request(path + '?invite=00000000')).ok).toBe(false)
      expect((await request(path + inviteQuery(tank))).status).toBe(200)
    }
    const pngResponse = await request(artwork + '?invite=' + tank.inviteCode)
    expect(pngResponse.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await pngResponse.arrayBuffer()).toString('base64')).toBe(png())
    expect((await request(artwork, { cookie: owner.cookie })).status).toBe(200)
    expect((await view('?focusFishId=' + first.id)).fish.map(fish => fish.id)).toEqual([publicFish.id])
    const search = '/fish/search?q=' + encodeURIComponent('秘密鱼')
    expect(await JSONresponse(await request(search))).toEqual({ fish: [] })
    expect(await JSONresponse(await request(search + '&tankId=' + tank.id), 403)).toMatchObject({ error: expect.any(String) })
    expect(await JSONresponse(await request(search + '&inviteCode=' + tank.inviteCode))).toMatchObject({
      fish: expect.arrayContaining([{ ...first }, { ...second }]),
    })
    const publicBoards = await JSONresponse<Leaderboard>(await request('/tank/leaderboard'))
    const privateBoards = await JSONresponse<Leaderboard>(await request('/tank/leaderboard' + inviteQuery(tank)))
    for (const name of ['gluttons', 'bullies', 'giants'] as const) {
      expect(publicBoards[name].map(fish => fish.id)).toEqual([publicFish.id])
      expect(privateBoards[name].map(fish => fish.id).sort()).toEqual([first.id, second.id].sort())
    }

    const knock = (cookie: string, victimFishId: string) =>
      request('/tank/knockout', { cookie, body: { attackerFishId: first.id, victimFishId } })
    expect((await knock(stranger.cookie, second.id)).status).toBe(403)
    expect((await knock(owner.cookie, publicFish.id)).status).toBe(409)
    expect((await request(profile + '/report', { cookie: stranger.cookie, method: 'POST' })).ok).toBe(false)
    expect((await request('/pellets/drop', { cookie: stranger.cookie, body: { tankId: tank.id, x: 0.4, y: 0.4 } })).status).toBe(403)
    expect(await jar(stranger.cookie)).toMatchObject({ remainingRations: 20 })
    const privatePellet = await drop(guest.cookie, undefined, { inviteCode: tank.inviteCode })
    expect(privatePellet.remainingRations).toBe(19)
    expect((await request(artwork, { cookie: guest.cookie })).status).toBe(200)
    expect((await knock(guest.cookie, second.id)).status).toBe(200)
    expect((await claim(guest.cookie, privatePellet.pelletId, publicFish.id)).status).toBe(409)
    expect(await JSONresponse(await claim(guest.cookie, privatePellet.pelletId, first.id))).toMatchObject({ fish: { id: first.id } })
    const publicPellet = await drop(guest.cookie)
    expect(publicPellet.remainingRations).toBe(18)
    expect((await claim(guest.cookie, publicPellet.pelletId, first.id)).status).toBe(409)
    expect(await JSONresponse(await claim(guest.cookie, publicPellet.pelletId, publicFish.id))).toMatchObject({ fish: { id: publicFish.id } })
  })

  it('搬家验证归属与目标容量，双方 SSE 仅收到各自鱼缸的事件', async () => {
    const owner = await register('搬家人')
    const other = await register('旁观者')
    const tank = await createTank(owner.cookie, '新家')
    const publicStream = await openEvents()
    const customStream = await openEvents(undefined, inviteQuery(tank))
    try {
      const resident = await release(owner.cookie, '在家', { tankId: tank.id })
      expect(await customStream.next()).toMatchObject({ name: 'fish_released', data: { fish: { id: resident.id } } })
      const moving = await release(owner.cookie, '准备搬家')
      expect(await publicStream.next()).toMatchObject({ name: 'fish_released', data: { fish: { id: moving.id } } })
      const move = (cookie: string, targetTankId: string) =>
        request(`/fish/${moving.id}/move`, { cookie, body: { targetTankId } })
      const pendingPublicPellet = await drop(owner.cookie)
      expect((await move(other.cookie, tank.id)).status).toBe(403)
      expect(await JSONresponse(await move(owner.cookie, tank.id))).toMatchObject({ fish: { id: moving.id, tankId: tank.id } })
      expect((await claim(owner.cookie, pendingPublicPellet.pelletId, moving.id)).status).toBe(409)
      expect(await publicStream.next()).toEqual({ name: 'fish_left', data: { fishId: moving.id } })
      expect(await customStream.next()).toMatchObject({ name: 'fish_released', data: { fish: { id: moving.id } } })
      expect(await JSONresponse(await move(owner.cookie, tank.id))).toMatchObject({ fish: { id: moving.id, tankId: tank.id } })
      const replacements: Fish[] = []
      for (let index = 0; index < 3; index++) {
        const replacement = await release(owner.cookie, '公共鱼 ' + index)
        replacements.push(replacement)
        expect(await publicStream.next()).toMatchObject({ name: 'fish_released', data: { fish: { id: replacement.id } } })
      }
      expect((await move(owner.cookie, PUBLIC_TANK_ID)).status).toBe(409)
      await JSONresponse(await request(`/fish/${replacements[0].id}/archive`, { cookie: owner.cookie, method: 'POST' }))
      expect(await publicStream.next()).toEqual({ name: 'fish_archived', data: { fishId: replacements[0].id } })
      expect(await JSONresponse(await move(owner.cookie, PUBLIC_TANK_ID))).toMatchObject({ fish: { id: moving.id, tankId: PUBLIC_TANK_ID } })
      expect(await customStream.next()).toEqual({ name: 'fish_left', data: { fishId: moving.id } })
      expect(await publicStream.next()).toMatchObject({ name: 'fish_released', data: { fish: { id: moving.id } } })
      expect((await view(inviteQuery(tank))).fish.map(fish => fish.id)).toEqual([resident.id])
      expect((await request(`/fish/${replacements[0].id}/move`, { cookie: owner.cookie, body: { targetTankId: tank.id } })).status).toBe(409)
    } finally {
      await Promise.all([publicStream.close(), customStream.close()])
    }
  })

  it('黄金大餐及普通喂食计数按鱼缸独立，跨缸标签页只积累一份在线鱼食', async () => {
    const owner = await register('房东')
    const stranger = await register('局外人')
    const tank = await createTank(owner.cookie, '金鱼缸')
    const scope = { tankId: tank.id }
    const publicFish = await release(owner.cookie, '海鲷')
    const privateFish = await release(owner.cookie, '金鳞', scope)
    service.db.prepare('UPDATE fish SET experience = 55 WHERE id = ?').run(privateFish.id)
    expect((await manualFeast('test-only-secret', 'missing-tank')).status).toBe(404)
    const { goldenFeast: publicMeal } = await JSONresponse<{ goldenFeast: GoldenFeast }>(await manualFeast('test-only-secret'), 201)
    for (let index = 0; index < 15; index++) {
      const pellet = await drop(owner.cookie, undefined, scope)
      await JSONresponse(await claim(owner.cookie, pellet.pelletId, privateFish.id))
      if (index < 14) expect((await view(inviteQuery(tank))).goldenFeast).toBeNull()
      time += 2_000
    }
    const customMeal = (await view(inviteQuery(tank))).goldenFeast!
    expect(customMeal.id).not.toBe(publicMeal.id)
    expect((await view()).goldenFeast).toEqual(publicMeal)
    expect((await claimFeast(customMeal.id, privateFish.id, stranger.cookie)).status).toBe(403)
    expect((await claimFeast(customMeal.id, publicFish.id, owner.cookie)).status).toBe(409)
    expect((await claimFeast(publicMeal.id, privateFish.id, owner.cookie)).status).toBe(409)
    expect(await JSONresponse(await claimFeast(customMeal.id, privateFish.id, owner.cookie))).toMatchObject({ fish: { id: privateFish.id } })
    expect((await view(inviteQuery(tank))).goldenFeast).toBeNull()
    expect((await view()).goldenFeast?.id).toBe(publicMeal.id)
    expect(service.db.prepare('SELECT value FROM tank_state WHERE key = ?').get('normal_feeds_total')).toEqual({ value: 0 })
    expect(service.db.prepare('SELECT value FROM tank_state WHERE key = ?').get('normal_feeds_total:' + tank.id)).toEqual({ value: 15 })
    const publicStream = await openEvents(owner.cookie)
    const customStream = await openEvents(owner.cookie, tankQuery(tank))
    try {
      time += RATION_REGEN_INTERVAL_MS
      expect(await jar(owner.cookie)).toEqual({ remainingRations: 6, nextRationInSec: 60 })
      await publicStream.close()
      time += RATION_REGEN_INTERVAL_MS
      expect(await jar(owner.cookie)).toEqual({ remainingRations: 7, nextRationInSec: 60 })
      expect(await customStream.event('rations_updated')).toMatchObject({ remainingRations: 6 })
    } finally {
      await publicStream.close()
      await customStream.close()
    }
  })

  it('改名、轮换邀请、请出、离开及删除保留鱼和画作，结算状态安全过期', async () => {
    const owner = await register('邀请者')
    const guest = await register('协作者')
    const tank = await createTank(owner.cookie, '深水缸')
    await joinTank(guest.cookie, tank.inviteCode!)
    const tankPath = '/tanks/' + tank.id
    const stream = await openEvents(guest.cookie, tankQuery(tank))
    const invitedObserver = await openEvents(undefined, inviteQuery(tank))
    let rotated: TankSummary
    try {
      expect((await request(tankPath, { cookie: guest.cookie, method: 'PATCH', body: { name: '篡改' } })).status).toBe(403)
      expect((await request(tankPath + '/rotate-invite', { cookie: guest.cookie, method: 'POST' })).status).toBe(403)
      expect((await request(tankPath, { cookie: guest.cookie, method: 'DELETE' })).status).toBe(403)
      expect(await JSONresponse(await request(tankPath, { cookie: owner.cookie, method: 'PATCH', body: { name: '珊瑚缸' } })))
        .toMatchObject({ tank: { id: tank.id, name: '珊瑚缸' } })
      expect(await stream.event('tank_updated')).toMatchObject({ tank: { id: tank.id, name: '珊瑚缸', isOwner: false } })
      expect(await invitedObserver.event('tank_updated')).toMatchObject({ tank: { id: tank.id, name: '珊瑚缸' } })
      const rotation = await JSONresponse<{ tank: TankSummary }>(await request(tankPath + '/rotate-invite', { cookie: owner.cookie, method: 'POST' }))
      rotated = rotation.tank
      expect(rotated.inviteCode).not.toBe(tank.inviteCode)
      await expect(invitedObserver.next()).rejects.toThrow('Unexpected end of event stream')
      expect((await request('/tank/view' + inviteQuery(tank))).status).toBe(404)
      expect((await view(inviteQuery(rotated))).tank.id).toBe(tank.id)
      expect((await view(tankQuery(tank), guest.cookie)).tank.id).toBe(tank.id)
      expect(await stream.event('tank_updated')).toMatchObject({ tank: { id: tank.id, inviteCode: rotated.inviteCode } })

      const scope = { tankId: tank.id }
      const guestFish = await release(guest.cookie, '协作者鱼', scope)
      const leave = () => request(tankPath + '/leave', { cookie: guest.cookie, method: 'POST' })
      expect((await leave()).status).toBe(409)
      expect(await JSONresponse(await request(tankPath + '/eject/' + guestFish.id, { cookie: owner.cookie, method: 'POST' })))
        .toMatchObject({ fish: { id: guestFish.id, tankId: PUBLIC_TANK_ID, status: 'archived' } })
      expect(await stream.event('fish_left')).toEqual({ fishId: guestFish.id })
      await JSONresponse(await leave())
      await expect(stream.next()).rejects.toThrow('Unexpected end of event stream')
      expect((await tanks(guest.cookie)).joinedTanks).toEqual([])
      expect((await request('/tank/view' + tankQuery(tank), { cookie: guest.cookie })).status).toBe(403)
      expect((await request('/fish/' + guestFish.id, { cookie: guest.cookie })).status).toBe(200)
    } finally {
      await Promise.all([stream.close(), invitedObserver.close()])
    }

    const live = await release(owner.cookie, '离水鱼', { tankId: tank.id })
    const archived = await release(owner.cookie, '提前归档鱼', { tankId: tank.id })
    await JSONresponse(await request(`/fish/${archived.id}/archive`, { cookie: owner.cookie, method: 'POST' }))
    const pellet = await drop(owner.cookie, undefined, { tankId: tank.id })
    const { goldenFeast } = await JSONresponse<{ goldenFeast: GoldenFeast }>(await manualFeast('test-only-secret', tank.id), 201)
    const observer = await openEvents(undefined, inviteQuery(rotated))
    try {
      expect(await JSONresponse(await request(tankPath, { cookie: owner.cookie, method: 'DELETE' })))
        .toEqual({ deleted: true, archivedCount: 1 })
      expect(await observer.event('tank_deleted')).toEqual({ tankId: tank.id })
      expect((await request('/tank/view' + inviteQuery(rotated))).status).toBe(404)
      expect((await view()).fish).toEqual([])
      expect((await tanks(owner.cookie)).ownedTanks).toEqual([])
      for (const id of [live.id, archived.id]) {
        expect(await JSONresponse(await request('/fish/' + id, { cookie: owner.cookie })))
          .toMatchObject({ fish: { id, status: 'archived', tankId: PUBLIC_TANK_ID } })
        expect((await request(`/assets/fish/${id}.png`, { cookie: owner.cookie })).status).toBe(200)
      }
      expect(service.db.prepare('SELECT status FROM pellets WHERE id = ?').get(pellet.pelletId)).toEqual({ status: 'expired' })
      expect(service.db.prepare('SELECT status FROM golden_feasts WHERE id = ?').get(goldenFeast.id)).toEqual({ status: 'expired' })
    } finally {
      await observer.close()
    }
  })

  it('旧库迁移保留公共缸鱼、画作、已消费鱼食与活跃大餐，重复启动保留独立大餐', async () => {
    const owner = await register('旧库主人')
    const fish = await release(owner.cookie, '旧库鱼')
    const pellet = await drop(owner.cookie)
    await JSONresponse(await claim(owner.cookie, pellet.pelletId, fish.id))
    const { goldenFeast: publicMeal } = await JSONresponse<{ goldenFeast: GoldenFeast }>(await manualFeast('test-only-secret'), 201)
    service.db.exec(`
      DROP TABLE tank_members;
      DROP TABLE tanks;
      DROP INDEX fish_tank_scope;
      DROP INDEX golden_feast_active_per_tank;
      ALTER TABLE fish DROP COLUMN tank_id;
      ALTER TABLE pellets DROP COLUMN tank_id;
      ALTER TABLE golden_feasts DROP COLUMN tank_id;
      CREATE UNIQUE INDEX golden_feast_active ON golden_feasts(status) WHERE status = 'active';
    `)
    service.db.close()
    service = openTestApp()
    expect((await view()).fish).toMatchObject([{ id: fish.id, tankId: PUBLIC_TANK_ID, tankName: '公共鱼缸', experience: 1 }])
    expect((await view()).goldenFeast).toEqual(publicMeal)
    expect((await request(fish.assetUrl.slice(4))).status).toBe(200)
    expect(service.db.prepare('SELECT tank_id, winner_fish_id FROM pellets WHERE id = ?').get(pellet.pelletId))
      .toMatchObject({ tank_id: PUBLIC_TANK_ID, winner_fish_id: fish.id })
    const tank = await createTank(owner.cookie, '迁移后新缸')
    const { goldenFeast: customMeal } = await JSONresponse<{ goldenFeast: GoldenFeast }>(await manualFeast('test-only-secret', tank.id), 201)
    service.db.close()
    service = openTestApp()
    expect((await view()).goldenFeast).toEqual(publicMeal)
    expect((await view(inviteQuery(tank))).goldenFeast).toEqual(customMeal)
    expect(service.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })
})
