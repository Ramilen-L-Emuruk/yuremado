import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { publishAnalysisChecked, publishAnalysisUpdated, readAnalysisUpdated, subscribeAnalysisUpdated } from './analysisUpdates'

describe('解析の知らせ', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('更新の知らせは、その地震を待つものにだけ 1 回渡す（正・対照）', () => {
    const seen: string[] = []
    const offA = subscribeAnalysisUpdated('20240101161010', () => seen.push('a'))
    const offB = subscribeAnalysisUpdated('20240101161800', () => seen.push('b'))
    publishAnalysisUpdated(['20240101161010', '20240101161010', '20000101000000'])
    expect(seen).toEqual(['a'])
    offA()
    offB()
  })

  it('見張りの知らせは、待っているものすべてへ、ばらした間の後に渡す（正）', () => {
    const seen: string[] = []
    const offA = subscribeAnalysisUpdated('20240101161010', () => seen.push('a'))
    const offB = subscribeAnalysisUpdated('20240101161800', () => seen.push('b'))
    const delays = [1000, 5000]
    publishAnalysisChecked(() => delays.shift()!)
    expect(seen).toEqual([])
    vi.advanceTimersByTime(1000)
    expect(seen).toEqual(['a'])
    vi.advanceTimersByTime(4000)
    expect(seen).toEqual(['a', 'b'])
    offA()
    offB()
  })

  it('見張りの知らせを待つ間に外したものには渡さない（安全弁）', () => {
    const seen: string[] = []
    const off = subscribeAnalysisUpdated('20240101161010', () => seen.push('a'))
    publishAnalysisChecked(() => 1000)
    off()
    vi.advanceTimersByTime(1000)
    expect(seen).toEqual([])
  })

  it('形の違う更新の知らせは読まない', () => {
    expect(readAnalysisUpdated({ eventIds: ['20240101161010'] })).toEqual(['20240101161010'])
    for (const msg of [{}, { eventIds: [] }, { eventIds: '20240101161010' }, { eventIds: ['2024'] }, { eventIds: [1] }]) {
      expect(readAnalysisUpdated(msg)).toBeNull()
    }
  })
})
