import { describe, expect, it } from 'vitest'
import { lastOpenedVersionKey, previousVersionToAnnounce } from './updatedNotice'

describe('previousVersionToAnnounce', () => {
  it('前に開いた版より新しければ、前の版を返す（正）', () => {
    expect(previousVersionToAnnounce('5.69.0', '5.70.0')).toBe('5.69.0')
    expect(previousVersionToAnnounce('5.9.0', '5.10.0')).toBe('5.9.0')
  })

  it('同じ版・古い版へ戻したときは出さない（対照）', () => {
    expect(previousVersionToAnnounce('5.70.0', '5.70.0')).toBeNull()
    expect(previousVersionToAnnounce('5.71.0', '5.70.0')).toBeNull()
  })

  it('覚えていない・番号が読めないときは出さない（安全弁）', () => {
    expect(previousVersionToAnnounce(null, '5.70.0')).toBeNull()
    expect(previousVersionToAnnounce('壊れた値', '5.70.0')).toBeNull()
  })
})

describe('lastOpenedVersionKey', () => {
  it('バリアントごとに別の鍵（同じオリジンで共有するため）', () => {
    expect(lastOpenedVersionKey('standard')).not.toBe(lastOpenedVersionKey('dmdss'))
  })
})
