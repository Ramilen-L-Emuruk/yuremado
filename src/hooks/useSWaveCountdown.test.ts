// @vitest-environment jsdom
//
// 登録地点への主要動到達カウントダウンの**出どころの出し分け**のテスト。
//
// ここで固定したいのは 1 点だけ —— **トークンを持たない端末が自前の走時計算へ倒れないこと。**
// 自前計算で個別地点の到達時刻を出す行為は気象業務法第 17 条の許可を要する地震動の予報業務に
// 当たりうる（→ `docs/spec/eew-spec.md` §6）。公開版は気象庁の発表値を伝えるだけで、
// 発表値が無ければ**何も出さない**（自前計算は最後の手段にもしない）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { EEWAlert, EEWRegion } from '../types/earthquake'
import type { PsWaveCircle } from '../services/kyoshin'
import type { SubRegion } from '../utils/subregions'
import { haversineKm } from '../utils/geo'
import { travelTimeSec } from '../utils/travelTime'
import { calcArrivalSafetyMarginSec } from '../utils/eew'

const NOTO: SubRegion = {
  name: '石川県能登',
  label: [37.0, 136.9],
  room: [0, 0],
  rings: [[[37.5, 136.5], [37.5, 137.5], [36.5, 137.5], [36.5, 136.5]]],
}

vi.mock('./useSubRegions', () => ({ useSubRegions: () => ({ data: [NOTO], failed: false }) }))

// 残り秒数を決め打ちにするため、サーバー同期時刻を固定する。
const NOW = Date.parse('2024-01-01T16:19:00+09:00')
// `serverDate` も要る —— 記録の時刻印（`utils/logger.ts`）が呼ぶので、欠けると自前計算の経路だけ落ちる。
vi.mock('../utils/clock', () => ({ serverNow: () => NOW, serverDate: () => new Date(NOW) }))

const { compareArrivalRows, countdownBeepTarget, useSWaveCountdown } = await import('./useSWaveCountdown')
type Row = import('./useSWaveCountdown').SWaveArrivalRow

const HOME = { lat: 37.0, lng: 136.9 }

function area(over: Partial<EEWRegion> = {}): EEWRegion {
  return {
    pref: '石川県',
    name: NOTO.name,
    scaleFrom: 40,
    scaleTo: 40,
    // 既定は「警報・未到達」。`11` を既定にすると到達予測時刻を見る経路を踏めない。
    kindCode: '10',
    arrivalTime: null,
    ...over,
  }
}

function eew(areas: EEWRegion[], id = 'e1', hypocenter = { name: '能登半島沖', latitude: 37.5, longitude: 137.2, depth: 20, magnitude: 6.0 }): EEWAlert {
  return {
    kind: 'eew',
    origin: 'dmdata',
    id,
    time: '2024-01-01T16:18:51+09:00',
    test: false,
    earthquake: {
      originTime: '2024-01-01T16:18:45+09:00',
      arrivalTime: '2024-01-01T16:18:45+09:00',
      condition: '',
      hypocenter,
    },
    severity: 'Warning',
    cancelled: false,
    issue: { eventId: id, serial: '1', time: '2024-01-01T16:18:51+09:00' },
    areas,
  }
}

/** 予報円は「震源が判っていて波面が地表に出ている」状態を 1 つだけ与える。 */
const CIRCLE: PsWaveCircle = {
  eventId: 'e1',
  lat: 37.5,
  lng: 137.2,
  pRadius: 90,
  sRadius: 40,
  depth: 20,
  magnitude: 6.0,
}

