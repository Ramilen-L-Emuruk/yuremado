// 縦積みレイアウト（スマホ縦など）で、地図の下に自作地震計・公開観測点の波形が出ている間の高さの配り方。
//
// 縦積みでは地図・波形・つまみ・パネルが 1 本の縦の列を分け合う。決まりは次のとおり
// （2026-11-04 ユーザー選択。不満の点は「閾値を超えたらいきなり見えなくなること。」「広げると波形が丸ごと消える」
// 「幅で決めていること自体」、案の原文は「いきなり消すんじゃなくてそこで止めてタブが覆い隠すようにしたら？」、
// 止まる所は「画面の高さの割合 (Recommended)」、波形が出たときは「それでよい (Recommended)」）。
//
// - **パネルはつまみの比率のまま。** 波形が出ても縮めない（保存した比率も、見せる比率も変えない）
// - パネルを広げると、まず地図が縮む（波形の先頭の段は縮めない）
// - 地図が器の高さの `MAP_FLOOR_SHARE` まで縮んだ所で、**地図と波形はそこで止まる**。
//   その先へ広げた分は、パネル（とつまみ）が下から波形の上へ重なって少しずつ覆う。覆い切ったら、その先は地図が縮む
//   （地図は覆わない。2026-11-04 ユーザー選択「覆い切った先は地図を縮める」）
// - 地図の大きさは幅では決めない（以前は地図を幅の正方形に保ち、上限を超えたら波形の枠ごと隠していた）
//
// 左右分割（`side`）では使わない —— パネルの高さも重なりも、呼び出し側の CSS が縦積みのときだけ効かせる。

/**
 * 地図が縮むのを止める高さ（器の高さに対する割合）。2026-11-04 ユーザー選択「3.5 割 (Recommended)」
 * （390×844 で地図は 268px で止まり、既定のパネル 45% では波形を覆わない。4 割だと既定でも波形の下 27px が覆われた）。
 */
export const MAP_FLOOR_SHARE = 0.35

export interface WaveStackLayoutInput {
  /** 地図・波形・つまみ・パネル・下のナビを縦に積む器の高さ（px）。パネルの比率はこの高さに掛かる。 */
  readonly containerHeight: number
  /** 器のうち地図の列とパネル以外が占める高さ（px。境目のつまみと下のナビ）。 */
  readonly otherHeight: number
  /** 波形の先頭の段の高さ（px）。**波形を出していないなら `null`**。 */
  readonly leadRowHeight: number | null
  /** 利用者が決めたパネルの比率（折りたたみ中は 0）。 */
  readonly panelRatio: number
}

export interface WaveStackLayout {
  /** 地図の高さの下限（px）。0 なら下限を置かない。波形の先頭の段を地図に押し出させないための値。 */
  readonly mapMinHeight: number
  /** つまみとパネルを上へ重ねる量（px）。0 なら重ねない。 */
  readonly overlap: number
  /** 波形の先頭の段まで、パネルに覆われて見えないか（覆われている間は絵を組まない）。 */
  readonly waveCovered: boolean
}

const NO_WAVE: WaveStackLayout = { mapMinHeight: 0, overlap: 0, waveCovered: false }

export function waveStackLayout(input: WaveStackLayoutInput): WaveStackLayout {
  const { containerHeight: h, otherHeight, leadRowHeight, panelRatio } = input
  // 波形が出ていない・寸法が読めないときは今までどおり（地図に下限を置かず、重ねない）。
  // `otherHeight` が負になるのは左右分割のとき（地図の列とパネルが横に並ぶので、器の高さから両方を引くと負になる）。
  if (
    leadRowHeight === null || !(h > 0) || !Number.isFinite(leadRowHeight)
    || !Number.isFinite(otherHeight) || otherHeight < 0 || !Number.isFinite(panelRatio)
  ) {
    return NO_WAVE
  }
  const row = Math.max(0, leadRowHeight)
  const panel = Math.max(0, panelRatio) * h
  // 地図と波形が止まる所。パネルがここより高くなった分は重ねる（背の低い画面では最初から重なる）
  const stopPanel = Math.max(0, h - otherHeight - MAP_FLOOR_SHARE * h - row)
  // 誤差で重ねたり戻したりを繰り返さないよう 0.5px の遊びを持たせる。**整数の px に丸める** —— 端数のまま CSS へ渡すと
  // ブラウザが丸めた量と ref へ足し戻す量がずれ、測り直すたびに `other` が端数ぶん変わって描き直しが往復する
  // **重ねるのは波形の先頭の段まで。** その先はパネルが場所を取り、地図そのものが縮む（2026-11-04 ユーザー選択
  // 「覆い切った先は地図を縮める」）。地図を覆うと、カメラの寄せ方も下端の帯・凡例・共有ボタンも覆われたことを知らない
  const overlap = panel - stopPanel > 0.5 ? Math.round(Math.min(panel - stopPanel, row)) : 0
  const laidPanel = panel - overlap
  return {
    mapMinHeight: Math.max(0, h - otherHeight - laidPanel - row),
    overlap,
    waveCovered: row > 0 && overlap >= row,
  }
}
