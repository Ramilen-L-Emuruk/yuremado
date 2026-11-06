import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRelayGate, createRelayTokenStore, relayEndpoint, RelayTokenError, RELAY_API_BASE, RELAY_DATA_BASE, RELAY_PRIVATE_BASE } from './relayEndpoint'

const HOUR = 3_600_000
const RELAY_NOW = Date.parse('2026-10-31T00:00:00Z')

function tokenResponse(over: Record<string, unknown> = {}, opts: { date?: string | null; status?: number } = {}): Response {
  const body = { status: 'ok', token: 'tok-1', expiresAt: new Date(RELAY_NOW + 6 * HOUR).toISOString(), ...over }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const date = opts.date === undefined ? new Date(RELAY_NOW).toUTCString() : opts.date
  if (date !== null) headers.Date = date
  return new Response(JSON.stringify(body), { status: opts.status ?? 200, headers })
}

describe('中継の札', () => {
  let mono = 0
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mono = 1000
    fetchMock = vi.fn(async () => tokenResponse())
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => { vi.unstubAllGlobals() })

  const store = (wallNowMs = RELAY_NOW) => createRelayTokenStore({ origin: 'https://relay.test', nowMs: () => mono, wallNowMs: () => wallNowMs })

  it('正: POST /token で札を取り、期限まで使い回す', async () => {
    const s = store()
    expect(s.current()).toBeNull()
    expect(await s.ensure()).toBe('tok-1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://relay.test/token')
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('POST')
    mono += 5 * HOUR
    expect(await s.ensure()).toBe('tok-1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('対照: 期限の 5 分前を過ぎたら取り直す', async () => {
    const s = store()
    await s.ensure()
    mono += 6 * HOUR - 5 * 60_000
    expect(s.current()).toBeNull()
    fetchMock.mockResolvedValueOnce(tokenResponse({ token: 'tok-2' }))
    expect(await s.ensure()).toBe('tok-2')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('同時に呼んでも POST /token は 1 本にまとめる', async () => {
    const s = store()
    const [a, b, c] = await Promise.all([s.ensure(), s.ensure(), s.ensure()])
    expect([a, b, c]).toEqual(['tok-1', 'tok-1', 'tok-1'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('安全弁: 端末の壁時計がずれていても、中継の Date 見出しから残りの長さを測る', async () => {
    // 端末の時計が 3 時間進んでいる。壁時計で測ると残り 3 時間になるが、中継の今から測れば 6 時間
    const s = store(RELAY_NOW + 3 * HOUR)
    await s.ensure()
    mono += 5 * HOUR
    expect(s.current()).toBe('tok-1')
  })

  it('Date 見出しが無ければ端末の壁時計で代える', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse({}, { date: null }))
    const s = store(RELAY_NOW + 3 * HOUR)
    await s.ensure()
    mono += 3 * HOUR
    expect(s.current()).toBeNull()
  })

  it('断られたら invalidate で捨て、次で取り直す', async () => {
    const s = store()
    await s.ensure()
    s.invalidate()
    expect(s.current()).toBeNull()
    fetchMock.mockResolvedValueOnce(tokenResponse({ token: 'tok-3' }))
    expect(await s.ensure()).toBe('tok-3')
  })

  it('取れなければ RelayTokenError を投げ、次の呼び出しでやり直せる', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 429 }))
    const s = store()
    await expect(s.ensure()).rejects.toBeInstanceOf(RelayTokenError)
    expect(await s.ensure()).toBe('tok-1')
  })

  it.each([
    ['status が ok でない', { status: 'error' }],
    ['token が空', { token: '' }],
    ['expiresAt が読めない', { expiresAt: 'あした' }],
    ['期限がもう近い', { expiresAt: new Date(RELAY_NOW + 60_000).toISOString() }],
  ])('応答の形が違えば投げる（%s）', async (_label, over) => {
    fetchMock.mockResolvedValueOnce(tokenResponse(over))
    await expect(store().ensure()).rejects.toBeInstanceOf(RelayTokenError)
  })
})

