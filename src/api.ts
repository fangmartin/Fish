import type {
  Claim, Fish, FishProfile, FishRelease, GoldenFeastClaim, Keeper, KeeperResponse, Leaderboard, Pellet, RationState, TankView,
} from '../shared/contracts'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch('/api' + path, init)
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new Error(data?.error ?? '鱼缸暂时无法连接，请重试')
  return data as T
}

const post = <T>(path: string, body?: object, keepalive?: boolean) => request<T>(path, {
  method: 'POST', keepalive, ...(body && {
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }),
})

export const api = {
  keeper: () => request<KeeperResponse>('/keeper/me'),
  register: (nickname: string) => post<{ keeper: Keeper } & RationState>('/keeper/register', { nickname }),
  recover: (passcode: string) => post<{ keeper: Keeper } & RationState>('/keeper/recover', { passcode }),
  nickname: (nickname: string) => post<{ keeper: Keeper }>('/keeper/nickname', { nickname }),
  tank: (focus: string, exclude: string[] = []) => request<TankView>(
    '/tank/view?' + new URLSearchParams({ focusFishId: focus, excludeIds: exclude.join(',') }),
  ),
  search: (q: string, signal: AbortSignal) => request<{ fish: Fish[] }>(
    '/fish/search?' + new URLSearchParams({ q }), { signal },
  ),
  fish: (id: string, signal?: AbortSignal) => request<{ fish: FishProfile }>(`/fish/${encodeURIComponent(id)}`, { signal }),
  release: (art: FishRelease) => post<{ fish: Fish }>('/fish', art),
  archive: (id: string) => post<{ fish: Fish }>(`/fish/${encodeURIComponent(id)}/archive`),
  stats: (id: string, stats: object) => post<{ fish: Fish }>(`/fish/${encodeURIComponent(id)}/stats`, stats),
  reset: (id: string) => post<{ fish: Fish }>(`/fish/${encodeURIComponent(id)}/stats/reset`),
  report: (id: string) => post<{ hidden: boolean }>(`/fish/${encodeURIComponent(id)}/report`),
  drop: (x: number, y: number) => post<Pellet>('/pellets/drop', { x, y }),
  claim: (id: string, winnerFishId: string) => post<Claim>(`/pellets/${id}/claim`, { winnerFishId }),
  cancel: (id: string) => post<RationState>(`/pellets/${id}/cancel`, undefined, true),
  leaderboard: (signal: AbortSignal) => request<Leaderboard>('/tank/leaderboard', { signal }),
  knockout: (attackerFishId: string, victimFishId: string) => post<{ fish: Fish }>('/tank/knockout', { attackerFishId, victimFishId }),
  claimFeast: (id: string, winnerFishId: string) => post<GoldenFeastClaim>(`/golden-feast/${id}/claim`, { winnerFishId }),
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
