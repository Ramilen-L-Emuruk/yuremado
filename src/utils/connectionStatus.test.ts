import { describe, it, expect } from 'vitest'
import { isLiveFeedHalted } from './connectionStatus'

// 地図の更新時刻に「更新停止」の警告を出すかの判定。
describe('isLiveFeedHalted', () => {
  // 正: 配信元が閉じて止めた 2 つも、更新は止まっているので警告を出す
  it('解約・終了の操作で止めた状態は止まっている', () => {
    expect(isLiveFeedHalted('contract-ended', null)).toBe(true)
    expect(isLiveFeedHalted('closed-by-user', null)).toBe(true)
  })

  // 対照: 従来から警告を出していた 2 つを巻き込んでいない
  it('切断と同時接続の上限は止まっている', () => {
    expect(isLiveFeedHalted('disconnected', null)).toBe(true)
    expect(isLiveFeedHalted('crowded', null)).toBe(true)
  })

  // 正: 中継と繋がっていても、中継が DMDATA.JP と切れていれば電文は届かない（2026-10-31 ユーザー選択）
  it('中継が DMDATA.JP と切れていれば、繋がっていても止まっている', () => {
    expect(isLiveFeedHalted('connected', { connected: false, disconnectedAtMs: null })).toBe(true)
    expect(isLiveFeedHalted('connected', { connected: true, disconnectedAtMs: null })).toBe(false)
  })

  // 安全弁: 再生中は上流の状態で警告を出さない（ライブを止めているので）
  it('再生中は上流が切れていても止まっていない', () => {
    expect(isLiveFeedHalted('replay', { connected: false, disconnectedAtMs: null })).toBe(false)
  })

  // 安全弁: 再生中はライブを意図的に止めているだけなので、警告を出さない
  it('接続中・接続試行中・再生中は止まっていない', () => {
    expect(isLiveFeedHalted('connected', null)).toBe(false)
    expect(isLiveFeedHalted('connecting', null)).toBe(false)
    expect(isLiveFeedHalted('replay', null)).toBe(false)
  })
})
