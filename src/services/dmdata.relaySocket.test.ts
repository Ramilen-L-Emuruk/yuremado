// @vitest-environment jsdom
//
// 中継（yuremado-relay）の WebSocket へ繋ぐ形（docs/relay-server-design.md §6.1）。
//
// 中継は DMDATA と同じ `start`・`data`・`ping` を送るので、受け方は鍵で繋ぐときと同じ `DmdataWebSocket` を使う。
// 違うのは繋ぎ方（札をサブプロトコルに載せ、チケットを払い出さない）と、中継だけの知らせ 2 つ
// （`relay-status`・`relay-active-eew`）。
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('../utils/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/logger')>()),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogThrottle: () => (emit: () => void) => emit(),
}))

import { DmdataWebSocket, type DmdataEvent, type RelayActiveEew, type RelayUpstreamStatus } from './dmdata'
import { RelayTokenError, type RelayTokenStore } from './relayEndpoint'
import { errorText } from '../utils/localizedError'
import { resetNotifyQuietWhileOpenForTest, setNotifyQuietWhileOpen, setPushQuietBinding } from './notifyQuietWhileOpen'

async function drain() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

class FakeWs {
  static all: FakeWs[] = []
  static get last(): FakeWs | undefined { return FakeWs.all[FakeWs.all.length - 1] }
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: ((ev: { code: number; reason: string }) => void) | null = null
  onerror: (() => void) | null = null
  readyState = 1
  readonly sent: string[] = []
  constructor(readonly url: string, readonly protocols: string | string[]) { FakeWs.all.push(this) }
  send(text: string) { this.sent.push(text) }
  close() { this.onclose?.({ code: 1006, reason: '' }) }
  receive(msg: unknown) { this.onmessage?.({ data: JSON.stringify(msg) }) }
}

