// 中継の解析の答えを読む・並べる・絞る・取る。素材は中継の本番から取った答え
// （能登 2024-01-01 M7.6・三陸沖 2026-11-12 M4.7。2026-11-15 取得）。
import { afterEach, describe, expect, it, vi } from 'vitest'
import noto from './relayAnalysis.noto.fixture.json'
import sanriku from './relayAnalysis.sanriku.fixture.json'

const ep = vi.hoisted(() => ({
  prepare: vi.fn(async () => {}),
  waitApiSlot: vi.fn(async () => {}),
  apiHeaders: vi.fn(() => ({ Authorization: 'Bearer t' })),
  observe: vi.fn(),
}))
vi.mock('./relayEndpoint', () => ({ RELAY_API_BASE: 'https://relay.example/v2', relayRestEndpoint: ep }))
// テストの共通の準備（`vitestSetup.ts`）が問い合わせを塞いでいるので、このファイルだけ本物に戻す
vi.unmock('./relayAnalysis')

import {
  analysisAsOf, analysisCheckedAt, analysisIsEmpty, analysisUrl, faultTypeOf, fetchQuakeAnalysis, groupSolutionVersions,
  latestVersion, parseQuakeAnalysis, representativeSolution,
} from './relayAnalysis'

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

describe('parseQuakeAnalysis', () => {
  it('能登の答えを読める（解 15 件・USGS の製品 5 種）', () => {
    const a = parseQuakeAnalysis(noto)
    expect(a.eventId).toBe(noto.eventId)
    expect(a.match.source).toBe('telegram')
    expect(a.solutions).toHaveLength(15)
    expect(a.sources.usgs.event?.id).toBe('us6000m0xl')
    expect(a.usgs.pager).toHaveLength(11)
    expect(a.usgs.finiteFault).toHaveLength(5)
    expect(a.usgs.pager[0].fatality?.bins.length).toBeGreaterThan(0)
  })

  it('三陸沖の答え（解も製品も無く、気象庁は該当なし）を読める', () => {
    const a = parseQuakeAnalysis(sanriku)
    expect(a.match.source).toBe('catalog')
    expect(a.catalogCheck?.result).toBe('found')
    expect(a.sources.jma.status).toBe('none')
    expect(a.solutions).toEqual([])
  })

  it('要る欄（eventId・match・sources）が欠けたら投げる', () => {
    for (const k of ['eventId', 'match', 'sources'] as const) {
      const bad: Record<string, unknown> = clone(sanriku)
      delete bad[k]
      expect(() => parseQuakeAnalysis(bad)).toThrow()
    }
    expect(() => parseQuakeAnalysis(null)).toThrow()
    expect(() => parseQuakeAnalysis([])).toThrow()
  })

  it('形の違う解・版は捨て、残りは読む', () => {
    const bad = clone(noto) as unknown as { solutions: unknown[]; usgs: { pager: unknown[] } }
    bad.solutions.push({ source: 'nasa', agency: 'x', method: 'y', key: 'z' }, { source: 'usgs' })
    bad.usgs.pager.push({ version: '1' })
    const a = parseQuakeAnalysis(bad)
    expect(a.solutions).toHaveLength(15)
    expect(a.usgs.pager).toHaveLength(11)
  })

  it('知らない欄は無視し、知らない状態は確認中として読む', () => {
    const odd = clone(sanriku) as unknown as { future: number; sources: { usgs: { status: string } } }
    odd.future = 1
    odd.sources.usgs.status = 'someday'
    expect(parseQuakeAnalysis(odd).sources.usgs.status).toBe('pending')
  })
})

