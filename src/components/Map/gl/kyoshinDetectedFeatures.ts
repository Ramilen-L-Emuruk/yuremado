import type { FeatureCollection, Point } from 'geojson'
import { mercatorProps } from './screenDepth'
import type { DetectedPoint } from '../../../utils/kyoshinDetectionView'
import { kyoshinIndexToJma } from '../../../utils/kyoshinIntensity'
import type { IntensityGrade } from '../../../utils/measuredIntensity'
import { getScaleRadius } from '../../../utils/intensity'
import { kyoshinDetectedIconId, kyoshinDetectedSubZeroIconId, KYOSHIN_DETECTED_ICON_BASE_RADIUS } from './kyoshinDetectedIcons'

// 揺れ検知点マーカー（KyoshinDetectedPointsGL）の GeoJSON を組み立てる純粋関数。
// 描画そのものはコンポーネント側、「どの点をどのバッジで描くか」の判断はこちらに置く。

// 確信度別の半径ボーナス（通常震度点の半径 getScaleRadius(scale) に加算）。
// confirmed（確かな段）は unconfirmed（likely＝早い段）よりさらに大きく＋太めの白フチ
// （kyoshinDetectedIcons.ts）で、一目で「確定」と分かるようにする。
const CONFIRMED_RADIUS_BONUS = 6
const UNCONFIRMED_RADIUS_BONUS = 2

// 検知点1点の描画半径（Leaflet 版と同一ロジックを confidence 別ボーナスへ一般化）。
// 震度0は固定小半径、震度1以上は計測震度連動。
// 固定式 (bonus + 3) / 2 は bonus=2（likelyの旧confirmed相当）で旧固定値 2.5 と一致する。
function detectedRadius(jma: IntensityGrade, iconScale: number, bonus: number): number {
  return jma.label !== '0' ? (getScaleRadius(jma.scale) + bonus) * iconScale : ((bonus + 3) / 2) * iconScale
}

/** 震度0 未満の印の半径。震度0 のバッジ（`(bonus + 3) / 2`）より一回り小さくする */
function subZeroRadius(iconScale: number, bonus: number): number {
  return ((bonus + 3) / 2) * 0.7 * iconScale
}

/**
 * 点列 → バッジ feature 列。**欠測（インデックスが負）の点は描かない。**
 *
 * 震度0 未満（計測震度が 0.0 未満）の点は、文字なしの小さな淡い灰色の印で描く
 * （2026-10-29 ユーザー「すみません、地図に書かない決まりを撤回したいです。検知しているなら描画するべきだと思います」、
 * 同日ユーザー選択「文字なしの小さな印 (Recommended)」）。値が下がりきった点で地図が埋まらないよう、
 * 震度0 未満が続いた点は束の側で描く点から外してある（`kyoshinEnsembleTracker` の `drawnKeys`）。
 */
function buildFeatures(points: DetectedPoint[], iconScale: number, confirmed: boolean) {
  // アイコン ID 側は confirmed 以外を歴史的に `candidate` と呼ぶ（likely だけを想定していた頃の語。
  // kyoshinDetectedIcons.ts）。ここでの unconfirmed（likely）と同じものを指す。
  const bonus = confirmed ? CONFIRMED_RADIUS_BONUS : UNCONFIRMED_RADIUS_BONUS
  return points.flatMap((p) => {
    if (!(p.index >= 0)) return []
    const jma = kyoshinIndexToJma(p.index)
    const radius = jma ? detectedRadius(jma, iconScale, bonus) : subZeroRadius(iconScale, bonus)
    return [{
      type: 'Feature' as const,
      properties: {
        index: p.index,
        iconId: jma ? kyoshinDetectedIconId(jma.rank, confirmed) : kyoshinDetectedSubZeroIconId(confirmed),
        iconSizeRatio: radius / KYOSHIN_DETECTED_ICON_BASE_RADIUS,
        // 欠測ホールドで直前値を描いている点。レイヤー側が icon-opacity を落として
        // 「そこに点はあるが今は値が無い」と示す（utils/kyoshinMissingHold.ts）。
        stale: p.stale === true,
        // 同じ階級のバッジを画面の手前から並べるために持たせる（gl/screenDepth.ts）。
        ...mercatorProps(p.lng, p.lat),
      },
      geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] },
    }]
  })
}

/**
 * 検知点マーカーの GeoJSON を作る。
 *
 * 2 つの点列は**重複しない前提**（`deriveKyoshinView` が観測点キーの差集合として渡す）。
 * ここで座標を見て重複を弾くことはしない——同一座標に複数の実体がある観測点が実在するため
 * （`buildSiteIndex` 参照）、座標で弾くと別の観測点を取り違えて落としてしまう。
 *
 * @param confirmedPoints confirmed の描く点（`deriveKyoshinView` の `detectedPoints`）
 * @param unconfirmedPoints likely の全イベントの描く点（confirmed に属する点は除かれている）
 * @param iconScale 地図アイコン倍率
 */
export function buildDetectedFC(
  confirmedPoints: DetectedPoint[],
  unconfirmedPoints: DetectedPoint[],
  iconScale: number,
): FeatureCollection<Point> {
  return {
    type: 'FeatureCollection',
    features: [
      ...buildFeatures(confirmedPoints, iconScale, true),
      ...buildFeatures(unconfirmedPoints, iconScale, false),
    ],
  }
}
