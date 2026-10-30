// @vitest-environment jsdom
//
// 南海トラフ・後発地震・関連解説情報・長周期地震動・推計震度分布図・地震回数の、**音・ブラウザ通知・ウィンドウタイトル・
// パネルの展開**を受け手の結線ごと固定するテスト。通知の文面そのものは `utils/specialInfoNotification.test.ts`。
//
// 固定する決定（扱いの記録は棚卸しの ⑤・⑨⑩⑪）:
// - 取消は系統ごとの取消音で鳴らす（2026-10-23 ユーザー選択「各系統の取消音を作る (Recommended)」）
// - 臨時情報・後発地震の取消と調査終了もパネルを開く（2026-10-22 ユーザー選択「取消も調査終了も鳴らす (Recommended)」）
// - 通知: 臨時・後発・臨時解説は「南海トラフ・後発地震の通知」、長周期・推計・地震回数は地震情報の通知に従う
//   （2026-10-24 ユーザー選択「南海は新設、他は地震情報に (Recommended)」）
// - タイトル: 長周期の階級・地震回数・解説情報（臨時情報が無いときだけ）を出す
// - EEW・津波・揺れ検知の通知は地震情報の最低震度に従わない（2026-10-22 ユーザー選択「3 種を切り離す (Recommended)」）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useLiveEventHandler } from './useLiveEventHandler'
import { DEFAULTS, type AppSettings } from './useSettings'
import { showBrowserNotification } from '../utils/notifications'
import { playAlertSound } from '../utils/alertSound'
import type {
  JMAQuake, JMATsunami, JMANankai, JMAKohatsu, JMANankaiCommentary, JMALpgm, JMAEarthquakeCount, JMAEstimatedIntensity,
} from '../types/earthquake'

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
const sound = vi.mocked(playAlertSound)

function setup(over: Partial<AppSettings> = {}, nankaiActive = false) {
  const settings = { ...DEFAULTS,
    voicevoxEnabled: false, soundEnabled: true, notifyMinScale: 40,
    notifyEEW: true, notifyTsunami: true, notifyDetection: false, notifyNankai: true,
    nankaiCommentaryAlerts: true, minDisplayScale: -1, ...over,
  } as unknown as AppSettings
  const titleCalls: Array<[string, unknown]> = []
  const title = new Proxy({ alertTitle: null } as Record<string, unknown>, {
    get: (t, k) => (k in t ? t[k as string] : (...args: unknown[]) => { titleCalls.push([String(k), args[0]]) }),
  })
  const expandPanel = vi.fn()
  const { result } = renderHook(() => useLiveEventHandler({
    settings, title: title as never,
    earthquakesRef: { current: [] as JMAQuake[] },
    tsunamisRef: { current: [] as JMATsunami[] },
    nankaiActiveRef: { current: nankaiActive },
    setActiveTabNonRealtime: vi.fn(),
    setActiveTabRealtimeOnUpdate: vi.fn(),
    setActiveTabRealtimeUrgent: vi.fn(), followSpeechTab: vi.fn(), preSpeechTab: vi.fn(() => true),
    quakeSpeakingCard: null,
    expandPanelForSpecialInfo: expandPanel,
    selectQuake: vi.fn(), openLpgmFromQuake: vi.fn(), openEstimatedIntensity: vi.fn(() => true), closeDistributionOnQuakeReport: vi.fn(),
  }))
  const handle = (e: unknown) => { act(() => { result.current.handleLiveEvent(e as never) }) }
  const titles = () => titleCalls.filter(([k]) => k === 'setTitle').map(([, v]) => v)
  return { handle, titles, titleCalls, expandPanel }
}

