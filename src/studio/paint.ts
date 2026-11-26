export type Point = { x: number; y: number }
export type RGB = [number, number, number]

function editConnectedPixels(
  pixels: Uint8ClampedArray, width: number, height: number, point: Point, tolerance: number,
  mask: Uint8ClampedArray | undefined, shouldEdit: (target: Uint8ClampedArray) => boolean,
  edit: (offset: number) => void,
) {
  const x = Math.floor(point.x)
  const y = Math.floor(point.y)
  if (x < 0 || y < 0 || x >= width || y >= height) return false
  const first = y * width + x
  if (mask && mask[first * 4 + 3] < 128) return false
  const target = pixels.slice(first * 4, first * 4 + 4)
  if (!shouldEdit(target)) return false

  const pending = new Int32Array(width * height)
  const visited = new Uint8Array(width * height)
  let end = 0
  function visit(index: number) {
    if (visited[index]) return
    visited[index] = 1
    const start = index * 4
    if (mask && mask[start + 3] < 128) return
    for (let channel = 0; channel < 4; channel++) {
      if (Math.abs(pixels[start + channel] - target[channel]) > tolerance) return
    }
    pending[end++] = index
  }

  visit(first)
  for (let cursor = 0; cursor < end; cursor++) {
    const index = pending[cursor]
    edit(index * 4)
    const column = index % width
    if (column > 0) visit(index - 1)
    if (column < width - 1) visit(index + 1)
    if (index >= width) visit(index - width)
    if (index < width * (height - 1)) visit(index + width)
  }
  return end > 0
}

export function floodFill(
  pixels: Uint8ClampedArray, width: number, height: number, point: Point, color: RGB,
  opacity: number, tolerance: number, mask?: Uint8ClampedArray,
) {
  return editConnectedPixels(pixels, width, height, point, tolerance, mask,
    target => !(target[3] === 255 && color.every((value, index) => target[index] === value)),
    start => {
      const alpha = opacity * (mask ? mask[start + 3] / 255 : 1)
      const original = pixels[start + 3] / 255
      const covered = alpha + original * (1 - alpha)
      for (let channel = 0; channel < 3; channel++) {
        pixels[start + channel] = (color[channel] * alpha + pixels[start + channel] * original * (1 - alpha)) / covered
      }
      pixels[start + 3] = covered * 255
    })
}

export function magicWandErase(
  pixels: Uint8ClampedArray, width: number, height: number, point: Point, tolerance: number, mask?: Uint8ClampedArray,
) {
  return editConnectedPixels(pixels, width, height, point, tolerance, mask, target => target[3] > 0,
    offset => { pixels[offset + 3] = 0 })
}

export function hsvToRgb(hue: number, saturation: number, value: number): RGB {
  const channel = (n: number) => {
    const k = (n + hue / 60) % 6
    return Math.round(255 * (value - value * saturation * Math.max(0, Math.min(k, 4 - k, 1))))
  }
  return [channel(5), channel(3), channel(1)]
}

export function rgbToHsv([r, g, b]: RGB) {
  const max = Math.max(r, g, b)
  const delta = max - Math.min(r, g, b)
  const hue = delta === 0 ? 0 : max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4
  return { hue: (hue * 60 + 360) % 360, saturation: max ? delta / max : 0, value: max / 255 }
}
