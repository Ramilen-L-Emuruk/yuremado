// @vitest-environment jsdom
//
// 行動チェックリストの「閉じたら畳む」挙動の回帰テスト。
//
// 能登のような群発では、余震も続報も次々届く。地震ごとに別物として出し直すと閉じても閉じても
// 現れるため、閉じたあとは小さなボタンへ畳む設計にした。ここで固定するのはその境界
// —— 何をもって畳んだままにし、何をもって開き直すか。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useActionChecklist, SUPPRESS_MS } from './useActionChecklist'
import type { EEWAlert, JMAQuake } from '../types/earthquake'
import type { DetectedPoint } from '../utils/kyoshinDetectionView'
import { NO_SCOPE, type NearbyScope } from '../utils/actionChecklistTrigger'
import { drainReplayEvents, __resetReplayEventLogForTest, type ReplayOverlayEvent } from '../utils/replayEventLog'

const MIN = 45 // 震度5弱

function quake(eventKey: string, maxScale: number): JMAQuake {
  return {
    id: eventKey,
    eventKey,
    time: '2026/01/01 16:10:00',
    issue: { source: '', time: '', type: '震源・震度情報', correct: 'なし' },
    earthquake: {
      time: '2026/01/01 16:10:00',
      hypocenter: { name: '石川県能登地方', latitude: 37.5, longitude: 137.2, depth: 16, magnitude: 7.6 },
      maxScale,
      domesticTsunami: 'None',
    },
    points: [],
  } as unknown as JMAQuake
}

const NO_EEWS: readonly EEWAlert[] = []

/** 予想震度を持つ EEW。`eewEventKey` は `issue.eventId` があればそれを見る。 */
function eewAlert(eventId: string, scale: number): EEWAlert {
  return {
    id: `${eventId}-1`,
    issue: { eventId },
    cancelled: false,
    areas: [],
    forecastMaxScale: scale,
    earthquake: { condition: undefined },
  } as unknown as EEWAlert
}

/**
 * 誤報取消を当てた EEW。**画面が持つ実際の形に合わせる** —— 取消は `{ ...表示中の EEW, cancelledAt }`
 * で当たるので、`cancelled` は false のまま（→ `docs/spec/eew-spec.md`）。
 */
function cancelledEew(eventId: string, scale: number): EEWAlert {
  return { ...eewAlert(eventId, scale), cancelledAt: new Date() }
}

const NO_POINTS: readonly DetectedPoint[] = []

/** 検知エンジンが確定と判断したメンバー観測点。 */
function detected(index: number): readonly DetectedPoint[] {
  return [{ key: '37.500,137.200', lat: 37.5, lng: 137.2, index }]
}

interface Props {
  q?: JMAQuake
  /** 地震の一覧（地震の時刻の新しい順）。渡せば `q` より優先する。 */
  qs?: readonly JMAQuake[]
  e?: readonly EEWAlert[]
  k?: readonly DetectedPoint[]
  /** 検知エンジンが結果を出せなくなっている（`useKyoshinDetectorV2` の `stalled`）。 */
  stalled?: boolean
  min?: number
}

// **同じ地震には同じ配列を返す。** 描き直すたびに `[q]` を作ると、App の一覧（状態なので参照が保たれる）と
// 違って毎回「一覧が変わった」ことになり、判定が余計に走り直す。
const NO_QUAKES: readonly JMAQuake[] = []
const singleQuakeLists = new WeakMap<JMAQuake, readonly JMAQuake[]>()
function listOf(q: JMAQuake | undefined): readonly JMAQuake[] {
  if (!q) return NO_QUAKES
  let list = singleQuakeLists.get(q)
  if (!list) singleQuakeLists.set(q, (list = [q]))
  return list
}

function setup(initial: JMAQuake | undefined, eews: readonly EEWAlert[] = NO_EEWS) {
  return renderHook(
    ({ q, qs, e, k, stalled, min }: Props) =>
      useActionChecklist({
        minScale: min ?? MIN,
        // ホーム地点を持たない端末（全国基準）。`scope` は呼び出し側が作る
        // （`useNearbyScope`）ので、ここでは絞らない形を直に渡す。
        scope: NO_SCOPE,
        detectedPoints: k ?? NO_POINTS,
        kyoshinStalled: stalled ?? false,
        eews: e ?? NO_EEWS,
        quakes: qs ?? listOf(q),
      }),
    { initialProps: { q: initial, e: eews } as Props },
  )
}

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('畳む・開く', () => {
  it('閾値に達したら開いた状態で出る', () => {
    const { result } = setup(quake('ev1', 70))
    expect(result.current.state?.scale).toBe(70)
    expect(result.current.collapsed).toBe(false)
  })

  it('閉じても中身は残り、ボタンへ畳まれる', () => {
    const { result } = setup(quake('ev1', 70))
    act(() => result.current.dismiss())
    // **null にしない。** 完全に消すと読み返せなくなる。
    expect(result.current.state).not.toBe(null)
    expect(result.current.collapsed).toBe(true)
  })

  it('畳んだボタンを押すと開く', () => {
    const { result } = setup(quake('ev1', 70))
    act(() => result.current.dismiss())
    act(() => result.current.restore())
    expect(result.current.collapsed).toBe(false)
    expect(result.current.state?.scale).toBe(70)
  })
})

describe('畳んでいる間に次の揺れが届いたら', () => {
  it('震度が同じか下なら畳んだまま（これが能登で直したかったこと）', () => {
    const { result, rerender } = setup(quake('ev1', 70))
    act(() => result.current.dismiss())
    // 別の地震（＝別のキー）が届く。旧実装ではここで帯が出直していた。
    act(() => rerender({ e: NO_EEWS, q: quake('ev2', 50) }))
    expect(result.current.collapsed).toBe(true)
    // 中身は最新の揺れへ更新する（ボタンに出す震度が古いままにならないように）。
    expect(result.current.state?.scale).toBe(50)
  })

  it('震度が上がったら開き直す', () => {
    const { result, rerender } = setup(quake('ev1', 50))
    act(() => result.current.dismiss())
    act(() => rerender({ e: NO_EEWS, q: quake('ev2', 60) }))
    expect(result.current.collapsed).toBe(false)
    expect(result.current.state?.scale).toBe(60)
  })

  it('一度開き直したら、その後の同程度の揺れでも開いたまま', () => {
    const { result, rerender } = setup(quake('ev1', 50))
    act(() => result.current.dismiss())
    act(() => rerender({ e: NO_EEWS, q: quake('ev2', 60) })) // 開き直る
    act(() => rerender({ e: NO_EEWS, q: quake('ev3', 50) }))
    expect(result.current.collapsed).toBe(false)
  })

  // 安全弁: 畳んでいる間の揺れで基準の震度を書き換えないこと。書き換えると余震で下がっていく
  // 値に追随し、そのうち小さな揺れでも「上がった」と見なして開いてしまう。
  it('畳んでいる間の弱い揺れで基準を下げない', () => {
    const { result, rerender } = setup(quake('ev1', 70)) // 震度7 で畳む
    act(() => result.current.dismiss())
    act(() => rerender({ e: NO_EEWS, q: quake('ev2', 40) }))
    act(() => rerender({ e: NO_EEWS, q: quake('ev3', 50) })) // 基準が 40 に下がっていれば開いてしまう
    expect(result.current.collapsed).toBe(true)
  })
})

