import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { HistoricalArchiveIndex, HistoricalArchiveMeta } from '../types/historicalArchive'

vi.mock('../utils/fetchJson', () => ({ fetchJsonWithTimeout: vi.fn() }))
// `log` だけ差し替える部分モック。**丸ごと置き換えると、logger が新しい関数を export した日に
// 「そんな export は無い」でファイルごと落ちる**（`createFirstSeenLogGate` を足したときに実際に起きた）。
vi.mock('../utils/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/logger')>()),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { fetchJsonWithTimeout } from '../utils/fetchJson'
import {
  findCoveringArchiveSync,
  findArchiveJustEndedSync,
  findUncollectedArchiveSync,
  fetchLocalArchiveEvents,
  fetchLocalArchiveQuakeHistory,
  listHistoricalArchives,
  clearLocalArchiveCache,
} from './localArchiveReplay'

/** テスト用: 日ごとの取りこぼしを合計する（実装が日ごとに持つようになったため）。 */
function skippedTotal(m: ReadonlyMap<string, number>): number {
  return [...m.values()].reduce((a, b) => a + b, 0)
}

const mockFetchJson = vi.mocked(fetchJsonWithTimeout)

const meta: HistoricalArchiveMeta = {
  id: '2011-tohoku',
  label: '2011年東北地方太平洋沖地震',
  description: 'test',
  from: '2011-03-11T05:45:00Z',
  to: '2011-03-11T06:00:00Z',
  coveredRanges: [{ from: '2011-03-11T05:45:00Z', to: '2011-03-11T06:00:00Z' }],
  firstEventTime: '2011-03-11T05:46:00Z',
}

// スキーマ検証（historicalArchiveSchema.ts）を通す最小限の妥当な event。
// quake は earthquake.maxScale、tsunami は areas がそれぞれ必須フィールドのため、
// 素の { kind: 'quake' } 等はここでは skip されてしまう（CRITICAL対策の値域検証）。
const validEew = (extra: Record<string, unknown> = {}) => ({ kind: 'eew', ...extra })
const validQuake = (extra: Record<string, unknown> = {}) => ({ kind: 'quake', earthquake: { maxScale: 70 }, ...extra })
const validTsunami = (extra: Record<string, unknown> = {}) => ({ kind: 'tsunami', areas: [], ...extra })

describe('findCoveringArchiveSync', () => {
  const index: HistoricalArchiveIndex = [meta]
  const ONE_HOUR_MS = 3600_000
  const PRE_WINDOW_MS = 24 * ONE_HOUR_MS
  /** 「本編」の1点を軽く指定するための、幅1msの範囲。 */
  const at = (iso: string): [Date, Date] => {
    const d = new Date(iso)
    return [d, new Date(d.getTime() + 1)]
  }

  it('範囲内の時刻はカバーするアーカイブを返す', () => {
    expect(findCoveringArchiveSync(index, ...at('2011-03-11T05:50:00Z'))?.id).toBe('2011-tohoku')
  })

  it('開始時刻ちょうどは含む（[from, to)）', () => {
    expect(findCoveringArchiveSync(index, ...at(meta.from))?.id).toBe('2011-tohoku')
  })

  it('終了時刻ちょうどは含まない（[from, to)）', () => {
    expect(findCoveringArchiveSync(index, ...at(meta.to))).toBeNull()
  })

  it('範囲外の時刻は null（DMDATA/P2PQuakeへフォールバックする合図）', () => {
    expect(findCoveringArchiveSync(index, ...at('2020-01-01T00:00:00Z'))).toBeNull()
  })

  it('空配列は常に null', () => {
    expect(findCoveringArchiveSync([], ...at('2011-03-11T05:50:00Z'))).toBeNull()
  })

  it('「本編」の問い合わせ範囲（対象時刻〜+1時間）が重なれば返す', () => {
    const target = new Date('2011-03-11T05:47:00Z')
    expect(findCoveringArchiveSync(index, target, new Date(target.getTime() + ONE_HOUR_MS))?.id).toBe('2011-tohoku')
  })

  it('「初期状態」の問い合わせ範囲（対象時刻から遡る24時間）は、対象時刻自体が収録範囲内なら重なりとして拾う', () => {
    // 実際のバグ再現: 24時間前は収録範囲(from)より大幅に前だが、範囲としては target まで
    // 伸びているため重なる。ここを「fromTime が収録範囲内か」だけで判定すると見逃し、
    // DMDATA/P2PQuake（データが存在しない時代）へ問い合わせて再生全体が止まっていた。
    const target = new Date('2011-03-11T05:47:00Z')
    const preFrom = new Date(target.getTime() - PRE_WINDOW_MS)
    expect(findCoveringArchiveSync(index, preFrom, target)?.id).toBe('2011-tohoku')
  })

  it('収録範囲より後（先読みが収録終端を過ぎた場合）は null', () => {
    const afterEnd = new Date(meta.to)
    expect(findCoveringArchiveSync(index, afterEnd, new Date(afterEnd.getTime() + ONE_HOUR_MS))).toBeNull()
  })
})

