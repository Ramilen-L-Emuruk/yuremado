// @vitest-environment jsdom
//
// 揺れ検知の「この 1 点を見せたい」要求（onShakeFocus）のテスト。
//
// この要求は**通知音を鳴らすのと同じ判定で**出す必要がある。判定を別に組むと、音は鳴るのに画は
// 動かない（またはその逆の）経路が黙って生まれる。ここで固定するのは 4 つ。
//   1. 正: レベルが上がったら、レベルを担った confirmed イベントの代表点を通知する
//   2. 対照: likely 中は通知しない（控えめな音で知らせるだけに留める）
//   3. 安全弁: 確定検知の開始では通知しない（全体を見せる初回フィットの担当）
//   4. 正: 別地点発報では、その地域自身の座標を通知する
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useKyoshinAlerts, type KyoshinAlertsDeps } from './useKyoshinAlerts'
import { playAlertSound, playKyoshinUpdateSound } from '../utils/alertSound'
import type { AppSettings } from './useSettings'
import type { AlertTitleApi } from './useAlertTitle'
import type { EEWAlert } from '../types/earthquake'
import type { TabId } from '../components/IconNav'

// 音の実体だけ差し替える。kyoshinLevel（震度→音レベルの境界）は本物を使う——レベルの上がり方が
// 発火の条件そのものなので、ここを模擬すると何も検証しないテストになる。
vi.mock('../utils/alertSound', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/alertSound')>()
  return { ...actual, playAlertSound: vi.fn(), playKyoshinUpdateSound: vi.fn() }
})
vi.mock('../utils/notifications', () => ({ showBrowserNotification: vi.fn() }))

// useKyoshinAlerts.test.ts と同じ座標（能登＝震源側／福岡＝遠方）。
//
// **重心（lat/lng）とピーク（peak）を意図的に離して置く。** 寄り先はピーク側でなければならない
// ——重心はメンバーの平均で、広域に広がったイベントでは最も強く揺れている点から数十〜百数十 km
// ずれる（2024-01-01 16:08 能登の再生で実測: 約 140km）。
const NOTO = { lat: 37.5, lng: 137.0, index: 20, peak: { lat: 37.45, lng: 137.15 } }
const FUKUOKA = { lat: 33.6, lng: 130.4, index: 12, peak: { lat: 33.58, lng: 130.35 } }

function makeDeps(over: Partial<KyoshinAlertsDeps> = {}): KyoshinAlertsDeps {
  return {
    confirmed: false,
    candidate: false,
    candidateMaxIndex: 0,
    confirmedShocks: [],
    dataTime: '',
    stalled: false,
    // notifyMinScale は -1（通知しない）。ブラウザ通知はこのテストの対象外。
    settings: { soundEnabled: true, notifyMinScale: -1, notifyDetection: false } as unknown as AppSettings,
    title: { setTitle: vi.fn(), setOngoingTitle: vi.fn(), applyPriority: vi.fn() } as unknown as AlertTitleApi,
    activeEEWsRef: { current: new Map<string, EEWAlert>() },
    defaultTabRef: { current: 'earthquake' as TabId },
    setActiveTab: vi.fn(),
    revertToDefaultTab: vi.fn(),
    reonset: null,
    onShakeFocus: vi.fn(),
    ...over,
  }
}