describe('ボタンの寿命', () => {
  it('揺れが届かないまま期限が来たら消える', () => {
    const { result } = setup(quake('ev1', 70))
    act(() => result.current.dismiss())
    act(() => void vi.advanceTimersByTime(SUPPRESS_MS + 1))
    expect(result.current.state).toBe(null)
    expect(result.current.collapsed).toBe(false)
  })

  it('揺れが届くたびに延びる（余震が続く間はボタンが残る）', () => {
    const { result, rerender } = setup(quake('ev1', 70))
    act(() => result.current.dismiss())
    act(() => void vi.advanceTimersByTime(SUPPRESS_MS - 1000))
    act(() => rerender({ e: NO_EEWS, q: quake('ev2', 50) })) // 期限の直前に余震
    act(() => void vi.advanceTimersByTime(2000)) // 元の期限は過ぎたが延長済み
    expect(result.current.state).not.toBe(null)
    expect(result.current.collapsed).toBe(true)
  })

  it('開いている間は期限で消さない（読んでいる最中に消えないこと）', () => {
    const { result } = setup(quake('ev1', 70))
    act(() => result.current.dismiss())
    act(() => result.current.restore())
    act(() => void vi.advanceTimersByTime(SUPPRESS_MS + 1))
    expect(result.current.state).not.toBe(null)
  })
})

describe('リロードをまたぐ', () => {
  it('畳んだ記録は保存され、期限内なら次の揺れでも畳んだまま', () => {
    const first = setup(quake('ev1', 70))
    act(() => first.result.current.dismiss())
    first.unmount()

    // 別インスタンス（＝リロード相当）。記録が効いていなければ開いた状態で出る。
    const second = setup(quake('ev2', 50))
    expect(second.result.current.collapsed).toBe(true)
  })

  it('期限切れの記録は無視して開いた状態で出る', () => {
    localStorage.setItem(
      'action-checklist-suppress',
      JSON.stringify({ until: Date.now() - 1, scale: 70 }),
    )
    const { result } = setup(quake('ev1', 50))
    expect(result.current.collapsed).toBe(false)
  })

  it('壊れた記録は無かったことにする', () => {
    localStorage.setItem('action-checklist-suppress', '{ this is not json')
    const { result } = setup(quake('ev1', 50))
    expect(result.current.collapsed).toBe(false)
    expect(result.current.state?.scale).toBe(50)
  })
})

describe('3 経路の優先順', () => {
  // 3 つは同時に成立しうる（発報中の EEW・揺れている観測値・直前の地震の確定情報）。
  // 順序を決めずに書くと最後に評価したものが勝ち、EEW が出ている最中に「強い揺れがありました」
  // （過去形）へ落ちる。
  it('EEW が出ている間は、直前の地震の確定情報より EEW を見せる', () => {
    const { result } = setup(quake('ev1', 70), [eewAlert('e1', 50)])
    expect(result.current.state?.reason).toBe('eew')
    expect(result.current.state?.scale).toBe(50)
  })

  it('EEW が無ければ地震情報を見せる', () => {
    const { result } = setup(quake('ev1', 70))
    expect(result.current.state?.reason).toBe('quake')
  })

  // 画面が持つ EEW には取消が `{ ...表示中の EEW, cancelledAt }` の形で当たり、`cancelled` は
  // false のまま残る（→ eew-spec.md）。`cancelled: true` で作ると実際には来ない形を試すことになる。
  it('誤報取消の EEW は見ない', () => {
    const { result } = setup(quake('ev1', 70), [cancelledEew('e1', 50)])
    expect(result.current.state?.reason).toBe('quake')
  })

  it('閾値に届かない EEW は飛ばして次の経路を見る', () => {
    const { result } = setup(quake('ev1', 70), [eewAlert('e1', 30)])
    expect(result.current.state?.reason).toBe('quake')
  })
})

describe('レビューで見つかった穴の回帰', () => {
  // 表示の更新を「中身が変わらないなら触らない」で打ち切ると、寿命の延長も道連れになる。
  // 強震モニタは毎秒判定するため、同じ震度が続く揺れでは延長が一度も走らない。
  it('中身が変わらない再通知でも寿命は延びる', () => {
    const { result, rerender } = setup(quake('ev1', 70))
    act(() => result.current.dismiss())
    act(() => void vi.advanceTimersByTime(SUPPRESS_MS - 1000))
    // 同じ地震・同じ震度がもう一度届く（表示は変わらない）
    act(() => rerender({ e: NO_EEWS, q: quake('ev1', 70) }))
    act(() => void vi.advanceTimersByTime(2000))
    expect(result.current.state).not.toBe(null)
    expect(result.current.collapsed).toBe(true)
  })

  // 地震情報は最新の 1 件が長く居座る（1 時間後も同じ地震が最新のままなのは普通）。
  // 「消し終えた」ことを覚えていないと、消した次の再描画でそのまま出し直してしまう。
  it('寿命が尽きて消したものは、同じ地震が居座っていても出し直さない', () => {
    const { result, rerender } = setup(quake('ev1', 70))
    act(() => result.current.dismiss())
    act(() => void vi.advanceTimersByTime(SUPPRESS_MS + 1))
    expect(result.current.state).toBe(null)
    act(() => rerender({ e: NO_EEWS, q: quake('ev1', 70) }))
    expect(result.current.state).toBe(null)
  })

  it('別の地震なら消したあとでも出す', () => {
    const { result, rerender } = setup(quake('ev1', 70))
    act(() => result.current.dismiss())
    act(() => void vi.advanceTimersByTime(SUPPRESS_MS + 1))
    act(() => rerender({ e: NO_EEWS, q: quake('ev2', 50) }))
    expect(result.current.state?.scale).toBe(50)
    expect(result.current.collapsed).toBe(false)
  })

  // 階級表に無い震度（例: 99）が記録に入ると「これを超えたら開き直す」が永久に成立せず、
  // 以後どんな揺れでもボタンが自動で開かなくなる。記録は永続化されるためリロードでも直らない。
  it('階級表に無い震度の記録は無視する', () => {
    localStorage.setItem(
      'action-checklist-suppress',
      JSON.stringify({ until: Date.now() + SUPPRESS_MS, scale: 99 }),
    )
    const { result } = setup(quake('ev1', 50))
    expect(result.current.collapsed).toBe(false)
  })
})

