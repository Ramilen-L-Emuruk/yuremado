import { describe, expect, it } from 'vitest'
import { MAP_FLOOR_SHARE, waveStackLayout } from './waveStackLayout'

// 390×844 の端末を思い描いた器。つまみ 20px と下のナビ約 57px を合わせて otherHeight 77px、波形の 1 段 77px。
const H = 767
const BASE = { containerHeight: H, otherHeight: 77, leadRowHeight: 77, panelRatio: 0.3 }
// 地図と波形が止まるパネルの高さ（px）
const STOP_PANEL = H - 77 - MAP_FLOOR_SHARE * H - 77

describe('waveStackLayout', () => {
  it('正: 止まる所より低いパネルでは重ねず、地図は残りから波形の 1 段を引いた高さ', () => {
    const r = waveStackLayout(BASE)
    expect(r.overlap).toBe(0)
    expect(r.waveCovered).toBe(false)
    expect(r.mapMinHeight).toBeCloseTo(H - 77 - 0.3 * H - 77)
  })

  it('正: 止まる所より高く広げた分だけ重ね、地図の下限は止まった高さのまま', () => {
    const panelRatio = (STOP_PANEL + 40) / H
    const r = waveStackLayout({ ...BASE, panelRatio })
    expect(r.overlap).toBeCloseTo(40)
    expect(r.mapMinHeight).toBeCloseTo(MAP_FLOOR_SHARE * H)
    // 1 段（77px）より少なく重ねている間は、波形はまだ一部見えている
    expect(r.waveCovered).toBe(false)
  })

  it('正: 1 段ぶん以上重ねたら、波形は覆われたとみなす（絵を組まない）', () => {
    const r = waveStackLayout({ ...BASE, panelRatio: (STOP_PANEL + 77) / H })
    expect(r.waveCovered).toBe(true)
  })

  it('対照: 波形が出ていなければ重ねず、地図に下限を置かない', () => {
    expect(waveStackLayout({ ...BASE, leadRowHeight: null, panelRatio: 0.9 }))
      .toEqual({ mapMinHeight: 0, overlap: 0, waveCovered: false })
  })

  it('対照: 止まる所ちょうど（0.5px の遊びの内）では重ねない', () => {
    const r = waveStackLayout({ ...BASE, panelRatio: (STOP_PANEL + 0.4) / H })
    expect(r.overlap).toBe(0)
  })

  it('安全弁: 波形を覆い切った先は重ねず（覆うのは先頭の段まで）、地図が縮む', () => {
    const r = waveStackLayout({ ...BASE, panelRatio: (STOP_PANEL + 200) / H })
    expect(r.overlap).toBe(77)
    expect(r.mapMinHeight).toBeCloseTo(MAP_FLOOR_SHARE * H - (200 - 77), 0)
    expect(r.waveCovered).toBe(true)
  })

  it('安全弁: 背の低い器では止まる所が 0 になり、パネルの高さぶん最初から重ねる', () => {
    const r = waveStackLayout({ containerHeight: 220, otherHeight: 77, leadRowHeight: 77, panelRatio: 0.3 })
    expect(r.overlap).toBeCloseTo(66)
    expect(r.mapMinHeight).toBeCloseTo(220 - 77 - 77)
  })

  it('安全弁: 寸法が読めない（左右分割で otherHeight が負）ときは重ねない', () => {
    expect(waveStackLayout({ ...BASE, otherHeight: -10 }).overlap).toBe(0)
    expect(waveStackLayout({ ...BASE, containerHeight: 0 }).overlap).toBe(0)
  })
})
