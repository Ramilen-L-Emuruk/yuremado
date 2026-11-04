import { describe, it, expect } from 'vitest'
import type { EEWAlert } from '../types/earthquake'
import { calcEEWCancelTime } from './eew'
import {
  createDetectionSpreadLog, decideEewExpiry, decideFinalReportExpiry,
  EEW_SPREAD_GRACE_MS, EEW_SPREAD_HOLD_MAX_MS, FIRST_ARRIVAL_WAIT_MS, type SpreadDetection,
} from './eewSpreadHold'
import { haversineKm } from './geo'
import { travelTimeSec } from './travelTime'

// 2026-10-30 17:45 根室半島南東沖（気象庁の最終報: 43.3N 146.3E・50km・M4.3）に似せた地震
const T0 = Date.parse('2026-10-30T08:45:55Z')
function makeEEW(overrides: Partial<EEWAlert['earthquake']> = {}): EEWAlert {
  return {
    kind: 'eew',
    origin: 'dmdata',
    id: 'test-eew',
    time: new Date(T0 + 45_000).toISOString(),
    test: false,
    isFinal: true,
    earthquake: {
      originTime: new Date(T0).toISOString(),
      arrivalTime: new Date(T0 + 5_000).toISOString(),
      condition: '以上',
      hypocenter: { name: '根室半島南東沖', latitude: 43.3, longitude: 146.3, depth: 50, magnitude: 4.3 },
      ...overrides,
    },
    severity: 'Forecast',
    cancelled: false,
  } as EEWAlert
}

/** 束 `id` を `epicenter` に置き、`fromSec`〜`untilSec`（発生から）の間 1 秒に 1 点ずつ増やして流す */
function feedGrowingBundle(
  log: ReturnType<typeof createDetectionSpreadLog>,
  opts: { id?: string; epicenter?: [number, number]; fromSec: number; growUntilSec: number; aliveUntilSec: number },
) {
  const { id = 'e0', epicenter = [43.3, 145.6], fromSec, growUntilSec, aliveUntilSec } = opts
  for (let s = fromSec; s <= aliveUntilSec; s++) {
    const n = Math.min(s, growUntilSec) - fromSec + 1
    const d: SpreadDetection = { id, epicenter, memberKeys: Array.from({ length: n }, (_, i) => `k${i}`) }
    log.push(T0 + s * 1000, [d])
  }
}

/**
 * `fromMs` の次の秒から `toMs` まで、検知の無い秒を 1 秒ずつ流す。ライブでは毎秒データが入るので、
 * 時刻を一度に飛ばすと係が「時間軸が変わった」とみなして束を捨てる（60 秒より大きな飛び）
 */
function tickEmpty(log: ReturnType<typeof createDetectionSpreadLog>, fromMs: number, toMs: number) {
  for (let ms = fromMs + 1000; ms <= toMs; ms += 1000) log.push(ms, [])
  log.push(toMs, [])
}

// 根室の震央から約 50km の観測点（観測網の中の地震にする）
const NEAR_NEMURO: [number, number] = [43.3, 145.7]

