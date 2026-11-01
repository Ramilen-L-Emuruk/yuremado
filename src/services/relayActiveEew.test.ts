import { describe, it, expect } from 'vitest'
import type { EEWAlert } from '../types/earthquake'
import type { DmdataEvent } from './dmdata'
import { activeEewsFromRelay } from './relayActiveEew'

const ORIGIN = '2026-01-01T12:00:00Z'
const WITHIN = new Date('2026-01-01T12:01:00Z')
const AFTER = new Date('2026-01-01T12:10:00Z')

function report(serial: number, overrides: Partial<EEWAlert> = {}): DmdataEvent {
  const time = new Date(Date.parse(ORIGIN) + serial * 5_000).toISOString()
  const data: EEWAlert = {
    kind: 'eew',
    origin: 'dmdata',
    id: `eew-${serial}`,
    time,
    test: false,
    earthquake: {
      originTime: ORIGIN,
      arrivalTime: '2026-01-01T12:00:20Z',
      condition: '以上',
      hypocenter: { name: 'テスト震源', latitude: 35.0, longitude: 135.0, depth: 10, magnitude: 6.0 },
    },
    severity: 'Warning',
    cancelled: false,
    issue: { eventId: 'ev1', serial: String(serial), time },
    ...overrides,
  }
  return { kind: 'eew', data }
}

describe('activeEewsFromRelay', () => {
  // 正: 地震ごとに最新の報を 1 通選び、第 1 報の発表時刻を載せる
  it('最新の報を選び、第 1 報の時刻を載せる', () => {
    const got = activeEewsFromRelay([report(1), report(2), report(3)], WITHIN)
    expect(got.map(e => e.id)).toEqual(['eew-3'])
    expect(got[0].firstIssueTime).toBe(new Date(Date.parse(ORIGIN) + 5_000).toISOString())
  })

  // 正: 途中の報で特別警報だった印は、最新報で下がっていても載せる
  it('途中の報の特別警報の印を載せる', () => {
    const got = activeEewsFromRelay([report(1), report(2, { everSpecialWarning: true }), report(3)], WITHIN)
    expect(got.map(e => e.id)).toEqual(['eew-3'])
    expect(got[0].everSpecialWarning).toBe(true)
  })

  // 対照: 特別警報だった報が無ければ印を付けない
  it('特別警報だった報が無ければ印を付けない', () => {
    const got = activeEewsFromRelay([report(1), report(2)], WITHIN)
    expect(got[0].everSpecialWarning).toBeUndefined()
  })

  // 安全弁: 取消の報があれば戻さない・自動解除を過ぎた最終報は戻さない・EEW 以外は読まない
  it('取消・解除済み・EEW 以外は戻さない', () => {
    expect(activeEewsFromRelay([report(1), report(2, { cancelled: true })], WITHIN)).toEqual([])
    expect(activeEewsFromRelay([report(1, { isFinal: true })], AFTER)).toEqual([])
    expect(activeEewsFromRelay([{ kind: 'quake', data: {} } as unknown as DmdataEvent], WITHIN)).toEqual([])
  })
})
