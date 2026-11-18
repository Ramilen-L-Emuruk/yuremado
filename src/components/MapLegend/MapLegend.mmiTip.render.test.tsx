// @vitest-environment jsdom
//
// 地図の凡例の見出し「MMI」の吹き出し。見出しの「MMI」が吹き出しを持つので、1 つ目のブロックでも
// 行全体は開閉に使わず、右端の ▾ だけが開閉になる（ボタンの中にボタンを入れない。
// 2026-11-18 ユーザー選択「見出しの文字は開閉に使わず、▾だけを開閉ボタンにする」）。
// 言語の配り役で包まないので、辞書は既定の日本語になる。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MapLegend } from './index'
import { buildLegendBlocks, EMPTY_LEGEND_SOURCES, type MapLegendSources } from './legendBlocks'
import { JA_MESSAGES } from '../../i18n/messages'

const w = JA_MESSAGES.map.legend

function blocksOf(patch: Partial<MapLegendSources>) {
  return buildLegendBlocks({ ...EMPTY_LEGEND_SOURCES, ...patch }, JA_MESSAGES)
}

afterEach(cleanup)

describe('MapLegend の MMI の見出し', () => {
  it('開いているとき、「MMI」だけが吹き出しの語で、押しても開閉は動かない（正）', () => {
    const onToggle = vi.fn()
    render(<MapLegend blocks={blocksOf({ analysisMmi: 1 })} collapsed={false} onToggle={onToggle} onHeatmapPeriodChange={() => {}} />)
    const term = screen.getByRole('button', { name: 'MMI' })
    fireEvent.click(term)
    expect(onToggle).not.toHaveBeenCalled()
    // 吹き出しは USGS の原文の直訳に、出典を添えて出る
    const tip = screen.getByRole('tooltip')
    expect(tip.textContent).toContain(JA_MESSAGES.quake.analysis.tips.mmi.text)
    expect(tip.textContent).toContain(JA_MESSAGES.quake.analysis.tips.mmi.src)
  })

  it('右端の ▾ のボタンが開閉を受け持ち、名前は見出しの全文（正）', () => {
    const onToggle = vi.fn()
    render(<MapLegend blocks={blocksOf({ analysisMmi: 1 })} collapsed={false} onToggle={onToggle} onHeatmapPeriodChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: w.analysisMmiTitle }))
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('ボタンの中にボタンが入っていない（対照）', () => {
    const { container } = render(<MapLegend blocks={blocksOf({ analysisMmi: 1 })} collapsed={false} onToggle={() => {}} onHeatmapPeriodChange={() => {}} />)
    expect(container.querySelectorAll('button button')).toHaveLength(0)
  })

  it('畳んだ凡例の短い名前「MMI」には吹き出しを付けず、行全体が開閉のまま（安全弁）', () => {
    const onToggle = vi.fn()
    render(<MapLegend blocks={blocksOf({ analysisMmi: 1 })} collapsed onToggle={onToggle} onHeatmapPeriodChange={() => {}} />)
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(1)
    fireEvent.click(buttons[0])
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('MMI が 2 つ目以降のときも「MMI」の語は吹き出しを持ち、先頭の見出しは行全体が開閉のまま（正）', () => {
    const onToggle = vi.fn()
    const [mmi] = blocksOf({ analysisMmi: 1 })
    const [faults] = blocksOf({ activeFaults: true })
    render(<MapLegend blocks={[faults, mmi]} collapsed={false} onToggle={onToggle} onHeatmapPeriodChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'MMI' }))
    expect(screen.getByRole('tooltip').textContent).toContain(JA_MESSAGES.quake.analysis.tips.mmi.text)
    expect(onToggle).not.toHaveBeenCalled()
    fireEvent.click(screen.getAllByRole('button')[0])
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('MMI 以外の見出しが先頭のときは、今までどおり行全体が開閉（対照）', () => {
    const onToggle = vi.fn()
    render(<MapLegend blocks={blocksOf({ activeFaults: true })} collapsed={false} onToggle={onToggle} onHeatmapPeriodChange={() => {}} />)
    const heading = screen.getAllByRole('button')[0]
    expect(heading.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(heading)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })
})
