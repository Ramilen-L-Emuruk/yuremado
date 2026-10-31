// @vitest-environment jsdom
//
// 揺れ検知の読み上げ（「〇〇で揺れを検知。」）と、他の読み上げとの待ち合わせ。
//
// 揺れ検知は地震情報より重く、EEW より軽い層（`SPEECH_PRIORITY.kyoshinDetect`）。音との間を置いている
// 最中に地震情報の間が明けても、地震情報は**取り下げずに待ち**、検知を言い終えてから読む
// （2026-10-31 ユーザー選択「取り下げず後で読む (Recommended)」）。
//
//   正     : 検知が間を置いている間に間が明けた地震情報は、取り下げられずに検知の後で読まれる
//   対照   : 検知の予約が無ければ、地震情報は間が明けたらそのまま読まれる
//   安全弁 : 待たせている間にリプレイを切り替えたら、待っていた地震情報も読まない（前の時間軸の声を出さない）
//   安全弁 : 検知が間を置いていても、EEW は待たずに読む（重い方は待たせない）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useLiveEventHandler } from './useLiveEventHandler'
import { DEFAULTS, type AppSettings } from './useSettings'
import type { EEWAlert, JMAQuake, JMATsunami } from '../types/earthquake'

const speakMock = vi.fn((..._args: unknown[]) => Promise.resolve({ spoke: true, spokenChunks: [] as string[] }))
vi.mock('../utils/voicevox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/voicevox')>()),
  speakWithVoicevox: (...args: unknown[]) => speakMock(...args),
  prewarmVoicevox: () => null,
  getSpeechClock: () => null,
  stopSpeech: () => {},
  isAudioPlaying: () => false,
}))
vi.mock('../utils/alertSound', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/alertSound')>()
  return { ...actual, playAlertSound: vi.fn() }
})
vi.mock('../utils/notifications', () => ({ showBrowserNotification: vi.fn() }))

const DETECT_TEXT = '石川県能登で揺れを検知。'
/** 地震情報の間（2.8 秒以下）より長く取る —— 地震情報の間が先に明け、検知はまだ間を置いている形を作る */
const DETECT_DELAY_MS = 6000

function spokenTexts(): string[] {
  return speakMock.mock.calls.map(c => c[1] as string)
}

async function flushMicrotasks() {
  for (let i = 0; i < 400; i++) await Promise.resolve()
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
    await flushMicrotasks()
  })
}

type Handler = ReturnType<typeof setup>

async function deliver(h: Handler, event: Parameters<Handler['handleLiveEvent']>[0]) {
  await act(async () => {
    h.handleLiveEvent(event)
    await flushMicrotasks()
  })
}

async function speakDetection(h: Handler) {
  await act(async () => {
    h.speakKyoshinDetection(DETECT_TEXT, DETECT_DELAY_MS)
    await flushMicrotasks()
  })
}

function makeQuake(): JMAQuake {
  return {
    kind: 'quake',
    id: 'quake-震度速報',
    time: '2026-01-01T12:00:00Z',
    issue: { source: 'JMA', time: '2026-01-01T12:00:00Z', type: '震度速報', correct: 'なし' },
    earthquake: {
      time: '2026-01-01T12:00:00Z',
      hypocenter: { name: '石川県能登地方', latitude: 37.5, longitude: 137.2, depth: 10, magnitude: 5.2 },
      maxScale: 40,
      domesticTsunami: 'なし',
    },
    points: [{ pref: '石川県', addr: '石川県能登', isArea: true, scale: 40 }],
  } as unknown as JMAQuake
}

function makeEEW(): EEWAlert {
  return {
    kind: 'eew',
    id: 'eew-1',
    time: '2026-01-01T12:00:00Z',
    test: false,
    earthquake: {
      originTime: '2026-01-01T12:00:00Z',
      arrivalTime: '2026-01-01T12:00:20Z',
      condition: '',
      hypocenter: { name: '日向灘', latitude: 32.0, longitude: 132.0, depth: 30, magnitude: 6.5 },
    },
    severity: 'Warning',
    cancelled: false,
    issue: { eventId: 'evt-1', serial: '1', time: '2026-01-01T12:00:00Z' },
    areas: [],
  } as unknown as EEWAlert
}