describe('レビュー 2 巡目で見つかった穴の回帰', () => {
  // `eews` の並びは発報を受けた順で、深刻さとは無関係。最初に閾値を超えたところで打ち切ると、
  // 後から発生したより強い地震の予想を見落とす。
  it('EEW が複数あるときは最も深刻なものを見せる', () => {
    const { result } = setup(undefined, [eewAlert('e-old', 50), eewAlert('e-new', 60)])
    expect(result.current.state?.scale).toBe(60)
    expect(result.current.state?.key).toBe('eew:e-new')
  })

  it('並び順が逆でも結果は変わらない', () => {
    const { result } = setup(undefined, [eewAlert('e-new', 60), eewAlert('e-old', 50)])
    expect(result.current.state?.scale).toBe(60)
  })

  // 判定側で早期に抜けるだけでは、開いたままの帯が手動で閉じるまで残る（開いている間は
  // 寿命でも消さない設計のため）。
  it('設定で「出さない」に切り替えたら、開いている帯も引っ込める', () => {
    const { result, rerender } = setup(quake('ev1', 70))
    expect(result.current.state).not.toBe(null)
    act(() => rerender({ q: quake('ev1', 70), min: -1 }))
    expect(result.current.state).toBe(null)
    expect(result.current.collapsed).toBe(false)
  })

  it('畳んだボタンも引っ込める', () => {
    const { result, rerender } = setup(quake('ev1', 70))
    act(() => result.current.dismiss())
    act(() => rerender({ q: quake('ev1', 70), min: -1 }))
    expect(result.current.state).toBe(null)
    expect(result.current.collapsed).toBe(false)
  })

  // EEW も地震情報もまだ無い数十秒の窓に、別々の地震が 2 つ入ることがある（群発・離れた
  // 2 地域の同時発生）。識別子を時単位に丸めていると両者が同じものになり、1 件目を閉じたあと
  // 2 件目が「同じ揺れの続き」として扱われて開き直さない。
  it('強震モニタだけで検知した揺れは、途切れたら別の識別子になる', () => {
    const STRONG = 19 // 震度7
    const CALM = 6 // 震度0
    const { result, rerender } = setup(undefined)
    act(() => rerender({ k: detected(STRONG) }))
    const first = result.current.state?.key
    expect(first).toMatch(/^kyoshin:/)

    act(() => rerender({ k: detected(CALM) })) // 揺れが収まる（識別子を捨てる）
    act(() => void vi.advanceTimersByTime(1000))
    act(() => rerender({ k: detected(STRONG) })) // 別の地震
    expect(result.current.state?.key).not.toBe(first)
  })

  // 対照: 揺れが続いている間は識別子を変えない（変えると畳んだものが開き直る）
  it('揺れが続いている間は識別子を変えない', () => {
    const STRONG = 19
    const { result, rerender } = setup(undefined)
    act(() => rerender({ k: detected(STRONG) }))
    const first = result.current.state?.key
    act(() => void vi.advanceTimersByTime(1000))
    act(() => rerender({ k: [...detected(STRONG), { key: 'x', lat: 37, lng: 137, index: STRONG }] }))
    expect(result.current.state?.key).toBe(first)
  })

  // 確定していない揺れでは発火しない。生の観測値を素通ししていたときは、1 点の跳ね上がりが
  // そのまま「震度7」として帯に出ていた（実データ 793 窓の再生で、気象庁発表が震度1 の地震に
  // 震度5弱、震度4 の地震に震度6弱と表示された）。
  it('検知エンジンが確定を出していなければ、値の高い点があっても発火しない', () => {
    const { result, rerender } = setup(undefined)
    act(() => rerender({ k: NO_POINTS }))
    expect(result.current.state).toBe(null)
  })
})

// 強震モニタ経路の入力を検知エンジンへ移したことで、エンジンの異常がこの機能にも波及するように
// なった。エンジンは連続して壊れると検知結果を空にする（`useKyoshinDetectorV2` の `stalled`）ので、
// それを「揺れが収まった」と読ませない。
describe('検知エンジンが詰まっている間', () => {
  const STRONG = 19 // 震度7

  it('識別子を捨てない（復帰したとき同じ揺れとして扱う）', () => {
    const { result, rerender } = setup(undefined)
    act(() => rerender({ k: detected(STRONG) }))
    const first = result.current.state?.key
    expect(first).toMatch(/^kyoshin:/)

    act(() => rerender({ k: NO_POINTS, stalled: true }))
    act(() => void vi.advanceTimersByTime(1000))
    act(() => rerender({ k: detected(STRONG), stalled: false }))
    expect(result.current.state?.key).toBe(first)
  })

  it('出ている帯を引っ込めない', () => {
    const { result, rerender } = setup(undefined)
    act(() => rerender({ k: detected(STRONG) }))
    act(() => rerender({ k: NO_POINTS, stalled: true }))
    expect(result.current.state?.reason).toBe('kyoshin')
    expect(result.current.state?.scale).toBe(70)
  })

  // 揺れが続いているのに「強い揺れがありました」（過去形）へ差し替わると、震度も別の値になる
  it('地震情報へ落とさない（過去形へ差し替わらない）', () => {
    const { result, rerender } = setup(undefined)
    act(() => rerender({ k: detected(STRONG) }))
    expect(result.current.state?.reason).toBe('kyoshin')
    act(() => rerender({ k: NO_POINTS, stalled: true, q: quake('ev1', 55) }))
    expect(result.current.state?.reason).toBe('kyoshin')
    expect(result.current.state?.scale).toBe(70)
  })

  // 安全弁: 留めるのは強震モニタの帯が出ているときだけ。何も出ていない状態まで止めると、
  // エンジンが壊れ続けている端末で地震情報の経路まで死ぬ。
  it('何も出ていなければ、詰まっていても地震情報で出す', () => {
    const { result, rerender } = setup(undefined)
    act(() => rerender({ k: NO_POINTS, stalled: true, q: quake('ev1', 55) }))
    expect(result.current.state?.reason).toBe('quake')
  })

  // 対照: 詰まっていないのに検知が消えたのは「揺れが収まった」。次の揺れは別物として扱う。
  it('詰まっていないなら、検知が消えた時点で識別子を捨てる', () => {
    const { result, rerender } = setup(undefined)
    act(() => rerender({ k: detected(STRONG) }))
    const first = result.current.state?.key
    act(() => rerender({ k: NO_POINTS, stalled: false }))
    act(() => void vi.advanceTimersByTime(1000))
    act(() => rerender({ k: detected(STRONG), stalled: false }))
    expect(result.current.state?.key).not.toBe(first)
  })
})

