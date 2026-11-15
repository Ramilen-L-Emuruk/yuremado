// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { LOCALE_SETTINGS, LOCALES, localeFromLanguageTags, type Locale, type Messages } from '../i18n/messages'
import { ja } from '../i18n/messages/ja'
import { en } from '../i18n/messages/en'
import { zhHans } from '../i18n/messages/zhHans'
import { zhHant } from '../i18n/messages/zhHant'
import { ko } from '../i18n/messages/ko'
import { ptBR } from '../i18n/messages/ptBR'
import { es } from '../i18n/messages/es'

/**
 * public/boot-recovery.js（index.html から最初に読む、起動の読み込みの受け皿）を、本物の index.html の
 * 文面と組み合わせて動かす。JS は index.html から素のまま読まれるので、ここでも素のまま評価する。
 */
const SCRIPT = readFileSync('public/boot-recovery.js', 'utf8')
const HTML = readFileSync('index.html', 'utf8')
const TEMPLATE = (() => {
  const m = /<template id="boot-failed">[\s\S]*?<\/template>/.exec(HTML)
  if (m === null) throw new Error('index.html に #boot-failed の文面が無い')
  return m[0]
})()
const TEXT_BLOCK = (() => {
  const m = /<script type="application\/json" id="boot-failed-text">[\s\S]*?<\/script>/.exec(HTML)
  if (m === null) throw new Error('index.html に #boot-failed-text の文面が無い')
  return m[0]
})()
const TEXTS = JSON.parse(TEXT_BLOCK.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '')) as Record<string, { message: string; reload: string }>
const DICTIONARIES: Record<Locale, Messages> = { ja, en, 'zh-Hans': zhHans, 'zh-Hant': zhHant, ko, 'pt-BR': ptBR, es }

interface Recovery {
  markBooted(): { reason: string; failedShown: boolean } | null
  onLateFailure(fn: (reason: string) => void): void
}

/** `settings` は localStorage の 'quake-viewer-settings' に置く値（undefined なら置かない）。`languages` は端末の言語の並び */
function load(storage: Storage | null, env: { settings?: string; languages?: readonly string[] } = { settings: JSON.stringify({ locale: 'ja' }) }) {
  const doc = document.implementation.createHTMLDocument('')
  doc.body.innerHTML = `<div id="root"><p>白い画面</p></div>${TEMPLATE}${TEXT_BLOCK}`
  const target = new EventTarget()
  const reload = vi.fn()
  const local = memoryStorage()
  if (env.settings !== undefined) local.setItem('quake-viewer-settings', env.settings)
  const root = {
    addEventListener: target.addEventListener.bind(target),
    get sessionStorage(): Storage {
      if (storage === null) throw new Error('使えない')
      return storage
    },
    localStorage: local,
    navigator: { languages: env.languages ?? [], language: env.languages?.[0] ?? '' },
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
    t.failLoad(`${window.location.origin}/assets/index-old.js`)
    expect(t.reload).toHaveBeenCalledTimes(1)
  })

  it('読み直した後にもう一度読めなければ、読み直さずに文面を出す（安全弁: 読み直しを繰り返さない）', () => {
    const storage = memoryStorage()
    load(storage).failLoad('/assets/index-old.js')
    const second = load(storage)
    second.failLoad('/assets/index-old.js')
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
    third.failLoad('/assets/index-old.js')
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
    t.failLoad('/other.js')
    t.failLoad('https://cdn.example.test/assets/vendor.js')
    expect(t.reload).not.toHaveBeenCalled()
  })

  it('印を書けない（sessionStorage が使えない）ときは読み直さずに文面を出す', () => {
    const t = load(null)
    t.failLoad('/assets/index-old.js')
    expect(t.reload).not.toHaveBeenCalled()
    expect(t.doc.getElementById('root')?.textContent).toContain('画面を読み込めませんでした')
  })
})

