import { describe, it, expect } from 'vitest'
import { haversineKm } from '../../src/utils/geo'
import { catalogReachKm, catalogWindowMs, chanceOfMatch, matchCatalog, watchedQuakes, type CatalogQuake } from './kyoshinCatalogMatch'

const T0 = Date.UTC(2026, 9, 20, 3, 0, 0)
const POS: [number, number] = [36, 140]
/** 緯度 1 度 ≒ 111 km */
const north = (km: number): [number, number] => [36 + km / 111.2, 140]
/** 深さ 0 の地震（深さを見ないテストでは、震央と震源の距離を同じにしておく） */
const quake = (t: number, at: [number, number], mag: number, depth = 0): CatalogQuake => ({ t, lat: at[0], lng: at[1], depth, mag })

describe('matchCatalog', () => {
  it('見え始めの 120 秒前〜10 秒後に起き、距離が M の範囲内の地震に当てはまる', () => {
    const q = quake(T0 - 60_000, north(50), 2.0)
    expect(matchCatalog(T0, POS, [q])?.quake).toBe(q)
  })

  it('近い地震は、見え始めの 120 秒前〜10 秒後に起きたものだけ（端ちょうどは含む）', () => {
    const before = quake(T0 - 121_000, north(10), 2.0)
    const after = quake(T0 + 11_000, north(10), 2.0)
    expect(matchCatalog(T0, POS, [before, after])).toBeNull()
    const edge = quake(T0 - 120_000, north(10), 2.0)
    expect(matchCatalog(T0, POS, [edge])?.quake).toBe(edge)
  })

  it('160 km までの窓は発生の 10 秒前〜120 秒後のまま', () => {
    expect(catalogWindowMs(0)).toEqual([-10_000, 120_000])
    expect(catalogWindowMs(160)).toEqual([-10_000, 120_000])
  })

  it('遠い大きな地震は、揺れが届く頃（P 波の到達の少し手前〜S 波の到達の 60 秒後）に見え始めた検知に当てはまる', () => {
    // 1,200 km 先の M7: 窓は P 波 150 秒 − 20 秒 − 10 秒 = 120 秒後〜S 波 400 秒 + 60 秒 = 460 秒後
    const [lo, hi] = catalogWindowMs(1200)
    expect(lo).toBe(120_000)
    expect(hi).toBe(460_000)
    const far = quake(T0, north(1200), 7.3)
    expect(matchCatalog(T0 + 190_000, POS, [far])?.quake).toBe(far)
    // P 波より明らかに早い検知・S 波の後を大きく過ぎた検知は、その地震のものではない
    expect(matchCatalog(T0 + 60_000, POS, [far])).toBeNull()
    expect(matchCatalog(T0 + 500_000, POS, [far])).toBeNull()
  })

  it('M6 以上は 3,000 km、M5 台は 1,000 km まで', () => {
    expect(catalogReachKm(7.3, 10)).toBe(3000)
    expect(catalogReachKm(5.9, 10)).toBe(1000)
    expect(matchCatalog(T0 + 400_000, POS, [quake(T0, north(1100), 5.9)])).toBeNull()
  })

  it('M が決まっていない地震は M3 未満と同じく 150 km まで', () => {
    expect(catalogReachKm(NaN, 10)).toBe(150)
    expect(matchCatalog(T0, POS, [quake(T0, north(140), NaN)])).not.toBeNull()
    expect(matchCatalog(T0, POS, [quake(T0, north(160), NaN)])).toBeNull()
  })

  it('深さ 100 km 以上は規模によらず 800 km まで、揺れの届く時刻は震源までの距離で測る（異常震域）', () => {
    expect(catalogReachKm(3.6, 363)).toBe(800)
    expect(catalogReachKm(3.6, 99)).toBe(200)
    expect(catalogReachKm(6.5, 400)).toBe(3000)
    // M が決まっていない・M3 未満の深い地震は広げない（規模の分からない地震で遠くの揺れを説明しない）
    expect(catalogReachKm(NaN, 141)).toBe(150)
    expect(catalogReachKm(2.9, 300)).toBe(150)
    expect(matchCatalog(T0 + 71_000, POS, [quake(T0, north(433), NaN, 363)])).toBeNull()
    // 三重県沖の深さ 363 km の M3.6 → 433 km 離れた茨城で 71 秒後に見え始めた束（2021-01-08 の実例の形）
    const deep = quake(T0, north(433), 3.6, 363)
    expect(matchCatalog(T0 + 71_000, POS, [deep])?.quake).toBe(deep)
    // 同じ位置・同じ時刻でも、浅い M3.6 なら 200 km を超えるので当てはまらない
    expect(matchCatalog(T0 + 71_000, POS, [quake(T0, north(433), 3.6, 10)])).toBeNull()
  })

  it('当てはまる地震が複数あれば、いちばん近いものを返す', () => {
    const far = quake(T0, north(80), 2.0)
    const near = quake(T0 - 5000, north(20), 2.0)
    expect(matchCatalog(T0, POS, [far, near])?.quake).toBe(near)
  })
})

