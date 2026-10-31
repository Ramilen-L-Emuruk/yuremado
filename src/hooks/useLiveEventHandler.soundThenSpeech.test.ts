// @vitest-environment jsdom
//
// 通知音が鳴り終わってから読み上げを始めること（2026-10-31 ユーザー指示「効果音がなりおわってから
// 読み上げるようにしてくださいね」）。
//
// **このファイルだけが AudioContext を持つ世界で走る。** 待ちは AudioContext の時計で測るので、
// 他のテスト（jsdom には AudioContext が無い）では一度も効かない。しかも `alertSound` は一度作った
// AudioContext を使い回すため、他のファイルへ混ぜると後のテストまで時計の止まった世界になる。
//
//   正     : EEW の発報は、音が鳴り終わる（AudioContext の時計が届く）まで声を出さない
//   対照   : 音を鳴らさない設定では待たない（待つ相手がいない）
//   安全弁 : 音声出力が止まって時計が進まなくても、上限で諦めて読む（黙ったままにしない）
//   正     : 地震情報の間は、壁時計が明けても音の頭の遅れの分だけ待ち足す
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useLiveEventHandler } from './useLiveEventHandler'
import { DEFAULTS, type AppSettings } from './useSettings'
import { ttsDelayFor, SOUND_AUDIBLE_END_MS, getAudioContext } from '../utils/alertSound'
import type { EEWAlert, JMAQuake, JMATsunami } from '../types/earthquake'

/** 時計を手で進める AudioContext。`suspended` の間は進めない（止まった音声出力を模す）。 */
class FakeAudioContext {
  currentTime = 10
  state = 'running'
  resume(): Promise<void> { return Promise.resolve() }
}
const fakeCtx = new FakeAudioContext()

beforeAll(() => {
  ;(window as unknown as { AudioContext: unknown }).AudioContext =
    function FakeCtor(this: unknown) { return fakeCtx } as unknown as typeof FakeAudioContext
  // 音の実体（playAlertSound）は差し替えてあるので、本物なら音を鳴らすときに作られる AudioContext を
  // ここで作っておく（声を出してよい時刻は、作られた AudioContext の時計で数える）
  getAudioContext()
})

const speakMock = vi.fn((..._args: unknown[]) => Promise.resolve({ spoke: true, spokenChunks: [] as string[] }))
vi.mock('../utils/voicevox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/voicevox')>()),
  speakWithVoicevox: (...args: unknown[]) => speakMock(...args),
  prewarmVoicevox: () => null,
  getSpeechClock: () => null,
  stopSpeech: () => {},
  isAudioPlaying: () => false,
}))
// 音の実体だけ差し替える。間の長さ・声を出してよい時刻の計算は本物を使う
vi.mock('../utils/alertSound', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/alertSound')>()
  return { ...actual, playAlertSound: vi.fn() }
})
vi.mock('../utils/notifications', () => ({ showBrowserNotification: vi.fn() }))

function spokenTexts(): string[] {
  return speakMock.mock.calls.map(c => c[1] as string)
}

async function flushMicrotasks() {
  for (let i = 0; i < 400; i++) await Promise.resolve()
}

/** 壁時計と AudioContext の時計を一緒に進める（`frozen` なら AudioContext は止めたまま）。 */
async function advance(ms: number, frozen = false) {
  if (!frozen) fakeCtx.currentTime += ms / 1000
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
    await flushMicrotasks()
  })
}

/** 電文を届ける（React を更新するので act() で包む）。 */
async function deliver(h: ReturnType<typeof setup>, event: Parameters<ReturnType<typeof setup>['handleLiveEvent']>[0]) {
  await act(async () => {
    h.handleLiveEvent(event)
    await flushMicrotasks()
  })
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

function setup(over: Partial<AppSettings> = {}) {
  const settings = {
    ...DEFAULTS,
    voicevoxEnabled: true,
    voicevoxUrl: 'http://localhost:50021',
    voicevoxSpeakerId: 1,
    soundEnabled: true,
    soundVolume: 1,
    notifyQuake: false,
    notifyEEW: false,
    ...over,
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
  fakeCtx.currentTime = 10
})

afterEach(() => {
  vi.useRealTimers()
})

describe('通知音が鳴り終わってから読み上げる', () => {
  const eewWaitMs = ttsDelayFor('eew') // 発報の音（1000ms）

  it('正: EEW の発報は、音が鳴り終わるまで声を出さない', async () => {
    const h = setup()
    await deliver(h, makeEEW())
    expect(spokenTexts()).toEqual([])
    // 音の途中ではまだ黙っている
    await advance(eewWaitMs - 100)
    expect(spokenTexts()).toEqual([])
    // 鳴り終わり（＋音の頭の先送り）を過ぎたら読む
    await advance(200)
    expect(spokenTexts()[0]).toBe('緊急地震速報、日向灘で地震。')
  })

  it('対照: 音を鳴らさない設定では待たずに読む', async () => {
    const h = setup({ soundEnabled: false })
    await deliver(h, makeEEW())
    expect(spokenTexts()[0]).toBe('緊急地震速報、日向灘で地震。')
  })

  it('安全弁: 音声出力が止まって時計が進まなくても、上限で諦めて読む', async () => {
    const h = setup()
    await deliver(h, makeEEW())
    // 時計を止めたまま、音の長さを過ぎても黙っている
    await advance(eewWaitMs + 1000, true)
    expect(spokenTexts()).toEqual([])
    // 上限（音の長さ＋3 秒）を過ぎたら、待つのをやめて読む
    await advance(3000, true)
    expect(spokenTexts()[0]).toBe('緊急地震速報、日向灘で地震。')
  })

  it('正: 地震情報の間は、音の頭が遅れた分だけ壁時計の後に待ち足す', async () => {
    // 震度速報（音は earthquake）を、AudioContext の時計を止めたまま受ける ——
    // 止まっていた音声出力が再開を待っている状態。壁時計の間が明けても音はまだ鳴っていない
    const h = setup()
    await deliver(h, {
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
    } as unknown as JMAQuake)
    await advance(SOUND_AUDIBLE_END_MS.earthquakePrompt + 200, true)
    expect(spokenTexts()).toEqual([])
    // 音声出力が戻って時計が進めば、音の分だけ待ってから読む
    await advance(SOUND_AUDIBLE_END_MS.earthquakePrompt + 100)
    expect(spokenTexts().length).toBeGreaterThan(0)
  })

  it('安全弁: 一度も再開できていない出力（suspended）では、壁時計の間だけで読む', async () => {
    // 自動再生の制限で止まったままの出力は時計が進まない。待ち足すと読み上げのたびに上限（3 秒）まで遅れる
    fakeCtx.state = 'suspended'
    try {
      const h = setup()
      await deliver(h, makeEEW())
      await advance(eewWaitMs + 100, true)
      expect(spokenTexts()[0]).toBe('緊急地震速報、日向灘で地震。')
    } finally {
      fakeCtx.state = 'running'
    }
  })
})
