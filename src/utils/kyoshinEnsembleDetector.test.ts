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
    return { n: 100_000, y, y3: [...y], y15: [...y] }
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
      return { n: 100_000, y, y3: [...y], y15: [...y] }
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

describe('まばらな所の規則のゆらぎの門', () => {
  // 120 km 以内に互いしかいない 2 点（111 km 離れた組。2022-09-18 の久米島と沖縄本島南部は 100 km）
  const PAIR: [number, number][] = [[30.0, 130.0], [31.0, 130.0]]
  const ON = 2400
  const tail = (): TailCounts => {
    const y = Array.from({ length: 12 }, (_, k) => Math.round(100_000 * 0.0005 / (k + 1)))
    return { n: 100_000, y, y3: [...y], y15: [...y] }
  }
  /** 1 段以上の上がりが 1 時間に 12 秒の静かな点（久米島の 12.2 回/時に近い） */
  const BUSY: QuietTables = {
    version: 1, days: ['test'], glob: tail(),
    tails: Object.fromEntries(PAIR.map(s => [quietSiteKey(s), tail()])),
    fire: Object.fromEntries(PAIR.map(s => [quietSiteKey(s), [12, 1, 0.1, 0, 0]])),
  }
  /**
   * 後の地震: A が ON 秒に段 2 → 7 へ跳ね、B が 35 秒後に段 2 → 6 へ上がる。A の跳ねが広い窓（30 秒）から外れた後なので、
   * 同じ秒に組む経路（ゆらぎの門を掛けない）ではなく、後から組にする経路（門を掛ける）を通る。111 km なら組にできる差は 40 秒
   */
  const later = (s: number) => [s < ON ? 2 : 7, s < ON + 35 ? 2 : 6]
  /** 先の地震: 両点が `at` 秒から 1 秒 1 段ずつ段 7 へ上がり、60 秒続いてから段 2 へ戻る */
  const shake = (s: number, at: number) => (s < at || s >= at + 65 ? 2 : Math.min(7, 2 + (s - at)))
  /** A だけが `ats` の各秒に 1 秒だけ段 2 → 6 へ跳ねて戻る（ゆらぎ） */
  const spikes = (s: number, ats: number[]) => (ats.includes(s) ? 6 : 2)
  /** まばらな所の規則が `from` 秒以降で確かな段にした最初の秒（無ければ -1） */
  const sparseConfirmedFrom = (values: (s: number) => number[], from: number) => {
    const det = createEnsembleDetector(PAIR, BUSY)
    for (let s = 0; s < ON + 120; s++) {
      const rs = det.push({ ms: T0 + s * 1000, values: Int8Array.from(values(s)) })
      if (s >= from && rs.some(r => r.tier === 'confirmed' && r.sources.includes('sparse'))) return s
    }
    return -1
  }
  const RECENT = [ON - 900, ON - 800, ON - 700, ON - 600]

  it('前提: 何も無ければ、後の地震は B が上がった秒に確かな段になる', () => {
    expect(sparseConfirmedFrom(later, ON - 5)).toBe(ON + 35)
  })

  it('正: 10 分前に揺れが続いた地震があっても、その揺れはゆらぎに数えず、後の地震を拾う', () => {
    const v = (s: number) => (s < ON ? [shake(s, ON - 600), shake(s, ON - 600)] : later(s))
    expect(sparseConfirmedFrom(v, ON - 5)).toBe(ON + 35)
  })

  it('対照: 直前 30 分に A がすぐ戻る跳ねを 4 回していたら、ゆらぎの多い点として後の地震を拾わない', () => {
    const v = (s: number) => (s < ON ? [spikes(s, RECENT), 2] : later(s))
    expect(sparseConfirmedFrom(v, ON - 5)).toBe(-1)
  })

  it('安全弁: すぐ戻る跳ねでも 30 分より前のものは数えない（間に上がりが無くても）', () => {
    const OLD = RECENT.map(t => t - 1300)
    const v = (s: number) => (s < ON ? [spikes(s, OLD), 2] : later(s))
    expect(sparseConfirmedFrom(v, ON - 5)).toBe(ON + 35)
  })

  /** A だけが ON の 10 分前から `sec` 秒のあいだ段 2 → 6 へ上がり、一度に段 2 へ戻る */
  const block = (sec: number) => (s: number) => (s < ON ? [s >= ON - 600 && s < ON - 600 + sec ? 6 : 2, 2] : later(s))

  it('境: 5 秒で戻った上がりは 5 秒ぶん数え（3 を超えて拾わない）、6 秒続いた上がりは数えない', () => {
    expect(sparseConfirmedFrom(block(5), ON - 5)).toBe(-1)
    expect(sparseConfirmedFrom(block(6), ON - 5)).toBe(ON + 35)
  })

  it('正: 11 秒続いてから一度に戻った上がりも、後半を新しい上がりとして数えない（居座りの間は待ち始めない）', () => {
    expect(sparseConfirmedFrom(block(11), ON - 5)).toBe(ON + 35)
  })

  /**
   * A が `from` 秒に段 2 → 6 へ上がったまま戻らず、ON の 150〜120 秒前に段 6 → 10 へ 1 秒だけ跳ねて戻るのを 4 回出し、
   * ON に段 11 へ跳ねる。B は ON の 35 秒後に段 2 → 6 へ上がる
   */
  const stuck = (from: number) => (s: number) => {
    const spike = [ON - 150, ON - 140, ON - 130, ON - 120].includes(s)
    const a = s < from ? 2 : s >= ON ? 11 : spike ? 10 : 6
    return [a, s < ON + 35 ? 2 : 6]
  }

  it('居座りの抜け: 元の値へ戻らないまま 30 分たつと、その後のすぐ戻る跳ねを数える', () => {
    expect(sparseConfirmedFrom(stuck(ON - 2000), ON - 5)).toBe(-1)
  })

  it('居座りの抜け（対照）: 30 分たつ前の居座りの間は、すぐ戻る跳ねも数えない', () => {
    expect(sparseConfirmedFrom(stuck(ON - 1000), ON - 5)).toBe(ON + 35)
  })
})

