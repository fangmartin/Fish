import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Fish } from '../shared/contracts'
import { dailyCount, getDigestionState, getGrowth, unspentPoints } from '../shared/domain'

export type KeeperRow = { id: string; nickname: string; passcode: string }
export type FishRow = {
  id: string; keeper_id: string; nickname: string; name: string
  is_system: number; is_hidden: number; status: Fish['status']; created_at: number
  experience: number; burst: number; stamina: number; sense: number; agility: number; brawn: number
  last_respec_date: string | null; daily_fed_count: number; daily_fed_date: string | null
  stuffed_stacks: number; stuffed_updated_at: number
}

export function openStorage(dataDir: string, dbPath: string) {
  const assets = join(dataDir, 'fish')
  mkdirSync(assets, { recursive: true })
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS keepers (
      id TEXT PRIMARY KEY, nickname TEXT NOT NULL, passcode TEXT UNIQUE, session TEXT UNIQUE
    );
    CREATE TABLE IF NOT EXISTS fish (
      id TEXT PRIMARY KEY, keeper_id TEXT NOT NULL REFERENCES keepers(id), name TEXT NOT NULL,
      is_system INTEGER NOT NULL DEFAULT 0, is_hidden INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, experience INTEGER NOT NULL DEFAULT 0,
      burst INTEGER NOT NULL DEFAULT 0, stamina INTEGER NOT NULL DEFAULT 0, sense INTEGER NOT NULL DEFAULT 0,
      agility INTEGER NOT NULL DEFAULT 0, brawn INTEGER NOT NULL DEFAULT 0, last_respec_date TEXT,
      daily_fed_count INTEGER NOT NULL DEFAULT 0, daily_fed_date TEXT,
      stuffed_stacks INTEGER NOT NULL DEFAULT 0, stuffed_updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS fish_owner ON fish(keeper_id, status);
    CREATE INDEX IF NOT EXISTS fish_tank ON fish(status, is_hidden, updated_at);
    CREATE TABLE IF NOT EXISTS pellets (
      id TEXT PRIMARY KEY, keeper_id TEXT NOT NULL REFERENCES keepers(id),
      x REAL NOT NULL, y REAL NOT NULL, expires_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'consumed', 'cancelled', 'expired')),
      dropped_date TEXT, consumed_date TEXT, consumed_at INTEGER,
      winner_fish_id TEXT REFERENCES fish(id), outcome TEXT
    );
    CREATE INDEX IF NOT EXISTS pellet_history ON pellets(winner_fish_id, consumed_at);
    CREATE INDEX IF NOT EXISTS pellet_expiry ON pellets(status, expires_at);
    CREATE TABLE IF NOT EXISTS reports (
      fish_id TEXT NOT NULL REFERENCES fish(id), keeper_id TEXT NOT NULL REFERENCES keepers(id),
      PRIMARY KEY (fish_id, keeper_id)
    );
    CREATE TABLE IF NOT EXISTS rate_limits (
      action TEXT NOT NULL, ip TEXT NOT NULL, bucket TEXT NOT NULL, count INTEGER NOT NULL,
      PRIMARY KEY (action, ip, bucket)
    );
    UPDATE fish SET is_hidden = 1 WHERE is_system = 1 AND is_hidden = 0;
  `)

  function transaction<T>(work: () => T): T {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  transaction(() => {
    const columns = db.prepare('PRAGMA table_info(pellets)').all()
    if (!columns.some(column => column.name === 'dropped_date')) {
      db.exec('ALTER TABLE pellets ADD COLUMN dropped_date TEXT')
    }
    db.exec(`CREATE INDEX IF NOT EXISTS pellet_drop_date
      ON pellets(keeper_id, COALESCE(dropped_date, consumed_date))`)
  })

  const fishSelect = 'SELECT f.*, k.nickname FROM fish f JOIN keepers k ON k.id = f.keeper_id'
  const findFish = (id: string) => db.prepare(`${fishSelect} WHERE f.id = ?`).get(id) as FishRow | undefined
  const assetPath = (id: string) => join(assets, `${id}.png`)

  return { db, transaction, findFish, fishSelect, assetPath }
}

export function presentFish(row: FishRow, nowMs: number): Fish {
  const stats = { burst: row.burst, stamina: row.stamina, sense: row.sense, agility: row.agility, brawn: row.brawn }
  const growth = getGrowth(row.experience)
  return {
    id: row.id, keeperId: row.keeper_id, nickname: row.nickname, name: row.name, status: row.status,
    isHidden: !!row.is_hidden, isSystem: !!row.is_system, createdAt: row.created_at, experience: row.experience,
    assetUrl: `/api/assets/fish/${row.id}.png`, ...growth, stats,
    unspentPoints: unspentPoints(growth.level, stats), lastRespecDate: row.last_respec_date,
    dailyFedCount: dailyCount(row.daily_fed_count, row.daily_fed_date, nowMs), dailyFedDate: row.daily_fed_date,
    rawStuffedStacks: row.stuffed_stacks, stuffedUpdatedAt: row.stuffed_updated_at, serverNow: nowMs,
    ...getDigestionState(row.stuffed_stacks, row.stuffed_updated_at, nowMs),
  }
}