const nankai = (over: Partial<JMANankai> = {}): JMANankai => ({
  id: 'n-1', time: '2026-10-24T10:00:00+09:00', eventId: 'n', kindCode: '130', kindName: '巨大地震注意',
  headline: '南海トラフ地震臨時情報（巨大地震注意）', body: '', cancelled: false,
  reportDateTime: '2026-10-24T10:00:00+09:00', summary: '要約。', ...over,
})
const kohatsu = (over: Partial<JMAKohatsu> = {}): JMAKohatsu => ({
  id: 'k-1', time: '', eventId: 'k', headline: '北海道・三陸沖後発地震注意情報', body: '', cancelled: false,
  reportDateTime: '', expireAt: '', summary: '要約。', ...over,
})
const commentary = (over: Partial<JMANankaiCommentary> = {}): JMANankaiCommentary => ({
  id: 'c-1', time: '', eventId: 'c', serialCode: '210', serialName: '臨時解説',
  headline: '南海トラフ地震関連解説情報（第１号）', body: '', cancelled: false, reportDateTime: '', expireAt: '',
  summary: '要約。', ...over,
})
const lpgm = (over: Partial<JMALpgm> = {}): JMALpgm => ({
  id: 'l-1', eventId: '20260101161000', time: '2026-01-01T16:20:00+09:00', originTime: '2026-01-01T16:10:00+09:00',
  maxClass: 3, cancelled: false, hypocenter: { name: '石川県能登地方' }, ...over,
} as JMALpgm)
const count = (over: Partial<JMAEarthquakeCount> = {}) => ({
  id: 'ec-1', eventId: 'ec', time: '', cancelled: false, items: [], body: '本文', reportDateTime: '', expireAt: '', ...over,
}) as unknown as JMAEarthquakeCount

beforeEach(() => {
  vi.useFakeTimers()
  notify.mockClear()
  sound.mockClear()
})
afterEach(() => { vi.useRealTimers() })

describe('臨時情報・後発地震注意情報', () => {
  it('正: 発表は通知を出す（本文は要約）', () => {
    const { handle } = setup()
    handle({ kind: 'nankai', data: nankai() })
    expect(notify).toHaveBeenCalledWith('南海トラフ地震臨時情報（巨大地震注意）', '要約。', 'nankai')
  })
  it('対照: 「南海トラフ・後発地震の通知」を切れば出さない（地震情報の通知とは別）', () => {
    const { handle } = setup({ notifyNankai: false })
    handle({ kind: 'nankai', data: nankai() })
    expect(notify).not.toHaveBeenCalled()
  })
  it('安全弁: 地震情報の通知を切っていても、臨時情報の通知は出す', () => {
    const { handle } = setup({ notifyQuake: false })
    handle({ kind: 'kohatsu', data: kohatsu() })
    expect(notify).toHaveBeenCalledWith('北海道・三陸沖後発地震注意情報', '要約。', 'kohatsu')
  })
  it('正: 取消は南海トラフの系統の取消音を鳴らし、パネルを開き、取消の通知を出す', () => {
    const { handle, expandPanel } = setup()
    handle({ kind: 'nankai', data: nankai({ cancelled: true, retracted: true, kindName: '', kindCode: '' }) })
    expect(sound.mock.calls).toEqual([['specialInfoCancel']])
    expect(expandPanel).toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith('南海トラフ地震臨時情報 取消', '南海トラフ地震臨時情報は取り消されました', 'nankai')
  })
  it('正: 調査終了も取消音とパネル展開', () => {
    const { handle, expandPanel } = setup()
    handle({ kind: 'nankai', data: nankai({ cancelled: true, kindName: '調査終了', kindCode: '190' }) })
    expect(sound.mock.calls).toEqual([['specialInfoCancel']])
    expect(expandPanel).toHaveBeenCalled()
  })
  it('正: 後発地震の取消も同じ取消音', () => {
    const { handle } = setup()
    handle({ kind: 'kohatsu', data: kohatsu({ cancelled: true, retracted: true }) })
    expect(sound.mock.calls).toEqual([['specialInfoCancel']])
  })
  it('対照: 取消で下ろすタイトルは自分の種別のものだけ（臨時情報と後発地震で待ちを分ける）', () => {
    const { handle, titleCalls } = setup()
    handle({ kind: 'kohatsu', data: kohatsu({ cancelled: true, retracted: true }) })
    expect(titleCalls).toContainEqual(['releaseTitle', 'kohatsu'])
    expect(titleCalls).not.toContainEqual(['releaseTitle', 'specialInfo'])
  })
})

