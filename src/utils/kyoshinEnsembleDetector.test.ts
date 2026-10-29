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
