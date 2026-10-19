import { describe, it, expect } from 'vitest'
import { hasWaveChartRows } from './chartRows'

describe('hasWaveChartRows', () => {
  // 正: どちらかに段があれば枠を描く
  it('自作地震計か公開観測点のどちらかに段があれば描く', () => {
    expect(hasWaveChartRows([{}], null)).toBe(true)
    expect(hasWaveChartRows([], { stations: [{}] })).toBe(true)
  })

  // 対照: 「出す」と決めていても段が 0 なら描かない（設定が「常に表示」で観測点が無い・公開観測点がまだ選ばれていない）
  it('段が 1 つも無ければ描かない', () => {
    expect(hasWaveChartRows([], null)).toBe(false)
    expect(hasWaveChartRows([], { stations: [] })).toBe(false)
  })
})
