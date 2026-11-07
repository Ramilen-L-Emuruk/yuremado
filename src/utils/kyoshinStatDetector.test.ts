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

/** 平常のゆらぎの表。p は 1 段上がる秒の割合（k 段は p / k） */
const tail = (p = 0.0005): TailCounts => {
  const y = Array.from({ length: 12 }, (_, k) => Math.round(100_000 * p / (k + 1)))
  return { n: 100_000, y, y3: [...y], y15: [...y] }
}
const quietTables = (p: number): QuietTables => ({
  version: 1, days: ['test'], glob: tail(p),
  tails: Object.fromEntries(SITES.map(s => [quietSiteKey(s), tail(p)])),
  fire: Object.fromEntries(SITES.map(s => [quietSiteKey(s), [0.1, 0.1, 0.1, 0.1, 0.1]])),
})
const QUIET = quietTables(0.0005)
/** 平常の上がりが QUIET の倍ある表。同じ上がりでも珍しさが下がり、点数が低く出る（下の並びの点数の幅は、下限を差し替えた写しで確かめた値。表の値や並びを変えたら測り直す。測り方は設計書§77） */
const NOISY = quietTables(0.001)

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

/** 6×6 の近くの組のうち `up` の点が ON 秒に一斉に rise 段上がる。`missing` の点は欠測（-1）、残りは値はあるが静か（段 4 のまま） */
function nearBurst(tables: QuietTables, up: number[], rise: number, missing: (i: number) => boolean, ON = 300): DetectorReport[][] {
  const det = createStatDetector(NEAR, tables)
  const out: DetectorReport[][] = []
  for (let s = 0; s < ON + 60; s++) {
    const v = new Int8Array(NEAR.length)
    for (let i = 0; i < NEAR.length; i++) v[i] = up.includes(i) ? (s >= ON ? 4 + rise : 4) : missing(i) ? -1 : 4
    out.push(det.push({ ms: T0 + s * 1000, values: v }))
  }
  return out
}

describe('値の無い点が多い中心は、早い段の下限を下げる', () => {
  // 早い段の下限が 9 なので（設計書§77）、平常の上がりが倍ある表（NOISY）で、3 点・1 段の点数が 8 以上 9 未満に入る並びを作る
  function burst(up: number[], rise: number, missing: (i: number) => boolean): DetectorReport[][] {
    return nearBurst(NOISY, up, rise, missing)
  }
  const THREE = [0, 1, 6] // 隅の点と、東・北の隣
  const mostlyMissing = (i: number) => i % 4 !== 0 // 4 点に 3 点が欠測
  const fewMissing = (i: number) => i % 3 === 2 // 3 点に 1 点が欠測

  // 値の届く点が少ないと、揺れていても点数が数え切れない（能登 2024 の 01-03 以降、2 点以上上がった有感が点数 8〜10 で止まった。設計書§65）。
  // この表と並びでは、欠測の多い中心の下限（8）が無ければ何も出ない（下の対照）
  it('正: 近くの点の多くが欠測なら、3 点が 1 段上がっただけで早い段に上がる（確かな段へは上がらない）', () => {
    const out = burst(THREE, 1, mostlyMissing)
    expect(out.flat().some(r => r.tier === 'early')).toBe(true)
    expect(firstConfirmed(out)).toBe(-1)
  })

  it('対照: 同じ 3 点の上がりでも、欠測が少なければ下限は下がらず、何も出ない', () => {
    expect(burst(THREE, 1, fewMissing).flat()).toEqual([])
  })

  // 下げた下限だけで届いた候補は、候補の点が 3 点以上要る（§57 で入れなかった 2 点の組を、欠測の多い所で入れない）。
  // QUIET の 2 点・8 段・欠測が多い並びは点数が 8 以上 9 未満で、下限 8 には届く。止めるのは 3 点の要件だけ
  it('安全弁: 近くの点の多くが欠測でも、下げた下限だけで届く 2 点の上がりは検知にしない', () => {
    expect(nearBurst(QUIET, [0, 1], 8, mostlyMissing).flat()).toEqual([])
  })
})

