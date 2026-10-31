// @vitest-environment jsdom
//
// 揺れ検知の確定で「〇〇で揺れを検知。」と読み上げること（2026-10-31 ユーザー選択「地名だけ・1回 (Recommended)」
// 「EEWの範囲内なら読まない (Recommended)」「設定を足し既定オフ」）。
//
//   正     : 設定が入っていれば、確定の立ち上がりで区域名つきで 1 回読む
//   正     : 確定と同じ瞬間に震度更新音も鳴ったら、長い方の音が鳴り終わるまで待つ
//   対照   : 設定が切れていれば読まない／強まっても読み直さない／区域が決まらなければ地名を言わない
//   安全弁 : 緊急地震速報の範囲に入る揺れは読まない／途絶からの復帰（同じ揺れの続き）では読まない
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useKyoshinAlerts, DETECT_SPEECH_REGION_WAIT_MS, type KyoshinAlertsDeps } from './useKyoshinAlerts'
import { ttsDelayFor, kyoshinUpdateSoundLengthMs } from '../utils/alertSound'
import { DEFAULTS } from './useSettings'
import type { AlertTitleApi } from './useAlertTitle'
import type { EEWAlert } from '../types/earthquake'
import type { TabId } from '../components/IconNav'
import type { SubRegion } from '../utils/subregions'
import type { DetectedPoint } from '../utils/kyoshinDetectionView'
import { log } from '../utils/logger'

vi.mock('../utils/alertSound', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/alertSound')>()
  return { ...actual, playAlertSound: vi.fn(), playKyoshinUpdateSound: vi.fn() }
})
vi.mock('../utils/notifications', () => ({ showBrowserNotification: vi.fn() }))

/** 正方形の区域「能登テスト区域」（緯度 37〜38・経度 137〜138）と「福岡テスト区域」（緯度 33〜34・経度 130〜131）。 */
const SUBREGIONS: SubRegion[] = [
  { name: '能登テスト区域', label: [37.5, 137.5], room: [0, 0], rings: [[[37, 137], [37, 138], [38, 138], [38, 137], [37, 137]]] },
  { name: '福岡テスト区域', label: [33.5, 130.5], room: [0, 0], rings: [[[33, 130], [33, 131], [34, 131], [34, 130], [33, 130]]] },
]
/** 読み終えた境界データ（null は「まだ読んでいない」） */
let loaded: SubRegion[] | null = SUBREGIONS
/** 読み込みを頼まれたときの返事（既定は読み終えて SUBREGIONS を返す） */
let loadImpl: () => Promise<SubRegion[]> = () => Promise.resolve(SUBREGIONS)
vi.mock('../utils/subregions', async (orig) => {
  const actual = await orig<typeof import('../utils/subregions')>()
  return { ...actual, getSubRegionsCache: () => loaded, loadSubRegions: () => loadImpl() }
})

const NOTO = { lat: 37.5, lng: 137.5, index: 11, peak: { lat: 37.5, lng: 137.5 }, points: [] }
const POINTS: DetectedPoint[] = [
  { key: 'a', lat: 37.5, lng: 137.5, index: 11 } as DetectedPoint,
  { key: 'b', lat: 37.6, lng: 137.6, index: 9 } as DetectedPoint,
]
const AT = '2026-01-01T12:00:30Z'

function makeDeps(over: Partial<KyoshinAlertsDeps> = {}): KyoshinAlertsDeps {
  return {
    confirmed: false,
    candidate: false,
    candidateMaxIndex: 0,
    confirmedShocks: [],
    dataTime: AT,
    stalled: false,
    settings: { ...DEFAULTS, soundEnabled: true, kyoshinDetectSpeech: true },
    title: { setTitle: vi.fn(), setOngoingTitle: vi.fn(), applyPriority: vi.fn() } as unknown as AlertTitleApi,
    activeEEWsRef: { current: new Map<string, EEWAlert>() },
    defaultTabRef: { current: 'earthquake' as TabId },
    setActiveTab: vi.fn(),
    revertToDefaultTab: vi.fn(),
    onShakeFocus: vi.fn(),
    reonset: null,
    detectedPoints: POINTS,
    speakDetection: vi.fn(),
    ...over,
  }
}

