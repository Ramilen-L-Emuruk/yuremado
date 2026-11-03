import { describe, expect, it } from 'vitest'
import type { JMAQuake } from '../../src/types/earthquake'
import {
  archiveDaysOf, catalogSecondOf, type FeltEvent, type FeltQuake, type FeltReport, feltQuakeOf, latestPerEvent, matchFeltQuakes, segmentsOfDays,
} from './kyoshinFeltQuakes'

const JST = 9 * 3_600_000
// 2024-01-02 07:37 JST（能登の群発の最中。同じ分に M3.9 と M4.2 が 17 秒違いで起きた形）
const MINUTE = Date.parse('2024-01-02T07:37:00+09:00')
const FELT: FeltQuake = { eventId: 'e1', minuteMs: MINUTE, lat: 37.5, lng: 137.3, depth: 10, mag: 4.3, maxScale: 30, area: '石川県能登地方', issuedMs: MINUTE + 300_000 }
const ORIGIN = '2024-01-02T07:37:00+09:00'
const FIRST = { t: MINUTE + 32_800, lat: 37.51, lng: 137.31, depth: 12, mag: 3.9 }
const SECOND = { t: MINUTE + 49_500, lat: 37.51, lng: 137.29, depth: 12, mag: 4.2 }

const quake = (over: { cancelled?: boolean; type?: string; maxScale?: number; lat?: number; eventId?: string; issued?: string }): JMAQuake => ({
  kind: 'quake', id: 'x', eventId: over.eventId ?? '20240101223700', time: '', cancelled: over.cancelled,
  issue: { source: '', time: over.issued ?? '2024-01-02T07:42:00+09:00', type: over.type ?? '震源・震度情報', correct: 'None' },
  earthquake: {
    // 読み取りの earthquake.time は発現時刻が優先で入る。発生時刻の次の分にしておき、こちらを使わないことを確かめる
    time: '2024-01-02T07:38:00+09:00', maxScale: over.maxScale ?? 30, domesticTsunami: 'None',
    hypocenter: { name: '石川県能登地方', latitude: over.lat ?? 37.5, longitude: 137.3, depth: 10, magnitude: 4.3 },
  },
  points: [],
} as unknown as JMAQuake)

const felt = (r: FeltReport) => (r.kind === 'felt' ? r.quake : null)

describe('地震情報から有感の地震を取り出す', () => {
  it('正: 震源・震度情報で震度1 以上なら、電文の発生時刻（分）と震央で取り出す', () => {
    expect(felt(feltQuakeOf(quake({}), ORIGIN))).toMatchObject({ minuteMs: MINUTE, lat: 37.5, lng: 137.3, mag: 4.3, maxScale: 30 })
  })

  it('対照: 別の種別・震度1 未満・位置不明は数えないと決まった報、取消は取消の報として分ける', () => {
    expect(feltQuakeOf(quake({ type: '震度速報' }), ORIGIN).kind).toBe('skip')
    expect(feltQuakeOf(quake({ maxScale: 0 }), ORIGIN).kind).toBe('skip')
    expect(feltQuakeOf(quake({ lat: -200 }), ORIGIN).kind).toBe('skip')
    expect(feltQuakeOf(quake({ cancelled: true }), ORIGIN)).toMatchObject({ kind: 'cancel', eventId: '20240101223700' })
  })

  it('安全弁: 読めるはずの欄が読めない報は、数えない報と分けて「読めなかった」にする（黙って母数から消さない）', () => {
    expect(feltQuakeOf(quake({}), null).kind).toBe('invalid')
    expect(feltQuakeOf(quake({}), '日時でない').kind).toBe('invalid')
    expect(feltQuakeOf(quake({ eventId: '' }), ORIGIN).kind).toBe('invalid')
  })

  it('安全弁: 時刻は電文の発生時刻を使い、読み取りの earthquake.time（発現時刻・次の分）は使わない', () => {
    expect(felt(feltQuakeOf(quake({}), ORIGIN))?.minuteMs).toBe(MINUTE)
  })
})

describe('同じ地震の報をまとめる', () => {
  const later = (issued: string): FeltReport => feltQuakeOf(quake({ issued }), ORIGIN)
  const cancel = (issued: string): FeltReport => feltQuakeOf(quake({ cancelled: true, issued }), ORIGIN)

  it('正: 同じ地震の報が複数あれば、発表の遅い報を採る（渡す順によらない）', () => {
    const a = later('2024-01-02T07:42:00+09:00'), b = later('2024-01-02T08:30:00+09:00')
    expect(latestPerEvent([a, b]).quakes).toEqual([felt(b)])
    expect(latestPerEvent([b, a]).quakes).toEqual([felt(b)])
  })

  it('対照: 取消が最後の報なら、その地震を落として数える', () => {
    expect(latestPerEvent([later('2024-01-02T07:42:00+09:00'), cancel('2024-01-02T08:00:00+09:00')])).toEqual({ quakes: [], cancelled: 1 })
  })

  it('安全弁: 取消の後にまた報が出たら、その報を採る', () => {
    const r = latestPerEvent([cancel('2024-01-02T08:00:00+09:00'), later('2024-01-02T08:30:00+09:00')])
    expect(r.cancelled).toBe(0)
    expect(r.quakes).toHaveLength(1)
  })
})

