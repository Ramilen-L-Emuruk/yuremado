import { describe, expect, it } from 'vitest'
import { createEnsembleDetector, type EnsembleReport } from './kyoshinEnsembleDetector'
import { quietSiteKey, type QuietTables, type TailCounts } from './kyoshinQuietTables'

// 0.1 度刻みの 6×6 の観測点。左下の隅から 6 km/s で広がる揺れを流す
const SITES: [number, number][] = []
for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) SITES.push([35 + a * 0.1, 137 + b * 0.1])
const T0 = Date.UTC(2026, 0, 1)
const ONSET = 300
const LEN = 420

/** 震度0未満の段 4 から、揺れが届いた点を 1 秒 1 段ずつ段 7（震度1.5 相当）まで上げる。表を使わない近道が効かない強さ */
function frame(s: number): Int8Array {
  const v = new Int8Array(SITES.length)
  for (let i = 0; i < SITES.length; i++) {
    const t = s - ONSET - Math.hypot(SITES[i][0] - 35, SITES[i][1] - 137) * 100 / 6
    v[i] = t < 0 ? 4 : Math.min(7, 4 + Math.floor(t))
  }
  return v
}

/** どの点も、上がりが `rate` の割合で起きる表。発火も `fire` 回/時 */
function tables(rate: number, fire: number): QuietTables {
  const tail = (): TailCounts => {
    const y = Array.from({ length: 12 }, (_, k) => Math.round(100_000 * rate / (k + 1)))
    return { n: 100_000, y, y3: [...y] }
  }
  return {
    version: 1, days: ['test'], glob: tail(),
    tails: Object.fromEntries(SITES.map(s => [quietSiteKey(s), tail()])),
    fire: Object.fromEntries(SITES.map(s => [quietSiteKey(s), [fire, fire, fire, fire, fire]])),
  }
}
const QUIET = tables(0.0005, 0.1)
const NOISY = tables(0.3, 200)

/** 揺れを流し、`swapAt` 秒の手前で表を差し替える。毎秒の出力を返す */
function run(initial: QuietTables, swapAt: number | null, next: QuietTables): EnsembleReport[][] {
  const det = createEnsembleDetector(SITES, initial)
  const out: EnsembleReport[][] = []
  for (let s = 0; s < LEN; s++) {
    if (s === swapAt) det.setTables(next)
    out.push(det.push({ ms: T0 + s * 1000, values: frame(s) }))
  }
  return out
}
const firstConfirmed = (out: EnsembleReport[][]) => out.findIndex(rs => rs.some(r => r.tier === 'confirmed'))

describe('組み合わせの検知器の表の差し替え', () => {
  it('前提: 静かな表なら揺れを確かな段まで拾い、騒がしい表なら確かな段に上がらない', () => {
    expect(firstConfirmed(run(QUIET, null, QUIET))).toBeGreaterThanOrEqual(ONSET)
    expect(firstConfirmed(run(NOISY, null, NOISY))).toBe(-1)
  })

  it('正: 揺れの前に騒がしい表へ差し替えると、確かな段に上がらない', () => {
    expect(firstConfirmed(run(QUIET, ONSET - 60, NOISY))).toBe(-1)
  })

  it('対照: 同じ表へ差し替えても、毎秒の出力は差し替えないときと変わらない（揺れの最中に差し替えても）', () => {
    expect(run(QUIET, ONSET + 10, QUIET)).toEqual(run(QUIET, null, QUIET))
    expect(run(QUIET, ONSET - 60, QUIET)).toEqual(run(QUIET, null, QUIET))
  })

  it('安全弁: 騒がしい表から静かな表へ戻すと、初めから静かな表で作ったときと同じ秒に確かな段へ上がる', () => {
    expect(firstConfirmed(run(NOISY, ONSET - 60, QUIET))).toBe(firstConfirmed(run(QUIET, null, QUIET)))
  })
})

