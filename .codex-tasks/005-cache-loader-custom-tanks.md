# Task 005: Stale-Cache Black-Screen Fix, Boot Progress Bar & Collaborative Custom Tanks

## Overview
Implement three cohesive upgrades on top of current `HEAD` (`0b4bac5`):
1. **Root-cause fix for next-day stale-cache black screen** (HTTP cache headers + strict 404 for missing `/assets/*` + self-healing boot fallback).
2. **Real multi-stage entry loading progress bar** (zero-flash inline HTML splash → real API & fish artwork decode milestones → smooth fade-out, plus sleek top progress bar when switching tanks).
3. **Collaborative custom fish tanks** (max 2 custom tanks per keeper, invite link sharing `?tank=<inviteCode>`, friends can view/feed/draw/release/move fish into the tank, full tank-scoped isolation for SSE/search/leaderboard/golden-feast).

## Protected Files & Hard Constraints
- Do **not** modify `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `Caddyfile`, `GLOSSARY.md`, `docs/adr/*`, `docs/update-report*`.
- Do **not** call any `t3-code` MCP tools.
- Do **not** run `git commit` or `git push`.
- Keep all existing features intact (9 fun features, belly capacity / 6-stat appetite / Lv.18 Emperor, 20-pellet online SSE stamina bar).
- Maintain **100% coverage** (Statements, Branches, Functions, Lines) on `shared/domain.ts`.
- Keep SQLite migration 100% idempotent and backward-compatible with existing production databases (zero data loss!).

---

## Part 1: Stale-Cache Black-Screen Fix (`server/static.ts` or `server/index.ts`, `index.html`, `src/main.tsx`)

### Root Cause
Previously `server/index.ts` had:
```ts
app.get('*', serveStatic({ root: './dist' }))
app.get('*', serveStatic({ path: './dist/index.html' }))
```
1. `index.html` was served without `Cache-Control`, allowing browsers to cache yesterday's HTML pointing to deleted hashed JS/CSS files.
2. When a cached `index.html` requested a deleted `/assets/index-OLDHASH.js`, the second line fell back to `index.html` with `200 text/html`, causing a module MIME error and a permanent blank dark screen until the user enabled DevTools "Disable cache".

### Required Fix
1. **Extract testable static-hosting registration** (e.g., `attachStaticRoutes(app, distDir)` in `server/static.ts` used by `server/index.ts` and tested in `tests/api.test.ts`):
   - **Hashed assets (`/assets/*`)**:
     - If file exists in `distDir/assets/...`, serve with `Cache-Control: public, max-age=31536000, immutable`.
     - If file does NOT exist, return **404** (`Content-Type: text/plain; charset=utf-8`, `Cache-Control: no-store`) — **NEVER** fall back to `index.html`!
   - **Other explicit static file paths** (paths whose last segment contains a dot `.`, e.g., `/favicon.ico`, `/robots.txt`, `/foo.js`, `/bar.css`, excluding `/api/*`):
     - If file exists in `distDir`, serve with `Cache-Control: no-cache`.
     - If missing, return **404** (`Cache-Control: no-store`) — **NEVER** return `index.html`!
   - **SPA HTML entry (`/` and extensionless client routes not starting with `/api/` or `/assets/`)**:
     - Serve `distDir/index.html` with:
       - `Cache-Control: no-store, no-cache, must-revalidate`
       - `Pragma: no-cache`
       - `Expires: 0`
2. **Self-healing client boot guard (`index.html` + `src/main.tsx`)**:
   - In `index.html`, register a lightweight capture-phase `error` listener on `window` (and `vite:preloadError`) BEFORE `<script type="module">` runs:
     - If a `<script>` or `<link>` targeting `/assets/` fails to load before `window.__FISH_APP_MOUNTED__` is true:
       - Check `sessionStorage.getItem('fish_boot_retry_at')`; if not retried within the last `30_000ms`, record `Date.now()` and trigger a single cache-busting reload (preserving existing URL query params like `?tank=...&fish=...`, adding/updating `_r=<timestamp>` or calling `location.replace` cleanly).
       - If already retried once within 30s (or still not mounted after 10s), show a clear Chinese recovery state inside `#boot-loader` ("页面资源已更新或网络连接失败" + a "重新加载" button that forces a fresh reload).
   - In `src/main.tsx`, set `window.__FISH_APP_MOUNTED__ = true` once React renders.

---

## Part 2: Real Multi-Stage Entry Progress Bar (`index.html`, `src/App.tsx`, `src/tank/TankCanvas.tsx`, `src/styles.css`)

1. **Instant Inline Boot Splash (`index.html`)**:
   - Place a `#boot-loader` overlay directly in `index.html` with inline `<style>` so it renders on the first byte with zero black flash:
     - Deep-sea gradient background matching the aquarium (`#061826` → `#0d2b40`), subtle glowing fish mark, `潮汐鱼缸` title, sleek progress track + glowing cyan-gold progress fill, numeric percentage (`8%` → `100%`), and concise Chinese stage caption.
   - Start cleanly at `12%` (`正在加载鱼缸界面…`) and gently creep to `28%` while the JS bundle parses.
2. **Real Bootstrap Milestones (`src/App.tsx` + `src/tank/TankCanvas.tsx`)**:
   - Expose a small clean controller (e.g. `window.__FISH_BOOT__` or a helper module `src/bootLoader.ts` manipulating `#boot-loader`) so React drives the exact same DOM splash without flicker or double overlays:
     - `30%`: 脚本已就绪，正在连接水域… (on `App` mount)
     - `65%`: 正在唤醒鱼群… (once initial `loadView` + `refreshKeeper` + `loadTanks` settle)
     - `65% → 98%`: Real fish image decode progress for the active tank view! Preload / track `img.complete` / `onload` / `onerror` for the initial fish list (if `0` fish, jump straight to `100%`). Include a hard `2200ms` safety cap after API completion so a single slow image never stalls entry.
     - `100%`: `进入鱼缸` → fade out `#boot-loader` (`opacity: 0`, `280ms`) and remove it from the DOM.
   - If the initial API call fails, show the error message + a "重试连接" button inside the splash (instead of getting stuck at 30%).
3. **Tank-Switching Top Progress Bar**:
   - When switching tanks or refreshing water (`viewLoading`), show a sleek 3px animated glowing bar (`className="tank-switch-bar"`) pinned to the very top of the viewport (non-blocking, disappears cleanly when load finishes).

---

## Part 3: Collaborative Custom Fish Tanks (`shared/domain.ts`, `shared/contracts.ts`, `server/storage.ts`, `server/app.ts`, `src/*`)

### 1. Domain Constants & Pure Rules (`shared/domain.ts`)
Add (maintaining **100% coverage** across statements, branches, functions, and lines!):
- `export const PUBLIC_TANK_ID = 'public'`
- `export const MAX_CUSTOM_TANKS_PER_KEEPER = 2`
- `export const MAX_OWNER_FISH_IN_CUSTOM_TANK = 10`
- `export const MAX_GUEST_FISH_IN_CUSTOM_TANK = 3`
- `export const MAX_TOTAL_FISH_IN_CUSTOM_TANK = 20`
- Keep `MAX_ACTIVE_FISH_PER_KEEPER = 3` (limit in `PUBLIC_TANK_ID`).
- `export function getKeeperTankFishLimit(tankId: string, isTankOwner: boolean)`:
  - If `tankId === PUBLIC_TANK_ID`, return `MAX_ACTIVE_FISH_PER_KEEPER` (`3`).
  - Else return `isTankOwner ? MAX_OWNER_FISH_IN_CUSTOM_TANK : MAX_GUEST_FISH_IN_CUSTOM_TANK` (`10` or `3`).
- `export function canPlaceFishInTank(input: { tankId: string; isTankOwner: boolean; keeperFishInTank: number; totalFishInTank: number })`:
  - Check `keeperLimit = getKeeperTankFishLimit(input.tankId, input.isTankOwner)`.
  - If `input.keeperFishInTank >= keeperLimit`, return `{ ok: false as const, reason: 'keeper_limit' as const, limit: keeperLimit }`.
  - If `input.tankId !== PUBLIC_TANK_ID && input.totalFishInTank >= MAX_TOTAL_FISH_IN_CUSTOM_TANK`, return `{ ok: false as const, reason: 'tank_full' as const, limit: MAX_TOTAL_FISH_IN_CUSTOM_TANK }`.
  - Return `{ ok: true as const }`.
- `export function normalizeInviteCode(input: unknown): string | null`:
  - Accepts either a raw invite code (e.g. `K7M9P2Q4`, case-insensitive, trimmed) OR a full URL containing `?tank=K7M9P2Q4`.
  - Validates `/^[A-Z2-9]{8}$/` (matching the unambiguous passcode alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`) and returns uppercased 8-char code or `null`.

### 2. SQLite Schema & Safe Auto-Migration (`server/storage.ts`)
- Create tables (idempotent `CREATE TABLE IF NOT EXISTS`):
  ```sql
  CREATE TABLE IF NOT EXISTS tanks (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES keepers(id),
    name TEXT NOT NULL,
    invite_code TEXT UNIQUE NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS tanks_owner ON tanks(owner_id, created_at);

  CREATE TABLE IF NOT EXISTS tank_members (
    tank_id TEXT NOT NULL REFERENCES tanks(id) ON DELETE CASCADE,
    keeper_id TEXT NOT NULL REFERENCES keepers(id),
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (tank_id, keeper_id)
  );
  CREATE INDEX IF NOT EXISTS tank_members_keeper ON tank_members(keeper_id, joined_at);
  ```
- Safe idempotent column migrations via `PRAGMA table_info(...)`:
  - `fish`: add `tank_id TEXT NOT NULL DEFAULT 'public'` (existing fish stay in `'public'`), plus index `fish_tank_scope ON fish(tank_id, status, is_hidden, updated_at)`.
  - `pellets`: add `tank_id TEXT NOT NULL DEFAULT 'public'`.
  - `golden_feasts`: add `tank_id TEXT NOT NULL DEFAULT 'public'`.
    - **Critical**: Drop legacy global unique index `DROP INDEX IF EXISTS golden_feast_active` and create `CREATE UNIQUE INDEX IF NOT EXISTS golden_feast_active_per_tank ON golden_feasts(tank_id, status) WHERE status = 'active'` so each tank can independently spawn its own Golden Feast!
- Update `presentFish(row, nowMs, inviteCode?)`:
  - Include `tankId: row.tank_id` and `tankName?: string` (or resolved via `LEFT JOIN tanks t ON t.id = f.tank_id`, defaulting to `'公共鱼缸'` when `tank_id = 'public'`).
  - If the fish belongs to a custom tank and an `inviteCode` is available (e.g. from `t.invite_code`), set `assetUrl` to `/api/assets/fish/${row.id}.png?invite=${encodeURIComponent(inviteCode)}` (for public tank, keep `/api/assets/fish/${row.id}.png`) so both logged-in users and incognito invite-link guests can load fish artwork seamlessly in `<img>`, `<canvas>`, and `poster.ts`!

### 3. Shared Contracts (`shared/contracts.ts`)
- Add `TankSummary`:
  ```ts
  export interface TankSummary {
    id: string
    name: string
    isPublic: boolean
    ownerId?: string
    ownerNickname?: string
    inviteCode?: string
    isOwner: boolean
    fishCount: number
    maxFish: number | null
    myFishCount: number
    myFishLimit: number
    createdAt?: number
  }
  ```
- Update `Fish`: add `tankId: string` and `tankName: string`.
- Update `FishRelease`: add optional `tankId?: string` and `inviteCode?: string`.
- Update `TankView`: `{ tank: TankSummary; fish: Fish[]; goldenFeast: GoldenFeast | null }`.
- Update `TankEvents`:
  - Add `fish_left: { fishId: string }` (sent to source tank when a fish moves out or is ejected, so clients immediately remove it from that tank's canvas).
  - Add `tank_updated: { tank: TankSummary }` (when renamed / invite rotated).
  - Add `tank_deleted: { tankId: string }` (so connected viewers smoothly fall back to public tank with a toast).

### 4. Backend API & Tank Scoping (`server/app.ts`)
- **Tank resolution helper `resolveTankAccess(c, { tankId?, inviteCode?, requireMemberForWrite? })`**:
  - If neither `tankId` nor `inviteCode` is given (or `tankId === 'public'`), resolves to the public tank (`PUBLIC_TANK_ID`).
  - If `inviteCode` is provided (normalized via `normalizeInviteCode`): looks up `tanks WHERE invite_code = ?`; `404` if not found. If requester is a logged-in keeper and not the owner, auto-insert into `tank_members (INSERT OR IGNORE)` so the tank is remembered in their list!
  - If `tankId` (custom UUID) is provided: looks up `tanks WHERE id = ?`; `404` if not found. Requester must be the owner, a member in `tank_members`, or provide the matching `inviteCode` (otherwise `403` `'需要邀请链接才能进入这个鱼缸'`).
- **New Tank Management Endpoints**:
  - `GET /api/tanks`: requires optional keeper (`keeperFor(c)`). Returns `{ publicTank: TankSummary, ownedTanks: TankSummary[], joinedTanks: TankSummary[] }`. (Unauthenticated visitors receive `publicTank` and empty arrays.)
  - `POST /api/tanks`: requires keeper. Body `{ name }`. Validates `shortName(name)`. Inside transaction, checks `COUNT(*) FROM tanks WHERE owner_id = ? < MAX_CUSTOM_TANKS_PER_KEEPER` (else `409` `'每位养鱼人最多只能创建 2 个自建鱼缸'`). Generates unique 8-char uppercase `invite_code`, inserts row, returns `{ tank }` (`201`).
  - `POST /api/tanks/join`: requires keeper. Body `{ inviteCode }` (accepts raw code or full URL via `normalizeInviteCode`). Finds tank (`404` if invalid), inserts into `tank_members` if not owner, returns `{ tank }`.
  - `PATCH /api/tanks/:id`: requires keeper & tank owner (`403` otherwise). Body `{ name }`. Updates `name` and `updated_at`, broadcasts `tank_updated` to that tank's SSE listeners, returns `{ tank }`.
  - `POST /api/tanks/:id/rotate-invite`: requires keeper & tank owner. Generates new unique `invite_code`, updates row, returns `{ tank }`. (Old invite link stops working for new visitors; existing `tank_members` keep access unless removed.)
  - `POST /api/tanks/:id/leave`: requires keeper & non-owner member. Deletes from `tank_members`. (Any fish that keeper still has in that tank stay unless they move/archive them, or keep simple: leave removes the tank from their joined list unless they still have active fish in it — wait: even cleaner, if they leave while having active fish there, either allow leaving or tell them to move/archive their fish first. Allowing leave anytime and showing a hint or moving their active fish to archive? Better: if they still have active fish in that tank, return `409` `'请先将你在这个鱼缸里的鱼搬走或归档，再退出鱼缸'` so no fish gets orphaned!)
  - `DELETE /api/tanks/:id`: requires keeper & tank owner. Inside transaction:
    - Archives all active fish currently in that tank (`UPDATE fish SET status = 'archived', tank_id = 'public', updated_at = ? WHERE tank_id = ? AND status = 'active'`) so **zero fish are ever lost** and public tank's 3-fish limit is never violated!
    - Expires pending pellets & active golden feast in that tank.
    - Deletes the tank (`DELETE FROM tanks WHERE id = ?`, cascading `tank_members`).
    - Broadcasts `tank_deleted` to SSE listeners of that tank.
    - Returns `{ deleted: true, archivedCount }`.
  - `POST /api/tanks/:id/eject/:fishId`: requires keeper & tank owner. Allows owner to remove another collaborator's active fish from their custom tank (archives it safely: `status = 'archived', tank_id = 'public'`), broadcasts `fish_left` to that tank, returns `{ fish }`.
- **Fish Move Endpoint**:
  - `POST /api/fish/:id/move`: requires keeper & fish owner (`ownedFish`). Body `{ targetTankId?: string, inviteCode?: string }`.
    - Fish must be `status = 'active'` and `!is_hidden` (`409` otherwise).
    - Resolves target tank via `resolveTankAccess` (keeper must have access: public, owner, member, or valid `inviteCode`).
    - If `fish.tank_id === targetTank.id`, return `{ fish }` cleanly (idempotent).
    - Checks `canPlaceFishInTank` against target tank inside transaction:
      - `keeper_limit`: `409` (e.g. `'你在目标鱼缸的在缸鱼已达上限（最多 X 条）'`)
      - `tank_full`: `409` (`'这个自建鱼缸已经游满 20 条鱼啦'`)
    - Updates `fish SET tank_id = ?, updated_at = ? WHERE id = ?`.
    - After commit: broadcast `fish_left` (`{ fishId }`) to source tank SSE listeners, and `fish_released` (`{ fish }`) to target tank SSE listeners!
    - Returns `{ fish }`.
- **Update Existing Endpoints to Be Tank-Scoped**:
  - `GET /api/tank/view`: accepts `tankId`, `inviteCode`, `focusFishId`, `excludeIds`.
    - Resolves tank (if `focusFishId` is provided without explicit `tankId`/`inviteCode`, and that fish is in public tank, keep public; if explicit `tankId`/`inviteCode` is provided, return that tank's fish — for custom tanks return all active non-hidden fish up to `MAX_TOTAL_FISH_IN_CUSTOM_TANK`, for public tank keep existing 35-fish slice sampling!).
    - Returns `{ tank, fish, goldenFeast }`.
  - `POST /api/fish`: accepts optional `tankId` / `inviteCode` (defaults to `'public'`). Checks `canPlaceFishInTank` inside transaction! Inserts with `tank_id`, broadcasts `fish_released` ONLY to `tank_id`.
  - `GET /api/tank/leaderboard`: accepts `tankId` / `inviteCode` (defaults to `'public'`), filters `WHERE f.tank_id = ? AND ${inTank}`.
  - `GET /api/fish/search`: accepts `q`, `tankId` / `inviteCode` (defaults to `'public'`), filters `WHERE f.tank_id = ? AND f.status = 'active' AND f.is_hidden = 0 ...`.
  - `POST /api/tank/knockout`: both `attackerFishId` and `victimFishId` must be active in the SAME `tank_id`; broadcasts `fish_updated` and `tank_ticker` ONLY to that `tank_id`.
  - `POST /api/pellets/drop`: accepts optional `tankId` / `inviteCode` (defaults to `'public'`). Verifies `ensureTankCanEat(tankId, time)`, records `tank_id` on `pellets`, consumes 1 ration from keeper's global 20-pellet online jar!
  - `POST /api/pellets/:pelletId/claim`: verifies `winnerFishId` belongs to `pellet.tank_id` (`409` if fish left that tank!), increments tank-scoped feed counter (`tank_state` key `'normal_feeds_total'` for `'public'`, `'normal_feeds_total:' + tankId` for custom tanks), spawns/broadcasts Golden Feast & `pellet_consumed` & `tank_ticker` ONLY to `pellet.tank_id`.
  - `POST /api/golden-feast/:id/claim`: verifies active feast and `winnerFishId` share the same `tank_id`, broadcasts ONLY to that `tank_id`.
  - `POST /api/admin/golden-feast`: optional body `{ tankId }` (defaults to `'public'`).
  - `GET /api/fish/:id` & `GET /api/assets/fish/:filename`: accept optional `?invite=<inviteCode>` (or `inviteCode`) so custom-tank fish & PNGs are strictly isolated from random public users while accessible to the fish owner, tank owner/members, and invite-link visitors!
  - **SSE `GET /api/events`**:
    - Accepts optional `?tankId=...` / `?inviteCode=...` (defaults to `'public'`). Validates tank access before opening stream.
    - Tracks each stream's subscribed `tankId` so `broadcastToTank(tankId, event, data)` only sends tank events to streams viewing that tank!
    - **Crucial**: `onlineKeepers` (20-pellet online stamina regen) remains keyed solely by `keeperId` across ALL tanks (staying open in any public or custom tank regenerates 1 pellet / 60s, deduplicated across tabs!).

### 5. Frontend UX (`src/App.tsx`, `src/api.ts`, `src/tank/TankManagerModal.tsx`, `src/tank/FishProfileModal.tsx`, `src/KeeperModal.tsx`, `src/studio/Studio.tsx`, `src/styles.css`)
- **URL Sync**:
  - Read initial `?tank=<inviteCode>` (and `?fish=<fishId>`) from `window.location.search`.
  - When switching tanks, update URL via `history.replaceState` cleanly (`/` for public tank, `/?tank=<inviteCode>` for custom tank) so refreshing or sharing the browser URL directly opens that exact tank!
  - If opening an invalid/deleted `?tank=...` link, fall back gracefully to Public Tank with a friendly toast (`'这个鱼缸链接已失效，已回到公共鱼缸'`).
- **Header Tank Switcher & `TankManagerModal.tsx`**:
  - Top-left brand area shows a clickable tank pill (e.g. `公共鱼缸 ▾` or `我的客厅缸 · 6/20 ▾`) that opens `TankManagerModal`.
  - Inside `TankManagerModal`:
    - Switch to **公共鱼缸**
    - **我创建的鱼缸（`ownedTanks.length / 2`）**: create new tank (name 1–16 chars), enter tank, copy invite link (`https://.../ ?tank=<code>`), rename inline, reset invite link, delete tank (with inline confirm noting fish will safely move to Deep-Sea Archive).
    - **受邀加入的鱼缸**: enter tank, copy invite link, leave tank.
    - **通过邀请码/链接加入**: single input box accepting either an 8-char invite code or pasted share URL!
- **In-Tank Custom Toolbar Actions**:
  - When viewing a custom tank:
    - Show an **「邀请好友」** button in the toolbar to copy the invite link in 1 click.
    - Replace/hide "换一片水域" shuffle (custom tank displays all ≤20 fish in that tank).
    - Show current tank target name in `Studio` when releasing a fish (e.g. `放生到：小明的客厅缸`), and pass `tankId` / `inviteCode` to `api.release`.
- **Fish Profile (`FishProfileModal.tsx`)**:
  - Show current tank badge (`所在鱼缸：公共鱼缸` / custom tank name).
  - For the fish's owner (when active), show a sleek **"搬家换缸"** row allowing one-click move to `公共鱼缸` or any of the keeper's owned/joined custom tanks.
  - For the custom tank's owner viewing a collaborator's fish, show a subtle **"请出本缸"** button (with confirm) calling `POST /api/tanks/:tankId/eject/:fishId`.
  - Share link & poster URL automatically preserve `?tank=<inviteCode>&fish=<fishId>` when the fish is in a custom tank!
- **Keeper Center (`KeeperModal.tsx`)**:
  - Show each active fish's tank name badge (`公共鱼缸` / custom tank name), and show `我的在缸鱼（共 N 条）` cleanly instead of hardcoding `/3` across all tanks (can show public slot usage e.g. `公共缸 X/3` if helpful).
  - Clicking a fish in `KeeperModal` switches to its tank (if active) and opens its profile.

---

## Verification & Tests Required
1. **`tests/domain.test.ts`**:
   - Cover `PUBLIC_TANK_ID`, `MAX_CUSTOM_TANKS_PER_KEEPER`, `MAX_OWNER_FISH_IN_CUSTOM_TANK`, `MAX_GUEST_FISH_IN_CUSTOM_TANK`, `MAX_TOTAL_FISH_IN_CUSTOM_TANK`, `getKeeperTankFishLimit`, `canPlaceFishInTank` (all branches), and `normalizeInviteCode` (raw code, lowercase, full URL, invalid inputs).
   - **100% coverage on `shared/domain.ts` (Stmts / Branch / Funcs / Lines)**.
2. **`tests/api.test.ts`**:
   - **Cache & static fallback tests** (testing `attachStaticRoutes`):
     - `GET /` and `GET /tank/demo` return `200 text/html` with `Cache-Control: no-store, no-cache, must-revalidate`.
     - Existing `/assets/app-123.js` returns `200` with `Cache-Control: public, max-age=31536000, immutable`.
     - Missing `/assets/deleted-old.js` returns **`404`** (NOT `200 text/html`!) with `Cache-Control: no-store`.
   - **Custom collaborative tanks tests**:
     - Create up to 2 custom tanks; 3rd creation returns `409`.
     - Unauthorized user without invite link cannot view/join custom tank (`403`).
     - Guest joining via `inviteCode` (or viewing via `?inviteCode=...`) can view tank, load fish PNG with `?invite=`, draw/release up to 3 fish, and feed fish (consuming their own 20-pellet jar).
     - Owner can place up to 10 fish in their own custom tank (while keeping independent 3-fish limit in public tank); tank rejects 21st total fish (`409`).
     - Moving fish (`POST /api/fish/:id/move`) between public tank and custom tank enforces target limits and broadcasts `fish_left` to source tank and `fish_released` to target tank without leaking across tanks!
     - Tank isolation: custom tank fish do NOT appear in public tank view, public search, or public leaderboard; SSE events in custom tank do NOT leak to public tank listeners; Golden Feast can spawn independently per tank; online SSE ration regen still works seamlessly while connected to a custom tank!
     - Rename tank, rotate invite link (old link fails, new link works), eject guest fish (moves to guest's archive), leave tank, delete tank (archives active fish safely with zero data loss and broadcasts `tank_deleted`).
     - Legacy SQLite migration test: existing DB without `tanks` table or `tank_id` columns migrates cleanly with all legacy fish in `'public'`.
3. Run and verify all pass:
   - `pnpm run typecheck`
   - `pnpm test`
   - `pnpm run build`
