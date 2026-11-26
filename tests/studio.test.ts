import { describe, expect, it } from 'vitest'
import { exportGeometry, getArtworkBounds, mapEyesToExport } from '../src/studio/exportFish'
import { floodFill, hsvToRgb, magicWandErase, rgbToHsv } from '../src/studio/paint'

function paint(pixels: Uint8ClampedArray, width: number, x: number, y: number, color = [20, 50, 80, 210]) {
  pixels.set(color, (y * width + x) * 4)
}

describe('画板导出与纯绘制逻辑', () => {
  it('眼球随原图裁切、缩放及留边后精确映射', () => {
    const bounds = { x: 50, y: 30, width: 200, height: 100 }
    const eye = { x: 90, y: 70, radius: 18, style: 'googly' as const }
    const [scaled] = mapEyesToExport([eye], bounds, 108, 4)
    expect(scaled).toEqual({ x: 24 / 108, y: 24 / 58, radius: 9 / 108, style: eye.style })
    const [native] = mapEyesToExport([eye], bounds)
    expect(native).toEqual({ x: 44 / 208, y: 44 / 108, radius: 18 / 208, style: eye.style })
  })

  it('魔棒只擦除相连的容差内区域，且遵守模板与画布边界', () => {
    const width = 4
    const height = 3
    const pixels = new Uint8ClampedArray(width * height * 4).fill(255)
    const mask = new Uint8ClampedArray(pixels.length).fill(255)
    const alpha = (x: number, y: number) => pixels[(y * width + x) * 4 + 3]
    for (let y = 0; y < height; y++) paint(pixels, width, 2, y, [20, 20, 20, 255])
    paint(pixels, width, 1, 0, [230, 235, 241, 221])
    paint(mask, width, 0, 2, [0, 0, 0, 0])
    expect(magicWandErase(pixels, width, height, { x: 0, y: 0 }, 36, mask)).toBe(true)
    expect([alpha(0, 0), alpha(1, 0), alpha(1, 2)]).toEqual([0, 0, 0])
    expect([alpha(2, 0), alpha(3, 0), alpha(0, 2)]).toEqual([255, 255, 255])
    expect(magicWandErase(pixels, width, height, { x: 0, y: 0 }, 36, mask)).toBe(false)
    expect(magicWandErase(pixels, width, height, { x: 0, y: 2 }, 36, mask)).toBe(false)
    expect(magicWandErase(pixels, width, height, { x: 4, y: 0 }, 36, mask)).toBe(false)
  })

  it('拒绝空画布与少于有效像素门槛的画痕', () => {
    const pixels = new Uint8ClampedArray(100 * 4)
    for (let i = 0; i < pixels.length; i += 4) pixels[i] = 255
    expect(getArtworkBounds(pixels, 10, 10)).toBeNull()
    paint(pixels, 10, 3, 4)
    expect(getArtworkBounds(pixels, 10, 10)).toBeNull()
  })

  it('精确裁掉透明边缘并保留一个小边距', () => {
    const width = 100
    const height = 50
    const pixels = new Uint8ClampedArray(width * height * 4)
    for (let y = 18; y <= 23; y++) {
      for (let x = 17; x <= 34; x++) paint(pixels, width, x, y)
    }
    paint(pixels, width, 41, 30, [0, 0, 0, 1])
    const bounds = getArtworkBounds(pixels, width, height)
    expect(bounds).toEqual({ x: 17, y: 18, width: 25, height: 13 })
    expect(exportGeometry(bounds!)).toEqual({ width: 33, height: 21, padding: 4 })
  })

  it('全画幅、触边笔迹和超长边的比例保持正确', () => {
    const pixels = new Uint8ClampedArray(10 * 10 * 4).fill(255)
    expect(getArtworkBounds(pixels, 10, 10)).toEqual({ x: 0, y: 0, width: 10, height: 10 })
    expect(exportGeometry({ x: 0, y: 10, width: 760, height: 380 }, 388)).toEqual({
      width: 388, height: 198, padding: 4,
    })
  })

  it('填充只经过相连且符合容差的像素，并遵守模板边界', () => {
    const pixels = new Uint8ClampedArray(5 * 4 * 4).fill(255)
    const mask = new Uint8ClampedArray(pixels.length).fill(255)
    for (let y = 0; y < 4; y++) paint(pixels, 5, 2, y, [1, 1, 1, 255])
    paint(pixels, 5, 1, 0, [230, 230, 230, 255])
    paint(mask, 5, 0, 3, [0, 0, 0, 0])
    expect(floodFill(pixels, 5, 4, { x: 0, y: 0 }, [20, 50, 90], 1, 28, mask)).toBe(true)
    expect([...pixels.slice(4, 8)]).toEqual([20, 50, 90, 255])
    expect([...pixels.slice(8, 12)]).toEqual([1, 1, 1, 255])
    expect([...pixels.slice(16, 20)]).toEqual([255, 255, 255, 255])
    expect([...pixels.slice(60, 64)]).toEqual([255, 255, 255, 255])
    expect(floodFill(pixels, 5, 4, { x: 0, y: 3 }, [20, 50, 90], 1, 28, mask)).toBe(false)
  })

  it('HSV 与色板 RGB 可以往返转换', () => {
    const hsv = rgbToHsv([114, 225, 191])
    expect(hsvToRgb(hsv.hue, hsv.saturation, hsv.value)).toEqual([114, 225, 191])
    expect(hsvToRgb(240, 1, 1)).toEqual([0, 0, 255])
    expect(hsvToRgb(0, 0, 0)).toEqual([0, 0, 0])
  })
})
