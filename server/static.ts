import { stat } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import type { Hono } from 'hono'

export function attachStaticRoutes(app: Hono, distDir: string) {
  const entry = serveStatic({ path: join(distDir, 'index.html') })
  const files = serveStatic({ root: distDir })
  const noFallback = async () => {}

  app.get('*', async c => {
    const path = c.req.path
    if (path === '/api' || path.startsWith('/api/')) return c.notFound()

    const missing = () => c.text('404 Not Found', 404, {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
    })
    const asset = path === '/assets' || path.startsWith('/assets/')
    if (asset || posix.basename(path).includes('.')) {
      if (path.includes('%') || path.includes('\\') || posix.normalize(path) !== path) return missing()
      // Only real files count here. The static middleware also serves directory indexes.
      const info = await stat(join(distDir, path)).catch(() => null)
      if (!info?.isFile()) return missing()
      const response = await files(c, noFallback)
      if (!response) return missing()
      response.headers.set('Cache-Control', asset ? 'public, max-age=31536000, immutable' : 'no-cache')
      return response
    }

    const response = await entry(c, noFallback)
    if (!response) return missing()
    response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate')
    response.headers.set('Pragma', 'no-cache')
    response.headers.set('Expires', '0')
    return response
  })
}
