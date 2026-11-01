// @vitest-environment jsdom
// 中継の電文一覧（警報 VXSE43 も載る）から作るもののテスト。中継は加工データ（`/v2/gd/*`）を配らないので
// （docs/relay-server-design.md §0 の 2026-10-31「加工データは配らない」の行）、次の 4 つは電文一覧から作る。
//   - リプレイの当日分の緊急地震速報（`fetchLiveReplayEntries`）
//   - 地震ごとの緊急地震速報の最終報（`fetchListedEewFinals`・`fetchDmdataEewOrigins`）
//   - ヒートマップの末尾の震源（`fetchListedHypocenters`）
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { DmdataEndpoint } from './dmdataEndpoint'
import { RELAY_CLASSIFICATIONS, relayRestClassifications, restSources } from './dmdataClassifications'
import {
  fetchListedEewFinals, fetchListedHypocenters, fetchLiveReplayEntries, clearLiveReplayCache,
} from './dmdataReplayLive'
import {
  fetchDmdataEewOrigins, clearReplayCache, clearArchiveCacheForTest, clearParseCachesForTest,
} from './dmdataReplay'
import { setBodyGateIntervalForTest } from './telegramBody'
import { setApiGateIntervalForTest, resetApiGateForTest, resetRateLimitsForTest } from './dmdataRequestGates'
import { clearArchiveBodyDb } from '../utils/archiveBodyDb'
import type { EEWAlert, JMAQuake } from '../types/earthquake'

/** 中継に見立てた繋ぎ先。電文一覧が警報を載せる（→ `DmdataEndpoint.telegramListHasEew`） */
const RELAY: DmdataEndpoint = {
  apiBase: 'https://relay.example.test/v2',
  dataBase: 'https://data.example.test/t/',
  telegramListHasEew: true,
  problem: () => null,
  prepare: async () => {},
  waitApiSlot: async () => {},
  waitDataSlot: async () => {},
  observe: () => {},
  noteListGaps: () => {},
  apiHeaders: () => ({ Authorization: 'Bearer test' }),
  dataHeaders: () => ({}),
}

interface ListTelegram {
  id: string
  type: string
  receivedTime: string
  /** XML 版の見出しの地震 ID と報番号。`null` なら載せない */
  eventId: string | null
  serial?: string | null
  originalId?: string
  test?: boolean
}

function listItem(t: ListTelegram) {
  return {
    id: t.id,
    ...(t.originalId ? { originalId: t.originalId } : {}),
    head: { type: t.type, time: t.receivedTime, test: t.test ?? false },
    receivedTime: t.receivedTime,
    url: `${RELAY.dataBase}${t.id}`,
    ...(t.eventId !== null ? { xmlReport: { head: { eventId: t.eventId, serial: t.serial ?? '1' } } } : {}),
  }
}

