// 揺れている区域の名前を「点の数×強さ」で決める（2026-10-31 ユーザー選択「点数×強さ (Recommended)」）。
//
//   正     : 強い 1 点より、やや弱い点が多く集まる区域を選ぶ
//   対照   : 点の数が同じなら強い方の区域を選ぶ／同点なら先に現れた区域
//   安全弁 : 欠測の点・区域に寄せられない点は数えない／区域データが無ければ null
import { describe, it, expect } from 'vitest'
import { dominantRegionName, kyoshinDetectSpeechText, type RegionPoint } from './kyoshinRegionName'
import type { SubRegion } from './subregions'

/** 緯度 35〜36 の 2 つの正方形の区域（西が「西区域」・東が「東区域」）。 */
const SUBREGIONS: SubRegion[] = [
  { name: '西区域', label: [35.5, 139.5], room: [0, 0], rings: [[[35, 139], [35, 140], [36, 140], [36, 139], [35, 139]]] },
  { name: '東区域', label: [35.5, 140.5], room: [0, 0], rings: [[[35, 140], [35, 141], [36, 141], [36, 140], [35, 140]]] },
]
const west = (index: number): RegionPoint => ({ lat: 35.5, lng: 139.5, index })
const east = (index: number): RegionPoint => ({ lat: 35.5, lng: 140.5, index })
/** どの区域からも離れた点（海の上・区域外） */
const far = (index: number): RegionPoint => ({ lat: 30, lng: 150, index })

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

  it('安全弁: 欠測（負の段）の点は数えない', () => {
    expect(dominantRegionName([west(-1), west(-1), west(-1), east(2)], SUBREGIONS)).toBe('東区域')
    expect(dominantRegionName([west(-1)], SUBREGIONS)).toBeNull()
  })

  it('安全弁: 区域に寄せられない点は数えない', () => {
    expect(dominantRegionName([far(19), west(5)], SUBREGIONS)).toBe('西区域')
    expect(dominantRegionName([far(19)], SUBREGIONS)).toBeNull()
  })

  it('安全弁: 区域データが無ければ null', () => {
    expect(dominantRegionName([west(9)], null)).toBeNull()
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
