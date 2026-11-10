import { describe, expect, it } from 'vitest'
import type { JMAInternationalTsunami, JMAQuake } from '../types/earthquake'
import {
  NO_INTERNATIONAL_TSUNAMIS, admitInternationalTsunami, ORIGIN_MATCH_TOLERANCE_MS, internationalTsunamiIndex, internationalTsunamiQuakeName,
  internationalTsunamiBandItem, internationalTsunamiOpenKey, internationalTsunamiTarget, upsertInternationalTsunami,
  withInternationalTsunamiCards,
} from './internationalTsunami'

// 結び付けが見るのは発生時刻と震央なので、その 2 つと種別だけを持つ地震で足りる（震央が読めなければ -200）
const quake = (type: string, time: string, lat = -200, lon = -200): JMAQuake =>
  ({ id: `q-${type}-${time}`, eventKey: `q-${type}-${time}`, issue: { type }, earthquake: { time, hypocenter: { latitude: lat, longitude: lon } } }) as unknown as JMAQuake

/** 地震発生時刻（`earthquake.originTime`）を持たせた地震。震度速報だけのカードは持たない */
const withOrigin = (q: JMAQuake, originTime: string): JMAQuake =>
  ({ ...q, earthquake: { ...q.earthquake, originTime } }) as JMAQuake

const bulletin = (over: Partial<JMAInternationalTsunami> = {}): JMAInternationalTsunami => ({
  id: 'WEPA60:2021-01-21T12:47:00.000Z:TSUNAMI BULLETIN NUMBER 001',
  title: 'TSUNAMI BULLETIN NUMBER 001',
  time: '2021-01-21T12:47:00.000Z',
  originTime: '2021-01-21T12:23:00.000Z',
  isCommunicationsTest: false,
  text: 'WEPA60 RJTD 211247',
  epicenter: { latitude: 4.8, longitude: 127.4 },
  regionName: 'TALAUD ISLANDS, INDONESIA',
  magnitude: 7.0,
  ...over,
})

const FOREIGN = quake('遠地地震', '2021-01-21T12:23:41.000Z')

/** そのカードに付いた報（付かなければ空） */
const attachedTo = (q: JMAQuake, quakes: readonly JMAQuake[], list: readonly JMAInternationalTsunami[]) =>
  internationalTsunamiIndex(quakes, list).byQuakeKey.get(q.eventKey!) ?? NO_INTERNATIONAL_TSUNAMIS

