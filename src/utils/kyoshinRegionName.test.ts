// 揺れている区域の名前を「点の数×強さ」で決める（2026-10-31 ユーザー選択「点数×強さ (Recommended)」）。
// 点 1 つの区域は、海底の相模湾 → 区域の中か 5km 以内 → 距離を問わず最寄り、の順で引く
// （同日「海底は「相模湾」・島は最寄り (Recommended)」「埋める・取れない時は「別の地点でも」 (Recommended)」）。
//
//   正     : 強い 1 点より、やや弱い点が多く集まる区域を選ぶ／相模湾の海底は「相模湾」／離れた点は最寄りの区域
//   対照   : 点の数が同じなら強い方の区域を選ぶ／同点なら先に現れた区域／相模湾の隣の座標は海底扱いしない
//   安全弁 : 欠測の点は強さに数えない（全部欠測なら点の数で決める）／区域データが無ければ null
import { describe, it, expect } from 'vitest'
import {
  dominantRegionName,
  kyoshinDetectSpeechText,
  kyoshinOtherRegionSpeechText,
  kyoshinPointRegionName,
  SAGAMI_BAY_SEAFLOOR_NAME,
  type RegionPoint,
} from './kyoshinRegionName'
import { nearestSubRegionName, type SubRegion } from './subregions'

/** 緯度 35〜36 の 2 つの正方形の区域（西が「西区域」・東が「東区域」）。 */
const SUBREGIONS: SubRegion[] = [
  { name: '西区域', label: [35.5, 139.5], room: [0, 0], rings: [[[35, 139], [35, 140], [36, 140], [36, 139], [35, 139]]] },
  { name: '東区域', label: [35.5, 140.5], room: [0, 0], rings: [[[35, 140], [35, 141], [36, 141], [36, 140], [35, 140]]] },
]
const west = (index: number): RegionPoint => ({ lat: 35.5, lng: 139.5, index })
const east = (index: number): RegionPoint => ({ lat: 35.5, lng: 140.5, index })
/** 東区域の東の端から 300km ほど離れた海の上の点（5km の上限の外） */
const farEast = (index: number): RegionPoint => ({ lat: 35.5, lng: 144.3, index })

describe('dominantRegionName', () => {
  it('正: 強い 1 点より、やや弱い点が多く集まる区域を選ぶ', () => {
    // 西: 段 13 が 1 点（重み 7）／東: 段 9 が 3 点（重み 5×3=15）
    expect(dominantRegionName([west(13), east(9), east(9), east(9)], SUBREGIONS)).toBe('東区域')
  })

  it('対照: 点の数が同じなら強い方の区域を選ぶ', () => {
    expect(dominantRegionName([west(9), east(11)], SUBREGIONS)).toBe('東区域')
  })

  it('対照: 合計が同じなら先に現れた区域を選ぶ', () => {
    expect(dominantRegionName([east(9), west(9)], SUBREGIONS)).toBe('東区域')
    expect(dominantRegionName([west(9), east(9)], SUBREGIONS)).toBe('西区域')
  })

  it('対照: 段 0（計測震度 −3.0）の点も数える', () => {
    expect(dominantRegionName([west(0)], SUBREGIONS)).toBe('西区域')
  })

  it('安全弁: 欠測（負の段）の点は強さに数えない', () => {
    expect(dominantRegionName([west(-1), west(-1), west(-1), east(2)], SUBREGIONS)).toBe('東区域')
  })

  it('安全弁: 全部の点が欠測なら、点の数で決める', () => {
    expect(dominantRegionName([west(-1)], SUBREGIONS)).toBe('西区域')
    expect(dominantRegionName([east(-1), west(-1), west(-1)], SUBREGIONS)).toBe('西区域')
  })

  it('正: 区域から離れた点も、最寄りの区域へ数える', () => {
    expect(dominantRegionName([farEast(19)], SUBREGIONS)).toBe('東区域')
    expect(dominantRegionName([farEast(19), west(5)], SUBREGIONS)).toBe('東区域')
  })

  it('安全弁: 区域データが無い・点が無ければ null', () => {
    expect(dominantRegionName([west(9)], null)).toBeNull()
    expect(dominantRegionName([], SUBREGIONS)).toBeNull()
  })
})

