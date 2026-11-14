// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 通知の許可は `useNotificationPermission` が読み込んだ時点で一度読むので、読み込みより先に置く
const perm = vi.hoisted(() => {
  const state = { value: 'default' as NotificationPermission }
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    value: { get permission() { return state.value }, requestPermission: async () => state.value },
  })
  return state
})

const push = vi.hoisted(() => ({
  supported: true,
  subscribe: vi.fn(async () => 'ok' as const),
  unsubscribe: vi.fn(async () => {}),
}))

vi.mock('../services/pushSubscription', async importOriginal => {
  const actual = await importOriginal<typeof import('../services/pushSubscription')>()
  return {
    ...actual,
    pushSupported: () => push.supported,
    subscribePush: push.subscribe,
    unsubscribePush: push.unsubscribe,
  }
})

import { usePushSubscription } from './usePushSubscription'
import { DEFAULTS, type AppSettings } from './useSettings'

/** 許可を変えたことを、画面へ戻ったときの読み直しで知らせる（Permissions API は jsdom に無い） */
function setPermission(value: NotificationPermission): void {
  perm.value = value
  act(() => { document.dispatchEvent(new Event('visibilitychange')) })
}

/** 登録はまとめて送るまで 1.5 秒待つ */
async function flushSync(): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
}

describe('usePushSubscription（プッシュ通知だけの入り切りは無く、許可と「通知を表示」で決まる）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    perm.value = 'default'
    push.supported = true
    push.subscribe.mockClear()
    push.unsubscribe.mockClear()
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
  })
  afterEach(() => { vi.useRealTimers() })

  it('正: 許可が出ていて「通知を表示」が入っていれば購読する', async () => {
    setPermission('granted')
    renderHook(() => usePushSubscription(DEFAULTS))
    await flushSync()
    expect(push.subscribe).toHaveBeenCalledTimes(1)
  })

  it('正: 許可の無い間は購読せず、許可が出たときに購読を始める', async () => {
    renderHook(() => usePushSubscription(DEFAULTS))
    await flushSync()
    expect(push.subscribe).not.toHaveBeenCalled()
    setPermission('granted')
    await flushSync()
    expect(push.subscribe).toHaveBeenCalledTimes(1)
  })

  it('対照: 「通知を表示」を切ると購読を外す', async () => {
    setPermission('granted')
    const { rerender } = renderHook((s: AppSettings) => usePushSubscription(s), { initialProps: DEFAULTS })
    await flushSync()
    rerender({ ...DEFAULTS, notifyEnabled: false })
    await flushSync()
    expect(push.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('対照: 許可が取り消されたら購読を外す', async () => {
    setPermission('granted')
    renderHook(() => usePushSubscription(DEFAULTS))
    await flushSync()
    setPermission('denied')
    await flushSync()
    expect(push.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('対照: 起動した時点で条件が外れていれば、残っている購読を一度だけ外す（前の版の「プッシュ通知」で作った分）', async () => {
    setPermission('granted')
    const { rerender } = renderHook((s: AppSettings) => usePushSubscription(s), { initialProps: { ...DEFAULTS, notifyEnabled: false } })
    await flushSync()
    rerender({ ...DEFAULTS, notifyEnabled: false, notifyEEW: !DEFAULTS.notifyEEW })
    await flushSync()
    expect(push.unsubscribe).toHaveBeenCalledTimes(1)
    expect(push.subscribe).not.toHaveBeenCalled()
  })

  it('安全弁: 購読を扱えないブラウザでは、許可していても購読しない', async () => {
    push.supported = false
    setPermission('granted')
    renderHook(() => usePushSubscription(DEFAULTS))
    await flushSync()
    expect(push.subscribe).not.toHaveBeenCalled()
  })
})
