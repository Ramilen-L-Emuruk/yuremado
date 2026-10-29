import { describe, expect, it } from 'vitest'
import {
  blendQuietTables,
  EMPTY_QUIET_COUNTS,
  FIRE_MIN_SEC,
  QuietTableBaker,
  quietSiteKey,
  validateQuietTables,
  type QuietCounts,
  type QuietTables,
} from './kyoshinQuietTables'

const SITES: [number, number][] = [[35.3, 136.8], [38.4, 140]]
const T0 = Date.UTC(2024, 7, 29)

/** 点ごとの値の並びを、1 秒ずつ流す。 */
function feedSeries(baker: QuietTableBaker, series: number[][], startMs = T0, cfg = 'c1', sites = SITES): void {
  for (let s = 0; s < series[0].length; s++) baker.feed(startMs + s * 1000, cfg, sites, series.map(v => v[s]), true)
}
const flat = (len: number, v = 3) => Array.from({ length: len }, () => v)

describe('平常のゆらぎの表を焼く数え方', () => {
  it('正: 平らな所から 2 段上がった点は、上がりの段ごとに数える', () => {
    const b = new QuietTableBaker()
    const rise = [...flat(80), 5, 5, 5, ...flat(20)]
    feedSeries(b, [rise, flat(rise.length)])
    const t = b.result(['20240829'])
    const s = t.tails[quietSiteKey(SITES[0])]
    expect(s.y[0]).toBeGreaterThan(0) // y ≥ 1
    expect(s.y[1]).toBeGreaterThan(0) // y ≥ 2
    expect(s.y[2]).toBe(0) // y ≥ 3 は無い
    expect(t.glob.y[1]).toBe(s.y[1])
  })

  it('対照: 平らなままの点は、判定できた秒だけ数えて上がりは数えない', () => {
    const b = new QuietTableBaker()
    feedSeries(b, [flat(100), flat(100)])
    const s = b.result([]).tails[quietSiteKey(SITES[1])]
    expect(s.n).toBeGreaterThan(0)
    expect(s.y.every(c => c === 0)).toBe(true)
    expect(s.y3.every(c => c === 0)).toBe(true)
  })

  it('安全弁: 欠測の秒は判定できた秒に入れない', () => {
    const b = new QuietTableBaker()
    const withGap = [...flat(50), ...flat(30, -1), ...flat(50)]
    feedSeries(b, [withGap, flat(withGap.length)])
    const t = b.result([])
    expect(t.tails[quietSiteKey(SITES[0])].n).toBeLessThan(t.tails[quietSiteKey(SITES[1])].n)
  })

  it('安全弁: 60 秒を超えて途切れたら数え直し、途切れの前の値から上がりを数えない', () => {
    const b = new QuietTableBaker()
    feedSeries(b, [flat(80, 1), flat(80, 1)])
    // 2 分空けて、高い値から始める。続けて流していれば 4 段の上がりになる形
    feedSeries(b, [flat(80, 5), flat(80, 1)], T0 + 80_000 + 120_000)
    expect(b.result([]).glob.y.every(c => c === 0)).toBe(true)
  })

  it('安全弁: 時刻が巻き戻ったら数え直し、巻き戻る前の値から上がりを数えない', () => {
    const b = new QuietTableBaker()
    feedSeries(b, [flat(80, 1), flat(80, 1)], T0 + 600_000)
    // 10 分前へ戻って、高い値から始める。続けて数えていれば 4 段の上がりになる形
    feedSeries(b, [flat(80, 5), flat(80, 1)], T0)
    expect(b.result([]).glob.y.every(c => c === 0)).toBe(true)
  })

  it('対照: 数えない秒は判定できた秒にも上がりにも足さないが、続く秒の上がりの基準には使う', () => {
    const rise = [...flat(80), 5, 5, 5, ...flat(20)]
    const all = new QuietTableBaker()
    feedSeries(all, [rise, flat(rise.length)])
    const skip = new QuietTableBaker()
    // 81〜83 秒目（上がり）だけ数えない。前後の秒は同じに数える
    for (let s = 0; s < rise.length; s++) skip.feed(T0 + s * 1000, 'c1', SITES, [rise[s], 3], s < 80 || s > 82)
    const k = quietSiteKey(SITES[0])
    expect(skip.result([]).tails[k].n).toBe(all.result([]).tails[k].n - 3)
    expect(skip.result([]).tails[k].y[1]).toBeLessThan(all.result([]).tails[k].y[1])
  })

  it('雑音の表: 4〜60 秒前の最大からの上がりを、段差ごとに 1 時間あたりの回数へ直す', () => {
    const b = new QuietTableBaker()
    // 1 時間を超えて平ら（2）で、10 分おきに 1 秒だけ 4 へ跳ねる
    const len = FIRE_MIN_SEC + 600
    const s0 = Array.from({ length: len }, (_, i) => (i % 600 === 599 ? 4 : 2))
    feedSeries(b, [s0, flat(len, 2)])
    const t = b.result([])
    const r = t.fire[quietSiteKey(SITES[0])]
    expect(r).toHaveLength(5)
    expect(r[0]).toBeCloseTo(r[1], 6) // 跳ねは 2 段なので、1 段以上と 2 段以上は同じ回数
    expect(r[1]).toBeGreaterThan(0)
    expect(r[2]).toBe(0) // 3 段以上は無い
    expect(t.fire[quietSiteKey(SITES[1])]).toEqual([0, 0, 0, 0, 0])
  })

  it('安全弁: 判定できた秒が 1 時間に満たない点は、雑音の表に載せない', () => {
    const b = new QuietTableBaker()
    feedSeries(b, [flat(FIRE_MIN_SEC - 100), flat(FIRE_MIN_SEC - 100)])
    expect(b.result([]).fire).toEqual({})
  })

  it('同じ座標に重なる観測点は、1 つのキーへ足し合わせる', () => {
    const b = new QuietTableBaker()
    const same: [number, number][] = [[35.3, 136.8], [35.3, 136.8]]
    feedSeries(b, [flat(100), flat(100)], T0, 'c1', same)
    const one = new QuietTableBaker()
    feedSeries(one, [flat(100)], T0, 'c1', [same[0]])
    expect(b.result([]).tails[quietSiteKey(same[0])].n).toBe(2 * one.result([]).tails[quietSiteKey(same[0])].n)
  })

  it('観測点の数と値の数が食い違う秒は受け付けない', () => {
    const b = new QuietTableBaker()
    expect(() => b.feed(T0, 'c1', SITES, [1], true)).toThrow()
  })
})

