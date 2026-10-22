// 自作地震計の周り（半径 30km）を表す {@link NearbyScope} を作る。地図の下端の波形を出すかの判定
// （`utils/seismoWaveTrigger.ts`）が使う。
//
// **中心は地震計の座標で、座標が無ければホーム地点**（2026-10-22 ユーザー承認。選ばれた選択肢は
// 「地震計の座標」）。波形は地震計が測ったものなので、揺れたかを見るべき場所も地震計の置き場所になる。
// ホーム地点を中心にすると、地点を登録していない端末では全国のどこで検知しても波形が出ていた。
//
// **観測点が複数あれば、それぞれの周りを合わせる**（どの観測点の近くで揺れても出す）。
//
// 半径・索引の引き方はホーム地点の範囲（`useNearbyScope`）と同じ関数を通す —— 別に持つと、片方だけ
// 半径や索引の扱いを変えたときに食い違う。

import { useMemo } from 'react'
import { NO_SCOPE, type NearbyScope } from '../utils/actionChecklistTrigger'
import {
  allRegionNames,
  allStationNames,
  nearbyKyoshinKeys,
  nearbyRegionNames,
  nearbyStationNames,
  type HomePoint,
} from '../utils/nearbyStations'
import type { StationCoordsData } from '../utils/stationCoords'
import type { SiteCoords } from '../services/kyoshin'

/** 座標を持つ観測点の位置だけを取り出す。座標が無ければ空。 */
export function seismoScopeCenters(
  stations: readonly { readonly lat: number | null; readonly lon: number | null }[],
): HomePoint[] {
  const centers: HomePoint[] = []
  for (const s of stations) {
    if (s.lat === null || s.lon === null || !Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue
    centers.push({ lat: s.lat, lng: s.lon })
  }
  return centers
}

/**
 * いくつかの点の周りを合わせた範囲。点が無ければ {@link NO_SCOPE}。
 *
 * **観測点の座標表（`stationCoords`）がまだ読めていなくても、強震モニタの観測点キーだけは作る。**
 * 強震モニタの観測点は座標表と別に届くので、座標表を待つと、その間は強震モニタの経路が地震計の周りに絞れない。
 * 区域・観測点名は空のまま（緊急地震速報の区域の判定は、区域を引けない端末と同じ扱いになる）。
 */
export function scopeAround(
  centers: readonly HomePoint[],
  stationCoords: StationCoordsData | null,
  kyoshinSites: SiteCoords,
): NearbyScope {
  if (centers.length === 0) return NO_SCOPE
  const kyoshinKeys = new Set<string>()
  const stationNames = new Set<string>()
  const regionNames = new Set<string>()
  for (const c of centers) {
    for (const k of nearbyKyoshinKeys(kyoshinSites, c)) kyoshinKeys.add(k)
    if (!stationCoords) continue
    for (const n of nearbyStationNames(stationCoords, c)) stationNames.add(n)
    for (const n of nearbyRegionNames(stationCoords, c)) regionNames.add(n)
  }
  return {
    centers,
    kyoshinKeys,
    stationNames,
    regionNames,
    knownStationNames: stationCoords ? allStationNames(stationCoords) : new Set<string>(),
    knownRegionNames: stationCoords ? allRegionNames(stationCoords) : new Set<string>(),
  }
}

export function useSeismoScope(params: {
  /** 自作地震計の観測点。座標を持つものだけを中心に使う。 */
  stations: readonly { readonly lat: number | null; readonly lon: number | null }[]
  /** 地震計の座標が 1 つも無いときの中心。 */
  homeScope: NearbyScope
  stationCoords: StationCoordsData | null
  kyoshinSites: SiteCoords
}): NearbyScope {
  const { stations, homeScope, stationCoords, kyoshinSites } = params
  // **震度が届くたびに観測点の配列は作り直される**（0.3 秒ごと）。全点の距離計算をそのたびに回さないよう、
  // 座標が変わったときだけ引き直す。
  const centersKey = seismoScopeCenters(stations).map((c) => `${c.lat},${c.lng}`).join(';')
  return useMemo(() => {
    if (centersKey === '') return homeScope
    const centers = centersKey.split(';').map((s) => {
      const [lat, lng] = s.split(',').map(Number)
      return { lat, lng }
    })
    return scopeAround(centers, stationCoords, kyoshinSites)
  }, [centersKey, homeScope, stationCoords, kyoshinSites])
}