/** 能登テスト区域の真ん中を震源とする、発表中の緊急地震速報（発生から 30 秒）。 */
function eewAt(lat: number, lng: number): EEWAlert {
  return {
    kind: 'eew',
    id: 'eew-1',
    time: '2026-01-01T12:00:05Z',
    test: false,
    earthquake: {
      originTime: '2026-01-01T12:00:00Z',
      arrivalTime: '2026-01-01T12:00:05Z',
      condition: '',
      hypocenter: { name: '能登半島沖', latitude: lat, longitude: lng, depth: 10, magnitude: 6.5 },
    },
    severity: 'Warning',
    cancelled: false,
    issue: { eventId: 'e1', serial: '1', time: '2026-01-01T12:00:05Z' },
    areas: [],
  } as unknown as EEWAlert
}

/** 何も無い状態から、渡したコマを順に流す。 */
function drive(...frames: Partial<KyoshinAlertsDeps>[]) {
  const speak = vi.fn()
  const { rerender } = renderHook((p: KyoshinAlertsDeps) => useKyoshinAlerts(p), {
    initialProps: makeDeps({ speakDetection: speak, ...frames[0] }),
  })
  for (const f of frames.slice(1)) rerender(makeDeps({ speakDetection: speak, ...f }))
  return speak
}

const CONFIRMED = { confirmed: true, confirmedShocks: [NOTO] }

