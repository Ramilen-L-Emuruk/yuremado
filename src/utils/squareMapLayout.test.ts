import { describe, expect, it } from 'vitest'
import { squareMapLayout } from './squareMapLayout'

// 375×812 の器。つまみ 20px と下のナビ約 57px を合わせて otherHeight 77px、波形の 1 段 77px（公開観測点を畳んだ段）。
const BASE = {
  containerWidth: 375, containerHeight: 812, otherHeight: 77, leadRowHeight: 77,
  panelRatio: 0.45, adjustedWhileWave: false, minPanelRatio: 0.2,
}
const CAP_PX = 812 - 77 - 375 - 77
const NOT_BORROWING = { panelRatio: 0.45, mapMinHeight: 0, waveHidden: false, borrowing: false }

describe('squareMapLayout', () => {
  it('正: 波形が出たら、地図の正方形と波形の 1 段が入るまでパネルを縮める', () => {
    const r = squareMapLayout(BASE)
    expect(r.panelRatio * 812).toBeCloseTo(CAP_PX)
    expect(r.mapMinHeight).toBeCloseTo(375)
    expect(r.waveHidden).toBe(false)
  })

  it('対照: 波形が出ていなければ、利用者の比率のまま地図に下限を置かない', () => {
    expect(squareMapLayout({ ...BASE, leadRowHeight: null })).toEqual(NOT_BORROWING)
  })

  it('対照: パネルが既に十分小さければ比率は変えない（広げもしない）', () => {
    const r = squareMapLayout({ ...BASE, panelRatio: 0.25 })
    expect(r.panelRatio).toBe(0.25)
    expect(r.mapMinHeight).toBe(375)
    expect(r.waveHidden).toBe(false)
  })

  it('対照: 折りたたみ中（0）は 0 のまま', () => {
    const r = squareMapLayout({ ...BASE, panelRatio: 0 })
    expect(r.panelRatio).toBe(0)
    expect(r.mapMinHeight).toBe(375)
  })

  it('正: 波形が出ている間につまみで上限より広げたら、その比率を使い、波形を隠して地図の正方形は残す', () => {
    const r = squareMapLayout({ ...BASE, panelRatio: 0.42, adjustedWhileWave: true })
    expect(r.panelRatio).toBe(0.42)
    expect(r.waveHidden).toBe(true)
    expect(r.mapMinHeight).toBe(375)
  })

  it('正: さらに広げて正方形が入らなくなったら、地図は残りの高さまで縮む', () => {
    const r = squareMapLayout({ ...BASE, panelRatio: 0.8, adjustedWhileWave: true })
    expect(r.waveHidden).toBe(true)
    expect(r.mapMinHeight).toBeCloseTo(812 - 77 - 0.8 * 812)
  })

  it('対照: つまみで上限より下へ動かしたら、波形は隠さない（1 段より多く見える）', () => {
    const r = squareMapLayout({ ...BASE, panelRatio: 0.25, adjustedWhileWave: true })
    expect(r.panelRatio).toBe(0.25)
    expect(r.waveHidden).toBe(false)
  })

  it('対照: つまみで動かした後に折りたたんでも、波形は隠さない', () => {
    const r = squareMapLayout({ ...BASE, panelRatio: 0, adjustedWhileWave: true })
    expect(r.waveHidden).toBe(false)
    expect(r.mapMinHeight).toBe(375)
  })

  it('安全弁: 上限ちょうど（端数の誤差）では波形を隠さない', () => {
    const r = squareMapLayout({ ...BASE, panelRatio: CAP_PX / 812 + 1e-9, adjustedWhileWave: true })
    expect(r.waveHidden).toBe(false)
  })

  it('安全弁: 背の低い画面でもパネルは下限より縮めず、波形の 1 段を残して地図が正方形を割る', () => {
    const r = squareMapLayout({ ...BASE, containerHeight: 560 })
    expect(r.panelRatio).toBe(0.2)
    expect(r.mapMinHeight).toBeCloseTo(560 - 77 - 112 - 77)
    expect(r.mapMinHeight).toBeLessThan(375)
    expect(r.waveHidden).toBe(false)
  })

  it('安全弁: 寸法が読めないときは何も借りない', () => {
    expect(squareMapLayout({ ...BASE, containerWidth: 0 })).toEqual(NOT_BORROWING)
    expect(squareMapLayout({ ...BASE, leadRowHeight: Number.NaN })).toEqual(NOT_BORROWING)
  })

  it('対照: 左右分割（地図の列とパネルが横に並び、引くと負になる）では何も借りない', () => {
    expect(squareMapLayout({ ...BASE, containerWidth: 812, containerHeight: 375, otherHeight: -375 })).toEqual(NOT_BORROWING)
  })
})
