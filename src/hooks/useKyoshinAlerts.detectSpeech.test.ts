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
import { ttsDelayFor, kyoshinUpdateSoundLengthMs, playAlertSound } from '../utils/alertSound'
import { eewFeltRadiusKm } from '../utils/eew'
import { haversineKm } from '../utils/geo'
import { DEFAULTS } from './useSettings'
import type { AlertTitleApi } from './useAlertTitle'
import type { EEWAlert } from '../types/earthquake'
import type { TabId } from '../components/IconNav'
import type { SubRegion } from '../utils/subregions'
import type { ConfirmedShock, DetectedPoint } from '../utils/kyoshinDetectionView'
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

/** 震源の差し替え（既定は発生 12:00:00・深さ 10km・M6.5・震源確定）。 */
interface EewOver {
  originTime?: string
  arrivalTime?: string
  magnitude?: number
  condition?: string
  cancelledAt?: Date
  strongShakingOnly?: true
}

/** 渡した位置を震源とする、発表中の緊急地震速報（既定は発生から 30 秒）。 */
function eewAt(lat: number, lng: number, over: EewOver = {}): EEWAlert {
  return {
    kind: 'eew',
    id: 'eew-1',
    time: '2026-01-01T12:00:05Z',
    test: false,
    earthquake: {
      originTime: over.originTime ?? '2026-01-01T12:00:00Z',
      arrivalTime: over.arrivalTime ?? '2026-01-01T12:00:05Z',
      condition: over.condition ?? '',
      hypocenter: { name: '能登半島沖', latitude: lat, longitude: lng, depth: 10, magnitude: over.magnitude ?? 6.5 },
    },
    severity: 'Warning',
    cancelled: false,
    ...(over.cancelledAt && { cancelledAt: over.cancelledAt }),
    ...(over.strongShakingOnly && { strongShakingOnly: true }),
    issue: { eventId: 'e1', serial: '1', time: '2026-01-01T12:00:05Z' },
    areas: [],
  } as unknown as EEWAlert
}

/** 揺れの時刻 `AT` から `sec` 秒前の時刻（緊急地震速報の発生時刻に使う）。 */
const beforeAt = (sec: number) => new Date(Date.parse(AT) - sec * 1000).toISOString()

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

/** 能登（37.5, 137.5）から約 775km 離れた福岡の揺れ。点は福岡テスト区域に入る */
const FUKUOKA = {
  lat: 33.6, lng: 130.4, index: 9, peak: { lat: 33.6, lng: 130.4 },
  points: [{ key: 'f', lat: 33.6, lng: 130.4, index: 9 } as DetectedPoint],
}
/** 能登から真南へ約 400km の揺れ */
const SOUTH_400 = { lat: 33.9, lng: 137.5, index: 9, peak: { lat: 33.9, lng: 137.5 }, points: [] }
/** 能登から真南へ約 200km の揺れ（下限 300km の内側） */
const SOUTH_200 = { lat: 35.7, lng: 137.5, index: 9, peak: { lat: 35.7, lng: 137.5 }, points: [] }