describe('南海トラフ地震関連解説情報', () => {
  it('正: 臨時情報が出ていなければタイトルに情報名を出す', () => {
    const { handle, titles } = setup({}, false)
    handle({ kind: 'nankaiCommentary', data: commentary() })
    expect(titles()).toEqual(['南海トラフ地震関連解説情報（第１号）'])
  })
  it('対照: 臨時情報が出ていればタイトルは書き換えない', () => {
    const { handle, titles } = setup({}, true)
    handle({ kind: 'nankaiCommentary', data: commentary() })
    expect(titles()).toEqual([])
  })
  it('正: 臨時解説は通知を出し、定例解説は出さない', () => {
    const { handle } = setup()
    handle({ kind: 'nankaiCommentary', data: commentary({ id: 'c-2', serialName: '定例解説', serialCode: '200' }) })
    expect(notify).not.toHaveBeenCalled()
    handle({ kind: 'nankaiCommentary', data: commentary() })
    expect(notify).toHaveBeenCalledWith('南海トラフ地震関連解説情報（第１号）', '要約。', 'nankai-commentary')
  })
  it('正: 取消は取消音を鳴らし、発表を通知した号なら取消の通知で置き換える', () => {
    const { handle } = setup()
    handle({ kind: 'nankaiCommentary', data: commentary() })
    sound.mockClear()
    notify.mockClear()
    handle({ kind: 'nankaiCommentary', data: commentary({ cancelled: true }) })
    expect(sound.mock.calls).toEqual([['specialInfoCancel']])
    expect(notify).toHaveBeenCalledWith('南海トラフ地震関連解説情報 取消', '南海トラフ地震関連解説情報は取り消されました', 'nankai-commentary')
  })
  it('対照: 通知していない号（定例解説）への取消は通知しない', () => {
    const { handle } = setup()
    handle({ kind: 'nankaiCommentary', data: commentary({ serialName: '定例解説', serialCode: '200' }) })
    handle({ kind: 'nankaiCommentary', data: commentary({ serialName: '定例解説', serialCode: '200', cancelled: true }) })
    expect(notify).not.toHaveBeenCalled()
  })
  it('安全弁: 解説情報の設定を切った端末では、取消でも鳴らさず通知もしない', () => {
    const { handle } = setup({ nankaiCommentaryAlerts: false })
    handle({ kind: 'nankaiCommentary', data: commentary({ cancelled: true }) })
    expect(sound).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })
})