describe('internationalTsunamiIndex の結び付け', () => {
  it('遠地地震のカードに、発生時刻が許すずれの内にある報を付ける', () => {
    const list = [bulletin()]
    expect(attachedTo(FOREIGN, [FOREIGN], list)).toEqual(list)
  })

  it('許すずれの境目ちょうどは付け、1 ミリ秒外は付けない', () => {
    const at = (deltaMs: number) => bulletin({
      originTime: new Date(Date.parse(FOREIGN.earthquake.time) + deltaMs).toISOString(),
    })
    expect(attachedTo(FOREIGN, [FOREIGN], [at(-ORIGIN_MATCH_TOLERANCE_MS)])).toHaveLength(1)
    expect(attachedTo(FOREIGN, [FOREIGN], [at(-ORIGIN_MATCH_TOLERANCE_MS - 1)])).toHaveLength(0)
  })

  // 比べるのはカードの地震発生時刻（無ければカードの時刻）。カードの時刻は地震発現時刻で、深い地震・遠い地震では数分遅れる
  //   正: 発現時刻が 3 分遅れても、発生時刻が合えば付ける（2026-10-16 カムチャツカ半島付近 深さ 160 km の形）
  //   対照: 発生時刻を持たないカード（震度速報だけ）はカードの時刻で比べる
  //   安全弁: 発現時刻が合っていても、発生時刻が許すずれの外なら付けない（発生時刻を先に見ている）
  it('カードの地震発生時刻で比べ、発生時刻が無ければカードの時刻で比べる', () => {
    const b = bulletin({ originTime: '2026-10-16T03:35:00.000Z', epicenter: { latitude: 50.0, longitude: 158.1 } })
    const kamchatka = withOrigin(quake('震源・震度情報', '2026-10-16T03:38:00.000Z', 50.0, 158.1), '2026-10-16T03:35:00.000Z')
    expect(attachedTo(kamchatka, [kamchatka], [b])).toEqual([b])
    expect(internationalTsunamiIndex([kamchatka], [b]).cards).toEqual([])

    const intensityOnly = quake('震度速報', '2026-10-16T03:35:40.000Z')
    expect(attachedTo(intensityOnly, [intensityOnly], [b])).toEqual([b])

    const originFar = withOrigin(quake('震源・震度情報', '2026-10-16T03:35:30.000Z', 50.0, 158.1), '2026-10-16T03:32:00.000Z')
    expect(attachedTo(originFar, [originFar], [b])).toHaveLength(0)
  })

  // 正（前の「国内の地震のカードには付けない」を覆した。2026-11-03 ユーザー選択「国内に付け、無い分はカードに (Recommended)」）:
  // 国内の地震の地震情報のカードにも付ける（2021-02-13 福島県沖 M7.3 の形）
  it('国内の地震のカードにも、発生時刻と震央が合えば付ける', () => {
    const domestic = quake('震源・震度情報', '2021-02-13T14:07:50.000Z', 37.7, 141.7)
    const fukushima = bulletin({ originTime: '2021-02-13T14:07:00.000Z', epicenter: { latitude: 37.7, longitude: 141.8 } })
    expect(attachedTo(domestic, [domestic], [fukushima])).toHaveLength(1)
  })

  // 安全弁: 同じ分の別の地震（震央が離れている）には付けない
  it('震央が両方読めて遠く離れていれば付けない', () => {
    const domestic = quake('震源・震度情報', '2021-01-21T12:23:30.000Z', 35.0, 139.0)
    expect(attachedTo(domestic, [domestic], [bulletin()])).toHaveLength(0)
  })

  // 1 通は 1 枚にだけ付ける（全期間の控えで、付けられるカードが 2 枚あった報は 3 通。どれも本震に付く）
  //   正: 本震と、2 分以内の余震が両方付けられるとき、時刻の差が小さい本震にだけ付く
  it('付けられるカードが 2 枚あれば、時刻の差が小さい方にだけ付ける', () => {
    const main = quake('震源・震度情報', '2026-07-28T07:27:18.000Z', 41.0, 142.0)
    const after = quake('震源・震度情報', '2026-07-28T07:28:50.000Z', 41.1, 142.1)
    const b = bulletin({ originTime: '2026-07-28T07:27:00.000Z', epicenter: { latitude: 41.0, longitude: 142.0 } })
    expect(attachedTo(main, [after, main], [b])).toEqual([b])
    expect(attachedTo(after, [after, main], [b])).toHaveLength(0)
  })

  //   正: 震央を突き合わせられたカードを、震央の無いカード（震度速報だけ）より先に選ぶ（2022-03-16 福島県沖の前震と本震の形）
  //   対照: 震央を突き合わせられるカードが無ければ、震央の無いカードにも時刻だけで付ける
  it('震央の無いカードより、震央を突き合わせられたカードを選ぶ', () => {
    const foreshock = quake('震度速報', '2022-03-16T14:36:10.000Z')
    const main = quake('震源・震度情報', '2022-03-16T14:36:46.000Z', 37.7, 141.6)
    const b = bulletin({ originTime: '2022-03-16T14:36:00.000Z', epicenter: { latitude: 37.7, longitude: 141.7 } })
    expect(attachedTo(main, [foreshock, main], [b])).toEqual([b])
    expect(attachedTo(foreshock, [foreshock, main], [b])).toHaveLength(0)
    expect(attachedTo(foreshock, [foreshock], [b])).toEqual([b])
  })

  it('通信試験・発生時刻の無い報は付けない', () => {
    expect(attachedTo(FOREIGN, [FOREIGN], [bulletin({ isCommunicationsTest: true })])).toHaveLength(0)
    expect(attachedTo(FOREIGN, [FOREIGN], [bulletin({ originTime: undefined })])).toHaveLength(0)
  })

  // 正: 同じ一覧・同じカードの組には同じ答え（地震を選ぶたびの描き直しでカードの memo を素通りさせない）
  // 対照: カードが増えて組み直しても、付く報の変わらないカードには同じ配列を返す。一覧が増えれば新しい報も付く
  it('同じ組には同じ答えを返し、組み直しても付く報の変わらないカードには同じ配列を返す', () => {
    const list = [bulletin()]
    const quakes = [FOREIGN]
    expect(internationalTsunamiIndex(quakes, list)).toBe(internationalTsunamiIndex(quakes, list))
    const first = attachedTo(FOREIGN, quakes, list)
    const other = quake('震源・震度情報', '2021-01-22T00:00:00.000Z', 35.0, 139.0)
    expect(attachedTo(FOREIGN, [other, FOREIGN], list)).toBe(first)
    const second = bulletin({ id: 'b2', title: 'TSUNAMI BULLETIN NUMBER 002', time: '2021-01-21T13:10:00.000Z' })
    expect(attachedTo(FOREIGN, quakes, [...list, second]).map(x => x.id)).toEqual([list[0].id, 'b2'])
  })

  it('報が無ければ毎回同じ空の結果を返す', () => {
    expect(internationalTsunamiIndex([FOREIGN], [])).toBe(internationalTsunamiIndex([], []))
  })
})

