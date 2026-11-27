const tankImages = new Map<string, HTMLImageElement>()

export function getTankImage(assetUrl: string) {
  const cached = tankImages.get(assetUrl)
  if (cached) return cached
  const image = new Image()
  image.src = assetUrl
  if (document.getElementById('boot-loader')) tankImages.set(assetUrl, image)
  return image
}

function setProgress(percent: number, caption: string) {
  document.getElementById('boot-track')?.setAttribute('aria-valuenow', String(percent))
  const fill = document.getElementById('boot-fill')
  const number = document.getElementById('boot-percent')
  const status = document.getElementById('boot-caption')
  if (fill) fill.style.width = `${percent}%`
  if (number) number.textContent = `${percent}%`
  if (status && status.textContent !== caption) status.textContent = caption
}

export function startBoot() {
  setProgress(30, '脚本已就绪，正在连接水域…')
  const button = document.getElementById('boot-retry')
  if (button) {
    button.hidden = true
    button.onclick = null
  }
}

export function showBootError(message: string, retry: () => void) {
  const caption = document.getElementById('boot-caption')
  const button = document.getElementById('boot-retry')
  if (!caption || !button) return
  caption.textContent = message
  button.textContent = '重试连接'
  button.onclick = retry
  button.hidden = false
}

function settleArtwork(image: HTMLImageElement, signal: AbortSignal) {
  return new Promise<void>(resolve => {
    function settle() {
      image.removeEventListener('load', decode)
      image.removeEventListener('error', settle)
      signal.removeEventListener('abort', settle)
      resolve()
    }

    function decode() {
      if (image.naturalWidth && image.decode) void image.decode().then(settle, settle)
      else settle()
    }

    signal.addEventListener('abort', settle, { once: true })
    if (image.complete) decode()
    else {
      image.addEventListener('load', decode, { once: true })
      image.addEventListener('error', settle, { once: true })
    }
  })
}

export async function finishBoot(assetUrls: readonly string[], signal: AbortSignal) {
  const loader = document.getElementById('boot-loader')
  if (!loader || signal.aborted) return

  if (assetUrls.length) {
    const caption = '正在唤醒鱼群…'
    setProgress(65, caption)
    const artwork = new AbortController()
    const stop = () => artwork.abort()
    signal.addEventListener('abort', stop, { once: true })
    const timeout = window.setTimeout(stop, 2200)
    let settled = 0
    await Promise.all(assetUrls.map(async url => {
      await settleArtwork(getTankImage(url), artwork.signal)
      if (!artwork.signal.aborted) setProgress(65 + Math.floor(++settled * 33 / assetUrls.length), caption)
    }))
    window.clearTimeout(timeout)
    signal.removeEventListener('abort', stop)
  }

  if (signal.aborted) return
  setProgress(100, '进入鱼缸')
  loader.classList.add('is-leaving')
  await new Promise<void>(resolve => window.setTimeout(resolve, 280))
  loader.remove()
  tankImages.clear()
  document.getElementById('root')?.removeAttribute('inert')
}