describe('端末で数えた分を薄めて持ち越す', () => {
  it('正: 薄めると、数えた秒も上がりの数も同じ割合で減る', () => {
    const b = new QuietTableBaker()
    feedSeries(b, [[...flat(80), 5, 5, 5, ...flat(20)], flat(103)])
    const before = b.counts()
    b.decay(0.5)
    const after = b.counts()
    const k = quietSiteKey(SITES[0])
    expect(after.tails[k].n).toBeCloseTo(before.tails[k].n / 2, 9)
    expect(after.tails[k].y[1]).toBeCloseTo(before.tails[k].y[1] / 2, 9)
    expect(after.glob.n).toBeCloseTo(before.glob.n / 2, 9)
  })

  it('対照: 書き出した数から作り直すと、同じ数を持つ', () => {
    const b = new QuietTableBaker()
    feedSeries(b, [[...flat(80), 5, 5, 5, ...flat(20)], flat(103)])
    const c = b.counts()
    expect(QuietTableBaker.fromCounts(c).counts()).toEqual(c)
  })

  it('安全弁: 書き出した数は写しで、あとから数え足しても書き出した側は動かない', () => {
    const b = new QuietTableBaker()
    feedSeries(b, [flat(100), flat(100)])
    const c = b.counts()
    const n = c.tails[quietSiteKey(SITES[0])].n
    feedSeries(b, [flat(100), flat(100)], T0 + 100_000)
    expect(c.tails[quietSiteKey(SITES[0])].n).toBe(n)
  })

  it('安全弁: 1 より大きい・0 以下の割合では薄めない', () => {
    const b = new QuietTableBaker()
    expect(() => b.decay(1.5)).toThrow()
    expect(() => b.decay(0)).toThrow()
  })
})