const run = (eews: EEWAlert[], allowOwn: boolean, waves: PsWaveCircle[] = [CIRCLE]) =>
  renderHook(() => useSWaveCountdown(waves, eews, HOME, true, allowOwn)).result.current

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('useSWaveCountdown: 出どころの出し分け', () => {
  const ARRIVAL = '2024-01-01T16:19:20+09:00' // NOW から 20 秒後

  it('トークンが無ければ気象庁の発表値を区域名付きで伝える（既定）', () => {
    const got = run([eew([area({ arrivalTime: ARRIVAL })])], false)
    expect(got?.source).toBe('telegram')
    expect(got?.areaName).toBe(NOTO.name)
    expect(got?.rows[0].etaSec).toBe(20)
  })

  it('トークンがあれば自前の走時計算へ切り替わる（正）', () => {
    const got = run([eew([area({ arrivalTime: ARRIVAL })])], true)
    expect(got?.source).toBe('own')
    // 地点そのものの値なので区域名は持たない（区域の値だと読まれないようにするため）。
    expect(got?.areaName).toBeNull()
  })

  // 意図的に覆した（2026-10-14 ユーザー承認「距離だけのカードを出す」）: 以前は何も出さなかった。
  // 守るものは変わらない —— **ここが自前計算へ倒れると、公開版が許可の要る形で動く。**
  // 予報円は与えてあるので、自前計算の材料は揃っている状態で確かめる。秒数は出さず、距離だけの行になる。
  it('トークンが無く発表値も無ければ、自前計算へ倒さず距離だけの行にする（安全弁）', () => {
    const got = run([eew([area({ arrivalTime: null })])], false)
    expect(got?.source).toBe('telegram')
    expect(got?.rows.map((r) => [r.noForecast, r.etaSec, r.arrived])).toEqual([[true, null, false]])
  })

  it('トークンが無く PLUM 法の区域しか無ければ、自前計算へ倒さず距離だけの行にする（安全弁）', () => {
    // PLUM の時刻は過去の時刻。発表値として使えないので、ここも自前計算へ倒さない。
    const got = run([eew([area({ kindCode: '19', arrivalTime: ARRIVAL })])], false)
    expect(got?.source).toBe('telegram')
    expect(got?.rows.map((r) => [r.noForecast, r.etaSec])).toEqual([[true, null]])
  })

  it('発表中の緊急地震速報が無ければ何も出さない', () => {
    const got = renderHook(() => useSWaveCountdown([CIRCLE], [], HOME, false, false)).result.current
    expect(got).toBeNull()
  })
})

// 「震源から N km」は**震源の緯度経度だけで決まる観測事実**で、深さとは関係が無い。
// 深さが判らない報では予報円を出さない（`computeEewCircle`。→ `docs/spec/eew-spec.md` §6）ので、
// 距離を円から拾う形のままだと**位置は判っているのに距離の行だけが消える**。
// 止めたかったのは根拠の無い秒数であって、距離ではない。
describe('useSWaveCountdown: 距離は予報円の有無に依存しない', () => {
  const ARRIVAL = '2024-01-01T16:19:20+09:00'

  // 正: 円が 1 つも無くても、発表値の経路は距離を出す。
  it('予報円が無くても発表値の経路は距離を出す', () => {
    const got = run([eew([area({ arrivalTime: ARRIVAL })])], false, [])
    expect(got?.source).toBe('telegram')
    expect(got?.rows[0].distanceKm).not.toBeNull()
    // 震源（37.5, 137.2）から HOME（37.0, 136.9）まで。円がある場合と同じ値になる。
    const withCircle = run([eew([area({ arrivalTime: ARRIVAL })])], false)
    expect(got?.rows[0].distanceKm).toBeCloseTo(withCircle!.rows[0].distanceKm!, 6)
  })

  // 対照: 位置も判らない報（センチネル `-200`）では距離を出さない。
  // **「円が無い」を一律で救う形にしていない**ことを見る。
  it('位置が判らない報では距離を出さない', () => {
    const e = eew([area({ arrivalTime: ARRIVAL })])
    const hidden: EEWAlert = {
      ...e,
      earthquake: { ...e.earthquake, hypocenter: { ...e.earthquake.hypocenter, latitude: -200, longitude: -200 } },
    }
    const got = run([hidden], false, [])
    expect(got?.rows[0].distanceKm).toBeNull()
  })

  // 安全弁: 取消済みの報は距離の候補に数えない（画面から消えたものの距離を出さない）。
  it('取消済みの報は距離の候補にしない', () => {
    const e = eew([area({ arrivalTime: ARRIVAL })])
    const got = run([{ ...e, cancelled: true }], false, [])
    expect(got?.rows[0].distanceKm ?? null).toBeNull()
  })
})

