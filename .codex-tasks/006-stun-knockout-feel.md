# Task 006: Tangible Collision Stun / Knockout Effect

## Goal
Make collision knockouts genuinely impactful and immediately readable in the aquarium: when a sprinting fish rams another fish, the victim gets knocked back and then **visibly stunned / immobilized in place for 1.8s–4.5s** (scaling with attacker `brawn`), complete with stopped swimming, cartoon dizzy visuals, countdown badge, and anti-stunlock protection.

## Protected Files & Constraints
- Only touch `src/tank/physics.ts`, `src/tank/meshRenderer.ts`, `src/tank/TankCanvas.tsx`, and `tests/physics.test.ts` (plus `src/audio/sound.ts` only if needed).
- Do **not** modify `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `Caddyfile`, `GLOSSARY.md`, `docs/`, `shared/domain.ts`, or `server/`.
- Do **not** call any `t3-code` MCP tools, do **not** run `git commit` or `git push`, and do **not** start any live local HTTP server or browser smoke test.

## Detailed Specification

### 1. Stun Physics & Anti-Stunlock (`src/tank/physics.ts`)
- Export `export const stunDuration = (brawn: number) => 1.8 + brawn * 0.45` (`1.8s` at `brawn = 0` up to `4.5s` at `brawn = 6`).
- Export `export const STUN_IMMUNITY_SECONDS = 1.2` (grace period after waking up so a fish cannot be chain-stun-locked indefinitely).
- Add `stunImmunity: number` (initialized to `0` in `createSwimmer`) to `Swimmer`.
- In `stepTank`:
  - Decrement `swimmer.stun = Math.max(0, swimmer.stun - dt)` and `swimmer.stunImmunity = Math.max(0, swimmer.stunImmunity - dt)`.
  - **While `swimmer.stun > 0`** (knocked out / immobilized):
    - Clear pursuit state: `swimmer.targetId = null`, `swimmer.sprinting = false`, `swimmer.alertTimer = 0`, `swimmer.reaction = 0`.
    - Do **not** actively steer, turn `heading`, or flip `facing`.
    - Rapidly brake active swim speed to `0`: `swimmer.speed *= Math.exp(-10 * dt)` (snap to `0` when `< 0.5`).
    - Position updates only via residual `speed` (braking to `0`) + knockback impulse `pushX`/`pushY` (which decays rapidly via `exp(-4.8 * dt)` and snaps to `0` when `Math.hypot(pushX, pushY) < 0.5`), clamped inside tank bounds. Result: victim visibly slides back from impact, then **hangs completely motionless in place** for the remainder of `swimmer.stun`!
    - Still cannot eat pellets (already guarded by `!swimmer.stun` in contacts loop).
  - **On collision** (attacker `sprinting && !attacker.stun`):
    - Skip peers where `peer === attacker || peer.stun > 0 || peer.stunImmunity > 0 || peer.body.bellyOverload === 2`.
    - Punchier knockback: `const force = (42 + attacker.body.stats.brawn * 28 + attacker.body.size * 0.24) / (1 + peer.body.size / 180)`.
    - Set:
      - `const duration = stunDuration(attacker.body.stats.brawn)`
      - `peer.stun = duration`
      - `peer.stunImmunity = duration + STUN_IMMUNITY_SECONDS`
      - `peer.targetId = null`
      - `peer.alertTimer = 0`
      - `peer.sprinting = false`
      - `peer.speed *= 0.25`
    - Note: Keep `CollisionEvent` shape unchanged (`attackerId, victimId, x, y, brawn, force`).
- In `knockTank`:
  - Skip stunned fish (`if (swimmer.body.bellyOverload === 2 || swimmer.stun > 0) continue`) so knocking the glass does not wake up a knocked-out fish into fleeing.

### 2. Visual Stun Feedback (`src/tank/meshRenderer.ts` & `src/tank/TankCanvas.tsx`)
- **`src/tank/meshRenderer.ts`**:
  - Add `stunned?: boolean` to `MeshPose`.
  - Update `drawFishEye(..., sleepy = false, stunned = false)`:
    - When `stunned && !sleepy`, draw unmistakable comic **`×` dizzy eyes** (pale sclera circle with crisp dark `×` cross strokes centered inside, scaled cleanly to `radius`).
  - In `drawFishMesh`:
    - When `pose.stunned`: reduce tail wave amplitude dramatically (`* 0.14`) so the fish looks limp/frozen rather than actively swimming.
    - Pass `Boolean(pose.stunned)` into `drawFishEye`.
- **`src/tank/TankCanvas.tsx`**:
  - When `const stunned = swimmer.stun > 0`:
    - Pause `visual.wavePhase` advancement (don't advance tail swim wave while stunned!).
    - Add a dazed tilted wobble to `tilt` (e.g., `const dazedTilt = stunned ? 0.16 * -Math.sign(swimmer.facing || 1) + Math.sin(seconds * 13 + phase) * 0.12 : 0`).
    - Pass `stunned` into `drawFishMesh`.
    - Keep orbiting golden stars (`✦`) spinning above the head while `stunned`, AND render a crisp countdown badge right beside/above the fish:
      - `caption(ctx, \`💫 晕了 · ${Math.ceil(swimmer.stun)}s\`, x, labelY, '#3a2238ea', '#ffe8a8')`
    - Play `bonk` sound on collisions (not only `brawn >= 3` — trigger `bonk` with cooldown `180ms` on any collision, and screen shake when `hit.brawn >= 2` so even low-brawn collisions feel tangible!).

### 3. Tests (`tests/physics.test.ts`)
- Update and expand collision/stun tests in `tests/physics.test.ts`:
  - Verify `stunDuration(0) === 1.8` and `stunDuration(6) === 4.5`.
  - Verify a stunned victim slides back from knockback, then **stops moving (`speed === 0`, displacement ≈ 0)**, does **not** chase or eat a pellet right in front of its mouth while `stun > 0`, and does **not** flee when `knockTank` is called.
  - Verify once `stun` expires, the fish resumes chasing food, and during `STUN_IMMUNITY_SECONDS` cannot be immediately re-stunned (anti-stunlock).
  - Verify sleeping (`bellyOverload === 2`) fish are not collided/stunned.

## Verification
Run and confirm all pass:
- `pnpm run typecheck`
- `pnpm test` (including 100% coverage on `shared/domain.ts`)
- `pnpm run build`
