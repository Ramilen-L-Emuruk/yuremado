// 緊急地震速報の取消の文字の塊を、カードのうち見えている範囲の真ん中へ置く計算（→ `cancelBlockOffset`）。
// 座標は画面の上端から。枠は 0〜600、塊の高さは 100。
import { describe, it, expect } from 'vitest'
import { cancelBlockOffset } from './cancelBlockOffset'

const VIEW = { viewTop: 0, viewBottom: 600 }
const BLOCK_H = 100
/** カード（幕）を top〜bottom に置いたときの、塊の上端の位置（ずらした後）。 */
function placedTop(top: number, bottom: number): number | null {
  const natural = (top + bottom) / 2 - BLOCK_H / 2
  const dy = cancelBlockOffset({ overlayTop: top, overlayBottom: bottom, ...VIEW, blockNaturalTop: natural, blockHeight: BLOCK_H })
  return dy === null ? null : natural + dy
}

describe('cancelBlockOffset', () => {
  // 正: 枠より高いカードが枠を埋めているときは、枠の真ん中。
  it('枠を埋めているカードでは枠の真ん中', () => {
    expect(placedTop(-700, 1100)).toBe(300 - 50)
  })

  // 正: 枠に収まって全体が見えているカードでは、カードの真ん中（ずらさない）。
  it('全体が見えているカードではカードの真ん中のまま', () => {
    expect(placedTop(8, 410)).toBe(209 - 50)
    expect(cancelBlockOffset({ overlayTop: 8, overlayBottom: 410, ...VIEW, blockNaturalTop: 159, blockHeight: BLOCK_H })).toBe(0)
  })

  // 正: 上が枠の外へ出ているカードでは、見えている部分（0〜260）の真ん中。
  it('上が隠れたカードでは、見えている部分の真ん中', () => {
    expect(placedTop(-142, 260)).toBe(130 - 50)
  })

  // 正: 下が枠の外へ出ているカードでも同じ（見えている部分 400〜600 の真ん中）。
  it('下が隠れたカードでは、見えている部分の真ん中', () => {
    expect(placedTop(400, 1500)).toBe(500 - 50)
  })

  // 安全弁: 見えている部分が塊より狭いときは、塊の上端を見えている部分の上端に合わせる
  // （真ん中に合わせると、先頭の「取消」が枠の外へ出る）。ただしカードの外へは出さない。
  it('見えている部分が塊より狭いときは、上端を揃え、カードの外へは出さない', () => {
    expect(placedTop(540, 2000)).toBe(540)
    expect(placedTop(-322, 80)).toBe(80 - BLOCK_H)
  })

  // 対照: カードが枠の外にあって重なりが無いときは、ずらさない（前の値のまま）。
  it('見えていないカードでは null', () => {
    expect(placedTop(700, 900)).toBeNull()
    expect(placedTop(-400, 0)).toBeNull()
  })
})
