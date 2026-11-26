import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { MAX_ART_BYTES, MAX_ART_EDGE } from '../../shared/domain'
import { Icon } from '../icons'
import { Modal } from '../Modal'
import { drawFishMesh } from '../tank/meshRenderer'
import { ColorPicker } from './ColorPicker'
import { cropCanvas, exportFish } from './exportFish'
import { floodFill, hsvToRgb, rgbToHsv, type Point } from './paint'
import { STENCILS, STUDIO_HEIGHT as HEIGHT, STUDIO_WIDTH as WIDTH } from './stencils'

const tools = [
  { id: 'pen', key: 'B', label: '画笔' },
  { id: 'eraser', key: 'E', label: '橡皮' },
  { id: 'fill', key: 'G', label: '填充' },
  { id: 'picker', key: 'I', label: '吸管' },
  { id: 'line', key: 'L', label: '直线' },
] as const

type Tool = typeof tools[number]['id']
type TemplateMode = 'none' | 'guide' | 'clip'
type Stroke = { id: number; start: Point; last: Point; before: ImageData; layer: CanvasRenderingContext2D }

const context = (canvas: HTMLCanvasElement) => canvas.getContext('2d', { willReadFrequently: true })!
const snapshot = (canvas: HTMLCanvasElement) => context(canvas).getImageData(0, 0, WIDTH, HEIGHT)
const imageTypes = ['image/png', 'image/jpeg', 'image/webp']

interface StudioProps {
  onClose: () => void
  canRelease: boolean
  onNeedKeeper: () => void
  onRelease: (name: string, pngBase64: string) => Promise<void>
}