describe('まばらな所の規則の広い窓', () => {
  // 120 km 以内に互いしかいない 2 点（44 km 離れた離島の組）
  const PAIR: [number, number][] = [[30.0, 130.0], [30.4, 130.0]]
  const ON = 300
  /** A は ON 秒から 3 秒に 1 段ずつ段 2 → 7 へゆっくり上がる（直前 10 秒の最小からは 5 段に届かない）。B は A が段 7 に着いた秒に段 2 → 6 へ跳ねる */
  const slow = (s: number) => [s < ON ? 2 : Math.min(7, 3 + Math.floor((s - ON) / 3)), s < ON + 12 ? 2 : 6]
  /** A も B も ON 秒に一度に跳ねる（A は 5 段・B は 4 段） */
  const abrupt = (s: number) => [s < ON ? 2 : 7, s < ON ? 2 : 6]
  /** 1 段以上の上がりが 1 時間に `fire1` 秒の表 */
  const pairTables = (fire1: number): QuietTables => {
    const tail = (): TailCounts => {
      const y = Array.from({ length: 12 }, (_, k) => Math.round(100_000 * 0.0005 / (k + 1)))
      return { n: 100_000, y, y3: [...y] }
    }
    return {
      version: 1, days: ['test'], glob: tail(),
      tails: Object.fromEntries(PAIR.map(s => [quietSiteKey(s), tail()])),
      fire: Object.fromEntries(PAIR.map(s => [quietSiteKey(s), [fire1, 1, 0.1, 0, 0]])),
    }
  }
  const CALM = pairTables(12) // 久米島（26.3,126.7）の 12.2 回/時に近い
  const FLICKER = pairTables(62) // 沖縄本島の南部（26.2,127.7）の 61.9 回/時に近い
  /** まばらな所の規則が確かな段にした最初の秒（無ければ -1） */
  const sparseConfirmedAt = (values: (s: number) => number[], initial: QuietTables, swap?: { at: number; to: QuietTables }) => {
    const det = createEnsembleDetector(PAIR, initial)
    for (let s = 0; s < ON + 120; s++) {
      if (swap && s === swap.at) det.setTables(swap.to)
      const rs = det.push({ ms: T0 + s * 1000, values: Int8Array.from(values(s)) })
      if (rs.some(r => r.tier === 'confirmed' && r.sources.includes('sparse'))) return s
    }
    return -1
  }

  it('正: 平常から細かくちらつかない点は、ゆっくり上がっても B が跳ねた秒に確かな段になる', () => {
    expect(sparseConfirmedAt(slow, CALM)).toBe(ON + 12)
  })

  it('対照: 細かくちらつく点では、ゆっくりした上がりを跳ねに数えない（直前 10 秒の最小だけで測る）', () => {
    expect(sparseConfirmedAt(slow, FLICKER)).toBe(-1)
  })

  it('安全弁: 細かくちらつく点でも、一度に跳ねる揺れは今までどおり確かな段になる', () => {
    expect(sparseConfirmedAt(abrupt, FLICKER)).toBe(ON)
    expect(sparseConfirmedAt(abrupt, CALM)).toBe(ON)
  })

  it('境: 1 段以上の上がりがちょうど 1 時間に 20 秒の点までは広げ、それを超える点は広げない', () => {
    expect(sparseConfirmedAt(slow, pairTables(20))).toBe(ON + 12)
    expect(sparseConfirmedAt(slow, pairTables(20.01))).toBe(-1)
  })

  it('表に無い点は広げない', () => {
    const noFire: QuietTables = { ...CALM, fire: { other: [1, 1, 0.1, 0, 0] } }
    expect(sparseConfirmedAt(slow, noFire)).toBe(-1)
  })

  it('欠測を挟むと、欠測の前の最小から跳ねを測らない（10 秒を超える欠測から高い値で戻っても、跳ねに数えない）', () => {
    // A は段 2 のまま、ON の 15 秒前から欠測して、ON に段 7 で戻る。B は ON に段 2 → 6 へ跳ねる
    const gapReturn = (s: number) => [s < ON - 15 ? 2 : s < ON ? -1 : 7, s < ON ? 2 : 6]
    expect(sparseConfirmedAt(gapReturn, CALM)).toBe(-1)
    // 欠測が無ければ同じ形は一度に跳ねる揺れで、確かな段になる（安全弁と同じ）
    expect(sparseConfirmedAt(abrupt, CALM)).toBe(ON)
  })

  it('表を差し替えると、広い窓を効かせる点も引き直す（騒がしい表で作っても、揺れの前に静かな表へ替えれば拾う）', () => {
    expect(sparseConfirmedAt(slow, FLICKER, { at: ON - 60, to: CALM })).toBe(ON + 12)
    expect(sparseConfirmedAt(slow, CALM, { at: ON - 60, to: FLICKER })).toBe(-1)
  })
})