describe('kyoshinPointRegionName', () => {
  it('正: 相模湾の海底観測点（KNG201〜206 の座標）は「相模湾」', () => {
    for (const [lat, lng] of [[34.6, 139.9], [34.7, 139.8], [34.8, 139.6], [34.9, 139.6], [34.9, 139.4], [35.1, 139.4]]) {
      expect(kyoshinPointRegionName(lat, lng, SUBREGIONS)).toBe(SAGAMI_BAY_SEAFLOOR_NAME)
    }
  })

  it('正: 座標の表し方の揺れ（34.599999… など）でも相模湾と引く', () => {
    expect(kyoshinPointRegionName(34.6 - 1e-9, 139.9 + 1e-9, SUBREGIONS)).toBe(SAGAMI_BAY_SEAFLOOR_NAME)
    expect(kyoshinPointRegionName(0.1 * 351, 139.4, SUBREGIONS)).toBe(SAGAMI_BAY_SEAFLOOR_NAME) // 35.1 の浮動小数
  })

  it('対照: 海底観測点の座標から 0.04 度ずれた点は、海底扱いしない', () => {
    // 35.14,139.44 は西区域の中
    expect(kyoshinPointRegionName(35.14, 139.44, SUBREGIONS)).toBe('西区域')
  })

  it('対照: 相模湾の座標に隣り合う点は、海底扱いせず区域で引く', () => {
    // 35.1,139.5 は西区域の中（海底観測点の 35.1,139.4 と 0.1 度違い）
    expect(kyoshinPointRegionName(35.1, 139.5, SUBREGIONS)).toBe('西区域')
  })

  it('正: 区域の中ならその区域、離れていれば最寄りの区域', () => {
    expect(kyoshinPointRegionName(35.5, 139.5, SUBREGIONS)).toBe('西区域')
    expect(kyoshinPointRegionName(35.5, 144.3, SUBREGIONS)).toBe('東区域')
  })

  it('安全弁: 区域データが空なら null', () => {
    expect(kyoshinPointRegionName(35.5, 139.5, [])).toBeNull()
  })
})

describe('nearestSubRegionName', () => {
  it('距離を問わず、境界の頂点が最も近い区域を返す', () => {
    expect(nearestSubRegionName(35.5, 130, SUBREGIONS)).toBe('西区域')
    expect(nearestSubRegionName(35.5, 150, SUBREGIONS)).toBe('東区域')
  })
  it('座標が数でない・区域データが空なら null', () => {
    expect(nearestSubRegionName(Number.NaN, 139, SUBREGIONS)).toBeNull()
    expect(nearestSubRegionName(35, 139, [])).toBeNull()
  })
})

describe('kyoshinDetectSpeechText', () => {
  it('区域名があれば「〇〇で揺れを検知。」', () => {
    expect(kyoshinDetectSpeechText('石川県能登')).toBe('石川県能登で揺れを検知。')
  })
  it('区域名が無ければ地名を言わない', () => {
    expect(kyoshinDetectSpeechText(null)).toBe('揺れを検知。')
  })
})

describe('kyoshinOtherRegionSpeechText', () => {
  it('区域名があれば「〇〇でも揺れを検知。」', () => {
    expect(kyoshinOtherRegionSpeechText('茨城県南部')).toBe('茨城県南部でも揺れを検知。')
  })
  it('区域名が無ければ「別の地点でも揺れを検知。」', () => {
    expect(kyoshinOtherRegionSpeechText(null)).toBe('別の地点でも揺れを検知。')
  })
})