describe('matchCatalog の窓の端', () => {
  // 震央の真北へ km 離した地震に対し、見え始めが窓の終わりちょうど／1 ms 後で当たるかを見る（早い打ち切りで狭く切らないこと）
  const hiOf = (km: number, depth: number) => catalogWindowMs(Math.hypot(km, depth))[1]
  const at = (km: number) => north(km)
  it('近い地震（50 km・浅い・M2）: 窓の終わりちょうどは当たり、1 ms 後は当たらない', () => {
    const q = quake(T0, at(50), 2.0)
    const hi = hiOf(haversineKm(POS[0], POS[1], q.lat, q.lng), 0)
    expect(matchCatalog(T0 + hi, POS, [q])?.quake).toBe(q)
    expect(matchCatalog(T0 + hi + 1, POS, [q])).toBeNull()
  })

  it('遠い大地震（2,500 km・M7）: 窓の終わりちょうどは当たり、1 ms 後は当たらない', () => {
    const q = quake(T0, at(2500), 7.0)
    const hi = hiOf(haversineKm(POS[0], POS[1], q.lat, q.lng), 0)
    expect(matchCatalog(T0 + hi, POS, [q])?.quake).toBe(q)
    expect(matchCatalog(T0 + hi + 1, POS, [q])).toBeNull()
  })

  it('深い地震（700 km・深さ 400 km・M3.6）: 震源までの距離で測った窓の終わりちょうどは当たり、1 ms 後は当たらない', () => {
    const q = quake(T0, at(700), 3.6, 400)
    const hi = hiOf(haversineKm(POS[0], POS[1], q.lat, q.lng), 400)
    expect(matchCatalog(T0 + hi, POS, [q])?.quake).toBe(q)
    expect(matchCatalog(T0 + hi + 1, POS, [q])).toBeNull()
  })

  it('深い地震の窓の始まり: 始まりちょうどは当たり、1 ms 前は当たらない', () => {
    const q = quake(T0, at(700), 3.6, 400)
    const lo = catalogWindowMs(Math.hypot(haversineKm(POS[0], POS[1], q.lat, q.lng), 400))[0]
    expect(matchCatalog(T0 + lo, POS, [q])?.quake).toBe(q)
    expect(matchCatalog(T0 + lo - 1, POS, [q])).toBeNull()
  })
})

