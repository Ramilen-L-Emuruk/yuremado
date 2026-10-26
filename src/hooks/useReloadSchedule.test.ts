// @vitest-environment jsdom
//
// 読み直しの段取り（秒読み・待つ条件・「後で」）を、時間の経過ごと固定する。
// 待つかどうかの判定そのものは utils/appUpdateGate.test.ts が持つ。ここは配線 —— 判定が変わったときに
// 秒読みを捨てて数え直すか、期限が明けたら戻るか、適用が効かなかった起動で自分から適用しないか。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useReloadSchedule, type ReloadScheduleInput } from './useReloadSchedule'
import { installAppUpdater, type AppUpdateSnapshot, type AppUpdater } from '../services/appUpdate'
import { RELOAD_COUNTDOWN_SEC, RELOAD_POSTPONE_MS } from '../utils/appUpdateGate'
import { markReleaseNotesOpen } from '../utils/releaseNotesOpen'

function fakeUpdater(snapshot: AppUpdateSnapshot) {
  const listeners = new Set<() => void>()
  let current = snapshot
  const updater: AppUpdater = {
    start() {},
    getSnapshot: () => current,
    subscribe: (l) => {
      listeners.add(l)
      return () => { listeners.delete(l) }
    },
    apply: vi.fn(),
    checkNow() {},
  }
  return {
    updater,
    set(next: AppUpdateSnapshot) {
      current = next
      for (const l of listeners) l()
    },
  }
}

const WAITING: AppUpdateSnapshot = { waiting: true, newVersion: '5.70.0', autoApply: true }
const QUIET: ReloadScheduleInput = { alertActive: false, replaying: false, periodicReloadEnabled: false }

function render(snapshot: AppUpdateSnapshot, input: ReloadScheduleInput = QUIET) {
  const f = fakeUpdater(snapshot)
  installAppUpdater(f.updater)
  const hook = renderHook((props: ReloadScheduleInput) => useReloadSchedule(props), { initialProps: input })
  return { ...f, hook }
}

function tick(seconds: number) {
  for (let i = 0; i < seconds; i++) act(() => { vi.advanceTimersByTime(1000) })
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('useReloadSchedule', () => {
  it('静かなら 10 秒数えて適用する（正）', () => {
    const t = render(WAITING)
    expect(t.hook.result.current.countdown).toBe(RELOAD_COUNTDOWN_SEC)
    tick(RELOAD_COUNTDOWN_SEC - 1)
    expect(t.updater.apply).not.toHaveBeenCalled()
    tick(1)
    expect(t.updater.apply).toHaveBeenCalledTimes(1)
  })

  it('秒読みの途中で発表が始まったら捨て、終わったら 10 秒から数え直す', () => {
    const t = render(WAITING)
    tick(7)
    expect(t.hook.result.current.countdown).toBe(RELOAD_COUNTDOWN_SEC - 7)
    t.hook.rerender({ ...QUIET, alertActive: true })
    expect(t.hook.result.current.countdown).toBeNull()
    expect(t.hook.result.current.gate).toEqual({ kind: 'held', reason: 'update', cause: 'alert' })
    tick(30)
    expect(t.updater.apply).not.toHaveBeenCalled()
    t.hook.rerender(QUIET)
    expect(t.hook.result.current.countdown).toBe(RELOAD_COUNTDOWN_SEC)
  })

  it('前の起動で適用が効かなかったら、待っていても秒読みしない（安全弁: 読み直しを繰り返さない）', () => {
    const t = render({ ...WAITING, autoApply: false })
    expect(t.hook.result.current.countdown).toBeNull()
    tick(60)
    expect(t.updater.apply).not.toHaveBeenCalled()
    // ［今すぐ更新］からは適用できる
    act(() => { t.hook.result.current.applyNow() })
    expect(t.updater.apply).toHaveBeenCalledTimes(1)
  })

  it('「後で」から 1 時間は秒読みせず、過ぎたら数え直す（境界）', () => {
    const t = render(WAITING)
    act(() => { t.hook.result.current.postpone() })
    expect(t.hook.result.current.countdown).toBeNull()
    act(() => { vi.advanceTimersByTime(RELOAD_POSTPONE_MS - 60_000) })
    expect(t.hook.result.current.countdown).toBeNull()
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(t.hook.result.current.countdown).toBe(RELOAD_COUNTDOWN_SEC)
  })

  it('変更内容の窓を開いている間は秒読みしない（2 つ開いて 1 つ閉じても止めたまま）', () => {
    const t = render(WAITING)
    let closeA = () => {}
    let closeB = () => {}
    act(() => {
      closeA = markReleaseNotesOpen()
      closeB = markReleaseNotesOpen()
    })
    expect(t.hook.result.current.countdown).toBeNull()
    act(() => { closeA() })
    act(() => { closeA() }) // 2 回閉じても 1 回にしか数えない
    expect(t.hook.result.current.countdown).toBeNull()
    act(() => { closeB() })
    expect(t.hook.result.current.countdown).toBe(RELOAD_COUNTDOWN_SEC)
  })

  it('待っている版が消えたら秒読みを捨てる（対照）', () => {
    const t = render(WAITING)
    tick(3)
    act(() => { t.set({ waiting: false, newVersion: null, autoApply: true }) })
    expect(t.hook.result.current.countdown).toBeNull()
    expect(t.hook.result.current.gate).toEqual({ kind: 'none' })
  })
})
