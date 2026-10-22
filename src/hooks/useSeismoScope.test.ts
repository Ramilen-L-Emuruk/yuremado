// @vitest-environment jsdom
//
// 自作地震計の周りの範囲（地図の下端の波形を出すかの判定に使う）の回帰テスト。
//
// 固定するのは「中心は地震計の座標・座標が無ければホーム地点」（2026-10-22 ユーザー承認「地震計の座標」）。
// 座標は架空の丸めた値。

import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { scopeAround, seismoScopeCenters, useSeismoScope } from './useSeismoScope'
import { NO_SCOPE, type NearbyScope } from '../utils/actionChecklistTrigger'
import type { StationCoordsData } from '../utils/stationCoords'
import type { SiteCoords } from '../services/kyoshin'

/** 東西に約 300 km 離れた 2 つの観測点と、その近くの強震モニタの観測点。 */
const COORDS = {
  stations: {
    '大阪府|観測点甲': [35.0, 135.0, 0],
    '東京都|観測点乙': [35.0, 138.3, 1],
  },
  regionNames: ['区域甲', '区域乙'],
} as unknown as StationCoordsData
const SITES: SiteCoords = [[35.0, 135.0], [35.0, 138.3]]

const HOME_SCOPE: NearbyScope = { ...NO_SCOPE, regionNames: new Set(['ホームの区域']) }

describe('seismoScopeCenters', () => {
  it('座標を持つ観測点だけを中心にする', () => {
    expect(seismoScopeCenters([{ lat: 35, lon: 135 }, { lat: null, lon: null }, { lat: Number.NaN, lon: 1 }]))
      .toEqual([{ lat: 35, lng: 135 }])
  })
})

describe('scopeAround', () => {
  it('中心が無ければ地域を絞れない', () => {
    expect(scopeAround([], COORDS, SITES)).toBe(NO_SCOPE)
  })
})

describe('useSeismoScope', () => {
  // 対照: 地震計に座標が無ければ、ホーム地点の範囲をそのまま使う。
  it('座標を持つ観測点が無ければホーム地点の範囲を返す', () => {
    const { result } = renderHook(() =>
      useSeismoScope({ stations: [{ lat: null, lon: null }], homeScope: HOME_SCOPE, stationCoords: COORDS, kyoshinSites: SITES }),
    )
    expect(result.current).toBe(HOME_SCOPE)
  })

  // 正: 座標があれば、ホーム地点ではなく地震計の周りで作る。
  it('座標を持つ観測点があれば、その周りで作る', () => {
    const { result } = renderHook(() =>
      useSeismoScope({ stations: [{ lat: 35.0, lon: 135.0 }], homeScope: HOME_SCOPE, stationCoords: COORDS, kyoshinSites: SITES }),
    )
    expect([...result.current.regionNames]).toEqual(['区域甲'])
    expect(result.current.stationNames.has('観測点甲')).toBe(true)
    expect(result.current.kyoshinKeys.size).toBe(1)
  })

  // 安全弁: 観測点の座標表がまだ読めていなくても、強震モニタの観測点キーは地震計の周りで作る。
  it('座標表が読めていなくても、強震モニタの観測点キーは作る', () => {
    const { result } = renderHook(() =>
      useSeismoScope({ stations: [{ lat: 35.0, lon: 135.0 }], homeScope: HOME_SCOPE, stationCoords: null, kyoshinSites: SITES }),
    )
    expect(result.current.kyoshinKeys.size).toBe(1)
    expect(result.current.regionNames.size).toBe(0)
    expect(result.current.stationNames.size).toBe(0)
  })

  // 安全弁: 震度が届くたびに観測点の配列が作り直されても、座標が同じなら同じ範囲を返す（作り直さない）。
  it('座標が変わらなければ同じ範囲を返す', () => {
    const { result, rerender } = renderHook(
      ({ stations }) => useSeismoScope({ stations, homeScope: HOME_SCOPE, stationCoords: COORDS, kyoshinSites: SITES }),
      { initialProps: { stations: [{ lat: 35.0, lon: 135.0 }] } },
    )
    const first = result.current
    rerender({ stations: [{ lat: 35.0, lon: 135.0 }] })
    expect(result.current).toBe(first)
  })
})
