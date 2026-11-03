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
  return { n: 100_000, y, y3: [...y], y15: [...y] }
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

// 揺れの前の 1,800 秒ほど、検知に届かない小さな上がり（2 段・2 秒）を観測点ごとに 144 秒に 1 回ずつ入れる。
// どの点も上がる回数は同じで、違うのは「同じ秒に近くの点も上がっているか」だけ。
// 直近の裾に数えられると、その点の珍しさが割り引かれ、本番の揺れの確かな段が遅れる
describe('近くの点と揃って上がった秒は、直近の荒れとして数えない', () => {
  const PRE_FROM = 60
  const QUAKE = 1900
  const CYCLE = 144
  /** 上がりの入れ方。pair = 隣り合う 2 点（約 9 km）が同じ秒に、alone = 1 点ずつ 4 秒ずらして */
  type Pre = 'none' | 'pair' | 'alone'
  function preRise(sites: readonly (readonly [number, number])[], pre: Pre, s: number, i: number): boolean {
    if (pre === 'none' || s < PRE_FROM || s >= QUAKE - 30) return false
    const t = (s - PRE_FROM) % CYCLE
    // pair: 8 秒ごとに (2p, 2p+1) の組。alone: 4 秒ごとに 1 点
    const slot = pre === 'pair' ? Math.floor(t / 8) * 2 : Math.floor(t / 4)
    const at = pre === 'pair' ? Math.floor(t / 8) * 8 : Math.floor(t / 4) * 4
    const mine = pre === 'pair' ? (i === slot || i === slot + 1) : i === slot
    return mine && i < sites.length && t - at < 2
  }
  function quakeFrame(sites: readonly (readonly [number, number])[], pre: Pre, s: number): Int8Array {
    const v = new Int8Array(sites.length)
    for (let i = 0; i < sites.length; i++) {
      const t = s - QUAKE - Math.hypot(sites[i][0] - sites[0][0], (sites[i][1] - sites[0][1]) * 0.82) * 111 / 6
      v[i] = t >= 0 ? Math.min(7, 4 + Math.floor(t)) : preRise(sites, pre, s, i) ? 6 : 4
    }
    return v
  }
  const tablesFor = (sites: readonly (readonly [number, number])[]): QuietTables => ({
    version: 1, days: ['test'], glob: tail(),
    tails: Object.fromEntries(sites.map(s => [quietSiteKey(s), tail()])),
    fire: Object.fromEntries(sites.map(s => [quietSiteKey(s), [0.1, 0.1, 0.1, 0.1, 0.1]])),
  })
  function runPre(sites: readonly (readonly [number, number])[], pre: Pre) {
    const det = createStatDetector(sites, tablesFor(sites))
    const out: DetectorReport[][] = []
    for (let s = 0; s < QUAKE + 60; s++) out.push(det.push({ ms: T0 + s * 1000, values: quakeFrame(sites, pre, s) }))
    return out
  }
  const beforeQuake = (out: DetectorReport[][]) => out.slice(0, QUAKE).flat().length

  it('前提: 揺れの前の上がりは、どの入れ方でも検知にならない', () => {
    expect(beforeQuake(runPre(NEAR, 'pair'))).toBe(0)
    expect(beforeQuake(runPre(NEAR, 'alone'))).toBe(0)
  })

  // 東西の間隔だけを変えた 6×6（南北は 0.3 度 = 約 33 km）。揃って上がる組は東西の隣どうし
  const grid = (dLng: number) => {
    const g: [number, number][] = []
    for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) g.push([35 + a * 0.3, 137 + b * dLng])
    return g
  }
  // 割り引きは表の ONLINE_CAP 倍までなので、0.1 度おきの密な格子では 1 点ずつの荒れを割り引いても点数が余り、確かな段は遅れない。
  // 東西 0.2 度（約 18 km・25 km の内側）の格子なら、割り引きの差が確かな段の秒に出る
  const MIDDLE = grid(0.2)

  it('正: 隣り合う 2 点が揃って上がっていた後でも、確かな段は前の上がりが無いときと同じ秒に出る', () => {
    expect(firstConfirmed(runPre(MIDDLE, 'pair'))).toBe(firstConfirmed(runPre(MIDDLE, 'none')))
  })

  it('対照: 同じ回数でも 1 点ずつ上がっていた点は荒れとして割り引かれ、確かな段が遅れる', () => {
    const quiet = firstConfirmed(runPre(MIDDLE, 'none'))
    const alone = firstConfirmed(runPre(MIDDLE, 'alone'))
    expect(quiet).toBeGreaterThanOrEqual(QUAKE)
    expect(alone === -1 || alone > quiet).toBe(true)
  })

  it('正: 25 km のすぐ内側（東西 0.26 度・約 24 km）の 2 点が揃って上がっても数えない', () => {
    const inside = grid(0.26)
    expect(firstConfirmed(runPre(inside, 'pair'))).toBe(firstConfirmed(runPre(inside, 'none')))
  })

  // 東西 0.3 度（約 27 km）では、隣の点も 25 km より外にいる。揃って上がっても数え続ける
  it('安全弁: 25 km のすぐ外側（約 27 km）の 2 点が揃って上がっても、荒れとして数え、確かな段が遅れる', () => {
    const wide = grid(0.3)
    const quiet = firstConfirmed(runPre(wide, 'none'))
    const pair = firstConfirmed(runPre(wide, 'pair'))
    expect(quiet).toBeGreaterThanOrEqual(QUAKE)
    expect(pair === -1 || pair > quiet).toBe(true)
  })

  // 直近の裾で割り引くのは表の ONLINE_CAP（3）倍まで。上限が無いと、この配置で確かな段は 3 秒遅れた（設計書§55）
  it('正: 1 点ずつの荒れで割り引かれても、割り引きは上限で止まり、確かな段の遅れは 1 秒に収まる', () => {
    const quiet = firstConfirmed(runPre(MIDDLE, 'none'))
    const alone = firstConfirmed(runPre(MIDDLE, 'alone'))
    expect(alone).toBeGreaterThan(quiet)
    expect(alone - quiet).toBeLessThanOrEqual(1)
  })
})

