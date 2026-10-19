import { describe, it, expect } from 'vitest'
import { isLiveFeedHalted } from './connectionStatus'

// 地図の更新時刻に「更新停止」の警告を出すかの判定。
describe('isLiveFeedHalted', () => {
  // 正: 配信元が閉じて止めた 2 つも、更新は止まっているので警告を出す
  it('解約・終了の操作で止めた状態は止まっている', () => {
    expect(isLiveFeedHalted('contract-ended')).toBe(true)
    expect(isLiveFeedHalted('closed-by-user')).toBe(true)
  })

  // 対照: 従来から警告を出していた 2 つを巻き込んでいない
  it('切断と同時接続の上限は止まっている', () => {
    expect(isLiveFeedHalted('disconnected')).toBe(true)
    expect(isLiveFeedHalted('crowded')).toBe(true)
  })

  // 安全弁: 再生中はライブを意図的に止めているだけなので、警告を出さない
  it('接続中・接続試行中・再生中は止まっていない', () => {
    expect(isLiveFeedHalted('connected')).toBe(false)
    expect(isLiveFeedHalted('connecting')).toBe(false)
    expect(isLiveFeedHalted('replay')).toBe(false)
  })
})
