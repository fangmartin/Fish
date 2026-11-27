import { useState, type FormEvent } from 'react'
import type { Fish, KeeperResponse } from '../shared/contracts'
import { api, copyText } from './api'
import { Icon } from './icons'
import { Modal } from './Modal'

export function KeeperModal({ state, message, onClose, onIdentity, onFish }: {
  state: KeeperResponse
  message?: string
  onClose: () => void
  onIdentity: () => Promise<void>
  onFish: (fish: Fish) => void
}) {
  const [mode, setMode] = useState<'nickname' | 'recover'>('nickname')
  const [nickname, setNickname] = useState(state.keeper?.nickname ?? '')
  const [passcode, setPasscode] = useState('')
  const [tab, setTab] = useState<'active' | 'archive'>('active')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [error, setError] = useState('')
  const fish = state.keeper ? (tab === 'active' ? state.activeFish : state.archivedFish) : []
  const keeper = state.keeper

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    setFeedback('')
    try {
      if (mode === 'recover') {
        const restored = await api.recover(passcode)
        setNickname(restored.keeper.nickname)
        setPasscode('')
        setMode('nickname')
        setFeedback('养鱼人身份已恢复')
      } else {
        await (keeper ? api.nickname(nickname) : api.register(nickname))
        setFeedback(keeper ? '昵称已更新' : '养鱼人身份已创建，请保存通行码')
      }
      await onIdentity()
    } catch (error) {
      setError(error instanceof Error ? error.message : '操作失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  return <Modal title="养鱼人中心" onClose={onClose}>
    {!keeper && <p className="muted">{message ?? '选个昵称，在这片水域留下你的鱼。'}</p>}
    {keeper && <section className="passcode">
      <div><span>通行码</span><code>{keeper.passcode}</code></div>
      <button className="icon-button" aria-label="复制通行码" onClick={() => void copyText(keeper.passcode)
        .then(() => { setError(''); setFeedback('通行码已复制') })
        .catch(() => setError('复制失败，可以手动选中通行码复制'))}><Icon name="copy" /></button>
    </section>}
    <form className="keeper-form" onSubmit={submit}>
      {mode === 'nickname' ? (
        <label>养鱼人昵称<input value={nickname} placeholder="1～16 字" maxLength={32} required
          onChange={event => setNickname(event.target.value)} /></label>
      ) : (
        <label>通行码<input value={passcode} placeholder="FISH-XXXX-XXXX-XXXX" required autoComplete="off"
          maxLength={19} onChange={event => setPasscode(event.target.value)} /></label>
      )}
      <button type="submit" className="button primary" disabled={busy}>
        {busy ? '处理中…' : mode === 'recover' ? '恢复身份' : keeper ? '更新昵称' : '进入鱼缸'}
      </button>
    </form>
    <button className="text-button" onClick={() => { setMode(mode === 'recover' ? 'nickname' : 'recover'); setError('') }}>
      {mode === 'recover' ? '返回昵称设置' : '用通行码恢复身份'}
    </button>
    {error && <p className="form-error" role="alert">{error}</p>}
    {feedback && <p className="feedback" role="status">{feedback}</p>}
    {state.keeper && <>
      <div className="keeper-tabs" aria-label="我的鱼">
        <button aria-pressed={tab === 'active'} onClick={() => setTab('active')}>我的在缸鱼（共 {state.activeFish.length} 条）</button>
        <button aria-pressed={tab === 'archive'} onClick={() => setTab('archive')}>深海归档图鉴</button>
      </div>
      <div className="keeper-fish">
        {!fish.length && <p className="muted">{tab === 'active' ? '你还没有鱼，画一条让它下水吧。' : '图鉴里还没有归档的鱼。'}</p>}
        {fish.map(item => <button className="fish-row" key={item.id} onClick={() => onFish(item)}>
          <img src={item.assetUrl} alt="" /><span>{item.name}{tab === 'active' && <small className="tank-badge">{item.tankName}</small>}</span><strong>Lv.{item.level}</strong>
          {item.isHidden && <small>已隐藏</small>}
        </button>)}
      </div>
    </>}
  </Modal>
}
