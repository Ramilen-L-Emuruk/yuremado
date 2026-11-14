import { describe, it, expect } from 'vitest'
import { quakeListDay } from './quakeListDay'
import { ja } from '../i18n/messages/ja'
import { en } from '../i18n/messages/en'

const F = ja.formats

describe('quakeListDay', () => {
  it('今年の地震でも年を出す', () => {
    const d = quakeListDay(new Date(2026, 10, 1, 16, 16).toISOString(), F)
    expect(d?.label).toBe('2026年11月1日')
  })

  it('別の年の地震も同じ形で出す', () => {
    const d = quakeListDay(new Date(2024, 0, 1, 16, 10).toISOString(), F)
    expect(d?.label).toBe('2024年1月1日')
  })

  it('同じ日の地震は同じ鍵、日付をまたぐと別の鍵になる', () => {
    const a = quakeListDay(new Date(2026, 10, 1, 0, 1).toISOString(), F)
    const b = quakeListDay(new Date(2026, 10, 1, 23, 59).toISOString(), F)
    const c = quakeListDay(new Date(2026, 9, 31, 23, 59).toISOString(), F)
    expect(a?.key).toBe(b?.key)
    expect(a?.key).not.toBe(c?.key)
  })

  it('区切りの文字は言語の書き方に従い、鍵は言語によらない', () => {
    const time = new Date(2026, 10, 1, 16, 16).toISOString()
    const a = quakeListDay(time, F)
    const b = quakeListDay(time, en.formats)
    expect(b?.key).toBe(a?.key)
    expect(b?.label).toBe(en.formats.fullDate(new Date(2026, 10, 1)))
    expect(b?.label).not.toContain('年')
  })

  it('時刻が読めなければ区切りを作らない', () => {
    expect(quakeListDay('not-a-date', F)).toBeNull()
  })
})