describe('decideFinalReportExpiry: 検知の束が広がっている間は自動解除を待つ', () => {
  const eew = makeEEW()
  const formulaMs = calcEEWCancelTime(eew, new Date(eew.time)).getTime()

  it('正: 解除の時刻にまだ点が加わっていれば、最後の追加から 30 秒まで待つ', () => {
    const log = createDetectionSpreadLog()
    log.setSites([NEAR_NEMURO])
    // 根室の実測に合わせ、発生 8 秒後に始まり 150 秒後まで点が加わる
    feedGrowingBundle(log, { fromSec: 8, growUntilSec: 150, aliveUntilSec: 150 })
    const d = decideFinalReportExpiry(eew, formulaMs, log)
    expect(d).toEqual({ kind: 'hold', untilMs: T0 + 150_000 + EEW_SPREAD_GRACE_MS })
  })

  it('対照: 点が加わらなくなって 30 秒を過ぎていれば、束が生きていても式の時刻で解除する', () => {
    const log = createDetectionSpreadLog()
    log.setSites([NEAR_NEMURO])
    // 60 秒で増えるのが止まり、束そのものは解除の時刻より後まで残る
    feedGrowingBundle(log, { fromSec: 8, growUntilSec: 60, aliveUntilSec: 120 })
    expect(formulaMs).toBeLessThan(T0 + 120_000)
    expect(T0 + 60_000 + EEW_SPREAD_GRACE_MS).toBeLessThan(formulaMs)
    expect(decideFinalReportExpiry(eew, formulaMs, log)).toEqual({ kind: 'expire', reason: 'grace-elapsed' })
  })

  it('対照: 観測網の中の地震は、有感半径の外の束を結び付けない（走時の窓に入っていても）', () => {
    const log = createDetectionSpreadLog()
    log.setSites([NEAR_NEMURO])
    // 根室から約 1000km の関東で、P 波が届く頃（発生 130 秒後）に始まった束。走時では合うが、根室の地震の揺れではない
    feedGrowingBundle(log, { epicenter: [35.0, 139.0], fromSec: 130, growUntilSec: 200, aliveUntilSec: 200 })
    expect(log.lastSpread(eew, T0 + 200_000)).toBeNull()
  })

  it('対照: 波が届く前に遠くで始まった束（別の揺れ）は結び付けない', () => {
    const log = createDetectionSpreadLog()
    log.setSites([NEAR_NEMURO])
    feedGrowingBundle(log, { epicenter: [35.0, 139.0], fromSec: 8, growUntilSec: 150, aliveUntilSec: 150 })
    expect(log.lastSpread(eew, T0 + 150_000)).toBeNull()
  })

  it('対照: 発生時刻より前に始まっていた束（前の地震）は結び付けない', () => {
    const log = createDetectionSpreadLog()
    feedGrowingBundle(log, { fromSec: -40, growUntilSec: 150, aliveUntilSec: 150 })
    expect(log.lastSpread(eew, T0 + 150_000)).toBeNull()
  })

  it('境: 震央の近くでは、発生の 10 秒前に始まった束まで結び、それより前は結ばない', () => {
    const at = createDetectionSpreadLog()
    feedGrowingBundle(at, { fromSec: -10, growUntilSec: 20, aliveUntilSec: 20 })
    expect(at.lastSpread(eew, T0 + 20_000)).not.toBeNull()
    const before = createDetectionSpreadLog()
    feedGrowingBundle(before, { fromSec: -11, growUntilSec: 20, aliveUntilSec: 20 })
    expect(before.lastSpread(eew, T0 + 20_000)).toBeNull()
  })

  it('対照: 仮の震源（仮定震源要素）の報は束と結び付けない', () => {
    const log = createDetectionSpreadLog()
    feedGrowingBundle(log, { fromSec: 8, growUntilSec: 150, aliveUntilSec: 150 })
    expect(log.lastSpread(makeEEW({ condition: '仮定震源要素' }), T0 + 150_000)).toBeNull()
    expect(log.firstArrivalWait(makeEEW({ condition: '仮定震源要素' }), T0 + 150_000)).toBeNull()
  })

  it('安全弁: 点が加わり続けても、式の時刻から 5 分より後へは延ばさない', () => {
    const log = createDetectionSpreadLog()
    feedGrowingBundle(log, { fromSec: 8, growUntilSec: 900, aliveUntilSec: 900 })
    const spread = log.lastSpread(eew, T0 + 900_000)
    expect(decideEewExpiry(formulaMs, formulaMs + 10_000, spread, null)).toEqual({ kind: 'hold', untilMs: formulaMs + EEW_SPREAD_HOLD_MAX_MS })
    expect(decideEewExpiry(formulaMs, formulaMs + EEW_SPREAD_HOLD_MAX_MS, spread, null)).toEqual({ kind: 'expire', reason: 'cap' })
  })

  it('解除の理由を言い分ける', () => {
    const stopped = { ms: formulaMs - 40_000, bySArrival: false }
    const sPassed = { ms: formulaMs - 40_000, bySArrival: true }
    expect(decideEewExpiry(formulaMs, formulaMs, null, null)).toEqual({ kind: 'expire', reason: 'no-bundle' })
    expect(decideEewExpiry(formulaMs, formulaMs, null, { kind: 'unavailable' })).toEqual({ kind: 'expire', reason: 'no-network-data' })
    expect(decideEewExpiry(formulaMs, formulaMs, null, { kind: 'wait', ms: formulaMs - 5_000 })).toEqual({ kind: 'expire', reason: 'no-bundle' })
    expect(decideEewExpiry(formulaMs, formulaMs + 30_000, null, { kind: 'wait', ms: formulaMs + 20_000 })).toEqual({ kind: 'expire', reason: 'first-arrival-elapsed' })
    expect(decideEewExpiry(formulaMs, formulaMs, stopped, null)).toEqual({ kind: 'expire', reason: 'grace-elapsed' })
    expect(decideEewExpiry(formulaMs, formulaMs, sPassed, null)).toEqual({ kind: 'expire', reason: 's-arrival-elapsed' })
    expect(decideEewExpiry(Number.NaN, formulaMs, stopped, null)).toEqual({ kind: 'expire', reason: 'formula-unknown' })
    // 束はあって先に止まり、観測網への波の待ちのほうが遅いが式の時刻より前に終わった → 束の理由（束が無いとは書かない）
    expect(decideEewExpiry(formulaMs, formulaMs, stopped, { kind: 'wait', ms: formulaMs - 10_000 })).toEqual({ kind: 'expire', reason: 'grace-elapsed' })
  })

  it('安全弁: 検知の束も観測点の一覧も無ければ、今までどおり式の時刻で解除する', () => {
    expect(decideFinalReportExpiry(eew, formulaMs, createDetectionSpreadLog())).toEqual({ kind: 'expire', reason: 'no-network-data' })
  })

  it('安全弁: 近い地震では、最寄りの観測点へ P 波が届く見込みを待っても式の時刻より延ばさない', () => {
    const log = createDetectionSpreadLog()
    // 震央から約 50km の観測点。P 波は 10 秒ほどで届くので、待ちは式の時刻より前に終わる
    log.setSites([NEAR_NEMURO])
    log.push(formulaMs, [])
    const wait = log.firstArrivalWait(eew, formulaMs)
    expect(wait?.kind).toBe('wait')
    expect(wait?.kind === 'wait' && wait.ms).toBeLessThan(formulaMs)
    expect(decideFinalReportExpiry(eew, formulaMs, log)).toEqual({ kind: 'expire', reason: 'no-bundle' })
  })
})