// 仮定震源要素（震源未確定）は、地名も座標も「最初に揺れを捉えた観測点の所在地」であって
// 震源ではない（→ `docs/spec/eew-spec.md` §5）。**元から距離は出ていなかった** ——
// 予報円を出さないので円から拾えず null だった。上の受け皿を足したときに巻き込まないよう固定する。
describe('useSWaveCountdown: 仮定震源要素は距離の候補にしない', () => {
  const ARRIVAL = '2024-01-01T16:19:20+09:00'

  it('仮定震源要素しか無ければ距離を出さない', () => {
    const e = eew([area({ arrivalTime: ARRIVAL })])
    const assumed: EEWAlert = {
      ...e,
      earthquake: { ...e.earthquake, condition: '仮定震源要素' },
    }
    const got = run([assumed], false, [])
    expect(got?.rows[0].distanceKm ?? null).toBeNull()
    // 行は出す（区域の発表値はある）。地名は震源ではないので、画面が「（震源未確定）」を添えられるよう印を持つ。
    expect(got?.rows[0].provisional).toBe(true)
  })

  // 対照: 同じ報でも `condition` が空（確定震源）なら距離を出す。
  // **「円が無いと出さない」へ戻っていない**ことを見る。
  it('確定震源なら円が無くても距離を出す（対照）', () => {
    const got = run([eew([area({ arrivalTime: ARRIVAL })])], false, [])
    expect(got?.rows[0].distanceKm).not.toBeNull()
  })
})

// 2026-10-14 ユーザー決定「地震ごとに並べて出す」。見せ方・並び順・音は 2026-10-18 ユーザー承認
// （「1 枚に行を並べる」「到達の早い順」「いちばん早く届く地震」）。以前は S 波の円がいちばん大きい 1 件だけを相手にし、
// 公開版では秒数をすべての速報の区域の値から、距離を別の 1 件から採っていた。
describe('useSWaveCountdown: 複数の地震は地震ごとに行を出す', () => {
  const FAR = { name: '岐阜県美濃中西部', latitude: 35.6, longitude: 136.6, depth: 10, magnitude: 5.0 }

  // 正: 発表値の経路で、地震ごとにその速報の区域の値と、同じ速報の震源からの距離を出す。到達の早い順に並べる。
  it('発表値の経路は地震ごとに行を出し、到達の早い順に並べる', () => {
    const near = eew([area({ arrivalTime: '2024-01-01T16:19:20+09:00' })], 'near')
    const far = eew([area({ arrivalTime: '2024-01-01T16:19:08+09:00' })], 'far', FAR)
    const got = run([near, far], false, [])
    expect(got?.rows.map((r) => [r.key, r.etaSec])).toEqual([['far', 8], ['near', 20]])
    expect(got?.rows.map((r) => r.hypocenterName)).toEqual([FAR.name, '能登半島沖'])
    // 距離はその行の地震の震源から測る（別の地震の距離を出さない）。
    const [farRow, nearRow] = got!.rows
    expect(farRow.distanceKm!).toBeCloseTo(haversineKm(FAR.latitude, FAR.longitude, HOME.lat, HOME.lng), 6)
    expect(nearRow.distanceKm!).toBeCloseTo(haversineKm(37.5, 137.2, HOME.lat, HOME.lng), 6)
  })

  // 対照: ホーム地点の区域について値を出していない速報の行は作らない。
  // 意図的に覆した（2026-10-14 ユーザー承認「距離だけのカードを出す」・並べ方は 2026-10-19 ユーザー承認
  // 「行として最後に並べる (推奨)」）: 以前はホーム地点の区域に値の無い速報の行を作らなかった。
  // 別の区域の値（東京都23区）は秒数に混ぜず、距離だけの行として最後に並べる。
  it('ホーム地点の区域に値の無い速報は距離だけの行にして最後に並べる', () => {
    const near = eew([area({ arrivalTime: '2024-01-01T16:19:20+09:00' })], 'near')
    const other = eew([area({ name: '東京都23区', arrivalTime: '2024-01-01T16:19:08+09:00' })], 'other', FAR)
    const rows = run([other, near], false, [])?.rows
    expect(rows?.map((r) => [r.key, r.noForecast, r.etaSec])).toEqual([['near', false, 20], ['other', true, null]])
    expect(rows?.[1].distanceKm).not.toBeNull()
  })

  // 対照: 距離を出せない報（位置不明・仮定震源要素・取消済み）は、値が無くても行を作らない。
  it('震源が判らない・決まっていない・取り消された報は距離だけの行も作らない', () => {
    const base = eew([area({ name: '東京都23区', arrivalTime: '2024-01-01T16:19:08+09:00' })], 'x')
    const hidden: EEWAlert = { ...base, earthquake: { ...base.earthquake, hypocenter: { ...base.earthquake.hypocenter, latitude: -200, longitude: -200 } } }
    const assumed: EEWAlert = { ...base, earthquake: { ...base.earthquake, condition: '仮定震源要素' } }
    expect(run([hidden], false, [])).toBeNull()
    expect(run([assumed], false, [])).toBeNull()
    expect(run([{ ...base, cancelled: true }], false, [])).toBeNull()
  })

  // 安全弁: 自前計算の経路は距離だけの行を作らない（予報円ごとに秒数を出す経路のまま）。
  it('自前計算の経路の行は距離だけの行にならない', () => {
    const got = run([eew([area({ name: '東京都23区', arrivalTime: '2024-01-01T16:19:08+09:00' })])], true)
    expect(got?.source).toBe('own')
    expect(got?.rows.every((r) => !r.noForecast)).toBe(true)
  })

  // 正: 自前計算の経路も予報円 1 つ（＝地震 1 つ）ごとに行を作る。
  it('自前計算の経路は予報円ごとに行を出す', () => {
    const near = eew([], 'near')
    const far = eew([], 'far', FAR)
    const waves: PsWaveCircle[] = [
      { ...CIRCLE, eventId: 'near' },
      { eventId: 'far', lat: FAR.latitude, lng: FAR.longitude, pRadius: 90, sRadius: 40, depth: 10, magnitude: 7.0 },
    ]
    const got = run([near, far], true, waves)
    expect(got?.source).toBe('own')
    expect(got?.rows.map((r) => r.key).sort()).toEqual(['far', 'near'])
  })

  // 安全弁: 解除までに届かない地震は、その地震の行だけを落とす。もう 1 つの地震の行は残す
  // （以前は選んだ 1 件が届かないと判定されるとカードごと消え、近い別の地震も出なかった）。
  it('解除までに届かない地震の行だけを落とし、ほかの地震の行は残す', () => {
    const near = eew([], 'near')
    const tiny = eew([], 'tiny', { name: '奄美大島近海', latitude: 28.3, longitude: 129.5, depth: 10, magnitude: 2.0 })
    const waves: PsWaveCircle[] = [
      { ...CIRCLE, eventId: 'near' },
      // 円は大きいが規模が小さく遠い（以前の「いちばん大きい円」を選ぶ形ならこちらが選ばれていた）。
      { eventId: 'tiny', lat: 28.3, lng: 129.5, pRadius: 200, sRadius: 120, depth: 10, magnitude: 2.0 },
    ]
    expect(run([near, tiny], true, waves)?.rows.map((r) => r.key)).toEqual(['near'])
  })
})