describe('並べる・絞る', () => {
  const a = parseQuakeAnalysis(noto)

  it('同じ鍵の版をまとめる（15 件 → 9 組）。新しい版が先', () => {
    const groups = groupSolutionVersions(a.solutions)
    expect(groups).toHaveLength(9)
    const usgs = groups.find(g => g.latest.key === 'us:us_6000m0xl_mww')!
    expect(usgs.latest.publishedAt).toBe('2024-03-09T21:38:17.040Z')
    expect(usgs.older).toHaveLength(5)
    const geofon = groups.find(g => g.latest.key === 'geofon:GFZ')!
    expect(geofon.latest.publishedAt).toBe('2024-01-01T08:11:25.633Z')
  })

  it('代表の解は気象庁、無ければ USGS', () => {
    expect(representativeSolution(a)?.method).toBe('CMT（精査後）')
    const noJma = { ...a, solutions: a.solutions.filter(s => s.source !== 'jma') }
    expect(representativeSolution(noJma)?.source).toBe('usgs')
    expect(representativeSolution(parseQuakeAnalysis(sanriku))).toBeNull()
  })

  it('すべり角で断層の型を分ける（境目 ±45°・±135° を含む）', () => {
    const t = (rake: number) => faultTypeOf({ strike: 0, dip: 45, rake })
    expect([t(45), t(90), t(135)]).toEqual(['reverse', 'reverse', 'reverse'])
    expect([t(-45), t(-90), t(-135)]).toEqual(['normal', 'normal', 'normal'])
    expect([t(0), t(44), t(136), t(180), t(-44), t(-136), t(-180)]).toEqual(Array(7).fill('strikeSlip'))
  })

  it('リプレイの時計より後に出た版と、公表時刻の無い気象庁の解を落とす', () => {
    // 発生から 40 分後（07:50 UTC）。GEOFON 1 版目・EMSC の CPPT・SC4 は出ていた
    const at = analysisAsOf(a, Date.parse('2024-01-01T07:50:00Z'))
    expect(at.solutions.map(s => s.key).sort()).toEqual(['emsc:CPPT', 'emsc:SC4', 'geofon:GFZ'])
    expect(at.solutions.some(s => s.source === 'jma')).toBe(false)
    expect(at.usgs.shakemap.map(v => v.version)).toEqual(['1704094381316'])
    expect(at.usgs.finiteFault).toEqual([])
    // 取得元の地震そのものは残す
    expect(at.sources.usgs.event?.id).toBe('us6000m0xl')
  })

  it('どの機関の版もまだ出ていない時刻では、取得元の地震も見せない（確認中に戻す）', () => {
    // 発生から 19 分後（07:29:00 UTC）。最初の版は USGS の DYFI の 07:29:16・GEOFON の 07:41・EMSC の 07:41
    const at = analysisAsOf(a, Date.parse('2024-01-01T07:29:00Z'))
    for (const s of ['usgs', 'emsc', 'geofon'] as const) {
      expect(at.sources[s].event).toBeNull()
      expect(at.sources[s].status).toBe('pending')
    }
    // 対照: DYFI が出た直後は USGS の地震だけ見え、他はまだ見えない
    const after = analysisAsOf(a, Date.parse('2024-01-01T07:30:00Z'))
    expect(after.sources.usgs.event?.id).toBe('us6000m0xl')
    expect(after.sources.geofon.event).toBeNull()
  })

  it('時計が十分後なら気象庁の解だけが落ちる（対照）', () => {
    const at = analysisAsOf(a, Date.parse('2030-01-01T00:00:00Z'))
    expect(at.solutions).toHaveLength(14)
    expect(at.usgs.dyfi).toHaveLength(a.usgs.dyfi.length)
  })

  it('一番新しい版は時刻を数で比べて選ぶ（小数の桁が違っても）', () => {
    expect(latestVersion([{ publishedAt: '2024-01-01T00:00:00.5Z' }, { publishedAt: '2024-01-01T00:00:00.123Z' }]))
      .toEqual({ publishedAt: '2024-01-01T00:00:00.5Z' })
    expect(latestVersion(a.usgs.pager)?.version).toBe('1710009382085')
    expect(latestVersion([])).toBeNull()
  })

  it('答えの時点は、確かめた時刻のうち一番新しいもの。読めない時刻は捨て、無ければ null', () => {
    // 能登の答え: 取得元の確認は 05:19:02（USGS など）、見張りは 05:14:08
    expect(analysisCheckedAt(a)).toBe('2026-11-15T05:19:02.205Z')
    // [安全弁] 先頭の時刻が読めなくても、他の時刻を採る
    const broken = clone(a)
    broken.sources.jma = { ...broken.sources.jma, checkedAt: 'not-a-date' }
    expect(analysisCheckedAt(broken)).toBe('2026-11-15T05:19:02.205Z')
    // [対照] どれも無ければ出さない
    const none = clone(a)
    for (const s of ['usgs', 'emsc', 'geofon', 'jma'] as const) none.sources[s] = { ...none.sources[s], checkedAt: null }
    none.watch = { ...none.watch, usgsCheckedAt: null }
    none.catalogCheck = null
    expect(analysisCheckedAt(none)).toBeNull()
  })

  it('空かどうか: 三陸沖は結んだ地震があるので空ではない', () => {
    expect(analysisIsEmpty(parseQuakeAnalysis(sanriku))).toBe(false)
    const none = parseQuakeAnalysis(sanriku)
    for (const s of ['usgs', 'emsc', 'geofon', 'jma'] as const) none.sources[s] = { ...none.sources[s], status: 'none', event: null }
    expect(analysisIsEmpty(none)).toBe(true)
  })
})

describe('fetchQuakeAnalysis', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })
  const q = { eventId: '20240101161010', time: '2024-01-01T16:10:00+09:00', lat: 37.5, lon: 137.2, depthKm: 0, mag: 7.6 }

  const stubFetch = (status: number, body: unknown) => {
    const f = vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }))
    vi.stubGlobal('fetch', f)
    return f
  }

  it('問い合わせの URL に地震の値を載せ、札を付ける', async () => {
    const f = stubFetch(200, noto)
    const r = await fetchQuakeAnalysis(q, null)
    expect(r.kind).toBe('ok')
    const url = new URL(String((f.mock.calls[0] as unknown[])[0]))
    expect(url.origin + url.pathname).toBe('https://relay.example/v2/analysis')
    expect(Object.fromEntries(url.searchParams)).toEqual({ eventId: q.eventId, time: q.time, lat: '37.5', lon: '137.2', depth: '0', mag: '7.6' })
    expect(ep.prepare).toHaveBeenCalledTimes(1)
    expect(ep.observe).toHaveBeenCalledWith(200, expect.anything())
  })

  it('深さ・規模が無ければ載せない', () => {
    const url = new URL(analysisUrl({ ...q, depthKm: null, mag: null }))
    expect(url.searchParams.has('depth')).toBe(false)
    expect(url.searchParams.has('mag')).toBe(false)
  })

  it('404 は「確かめられない」、他の失敗・形の違いは「失敗」', async () => {
    stubFetch(404, { error: 'unknown' })
    expect((await fetchQuakeAnalysis(q, null)).kind).toBe('unverifiable')
    stubFetch(500, 'x')
    expect((await fetchQuakeAnalysis(q, null)).kind).toBe('error')
    stubFetch(200, 'not json')
    expect((await fetchQuakeAnalysis(q, null)).kind).toBe('error')
    stubFetch(200, { eventId: 'x' })
    expect((await fetchQuakeAnalysis(q, null)).kind).toBe('error')
    expect(ep.observe).toHaveBeenCalledWith(404, expect.anything())
  })
})
