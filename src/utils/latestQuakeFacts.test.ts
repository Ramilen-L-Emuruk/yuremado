// 同じ地震について届いた報のうち、発表が最も新しい報の値を地震カードの上段へ当てる規則
// （2026-11-03 ユーザー選択「発表時刻が最も新しい報 (Recommended)」「長周期と同じくカード本体へまとめる (Recommended)」）。
import { describe, it, expect } from 'vitest'
import { withLatestQuakeFacts as withLatestQuakeFactsAll, latestQuakeFactsIntoCards as latestQuakeFactsIntoCardsAll } from './latestQuakeFacts'
import './quakeMerge'
import type { JMAQuake, JMAEstimatedIntensity, JMALpgm, JMATsunami, TsunamiSourceEarthquake } from '../types/earthquake'
import { borrowFromTsunamiIntoCards } from './borrowFromTsunami'
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
      // 実電文の地震情報は発生時刻を持つ（長周期・津波の原因地震と同じ値）
      originTime: '2024-01-01T16:10:00+09:00',
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
// 津波を使わないテストは、津波の一覧を空で渡す
const withLatestQuakeFacts = (card: JMAQuake, l: Map<string, JMALpgm>, eis: readonly JMAEstimatedIntensity[]) =>
  withLatestQuakeFactsAll(card, l, eis, [], [])