describe('upsertInternationalTsunami', () => {
  it('同じ id の報は足さず null を返し、別の報は発表時刻の古い順に並べる', () => {
    const later = bulletin({ id: 'b', time: '2021-01-21T13:30:00.000Z' })
    const first = bulletin()
    const list = upsertInternationalTsunami([later], first)
    expect(list?.map(x => x.id)).toEqual([first.id, 'b'])
    expect(upsertInternationalTsunami(list!, first)).toBeNull()
  })
})

// 受信の入口で入れるか。
//   正  : 通信試験は試験報の設定が切なら入れない／対照: 設定が入なら入れる／安全弁: 地震の報は設定に関わらず入れる
describe('admitInternationalTsunami', () => {
  const test = bulletin({ title: 'NWPTA COMMUNICATIONS TEST', isCommunicationsTest: true, originTime: undefined })
  it('正: 通信試験は試験報を受け取らない設定では入れない', () => {
    expect(admitInternationalTsunami(test, false)).toBe(false)
  })
  it('対照: 試験報を受け取る設定なら通信試験も入れる', () => {
    expect(admitInternationalTsunami(test, true)).toBe(true)
  })
  it('安全弁: 地震の報は設定に関わらず入れる', () => {
    expect(admitInternationalTsunami(bulletin(), false)).toBe(true)
    expect(admitInternationalTsunami(bulletin(), true)).toBe(true)
  })
})

// 付く先の無い報を拾う。
//   正  : 付く地震カードが無ければ拾う／対照: 付くカードがあれば拾わない／安全弁: 通信試験は拾わない
describe('internationalTsunamiIndex の付く先の無い報', () => {
  it('付く地震カードが無い報だけを返し、通信試験は返さない', () => {
    const b = bulletin({})
    const test = bulletin({ id: 't', isCommunicationsTest: true, originTime: undefined })
    expect(internationalTsunamiIndex([], [b, test]).unattached.map(x => x.id)).toEqual([b.id])
    expect(internationalTsunamiIndex([FOREIGN], [b, test]).unattached).toEqual([])
  })

  it('発生時刻を読めない報は付く先の無い報に残るが、カードにはならない', () => {
    const index = internationalTsunamiIndex([], [bulletin({ originTime: undefined })])
    expect(index.unattached).toHaveLength(1)
    expect(index.cards).toHaveLength(0)
  })
})

