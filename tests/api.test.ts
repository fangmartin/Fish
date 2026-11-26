import { randomBytes } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Claim, Fish, FishProfile, Keeper, KeeperResponse, Pellet } from '../shared/contracts'
import { MAX_ART_BYTES, MAX_ART_EDGE } from '../shared/domain'
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
  const { keeper } = await JSONresponse<{ keeper: Keeper }>(response, 201)
  const header = response.headers.get('set-cookie')!
  return { cookie: header.split(';')[0], header, keeper }
}

async function release(cookie: string, name: string) {
  const response = await request('/fish', { cookie, body: { name, pngBase64: png() } })
  return (await JSONresponse<{ fish: Fish }>(response, 201)).fish
}

async function drop(cookie: string, ip?: string) {
  return JSONresponse<Pellet>(await request('/pellets/drop', { cookie, body: { x: 0.38, y: 0.44 }, ip }), 201)
}

function claim(cookie: string, pelletId: string, winnerFishId: string) {
  return request(`/pellets/${pelletId}/claim`, { cookie, body: { winnerFishId } })
}

const view = (query = '', cookie?: string) =>
  request('/tank/view' + query, { cookie }).then(response => JSONresponse<{ fish: Fish[] }>(response))

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
  it('空缸不会生成鱼，重启后隐藏旧演示鱼并保留进食历史', async () => {
    expect(await view()).toEqual({ fish: [] })
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
    expect(await JSONresponse(recovered)).toMatchObject({ keeper: first.keeper, remainingRations: 10 })
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

  it('投放即扣减，结算防重复，取消或超时也计入每日 10 颗配额', async () => {
    const { cookie } = await register('投喂者')
    const { cookie: other } = await register('围观者')
    const fish = await release(cookie, '绿光')
    expect((await request('/pellets/drop', { cookie, body: { x: 1.1, y: 0 } })).status).toBe(400)
    const a = await drop(cookie)
    const b = await drop(cookie)
    const c = await drop(cookie)
    expect([a.remainingRations, b.remainingRations, c.remainingRations]).toEqual([9, 8, 7])
    expect(a).toMatchObject({ x: 0.38, y: 0.44, expiresAt: time + 90_000 })
    expect((await claim(other, b.pelletId, fish.id)).status).toBe(403)
    expect((await claim(cookie, a.pelletId, 'missing')).status).toBe(409)
    expect(await JSONresponse(await request(`/pellets/${b.pelletId}/cancel`, { method: 'POST', cookie })))
      .toEqual({ remainingRations: 7 })
    expect((await claim(cookie, b.pelletId, fish.id)).status).toBe(409)
    const submissions = await Promise.all([
      claim(cookie, a.pelletId, fish.id), claim(cookie, a.pelletId, fish.id), claim(cookie, a.pelletId, fish.id),
    ])
    expect(submissions.map(res => res.status).sort()).toEqual([200, 409, 409])
    const growth = await JSONresponse<Claim>(submissions.find(res => res.ok)!)
    expect(growth).toMatchObject({ outcome: 'leveled_up', remainingRations: 7, levelDelta: 1,
      fish: { experience: 1, level: 2, dailyFedCount: 1, unspentPoints: 1 } })
    time += 90_000
    expect(await JSONresponse(await request('/keeper/me', { cookie }))).toMatchObject({ remainingRations: 7 })
    expect((await claim(cookie, c.pelletId, fish.id)).status).toBe(409)
    expect(service.db.prepare('SELECT status FROM pellets WHERE id = ?').get(c.pelletId))
      .toMatchObject({ status: 'expired' })
    expect(await JSONresponse(await request(`/pellets/${c.pelletId}/cancel`, { method: 'POST', cookie })))
      .toEqual({ remainingRations: 7 })
    for (let index = 6; index >= 0; index--) {
      expect((await drop(cookie)).remainingRations).toBe(index)
    }
    expect(await JSONresponse(await request('/pellets/drop', { cookie, body: { x: 0, y: 0 } }), 409))
      .toMatchObject({ error: '今天的投喂配额已用完' })
    const profile = await JSONresponse<{ fish: FishProfile }>(await request(`/fish/${fish.id}`))
    expect(profile.fish.feedingHistory).toHaveLength(1)
  })

  it('23:59 投放的鱼食在上海零点结算时仍计入昨天', async () => {
    const { cookie } = await register('午夜投喂者')
    const fish = await release(cookie, '夜光')
    time = Date.parse('2026-03-04T15:59:00Z')
    const across = await drop(cookie)
    expect(across.remainingRations).toBe(9)
    time += 60_000
    expect(await JSONresponse(await request('/keeper/me', { cookie }))).toMatchObject({ remainingRations: 10 })
    expect(await JSONresponse<Claim>(await claim(cookie, across.pelletId, fish.id)))
      .toMatchObject({ outcome: 'leveled_up', fish: { dailyFedCount: 1, experience: 1 }, remainingRations: 10 })
    expect(service.db.prepare('SELECT dropped_date, consumed_date FROM pellets WHERE id = ?').get(across.pelletId))
      .toMatchObject({ dropped_date: '2026-03-04', consumed_date: '2026-03-05' })
    expect((await drop(cookie)).remainingRations).toBe(9)
    const profile = await JSONresponse<{ fish: FishProfile }>(await request(`/fish/${fish.id}`))
    expect(profile.fish.feedingHistory[0].consumedAt).toBe(time)
  })

  it('空缸和全缸鱼都撑不动时拒绝投放，鱼只在消化完成后恢复投喂', async () => {
    const { cookie } = await register('等鱼的养鱼人')
    const attempt = () => request('/pellets/drop', { cookie, body: { x: 0, y: 0 } })
    expect(await JSONresponse(await attempt(), 409)).toMatchObject({ error: '鱼缸里还没有鱼，先画一条下水吧' })
    expect(await JSONresponse(await request('/keeper/me', { cookie }))).toMatchObject({ remainingRations: 10 })
    expect(service.db.prepare('SELECT COUNT(*) AS count FROM pellets').get()).toMatchObject({ count: 0 })

    const stuffed = await release(cookie, '已经吃撑')
    const hidden = await release(cookie, '已隐藏')
    const archived = await release(cookie, '已归档')
    service.db.prepare('UPDATE fish SET stuffed_stacks = 3, stuffed_updated_at = ? WHERE id = ?').run(time, stuffed.id)
    service.db.prepare('UPDATE fish SET is_hidden = 1 WHERE id = ?').run(hidden.id)
    service.db.prepare("UPDATE fish SET status = 'archived' WHERE id = ?").run(archived.id)
    time += 3_599_999
    expect(await JSONresponse(await attempt(), 409)).toMatchObject({ error: '鱼缸里的鱼都撑不动了，稍后再喂吧' })
    expect(await JSONresponse(await request('/keeper/me', { cookie }))).toMatchObject({ remainingRations: 10 })
    expect(service.db.prepare('SELECT COUNT(*) AS count FROM pellets').get()).toMatchObject({ count: 0 })
    time++
    expect((await drop(cookie)).remainingRations).toBe(9)
  })

  it('启动迁移没有 dropped_date 的 SQLite，并按旧进食日期统计历史配额', async () => {
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
    expect(await JSONresponse(await request('/keeper/me', { cookie }))).toMatchObject({ remainingRations: 9 })
    const modern = await drop(cookie)
    expect(modern.remainingRations).toBe(8)
    expect(service.db.prepare('SELECT dropped_date FROM pellets WHERE id = ?').get(modern.pelletId))
      .toMatchObject({ dropped_date: '2026-03-04' })
  })

  it('服务端强制单鱼每日 6 颗与 3 层禁食，满 60 分钟后恢复', async () => {
    const players = await Promise.all([register('海一', 'a'), register('海二', 'b'),
      register('海三', 'c'), register('海四', 'd')])
    const starting = await release(players[0].cookie, '浪潮')
    await release(players[0].cookie, '另一条能吃的鱼')
    for (let i = 0; i < 9; i++) {
      const { cookie } = players[Math.floor(i / 3)]
      const pellet = await drop(cookie, String(Math.floor(i / 3)))
      const result = await JSONresponse<Claim>(await claim(cookie, pellet.pelletId, starting.id))
      expect(result.fish.experience).toBe(Math.min(6, i + 1))
      expect(result.fish.stuffedStacks).toBe(Math.max(0, i - 5))
    }
    const { cookie } = players[3]
    const pellet = await drop(cookie)
    expect((await claim(cookie, pellet.pelletId, starting.id)).status).toBe(409)
    time += 3_599_999
    expect((await JSONresponse<{ fish: Fish }>(await request(`/fish/${starting.id}`))).fish).toMatchObject({
      dailyFedCount: 0, stuffedStacks: 3, digestionRemainingSec: 1,
    })
    const nearRecovery = await drop(cookie)
    expect((await claim(cookie, nearRecovery.pelletId, starting.id)).status).toBe(409)
    time++
    const result = await JSONresponse<Claim>(await claim(cookie, nearRecovery.pelletId, starting.id))
    expect(result.fish).toMatchObject({ experience: 7, dailyFedCount: 1, stuffedStacks: 0 })
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
    expect((await drop(cookie, 'same-drop-ip')).remainingRations).toBe(1)
  })

  it('只有本人可分配和洗点，每日允许一次并返还点数', async () => {
    const { cookie } = await register('点数一')
    const { cookie: other } = await register('点数二')
    const fish = await release(cookie, '逆流')
    const endpoint = `/fish/${fish.id}/stats`
    expect((await request(endpoint, { cookie: other, body: { agility: 1 } })).status).toBe(403)
    expect((await request(endpoint, { cookie, body: { agility: 1 } })).status).toBe(400)
    service.db.prepare('UPDATE fish SET experience = 55 WHERE id = ?').run(fish.id)
    expect((await request(endpoint, { cookie, body: { stamina: 6, brawn: 5 } })).status).toBe(400)
    expect((await request(endpoint, { cookie, body: { brawn: 7 } })).status).toBe(400)
    expect((await request(endpoint, { cookie, body: { brawn: -1 } })).status).toBe(400)
    expect(await JSONresponse(await request(endpoint, { cookie, body: { burst: 1, stamina: 1, sense: 1, agility: 1, brawn: 6 } })))
      .toMatchObject({ fish: { unspentPoints: 0, stats: { burst: 1, stamina: 1, sense: 1, agility: 1, brawn: 6 } } })
    expect((await request(endpoint + '/reset', { cookie: other, method: 'POST' })).status).toBe(403)
    expect(await JSONresponse(await request(endpoint + '/reset', { cookie, method: 'POST' })))
      .toMatchObject({ fish: { unspentPoints: 10, lastRespecDate: '2026-03-04',
        stats: { burst: 0, stamina: 0, sense: 0, agility: 0, brawn: 0 } } })
    expect((await request(endpoint + '/reset', { cookie, method: 'POST' })).status).toBe(409)
    time += 120_000
    expect((await request(endpoint + '/reset', { cookie, method: 'POST' })).status).toBe(200)
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
    const response = await request('/events')
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffered = ''

    async function event(name: string) {
      for (;;) {
        const boundary = buffered.indexOf('\n\n')
        if (boundary < 0) {
          const chunk = await reader.read()
          if (chunk.done) throw new Error(`Event ${name} missing`)
          buffered += decoder.decode(chunk.value)
          continue
        }
        const entry = buffered.slice(0, boundary)
        buffered = buffered.slice(boundary + 2)
        if (entry.includes(`event: ${name}\n`)) return JSON.parse(entry.match(/^data: (.*)$/m)![1]) as object
      }
    }

    try {
      await event('ready')
      const fish = await release(cookie, '光谱')
      expect(await event('fish_released')).toMatchObject({ fish: { id: fish.id } })
      const pellet = await drop(cookie)
      await JSONresponse(await claim(cookie, pellet.pelletId, fish.id))
      expect(await event('pellet_consumed')).toMatchObject({ pelletId: pellet.pelletId, outcome: 'leveled_up', fish: { id: fish.id } })
      await JSONresponse(await request(`/fish/${fish.id}/stats`, { cookie, body: { burst: 1 } }))
      expect(await event('fish_updated')).toMatchObject({ fish: { id: fish.id, stats: { burst: 1 } } })
      await JSONresponse(await request(`/fish/${fish.id}/archive`, { method: 'POST', cookie }))
      expect(await event('fish_archived')).toEqual({ fishId: fish.id })
      const adminFish = await release(cookie, '待隐藏')
      await JSONresponse(await request(`/admin/fish/${adminFish.id}`, { method: 'DELETE', secret: 'test-only-secret' }))
      expect(await event('fish_hidden')).toEqual({ fishId: adminFish.id })
    } finally {
      await reader.cancel()
    }
  })
})
