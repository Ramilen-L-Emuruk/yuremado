// @vitest-environment jsdom
//
// 吹き出しを収める範囲。地図の上に乗る凡例は、隣のパネルの下に隠れないよう、`data-tip-bounds` を持つ枠
// （地図の領域）の右端までに収める。枠が無ければ今までどおり画面全体（正・対照）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DescriptionTip } from './index'

const rect = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) })

beforeEach(() => {
  vi.stubGlobal('innerWidth', 1280)
  vi.stubGlobal('innerHeight', 900)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    // 枠は画面の左 300px。基準のラベルは枠の右寄り（x=200）に居る
    if (this.hasAttribute('data-tip-bounds')) return rect(0, 0, 300, 500) as DOMRect
    return rect(200, 100, 230, 112) as DOMRect
  })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(100)
})

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('DescriptionTip の収める範囲', () => {
  it('data-tip-bounds の枠の中なら、吹き出しの右端が枠の右端を越えない（正）', () => {
    render(<div data-tip-bounds><DescriptionTip label="見出し" description="説明" /></div>)
    fireEvent.click(screen.getByRole('button', { name: '見出し' }))
    const tip = screen.getByRole('tooltip')
    const left = parseFloat(tip.style.left)
    const maxWidth = parseFloat(tip.style.maxWidth)
    expect(left + maxWidth).toBeLessThanOrEqual(300)
  })

  it('枠が無ければ、基準の左端（x=200）に揃えたまま（対照）', () => {
    render(<DescriptionTip label="見出し" description="説明" />)
    fireEvent.click(screen.getByRole('button', { name: '見出し' }))
    expect(parseFloat(screen.getByRole('tooltip').style.left)).toBe(200)
  })
})
