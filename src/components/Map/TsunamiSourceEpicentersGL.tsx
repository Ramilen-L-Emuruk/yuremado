import { useEffect, useRef } from 'react'
import type { MapGeoJSONFeature } from 'maplibre-gl'
import { useMapGL } from './mapGLContext'
import type { TsunamiSourceEarthquake } from '../../types/earthquake'
import { QUAKE_ARRIVAL_TIME_LABEL, formatDepth, formatMagnitudeCondition, formatTimeMin, hasDepth } from '../../utils/formatters'
import { hasKnownEpicenter, normalizeEpicenterLng } from '../../utils/geo'
import { sourceEarthquakeTime } from '../../utils/tsunami'
import { registerPopupSource, type PopupHandle } from './gl/popupRegistry'
import { addOrderedLayer } from './gl/layerOrder'
import { createDepthPointLayer, type DepthPoint, type DepthPointLayer } from './gl/depthPointLayer'
import { escapeHtml } from './gl/popupHtml'
import { log } from '../../utils/logger'
import { reportRenderFailure, clearRenderFailure, clearRenderFailuresFor } from '../../utils/renderHealth'

// 津波タブの地図に、**その津波の原因地震の震源**を×印で出す（2026-10-22 ユーザー選択「原因地震の震源を出す
// (Recommended)」）。地震カードで選んだ地震ではなく、津波電文が名乗る原因地震（`sourceEarthquakes`）。
// 複数あれば全部出す。凡例には載せない（EEW の×印と同じ）。
//
// 描き方は地震情報の震源・EEW の震源と同じ仕組み（深さを持つ点。gl/depthPointLayer.ts）で、色・大きさも揃える。
// **点滅はしない** —— 津波の原因地震は既に起きた地震で、進行中の揺れ（EEW）と同じ見せ方にしない。
// 深さが判らない震源は地表に置き、途切れた ×（`crossBroken`）で「ごく浅い」と見分ける（EEW と同じ扱い）。

const LYR = 'tsunami-source-epicenters'
/** 震央の経度を寄せる中心（地震情報・EEW の震源と同じ値。`useQuakeLayerData`・`useEewLayerData` の同名の定数）。 */
const JAPAN_CENTER_LNG = 137.7
/** 不調を知らせるときに画面へ出す名前（`utils/renderHealth.ts`）。 */
const LABEL = '津波の原因地震の震源'

/** ×印の色・大きさ。地震情報の震源（HypocenterDepthGL）・EEW の震源と揃える。 */
const CROSS_COLOR: readonly [number, number, number] = [255 / 255, 34 / 255, 34 / 255]
const CROSS_SIZE_PX = 32
const EPICENTER_COLOR: readonly [number, number, number] = [0.62, 0.16, 0.16]
const EPICENTER_SIZE_PX = 12

/** 地図に置ける原因地震（座標を持つもの）。座標が無い・センチネルのものは落とす。 */
export function placeableSources(sources: readonly TsunamiSourceEarthquake[]): (TsunamiSourceEarthquake & { latitude: number; longitude: number })[] {
  return sources.filter((s): s is TsunamiSourceEarthquake & { latitude: number; longitude: number } =>
    s.latitude !== undefined && s.longitude !== undefined && hasKnownEpicenter(s.latitude, s.longitude))
}

/**
 * 点の並びと、点の添字から原因地震を引く表を作る（1 つの震源につき震央の丸と震源の × の 2 点）。
 * **クリックの引き当てに使うので、点の並びと表の並びは必ず一致させること。**
 */
export function buildSourcePoints(
  sources: readonly TsunamiSourceEarthquake[],
  iconScale: number,
): { points: DepthPoint[]; owners: number[] } {
  const points: DepthPoint[] = []
  const owners: number[] = []
  placeableSources(sources).forEach((s, i) => {
    const lng = normalizeEpicenterLng(s.longitude, JAPAN_CENTER_LNG)
    const known = s.depth !== undefined && hasDepth(s.depth)
    points.push({ lng, lat: s.latitude, depthKm: 0, shape: 'circle', auxiliary: true, color: EPICENTER_COLOR, sizePx: EPICENTER_SIZE_PX * iconScale })
    owners.push(i)
    points.push({ lng, lat: s.latitude, depthKm: known ? s.depth! : 0, shape: known ? 'cross' : 'crossBroken', stem: true, color: CROSS_COLOR, sizePx: CROSS_SIZE_PX * iconScale })
    owners.push(i)
  })
  return { points, owners }
}