describe('リプレイの開始・停止で落とすもの', () => {
  // 正: 表示中の帯は消える。入力（地震・EEW・揺れ）が空になっても消える経路が他に無いため、
  // 落とさないと切替前の地震の帯が新しい時間軸の画面に残る
  it('表示中の帯は消える', () => {
    const { result } = setup(quake('ev1', 70))
    expect(result.current.state).not.toBe(null)
    act(() => result.current.resetForReplay())
    expect(result.current.state).toBe(null)
    expect(result.current.collapsed).toBe(false)
  })

  // 正: 「寿命が尽きて消した識別子」も落ちる。残すと同じ地震を再生しても二度と出ない
  it('寿命で消した地震は、リセット後なら再び出る', () => {
    const { result, rerender } = setup(quake('ev1', 70))
    act(() => result.current.dismiss())
    // 期限まで揺れが届かず消える（= doneKeys に積まれる）
    act(() => { vi.advanceTimersByTime(SUPPRESS_MS + 1) })
    expect(result.current.state).toBe(null)
    // 同じ地震をもう一度渡しても出し直さない
    act(() => rerender({ q: undefined, e: NO_EEWS }))
    act(() => rerender({ q: quake('ev1', 70), e: NO_EEWS }))
    expect(result.current.state).toBe(null)
    // リセットを挟めば出る
    act(() => result.current.resetForReplay())
    act(() => rerender({ q: undefined, e: NO_EEWS }))
    act(() => rerender({ q: quake('ev1', 70), e: NO_EEWS }))
    expect(result.current.state?.scale).toBe(70)
  })

  // 安全弁: 抑止の記録（利用者が閉じた意思・永続化されている）は落とさない。
  // リプレイへ入った途端に開き直すのは、閉じた意思を無視することになる
  it('閉じた記録は残る（次の揺れは畳んだ状態から）', () => {
    const { result, rerender } = setup(quake('ev1', 70))
    act(() => result.current.dismiss())
    act(() => result.current.resetForReplay())
    // 記録が残っているので、同程度以下の揺れは畳んだまま出る
    act(() => rerender({ q: quake('ev2', 70), e: NO_EEWS }))
    expect(result.current.state?.scale).toBe(70)
    expect(result.current.collapsed).toBe(true)
  })
})

