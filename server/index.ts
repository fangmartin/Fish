import { resolve } from 'node:path'
import { serve } from '@hono/node-server'
import { getConnInfo } from '@hono/node-server/conninfo'
import { serveStatic } from '@hono/node-server/serve-static'
import { createApp } from './app'

function positiveInt(value: string | undefined, fallback: number) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : fallback
}

const { app, db } = createApp({
  dataDir: resolve(process.env.DATA_DIR ?? 'data'),
  dbPath: process.env.DB_PATH ? resolve(process.env.DB_PATH) : undefined,
  adminSecret: process.env.ADMIN_SECRET,
  registerLimit: positiveInt(process.env.REGISTER_IP_DAILY_LIMIT, 8),
  dropLimit: positiveInt(process.env.DROP_IP_MINUTE_LIMIT, 30),
  ip: c => getConnInfo(c).remote.address ?? 'unknown',
})

app.get('*', serveStatic({ root: './dist' }))
app.get('*', serveStatic({ path: './dist/index.html' }))

const server = serve({
  fetch: app.fetch,
  port: positiveInt(process.env.PORT, 3000),
  hostname: process.env.HOST ?? '0.0.0.0',
}, ({ address, port }) => {
  let browserHost = address
  if (address === '0.0.0.0') browserHost = '127.0.0.1'
  if (address === '::') browserHost = '::1'
  const urlHost = browserHost.includes(':') ? `[${browserHost}]` : browserHost
  console.log(`潮汐鱼缸 http://${urlHost}:${port}`)
})

function stop() {
  server.close(() => db.close())
  if ('closeAllConnections' in server) server.closeAllConnections()
}

process.once('SIGINT', stop)
process.once('SIGTERM', stop)