describe('震源リストから発生時刻を秒まで引く', () => {
  it('正: 同じ分に近くの地震が 2 つあれば、M の近いほう（後の M4.2）を選ぶ', () => {
    expect(catalogSecondOf(FELT, [FIRST, SECOND])).toBe(SECOND.t)
  })

  it('対照: 次の分の頭ちょうど・30 km より遠い地震は選ばない', () => {
    expect(catalogSecondOf(FELT, [{ ...SECOND, t: MINUTE + 60_000 }])).toBeNull()
    expect(catalogSecondOf(FELT, [{ ...SECOND, lat: 37.8 }])).toBeNull()
  })

  it('安全弁: M が判らなければ距離だけで選ぶ（NaN で比べ損ねない）', () => {
    const far = { ...FIRST, lat: 37.6 }
    expect(catalogSecondOf({ ...FELT, mag: NaN }, [far, SECOND])).toBe(SECOND.t)
    expect(catalogSecondOf(FELT, [far, { ...SECOND, mag: NaN }])).toBe(SECOND.t)
  })
})

describe('読むアーカイブの日', () => {
  it('正: 流した最後の日の次の日（日本時間）も読む。23 時台の地震の報は 0 時を過ぎて出ることがある', () => {
    expect(archiveDaysOf(['20240101', '20240102'])).toEqual(['2024-01-01', '2024-01-02', '2024-01-03'])
  })

  it('対照: 流した日より前の日は読まない', () => {
    expect(archiveDaysOf(['20240105'])[0]).toBe('2024-01-05')
  })

  it('安全弁: 飛んだ日はそれぞれの次の日を読み、重ならない', () => {
    expect(archiveDaysOf(['20240101', '20240103', '20240102'])).toEqual(['2024-01-01', '2024-01-02', '2024-01-03', '2024-01-04'])
    expect(archiveDaysOf(['20240101', '20240105'])).toEqual(['2024-01-01', '2024-01-02', '2024-01-05', '2024-01-06'])
  })
})

describe('有感の地震と束を突き合わせる', () => {
  // 先の M3.9 の揺れで見え始めた束（発生の 5 秒後・震央から数 km）
  const bundle: FeltEvent = { firstLikelyMs: FIRST.t + 5_000 + JST, firstConfirmedMs: null, pos: [37.52, 137.3], maxMembers: 271, inWarmup: false }
  const days = ['20240102']

  it('正: 秒まで引くと、同じ分に先に起きた地震の束を当たりに数えない', () => {
    const { rows } = matchFeltQuakes([FELT], [bundle], days, 600, [], JST, () => [FIRST, SECOND])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ t: SECOND.t, fromCatalog: true })
    expect(rows[0].matched).toEqual([])
  })

  it('対照: 震源リストに見つからなければ分のまま照合し、同じ束が当たる', () => {
    const { rows } = matchFeltQuakes([FELT], [bundle], days, 600, [], JST, () => [])
    expect(rows[0]).toMatchObject({ t: MINUTE, fromCatalog: false })
    expect(rows[0].matched).toEqual([bundle])
  })

  it('安全弁: 助走の間・終わり際・秒フレームの無い時間の地震は数えずに分け、流した日の外の地震は落とし、助走の間に見え始めた束は当てない', () => {
    const early = { ...FELT, eventId: 'e0', minuteMs: Date.parse('2024-01-02T00:05:00+09:00') }
    const late = { ...FELT, eventId: 'e3', minuteMs: Date.parse('2024-01-02T23:59:00+09:00') }
    const blind = { ...FELT, eventId: 'e4', minuteMs: Date.parse('2024-01-02T12:30:00+09:00') }
    // 欠けた時間（12 時台）の 1 分前と、欠けの後の助走（13:00〜13:10）の内
    const beforeBlind = { ...FELT, eventId: 'e5', minuteMs: Date.parse('2024-01-02T11:59:00+09:00') }
    const afterBlind = { ...FELT, eventId: 'e6', minuteMs: Date.parse('2024-01-02T13:05:00+09:00') }
    // 対照: 欠けの前の 2 分より前・助走の後は数える
    const wellBefore = { ...FELT, eventId: 'e7', minuteMs: Date.parse('2024-01-02T11:50:00+09:00') }
    const wellAfter = { ...FELT, eventId: 'e8', minuteMs: Date.parse('2024-01-02T13:15:00+09:00') }
    const outsideDay = { ...FELT, eventId: 'e2', minuteMs: MINUTE + 86_400_000 }
    const { rows, outside } = matchFeltQuakes(
      [early, FELT, wellBefore, beforeBlind, blind, afterBlind, wellAfter, late, outsideDay], [{ ...bundle, inWarmup: true }], days, 600,
      [{ day: '20240102', hour: 12 }], JST, () => [],
    )
    expect(outside.map((q) => q.eventId)).toEqual(['e0', 'e5', 'e4', 'e6', 'e3'])
    expect(rows.map((r) => r.quake.eventId)).toEqual(['e1', 'e7', 'e8'])
    expect(rows[0].matched).toEqual([])
  })

  it('安全弁: 流した日の外の地震では震源リストを引かない（流していない日の控えを要らない）', () => {
    const asked: string[] = []
    matchFeltQuakes([{ ...FELT, eventId: 'e2', minuteMs: MINUTE + 86_400_000 }], [], days, 600, [], JST, (q) => { asked.push(q.eventId); return [] })
    expect(asked).toEqual([])
  })

  it('安全弁: 続いた日は 1 つの区間にまとめ、飛んだ日は分ける', () => {
    expect(segmentsOfDays(['20240103', '20240101', '20240102', '20240105'])).toEqual([
      { from: Date.parse('2024-01-01T00:00:00+09:00'), to: Date.parse('2024-01-04T00:00:00+09:00') },
      { from: Date.parse('2024-01-05T00:00:00+09:00'), to: Date.parse('2024-01-06T00:00:00+09:00') },
    ])
  })
})
