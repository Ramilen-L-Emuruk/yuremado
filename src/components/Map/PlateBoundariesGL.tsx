import { useEffect, useRef } from 'react'
import type { ExpressionSpecification } from 'maplibre-gl'
import { useMapGL } from './mapGLContext'
import { PLATE_BOUNDARY_CLASSES, type PlateBoundaryClass, type PlateBoundarySegment } from '../../utils/plateBoundaries'
import { segmentsToMultiLineFC } from './gl/geojson'
import { registerPopupSource, type PopupHandle } from './gl/popupRegistry'
import { twoLinePopupHtml } from './gl/popupHtml'
import { addOrderedLayer } from './gl/layerOrder'
import {
  OVERLAY_LINE_SRC,
  dropOverlayLines,
  overlayLineKindFilter,
  putOverlayLines,
  type OverlayLineProps,
} from './gl/overlayLineSource'
import {
  SUBDUCTION_COLOR,
  PLATE_CONVERGENT_COLOR,
  PLATE_DIVERGENT_COLOR,
  PLATE_TRANSFORM_COLOR,
} from './gl/overlayLineStyle'

// 全球のプレート境界線（PB2002モデル）を描画する MapLibre 版（Leaflet の PlateBoundariesLayer 相当）。
// セグメント1件=MultiLineString feature 1件にまとめ、1枚の line レイヤーで描く。原典の 7 分類を
// 4 系統の色に分けるため type を feature プロパティに持たせ、line-color を match 式で分岐する。
// 破線は Leaflet の dashArray '6 4'（px）相当を、MapLibre の線幅単位 dasharray で weight2 に合わせ [3,2]。
//
// geojson ソースは活断層線と共有する（gl/overlayLineSource.ts）。自分の分は `kind: 'plate'` で
// 区別し、レイヤー側は filter で拾う。

// 色は gl/overlayLineStyle.ts が単一情報源（凡例と共有する）。
const GROUP_COLOR = {
  subduction: SUBDUCTION_COLOR,
  convergent: PLATE_CONVERGENT_COLOR,
  divergent: PLATE_DIVERGENT_COLOR,
  transform: PLATE_TRANSFORM_COLOR,
} as const
/** `type`（7 分類）→ 系統の色。表に無い値もトランスフォームの色で描く（線そのものは消さない）。 */
const LINE_COLOR_EXPR = [
  'match',
  ['get', 'type'],
  ...(Object.keys(PLATE_BOUNDARY_CLASSES) as PlateBoundaryClass[]).flatMap((c) => [
    c,
    GROUP_COLOR[PLATE_BOUNDARY_CLASSES[c].group],
  ]),
  PLATE_TRANSFORM_COLOR,
] as unknown as ExpressionSpecification
// 線クリックの当たり判定許容（px）。旧 Leaflet の Canvas ヒットレンダラー tolerance:8 に揃える。
const HIT_TOL_PX = 8

const LYR = 'plate-boundaries'

interface Props {
  plateBoundaries: PlateBoundarySegment[] | null
  visible: boolean
}

export function PlateBoundariesGL({ plateBoundaries, visible }: Props) {
  const map = useMapGL()
  const popupRef = useRef<PopupHandle | null>(null)

  useEffect(() => {
    if (!map || !plateBoundaries) return
    const fc = segmentsToMultiLineFC(
      plateBoundaries,
      (seg): OverlayLineProps & { plateA: string; plateB: string; type: string } => ({
        kind: 'plate',
        plateA: seg.plateA,
        plateB: seg.plateB,
        type: seg.type,
      }),
    )
    putOverlayLines(map, 'plate', fc.features)
    // MAP_LAYER_ORDER に従い最下層付近（活断層より下）へ挿入する（追加順非依存）。
    addOrderedLayer(map, {
      id: LYR,
      type: 'line',
      source: OVERLAY_LINE_SRC,
      filter: overlayLineKindFilter('plate'),
      layout: {
        'line-join': 'round',
        // 破線端を丸に（旧 Leaflet SVG レンダラーの既定 line-cap:round に揃える）。
        'line-cap': 'round',
        visibility: visible ? 'visible' : 'none',
      },
      paint: {
        'line-color': LINE_COLOR_EXPR,
        'line-width': 2,
        'line-opacity': 0.55,
        'line-dasharray': [3, 2],
      },
    })
    popupRef.current = registerPopupSource(map, {
      layerId: LYR,
      priority: 'line',
      tolPx: HIT_TOL_PX,
      buildClickHtml: (f) => {
        const p = f.properties ?? {}
        const cls = PLATE_BOUNDARY_CLASSES[p.type as PlateBoundaryClass]
        return twoLinePopupHtml(
          `${p.plateA ?? ''} – ${p.plateB ?? ''}`,
          cls ? `プレート境界（${cls.label}・PB2002モデル）` : 'プレート境界（PB2002モデル）',
        )
      },
    })
    return () => {
      popupRef.current?.remove()
      popupRef.current = null
      // 共有ソースは自分のレイヤーを外してから降りる（参照が残っていると削除できない）。
      if (map.getLayer(LYR)) map.removeLayer(LYR)
      dropOverlayLines(map, 'plate')
    }
  }, [map, plateBoundaries])

  useEffect(() => {
    if (!map || !map.getLayer(LYR)) return
    map.setLayoutProperty(LYR, 'visibility', visible ? 'visible' : 'none')
  }, [map, visible, plateBoundaries])

  return null
}
