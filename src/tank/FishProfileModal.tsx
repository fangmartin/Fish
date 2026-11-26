import { useEffect, useState } from 'react'
import type { Fish, FishProfile } from '../../shared/contracts'
import {
  DAILY_SATIETY_CAP, EMPTY_STATS, MAX_STAT_VALUE, STAT_KEYS, canRespec, dailyCount, getBuildTitle, getDigestionState, type Stats,
} from '../../shared/domain'
import { api, copyText } from '../api'
import { Icon } from '../icons'
import { Modal } from '../Modal'
import { FishPreview } from './FishPreview'
import { downloadFishPoster, statNames } from './poster'

const stageNames = { fry: '鱼苗', juvenile: '幼鱼', adult: '成鱼', leviathan: '鱼王' }
const outcomeNames = { grew: '成长', leveled_up: '升级', stuffed: '吃撑', stuffed_full: '撑不动了' }
const clock = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
})

export function FishProfileModal({ id, live, keeperId, onClose, onChange, onReport }: {
  id: string
  live?: Fish
  keeperId?: string
  onClose: () => void
  onChange: (fish: Fish) => void
  onReport: (hidden: boolean) => void
}) {
  const [profile, setProfile] = useState<FishProfile>()
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')
  const [increments, setIncrements] = useState<Stats>({ ...EMPTY_STATS })
  const [busy, setBusy] = useState(false)
  const [savingPoster, setSavingPoster] = useState(false)
  const [archiveConfirm, setArchiveConfirm] = useState(false)
  const [wallTime, setWallTime] = useState(Date.now)
  const [receivedAt, setReceivedAt] = useState(Date.now)

  useEffect(() => {
    const timer = window.setInterval(() => setWallTime(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void api.fish(id, controller.signal).then(({ fish }) => {
      setReceivedAt(Date.now())
      setLoadError('')
      setProfile(fish)
    }).catch(error => { if (!controller.signal.aborted) setLoadError(error.message) })
    return () => controller.abort()
  }, [id, live])

  async function edit(change: () => Promise<{ fish: Fish }>) {
    if (busy) return
    setBusy(true)
    setError('')
    setFeedback('')
    try {
      const { fish } = await change()
      setReceivedAt(Date.now())
      setProfile(previous => ({ ...fish, feedingHistory: previous?.feedingHistory ?? [], totalEats: previous?.totalEats ?? 0 }))
      setIncrements({ ...EMPTY_STATS })
      setArchiveConfirm(false)
      onChange(fish)
    } catch (error) {
      setError(error instanceof Error ? error.message : '操作失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  if (loadError || !profile) return <Modal title="鱼的档案" onClose={onClose}>
    <p className={loadError ? 'form-error' : 'muted'} role={loadError ? 'alert' : 'status'}>{loadError || '正在寻找这条鱼…'}</p>
  </Modal>

  const fish = live && live.serverNow > profile.serverNow ? live : profile
  const owner = keeperId === fish.keeperId
  const now = fish.serverNow + Math.max(0, wallTime - receivedAt)
  const digestion = getDigestionState(fish.rawStuffedStacks, fish.stuffedUpdatedAt, now)
  const dailyFed = dailyCount(fish.dailyFedCount, fish.dailyFedDate, now)
  const available = fish.unspentPoints - STAT_KEYS.reduce((sum, key) => sum + increments[key], 0)
  const share = new URL(window.location.pathname, window.location.origin)
  share.searchParams.set('fish', fish.id)
  const posterFish = { ...profile, ...fish }

  async function savePoster() {
    setSavingPoster(true)
    setError('')
    setFeedback('')
    try {
      await downloadFishPoster(posterFish, share.href)
    } catch {
      setError('海报暂时无法生成，请重试')
    } finally {
      setSavingPoster(false)
    }
  }

  async function report() {
    if (!keeperId) { setError('请先设置养鱼人昵称，再提交举报'); return }
    setBusy(true)
    setError('')
    setFeedback('')
    try {
      const { hidden } = await api.report(fish.id)
      if (!hidden) setFeedback('举报已记录')
      onReport(hidden)
    } catch (error) {
      setError(error instanceof Error ? error.message : '举报提交失败')
    } finally {
      setBusy(false)
    }
  }

  return <Modal title={fish.name} onClose={onClose}>
    <FishPreview fish={fish} stuffed={digestion.stuffedStacks} />
    <div className="profile-meta">
      <span>{fish.nickname} · {stageNames[fish.stage]}</span>
      <span className="build-badge">{getBuildTitle(fish.stats, fish.level)}</span><strong>Lv.{fish.level}</strong>
    </div>
    {fish.tagline && <p className="profile-tagline">「{fish.tagline}」</p>}
    <div className="progress-header"><span>成长经验</span><strong>{fish.nextLevelXp ? `${fish.progress} / ${fish.nextLevelXp}` : '已满级'}</strong></div>
    <progress className="growth-progress" value={fish.nextLevelXp ? fish.progress : 1} max={fish.nextLevelXp || 1} aria-label="成长经验" />
    <div className="profile-satiety">
      <div><span>今日有效饱食</span><strong>{dailyFed} / {DAILY_SATIETY_CAP}</strong></div>
      <div><span>{digestion.stuffedStacks === 3 ? '撑不动了' : '吃撑层数'}</span>
        <strong>{digestion.stuffedStacks} / 3</strong>
        {!!digestion.digestionRemainingSec && <small>消化剩余 {Math.ceil(digestion.digestionRemainingSec / 60)} 分钟</small>}
      </div>
    </div>
    <section className="attributes" aria-label="五维属性">
      <div className="progress-header"><h3>五维属性</h3>{owner && <strong>{available} 点可分配</strong>}</div>
      {STAT_KEYS.map(key => <div className="attribute-row" key={key}>
        <span>{statNames[key]}</span>
        <div className="stat-blocks" aria-hidden="true">
          {Array.from({ length: MAX_STAT_VALUE }, (_, index) => <i key={index}
            className={index < fish.stats[key] ? 'earned' : index < fish.stats[key] + increments[key] ? 'pending' : ''} />)}
        </div>
        <output>{fish.stats[key] + increments[key]}</output>
        {owner && <div className="stat-controls">
          <button aria-label={`减少${statNames[key]}待分配点数`} disabled={busy || !increments[key]}
            onClick={() => setIncrements({ ...increments, [key]: increments[key] - 1 })}><Icon name="minus" /></button>
          <button aria-label={`增加${statNames[key]}待分配点数`} disabled={busy || available <= 0 || fish.stats[key] + increments[key] >= MAX_STAT_VALUE}
            onClick={() => setIncrements({ ...increments, [key]: increments[key] + 1 })}><Icon name="plus" /></button>
        </div>}
      </div>)}
      {owner && <div className="modal-actions">
        <button className="button subtle" disabled={busy || !canRespec(fish.lastRespecDate, now)}
          onClick={() => void edit(() => api.reset(fish.id))}>{canRespec(fish.lastRespecDate, now) ? '免费洗点' : '今日已洗点'}</button>
        <button className="button primary" disabled={busy || available === fish.unspentPoints}
          onClick={() => void edit(() => api.stats(fish.id, increments))}>提交加点</button>
      </div>}
    </section>
    {!!profile.feedingHistory.length && <details className="feeding-history">
      <summary>最近进食</summary>
      <ul>{profile.feedingHistory.map((record, index) => <li key={index}>
        <time dateTime={new Date(record.consumedAt).toISOString()}>{clock.format(record.consumedAt)}</time>
        <span>{outcomeNames[record.outcome]}</span>
      </li>)}</ul>
    </details>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {feedback && <p className="feedback" role="status">{feedback}</p>}
    <footer className="profile-actions">
      <button className="button primary" disabled={savingPoster} onClick={() => void savePoster()}>
        <Icon name="download" /> {savingPoster ? '正在生成…' : '保存晒图'}</button>
      <button className="button subtle" onClick={() => void copyText(share.href).then(() => setFeedback('直达链接已复制'))
        .catch(() => setFeedback(share.href))}><Icon name="copy" /> 复制链接</button>
      {fish.status === 'active' && !fish.isHidden && <button className="button subtle" disabled={busy} onClick={() => void report()}>
        <Icon name="flag" /> 举报</button>}
      {owner && fish.status === 'active' && <button className="button subtle" disabled={busy} onClick={() => setArchiveConfirm(true)}>
        <Icon name="archive" /> 深海归档</button>}
    </footer>
    {archiveConfirm && <div className="archive-confirm" role="group" aria-label="确认深海归档">
      <p>归档后，这条鱼将离开公共鱼缸并永久收入你的图鉴。</p>
      <div className="modal-actions">
        <button className="button subtle" disabled={busy} onClick={() => setArchiveConfirm(false)}>取消</button>
        <button className="button primary" disabled={busy} onClick={() => void edit(() => api.archive(fish.id))}>确认归档</button>
      </div>
    </div>}
  </Modal>
}
