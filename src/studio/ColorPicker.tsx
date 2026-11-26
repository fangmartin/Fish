import type { PointerEvent } from 'react'
import { hsvToRgb, rgbToHsv, type RGB } from './paint'

const palette: RGB[] = [
  [247, 246, 233], [250, 159, 131], [247, 211, 113], [114, 225, 191],
  [102, 185, 250], [184, 151, 245], [246, 133, 190], [25, 37, 63],
]
type HSV = ReturnType<typeof rgbToHsv>
const percent = (value: number) => Math.max(0, Math.min(1, value))

export function ColorPicker({ color, onChange }: { color: HSV; onChange: (value: HSV) => void }) {
  const { hue, saturation, value } = color
  const handle = hue * Math.PI / 180
  const rgb = hsvToRgb(hue, saturation, value)
  const hex = '#' + rgb.map(channel => channel.toString(16).padStart(2, '0')).join('').toUpperCase()

  function selectHue(event: PointerEvent<HTMLDivElement>) {
    if (event.type === 'pointerdown') event.currentTarget.setPointerCapture(event.pointerId)
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    const rect = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - rect.left - rect.width / 2
    const y = event.clientY - rect.top - rect.height / 2
    onChange({ ...color, hue: (Math.atan2(x, -y) * 180 / Math.PI + 360) % 360 })
  }

  function selectShade(event: PointerEvent<HTMLDivElement>) {
    event.stopPropagation()
    if (event.type === 'pointerdown') event.currentTarget.setPointerCapture(event.pointerId)
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    const rect = event.currentTarget.getBoundingClientRect()
    onChange({ ...color, saturation: percent((event.clientX - rect.left) / rect.width),
      value: 1 - percent((event.clientY - rect.top) / rect.height) })
  }

  return <>
    <div className="color-wheel" role="slider" aria-label="色相" aria-valuemin={0} aria-valuemax={359}
      aria-valuenow={Math.floor(hue)} tabIndex={0} onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
        event.preventDefault()
        onChange({ ...color, hue: (hue + (['ArrowRight', 'ArrowUp'].includes(event.key) ? 5 : -5) + 360) % 360 })
      }} onPointerDown={selectHue} onPointerMove={selectHue}>
      <div className="wheel-inner" aria-hidden="true" />
      <span className="hue-handle" aria-hidden="true" style={{ left: `${50 + Math.sin(handle) * 45}%`,
        top: `${50 - Math.cos(handle) * 45}%`, backgroundColor: `hsl(${hue} 100% 50%)` }} />
      <div className="color-square" role="slider" aria-label="饱和度与明度" aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={Math.round(saturation * 100)} aria-valuetext={`饱和度 ${Math.round(saturation * 100)}%，明度 ${Math.round(value * 100)}%`}
        tabIndex={0} style={{ backgroundColor: `hsl(${hue} 100% 50%)` }}
        onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
          event.preventDefault()
          event.stopPropagation()
          onChange({ ...color,
            saturation: percent(saturation + (event.key === 'ArrowRight' ? 0.04 : event.key === 'ArrowLeft' ? -0.04 : 0)),
            value: percent(value + (event.key === 'ArrowUp' ? 0.04 : event.key === 'ArrowDown' ? -0.04 : 0)) })
        }} onPointerDown={selectShade} onPointerMove={selectShade}>
        <span aria-hidden="true" style={{ left: `${saturation * 100}%`, top: `${(1 - value) * 100}%`, backgroundColor: hex }} />
      </div>
    </div>
    <div className="color-readout"><span style={{ background: hex }} />{hex}</div>
    <div className="swatches">
      {palette.map((rgb, index) => <button key={index} type="button" style={{ background: `rgb(${rgb.join(',')})` }}
        aria-label={`色板颜色 ${index + 1}`} onClick={() => onChange(rgbToHsv(rgb))} />)}
    </div>
  </>
}