describe('出している帯の元の EEW が誤報取消されたら', () => {
  // 2026-10-16 の誤報（千島列島 M9.9・震度7予想の警報を約 8 分後に取消）の再生で、EEW カードは
  // 取消を経て消えたのに、帯は「震度7 強い揺れが予想されています」のまま残った。開いている帯は
  // 寿命でも消さない設計のため、取消で下ろす経路が要る。
  beforeEach(() => { __resetReplayEventLogForTest() })

  const closes = () => drainReplayEvents().events
    .filter((e): e is ReplayOverlayEvent => e.type === 'overlay' && e.overlay === 'actionChecklist' && !e.open)

  it('開いている帯を下ろす', () => {
    const { result, rerender } = setup(undefined, [eewAlert('e1', 70)])
    expect(result.current.state?.reason).toBe('eew')
    act(() => rerender({ e: [cancelledEew('e1', 70)] }))
    expect(result.current.state).toBe(null)
    expect(result.current.collapsed).toBe(false)
  })

  it('下ろしたことを録画ツール向けに 1 件だけ記録する', () => {
    const { rerender } = setup(undefined, [eewAlert('e1', 70)])
    __resetReplayEventLogForTest() // 開いた分は見ない
    act(() => rerender({ e: [cancelledEew('e1', 70)] }))
    act(() => rerender({ e: NO_EEWS })) // 10 秒後に取消済みの EEW がリストから消える
    expect(closes().map(e => e.reason)).toEqual(['緊急地震速報が取り消された'])
  })

  it('畳んだボタンも下ろし、畳んだ記録も捨てる', () => {
    const { result, rerender } = setup(undefined, [eewAlert('e1', 70)])
    act(() => result.current.dismiss())
    act(() => rerender({ e: [cancelledEew('e1', 70)] }))
    expect(result.current.state).toBe(null)
    expect(result.current.collapsed).toBe(false)
    expect(localStorage.getItem('action-checklist-suppress')).toBe(null)
    // 震度7（取り消された予想）を基準に畳んだままにしない。本物の揺れは開いて出る。
    act(() => rerender({ e: NO_EEWS, q: quake('ev1', 50) }))
    expect(result.current.state?.reason).toBe('quake')
    expect(result.current.collapsed).toBe(false)
  })

  it('強震モニタで揺れていれば、その帯へ切り替える', () => {
    const STRONG = 19 // 震度7
    const { result, rerender } = setup(undefined, [eewAlert('e1', 70)])
    act(() => rerender({ e: [cancelledEew('e1', 70)], k: detected(STRONG) }))
    expect(result.current.state?.reason).toBe('kyoshin')
    // 識別子を取り消された EEW へ紐づけない
    expect(result.current.state?.key).not.toContain('e1')
  })

  it('地震情報が閾値に達していれば、その帯へ切り替える', () => {
    const { result, rerender } = setup(quake('ev1', 60), [eewAlert('e1', 70)])
    expect(result.current.state?.reason).toBe('eew')
    act(() => rerender({ q: quake('ev1', 60), e: [cancelledEew('e1', 70)] }))
    expect(result.current.state?.reason).toBe('quake')
    expect(result.current.state?.scale).toBe(60)
  })

  it('ほかの EEW が出ていれば、そちらへ切り替える', () => {
    const { result, rerender } = setup(undefined, [eewAlert('e1', 70), eewAlert('e2', 50)])
    expect(result.current.state?.key).toBe('eew:e1')
    act(() => rerender({ e: [cancelledEew('e1', 70), eewAlert('e2', 50)] }))
    expect(result.current.state?.key).toBe('eew:e2')
  })

  it('切り替えても、取り消された帯が下りたことは記録に残す', () => {
    const { rerender } = setup(quake('ev1', 60), [eewAlert('e1', 70)])
    __resetReplayEventLogForTest()
    act(() => rerender({ q: quake('ev1', 60), e: [cancelledEew('e1', 70)] }))
    const log = drainReplayEvents().events
      .filter((e): e is ReplayOverlayEvent => e.type === 'overlay' && e.overlay === 'actionChecklist')
    expect(log.map(e => [e.open, e.reason])).toEqual([
      [false, '緊急地震速報が取り消された'],
      [true, '揺れを検知'],
    ])
  })

  // 寿命が尽きて消した地震は出し直さない（`show` が弾く）。切り替え先がそれしか無いときに
  // 結果を見ずに任せると、取り消された帯が画面に残る（最新の地震は長く居座る）。
  it('切り替え先が寿命の尽きた地震しか無ければ、消す', () => {
    const { result, rerender } = setup(quake('ev1', 60))
    act(() => result.current.dismiss())
    act(() => void vi.advanceTimersByTime(SUPPRESS_MS + 1)) // ev1 は出し終えた
    expect(result.current.state).toBe(null)
    act(() => rerender({ q: quake('ev1', 60), e: [eewAlert('e1', 70)] }))
    expect(result.current.state?.reason).toBe('eew')
    act(() => rerender({ q: quake('ev1', 60), e: [cancelledEew('e1', 70)] }))
    expect(result.current.state).toBe(null)
    expect(result.current.collapsed).toBe(false)
  })

  // 安全弁: 別の揺れを閉じて畳んでいた記録は、その間の EEW が取り消されても残す
  it('別の地震で畳んでいた記録は残し、畳んだまま地震情報へ戻る', () => {
    const { result, rerender } = setup(quake('ev1', 70))
    act(() => result.current.dismiss()) // ev1（震度7）で畳む
    act(() => rerender({ q: quake('ev1', 70), e: [eewAlert('e1', 50)] })) // 畳んだまま EEW へ
    expect(result.current.state?.reason).toBe('eew')
    expect(result.current.collapsed).toBe(true)
    act(() => rerender({ q: quake('ev1', 70), e: [cancelledEew('e1', 50)] }))
    expect(result.current.state?.reason).toBe('quake')
    expect(result.current.collapsed).toBe(true)
    expect(localStorage.getItem('action-checklist-suppress')).not.toBe(null)
  })

  it('別の地震で畳んでいた記録を残したまま消すときは、畳んだ状態を保つ', () => {
    const { result, rerender } = setup(quake('ev1', 70))
    act(() => result.current.dismiss())
    act(() => rerender({ q: undefined, e: [eewAlert('e1', 50)] }))
    act(() => rerender({ q: undefined, e: [cancelledEew('e1', 50)] }))
    expect(result.current.state).toBe(null)
    expect(result.current.collapsed).toBe(true)
    // 記録が効いているので、同程度以下の次の揺れは畳んだまま出る
    act(() => rerender({ q: quake('ev2', 60), e: NO_EEWS }))
    expect(result.current.collapsed).toBe(true)
  })

  // 識別子を持たない古い記録（導入前に保存されたもの）は、どの帯を閉じたものか分からないので捨てる
  it('識別子の無い古い記録は、取消のときに捨てる', () => {
    localStorage.setItem('action-checklist-suppress', JSON.stringify({ until: Date.now() + SUPPRESS_MS, scale: 70 }))
    const { result, rerender } = setup(undefined, [eewAlert('e1', 70)])
    expect(result.current.collapsed).toBe(true)
    act(() => rerender({ e: [cancelledEew('e1', 70)] }))
    expect(localStorage.getItem('action-checklist-suppress')).toBe(null)
    act(() => rerender({ e: NO_EEWS, q: quake('ev1', 50) }))
    expect(result.current.collapsed).toBe(false)
  })

  // 閉じたあと帯が別の EEW へ移っていても、記録の震度は取り消された予想のまま残っている
  it('取り消された EEW を閉じてできた記録は、帯が別の EEW へ移っていても捨てる', () => {
    const { result, rerender } = setup(undefined, [eewAlert('e1', 70)])
    act(() => result.current.dismiss()) // e1（震度7予想）で畳む
    act(() => rerender({ e: [eewAlert('e1', 40), eewAlert('e2', 50)] })) // 続報で e1 が下がり e2 が引き継ぐ
    expect(result.current.state?.key).toBe('eew:e2')
    act(() => rerender({ e: [cancelledEew('e1', 40), eewAlert('e2', 50)] }))
    expect(localStorage.getItem('action-checklist-suppress')).toBe(null)
    // 記録が無くなったので、出ている e2 は開いて出る
    expect(result.current.state?.key).toBe('eew:e2')
    expect(result.current.collapsed).toBe(false)
  })

  it('閉じた帯の識別子はリロードをまたいで効く', () => {
    const first = setup(undefined, [eewAlert('e1', 70)])
    act(() => first.result.current.dismiss())
    first.unmount()
    const second = setup(undefined, [eewAlert('e1', 70)])
    expect(second.result.current.collapsed).toBe(true)
    act(() => second.rerender({ e: [cancelledEew('e1', 70)] }))
    expect(localStorage.getItem('action-checklist-suppress')).toBe(null)
    expect(second.result.current.state).toBe(null)
    expect(second.result.current.collapsed).toBe(false)
  })

  it('寿命を延ばしても、閉じた帯の識別子は保つ', () => {
    const { result, rerender } = setup(undefined, [eewAlert('e1', 70)])
    act(() => result.current.dismiss())
    act(() => void vi.advanceTimersByTime(SUPPRESS_MS - 1000)) // 残りが半分を切る
    act(() => rerender({ e: [eewAlert('e1', 70)], q: quake('ev1', 50) })) // 揺れが届いて延長
    const saved = JSON.parse(localStorage.getItem('action-checklist-suppress') ?? 'null')
    expect(saved.until).toBeGreaterThan(Date.now() + SUPPRESS_MS / 2)
    expect(saved.key).toBe('eew:e1')
  })

  // 対照: 別の EEW の取消では下ろさない
  it('元ではない EEW が取り消されても帯は残る', () => {
    const { result, rerender } = setup(undefined, [eewAlert('e1', 70), eewAlert('e2', 50)])
    act(() => rerender({ e: [eewAlert('e1', 70), cancelledEew('e2', 50)] }))
    expect(result.current.state?.key).toBe('eew:e1')
  })

  // 対照: 最終報で終わった EEW は取消ではない（即座にリストから外れる）。揺れは実際に起きて
  // いるので、帯は残す（開いている間は消さない）。
  it('最終報で EEW がリストから外れただけなら帯は残る', () => {
    const { result, rerender } = setup(undefined, [eewAlert('e1', 70)])
    act(() => rerender({ e: NO_EEWS }))
    expect(result.current.state?.reason).toBe('eew')
    expect(result.current.state?.scale).toBe(70)
  })
})

