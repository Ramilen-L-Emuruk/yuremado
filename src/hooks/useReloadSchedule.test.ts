// @vitest-environment jsdom
//
// 読み直しの段取り（秒読み・待つ条件・「後で」）を、時間の経過ごと固定する。
// 待つかどうかの判定そのものは utils/appUpdateGate.test.ts が持つ。ここは配線 —— 判定が変わったときに
// 秒読みを捨てて数え直すか、期限が明けたら戻るか、適用が効かなかった起動で自分から適用しないか。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useReloadSchedule, type ReloadScheduleInput } from './useReloadSchedule'
import { installAppUpdater, type AppUpdateSnapshot, type AppUpdater } from '../services/appUpdate'
import { RELOAD_COUNTDOWN_SEC, RELOAD_POSTPONE_MS, SETTINGS_DIALOG_ATTR, SETTINGS_IDLE_HOLD_LIMIT_MS } from '../utils/appUpdateGate'
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
const QUIET: ReloadScheduleInput = { alertActive: false, replaying: false, periodicReloadEnabled: false, settingsOpen: false }

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

  it('設定の窓を開いたまま操作が無く 30 分経ったら、窓の後ろで秒読みする（正）', () => {
    const t = render(WAITING, { ...QUIET, settingsOpen: true })
    expect(t.hook.result.current.gate).toEqual({ kind: 'held', reason: 'update', cause: 'settings' })
    act(() => { vi.advanceTimersByTime(SETTINGS_IDLE_HOLD_LIMIT_MS - 60_000) })
    expect(t.hook.result.current.countdown).toBeNull()
    act(() => { vi.advanceTimersByTime(60_000 + 30_000) })
    expect(t.hook.result.current.countdown).toBe(RELOAD_COUNTDOWN_SEC)
  })

  it('期限の手前で窓の中を触ったら、そこから 30 分数え直す（対照）', () => {
    const t = render(WAITING, { ...QUIET, settingsOpen: true })
    act(() => { vi.advanceTimersByTime(10_000) })
    act(() => { window.dispatchEvent(new Event('keydown')) })
    // 開いてから 30 分 5 秒。最後の操作からはまだ 30 分経っていない
    act(() => { vi.advanceTimersByTime(SETTINGS_IDLE_HOLD_LIMIT_MS - 5_000) })
    expect(t.hook.result.current.countdown).toBeNull()
    expect(t.hook.result.current.gate).toEqual({ kind: 'held', reason: 'update', cause: 'settings' })
    // 最後の操作から 30 分を過ぎ、次の見直しが来たら秒読みへ
    act(() => { vi.advanceTimersByTime(40_000) })
    expect(t.hook.result.current.countdown).toBe(RELOAD_COUNTDOWN_SEC)
  })

  it('窓の後ろで秒読みしている間に窓の中を触ったら、秒読みを捨ててまた待つ', () => {
    const t = render(WAITING, { ...QUIET, settingsOpen: true })
    act(() => { vi.advanceTimersByTime(SETTINGS_IDLE_HOLD_LIMIT_MS + 30_000) })
    expect(t.hook.result.current.countdown).toBe(RELOAD_COUNTDOWN_SEC)
    act(() => { window.dispatchEvent(new Event('pointerdown')) })
    expect(t.hook.result.current.countdown).toBeNull()
    expect(t.hook.result.current.gate).toEqual({ kind: 'held', reason: 'update', cause: 'settings' })
    tick(RELOAD_COUNTDOWN_SEC)
    expect(t.updater.apply).not.toHaveBeenCalled()
  })

  it('一度開いて閉じ、開き直したら、待つ時間を初めから数える（境界）', () => {
    const t = render(WAITING, { ...QUIET, settingsOpen: true })
    act(() => { vi.advanceTimersByTime(SETTINGS_IDLE_HOLD_LIMIT_MS + 1_000) })
    t.hook.rerender(QUIET)
    t.hook.rerender({ ...QUIET, settingsOpen: true })
    expect(t.hook.result.current.gate).toEqual({ kind: 'held', reason: 'update', cause: 'settings' })
  })

  it('見直しの合図より先に別の描き直しで待ちが明けても、窓の中を触れば秒読みを捨てる（安全弁）', () => {
    const t = render(WAITING, { ...QUIET, settingsOpen: true })
    // 最後の操作を開いて 10 秒後にずらし、期限（1810 秒）を見直し（30 秒ごと: 1800・1830 秒）の間に置く
    act(() => { vi.advanceTimersByTime(10_000) })
    act(() => { window.dispatchEvent(new Event('keydown')) })
    act(() => { vi.advanceTimersByTime(SETTINGS_IDLE_HOLD_LIMIT_MS - 5_000) })
    expect(t.hook.result.current.countdown).toBeNull()
    act(() => { vi.advanceTimersByTime(10_000) })
    // 期限は過ぎたが見直しはまだ。別の理由で描き直されて秒読みが始まる
    t.hook.rerender({ ...QUIET, settingsOpen: true, periodicReloadEnabled: true })
    expect(t.hook.result.current.countdown).toBe(RELOAD_COUNTDOWN_SEC)
    act(() => { window.dispatchEvent(new Event('keydown')) })
    expect(t.hook.result.current.countdown).toBeNull()
  })

  it('窓の外のスクロールは操作に数えない（追従のスクロールで待ちが延びない）', () => {
    const t = render(WAITING, { ...QUIET, settingsOpen: true })
    const outside = document.createElement('div')
    document.body.appendChild(outside)
    act(() => { vi.advanceTimersByTime(SETTINGS_IDLE_HOLD_LIMIT_MS - 60_000) })
    act(() => { outside.dispatchEvent(new Event('scroll')) })
    act(() => { vi.advanceTimersByTime(90_000) })
    expect(t.hook.result.current.countdown).toBe(RELOAD_COUNTDOWN_SEC)
    outside.remove()
  })

  it('窓の中のスクロールは操作に数える', () => {
    const t = render(WAITING, { ...QUIET, settingsOpen: true })
    const dialog = document.createElement('div')
    dialog.setAttribute(SETTINGS_DIALOG_ATTR, '')
    const pane = document.createElement('div')
    dialog.appendChild(pane)
    document.body.appendChild(dialog)
    act(() => { vi.advanceTimersByTime(SETTINGS_IDLE_HOLD_LIMIT_MS - 60_000) })
    act(() => { pane.dispatchEvent(new Event('scroll')) })
    act(() => { vi.advanceTimersByTime(90_000) })
    expect(t.hook.result.current.countdown).toBeNull()
    dialog.remove()
  })

  it('窓の中の入力欄にフォーカスがあっても「入力中」で待たず、30 分で明ける（安全弁が窓の待ちを越えない）', () => {
    const dialog = document.createElement('div')
    dialog.setAttribute(SETTINGS_DIALOG_ATTR, '')
    const input = document.createElement('input')
    dialog.appendChild(input)
    document.body.appendChild(dialog)
    input.focus()
    const t = render(WAITING, { ...QUIET, settingsOpen: true })
    expect(t.hook.result.current.gate).toEqual({ kind: 'held', reason: 'update', cause: 'settings' })
    act(() => { vi.advanceTimersByTime(SETTINGS_IDLE_HOLD_LIMIT_MS + 30_000) })
    expect(t.hook.result.current.countdown).toBe(RELOAD_COUNTDOWN_SEC)
    dialog.remove()
  })
})
