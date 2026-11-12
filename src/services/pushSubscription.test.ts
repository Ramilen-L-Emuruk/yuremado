import { describe, expect, it } from 'vitest'
import { DEFAULTS } from '../hooks/useSettings'
import { pushPrefsOf } from './pushSubscription'

describe('pushPrefsOf の言語', () => {
  it('言語を選んでいれば、端末の言語に関わらずその言語を中継へ渡す', () => {
    expect(pushPrefsOf({ ...DEFAULTS, locale: 'ko' }, ['en-US']).locale).toBe('ko')
  })

  it('端末に合わせるなら、端末の言語の並びから決めた言語を渡す', () => {
    expect(pushPrefsOf({ ...DEFAULTS, locale: 'auto' }, ['zh-TW', 'en']).locale).toBe('zh-Hant')
  })

  it('端末の言語が 7 言語に当たらなければ英語を渡す（日本語にはしない）', () => {
    expect(pushPrefsOf({ ...DEFAULTS, locale: 'auto' }, ['fr-FR']).locale).toBe('en')
  })
})
