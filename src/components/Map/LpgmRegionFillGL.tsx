import { useEffect, useRef } from 'react'
import { frontSortKeyExpression, mercatorProps } from './gl/screenDepth'
import type { GeoJSONSource, MapGeoJSONFeature } from 'maplibre-gl'
import type { Feature, FeatureCollection, Point, Polygon } from 'geojson'
import { useMapGL } from './mapGLContext'
import { getLpgmClassColor, getLpgmClassLabel, getLpgmClassRadius, type LpgmStationRow } from '../../utils/lpgm'
import { getIntensityLabel } from '../../utils/intensity'
import { NON_JMA_MARK_TITLE, withNonJmaMark } from '../../utils/formatters'
import type { LpgmRegionAggregate } from '../../hooks/useQuakeLayerData'
import { ringToLngLat } from './gl/geojson'
import { addOrderedLayer } from './gl/layerOrder'
import { registerPopupSource, type PopupHandle } from './gl/popupRegistry'
import { badgeHtml, escapeHtml } from './gl/popupHtml'
import { ensureLpgmIcons, lpgmIconId, LPGM_ICON_BASE_RADIUS } from './gl/lpgmIcons'

// 長周期地震動のズームアウト時、一次細分区域ごとの最大階級を塗る MapLibre 版
// （Leaflet 版 JapanMap の lpgm-region-fill ペイン＋区域中心マーカー相当）。
// 区域塗りは fill+line、区域中心の階級ラベルは観測点（LpgmPointsGL）と同じ icon-image 方式で描く
// （gl/lpgmIcons.ts の Canvas2D 事前ラスタライズ画像を共有）。クリックのみでポップアップを出す
// （ホバーは元々無し）。

const FILL_SRC = 'quake-lpgm-region-fill'
const FILL_LYR = 'quake-lpgm-region-fill'
const LINE_LYR = 'quake-lpgm-region-fill-line'
const LABEL_SRC = 'quake-lpgm-region-label'
const LABEL_LYR = 'quake-lpgm-region-label'
const HIT_TOL_PX = 10
// 区域バッジは観測点バッジ（LpgmPointsGL）より一回り大きくする分の下駄。
// 震度側が観測点 `getScaleRadius()+3`／区域 `+4` と使い分けているのと同じ考え方。
//
// 以前は階級によらず 32px 固定だった（旧 HTML Marker 版 buildLpgmBadgeEl からの移植の名残）。
// 最も重い階級4 が階級1 と同じ大きさで、重大さが大きさに出ていなかったため階級連動にした。
// 下駄を 8 にすることで階級1 は従来どおり 32px のまま、階級4 が 44px まで育つ（縮小はしない）。
const REGION_RADIUS_BONUS = 8

const EMPTY_FILL_FC: FeatureCollection<Polygon> = { type: 'FeatureCollection', features: [] }
const EMPTY_LABEL_FC: FeatureCollection<Point> = { type: 'FeatureCollection', features: [] }

interface Props {
  regionAggregates: LpgmRegionAggregate[]
  iconScale: number
  visible: boolean
}

function buildFillFC(regions: LpgmRegionAggregate[]): FeatureCollection<Polygon> {
  const features: Feature<Polygon>[] = []
  for (const r of regions) {
    const color = getLpgmClassColor(r.maxLgInt)
    for (const ring of r.rings) {
      features.push({
        type: 'Feature',
        properties: { color },
        geometry: { type: 'Polygon', coordinates: [ringToLngLat(ring)] },
      })
    }
  }
  return { type: 'FeatureCollection', features }
}

function buildLabelFC(regions: LpgmRegionAggregate[], iconScale: number): FeatureCollection<Point> {
  const features: Feature<Point>[] = regions.map((r) => ({
    type: 'Feature',
    properties: {
      iconId: lpgmIconId(r.maxLgInt),
      iconSizeRatio: ((getLpgmClassRadius(r.maxLgInt) + REGION_RADIUS_BONUS) * iconScale) / LPGM_ICON_BASE_RADIUS,
      lgInt: r.maxLgInt,
      name: r.name,
      // 区域の最大震度。**階級だけだと「揺れは小さいのに高層階が大きく揺れた」形が読めない**
      int: r.maxInt ?? -1,
      // 同じ階級のバッジを画面の手前から並べるために持たせる（gl/screenDepth.ts）。
      ...mercatorProps(r.label[1], r.label[0]),
    },
    geometry: { type: 'Point', coordinates: [r.label[1], r.label[0]] },
  }))
  return { type: 'FeatureCollection', features }
}

/** 吹き出しに並べる観測点の数。超えた分は「ほか N 観測点」の行で件数だけ伝える（地震の区域塗りの市町村と同じ上限）。 */
export const POPUP_STATION_LIMIT = 8

/**
 * 区域の吹き出しに足す、その区域の観測点の行（2026-10-25 ユーザー選択「観測点を並べる (Recommended)」）。
 *
 * **電文は区域の段に周期ごとの内訳を持たない。** 区域の内訳を集計で作ると電文に無い値になるので、
 * 区域では観測点を並べるだけにし、内訳は観測点の吹き出しとカードの観測点の行で見せる。
 * カードで区域の行を開いたときと同じ顔ぶれ・同じ順（→ `lpgmStationsByArea`）。
 * 作りは地震の区域塗りの吹き出しの市町村の行（`regionCityRowsHtml`）に揃える。
 */
