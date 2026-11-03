import { describe, expect, it } from 'vitest'

import { EEW_HYPOCENTER_NAME_MEMORY_MAX, eewAnnounceShouldNotify, eewCancelShouldNotify, rememberEewNotified } from './eew'

// 設定「通知する地域」で県を選んだ人の緊急地震速報の通知（2026-11-03 ユーザー選択「通知した地震の取消だけ (Recommended)」）
describe('eewAnnounceShouldNotify', () => {
  const base = { isNew: false, levelUpgraded: false, forecastRaised: false, regionSelected: false, alreadyNotified: false }
  it('正: 地域を選んでいて、まだ通知していない地震なら、区分も予想も変わらない続報でも出す（選んだ県が続報で加わった）', () => {
    expect(eewAnnounceShouldNotify({ ...base, regionSelected: true })).toBe(true)
  })
  it('対照: 地域を選んでいても、通知済みの地震の変わらない続報は出さない', () => {
    expect(eewAnnounceShouldNotify({ ...base, regionSelected: true, alreadyNotified: true })).toBe(false)
  })
  it('安全弁: 地域を選んでいなければ今までどおり（新規・格上げ・引き上げだけ）', () => {
    expect(eewAnnounceShouldNotify(base)).toBe(false)
    expect(eewAnnounceShouldNotify({ ...base, isNew: true })).toBe(true)
    expect(eewAnnounceShouldNotify({ ...base, levelUpgraded: true, alreadyNotified: true })).toBe(true)
    expect(eewAnnounceShouldNotify({ ...base, forecastRaised: true, alreadyNotified: true })).toBe(true)
  })
})

describe('eewCancelShouldNotify', () => {
  it('正: 地域を選んでいる人には、通知した地震の取消だけを出す', () => {
    expect(eewCancelShouldNotify({ regionSelected: true, notified: true })).toBe(true)
    expect(eewCancelShouldNotify({ regionSelected: true, notified: false })).toBe(false)
  })
  it('安全弁: 地域を選んでいなければ、記憶に無い地震の取消も出す（今までどおり）', () => {
    expect(eewCancelShouldNotify({ regionSelected: false, notified: false })).toBe(true)
  })
})

describe('rememberEewNotified', () => {
  it('上限を超えたら古いものから捨て、覚え直したものは新しい側へ動かす', () => {
    const m = new Set<string>()
    for (let i = 0; i < EEW_HYPOCENTER_NAME_MEMORY_MAX; i++) rememberEewNotified(m, `k${i}`)
    rememberEewNotified(m, 'k0')
    rememberEewNotified(m, 'new')
    expect(m.size).toBe(EEW_HYPOCENTER_NAME_MEMORY_MAX)
    expect(m.has('k0')).toBe(true)
    expect(m.has('k1')).toBe(false)
    expect(m.has('new')).toBe(true)
  })
})
