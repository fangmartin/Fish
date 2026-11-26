import { useEffect, useRef } from 'react'
import type { Fish } from '../../shared/contracts'
import { drawFishMesh } from './meshRenderer'

export function FishPreview({ fish, stuffed }: { fish: Fish; stuffed: number }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const ctx = canvas.current!.getContext('2d')!
    const image = new Image()
    image.src = fish.assetUrl
    let animation = 0
    function draw(time: number) {
      ctx.clearRect(0, 0, 380, 118)
      const scale = Math.min(157, 78 * Math.max(1, image.naturalWidth / (image.naturalHeight || 1)))
      if (image.complete && image.naturalWidth) drawFishMesh(ctx, image, image.naturalWidth, image.naturalHeight, {
        x: 190, y: 60, size: scale, time: time / 1000, tilt: Math.sin(time / 1050) * 0.047, stuffedStacks: stuffed,
        eyes: fish.eyes,
      })
      animation = requestAnimationFrame(draw)
    }
    animation = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(animation)
  }, [fish.assetUrl, fish.eyes, stuffed])
  return <canvas className="profile-preview" ref={canvas} width={380} height={118} aria-label={`${fish.name}的动态预览`} />
}
