// @vitest-environment jsdom
//
// 等級は据え置きのまま予想波高だけが動いた津波警報等（VTSE41）の続報を、フックの結線ごと固定するテスト。
// 文の組み立ては `ttsText.test.ts`、変化の抽出は `tsunami.test.ts` が見ている。ここで守るのは 3 点。
//
// 1. **動いた区域だけを読むこと**（従来は観測点を運ばない続報として黙っていた）
// 2. **同じ値を載せ続ける続報で読み直さないこと**（基準は声にした予想波高）
// 3. **津波情報（VTSE51/52）では読まないこと**（予想波高を伝える電文は津波警報等だけ）
import type { SpeechOutcome } from '../utils/voicevox'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useLiveEventHandler } from './useLiveEventHandler'
import { DEFAULTS, type AppSettings } from './useSettings'
import type { JMAQuake, JMATsunami, TsunamiArea, TsunamiGrade, TsunamiHeadType } from '../types/earthquake'

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

const spokenTexts = (): string[] => speeches.map(s => s.text)

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

type AreaSpec = { name: string; code: string; grade: TsunamiGrade; lastGrade?: TsunamiGrade; height?: string; revise?: string }

let serial = 0

function makeReport(areas: AreaSpec[], headType: TsunamiHeadType = 'VTSE41'): JMATsunami {
  serial += 1
  return {
    kind: 'tsunami',
    id: `tsunami-${serial}`,
    eventId: '20110311144640',
    headType,
    time: '2026-01-01T12:00:00Z',
    cancelled: false,
    issue: { source: 'JMA', time: '2026-01-01T12:00:00Z', type: 'Focus' },
    areas: areas.map(({ height, revise, ...a }) => ({
      ...a,
      immediate: false,
      ...(height !== undefined && { maxHeight: { description: height, ...(revise && { revise }) } }),
    } as TsunamiArea)),
    observations: [],
  } as JMATsunami
}

// 2011 東北の気象庁サンプル 14:53 → 15:00 の形を縮めたもの（等級は同じまま、予想波高だけが動く）
const ISSUED: AreaSpec[] = [
  { name: '岩手県', code: '210', grade: 'MajorWarning', height: '巨大' },
  { name: '宮城県', code: '220', grade: 'MajorWarning', height: '巨大' },
  { name: '茨城県', code: '300', grade: 'Warning', height: '高い' },
]
const UPDATED: AreaSpec[] = [
  { name: '岩手県', code: '210', grade: 'MajorWarning', lastGrade: 'MajorWarning', height: '5m', revise: '更新' },
  { name: '宮城県', code: '220', grade: 'MajorWarning', lastGrade: 'MajorWarning', height: '巨大' },
  { name: '茨城県', code: '300', grade: 'Warning', lastGrade: 'Warning', height: '3m', revise: '更新' },
]

function setup() {
  const settings = { ...DEFAULTS,
    voicevoxEnabled: true, voicevoxUrl: 'http://x', voicevoxSpeakerId: 1,
    soundEnabled: false, soundVolume: 1, notifyQuake: false,
    notifyEEW: false, notifyTsunami: false, notifyDetection: false,
    ttsIntensityLevels: [], ttsMaxRegions: 0, ttsAlwaysReadScale: 0, ttsRegionTolerance: 0,
    minDisplayScale: -1,
  } as unknown as AppSettings
  const title = new Proxy({ alertTitle: null } as Record<string, unknown>, {
    get: (t, k) => (k in t ? t[k as string] : vi.fn()),
  })
  // App が画面に出している津波。空のままだと毎報が「新規発報」と判定される（→ 区域の等級変化テスト）。
  const displayed: JMATsunami[] = []
  const { result } = renderHook(() => useLiveEventHandler({
    settings, title: title as never,
    earthquakesRef: { current: [] as JMAQuake[] },
    tsunamisRef: { current: displayed },
    nankaiActiveRef: { current: false },
    setActiveTabNonRealtime: vi.fn(),
    setActiveTabRealtimeOnUpdate: vi.fn(),
    setActiveTabRealtimeUrgent: vi.fn(), followSpeechTab: vi.fn(), preSpeechTab: vi.fn(() => true),
    quakeSpeakingCard: null,
    expandPanelForSpecialInfo: vi.fn(),
    selectQuake: vi.fn(), openLpgmFromQuake: vi.fn(), openEstimatedIntensity: vi.fn(), closeDistributionOnQuakeReport: vi.fn(),
  }))
  const handle = (tsunami: JMATsunami) => {
    act(() => { result.current.handleLiveEvent(tsunami as never) })
    displayed[0] = tsunami
  }
  return { handle }
}

beforeEach(() => {
  vi.useFakeTimers()
  speeches.length = 0
  serial = 0
  speakMock.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('等級は据え置きのまま予想波高だけが動いた続報', () => {
  it('正: 動いた区域だけを、等級ごとに読む', async () => {
    const { handle } = setup()
    handle(makeReport(ISSUED))
    await settle()
    handle(makeReport(UPDATED))
    await settle()
    expect(spokenTexts()).toHaveLength(2)
    expect(spokenTexts()[1]).toBe(
      '予想される津波の高さが変わりました。岩手県で5メートルが予想されています。また、茨城県で3メートルが予想されています。',
    )
  })

  it('対照: 同じ値を載せ続ける続報では読み直さない', async () => {
    const { handle } = setup()
    handle(makeReport(ISSUED))
    await settle()
    handle(makeReport(UPDATED))
    await settle()
    handle(makeReport(UPDATED))
    await settle()
    expect(spokenTexts()).toHaveLength(2)
  })

  it('対照: 予想波高が発表時から動いていなければ読まない', async () => {
    const { handle } = setup()
    handle(makeReport(ISSUED))
    await settle()
    handle(makeReport(ISSUED.map(a => ({ ...a, lastGrade: a.grade }))))
    await settle()
    expect(spokenTexts()).toHaveLength(1)
  })

  it('対照: 津波情報（VTSE51）は予想波高が違っても読まない', async () => {
    const { handle } = setup()
    handle(makeReport(ISSUED))
    await settle()
    handle(makeReport(UPDATED, 'VTSE51'))
    await settle()
    expect(spokenTexts().join('')).not.toContain('予想される津波の高さが変わりました')
  })

  it('正: 発表時に予想波高が無かった区域は、電文が「更新」と書いたときに読む', async () => {
    const { handle } = setup()
    handle(makeReport([{ name: '北海道太平洋沿岸東部', code: '100', grade: 'Watch' }]))
    await settle()
    handle(makeReport([{ name: '北海道太平洋沿岸東部', code: '100', grade: 'Watch', lastGrade: 'Watch', height: '1m', revise: '更新' }]))
    await settle()
    expect(spokenTexts()[1]).toBe('予想される津波の高さが変わりました。北海道太平洋沿岸東部で1メートルが予想されています。')
  })

  it('安全弁: 記憶の無い区域でも「更新」の印が無ければ読まない', async () => {
    const { handle } = setup()
    handle(makeReport([{ name: '北海道太平洋沿岸東部', code: '100', grade: 'Watch' }]))
    await settle()
    handle(makeReport([{ name: '北海道太平洋沿岸東部', code: '100', grade: 'Watch', lastGrade: 'Watch', height: '1m' }]))
    await settle()
    expect(spokenTexts()).toHaveLength(1)
  })
})