// 2024-01-01 能登半島地震の緊急地震速報（警報）を最小化したもの
const VXSE43_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/" xmlns:jmx="http://xml.kishou.go.jp/jmaxml1/">
<Control><Title>緊急地震速報（警報）</Title><Status>通常</Status><EditorialOffice>気象庁本庁</EditorialOffice><PublishingOffice>気象庁</PublishingOffice></Control>
<Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">
<Title>緊急地震速報（警報）</Title>
<ReportDateTime>2024-01-01T16:11:07+09:00</ReportDateTime>
<EventID>20240101161010</EventID>
<InfoType>発表</InfoType>
<Serial>3</Serial>
</Head>
<Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/seismology1/" xmlns:jmx_eb="http://xml.kishou.go.jp/jmaxml1/elementBasis1/">
<Earthquake>
<OriginTime>2024-01-01T16:10:10+09:00</OriginTime>
<ArrivalTime>2024-01-01T16:10:10+09:00</ArrivalTime>
<Hypocenter><Area><Name>石川県能登地方</Name><jmx_eb:Coordinate>+37.5+137.2-10000/</jmx_eb:Coordinate></Area></Hypocenter>
<jmx_eb:Magnitude type="Mj">7.6</jmx_eb:Magnitude>
</Earthquake>
<Intensity><Forecast>
<ForecastInt><From>7</From><To>7</To></ForecastInt>
</Forecast></Intensity>
</Body>
</Report>`

const vxse43Data = (id: string) => ({
  type: 'data', version: '2.0', id, classification: 'eew.warning', passing: [],
  head: { type: 'VXSE43', author: 'JPOS', time: '2024-01-01T07:11:07.000Z', test: false, designation: null },
  format: 'xml', encoding: 'utf-8', body: VXSE43_XML,
})

const RELAY_START = { type: 'start', socketId: 0, classifications: ['telegram.earthquake', 'eew.warning'], test: 'including', formats: ['xml'] }

function fakeTokens(): RelayTokenStore & { ensure: ReturnType<typeof vi.fn>; invalidate: ReturnType<typeof vi.fn> } {
  let current: string | null = null
  return {
    current: () => current,
    ensure: vi.fn(async () => { current = 'tok-1'; return 'tok-1' }),
    invalidate: vi.fn(() => { current = null }),
    setForecastKey: () => {},
    forecastKey: () => null,
    forecastKeyChecking: () => false,
    forecastScope: () => null,
    setUsage: () => {},
    usageInstall: () => null,
    subscribe: () => () => {},
  }
}

function setup(tokens = fakeTokens()) {
  FakeWs.all = []
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', FakeWs as unknown as typeof WebSocket)
  const fetchMock = vi.fn(async () => { throw new Error('中継の経路でチケットを取りに行った') })
  vi.stubGlobal('fetch', fetchMock)
  const ws = new DmdataWebSocket({ kind: 'relay', tokens, url: 'wss://relay.test/v2/websocket' })
  const events: DmdataEvent[] = []
  const statuses: string[] = []
  const upstream: RelayUpstreamStatus[] = []
  const active: RelayActiveEew[] = []
  const classifications: (readonly string[])[] = []
  ws.onEvent = (ev) => { events.push(ev) }
  ws.onStatusChange = (s) => { statuses.push(s) }
  ws.onRelayUpstream = (s) => { upstream.push(s) }
  ws.onRelayActiveEew = (a) => { active.push(a) }
  ws.onClassifications = (c) => { classifications.push(c) }
  return { ws, tokens, fetchMock, events, statuses, upstream, active, classifications }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('DmdataWebSocket: 中継へ繋ぐ', () => {
  // 正: 札をサブプロトコルに載せて直に開き、チケットは払い出さない
  it('札をサブプロトコルに載せて開き、チケットを取りに行かない', async () => {
    const { ws, tokens, fetchMock } = setup()
    try {
      ws.connect()
      await drain()
      expect(tokens.ensure).toHaveBeenCalledTimes(1)
      expect(FakeWs.last?.url).toBe('wss://relay.test/v2/websocket')
      expect(FakeWs.last?.protocols).toEqual(['dmdata.v2', 'tok-1'])
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      ws.disconnect()
    }
  })

  // 正: 区分は中継が start で名乗ったもの。予報が無いので警報 VXSE43 を緊急地震速報として読む
  it('start の区分で決め、警報 VXSE43 を緊急地震速報として読む', async () => {
    const { ws, events, statuses, classifications } = setup()
    try {
      ws.connect()
      await drain()
      FakeWs.last?.receive(RELAY_START)
      await drain()
      expect(classifications).toEqual([['telegram.earthquake', 'eew.warning']])
      expect(statuses[statuses.length - 1]).toBe('connected')
      await expect(ws.classificationsReady).resolves.toEqual(['telegram.earthquake', 'eew.warning'])

      FakeWs.last?.receive(vxse43Data('tg-eew-1'))
      await drain()
      expect(events.map(e => e.kind)).toEqual(['eew'])
    } finally {
      ws.disconnect()
    }
  })

  // 正: 中継の ping には同じ pingId の pong を返す（中継はこの文字列を自動応答で受ける）
  it('中継の ping に pong を返す', async () => {
    const { ws } = setup()
    try {
      ws.connect()
      await drain()
      FakeWs.last?.receive({ type: 'ping', pingId: 'relay' })
      await drain()
      expect(FakeWs.last?.sent).toEqual(['{"type":"pong","pingId":"relay"}'])
    } finally {
      ws.disconnect()
    }
  })

  // 正: relay-status で中継が DMDATA と繋がっているかを知らせる
  it('relay-status を読んで知らせる', async () => {
    const { ws, upstream } = setup()
    try {
      ws.connect()
      await drain()
      FakeWs.last?.receive({ type: 'relay-status', upstream: 'disconnected', disconnectedAt: '2026-10-31T00:00:00.000Z' })
      FakeWs.last?.receive({ type: 'relay-status', upstream: 'connected', disconnectedAt: null })
      FakeWs.last?.receive({ type: 'relay-status', upstream: 'たぶん' })
      await drain()
      expect(upstream).toEqual([
        { connected: false, disconnectedAtMs: Date.parse('2026-10-31T00:00:00.000Z') },
        { connected: true, disconnectedAtMs: null },
      ])
    } finally {
      ws.disconnect()
    }
  })

  // 正: 中継が尋ねる口を名乗ったら、設定「アプリを開いている間は通知しない」の名乗りを送り、問いに答える
  // （→ notifyQuietWhileOpen.ts。答えるかの判定そのものは notifyQuietWhileOpen.test.ts）
  it('relay-status の pushQuiet で名乗り、relay-push-probe に答える', async () => {
    const { ws } = setup()
    setNotifyQuietWhileOpen(true)
    setPushQuietBinding({ endpoint: 'https://push.example/abc', auth: 'secret' })
    try {
      ws.connect()
      await drain()
      FakeWs.last?.receive({ type: 'relay-status', upstream: 'connected', disconnectedAt: null, pushQuiet: true })
      // 2 度名乗られても 1 度だけ
      FakeWs.last?.receive({ type: 'relay-status', upstream: 'connected', disconnectedAt: null, pushQuiet: true })
      FakeWs.last?.receive({ type: 'relay-push-probe', probe: 'p1' })
      await drain()
      expect(FakeWs.last?.sent).toEqual([
        '{"type":"push-quiet-bind","endpoint":"https://push.example/abc","auth":"secret"}',
        '{"type":"push-probe-ack","probe":"p1"}',
      ])
      // 閉じた接続へは名乗り直さない
      FakeWs.last?.close()
      const closed = FakeWs.all[0]
      setNotifyQuietWhileOpen(false)
      expect(closed.sent).toHaveLength(2)
    } finally {
      ws.disconnect()
      resetNotifyQuietWhileOpenForTest()
    }
  })

  // 対照: 尋ねる口を名乗らない中継（古い版）には何も送らない（古い版は pong 以外を送る接続を閉じる）
  it('pushQuiet の無い relay-status では名乗らない', async () => {
    const { ws } = setup()
    setNotifyQuietWhileOpen(true)
    setPushQuietBinding({ endpoint: 'https://push.example/abc', auth: 'secret' })
    try {
      ws.connect()
      await drain()
      FakeWs.last?.receive({ type: 'relay-status', upstream: 'connected', disconnectedAt: null })
      await drain()
      expect(FakeWs.last?.sent).toEqual([])
    } finally {
      ws.disconnect()
      resetNotifyQuietWhileOpenForTest()
    }
  })

  // 正: いま発表中の警報は onEvent へ流さず、集めて 1 度に渡す（受けた側は鳴らさず画面だけを作る）
  it('relay-active-eew は読んで集め、ライブの onEvent へは流さない', async () => {
    const { ws, events, active } = setup()
    try {
      ws.connect()
      await drain()
      FakeWs.last?.receive(RELAY_START)
      await drain()
      FakeWs.last?.receive({ type: 'relay-active-eew', telegrams: [vxse43Data('tg-a1'), vxse43Data('tg-a2')] })
      await drain()
      expect(events).toEqual([])
      expect(active).toHaveLength(1)
      expect(active[0].events.map(e => e.kind)).toEqual(['eew', 'eew'])
      expect(active[0].incomplete).toBe(false)
    } finally {
      ws.disconnect()
    }
  })

  // 対照: 中継が読めない報を抜いた印、形の違う報は incomplete として渡す（欠けたまま黙って渡さない）
  it('relay-active-eew の欠けを incomplete で渡す', async () => {
    const { ws, active } = setup()
    try {
      ws.connect()
      await drain()
      FakeWs.last?.receive(RELAY_START)
      await drain()
      FakeWs.last?.receive({ type: 'relay-active-eew', telegrams: [], incomplete: true })
      FakeWs.last?.receive({ type: 'relay-active-eew', telegrams: [{ type: 'ping' }, vxse43Data('tg-b1')] })
      await drain()
      expect(active.map(a => [a.events.length, a.incomplete])).toEqual([[0, true], [1, true]])
    } finally {
      ws.disconnect()
    }
  })

  // 正: start の前に閉じられたら札を捨てる（401 と 429 はブラウザから見分けられない）。対照: start の後なら捨てない
  it('start の前に閉じたら札を捨て、start の後に閉じたら捨てない', async () => {
    const { ws, tokens } = setup()
    try {
      ws.connect()
      await drain()
      FakeWs.last?.close()
      await drain()
      expect(tokens.invalidate).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(60_000)
      await drain()
      expect(FakeWs.all).toHaveLength(2)
      FakeWs.last?.receive(RELAY_START)
      await drain()
      FakeWs.last?.close()
      await drain()
      expect(tokens.invalidate).toHaveBeenCalledTimes(1)
    } finally {
      ws.disconnect()
    }
  })

  // 安全弁: 札が取れなくても止めず、張り直しと同じ間隔で取り直す
  it('札が取れなければ切断にして取り直す', async () => {
    const tokens = fakeTokens()
    tokens.ensure.mockRejectedValueOnce(new RelayTokenError(errorText('relayTokenHttp', 429), 429))
    const { ws, statuses } = setup(tokens)
    try {
      ws.connect()
      await drain()
      expect(statuses).toEqual(['connecting', 'disconnected'])
      expect(FakeWs.all).toHaveLength(0)

      await vi.advanceTimersByTimeAsync(60_000)
      await drain()
      expect(tokens.ensure).toHaveBeenCalledTimes(2)
      expect(FakeWs.all).toHaveLength(1)
    } finally {
      ws.disconnect()
    }
  })

  // 安全弁: 中継の知らせは中継へ繋いでいるときだけ読む（鍵の経路では知らない種類として捨てる）
  it('鍵で繋いだ接続では relay-status を読まない', async () => {
    FakeWs.all = []
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWs as unknown as typeof WebSocket)
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200,
      json: async () => ({ websocket: { url: 'wss://example.invalid/ws' }, classifications: ['eew.forecast', 'telegram.earthquake'] }),
    }) as unknown as Response))
    const ws = new DmdataWebSocket('valid-key')
    const upstream: RelayUpstreamStatus[] = []
    ws.onRelayUpstream = (s) => { upstream.push(s) }
    try {
      ws.connect()
      await drain()
      expect(FakeWs.last?.protocols).toBe('dmdata.v2')
      FakeWs.last?.receive({ type: 'relay-status', upstream: 'connected', disconnectedAt: null })
      await drain()
      expect(upstream).toEqual([])
    } finally {
      ws.disconnect()
    }
  })
})