// 3×3 の点（0.1 度おき）が、per 点ずつ gap 秒おきに d 段上がってそのまま保つ（i 番目の点は ON + floor(i / per)×gap 秒）。
// 1 点ずつ 4 秒おきなら、6 秒の窓（y）には同時に 1〜2 点しか入らず、15 秒の窓（y15）には 3〜4 点が入る
describe('15 秒の窓は、ゆっくり揃って上がる点を早い段まで上げる', () => {
  const G: [number, number][] = []
  for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) G.push([35 + a * 0.1, 137 + b * 0.1])
  const ON = 300
  const tables: QuietTables = {
    version: 1, days: ['test'], glob: tail(),
    tails: Object.fromEntries(G.map(s => [quietSiteKey(s), tail()])),
    fire: Object.fromEntries(G.map(s => [quietSiteKey(s), [0.1, 0.1, 0.1, 0.1, 0.1]])),
  }
  const staggered = (gap: number, d: number, per = 1) => {
    const det = createStatDetector(G, tables)
    const out: DetectorReport[][] = []
    for (let s = 0; s < ON + G.length * gap + 30; s++) {
      const v = new Int8Array(G.length)
      for (let i = 0; i < G.length; i++) v[i] = s < ON + Math.floor(i / per) * gap ? 4 : 4 + d
      out.push(det.push({ ms: T0 + s * 1000, values: v }))
    }
    return out
  }
  const firstEarly = (out: DetectorReport[][]) => out.findIndex(rs => rs.some(r => r.tier === 'early'))

  // 15 秒の窓が無いと、この並びは早い段にも届かなかった（6 秒の窓には 2 点しか揃わない。設計書§55）
  it('正: 4 秒ずつずらして 2 段上がる点の並びは、早い段に上がる', () => {
    expect(firstEarly(staggered(4, 2))).toBeGreaterThanOrEqual(ON)
  })

  it('対照: 6 秒ずつずらすと 15 秒の窓にも 2〜3 点しか揃わず、早い段にも上がらない', () => {
    expect(staggered(6, 2).flat()).toEqual([])
  })

  // 15 秒の窓は広い範囲の点がゆっくり揃って上がる雑音でも点数が立つので、確かな段は 6 秒・3 秒の窓に任せる。
  // 2 点ずつ 3 秒おきの並びは、15 秒の窓にも確かな段へ上げさせると 6 秒後に確かな段へ上がる（設計書§55）
  it('安全弁: 15 秒の窓の点数は確かな段の手前で止まり、2 点ずつ 3 秒おきに上がる並びも早い段どまりになる', () => {
    for (const [gap, d] of [[3, 2], [4, 3]] as const) {
      const out = staggered(gap, d, 2)
      expect(firstEarly(out)).toBeGreaterThanOrEqual(ON)
      expect(firstConfirmed(out)).toBe(-1)
    }
  })
})

describe('値の無い点は、平常の期待値に数えない', () => {
  // 6×6 の近くの組のうち、先頭の k 点が一斉に rise 段上がる。残りの点は欠測（-1）か、値はあるが静か（段 4 のまま）
  const ON = 300
  function burst(k: number, rise: number, others: 'missing' | 'quiet'): DetectorReport[][] {
    const det = createStatDetector(NEAR, QUIET)
    const out: DetectorReport[][] = []
    for (let s = 0; s < ON + 60; s++) {
      const v = new Int8Array(NEAR.length)
      for (let i = 0; i < NEAR.length; i++) v[i] = i < k ? (s >= ON ? 4 + rise : 4) : others === 'missing' ? -1 : 4
      out.push(det.push({ ms: T0 + s * 1000, values: v }))
    }
    return out
  }

  // 欠測の点は上がりようがないのに、平常なら珍しく上がる点の数の期待値へ足すと、まわりが欠けた所ほど
  // 「偶然ではない」と言うのに多くの点が要る（能登 2024 の 01-03 以降に、震央付近の点の半分ほどが欠けた中で取りこぼした。設計書§62）
  it('正: まわりの点が欠測していれば、5 点が 6 段上がっただけで確かな段に上がる', () => {
    expect(firstConfirmed(burst(5, 6, 'missing'))).toBeGreaterThanOrEqual(ON)
  })

  it('対照: 同じ 5 点の上がりでも、まわりの点が値を届けていて静かなら早い段どまり', () => {
    const out = burst(5, 6, 'quiet')
    expect(out.flat().some(r => r.tier === 'early')).toBe(true)
    expect(firstConfirmed(out)).toBe(-1)
  })

  it('安全弁: まわりの点が欠測していても、2 点だけの上がりは検知にしない', () => {
    expect(burst(2, 8, 'missing').flat()).toEqual([])
  })

  // 有効な点が少ない近傍では、数点の上がりが前より高く評価される。確かな段までは、まわりが静かなときと同じく上がらないこと
  it('安全弁: まわりの点が欠測していても、3 点だけの上がりは 8 段でも早い段どまり', () => {
    const out = burst(3, 8, 'missing')
    expect(out.flat().some(r => r.tier === 'early')).toBe(true)
    expect(firstConfirmed(out)).toBe(-1)
  })
})
