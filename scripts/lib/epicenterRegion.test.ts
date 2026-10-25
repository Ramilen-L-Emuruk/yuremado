import { describe, expect, it } from 'vitest'
import { buildEpicenterRegionIndex } from './epicenterRegion'

const square = (x0: number, y0: number, x1: number, y1: number) => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
  [x0, y0],
]

const geojson = {
  type: 'FeatureCollection',
  features: [
    // 穴のある区域（穴の中は別の区域）
    { properties: { name: '外側' }, geometry: { type: 'Polygon', coordinates: [square(0, 0, 10, 10), square(4, 4, 6, 6)] } },
    { properties: { name: '穴の中' }, geometry: { type: 'Polygon', coordinates: [square(4, 4, 6, 6)] } },
    // 離れた 2 つの島からなる区域
    {
      properties: { name: '島々' },
      geometry: { type: 'MultiPolygon', coordinates: [[square(20, 0, 21, 1)], [square(30, 0, 31, 1)]] },
    },
  ],
}

describe('座標から震央地名を引く', () => {
  const index = buildEpicenterRegionIndex(geojson)

  it('正: 区域の中の点はその区域の名前になる（緯度・経度の順に渡す）', () => {
    expect(index.lookup(1, 1)).toBe('外側')
    expect(index.lookup(0.5, 30.5)).toBe('島々')
  })

  it('正: 穴の中の点は外側の区域に入らず、穴を埋める区域になる', () => {
    expect(index.lookup(5, 5)).toBe('穴の中')
  })

  it('対照: どの区域にも入らない点は null（英字の名前へ倒すのは呼び出し側）', () => {
    expect(index.lookup(0.5, 25)).toBeNull()
    expect(index.lookup(-1, -1)).toBeNull()
  })

  it('安全弁: 名前の無い区域・読めない形は黙って飛ばさず投げる', () => {
    expect(() => buildEpicenterRegionIndex({ features: [] })).toThrow()
    expect(() =>
      buildEpicenterRegionIndex({ features: [{ properties: {}, geometry: { type: 'Polygon', coordinates: [square(0, 0, 1, 1)] } }] }),
    ).toThrow()
    expect(() =>
      buildEpicenterRegionIndex({ features: [{ properties: { name: 'x' }, geometry: { type: 'Point', coordinates: [0, 0] } }] }),
    ).toThrow()
  })
})