// 自前計算で残りが 0 秒へ丸まった行は到達済みとして扱う（発表値の経路と揃える）。
// 未到達のまま 0 秒を出すと、並びでも見出しでも「まだ来ていない」側に残る。
describe('useSWaveCountdown: 自前計算の 0 秒は到達済み', () => {
  const dist = haversineKm(CIRCLE.lat, CIRCLE.lng, HOME.lat, HOME.lng)
  // 実装と同じ式（走時表＋安全マージン）で、残りが `remainSec` 秒になる波面の半径を二分探索で引く。
  const radiusFor = (remainSec: number): number => {
    const target = travelTimeSec('S', dist, CIRCLE.depth) + calcArrivalSafetyMarginSec(dist) - remainSec
    let lo = 0
    let hi = 2000
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2
      if (travelTimeSec('S', mid, CIRCLE.depth) < target) lo = mid
      else hi = mid
    }
    return lo
  }

  // 正: 残りが 0.3 秒（0 へ丸まる）なら到達済みになる。
  it('残りが 0 秒へ丸まれば到達済み', () => {
    const row = run([eew([])], true, [{ ...CIRCLE, sRadius: radiusFor(0.3) }])?.rows[0]
    expect(row?.etaSec).toBe(0)
    expect(row?.arrived).toBe(true)
  })

  // 対照: 残りが 0.7 秒（1 へ丸まる）なら到達済みにしない。
  it('残りが 1 秒へ丸まるなら未到達のまま', () => {
    const row = run([eew([])], true, [{ ...CIRCLE, sRadius: radiusFor(0.7) }])?.rows[0]
    expect(row?.etaSec).toBe(1)
    expect(row?.arrived).toBe(false)
  })
})