describe('chanceOfMatch', () => {
  it('範囲内の地震 1 つで、当てはまる秒は 10 秒前〜120 秒後の 131 秒', () => {
    const q = quake(T0 + 3_600_000, north(10), 2.0)
    expect(chanceOfMatch(POS, [q], T0, 86_400)).toBeCloseTo(131 / 86_400, 10)
  })

  it('範囲の外の地震は数えない', () => {
    expect(chanceOfMatch(POS, [quake(T0 + 3_600_000, north(200), 2.0)], T0, 86_400)).toBe(0)
  })

  it('遠い地震は、揺れが届く頃の窓の秒だけ数える', () => {
    // 1,200 km ほど先の M7: 揺れが届く頃の窓（およそ 120 秒後〜460 秒後）の秒数だけ
    const q = quake(T0 + 3_600_000, north(1200), 7.3)
    const [lo, hi] = catalogWindowMs(haversineKm(POS[0], POS[1], q.lat, q.lng))
    const secs = Math.floor((3_600_000 + hi) / 1000) - Math.ceil((3_600_000 + lo) / 1000) + 1
    expect(secs).toBeGreaterThan(330)
    expect(chanceOfMatch(POS, [q], T0, 86_400)).toBeCloseTo(secs / 86_400, 10)
  })

  it('重なった地震の秒は 2 度数えず、日の外へはみ出した分も数えない', () => {
    const a = quake(T0 + 3_600_000, north(10), 2.0)
    const b = quake(T0 + 3_600_000 + 30_000, north(10), 2.0)
    expect(chanceOfMatch(POS, [a, b], T0, 86_400)).toBeCloseTo(161 / 86_400, 10)
    // 日の頭の直前に起きた地震は、日の内に入った分（0〜60 秒）だけ
    const early = quake(T0 - 60_000, north(10), 2.0)
    expect(chanceOfMatch(POS, [early], T0, 86_400)).toBeCloseTo(61 / 86_400, 10)
  })
})

describe('chanceOfMatch の見ていた秒', () => {
  it('見ていない秒は分母にも分子にも入れない', () => {
    const q = quake(T0 + 3_600_000, north(10), 2.0)
    const watched = new Uint8Array(86_400)
    // 当たる 131 秒（3590〜3720 秒）を含む 3000〜3999 秒だけ見ていた
    watched.fill(1, 3000, 4000)
    expect(chanceOfMatch(POS, [q], T0, 86_400, watched)).toBeCloseTo(131 / 1000, 10)
  })

  it('見ていた秒が 1 つも無ければ 0', () => {
    expect(chanceOfMatch(POS, [quake(T0, north(10), 2.0)], T0, 86_400, new Uint8Array(86_400))).toBe(0)
  })

  it('見ていた秒を全部 1 にすると、渡さないときと同じ', () => {
    const q = quake(T0 + 3_600_000, north(10), 2.0)
    expect(chanceOfMatch(POS, [q], T0, 86_400, new Uint8Array(86_400).fill(1))).toBeCloseTo(chanceOfMatch(POS, [q], T0, 86_400), 12)
  })
})

describe('watchedQuakes', () => {
  const watched = new Uint8Array(3_600)
  watched.fill(1, 600, 3_000)

  it('見ていた間に起き、その後 120 秒も見続けていた地震だけを残す', () => {
    const inside = quake(T0 + 1_000_000, POS, 3.5)
    expect(watchedQuakes([inside], T0, watched)).toEqual([inside])
  })

  it('助走の間・見ていない時間・期間の外に起きた地震は外す', () => {
    const warmup = quake(T0 + 300_000, POS, 3.5)
    const before = quake(T0 - 1000, POS, 3.5)
    const after = quake(T0 + 3_100_000, POS, 3.5)
    expect(watchedQuakes([warmup, before, after], T0, watched)).toEqual([])
  })

  it('起きた後 120 秒のうちに見なくなった地震は外す（境目ちょうどまで見ていれば残す）', () => {
    const late = quake(T0 + (3_000 - 100) * 1000, POS, 3.5)
    expect(watchedQuakes([late], T0, watched)).toEqual([])
    const edge = quake(T0 + (3_000 - 121) * 1000, POS, 3.5)
    expect(watchedQuakes([edge], T0, watched)).toEqual([edge])
  })
})
