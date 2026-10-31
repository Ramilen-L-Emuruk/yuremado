// 旧 URL の橋渡しのページ（bridge/handoff.js）と、新しいアプリの受け手（src/utils/settingsHandoff.ts）の往復。
// 2 つは別々に配られるので、形がずれると設定が黙って届かなくなる。ここで対にして固定する。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  buildHandoffUrl, HANDOFF_PREFIX, hasSettingsToCarry, isOldAppRegistration, NEW_APP_URL, readOldSettings,
} from '../bridge/handoff.js'
import {
  BRIDGE_ORIGIN,
  consumeSettingsHandoff,
  decodeSettingsHandoff,
  SETTINGS_HANDOFF_PREFIX,
  type HandoffEnv,
} from '../src/utils/settingsHandoff'

function storageOf(entries: Record<string, string>): Pick<Storage, 'getItem' | 'setItem'> & { data: Map<string, string> } {
  const data = new Map(Object.entries(entries))
  return {
    data,
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value) },
  }
}

function hashOf(url: string): string {
  return url.slice(NEW_APP_URL.length)
}

describe('橋渡しの形', () => {
  it('# の目印は橋渡しと受け手で同じ', () => {
    expect(HANDOFF_PREFIX).toBe(SETTINGS_HANDOFF_PREFIX)
  })

  it('設定が無ければ素の URL を返す', () => {
    expect(buildHandoffUrl(null)).toBe(NEW_APP_URL)
  })
})

describe('旧アドレスの設定の読み方', () => {
  it('DMDSS 版の設定があればそれを先に採る', () => {
    const storage = storageOf({
      'quake-viewer-settings': JSON.stringify({ minDisplayScale: 1 }),
      'quake-viewer-settings-dmdss': JSON.stringify({ minDisplayScale: 3 }),
    })
    expect(readOldSettings(storage)).toEqual({ minDisplayScale: 3 })
  })

  it('DMDSS 版が無ければ標準版を採る', () => {
    const storage = storageOf({ 'quake-viewer-settings': JSON.stringify({ minDisplayScale: 1 }) })
    expect(readOldSettings(storage)).toEqual({ minDisplayScale: 1 })
  })

  it('DMDSS 版が壊れていれば標準版を採る', () => {
    const storage = storageOf({
      'quake-viewer-settings': JSON.stringify({ minDisplayScale: 1 }),
      'quake-viewer-settings-dmdss': '{壊れた',
    })
    expect(readOldSettings(storage)).toEqual({ minDisplayScale: 1 })
  })

  it('どちらも無ければ null', () => {
    expect(readOldSettings(storageOf({}))).toBeNull()
  })
})

describe('往復', () => {
  const old = {
    minDisplayScale: 3,
    voicevoxUrl: 'http://例.local:50021',
    dmdataApiKey: 'AKe.秘密',
    arrivalToken: 'tok.秘密',
    forecastKey: 'fc.秘密',
  }

  it('鍵以外の設定は日本語を含めてそのまま届き、鍵は届かない', () => {
    const url = buildHandoffUrl(old)
    expect(url).not.toContain('秘密')
    const handoff = decodeSettingsHandoff(hashOf(url))
    expect(handoff).toEqual({ settings: { minDisplayScale: 3, voicevoxUrl: 'http://例.local:50021' }, hadApiKey: true })
  })

  it('API キーが空なら入れ直しの案内は立てない', () => {
    const handoff = decodeSettingsHandoff(hashOf(buildHandoffUrl({ minDisplayScale: 1, dmdataApiKey: '' })))
    expect(handoff?.hadApiKey).toBe(false)
  })

  it('受け手が鍵の欄を受け取っても外す（橋渡し側を経ずに作られた URL でも）', () => {
    const json = JSON.stringify({ v: 1, settings: { dmdataApiKey: 'x', arrivalToken: 'y', forecastKey: 'z', minDisplayScale: 2 }, hadApiKey: true })
    const hash = SETTINGS_HANDOFF_PREFIX + btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(decodeSettingsHandoff(hash)?.settings).toEqual({ minDisplayScale: 2 })
  })
})

