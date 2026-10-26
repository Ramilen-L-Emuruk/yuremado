// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

/**
 * public/boot-recovery.js（index.html から最初に読む、起動の読み込みの受け皿）を、本物の index.html の
 * 文面と組み合わせて動かす。JS は index.html から素のまま読まれるので、ここでも素のまま評価する。
 */
const SCRIPT = readFileSync('public/boot-recovery.js', 'utf8')
const TEMPLATE = (() => {
  const m = /<template id="boot-failed">[\s\S]*?<\/template>/.exec(readFileSync('index.html', 'utf8'))
  if (m === null) throw new Error('index.html に #boot-failed の文面が無い')
  return m[0]
})()

interface Recovery {
  markBooted(): { reason: string; failedShown: boolean } | null
  onLateFailure(fn: (reason: string) => void): void
}

function load(storage: Storage | null) {
  const doc = document.implementation.createHTMLDocument('')
  doc.body.innerHTML = `<div id="root"><p>白い画面</p></div>${TEMPLATE}`
  const target = new EventTarget()
  const reload = vi.fn()
  const root = {
    addEventListener: target.addEventListener.bind(target),
    get sessionStorage(): Storage {
      if (storage === null) throw new Error('使えない')
      return storage
    },
    // jsdom の文書は自分の起点で相対パスを解決するので、同じ起点を名乗る
    location: { reload, href: window.location.href, origin: window.location.origin },
    document: doc,
    __bootRecovery: undefined as Recovery | undefined,
  }
  new Function('window', SCRIPT)(root)
  const failLoad = (src: string) => {
    const el = doc.createElement('script')
    el.src = src
    const ev = new Event('error')
    Object.defineProperty(ev, 'target', { value: el })
    target.dispatchEvent(ev)
  }
  const failImport = (message: string) => {
    const ev = new Event('vite:preloadError')
    Object.assign(ev, { payload: new Error(message) })
    target.dispatchEvent(ev)
  }
  return { root, doc, reload, failLoad, failImport, recovery: () => root.__bootRecovery as Recovery }
}

function memoryStorage(): Storage {
  const m = new Map<string, string>()
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => { m.set(k, String(v)) },
    removeItem: (k) => { m.delete(k) },
    clear: () => m.clear(),
    key: () => null,
    get length() { return m.size },
  }
}

describe('boot-recovery.js', () => {
  it('実行される部分は ASCII だけ（文字コードの指定なしで配られても化けない。コメントは除く）', () => {
    const code = SCRIPT.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    const nonAscii = [...code].filter((c) => c.charCodeAt(0) > 0x7e)
    expect(nonAscii).toEqual([])
  })

  it('起動の途中で自分のファイルが読めなければ、1 回だけ読み直す（正）', () => {
    const t = load(memoryStorage())
    t.failLoad(`${window.location.origin}/yuremado/dmdss/assets/index-old.js`)
    expect(t.reload).toHaveBeenCalledTimes(1)
  })

  it('読み直した後にもう一度読めなければ、読み直さずに文面を出す（安全弁: 読み直しを繰り返さない）', () => {
    const storage = memoryStorage()
    load(storage).failLoad('/yuremado/assets/index-old.js')
    const second = load(storage)
    second.failLoad('/yuremado/assets/index-old.js')
    expect(second.reload).not.toHaveBeenCalled()
    expect(second.doc.getElementById('root')?.textContent).toContain('画面を読み込めませんでした')
    second.doc.querySelector('#root button')?.dispatchEvent(new Event('click'))
    expect(second.reload).toHaveBeenCalledTimes(1)
    // ［再読み込み］の後に起動できたら、文面を出したことが分かる
    expect(load(storage).recovery().markBooted()).toEqual({ reason: expect.stringContaining('index-old.js'), failedShown: true })
  })

  it('起動が終わったら印を消し、読み直したきっかけを返す（次に開いたときはまた 1 回読み直せる）', () => {
    const storage = memoryStorage()
    load(storage).failImport('Failed to fetch dynamically imported module')
    const second = load(storage)
    expect(second.recovery().markBooted()).toEqual({ reason: expect.stringContaining('Failed to fetch'), failedShown: false })
    const third = load(storage)
    expect(third.recovery().markBooted()).toBeNull()
    third.failLoad('/yuremado/assets/index-old.js')
    expect(third.reload).not.toHaveBeenCalled()
  })

  it('起動が終わった後に読めなくても読み直さず、知らせ先へ渡す（対照）', () => {
    const t = load(memoryStorage())
    const late = vi.fn()
    t.recovery().markBooted()
    t.recovery().onLateFailure(late)
    t.failImport('Failed to fetch dynamically imported module')
    expect(t.reload).not.toHaveBeenCalled()
    expect(late).toHaveBeenCalledWith(expect.stringContaining('Failed to fetch'))
  })

  it('自分の配信元の /assets/ の下でなければ拾わない（対照）', () => {
    const t = load(memoryStorage())
    t.failLoad('/yuremado/other.js')
    t.failLoad('https://cdn.example.test/assets/vendor.js')
    expect(t.reload).not.toHaveBeenCalled()
  })

  it('印を書けない（sessionStorage が使えない）ときは読み直さずに文面を出す', () => {
    const t = load(null)
    t.failLoad('/yuremado/assets/index-old.js')
    expect(t.reload).not.toHaveBeenCalled()
    expect(t.doc.getElementById('root')?.textContent).toContain('画面を読み込めませんでした')
  })
})