function setup() {
  const settings = {
    ...DEFAULTS,
    voicevoxEnabled: true,
    voicevoxUrl: 'http://localhost:50021',
    voicevoxSpeakerId: 1,
    soundEnabled: true,
    soundVolume: 1,
    notifyQuake: false,
    notifyEEW: false,
  } as unknown as AppSettings
  const title = {
    alertTitle: null, setTitle: vi.fn(), setOngoingTitle: vi.fn(), applyPriority: vi.fn(),
    scheduleTitleRevert: vi.fn(), clearTitleTimer: vi.fn(), releaseTitle: vi.fn(),
  }
  const { result } = renderHook(() => useLiveEventHandler({
    settings,
    title: title as never,
    earthquakesRef: { current: [] as JMAQuake[] },
    tsunamisRef: { current: [] as JMATsunami[] },
    nankaiActiveRef: { current: false },
    setActiveTabNonRealtime: vi.fn(),
    setActiveTabRealtimeOnUpdate: vi.fn(),
    setActiveTabRealtimeUrgent: vi.fn(),
    followSpeechTab: vi.fn() as never,
    preSpeechTab: vi.fn(() => true),
    quakeSpeakingCard: null,
    expandPanelForSpecialInfo: vi.fn(),
    selectQuake: vi.fn(),
    openLpgmFromQuake: vi.fn(),
    openEstimatedIntensity: vi.fn(),
    closeDistributionOnQuakeReport: vi.fn(),
    eewSpeakingCard: undefined,
  }))
  return result.current
}

beforeEach(() => {
  vi.useFakeTimers()
  speakMock.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('揺れ検知の読み上げと他の読み上げの待ち合わせ', () => {
  it('正: 検知が間を置いている間に間が明けた地震情報は、取り下げられずに検知の後で読まれる', async () => {
    const h = setup()
    await deliver(h, makeQuake())
    await advance(100)
    await speakDetection(h)
    // 地震情報の間は明けたが、検知がまだ間を置いているので黙って待つ
    await advance(3500)
    expect(spokenTexts()).toEqual([])
    // 検知が鳴り、その後に地震情報が読まれる
    await advance(DETECT_DELAY_MS)
    const texts = spokenTexts()
    expect(texts[0]).toBe(DETECT_TEXT)
    expect(texts.length).toBeGreaterThan(1)
    expect(texts.slice(1).some(t => t.includes('石川県能登'))).toBe(true)
  })

  it('対照: 検知の予約が無ければ、地震情報は間が明けたらそのまま読まれる', async () => {
    const h = setup()
    await deliver(h, makeQuake())
    await advance(3500)
    const texts = spokenTexts()
    expect(texts.length).toBeGreaterThan(0)
    expect(texts).not.toContain(DETECT_TEXT)
  })

  it('安全弁: 待たせている間にリプレイを切り替えたら、待っていた地震情報も読まない', async () => {
    const h = setup()
    await deliver(h, makeQuake())
    await advance(100)
    await speakDetection(h)
    // 地震情報は間が明けて検知を待っている
    await advance(3500)
    expect(spokenTexts()).toEqual([])
    // 時間軸を切り替える（検知の予約は取り消され、待っていた地震情報は前の時間軸のもの）
    await act(async () => {
      h.resetTracking()
      await flushMicrotasks()
    })
    await advance(DETECT_DELAY_MS + 2000)
    expect(spokenTexts()).toEqual([])
  })

  it('安全弁: 検知が間を置いていても、EEW は待たずに読む', async () => {
    const h = setup()
    await speakDetection(h)
    await advance(100)
    await deliver(h, makeEEW())
    // 検知の間（6 秒）が明けるより前に EEW が読まれている
    await advance(2000)
    expect(spokenTexts()[0]).toBe('緊急地震速報、日向灘で地震。')
  })
})
