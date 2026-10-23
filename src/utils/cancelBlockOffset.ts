/**
 * カードのうち見えている範囲の真ん中へ、取消の文字の塊を置くためのずらし量（px）を決める。
 *
 * 座標はどれも画面の上端からの位置。塊はふだん幕の縦の真ん中（`blockNaturalTop`）にあり、
 * そこからどれだけ下へずらすかを返す（上なら負）。
 *
 * - 見えている範囲 ＝ カード（の幕）と枠の重なり。その真ん中に塊の真ん中を合わせる
 * - **見えている範囲が塊より狭いときは、塊の上端を見えている範囲の上端に合わせる** —— 真ん中に
 *   合わせると、塊の先頭にある「取消」の文字が枠の外へ出る
 * - どの場合も塊は幕（カード）の外へは出さない
 * - カードが枠の外にあって重なりが無いときは `null`（ずらす相手が見えていない。前の値のままでよい）
 */
export function cancelBlockOffset(input: {
  overlayTop: number
  overlayBottom: number
  viewTop: number
  viewBottom: number
  blockNaturalTop: number
  blockHeight: number
}): number | null {
  const { overlayTop, overlayBottom, viewTop, viewBottom, blockNaturalTop, blockHeight } = input
  const visibleTop = Math.max(overlayTop, viewTop)
  const visibleBottom = Math.min(overlayBottom, viewBottom)
  if (visibleBottom <= visibleTop) return null
  const wanted = visibleBottom - visibleTop >= blockHeight
    ? (visibleTop + visibleBottom) / 2 - blockHeight / 2
    : visibleTop
  const clamped = Math.min(Math.max(wanted, overlayTop), Math.max(overlayTop, overlayBottom - blockHeight))
  return clamped - blockNaturalTop
}
