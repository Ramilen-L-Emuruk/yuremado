// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import {
  NOTIFIED_SPECIAL_INFO_KEY, NOTIFIED_SPECIAL_INFO_MAX, forgetNotifiedSpecialInfo, loadNotifiedSpecialInfo, rememberNotifiedSpecialInfo,
  saveNotifiedSpecialInfo,
} from './notifiedSpecialInfoStore'

beforeEach(() => { localStorage.clear() })

describe('通知した特別な情報の記憶', () => {
  it('正: 覚えた鍵と設定・長周期の地名を、読み直しても取り戻す', () => {
    const m = loadNotifiedSpecialInfo()
    rememberNotifiedSpecialInfo(m, 'lpgm:20260101161000', { kind: 'quake' }, { eventId: '20260101161000', name: '石川県能登地方' })
    const again = loadNotifiedSpecialInfo()
    expect([...again.gates]).toEqual([['lpgm:20260101161000', { kind: 'quake' }]])
    expect([...again.lpgmNames]).toEqual([['20260101161000', '石川県能登地方']])
  })
  it('正: 上限を超えたら古いものから捨てる（覚え直した鍵は新しい側へ寄る）', () => {
    const m = loadNotifiedSpecialInfo()
    for (let i = 0; i < NOTIFIED_SPECIAL_INFO_MAX; i++) rememberNotifiedSpecialInfo(m, `k:${i}`, { kind: 'quake' } as never)
    rememberNotifiedSpecialInfo(m, 'k:0', { kind: 'quake' } as never)
    rememberNotifiedSpecialInfo(m, 'k:new', { kind: 'quake' } as never)
    const keys = [...loadNotifiedSpecialInfo().gates.keys()]
    expect(keys).toHaveLength(NOTIFIED_SPECIAL_INFO_MAX)
    expect(keys).not.toContain('k:1')
    expect(keys).toContain('k:0')
    expect(keys[keys.length - 1]).toBe('k:new')
  })
  it('対照: 保存が無ければ空から始める', () => {
    const m = loadNotifiedSpecialInfo()
    expect(m.gates.size).toBe(0)
    expect(m.lpgmNames.size).toBe(0)
  })
  it('安全弁: 壊れた保存値・形の合わない項目は捨てて読む', () => {
    localStorage.setItem(NOTIFIED_SPECIAL_INFO_KEY, '{')
    expect(loadNotifiedSpecialInfo().gates.size).toBe(0)
    localStorage.setItem(NOTIFIED_SPECIAL_INFO_KEY, JSON.stringify({ gates: [['a', { kind: 'quake' }], ['b', 3], 'x'], lpgmNames: [['e', 1], ['f', '地名']] }))
    const m = loadNotifiedSpecialInfo()
    expect([...m.gates.keys()]).toEqual(['a'])
    expect([...m.lpgmNames]).toEqual([['f', '地名']])
    saveNotifiedSpecialInfo(m)
    expect(JSON.parse(localStorage.getItem(NOTIFIED_SPECIAL_INFO_KEY) ?? '')).toEqual({ gates: [['a', { kind: 'quake' }]], lpgmNames: [['f', '地名']] })
  })
  it('正: 別のタブが覚えた鍵を、保存のときに合わせて消さない', () => {
    const a = loadNotifiedSpecialInfo()
    const b = loadNotifiedSpecialInfo()
    rememberNotifiedSpecialInfo(a, 'earthquakeCount:A', { kind: 'quake' })
    rememberNotifiedSpecialInfo(b, 'earthquakeCount:B', { kind: 'quake' })
    expect([...loadNotifiedSpecialInfo().gates.keys()].sort()).toEqual(['earthquakeCount:A', 'earthquakeCount:B'])
  })
  it('安全弁: このタブで取消を通知して忘れた鍵は、別のタブの古い保存値と合わせても生き返らない', () => {
    const a = loadNotifiedSpecialInfo()
    rememberNotifiedSpecialInfo(a, 'quakeNotice:X', { kind: 'quakeNotice' }, undefined)
    const b = loadNotifiedSpecialInfo()
    forgetNotifiedSpecialInfo(b, 'quakeNotice:X')
    saveNotifiedSpecialInfo(b)
    expect(loadNotifiedSpecialInfo().gates.has('quakeNotice:X')).toBe(false)
  })
  it('対照: 覚えていない鍵を忘れても保存しない', () => {
    const m = loadNotifiedSpecialInfo()
    forgetNotifiedSpecialInfo(m, 'lpgm:none', 'none')
    expect(localStorage.getItem(NOTIFIED_SPECIAL_INFO_KEY)).toBeNull()
  })
})