/**
 * 吹き出し。震源名／「M7.6　深さ 10km」／「地震発現時刻 16:10」（2026-10-24 ユーザー選択「この形で (Recommended)」。
 * 津波カードの原因地震の行と同じ語）。規模が数値で無ければ気象庁の説明（「Ｍ８を超える巨大地震」）を出し、
 * どちらも無ければ・深さが判らなければ・時刻が読めなければ、その項目を落とす（カードの行と同じ）。
 */
export function sourcePopupHtml(s: TsunamiSourceEarthquake): string {
  const mag = s.magnitude !== undefined ? `M${s.magnitude}` : s.magnitudeCondition ? formatMagnitudeCondition(s.magnitudeCondition) : ''
  const depth = s.depth !== undefined && hasDepth(s.depth) ? `深さ ${formatDepth(s.depth, s.depthAtLeast === true)}` : ''
  const quakeTime = sourceEarthquakeTime(s)
  const hm = quakeTime ? formatTimeMin(quakeTime) : null
  const detail = [mag, depth].filter(Boolean).join('　')
  return (
    `<div class="text-sm"><div class="font-bold">${escapeHtml(s.hypocenterName)}</div>` +
    (detail ? `<div class="text-xs" style="color:#e5e7eb">${escapeHtml(detail)}</div>` : '') +
    (hm ? `<div class="text-xs" style="color:#94a3b8">${escapeHtml(`${QUAKE_ARRIVAL_TIME_LABEL} ${hm}`)}</div>` : '') +
    `</div>`
  )
}

interface Props {
  sources: TsunamiSourceEarthquake[]
  iconScale: number
}

export function TsunamiSourceEpicentersGL({ sources, iconScale }: Props) {
  const map = useMapGL()
  const layerRef = useRef<DepthPointLayer | null>(null)
  const ownersRef = useRef<number[]>([])
  const placedRef = useRef<ReturnType<typeof placeableSources>>([])

  useEffect(() => {
    if (!map) return
    const layer = createDepthPointLayer(LYR, map, LABEL)
    layerRef.current = layer
    const add = () => {
      try {
        if (!map.getLayer(LYR)) addOrderedLayer(map, layer)
        clearRenderFailure(LYR, 'draw')
      } catch (err) {
        log.error('[TsunamiSourceEpicentersGL] カスタムレイヤーを足せなかった', err)
        reportRenderFailure(LYR, LABEL, 'draw')
      }
    }
    add()
    // WebGL の文脈が戻ったら足し直す（EEW の震源と同じ手当て）。
    const onRestored = () => {
      log.warn('[TsunamiSourceEpicentersGL] WebGL の文脈が戻ったので、カスタムレイヤーを足し直す')
      if (map.isStyleLoaded()) add()
      else map.once('style.load', add)
    }
    map.on('webglcontextrestored', onRestored)
    let popup: PopupHandle | null = null
    try {
      popup = registerPopupSource(map, {
        layerId: LYR,
        label: LABEL,
        priority: 'point',
        tolPx: 0,
        pick: (point, forClick) => {
          const hit = layerRef.current?.pick(point.x, point.y, forClick)
          if (hit === 'pending') return 'pending'
          if (hit == null) return null
          const s = placedRef.current[ownersRef.current[hit]]
          if (!s) return null
          return {
            type: 'Feature',
            // 吹き出しの位置は×を描いた世界のコピーに合わせる（遠地の震源は日本寄りへ寄せて描いている。`buildSourcePoints`）
            geometry: { type: 'Point', coordinates: [normalizeEpicenterLng(s.longitude, JAPAN_CENTER_LNG), s.latitude] },
            properties: { index: ownersRef.current[hit] },
          } as unknown as MapGeoJSONFeature
        },
        buildClickHtml: (feature) => {
          const s = placedRef.current[Number(feature.properties?.index)]
          return s ? sourcePopupHtml(s) : ''
        },
      })
    } catch (err) {
      log.error('[TsunamiSourceEpicentersGL] 吹き出しの元データを登録できなかった', err)
      reportRenderFailure(LYR, LABEL, 'interact')
    }
    return () => {
      popup?.remove()
      clearRenderFailuresFor(LYR)
      map.off('webglcontextrestored', onRestored)
      map.off('style.load', add)
      layerRef.current = null
      if (map.getLayer(LYR)) map.removeLayer(LYR)
    }
  }, [map])

  useEffect(() => {
    const { points, owners } = buildSourcePoints(sources, iconScale)
    ownersRef.current = owners
    placedRef.current = placeableSources(sources)
    layerRef.current?.setPoints(points)
    // `map` を依存に含める理由は EEW の震源と同じ（地図の生成が後になると、先に走ったこの効果が素通りする）。
  }, [map, sources, iconScale])

  return null
}
