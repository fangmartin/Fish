import { useEffect, useRef, type ReactNode } from 'react'
import { Icon } from './icons'

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current!
    dialog.showModal()
    return () => dialog.close()
  }, [])
  return <dialog ref={ref} className="modal" aria-label={title}
    onCancel={event => { event.preventDefault(); onClose() }}
    onClick={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="modal-body">
      <header className="modal-heading">
        <h2>{title}</h2>
        <button className="icon-button" aria-label="关闭" onClick={onClose}><Icon name="close" /></button>
      </header>
      {children}
    </div>
  </dialog>
}
