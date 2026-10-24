// @vitest-environment jsdom
//
// 津波タブに電文の値を出す変更（2026-10-21 の棚卸し④の決定）をカードの描画で固定する。
//   - 実測のある区域でも到達状況のバッジを出す
//   - 予測だけの観測点の行・解除された区域名も押せる
//   - 取消・解除の表示中も原因地震の行を出す
//   - 前の等級を読めない解除区域は「解除」とだけ出す
//   - 予想波高・満潮時刻・沿岸への推定に「この報で動いた」印を付ける
//   - 別の地震の津波で置き換えたとき、前の地震も原因地震の行に並べる
//
// 時刻は `formatTimeMin` がローカル時刻で組むため、**オフセットを書かない表記**を使う（CI は TZ=UTC で回る）。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { TsunamiTab } from './index'
import type { JMATsunami, TsunamiArea, TsunamiObservation } from '../../types/earthquake'
import { NO_TSUNAMI_VALUE_MARKS, tideStationKey, type TsunamiValueMarks } from '../../utils/tsunami'
import { UPDATE_MARK_COLOR } from '../../utils/updateMark'

vi.mock('../../hooks/useTsunamiZones', () => ({
  useTsunamiZones: () => ({ 福島県: [[[36.9, 140.9], [37.9, 141.1]]], 宮城県: [[[37.8, 140.9], [38.9, 141.7]]] }),
}))
vi.mock('../../hooks/useTsunamiObsCoords', () => ({
  useTsunamiObsCoords: () => ({ 相馬: [37.83, 140.96], いわき市小名浜: [36.93, 140.9] }),
}))

afterEach(cleanup)

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = NoopResizeObserver as unknown as typeof ResizeObserver

const FUKUSHIMA: TsunamiArea = {
  code: '250', name: '福島県', grade: 'MajorWarning', immediate: false,
  firstHeight: { condition: '第１波の到達を確認' },
  maxHeight: { description: '6m', value: 6.0 },
  stations: [{ name: '相馬', code: '25001', arrivalTime: '2026-04-20T05:40:00', highTideDateTime: '2026-04-20T07:30:00' }],
}

function makeTsunami(over: Partial<JMATsunami> = {}): JMATsunami {
  return {
    kind: 'tsunami', id: 'test-tsunami-values', eventId: '20260420050000', time: '2026-04-20T05:30:00', cancelled: false,
    issue: { source: 'テスト', time: '2026-04-20T05:30:00', type: 'Focus' },
    areas: [FUKUSHIMA], observations: [],
    sourceEarthquakes: [{ hypocenterName: '福島県沖', magnitude: 7.3, arrivalTime: '2026-04-20T05:20:00' }],
    ...over,
  }
}

const observed: TsunamiObservation = {
  name: 'いわき市小名浜', districtCode: '250', districtName: '福島県', height: { value: 0.5, description: '0.5m' },
}

const renderTab = (tsunami: JMATsunami, marks: TsunamiValueMarks = NO_TSUNAMI_VALUE_MARKS, extra: Record<string, unknown> = {}) =>
  render(<TsunamiTab tsunamiValueMarks={marks} tsunamis={[tsunami]} isVisible {...extra} />)

describe('到達状況のバッジ', () => {
  // 正（2026-10-21 ユーザー選択「バッジも出す (Recommended)」）: 実測のある区域でもバッジを出す
  it('正: 実測のある区域でも到達状況のバッジを出す', () => {
    renderTab(makeTsunami({ observations: [observed] }))
    expect(screen.getByText('第1波到達')).toBeTruthy()
  })

  // 正（2026-10-21 ユーザー選択「表に無くてもバッジ」）: 区域でも表に無い語をそのままバッジにする
  it('正: 区域の到達状況が表に無い語でも、その文字でバッジにする（本文へ重ねない）', () => {
    renderTab(makeTsunami({ areas: [{ ...FUKUSHIMA, firstHeight: { condition: 'まだ無い語' } }] }))
    expect(screen.getAllByText('まだ無い語')).toHaveLength(1)
  })
})

describe('押せる行', () => {
  // 正（2026-10-21 ユーザー選択「押せるようにする (Recommended)」）: 予測だけの観測点の行も、座標があれば押せる
  it('正: 予測だけの観測点の行を押すと、その観測点へ寄る', () => {
    const onObservationClick = vi.fn()
    renderTab(makeTsunami(), NO_TSUNAMI_VALUE_MARKS, { onObservationClick })
    fireEvent.click(screen.getByText('相馬'))
    expect(onObservationClick).toHaveBeenCalledWith('相馬')
  })

  it('対照: 座標表に無い観測点の予測の行は押せない', () => {
    const onObservationClick = vi.fn()
    renderTab(makeTsunami({ areas: [{ ...FUKUSHIMA, stations: [{ name: '座標の無い港', code: '25009' }] }] }), NO_TSUNAMI_VALUE_MARKS, { onObservationClick })
    fireEvent.click(screen.getByText('座標の無い港'))
    expect(onObservationClick).not.toHaveBeenCalled()
  })

  // 正（2026-10-21 ユーザー選択「押すと寄る (Recommended)」）: 解除された区域名も押すと、その予報区の範囲へ寄る
  it('正: 解除された区域名を押すと、その予報区の範囲へ寄る', () => {
    const onFocusMap = vi.fn()
    renderTab(makeTsunami({ cancelledAreas: [{ code: '220', name: '宮城県', grade: 'Unknown', lastGrade: 'Watch', immediate: false }] }), NO_TSUNAMI_VALUE_MARKS, { onFocusMap })
    fireEvent.click(screen.getByText('宮城県'))
    expect(onFocusMap).toHaveBeenCalledWith([[37.8, 140.9], [38.9, 141.7]])
  })
})