describe('受け取り', () => {
  const KEY = 'quake-viewer-settings'

  function env(hash: string, storage: Pick<Storage, 'getItem' | 'setItem'>, referrer = `${BRIDGE_ORIGIN}/yuremado/`) {
    let cleared = 0
    const e: HandoffEnv = { hash, clearHash: () => { cleared++ }, storage, storageKey: KEY, referrer }
    return { e, cleared: () => cleared }
  }

  it('正: 新しいアドレスに保存が無ければ保存し、鍵の入れ直しの印を立てる', () => {
    const storage = storageOf({})
    const { e, cleared } = env(hashOf(buildHandoffUrl({ minDisplayScale: 3, dmdataApiKey: 'k' })), storage)
    expect(consumeSettingsHandoff(e)).toBe('applied')
    expect(JSON.parse(storage.data.get(KEY)!)).toEqual({ minDisplayScale: 3, dmdataKeyReentryNotice: true })
    expect(cleared()).toBe(1)
  })

  it('対照: 新しいアドレスに保存があれば上書きしない（2026-10-31 ユーザー選択「上書きしない」）', () => {
    const storage = storageOf({ [KEY]: JSON.stringify({ minDisplayScale: 5 }) })
    const { e, cleared } = env(hashOf(buildHandoffUrl({ minDisplayScale: 3 })), storage)
    expect(consumeSettingsHandoff(e)).toBe('kept')
    expect(JSON.parse(storage.data.get(KEY)!)).toEqual({ minDisplayScale: 5 })
    expect(cleared()).toBe(1)
  })

  it('安全弁: 読めない # は保存せず、# だけ消す', () => {
    const storage = storageOf({})
    const { e, cleared } = env(SETTINGS_HANDOFF_PREFIX + '@@@', storage)
    expect(consumeSettingsHandoff(e)).toBe('invalid')
    expect(storage.data.size).toBe(0)
    expect(cleared()).toBe(1)
  })

  it('安全弁: 渡された設定の無い # には触れない', () => {
    const storage = storageOf({})
    const { e, cleared } = env('#other', storage)
    expect(consumeSettingsHandoff(e)).toBe('none')
    expect(cleared()).toBe(0)
  })

  // 誰でも作れるリンクで設定を差し込めないよう、案内のページから来たときだけ受け取る（2026-10-31 ユーザー決定「来た元を確かめる」）
  it('正: 案内のページの生成元から来たなら保存する（DMDSS 版の案内のページからも）', () => {
    const storage = storageOf({})
    const { e } = env(hashOf(buildHandoffUrl({ minDisplayScale: 3 })), storage, `${BRIDGE_ORIGIN}/yuremado/dmdss/`)
    expect(consumeSettingsHandoff(e)).toBe('applied')
    expect(JSON.parse(storage.data.get(KEY)!)).toEqual({ minDisplayScale: 3, dmdataKeyReentryNotice: false })
  })

  it('対照: 違う生成元から来たら保存せず、# は消す', () => {
    const storage = storageOf({})
    const { e, cleared } = env(hashOf(buildHandoffUrl({ voicevoxUrl: 'http://悪い.example:50021' })), storage, 'https://example.github.io/yuremado/')
    expect(consumeSettingsHandoff(e)).toBe('foreign')
    expect(storage.data.size).toBe(0)
    expect(cleared()).toBe(1)
  })

  it('対照: 来た元が届かない（空）なら保存せず、# は消す', () => {
    const storage = storageOf({})
    const { e, cleared } = env(hashOf(buildHandoffUrl({ minDisplayScale: 3 })), storage, '')
    expect(consumeSettingsHandoff(e)).toBe('foreign')
    expect(storage.data.size).toBe(0)
    expect(cleared()).toBe(1)
  })

  it('対照: 生成元が前方一致するだけの別の生成元は受け取らない', () => {
    const storage = storageOf({})
    const { e } = env(hashOf(buildHandoffUrl({ minDisplayScale: 3 })), storage, `${BRIDGE_ORIGIN}.example.com/yuremado/`)
    expect(consumeSettingsHandoff(e)).toBe('foreign')
    expect(storage.data.size).toBe(0)
  })

  it('安全弁: 案内のページから来ても、保存が既にあれば kept のまま', () => {
    const storage = storageOf({ [KEY]: JSON.stringify({ minDisplayScale: 5 }) })
    const { e } = env(hashOf(buildHandoffUrl({ minDisplayScale: 3 })), storage)
    expect(consumeSettingsHandoff(e)).toBe('kept')
    expect(JSON.parse(storage.data.get(KEY)!)).toEqual({ minDisplayScale: 5 })
  })
})

describe('案内のページの生成元', () => {
  it('README に書いた以前のアドレスと同じ', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf-8')
    expect(readme).toContain(`${BRIDGE_ORIGIN}/yuremado/`)
  })

  it('案内のページのリンクは生成元を必ず届ける', () => {
    const html = readFileSync(new URL('../bridge/index.html', import.meta.url), 'utf-8')
    expect(html).toMatch(/<a id="go"[^>]*referrerpolicy="origin"/)
  })
})