describe('useKyoshinAlerts: 揺れ検知の読み上げ', () => {
  beforeEach(() => {
    loaded = SUBREGIONS
    loadImpl = () => Promise.resolve(SUBREGIONS)
  })

  it('[正] 確定の立ち上がりで、区域名つきで 1 回読む（間は検知音）', () => {
    const speak = drive({}, CONFIRMED)
    expect(speak).toHaveBeenCalledTimes(1)
    expect(speak).toHaveBeenCalledWith('能登テスト区域で揺れを検知。', ttsDelayFor('kyoshin'), expect.any(Function))
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

// 緊急地震速報の P 波が検知の時刻までに届いていた場所の揺れだけを読まない（2026-11-05 ユーザー選択
// 「揺れが届いた所だけ読まない (Recommended)」）。有感半径の打ち止めと 300km の下限は持たない。
//
//   正     : P 波が届いた遠い揺れは読まない（有感半径の外でも）。震源の決まっていない報も数える
//   対照   : P 波が届く前の揺れは読む（下限 300km の内側でも）。同時に起きた別の地震は、その揺れの点で読む
//   安全弁 : 緊急地震速報が無ければ読む／取消を当てた報は数えない
describe('useKyoshinAlerts: 揺れ検知の読み上げと緊急地震速報の P 波の届き', () => {
  beforeEach(() => {
    loaded = SUBREGIONS
    loadImpl = () => Promise.resolve(SUBREGIONS)
  })

  /** 能登の本震の初報（2024-01-01 16:10:16 の警報。震源 37.5, 137.2・深さ 10km・M5.5）を、発生から `sec` 秒の時点で */
  const notoFirst = (sec: number, over: EewOver = {}) =>
    ({ current: new Map([['e1', eewAt(37.5, 137.2, { originTime: beforeAt(sec), magnitude: 5.5, ...over })]]) })
  const confirmedAt = (...shocks: ConfirmedShock[]) => ({ confirmed: true, confirmedShocks: shocks })

  it('[正] 能登の初報 M5.5・発生 60 秒・400km 先の揺れは読まない', () => {
    expect(haversineKm(37.5, 137.2, SOUTH_400.lat, SOUTH_400.lng)).toBeGreaterThan(395)
    const eews = notoFirst(60)
    const speak = drive({ activeEEWsRef: eews }, { ...confirmedAt(SOUTH_400), activeEEWsRef: eews })
    expect(speak).not.toHaveBeenCalled()
  })

  it('[正] 有感半径の外でも、P 波が届いていれば読まない（M5.5・発生 100 秒・福岡）', () => {
    // 有感半径で打ち止めると、この揺れは範囲の外になって読まれる
    expect(haversineKm(37.5, 137.2, FUKUOKA.lat, FUKUOKA.lng)).toBeGreaterThan(eewFeltRadiusKm(5.5, 10))
    const eews = notoFirst(100)
    const speak = drive({ activeEEWsRef: eews }, { ...confirmedAt(FUKUOKA), activeEEWsRef: eews })
    expect(speak).not.toHaveBeenCalled()
  })

  it('[正] 震源の決まっていない報（仮定震源要素）も、報の位置を震源として数える', () => {
    const eews = notoFirst(60, { condition: '仮定震源要素', magnitude: 1.0 })
    const speak = drive({ activeEEWsRef: eews }, { ...confirmedAt(SOUTH_400), activeEEWsRef: eews })
    expect(speak).not.toHaveBeenCalled()
  })

  it('[正] 発生時刻を持たない「非常に強い揺れを検知」の報は、発現時刻から測る', () => {
    const eews = notoFirst(60, { strongShakingOnly: true, originTime: '', arrivalTime: beforeAt(60), magnitude: NaN })
    const speak = drive({ activeEEWsRef: eews }, { ...confirmedAt(SOUTH_400), activeEEWsRef: eews })
    expect(speak).not.toHaveBeenCalled()
  })

  it('[対照] P 波が届く前の揺れは読む（発生 30 秒・400km 先）', () => {
    const eews = notoFirst(30)
    const speak = drive({ activeEEWsRef: eews }, { ...confirmedAt(SOUTH_400), activeEEWsRef: eews })
    expect(speak).toHaveBeenCalledTimes(1)
  })

  it('[対照] 300km より近くても、P 波が届く前なら別の地震として読む（発生 10 秒・200km 先）', () => {
    const eews = notoFirst(10)
    const speak = drive({ activeEEWsRef: eews }, { ...confirmedAt(SOUTH_200), activeEEWsRef: eews })
    expect(speak).toHaveBeenCalledTimes(1)
  })

  // 能登の週の控え（01-01 16:32:54）の形: 震源が仮の速報の発生 9 秒、揺れの重心は震源から約 120km だが、
  // 最も強い点は震源のそば（2026-11-05 ユーザー選択「最も強い点でも判定する (Recommended)」）
  const spreadShock = (peakLat: number): ConfirmedShock =>
    ({ lat: 36.42, lng: 137.2, index: 9, peak: { lat: peakLat, lng: 137.2 }, points: [] })

  it('[正] 重心が P 波の円の外でも、最も強い点に届いていれば読まない（仮定震源・発生 9 秒）', () => {
    expect(haversineKm(37.5, 137.2, 36.42, 137.2)).toBeGreaterThan(115)
    const eews = notoFirst(9, { condition: '仮定震源要素', magnitude: 1.0 })
    const speak = drive({ activeEEWsRef: eews }, { ...confirmedAt(spreadShock(37.45)), activeEEWsRef: eews })
    expect(speak).not.toHaveBeenCalled()
  })

  it('[対照] 重心も最も強い点も P 波の円の外なら読む（仮定震源・発生 9 秒）', () => {
    const eews = notoFirst(9, { condition: '仮定震源要素', magnitude: 1.0 })
    const speak = drive({ activeEEWsRef: eews }, { ...confirmedAt(spreadShock(36.42)), activeEEWsRef: eews })
    expect(speak).toHaveBeenCalledTimes(1)
  })

  it('[安全弁] P 波が通り過ぎた所で後から起きた揺れも、速報が出ている間は読まない（時刻では分けない）', () => {
    // 2026-11-05 ユーザー選択「今のまま P 波だけで見る (Recommended)」。能登の週の控えで、時刻の条件では
    // 同じ地震と別の地震をきれいに分けられなかった（S 波の到達から 60 秒で切ると、別の地震 19 件のうち 7 件を
    // 拾う代わりに同じ地震 182 件のうち 6 件を巻き込む）
    const eews = notoFirst(180)
    const speak = drive({ activeEEWsRef: eews }, { ...confirmedAt(SOUTH_200), activeEEWsRef: eews })
    expect(speak).not.toHaveBeenCalled()
  })

  it('[対照] 発生時刻より前の揺れは、震源の真上でも読む', () => {
    const eews = notoFirst(-5)
    const speak = drive({ activeEEWsRef: eews }, { ...confirmedAt({ ...NOTO, lat: 37.5, lng: 137.2 }), activeEEWsRef: eews })
    expect(speak).toHaveBeenCalledTimes(1)
  })

  it('[対照] 同時に起きた別の地震は、届いていない揺れの点の区域名で読む', () => {
    // 能登は発生 30 秒で届いている。福岡（約 775km）にはまだ届いていない
    const eews = notoFirst(30)
    const speak = drive({ activeEEWsRef: eews }, { ...confirmedAt(NOTO, FUKUOKA), activeEEWsRef: eews })
    expect(speak.mock.calls.map((c) => c[0])).toEqual(['福岡テスト区域で揺れを検知。'])
  })

  it('[安全弁] 緊急地震速報が無ければ、遠い揺れも今どおり読む', () => {
    const speak = drive({}, confirmedAt(SOUTH_400))
    expect(speak).toHaveBeenCalledTimes(1)
  })

  it('[安全弁] 取消を当てた報は数えない', () => {
    const eews = notoFirst(60, { cancelledAt: new Date(Date.parse(AT) - 1000) })
    const speak = drive({ activeEEWsRef: eews }, { ...confirmedAt(SOUTH_400), activeEEWsRef: eews })
    expect(speak).toHaveBeenCalledTimes(1)
  })
})

// 積む時に読むと決めた揺れも、声に出す直前にもう一度、その時点の発表中の速報と**検知の時刻**で見直す。
// 能登の本震（2024-01-01）は揺れの確定 16:10:15・速報の初報 16:10:16（発生 16:10:08）で、確定の時には速報がまだ無い。
//
//   正     : 検知が先・速報が 1 秒後に届いたら、見直しは捨てる（最初の検知・別の地点とも）
//   対照   : 後から届いた速報が別の地震で、P 波が検知の時刻に届いていなければ捨てない
//   安全弁 : 速報が無ければ捨てない／取消を当てた報は数えない
describe('useKyoshinAlerts: 揺れ検知の読み上げの、読む直前の見直し', () => {
  beforeEach(() => {
    loaded = SUBREGIONS
    loadImpl = () => Promise.resolve(SUBREGIONS)
  })

  /** 渡した速報の入れ物で、速報の無いまま能登で確定させ、読み上げの口へ渡った見直しを返す */
  function confirmWithoutEew(eews: { current: Map<string, EEWAlert> }) {
    const speak = drive({ activeEEWsRef: eews }, { ...CONFIRMED, activeEEWsRef: eews })
    expect(speak).toHaveBeenCalledTimes(1)
    return speak.mock.calls[0][2] as () => boolean
  }
  /** 能登の本震の速報（発生は検知の 7 秒前＝ 16:10:08 と 16:10:15 の差） */
  const notoMain = (over: EewOver = {}) => eewAt(37.5, 137.2, { originTime: beforeAt(7), magnitude: 5.5, ...over })

  it('[正] 検知が先・速報が 1 秒後に届いたら、読む直前の見直しで捨てる', () => {
    const eews = { current: new Map<string, EEWAlert>() }
    const drop = confirmWithoutEew(eews)
    expect(drop()).toBe(false)
    // 1 秒後に速報が届く（App が入れ物を差し替える）
    eews.current = new Map([['e1', notoMain()]])
    expect(drop()).toBe(true)
  })

  it('[正] 別の地点の読み上げも、読む直前の見直しで捨てる', () => {
    const t = (sec: number) => new Date(Date.parse(AT) + sec * 1000).toISOString()
    const eews = { current: new Map<string, EEWAlert>() }
    const speak = drive(
      { activeEEWsRef: eews },
      { ...CONFIRMED, dataTime: t(0), activeEEWsRef: eews },
      { confirmed: true, confirmedShocks: [NOTO, FUKUOKA], dataTime: t(1), activeEEWsRef: eews },
      { confirmed: true, confirmedShocks: [NOTO, FUKUOKA], dataTime: t(3), activeEEWsRef: eews },
    )
    expect(speak.mock.calls.map((c) => c[0])).toEqual(['能登テスト区域で揺れを検知。', '福岡テスト区域でも揺れを検知。'])
    const dropOther = speak.mock.calls[1][2] as () => boolean
    // 別地点の検知の時刻（t(3)）に、発生 103 秒の能登の速報の P 波は福岡（約 775km）へ届いている
    eews.current = new Map([['e1', eewAt(37.5, 137.2, { originTime: beforeAt(100), magnitude: 5.5 })]])
    expect(dropOther()).toBe(true)
  })

  it('[対照] 後から届いた速報が別の地震で、P 波が検知の時刻に届いていなければ捨てない', () => {
    const eews = { current: new Map<string, EEWAlert>() }
    const drop = confirmWithoutEew(eews)
    // 福岡沖（能登から約 790km）で 7 秒前に起きた地震の速報
    eews.current = new Map([['e1', eewAt(33.6, 130.0, { originTime: beforeAt(7) })]])
    expect(drop()).toBe(false)
  })

  it('[安全弁] 速報が無ければ捨てない', () => {
    const drop = confirmWithoutEew({ current: new Map<string, EEWAlert>() })
    expect(drop()).toBe(false)
  })

  it('[安全弁] 取消を当てた報は数えない', () => {
    const eews = { current: new Map<string, EEWAlert>() }
    const drop = confirmWithoutEew(eews)
    eews.current = new Map([['e1', notoMain({ cancelledAt: new Date(Date.parse(AT) + 1000) })]])
    expect(drop()).toBe(false)
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

  it('[正] 有感半径の外で別地点として鳴っても、P 波が届いていた地域は読まない（音は鳴る）', () => {
    // 能登の初報 M5.5 が発生から 100 秒。福岡（約 775km）は有感半径（約 607km）の外なので別地点として鳴るが、P 波は届いている
    vi.mocked(playAlertSound).mockClear()
    const eews = { current: new Map([['e1', eewAt(37.5, 137.2, { originTime: beforeAt(100), magnitude: 5.5 })]]) }
    const speak = drive(...framesOtherRegion({ activeEEWsRef: eews }))
    expect(speak).not.toHaveBeenCalled()
    // 最初の検知と別地点の 2 回とも検知音は鳴る（音の扱いは変えない）
    expect(vi.mocked(playAlertSound).mock.calls.filter((c) => c[0] === 'kyoshin')).toHaveLength(2)
  })

  it('[対照] 別地点の地域に P 波がまだ届いていなければ読む', () => {
    // 震源は能登・発生 30 秒。能登の最初の検知は届いているので読まず、福岡はまだ届いていないので読む
    const eews = { current: new Map([['e1', eewAt(37.5, 137.5)]]) }
    const speak = drive(...framesOtherRegion({ activeEEWsRef: eews }))
    expect(speak.mock.calls.map((c) => c[0])).toEqual(['福岡テスト区域でも揺れを検知。'])
  })
})
