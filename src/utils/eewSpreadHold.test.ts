import { describe, it, expect } from 'vitest'
import type { EEWAlert } from '../types/earthquake'
import { calcEEWCancelTime } from './eew'
import {
  createDetectionSpreadLog, decideEewExpiry, decideFinalReportExpiry,
  EEW_SPREAD_GRACE_MS, EEW_SPREAD_HOLD_MAX_MS, type SpreadDetection,
} from './eewSpreadHold'

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

describe('decideFinalReportExpiry: 検知の束が広がっている間は自動解除を待つ', () => {
  const eew = makeEEW()
  const formulaMs = calcEEWCancelTime(eew, new Date(eew.time)).getTime()

  it('正: 解除の時刻にまだ点が加わっていれば、最後の追加から 30 秒まで待つ', () => {
    const log = createDetectionSpreadLog()
    // 根室の実測に合わせ、発生 8 秒後に始まり 150 秒後まで点が加わる
    feedGrowingBundle(log, { fromSec: 8, growUntilSec: 150, aliveUntilSec: 150 })
    const d = decideFinalReportExpiry(eew, formulaMs, log)
    expect(d).toEqual({ kind: 'hold', untilMs: T0 + 150_000 + EEW_SPREAD_GRACE_MS })
  })

  it('対照: 点が加わらなくなって 30 秒を過ぎていれば、束が生きていても式の時刻で解除する', () => {
    const log = createDetectionSpreadLog()
    // 60 秒で増えるのが止まり、束そのものは解除の時刻より後まで残る
    feedGrowingBundle(log, { fromSec: 8, growUntilSec: 60, aliveUntilSec: 120 })
    expect(T0 + 60_000 + EEW_SPREAD_GRACE_MS).toBeLessThan(formulaMs)
    expect(decideFinalReportExpiry(eew, formulaMs, log)).toMatchObject({ kind: 'expire' })
  })

  it('対照: 有感半径の外で始まった束は結び付けない', () => {
    const log = createDetectionSpreadLog()
    feedGrowingBundle(log, { epicenter: [35.0, 139.0], fromSec: 8, growUntilSec: 150, aliveUntilSec: 150 })
    expect(log.lastSpreadMs(eew)).toBeNull()
    expect(decideFinalReportExpiry(eew, formulaMs, log)).toMatchObject({ kind: 'expire' })
  })

  it('対照: 発生時刻より前に始まっていた束（前の地震）は結び付けない', () => {
    const log = createDetectionSpreadLog()
    feedGrowingBundle(log, { fromSec: -40, growUntilSec: 150, aliveUntilSec: 150 })
    expect(log.lastSpreadMs(eew)).toBeNull()
  })

  it('対照: 仮の震源（仮定震源要素）の報は束と結び付けない', () => {
    const log = createDetectionSpreadLog()
    feedGrowingBundle(log, { fromSec: 8, growUntilSec: 150, aliveUntilSec: 150 })
    expect(log.lastSpreadMs(makeEEW({ condition: '仮定震源要素' }))).toBeNull()
  })

  it('安全弁: 点が加わり続けても、式の時刻から 5 分より後へは延ばさない', () => {
    const log = createDetectionSpreadLog()
    feedGrowingBundle(log, { fromSec: 8, growUntilSec: 900, aliveUntilSec: 900 })
    const d = decideEewExpiry(formulaMs, formulaMs + 10_000, log.lastSpreadMs(eew))
    expect(d).toEqual({ kind: 'hold', untilMs: formulaMs + EEW_SPREAD_HOLD_MAX_MS })
    expect(decideEewExpiry(formulaMs, formulaMs + EEW_SPREAD_HOLD_MAX_MS, log.lastSpreadMs(eew))).toMatchObject({ kind: 'expire' })
  })

  it('解除の理由を言い分ける（束が無い・点が止まった・上限に当たった）', () => {
    expect(decideEewExpiry(formulaMs, formulaMs, null)).toEqual({ kind: 'expire', reason: 'no-bundle' })
    expect(decideEewExpiry(formulaMs, formulaMs, formulaMs - 40_000)).toEqual({ kind: 'expire', reason: 'grace-elapsed' })
    expect(decideEewExpiry(formulaMs, formulaMs + EEW_SPREAD_HOLD_MAX_MS, formulaMs + EEW_SPREAD_HOLD_MAX_MS - 1_000))
      .toEqual({ kind: 'expire', reason: 'cap' })
    expect(decideEewExpiry(Number.NaN, formulaMs, formulaMs)).toEqual({ kind: 'expire', reason: 'formula-unknown' })
  })

  it('安全弁: 検知の束が無ければ今までどおり式の時刻で解除する', () => {
    expect(decideFinalReportExpiry(eew, formulaMs, createDetectionSpreadLog())).toMatchObject({ kind: 'expire' })
  })
})

describe('createDetectionSpreadLog: 時間軸が変わったら覚えた束を捨てる', () => {
  it('データ時刻が巻き戻ったら、同じ id の束を古い束の続きと取り違えない', () => {
    const eew = makeEEW()
    const log = createDetectionSpreadLog()
    feedGrowingBundle(log, { fromSec: 8, growUntilSec: 150, aliveUntilSec: 150 })
    // 再生を始め直して時刻が戻る（検知器も作り直され id が e0 から振り直される）
    log.push(T0 - 3_600_000, [])
    expect(log.lastSpreadMs(eew)).toBeNull()
  })

  it('読めないデータ時刻は無視する', () => {
    const log = createDetectionSpreadLog()
    feedGrowingBundle(log, { fromSec: 8, growUntilSec: 20, aliveUntilSec: 20 })
    log.push(Number.NaN, [])
    expect(log.lastSpreadMs(makeEEW())).toBe(T0 + 20_000)
  })
})
