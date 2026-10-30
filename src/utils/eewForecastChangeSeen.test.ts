import { describe, it, expect, beforeEach } from 'vitest'
import { eewForecastChangeFirstSeenAt, resetEewForecastChangeSeen } from './eewForecastChangeSeen'

describe('「予想が変わった」の帯を初めて見た時刻', () => {
  beforeEach(() => resetEewForecastChangeSeen())

  // 正: 同じ報は 2 度目も初めて見た時刻を返す（カードを作り直しても計時をやり直さない）
  it('同じ鍵は最初に見た時刻を返し続ける', () => {
    expect(eewForecastChangeFirstSeenAt('k', 1000)).toBe(1000)
    expect(eewForecastChangeFirstSeenAt('k', 9000)).toBe(1000)
  })

  // 安全弁: リプレイの開始・停止で捨てると、同じ報を再生し直したとき計時がやり直しになる
  it('片付けた後は、いまを起点に覚え直す', () => {
    eewForecastChangeFirstSeenAt('k', 1000)
    resetEewForecastChangeSeen()
    expect(eewForecastChangeFirstSeenAt('k', 50_000)).toBe(50_000)
  })
})
