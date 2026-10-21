// @vitest-environment jsdom
//
// 津波情報（VTSE51）だけの取消を受けたときの、受信処理の記憶の扱いを固定するテスト。
//
// 1. 名前は残っても**値が取消前と変わった観測点**は、読み上げの記憶を落とす（取り消された値を
//    「もう伝えた」まま残すと、いまの値が届いても声にならない）
// 2. 組み直す報が残らない取消（カードは消える）は、解除と同じく記憶を落とす
import type { SpeechOutcome } from '../utils/voicevox'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useLiveEventHandler } from './useLiveEventHandler'
import { DEFAULTS, type AppSettings } from './useSettings'
import type { JMAQuake, JMATsunami } from '../types/earthquake'
import { drainReplayEvents } from '../utils/replayEventLog'

const speeches: { text: string; finish: () => void; done: boolean }[] = []
const speakMock = vi.fn((_url: string, text: string) => {
  for (const s of speeches) {
    if (!s.done) { s.done = true; s.finish() }
  }
  let finish!: () => void
  const p = new Promise<SpeechOutcome>(r => { finish = () => r({ spoke: true, spokenChunks: [text] }) })
  speeches.push({ text, finish, done: false })
  return p
})
vi.mock('../utils/voicevox', () => ({
  speakWithVoicevox: (...args: unknown[]) => speakMock(...(args as [string, string])),
  prewarmVoicevox: () => null,
  getSpeechClock: () => null,
}))
vi.mock('../utils/alertSound', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/alertSound')>()
  return { ...actual, playAlertSound: vi.fn() }
})
vi.mock('../utils/notifications', () => ({ showBrowserNotification: vi.fn() }))

const A = '20260101120000'
const B = '20260101121500'
const at = (min: number) => `2026-01-01T12:${String(min).padStart(2, '0')}:00+09:00`

async function flush() {
  for (let i = 0; i < 400; i++) await Promise.resolve()
}

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000)
    await flush()
    for (const s of speeches) if (!s.done) { s.done = true; s.finish() }
    await flush()
  })
}

function spokenTexts(): string[] {
  return speeches.map(s => s.text)
}

function warning(): JMATsunami {
  return {
    kind: 'tsunami', id: 'w-1', eventId: A, headType: 'VTSE41', time: at(0), cancelled: false,
    issue: { source: 'JMA', time: at(0), type: 'Focus' },
    areas: [{ name: '石川県能登', code: '360', grade: 'Warning', immediate: false }],
  } as unknown as JMATsunami
}

function obsReport(id: string, eventId: string, minute: number, value: number): JMATsunami {
  return {
    kind: 'tsunami', id, eventId, headType: 'VTSE51', time: at(minute), cancelled: false,
    issue: { source: 'JMA', time: at(minute), type: 'Focus' },
    areas: [],
    observations: [{ name: '輪島港', districtCode: '360', districtName: '石川県能登', height: { value, description: `${value}m` } }],
  } as unknown as JMATsunami
}

function retraction(eventId: string, minute: number): JMATsunami {
  return {
    kind: 'tsunami', id: `r-${eventId}`, eventId, headType: 'VTSE51', time: at(minute), cancelled: true, cancelReason: 'retracted',
    issue: { source: 'JMA', time: at(minute), type: 'Focus' },
    areas: [],
  } as unknown as JMATsunami
}

