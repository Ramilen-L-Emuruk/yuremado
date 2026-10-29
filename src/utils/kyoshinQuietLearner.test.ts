import { describe, expect, it } from 'vitest'
import { createQuietLearner, parseQuietLearnerState, type QuietLearnerOptions, type QuietLearnerState } from './kyoshinQuietLearner'
import { EMPTY_QUIET_COUNTS, quietSiteKey, type QuietTables, type TailCounts } from './kyoshinQuietTables'

const SITES: [number, number][] = [[35.3, 136.8], [38.4, 140]]
const K0 = quietSiteKey(SITES[0])
/** 日本時間の 2026-01-01 0 時 */
const T0 = Date.UTC(2025, 11, 31, 15)
const HOUR = 3_600_000

const last = <T>(xs: T[]): T => xs[xs.length - 1]
const tail = (n: number): TailCounts =>({ n, y: new Array(12).fill(0), y3: new Array(12).fill(0) })
const PRIOR: QuietTables = {
  version: 1, days: ['20260911'], glob: tail(200_000),
  tails: { [K0]: tail(100_000), [quietSiteKey(SITES[1])]: tail(100_000) },
  fire: { [K0]: [0, 0, 0, 0, 0] },
}

function harness(over: Partial<QuietLearnerOptions> = {}) {
  const tables: QuietTables[] = []
  const saved: QuietLearnerState[] = []
  const learner = createQuietLearner({
    prior: PRIOR, initial: null, priorSec: 86_400, halfLifeMs: 7 * 24 * HOUR, guardMs: 60_000, rebuildEveryMs: HOUR,
    minHourSec: 0, onTables: t => tables.push(t), onSave: s => saved.push(s), ...over,
  })
  /** `fromSec` 秒目から `len` 秒、値 `v` を流す。`detectAt` に入る秒は揺れ検知が出ている扱い */
  const feed = (fromSec: number, len: number, v = 3, detectAt: (s: number) => boolean = () => false) => {
    for (let s = fromSec; s < fromSec + len; s++) learner.push(T0 + s * 1000, 'c1', SITES, [v, v], detectAt(s))
  }
  /** `day` 日目の各時間帯の頭から `len` 秒ずつ流す（`skipHour` の時間帯は飛ばす） */
  const feedEveryHour = (day: number, len: number, skipHour = -1) => {
    for (let h = 0; h < 24; h++) if (h !== skipHour) feed(day * 86_400 + h * 3_600, len)
  }
  const counted = () => learner.counts().tails[K0]?.n ?? 0
  return { learner, tables, saved, feed, feedEveryHour, counted }
}

describe('平常のゆらぎを端末で学び直す', () => {
  it('正: 揺れ検知が出ていない秒は数え、データの時刻で 1 時間たつと混ぜた表を渡して数を残す', () => {
    const h = harness()
    h.feed(0, 3_700)
    expect(h.counted()).toBeGreaterThan(3_500)
    expect(h.tables).toHaveLength(1)
    expect(h.saved).toHaveLength(1)
    // 端末で数えた秒が加わって、配る表より判定できた秒が多い
    expect(h.tables[0].tails[K0].n).toBeGreaterThan(PRIOR.tails[K0].n * 0.86)
  })

  it('対照: 揺れ検知が出ている秒とその前後 60 秒は数えない', () => {
    const quiet = harness()
    quiet.feed(0, 600)
    const busy = harness()
    // 300〜319 秒目に検知。その前後 60 秒（240〜379 秒目）が抜ける
    busy.feed(0, 600, 3, s => s >= 300 && s < 320)
    expect(quiet.counted() - busy.counted()).toBeGreaterThanOrEqual(140)
    expect(quiet.counted() - busy.counted()).toBeLessThanOrEqual(141)
  })

  it('対照: 1 時間たつまでは表を渡さない', () => {
    const h = harness()
    h.feed(0, 3_000)
    expect(h.tables).toHaveLength(0)
  })

  it('安全弁: 時間軸が変わったら遅らせていた分を捨て、変わる前の秒を変わった後の検知で消し損ねない', () => {
    const h = harness()
    h.feed(0, 50)
    h.learner.reset()
    expect(h.counted()).toBe(0)
    h.feed(10_000, 200)
    expect(h.counted()).toBeGreaterThan(0)
  })

  it('安全弁: 古い数は半減期で薄まる（1 週間ぶん数え足すと前の 1 時間は半分の重みになる）', () => {
    const h = harness({ halfLifeMs: HOUR })
    h.feed(0, 3_700)
    const first = h.counted()
    // 2 時間ぶん数え足す。最初の 1 時間ぶんは、表を作り直すたびに薄まる
    h.feed(3_700, 7_200)
    expect(h.counted()).toBeLessThan(first + 7_200 * 0.8)
  })

  it('安全弁: 端末に残した数から始められる', () => {
    const start: QuietLearnerState = { counts: { ...EMPTY_QUIET_COUNTS, tails: { [K0]: tail(50_000) }, glob: tail(50_000) }, hourSec: new Array(24).fill(0) }
    const h = harness({ initial: start })
    expect(h.counted()).toBe(50_000)
  })
})

