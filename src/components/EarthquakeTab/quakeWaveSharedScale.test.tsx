// @vitest-environment jsdom
//
// 地震カードの公開観測点の段で、縦の範囲を揃えて圧縮すること（2026-10-19 ユーザー選択「揃えて圧縮する (推奨)」。
// 問い「① 地震カードの公開観測点の段も、縦を揃えますか？（いまは段ごとの線形。詳細の窓は 1 観測点ずつなのでどの案でも今のまま）」）。
//
// 描画そのもの（Canvas）は差し替え、**どの範囲と曲線で描かせたか**だけを見る。

import { act, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { QuakeSeismoWave } from './QuakeSeismoWave'
import type { SeismoQuakeWave } from '../../hooks/useSeismoQuakeWaves'
import { paintCompositeColumns, paintWaveColumns, type PaintableColumns } from '../SeismoWaveChart/paintWave'
import { COMPRESSED_VERTICAL_NOTE, LINEAR_VERTICAL, type VerticalMap } from '../SeismoWaveChart/verticalMap'
import { PUBLIC_WAVE_UNIT, SEISMO_WAVE_UNIT, type WaveUnit } from '../SeismoWaveChart/waveUnit'
import type { WaveHistoryColumn } from '../../services/seismoWaveHistory'

vi.mock('../SeismoWaveChart/paintWave', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../SeismoWaveChart/paintWave')>()
  return { ...orig, paintCompositeColumns: vi.fn(), paintWaveColumns: vi.fn() }
})

const composite = vi.mocked(paintCompositeColumns)
const overlay = vi.mocked(paintWaveColumns)

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = NoopResizeObserver as unknown as typeof ResizeObserver

const ZERO_MS = Date.UTC(2026, 9, 19, 3, 0, 0)

/** 1 秒 × 120 列。0 の手前 60 秒は静か、後ろ 60 秒は振れ幅 `peak`。 */
function columnsOf(peak: number, withComposite: boolean): readonly WaveHistoryColumn[] {
  return Array.from({ length: 120 }, (_, i) => {
    const v = i < 60 ? 0.05 : peak
    return {
      min: [-v, -v, -v],
      max: [v, v, v],
      minMembers: 2,
      magMin: withComposite ? 0 : NaN,
      magMax: withComposite ? v : NaN,
      magSum: withComposite ? v : NaN,
      magCount: withComposite ? 1 : 0,
    }
  })
}

function waveOf(stationId: string, peak: number, unit: WaveUnit, withComposite = true): SeismoQuakeWave {
  return {
    stationId,
    displayName: stationId,
    columns: { fromMs: ZERO_MS - 60_000, columnSpanMs: 1000, columns: columnsOf(peak, withComposite) },
    arrival: null,
    axisZero: { kind: 'minute', ms: ZERO_MS },
    reach: null,
    interrupted: false,
    complete: true,
    intensity: null,
    distanceKm: null,
    samples: { kind: 'held', columns: [] } as unknown as SeismoQuakeWave['samples'],
    unit,
  }
}

interface Painted {
  readonly scale: number
  readonly vertical: VerticalMap
}

function lastOf<T>(items: readonly T[]): T | undefined {
  return items.length === 0 ? undefined : items[items.length - 1]
}

/** 段（canvas）ごとの最後の描き方。合成は `minScale`、3 成分は列の `scaleGal` を範囲として読む。 */
function lastPaintedBy(container: HTMLElement): Painted[] {
  const canvases = [...container.querySelectorAll('canvas')]
  return canvases.map((canvas) => {
    const c = lastOf(composite.mock.calls.filter((call) => call[0] === canvas))
    const o = lastOf(overlay.mock.calls.filter((call) => call[0] === canvas))
    // どちらで描いたかは、最後に呼ばれた側（テストごとに表示の設定を 1 つに決めている）。
    if (c !== undefined) return { scale: c[3].minScale, vertical: c[3].vertical }
    if (o === undefined) throw new Error('段が描かれていない')
    const built = o[1](100) as PaintableColumns
    return { scale: built.scaleGal, vertical: o[3].vertical }
  })
}

function renderCard(waves: readonly SeismoQuakeWave[], view: 'composite' | 'overlay') {
  composite.mockReset()
  overlay.mockReset()
  composite.mockImplementation((_canvas, build) => {
    build(100)
    return '0〜1 μm/s'
  })
  overlay.mockImplementation((_canvas, build) => {
    build(100)
    return '±1 μm/s'
  })
  let result: ReturnType<typeof render> | null = null
  act(() => {
    result = render(<QuakeSeismoWave waves={waves} quakeLabel="テストの地震" view={view} />)
  })
  return result as unknown as ReturnType<typeof render>
}

