import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createRelayTokenStore } from './relayEndpoint'
import {
  USAGE_INSTALL_KEY, buildUsageReport, classifyUserAgent, countUsage, createUsageCounter, flushUsage, formFactor, setUsageCounting,
  syncInstallId, usageCounter, withUsageCount, prefsToSend, markPrefsSent, USAGE_PREFS_SENT_KEY, usageDay,
} from './usageStats'

function memoryStorage() {
  const m = new Map<string, string>()
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v) },
    removeItem: (k: string) => { m.delete(k) },
  }
}

describe('classifyUserAgent', () => {
  const cases: [string, number, string, string][] = [
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 0, 'windows', 'chrome'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0', 0, 'windows', 'edge'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', 5, 'ios', 'safari'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', 0, 'mac', 'safari'],
    ['Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36', 5, 'android', 'chrome'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0', 0, 'linux', 'firefox'],
  ]
  for (const [ua, touch, os, browser] of cases) {
    it(`${os} / ${browser}`, () => expect(classifyUserAgent(ua, touch)).toEqual({ os, browser }))
  }
  it('iPad の Safari は Mac と名乗るので、触れる点があれば iOS とみなす', () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
    expect(classifyUserAgent(ua, 5).os).toBe('ios')
  })
  it('分からなければ other', () => expect(classifyUserAgent('curl/8', 0)).toEqual({ os: 'other', browser: 'other' }))
})

describe('formFactor', () => {
  it('短い辺で分ける（向きを変えても同じ）', () => {
    expect(formFactor(390, 844)).toBe('phone')
    expect(formFactor(844, 390)).toBe('phone')
    expect(formFactor(820, 1180)).toBe('tablet')
    expect(formFactor(1920, 1080)).toBe('desktop')
  })
})

describe('syncInstallId', () => {
  it('正: 許可したら識別子を作って保存し、次も同じものを返す', () => {
    const s = memoryStorage()
    const id = syncInstallId(true, s)
    expect(id).toMatch(/^[0-9a-f]{32}$/)
    expect(syncInstallId(true, s)).toBe(id)
  })
  it('安全弁: 許可しなければ消して null を返す（オフにした端末に識別子を残さない）', () => {
    const s = memoryStorage()
    syncInstallId(true, s)
    expect(syncInstallId(false, s)).toBeNull()
    expect(s.m.has(USAGE_INSTALL_KEY)).toBe(false)
  })
  it('形の違う値が残っていれば作り直す', () => {
    const s = memoryStorage()
    s.m.set(USAGE_INSTALL_KEY, 'bad')
    expect(syncInstallId(true, s)).toMatch(/^[0-9a-f]{32}$/)
  })
})

describe('buildUsageReport', () => {
  it('識別子・版・端末の種類・設定の使い方だけを載せる', () => {
    const r = buildUsageReport('a'.repeat(32), { apiKey: true, tts: false, sound: true, notify: false, seismo: false }, { soundVolume: '0.5' }, {
      version: '6.2.0', standalone: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1',
      maxTouchPoints: 5, screenWidth: 390, screenHeight: 844, language: 'ja',
    })
    expect(r).toEqual({
      install: 'a'.repeat(32), version: '6.2.0', standalone: true, os: 'ios', browser: 'safari', form: 'phone', lang: 'ja',
      settings: { apiKey: true, tts: false, sound: true, notify: false, seismo: false }, prefs: { soundVolume: '0.5' },
    })
  })
})

describe('数え手', () => {
  afterEach(() => setUsageCounting(false))
  it('正: 許可している間だけ数える', () => {
    setUsageCounting(true)
    countUsage('tab:earthquake')
    countUsage('tab:earthquake')
    countUsage('share')
    expect(usageCounter.take()).toEqual({ 'tab:earthquake': 2, share: 1 })
    expect(usageCounter.take()).toBeNull()
  })
  it('安全弁: 許可していなければ数えず、オフにしたら数えた分も捨てる', () => {
    countUsage('share')
    expect(usageCounter.take()).toBeNull()
    setUsageCounting(true)
    countUsage('share')
    setUsageCounting(false)
    expect(usageCounter.take()).toBeNull()
  })
  it('withUsageCount: 手を呼ぶたびに 1 回数え、元の手の戻り値を返す', () => {
    setUsageCounting(true)
    const h = withUsageCount('test', { a: () => 1, b: (x: never) => x })
    expect(h.a()).toBe(1)
    h.b(undefined as never)
    expect(usageCounter.take()).toEqual({ test: 2 })
  })
})

