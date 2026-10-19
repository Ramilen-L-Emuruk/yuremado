// @vitest-environment jsdom
//
// 津波のブラウザ通知を受け手の結線ごと固定するテスト。中身の組み立ては `utils/tsunamiNotification.test.ts`。
// ここで守るのは、**どの報で何が `showBrowserNotification` に渡るか**（材料・解除の報・送らない報）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useLiveEventHandler } from './useLiveEventHandler'
import { DEFAULTS, type AppSettings } from './useSettings'
import { showBrowserNotification } from '../utils/notifications'
import type { JMAQuake, JMATsunami, TsunamiArea, TsunamiGrade } from '../types/earthquake'

vi.mock('../utils/voicevox', () => ({
  speakWithVoicevox: vi.fn(() => Promise.resolve({ spoke: true, spokenChunks: [] })),
  prewarmVoicevox: () => null,
  getSpeechClock: () => null,
}))
vi.mock('../utils/alertSound', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/alertSound')>()
  return { ...actual, playAlertSound: vi.fn() }
})
vi.mock('../utils/notifications', () => ({ showBrowserNotification: vi.fn() }))

const notify = vi.mocked(showBrowserNotification)

const area = (name: string, code: string, grade: TsunamiGrade, lastGrade?: TsunamiGrade): TsunamiArea =>
  ({ name, code, grade, ...(lastGrade && { lastGrade }), immediate: false } as TsunamiArea)

let serial = 0
function report(areas: TsunamiArea[], extra: Partial<JMATsunami> = {}): JMATsunami {
  serial += 1
  return {
    kind: 'tsunami', id: `tsunami-${serial}`, eventId: '20240101161010', time: '2024-01-01T16:22:00+09:00',
    cancelled: false, issue: { source: '気象庁', time: '2024-01-01T16:22:00+09:00', type: 'Focus' },
    areas, ...extra,
  }
}

function setup(notifyTsunami = true) {
  const settings = { ...DEFAULTS,
    voicevoxEnabled: false, soundEnabled: false, notifyMinScale: 0,
    notifyEEW: false, notifyTsunami, notifyDetection: false, minDisplayScale: -1,
  } as unknown as AppSettings
  const title = new Proxy({ alertTitle: null } as Record<string, unknown>, {
    get: (t, k) => (k in t ? t[k as string] : vi.fn()),
  })
  const displayed: JMATsunami[] = []
  const { result } = renderHook(() => useLiveEventHandler({
    settings, title: title as never,
    earthquakesRef: { current: [] as JMAQuake[] },
    tsunamisRef: { current: displayed },
    kyoshinDetectedRef: { current: false },
    defaultTabRef: { current: 'earthquake' },
    setActiveTabRealtimeForKyoshin: vi.fn(), setActiveTabNonRealtime: vi.fn(),
    setActiveTabRealtimeOnUpdate: vi.fn(),
    setActiveTabRealtimeUrgent: vi.fn(), followSpeechTab: vi.fn(), preSpeechTab: vi.fn(() => true),
    quakeSpeakingCard: null,
    expandPanelForSpecialInfo: vi.fn(), revertToDefaultTab: vi.fn(),
    selectQuake: vi.fn(), openLpgmFromQuake: vi.fn(), openEstimatedIntensity: vi.fn(), closeDistributionOnQuakeReport: vi.fn(),
  }))
  const handle = (t: JMATsunami) => {
    act(() => { result.current.handleLiveEvent(t as never) })
    if (!t.cancelled) displayed[0] = t
  }
  return { handle }
}

beforeEach(() => {
  vi.useFakeTimers()
  serial = 0
  notify.mockClear()
})
afterEach(() => { vi.useRealTimers() })