// 安全弁: 予報円を作った速報を一覧から引けないときは行を作らない（「震源調査中」や別の地震の名前で埋めない）。
describe('useSWaveCountdown: 円を作った速報を引けなければ行を作らない', () => {
  it('引き当てられない円の行は出さず、引ける円の行は出す', () => {
    const waves: PsWaveCircle[] = [{ ...CIRCLE, eventId: 'near' }, { ...CIRCLE, eventId: 'gone' }]
    expect(run([eew([], 'near')], true, waves)?.rows.map((r) => r.key)).toEqual(['near'])
  })
})

describe('compareArrivalRows', () => {
  const row = (key: string, etaSec: number | null, arrived = false, noForecast = false): Row =>
    ({ key, hypocenterName: null, provisional: false, distanceKm: noForecast ? 100 : null, etaSec, arrived, noForecast })

  it('到達済みを先頭、残りは秒数の短い順、推定中を最後に並べる', () => {
    const sorted = [row('a', 20), row('b', null), row('c', 0, true), row('d', 5)].sort(compareArrivalRows)
    expect(sorted.map((r) => r.key)).toEqual(['c', 'd', 'a', 'b'])
  })

  // 2026-10-19 ユーザー承認「行として最後に並べる (推奨)」: 到達予測の出ていない行は推定中よりも後ろ。
  it('到達予測の出ていない行は推定中よりも後ろに並べる', () => {
    const sorted = [row('a', null, false, true), row('b', null), row('c', 0, true), row('d', 5)].sort(compareArrivalRows)
    expect(sorted.map((r) => r.key)).toEqual(['c', 'd', 'b', 'a'])
  })

  // 同点は地震の鍵で決める（描き直しのたびに並びが揺れない）。
  it('同点は地震の鍵の順', () => {
    expect([row('z', 5), row('a', 5)].sort(compareArrivalRows).map((r) => r.key)).toEqual(['a', 'z'])
  })
})

describe('countdownBeepTarget', () => {
  const row = (key: string, etaSec: number | null, arrived = false, noForecast = false): Row =>
    ({ key, hypocenterName: null, provisional: false, distanceKm: noForecast ? 100 : null, etaSec, arrived, noForecast })
  const of = (rows: Row[]) => ({ source: 'telegram' as const, areaName: NOTO.name, rows: [...rows].sort(compareArrivalRows) })

  // 正（2026-10-18 ユーザー承認「いちばん早く届く地震」）: まだ届いていない地震のうち到達がいちばん早いもの。
  it('まだ届いていない地震のうち到達がいちばん早いものの秒数', () => {
    expect(countdownBeepTarget(of([row('a', 12), row('b', 4)]))).toEqual({ key: 'b', etaSec: 4 })
  })

  // 正: 先に届いた地震の後は、次の地震の秒数へ移る（到達済みの地震で音を止めない）。
  it('届いた地震は飛ばして次の地震の秒数で鳴らす', () => {
    // 鍵も返すので、呼び出し側は「前の地震と同じ秒数」でも地震が替われば鳴らせる。
    expect(countdownBeepTarget(of([row('a', 0, true), row('b', 3)]))).toEqual({ key: 'b', etaSec: 3 })
  })

  // 安全弁（2026-10-19 ユーザー承認「秒読みの音には加えない」）: 到達予測の出ていない行は音の相手にしない。
  // 秒数を持たない形のまま etaSec だけ埋まった行が来ても、印のほうで外す。
  it('到達予測の出ていない行では鳴らさない', () => {
    expect(countdownBeepTarget(of([row('a', null, false, true)]))).toBeNull()
    expect(countdownBeepTarget(of([row('a', 7, false, true), row('b', 9)]))).toEqual({ key: 'b', etaSec: 9 })
  })

  // 安全弁: 全部届いた・秒数が判らないなら鳴らさない。
  it('鳴らす相手が無ければ null', () => {
    expect(countdownBeepTarget(of([row('a', 0, true), row('b', null)]))).toBeNull()
    expect(countdownBeepTarget(null)).toBeNull()
  })
})
