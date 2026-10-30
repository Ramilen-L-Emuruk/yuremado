import { useEffect, useRef } from 'react'
import { frontSortKeyExpression, mercatorProps } from './gl/screenDepth'
import type { GeoJSONSource, MapGeoJSONFeature } from 'maplibre-gl'
import type { Feature, FeatureCollection, Point, Polygon } from 'geojson'
import { useMapGL } from './mapGLContext'
import { getIntensityColor, getIntensityLabel, getIntensityLabelWithOrAbove, getScaleRadius } from '../../utils/intensity'
import { readableTextColor } from '../../utils/contrast'
import type { JMAQuakeCity } from '../../types/earthquake'
import type { RegionAggregate } from '../../hooks/useQuakeLayerData'
import { ringToLngLat } from './gl/geojson'
import { addOrderedLayer } from './gl/layerOrder'
import { registerPopupSource, type PopupHandle } from './gl/popupRegistry'
import { escapeHtml, popupCodeHtml } from './gl/popupHtml'
import { ensureIntensityIcons, intensityIconId, INTENSITY_ICON_BASE_RADIUS, UNRECEIVED_COLOR } from './gl/intensityIcons'

// 地震モードのズームアウト時、一次細分区域ごとの最大震度を塗る MapLibre 版
// （Leaflet 版 JapanMap の quake-region-fill ペイン＋区域中心マーカー相当）。
// 区域塗りは fill+line レイヤー、区域中心の震度ラベルは観測点（QuakeIntensityPointsGL）と同じ
// icon-image 方式で描く（gl/intensityIcons.ts の Canvas2D 事前ラスタライズ画像を共有）。
// クリックのみでポップアップを出す（ホバーは元々無し）。中身は区域名・最大震度と、市町村ごとの震度。

const FILL_SRC = 'quake-region-fill'
const FILL_LYR = 'quake-region-fill'
const LINE_LYR = 'quake-region-fill-line'
const LABEL_SRC = 'quake-region-label'
const LABEL_LYR = 'quake-region-label'
// バッジがそれほど小さくない（区域代表点は数十件程度）ため、当たり判定に少し余裕を持たせる。
const HIT_TOL_PX = 10

const EMPTY_FILL_FC: FeatureCollection<Polygon> = { type: 'FeatureCollection', features: [] }
const EMPTY_LABEL_FC: FeatureCollection<Point> = { type: 'FeatureCollection', features: [] }

interface Props {
  regionAggregates: RegionAggregate[]
  iconScale: number
  visible: boolean
}

// 各区域の全リングを、color/scale プロパティ付きの Polygon Feature 群にする。
// 弱い震度を先（下）、強い震度を後（上）に並べて前面に重ねる（regionAggregates は弱→強でソート済み）。
function buildFillFC(regions: RegionAggregate[]): FeatureCollection<Polygon> {
  const features: Feature<Polygon>[] = []
  for (const r of regions) {
    const color = getIntensityColor(r.scale)
    for (const ring of r.rings) {
      features.push({
        type: 'Feature',
        properties: { color, scale: r.scale },
        geometry: { type: 'Polygon', coordinates: [ringToLngLat(ring)] },
      })
    }
  }
  return { type: 'FeatureCollection', features }
}

// 区域中心の震度ラベル用 Point Feature 群。
// 旧 HTML Marker 版（buildIntensityBadgeEl）のサイズ比率 (getScaleRadius*2+8) を踏襲。
function buildLabelFC(regions: RegionAggregate[], iconScale: number): FeatureCollection<Point> {
  const features: Feature<Point>[] = regions.map((r) => ({
    type: 'Feature',
    properties: {
      iconId: intensityIconId(r.scale),
      iconSizeRatio: ((getScaleRadius(r.scale) + 4) * iconScale) / INTENSITY_ICON_BASE_RADIUS,
      scale: r.scale,
      name: r.name,
      code: r.code ?? '',
      // 同じ階級のバッジを画面の手前から並べるために持たせる（gl/screenDepth.ts）。
      ...mercatorProps(r.label[1], r.label[0]),
    },
    geometry: { type: 'Point', coordinates: [r.label[1], r.label[0]] },
  }))
  return { type: 'FeatureCollection', features }
}

/** 吹き出しに並べる市町村の数。超えた分は「ほか N 市町村」の行で件数だけ伝える。 */
export const POPUP_CITY_LIMIT = 8

/**
 * 区域の吹き出しに足す、市町村ごとの震度の行（2026-10-22 ユーザー選択「市町村ごとの震度も添える (Recommended)」、
 * 文面は 2026-10-25「A の案でよい (Recommended)」）。震源の吹き出しの都道府県の行と同じ作りにする。
 *
 * - 並びは震度の高い順。同じ震度なら観測できた市町村を先に、その中は電文の順（気象庁の標準順）
 * - 上限は {@link POPUP_CITY_LIMIT}。超えた分は「ほか N 市町村」にまとめる
 * - 市町村の震度が無い報（震度速報・標準版）は空文字を返し、吹き出しは区域名と最大震度の 2 行のまま
 */