describe('早い段の下限は 9', () => {
  // 点数 9 以上 10 未満に留まる有感を拾う（設計書§77）。
  // QUIET の 3 点・1 段（欠測なし）は点数が 9 以上 10 未満、NOISY の同じ並びは 8 以上 9 未満。下限が 10 でも 8 でも、正か安全弁のどちらかが落ちる
  const THREE = [0, 1, 6]
  const none = () => false

  it('正: 値の届く点の中で 3 点が 1 段上がれば早い段に上がる（確かな段へは上がらない）', () => {
    const out = nearBurst(QUIET, THREE, 1, none)
    expect(out.flat().some(r => r.tier === 'early')).toBe(true)
    expect(firstConfirmed(out)).toBe(-1)
  })

  it('対照: 2 点だけが 1 段上がっても何も出ない', () => {
    expect(nearBurst(QUIET, [0, 1], 1, none).flat()).toEqual([])
  })

  it('安全弁: 平常の上がりが倍ある所では、同じ 3 点・1 段でも何も出ない（欠測の少ない中心の下限は 9 より下がっていない）', () => {
    expect(nearBurst(NOISY, THREE, 1, none).flat()).toEqual([])
  })
})

/** 揺れの並び。`at` 秒から `dur` 秒の間、`pts` の点を `rise` 段上げる（ほかの点と、その前後は段 4 のまま） */
type Burst = { at: number; pts: number[]; rise: number; dur: number }
function bursts(tables: QuietTables, list: Burst[], len: number): DetectorReport[][] {
  const det = createStatDetector(SITES, tables)
  const out: DetectorReport[][] = []
  for (let s = 0; s < len; s++) {
    const v = new Int8Array(SITES.length).fill(4)
    for (const b of list) if (s >= b.at && s < b.at + b.dur) for (const i of b.pts) v[i] = 4 + b.rise
    out.push(det.push({ ms: T0 + s * 1000, values: v }))
  }
  return out
}