describe('引き継ぐ設定があるか（案内のページの文の出し分け）', () => {
  it('正: 鍵以外の欄が 1 つでもあれば引き継ぐ', () => {
    expect(hasSettingsToCarry({ minDisplayScale: 3, dmdataApiKey: 'k' })).toBe(true)
  })

  it('対照: 設定が無い・空・鍵だけ・中身の無い値だけなら引き継がない', () => {
    expect(hasSettingsToCarry(null)).toBe(false)
    expect(hasSettingsToCarry({})).toBe(false)
    expect(hasSettingsToCarry({ dmdataApiKey: 'k', arrivalToken: 't', forecastKey: 'f' })).toBe(false)
    expect(hasSettingsToCarry({ minDisplayScale: null })).toBe(false)
  })

  it('安全弁: 偽や 0 や空文字も利用者が選んだ値なので引き継ぐ', () => {
    expect(hasSettingsToCarry({ soundEnabled: false })).toBe(true)
    expect(hasSettingsToCarry({ minDisplayScale: 0 })).toBe(true)
    expect(hasSettingsToCarry({ voicevoxUrl: '' })).toBe(true)
  })
})

describe('旧アプリの Service Worker の登録だけを外す', () => {
  it('正: /yuremado/ 以下の登録は外す', () => {
    expect(isOldAppRegistration(`${BRIDGE_ORIGIN}/yuremado/`)).toBe(true)
    expect(isOldAppRegistration(`${BRIDGE_ORIGIN}/yuremado/dmdss/`)).toBe(true)
  })

  it('対照: 同じ生成元の別のアプリの登録は外さない', () => {
    expect(isOldAppRegistration(`${BRIDGE_ORIGIN}/`)).toBe(false)
    expect(isOldAppRegistration(`${BRIDGE_ORIGIN}/other-app/`)).toBe(false)
    expect(isOldAppRegistration(`${BRIDGE_ORIGIN}/yuremado-next/`)).toBe(false)
  })

  it('安全弁: 読めない scope は外さない', () => {
    expect(isOldAppRegistration('壊れた')).toBe(false)
  })
})

describe('旧アプリのキャッシュだけを消す（bridge/sw.js）', () => {
  /** sw.js を偽の `self`・`caches` の上で動かし、activate で消された名前を返す */
  async function activateWith(names: string[]): Promise<{ deleted: string[]; unregistered: boolean }> {
    const src = readFileSync(new URL('../bridge/sw.js', import.meta.url), 'utf-8')
    const listeners = new Map<string, (ev: unknown) => void>()
    const deleted: string[] = []
    let unregistered = false
    const self = {
      location: { origin: BRIDGE_ORIGIN },
      addEventListener: (type: string, fn: (ev: unknown) => void) => { listeners.set(type, fn) },
      skipWaiting: () => {},
      registration: { unregister: async () => { unregistered = true; return true } },
      clients: { matchAll: async () => [] },
    }
    const caches = {
      keys: async () => names,
      delete: async (name: string) => { deleted.push(name); return true },
    }
    new Function('self', 'caches', src)(self, caches)
    let done: Promise<unknown> = Promise.resolve()
    listeners.get('activate')!({ waitUntil: (p: Promise<unknown>) => { done = p } })
    await done
    return { deleted, unregistered }
  }

  it('正: 旧アプリが作った名前（事前キャッシュと実行時キャッシュ）は消し、自分の登録を外す', async () => {
    const old = [
      `workbox-precache-v2-${BRIDGE_ORIGIN}/yuremado/`,
      `workbox-precache-v2-${BRIDGE_ORIGIN}/yuremado/dmdss/`,
      'p2pquake-history', 'map-tiles',
      'generated-data-standard', 'generated-data-dmdss',
      'bathymetry-tiles-standard', 'bathymetry-tiles-dmdss',
    ]
    const got = await activateWith(old)
    expect(got.deleted.sort()).toEqual([...old].sort())
    expect(got.unregistered).toBe(true)
  })

  it('対照: 同じ生成元の別のアプリのキャッシュは消さない', async () => {
    const got = await activateWith([
      `workbox-precache-v2-${BRIDGE_ORIGIN}/other-app/`,
      `workbox-precache-v2-${BRIDGE_ORIGIN}/yuremado-next/`,
      'other-app-data',
    ])
    expect(got.deleted).toEqual([])
    expect(got.unregistered).toBe(true)
  })
})
