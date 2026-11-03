import { describe, expect, it } from 'vitest'
import type { JMAQuake } from '../../src/types/earthquake'
import {
  archiveDaysOf, areaScalesOf, catalogSecondOf, type FeltEvent, type FeltQuake, type FeltReport, feltQuakeOf, latestPerEvent, matchFeltQuakes,
  latestQuakeStates, latestShindoPerEvent, linkShindo, matchShindoOnly, type ShindoOnly, type ShindoReport, segmentsOfDays, shindoReportOf,
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

describe('地域ごとの最大震度', () => {
  const withPoints = (points: unknown[]) => ({ ...quake({}), points } as unknown as JMAQuake)

  it('正: 地域の行の震度を、地域ごとに大きいほうで取る', () => {
    const q = withPoints([
      { pref: '', addr: '石川県能登', isArea: true, scale: 30 },
      { pref: '', addr: '石川県能登', isArea: true, scale: 40 },
      { pref: '', addr: '石川県加賀', isArea: true, scale: 20 },
    ])
    expect([...areaScalesOf(q)]).toEqual([['石川県能登', 40], ['石川県加賀', 20]])
  })

  it('対照: 県の行（pref に県名が入る）と観測点の行は地域に数えない', () => {
    const q = withPoints([
      { pref: '石川県', addr: '石川県', isArea: true, scale: 40 },
      { pref: '', addr: '輪島市門前町走出', isArea: false, scale: 50 },
      { pref: '', addr: '石川県能登', isArea: true, scale: 30 },
    ])
    expect([...areaScalesOf(q)]).toEqual([['石川県能登', 30]])
  })

  it('安全弁: 震度5弱以上未入電の行（下限の 45 を仮に置いたもの）は最大震度を押し上げない', () => {
    const q = withPoints([
      { pref: '', addr: '石川県能登', isArea: true, scale: 45, unreceived: true },
      { pref: '', addr: '石川県加賀', isArea: true, scale: 30 },
    ])
    expect([...areaScalesOf(q)]).toEqual([['石川県加賀', 30]])
  })
})

describe('震度速報を読む', () => {
  const sq = (over: { cancelled?: boolean; eventId?: string; points?: unknown[] } = {}) => ({
    ...quake({ eventId: over.eventId ?? 's1', cancelled: over.cancelled }),
    points: over.points ?? [{ pref: '', addr: '石川県能登', isArea: true, scale: 30 }, { pref: '', addr: '石川県加賀', isArea: true, scale: 20 }],
  } as unknown as JMAQuake)
  const T = '2024-01-04T17:16:00+09:00', R = '2024-01-04T17:17:30+09:00'

  it('正: 最大震度と、その震度の地域を取り、時刻は分で切り捨てる', () => {
    expect(shindoReportOf(sq(), '2024-01-04T17:16:20+09:00', R)).toEqual({
      kind: 'shindo', issuedMs: Date.parse(R),
      shindo: { eventId: 's1', minuteMs: Date.parse(T), maxScale: 30, topAreas: ['石川県能登'] },
    })
  })

  it('対照: 取消は取消の報として分ける（地域が無くても読めなかったことにしない）', () => {
    expect(shindoReportOf(sq({ cancelled: true, points: [] }), T, R)).toEqual({ kind: 'cancel', eventId: 's1', issuedMs: Date.parse(R) })
  })

  it('安全弁: 地域の震度が 1 つも読めない報・時刻の読めない報・EventID の無い報は、黙って落とさず読めなかった報にする', () => {
    expect(shindoReportOf(sq({ points: [{ pref: '石川県', addr: '石川県', isArea: true, scale: 30 }] }), T, R).kind).toBe('invalid')
    expect(shindoReportOf(sq(), null, R).kind).toBe('invalid')
    expect(shindoReportOf(sq(), T, null).kind).toBe('invalid')
    expect(shindoReportOf(sq({ eventId: '' }), T, R).kind).toBe('invalid')
    expect(shindoReportOf(null, T, R).kind).toBe('invalid')
  })
})

describe('報を EventID ごとにまとめる（震度速報・震源・震度情報の状態）', () => {
  const S = (id: string, issuedMs: number): ShindoReport =>
    ({ kind: 'shindo', issuedMs, shindo: { eventId: id, minuteMs: 0, maxScale: 30, topAreas: ['石川県能登'] } })
  const C = (id: string, issuedMs: number): ShindoReport => ({ kind: 'cancel', eventId: id, issuedMs })

  it('正: 震度速報は発表の遅い報を採り、それが取消なら落として数える（渡す順によらない）', () => {
    expect(latestShindoPerEvent([S('a', 1), C('a', 2)])).toEqual({ shindo: [], cancelled: 1 })
    expect(latestShindoPerEvent([C('a', 2), S('a', 1)])).toEqual({ shindo: [], cancelled: 1 })
    expect(latestShindoPerEvent([C('a', 1), S('a', 2)]).shindo.map((s) => s.eventId)).toEqual(['a'])
  })

  const felt53 = (id: string, issued: string): FeltReport => feltQuakeOf(quake({ eventId: id, issued }), ORIGIN)
  const noto = new Map([['石川県能登', 30]])

  it('正: 震源・震度情報は発表の遅い報の状態と地域を採る（並べた順ではなく発表時刻で）', () => {
    const late = felt53('q', '2024-01-02T08:00:00+09:00'), early = felt53('q', '2024-01-02T07:42:00+09:00')
    const st = latestQuakeStates([{ report: late, areas: noto }, { report: early, areas: new Map([['石川県加賀', 20]]) }])
    expect(st.get('q')).toEqual({ state: 'felt', areas: noto })
  })

  it('対照: 最後が取消なら cancel、数えない報しか無ければ skip', () => {
    const cancel = feltQuakeOf(quake({ eventId: 'q', cancelled: true, issued: '2024-01-02T09:00:00+09:00' }), ORIGIN)
    expect(latestQuakeStates([{ report: felt53('q', '2024-01-02T07:42:00+09:00'), areas: noto }, { report: cancel, areas: new Map() }]).get('q')?.state).toBe('cancel')
    const skip = feltQuakeOf(quake({ eventId: 'p', lat: -200 }), ORIGIN)
    expect(latestQuakeStates([{ report: skip, areas: noto }]).get('p')).toEqual({ state: 'skip', areas: new Map() })
  })

  it('安全弁: 数える報の後に数えない報が出ても felt のまま（latestPerEvent と同じく数えない報は比べない。食い違うと二重に数える）', () => {
    const skipLater = feltQuakeOf(quake({ eventId: 'q', lat: -200, issued: '2024-01-02T09:00:00+09:00' }), ORIGIN)
    const reports = [{ report: felt53('q', '2024-01-02T07:42:00+09:00'), areas: noto }, { report: skipLater, areas: new Map() }]
    expect(latestQuakeStates(reports).get('q')?.state).toBe('felt')
    expect(latestPerEvent(reports.map((r) => r.report)).quakes.map((q) => q.eventId)).toEqual(['q'])
  })
})

describe('震度速報だけの地震', () => {
  // 2024-01-04 17:16 の形: 震度速報が出た後、別の EventID で同じ分に発生した震源・震度情報が出る
  const S_MIN = Date.parse('2024-01-04T17:16:00+09:00')
  const shindo: ShindoOnly = { eventId: 's1', minuteMs: S_MIN, maxScale: 30, topAreas: ['石川県能登'] }
  const f = (eventId: string, minuteMs: number, pairs: [string, number][]) => ({ eventId, minuteMs, areas: new Map(pairs) })
  const none = new Set<string>()

  it('正: 震度速報の 3 分前〜1 分後に、最大震度の地域を同じ震度で持つ震源・震度情報があれば結ぶ', () => {
    for (const dt of [-3 * 60_000, -60_000, 60_000]) {
      expect(linkShindo([shindo], [f('q', S_MIN + dt, [['石川県能登', 30]])], none)).toEqual({ unlinked: [], links: [{ eventId: 's1', to: 'q', candidates: 1 }] })
    }
  })

  it('対照: 窓の外・震度が違う・地域が違うなら結ばない', () => {
    for (const cand of [f('q', S_MIN - 4 * 60_000, [['石川県能登', 30]]), f('q', S_MIN + 2 * 60_000, [['石川県能登', 30]]),
      f('q', S_MIN, [['石川県能登', 20]]), f('q', S_MIN, [['石川県加賀', 30]])]) {
      expect(linkShindo([shindo], [cand], none).unlinked).toEqual([shindo])
    }
  })

  it('安全弁: 結び先は 1 対 1。発生の近い候補を採り、使った先と自分の震度速報を持つ先はほかに使わない', () => {
    const near = f('near', S_MIN, [['石川県能登', 30]]), farther = f('far', S_MIN - 2 * 60_000, [['石川県能登', 30]])
    const second = { ...shindo, eventId: 's2', minuteMs: S_MIN + 60_000 }
    const r = linkShindo([second, shindo], [farther, near], none)
    expect(r.links).toEqual([{ eventId: 's1', to: 'near', candidates: 2 }, { eventId: 's2', to: 'far', candidates: 1 }])
    // 群発で同じ地域・同じ震度の別の地震しか無く、それが自分の震度速報を持つなら結ばない
    expect(linkShindo([shindo], [near], new Set(['near'])).unlinked).toEqual([shindo])
  })

  const NOTO: [number, number] = [37.208, 136.947]
  const labelOf = (a: string) => (a === '石川県能登' ? NOTO : null)
  const ev = (seenMs: number, pos: [number, number], over: Partial<FeltEvent> = {}): FeltEvent =>
    ({ firstLikelyMs: seenMs + JST, firstConfirmedMs: null, pos, maxMembers: 10, inWarmup: false, ...over })
  const days = ['20240104']

  it('正: 結べなかった震度速報は、地域の代表点から 150 km の内で、分の頭の 10 秒前〜180 秒後に見え始めた束に当てる', () => {
    const edges = [ev(S_MIN - 10_000, [37.4, 137.0]), ev(S_MIN + 180_000, [37.4, 137.0])]
    const { rows } = matchShindoOnly([shindo], edges, days, 600, [], JST, labelOf)
    expect(rows[0].matched).toEqual(edges)
    expect(rows[0].km.every((k) => k > 0 && k < 30)).toBe(true)
  })

  it('対照: 遠い束・窓の外の束・助走の間に見え始めた束は当てない', () => {
    const far = ev(S_MIN + 30_000, [35.0, 139.5])
    const tooEarly = ev(S_MIN - 11_000, [37.4, 137.0])
    const tooLate = ev(S_MIN + 181_000, [37.4, 137.0])
    const warm = ev(S_MIN + 30_000, [37.4, 137.0], { inWarmup: true })
    const { rows } = matchShindoOnly([shindo], [far, tooEarly, tooLate, warm], days, 600, [], JST, labelOf)
    expect(rows).toEqual([{ shindo, matched: [], km: [] }])
  })

  it('安全弁: 終わり際の余白は窓の後ろの 180 秒。見ていない時刻は outside、代表点を 1 つでも引けなければ noLabel、流していない日は unrun に数える', () => {
    const dayEnd = Date.parse('2024-01-05T00:00:00+09:00')
    const nearEnd = { ...shindo, eventId: 'e1', minuteMs: dayEnd - 170_000 } // 余白 120 秒なら見ていた扱いになる位置
    const beforeEnd = { ...shindo, eventId: 'e2', minuteMs: dayEnd - 190_000 }
    const blind = { ...shindo, eventId: 's2', minuteMs: Date.parse('2024-01-04T12:30:00+09:00') }
    const partial = { ...shindo, eventId: 's3', topAreas: ['石川県能登', 'どこでもない地域'] }
    const otherDay = { ...shindo, eventId: 's4', minuteMs: S_MIN + 86_400_000 }
    const r = matchShindoOnly([shindo, blind, partial, otherDay, nearEnd, beforeEnd], [], days, 600, [{ day: '20240104', hour: 12 }], JST, labelOf)
    expect(r.rows.map((x) => x.shindo.eventId)).toEqual(['s1', 'e2'])
    expect(r.outside.map((s) => s.eventId)).toEqual(['s2', 'e1'])
    expect(r.noLabel.map((s) => s.eventId)).toEqual(['s3'])
    expect(r.unrun).toBe(1)
  })
})
