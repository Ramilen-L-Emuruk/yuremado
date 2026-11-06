// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import {
  NOTIFICATION_OPEN_WAIT_MS, resolveNotificationOpen, useNotificationOpen,
  type NotificationOpenActions, type NotificationOpenScreen,
} from './useNotificationOpen'
import { emitNotificationOpen } from '../utils/notificationClick'
import type { JMAQuake } from '../types/earthquake'
import type { TabId } from '../components/IconNav'
import { log } from '../utils/logger'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  window.history.replaceState(null, '', '/')
})

/** 鍵（eventKey）と電文の id・発現時刻だけを持つ地震カード */
const quake = (eventId: string, over: Partial<JMAQuake> = {}): JMAQuake => ({
  id: `dmdata-quake-${eventId}-1`,
  eventKey: eventId,
  earthquake: { time: '2026-01-01T16:10:00+09:00', hypocenter: { latitude: 37.5, longitude: 137.27 } },
  ...over,
} as unknown as JMAQuake)

function actions(): NotificationOpenActions & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    openTab: tab => calls.push(`tab:${tab}`),
    selectQuake: key => calls.push(`quake:${key}`),
    openLpgm: id => calls.push(`lpgm:${id}`),
    openDistribution: key => calls.push(`distribution:${key}`),
  }
}

interface Props { shown: JMAQuake[]; all: JMAQuake[]; screen: NotificationOpenScreen }
const screen = (activeTab: TabId = 'realtime', selectionTick = 0): NotificationOpenScreen => ({ activeTab, selectionTick })
function render(a: NotificationOpenActions, initial: Partial<Props> = {}) {
  const props: Props = { shown: [], all: [], screen: screen(), ...initial }
  return renderHook((p: Props) => useNotificationOpen(p.shown, p.all, p.screen, a), { initialProps: props })
}

describe('resolveNotificationOpen', () => {
  const eq = quake('20260101161000')
  const cancelled = quake('20260101170000', { cancelledAt: new Date(0) })
  const hidden = quake('20260101180000')
  const all = [eq, cancelled, hidden]
  const shown = [eq, cancelled]
  it('正: 地震・長周期・推計の開き先から、その地震カードの鍵を引く', () => {
    expect(resolveNotificationOpen({ tab: 'earthquake', quake: '20260101161000' }, shown, all)).toEqual({ kind: 'select', key: '20260101161000' })
    expect(resolveNotificationOpen({ tab: 'earthquake', lpgm: '20260101161000' }, shown, all)).toEqual({ kind: 'select', key: '20260101161000' })
    expect(resolveNotificationOpen({ tab: 'earthquake', estimated: '2026-01-01T16:10:00+09:00', lat: 37.5, lon: 137.3 }, [eq], [eq]))
      .toEqual({ kind: 'select', key: '20260101161000' })
  })
  it('正: 推計を時刻だけで当てて候補が 2 つあるときは、地震タブに出ている方を選ぶ', () => {
    const twin = quake('20260101161001')
    expect(resolveNotificationOpen({ tab: 'earthquake', estimated: '2026-01-01T16:10:00+09:00' }, [twin], [eq, twin]))
      .toEqual({ kind: 'select', key: '20260101161001' })
  })
  it('対照: カードがまだ無ければ待ち、地震を指さない開き先は none', () => {
    expect(resolveNotificationOpen({ tab: 'earthquake', quake: '20260101190000' }, shown, all)).toEqual({ kind: 'wait' })
    expect(resolveNotificationOpen({ tab: 'realtime' }, shown, all)).toEqual({ kind: 'none' })
  })
  it('安全弁: 取り消されたカードは待たずに諦め、表示の絞りで出ていないカードは出てくるのを待つ', () => {
    expect(resolveNotificationOpen({ tab: 'earthquake', quake: '20260101170000' }, shown, all).kind).toBe('giveUp')
    expect(resolveNotificationOpen({ tab: 'earthquake', quake: '20260101180000' }, shown, all).kind).toBe('hidden')
  })
})