describe('useKyoshinAlerts: 揺れ検知の読み上げ', () => {
  beforeEach(() => {
    loaded = SUBREGIONS
    loadImpl = () => Promise.resolve(SUBREGIONS)
  })

  it('[正] 確定の立ち上がりで、区域名つきで 1 回読む（間は検知音）', () => {
    const speak = drive({}, CONFIRMED)
    expect(speak).toHaveBeenCalledTimes(1)
    expect(speak).toHaveBeenCalledWith('能登テスト区域で揺れを検知。', ttsDelayFor('kyoshin'))
  })

  it('[正] 確定と同じ瞬間に震度更新音も鳴ったら、長い方まで待つ', () => {
    // 揺れの可能性（段 2）から始め、段 7 で確定する —— 確定の瞬間に段が上がり更新音が鳴る
    const speak = drive(
      { candidate: true, candidateMaxIndex: 9 },
      { candidate: true, candidateMaxIndex: 9, confirmed: true, confirmedShocks: [{ ...NOTO, index: 19 }] },
    )
    expect(speak).toHaveBeenCalledTimes(1)
    const longer = Math.max(ttsDelayFor('kyoshin'), kyoshinUpdateSoundLengthMs(19))
    expect(longer).toBeGreaterThan(ttsDelayFor('kyoshin'))
    expect(speak.mock.calls[0][1]).toBe(longer)
  })

  it('[対照] 設定が切れていれば読まない', () => {
    const off = { ...DEFAULTS, soundEnabled: true, kyoshinDetectSpeech: false }
    const speak = drive({ settings: off }, { ...CONFIRMED, settings: off })
    expect(speak).not.toHaveBeenCalled()
  })

  it('[対照] 確定が続いて強まっても読み直さない', () => {
    const speak = drive({}, CONFIRMED, { ...CONFIRMED, confirmedShocks: [{ ...NOTO, index: 17 }] })
    expect(speak).toHaveBeenCalledTimes(1)
  })

  it('[正] 境界データをまだ読んでいなければ、読み終えるのを待ってから区域名つきで読む', async () => {
    loaded = null
    const speak = drive({}, CONFIRMED)
    expect(speak).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(speak).toHaveBeenCalledTimes(1))
    expect(speak.mock.calls[0][0]).toBe('能登テスト区域で揺れを検知。')
    // 待った時間は音との間から差し引く（声が音から遅れない）
    expect(speak.mock.calls[0][1]).toBeLessThanOrEqual(ttsDelayFor('kyoshin'))
  })

  it('[対照] 境界データを読めなければ地名を言わない', async () => {
    loaded = null
    loadImpl = () => Promise.reject(new Error('テスト用の読み込み失敗'))
    const speak = drive({}, CONFIRMED)
    await vi.waitFor(() => expect(speak).toHaveBeenCalledTimes(1))
    expect(speak.mock.calls[0][0]).toBe('揺れを検知。')
  })

  describe('境界データの待ちの上限（2026-10-31 ユーザー選択「10秒で地名なしに切替 (Recommended)」）', () => {
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.useRealTimers() })

    /** 読み込みが返らないまま、確定させる */
    function driveStuck() {
      loaded = null
      let release: (subs: SubRegion[]) => void = () => {}
      loadImpl = () => new Promise((resolve) => { release = resolve })
      const speak = drive({}, CONFIRMED)
      return { speak, release: (subs: SubRegion[]) => release(subs) }
    }

    it('[対照] 上限の手前ではまだ読まない', async () => {
      const { speak } = driveStuck()
      await act(async () => { await vi.advanceTimersByTimeAsync(DETECT_SPEECH_REGION_WAIT_MS - 1) })
      expect(speak).not.toHaveBeenCalled()
    })

    it('[正] 上限まで読み終わらなければ、地名を言わずに読む', async () => {
      const { speak } = driveStuck()
      await act(async () => { await vi.advanceTimersByTimeAsync(DETECT_SPEECH_REGION_WAIT_MS) })
      expect(speak).toHaveBeenCalledTimes(1)
      expect(speak.mock.calls[0][0]).toBe('揺れを検知。')
    })

    it('[安全弁] 上限の後に読み終わっても、2 回目は読まない', async () => {
      const { speak, release } = driveStuck()
      await act(async () => { await vi.advanceTimersByTimeAsync(DETECT_SPEECH_REGION_WAIT_MS) })
      await act(async () => { release(SUBREGIONS); await vi.advanceTimersByTimeAsync(0) })
      expect(speak).toHaveBeenCalledTimes(1)
    })
  })

  it('[安全弁] 境界データを待つ間にリプレイを始め直したら、旧い揺れは読まない', async () => {
    loaded = null
    let release: (subs: SubRegion[]) => void = () => {}
    loadImpl = () => new Promise((resolve) => { release = resolve })
    const speak = vi.fn()
    const { result, rerender } = renderHook((p: KyoshinAlertsDeps) => useKyoshinAlerts(p), {
      initialProps: makeDeps({ speakDetection: speak }),
    })
    rerender(makeDeps({ speakDetection: speak, ...CONFIRMED }))
    result.current.resetForReplay()
    release(SUBREGIONS)
    await new Promise((r) => setTimeout(r, 0))
    expect(speak).not.toHaveBeenCalled()
  })

  it('[安全弁] 境界データを待った後の予約で例外が出ても、黙って消さずにログへ残す', async () => {
    loaded = null
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => {})
    const speak = vi.fn(() => { throw new Error('テスト用の予約失敗') })
    const { rerender } = renderHook((p: KyoshinAlertsDeps) => useKyoshinAlerts(p), {
      initialProps: makeDeps({ speakDetection: speak }),
    })
    rerender(makeDeps({ speakDetection: speak, ...CONFIRMED }))
    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledTimes(1))
    expect(String(errorSpy.mock.calls[0][0])).toContain('揺れを検知。')
    errorSpy.mockRestore()
  })

  it('[安全弁] 緊急地震速報の範囲に入る揺れは読まない', () => {
    const eews = { current: new Map([['e1', eewAt(37.5, 137.5)]]) }
    const speak = drive({ activeEEWsRef: eews }, { ...CONFIRMED, activeEEWsRef: eews })
    expect(speak).not.toHaveBeenCalled()
  })

  it('[安全弁] 範囲の外の緊急地震速報なら読む', () => {
    // 震源は福岡沖（能登から約 700km）。発生 30 秒では範囲が届かない
    const eews = { current: new Map([['e1', eewAt(33.6, 130.0)]]) }
    const speak = drive({ activeEEWsRef: eews }, { ...CONFIRMED, activeEEWsRef: eews })
    expect(speak).toHaveBeenCalledTimes(1)
  })

  it('[安全弁] 途絶からの復帰（同じ揺れの続き）では読まない', () => {
    const speak = drive({}, CONFIRMED, { confirmed: false, confirmedShocks: [], stalled: true }, CONFIRMED)
    expect(speak).toHaveBeenCalledTimes(1)
  })
})

