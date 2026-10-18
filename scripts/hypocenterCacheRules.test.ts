import { describe, it, expect } from 'vitest'
import { ZIP_RECENT_MAX_AGE_MS, isYearMagColumnValid, isZipCacheStale } from './hypocenterCacheRules'

// 2026-10-18 12:00 JST
const NOW = Date.UTC(2026, 9, 18, 3, 0, 0)
const DAY = 24 * 60 * 60 * 1000

describe('isZipCacheStale', () => {
  // 正: 直近 3 年（2024〜2026）の控えは 6 日を過ぎたら取り直す
  it.each(['2024', '2025', '2026'])('%s 年の 7 日前の控えは取り直す', (file) => {
    expect(isZipCacheStale(file, NOW - 7 * DAY, NOW)).toBe(true)
  })

  // 対照: 期限内なら取り直さない
  it('2024 年でも 5 日前の控えは使う', () => {
    expect(isZipCacheStale('2024', NOW - 5 * DAY, NOW)).toBe(false)
  })

  it('ちょうど期限の控えは使う', () => {
    expect(isZipCacheStale('2024', NOW - ZIP_RECENT_MAX_AGE_MS, NOW)).toBe(false)
  })

  // 安全弁: 3 年より前は何年前の控えでも取り直さない（まとめ ZIP・分割 ZIP も先頭 4 桁で年を読む）
  it.each(['2023', '1919', '1967', '199701'])('%s の控えは古くても使う', (file) => {
    expect(isZipCacheStale(file, NOW - 365 * DAY, NOW)).toBe(false)
  })

  // 年の境目は日本時間で数える（UTC では 12 月 31 日でも日本時間で元日なら新しい年）
  it('日本時間の元日になったら 3 年前の年は外れる', () => {
    const newYearJst = Date.UTC(2026, 11, 31, 15, 0, 0) // 2027-01-01 00:00 JST
    expect(isZipCacheStale('2024', newYearJst - 7 * DAY, newYearJst)).toBe(false)
    expect(isZipCacheStale('2025', newYearJst - 7 * DAY, newYearJst)).toBe(true)
  })
})

describe('isYearMagColumnValid', () => {
  it('null と有限数だけで件数と同じ長さなら通る', () => {
    expect(isYearMagColumnValid([45, null, 90], 3)).toBe(true)
  })

  it.each([
    ['列が無い', undefined, 0],
    ['長さが件数と違う', [45, null], 3],
    ['文字列が混ざる', [45, '90'], 2],
    ['NaN が混ざる', [45, Number.NaN], 2],
    ['undefined が混ざる', [45, undefined], 2],
  ])('%s なら弾く', (_label, mag, count) => {
    expect(isYearMagColumnValid(mag, count)).toBe(false)
  })
})
