import { describe, expect, it } from 'vitest'
import { plateNameFor } from './plateNames'

describe('plateNameFor', () => {
  it('正: 日本語以外の言語では表の訳を返す', () => {
    expect(plateNameFor('en', '太平洋プレート')).toBe('Pacific plate')
    expect(plateNameFor('zh-Hant', 'オーストラリアプレート')).toBe('澳洲板塊')
  })
  it('対照: 日本語の画面では日本語の名前のまま', () => {
    expect(plateNameFor('ja', '太平洋プレート')).toBe('太平洋プレート')
  })
  it('安全弁: 表に無い名前は日本語の名前のまま返す', () => {
    expect(plateNameFor('en', '架空プレート')).toBe('架空プレート')
  })
})
