// 同じ地震について届いた報のうち、発表が最も新しい報の値を地震カードの上段へ当てる規則
// （2026-11-03 ユーザー選択「発表時刻が最も新しい報 (Recommended)」「長周期と同じくカード本体へまとめる (Recommended)」）。
import { describe, it, expect } from 'vitest'
import { withLatestQuakeFacts, latestQuakeFactsIntoCards } from './latestQuakeFacts'
import './quakeMerge'
import type { JMAQuake, JMAEstimatedIntensity, JMALpgm } from '../types/earthquake'
import { CELL_LAT_DEG, CELL_LON_DEG } from './bufrEstimatedIntensity'

const EVENT = '20240101161010'

function quake(reportTime: string, magnitude = 7.4): JMAQuake {
  return {
    kind: 'quake',
    id: `dmdata-quake-${EVENT}-1`,
    time: reportTime,
    issue: { source: '気象庁', time: reportTime, type: '震源・震度情報', correct: 'なし' },
    earthquake: {
      time: '2024-01-01T16:10:00+09:00',
      hypocenter: { name: '石川県能登地方', latitude: 37.5, longitude: 137.2, depth: 0, magnitude },
      maxScale: 70,
      domesticTsunami: '警報等',
    },
    points: [],
  } as unknown as JMAQuake
}

function lpgm(reportTime: string, magnitude = 7.6, extra: Partial<JMALpgm> = {}): JMALpgm {
  return {
    id: 'lpgm1', eventId: EVENT, time: reportTime, originTime: '2024-01-01T16:10:00+09:00',
    maxClass: 4, cancelled: false, magnitude, maxInt: 70,
    arrivalTime: '2024-01-01T16:10:00+09:00',
    hypocenter: { name: '石川県能登地方', latitude: 37.5, longitude: 137.3, depth: 20 },
    ...extra,
  } as JMALpgm
}

function ei(reportTime: string, lat = 37.51, lon = 137.22): JMAEstimatedIntensity {
  return {
    id: 'ix1', time: reportTime, arrivalTime: '2024-01-01T07:10:00.000Z',
    hypocenter: { lat, lon, depthKm: 10 }, magnitude: 7.5, areaCode: 390, telegramKind: 0,
    grades: [{ scale: 7, modifier: 'none', lower: 65, upper: 70 }],
    count: 1, lat: new Float32Array([37.5]), lon: new Float32Array([137.2]), si: new Uint8Array([70]),
    cellLatDeg: CELL_LAT_DEG, cellLonDeg: CELL_LON_DEG,
    bounds: { south: 37.5, north: 37.51, west: 137.2, east: 137.21 },
  }
}

const map = (l?: JMALpgm) => new Map(l ? [[EVENT, l]] : [])