describe('findUncollectedArchiveSync', () => {
  // 2018 年北海道胆振東部地震の形: 収録範囲は 9/6〜2/23 と広いが、電文を集めたのは 3 か所の 2 日ずつ
  const iburi: HistoricalArchiveMeta = {
    id: '2018-iburi',
    label: '2018年北海道胆振東部地震',
    description: 'test',
    from: '2018-09-05T15:00:00.000Z',
    to: '2019-02-22T15:00:00.000Z',
    coveredRanges: [
      { from: '2018-09-05T15:00:00.000Z', to: '2018-09-07T15:00:00.000Z' },
      { from: '2018-10-04T15:00:00.000Z', to: '2018-10-06T15:00:00.000Z' },
      { from: '2019-02-20T15:00:00.000Z', to: '2019-02-22T15:00:00.000Z' },
    ],
    firstEventTime: '2018-09-05T18:08:10.400Z',
  }
  const hour = (iso: string): [Date, Date] => [new Date(iso), new Date(new Date(iso).getTime() + 60 * 60 * 1000)]

  it('集めていない日だけを見る窓はそのアーカイブを返す（止める）', () => {
    expect(findUncollectedArchiveSync([iburi], ...hour('2018-11-01T03:00:00.000Z'))?.id).toBe('2018-iburi')
    // 集めた日の終わりちょうどから始まる窓も、集めていない側だけを見る
    expect(findUncollectedArchiveSync([iburi], ...hour('2018-09-07T15:00:00.000Z'))?.id).toBe('2018-iburi')
  })

  // 対照: 集めた日に 1 秒でも掛かる窓は通す（掛かった分の電文は本物）
  it('集めた日に掛かる窓・集めた日の中の窓は null（止めない）', () => {
    expect(findUncollectedArchiveSync([iburi], ...hour('2018-09-06T03:00:00.000Z'))).toBeNull()
    expect(findUncollectedArchiveSync([iburi], ...hour('2018-09-07T14:30:00.000Z'))).toBeNull()
    // 初期状態（24 時間）が集めていない前日へはみ出しても、集めた日に掛かれば通す
    expect(findUncollectedArchiveSync([iburi], new Date('2018-10-04T03:00:00.000Z'), new Date('2018-10-05T03:00:00.000Z'))).toBeNull()
  })

  // 安全弁: 途切れなく集めたアーカイブ・収録範囲の外は従来どおり（止めない）
  it('収録範囲を全部集めたアーカイブと、収録範囲の外では null', () => {
    expect(findUncollectedArchiveSync([meta], ...hour('2011-03-11T05:50:00Z'))).toBeNull()
    expect(findUncollectedArchiveSync([iburi], ...hour('2020-01-01T00:00:00.000Z'))).toBeNull()
  })
})

describe('findArchiveJustEndedSync', () => {
  const index: HistoricalArchiveIndex = [meta]
  const WINDOW_MS = 3600_000

  it('収録終端ちょうど〜windowMs以内は「ついさっき終わった」として返す', () => {
    const to = new Date(meta.to)
    expect(findArchiveJustEndedSync(index, to, WINDOW_MS)?.id).toBe('2011-tohoku')
    expect(findArchiveJustEndedSync(index, new Date(to.getTime() + WINDOW_MS - 1), WINDOW_MS)?.id).toBe('2011-tohoku')
  })

  it('windowMsを超えて過ぎていれば null（DMDATA/P2PQuakeへ黙ってフォールバックしてよい）', () => {
    const to = new Date(meta.to)
    expect(findArchiveJustEndedSync(index, new Date(to.getTime() + WINDOW_MS), WINDOW_MS)).toBeNull()
  })

  it('収録範囲内（まだ終わっていない）は null', () => {
    expect(findArchiveJustEndedSync(index, new Date(meta.from), WINDOW_MS)).toBeNull()
  })
})

