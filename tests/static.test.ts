import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { attachStaticRoutes } from '../server/static'

describe('production static hosting', () => {
  const app = new Hono()
  const html = '<!doctype html><title>潮汐鱼缸</title>'
  let distDir: string

  beforeAll(async () => {
    distDir = await mkdtemp(join(tmpdir(), 'fish-static-'))
    await mkdir(join(distDir, 'assets', 'directory.js'), { recursive: true })
    await Promise.all([
      writeFile(join(distDir, 'index.html'), html),
      writeFile(join(distDir, 'assets', 'app-123.js'), 'export {}'),
      writeFile(join(distDir, 'assets', 'directory.js', 'index.html'), 'directory html'),
      writeFile(join(distDir, 'robots.txt'), 'User-agent: *'),
    ])
    app.get('/api/ready', c => c.json({ ready: true }))
    attachStaticRoutes(app, distDir)
  })

  afterAll(async () => { await rm(distDir, { recursive: true, force: true }) })

  it.each(['/', '/tank/demo', '/tank.preview/demo?fish=42'])('serves fresh entry HTML from %s', async path => {
    const response = await app.request(path)
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toMatch(/^text\/html/)
    expect(response.headers.get('Cache-Control')).toBe('no-store, no-cache, must-revalidate')
    expect(response.headers.get('Pragma')).toBe('no-cache')
    expect(response.headers.get('Expires')).toBe('0')
    expect(await response.text()).toBe(html)
  })

  it('caches hashed assets immutably and keeps byte ranges', async () => {
    const response = await app.request('/assets/app-123.js?v=1')
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toMatch(/javascript/)
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable')
    expect(await response.text()).toBe('export {}')

    const range = await app.request('/assets/app-123.js', { headers: { Range: 'bytes=1-3' } })
    expect(range.status).toBe(206)
    expect(await range.text()).toBe('xpo')
  })

  it('serves other files with revalidation, including HEAD', async () => {
    const response = await app.request('/robots.txt')
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-cache')
    expect(await response.text()).toBe('User-agent: *')

    const head = await app.request('/robots.txt', { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('Cache-Control')).toBe('no-cache')
    expect(await head.text()).toBe('')
  })

  it.each(['/assets/deleted-old.js', '/assets/missing', '/assets/directory.js', '/assets/', '/favicon.ico'])('returns a plain-text 404 for %s', async path => {
    const response = await app.request(path)
    expect(response.status).toBe(404)
    expect(response.headers.get('Content-Type')).toBe('text/plain; charset=utf-8')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.text()).toBe('404 Not Found')
  })

  it('leaves API requests to Hono', async () => {
    const ready = await app.request('/api/ready')
    expect(await ready.json()).toEqual({ ready: true })
    expect((await app.request('/api/unknown')).status).toBe(404)
  })
})