describe('地震が続いている所では、珍しい点がそろった中心の早い段の下限を下げる', () => {
  // 近くの組の 36 点が一斉に 3 段上がる地震（確かな段まで上がる）。中ほどの組（約 120 km 先）の 9 点の地震も用意する
  const NEAR_QUAKE: Burst = { at: 300, pts: NEAR.map((_, i) => i), rise: 3, dur: 60 }
  const MID_QUAKE: Burst = { at: 300, pts: MID.map((_, i) => NEAR.length + i), rise: 3, dur: 60 }
  // 1 時間後に、近くの組の隅の 3 点が 1 段だけ上がる。NOISY の表では点数が 8 以上 9 未満で、下限 9 には届かない（「早い段の下限は 9」の安全弁と同じ並び）
  const SMALL_AT = 300 + 3600
  const small = (pts = [0, 1, 6]): Burst => ({ at: SMALL_AT, pts, rise: 1, dur: 60 })
  const after = (out: DetectorReport[][], s: number) => out.slice(s).flat()

  it('前提: 近くの組の地震は確かな段まで上がる', () => {
    expect(firstConfirmed(bursts(NOISY, [NEAR_QUAKE], 400))).toBeGreaterThanOrEqual(300)
  })

  it('正: 1 時間前に近くで確かな段があれば、3 点の小さな上がりが早い段に上がる（確かな段へは上がらない）', () => {
    const out = bursts(NOISY, [NEAR_QUAKE, small()], SMALL_AT + 70)
    const late = after(out, SMALL_AT)
    expect(late.some(r => r.tier === 'early')).toBe(true)
    expect(late.some(r => r.tier === 'confirmed')).toBe(false)
  })

  it('対照: 前に地震が無ければ、同じ 3 点の上がりは何も出ない', () => {
    expect(after(bursts(NOISY, [small()], SMALL_AT + 70), SMALL_AT)).toEqual([])
  })

  it('対照: 確かな段から 6 時間を過ぎていれば、下限は下がらない', () => {
    const at = 300 + 6 * 3600 + 120
    const out = bursts(NOISY, [NEAR_QUAKE, { ...small(), at }], at + 70)
    expect(after(out, at)).toEqual([])
  })

  it('安全弁: 前の地震が 50 km より遠ければ、下限は下がらない', () => {
    expect(after(bursts(NOISY, [MID_QUAKE, small()], SMALL_AT + 70), SMALL_AT)).toEqual([])
  })

  // 隅の点・東へ約 27 km・北へ約 33 km の 3 点。どの 2 点も 25 km より離れていて、いちばん狭い半径の円に 3 点がそろわない。
  // QUIET の表で 1 段だと点数は 7 以上 9 未満（3 点の条件を外した写しでは早い段に上がる。設計書§80）
  it('安全弁: 地震が続いている所でも、いちばん狭い半径の円に珍しい点が 3 点そろわなければ、下限は下がらない', () => {
    expect(after(bursts(QUIET, [NEAR_QUAKE, small([0, 3, 18])], SMALL_AT + 70), SMALL_AT)).toEqual([])
  })

  // 地震が続いている所の下限だけで作った事象へは、STALE（12 秒）を過ぎたら別の揺れを入れない。前の小さな揺れの事象が後の地震を吸い込まないように。
  // 10 秒後に近くの組の反対の隅の 4 点が上がる並びは、この決まりが無いと前の事象に入り、早い段の報告の 2 秒（EARLY_MAX）を使い切った事象なので何も出ない（設計書§80）
  it('正: 下げた下限で生まれた事象に、10 秒後の別の揺れは吸い込まれず、別の事象として早い段が出る', () => {
    const later: Burst = { at: SMALL_AT + 10, pts: [28, 29, 34, 35], rise: 2, dur: 40 }
    const out = bursts(NOISY, [NEAR_QUAKE, small(), later], SMALL_AT + 70)
    const first = new Set(out.slice(SMALL_AT, later.at).flat().map(r => r.id))
    const second = out.slice(later.at).flat().filter(r => r.sites.some(i => later.pts.includes(i)))
    expect(first.size).toBeGreaterThan(0)
    expect(second.some(r => r.tier === 'early')).toBe(true)
    expect(second.some(r => first.has(r.id))).toBe(false)
  })

  // 地震が続いている所の下限だけで届いた候補は、既にある事象へ入れない。入れると、早い段の報告を使い切った事象の支えが続き、
  // 後から近くで起きた揺れまでその事象に入って何も出ない（この並びは、決まりを外した写しで何も出なくなることを確かめた。設計書§80）
  it('正: 下げた下限で届いた候補は既にある事象を延ばさず、15 秒後の別の揺れは別の事象として早い段が出る', () => {
    const e: Burst = { at: SMALL_AT, pts: [28, 29, 34, 35], rise: 2, dur: 3 }
    const later: Burst = { at: SMALL_AT + 15, pts: [22, 23, 16, 17], rise: 2, dur: 30 }
    const out = bursts(NOISY, [NEAR_QUAKE, e, { ...small(), at: SMALL_AT + 3 }, later], SMALL_AT + 60)
    const first = new Set(out.slice(SMALL_AT, SMALL_AT + 3).flat().map(r => r.id))
    const second = out.slice(later.at).flat().filter(r => r.sites.some(i => later.pts.includes(i)))
    expect(first.size).toBeGreaterThan(0)
    expect(second.some(r => r.tier === 'early')).toBe(true)
    expect(second.some(r => first.has(r.id))).toBe(false)
  })

  // 下げた下限で生まれた事象も、確かな段へ上がった後は普通の事象として扱う。2 秒後に近くの組の地震が来て同じ事象が確かな段へ上がり、
  // 生まれてから 16 秒後に同じ点がもう一段上がっても（STALE の 12 秒を過ぎた候補）、地震の続きを別の事象へ割らない（設計書§80）
  it('安全弁: 下げた下限で生まれた事象が確かな段へ上がったら、続く揺れを別の事象へ割らない', () => {
    const quake: Burst = { ...NEAR_QUAKE, at: SMALL_AT + 2 }
    const stronger: Burst = { ...NEAR_QUAKE, at: SMALL_AT + 16, rise: 5, dur: 30 }
    const out = bursts(NOISY, [NEAR_QUAKE, small(), quake, stronger], SMALL_AT + 70)
    const conf = out.slice(SMALL_AT).flat().filter(r => r.tier === 'confirmed')
    expect(out.slice(stronger.at, stronger.at + 5).flat().some(r => r.tier === 'confirmed')).toBe(true)
    expect(new Set(out.slice(SMALL_AT).flat().map(r => r.id))).toEqual(new Set([conf[0].id]))
  })

  // 20 秒の地震は 328 秒まで報告され、消えかけの事象として 349 秒まで残る。その間の 335〜344 秒に下げた下限で届く小さな上がりがあっても、
  // 消えかけの事象を生き返らせない。生き返らせると消えかけの事象が 364 秒まで延び、355 秒の別の揺れがそれに入って何も出ない（設計書§80）
  it('正: 下げた下限で届いた候補は消えかけの事象を生き返らせず、後の別の揺れは早い段が出る', () => {
    const quake: Burst = { ...NEAR_QUAKE, dur: 20 }
    const later: Burst = { at: 355, pts: [28, 29, 34, 35], rise: 2, dur: 30 }
    const out = bursts(NOISY, [quake, { ...small(), at: 335 }, later], 400)
    const quakeIds = new Set(out.slice(300, 330).flat().map(r => r.id))
    const second = out.slice(later.at).flat().filter(r => r.sites.some(i => later.pts.includes(i)))
    expect(second.some(r => r.tier === 'early')).toBe(true)
    expect(second.some(r => quakeIds.has(r.id))).toBe(false)
  })
})