// 付く地震カードの無い報から組むカード（2026-11-03 ユーザー選択「英文の値をそのまま並べる (Recommended)」「震央を出す (Recommended)」）
describe('internationalTsunamiIndex の英文だけのカード', () => {
  // 正: 英文の値（地名・震央・規模・深さ・規模の種類）をそのまま載せた、遠地地震の形のカードを 1 枚作る
  it('付くカードの無い報から、英文の値を載せたカードを作り、その報をカードに付ける', () => {
    const b = bulletin({ depthKm: 139, magnitudeType: 'Mw' })
    const index = internationalTsunamiIndex([], [b])
    const [card] = index.cards
    expect(card.fromInternationalTsunami).toBe(true)
    expect(card.issue.type).toBe('遠地地震')
    expect(card.earthquake.time).toBe('2021-01-21T12:23:00.000Z')
    expect(card.earthquake.hypocenter).toMatchObject({ name: 'TALAUD ISLANDS, INDONESIA', latitude: 4.8, longitude: 127.4, depth: 139, magnitude: 7.0, magnitudeType: 'Mw' })
    expect(index.byQuakeKey.get(card.eventKey!)).toEqual([b])
  })

  // 正: 同じ発生時刻の報は 1 枚にまとめ、値は発表が最も新しい報のもの
  it('同じ発生時刻の報は 1 枚にまとめ、新しい報の値を使う', () => {
    const second = bulletin({ id: 'b2', title: 'TSUNAMI BULLETIN NUMBER 002', time: '2021-01-21T13:10:00.000Z', magnitude: 7.1 })
    const index = internationalTsunamiIndex([], [bulletin(), second])
    expect(index.cards).toHaveLength(1)
    expect(index.cards[0].earthquake.hypocenter.magnitude).toBe(7.1)
    expect(index.byQuakeKey.get(index.cards[0].eventKey!)).toHaveLength(2)
  })

  // 正: 最新の報が同じなら同じカードを返す（津波の電文が届くたびの組み直しで memo を素通りさせない）。安全弁: 新しい報が来れば組み直す
  it('最新の報が同じなら同じカードを返し、新しい報が来れば組み直す', () => {
    const first = bulletin()
    const [a] = internationalTsunamiIndex([], [first]).cards
    expect(internationalTsunamiIndex([], [first]).cards[0]).toBe(a)
    expect(internationalTsunamiIndex([quake('震源・震度情報', '2021-01-22T00:00:00.000Z')], [first]).cards[0]).toBe(a)
    const second = bulletin({ id: 'b2', title: 'TSUNAMI BULLETIN NUMBER 002', time: '2021-01-21T13:10:00.000Z', magnitude: 7.1 })
    const [b] = internationalTsunamiIndex([], [first, second]).cards
    expect(b).not.toBe(a)
    expect(b.earthquake.hypocenter.magnitude).toBe(7.1)
  })

  // 対照: 付く地震カードがあれば作らない。深さ・規模が書かれていなければセンチネル（-1・NaN）
  it('付く地震カードがあれば作らない', () => {
    expect(internationalTsunamiIndex([FOREIGN], [bulletin()]).cards).toEqual([])
    const [card] = internationalTsunamiIndex([], [bulletin({ magnitude: undefined })]).cards
    expect(card.earthquake.hypocenter.depth).toBe(-1)
    expect(card.earthquake.hypocenter.magnitude).toBeNaN()
  })

  // 安全弁: 震度で絞って隠れた国内の地震があれば、英文だけのカードを作らない（付くかは絞る前の全カードで見る）
  it('一覧へ差し込むとき、付くかは絞る前の全カードで見る。差し込むものが無ければ元の参照', () => {
    const hidden = quake('震源・震度情報', '2021-01-21T12:23:30.000Z', 4.8, 127.4)
    const shown: JMAQuake[] = []
    expect(withInternationalTsunamiCards(shown, internationalTsunamiIndex([hidden], [bulletin()]))).toBe(shown)
    expect(withInternationalTsunamiCards(shown, internationalTsunamiIndex([], [bulletin()]))).toHaveLength(1)
  })
})

