import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { finishBoot, getTankImage, showBootError, startBoot } from '../src/bootLoader'

function node() {
  return {
    style: { width: '' }, textContent: '', hidden: true, onclick: null as (() => void) | null,
    setAttribute: vi.fn(), removeAttribute: vi.fn(), remove: vi.fn(), classList: { add: vi.fn() },
  }
}

function bootPage() {
  const nodes = new Map(['loader', 'track', 'fill', 'percent', 'caption', 'retry'].map(id => [`boot-${id}`, node()]))
  nodes.set('root', node())
  const document = { getElementById: (id: string) => nodes.get(id) ?? null }
  const window = { addEventListener: vi.fn(), setTimeout, clearTimeout, setInterval, clearInterval, __FISH_APP_MOUNTED__: false }
  const location = { href: 'https://example.com/?tank=K7M9P2Q4&fish=blue#pond', replace: vi.fn() }
  const storage = new Map<string, string>()

  function runGuard() {
    const html = readFileSync('index.html', 'utf8')
    runInNewContext(html.match(/<script>([\s\S]+?)<\/script>/)?.[1] ?? '', {
      Date, URL, document, window, location,
      sessionStorage: { getItem: storage.get.bind(storage), setItem: storage.set.bind(storage) },
      HTMLScriptElement: class {}, HTMLLinkElement: GuardLink,
    })
  }

  return { nodes, document, window, location, storage, runGuard, element: (id: string) => nodes.get(id)! }
}

class GuardLink {
  href = 'https://example.com/assets/index-old.css'
}

class TestImage extends EventTarget {
  src = ''
  complete = false
  naturalWidth = 0
  decode = vi.fn(async () => {})
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('inline resource recovery', () => {
  it('registers asset failures in capture phase and only reloads once per window', () => {
    const page = bootPage()
    page.runGuard()
    const listener = page.window.addEventListener.mock.calls.find(([type]) => type === 'error')!
    expect(listener[2]).toBe(true)
    listener[1]({ target: new GuardLink() })
    listener[1]({ target: new GuardLink() })
    expect(page.location.replace).toHaveBeenCalledTimes(1)
    const target = page.location.replace.mock.calls[0][0] as URL
    expect(target.searchParams.get('tank')).toBe('K7M9P2Q4')
    expect(target.searchParams.get('fish')).toBe('blue')
    expect(target.searchParams.get('_r')).toBe(String(Date.now()))
    expect(target.hash).toBe('#pond')

    const retry = bootPage()
    retry.location.href = target.href
    retry.runGuard()
    retry.window.addEventListener.mock.calls.find(([type]) => type === 'vite:preloadError')![1]()
    expect(retry.location.replace).not.toHaveBeenCalled()
    expect(retry.element('boot-caption').textContent).toBe('页面资源已更新或网络连接失败')
    expect(retry.element('boot-retry').textContent).toBe('重新加载')
    expect(retry.element('boot-retry').hidden).toBe(false)
    retry.element('boot-retry').onclick?.()
    expect(retry.location.replace).toHaveBeenCalledTimes(1)
  })

  it('caps parsing progress and shows recovery after 10 seconds without a commit', () => {
    const page = bootPage()
    page.runGuard()
    vi.advanceTimersByTime(2000)
    expect(page.element('boot-percent').textContent).toBe('28%')
    expect(page.element('boot-retry').hidden).toBe(true)
    vi.advanceTimersByTime(8000)
    expect(page.element('boot-retry').hidden).toBe(false)

    const mounted = bootPage()
    mounted.runGuard()
    mounted.window.__FISH_APP_MOUNTED__ = true
    vi.advanceTimersByTime(10_000)
    expect(mounted.element('boot-retry').hidden).toBe(true)
  })
})

function mountBootPage() {
  const page = bootPage()
  vi.stubGlobal('window', page.window)
  vi.stubGlobal('document', page.document)
  vi.stubGlobal('Image', TestImage)
  return page
}

describe('React boot milestones', () => {
  it('shows API errors and clears retry state when connecting again', () => {
    const page = mountBootPage()
    const retry = vi.fn(startBoot)
    showBootError('服务暂时无法访问', retry)
    expect(page.element('boot-caption').textContent).toBe('服务暂时无法访问')
    expect(page.element('boot-retry').textContent).toBe('重试连接')
    page.element('boot-retry').onclick?.()
    expect(retry).toHaveBeenCalledTimes(1)
    expect(page.element('boot-percent').textContent).toBe('30%')
    expect(page.element('boot-retry').hidden).toBe(true)
  })

  it('counts decoded and failed artwork and waits for the fade before releasing the app', async () => {
    const page = mountBootPage()
    const image = getTankImage('/first.png') as unknown as TestImage
    const rejected = getTankImage('/broken.png') as unknown as TestImage
    let finishDecode!: () => void
    image.decode.mockImplementation(() => new Promise(resolve => { finishDecode = resolve }))
    const done = finishBoot(['/first.png', '/broken.png'], new AbortController().signal)
    expect(page.element('boot-percent').textContent).toBe('65%')
    image.naturalWidth = 48
    image.dispatchEvent(new Event('load'))
    expect(image.decode).toHaveBeenCalledTimes(1)
    rejected.dispatchEvent(new Event('error'))
    await vi.advanceTimersByTimeAsync(0)
    expect(page.element('boot-percent').textContent).toBe('81%')
    finishDecode()
    await vi.advanceTimersByTimeAsync(0)
    expect(page.element('boot-track').setAttribute).toHaveBeenCalledWith('aria-valuenow', '98')
    expect(page.element('boot-percent').textContent).toBe('100%')
    expect(page.element('root').removeAttribute).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(280)
    await done
    expect(page.element('boot-loader').remove).toHaveBeenCalledTimes(1)
    expect(page.element('root').removeAttribute).toHaveBeenCalledWith('inert')
  })

  it('uses a 2200ms cap for hung artwork and enters empty tanks immediately', async () => {
    const page = mountBootPage()
    const done = finishBoot(['/hanging.png'], new AbortController().signal)
    await vi.advanceTimersByTimeAsync(2199)
    expect(page.element('boot-percent').textContent).toBe('65%')
    await vi.advanceTimersByTimeAsync(1)
    expect(page.element('boot-percent').textContent).toBe('100%')
    await vi.advanceTimersByTimeAsync(280)
    await done

    const empty = mountBootPage()
    const entered = finishBoot([], new AbortController().signal)
    expect(empty.element('boot-percent').textContent).toBe('100%')
    expect(empty.element('boot-track').setAttribute).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(280)
    await entered
  })

  it('does not complete the splash for an aborted attempt', async () => {
    const page = mountBootPage()
    const controller = new AbortController()
    const done = finishBoot(['/stale-attempt.png'], controller.signal)
    controller.abort()
    await done
    await vi.advanceTimersByTimeAsync(2480)
    expect(page.element('boot-percent').textContent).toBe('65%')
    expect(page.element('boot-loader').remove).not.toHaveBeenCalled()
  })
})