// 観測点は続報で後から加わる（実電文で、VXSE53 を 2 通以上持つ 18 地震のうち 17 地震）。先頭の
// 1 件だけを見ると、その間に別の地震が先頭へ来たとき、前の地震で上がった震度が判定されない。
describe('先頭でない地震の続報', () => {
  /** 統合したカード。`id` は最後に当てた電文の id（続報が届くと替わる）。 */
  function card(eventKey: string, maxScale: number, id: string): JMAQuake {
    return { ...quake(eventKey, maxScale), id }
  }

  // 正
  it('先頭でない地震に続報が届いて閾値に達したら出る', () => {
    const { result, rerender } = setup(card('ev1', 30, 'ev1-1'))
    // 別の地震が先頭へ来る（どちらも閾値未満）
    act(() => rerender({ qs: [card('ev2', 30, 'ev2-1'), card('ev1', 30, 'ev1-1')] }))
    expect(result.current.state).toBe(null)
    // 前の地震の続報で震度が上がる
    act(() => rerender({ qs: [card('ev2', 30, 'ev2-1'), card('ev1', 55, 'ev1-2')] }))
    expect(result.current.state?.key).toBe('quake:ev1')
    expect(result.current.state?.scale).toBe(55)
  })

  // 正: 一度も先頭に来ていない地震（起動時の履歴で入った等）でも、続報が届けば判定する
  it('先頭に来たことのない地震でも、続報が届いて閾値に達したら出る', () => {
    const { result, rerender } = setup(undefined)
    act(() => rerender({ qs: [card('ev2', 30, 'ev2-1'), card('ev1', 30, 'ev1-1')] }))
    expect(result.current.state).toBe(null)
    act(() => rerender({ qs: [card('ev2', 30, 'ev2-1'), card('ev1', 55, 'ev1-2')] }))
    expect(result.current.state?.key).toBe('quake:ev1')
  })

  // 対照: 起動時の履歴や「もっと見る」で古い地震がまとめて入っただけでは出さない
  it('先頭でない地震が初めて現れただけでは出ない', () => {
    const { result, rerender } = setup(card('ev2', 30, 'ev2-1'))
    act(() => rerender({ qs: [card('ev2', 30, 'ev2-1'), card('ev1', 70, 'ev1-9')] }))
    expect(result.current.state).toBe(null)
  })

  // 対照: 同じ `id` のまま描き直されただけ（続報ではない）なら出さない
  it('先頭でない地震の id が変わらなければ出ない', () => {
    const { result, rerender } = setup(card('ev2', 30, 'ev2-1'))
    act(() => rerender({ qs: [card('ev2', 30, 'ev2-1'), card('ev1', 70, 'ev1-9')] }))
    act(() => rerender({ qs: [card('ev2', 30, 'ev2-1'), card('ev1', 70, 'ev1-9')], e: NO_EEWS }))
    expect(result.current.state).toBe(null)
  })

  it('続報で出た古い地震の帯は、先頭のより低い地震に差し替わらない', () => {
    const { result, rerender } = setup(card('ev1', 30, 'ev1-1'))
    act(() => rerender({ qs: [card('ev2', 30, 'ev2-1'), card('ev1', 30, 'ev1-1')] }))
    act(() => rerender({ qs: [card('ev2', 30, 'ev2-1'), card('ev1', 60, 'ev1-2')] }))
    // 先頭の地震の続報で、閾値には達するが古い方より低い
    act(() => rerender({ qs: [card('ev2', 50, 'ev2-2'), card('ev1', 60, 'ev1-2')] }))
    expect(result.current.state?.key).toBe('quake:ev1')
    expect(result.current.state?.scale).toBe(60)
  })

  // 安全弁: 寿命が尽きて消した地震が最も深刻でも、閾値に達した別の地震は出る
  it('消した地震が最も深刻でも、別の地震の帯は出る', () => {
    const { result, rerender } = setup(card('ev1', 70, 'ev1-1'))
    act(() => result.current.dismiss())
    act(() => void vi.advanceTimersByTime(SUPPRESS_MS + 1)) // 寿命が尽きて消える
    expect(result.current.state).toBe(null)
    act(() => rerender({ qs: [card('ev2', 50, 'ev2-1'), card('ev1', 70, 'ev1-1')] }))
    expect(result.current.state?.key).toBe('quake:ev2')
  })

  it('一覧から消えた地震は判定から外れる', () => {
    const { result, rerender } = setup(card('ev1', 30, 'ev1-1'))
    act(() => rerender({ qs: [card('ev2', 30, 'ev2-1'), card('ev1', 30, 'ev1-1')] }))
    act(() => rerender({ qs: [card('ev2', 30, 'ev2-1')] }))
    // 同じ地震が再び現れても、初めて現れた扱い（先頭でないので判定しない）
    act(() => rerender({ qs: [card('ev2', 30, 'ev2-1'), card('ev1', 70, 'ev1-2')] }))
    expect(result.current.state).toBe(null)
  })

  it('リプレイの開始で、前に見た id を忘れる', () => {
    const { result, rerender } = setup(card('ev2', 30, 'ev2-1'))
    act(() => rerender({ qs: [card('ev2', 30, 'ev2-1'), card('ev1', 30, 'ev1-1')] }))
    act(() => result.current.resetForReplay())
    // 新しい時間軸で同じ地震が別の報の状態で現れても、「続報が届いた」と取り違えない
    act(() => rerender({ qs: [card('ev2', 30, 'ev2-1'), card('ev1', 70, 'ev1-3')] }))
    expect(result.current.state).toBe(null)
  })
})

