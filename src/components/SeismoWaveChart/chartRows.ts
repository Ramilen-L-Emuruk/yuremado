/**
 * 地図の下の波形の枠が、実際に段を 1 つ以上描くか。
 *
 * **枠を出すかどうかを決めるのはここ 1 箇所。** 「波形を出す」と判定していても（設定が「常に表示」・
 * 緊急地震速報や揺れの検知で自動表示）、積む段が 0 なら枠は何も描かない（`SeismoWaveChart` が `null` を返す）。
 * 呼び出し側がこれと別の条件で「枠が出ている」と読むと、地図の高さが削れていないのに削れた前提で動く
 * （特別情報の帯の下端の余白を外してしまう等）。
 *
 * @param stations 段にする自作地震計の観測点（出さないなら空）
 * @param publicWaves 公開観測点の波形（出さないなら `null`）
 */
export function hasWaveChartRows(
  stations: readonly unknown[],
  publicWaves: { readonly stations: readonly unknown[] } | null,
): boolean {
  return stations.length > 0 || (publicWaves !== null && publicWaves.stations.length > 0)
}
