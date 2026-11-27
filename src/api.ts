import type {
  Claim, Fish, FishProfile, FishRelease, GoldenFeastClaim, Keeper, KeeperResponse, Leaderboard, Pellet, RationState,
  TankSummary, TankView,
} from '../shared/contracts'

export type TankScope = { tankId?: string; inviteCode?: string }
export interface TankList {
  publicTank: TankSummary
  ownedTanks: TankSummary[]
  joinedTanks: TankSummary[]
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch('/api' + path, init)
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new ApiError(response.status, data?.error ?? '鱼缸暂时无法连接，请重试')
  return data as T
}

function query(path: string, values: Record<string, string | undefined>) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value) params.set(key, value)
  }
  return params.size ? path + '?' + params : path
}

export function tankLink(inviteCode?: string, fishId?: string, origin = window.location.origin) {
  return new URL(query('/', { tank: inviteCode, fish: fishId }), origin)
}

const json = (body: object) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const post = <T>(path: string, body?: object, keepalive?: boolean) => request<T>(path, {
  method: 'POST', keepalive, ...(body && json(body)),
})
const tankPath = (id: string) => '/tanks/' + encodeURIComponent(id)
const fishPath = (id: string) => '/fish/' + encodeURIComponent(id)

export const api = {
  keeper: (signal?: AbortSignal) => request<KeeperResponse>('/keeper/me', { signal }),
  register: (nickname: string) => post<{ keeper: Keeper } & RationState>('/keeper/register', { nickname }),
  recover: (passcode: string) => post<{ keeper: Keeper } & RationState>('/keeper/recover', { passcode }),
  nickname: (nickname: string) => post<{ keeper: Keeper }>('/keeper/nickname', { nickname }),
  tanks: (signal?: AbortSignal) => request<TankList>('/tanks', { signal }),
  createTank: (name: string) => post<{ tank: TankSummary }>('/tanks', { name }),
  joinTank: (inviteCode: string) => post<{ tank: TankSummary }>('/tanks/join', { inviteCode }),
  renameTank: (id: string, name: string) => request<{ tank: TankSummary }>(tankPath(id), { method: 'PATCH', ...json({ name }) }),
  rotateTankInvite: (id: string) => post<{ tank: TankSummary }>(tankPath(id) + '/rotate-invite'),
  leaveTank: (id: string) => post<{ left: true }>(tankPath(id) + '/leave'),
  deleteTank: (id: string) => request<{ deleted: true; archivedCount: number }>(tankPath(id), { method: 'DELETE' }),
  eject: (tankId: string, fishId: string) => post<{ fish: Fish }>(tankPath(tankId) + '/eject/' + encodeURIComponent(fishId)),
  moveFish: (id: string, targetTankId: string) => post<{ fish: Fish }>(fishPath(id) + '/move', { targetTankId }),
  eventsUrl: (scope: TankScope) => query('/api/events', scope),
  tank: (scope: TankScope, focus = '', exclude: string[] = [], signal?: AbortSignal) => request<TankView>(
    query('/tank/view', { ...scope, focusFishId: focus, excludeIds: exclude.join(',') }), { signal },
  ),
  search: (scope: TankScope, q: string, signal: AbortSignal) => request<{ fish: Fish[] }>(
    query('/fish/search', { ...scope, q }), { signal },
  ),
  fish: (id: string, inviteCode?: string, signal?: AbortSignal) => request<{ fish: FishProfile }>(query(fishPath(id), { invite: inviteCode }), { signal }),
  release: (art: FishRelease) => post<{ fish: Fish }>('/fish', art),
  archive: (id: string) => post<{ fish: Fish }>(`/fish/${encodeURIComponent(id)}/archive`),
  stats: (id: string, stats: object) => post<{ fish: Fish }>(`/fish/${encodeURIComponent(id)}/stats`, stats),
  reset: (id: string) => post<{ fish: Fish }>(`/fish/${encodeURIComponent(id)}/stats/reset`),
  report: (id: string) => post<{ hidden: boolean }>(fishPath(id) + '/report'),
  drop: (scope: TankScope, x: number, y: number) => post<Pellet>('/pellets/drop', { ...scope, x, y }),
  claim: (id: string, winnerFishId: string, inviteCode?: string) => post<Claim>(`/pellets/${id}/claim`, { winnerFishId, inviteCode }),
  cancel: (id: string) => post<RationState>(`/pellets/${id}/cancel`, undefined, true),
  leaderboard: (scope: TankScope, signal: AbortSignal) => request<Leaderboard>(query('/tank/leaderboard', scope), { signal }),
  knockout: (attackerFishId: string, victimFishId: string, inviteCode?: string) => post<{ fish: Fish }>('/tank/knockout', { attackerFishId, victimFishId, inviteCode }),
  claimFeast: (id: string, winnerFishId: string, inviteCode?: string) => post<GoldenFeastClaim>(`/golden-feast/${id}/claim`, { winnerFishId, inviteCode }),
}

export async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return } catch { /* Fall back in embedded and HTTP views. */ }
  }
  const input = document.createElement('textarea')
  input.value = text
  input.style.position = 'fixed'
  input.style.opacity = '0'
  const container = document.querySelector('dialog[open]') ?? document.body
  container.append(input)
  input.select()
  const copied = document.execCommand('copy')
  input.remove()
  if (!copied) throw new Error('复制失败，请手动复制')
}
