// 予報の発表状況（fc_hist）の個別ページを読む。材料は Wayback Machine の控えから取った実ページ
// （2016-04-16 01:25 熊本県熊本地方の地震。scripts/fc-hist-20160416012510.fixture.html。BOM 付きの UTF-8 のまま）。
//
// fc_hist は警報の発表状況（pub_hist）と表の作りが同じで、震源要素の表の書式だけが違う ——
// 発生時刻が分まで（「平成28年04月16日01時25分」）・緯度経度が10進度（「32.8」）。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseDegMin, parseEewContentHtml, parseWarekiDateTime, warekiDateTimeHasSeconds } from './historicalEewParser'
import { buildEewEntries } from './historicalEewArchiveBuilder'
import { loadCatalogYear, matchCatalogOrigin, type CatalogYear } from './catalogOriginTime'
import type { EEWAlert } from '../src/types/earthquake'

const SAMPLE = readFileSync(join(__dirname, 'fc-hist-20160416012510.fixture.html'), 'utf-8')
const ROOT = join(__dirname, '..')

describe('和暦日時の 2 つの書式', () => {
  it('正: 分までの書式（fc_hist）も読み、秒は 0 として返す', () => {
    expect(parseWarekiDateTime('平成28年04月16日01時25分')).toBe('2016-04-15T16:25:00.000Z')
    expect(warekiDateTimeHasSeconds('平成28年04月16日01時25分')).toBe(false)
  })

  it('対照: 秒までの書式（pub_hist）は今までどおり読み、秒まであると答える', () => {
    expect(parseWarekiDateTime('平成28年04月16日01時25分05.4秒')).toBe('2016-04-15T16:25:05.400Z')
    expect(warekiDateTimeHasSeconds('平成28年04月16日01時25分05.4秒')).toBe(true)
  })

  it('安全弁: どちらの書式でもなければ例外', () => {
    expect(() => parseWarekiDateTime('平成28年04月16日01時')).toThrow()
    expect(() => warekiDateTimeHasSeconds('2016-04-16 01:25')).toThrow()
  })
})

describe('震源要素の緯度経度の 2 つの書式', () => {
  it('正: 10進度（fc_hist）を読む', () => {
    expect(parseDegMin('32.8')).toBe(32.8)
  })

  it('対照: 度分（pub_hist）は今までどおり', () => {
    expect(parseDegMin('32°44.5′')).toBeCloseTo(32.74167, 4)
  })

  it('安全弁: どちらでもない書式は例外', () => {
    expect(() => parseDegMin('32.8N')).toThrow()
  })
})

