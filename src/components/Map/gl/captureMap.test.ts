import { describe, it, expect } from 'vitest'
import { renderSizeFor } from './captureMap'

describe('renderSizeFor', () => {
  it('正: 出力の縦横比のまま、面積を画面の地図領域に揃えて描き、画素数は出力の幅に揃える', () => {
    // 16:9 のカード（地図 1600×700）を、967×900 の縦長の地図領域から撮る
    const r = renderSizeFor({ width: 1600, height: 700 }, { width: 967, height: 900 }, 1)
    expect(r.width / r.height).toBeCloseTo(1600 / 700, 2)
    expect((r.width * r.height) / (967 * 900)).toBeCloseTo(1, 2)
    expect(r.width * r.pixelRatio).toBeCloseTo(1600, 0)
  })

  it('対照: 端末の解像度は精細さだけに効き、描く寸法は変えない', () => {
    const a = renderSizeFor({ width: 1600, height: 700 }, { width: 929, height: 454 }, 1)
    const b = renderSizeFor({ width: 1600, height: 700 }, { width: 929, height: 454 }, 2)
    expect(b.width).toBe(a.width)
    expect(b.height).toBe(a.height)
    expect(b.pixelRatio).toBeCloseTo(a.pixelRatio * 2, 6)
  })

  it('安全弁: 重ねる精細さは 2 倍で止める（解像度 3 の端末でも画素を増やしすぎない）', () => {
    const r = renderSizeFor({ width: 1600, height: 700 }, { width: 929, height: 454 }, 3)
    expect(r.width * r.pixelRatio).toBeCloseTo(3200, 0)
  })

  it('安全弁: 画面の寸法が取れないときは出力寸法のまま描く', () => {
    expect(renderSizeFor({ width: 1600, height: 700 }, { width: 0, height: 0 }, 1)).toEqual({
      width: 1600,
      height: 700,
      pixelRatio: 1,
    })
  })
})