describe('まばらな所の規則の、近くの点だけが少ない点', () => {
  // B（組の相手）と A（跳ねる点）は 22 km。120 km 以内には 70〜100 km 離れた 8 点もいて、今の規則（120 km 以内が 6 点以下）には入らない。
  // A から 40 km 以内には B しかいない（伊豆諸島の新島・三宅島の並び）
  const B: [number, number] = [34.6, 139.3]
  const A: [number, number] = [34.4, 139.3]
  const FAR: [number, number][] = [
    [35.1, 139.3], [35.2, 139.3], [33.7, 139.3], [33.6, 139.3],
    [34.4, 140.1], [34.4, 140.2], [34.4, 138.5], [34.4, 138.4],
  ]
  const ON = 2400
  const tablesFor = (sites: [number, number][]): QuietTables => {
    const tail = (): TailCounts => {
      const y = Array.from({ length: 12 }, (_, k) => Math.round(100_000 * 0.0005 / (k + 1)))
      return { n: 100_000, y, y3: [...y], y15: [...y] }
    }
    return {
      version: 1, days: ['test'], glob: tail(),
      tails: Object.fromEntries(sites.map(s => [quietSiteKey(s), tail()])),
      fire: Object.fromEntries(sites.map(s => [quietSiteKey(s), [30, 1, 0.1, 0, 0]])),
    }
  }
  /** `sites` の先頭 2 点を B・A として `values(s)` の段で流し、まばらな所の規則が出した段の秒を返す */
  const sparseAt = (sites: [number, number][], values: (s: number) => [number, number]) => {
    const det = createEnsembleDetector(sites, tablesFor(sites))
    let early = -1, confirmed = -1
    for (let s = 0; s < ON + 60; s++) {
      const [b, a] = values(s)
      const v = Int8Array.from(sites.map((_, i) => (i === 0 ? b : i === 1 ? a : 2)))
      const rs = det.push({ ms: T0 + s * 1000, values: v }).filter(r => r.sources.includes('sparse'))
      if (early < 0 && rs.some(r => r.tier === 'early')) early = s
      if (confirmed < 0 && rs.some(r => r.tier === 'confirmed')) confirmed = s
    }
    return { early, confirmed }
  }
  const SITES_NEAR: [number, number][] = [B, A, ...FAR]
  /** A が ON 秒に段 2 → 7、B が同じ秒に段 2 → `bTo` */
  const shake = (bTo: number) => (s: number): [number, number] => (s < ON ? [2, 2] : [bTo, 7])

  it('正: 40 km 以内の隣が 4 段以上上がれば、跳ねた秒に確かな段になる', () => {
    expect(sparseAt(SITES_NEAR, shake(6)).confirmed).toBe(ON)
  })

  it('対照: 隣の上がりが 3 段なら組にしない（今の規則の点なら 3 段で組にする）', () => {
    expect(sparseAt(SITES_NEAR, shake(5)).confirmed).toBe(-1)
  })

  it('対照: 隣が上がらなければ、6 段以上の 1 点の跳ねでも早い段を出さない（早い段の経路は使わない）', () => {
    const solo = (s: number): [number, number] => (s < ON ? [2, 2] : [2, 9])
    expect(sparseAt(SITES_NEAR, solo)).toEqual({ early: -1, confirmed: -1 })
  })

  it('対照: 直前 30 分に A がすぐ戻る跳ねを 4 回していたら、ゆらぎの多い点として組にしない', () => {
    const spikes = [ON - 900, ON - 800, ON - 700, ON - 600]
    const v = (s: number): [number, number] => (s < ON ? [2, spikes.includes(s) ? 6 : 2] : [6, 7])
    expect(sparseAt(SITES_NEAR, v).confirmed).toBe(-1)
  })

  it('正: 隣が観測点の並びで後ろにいても、同じ秒に上がれば跳ねた秒に確かな段になる', () => {
    const swapped: [number, number][] = [A, B, ...FAR]
    expect(sparseAt(swapped, (s) => { const [b, a] = shake(6)(s); return [a, b] }).confirmed).toBe(ON)
  })

  it('対照: 隣が直前 30 分にすぐ戻る跳ねを 4 回していたら、ゆらぎの多い隣として組にしない', () => {
    const spikes = [ON - 900, ON - 800, ON - 700, ON - 600]
    const v = (s: number): [number, number] => (s < ON ? [spikes.includes(s) ? 6 : 2, 2] : [6, 7])
    expect(sparseAt(SITES_NEAR, v).confirmed).toBe(-1)
  })

  it('対照: 4 段の跳ねは隣が上がっても早い段を出さない（早い段だけの経路は使わない）', () => {
    const four = (s: number): [number, number] => (s < ON ? [2, 2] : [6, 6])
    expect(sparseAt(SITES_NEAR, four)).toEqual({ early: -1, confirmed: -1 })
  })

  it('安全弁: 40 km 以内に 3 点いる点は対象にしない（同じ揺れでも確かな段にしない）', () => {
    const crowded: [number, number][] = [B, A, [34.25, 139.3], [34.4, 139.5], ...FAR]
    expect(sparseAt(crowded, shake(6)).confirmed).toBe(-1)
  })
})
