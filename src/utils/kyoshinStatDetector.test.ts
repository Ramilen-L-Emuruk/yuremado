import { describe, expect, it } from 'vitest'
import { createStatDetector, type DetectorReport } from './kyoshinStatDetector'
import { quietSiteKey, type QuietTables, type TailCounts } from './kyoshinQuietTables'

// 0.1 度刻みの 6×6 の観測点（近くの組）と、東へ約 115〜135 km の 3×3 の観測点（中ほどの組）。
// 近くの組には左下の隅から 6 km/s で広がる揺れを流す。中ほどの組は `midAt` 秒に一斉に上がる
const NEAR: [number, number][] = []
for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) NEAR.push([35 + a * 0.1, 137 + b * 0.1])
const MID: [number, number][] = []
for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) MID.push([35.1 + a * 0.1, 138.3 + b * 0.1])
const SITES = [...NEAR, ...MID]
const T0 = Date.UTC(2026, 0, 1)
const ONSET = 300
const LEN = 360
/** 波が中ほどの組へ届くのは揺れの始まりから約 20 秒後（6 km/s で約 115〜135 km） */
const MID_WAVE = ONSET + 22
const NEVER = Number.POSITIVE_INFINITY

function frame(s: number, midAt: number): Int8Array {
  const v = new Int8Array(SITES.length)
  for (let i = 0; i < SITES.length; i++) {
    if (i < NEAR.length) {
      const t = s - ONSET - Math.hypot(SITES[i][0] - 35, SITES[i][1] - 137) * 100 / 6
      v[i] = t < 0 ? 4 : Math.min(7, 4 + Math.floor(t))
    } else {
      v[i] = s < midAt ? 4 : Math.min(6, 4 + Math.floor(s - midAt))
    }
  }
  return v
}

const tail = (): TailCounts => {
  const y = Array.from({ length: 12 }, (_, k) => Math.round(100_000 * 0.0005 / (k + 1)))
  return { n: 100_000, y, y3: [...y] }
}
const QUIET: QuietTables = {
  version: 1, days: ['test'], glob: tail(),
  tails: Object.fromEntries(SITES.map(s => [quietSiteKey(s), tail()])),
  fire: Object.fromEntries(SITES.map(s => [quietSiteKey(s), [0.1, 0.1, 0.1, 0.1, 0.1]])),
}

function run(midAt: number): DetectorReport[][] {
  const det = createStatDetector(SITES, QUIET)
  const out: DetectorReport[][] = []
  for (let s = 0; s < LEN; s++) out.push(det.push({ ms: T0 + s * 1000, values: frame(s, midAt) }))
  return out
}
const isMid = (i: number) => i >= NEAR.length
const reportedSites = (out: DetectorReport[][]) => new Set(out.flat().flatMap(r => r.sites))
const ids = (out: DetectorReport[][]) => new Set(out.flat().map(r => r.id))
const firstConfirmed = (out: DetectorReport[][]) => out.findIndex(rs => rs.some(r => r.tier === 'confirmed'))

describe('統計の部分の顔ぶれは、波で届く点に絞る', () => {
  it('前提: 近くの揺れは確かな段まで上がり、近くの 36 点がすべて顔ぶれに入る', () => {
    const out = run(NEVER)
    expect(firstConfirmed(out)).toBeGreaterThanOrEqual(ONSET)
    expect([...reportedSites(out)].filter(i => !isMid(i))).toHaveLength(NEAR.length)
  })

  it('正: 揺れの始まりの 3 秒後に上がった中ほどの組（波がまだ届かない）は顔ぶれに入らず、別の束も立てない', () => {
    const out = run(ONSET + 3)
    expect([...reportedSites(out)].filter(isMid)).toEqual([])
    expect(ids(out).size).toBe(1)
  })

  it('対照: 波が届く頃に上がった中ほどの組は、同じ配置でも顔ぶれに入る', () => {
    const out = run(MID_WAVE)
    expect([...reportedSites(out)].filter(isMid)).toHaveLength(MID.length)
    expect(ids(out).size).toBe(1)
  })

  // 絞るのは顔ぶれだけで、強さ（S）の計算には近くで上がった点をすべて数える。だから確かな段は早まりうるが、遅れはしない
  it('安全弁: 中ほどの組を外しても、近くの揺れの確かな段は遅れず、近くの顔ぶれは中ほどの組が上がらないときと同じ', () => {
    const quietMid = run(NEVER)
    const earlyMid = run(ONSET + 3)
    expect(firstConfirmed(earlyMid)).toBeGreaterThanOrEqual(ONSET)
    expect(firstConfirmed(earlyMid)).toBeLessThanOrEqual(firstConfirmed(quietMid))
    expect([...reportedSites(earlyMid)].filter(i => !isMid(i)).sort((a, b) => a - b))
      .toEqual([...reportedSites(quietMid)].filter(i => !isMid(i)).sort((a, b) => a - b))
  })
})