export function regionStationRowsHtml(stations: readonly LpgmStationRow[]): string {
  if (stations.length === 0) return ''
  const omitted = stations.length - POPUP_STATION_LIMIT
  const rows = stations
    .slice(0, POPUP_STATION_LIMIT)
    .map((s) =>
      `<div style="display:flex;align-items:center;gap:8px;font-size:12px">` +
      `${badgeHtml(String(s.lgInt), getLpgmClassColor(s.lgInt))}` +
      `<span style="color:#cbd5e1"` + (s.nonJma ? ` title="${escapeHtml(NON_JMA_MARK_TITLE)}"` : '') +
      `>${escapeHtml(withNonJmaMark(s.name, s.nonJma === true))}</span>` +
      (s.int !== undefined
        ? `<span style="color:#94a3b8">震度 ${escapeHtml(getIntensityLabel(s.int))}</span>`
        : '') +
      `</div>`)
    .join('')
  const more = omitted > 0 ? `<div style="font-size:12px;color:#cbd5e1">ほか ${omitted} 観測点</div>` : ''
  return `<div style="margin-top:8px;display:flex;flex-direction:column;gap:2px">${rows}${more}</div>`
}

function clickHtml(f: MapGeoJSONFeature, stationsByRegion: ReadonlyMap<string, readonly LpgmStationRow[]>): string {
  const lgInt = Number(f.properties?.lgInt ?? 0)  // 地物は組み立てで必ず lgInt（0〜4）を持つ。欠けるのは組み立てが壊れたときだけ
  const name = String(f.properties?.name ?? '')
  const int = Number(f.properties?.int ?? -1)
  return (
    `<div class="text-sm" style="min-width:160px"><div class="font-bold">${escapeHtml(name)}</div>` +
    `<div class="text-xs" style="color:#94a3b8">長周期地震動 ${escapeHtml(getLpgmClassLabel(lgInt))}` +
    (int >= 0 ? `　震度 ${escapeHtml(getIntensityLabel(int))}` : '') +
    `</div>` +
    regionStationRowsHtml(stationsByRegion.get(name) ?? []) +
    `</div>`
  )
}

export function LpgmRegionFillGL({ regionAggregates, iconScale, visible }: Props) {
  const map = useMapGL()
  const addedRef = useRef(false)
  const popupRef = useRef<PopupHandle | null>(null)
  // 吹き出しの登録は [map] 依存で 1 回だけなので、観測点は ref 越しに最新を読む（QuakeRegionFillGL と同じ）。
  const stationsByRegionRef = useRef<ReadonlyMap<string, readonly LpgmStationRow[]>>(new Map())
  stationsByRegionRef.current = new Map(regionAggregates.map((r) => [r.name, r.stations]))

  useEffect(() => {
    if (!map) return
    ensureLpgmIcons(map)
    map.addSource(FILL_SRC, { type: 'geojson', data: EMPTY_FILL_FC })
    addOrderedLayer(map, {
      id: FILL_LYR,
      type: 'fill',
      source: FILL_SRC,
      layout: { visibility: visible ? 'visible' : 'none' },
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.5 },
    })
    addOrderedLayer(map, {
      id: LINE_LYR,
      type: 'line',
      source: FILL_SRC,
      layout: { visibility: visible ? 'visible' : 'none' },
      paint: { 'line-color': ['get', 'color'], 'line-width': 1 },
    })
    map.addSource(LABEL_SRC, { type: 'geojson', data: EMPTY_LABEL_FC })
    addOrderedLayer(map, {
      id: LABEL_LYR,
      type: 'symbol',
      source: LABEL_SRC,
      layout: {
        'icon-image': ['get', 'iconId'],
        'icon-size': ['get', 'iconSizeRatio'],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        // 階級が第一・画面の手前らしさが第二の合成キー（gl/screenDepth.ts）。方位が変われば
        // JapanMapGL が式を差し替える。ここで置くのは方位 0 の初期値。
        'symbol-sort-key': frontSortKeyExpression('lgInt', 0),
        visibility: visible ? 'visible' : 'none',
      },
    })
    popupRef.current = registerPopupSource(map, {
      layerId: LABEL_LYR,
      priority: 'point',
      tolPx: HIT_TOL_PX,
      rankKey: 'lgInt',
      buildClickHtml: (f) => clickHtml(f, stationsByRegionRef.current),
    })
    addedRef.current = true
    return () => {
      popupRef.current?.remove()
      popupRef.current = null
      if (map.getLayer(LABEL_LYR)) map.removeLayer(LABEL_LYR)
      if (map.getSource(LABEL_SRC)) map.removeSource(LABEL_SRC)
      if (map.getLayer(LINE_LYR)) map.removeLayer(LINE_LYR)
      if (map.getLayer(FILL_LYR)) map.removeLayer(FILL_LYR)
      if (map.getSource(FILL_SRC)) map.removeSource(FILL_SRC)
      addedRef.current = false
    }
  }, [map])

  useEffect(() => {
    if (!map || !addedRef.current) return
    const fillSrc = map.getSource(FILL_SRC) as GeoJSONSource | undefined
    fillSrc?.setData(buildFillFC(regionAggregates))
    const labelSrc = map.getSource(LABEL_SRC) as GeoJSONSource | undefined
    labelSrc?.setData(buildLabelFC(regionAggregates, iconScale))
  }, [map, regionAggregates, iconScale])

  useEffect(() => {
    if (!map || !map.getLayer(FILL_LYR)) return
    const v = visible ? 'visible' : 'none'
    map.setLayoutProperty(FILL_LYR, 'visibility', v)
    map.setLayoutProperty(LINE_LYR, 'visibility', v)
    map.setLayoutProperty(LABEL_LYR, 'visibility', v)
  }, [map, visible])

  return null
}