// 「別の地点で揺れを検知」でも「〇〇でも揺れを検知。」と 1 回読む（2026-10-31 ユーザー選択
// 「境を直してから読む (Recommended)」）。区域名はその揺れの点から決める。
//
//   正     : 別地点の地域が鳴ったら、その揺れの点の区域名で「〜でも揺れを検知。」と読む
//   対照   : 設定が切れていれば別地点でも読まない／同じ地域では 2 回読まない
//   安全弁 : 緊急地震速報の範囲に入る地域（別地点として鳴らない）は読まない
describe('useKyoshinAlerts: 別の地点の揺れ検知の読み上げ', () => {
  beforeEach(() => {
    loaded = SUBREGIONS
    loadImpl = () => Promise.resolve(SUBREGIONS)
  })

  /** 能登から約 700km 離れた福岡の揺れ。点は福岡テスト区域に入る */
  const FUKUOKA = {
    lat: 33.6, lng: 130.4, index: 9, peak: { lat: 33.6, lng: 130.4 },
    points: [{ key: 'f', lat: 33.6, lng: 130.4, index: 9 } as DetectedPoint],
  }
  const t = (sec: number) => new Date(Date.parse(AT) + sec * 1000).toISOString()
  /** 能登で確定 → 1 秒後に福岡が加わる → 3 秒後に福岡が持続して別地点として鳴る */
  const framesOtherRegion = (over: Partial<KyoshinAlertsDeps> = {}): Partial<KyoshinAlertsDeps>[] => [
    { ...over },
    { ...over, ...CONFIRMED, dataTime: t(0) },
    { ...over, confirmed: true, confirmedShocks: [NOTO, FUKUOKA], dataTime: t(1) },
    { ...over, confirmed: true, confirmedShocks: [NOTO, FUKUOKA], dataTime: t(3) },
  ]

  it('[正] 別地点で、その揺れの点の区域名で「〜でも揺れを検知。」と読む', () => {
    const speak = drive(...framesOtherRegion())
    expect(speak.mock.calls.map((c) => c[0])).toEqual(['能登テスト区域で揺れを検知。', '福岡テスト区域でも揺れを検知。'])
    expect(speak.mock.calls[1][1]).toBe(ttsDelayFor('kyoshin'))
  })

  it('[対照] 同じ別地点の地域では 2 回読まない', () => {
    const frames = framesOtherRegion()
    const speak = drive(...frames, { ...frames[3], dataTime: t(10) })
    expect(speak).toHaveBeenCalledTimes(2)
  })

  it('[対照] 設定が切れていれば別地点でも読まない', () => {
    const off = { ...DEFAULTS, soundEnabled: true, kyoshinDetectSpeech: false }
    const speak = drive(...framesOtherRegion({ settings: off }))
    expect(speak).not.toHaveBeenCalled()
  })

  it('[安全弁] 緊急地震速報の範囲に入る地域は別地点として鳴らないので読まない', () => {
    // 震源は福岡（能登から約 700km）。能登は範囲の外なので最初の検知は読む
    const eews = { current: new Map([['e1', eewAt(33.6, 130.4)]]) }
    const speak = drive(...framesOtherRegion({ activeEEWsRef: eews }))
    expect(speak.mock.calls.map((c) => c[0])).toEqual(['能登テスト区域で揺れを検知。'])
  })
})