// 震源（東経 137 度）側に 0.4 度おきの疎らな点を 4 つ、東へ 100 km ほど離れた所に密な 5×8 の点を置く。
// 揺れはゆっくり（3 秒に 1 段）強まるので、密な点が揃って事象が生まれた時点で、震源側の点はまだ候補に残っている。
// 種は密な点のどれかになり、震源側の点は種より先に上がっている
describe('種より先に上がった点も、顔ぶれの点から波で届けば顔ぶれに入る', () => {
  const SPARSE: [number, number][] = [0, 1, 2, 3].map(x => [35, 137 + x * 0.4])
  const DENSE: [number, number][] = []
  for (let a = 0; a < 5; a++) for (let b = 0; b < 8; b++) DENSE.push([34.9 + a * 0.05, 138.1 + b * 0.05])
  // 密な点の東端から約 100 km 東の 1 点。震源からは約 237 km で、6 km/s の波が届くのは揺れの始まりから約 40 秒後
  const FAR: [number, number] = [35.0, 139.6]
  const ALL = [...SPARSE, ...DENSE, FAR]
  const FAR_I = ALL.length - 1
  const FAR_WAVE = ONSET + 40
  const tables: QuietTables = {
    version: 1, days: ['test'], glob: tail(),
    tails: Object.fromEntries(ALL.map(s => [quietSiteKey(s), tail()])),
    fire: Object.fromEntries(ALL.map(s => [quietSiteKey(s), [0.1, 0.1, 0.1, 0.1, 0.1]])),
  }
  const slowFrame = (s: number, farAt: number, sites = ALL) => {
    const v = new Int8Array(sites.length)
    for (let i = 0; i < sites.length; i++) {
      const isFar = sites[i] === FAR
      const t = isFar ? s - farAt : s - ONSET - Math.hypot(sites[i][0] - 35, (sites[i][1] - 137) * 0.82) * 111 / 6
      v[i] = t < 0 ? 4 : Math.min(14, 4 + Math.floor(t / 3))
    }
    return v
  }
  const runSlow = (farAt: number, sites = ALL) => {
    const det = createStatDetector(sites, tables)
    const out: DetectorReport[][] = []
    for (let s = 0; s < 400; s++) out.push(det.push({ ms: T0 + s * 1000, values: slowFrame(s, farAt, sites) }))
    return out
  }

  it('正: 震源側の 4 点がすべて顔ぶれに入る（種から測ると、種から遠い震源側の点が入らない）', () => {
    const out = runSlow(NEVER)
    expect(firstConfirmed(out)).toBeGreaterThanOrEqual(ONSET)
    expect([...reportedSites(out)].filter(i => i < SPARSE.length).sort((a, b) => a - b)).toEqual([0, 1, 2, 3])
    expect(ids(out).size).toBe(1)
  })

  it('対照: 連鎖でも、どの顔ぶれの点からも波が届かない頃に上がった離れた点は入らない（波の届く頃なら入る）', () => {
    expect(reportedSites(runSlow(FAR_WAVE)).has(FAR_I)).toBe(true)
    const early = runSlow(ONSET + 17)
    expect(reportedSites(early).has(FAR_I)).toBe(false)
    expect(ids(early).size).toBe(1)
  })

  // この配置では、同じ秒を 1 回しか見ない形でも通る（候補の点を見る順で差が出る配置は作れていない）。
  // 固定しているのは「観測点の並びを変えても毎秒の顔ぶれが変わらない」ことまで
  it('安全弁: 観測点の並びを逆にしても、毎秒の顔ぶれは同じ', () => {
    const reversed = [...ALL].reverse()
    const back = (i: number) => ALL.length - 1 - i
    // 毎秒の顔ぶれで比べる（順に左右されると、同じ点が入る秒が遅れる）
    const perSecond = (out: DetectorReport[][], map: (i: number) => number) =>
      out.map(rs => [...new Set(rs.flatMap(r => r.sites).map(map))].sort((a, b) => a - b))
    expect(perSecond(runSlow(FAR_WAVE, reversed), back)).toEqual(perSecond(runSlow(FAR_WAVE), i => i))
  })
})