function setup() {
  const settings = { ...DEFAULTS,
    voicevoxEnabled: true, voicevoxUrl: 'http://x', voicevoxSpeakerId: 1,
    soundEnabled: false, soundVolume: 1, notifyMinScale: -1,
    notifyEEW: false, notifyTsunami: false, notifyDetection: false,
    ttsIntensityLevels: [], ttsMaxRegions: 0, ttsAlwaysReadScale: 0, ttsRegionTolerance: 0,
    minDisplayScale: -1,
  } as unknown as AppSettings
  const title = new Proxy({ alertTitle: null } as Record<string, unknown>, {
    get: (t, k) => (k in t ? t[k as string] : vi.fn()),
  })
  const { result } = renderHook(() => useLiveEventHandler({
    settings, title: title as never,
    earthquakesRef: { current: [] as JMAQuake[] },
    tsunamisRef: { current: [] },
    kyoshinDetectedRef: { current: false },
    defaultTabRef: { current: 'earthquake' },
    setActiveTabRealtimeForKyoshin: vi.fn(), setActiveTabNonRealtime: vi.fn(),
    setActiveTabRealtimeOnUpdate: vi.fn(),
    setActiveTabRealtimeUrgent: vi.fn(), followSpeechTab: vi.fn(), preSpeechTab: vi.fn(() => true),
    quakeSpeakingCard: null,
    expandPanelForSpecialInfo: vi.fn(), revertToDefaultTab: vi.fn(),
    selectQuake: vi.fn(), openLpgmFromQuake: vi.fn(), openEstimatedIntensity: vi.fn(), closeDistributionOnQuakeReport: vi.fn(),
  }))
  const handle = (event: JMATsunami) => { act(() => { result.current.handleLiveEvent(event as never) }) }
  return Object.assign(handle, { result })
}

function tsunamiAlerts(): { change: string; grade: string | null }[] {
  return drainReplayEvents().events
    .filter((e): e is Extract<typeof e, { type: 'alert' }> => e.type === 'alert' && e.category === 'tsunami')
    .map(e => ({ change: e.change, grade: e.grade }))
}