// 2026-11-04 01:48 硫黄島近海（緊急地震速報の最終報: 25.9N 141.8E・10km・M4.8・発生 01:48:35）。
// 強震モニタの最寄りの観測点は八丈島（約 824km）で、有感半径（約 417km）の外にある
const T1 = Date.parse('2026-11-03T16:48:35Z')
function makeIwojimaEEW(): EEWAlert {
  return {
    ...makeEEW(),
    id: 'test-eew-iwojima',
    time: new Date(T1 + 59_000).toISOString(),
    earthquake: {
      originTime: new Date(T1).toISOString(),
      arrivalTime: new Date(T1 + 17_000).toISOString(),
      condition: '以上',
      hypocenter: { name: '硫黄島近海', latitude: 25.9, longitude: 141.8, depth: 10, magnitude: 4.8 },
    },
  } as EEWAlert
}
const HACHIJO: [number, number] = [33.1, 139.8]
const BOSO: [number, number] = [35.0, 139.9]

describe('decideFinalReportExpiry: 観測網から遠い海域の地震', () => {
  const eew = makeIwojimaEEW()
  const formulaMs = calcEEWCancelTime(eew, new Date(eew.time)).getTime()
  const pAtHachijoMs = T1 + travelTimeSec('P', haversineKm(25.9, 141.8, HACHIJO[0], HACHIJO[1]), 10) * 1000
  /** 観測点を八丈島と房総に置いた係 */
  function makeLog() {
    const log = createDetectionSpreadLog()
    log.setSites([HACHIJO, BOSO])
    return log
  }
  /** 束 `id` を `epicenter` に置き、発生から `fromSec`〜`growUntilSec` 秒の間 1 秒に 1 点ずつ増やして流す */
  function feed(log: ReturnType<typeof createDetectionSpreadLog>, id: string, epicenter: [number, number], fromSec: number, growUntilSec: number) {
    for (let s = fromSec; s <= growUntilSec; s++) {
      log.push(T1 + s * 1000, [{ id, epicenter, memberKeys: Array.from({ length: s - fromSec + 1 }, (_, i) => `${id}-${i}`) }])
    }
  }

  it('正: 波が届いた関東で始まった束と、距離で切らずに結び付き、点が加わる間は待つ', () => {
    const log = makeLog()
    // 再生で見た形: 発生から約 131 秒後に房総付近（約 1020km）で始まり、関東・東北へ広がる
    feed(log, 'e0', BOSO, 131, 330)
    expect(log.lastSpread(eew, T1 + 330_000)).toEqual({ ms: T1 + 330_000, bySArrival: false })
    expect(decideFinalReportExpiry(eew, formulaMs, log)).toEqual({ kind: 'hold', untilMs: T1 + 330_000 + EEW_SPREAD_GRACE_MS })
  })

  it('正: P 波の束が止まっても、その場所へ S 波が届いて 30 秒までは待つ（S 波の束が続いて始まる間に消さない）', () => {
    const log = makeLog()
    // 再生で見た形: 房総の P 波の束は発生から 190 秒で点が止まり、神奈川の S 波の束は 264 秒後から始まる
    feed(log, 'e0', BOSO, 131, 190)
    const sAtBosoMs = T1 + travelTimeSec('S', haversineKm(25.9, 141.8, BOSO[0], BOSO[1]), 10) * 1000
    expect(sAtBosoMs).toBeGreaterThan(T1 + 190_000 + EEW_SPREAD_GRACE_MS)
    expect(decideFinalReportExpiry(eew, T1 + 220_000, log)).toEqual({ kind: 'hold', untilMs: sAtBosoMs + EEW_SPREAD_GRACE_MS })
    tickEmpty(log, T1 + 190_000, sAtBosoMs + EEW_SPREAD_GRACE_MS)
    expect(decideFinalReportExpiry(eew, sAtBosoMs + EEW_SPREAD_GRACE_MS, log)).toEqual({ kind: 'expire', reason: 's-arrival-elapsed' })
  })

  it('正: 式の時刻に束がまだ無くても、最寄りの観測点へ P 波が届く見込み＋60 秒までは待つ', () => {
    const log = makeLog()
    log.push(formulaMs, [])
    const wait = log.firstArrivalWait(eew, formulaMs)
    expect(wait).toEqual({ kind: 'wait', ms: pAtHachijoMs + FIRST_ARRIVAL_WAIT_MS })
    expect(pAtHachijoMs + FIRST_ARRIVAL_WAIT_MS).toBeGreaterThan(formulaMs)
    expect(decideFinalReportExpiry(eew, formulaMs, log)).toEqual({ kind: 'hold', untilMs: pAtHachijoMs + FIRST_ARRIVAL_WAIT_MS })
  })

  it('正: 小さな束が先に止まっても、観測網へ波が届く見込みより前には消さない', () => {
    const stoppedEarly = { ms: formulaMs - 40_000, bySArrival: false }
    const wait = { kind: 'wait' as const, ms: formulaMs + 20_000 }
    expect(decideEewExpiry(formulaMs, formulaMs, stoppedEarly, wait)).toEqual({ kind: 'hold', untilMs: formulaMs + 20_000 })
  })

  it('対照: 見込みを過ぎても束ができなければ、そこで解除する', () => {
    const log = makeLog()
    const untilMs = pAtHachijoMs + FIRST_ARRIVAL_WAIT_MS
    log.push(untilMs, [])
    expect(decideFinalReportExpiry(eew, untilMs, log)).toEqual({ kind: 'expire', reason: 'first-arrival-elapsed' })
  })

  it('対照: 強震モニタのデータが止まっていれば、観測網へ波が届くのを待たない', () => {
    const log = makeLog()
    // 最後のデータは式の時刻の 1 分前
    log.push(formulaMs - 60_000, [])
    expect(log.firstArrivalWait(eew, formulaMs)).toEqual({ kind: 'unavailable' })
    expect(decideFinalReportExpiry(eew, formulaMs, log)).toEqual({ kind: 'expire', reason: 'no-network-data' })
  })

  it('対照: 強震モニタが止まっていれば、残った束を S 波の見込みでは延ばさない', () => {
    const log = makeLog()
    feed(log, 'e0', BOSO, 131, 190)
    // 最後のデータは発生 190 秒後。そこから 1 分経ったいま、S 波の束はできようがない
    expect(log.lastSpread(eew, T1 + 250_000)).toEqual({ ms: T1 + 190_000, bySArrival: false })
    expect(log.lastSpread(eew, T1 + 200_000)?.bySArrival).toBe(true)
  })

  it('対照: P 波が届く前に関東で始まった束（別の揺れ）は結び付けない', () => {
    const log = makeLog()
    // 発生 18 秒後に東京付近（約 1100km）。P 波が届くのは 2 分あまり後
    feed(log, 'e0', [35.7, 139.8], 18, 40)
    expect(log.lastSpread(eew, T1 + 40_000)).toBeNull()
  })

  it('安全弁: 観測網へ波が届くのを待つのも、式の時刻から 5 分より後へは延ばさない', () => {
    const late = { kind: 'wait' as const, ms: formulaMs + EEW_SPREAD_HOLD_MAX_MS + 60_000 }
    expect(decideEewExpiry(formulaMs, formulaMs, null, late)).toEqual({ kind: 'hold', untilMs: formulaMs + EEW_SPREAD_HOLD_MAX_MS })
    expect(decideEewExpiry(formulaMs, formulaMs + EEW_SPREAD_HOLD_MAX_MS, null, late)).toEqual({ kind: 'expire', reason: 'cap-first-arrival' })
  })
})