describe('長周期地震動に関する観測情報', () => {
  it('正: タイトルに震央地名と最大階級、通知を出す', () => {
    const { handle, titles } = setup()
    handle({ kind: 'lpgm', data: lpgm() })
    expect(titles()).toEqual(['長周期地震動 石川県能登地方 最大階級3'])
    expect(notify).toHaveBeenCalledWith('長周期地震動に関する観測情報', '石川県能登地方 最大長周期地震動階級3', 'lpgm-20260101161000')
  })
  // 最大階級 0 の報も階級 1 以上と同じく扱う（2026-10-30 ユーザー選択「階級 1 以上と同じ型 (Recommended)」）
  it('正: 最大階級 0 の報も音を鳴らし、タイトルと通知を出す', () => {
    const { handle, titles } = setup()
    handle({ kind: 'lpgm', data: lpgm({ maxClass: 0 }) })
    expect(sound).toHaveBeenCalled()
    expect(titles()).toEqual(['長周期地震動 石川県能登地方 最大階級0'])
    expect(notify).toHaveBeenCalledWith('長周期地震動に関する観測情報', '石川県能登地方 最大長周期地震動階級0', 'lpgm-20260101161000')
  })
  it('安全弁: 最大階級 0 の報でも、地震情報の通知を切れば通知しない', () => {
    const { handle } = setup({ notifyQuake: false })
    handle({ kind: 'lpgm', data: lpgm({ maxClass: 0 }) })
    expect(notify).not.toHaveBeenCalled()
  })
  it('対照: 地震情報の通知を切れば通知しない（タイトルは出す）', () => {
    const { handle, titles } = setup({ notifyQuake: false })
    handle({ kind: 'lpgm', data: lpgm() })
    expect(notify).not.toHaveBeenCalled()
    expect(titles()).toHaveLength(1)
  })
  it('正: 取消は地震情報の系統の取消音を鳴らし、発表で覚えた地名で取消の通知を出す', () => {
    const { handle } = setup()
    handle({ kind: 'lpgm', data: lpgm() })
    sound.mockClear()
    notify.mockClear()
    handle({ kind: 'lpgm', data: lpgm({ id: 'l-2', cancelled: true, hypocenter: undefined, maxClass: 0 }) })
    expect(sound.mock.calls).toEqual([['earthquakeCancel']])
    expect(notify).toHaveBeenCalledWith(
      '長周期地震動に関する観測情報 取消', '石川県能登地方の長周期地震動に関する観測情報は取り消されました', 'lpgm-20260101161000',
    )
  })
})

describe('推計震度分布図', () => {
  const ei = { arrivalTime: '2026-10-24T10:05:00+09:00', hypocenter: { lat: 35, lon: 135 } } as unknown as JMAEstimatedIntensity
  it('正: 受信したことを通知する', () => {
    const { handle } = setup()
    handle({ kind: 'estimatedIntensity', data: ei, isNew: true })
    expect(notify).toHaveBeenCalledWith('推計震度分布図', '10時05分頃発生した地震の推計震度分布図を受信しました', 'estimated-intensity-2026-10-24T10:05:00+09:00')
  })
  it('対照: 地震情報の通知を切れば通知しない', () => {
    const { handle } = setup({ notifyQuake: false })
    handle({ kind: 'estimatedIntensity', data: ei, isNew: true })
    expect(notify).not.toHaveBeenCalled()
  })
})

describe('地震回数に関する情報', () => {
  it('正: タイトルと通知を出す（数字の無い報は種別名だけ）', () => {
    const { handle, titles } = setup()
    handle({ kind: 'earthquakeCount', data: count() })
    expect(titles()).toEqual(['地震回数に関する情報'])
    expect(notify).toHaveBeenCalledWith('地震回数に関する情報', '', 'earthquake-count')
  })
  it('正: 取消は地震情報の系統の取消音を鳴らし、発表を通知していれば取消の通知で置き換える', () => {
    const { handle } = setup()
    handle({ kind: 'earthquakeCount', data: count() })
    sound.mockClear()
    notify.mockClear()
    handle({ kind: 'earthquakeCount', data: count({ id: 'ec-2', cancelled: true }) })
    expect(sound.mock.calls).toEqual([['earthquakeCancel']])
    expect(notify).toHaveBeenCalledWith('地震回数に関する情報 取消', '地震回数に関する情報は取り消されました', 'earthquake-count')
  })
  // 2026-10-24 ユーザー選択「発表を通知したものだけ (Recommended)」
  it('対照: 発表を通知していない群発への取消は、音だけで通知は出さない', () => {
    const { handle } = setup()
    handle({ kind: 'earthquakeCount', data: count({ cancelled: true }) })
    expect(sound.mock.calls).toEqual([['earthquakeCancel']])
    expect(notify).not.toHaveBeenCalled()
  })
})