beforeEach(() => {
  vi.useFakeTimers()
  drainReplayEvents()
  speeches.length = 0
  speakMock.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('津波情報だけの取消: 観測点の読み上げの記憶', () => {
  // 正: 取り消された報が観測点の値を上書きしていたら、名前が残っても記憶を落とす。
  // 「A B」の単位の報（0.3m）のあとに「A」の単位の報（1.2m）が届き、「A」の取消で 1.2m だけが取り消される。
  // 気象庁がいまの値として 1.2m を出し直したら、もう一度読む（記憶が 1.2m のままだと黙る）。
  it('値が取消前と変わった観測点は、出し直された値を読む', async () => {
    const handle = setup()
    handle(warning())
    await settle()
    handle(obsReport('o-1', `${A} ${B}`, 5, 0.3))
    await settle()
    handle(obsReport('o-2', A, 10, 1.2))
    await settle()
    expect(spokenTexts().join('')).toContain('輪島港で1.2メートルへ更新されました。')
    const before = speeches.length
    handle(retraction(A, 12))
    await settle()
    handle(obsReport('o-3', A, 14, 1.2))
    await settle()
    expect(spokenTexts().slice(before).join('')).toContain('輪島港で1.2メートル')
  })

  // 対照: 値が変わらず残った観測点は記憶を残す（同じ値を読み直さない）。
  it('値が取消前と同じまま残った観測点は読み直さない', async () => {
    const handle = setup()
    handle(warning())
    await settle()
    handle(obsReport('o-1', `${A} ${B}`, 5, 1.2))
    await settle()
    handle(obsReport('o-2', A, 10, 1.2))
    await settle()
    const before = speeches.length
    handle(retraction(A, 12))
    await settle()
    handle(obsReport('o-3', `${A} ${B}`, 14, 1.2))
    await settle()
    expect(spokenTexts().slice(before).join('')).not.toContain('輪島港で1.2メートル')
  })
})

describe('津波情報だけの取消: 組み直す報が残らないとき', () => {
  // 正: 津波情報だけで組み立てていた津波（警報等を受けていない）の取消は、解除と同じく記憶を落とす。
  // 同じ観測点が新しい津波で届いたら、初出として読む。
  it('記憶を解除と同じく落とし、次の津波で観測点を初出として読む', async () => {
    const handle = setup()
    handle(obsReport('o-1', A, 5, 0.3))
    await settle()
    drainReplayEvents()
    handle(retraction(A, 8))
    await settle()
    // 解除と同じ後始末を通る（カードの位置を先頭へ戻す・録画ツールへは取消として残す）
    expect(handle.result.current.focusedDistrict?.resetToTop).toBe(true)
    expect(tsunamiAlerts()).toEqual([{ change: 'retracted', grade: null }])
    const before = speeches.length
    handle(obsReport('o-2', B, 20, 0.3))
    await settle()
    expect(spokenTexts().slice(before).join('')).toContain('新たに、次の地点で津波を観測しました。石川県能登、輪島港で0.3メートルを観測しました。')
  })
})

describe('津波情報だけの取消: 録画ツール向けの記録', () => {
  // 正: 組み直した津波の等級が動いたら、動いた向きを残す
  it('取り消した報だけが等級を上げていたら、引き下げとして残す', async () => {
    const handle = setup()
    handle(warning())
    await settle()
    const major: JMATsunami = {
      ...obsReport('o-1', A, 5, 0.3),
      areas: [{ name: '石川県能登', code: '360', grade: 'MajorWarning', immediate: false }],
    } as unknown as JMATsunami
    handle(major)
    await settle()
    drainReplayEvents()
    handle(retraction(A, 8))
    await settle()
    expect(tsunamiAlerts()).toEqual([{ change: 'downgraded', grade: 'Warning' }])
  })

  // 対照: 等級が動かない一部取消は `alert` に出さない（全体の等級が動いたときだけ出す規約）
  it('等級が動かない一部取消は記録しない', async () => {
    const handle = setup()
    handle(warning())
    await settle()
    handle(obsReport('o-1', A, 5, 0.3))
    await settle()
    drainReplayEvents()
    handle(retraction(A, 8))
    await settle()
    expect(tsunamiAlerts()).toEqual([])
  })
})

describe('有効期限の過ぎた報', () => {
  const expired = (): JMATsunami => ({
    ...warning(), id: 'w-old', headType: 'VTSE41', validDateTime: '2000-01-01T00:00:00+09:00',
    areas: [{ name: '石川県能登', code: '360', grade: 'Forecast', immediate: false }],
  } as unknown as JMATsunami)

  // 正: 画面が外す津波は声でも伝えない
  it('届いた時点で期限の過ぎた報は読み上げない', async () => {
    const handle = setup()
    handle(expired())
    await settle()
    expect(spokenTexts()).toEqual([])
  })

  // 正: 終わった津波として記憶を落とす。次の津波で同じ観測点が同じ値で届いても読む
  it('期限の過ぎた報で記憶を落とし、次の津波の同じ観測点を読む', async () => {
    const handle = setup()
    handle(warning())
    await settle()
    handle(obsReport('o-1', A, 5, 0.3))
    await settle()
    handle(expired())
    await settle()
    handle({ ...warning(), id: 'w-2', eventId: B } as unknown as JMATsunami)
    await settle()
    handle(obsReport('o-2', B, 20, 0.3))
    await settle()
    expect(spokenTexts().filter(t => t.includes('輪島港'))).toHaveLength(2)
  })

  // 安全弁: 生きている別の津波へ期限切れの古い報が届いても、その津波の記憶は落とさない（読み直さない）
  it('生きている別の津波の記憶は、期限切れの古い報で落とさない', async () => {
    const handle = setup()
    handle(warning())
    await settle()
    handle(obsReport('o-1', A, 5, 0.3))
    await settle()
    handle({ ...expired(), id: 'w-other', eventId: B } as unknown as JMATsunami)
    await settle()
    handle(obsReport('o-2', A, 10, 0.3))
    await settle()
    expect(spokenTexts().filter(t => t.includes('輪島港'))).toHaveLength(1)
  })

  // 対照: 期限がまだ先の報はふだんどおり読む
  it('期限がまだ先の報は読む', async () => {
    const handle = setup()
    handle({ ...expired(), validDateTime: '2099-01-01T00:00:00+09:00' } as unknown as JMATsunami)
    await settle()
    expect(spokenTexts().length).toBeGreaterThan(0)
  })
})