const latestQuakeFactsIntoCards = (cards: JMAQuake[], l: Map<string, JMALpgm>, eis: readonly JMAEstimatedIntensity[]) =>
  latestQuakeFactsIntoCardsAll(cards, l, eis, [])

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

  // 地震発生時刻は震源と組で当てて動く（波形の線の起点の秒を、当てた震源の発生時刻の分で探す。→ `JMAQuake.earthquake.originTime`）
  it('長周期の地震発生時刻も震源と一緒に当て、当てる報が無くなれば地震情報の値へ戻す', () => {
    const base = quake('2024-01-01T16:16:00+09:00')
    const card = { ...base, earthquake: { ...base.earthquake, originTime: '2024-01-01T16:10:00+09:00' } } as JMAQuake
    const applied = withLatestQuakeFacts(card, map(lpgm('2024-01-01T16:23:00+09:00', 7.6, { originTime: '2024-01-01T16:09:00+09:00' })), [])
    expect(applied.earthquake.originTime).toBe('2024-01-01T16:09:00+09:00')
    expect(applied.quakeInfoFacts?.originTime).toBe('2024-01-01T16:10:00+09:00')
    const back = withLatestQuakeFacts(applied, map(), [])
    expect(back.earthquake.originTime).toBe('2024-01-01T16:10:00+09:00')
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

// 津波電文の原因地震も同じ地震の報として当てる（2026-11-03 ユーザー選択「入れる (Recommended)」）
describe('津波電文の原因地震を当てる', () => {
  const source = (over: Partial<TsunamiSourceEarthquake> = {}): TsunamiSourceEarthquake => ({
    hypocenterName: '石川県能登地方', magnitude: 7.6, magnitudeType: 'Mj', originTime: '2024-01-01T16:10:00+09:00',
    arrivalTime: '2024-01-01T16:10:00+09:00', latitude: 37.5, longitude: 137.2, depth: 0, ...over,
  })
  const tsunami = (reportTime: string, over: Partial<JMATsunami> = {}, src = source()): JMATsunami => ({
    kind: 'tsunami', id: `dmdata-tsunami-${EVENT}-${reportTime}`, eventId: EVENT, time: reportTime, cancelled: false,
    infoName: '津波警報・津波注意報・津波予報', issue: { source: 'dmdata', time: reportTime, type: 'Focus' },
    areas: [], sourceEarthquakes: [src], ...over,
  } as JMATsunami)

  // 正: 地震情報より新しい津波が新しい規模を運べば、上段へ当て、出どころに津波の印を付ける（能登 16:22 の形）
  it('地震情報より新しい津波の規模を当て、津波情報の印を付ける', () => {
    const card = quake('2024-01-01T16:16:00+09:00')
    const out = withLatestQuakeFactsAll(card, map(), [], [tsunami('2024-01-01T16:22:00+09:00')], [card])
    expect(out.earthquake.hypocenter.magnitude).toBe(7.6)
    expect(out.hypocenterSource?.shortLabel).toBe('津波情報')
    expect(out.quakeInfoFacts?.hypocenter.magnitude).toBe(7.4)
  })

  // 対照: 地震情報のほうが新しければ当てない（16:24 の地震情報が同じ更新を伝えた後）
  it('地震情報のほうが新しければ当てない', () => {
    const card = quake('2024-01-01T16:24:00+09:00', 7.6)
    expect(withLatestQuakeFactsAll(card, map(), [], [tsunami('2024-01-01T16:22:00+09:00')], [card])).toBe(card)
  })

  // 安全弁: 取り消された津波は当てず、当てていた値は地震情報の値へ戻る
  it('取り消された津波は当てず、当てていた値を戻す', () => {
    const card = quake('2024-01-01T16:16:00+09:00')
    const applied = withLatestQuakeFactsAll(card, map(), [], [tsunami('2024-01-01T16:22:00+09:00')], [card])
    const cancelled = tsunami('2024-01-01T16:22:00+09:00', { cancelledAt: new Date(), cancelReason: 'retracted' })
    const back = withLatestQuakeFactsAll(applied, map(), [], [cancelled], [card])
    expect(back.earthquake.hypocenter.magnitude).toBe(7.4)
    expect(back.hypocenterSource).toBeUndefined()
  })

  // 安全弁: 津波を当てたカードは、借りる処理が上書きしない（当てる側が毎回組み立て直す）
  it('当てたカードに借りる処理を掛けても変わらない', () => {
    const card = quake('2024-01-01T16:16:00+09:00')
    const tsu = [tsunami('2024-01-01T16:22:00+09:00')]
    const applied = withLatestQuakeFactsAll(card, map(), [], tsu, [card])
    expect(borrowFromTsunamiIntoCards([applied], tsu)[0]).toBe(applied)
  })

  // 正: 長周期と津波の両方が新しければ、発表がより新しいほう
  it('長周期と津波のうち発表が新しいほうを当てる', () => {
    const card = quake('2024-01-01T16:16:00+09:00')
    const out = withLatestQuakeFactsAll(card, map(lpgm('2024-01-01T16:23:00+09:00', 7.5)), [], [tsunami('2024-01-01T16:22:00+09:00')], [card])
    expect(out.earthquake.hypocenter.magnitude).toBe(7.5)
    expect(out.hypocenterSource).toBeUndefined()
  })
})

describe('当てた津波の値を覚えておく（一覧に無いだけでは戻さない）', () => {
  const src = (over: Partial<TsunamiSourceEarthquake> = {}): TsunamiSourceEarthquake => ({
    hypocenterName: '石川県能登地方', magnitude: 7.6, magnitudeType: 'Mj', arrivalTime: '2024-01-01T16:10:00+09:00',
    latitude: 37.5, longitude: 137.2, depth: 0, ...over,
  })
  const tsu = (reportTime: string, over: Partial<JMATsunami> = {}): JMATsunami => ({
    kind: 'tsunami', id: `t-${reportTime}`, eventId: EVENT, time: reportTime, cancelled: false,
    infoName: '津波警報・津波注意報・津波予報', issue: { source: 'dmdata', time: reportTime, type: 'Focus' },
    areas: [], sourceEarthquakes: [src()], ...over,
  } as JMATsunami)
  const applied = () => {
    const card = quake('2024-01-01T16:16:00+09:00')
    return withLatestQuakeFactsAll(card, map(), [], [tsu('2024-01-01T16:22:00+09:00')], [card])
  }

  // 安全弁: 解除・失効で津波が一覧から消えても、当てた津波の値は残る（津波の値は取り下げられていない）
  it('津波が一覧から消えても当てた値を残す', () => {
    const a = applied()
    const out = withLatestQuakeFactsAll(a, map(), [], [], [a])
    expect(out.earthquake.hypocenter.magnitude).toBe(7.6)
    expect(out.hypocenterSource?.shortLabel).toBe('津波情報')
  })

  // 安全弁: 原因地震を持たない続報（観測だけの報など）が来ても、当てた値は残る
  it('原因地震を持たない続報では戻さない', () => {
    const a = applied()
    const out = withLatestQuakeFactsAll(a, map(), [], [tsu('2024-01-01T16:40:00+09:00', { sourceEarthquakes: undefined })], [a])
    expect(out.earthquake.hypocenter.magnitude).toBe(7.6)
  })

  // 安全弁: 解除された津波（取消ではない）の値も残す
  it('解除された津波の値は残す', () => {
    const a = applied()
    const lifted = tsu('2024-01-01T16:22:00+09:00', { cancelledAt: new Date(), cancelReason: 'lifted' })
    expect(withLatestQuakeFactsAll(a, map(), [], [lifted], [a]).earthquake.hypocenter.magnitude).toBe(7.6)
  })

  // 正: 取り消されたと分かったら、覚えていた値も捨てて地震情報の値へ戻す。その後一覧から消えても戻ったまま
  it('取り消されたら覚えていた値も捨てる', () => {
    const a = applied()
    const retracted = tsu('2024-01-01T16:22:00+09:00', { cancelledAt: new Date(), cancelReason: 'retracted' })
    const back = withLatestQuakeFactsAll(a, map(), [], [retracted], [a])
    expect(back.earthquake.hypocenter.magnitude).toBe(7.4)
    expect(back.appliedTsunamiSource).toBeUndefined()
    expect(withLatestQuakeFactsAll(back, map(), [], [], [back]).earthquake.hypocenter.magnitude).toBe(7.4)
  })

  // 安全弁: 解除の報（cancelled: true・cancelReason: 'lifted'）は取消ではない
  it('解除の報そのものでは戻さない', () => {
    const a = applied()
    const lift = tsu('2024-01-01T17:00:00+09:00', { cancelled: true, cancelReason: 'lifted', sourceEarthquakes: undefined })
    expect(withLatestQuakeFactsAll(a, map(), [], [lift], [a]).earthquake.hypocenter.magnitude).toBe(7.6)
  })

  // 正: 津波が一覧から消えた後でも、届いた取消の報だけで戻す（表示中の津波に当たらない取消）
  it('一覧に津波が無くても、取消の報が届けば戻す', () => {
    const a = applied()
    const gone = withLatestQuakeFactsAll(a, map(), [], [], [a])
    const retraction = tsu('2024-01-01T17:00:00+09:00', { cancelled: true, cancelReason: 'retracted', sourceEarthquakes: undefined })
    const back = withLatestQuakeFactsAll(gone, map(), [], [retraction], [gone])
    expect(back.earthquake.hypocenter.magnitude).toBe(7.4)
    expect(back.appliedTsunamiSource).toBeUndefined()
  })

  // 正: 覚えた津波の番号（暫定の番号）を指す取消でも戻す
  it('覚えた津波の番号を指す取消で戻す', () => {
    const a = applied()
    const renumbered = { ...a, id: 'dmdata-quake-20240101161099-1' }
    const retraction = tsu('2024-01-01T17:00:00+09:00', { cancelled: true, cancelReason: 'retracted', sourceEarthquakes: undefined })
    expect(withLatestQuakeFactsAll(renumbered, map(), [], [retraction], [renumbered]).earthquake.hypocenter.magnitude).toBe(7.4)
  })

  // 安全弁: 番号を足して切り替わった津波（A → A B）の後に、別の津波（B C）の取消が来ても、地震 A のカードは戻さない
  it('番号の重なる別の津波の取消では戻さない', () => {
    const card = quake('2024-01-01T16:16:00+09:00')
    const switched = tsu('2024-01-01T16:22:00+09:00', { eventId: `${EVENT} 20240101170000` })
    const a = withLatestQuakeFactsAll(card, map(), [], [switched], [card])
    expect(a.earthquake.hypocenter.magnitude).toBe(7.6)
    const other = tsu('2024-01-01T17:30:00+09:00', { eventId: '20240101170000 20240101171111', cancelled: true, cancelReason: 'retracted', sourceEarthquakes: undefined })
    expect(withLatestQuakeFactsAll(a, map(), [], [other], [a]).earthquake.hypocenter.magnitude).toBe(7.6)
  })

  // 安全弁: 覚えた報より古い取消（再配信）では戻さない
  it('覚えた報より古い取消では戻さない', () => {
    const a = applied()
    const stale = tsu('2024-01-01T16:20:00+09:00', { cancelled: true, cancelReason: 'retracted', sourceEarthquakes: undefined })
    expect(withLatestQuakeFactsAll(a, map(), [], [stale], [a]).earthquake.hypocenter.magnitude).toBe(7.6)
  })

  // 安全弁: 地震情報の続報を統合しても覚えた値は引き継ぎ、続報より津波が新しければ当て続ける
  it('統合は覚えた津波の値を引き継ぐ', async () => {
    const { mergeQuakeInto } = await import('./quakeMerge')
    const a = applied()
    const next = { ...quake('2024-01-01T16:18:00+09:00', 7.4), id: `dmdata-quake-${EVENT}-2` }
    const merged = mergeQuakeInto(a, next)
    expect(merged.appliedTsunamiSource?.source.magnitude).toBe(7.6)
    expect(withLatestQuakeFactsAll(merged, map(), [], [], [merged]).earthquake.hypocenter.magnitude).toBe(7.6)
  })

  // 正・対照: 規模は 3 つ組で採る。報が規模を運べば種類も報の値、運ばなければ 3 つとも地震情報のまま
  it('規模の値・説明・種類を組で採る', () => {
    const card = quake('2024-01-01T16:16:00+09:00')
    const typed = { ...card, earthquake: { ...card.earthquake, hypocenter: { ...card.earthquake.hypocenter, magnitudeType: 'Mj' } } }
    const noType = withLatestQuakeFactsAll(typed, map(), [], [tsu('2024-01-01T16:22:00+09:00', { sourceEarthquakes: [src({ magnitudeType: undefined })] })], [typed])
    expect(noType.earthquake.hypocenter.magnitude).toBe(7.6)
    expect(noType.earthquake.hypocenter.magnitudeType).toBeUndefined()
    const noMag = withLatestQuakeFactsAll(typed, map(), [], [tsu('2024-01-01T16:22:00+09:00', { sourceEarthquakes: [src({ magnitude: undefined, magnitudeType: undefined, latitude: 37.6 })] })], [typed])
    expect(noMag.earthquake.hypocenter).toMatchObject({ magnitude: 7.4, magnitudeType: 'Mj', latitude: 37.6 })
  })
})
