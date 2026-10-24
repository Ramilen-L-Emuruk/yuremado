import { useEffect, useRef } from 'react'
import * as maplibregl from 'maplibre-gl'
import { useMapGL } from './mapGLContext'
import type { TsunamiMissingMarker } from '../../hooks/useTsunamiLayerData'
import { arrivalMetrics, popupOffset, ARRIVAL_RING_COLOR, ARRIVAL_OPACITY } from './gl/tsunamiArrivalMarker'
import { missingMarkMetrics } from './gl/tsunamiMissingMarker'
import { BADGE_SHADOW_BLUR, BADGE_SHADOW_COLOR } from './gl/tsunamiObsBar'
import { TSUNAMI_MISSING_COLOR } from '../../utils/tsunamiStyle'
import { overSuffixedHeight, observationFirstWaveText } from '../../utils/tsunami'
import { attachTsunamiMarkerPopup, type TsunamiMarkerPopup } from './gl/tsunamiMarkerPopup'

// 観測データが欠測となっている観測点の印を描画する。
//
// 到達確認マーカー（TsunamiArrivalMarkersGL）と対になるが、意味が違うので別の印にしてある
// （理由と寸法は `gl/tsunamiMissingMarker.ts` の冒頭）。差分更新・点滅・後始末の作りは
// 到達確認マーカーと揃えてある。

export function missingTooltipHtml(marker: TsunamiMissingMarker): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const lines = [`<div class="font-bold">${esc(marker.name)}</div>`]
  // 第1波の行は観測棒・到達確認の吹き出しと同じ形（「第1波 05:12 押し波」。2026-10-24 ユーザー選択「この形で揃える
  // (Recommended)」）。日時として読めない時刻は行ごと落とす（→ `observationFirstWaveText`）。
  const firstWave = observationFirstWaveText(marker)
  if (firstWave) {
    lines.push(`<div class="text-xs" style="color:#e5e7eb">${esc(firstWave)}</div>`)
  }
  // これまでに観測できた波高があれば出す。欠測になる前の値であることを添えないと、いまの波高だと読める。
  if (marker.height) {
    lines.push(`<div class="text-xs" style="color:#e5e7eb">これまでの最大波 ${esc(overSuffixedHeight(marker.height))}</div>`)
  }
  lines.push(`<div class="text-xs" style="color:${TSUNAMI_MISSING_COLOR}">欠測（観測データが得られていません）</div>`)
  return `<div class="text-sm">${lines.join('')}</div>`
}

// 既存 el の見た目だけ更新する。className の丸ごと代入は Marker がコンストラクタで付与する
// 'maplibregl-marker' クラスを消してしまうため、blink クラスは classList.toggle で足し引きする。
function updateMarkerEl(el: HTMLDivElement, marker: TsunamiMissingMarker, iconScale: number): void {
  const { ring, size } = arrivalMetrics(iconScale)
  const { length, thickness } = missingMarkMetrics(iconScale)
  // 寸法は毎回ここで書く（観測点名キーで既存マーカーを再利用するため、生成時だけの設定は
  // 倍率を変えたときに取り残される）。
  el.style.width = `${size}px`
  el.style.height = `${size}px`
  el.classList.toggle('tsunami-obs-blink', marker.blinking)
  // 丸そのものは内側の要素に描く（根の `opacity` は Marker が自前で管理するため）。
  // 中央の横棒はさらにその内側へ置く。
  el.innerHTML =
    `<div style="position:absolute;inset:0;box-sizing:border-box;border-radius:50%;` +
    `background:${TSUNAMI_MISSING_COLOR};border:${ring}px solid ${ARRIVAL_RING_COLOR};` +
    `box-shadow:0 0 ${BADGE_SHADOW_BLUR}px ${BADGE_SHADOW_COLOR};opacity:${ARRIVAL_OPACITY}">` +
    `<div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);` +
    `width:${length}px;height:${thickness}px;background:${ARRIVAL_RING_COLOR}"></div>` +
    `</div>`
}

export function buildMissingMarkerEl(marker: TsunamiMissingMarker, iconScale: number): HTMLDivElement {
  const el = document.createElement('div')
  // **`position` を書かないこと**（理由は `TsunamiArrivalMarkersGL.tsx` の同じ箇所）。
  // インラインで指定すると MapLibre の `position: absolute` を上書きし、マーカーが
  // DOM の並び順に下へ積み上がる。
  updateMarkerEl(el, marker, iconScale)
  return el
}

interface Props {
  markers: TsunamiMissingMarker[]
  /** 地図アイコンの倍率（設定値）。観測棒・到達確認マーカーと揃えて拡縮する。 */
  iconScale: number
}

interface MarkerEntry {
  marker: maplibregl.Marker
  popup: maplibregl.Popup
  el: HTMLDivElement
  data: TsunamiMissingMarker
  opener: TsunamiMarkerPopup
}

export function TsunamiMissingMarkersGL({ markers, iconScale }: Props) {
  const map = useMapGL()
  const entriesRef = useRef<Map<string, MarkerEntry>>(new Map())

  useEffect(() => {
    if (!map) return
    const entries = entriesRef.current
    const seen = new Set<string>()
    for (const m of markers) {
      seen.add(m.name)
      const existing = entries.get(m.name)
      if (existing) {
        updateMarkerEl(existing.el, m, iconScale)
        existing.data = m
        existing.popup.setHTML(missingTooltipHtml(m)).setOffset(popupOffset(iconScale))
        continue
      }
      const el = buildMissingMarkerEl(m, iconScale)
      const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat([m.lng, m.lat])
        .addTo(map)
      const popup = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
        offset: popupOffset(iconScale),
      }).setHTML(missingTooltipHtml(m))
      const entry: MarkerEntry = { marker, popup, el, data: m, opener: null as unknown as TsunamiMarkerPopup }
      entry.opener = attachTsunamiMarkerPopup(map, el, popup, m.name, 'missing', () => [entry.data.lng, entry.data.lat])
      entries.set(m.name, entry)
    }
    // 欠測が解けた・区域が減った等で消えたものを後始末する。
    for (const [name, entry] of entries) {
      if (seen.has(name)) continue
      entry.opener.dispose()
      entry.marker.remove()
      entries.delete(name)
    }
  }, [map, markers, iconScale])

  // アンマウント時に全マーカーを後始末する。
  useEffect(() => {
    const entries = entriesRef.current
    return () => {
      for (const entry of entries.values()) {
        entry.opener.dispose()
        entry.marker.remove()
      }
      entries.clear()
    }
  }, [map])

  return null
}