describe('1 日のどの時間帯も数え終えるまでは、配る表のまま動かす', () => {
  it('正: 24 の時間帯すべてで下限を超えて数えたら、混ぜた表を渡す', () => {
    const h = harness({ minHourSec: 60 })
    h.feedEveryHour(0, 150)
    h.feed(86_400, 200) // 翌日の 0 時台。ここまで流すと 23 時台の分も数え終わる
    expect(h.tables.length).toBeGreaterThan(0)
    expect(last(h.tables)).not.toBe(PRIOR)
    expect(last(h.saved).hourSec.every(s => s >= 60)).toBe(true)
  })

  it('対照: 1 つの時間帯でも足りなければ、混ぜた表を渡さない（夜だけ・昼だけの学びで閾値を動かさない）', () => {
    const h = harness({ minHourSec: 60 })
    h.feedEveryHour(0, 150, 13)
    h.feed(86_400, 200)
    expect(h.tables).toHaveLength(0)
    // 数そのものは残す（次に開いたとき足りない時間帯を埋めれば効く）
    expect(h.saved.length).toBeGreaterThan(0)
    expect(last(h.saved).hourSec[13]).toBe(0)
  })

  it('安全弁: 時間帯ごとの秒も薄まり、下限を割ったら配る表へ戻す', () => {
    // 半減期 1 日。1 日で流し終えた時点では、最初の時間帯も 150 秒の半分以上残る
    const h = harness({ minHourSec: 60, halfLifeMs: 24 * HOUR })
    h.feedEveryHour(0, 150)
    h.feed(86_400, 200)
    expect(last(h.tables)).not.toBe(PRIOR)
    // 2 日あける。ほかの時間帯は 4 分の 1 以下に薄まって下限を割る
    h.feed(3 * 86_400, 3_700)
    expect(last(h.tables)).toBe(PRIOR)
  })

  it('正: 残した状態がどの時間帯も満たしていれば、始めた時点で混ぜた表を渡す（開くたびに 1 時間古い表で動かない）', () => {
    const start: QuietLearnerState = { counts: { ...EMPTY_QUIET_COUNTS, tails: { [K0]: tail(50_000) }, glob: tail(50_000) }, hourSec: new Array(24).fill(3_600) }
    const h = harness({ initial: start, minHourSec: 60 })
    expect(h.tables).toHaveLength(1)
    expect(h.tables[0]).not.toBe(PRIOR)
  })

  it('対照: 残した状態が時間帯を満たしていなければ、始めた時点では何も渡さない', () => {
    const hourSec = new Array(24).fill(3_600)
    hourSec[5] = 0
    const h = harness({ initial: { counts: EMPTY_QUIET_COUNTS, hourSec }, minHourSec: 60 })
    expect(h.tables).toHaveLength(0)
  })

  it('安全弁: 時間帯は日本時間で数える（UTC の 15 時は日本時間の 0 時台）', () => {
    const h = harness()
    h.feed(0, 3_700)
    const hs = last(h.saved).hourSec
    expect(hs[0]).toBeGreaterThan(3_000)
    expect(hs[15]).toBe(0)
  })
})

describe('端末に残した状態を読み戻す', () => {
  const good = (): QuietLearnerState => ({
    counts: { version: 1, glob: tail(10), tails: { [K0]: tail(10) }, fire: { [K0]: { sec: 3_600, hits: [1, 0, 0, 0, 0] } } },
    hourSec: new Array(24).fill(100),
  })

  it('正: 書き出した形のままなら、そのまま戻す', () => {
    const s = good()
    expect(parseQuietLearnerState(JSON.parse(JSON.stringify(s)))).toEqual(s)
  })

  it('対照: 時間帯の秒が 24 個でない・負の数・数でないものが混じれば使わない', () => {
    expect(parseQuietLearnerState({ ...good(), hourSec: new Array(23).fill(0) })).toBeNull()
    expect(parseQuietLearnerState({ ...good(), hourSec: [-1, ...new Array(23).fill(0)] })).toBeNull()
    expect(parseQuietLearnerState({ ...good(), hourSec: ['a', ...new Array(23).fill(0)] })).toBeNull()
  })

  it('安全弁: 点ごとの数の並びの長さが違う・版が違う・形が違うものは使わない', () => {
    const s = good()
    s.counts.tails[K0] = { n: 10, y: [1], y3: new Array(12).fill(0) }
    expect(parseQuietLearnerState(s)).toBeNull()
    expect(parseQuietLearnerState({ ...good(), counts: { ...good().counts, version: 2 } })).toBeNull()
    expect(parseQuietLearnerState(null)).toBeNull()
    expect(parseQuietLearnerState({ counts: good().counts })).toBeNull()
  })
})