describe('中継の札と予報キー', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn(async () => tokenResponse({ forecast: true }))
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => { vi.unstubAllGlobals() })
  const store = () => createRelayTokenStore({ origin: 'https://relay.test', nowMs: () => 1000, wallNowMs: () => RELAY_NOW })
  const authOf = (i: number) => new Headers((fetchMock.mock.calls[i][1] as RequestInit).headers).get('Authorization')

  it('正: 予報キーを Authorization: Forecast で添え、中継の答えを覚える', async () => {
    const s = store()
    s.setForecastKey('f.k', false)
    await s.ensure()
    expect(authOf(0)).toBe('Forecast f.k')
    expect(s.forecastScope()).toEqual({ granted: true, problem: null })
  })

  it('対照: 予報キーが無ければ何も添えず、答えも持たない', async () => {
    const s = store()
    await s.ensure()
    expect(authOf(0)).toBeNull()
    expect(s.forecastScope()).toBeNull()
  })

  it('断られた理由を運ぶ', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse({ forecast: false, forecastProblem: 'signature' }))
    const s = store()
    s.setForecastKey('bad', false)
    await s.ensure()
    expect(s.forecastScope()).toEqual({ granted: false, problem: 'signature' })
  })

  it('安全弁: キーを入れ替えたら札を捨てて取り直し、外したら答えも消す', async () => {
    const s = store()
    const seen: number[] = []
    s.subscribe(() => seen.push(1))
    await s.ensure()
    s.setForecastKey('f.k', false)
    expect(s.current()).toBeNull()
    await s.ensure()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(authOf(1)).toBe('Forecast f.k')
    s.setForecastKey(null, false)
    expect(s.forecastScope()).toBeNull()
    expect(s.current()).toBeNull()
    expect(seen.length).toBeGreaterThanOrEqual(3)
  })

  it('安全弁: 取りに行っている間にキーが変わったら、届いた札を覚えない', async () => {
    let release!: (r: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => { release = r }))
    const s = store()
    s.setForecastKey('old', false)
    const pending = s.ensure()
    s.setForecastKey('new', false)
    release(tokenResponse({ token: 'tok-old', forecast: true }))
    expect(await pending).toBe('tok-old')
    expect(s.current()).toBeNull()
    expect(s.forecastScope()).toBeNull()
  })

  // 正: 予報キーの検証が済むまでは札を取りに行かず、済んだらそのキーを添えて 1 本だけ取る
  it('予報キーの検証中は札を取らずに待ち、済んだキーで取る', async () => {
    const s = store()
    s.setForecastKey(null, true)
    expect(s.forecastKeyChecking()).toBe(true)
    const a = s.ensure()
    const b = s.ensure()
    await Promise.resolve()
    expect(fetchMock).not.toHaveBeenCalled()
    s.setForecastKey('f.k', false)
    expect(await a).toBe('tok-1')
    expect(await b).toBe('tok-1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(authOf(0)).toBe('Forecast f.k')
  })

  // 安全弁: 検証中は手元に使える札があっても渡さない（キーが入ると捨てる札で繋ぐことになる）
  it('検証中は手元の札も渡さず、検証の結果キーが無ければその札を使う', async () => {
    const s = store()
    await s.ensure()
    s.setForecastKey(null, true)
    let settled = false
    const pending = s.ensure().then((t) => { settled = true; return t })
    await Promise.resolve()
    expect(settled).toBe(false)
    s.setForecastKey(null, false)
    expect(await pending).toBe('tok-1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  // 対照: 検証中でなければ待たない
  it('対照: 検証中でなければ待たずに取る', async () => {
    const s = store()
    expect(s.forecastKeyChecking()).toBe(false)
    expect(await s.ensure()).toBe('tok-1')
  })
})

describe('中継の札と使用状況データ', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn(async () => tokenResponse())
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => { vi.unstubAllGlobals() })
  const INSTALL = 'c'.repeat(32)
  const store = () => createRelayTokenStore({ origin: 'https://relay.test', nowMs: () => 1000, wallNowMs: () => RELAY_NOW })
  const init = (i: number) => fetchMock.mock.calls[i][1] as RequestInit

  it('正: 許可している間は、札を取るときに本文 usage へ報告を添える', async () => {
    const s = store()
    s.setUsage(INSTALL, () => ({ install: INSTALL, os: 'ios' }), null)
    await s.ensure()
    expect(JSON.parse(String(init(0).body))).toEqual({ usage: { install: INSTALL, os: 'ios' } })
    expect((init(0).headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(s.usageInstall()).toBe(INSTALL)
  })
  it('安全弁: 許可していなければ本文を付けない', async () => {
    const s = store()
    await s.ensure()
    expect(init(0).body).toBeUndefined()
  })
  it('識別子が変わったら札を捨てて取り直す（オフにしたら識別子の無い札になる）', async () => {
    const s = store()
    const seen: string[] = []
    s.subscribe(() => { seen.push(String(s.usageInstall())) })
    s.setUsage(INSTALL, () => ({ install: INSTALL }), null)
    await s.ensure()
    s.setUsage(null, null, null)
    expect(s.current()).toBeNull()
    await s.ensure()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(init(1).body).toBeUndefined()
    expect(seen).toContain('null')
  })
  it('正: 中継が札を出したら、添えた報告を渡して「送れた」を呼ぶ', async () => {
    const s = store()
    const accepted = vi.fn()
    s.setUsage(INSTALL, () => ({ install: INSTALL, prefs: { a: '1' } }), accepted)
    await s.ensure()
    expect(accepted).toHaveBeenCalledWith({ install: INSTALL, prefs: { a: '1' } }, null)
  })
  it('対照: 札を受け取れなかったときは「送れた」を呼ばない（次の札でもう一度送る）', async () => {
    fetchMock.mockImplementation(async () => new Response('x', { status: 500 }))
    const s = store()
    const accepted = vi.fn()
    s.setUsage(INSTALL, () => ({ install: INSTALL }), accepted)
    await expect(s.ensure()).rejects.toThrow()
    expect(accepted).not.toHaveBeenCalled()
  })
  it('対照: 同じ識別子のまま報告の関数だけ替えても、札は捨てない', async () => {
    const s = store()
    s.setUsage(INSTALL, () => ({ a: 1 }), null)
    await s.ensure()
    s.setUsage(INSTALL, () => ({ a: 2 }), null)
    expect(s.current()).toBe('tok-1')
  })
})

describe('中継の札を待つ呼び手の中断', () => {
  let release!: (r: Response) => void
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn(() => new Promise<Response>((r) => { release = r }))
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => { vi.unstubAllGlobals() })
  const store = () => createRelayTokenStore({ origin: 'https://relay.test', nowMs: () => 1000, wallNowMs: () => RELAY_NOW })

  // 正: 止めた呼び手だけが AbortError で抜ける
  it('止めた呼び手だけが待ちを抜ける', async () => {
    const s = store()
    const first = new AbortController()
    const a = s.ensure(first.signal)
    const b = s.ensure(new AbortController().signal)
    first.abort()
    await expect(a).rejects.toMatchObject({ name: 'AbortError' })
    release(tokenResponse())
    expect(await b).toBe('tok-1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  // 安全弁: 最初の呼び手が止めても、まとめた取得そのものは止まらない（相乗りした接続の札が取れる）
  it('最初の呼び手が止めても、まとめた取得は打ち切られない', async () => {
    const s = store()
    const first = new AbortController()
    const a = s.ensure(first.signal)
    const later = s.ensure()
    first.abort()
    await expect(a).rejects.toMatchObject({ name: 'AbortError' })
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.signal?.aborted ?? false).toBe(false)
    release(tokenResponse())
    expect(await later).toBe('tok-1')
    expect(s.current()).toBe('tok-1')
  })

  // 対照: 既に止まった合図で呼ばれたら、札を取りに行かずに抜ける
  it('既に止まった合図で呼ぶと、取りに行かずに AbortError で抜ける', async () => {
    const s = store()
    const done = new AbortController()
    done.abort()
    await expect(s.ensure(done.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('中継の繋ぎ先', () => {
  it('API には札を付け、本体（公開バケット）には何も付けない', async () => {
    let current: string | null = null
    const ep = relayEndpoint({
      current: () => current,
      ensure: async () => { current = 'tok'; return 'tok' },
      invalidate: () => { current = null },
      setForecastKey: () => {}, forecastKey: () => null, forecastKeyChecking: () => false, forecastScope: () => null, setUsage: () => {}, usageInstall: () => null, subscribe: () => () => {},
    }, createRelayGate())
    expect(ep.apiBase).toBe(RELAY_API_BASE)
    expect(ep.dataBase).toBe(RELAY_DATA_BASE)
    expect(ep.problem()).toBeNull()
    expect(() => ep.apiHeaders()).toThrow(RelayTokenError)
    await ep.prepare()
    expect(ep.apiHeaders()).toEqual({ Authorization: 'Bearer tok' })
    expect(ep.dataHeaders(`${RELAY_DATA_BASE}t/abc`)).toEqual({})
  })

  // 予報の本体と束は中継の口が予報キーの札を確かめて返すので、そこへだけ札を付ける。公開バケットへは付けない
  it('中継の口から返す本体（予報）には札を付け、429 の待ちに並ぶ', async () => {
    let current: string | null = null
    const gate = createRelayGate({ nowMs: () => 0, sleep: async () => {} })
    const ep = relayEndpoint({
      current: () => current,
      ensure: async () => { current = 'tok'; return 'tok' },
      invalidate: () => { current = null },
      setForecastKey: () => {}, forecastKey: () => null, forecastKeyChecking: () => false, forecastScope: () => null, setUsage: () => {}, usageInstall: () => null, subscribe: () => () => {},
    }, gate)
    const privateUrl = `${RELAY_PRIVATE_BASE}t/abc`
    expect(() => ep.dataHeaders(privateUrl)).toThrow(RelayTokenError)
    await ep.prepare()
    expect(ep.dataHeaders(privateUrl)).toEqual({ Authorization: 'Bearer tok' })
    // 待ちは 429 を覚えたときだけ。公開バケットは覚えていても待たない
    const wait = vi.spyOn(gate, 'wait')
    await ep.waitDataSlot(`${RELAY_DATA_BASE}t/abc`)
    expect(wait).not.toHaveBeenCalled()
    await ep.waitDataSlot(privateUrl)
    expect(wait).toHaveBeenCalledTimes(1)
  })

  it('401 で札を捨て、429 で Retry-After を門へ覚えさせる', async () => {
    let current: string | null = 'tok'
    const gate = createRelayGate({ nowMs: () => 0 })
    const ep = relayEndpoint({ current: () => current, ensure: async () => 'tok', invalidate: () => { current = null }, setForecastKey: () => {}, forecastKey: () => null, forecastKeyChecking: () => false, forecastScope: () => null, setUsage: () => {}, usageInstall: () => null, subscribe: () => () => {} }, gate)
    ep.observe(200, null)
    expect(current).toBe('tok')
    ep.observe(401, null)
    expect(current).toBeNull()
    ep.observe(429, new Headers({ 'Retry-After': '30' }))
    expect(gate.remainingMs()).toBe(30_000)
  })
})

describe('中継の門', () => {
  it('正: Retry-After の秒数だけ待たせ、明けたら通す', async () => {
    let mono = 0
    const slept: number[] = []
    const gate = createRelayGate({ nowMs: () => mono, sleep: async (ms) => { slept.push(ms); mono += ms } })
    await gate.wait()
    expect(slept).toEqual([])
    gate.noteRetryAfter(60)
    expect(gate.remainingMs()).toBe(60_000)
    mono += 15_000
    expect(gate.remainingMs()).toBe(45_000)
    await gate.wait()
    expect(slept).toEqual([45_000])
    expect(gate.remainingMs()).toBeNull()
  })
  it('対照: 短い Retry-After で、先に覚えた長い待ちを縮めない', () => {
    const gate = createRelayGate({ nowMs: () => 0 })
    gate.noteRetryAfter(60)
    gate.noteRetryAfter(5)
    expect(gate.remainingMs()).toBe(60_000)
  })
  it('安全弁: 読めない・負の Retry-After は無視する', () => {
    const gate = createRelayGate({ nowMs: () => 0 })
    gate.noteRetryAfter(Number.NaN)
    gate.noteRetryAfter(-3)
    expect(gate.remainingMs()).toBeNull()
  })
})
