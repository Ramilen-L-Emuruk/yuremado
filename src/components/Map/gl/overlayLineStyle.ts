// 地図に重ねる線（活断層・プレート境界）の配色。
//
// **描画（`ActiveFaultsGL` / `PlateBoundariesGL`）と凡例（`MapLegend`）で同じ値を使うために
// ここへ置く。** 色だけを持つモジュールにしているのは、凡例の組み立てをテストから直接呼ぶため
// （描画コンポーネントを読み込むと React と MapLibre まで引き込む）。

/** 活断層。 */
export const FAULT_COLOR = '#96421f'

/** プレート境界のうち沈み込み帯（SUB）。 */
export const SUBDUCTION_COLOR = '#b91c1c'

/** プレート境界のうち沈み込み帯以外の収束境界（OCB・CCB）。 */
export const PLATE_CONVERGENT_COLOR = '#c2410c'

/** プレート境界のうち拡大軸とリフト（OSR・CRB）。 */
export const PLATE_DIVERGENT_COLOR = '#15803d'

/** プレート境界のうちトランスフォーム断層（OTF・CTF）。 */
export const PLATE_TRANSFORM_COLOR = '#1d4ed8'
