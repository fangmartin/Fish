import { useEffect, useState } from 'react'
import type { Fish, Leaderboard } from '../../shared/contracts'
import { api } from '../api'
import { Modal } from '../Modal'

const names = { gluttons: '今日干饭王', bullies: '全缸恶霸', giants: '深海巨物' } as const

export function LeaderboardModal({ onClose, onFish }: { onClose: () => void; onFish: (fish: Fish) => void }) {
  const [tab, setTab] = useState<keyof Leaderboard>('gluttons')
  const [boards, setBoards] = useState<Leaderboard>()
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    void api.leaderboard(controller.signal).then(setBoards).catch(error => {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '榜单暂时无法加载')
    })
    return () => controller.abort()
  }, [])

  return <Modal title="鱼缸排行榜" onClose={onClose}>
    <div className="keeper-tabs" aria-label="趣味榜单">
      {(Object.keys(names) as (keyof Leaderboard)[]).map(key =>
        <button key={key} aria-pressed={tab === key} onClick={() => setTab(key)}>{names[key]}</button>)}
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {!error && !boards && <p className="muted" role="status">正在加载榜单…</p>}
    {boards && !boards[tab].length && <p className="muted">水域里还没有上榜的鱼。</p>}
    {boards && <ol className="leaderboard-list">
      {boards[tab].map((fish, index) => <li key={fish.id}>
        <button className="fish-row" onClick={() => onFish(fish)}>
          <b className="rank-number">{index + 1}</b><img src={fish.assetUrl} alt="" />
          <span>{fish.name}<small>{fish.nickname}</small></span>
          <strong>{tab === 'gluttons' ? `${fish.dailyEatsCount} 颗`
            : tab === 'bullies' ? `${fish.totalKnockouts} 次` : `Lv.${fish.level} · ${fish.experience} 经验`}</strong>
        </button>
      </li>)}
    </ol>}
  </Modal>
}