describe('読み上げ・通知の付く先（internationalTsunamiQuakeName / internationalTsunamiOpenKey）', () => {
  const named = (q: JMAQuake, name: string, extra: Partial<JMAQuake> = {}): JMAQuake =>
    ({ ...q, ...extra, earthquake: { ...q.earthquake, hypocenter: { ...q.earthquake.hypocenter, name } } }) as JMAQuake

  it('正: 画面と同じ選び方で結べた地震カードの震源名を返す', () => {
    const card = named(quake('遠地地震', '2021-01-21T12:23:41.000Z', 4.8, 127.4), 'インドネシア付近')
    expect(internationalTsunamiQuakeName([card], bulletin())).toBe('インドネシア付近')
  })

  it('対照: 結べるカードが無い・取り消されたカード・英文だけのカードなら返さない（座標で読む側へ倒す）', () => {
    expect(internationalTsunamiQuakeName([], bulletin())).toBeUndefined()
    const cancelled = named(FOREIGN, 'インドネシア付近', { cancelledAt: new Date('2021-01-21T13:00:00.000Z') })
    expect(internationalTsunamiQuakeName([cancelled], bulletin())).toBeUndefined()
    // 名前は言わないが、選ぶ先は画面の結び付けと同じく取り消されたカード（英文だけのカードは作られないので、そちらを指すと空振りする）
    expect(internationalTsunamiTarget([cancelled], bulletin())?.key).toBe(cancelled.eventKey)
    expect(attachedTo(cancelled, [cancelled], [bulletin()])).toHaveLength(1)
    const fromEnglish = named(FOREIGN, 'TALAUD ISLANDS, INDONESIA', { fromInternationalTsunami: true } as Partial<JMAQuake>)
    expect(internationalTsunamiQuakeName([fromEnglish], bulletin())).toBeUndefined()
  })

  it('安全弁: 通信試験はどのカードにも結ばない', () => {
    const card = named(FOREIGN, 'インドネシア付近')
    expect(internationalTsunamiQuakeName([card], bulletin({ isCommunicationsTest: true }))).toBeUndefined()
  })

  it('通知の開き先は画面の結び付けと同じカードを指し、付く先が無ければ英文だけのカードを指す', () => {
    const origin = '2021-01-21T12:23:00.000Z'
    const card = named(quake('遠地地震', '2021-01-21T12:23:41.000Z', 4.8, 127.4), 'インドネシア付近')
    expect(internationalTsunamiOpenKey([card], origin, 4.8, 127.4)).toBe(card.eventKey)
    // 300 km を超えて離れた震央・時刻の幅の外のカードは指さない（英文だけのカードを指す）
    const english = withInternationalTsunamiCards([], internationalTsunamiIndex([], [bulletin()]))[0]
    expect(internationalTsunamiOpenKey([named(quake('遠地地震', '2021-01-21T12:23:41.000Z', 35, 139), '関東')], origin, 4.8, 127.4)).toBe(english.eventKey)
    expect(internationalTsunamiOpenKey([named(quake('遠地地震', '2021-01-21T12:30:00.000Z'), 'X')], origin)).toBe(english.eventKey)
  })

  it('前震と本震のように付けられるカードが 2 枚あっても、画面と同じく震央を突き合わせられた本震を指す', () => {
    const origin = '2021-01-21T12:23:00.000Z'
    const foreshock = named(quake('震度速報', '2021-01-21T12:22:10.000Z'), '')
    const main = named(quake('震源・震度情報', '2021-01-21T12:23:41.000Z', 4.8, 127.4), 'インドネシア付近')
    expect(internationalTsunamiOpenKey([foreshock, main], origin, 4.8, 127.4)).toBe(main.eventKey)
    expect(attachedTo(main, [foreshock, main], [bulletin()])).toHaveLength(1)
  })
})

// 地震カードに付かない報を特別な情報の帯へ（2026-11-09 ユーザー選択「帯に出す (Recommended)」）
//   正: 通信試験と発生時刻を読めない報は帯の 1 通になり、期限は発表から 7 日／対照: 地震カードに付く報は帯に出さない／
//   安全弁: 発表時刻を読めない報は期限を数えられないので帯に出さない
describe('internationalTsunamiBandItem', () => {
  const x = (over: Partial<JMAInternationalTsunami>): JMAInternationalTsunami =>
    ({ id: 'w1', title: 'T', time: '2026-01-01T12:00:00Z', isCommunicationsTest: false, text: 'x', ...over } as JMAInternationalTsunami)
  it('正: 通信試験と発生時刻を読めない報は帯の 1 通になる（期限は発表から 7 日）', () => {
    expect(internationalTsunamiBandItem(x({ isCommunicationsTest: true }))).toEqual({
      id: 'w1', reportDateTime: '2026-01-01T12:00:00Z', expireAt: '2026-01-08T12:00:00.000Z', report: expect.objectContaining({ id: 'w1' }),
    })
    expect(internationalTsunamiBandItem(x({ originTime: undefined }))).not.toBeNull()
  })
  it('対照: 発生時刻を読める報（地震カードに付く）は帯に出さない', () => {
    expect(internationalTsunamiBandItem(x({ originTime: '2026-01-01T11:50:00Z' }))).toBeNull()
  })
  it('安全弁: 発表時刻を読めない報は帯に出さない', () => {
    expect(internationalTsunamiBandItem(x({ isCommunicationsTest: true, time: 'bad' }))).toBeNull()
  })
})