describe('flushUsage', () => {
  const INSTALL = 'b'.repeat(32)
  // 戻すのは数えている間だけ（許可を外した後に戻すと、次の識別子へ混ざる）
  beforeEach(() => setUsageCounting(true))
  afterEach(() => setUsageCounting(false))
  async function storeWithToken(install: string | null) {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ status: 'ok', token: 't1', expiresAt: '2099-01-01T00:00:00Z' })))
    vi.stubGlobal('fetch', fetcher)
    const store = createRelayTokenStore({ origin: 'https://relay.test', wallNowMs: () => Date.parse('2026-11-03T00:00:00Z') })
    store.setUsage(install, install === null ? null : () => ({ install }), null)
    await store.ensure()
    vi.unstubAllGlobals()
    return store
  }
  it('正: 識別子入りの札で、数えた分を本文にして送る', async () => {
    const store = await storeWithToken(INSTALL)
    const c = createUsageCounter()
    c.count('share')
    const send = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 204 }))
    await flushUsage(c, store, send as unknown as typeof fetch)
    expect(send).toHaveBeenCalledTimes(1)
    const [url, init] = send.mock.calls[0]
    expect(url).toBe('https://relay.yuremado.com/usage')
    expect(JSON.parse(String(init.body))).toEqual({ counts: { share: 1 } })
    expect(c.take()).toBeNull()
  })
  it('安全弁: 許可していない（識別子の無い）札では送らず、数えた分も捨てる', async () => {
    const store = await storeWithToken(null)
    const c = createUsageCounter()
    c.count('share')
    const send = vi.fn()
    await flushUsage(c, store, send as unknown as typeof fetch)
    expect(send).not.toHaveBeenCalled()
    expect(c.take()).toBeNull()
  })
  it('安全弁: 許可を外した後は、送れなかった分を戻さない', async () => {
    const store = await storeWithToken(INSTALL)
    const c = createUsageCounter()
    c.count('share')
    setUsageCounting(false)
    await flushUsage(c, store, (async () => new Response(null, { status: 503 })) as unknown as typeof fetch)
    expect(c.take()).toBeNull()
  })
  it('札が切れていたら取り直してから送る', async () => {
    const store = await storeWithToken(INSTALL)
    store.invalidate()
    const send = vi.fn(async (url: string) => (String(url).endsWith('/token')
      ? new Response(JSON.stringify({ status: 'ok', token: 't2', expiresAt: '2099-01-01T00:00:00Z' }))
      : new Response(null, { status: 204 })))
    vi.stubGlobal('fetch', send)
    const c = createUsageCounter()
    c.count('test')
    await flushUsage(c, store, send as unknown as typeof fetch)
    vi.unstubAllGlobals()
    const usageCall = send.mock.calls.find(([u]) => String(u).endsWith('/usage'))
    expect(usageCall).toBeDefined()
    expect(c.take()).toBeNull()
  })
  it('届かなかった（通信の失敗・429・5xx）分は次の回へ戻し、断られた分は戻さない', async () => {
    const store = await storeWithToken(INSTALL)
    for (const [res, kept] of [[new Response(null, { status: 503 }), true], [new Response(null, { status: 403 }), false]] as const) {
      const c = createUsageCounter()
      c.count('test')
      await flushUsage(c, store, (async () => res) as unknown as typeof fetch)
      expect(c.take() !== null).toBe(kept)
    }
    const c = createUsageCounter()
    c.count('test')
    await flushUsage(c, store, (async () => { throw new TypeError('切れた') }) as unknown as typeof fetch)
    expect(c.take()).toEqual({ test: 1 })
  })
})

describe('設定の全項目は、変わったときと 1 日 1 回だけ送る', () => {
  const ID = 'a'.repeat(32)
  const T = Date.parse('2026-11-05T03:00:00Z') // 日本時間 12:00
  const prefs = { soundVolume: '0.5', notifyEnabled: '1' }
  it('正: 送れたあと同じ日に同じ値なら空にする', () => {
    const s = memoryStorage()
    expect(prefsToSend(ID, prefs, T, s)).toEqual(prefs)
    markPrefsSent(ID, { prefs }, 2, usageDay(T), s)
    expect(prefsToSend(ID, prefs, T + 3 * 3600_000, s)).toEqual({})
  })
  it('正: 値が変わった・日本時間の日が替わった・識別子が変わったときは送る', () => {
    const s = memoryStorage()
    markPrefsSent(ID, { prefs }, 2, usageDay(T), s)
    expect(prefsToSend(ID, { ...prefs, soundVolume: '0.6' }, T, s)).toEqual({ ...prefs, soundVolume: '0.6' })
    expect(prefsToSend(ID, prefs, Date.parse('2026-11-05T15:00:00Z'), s)).toEqual(prefs) // 日本時間 11-06 0:00
    expect(prefsToSend('b'.repeat(32), prefs, T, s)).toEqual(prefs)
  })
  it('対照: 送れていない（札を受け取れなかった）間は、何度でも送る', () => {
    const s = memoryStorage()
    expect(prefsToSend(ID, prefs, T, s)).toEqual(prefs)
    expect(prefsToSend(ID, prefs, T + 60_000, s)).toEqual(prefs)
  })
  it('安全弁: 設定を添えていない報告（同じ日に送り済み）は控えを書き換えない。オフにすると控えも消える', () => {
    const s = memoryStorage()
    markPrefsSent(ID, { prefs }, 2, usageDay(T), s)
    markPrefsSent(ID, { prefs: {} }, 0, usageDay(T + 86400_000), s)
    expect(prefsToSend(ID, prefs, T, s)).toEqual({})
    syncInstallId(false, s)
    expect(s.m.has(USAGE_PREFS_SENT_KEY)).toBe(false)
  })
  it('対照: 中継が記録できた件数が送った件数と揃わなければ控えない（記録を切ってある・捨てた・前の版の中継）', () => {
    const s = memoryStorage()
    markPrefsSent(ID, { prefs }, 1, usageDay(T), s)
    markPrefsSent(ID, { prefs }, null, usageDay(T), s)
    markPrefsSent(ID, { prefs }, 0, usageDay(T), s)
    expect(prefsToSend(ID, prefs, T, s)).toEqual(prefs)
  })
  it('安全弁: 控えが壊れていても送る側へ倒す', () => {
    const s = memoryStorage()
    s.m.set(USAGE_PREFS_SENT_KEY, '{')
    expect(prefsToSend(ID, prefs, T, s)).toEqual(prefs)
  })
})
