// @vitest-environment jsdom
//
// 揺れ検知のブラウザ通知を、確定後に揺れが強まったら書き換えることのテスト
// （2026-10-22 ユーザー選択「強まったら通知し直す (Recommended)」。likely での通知・寄せは今のまま）。
// あわせて、揺れ検知の通知が地震情報の通知の設定に従わないことも固定する（2026-10-22 ユーザー選択
// 「3 種を切り離す (Recommended)」）。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useKyoshinAlerts, type KyoshinAlertsDeps } from './useKyoshinAlerts'
import { showBrowserNotification } from '../utils/notifications'
import { DEFAULTS, type AppSettings } from './useSettings'
import type { AlertTitleApi } from './useAlertTitle'
import type { EEWAlert } from '../types/earthquake'
import type { TabId } from '../components/IconNav'

vi.mock('../utils/alertSound', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/alertSound')>()
  return { ...actual, playAlertSound: vi.fn(), playKyoshinUpdateSound: vi.fn() }
})
vi.mock('../utils/notifications', () => ({ showBrowserNotification: vi.fn() }))

const notify = vi.mocked(showBrowserNotification)

// index は強震モニタの色の段（13≒震度3・16≒震度5弱・19≒震度6強）。音の段（kyoshinLevel）が上がる値を選ぶ
const shock = (index: number) => ({ lat: 37.5, lng: 137.0, index, peak: { lat: 37.45, lng: 137.15 }, points: [] })

function makeDeps(over: Partial<KyoshinAlertsDeps> = {}, settings: Partial<AppSettings> = {}): KyoshinAlertsDeps {
  return {
    confirmed: false,
    candidate: false,
    candidateMaxIndex: 0,
    confirmedShocks: [],
    dataTime: '',
    stalled: false,
    // 地震情報の通知は切ってある（-1）。揺れ検知の通知はそれに従わない
    settings: { ...DEFAULTS, soundEnabled: false, notifyDetection: true, ...settings },
    title: { setTitle: vi.fn(), setOngoingTitle: vi.fn(), applyPriority: vi.fn() } as unknown as AlertTitleApi,
    activeEEWsRef: { current: new Map<string, EEWAlert>() },
    defaultTabRef: { current: 'earthquake' as TabId },
    setActiveTab: vi.fn(),
    revertToDefaultTab: vi.fn(),
    onShakeFocus: vi.fn(),
    reonset: null,
    detectedPoints: [],
    speakDetection: () => {},
    ...over,
  }
}

describe('useKyoshinAlerts: 確定後に強まったら通知を書き換える', () => {
  beforeEach(() => { notify.mockClear() })

  it('[正] 確定中に強まると、同じ札で新しい最大リアルタイム震度の通知を出す', () => {
    const { rerender } = renderHook((p: KyoshinAlertsDeps) => useKyoshinAlerts(p), {
      initialProps: makeDeps({ confirmed: true, confirmedShocks: [shock(13)] }),
    })
    expect(notify).toHaveBeenCalledTimes(1)
    const first = notify.mock.calls[0]
    rerender(makeDeps({ confirmed: true, confirmedShocks: [shock(19)] }))
    expect(notify).toHaveBeenCalledTimes(2)
    const second = notify.mock.calls[1]
    expect(second[0]).toBe('揺れを検知中')
    expect(second[2]).toBe('kyoshin-detection')
    expect(second[1]).not.toBe(first[1])
  })

  it('[対照] 揺れの可能性（likely）で強まっても通知は出さない', () => {
    const { rerender } = renderHook((p: KyoshinAlertsDeps) => useKyoshinAlerts(p), {
      initialProps: makeDeps({ candidate: true, candidateMaxIndex: 13 }),
    })
    rerender(makeDeps({ candidate: true, candidateMaxIndex: 19 }))
    expect(notify).not.toHaveBeenCalled()
  })

  it('[安全弁] 揺れの可能性から確定へ上がった瞬間は、開始の通知 1 回だけ（同じ値で二重に出さない）', () => {
    const { rerender } = renderHook((p: KyoshinAlertsDeps) => useKyoshinAlerts(p), {
      initialProps: makeDeps({ candidate: true, candidateMaxIndex: 13 }),
    })
    rerender(makeDeps({ confirmed: true, confirmedShocks: [shock(19)] }))
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('[安全弁] 揺れ検知の通知を切っていれば、強まっても出さない', () => {
    const { rerender } = renderHook((p: KyoshinAlertsDeps) => useKyoshinAlerts(p), {
      initialProps: makeDeps({ confirmed: true, confirmedShocks: [shock(13)] }, { notifyDetection: false }),
    })
    rerender(makeDeps({ confirmed: true, confirmedShocks: [shock(19)] }, { notifyDetection: false }))
    expect(notify).not.toHaveBeenCalled()
  })
})
