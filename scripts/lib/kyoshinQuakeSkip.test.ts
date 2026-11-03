import { describe, expect, it } from 'vitest'
import { QUAKE_SKIP_LEAD_SEC, QUAKE_SKIP_TAIL_SEC, QUAKE_SKIP_VS_KMPS, QuakeSkipper } from './kyoshinQuakeSkip'

// 震央の真上の点と、東へ約 90 km の点と、約 900 km 離れた点。M2.5（揺れの届く範囲 150 km）の地震
const SITES: [number, number][] = [[37, 137], [37, 138], [45, 142]]
const T = Date.UTC(2024, 7, 29, 3)
const QUAKE = { t: T, lat: 37, lng: 137, depth: 0, mag: 2.5 }
const at = (sk: QuakeSkipper, sec: number) => [...sk.maskAt(T + sec * 1000)]

describe('震源リストの地震の揺れが届く秒を、点ごとに外す', () => {
  it('正: 震央の点は発生の少し前から、離れた点は揺れが届いた後まで外す', () => {
    const sk = new QuakeSkipper(SITES, [QUAKE], 0)
    expect(at(sk, -QUAKE_SKIP_LEAD_SEC)).toEqual([1, 1, 0])
    // 約 90 km の点は 90 / 3 + 20 = 約 50 秒後まで外れ、震央の点は 20 秒で外れ終える
    expect(at(sk, QUAKE_SKIP_TAIL_SEC + 1)).toEqual([0, 1, 0])
    const farEnd = 88.8 / QUAKE_SKIP_VS_KMPS + QUAKE_SKIP_TAIL_SEC
    expect(at(sk, Math.ceil(farEnd) + 1)).toEqual([0, 0, 0])
  })

  it('対照: 揺れの届く範囲の外の点と、発生より前の秒は外さない', () => {
    const sk = new QuakeSkipper(SITES, [QUAKE], 0)
    expect(at(sk, -QUAKE_SKIP_LEAD_SEC - 1)).toEqual([0, 0, 0])
    expect(at(sk, 0)[2]).toBe(0)
  })

  it('安全弁: 区間が重なっても、後から始まって先に終わる区間の後ろの区間を見落とさない', () => {
    // 1 つ目は M5（届く範囲が広く長い）、2 つ目はその 10 秒後の M2.5
    const big = { ...QUAKE, mag: 5.5, lat: 40 }
    const sk = new QuakeSkipper(SITES, [big, { ...QUAKE, t: T + 10_000 }], 0)
    // 震央の点は 2 つ目の地震の区間（5〜30 秒）の間も、1 つ目（約 333 km 離れて 131 秒後まで）の間も外れたまま
    expect(at(sk, 60)[0]).toBe(1)
    expect(at(sk, 140)[0]).toBe(0)
  })

  it('安全弁: 発生時刻を秒フレームの時刻へ直す差を足す（控えの秒フレームは日本時間の時刻を UTC として数える）', () => {
    const jst = 9 * 3_600_000
    const sk = new QuakeSkipper(SITES, [QUAKE], jst)
    expect([...sk.maskAt(T)]).toEqual([0, 0, 0])
    expect([...sk.maskAt(T + jst)]).toEqual([1, 1, 0])
  })

  it('安全弁: 時刻か位置が数でない震源は受け付けない', () => {
    expect(() => new QuakeSkipper(SITES, [{ ...QUAKE, t: NaN }], 0)).toThrow()
    expect(() => new QuakeSkipper(SITES, [{ ...QUAKE, lat: NaN }], 0)).toThrow()
    // M・深さが分からない地震は受け付ける（届く範囲は catalogReachKm が決める）
    expect(() => new QuakeSkipper(SITES, [{ ...QUAKE, mag: NaN, depth: NaN }], 0)).not.toThrow()
  })

  it('安全弁: 時刻が巻き戻ったら止める', () => {
    const sk = new QuakeSkipper(SITES, [QUAKE], 0)
    sk.maskAt(T + 10_000)
    expect(() => sk.maskAt(T)).toThrow()
  })
})