export function regionCityRowsHtml(cities: readonly JMAQuakeCity[]): string {
  if (cities.length === 0) return ''
  const sorted = cities
    .map((c, i) => ({ c, i }))
    .sort((a, b) =>
      b.c.scale - a.c.scale
      || Number(a.c.unreceived === true) - Number(b.c.unreceived === true)
      || a.i - b.i)
    .map(({ c }) => c)
  const omitted = sorted.length - POPUP_CITY_LIMIT
  const rows = sorted
    .slice(0, POPUP_CITY_LIMIT)
    .map((c) => {
      // 値が入っていない市町村は震度階級色を借りず、語も断定しない（震源の吹き出しと同じ。→ quake-spec.md §4）。
      const color = c.unreceived ? UNRECEIVED_COLOR : getIntensityColor(c.scale)
      const label = getIntensityLabelWithOrAbove(c.scale, c.unreceived === true)
      const mark = c.hasUnreceived && !c.unreceived
        ? `<span style="font-size:10px;font-weight:700;color:${UNRECEIVED_COLOR}">未入電あり</span>`
        : ''
      return (
        `<div style="display:flex;align-items:center;gap:8px;font-size:12px">` +
        `<span style="display:inline-block;min-width:20px;padding:0 3px;text-align:center;font-weight:700;border-radius:3px;` +
        `color:${readableTextColor(color)};font-size:10px;background:${color}">${escapeHtml(label)}</span>` +
        `<span style="color:#cbd5e1">${escapeHtml(c.name)}</span>${mark}` +
        (c.code ? `<span style="margin-left:auto;font-size:10px;color:#64748b">コード ${escapeHtml(c.code)}</span>` : '') +
        `</div>`
      )
    })
    .join('')
  const more = omitted > 0 ? `<div style="font-size:12px;color:#cbd5e1">ほか ${omitted} 市町村</div>` : ''
  return `<div style="margin-top:8px;display:flex;flex-direction:column;gap:2px">${rows}${more}</div>`
}

function clickHtml(f: MapGeoJSONFeature, citiesByRegion: ReadonlyMap<string, readonly JMAQuakeCity[]>): string {
  const scale = Number(f.properties?.scale ?? -1)
  const name = String(f.properties?.name ?? '')
  return (
    `<div class="text-sm" style="min-width:160px"><div class="font-bold">${escapeHtml(name)}</div>` +
    `<div class="text-xs" style="color:#94a3b8">最大震度 ${escapeHtml(getIntensityLabel(scale))}</div>` +
    regionCityRowsHtml(citiesByRegion.get(name) ?? []) +
    popupCodeHtml(String(f.properties?.code ?? '') || undefined) +
    `</div>`
  )
}

export function QuakeRegionFillGL({ regionAggregates, iconScale, visible }: Props) {
  const map = useMapGL()
  const addedRef = useRef(false)
  const popupRef = useRef<PopupHandle | null>(null)
  // 吹き出しの登録は [map] 依存で 1 回だけなので、市町村は ref 越しに最新を読む。
  const citiesByRegionRef = useRef<ReadonlyMap<string, readonly JMAQuakeCity[]>>(new Map())
  citiesByRegionRef.current = new Map(regionAggregates.map((r) => [r.name, r.cities]))

  // fill + line + ラベル用レイヤーを一度だけ作る。
  useEffect(() => {
    if (!map) return
    ensureIntensityIcons(map)
    map.addSource(FILL_SRC, { type: 'geojson', data: EMPTY_FILL_FC })
    addOrderedLayer(map, {
      id: FILL_LYR,
      type: 'fill',
      source: FILL_SRC,
      layout: { visibility: visible ? 'visible' : 'none' },
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.5 },
    })
    // 枠線（Leaflet の weight1・塗りと同色）。MAP_LAYER_ORDER 上で fill の直上に入る。
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
        'symbol-sort-key': frontSortKeyExpression('scale', 0),
        visibility: visible ? 'visible' : 'none',
      },
    })
    popupRef.current = registerPopupSource(map, {
      layerId: LABEL_LYR,
      priority: 'point',
      tolPx: HIT_TOL_PX,
      rankKey: 'scale',
      buildClickHtml: (f) => clickHtml(f, citiesByRegionRef.current),
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

  // データ／倍率変化: 塗り・ラベルを差し替え。
  useEffect(() => {
    if (!map || !addedRef.current) return
    const fillSrc = map.getSource(FILL_SRC) as GeoJSONSource | undefined
    fillSrc?.setData(buildFillFC(regionAggregates))
    const labelSrc = map.getSource(LABEL_SRC) as GeoJSONSource | undefined
    labelSrc?.setData(buildLabelFC(regionAggregates, iconScale))
  }, [map, regionAggregates, iconScale])

  // 表示切替（fill/line/ラベル レイヤー）。
  useEffect(() => {
    if (!map || !map.getLayer(FILL_LYR)) return
    const v = visible ? 'visible' : 'none'
    map.setLayoutProperty(FILL_LYR, 'visibility', v)
    map.setLayoutProperty(LINE_LYR, 'visibility', v)
    map.setLayoutProperty(LABEL_LYR, 'visibility', v)
  }, [map, visible])

  return null
}
