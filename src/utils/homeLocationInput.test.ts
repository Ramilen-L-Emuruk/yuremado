import { describe, it, expect } from 'vitest'
import { isValidHomeLocation, parseCoordinateNumber, splitPastedLatLng } from './homeLocationInput'

describe('ホーム地点の手入力', () => {
  // 正: 半角・全角・符号つきを読む
  it('数として読む', () => {
    expect(parseCoordinateNumber('37.5')).toBe(37.5)
    expect(parseCoordinateNumber(' ３７．５ ')).toBe(37.5)
    expect(parseCoordinateNumber('-33.9')).toBe(-33.9)
  })

  // 対照: 数でないものは読まない
  it('数でないものは null', () => {
    expect(parseCoordinateNumber('')).toBeNull()
    expect(parseCoordinateNumber('北緯37')).toBeNull()
    expect(parseCoordinateNumber('1e3')).toBeNull()
  })

  // 安全弁: 範囲の外は丸めずに受け付けない（打ち間違いを別の地点にしない）
  it('範囲の外は使えない', () => {
    expect(isValidHomeLocation(37.5, 137.2)).toBe(true)
    expect(isValidHomeLocation(91, 137.2)).toBe(false)
    expect(isValidHomeLocation(37.5, 1372)).toBe(false)
    expect(isValidHomeLocation(null, 137.2)).toBe(false)
  })

  it('1 つの欄へ貼られた組を割る', () => {
    expect(splitPastedLatLng('37.5, 137.2')).toEqual({ lat: '37.5', lng: '137.2' })
    expect(splitPastedLatLng('37.5 137.2')).toEqual({ lat: '37.5', lng: '137.2' })
    expect(splitPastedLatLng('３７．５、１３７．２')).toEqual({ lat: '37.5', lng: '137.2' })
    expect(splitPastedLatLng('37.5')).toBeNull()
    expect(splitPastedLatLng('37.5, 東経137')).toBeNull()
  })
})