describe('useKyoshinAlerts の揺れフォーカス要求', () => {
  beforeEach(() => {
    vi.mocked(playAlertSound).mockClear()
    vi.mocked(playKyoshinUpdateSound).mockClear()
  })

  it('[正] レベルが上がったら、レベルを担ったイベントの代表点を通知する', () => {
    const onShakeFocus = vi.fn()
    // 震度3（index 11 → レベル3）で確定。初観測なので基準値を作るだけで音は鳴らない。
    const { rerender } = renderHook((p: KyoshinAlertsDeps) => useKyoshinAlerts(p), {
      initialProps: makeDeps({
        confirmed: true,
        confirmedShocks: [{ ...FUKUOKA, index: 11 }],
        onShakeFocus,
      }),
    })
    expect(playKyoshinUpdateSound).not.toHaveBeenCalled()
    expect(onShakeFocus).not.toHaveBeenCalled()

    // 震度4（index 13 → レベル4）へ上がる。弱いままの地域も残しておく——寄り先は
    // 「レベルを担った方」でなければならない。
    rerender(makeDeps({
      confirmed: true,
      confirmedShocks: [{ ...FUKUOKA, index: 11 }, { ...NOTO, index: 13 }],
      onShakeFocus,
    }))

    expect(playKyoshinUpdateSound).toHaveBeenCalledTimes(1)
    expect(onShakeFocus).toHaveBeenCalledTimes(1)
    // 重心（NOTO.lat/lng）ではなくピークへ寄せる。
    expect(onShakeFocus).toHaveBeenCalledWith(NOTO.peak)
    expect(onShakeFocus).not.toHaveBeenCalledWith({ lat: NOTO.lat, lng: NOTO.lng })
  })

  it('[対照] likely 中のレベルアップでは通知しない（音だけ鳴らす）', () => {
    const onShakeFocus = vi.fn()
    const { rerender } = renderHook((p: KyoshinAlertsDeps) => useKyoshinAlerts(p), {
      initialProps: makeDeps({ candidate: true, candidateMaxIndex: 11, onShakeFocus }),
    })

    rerender(makeDeps({ candidate: true, candidateMaxIndex: 13, onShakeFocus }))

    expect(playKyoshinUpdateSound).toHaveBeenCalledTimes(1)
    expect(onShakeFocus).not.toHaveBeenCalled()
  })

  it('[安全弁] 確定検知の開始では通知しない（初回フィットが全体を見せる担当）', () => {
    const onShakeFocus = vi.fn()
    renderHook((p: KyoshinAlertsDeps) => useKyoshinAlerts(p), {
      initialProps: makeDeps({ confirmed: true, confirmedShocks: [NOTO], onShakeFocus }),
    })

    expect(playAlertSound).toHaveBeenCalledWith('kyoshin')
    expect(onShakeFocus).not.toHaveBeenCalled()
  })

  it('[正] 同じフレームで強まりと別地点発報が重なったら、別地点の座標が最後になる', () => {
    // どちらの要求も同じ flush で出る。App 側の state には最後の要求だけが残るため、ここで
    // 「最後に渡すのはどちらか」を固定する。別地点はフル音量で「別の場所でも揺れている」ことを
    // 知らせる報せなので、同じ地震の強まりより見せる価値が高い（実装は別地点の effect を後に置く）。
    const onShakeFocus = vi.fn()
    const t0 = new Date('2026-08-23T12:00:00.000Z').getTime()
    const at = (i: number) => new Date(t0 + i * 1000).toISOString()
    const props = (i: number, shocks: typeof NOTO[]) =>
      makeDeps({ confirmed: true, confirmedShocks: shocks, dataTime: at(i), onShakeFocus })

    // 震度4（index 13 → レベル4）で確定し、遠方が登録されて持続する。
    const { rerender } = renderHook((p: KyoshinAlertsDeps) => useKyoshinAlerts(p), {
      initialProps: props(0, [{ ...NOTO, index: 13 }]),
    })
    for (let i = 1; i <= 2; i++) rerender(props(i, [{ ...NOTO, index: 13 }, FUKUOKA]))
    expect(onShakeFocus).not.toHaveBeenCalled()

    // 別地点の発報が成立するフレームで、同時に最大震度も上がる（5弱 → レベル5）。
    rerender(props(3, [{ ...NOTO, index: 15 }, FUKUOKA]))

    // 強まりと別地点の両方が要求を出し、最後は別地点。
    expect(onShakeFocus).toHaveBeenCalledTimes(2)
    expect(onShakeFocus).toHaveBeenNthCalledWith(1, NOTO.peak)
    expect(onShakeFocus).toHaveBeenNthCalledWith(2, FUKUOKA.peak)
  })

  it('[正] 別地点で揺れを検知したら、その地域自身の座標を通知する', () => {
    const onShakeFocus = vi.fn()
    const t0 = new Date('2026-08-23T12:00:00.000Z').getTime()
    const at = (i: number) => new Date(t0 + i * 1000).toISOString()
    // 最大 index は 20 のまま動かさない（レベルアップ経路と混ざらないようにする）。
    const props = (i: number, shocks: typeof NOTO[]) =>
      makeDeps({ confirmed: true, confirmedShocks: shocks, dataTime: at(i), onShakeFocus })

    const { rerender } = renderHook((p: KyoshinAlertsDeps) => useKyoshinAlerts(p), {
      initialProps: props(0, [NOTO]),
    })
    // 遠方を登録 → 持続 → 発報（useKyoshinAlerts.test.ts の stepAlertRegions と同じ 4 フレーム）。
    for (let i = 1; i <= 3; i++) rerender(props(i, [NOTO, FUKUOKA]))

    expect(playAlertSound).toHaveBeenCalledWith('kyoshin')
    expect(onShakeFocus).toHaveBeenCalledTimes(1)
    // 別地点も同じく、その地域で最大震度を記録した観測点へ寄せる（重心ではない）。
    expect(onShakeFocus).toHaveBeenCalledWith(FUKUOKA.peak)
    expect(onShakeFocus).not.toHaveBeenCalledWith({ lat: FUKUOKA.lat, lng: FUKUOKA.lng })
  })

  describe('同じ場所の 2 つ目の地震（設計書§40）', () => {
    const t0 = new Date('2026-08-23T12:00:00.000Z').getTime()
    const at = (i: number) => new Date(t0 + i * 1000).toISOString()
    const SECOND = { lat: 37.3, lng: 137.0 }
    /** 合図。`atMs` はフレームのデータ時刻（`at(i)` と同じ物差し）。印はイベント ID と時刻から作る */
    const signalAt = (i: number, focus: typeof SECOND | null = SECOND) => ({ key: `evt-1@${t0 + i * 1000}`, atMs: t0 + i * 1000, focus })
    const SIGNAL = signalAt(1)

    it('[正] 合図があれば検知音を鳴らし、その点へ寄せる', () => {
      const onShakeFocus = vi.fn()
      const setActiveTab = vi.fn()
      const { rerender } = renderHook((p: KyoshinAlertsDeps) => useKyoshinAlerts(p), {
        initialProps: makeDeps({ confirmed: true, confirmedShocks: [NOTO], dataTime: at(0), onShakeFocus, setActiveTab }),
      })
      vi.mocked(playAlertSound).mockClear()
      rerender(makeDeps({ confirmed: true, confirmedShocks: [NOTO], dataTime: at(1), onShakeFocus, setActiveTab, reonset: SIGNAL }))
      expect(playAlertSound).toHaveBeenCalledWith('kyoshin')
      expect(onShakeFocus).toHaveBeenLastCalledWith(SECOND)
      expect(setActiveTab).toHaveBeenLastCalledWith('realtime')
    })

    it('[安全弁] 寄せ先が引けない合図でも、音とタブ移動は出す（寄せだけ省く）', () => {
      const onShakeFocus = vi.fn()
      const setActiveTab = vi.fn()
      const { rerender } = renderHook((p: KyoshinAlertsDeps) => useKyoshinAlerts(p), {
        initialProps: makeDeps({ confirmed: true, confirmedShocks: [NOTO], dataTime: at(0), onShakeFocus, setActiveTab }),
      })
      vi.mocked(playAlertSound).mockClear()
      onShakeFocus.mockClear()
      rerender(makeDeps({ confirmed: true, confirmedShocks: [NOTO], dataTime: at(1), onShakeFocus, setActiveTab, reonset: signalAt(1, null) }))
      expect(playAlertSound).toHaveBeenCalledWith('kyoshin')
      expect(setActiveTab).toHaveBeenLastCalledWith('realtime')
      expect(onShakeFocus).not.toHaveBeenCalled()
    })

    it('[安全弁] 同じ合図のまま時刻だけ進んでも、作り直された同じ印の合図でも、鳴り直さない', () => {
      // 検知結果が止まっている間（時刻だけ進む）と、`useMemo` の再計算（同じ中身の新しいオブジェクト）
      const { rerender } = renderHook((p: KyoshinAlertsDeps) => useKyoshinAlerts(p), {
        initialProps: makeDeps({ confirmed: true, confirmedShocks: [NOTO], dataTime: at(0) }),
      })
      vi.mocked(playAlertSound).mockClear()
      rerender(makeDeps({ confirmed: true, confirmedShocks: [NOTO], dataTime: at(1), reonset: signalAt(1) }))
      rerender(makeDeps({ confirmed: true, confirmedShocks: [NOTO], dataTime: at(1), reonset: signalAt(1) }))
      rerender(makeDeps({ confirmed: true, confirmedShocks: [NOTO], dataTime: at(2), reonset: signalAt(1) }))
      rerender(makeDeps({ confirmed: true, confirmedShocks: [NOTO], dataTime: at(3), reonset: signalAt(1) }))
      expect(vi.mocked(playAlertSound).mock.calls.filter(([t]) => t === 'kyoshin')).toHaveLength(1)
    })

    it('[正] 印が変われば（次の合図）また鳴らす', () => {
      const { rerender } = renderHook((p: KyoshinAlertsDeps) => useKyoshinAlerts(p), {
        initialProps: makeDeps({ confirmed: true, confirmedShocks: [NOTO], dataTime: at(0) }),
      })
      vi.mocked(playAlertSound).mockClear()
      rerender(makeDeps({ confirmed: true, confirmedShocks: [NOTO], dataTime: at(1), reonset: signalAt(1) }))
      rerender(makeDeps({ confirmed: true, confirmedShocks: [NOTO], dataTime: at(2), reonset: null }))
      rerender(makeDeps({ confirmed: true, confirmedShocks: [NOTO], dataTime: at(70), reonset: signalAt(70) }))
      expect(vi.mocked(playAlertSound).mock.calls.filter(([t]) => t === 'kyoshin')).toHaveLength(2)
    })

    it('[対照] 合図が無ければ鳴らさない', () => {
      const { rerender } = renderHook((p: KyoshinAlertsDeps) => useKyoshinAlerts(p), {
        initialProps: makeDeps({ confirmed: true, confirmedShocks: [NOTO], dataTime: at(0) }),
      })
      vi.mocked(playAlertSound).mockClear()
      rerender(makeDeps({ confirmed: true, confirmedShocks: [NOTO], dataTime: at(1) }))
      expect(playAlertSound).not.toHaveBeenCalled()
    })

    it('[安全弁] 同じフレームで別地点として鳴らしていたら、重ねて鳴らさない', () => {
      const onShakeFocus = vi.fn()
      const props = (i: number, reonset: ReturnType<typeof signalAt> | null = null) =>
        makeDeps({ confirmed: true, confirmedShocks: i === 0 ? [NOTO] : [NOTO, FUKUOKA], dataTime: at(i), onShakeFocus, reonset })
      const { rerender } = renderHook((p: KyoshinAlertsDeps) => useKyoshinAlerts(p), { initialProps: props(0) })
      for (let i = 1; i <= 2; i++) rerender(props(i))
      vi.mocked(playAlertSound).mockClear()
      // 別地点の発報が成立するフレームに、2 つ目の合図も重なる
      rerender(props(3, signalAt(3)))
      expect(vi.mocked(playAlertSound).mock.calls.filter(([t]) => t === 'kyoshin')).toHaveLength(1)
      expect(onShakeFocus).toHaveBeenLastCalledWith(FUKUOKA.peak)
    })
  })
})
