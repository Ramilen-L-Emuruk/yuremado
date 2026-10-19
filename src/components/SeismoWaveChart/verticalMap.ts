// 波形の値を縦の位置へ写す関数。**線形と、対数に近い曲線の 2 つ。**
//
// 曲線を使うのは、地図の下端の公開観測点の段だけ（2026-10-19 ユーザー選択「縦を圧縮する (Recommended)」。問い
// 「遠い観測点が埋もれるのをどうしますか？（能登の本震で 16 段中 13 段が枠の 1 割未満）」）。縦の範囲を全段で揃える
// （`sharedScale.ts`）と、震源に近い観測点と遠い観測点の振幅が桁で違うので、線形のままでは遠い観測点が平らになる。

/**
 * 値を縦の位置へ写す。`scale` が縦の範囲（上端の値）で、**`|value| = scale` が 1**（枠の端）、0 が 0。符号は保つ。
 */
export type VerticalMap = (value: number, scale: number) => number

/** 線形（値に比例）。 */
export const LINEAR_VERTICAL: VerticalMap = (value, scale) => value / scale

/**
 * 対数に近い曲線（`log(1 + |v| / knee)`）。**`knee` より十分小さい値ではほぼ線形、大きい値では対数で潰れる。**
 * 大小の順と符号は保つ。`knee` が正の数でなければ線形へ戻す（0 で割ると全部の線が端へ張り付く）。
 */
export function compressedVertical(knee: number): VerticalMap {
  if (!Number.isFinite(knee) || !(knee > 0)) return LINEAR_VERTICAL
  return (value, scale) => {
    const top = Math.log1p(scale / knee)
    if (!(top > 0)) return value / scale
    return (Math.sign(value) * Math.log1p(Math.abs(value) / knee)) / top
  }
}