describe('listHistoricalArchives', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearLocalArchiveCache()
  })

  it('正常な空配列（収録0件）は成功として扱い、以後は再取得しない', async () => {
    mockFetchJson.mockResolvedValue([])

    await listHistoricalArchives()
    await listHistoricalArchives()

    expect(mockFetchJson).toHaveBeenCalledTimes(1)
  })

  it('取得失敗は恒久キャッシュせず、次回呼び出しで再取得を試みる（HIGH対策）', async () => {
    mockFetchJson.mockRejectedValueOnce(new Error('network error'))
    mockFetchJson.mockResolvedValueOnce([meta])

    const first = await listHistoricalArchives()
    const second = await listHistoricalArchives()

    expect(first).toEqual([])
    expect(second).toEqual([meta])
    expect(mockFetchJson).toHaveBeenCalledTimes(2)
  })

  it('トップレベルが配列でない配信破損も恒久キャッシュせず、次回に再取得を試みる（HIGH対策）', async () => {
    mockFetchJson.mockResolvedValueOnce({ not: 'an array' })
    mockFetchJson.mockResolvedValueOnce([meta])

    const first = await listHistoricalArchives()
    const second = await listHistoricalArchives()

    expect(first).toEqual([])
    expect(second).toEqual([meta])
    expect(mockFetchJson).toHaveBeenCalledTimes(2)
  })
})

describe('fetchLocalArchiveEvents', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearLocalArchiveCache()
  })

  it('指定範囲 [fromTime, toTime) の entries だけを ReplayEntry として返す', async () => {
    mockFetchJson.mockResolvedValueOnce({
      ...meta,
      entries: [
        { time: '2011-03-11T05:46:00Z', payload: { kind: 'event', event: validEew() } },
        { time: '2011-03-11T05:49:00Z', payload: { kind: 'event', event: validTsunami() } },
        { time: '2011-03-11T05:55:00Z', payload: { kind: 'event', event: validQuake() } },
      ],
    })

    const result = await fetchLocalArchiveEvents(meta, new Date('2011-03-11T05:47:00Z'), new Date('2011-03-11T05:50:00Z'))

    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].replayTime.toISOString()).toBe('2011-03-11T05:49:00.000Z')
    expect(skippedTotal(result.skippedByDay)).toBe(0)
    expect(result.failedArchiveUrls).toEqual([])
  })

  it('本体の取得・検証に失敗したら失敗アーカイブとして扱う（DMDATA側の「全滅」と同じ粒度）', async () => {
    mockFetchJson.mockRejectedValueOnce(new Error('network error'))

    const result = await fetchLocalArchiveEvents(meta, new Date(meta.from), new Date(meta.to))

    expect(result.entries).toEqual([])
    expect(result.failedArchiveUrls).toHaveLength(1)
  })

  it('検証に失敗した本体（配列でない等）も失敗として扱う', async () => {
    mockFetchJson.mockResolvedValueOnce({ not: 'a valid archive file' })

    const result = await fetchLocalArchiveEvents(meta, new Date(meta.from), new Date(meta.to))

    expect(result.entries).toEqual([])
    expect(result.failedArchiveUrls).toHaveLength(1)
  })

  it('同じ id への呼び出しは、成功時に本体取得を1回だけキャッシュする', async () => {
    mockFetchJson.mockResolvedValue({ ...meta, entries: [] })

    await fetchLocalArchiveEvents(meta, new Date(meta.from), new Date(meta.to))
    await fetchLocalArchiveEvents(meta, new Date(meta.from), new Date(meta.to))

    const bodyCalls = mockFetchJson.mock.calls.filter(([, label]) => label === `historical-archive ${meta.id}`)
    expect(bodyCalls).toHaveLength(1)
  })

  it('本体取得の失敗は恒久キャッシュせず、次回呼び出しで再取得を試みる（HIGH対策）', async () => {
    mockFetchJson.mockRejectedValueOnce(new Error('network error'))
    mockFetchJson.mockResolvedValueOnce({ ...meta, entries: [{ time: '2011-03-11T05:46:00Z', payload: { kind: 'event', event: validEew() } }] })

    const first = await fetchLocalArchiveEvents(meta, new Date(meta.from), new Date(meta.to))
    const second = await fetchLocalArchiveEvents(meta, new Date(meta.from), new Date(meta.to))

    expect(first.failedArchiveUrls).toHaveLength(1)
    expect(second.entries).toHaveLength(1)
    const bodyCalls = mockFetchJson.mock.calls.filter(([, label]) => label === `historical-archive ${meta.id}`)
    expect(bodyCalls).toHaveLength(2)
  })
})

describe('fetchLocalArchiveQuakeHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearLocalArchiveCache()
  })

  /**
   * 地震に畳めるだけの欄を持つ地震情報。`eventId`（14 桁）が同じなら同じ地震として畳まれる
   * （DMDATA の電文 ID の書式。→ `extractQuakeEventIdFromId`）。
   */
  const quakeOf = (eventId: string, serial: number, time: string) => validQuake({
    id: `dmdata-quake-${eventId}-${serial}`,
    eventId,
    time,
    issue: { source: '気象庁', time, type: '震源・震度情報', correct: 'なし' },
    earthquake: {
      time: '2016-04-14T12:26:00Z',
      hypocenter: { name: '熊本県熊本地方', latitude: 32.7, longitude: 130.8, depth: 10, magnitude: 6.5 },
      maxScale: 70,
      domesticTsunami: 'なし',
    },
    points: [],
  })
  const quakeEntry = (eventId: string, serial: number, time: string) =>
    ({ time, payload: { kind: 'event', event: quakeOf(eventId, serial, time) } })
  /** 履歴の窓（7 日）を見るには、収録範囲の広いアーカイブが要る。 */
  const wide: HistoricalArchiveMeta = { ...meta, from: '2016-04-01T00:00:00Z', to: '2016-04-30T00:00:00Z', coveredRanges: [{ from: '2016-04-01T00:00:00Z', to: '2016-04-30T00:00:00Z' }], firstEventTime: '2016-04-01T00:00:00Z' }
  const BEFORE = new Date('2016-04-16T00:00:00Z')

  it('before より前の地震（event.kind === quake）だけを返す', async () => {
    mockFetchJson.mockResolvedValueOnce({
      ...wide,
      entries: [
        { time: '2016-04-14T12:27:00Z', payload: { kind: 'event', event: validEew() } }, // quake以外は除外
        quakeEntry('20160414212600', 1, '2016-04-14T12:30:00Z'),
        quakeEntry('20160415000300', 1, '2016-04-15T00:10:00Z'),
        quakeEntry('20160416012500', 1, '2016-04-16T01:30:00Z'), // before以降は除外
      ],
    })

    const result = await fetchLocalArchiveQuakeHistory(wide, BEFORE, 7)

    expect(result.quakes.map(q => q.id).sort()).toEqual([
      'dmdata-quake-20160414212600-1', 'dmdata-quake-20160415000300-1',
    ])
    expect(skippedTotal(result.skippedByDay)).toBe(0)
    expect(result.failedArchiveUrls).toEqual([])
  })

  // 並びは新しい順（P2PQuake の履歴と同じ）。統合は同じ順位の報どうしで入力の並びが効くので固定する
  it('地震情報を収録の並びによらず新しい順に返す', async () => {
    mockFetchJson.mockResolvedValueOnce({
      ...wide,
      entries: [
        quakeEntry('20160415000300', 1, '2016-04-15T00:10:00Z'),
        quakeEntry('20160414212600', 2, '2016-04-14T12:40:00Z'),
        quakeEntry('20160415000300', 2, '2016-04-15T00:20:00Z'),
        quakeEntry('20160414212600', 1, '2016-04-14T12:30:00Z'),
      ],
    })

    const result = await fetchLocalArchiveQuakeHistory(wide, BEFORE, 7)

    expect(result.quakes.map(q => q.id)).toEqual([
      'dmdata-quake-20160415000300-2', 'dmdata-quake-20160415000300-1',
      'dmdata-quake-20160414212600-2', 'dmdata-quake-20160414212600-1',
    ])
  })

  // 正: 電文の件数で切っていた頃は、熊本の本震直前で 52 地震のうち 18 枚しか残らなかった
  it('件数では切らない（50 件を超える地震を全部返す）', async () => {
    const entries = Array.from({ length: 60 }, (_, i) => {
      const t = new Date(Date.parse('2016-04-15T00:00:00Z') + i * 60_000).toISOString()
      return quakeEntry(`201604150${String(1000 + i).padStart(5, '0')}`, 1, t)
    })
    mockFetchJson.mockResolvedValueOnce({ ...wide, entries })

    const result = await fetchLocalArchiveQuakeHistory(wide, BEFORE, 7)

    expect(result.quakes).toHaveLength(60)
  })

  // 正: 窓を地震で閉じる。窓の中に報を持つ地震は、窓より前の報も返す（途中で切れたカードを作らない）
  it('窓の中に報を持つ地震は、窓より前の報も一緒に返す', async () => {
    mockFetchJson.mockResolvedValueOnce({
      ...wide,
      entries: [
        quakeEntry('20160407230000', 1, '2016-04-07T14:00:00Z'), // 窓（04-09 JST 0 時〜）より前
        quakeEntry('20160407230000', 2, '2016-04-09T00:00:00Z'), // 同じ地震の続報が窓の中
      ],
    })

    const result = await fetchLocalArchiveQuakeHistory(wide, BEFORE, 7)

    expect(result.quakes.map(q => q.id).sort()).toEqual([
      'dmdata-quake-20160407230000-1', 'dmdata-quake-20160407230000-2',
    ])
  })

  // 対照: 報が全部窓より前の地震は返さない（7 日の窓が効いている）
  it('報が全部 7 日の窓より前の地震は返さない', async () => {
    mockFetchJson.mockResolvedValueOnce({
      ...wide,
      entries: [
        quakeEntry('20160402100000', 1, '2016-04-02T01:00:00Z'),
        quakeEntry('20160415000300', 1, '2016-04-15T00:10:00Z'),
      ],
    })

    const result = await fetchLocalArchiveQuakeHistory(wide, BEFORE, 7)

    expect(result.quakes.map(q => q.id)).toEqual(['dmdata-quake-20160415000300-1'])
  })

  it('同じ窓の津波と帯・長周期（extras）も返す', async () => {
    const band = (id: string, time: string) => ({
      time,
      payload: {
        kind: 'earthquakeCount',
        data: { id, time, eventId: '20160414212600', headline: '', items: [], cancelled: false, reportDateTime: time, expireAt: '2016-04-22T00:00:00Z' },
      },
    })
    const lpgm = (serial: number, time: string) => ({
      time,
      payload: { kind: 'lpgm', data: { id: `lpgm-${serial}`, eventId: '20160414212600', time, originTime: time, maxClass: 1, cancelled: false } },
    })
    mockFetchJson.mockResolvedValueOnce({
      ...wide,
      entries: [
        { time: '2016-04-14T12:40:00Z', payload: { kind: 'event', event: validTsunami({ id: 't1' }) } },
        band('c1', '2016-04-14T13:00:00Z'),
        band('c2', '2016-04-14T14:00:00Z'),
        lpgm(1, '2016-04-14T12:45:00Z'),
        lpgm(2, '2016-04-14T12:50:00Z'),
        { time: '2016-04-02T00:00:00Z', payload: { kind: 'event', event: validTsunami({ id: 't-old' }) } }, // 窓より前
      ],
    })

    const result = await fetchLocalArchiveQuakeHistory(wide, BEFORE, 7)

    expect(result.tsunamis.map(t => t.id)).toEqual(['t1'])
    // 帯は電文ごと、長周期は地震ごとに最新 1 通（鍵は historyExtraKey）。古い順
    expect(result.extras.map(e => e.payload.kind === 'lpgm' ? e.payload.data.id : e.payload.kind === 'earthquakeCount' ? e.payload.data.id : '?'))
      .toEqual(['lpgm-2', 'c1', 'c2'])
  })

  it('本体が読めなければ失敗アーカイブとして扱う', async () => {
    mockFetchJson.mockRejectedValueOnce(new Error('network error'))

    const result = await fetchLocalArchiveQuakeHistory(meta, new Date(meta.to), 7)

    expect(result.quakes).toEqual([])
    expect(result.failedArchiveUrls).toHaveLength(1)
  })
})