describe('fc_hist の実ページを読む', () => {
  const parsed = parseEewContentHtml(SAMPLE)

  it('震源要素の表（BOM 付きのまま読める）', () => {
    expect(parsed.hypocenter.name).toBe('熊本県熊本地方')
    expect(parsed.hypocenter.latitude).toBe(32.8)
    expect(parsed.hypocenter.longitude).toBe(130.8)
    expect(parsed.hypocenter.depthKm).toBe(10)
    expect(parsed.hypocenter.magnitude).toBe(7.1)
    expect(parsed.hypocenter.originTimeIso).toBe('2016-04-15T16:25:00.000Z')
    expect(parsed.hypocenter.originTimeHasSeconds).toBe(false)
  })

  it('報の表: 検知時刻の行と 12 報。警報の行は第1報と第4報', () => {
    expect(parsed.reports.map((r) => r.reportNum)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(parsed.reports.filter((r) => r.isPublicWarningRow).map((r) => r.reportNum)).toEqual([1, 4])
    expect(parsed.reports[1].timeIso).toBe('2016-04-15T16:25:14.000Z')
  })

  it('区域ごとの予測震度の表: ※1〜※6', () => {
    expect([...parsed.footnotes.keys()]).toEqual(['※1', '※2', '※3', '※4', '※5', '※6'])
    expect(parsed.footnotes.get('※6')?.[0]).toEqual({ scaleFrom: 55, scaleTo: 70, regionNames: ['熊本県熊本'] })
  })
})

describe('fc_hist の実ページから EEW を組み立てる', () => {
  const entries = buildEewEntries(parseEewContentHtml(SAMPLE), {
    idPrefix: 'test',
    eventId: '20160416012510',
    originTimeIso: '2016-04-15T16:25:05.470Z',
  })
  const events = entries.map((e) => (e.payload as { event: EEWAlert }).event)

  it('正: 予報の報も含め 12 報。EventID と発生時刻は渡した値', () => {
    expect(events).toHaveLength(12)
    expect(new Set(events.map((e) => e.issue?.eventId))).toEqual(new Set(['20160416012510']))
    expect(new Set(events.map((e) => e.earthquake.originTime))).toEqual(new Set(['2016-04-15T16:25:05.470Z']))
  })

  it('正: 第1報が警報の行なので、以後はすべて警報。最終報は第12報だけ', () => {
    expect(events.map((e) => e.severity)).toEqual(Array(12).fill('Warning'))
    expect(events.filter((e) => e.isFinal).map((e) => e.issue?.serial)).toEqual(['12'])
  })

  it('安全弁: EventID が 14 桁でなければ例外（発生時刻から作り直さない）', () => {
    expect(() =>
      buildEewEntries(parseEewContentHtml(SAMPLE), { idPrefix: 'test', eventId: '201604160125', originTimeIso: '2016-04-15T16:25:05.470Z' }),
    ).toThrow(/EventID/)
  })
})

describe('発生時刻の秒を震源カタログで補う', () => {
  let catalog: CatalogYear
  const load = async () => (catalog ??= await loadCatalogYear(ROOT, 2016))
  // 2016-04-16 01:25 の地震。EventID は 01:25:10（地震波を検知した時刻）
  const mainshock = { eventIdIso: '2016-04-15T16:25:10.000Z', minuteIso: '2016-04-15T16:25:00.000Z', latitude: 32.8, longitude: 130.8, magnitude: 7.1 }

  it('正: 表の値（緊急地震速報の最終報。M7.1）から、カタログの地震（M7.3）の秒まである発生時刻を返す', async () => {
    const m = matchCatalogOrigin(mainshock, await load())
    expect(m.kind).toBe('matched')
    if (m.kind === 'matched') {
      // 警報の発表状況（pub_hist）は同じ地震を 01時25分05.4秒 と書いている
      const delta = new Date(m.originTimeIso).getTime() - Date.parse('2016-04-15T16:25:05.400Z')
      expect(delta).toBeGreaterThanOrEqual(0)
      expect(delta).toBeLessThan(100)
    }
  })

  it('対照: EventID と表の分が 2 分ずれた地震には当てない', async () => {
    const m = matchCatalogOrigin(
      { ...mainshock, eventIdIso: '2016-04-15T16:27:10.000Z', minuteIso: '2016-04-15T16:27:00.000Z' },
      await load(),
    )
    expect(m.kind).toBe('none')
  })

  it('安全弁: 位置が無ければ当てない（呼び出し側が EventID の時刻で代える）', async () => {
    const m = matchCatalogOrigin({ ...mainshock, latitude: null, longitude: null }, await load())
    expect(m.kind).toBe('none')
  })

  it('正: 候補が 2 つあれば EventID の時刻に近いほうを採る', () => {
    const t = Date.parse('2016-04-15T16:25:00.000Z')
    const two: CatalogYear = { timeMs: [t + 1000, t + 8000], lat: [32.8, 32.8], lng: [130.8, 130.8], magnitude: [3.0, 3.0] }
    const m = matchCatalogOrigin({ ...mainshock, magnitude: 3.0 }, two)
    expect(m).toEqual({ kind: 'matched', originTimeIso: new Date(t + 8000).toISOString(), candidates: 2 })
  })

  it('対照: M の決まっていない候補が EventID に近くても、M が合う候補を採る', () => {
    const t = Date.parse('2016-04-15T16:25:00.000Z')
    const two: CatalogYear = { timeMs: [t + 2000, t + 9000], lat: [32.8, 32.8], lng: [130.8, 130.8], magnitude: [3.0, NaN] }
    const m = matchCatalogOrigin({ ...mainshock, magnitude: 3.0 }, two)
    expect(m).toEqual({ kind: 'matched', originTimeIso: new Date(t + 2000).toISOString(), candidates: 2 })
  })

  it('安全弁: M の合う候補が無く M の決まっていない候補だけなら、そちらを採る（候補は数える）', () => {
    const t = Date.parse('2016-04-15T16:25:00.000Z')
    const two: CatalogYear = { timeMs: [t + 2000, t + 9000], lat: [32.8, 32.8], lng: [130.8, 130.8], magnitude: [NaN, 6.0] }
    const m = matchCatalogOrigin({ ...mainshock, magnitude: 3.0 }, two)
    expect(m).toEqual({ kind: 'matched', originTimeIso: new Date(t + 2000).toISOString(), candidates: 1 })
  })
})

// 取消（キャンセル報）の地震。材料は 2016-04-16 02:33 の実ページ（scripts/fc-hist-20160416023300.fixture.html）。
// 震源要素の表は「(キャンセル報)」と「---」、最後の行の報番号の欄が「キャンセル」になる。
const CANCEL_SAMPLE = readFileSync(join(__dirname, 'fc-hist-20160416023300.fixture.html'), 'utf-8')

describe('fc_hist の取消（キャンセル報）の地震', () => {
  const parsed = parseEewContentHtml(CANCEL_SAMPLE)

  it('震源要素の表の「(キャンセル報)」は地名にしない。「---」は値なし', () => {
    expect(parsed.hypocenter.name).toBe('')
    expect(parsed.hypocenter.latitude).toBeNull()
    expect(parsed.hypocenter.depthKm).toBeNull()
    expect(parsed.hypocenter.magnitude).toBeNull()
  })

  it('取消の行は前の報の次の番号で、取消の印が立つ', () => {
    expect(parsed.reports.map((r) => [r.reportNum, r.isCancellation])).toEqual([
      [0, false],
      [1, false],
      [2, false],
      [3, true],
    ])
  })

  const events = buildEewEntries(parsed, { idPrefix: 'test', eventId: '20160416023300', originTimeIso: '2016-04-15T17:33:00.000Z' }).map(
    (e) => (e.payload as { event: EEWAlert }).event,
  )

  it('正: 取消はライブの取消電文と同じ形（予想を残さない・最終報）', () => {
    const cancel = events[events.length - 1]
    expect(cancel.cancelled).toBe(true)
    expect(cancel.isFinal).toBe(true)
    expect(cancel.areas).toEqual([])
    expect(cancel.forecastMaxScale).toBeUndefined()
    expect(cancel.earthquake.hypocenter.latitude).toBe(-200)
    expect(cancel.earthquake.originTime).toBe('')
    expect(cancel.issue?.serial).toBe('3')
  })

  it('対照: 取消より前の報は取消でも最終報でもない', () => {
    expect(events.slice(0, -1).map((e) => [e.cancelled, e.isFinal])).toEqual([
      [false, false],
      [false, false],
    ])
  })
})

describe('深さ「ごく浅い」', () => {
  it('0 km として読む（アプリでも深さ 0 は「ごく浅い」）', () => {
    const html = SAMPLE.replace('<td>10km</td><td>7.1</td><td>６強</td>', '<td>ごく浅い</td><td>7.1</td><td>６強</td>')
    expect(parseEewContentHtml(html).hypocenter.depthKm).toBe(0)
  })

  it('安全弁: 書式の分からない深さは例外', () => {
    const html = SAMPLE.replace('<td>10km</td><td>7.1</td><td>６強</td>', '<td>浅い</td><td>7.1</td><td>６強</td>')
    expect(() => parseEewContentHtml(html)).toThrow(/深さ/)
  })
})