describe('津波のブラウザ通知（受け手）', () => {
  it('正: 一部解除の報で、発表中の区域と「解除：」の行を送る', () => {
    const { handle } = setup()
    handle(report([area('石川県能登', '360', 'Watch'), area('青森県日本海沿岸', '200', 'Watch')]))
    notify.mockClear()
    handle(report([area('石川県能登', '360', 'Watch', 'Watch')], {
      cancelledAreas: [area('青森県日本海沿岸', '200', 'Unknown', 'Watch')],
    }))
    expect(notify).toHaveBeenCalledWith('津波注意報', '石川県能登\n解除：青森県日本海沿岸', 'tsunami', true)
  })

  it('対照: 津波予報だけの報は閉じるまで残さない', () => {
    const { handle } = setup()
    handle(report([area('石川県能登', '360', 'Forecast')]))
    expect(notify).toHaveBeenCalledWith('津波予報（若干の海面変動）', '石川県能登', 'tsunami', false)
  })

  // 2026-10-19 ユーザー選択「送る (Recommended)」
  it('正: 全区域解除の報で、気象庁の文を本文にして送る', () => {
    const { handle } = setup()
    handle(report([area('石川県能登', '360', 'Watch')]))
    notify.mockClear()
    const text = '現在、大津波警報・津波警報・津波注意報を発表している沿岸はありません。'
    handle(report([], { cancelled: true, cancelReason: 'lifted', warningComments: [{ key: 'VTSE41', text }] } as Partial<JMATsunami>))
    expect(notify).toHaveBeenCalledWith('津波警報等の解除', text, 'tsunami', false)
  })

  it('安全弁: 同じ解除が 2 度届いても 1 回だけ送る', () => {
    const { handle } = setup()
    handle(report([area('石川県能登', '360', 'Watch')]))
    notify.mockClear()
    const lift = { cancelled: true, cancelReason: 'lifted' } as Partial<JMATsunami>
    handle(report([], lift))
    handle(report([], lift))
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('安全弁: 誤報の取消と失効は通知しない（問うたのは全区域解除だけ）', () => {
    const { handle } = setup()
    handle(report([area('石川県能登', '360', 'Watch')]))
    notify.mockClear()
    handle(report([], { cancelled: true, cancelReason: 'retracted', headType: 'VTSE41' } as Partial<JMATsunami>))
    handle(report([], { cancelled: true, cancelReason: 'expired', eventId: '20240102000000' } as Partial<JMATsunami>))
    expect(notify).not.toHaveBeenCalled()
  })

  // 通知は発表中の通知と tag が同じ。別の津波の解除で、閉じるまで残していた警報の通知を「解除」へ置き換えない
  it('安全弁: 表示中の津波と別の津波の解除では通知しない', () => {
    const { handle } = setup()
    handle(report([area('石川県能登', '360', 'Warning')]))
    notify.mockClear()
    handle(report([], { eventId: '20240102000000', cancelled: true, cancelReason: 'lifted' } as Partial<JMATsunami>))
    expect(notify).not.toHaveBeenCalled()
  })

  // 受信処理が表示中の津波を覚えていない（リロード直後など）ときの解除は照合で弾かない。照合を
  // 「覚えている津波があるときだけ」へ寄せると、この解除の通知が黙って出なくなる。
  // なお失効で閉じた後に届く同じ津波の解除は、読み上げと同じ既読の判定（`tsunamiCancelKey`）で音・声ごと黙る
  it('正: 覚えている津波が無いときに届いた解除でも送る', () => {
    const { handle } = setup()
    handle(report([], { cancelled: true, cancelReason: 'lifted' } as Partial<JMATsunami>))
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).toBe('津波警報等の解除')
  })

  // P2PQuake など理由を持たない解除は、画面と同じく解除へ倒す
  it('正: 理由を持たない解除は解除として送る', () => {
    const { handle } = setup()
    handle(report([area('石川県能登', '360', 'Watch')]))
    notify.mockClear()
    handle(report([], { cancelled: true } as Partial<JMATsunami>))
    expect(notify).toHaveBeenCalledWith('津波警報等の解除', '津波警報等は全て解除されました。', 'tsunami', false)
  })

  it('対照: 等級を読めなかった区域だけの報は閉じるまで残さない', () => {
    const { handle } = setup()
    handle(report([area('石川県能登', '360', 'Unknown')]))
    expect(notify.mock.calls[0]?.[3]).toBe(false)
  })

  it('安全弁: 区域を載せない報（観測情報だけ）は通知しない', () => {
    const { handle } = setup()
    handle(report([area('石川県能登', '360', 'Watch')]))
    notify.mockClear()
    handle(report([]))
    expect(notify).not.toHaveBeenCalled()
  })

  it('安全弁: 津波の通知を切った端末では解除も送らない', () => {
    const { handle } = setup(false)
    handle(report([area('石川県能登', '360', 'Watch')]))
    handle(report([], { cancelled: true, cancelReason: 'lifted' } as Partial<JMATsunami>))
    expect(notify).not.toHaveBeenCalled()
  })
})