describe('withLatestQuakeFacts', () => {
  // 正: 地震情報より後に出た長周期が別の値を運べば、その値をカードの上段に出す
  it('地震情報より新しい長周期の震源・規模・深さを当てる', () => {
    const card = quake('2024-01-01T16:16:00+09:00')
    const out = withLatestQuakeFacts(card, map(lpgm('2024-01-01T16:23:00+09:00')), [])
    expect(out.earthquake.hypocenter).toMatchObject({ longitude: 137.3, depth: 20, magnitude: 7.6 })
    expect(out.earthquake.hypocenter.name).toBe('石川県能登地方')
  })

  // 対照: 長周期より後に地震情報が出ていれば、地震情報の値のまま（同じ参照を返す）
  it('地震情報のほうが新しければ当てない', () => {
    const card = quake('2024-01-01T21:30:00+09:00', 7.6)
    expect(withLatestQuakeFacts(card, map(lpgm('2024-01-01T16:23:00+09:00', 7.4)), [])).toBe(card)
  })

  // 安全弁: 同じ値なら参照を変えない（続報のたびに一覧を描き直させない）
  it('当てても値が同じなら元の参照を返す', () => {
    const card = quake('2024-01-01T16:16:00+09:00')
    const same = lpgm('2024-01-01T16:23:00+09:00', 7.4, { hypocenter: { name: '石川県能登地方', latitude: 37.5, longitude: 137.2, depth: 0 } })
    expect(withLatestQuakeFacts(card, map(same), [])).toBe(card)
  })

  // 安全弁: 取消の長周期・取消表示中のカードからは当てない
  it('取消の長周期と、取消表示中のカードは触らない', () => {
    const card = quake('2024-01-01T16:16:00+09:00')
    expect(withLatestQuakeFacts(card, map(lpgm('2024-01-01T16:23:00+09:00', 7.6, { cancelled: true })), [])).toBe(card)
    const cancelled = { ...card, cancelledAt: new Date() }
    expect(withLatestQuakeFacts(cancelled, map(lpgm('2024-01-01T16:23:00+09:00')), [])).toBe(cancelled)
  })

  // 正: 推計が最も新しければ、その座標（0.01 度）・深さ・規模を当て、震央地名は地震情報のまま
  it('推計が最も新しければ座標・深さ・規模を当て、地名は残す', () => {
    const card = quake('2024-01-01T16:16:00+09:00')
    const out = withLatestQuakeFacts(card, map(), [ei('2024-01-01T16:20:00+09:00')])
    expect(out.earthquake.hypocenter).toMatchObject({ name: '石川県能登地方', latitude: 37.51, longitude: 137.22, depth: 10, magnitude: 7.5 })
  })

  // 正: 長周期と推計の両方が新しければ、発表がより新しいほう
  it('長周期と推計のうち発表が新しいほうを当てる', () => {
    const card = quake('2024-01-01T16:16:00+09:00')
    const out = withLatestQuakeFacts(card, map(lpgm('2024-01-01T16:23:00+09:00')), [ei('2024-01-01T16:20:00+09:00')])
    expect(out.earthquake.hypocenter.magnitude).toBe(7.6)
    const out2 = withLatestQuakeFacts(card, map(lpgm('2024-01-01T16:18:00+09:00')), [ei('2024-01-01T16:20:00+09:00')])
    expect(out2.earthquake.hypocenter.magnitude).toBe(7.5)
  })

  // 安全弁: 同じ分の別の地震（離れている・規模が大きく違う）の推計は、上段へ当てない
  it('震央が 30 km より離れた推計・規模が 0.5 より違う推計は当てない', () => {
    const card = quake('2024-01-01T16:16:00+09:00')
    expect(withLatestQuakeFacts(card, map(), [ei('2024-01-01T16:20:00+09:00', 37.9, 137.2)])).toBe(card)
    const big = { ...ei('2024-01-01T16:20:00+09:00'), magnitude: 8.1 }
    expect(withLatestQuakeFacts(card, map(), [big])).toBe(card)
  })

  // 安全弁: 震央が読めないカード（震度速報の段）には推計を当てない（時刻だけでは別の地震と見分けられない）
  it('震央が読めないカードには推計を当てない', () => {
    const card = quake('2024-01-01T16:16:00+09:00')
    const pending = { ...card, earthquake: { ...card.earthquake, hypocenter: { ...card.earthquake.hypocenter, latitude: -200, longitude: -200 } } }
    expect(withLatestQuakeFacts(pending, map(), [ei('2024-01-01T16:20:00+09:00')])).toBe(pending)
  })

  // 安全弁: 説明の無い NaN の規模は、読めなかっただけなので地震情報の規模を残す
  it('推計の規模が説明の無い NaN なら地震情報の規模を残す', () => {
    const card = quake('2024-01-01T16:16:00+09:00')
    const out = withLatestQuakeFacts(card, map(), [{ ...ei('2024-01-01T16:20:00+09:00'), magnitude: Number.NaN }])
    expect(out.earthquake.hypocenter).toMatchObject({ latitude: 37.51, magnitude: 7.4 })
  })

  // 正: 当てたら津波から借りた印を外す（上段は津波の値ではなくなる）
  it('当てたら津波から借りた印を外す', () => {
    const card = { ...quake('2024-01-01T16:16:00+09:00'), hypocenterSource: { kind: '津波警報・注意報・予報', reportTime: '2024-01-01T16:12:00+09:00' } } as unknown as JMAQuake
    const out = withLatestQuakeFacts(card, map(lpgm('2024-01-01T16:23:00+09:00')), [])
    expect(out.hypocenterSource).toBeUndefined()
    expect(out.earthquake.hypocenter.magnitude).toBe(7.6)
  })

  // 正: 当てていた長周期が無くなれば（取消）、上段は地震情報の値へ戻り、津波から借りた印も戻る
  it('当てていた報が無くなれば地震情報の値へ戻す', () => {
    const card = { ...quake('2024-01-01T16:16:00+09:00'), hypocenterSource: { kind: '津波警報・注意報・予報', reportTime: '2024-01-01T16:12:00+09:00' } } as unknown as JMAQuake
    const applied = withLatestQuakeFacts(card, map(lpgm('2024-01-01T16:23:00+09:00')), [])
    const back = withLatestQuakeFacts(applied, map(), [])
    expect(back.earthquake).toEqual(card.earthquake)
    expect(back.hypocenterSource).toEqual(card.hypocenterSource)
    expect(back.quakeInfoFacts).toBeUndefined()
  })

  // 安全弁: 当てた後に変わった上段以外の欄（津波から借りた津波区分など）は、当て直しても戻さない
  it('当て直しても、当てた後に変わった津波区分は巻き戻さない', () => {
    const base = quake('2024-01-01T16:16:00+09:00')
    const card = { ...base, earthquake: { ...base.earthquake, domesticTsunami: '調査中' } } as JMAQuake
    const applied = withLatestQuakeFacts(card, map(lpgm('2024-01-01T16:23:00+09:00')), [])
    const borrowed = { ...applied, earthquake: { ...applied.earthquake, domesticTsunami: '警報等' } } as JMAQuake
    const again = withLatestQuakeFacts(borrowed, map(lpgm('2024-01-01T16:30:00+09:00', 7.7)), [])
    expect(again.earthquake.hypocenter.magnitude).toBe(7.7)
    expect(again.earthquake.domesticTsunami).toBe('警報等')
    expect(withLatestQuakeFacts(again, map(), []).earthquake.domesticTsunami).toBe('警報等')
  })

  // 安全弁: 当てた後にもう一度当てても同じ参照（毎回組み立て直しても、値が同じなら描き直させない）
  it('当てたカードへ同じ報をもう一度当てても同じ参照を返す', () => {
    const l = map(lpgm('2024-01-01T16:23:00+09:00'))
    const applied = withLatestQuakeFacts(quake('2024-01-01T16:16:00+09:00'), l, [])
    expect(withLatestQuakeFacts(applied, l, [])).toBe(applied)
  })

  // 正・対照: 震央地名が同じなら、長周期に無い震央補助表現は地震情報の値を残す。地名が変われば残さない
  it('震央補助表現は、地名が同じときだけ地震情報の値を残す', () => {
    const base = quake('2024-01-01T16:16:00+09:00')
    const card = { ...base, earthquake: { ...base.earthquake, hypocenter: { ...base.earthquake.hypocenter, nameFromMark: '輪島の東北東３０ｋｍ付近' } } }
    const same = withLatestQuakeFacts(card, map(lpgm('2024-01-01T16:23:00+09:00')), [])
    expect(same.earthquake.hypocenter.nameFromMark).toBe('輪島の東北東３０ｋｍ付近')
    const renamed = lpgm('2024-01-01T16:23:00+09:00', 7.6, { hypocenter: { name: '能登半島沖', latitude: 37.6, longitude: 137.3, depth: 20 } })
    expect(withLatestQuakeFacts(card, map(renamed), []).earthquake.hypocenter.nameFromMark).toBeUndefined()
  })
})

