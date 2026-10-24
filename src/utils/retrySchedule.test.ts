import { describe, expect, it } from 'vitest'
import { RETRY_MAX_DELAY_MS, RETRY_MAX_RETRIES, retryDelayAfter } from './retrySchedule'

describe('retryDelayAfter', () => {
  it('30 秒から倍々に伸び、5 分で頭打ちになる', () => {
    expect([1, 2, 3, 4, 5].map(retryDelayAfter)).toEqual([30_000, 60_000, 120_000, 240_000, RETRY_MAX_DELAY_MS])
  })

  it('取り直しを使い切ったら諦める（対照: 5 回目までは間隔を返す）', () => {
    expect(retryDelayAfter(RETRY_MAX_RETRIES)).not.toBeNull()
    expect(retryDelayAfter(RETRY_MAX_RETRIES + 1)).toBeNull()
  })

  it('失敗していない・壊れた回数では取り直さない（安全弁）', () => {
    for (const n of [0, -1, 1.5, Number.NaN]) expect(retryDelayAfter(n)).toBeNull()
  })

  it('諦めるまでの合計は約 12 分半', () => {
    let total = 0
    for (let n = 1; n <= RETRY_MAX_RETRIES; n += 1) total += retryDelayAfter(n) ?? 0
    expect(total).toBe(750_000)
  })
})