describe('地震カードの公開観測点の縦の範囲', () => {
  // 正: 公開観測点の段どうしは大きいほうの範囲で揃い、縦は曲線で圧縮される（合成の段）。
  it('合成の段は大きいほうの範囲に揃え、曲線で描く', () => {
    const { container } = renderCard([waveOf('NEAR', 100, PUBLIC_WAVE_UNIT), waveOf('FAR', 2, PUBLIC_WAVE_UNIT)], 'composite')
    const [near, far] = lastPaintedBy(container)
    expect(far.scale).toBeCloseTo(near.scale)
    expect(near.scale).toBeGreaterThanOrEqual(100)
    expect(far.vertical).not.toBe(LINEAR_VERTICAL)
    // 小さい値が線形より高く出る（遠い観測点が平らにならない）。
    expect(far.vertical(2, far.scale)).toBeGreaterThan(2 / far.scale)
  })

  // 正: 3 成分を重ねる段も、揃えた範囲で描く。
  it('3 成分の段も大きいほうの範囲に揃える', () => {
    const { container } = renderCard([waveOf('NEAR', 100, PUBLIC_WAVE_UNIT), waveOf('FAR', 2, PUBLIC_WAVE_UNIT)], 'overlay')
    const [near, far] = lastPaintedBy(container)
    expect(far.scale).toBeCloseTo(near.scale)
    expect(near.scale).toBeGreaterThanOrEqual(100)
  })

  // 対照: 自作地震計の段は揃えず、線形のまま（公開観測点の大きな範囲に引きずられない）。
  it('自作地震計の段は揃えず線形で描く', () => {
    const { container } = renderCard([waveOf('HOME', 1, SEISMO_WAVE_UNIT), waveOf('NEAR', 100, PUBLIC_WAVE_UNIT)], 'composite')
    const [home, near] = lastPaintedBy(container)
    expect(home.vertical).toBe(LINEAR_VERTICAL)
    expect(home.scale).toBeLessThan(near.scale)
  })

  // 安全弁: 段が外れたら帳面から外し、残った段は自分の範囲へ戻る（いない段の範囲で縛り続けない）。
  it('外れた段の範囲で残りの段を縛らない', () => {
    const view = 'composite'
    const { container, rerender } = renderCard([waveOf('NEAR', 100, PUBLIC_WAVE_UNIT), waveOf('FAR', 2, PUBLIC_WAVE_UNIT)], view)
    act(() => {
      rerender(<QuakeSeismoWave waves={[waveOf('FAR', 2, PUBLIC_WAVE_UNIT)]} quakeLabel="テストの地震" view={view} />)
    })
    const [far] = lastPaintedBy(container)
    expect(far.scale).toBeLessThan(100)
  })

  // 安全弁: 書き込みが往復し続けない（自分の値は揃える前の値なので、揃った後の描き直しでは変わらない）。
  it('揃うまでの描き直しは数回で止まる', () => {
    renderCard([waveOf('A', 100, PUBLIC_WAVE_UNIT), waveOf('B', 20, PUBLIC_WAVE_UNIT), waveOf('C', 2, PUBLIC_WAVE_UNIT)], 'composite')
    expect(composite.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(composite.mock.calls.length).toBeLessThanOrEqual(9)
  })

  // 安全弁: 列を組まなかった描き直し（2D の描画文脈を取れなかった）では帳面から外れず、他の段の範囲を保つ。
  it('列を組まなかった描き直しでは帳面から外れない', () => {
    const waves = [waveOf('NEAR', 100, PUBLIC_WAVE_UNIT), waveOf('FAR', 2, PUBLIC_WAVE_UNIT)]
    const { container, rerender } = renderCard(waves, 'composite')
    const nearCanvas = container.querySelectorAll('canvas')[0]
    // NEAR の段だけ、組まずに戻る描き直しにする（列を伸ばして描き直させる）。
    composite.mockImplementation((canvas, build) => {
      if (canvas !== nearCanvas) build(100)
      return null
    })
    act(() => {
      rerender(<QuakeSeismoWave waves={[waveOf('NEAR', 100, PUBLIC_WAVE_UNIT), waves[1]]} quakeLabel="テストの地震" view="composite" />)
    })
    const [, far] = lastPaintedBy(container)
    expect(far.scale).toBeGreaterThanOrEqual(100)
  })

  // 縦を圧縮している段だけ、範囲の字にホバーの一言を添える。
  it('ホバーの一言は公開観測点の段だけに付く', () => {
    const { container } = renderCard([waveOf('HOME', 1, SEISMO_WAVE_UNIT), waveOf('NEAR', 100, PUBLIC_WAVE_UNIT)], 'composite')
    const titled = [...container.querySelectorAll('span.font-mono')].map((el) => el.getAttribute('title'))
    expect(titled).toEqual([null, COMPRESSED_VERTICAL_NOTE])
  })
})
