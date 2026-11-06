import { describe, expect, it } from 'vitest'
import { DAILY_SETTLE_DAYS, settledDay, shiftDay, todayJst } from './hypocenterDays'

describe('震源の日の数え方', () => {
  it('正: 月末・年末・うるう年をまたいで日をずらす', () => {
    expect(shiftDay('20240229', 1)).toBe('20240301')
    expect(shiftDay('20240301', -1)).toBe('20240229')
    expect(shiftDay('20230228', 1)).toBe('20230301')
    expect(shiftDay('20221231', 1)).toBe('20230101')
    expect(shiftDay('20230101', -1)).toBe('20221231')
  })

  it('対照: 0 日ずらしても同じ日', () => {
    expect(shiftDay('20261103', 0)).toBe('20261103')
  })

  it('正: 出そろったとみなせる最後の日は、今日から決めた日数だけ前', () => {
    expect(DAILY_SETTLE_DAYS).toBe(3)
    expect(settledDay('20261103')).toBe('20261031')
    expect(settledDay('20260301')).toBe('20260226')
  })

  it('安全弁: 今日は日本時間で決める（UTC の 15 時は日本時間の翌日）', () => {
    expect(todayJst(Date.UTC(2026, 10, 2, 14, 59))).toBe('20261102')
    expect(todayJst(Date.UTC(2026, 10, 2, 15, 0))).toBe('20261103')
  })
})