describe('boot-recovery.js の文面の言語', () => {
  /** 印を書けない形で 1 回失敗させ、出た文面と言語を返す */
  function shown(env: { settings?: string; languages?: readonly string[] }) {
    const t = load(null, env)
    t.failLoad('/assets/index-old.js')
    const host = t.doc.getElementById('root')
    return {
      message: host?.querySelector('p')?.textContent,
      reload: host?.querySelector('button')?.textContent,
      lang: host?.firstElementChild?.getAttribute('lang'),
      clickReloads: () => { host?.querySelector('button')?.dispatchEvent(new Event('click')); return t.reload.mock.calls.length },
    }
  }

  it('設定の言語の文面に差し替え、ボタンは押せば読み直す（正）', () => {
    const s = shown({ settings: JSON.stringify({ locale: 'ko' }), languages: ['en-US'] })
    expect(s).toMatchObject({ message: '화면을 불러오지 못했습니다', reload: '다시 불러오기', lang: 'ko' })
    expect(s.clickReloads()).toBe(1)
  })

  it('設定が「端末に合わせる」・保存が無いなら、端末の言語で選ぶ（台湾は繁体、当たらなければ英語）', () => {
    expect(shown({ settings: JSON.stringify({ locale: 'auto' }), languages: ['zh-TW'] })).toMatchObject({ reload: '重新載入', lang: 'zh-Hant' })
    expect(shown({ languages: ['pt-PT'] })).toMatchObject({ reload: 'Recarregar', lang: 'pt-BR' })
    expect(shown({ languages: ['fr-FR', 'de'] })).toMatchObject({ reload: 'Reload', lang: 'en' })
  })

  it('対照: 言語の設定ができる前の保存（locale が無い）と日本語の設定は、日本語のまま', () => {
    expect(shown({ settings: JSON.stringify({ volume: 1 }), languages: ['en-US'] })).toMatchObject({ message: '画面を読み込めませんでした', reload: '再読み込み', lang: 'ja' })
    expect(shown({ settings: JSON.stringify({ locale: 'ja' }), languages: ['en-US'] })).toMatchObject({ reload: '再読み込み', lang: 'ja' })
  })

  it('安全弁: 設定が壊れている・知らない言語の値なら、アプリ（readStoredLocaleSetting）と同じく端末に合わせる', () => {
    expect(shown({ settings: '{', languages: ['es-MX'] })).toMatchObject({ reload: 'Recargar', lang: 'es' })
    expect(shown({ settings: JSON.stringify({ locale: 'xx' }), languages: ['zh-CN'] })).toMatchObject({ reload: '重新加载', lang: 'zh-Hans' })
    expect(shown({ settings: JSON.stringify({ locale: null }), languages: ['en'] })).toMatchObject({ reload: 'Reload', lang: 'en' })
  })

  it('安全弁: 文面の塊が壊れていれば、日本語の文面とボタンのまま出す', () => {
    const t = load(null, { settings: JSON.stringify({ locale: 'ko' }) })
    const block = t.doc.getElementById('boot-failed-text')
    if (block === null) throw new Error('文面の塊が無い')
    block.textContent = '{'
    t.failLoad('/assets/index-old.js')
    expect(t.doc.querySelector('#root p')?.textContent).toBe('画面を読み込めませんでした')
    expect(t.doc.querySelector('#root button')?.textContent).toBe('再読み込み')
  })

  it('JS の中の言語の並びは、アプリの LOCALE_SETTINGS と同じ', () => {
    const m = /var LOCALE_SETTINGS = (\[[^\]]*\])/.exec(SCRIPT)
    if (m === null) throw new Error('boot-recovery.js に LOCALE_SETTINGS が無い')
    expect(JSON.parse(m[1].replace(/'/g, '"'))).toEqual([...LOCALE_SETTINGS])
  })

  it('端末の言語の選び方がアプリ（localeFromLanguageTags）と同じ', () => {
    const cases: string[][] = [['ja-JP'], ['en-GB'], ['ko-KR'], ['es-419'], ['pt-BR'], ['zh-CN'], ['zh-Hans-HK'], ['zh-Hant'], ['zh-HK'], ['zh_MO'], ['zh'], ['fr', 'ko'], ['fr'], []]
    for (const languages of cases) {
      expect(shown({ languages }).lang, languages.join(',')).toBe(localeFromLanguageTags(languages))
    }
  })

  it('文面は日本語以外の 6 言語ぶんあり、ボタンの語は辞書の errorScreen.reload と同じ', () => {
    expect(Object.keys(TEXTS).sort()).toEqual(LOCALES.map((l) => l.id).filter((id) => id !== 'ja').sort())
    for (const [locale, t] of Object.entries(TEXTS)) {
      expect(t.reload, locale).toBe(DICTIONARIES[locale as Locale].errorScreen.reload)
      // 本文は辞書に対応する語が無いので、空でないことだけを見る
      expect(typeof t.message === 'string' && t.message.trim() !== '', locale).toBe(true)
    }
    expect(TEMPLATE).toContain(`>${ja.errorScreen.reload}</button>`)
  })
})
