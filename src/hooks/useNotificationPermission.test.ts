// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

// 許可は読み込んだ時点で一度読むので、読み込みより先に置く
const perm = vi.hoisted(() => {
  const state = {
    value: 'default' as NotificationPermission,
    request: async (): Promise<NotificationPermission> => state.value,
  }
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    value: { get permission() { return state.value }, requestPermission: () => state.request() },
  })
  return state
})

import { requestNotificationPermission } from './useNotificationPermission'

describe('requestNotificationPermission', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('正: 尋ねて許可が出たら、許可を返す', async () => {
    perm.request = async () => { perm.value = 'granted'; return 'granted' }
    await expect(requestNotificationPermission()).resolves.toBe('granted')
  })

  it('安全弁: 尋ねる処理が投げても、記録に残して今の許可を返す（押したボタンが黙って止まらない）', async () => {
    perm.value = 'default'
    perm.request = async () => { throw new Error('権限ポリシーで禁止') }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(requestNotificationPermission()).resolves.toBe('default')
    expect(warn.mock.calls.some(c => c.some(a => String(a).includes('通知の許可を尋ねられませんでした')))).toBe(true)
  })
})
