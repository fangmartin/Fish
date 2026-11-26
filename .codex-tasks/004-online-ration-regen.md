# Task 004: Online Stamina-Bar Food Rations (SSE-Backed Regen)

## Goal
Replace the daily midnight-reset food ration limit with an **online stamina-bar food jar**:
- Default & max capacity: **20 pellets** (`MAX_RATIONS = 20`).
- **Stamina-bar regen**: Whenever a keeper has `< 20` pellets **and has the page open** (detected via an active authenticated `/api/events` SSE connection), online time accumulates continuously and regenerates **+1 pellet every 60 seconds** (`RATION_REGEN_INTERVAL_MS = 60_000`) until reaching `20`.
- **Offline pauses regen**: Closing the page (no active SSE connections for that keeper) immediately settles elapsed online time and pauses regeneration; offline time contributes `0 ms`.
- **No midnight daily reset**: Crossing Shanghai midnight does **not** reset rations or regen progress.

## Scope & Protected Files
- Do **not** touch `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `Caddyfile`, `docs/`, or `GLOSSARY.md`.
- Keep all existing features (including commit `7a6f8dd` belly capacity / `appetite` / Lv.18 emperor stage and commit `12d7e6c` 9 fun features) intact.
- Do **not** run `git commit` or `git push`; leave a clean working tree diff ready for review.
- Do **not** call any `t3-code` MCP tools.

## Detailed Specification

### 1. Domain Logic (`shared/domain.ts`)
- Replace `DAILY_RATION_LIMIT` and `remainingRations(droppedCount)` with:
  - `export const MAX_RATIONS = 20`
  - `export const RATION_REGEN_INTERVAL_MS = 60_000`
  - `export function settleOnlineRations(rations: number, progressMs: number, elapsedOnlineMs: number)`:
    - Clamp `rations` to `[0, MAX_RATIONS]` (integer floor).
    - If `rations >= MAX_RATIONS`, return `{ rations: MAX_RATIONS, progressMs: 0, gained: 0, nextRationInSec: 0 }`.
    - Clamp `progressMs >= 0` and `elapsedOnlineMs >= 0` (integer floor).
    - `totalMs = progressMs + elapsedOnlineMs`.
    - `gained = Math.min(MAX_RATIONS - rations, Math.floor(totalMs / RATION_REGEN_INTERVAL_MS))`.
    - `nextRations = rations + gained`.
    - `nextProgressMs = nextRations >= MAX_RATIONS ? 0 : totalMs % RATION_REGEN_INTERVAL_MS`.
    - `nextRationInSec = nextRations >= MAX_RATIONS ? 0 : Math.ceil((RATION_REGEN_INTERVAL_MS - nextProgressMs) / 1000)`.
    - Return `{ rations: nextRations, progressMs: nextProgressMs, gained, nextRationInSec }`.
  - `export function consumeRation(rations: number, progressMs: number)`:
    - Normalize `current = clamp(Math.floor(rations), 0, MAX_RATIONS)`.
    - If `current <= 0`, return `null`.
    - `nextRations = current - 1`.
    - Preserve partial `progressMs` if `current < MAX_RATIONS`; if `current === MAX_RATIONS`, start fresh at `progressMs = 0`.
    - `nextRationInSec = Math.ceil((RATION_REGEN_INTERVAL_MS - nextProgressMs) / 1000)`.
    - Return `{ rations: nextRations, progressMs: nextProgressMs, nextRationInSec }`.
- Maintain **100% test coverage** (Statements, Branches, Functions, Lines) on `shared/domain.ts`.

### 2. Persistence & Safe Migration (`server/storage.ts`)
- Add two columns to `keepers`:
  - `rations INTEGER NOT NULL DEFAULT 20`
  - `ration_progress_ms INTEGER NOT NULL DEFAULT 0`
- Ensure `openStorage` migrates existing SQLite databases idempotently via `PRAGMA table_info(keepers)` + `ALTER TABLE keepers ADD COLUMN ...` so existing live keepers start cleanly at `20` rations with `0` progress and zero data loss.
- Keep `pellets` table and existing pellet drop/claim/cancel/expire semantics unchanged (dropping consumes 1 ration immediately; cancelling or expiring a pellet does **not** refund rations).

### 3. Server-Side SSE Presence & Regen (`server/app.ts`)
- Reuse `/api/events` SSE to track online keepers by `keeperId`:
  - Maintain an in-memory map `onlineKeepers: Map<string, { streams: Set<EventListener>; lastSettledAt: number; nextRegenAt: number | null }>`.
  - **Multi-tab deduplication**: If the same `keeperId` opens 2+ tabs, all streams share one `OnlinePresence` entry; online time only counts 1x (never multiplied by tab count).
  - **Connect (`GET /api/events`)**:
    - Look up `keeper = keeperFor(c)`.
    - If authenticated, register the stream into `onlineKeepers`:
      - If this is the keeper's first active stream, read current `(rations, ration_progress_ms)` from DB, set `lastSettledAt = time`, and compute `nextRegenAt = rations < MAX_RATIONS ? time + (RATION_REGEN_INTERVAL_MS - ration_progress_ms) : null`.
      - If already online, simply add the stream to `presence.streams` (do not reset `lastSettledAt`).
  - **Disconnect (`stream.onAbort`)**:
    - Remove the stream from `presence.streams`.
    - If `presence.streams.size === 0`, settle accumulated online time up to `now()` into SQLite first, then delete the keeper from `onlineKeepers`. Offline time afterwards accumulates `0 ms`.
- **Deterministic sync helper** `syncKeeperRations(keeperId, time)`:
  - When called inside or outside a transaction, reads `rations, ration_progress_ms` from `keepers`.
  - If `onlineKeepers.has(keeperId)`, computes `elapsed = Math.max(0, time - presence.lastSettledAt)` and runs `settleOnlineRations(row.rations, row.ration_progress_ms, elapsed)`.
  - If not online, runs `settleOnlineRations(row.rations, row.ration_progress_ms, 0)` (no offline regen!).
  - **Transaction safety**: Only advance `presence.lastSettledAt` and update `presence.nextRegenAt` **after** the DB update/transaction succeeds (never leave in-memory `presence` ahead of a rolled-back transaction).
  - Call `syncKeeperRations` on:
    - `GET /api/keeper/me`
    - `POST /api/keeper/recover`
    - `POST /api/pellets/drop` (before `consumeRation`)
    - `POST /api/pellets/:pelletId/claim`
    - `POST /api/pellets/:pelletId/cancel`
    - SSE disconnect when last stream closes
- **Live targeted SSE push (`rations_updated`)**:
  - Run a lightweight periodic check (`setInterval(..., 1_000).unref()` so Node/Vitest exits cleanly) that iterates `onlineKeepers` and ONLY touches DB for keepers where `presence.nextRegenAt !== null && now() >= presence.nextRegenAt`.
  - When `gained > 0`, send SSE event `rations_updated` (`{ remainingRations, nextRationInSec }`) **only** to that keeper's streams (do not broadcast personal rations to other players).
- **Error message & API responses**:
  - When `consumeRation` returns `null` in `POST /api/pellets/drop`, return `409` with `'鱼食已用完，留在页面每分钟恢复 1 颗'`.
  - Include `nextRationInSec` alongside `remainingRations` in `GET /api/keeper/me`, `POST /api/keeper/register` (`20`, `0`), `POST /api/keeper/recover`, `POST /api/pellets/drop`, `POST /api/pellets/:pelletId/claim`, and `POST /api/pellets/:pelletId/cancel`.

### 4. Shared Contracts (`shared/contracts.ts`)
- Add `nextRationInSec: number` to:
  - Authenticated branch of `KeeperResponse`
  - `Pellet`
  - `Claim`
- Add `rations_updated: { remainingRations: number; nextRationInSec: number }` to `TankEvents`.
- Update `src/api.ts` return types (`register`, `recover`, `cancel`) to include `remainingRations` / `nextRationInSec` where applicable.

### 5. Frontend (`src/App.tsx` & styles)
- **Critical SSE auth lifecycle**: Reconnect `EventSource('/api/events')` whenever `keeper.keeper?.id` changes (e.g. a brand-new visitor registers or recovers a passcode), so the SSE connection immediately carries the newly issued `fish_keeper` session cookie and starts online regen without requiring a manual browser refresh!
  - Make sure reconnecting on `keeperId` change doesn't break existing SSE listeners, pellet cleanup, or cause infinite loops.
- Subscribe to `rations_updated` on the `EventSource` to update `rations` and `nextRationInSec` in real time.
- Sync `rations` and `nextRationInSec` from `refreshKeeper()`, `drop()`, `claim()`, and `cancel()`.
- Display live regen countdown on the food jar button when authenticated and `rations < MAX_RATIONS`:
  - Full (`20/20`): `剩余 20/20`
  - Regenerating (`< 20`): `剩余 X/20 · Ns后+1` (tick smoothly every second locally while page is open, re-anchored whenever server sends updated `nextRationInSec` / `rations_updated`).
- Update empty-jar toast copy in `src/App.tsx` from `'今天的投喂配额已用完'` to `'鱼食已用完，留在页面每分钟恢复 1 颗'`.

### 6. Automated Tests
- **`tests/domain.test.ts`**:
  - Test `MAX_RATIONS`, `RATION_REGEN_INTERVAL_MS`, `settleOnlineRations` (full cap, partial progress accumulation, multi-minute regen, clamping at 20 and resetting progress to 0, zero/negative elapsed clamping), and `consumeRation` (from 20 starts at 0 progress / 60s, from <20 preserves existing progress, from 0 returns `null`).
  - Verify 100% coverage on `shared/domain.ts`.
- **`tests/api.test.ts`**:
  - Update old daily-reset ration tests to verify the new rules:
    1. New keeper starts with `20` rations, `nextRationInSec: 0`.
    2. Dropping pellets decrements rations immediately (`19`, `18`, ...), cancel/expire does not refund, dropping at `0` fails with `409` `'鱼食已用完，留在页面每分钟恢复 1 颗'`.
    3. **Offline does NOT regen**: advance fake clock `now` by hours or across Shanghai midnight (`00:00`) with NO SSE connection -> rations stay unchanged (neither regens nor resets at midnight!).
    4. **Online via SSE regens 1/min**: open authenticated `GET /api/events` stream, advance fake clock `35s` -> still same count with `nextRationInSec: 25`; advance another `25s` -> `+1` ration (`nextRationInSec: 60` or `0` if full); advance `30m` -> capped at `20` with `nextRationInSec: 0`.
    5. **Closing SSE pauses regen & preserves partial progress**: open SSE for `40s`, abort SSE, advance clock `10 minutes` offline -> still `+0`; reconnect SSE for `20s` -> completes the `40s + 20s = 60s` minute and gains `+1`!
    6. **Multi-tab deduplication**: open 2 concurrent SSE streams for the same keeper, advance `60s` -> only `+1` ration (not `+2`), and closing 1 of the 2 streams keeps online regen running until the 2nd closes.
    7. **Targeted `rations_updated` SSE push**: verify the owning keeper receives `rations_updated` when a minute elapses while another keeper's stream does not receive it.
    8. **Migration compatibility**: opening a legacy SQLite DB whose `keepers` table lacks `rations` / `ration_progress_ms` migrates cleanly and yields `remainingRations: 20`.

## Verification Commands
Before finishing, run and confirm all pass:
- `pnpm run typecheck`
- `pnpm test` (including coverage check on `shared/domain.ts`)
- `pnpm run build`
