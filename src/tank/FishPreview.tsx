import { useEffect, useRef } from 'react'
import type { Fish } from '../../shared/contracts'
import type { BellyOverload } from '../../shared/domain'
import { drawFishMesh, fishWaveSpeed } from './meshRenderer'

export function FishPreview({ fish, bellyFillRatio, bellyOverload }: {
  fish: Fish; bellyFillRatio: number; bellyOverload: BellyOverload
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const current = useRef({ fish, bellyFillRatio, bellyOverload })
  useEffect(() => { current.current = { fish, bellyFillRatio, bellyOverload } }, [fish, bellyFillRatio, bellyOverload])
  useEffect(() => {
    const ctx = canvas.current!.getContext('2d')!
    const image = new Image()
    image.src = fish.assetUrl
    let animation = 0
    let previous = 0
    let wavePhase = 0
    function draw(time: number) {
      const { fish, bellyFillRatio, bellyOverload } = current.current
      if (previous) wavePhase += Math.min(0.034, (time - previous) / 1000) * fishWaveSpeed(false, bellyFillRatio, bellyOverload)
      previous = time
      ctx.clearRect(0, 0, 380, 118)
      const size = Math.min(157, 65 * Math.max(1, image.naturalWidth / (image.naturalHeight || 1)))
      if (image.complete && image.naturalWidth) drawFishMesh(ctx, image, image.naturalWidth, image.naturalHeight, {
        x: 190, y: 60, size, time: time / 1000, wavePhase, tilt: Math.sin(time / 1050) * 0.047,
        bellyFillRatio, bellyOverload, isEmperor: fish.stage === 'emperor', eyes: fish.eyes,
      })
      animation = requestAnimationFrame(draw)
    }
    animation = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(animation)
  }, [fish.assetUrl])
  return <canvas className="profile-preview" ref={canvas} width={380} height={118} aria-label={`${fish.name}的动态预览`} />
}