describe('createDetectionSpreadLog: 時間軸が変わったら覚えた束を捨てる', () => {
  it('データ時刻が巻き戻ったら、同じ id の束を古い束の続きと取り違えない', () => {
    const eew = makeEEW()
    const log = createDetectionSpreadLog()
    feedGrowingBundle(log, { fromSec: 8, growUntilSec: 150, aliveUntilSec: 150 })
    // 再生を始め直して時刻が戻る（検知器も作り直され id が e0 から振り直される）
    log.push(T0 - 3_600_000, [])
    expect(log.lastSpread(eew, T0 - 3_600_000)).toBeNull()
  })

  it('読めないデータ時刻は無視する', () => {
    const log = createDetectionSpreadLog()
    feedGrowingBundle(log, { fromSec: 8, growUntilSec: 20, aliveUntilSec: 20 })
    log.push(Number.NaN, [])
    expect(log.lastSpread(makeEEW(), T0 + 20_000)).toEqual({ ms: T0 + 20_000, bySArrival: false })
  })

  it('最初の点の座標が読めない束は覚えない（距離 0 として震源の真上の束に化けさせない）', () => {
    const log = createDetectionSpreadLog()
    feedGrowingBundle(log, { epicenter: [Number.NaN, Number.NaN], fromSec: 8, growUntilSec: 20, aliveUntilSec: 20 })
    expect(log.lastSpread(makeEEW(), T0 + 20_000)).toBeNull()
  })
})
