// @vitest-environment jsdom
//
// 一部の取消（情報名ごとの取消）が届いたら、その地震の行を開く（→ docs/quake-tab-redesign.md
// 「決まっていること」の一部取消の行。2026-11-01 選択「自動で開き、閉じた行には出さない (Recommended)」）。
//
// 閉じた行には一部取消を出さない決まりなので、開かないと取り下げた事実が画面のどこにも現れない。
// **読み上げを切っている端末でも開く** —— 声で伝わらない人ほど画面が唯一の手掛かりになる。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useLiveEventHandler } from './useLiveEventHandler'
import { DEFAULTS, type AppSettings } from './useSettings'
import type { JMAQuake, LiveEventMeta } from '../types/earthquake'

vi.mock('../utils/voicevox', () => ({
  speakWithVoicevox: vi.fn(() => Promise.resolve({ spoke: true, spokenChunks: [] })),
  prewarmVoicevox: vi.fn(() => ({ text: '', first: Promise.resolve(null), abort: vi.fn() })),
  isAudioPlaying: () => false,
}))
vi.mock('../utils/alertSound', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/alertSound')>()
  return { ...actual, playAlertSound: vi.fn() }
})
vi.mock('../utils/notifications', () => ({ showBrowserNotification: vi.fn() }))

const CARD_KEY = 'quake-card-key'

/** 震度速報と震源・震度情報を受け取っているカード（取消が当たる前の姿）。 */
const card: JMAQuake = {
  kind: 'quake',
  id: 'dmdata-quake-20260101120000-2',
  eventId: '20260101120000',
  eventKey: CARD_KEY,
  time: '2026-01-01T12:05:00Z',
  issue: { source: 'JMA', time: '2026-01-01T12:05:00Z', type: '震源・震度情報', correct: 'なし' },
  earthquake: {
    time: '2026-01-01T12:00:00Z',
    hypocenter: { name: '石川県能登地方', latitude: 37.5, longitude: 137.2, depth: 10, magnitude: 6.1 },
    maxScale: 50,
    domesticTsunami: 'なし',
  },
  points: [{ pref: '石川県', addr: '石川県能登', isArea: true, scale: 50 }],
} as JMAQuake

/** 震度速報だけを取り消す電文。 */
const cancelEvent: JMAQuake = {
  ...card,
  id: 'dmdata-quake-20260101120000-cancel',
  cancelled: true,
  cancelText: '震度速報を取り消します。',
  issue: { source: 'JMA', time: '2026-01-01T12:10:00Z', type: '震度速報', correct: 'なし' },
} as JMAQuake

function setup(over: { voicevoxEnabled?: boolean } = {}) {
  const selectQuake = vi.fn()
  const settings = { ...DEFAULTS,
    voicevoxEnabled: over.voicevoxEnabled ?? false, voicevoxUrl: 'http://x', voicevoxSpeakerId: 1,
    soundEnabled: false, notifyQuake: false, notifyEEW: false, notifyTsunami: false, notifyDetection: false,
  } as unknown as AppSettings
  const title = new Proxy({ alertTitle: null } as Record<string, unknown>, {
    get: (t, k) => (k in t ? t[k as string] : vi.fn()),
  })
  const { result } = renderHook(() => useLiveEventHandler({
    settings, title: title as never,
    earthquakesRef: { current: [card] },
    tsunamisRef: { current: [] },
    nankaiActiveRef: { current: false },
    selectQuake, openLpgmFromQuake: vi.fn(), closeDistributionOnQuakeReport: vi.fn(),
    followSpeechTab: vi.fn(), preSpeechTab: vi.fn(() => true), quakeSpeakingCard: null,
    expandPanelForSpecialInfo: vi.fn(), setActiveTabNonRealtime: vi.fn(),
    setActiveTabRealtimeOnUpdate: vi.fn(), setActiveTabRealtimeUrgent: vi.fn(), openEstimatedIntensity: vi.fn(),
  }))
  return {
    selectQuake,
    handle: (meta: LiveEventMeta) => { act(() => { result.current.handleLiveEvent(cancelEvent, meta) }) },
  }
}

const retracted = { issueType: '震度速報' as const, reportTime: '2026-01-01T12:02:00Z' }

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('一部の取消で、その地震の行を開く', () => {
  // 正: 一部の取消なら、取り消されたカードを選ぶ（読み上げを切っていても）
  it('一部の取消が届いたら、そのカードを選ぶ', () => {
    const { handle, selectQuake } = setup()
    handle({ quakeCancel: { target: card, retracted, duplicate: false } })
    expect(selectQuake).toHaveBeenCalledWith(CARD_KEY)
  })

  // 正: 読み上げが有効な端末でも同じ
  it('読み上げが有効でも選ぶ', () => {
    const { handle, selectQuake } = setup({ voicevoxEnabled: true })
    handle({ quakeCancel: { target: card, retracted, duplicate: false } })
    expect(selectQuake).toHaveBeenCalledWith(CARD_KEY)
  })

  // 対照: 地震情報全体の取消ではカードが取消になるので選ばない（取消のカードは選択から外れる）
  it('地震情報全体の取消では選ばない', () => {
    const { handle, selectQuake } = setup()
    handle({ quakeCancel: { target: card, retracted: undefined, duplicate: false } })
    expect(selectQuake).not.toHaveBeenCalled()
  })

  // 安全弁: もう伝えた取消（二重配信）では開き直さない（見ている別のカードを奪わない）
  it('もう伝えた取消では選ばない', () => {
    const { handle, selectQuake } = setup()
    handle({ quakeCancel: { target: card, retracted, duplicate: true } })
    expect(selectQuake).not.toHaveBeenCalled()
  })
})
