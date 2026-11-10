import { describe, expect, it } from 'vitest'

import type { EEWAlert, JMAQuake, JMATsunami } from '../types/earthquake'
import {
  eewPrefectures, estimatedIntensityPrefectures, noIntensityQuakeHiddenByRegion, quakePrefectures, tsunamiPrefectures,
} from './notificationRegions'

type Points = Pick<JMAQuake, 'points'>['points']
type Areas = JMATsunami['areas']

describe('quakePrefectures', () => {
  it('都道府県の行だけを読み、コードへ直して重ねない', () => {
    const points = [
      { pref: '石川県', addr: '' },
      { pref: '', addr: '輪島市' },
      { pref: '富山県', addr: '' },
      { pref: '石川県', addr: '' },
    ] as unknown as Points
    expect(quakePrefectures({ points })).toEqual(['16', '17'])
  })

  it('安全弁: 読めない県名が混じれば絞らない', () => {
    const points = [{ pref: '石川県', addr: '' }, { pref: '架空県', addr: '' }] as unknown as Points
    expect(quakePrefectures({ points })).toBeNull()
  })

  it('県が読めなければ null（絞らない）', () => {
    expect(quakePrefectures({ points: [{ pref: '', addr: '輪島市' }] as unknown as Points })).toBeNull()
    expect(quakePrefectures({ points: [{ pref: '架空県', addr: '' }] as unknown as Points })).toBeNull()
  })
})

describe('eewPrefectures', () => {
  it('対象の地域の府県予報区（実電文の名前。「県」が付かず、北海道は分かれる）から県を読む', () => {
    const eew = { areas: [{ pref: '宮城' }, { pref: '岩手' }, { pref: '宮城' }, { pref: '北海道道南' }] } as unknown as EEWAlert
    expect(eewPrefectures(eew)).toEqual(['01', '03', '04'])
  })

  it('安全弁: 読めない名前が 1 つでも混じれば絞らない（読めた県だけで判定すると、選んだ県の報を落としうる）', () => {
    const eew = { areas: [{ pref: '宮城' }, { pref: '架空' }] } as unknown as EEWAlert
    expect(eewPrefectures(eew)).toBeNull()
  })

  it('地域を載せない報（取消など）は null', () => {
    expect(eewPrefectures({ areas: [] } as unknown as EEWAlert)).toBeNull()
  })
})

describe('tsunamiPrefectures', () => {
  it('予報区が面する県を、解除・取消の区域も含めて読む', () => {
    const areas = [{ name: '東京湾内湾' }] as unknown as Areas
    const cancelledAreas = [{ name: '愛知県外海' }] as unknown as Areas
    expect(tsunamiPrefectures({ areas, cancelledAreas })).toEqual(['12', '13', '14', '23'])
  })

  it('安全弁: 表に無い予報区が混じれば絞らない', () => {
    const areas = [{ name: '東京湾内湾' }, { name: '架空の海' }] as unknown as Areas
    expect(tsunamiPrefectures({ areas, cancelledAreas: [] })).toBeNull()
  })

  it('表に無い予報区だけなら null', () => {
    expect(tsunamiPrefectures({ areas: [{ name: '架空の海' }] as unknown as Areas, cancelledAreas: [] })).toBeNull()
  })
})

describe('estimatedIntensityPrefectures（推計震度分布図は元の地震の県で絞る）', () => {
  const quake = (id: string, time: string, lat: number, lon: number, prefs: string[]) => ({
    id, earthquake: { time, hypocenter: { latitude: lat, longitude: lon } },
    points: prefs.map(p => ({ pref: p, addr: '' })),
  }) as unknown as JMAQuake
  const ei = { arrivalTime: '2024-01-01T16:10:00+09:00', hypocenter: { lat: 37.5, lon: 137.2, depthKm: 10 } }

  it('正: 同じ地震と判定できる地震カードの、震度を観測した県を返す', () => {
    const q = quake('a', '2024-01-01T16:10:00+09:00', 37.5, 137.3, ['石川県', '富山県'])
    expect(estimatedIntensityPrefectures(ei, [q])).toEqual(['16', '17'])
  })

  it('安全弁: 当てはまる地震カードが無い・2 枚以上なら絞らない', () => {
    expect(estimatedIntensityPrefectures(ei, [])).toBeNull()
    const a = quake('a', '2024-01-01T16:10:00+09:00', 37.5, 137.3, ['石川県'])
    const b = quake('b', '2024-01-01T16:10:00+09:00', 37.6, 137.2, ['新潟県'])
    expect(estimatedIntensityPrefectures(ei, [a, b])).toBeNull()
  })
})

// 2026-11-09 ユーザー選択「地域を選んでいれば出さない (Recommended)」
//   正: 地域を選んでいれば震度なしの国内の報は出さない／対照: 地域を選んでいなければ出す・震度のある報は県で判定する側へ回す／
//   安全弁: 遠地地震は震度に関係なく出す
describe('noIntensityQuakeHiddenByRegion', () => {
  const q = (maxScale: number, type = '震源・震度に関する情報') => ({ earthquake: { maxScale }, issue: { type } })
  it('正: 地域を選んでいれば震度なしの国内の報は出さない', () => {
    expect(noIntensityQuakeHiddenByRegion({ notifyPrefectures: ['13'] }, q(-1))).toBe(true)
    expect(noIntensityQuakeHiddenByRegion({ notifyPrefectures: ['13'] }, q(-1, '震源情報'))).toBe(true)
  })
  it('対照: 地域を選んでいない・震度のある報は、ここでは止めない', () => {
    expect(noIntensityQuakeHiddenByRegion({ notifyPrefectures: [] }, q(-1))).toBe(false)
    expect(noIntensityQuakeHiddenByRegion({ notifyPrefectures: ['13'] }, q(10))).toBe(false)
  })
  it('安全弁: 遠地地震は地域を選んでいても止めない', () => {
    expect(noIntensityQuakeHiddenByRegion({ notifyPrefectures: ['13'] }, q(-1, '遠地地震'))).toBe(false)
  })
})