describe('useNotificationOpen', () => {
  const eq = quake('20260101161000')

  it('正: 開いている画面で押されたら、タブを移してその地震を選ぶ', () => {
    const a = actions()
    render(a, { shown: [eq], all: [eq] })
    act(() => emitNotificationOpen({ tab: 'earthquake', quake: '20260101161000' }, 'テスト'))
    expect(a.calls).toEqual(['tab:earthquake', 'quake:20260101161000'])
  })

  it('正: 長周期は地震を選んでから長周期の表示を、推計は選んだカードの分布を開く', () => {
    const a = actions()
    render(a, { shown: [eq], all: [eq] })
    act(() => emitNotificationOpen({ tab: 'earthquake', lpgm: '20260101161000' }, 'テスト'))
    act(() => emitNotificationOpen({ tab: 'earthquake', estimated: '2026-01-01T16:10:00+09:00' }, 'テスト'))
    expect(a.calls).toEqual([
      'tab:earthquake', 'quake:20260101161000', 'lpgm:20260101161000',
      'tab:earthquake', 'quake:20260101161000', 'distribution:20260101161000',
    ])
  })

  it('正: 閉じていて URL に付いて開いたら、読んで移り、URL からは開き先だけを消す', () => {
    window.history.replaceState(null, '', '/?open=realtime&debug=1')
    const a = actions()
    render(a)
    expect(a.calls).toEqual(['tab:realtime'])
    expect(window.location.search).toBe('?debug=1')
  })

  it('安全弁: URL の開き先を読めなければ、消したうえで記録を残す。open の無い URL は触らない', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    window.history.replaceState(null, '', '/?open=earthquake&quake=')
    const first = render(actions())
    expect(window.location.search).toBe('')
    expect(warn).toHaveBeenCalledTimes(1)
    first.unmount()
    window.history.replaceState(null, '', '/?quake=1')
    render(actions())
    expect(window.location.search).toBe('?quake=1')
  })

  it('正: 受け手が付く前に押された開き先は、付いたときに渡す', () => {
    vi.spyOn(log, 'info').mockImplementation(() => {})
    emitNotificationOpen({ tab: 'tsunami' }, 'テスト')
    const a = actions()
    render(a)
    expect(a.calls).toEqual(['tab:tsunami'])
  })

  it('正: カードがまだ無ければ、タブだけ移して待ち、現れたら選ぶ', () => {
    window.history.replaceState(null, '', '/?open=earthquake&quake=20260101161000')
    const a = actions()
    const { rerender } = render(a)
    expect(a.calls).toEqual(['tab:earthquake'])
    rerender({ shown: [eq], all: [eq], screen: screen('earthquake') })
    expect(a.calls).toEqual(['tab:earthquake', 'quake:20260101161000'])
    // 選んだら待ちは外れる（一覧が変わっても選び直さない）
    const other = quake('20260101170000')
    rerender({ shown: [eq, other], all: [eq, other], screen: screen('earthquake') })
    expect(a.calls).toHaveLength(2)
  })

  it('対照: 待つ上限を過ぎてから現れたカードは選ばず、諦めた記録を残す', () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const a = actions()
    const { rerender } = render(a)
    act(() => emitNotificationOpen({ tab: 'earthquake', quake: '20260101161000' }, 'テスト'))
    act(() => { vi.advanceTimersByTime(NOTIFICATION_OPEN_WAIT_MS) })
    expect(warn).toHaveBeenCalledTimes(1)
    rerender({ shown: [eq], all: [eq], screen: screen('earthquake') })
    expect(a.calls).toEqual(['tab:earthquake'])
  })

  it('正: 届いていても絞りで出ていない地震は、後から地震タブに出てきたら選ぶ', () => {
    const a = actions()
    const { rerender } = render(a, { all: [eq] })
    act(() => emitNotificationOpen({ tab: 'earthquake', quake: '20260101161000' }, 'テスト'))
    rerender({ shown: [eq], all: [eq], screen: screen('earthquake') })
    expect(a.calls).toEqual(['tab:earthquake', 'quake:20260101161000'])
  })

  it('安全弁: 待っている間に利用者が地震を選び直したら、届いても通知の地震へ飛ばない', () => {
    vi.spyOn(log, 'info').mockImplementation(() => {})
    const a = actions()
    const { rerender } = render(a)
    act(() => emitNotificationOpen({ tab: 'earthquake', quake: '20260101161000' }, 'テスト'))
    rerender({ shown: [], all: [], screen: screen('earthquake', 1) })
    rerender({ shown: [eq], all: [eq], screen: screen('earthquake', 1) })
    expect(a.calls).toEqual(['tab:earthquake'])
  })

  it('安全弁: 開き先のタブへ移った後に別のタブへ移されたら、届いても通知の地震へ飛ばない', () => {
    vi.spyOn(log, 'info').mockImplementation(() => {})
    const a = actions()
    const { rerender } = render(a)
    act(() => emitNotificationOpen({ tab: 'earthquake', quake: '20260101161000' }, 'テスト'))
    rerender({ shown: [], all: [], screen: screen('earthquake') })
    rerender({ shown: [], all: [], screen: screen('tsunami') })
    rerender({ shown: [eq], all: [eq], screen: screen('tsunami') })
    expect(a.calls).toEqual(['tab:earthquake'])
  })

  it('安全弁: 後から別の通知を押したら、待っていた方は捨てる', () => {
    const a = actions()
    const { rerender } = render(a)
    act(() => emitNotificationOpen({ tab: 'earthquake', quake: '20260101161000' }, 'テスト'))
    act(() => emitNotificationOpen({ tab: 'tsunami' }, 'テスト'))
    rerender({ shown: [eq], all: [eq], screen: screen('tsunami') })
    expect(a.calls).toEqual(['tab:earthquake', 'tab:tsunami'])
  })

  it('安全弁: 受け手が投げても、外へ漏らさず記録し、残りの受け手には渡す', () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => {})
    const a = actions()
    render(a)
    render({ ...actions(), openTab: () => { throw new Error('テスト') } })
    expect(() => act(() => emitNotificationOpen({ tab: 'realtime' }, 'テスト'))).not.toThrow()
    expect(error).toHaveBeenCalledTimes(1)
    expect(a.calls).toEqual(['tab:realtime'])
  })
})