function warningBody(eventId: string, serial: string, originTime: string, o: { infoType?: string } = {}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/" xmlns:jmx="http://xml.kishou.go.jp/jmaxml1/">
<Control><Title>緊急地震速報（警報）</Title><DateTime>2026-10-31T02:00:10Z</DateTime><Status>通常</Status><EditorialOffice>気象庁</EditorialOffice></Control>
<Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">
<Title>緊急地震速報（警報）</Title><ReportDateTime>2026-10-31T11:00:10+09:00</ReportDateTime>
<EventID>${eventId}</EventID><InfoType>${o.infoType ?? '発表'}</InfoType><Serial>${serial}</Serial></Head>
<Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/seismology1/" xmlns:jmx_eb="http://xml.kishou.go.jp/jmaxml1/elementBasis1/">
<Earthquake><OriginTime>${originTime}</OriginTime><ArrivalTime>${originTime}</ArrivalTime>
<Hypocenter><Area><Name>茨城県南部</Name><jmx_eb:Coordinate>+36.0+140.1-50000/</jmx_eb:Coordinate></Area></Hypocenter>
<jmx_eb:Magnitude type="Mj">6.0</jmx_eb:Magnitude></Earthquake>
<Intensity><Forecast><ForecastInt><From>5-</From><To>5-</To></ForecastInt>
<Pref><Name>茨城県</Name><Code>08</Code><Area><Name>茨城県南部</Name><Code>301</Code>
<Category><Kind><Name>緊急地震速報（警報）</Name><Code>11</Code></Kind></Category>
<ForecastInt><From>5-</From><To>5-</To></ForecastInt></Area></Pref></Forecast></Intensity>
</Body></Report>`
}

function hypocenterBody(eventId: string, originTime: string, name: string, o: { title?: string } = {}): string {
  const title = o.title ?? '震源・震度に関する情報'
  return `<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/" xmlns:jmx="http://xml.kishou.go.jp/jmaxml1/">
<Control><Title>${title}</Title><DateTime>2026-10-31T02:05:00Z</DateTime><Status>通常</Status><EditorialOffice>気象庁</EditorialOffice></Control>
<Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">
<Title>${title}</Title><ReportDateTime>2026-10-31T11:05:00+09:00</ReportDateTime>
<EventID>${eventId}</EventID><InfoType>発表</InfoType><Serial>1</Serial></Head>
<Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/seismology1/" xmlns:jmx_eb="http://xml.kishou.go.jp/jmaxml1/elementBasis1/">
<Earthquake><OriginTime>${originTime}</OriginTime><ArrivalTime>${originTime}</ArrivalTime>
<Hypocenter><Area><Name>${name}</Name><jmx_eb:Coordinate>+39.9+142.2-50000/</jmx_eb:Coordinate></Area></Hypocenter>
<jmx_eb:Magnitude type="Mj">4.1</jmx_eb:Magnitude></Earthquake>
<Intensity><Observation><MaxInt>2</MaxInt></Observation></Intensity>
</Body></Report>`
}

/** 中継の口に応える偽の `fetch`。投げた URL を返す */
function mockRelay(o: {
  list: ListTelegram[]
  bodies: Record<string, string>
  listStatus?: number
  /** 中継の一覧が載せる見ていない区間（そのまま応答へ載せる） */
  gapsBody?: { gapsSpan: { from: string; to: string }; gaps: { classification: string; from: string; to: string }[] }
}): string[] {
  const urls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    urls.push(input)
    const ok = (json: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => json } as unknown as Response)
    if (input.startsWith(`${RELAY.apiBase}/telegram?`)) {
      if (o.listStatus !== undefined) return { ok: false, status: o.listStatus, headers: new Headers() } as unknown as Response
      return ok({ status: 'ok', items: o.list.map(listItem), ...o.gapsBody })
    }
    if (input.startsWith(`${RELAY.apiBase}/archive?`)) return ok({ status: 'ok', items: [] })
    if (input.startsWith(RELAY.dataBase)) {
      const body = o.bodies[input.slice(RELAY.dataBase.length)]
      if (body === undefined) return { ok: false, status: 404, headers: new Headers() } as unknown as Response
      return { ok: true, status: 200, headers: new Headers(), text: async () => body } as unknown as Response
    }
    return { ok: false, status: 404, headers: new Headers() } as unknown as Response
  }))
  return urls
}

const FROM = new Date('2026-10-31T00:00:00+09:00')
const TO = new Date('2026-10-31T12:00:00+09:00')

beforeEach(async () => {
  setBodyGateIntervalForTest(0)
  setApiGateIntervalForTest(0)
  resetApiGateForTest()
  resetRateLimitsForTest()
  clearLiveReplayCache()
  clearReplayCache()
  clearArchiveCacheForTest()
  clearParseCachesForTest()
  await clearArchiveBodyDb()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('relayRestClassifications', () => {
  it('受けている区分から予報を外す（予報キーを受け付けていない中継は予報を返さない）', () => {
    expect(relayRestClassifications(['telegram.earthquake', 'eew.warning', 'eew.forecast'], false)).toEqual(['telegram.earthquake', 'eew.warning'])
  })
  it('まだ何も受けていない・予報しか受けていないなら、中継の既定の区分で引く', () => {
    expect(relayRestClassifications(null, false)).toEqual(RELAY_CLASSIFICATIONS)
    expect(relayRestClassifications(['eew.forecast'], false)).toEqual(RELAY_CLASSIFICATIONS)
  })
  // 中継が予報キーを受け付けているなら、一覧・束から予報も引く（自分の鍵の端末と同じく VXSE45 で探す）
  it('中継が予報キーを受け付けているなら予報を足す', () => {
    expect(relayRestClassifications(['telegram.earthquake', 'eew.warning'], true)).toEqual(['telegram.earthquake', 'eew.warning', 'eew.forecast'])
    expect(relayRestClassifications(['telegram.earthquake', 'eew.warning', 'eew.forecast'], true)).toEqual(['telegram.earthquake', 'eew.warning', 'eew.forecast'])
    expect(relayRestClassifications(null, true)).toEqual([...RELAY_CLASSIFICATIONS, 'eew.forecast'])
  })
})

describe('restSources', () => {
  // 自分の鍵の予報が通っている（区分に予報がある）なら、予報は鍵から引き、中継から警報を引かない（ライブと同じく VXSE43 を採らない）
  it('鍵の予報が通っていて中継が予報を配らないなら、予報は鍵から・中継は警報を外して引く', () => {
    expect(restSources(['telegram.earthquake', 'eew.warning', 'eew.forecast'], false, true, false))
      .toEqual({ relay: ['telegram.earthquake'], keyForecast: true })
  })
  // 鍵の接続が 409（枠が埋まっている）で繋がらない間・答える前も、過去の電文は枠を使わずに鍵で引ける
  it('鍵の接続がまだ答えていなくても、予報は鍵から・中継は警報を外して引く', () => {
    expect(restSources(null, false, true, false)).toEqual({ relay: ['telegram.earthquake'], keyForecast: true })
    expect(restSources(['telegram.earthquake', 'eew.warning'], false, true, false))
      .toEqual({ relay: ['telegram.earthquake'], keyForecast: true })
  })
  it('鍵が予報を受け付けないと答えたなら、中継の警報で引く', () => {
    expect(restSources(['telegram.earthquake', 'eew.warning'], false, true, true))
      .toEqual({ relay: ['telegram.earthquake', 'eew.warning'], keyForecast: false })
    expect(restSources(null, false, true, true)).toEqual({ relay: RELAY_CLASSIFICATIONS, keyForecast: false })
  })
  // 鍵を消した直後は受けている区分がまだ前のまま。鍵が無ければ鍵からは引かない
  it('鍵が入っていなければ、区分に予報が残っていても中継の警報で引く', () => {
    expect(restSources(['telegram.earthquake', 'eew.warning', 'eew.forecast'], false, false, false))
      .toEqual({ relay: ['telegram.earthquake', 'eew.warning'], keyForecast: false })
    expect(restSources(null, false, false, false)).toEqual({ relay: RELAY_CLASSIFICATIONS, keyForecast: false })
  })
  // 中継が予報キーを受け付けていれば、鍵があっても中継から予報を引く（鍵の枠を使わない）
  it('中継が予報キーを受け付けているなら、鍵からは引かない', () => {
    expect(restSources(['telegram.earthquake', 'eew.warning', 'eew.forecast'], true, true, false))
      .toEqual({ relay: ['telegram.earthquake', 'eew.warning', 'eew.forecast'], keyForecast: false })
    expect(restSources(null, true, true, false))
      .toEqual({ relay: [...RELAY_CLASSIFICATIONS, 'eew.forecast'], keyForecast: false })
  })
})

describe('fetchListedEewFinals', () => {
  it('地震ごとに報番号のいちばん大きい警報を選び、本文を読む', async () => {
    mockRelay({
      // 一覧は新しい順。報番号は数で比べる（"10" は "9" より大きい）
      list: [
        { id: 'a10', type: 'VXSE43', receivedTime: '2026-10-31T02:00:30Z', eventId: 'A', serial: '10' },
        { id: 'a10j', type: 'VXSE43', receivedTime: '2026-10-31T02:00:30Z', eventId: 'A', serial: '10', originalId: 'a10' },
        { id: 'a9', type: 'VXSE43', receivedTime: '2026-10-31T02:00:20Z', eventId: 'A', serial: '9' },
        { id: 'b1', type: 'VXSE43', receivedTime: '2026-10-31T01:00:00Z', eventId: 'B', serial: '1', test: true },
        { id: 'q1', type: 'VXSE53', receivedTime: '2026-10-31T01:00:00Z', eventId: 'Q', serial: '1' },
      ],
      bodies: {
        a10: warningBody('A', '10', '2026-10-31T11:00:07+09:00'),
        a9: warningBody('A', '9', '2026-10-31T11:00:05+09:00'),
      },
    })
    const { finals, complete } = await fetchListedEewFinals(RELAY, FROM, TO, 'VXSE43', null)
    expect(complete).toBe(true)
    // 試験の報・JSON 版・地震情報は選ばない
    expect(finals.map(e => [e.issue?.eventId, e.issue?.serial])).toEqual([['A', '10']])
    expect(finals[0].earthquake.originTime).toBe('2026-10-31T11:00:07+09:00')
  })

  it('対照: 期間の外に受信した報は選ばない', async () => {
    mockRelay({
      list: [{ id: 'a1', type: 'VXSE43', receivedTime: '2026-10-31T04:00:00Z', eventId: 'A', serial: '1' }],
      bodies: { a1: warningBody('A', '1', '2026-10-31T13:00:00+09:00') },
    })
    const { finals, complete } = await fetchListedEewFinals(RELAY, FROM, TO, 'VXSE43', null)
    expect(finals).toEqual([])
    expect(complete).toBe(true)
  })

  it('安全弁: 地震 ID か報番号を読めない報があれば、取りきれていないと返す', async () => {
    mockRelay({
      list: [
        { id: 'a1', type: 'VXSE43', receivedTime: '2026-10-31T02:00:00Z', eventId: 'A', serial: '1' },
        { id: 'x1', type: 'VXSE43', receivedTime: '2026-10-31T02:00:00Z', eventId: null },
        { id: 'y1', type: 'VXSE43', receivedTime: '2026-10-31T02:00:00Z', eventId: 'Y', serial: '' },
      ],
      bodies: { a1: warningBody('A', '1', '2026-10-31T11:00:00+09:00') },
    })
    const { finals, complete } = await fetchListedEewFinals(RELAY, FROM, TO, 'VXSE43', null)
    expect(finals.map(e => e.issue?.eventId)).toEqual(['A'])
    expect(complete).toBe(false)
  })

  it('安全弁: 一覧を引けなければ投げずに、取りきれていないと返す', async () => {
    mockRelay({ list: [], bodies: {}, listStatus: 500 })
    const { finals, complete } = await fetchListedEewFinals(RELAY, FROM, TO, 'VXSE43', null)
    expect(finals).toEqual([])
    expect(complete).toBe(false)
  })
})

describe('fetchListedHypocenters', () => {
  it('地震ごとにいちばん新しい震源の電文を読み、VXSE53 が無い地震だけ VXSE52 を使う', async () => {
    mockRelay({
      list: [
        { id: 'a2', type: 'VXSE53', receivedTime: '2026-10-31T02:10:00Z', eventId: 'A' },
        { id: 'a1', type: 'VXSE53', receivedTime: '2026-10-31T02:05:00Z', eventId: 'A' },
        { id: 'a0', type: 'VXSE52', receivedTime: '2026-10-31T02:03:00Z', eventId: 'A' },
        { id: 'b0', type: 'VXSE52', receivedTime: '2026-10-31T01:03:00Z', eventId: 'B' },
        // 震度速報（震源を持たない）・JSON 版・試験の報は使わない
        { id: 'c0', type: 'VXSE51', receivedTime: '2026-10-31T01:02:00Z', eventId: 'C' },
        { id: 'a2j', type: 'VXSE53', receivedTime: '2026-10-31T02:10:00Z', eventId: 'A', originalId: 'a2' },
        { id: 't0', type: 'VXSE53', receivedTime: '2026-10-31T01:00:00Z', eventId: 'T', test: true },
      ],
      bodies: {
        a2: hypocenterBody('A', '2026-10-31T11:00:00+09:00', '岩手県沖（新）'),
        a1: hypocenterBody('A', '2026-10-31T11:00:00+09:00', '岩手県沖（旧）'),
        a0: hypocenterBody('A', '2026-10-31T11:00:00+09:00', '岩手県沖（速報）', { title: '震源に関する情報' }),
        b0: hypocenterBody('B', '2026-10-31T10:00:00+09:00', '宮城県沖', { title: '震源に関する情報' }),
      },
    })
    const { quakes, complete } = await fetchListedHypocenters(RELAY, FROM, TO, null)
    expect(complete).toBe(true)
    const names = quakes.map((q: JMAQuake) => q.earthquake.hypocenter.name).sort()
    expect(names).toEqual(['宮城県沖', '岩手県沖（新）'])
  })

  it('対照: 再生を始めた時刻より後に受信した電文は使わない', async () => {
    mockRelay({
      list: [{ id: 'a1', type: 'VXSE53', receivedTime: '2026-10-31T03:30:00Z', eventId: 'A' }],
      bodies: { a1: hypocenterBody('A', '2026-10-31T12:29:00+09:00', '岩手県沖') },
    })
    const { quakes } = await fetchListedHypocenters(RELAY, FROM, TO, null)
    expect(quakes).toEqual([])
  })

  it('安全弁: 本文を取れない地震があれば、取れた分を返して取りきれていないと返す', async () => {
    mockRelay({
      list: [
        { id: 'a1', type: 'VXSE53', receivedTime: '2026-10-31T02:00:00Z', eventId: 'A' },
        { id: 'b1', type: 'VXSE53', receivedTime: '2026-10-31T01:00:00Z', eventId: 'B' },
      ],
      bodies: { a1: hypocenterBody('A', '2026-10-31T11:00:00+09:00', '岩手県沖') },
    })
    const { quakes, complete } = await fetchListedHypocenters(RELAY, FROM, TO, null)
    expect(quakes.map(q => q.earthquake.hypocenter.name)).toEqual(['岩手県沖'])
    expect(complete).toBe(false)
  })
})

describe('fetchLiveReplayEntries（中継）', () => {
  it('警報を電文一覧から取り、加工データの一覧を引かない', async () => {
    const urls = mockRelay({
      list: [
        { id: 'w2', type: 'VXSE43', receivedTime: '2026-10-31T02:00:12Z', eventId: 'A', serial: '2' },
        { id: 'w2j', type: 'VXSE43', receivedTime: '2026-10-31T02:00:12Z', eventId: 'A', serial: '2', originalId: 'w2' },
        { id: 'w1', type: 'VXSE43', receivedTime: '2026-10-31T02:00:08Z', eventId: 'A', serial: '1' },
        { id: 'q1', type: 'VXSE53', receivedTime: '2026-10-31T02:05:00Z', eventId: 'A' },
      ],
      bodies: {
        w2: warningBody('A', '2', '2026-10-31T11:00:07+09:00'),
        w1: warningBody('A', '1', '2026-10-31T11:00:05+09:00'),
        q1: hypocenterBody('A', '2026-10-31T11:00:00+09:00', '岩手県沖'),
      },
    })
    const result = await fetchLiveReplayEntries(RELAY, FROM, TO, ['2026-10-31'], false, RELAY_CLASSIFICATIONS, null)
    expect(urls.some(u => u.includes('/gd/'))).toBe(false)
    const kinds = result.entries.map(e => (e.payload.kind === 'event' ? e.payload.event.kind : e.payload.kind))
    expect(kinds.filter(k => k === 'eew')).toHaveLength(2)
    expect(kinds.filter(k => k === 'quake')).toHaveLength(1)
    expect(result.failedSources).toEqual([])
  })
})

describe('見ていない区間', () => {
  it('一覧の応答に載った見ていない区間を、繋ぎ先へ渡す', async () => {
    const noteListGaps = vi.fn()
    mockRelay({
      list: [],
      bodies: {},
      gapsBody: {
        gapsSpan: { from: '2026-10-30T15:00:00Z', to: '2026-10-31T03:00:00Z' },
        gaps: [{ classification: 'eew.warning', from: '2026-10-30T20:00:00Z', to: '2026-10-30T21:00:00Z' }],
      },
    })
    await fetchListedHypocenters({ ...RELAY, noteListGaps }, FROM, TO, null)
    expect(noteListGaps).toHaveBeenCalledWith({
      span: { fromMs: Date.parse('2026-10-30T15:00:00Z'), toMs: Date.parse('2026-10-31T03:00:00Z') },
      gaps: [{ classification: 'eew.warning', fromMs: Date.parse('2026-10-30T20:00:00Z'), toMs: Date.parse('2026-10-30T21:00:00Z') }],
    })
  })

  it('対照: 印を載せない応答（DMDATA の一覧）では渡さない', async () => {
    const noteListGaps = vi.fn()
    mockRelay({ list: [], bodies: {} })
    await fetchListedHypocenters({ ...RELAY, noteListGaps }, FROM, TO, null)
    expect(noteListGaps).not.toHaveBeenCalled()
  })
})

describe('fetchDmdataEewOrigins（中継）', () => {
  it('加工データの一覧を引かず、電文一覧から地震ごとの最終報と取消を取る', async () => {
    const urls = mockRelay({
      list: [
        { id: 'a2', type: 'VXSE43', receivedTime: '2026-10-31T02:00:12Z', eventId: 'A', serial: '2' },
        { id: 'a1', type: 'VXSE43', receivedTime: '2026-10-31T02:00:08Z', eventId: 'A', serial: '1' },
        { id: 'c2', type: 'VXSE43', receivedTime: '2026-10-31T01:00:20Z', eventId: 'C', serial: '2' },
      ],
      bodies: {
        a2: warningBody('A', '2', '2026-10-31T11:00:07+09:00'),
        a1: warningBody('A', '1', '2026-10-31T11:00:05+09:00'),
        c2: warningBody('C', '2', '2026-10-31T10:00:00+09:00', { infoType: '取消' }),
      },
    })
    const { finals, canceledIds, complete } = await fetchDmdataEewOrigins(RELAY, FROM, TO, RELAY_CLASSIFICATIONS, null)
    expect(urls.some(u => u.includes('/gd/'))).toBe(false)
    const byId = new Map(finals.map((e: EEWAlert) => [e.issue?.eventId, e]))
    expect(byId.get('A')?.earthquake.originTime).toBe('2026-10-31T11:00:07+09:00')
    expect(canceledIds).toEqual(['C'])
    expect(complete).toBe(true)
  })
})
