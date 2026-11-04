// 津波の原因地震を、結べた地震カードの上段の値で表す（2026-11-03 ユーザー選択「結べた地震カードの値 (Recommended)」）。
import { describe, it, expect } from 'vitest'
import { distinctShownTsunamiSources, shownTsunamiSource, shownTsunamiSources } from './tsunamiSourceLinks'
import './quakeMerge'
import type { JMAQuake, JMATsunami, TsunamiSourceEarthquake } from '../types/earthquake'

const EVENT = '20240101161010'

function card(extra: Partial<JMAQuake> = {}): JMAQuake {
  return {
    kind: 'quake',
    id: `dmdata-quake-${EVENT}-1`,
    time: '2024-01-01T16:24:00+09:00',
    issue: { source: '気象庁', time: '2024-01-01T16:24:00+09:00', type: '震源・震度情報', correct: 'なし' },
    earthquake: {
      time: '2024-01-01T16:10:00+09:00',
      hypocenter: {
        name: '石川県能登地方', latitude: 37.5, longitude: 137.3, depth: 0, magnitude: 7.6, magnitudeType: 'Mj',
        nameFromMark: '輪島の東北東３０ｋｍ付近',
      },
      maxScale: 70,
    },
    points: [],
    ...extra,
  } as unknown as JMAQuake
}

/** 津波電文が名乗る原因地震（地震情報より古い規模 M7.4 を運んだ形）。 */
const fromTsunami: TsunamiSourceEarthquake = {
  hypocenterName: '石川県能登地方', magnitude: 7.4, magnitudeType: 'Mj', depth: 10,
  latitude: 37.4, longitude: 137.2, arrivalTime: '2024-01-01T16:10:00+09:00', nameFromMark: '輪島の東北東２０ｋｍ付近',
}

describe('shownTsunamiSource', () => {
  // 正: 結べた地震カードがあれば、その上段の値（規模・深さ・震央・補助表現）で出す
  it('結べた地震カードの上段の値で出す', () => {
    const shown = shownTsunamiSource(fromTsunami, card())
    expect(shown.magnitude).toBe(7.6)
    expect(shown.depth).toBe(0)
    expect(shown.latitude).toBe(37.5)
    expect(shown.nameFromMark).toBe('輪島の東北東３０ｋｍ付近')
    expect(shown.arrivalTime).toBe('2024-01-01T16:10:00+09:00')
  })

  // 対照: 結べなければ津波電文の値のまま（同じ参照を返す）
  it('結べなければ電文の値のまま', () => {
    expect(shownTsunamiSource(fromTsunami, undefined)).toBe(fromTsunami)
  })

  // 安全弁: 取り消された地震カード・震源名を持たないカード（震度速報だけ）の値は使わない
  it('取り消されたカードと震源名の無いカードは使わない', () => {
    expect(shownTsunamiSource(fromTsunami, card({ cancelledAt: new Date('2024-01-01T16:30:00+09:00') } as Partial<JMAQuake>))).toBe(fromTsunami)
    const pending = card()
    pending.earthquake.hypocenter = { ...pending.earthquake.hypocenter, name: '', latitude: Number.NaN, longitude: Number.NaN, depth: -1, magnitude: Number.NaN }
    expect(shownTsunamiSource(fromTsunami, pending)).toBe(fromTsunami)
  })

  // 安全弁: カードが値を持たない欄は電文の値を残す（電文にしか無い値を黙って落とさない）。
  // ただしカードが規模の説明（「Ｍ不明」）を持つなら、それが上段の値
  it('カードが持たない欄は電文の値を残す', () => {
    const partial = card()
    partial.earthquake.hypocenter = { name: '石川県能登地方', latitude: Number.NaN, longitude: Number.NaN, depth: -1, magnitude: Number.NaN }
    const shown = shownTsunamiSource({ ...fromTsunami, source: 'ＰＴＷＣ' }, partial)
    expect(shown.depth).toBe(10)
    expect(shown.magnitude).toBe(7.4)
    expect(shown.latitude).toBe(37.4)
    expect(shown.nameFromMark).toBe('輪島の東北東２０ｋｍ付近')
    expect(shown.source).toBe('ＰＴＷＣ')
    // 震源を決めたカード（位置・規模を持つ）が機関を持たないなら、電文の機関は残さない（気象庁の値の横に「ＰＴＷＣ」を出さない）
    expect(shownTsunamiSource({ ...fromTsunami, source: 'ＰＴＷＣ' }, card()).source).toBeUndefined()
    const unknownM = card()
    unknownM.earthquake.hypocenter = { ...unknownM.earthquake.hypocenter, magnitude: Number.NaN, magnitudeCondition: 'Ｍ不明' }
    const shownM = shownTsunamiSource(fromTsunami, unknownM)
    expect(shownM.magnitude).toBeUndefined()
    expect(shownM.magnitudeCondition).toBe('Ｍ不明')
  })
})

describe('shownTsunamiSources', () => {
  it('番号で結べた原因地震だけ地震カードの値になる', () => {
    const tsunami = { eventId: EVENT, sourceEarthquakes: [fromTsunami] } as Pick<JMATsunami, 'eventId' | 'foldedReports' | 'sourceEarthquakes'>
    expect(shownTsunamiSources(tsunami, [card()])[0].magnitude).toBe(7.6)
    expect(shownTsunamiSources({ ...tsunami, eventId: '20240101000000' }, [card()])[0].magnitude).toBe(7.4)
  })
})

describe('distinctShownTsunamiSources', () => {
  type T = Pick<JMATsunami, 'cancelled' | 'eventId' | 'foldedReports' | 'sourceEarthquakes'>
  // 結べる津波（番号が地震カードと同じ）と、結べない津波（番号が違う）が同じ地震を運ぶ形
  const linked: T = { cancelled: false, eventId: EVENT, sourceEarthquakes: [fromTsunami] }
  const unlinked: T = { cancelled: false, eventId: '20240101000000', sourceEarthquakes: [{ ...fromTsunami, arrivalTime: '2024-01-01T07:10:00Z' }] }

  // 正: 片方だけ結べて時刻の書き方が違っても、同じ瞬間・同じ震源名なら 1 つにまとめる
  it('時刻の書き方が違っても、同じ地震は 1 度だけ', () => {
    const out = distinctShownTsunamiSources([linked, unlinked], [card()])
    expect(out).toHaveLength(1)
    expect(out[0].magnitude).toBe(7.6)
  })

  // 対照: 時刻が違えば別の地震として並べる
  it('時刻が違う地震は別に並べる', () => {
    const other: T = { cancelled: false, eventId: '20240101000000', sourceEarthquakes: [{ ...fromTsunami, arrivalTime: '2024-01-01T17:00:00+09:00' }] }
    expect(distinctShownTsunamiSources([linked, other], [card()])).toHaveLength(2)
  })

  // 安全弁: 取り消された津波の原因地震は描かない
  it('取り消された津波は見ない', () => {
    expect(distinctShownTsunamiSources([{ ...linked, cancelled: true }], [card()])).toEqual([])
  })
})