describe('latestQuakeFactsIntoCards', () => {
  it('1 枚も変わらなければ元の配列を返す', () => {
    const cards = [quake('2024-01-01T21:30:00+09:00', 7.6)]
    expect(latestQuakeFactsIntoCards(cards, map(lpgm('2024-01-01T16:23:00+09:00')), [])).toBe(cards)
  })

  // 分ごとに分けて引いても、1 枚ずつ当てたときと同じ結果になる
  it('推計は発現時刻の分で引き、1 枚ずつ当てたときと同じ値になる', () => {
    const cards = [quake('2024-01-01T16:16:00+09:00')]
    const eis = [ei('2024-01-01T16:20:00+09:00'), { ...ei('2024-01-01T16:21:00+09:00'), arrivalTime: '2024-01-01T07:30:00.000Z' }]
    const [out] = latestQuakeFactsIntoCards(cards, map(), eis)
    expect(out).toEqual(withLatestQuakeFacts(cards[0], map(), eis))
    expect(out.earthquake.hypocenter.latitude).toBe(37.51)
  })
})

describe('mergeQuakeInto は当てた値を地震情報の値として引き継がない', () => {
  // 正: 当てたカードへ地震情報の続報を統合すると、続報の値の上で組み立て直せる形（当てる前の値）に戻る
  it('統合の結果は地震情報の値で、当てた印を持たない', async () => {
    const { mergeQuakeInto } = await import('./quakeMerge')
    const applied = withLatestQuakeFacts(quake('2024-01-01T16:16:00+09:00'), map(lpgm('2024-01-01T16:23:00+09:00')), [])
    expect(applied.quakeInfoFacts).toBeDefined()
    const next = { ...quake('2024-01-01T16:40:00+09:00', 7.5), id: `dmdata-quake-${EVENT}-2` }
    const merged = mergeQuakeInto(applied, next)
    expect(merged.quakeInfoFacts).toBeUndefined()
    expect(merged.earthquake.hypocenter.magnitude).toBe(7.5)
  })
})
