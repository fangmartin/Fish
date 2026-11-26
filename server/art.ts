import { inflateSync } from 'node:zlib'
import { PNG } from 'pngjs'
import { MAX_ART_BYTES, MAX_ART_EDGE, MIN_ART_PIXELS } from '../shared/domain'

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const maxEncodedLength = Math.ceil(MAX_ART_BYTES / 3) * 4

function checkInterlacedData(data: Buffer, width: number, height: number) {
  const chunks: Buffer[] = []
  for (let offset = 8; offset + 12 <= data.length;) {
    const length = data.readUInt32BE(offset)
    const start = offset + 8
    const end = start + length
    if (end + 4 > data.length) throw new Error('Truncated PNG chunk')
    if (data.toString('ascii', offset + 4, start) === 'IDAT') chunks.push(data.subarray(start, end))
    offset = end + 4
  }
  // pngjs bounds its non-interlaced inflate. Adam7 also needs a limit before decoding.
  inflateSync(Buffer.concat(chunks), { maxOutputLength: width * height * 8 + height * 4 + 64 })
}

export function parseArtwork(input: unknown) {
  if (typeof input !== 'string') return null
  const base64 = input.replace(/^data:image\/png;base64,/, '')
  if (!base64 || base64.length > maxEncodedLength || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null

  const data = Buffer.from(base64, 'base64')
  if (data.toString('base64') !== base64 || data.length < 33 || data.length > MAX_ART_BYTES ||
      !data.subarray(0, 8).equals(signature) || data.readUInt32BE(8) !== 13 || data.toString('ascii', 12, 16) !== 'IHDR') {
    return null
  }

  const width = data.readUInt32BE(16)
  const height = data.readUInt32BE(20)
  if (!width || !height || width > MAX_ART_EDGE || height > MAX_ART_EDGE) return null

  try {
    if (data[28] === 1) checkInterlacedData(data, width, height)
    const { data: pixels } = PNG.sync.read(data)
    let painted = 0
    let transparent = false
    for (let i = 3; i < pixels.length; i += 4) {
      if (pixels[i] > 0) painted++
      else transparent = true
    }
    return transparent && painted >= MIN_ART_PIXELS ? data : null
  } catch {
    return null
  }
}
