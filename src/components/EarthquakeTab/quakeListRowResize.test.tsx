// @vitest-environment jsdom
//
// 閉じた行の「入らないときだけ段を下げる」測り方（QuakeListRow）。
//
// 段を下げると行の高さが変わり、幅の見張りがもう一度鳴る。そこで段を戻すと、入らずにまた下げ、
// 毎フレーム往復して行が震える（実機の 390px で、1 行が 2 秒に 160 回描き直されていた）。
// **段を戻すのは幅か中身が変わったときだけ**であることを固定する。jsdom は ResizeObserver も
// 寸法も持たないので、どちらも差し替える。
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, act } from '@testing-library/react'
import { QuakeListRow, type QuakeListRowProps } from './QuakeListRow'

type RoCallback = (entries: { contentRect: { width: number } }[]) => void

let observed: RoCallback | null = null
/** 中身の幅。枠（100）より広ければ入らない。 */
let contentWidth = 200

beforeEach(() => {
  observed = null
  contentWidth = 200
  vi.stubGlobal('ResizeObserver', class {
    constructor(cb: RoCallback) { observed = cb }
    observe() {}
    disconnect() {}
  })
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(() => contentWidth)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(100)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 300 } as DOMRect)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const baseProps: QuakeListRowProps = { lpgmTabbable: false,
  scale: 45, scaleLabel: '5弱', orAbove: false, lpgmClass: null,
  heading: <span>震源・震度情報</span>, chips: <span data-chip>訓練</span>,
  tsunami: { text: '津波の心配なし', color: '#fff' },
  time: '16:10', name: '石川県能登地方', magnitude: { text: 'M7.6', value: 7.6 }, depth: { text: '10km', value: 10 },
}

/** 札が 2 段目へ下がっているか（下げた札は別の段の要素へ移る）。 */
const chipsDropped = (c: HTMLElement) => c.querySelector('[data-chip]')?.closest('.row-start-2') !== null

describe('閉じた行の段の測り方', () => {
  it('入らなければ札を下げる', () => {
    const { container } = render(<QuakeListRow {...baseProps} />)
    expect(chipsDropped(container)).toBe(true)
  })

  // 正: 幅が同じまま鳴った見張り（段を下げて高さが変わった分）では、段を戻さない
  it('幅が変わらない見張りでは段を戻さない', () => {
    const { container } = render(<QuakeListRow {...baseProps} />)
    contentWidth = 50
    act(() => observed?.([{ contentRect: { width: 300 } }]))
    expect(chipsDropped(container)).toBe(true)
  })

  // 対照: 幅が変わったら一度戻して測り直す（広がって入るようになったら段を戻す）
  it('幅が変わって入るようになったら段を戻す', () => {
    const { container } = render(<QuakeListRow {...baseProps} />)
    contentWidth = 50
    act(() => observed?.([{ contentRect: { width: 360 } }]))
    expect(chipsDropped(container)).toBe(false)
  })

  it('幅が変わっても入らなければ下げたまま', () => {
    const { container } = render(<QuakeListRow {...baseProps} />)
    act(() => observed?.([{ contentRect: { width: 360 } }]))
    expect(chipsDropped(container)).toBe(true)
  })

  // 安全弁: 0.5px 未満の揺れ（小数の丸め）は幅の変化に数えない
  it('0.5px 未満の差は幅の変化に数えない', () => {
    const { container } = render(<QuakeListRow {...baseProps} />)
    contentWidth = 50
    act(() => observed?.([{ contentRect: { width: 300.3 } }]))
    expect(chipsDropped(container)).toBe(true)
  })

  // 正: 続報で中身が短くなって入るようになったら、幅が同じでも段を戻す
  it('中身が変わって入るようになったら段を戻す', () => {
    const { container, rerender } = render(<QuakeListRow {...baseProps} />)
    contentWidth = 50
    rerender(<QuakeListRow {...baseProps} name="能登半島沖" />)
    expect(chipsDropped(container)).toBe(false)
  })

  // 安全弁: 同じ中身での描き直し（親の更新）では段を戻さない
  it('同じ中身の描き直しでは段を戻さない', () => {
    const { container, rerender } = render(<QuakeListRow {...baseProps} />)
    contentWidth = 50
    rerender(<QuakeListRow {...baseProps} heading={<span>震源・震度情報</span>} chips={<span data-chip>訓練</span>} />)
    expect(chipsDropped(container)).toBe(true)
  })
})