describe('配る表と端末で数えた分を混ぜる', () => {
  const k0 = quietSiteKey(SITES[0])
  const prior = (n: number, y2: number, fire2: number): QuietTables => ({
    version: 1, days: ['20260911'],
    glob: { n, y: [y2, y2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], y3: new Array(12).fill(0) },
    tails: { [k0]: { n, y: [y2, y2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], y3: new Array(12).fill(0) } },
    fire: { [k0]: [fire2, fire2, 0, 0, 0] },
  })
  const learned = (n: number, y2: number, fireSec: number, fireHits2: number): QuietCounts => ({
    version: 1,
    glob: { n, y: [y2, y2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], y3: new Array(12).fill(0) },
    tails: { [k0]: { n, y: [y2, y2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], y3: new Array(12).fill(0) } },
    fire: { [k0]: { sec: fireSec, hits: [fireHits2, fireHits2, 0, 0, 0] } },
  })
  const rate2 = (t: QuietTables) => t.tails[k0].y[1] / t.tails[k0].n

  it('正: 端末で数えた秒が配る表の重みより十分多ければ、端末の率に寄る', () => {
    // 配る表は 2 段以上が 1%、端末では 4%。端末の秒は配る表の重みの 99 倍
    const t = blendQuietTables(prior(100_000, 1_000, 2), learned(9_900_000, 396_000, 9_900_000, 2_750), 100_000)
    expect(rate2(t)).toBeCloseTo(0.0397, 4)
    expect(t.fire[k0][1]).toBeCloseTo((2 * 100_000 / 3600 + 2_750) / ((100_000 + 9_900_000) / 3600), 3)
  })

  it('対照: 端末でまだ 1 秒も数えていなければ、配る表の率のまま', () => {
    const t = blendQuietTables(prior(100_000, 1_000, 2), EMPTY_QUIET_COUNTS, 50_000)
    expect(rate2(t)).toBeCloseTo(0.01, 9)
    expect(t.fire[k0]).toEqual([2, 2, 0, 0, 0])
    expect(t.days).toEqual(['20260911'])
  })

  it('安全弁: 配る表の重みは決めた秒数で頭打ちにする（数日ぶん数えた表でも 1 日ぶんの重みしか持たない）', () => {
    // 配る表は 3 日ぶん（259,200 秒）で 1%。重みを 86,400 秒に抑え、端末で同じ 86,400 秒数えた 3% と混ぜる → 2%
    const t = blendQuietTables(prior(259_200, 2_592, 0), learned(86_400, 2_592, 0, 0), 86_400)
    expect(rate2(t)).toBeCloseTo(0.02, 6)
  })

  it('安全弁: 混ぜた表は配る表と同じ検分を通る', () => {
    const t = blendQuietTables(prior(100_000, 1_000, 2), learned(5_000, 100, 5_000, 1), 100_000)
    expect(() => validateQuietTables(t)).not.toThrow()
  })

  it('安全弁: 配る表に無い点は、端末で 1 時間数えるまで雑音の表に載せない', () => {
    const k1 = quietSiteKey(SITES[1])
    const l = learned(1, 0, 0, 0)
    l.fire[k1] = { sec: FIRE_MIN_SEC - 1, hits: [0, 0, 0, 0, 0] }
    expect(blendQuietTables(prior(100_000, 1_000, 2), l, 100_000).fire[k1]).toBeUndefined()
    l.fire[k1] = { sec: FIRE_MIN_SEC, hits: [0, 0, 0, 0, 0] }
    expect(blendQuietTables(prior(100_000, 1_000, 2), l, 100_000).fire[k1]).toEqual([0, 0, 0, 0, 0])
  })
})