describe('判定する地震の期限と取消', () => {
  function card(eventKey: string, maxScale: number, id: string, telegramKey?: string): JMAQuake {
    return { ...quake(eventKey, maxScale), id, ...(telegramKey && { telegramKey }) }
  }
  function cancelled(q: JMAQuake): JMAQuake {
    return { ...q, cancelledAt: new Date() } as JMAQuake
  }

  // 正: DMDATA の id は種別を含まないので、震源情報 #1 → 震源・震度情報 #1 で id が変わらない
  it('id が同じでも、最後に当てた電文が替われば続報として判定する', () => {
    const { result, rerender } = setup(undefined)
    act(() => rerender({ qs: [card('ev2', 30, 'ev2-1', 't2a'), card('ev1', 30, 'dmdata-quake-ev1-1', 't1a')] }))
    act(() => rerender({ qs: [card('ev2', 30, 'ev2-1', 't2a'), card('ev1', 55, 'dmdata-quake-ev1-1', 't1b')] }))
    expect(result.current.state?.key).toBe('quake:ev1')
  })

  // 正: 最後に電文が届いてから 1 時間を過ぎた地震は選ばない（何時間も前の地震の帯が開き直さない）
  it('最後に電文が届いてから 1 時間を過ぎた地震は、より深刻でも選ばない', () => {
    const { result, rerender } = setup(card('ev1', 70, 'ev1-1'))
    expect(result.current.state?.key).toBe('quake:ev1')
    act(() => rerender({ q: card('ev1', 70, 'ev1-1'), e: [eewAlert('e1', 60)] }))
    expect(result.current.state?.key).toBe('eew:e1')
    act(() => void vi.advanceTimersByTime(SUPPRESS_MS + 1000))
    act(() => rerender({ qs: [card('ev2', 50, 'ev2-1'), card('ev1', 70, 'ev1-1')], e: NO_EEWS }))
    expect(result.current.state?.key).toBe('quake:ev2')
  })

  // 対照: 1 時間以内なら、より深刻な古い地震を選ぶ
  it('1 時間以内なら、より深刻な地震を選ぶ', () => {
    const { result, rerender } = setup(card('ev1', 70, 'ev1-1'))
    act(() => rerender({ q: card('ev1', 70, 'ev1-1'), e: [eewAlert('e1', 60)] }))
    act(() => void vi.advanceTimersByTime(SUPPRESS_MS - 60_000))
    act(() => rerender({ qs: [card('ev2', 50, 'ev2-1'), card('ev1', 70, 'ev1-1')], e: NO_EEWS }))
    expect(result.current.state?.key).toBe('quake:ev1')
  })

  // 安全弁: 続報が届けば期限は延びる
  it('続報が届けば、そこから 1 時間判定する', () => {
    const { result, rerender } = setup(card('ev2', 30, 'ev2-1'))
    act(() => rerender({ qs: [card('ev2', 30, 'ev2-1'), card('ev1', 30, 'ev1-1')] }))
    act(() => void vi.advanceTimersByTime(SUPPRESS_MS + 1000))
    act(() => rerender({ qs: [card('ev2', 30, 'ev2-1'), card('ev1', 55, 'ev1-2')] }))
    expect(result.current.state?.key).toBe('quake:ev1')
  })

  it('取消表示中の地震カードは判定しない', () => {
    const { result } = setup(cancelled(card('ev1', 70, 'ev1-1')))
    expect(result.current.state).toBe(null)
  })

  // 正: 出ている帯の元の地震が取り消されたら、帯を下ろす（緊急地震速報と同じ）
  it('出ている帯の元の地震が取り消されたら、帯を下ろす', () => {
    const { result, rerender } = setup(card('ev1', 70, 'ev1-1'))
    expect(result.current.state?.key).toBe('quake:ev1')
    act(() => rerender({ qs: [cancelled(card('ev1', 70, 'ev1-1'))] }))
    expect(result.current.state).toBe(null)
  })

  it('取り消された地震の帯を閉じてできた記録は捨てる', () => {
    const { result, rerender } = setup(card('ev1', 70, 'ev1-1'))
    act(() => result.current.dismiss())
    expect(localStorage.getItem('action-checklist-suppress')).not.toBe(null)
    act(() => rerender({ qs: [cancelled(card('ev1', 70, 'ev1-1'))] }))
    expect(localStorage.getItem('action-checklist-suppress')).toBe(null)
  })

  // 対照: 同じ鍵の生きたカードが並んでいれば（取消のあとに出し直された報）帯は下ろさない
  it('同じ鍵の生きたカードが残っていれば、帯は下ろさない', () => {
    const { result, rerender } = setup(card('ev1', 70, 'ev1-1'))
    act(() => rerender({ qs: [card('ev1', 70, 'ev1-2'), cancelled(card('ev1', 70, 'ev1-1'))] }))
    expect(result.current.state?.key).toBe('quake:ev1')
  })

  // 安全弁: 同じ鍵の取消カードの震度は使わない（生きたカードの震度で出す）
  it('同じ鍵の取消カードと並んでいても、震度は生きたカードから取る', () => {
    const { result, rerender } = setup(card('ev1', 50, 'ev1-1'))
    act(() => rerender({ qs: [card('ev1', 50, 'ev1-2'), cancelled(card('ev1', 70, 'ev1-1'))] }))
    expect(result.current.state?.scale).toBe(50)
  })

  /** 統合したカード（控えている電文つき）。`at` は控えの各電文の発表時刻。 */
  function folded(eventKey: string, maxScale: number, adoptedId: string, at: string[]): JMAQuake {
    const sources = at.map((time, i) => ({ ...quake(eventKey, maxScale), id: `${eventKey}-src${i}`, time }))
    return { ...card(eventKey, maxScale, adoptedId, `k-${adoptedId}`), sourceTelegrams: sources }
  }

  // 対照: 「もっと見る」で古い電文が足され、当て直しで採用される電文が古い完全版へ替わっても、
  // 続報は届いていないので判定しない
  it('古い電文が後から足されて採用される電文が替わっても、続報としない', () => {
    const { result, rerender } = setup(undefined)
    act(() => rerender({ qs: [card('ev2', 30, 'ev2-1'), folded('ev1', 70, 'ev1-prompt', ['2026/01/01 16:20:00'])] }))
    act(() => rerender({ qs: [card('ev2', 30, 'ev2-1'), folded('ev1', 70, 'ev1-full', ['2026/01/01 16:15:00', '2026/01/01 16:20:00'])] }))
    expect(result.current.state).toBe(null)
  })

  // 正: 同じ分に届いた続報も、通数で拾う
  it('最も新しい電文と同じ分に届いた続報も、続報として判定する', () => {
    const { result, rerender } = setup(undefined)
    act(() => rerender({ qs: [card('ev2', 30, 'ev2-1'), folded('ev1', 30, 'ev1-a', ['2026/01/01 16:20:00'])] }))
    act(() => rerender({ qs: [card('ev2', 30, 'ev2-1'), folded('ev1', 55, 'ev1-a', ['2026/01/01 16:20:00', '2026/01/01 16:20:00'])] }))
    expect(result.current.state?.key).toBe('quake:ev1')
  })

  // 正: 取消のあと、同じ地震が先頭でない位置へ出し直されたら続報として判定する
  it('取消のあと先頭でない位置へ出し直された地震は、続報として判定する', () => {
    const { result, rerender } = setup(undefined)
    act(() => rerender({ qs: [card('ev2', 30, 'ev2-1'), card('ev1', 30, 'ev1-1')] }))
    act(() => rerender({ qs: [card('ev2', 30, 'ev2-1'), cancelled(card('ev1', 30, 'ev1-1'))] }))
    act(() => rerender({ qs: [card('ev2', 30, 'ev2-1'), card('ev1', 60, 'ev1-2')] }))
    expect(result.current.state?.key).toBe('quake:ev1')
  })

  // 対照: 別の地震が取り消されても帯は残る
  it('元ではない地震が取り消されても帯は残る', () => {
    const { result, rerender } = setup(card('ev1', 70, 'ev1-1'))
    act(() => rerender({ qs: [cancelled(card('ev2', 30, 'ev2-1')), card('ev1', 70, 'ev1-1')] }))
    expect(result.current.state?.key).toBe('quake:ev1')
  })
})