describe('解除・取消の表示', () => {
  // 正（2026-10-21 ユーザー選択「「解除」とだけ出す」）: 前の等級を読めない解除区域も行を出す
  it('正: 前の等級を読めない解除区域は「解除」とだけ出す', () => {
    renderTab(makeTsunami({ cancelledAreas: [{ code: '220', name: '宮城県', grade: 'Unknown', immediate: false }] }))
    expect(screen.getByText('宮城県')).toBeTruthy()
    expect(screen.getAllByText('解除').length).toBeGreaterThanOrEqual(2) // 枠の帯と行
  })

  it('対照: 前の等級を読める解除区域は「〇〇を解除」と出す', () => {
    renderTab(makeTsunami({ cancelledAreas: [{ code: '220', name: '宮城県', grade: 'Unknown', lastGrade: 'Watch', immediate: false }] }))
    expect(screen.getByText('津波注意報を解除')).toBeTruthy()
  })

  // 正（2026-10-21 ユーザー選択「原因地震も出す (Recommended)」）: 取消・解除の表示中も原因地震の行を出す
  it('正: 解除の表示中も原因地震の行を出す', () => {
    const { container } = renderTab(makeTsunami({ cancelled: true, cancelReason: 'lifted', cancelledAt: new Date('2026-04-20T06:00:00Z') }))
    expect(container.textContent).toContain('震源: 福島県沖')
  })
})

describe('前の津波の原因地震', () => {
  // 正（2026-10-21 ユーザー選択「置き換え、前の地震も残す (Recommended)」・並べ方は 2026-10-24「同じ形で後に並べる」）
  it('正: 前の津波の原因地震を、今の報の原因地震のあとに同じ形で並べる', () => {
    const { container } = renderTab(makeTsunami({
      previousSourceEarthquakes: [{ hypocenterName: '八丈島東方沖', magnitude: 5.9, arrivalTime: '2026-04-20T05:00:00' }],
    }))
    const text = container.textContent ?? ''
    expect(text).toContain('八丈島東方沖　M5.9')
    expect(text.indexOf('福島県沖')).toBeLessThan(text.indexOf('八丈島東方沖'))
  })
})

describe('観測点以外の値の印', () => {
  it('正: 予想波高に印があれば、その高さの見出しに色を当て、区域の行に縦線を引く', () => {
    const marks: TsunamiValueMarks = { ...NO_TSUNAMI_VALUE_MARKS, forecastHeight: new Map([['250', { status: 'changed', fields: new Set() }]]) }
    renderTab(makeTsunami(), marks)
    const header = screen.getByText('6m') as HTMLElement
    expect(header.style.color).toBe(hexToRgb(UPDATE_MARK_COLOR.changed))
    const row = screen.getByText('福島県').closest('.border-b') as HTMLElement
    expect(row.style.borderLeft).toContain(hexToRgb(UPDATE_MARK_COLOR.changed))
  })

  it('対照: 印が無ければ見出しは等級の色のまま、縦線は透明', () => {
    renderTab(makeTsunami())
    const row = screen.getByText('福島県').closest('.border-b') as HTMLElement
    expect(row.style.borderLeft).toContain('transparent')
  })

  // 正（2026-10-21 ユーザー選択「時刻に色を付ける (Recommended)」）: 満潮時刻が動いたら時刻の文字だけに色を当てる
  it('正: 満潮時刻が動いた潮位観測点は、満潮の文字に色を当てる（行の縦線は付けない）', () => {
    const marks: TsunamiValueMarks = { ...NO_TSUNAMI_VALUE_MARKS, highTide: new Set([tideStationKey(FUKUSHIMA, FUKUSHIMA.stations![0])]) }
    renderTab(makeTsunami(), marks)
    const tide = screen.getByText('満潮 07:30') as HTMLElement
    expect(tide.style.color).toBe(hexToRgb(UPDATE_MARK_COLOR.changed))
  })

  // 正（2026-10-21 ユーザー選択「時刻も印も出す (Recommended)」・語は 2026-10-24「「最大波 23:26」」）
  it('正: 沿岸への推定の行に最大波の時刻を出し、動いた項目に色を当てる', () => {
    const marks: TsunamiValueMarks = {
      ...NO_TSUNAMI_VALUE_MARKS,
      estimation: new Map([['宮城県', { status: 'changed', fields: new Set(['maxHeightTime'] as const) }]]),
    }
    renderTab(makeTsunami({ estimations: [{ name: '宮城県', maxHeight: { description: '1m', value: 1 }, maxHeightDateTime: '2026-04-20T05:50:00' }] }), marks)
    const time = screen.getByText('最大波 05:50') as HTMLElement
    expect(time.style.color).toBe(hexToRgb(UPDATE_MARK_COLOR.changed))
    expect((screen.getByText('1m') as HTMLElement).style.color).toBe('')
  })
})

/** jsdom は色を `rgb(...)` へ直して返す。 */
function hexToRgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}
