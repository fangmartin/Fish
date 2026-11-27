import { useState } from 'react'
import type { TankSummary } from '../../shared/contracts'
import { MAX_CUSTOM_TANKS_PER_KEEPER, normalizeInviteCode } from '../../shared/domain'
import { api, copyText, tankLink, type TankList } from '../api'
import { Icon } from '../icons'
import { Modal } from '../Modal'

export function TankManagerModal({ tanks, current, hasKeeper, onClose, onNeedKeeper, onEnter, onJoin, onChange, onRemove }: {
  tanks: TankList
  current: TankSummary
  hasKeeper: boolean
  onClose: () => void
  onNeedKeeper: () => void
  onEnter: (tank: TankSummary) => Promise<void>
  onJoin: (inviteCode: string) => Promise<void>
  onChange: (tank: TankSummary) => void
  onRemove: (id: string, message: string) => void
}) {
  const [name, setName] = useState('')
  const [invite, setInvite] = useState('')
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const [deleting, setDeleting] = useState('')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [error, setError] = useState('')
  const canCreate = tanks.ownedTanks.length < MAX_CUSTOM_TANKS_PER_KEEPER

  async function run(action: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    setError('')
    setFeedback('')
    try {
      await action()
    } catch (error) {
      setError(error instanceof Error ? error.message : '操作失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  function readName(value: string) {
    const name = value.trim()
    if (!name || [...name].length > 16) throw new Error('鱼缸名称需要 1～16 字')
    return name
  }

  function tankRow(summary: TankSummary) {
    const tank = current.id === summary.id ? current : summary
    const selected = current.id === tank.id
    return <article className="tank-entry" key={tank.id}>
      <div className="tank-entry-heading">
        <div><h4>{tank.name}</h4>
          <p>{tank.isPublic ? '开放水域' : `${tank.fishCount}/${tank.maxFish} 条鱼`}
            {!tank.isOwner && tank.ownerNickname && ` · ${tank.ownerNickname}`}</p></div>
        <button className="button subtle" disabled={busy || selected} onClick={() => void run(() => onEnter(tank))}>
          {selected ? '当前鱼缸' : '进入'}</button>
      </div>
      {!tank.isPublic && <div className="tank-entry-actions">
        {tank.inviteCode && <button className="text-button" disabled={busy} onClick={() => void run(async () => {
          const link = tankLink(tank.inviteCode).href
          await copyText(link).then(() => setFeedback('邀请链接已复制')).catch(() => setFeedback(link))
        })}><Icon name="copy" />复制邀请链接</button>}
        {tank.isOwner ? <>
          <button className="text-button" disabled={busy} onClick={() => { setDeleting(''); setRenaming({ id: tank.id, name: tank.name }) }}>重命名</button>
          <button className="text-button" disabled={busy} onClick={() => void run(async () => {
            const result = await api.rotateTankInvite(tank.id)
            onChange(result.tank)
            setFeedback('邀请链接已更新，已加入的好友可继续进入')
          })}>重置邀请链接</button>
          <button className="text-button tank-danger" disabled={busy} onClick={() => { setRenaming(null); setDeleting(tank.id) }}>删除鱼缸</button>
        </> : <button className="text-button" disabled={busy} onClick={() => void run(async () => {
          await api.leaveTank(tank.id)
          onRemove(tank.id, '已退出鱼缸')
          setFeedback('已退出鱼缸')
        })}>退出鱼缸</button>}
      </div>}
      {renaming?.id === tank.id && <form className="tank-form" onSubmit={event => {
        event.preventDefault()
        void run(async () => {
          const result = await api.renameTank(tank.id, readName(renaming.name))
          onChange(result.tank)
          setRenaming(null)
          setFeedback('鱼缸名称已更新')
        })
      }}>
        <input aria-label="新的鱼缸名称" value={renaming.name} maxLength={32} required disabled={busy}
          onChange={event => setRenaming({ id: tank.id, name: event.target.value })} />
        <button type="button" className="button subtle" disabled={busy} onClick={() => setRenaming(null)}>取消</button>
        <button type="submit" className="button primary" disabled={busy}>保存</button>
      </form>}
      {deleting === tank.id && <div className="archive-confirm" role="group" aria-label="确认删除鱼缸">
        <p>删除后，缸内的鱼会安全收入各自养鱼人的深海归档图鉴。</p>
        <div className="modal-actions">
          <button className="button subtle" disabled={busy} onClick={() => setDeleting('')}>取消</button>
          <button className="button subtle tank-danger" disabled={busy} onClick={() => void run(async () => {
            const { archivedCount } = await api.deleteTank(tank.id)
            const message = `鱼缸已删除，${archivedCount} 条鱼已归档`
            onRemove(tank.id, message)
            setDeleting('')
            setFeedback(message)
          })}>确认删除</button>
        </div>
      </div>}
    </article>
  }

  return <Modal title="鱼缸管理" onClose={() => { if (!busy) onClose() }}>
    {tankRow(tanks.publicTank)}
    {hasKeeper ? <>
      <section className="tank-manager-section">
        <h3>我创建的鱼缸 <small>{tanks.ownedTanks.length}/{MAX_CUSTOM_TANKS_PER_KEEPER}</small></h3>
        {tanks.ownedTanks.map(tankRow)}
        {canCreate && <form className="tank-form" onSubmit={event => {
          event.preventDefault()
          void run(async () => {
            const { tank } = await api.createTank(readName(name))
            onChange(tank)
            setName('')
            await onEnter(tank)
          })
        }}>
          <input aria-label="鱼缸名称" value={name} maxLength={32} required disabled={busy} placeholder="鱼缸名称（1～16 字）"
            onChange={event => setName(event.target.value)} />
          <button type="submit" className="button primary" disabled={busy}><Icon name="plus" />创建鱼缸</button>
        </form>}
      </section>
      <section className="tank-manager-section">
        <h3>受邀加入的鱼缸</h3>
        {tanks.joinedTanks.length ? tanks.joinedTanks.map(tankRow) : <p className="muted">还没有加入其他鱼缸</p>}
      </section>
    </> : <button className="text-button" disabled={busy} onClick={onNeedKeeper}>设置养鱼人身份后可创建鱼缸</button>}
    <section className="tank-manager-section">
      <h3>通过邀请码或链接加入</h3>
      <form className="tank-form" onSubmit={event => {
        event.preventDefault()
        void run(async () => {
          const code = normalizeInviteCode(invite)
          if (!code) throw new Error('请输入 8 位邀请码或完整邀请链接')
          await onJoin(code)
        })
      }}>
        <input aria-label="邀请码或邀请链接" autoComplete="off" value={invite} required disabled={busy} placeholder="输入邀请码或粘贴链接"
          onChange={event => setInvite(event.target.value)} />
        <button className="button primary" type="submit" disabled={busy}>{hasKeeper ? '加入' : '进入'}</button>
      </form>
    </section>
    {error && <p className="form-error" role="alert">{error}</p>}
    {feedback && <p className="feedback" role="status">{feedback}</p>}
  </Modal>
}