// 判定した範囲（`scope`）は帯の見出しと根拠の 1 行にしか効かない。強震モニタは毎秒判定し、半径内の点が
// 欠測を出入りすると範囲だけが往復するので、そのたびに「帯が出た」を記録すると録画の記録が積み上がる。
describe('判定した範囲だけが変わった回', () => {
  const HOME: NearbyScope = {
    ...NO_SCOPE,
    stationNames: new Set(['新宿区西新宿']),
    regionNames: new Set(['東京都23区']),
    knownStationNames: new Set(['新宿区西新宿']),
    knownRegionNames: new Set(['東京都23区']),
  }
  function withPoints(q: JMAQuake, points: JMAQuake['points']): JMAQuake {
    return { ...q, points }
  }
  const AREA_ONLY = withPoints(quake('ev1', 50), [{ pref: '', addr: '東京都23区', isArea: true, scale: 50 }] as JMAQuake['points'])
  const WITH_STATION = withPoints(quake('ev1', 50), [
    { pref: '', addr: '東京都23区', isArea: true, scale: 45 },
    { pref: '', addr: '新宿区西新宿', isArea: false, scale: 50 },
  ] as JMAQuake['points'])
  const STATION_HIGHER = withPoints(quake('ev1', 55), [
    { pref: '', addr: '東京都23区', isArea: true, scale: 45 },
    { pref: '', addr: '新宿区西新宿', isArea: false, scale: 55 },
  ] as JMAQuake['points'])

  function setupHome(initial: JMAQuake) {
    return renderHook(
      ({ q }: { q: JMAQuake }) =>
        useActionChecklist({
          minScale: MIN,
          scope: HOME,
          detectedPoints: NO_POINTS,
          kyoshinStalled: false,
          eews: NO_EEWS,
          quakes: listOf(q),
        }),
      { initialProps: { q: initial } },
    )
  }
  function openedLog() {
    return drainReplayEvents().events
      .filter((e): e is ReplayOverlayEvent => e.type === 'overlay' && e.overlay === 'actionChecklist')
  }

  // 正: 範囲は描き直すが、記録は増やさない
  it('名乗りは描き直し、帯が出た記録は増やさない', () => {
    const { result, rerender } = setupHome(AREA_ONLY)
    expect(result.current.state?.scope).toBe('nearArea')
    __resetReplayEventLogForTest()
    act(() => rerender({ q: WITH_STATION }))
    expect(result.current.state?.scope).toBe('near')
    expect(result.current.state?.scale).toBe(50)
    act(() => rerender({ q: AREA_ONLY }))
    expect(result.current.state?.scope).toBe('nearArea')
    expect(openedLog()).toEqual([])
  })

  // 対照: 震度が変わった回は従来どおり記録する
  it('震度も変わった回は記録する', () => {
    const { rerender } = setupHome(AREA_ONLY)
    __resetReplayEventLogForTest()
    act(() => rerender({ q: STATION_HIGHER }))
    expect(openedLog().map(e => [e.open, e.reason])).toEqual([[true, '揺れを検知']])
  })

  // 安全弁: 畳んでいる間に範囲だけが変わっても、畳んだまま・記録も増やさない
  it('畳んだまま範囲だけが変わった回は、畳みを保ち記録しない', () => {
    const { result, rerender } = setupHome(AREA_ONLY)
    act(() => result.current.dismiss())
    __resetReplayEventLogForTest()
    act(() => rerender({ q: WITH_STATION }))
    expect(result.current.state?.scope).toBe('near')
    expect(result.current.collapsed).toBe(true)
    expect(openedLog()).toEqual([])
    expect(localStorage.getItem('action-checklist-suppress')).not.toBe(null)
  })

  // 対照: 範囲と一緒に震度が上がって開き直す回は、記録し、畳んだ記録も消す
  it('範囲と一緒に震度が上がって開き直す回は、記録して畳んだ記録を消す', () => {
    const { result, rerender } = setupHome(AREA_ONLY)
    act(() => result.current.dismiss())
    __resetReplayEventLogForTest()
    act(() => rerender({ q: STATION_HIGHER }))
    expect(result.current.collapsed).toBe(false)
    expect(openedLog().map(e => [e.open, e.reason])).toEqual([[true, '揺れを検知']])
    expect(localStorage.getItem('action-checklist-suppress')).toBe(null)
  })
})