export function Studio({ onClose, canRelease, onNeedKeeper, onRelease }: StudioProps) {
  const art = useRef<HTMLCanvasElement>(null)
  const guidance = useRef<HTMLCanvasElement>(null)
  const preview = useRef<HTMLCanvasElement>(null)
  const releaseName = useRef<HTMLInputElement>(null)
  const imageInput = useRef<HTMLInputElement>(null)
  const active = useRef<Stroke | null>(null)
  const undo = useRef<ImageData[]>([])
  const redo = useRef<ImageData[]>([])
  const rev = useRef(0)
  const clipPixels = useRef<Uint8ClampedArray | undefined>(undefined)
  const [history, setHistory] = useState({ undo: 0, redo: 0 })
  const [name, setName] = useState('')
  const [tool, setTool] = useState<Tool>('pen')
  const [previewing, setPreviewing] = useState(false)
  const [hint, setHint] = useState(false)
  const [stencil, setStencil] = useState(0)
  const [mode, setMode] = useState<TemplateMode>('guide')
  const [mirrorX, setMirrorX] = useState(false)
  const [mirrorY, setMirrorY] = useState(false)
  const [soft, setSoft] = useState(false)
  const [size, setSize] = useState(15)
  const [opacity, setOpacity] = useState(100)
  const [tolerance, setTolerance] = useState(32)
  const [color, setColor] = useState(() => rgbToHsv([114, 225, 191]))
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState('')
  const rgb = hsvToRgb(color.hue, color.saturation, color.value)
  const ink = `rgb(${rgb.join(',')})`
  const stencilPath = STENCILS[stencil].path

  useEffect(() => {
    if (confirming) releaseName.current?.focus()
  }, [confirming])

  function updateHistory() {
    rev.current++
    setHistory({ undo: undo.current.length, redo: redo.current.length })
  }

  function remember(before: ImageData) {
    undo.current.push(before)
    if (undo.current.length > 24) undo.current.shift()
    redo.current = []
    updateHistory()
  }

  function travel(forward: boolean) {
    if (!art.current || active.current) return
    const [from, to] = forward ? [redo.current, undo.current] : [undo.current, redo.current]
    const state = from.pop()
    if (!state) return
    to.push(snapshot(art.current))
    context(art.current).putImageData(state, 0, 0)
    updateHistory()
  }

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if ((event.target as HTMLElement | null)?.closest('input, textarea, [contenteditable]')) return
      if (event.key.toLowerCase() === 'z' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        travel(event.shiftKey)
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const match = tools.find(tool => tool.key === event.key.toUpperCase())
      if (match) setTool(match.id)
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [])

  useEffect(() => {
    const ctx = context(guidance.current!)
    ctx.clearRect(0, 0, WIDTH, HEIGHT)
    clipPixels.current = undefined
    if (mode !== 'none') {
      const path = new Path2D(stencilPath)
      if (mode === 'clip') {
        ctx.fillStyle = '#fff'
        ctx.fill(path)
        clipPixels.current = ctx.getImageData(0, 0, WIDTH, HEIGHT).data
        ctx.clearRect(0, 0, WIDTH, HEIGHT)
      }
      ctx.fillStyle = mode === 'clip' ? '#54d9c21b' : '#6ac7ed14'
      ctx.strokeStyle = mode === 'clip' ? '#75e5cca0' : '#91c7df79'
      ctx.lineWidth = 2
      ctx.setLineDash([7, 6])
      ctx.fill(path)
      ctx.stroke(path)
    }
    ctx.strokeStyle = '#dcc4ff9c'
    ctx.lineWidth = 1
    ctx.setLineDash([5, 5])
    ctx.beginPath()
    if (mirrorX) { ctx.moveTo(WIDTH / 2, 0); ctx.lineTo(WIDTH / 2, HEIGHT) }
    if (mirrorY) { ctx.moveTo(0, HEIGHT / 2); ctx.lineTo(WIDTH, HEIGHT / 2) }
    ctx.stroke()
    ctx.setLineDash([])
  }, [stencilPath, mode, mirrorX, mirrorY])

  useEffect(() => {
    if (!previewing || !preview.current) return
    const ctx = preview.current.getContext('2d')!
    let frame = 0
    let lastRefresh = -Infinity
    let version = -1
    let source: HTMLCanvasElement | null = null
    function draw(time: number) {
      if (rev.current !== version && time - lastRefresh > 140) {
        source = cropCanvas(art.current!, 420)
        version = rev.current
        lastRefresh = time
      }
      ctx.clearRect(0, 0, 400, 124)
      if (source) {
        const seconds = time / 1000
        drawFishMesh(ctx, source, source.width, source.height, {
          x: 200 + Math.sin(seconds * 0.85) * 88,
          y: 62 + Math.cos(seconds * 1.21) * 7,
          size: Math.min(168, 92 * Math.max(1, source.width / source.height)),
          time: seconds, facing: -Math.tanh(Math.cos(seconds * 0.85) * 9),
          tilt: Math.sin(seconds * 1.21) * 0.045,
        })
      } else {
        ctx.fillStyle = '#9ebac4'
        ctx.font = '15px sans-serif'
        ctx.textAlign = 'center'
        ctx.fillText('在画布上添几笔，看看它游起来', 200, 68)
      }
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [previewing])

  function getPoint(clientX: number, clientY: number): Point {
    const rect = art.current!.getBoundingClientRect()
    return { x: (clientX - rect.left) * WIDTH / rect.width, y: (clientY - rect.top) * HEIGHT / rect.height }
  }

  function reflected(point: Point) {
    const copies = [point]
    if (mirrorX && point.x !== WIDTH / 2) copies.push({ x: WIDTH - point.x, y: point.y })
    if (mirrorY && point.y !== HEIGHT / 2) copies.push(...copies.map(p => ({ x: p.x, y: HEIGHT - p.y })))
    return copies
  }

  function drawSegment(layer: CanvasRenderingContext2D, from: Point, to: Point) {
    const paint = tool === 'eraser' ? '#000' : ink
    const radius = size / 2
    function dab(x: number, y: number) {
      layer.beginPath()
      if (soft) {
        const fade = layer.createRadialGradient(x, y, radius * 0.17, x, y, radius)
        fade.addColorStop(0, paint)
        fade.addColorStop(1, 'transparent')
        layer.fillStyle = fade
      } else layer.fillStyle = paint
      layer.arc(x, y, radius, 0, Math.PI * 2)
      layer.fill()
    }
    const pairs = [{ from, to }]
    if (mirrorX) pairs.push({ from: { x: WIDTH - from.x, y: from.y }, to: { x: WIDTH - to.x, y: to.y } })
    if (mirrorY) pairs.push(...pairs.map(pair => ({
      from: { x: pair.from.x, y: HEIGHT - pair.from.y }, to: { x: pair.to.x, y: HEIGHT - pair.to.y },
    })))
    for (const pair of pairs) {
      if (soft || (pair.from.x === pair.to.x && pair.from.y === pair.to.y)) {
        const distance = Math.hypot(pair.from.x - pair.to.x, pair.from.y - pair.to.y)
        const steps = Math.max(1, Math.ceil(distance / Math.max(0.55, size * 0.18)))
        for (let step = 0; step <= steps; step++) {
          dab(pair.from.x + (pair.to.x - pair.from.x) * step / steps, pair.from.y + (pair.to.y - pair.from.y) * step / steps)
        }
      } else {
        layer.strokeStyle = paint
        layer.lineCap = 'round'
        layer.lineWidth = size
        layer.beginPath()
        layer.moveTo(pair.from.x, pair.from.y)
        layer.lineTo(pair.to.x, pair.to.y)
        layer.stroke()
      }
    }
  }

  function compose(stroke: Stroke) {
    const ctx = context(art.current!)
    ctx.putImageData(stroke.before, 0, 0)
    ctx.save()
    if (mode === 'clip') ctx.clip(new Path2D(stencilPath))
    ctx.globalAlpha = opacity / 100
    if (tool === 'eraser') ctx.globalCompositeOperation = 'destination-out'
    ctx.drawImage(stroke.layer.canvas, 0, 0)
    ctx.restore()
    rev.current++
  }

  function begin(event: PointerEvent<HTMLCanvasElement>) {
    if (event.button !== 0 || active.current || busy || importing) return
    setError('')
    const canvas = event.currentTarget
    const point = getPoint(event.clientX, event.clientY)
    const ctx = context(canvas)
    if (tool === 'picker') {
      const [r, g, b, alpha] = ctx.getImageData(point.x, point.y, 1, 1).data
      if (alpha) setColor(rgbToHsv([r, g, b]))
      return
    }
    const before = snapshot(canvas)
    if (tool === 'fill') {
      const next = snapshot(canvas)
      let changed = false
      for (const region of reflected(point)) {
        changed = floodFill(next.data, WIDTH, HEIGHT, region, rgb, opacity / 100, tolerance, clipPixels.current) || changed
      }
      if (changed) {
        remember(before)
        ctx.putImageData(next, 0, 0)
      }
      return
    }
    canvas.setPointerCapture(event.pointerId)
    const layer = document.createElement('canvas')
    layer.width = WIDTH
    layer.height = HEIGHT
    const stroke = { id: event.pointerId, start: point, last: point, before, layer: layer.getContext('2d')! }
    active.current = stroke
    drawSegment(stroke.layer, point, point)
    compose(stroke)
  }

  function move(event: PointerEvent<HTMLCanvasElement>) {
    const stroke = active.current
    if (!stroke || stroke.id !== event.pointerId) return
    const latest = getPoint(event.clientX, event.clientY)
    if (tool === 'line') {
      stroke.layer.clearRect(0, 0, WIDTH, HEIGHT)
      drawSegment(stroke.layer, stroke.start, latest)
    } else {
      const events = event.nativeEvent.getCoalescedEvents?.() ?? []
      const points = events.length ? events.map(event => getPoint(event.clientX, event.clientY)) : [latest]
      for (const point of points) {
        drawSegment(stroke.layer, stroke.last, point)
        stroke.last = point
      }
    }
    compose(stroke)
  }

  function end(event: PointerEvent<HTMLCanvasElement>) {
    const stroke = active.current
    if (!stroke || stroke.id !== event.pointerId) return
    if (event.type === 'pointerup') move(event)
    active.current = null
    remember(stroke.before)
  }

  async function importImage(file: File) {
    if (busy || importing || active.current) return
    if (file.type && !imageTypes.includes(file.type)) {
      setError('请选择 PNG、JPEG 或 WebP 图片')
      return
    }
    setImporting(true)
    setError('')
    let image: ImageBitmap | undefined
    try {
      image = await createImageBitmap(file)
      const canvas = art.current
      if (!canvas) return
      const scale = Math.min(1, (WIDTH - 32) / image.width, (HEIGHT - 32) / image.height)
      const width = Math.max(1, Math.round(image.width * scale))
      const height = Math.max(1, Math.round(image.height * scale))
      remember(snapshot(canvas))
      const ctx = context(canvas)
      ctx.clearRect(0, 0, WIDTH, HEIGHT)
      ctx.drawImage(image, Math.floor((WIDTH - width) / 2), Math.floor((HEIGHT - height) / 2), width, height)
    } catch {
      setError('图片无法打开，请选择有效的 PNG、JPEG 或 WebP 图片')
    } finally {
      image?.close()
      setImporting(false)
    }
  }

  async function release() {
    if (busy || importing) return
    const title = name.trim()
    if (!title || [...title].length > 16) {
      setError('请给鱼取一个 1～16 字的名字')
      return
    }
    const png = exportFish(art.current!)
    if (!png) {
      setError('请先画几笔，或导入一张有内容的图片')
      setConfirming(false)
      return
    }
    if (!canRelease) {
      setConfirming(false)
      onNeedKeeper()
      return
    }
    setBusy(true)
    setError('')
    try {
      await onRelease(title, png)
    } catch (error) {
      setError(error instanceof Error ? error.message : '下水失败，请再试一次')
      setConfirming(false)
    } finally {
      setBusy(false)
    }
  }

  return <main className="studio" aria-label="手绘画板">
    <header className="studio-header">
      <button type="button" className="button subtle" onClick={onClose} disabled={busy}><Icon name="back" /> 返回鱼缸</button>
      <div className="studio-title"><Icon name="pen" /><h1>手绘画板</h1>
        <button type="button" className="icon-button" aria-label="画板提示" aria-expanded={hint} onClick={() => setHint(!hint)}><Icon name="info" /></button>
      </div>
      <div className="studio-actions">
        <input value={name} onChange={e => setName(e.target.value)} maxLength={32} placeholder="给鱼取个名字" aria-label="鱼名称" />
        <button type="button" className="button subtle" aria-pressed={previewing} onClick={() => setPreviewing(!previewing)}><Icon name="wave" /> 游动预览</button>
        <button type="button" className="button primary" disabled={busy || importing} onClick={() => { setError(''); setConfirming(true) }}><Icon name="fish" /> 放生下水</button>
      </div>
    </header>
    {hint && <p className="studio-instructions">鱼头朝左画，游动时尾部会自然摆动。鱼形模板可作参考，也可限制涂色范围。下水后外观与名字永久锁定。</p>}
    <div className="studio-layout">
      <aside className="studio-panel studio-left" aria-label="历史与模板">
        <h2>画布操作</h2>
        <div className="history-tools">
          <button type="button" disabled={!history.undo} onClick={() => travel(false)} title="Ctrl / Cmd + Z"><Icon name="undo" /> 撤销</button>
          <button type="button" disabled={!history.redo} onClick={() => travel(true)} title="Ctrl / Cmd + Shift + Z"><Icon name="redo" /> 重做</button>
        </div>
        <input ref={imageInput} type="file" accept={imageTypes.join(',')} hidden onChange={event => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ''
          if (file) void importImage(file)
        }} />
        <button type="button" className="canvas-action" disabled={busy || importing}
          title="导入图片会替换当前画布，可撤销" onClick={() => imageInput.current?.click()}>
          <Icon name="image" /> {importing ? '正在导入…' : '导入图片'}
        </button>
        <button type="button" className="canvas-action" onClick={() => {
          if (active.current) return
          const canvas = art.current!
          remember(snapshot(canvas))
          context(canvas).clearRect(0, 0, WIDTH, HEIGHT)
        }}><Icon name="clear" /> 清空画布</button>
        <h2><Icon name="template" /> 鱼形模板</h2>
        <div className="template-modes" aria-label="模板模式">
          {([['none', '无模板'], ['guide', '参考轮廓'], ['clip', '轮廓内涂色']] as const).map(([id, label]) =>
            <button type="button" key={id} aria-pressed={mode === id} onClick={() => setMode(id)}>{label}</button>)}
        </div>
        <div className="template-grid">
          {STENCILS.map((item, index) => <button type="button" key={item.name} aria-pressed={mode !== 'none' && index === stencil}
            onClick={() => { setStencil(index); if (mode === 'none') setMode('guide') }}>
            <svg viewBox="36 40 575 311" aria-hidden="true"><path d={item.path} /></svg>
            <span>{item.name}</span>
          </button>)}
        </div>
      </aside>
      <section className="studio-center" aria-label="绘图区域">
        {previewing && <div className="swim-preview"><canvas ref={preview} width={400} height={124} aria-label="游动预览" /></div>}
        <div className="drawing-frame">
          <div className="direction-guide" aria-hidden="true">← 鱼头 <span>｜</span> 尾巴 →</div>
          <canvas className="stencil-canvas" ref={guidance} width={WIDTH} height={HEIGHT} aria-hidden="true" />
          <canvas className={`drawing-canvas tool-${tool}`} ref={art} width={WIDTH} height={HEIGHT}
            aria-label="手绘鱼的透明画布" onPointerDown={begin} onPointerMove={move}
            onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end} />
        </div>
        {error && !confirming && <p className="form-error" role="alert">{error}</p>}
        <div className="canvas-meta"><span>{WIDTH} × {HEIGHT}</span><span>{tools.find(item => item.id === tool)?.label} · {size} px</span></div>
      </section>
      <aside className="studio-panel studio-right" aria-label="绘画工具与颜色">
        <h2>绘画工具</h2>
        <div className="tool-grid">
          {tools.map(item => <button type="button" key={item.id} aria-pressed={tool === item.id} title={`${item.label} (${item.key})`}
            onClick={() => setTool(item.id)}><Icon name={item.id} /><span>{item.label}</span><kbd>{item.key}</kbd></button>)}
        </div>
        <div className="segments">
          <button type="button" aria-pressed={mirrorX} onClick={() => setMirrorX(!mirrorX)}><Icon name="mirrorX" /> 左右对称</button>
          <button type="button" aria-pressed={mirrorY} onClick={() => setMirrorY(!mirrorY)}><Icon name="mirrorY" /> 上下对称</button>
        </div>
        <div className="segments">
          <button type="button" aria-pressed={!soft} onClick={() => setSoft(false)}>硬边</button>
          <button type="button" aria-pressed={soft} onClick={() => setSoft(true)}>软边</button>
        </div>
        <h2>颜色</h2>
        <ColorPicker color={color} onChange={setColor} />
        <label className="slider"><span>粗细 <output>{size} px</output></span>
          <input type="range" min={1} max={60} value={size} onChange={event => setSize(+event.target.value)} /></label>
        <label className="slider"><span>不透明度 <output>{opacity}%</output></span>
          <input type="range" min={10} max={100} value={opacity} onChange={event => setOpacity(+event.target.value)} /></label>
        {tool === 'fill' && <label className="slider"><span>填充容差 <output>{tolerance}</output></span>
          <input type="range" min={0} max={120} value={tolerance} onChange={event => setTolerance(+event.target.value)} /></label>}
      </aside>
    </div>
    {confirming && <Modal title="放生下水" onClose={() => { if (!busy) setConfirming(false) }}>
      <form className="release-form" noValidate onSubmit={event => { event.preventDefault(); void release() }}>
        <label>鱼名
          <input ref={releaseName} value={name} required maxLength={32} disabled={busy} placeholder="输入 1～16 字"
            aria-invalid={!!error} aria-describedby={error ? 'release-name-error' : undefined}
            onChange={event => { setName(event.target.value); setError('') }} />
        </label>
        <p className="muted">下水后，鱼的外观与名字将永久锁定。</p>
        <p className="muted">画作会压缩至最长边 {MAX_ART_EDGE} 像素以内，体积不超过 {MAX_ART_BYTES / 1024} KB。</p>
        {error && <p id="release-name-error" className="form-error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="button subtle" disabled={busy} onClick={() => setConfirming(false)}>继续画</button>
          <button type="submit" className="button primary" disabled={busy}>{busy ? '正在下水…' : '确认下水'}</button>
        </div>
      </form>
    </Modal>}
  </main>
}
