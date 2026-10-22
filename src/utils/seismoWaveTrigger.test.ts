// 自作地震計の波形グラフを自動で出す条件の回帰テスト。
//
// 固定するのは 3 経路の or と、そのそれぞれの境界。**とくに「静穏時に出っぱなしに
// ならない」ことを対照として置く** —— 自作地震計は平常時も毎秒 1 件の震度を出し、
// その値は負にもなる（実機で `-0.04`）。震度0 の帯を通してしまうと絵が消えなくなる。

import { describe, it, expect } from 'vitest'
import { EEW_REACH_FLOOR_WITHOUT_USUAL, SEISMO_WAVE_USUAL_MARGIN, seismoWaveTriggered, type SeismoIntensityLike } from './seismoWaveTrigger'
import { NO_SCOPE, type NearbyScope } from './actionChecklistTrigger'
import type { EEWAlert } from '../types/earthquake'
import type { DetectedPoint } from './kyoshinDetectionView'

function scope(partial: Partial<NearbyScope>): NearbyScope {
  const merged = { ...NO_SCOPE, ...partial }
  return {
    ...merged,
    knownStationNames: partial.knownStationNames ?? merged.stationNames,
    knownRegionNames: partial.knownRegionNames ?? merged.regionNames,
  }
}

/** 位置の判らない震源（`-200` は位置不明のセンチネル）。予測できないので区域の判定へ戻る。 */
const UNKNOWN_HYPOCENTER = { name: '', latitude: -200, longitude: -200, depth: -1, magnitude: -1 }

function eew(areas: EEWAlert['areas'], cancelled = false): EEWAlert {
  return { id: 'e1', cancelled, areas, earthquake: { hypocenter: UNKNOWN_HYPOCENTER } } as unknown as EEWAlert
}

/** 震源の判った EEW。区域は持たない（予測震度の下限が震度 3 以下の報の形）。 */
function eewAt(lat: number, lon: number, depth: number, magnitude: number, condition = ''): EEWAlert {
  return {
    id: 'e1',
    cancelled: false,
    areas: [],
    forecastMaxScale: 20,
    earthquake: { condition, hypocenter: { name: '', latitude: lat, longitude: lon, depth, magnitude } },
  } as unknown as EEWAlert
}

/** 座標を持つ自作地震計の観測点（座標は架空の丸めた値）。静かなとき（震度は普段どおり）。 */
function stationAt(lat: number, lon: number, usualMeasured: number | null = -1.3): SeismoIntensityLike {
  return { stationId: 's1', lat, lon, intensity: usualMeasured, usualMeasured }
}

/** Yahoo のインデックス → 震度: value = -3.0 + index * 0.5。index 8 で 1.0（震度1）。 */
function pt(key: string, index: number): DetectedPoint {
  return { key, lat: 35, lng: 139, index }
}

const HOME_KEY = '35.700,139.700'
const FAR_KEY = '34.700,135.500'

/** 何も起きていない状態。各テストはここから 1 つだけ動かす。 */
const QUIET = {
  scope: NO_SCOPE,
  eews: [] as readonly EEWAlert[],
  detectedPoints: [] as readonly DetectedPoint[],
  stations: [] as readonly SeismoIntensityLike[],
}

describe('seismoWaveTriggered', () => {
  it('何も起きていなければ出さない', () => {
    expect(seismoWaveTriggered(QUIET)).toBe(false)
  })

  describe('自作地震計自身の震度（普段が読めないとき）', () => {
    it('震度1 以上なら出す', () => {
      expect(seismoWaveTriggered({ ...QUIET, stations: [{ stationId: 's1', lat: null, lon: null, intensity: 0.5, usualMeasured: null }] })).toBe(true)
      expect(seismoWaveTriggered({ ...QUIET, stations: [{ stationId: 's1', lat: null, lon: null, intensity: 4.2, usualMeasured: null }] })).toBe(true)
    })

    // 対照: 震度0 の帯（計測震度 0.5 未満）は平常時そのもの。ここを通すと絵が消えなくなる。
    it('震度0 では出さない', () => {
      expect(seismoWaveTriggered({ ...QUIET, stations: [{ stationId: 's1', lat: null, lon: null, intensity: 0.49, usualMeasured: null }] })).toBe(false)
      expect(seismoWaveTriggered({ ...QUIET, stations: [{ stationId: 's1', lat: null, lon: null, intensity: 0, usualMeasured: null }] })).toBe(false)
    })

    // 静穏時の実機はここにいる（計測震度は 2*log10(a) + 0.94 なので a < 0.34 gal で負）。
    it('負の計測震度でも出さない', () => {
      expect(seismoWaveTriggered({ ...QUIET, stations: [{ stationId: 's1', lat: null, lon: null, intensity: -0.04, usualMeasured: null }] })).toBe(false)
    })

    it('震度を出せていない観測点は数えない', () => {
      expect(seismoWaveTriggered({ ...QUIET, stations: [{ stationId: 's1', lat: null, lon: null, intensity: null, usualMeasured: null }] })).toBe(false)
    })

    it('複数の観測点のうち 1 つでも揺れていれば出す', () => {
      expect(
        seismoWaveTriggered({ ...QUIET, stations: [{ stationId: 's1', lat: null, lon: null, intensity: -0.1, usualMeasured: null }, { stationId: 's1', lat: null, lon: null, intensity: 1.2, usualMeasured: null }] }),
      ).toBe(true)
    })
  })

  // 2026-10-15 ユーザー承認の「普段 + 0.5」。値は観測点 1 の実測（普段はおよそ −1.3）。
  describe('自作地震計自身の震度（普段が読めるとき）', () => {
    const at = (intensity: number, usualMeasured = -1.3) => ({ ...QUIET, stations: [{ stationId: 's1', lat: null, lon: null, intensity, usualMeasured }] })

    // 正: 震度1 に届かなくても、普段よりはっきり上がれば出す（実測で拾えた M3.6 は普段 +0.66）。
    it('普段より余裕を超えて上がれば、震度1 に届かなくても出す', () => {
      expect(seismoWaveTriggered(at(-1.3 + 0.66))).toBe(true)
    })

    // 対照: 境目ちょうどは出さない（「超えたら」）。普段の揺れの範囲では出さない。
    it('普段 + 余裕ちょうどまでは出さない', () => {
      expect(seismoWaveTriggered(at(-1.3 + SEISMO_WAVE_USUAL_MARGIN))).toBe(false)
      expect(seismoWaveTriggered(at(-1.2))).toBe(false)
    })

    // 対照: 普段が高い（騒がしい）観測点では、震度1 でも普段の範囲なら出さない。
    it('普段が高ければ、震度1 でも余裕を超えなければ出さない', () => {
      expect(seismoWaveTriggered(at(0.6, 0.3))).toBe(false)
      expect(seismoWaveTriggered(at(0.9, 0.3))).toBe(true)
    })

    // 正: 普段が高い間（置き場所での作業・余震）でも、震度3 以上は必ず出す（2026-10-15 ユーザー承認）。
    it('普段が高くても、震度3 以上なら出す', () => {
      expect(seismoWaveTriggered(at(2.5, 5.5))).toBe(true)
    })

    // 対照: 震度3 に届かなければ、普段が高い間は出さない（普段 + 余裕の線に従う）。
    it('普段が高ければ、震度2 では出さない', () => {
      expect(seismoWaveTriggered(at(2.4, 5.5))).toBe(false)
    })

    // 安全弁: 普段が読めない観測点は震度1 の線へ戻る（何も出さない形にしない）。
    it('普段が読めない観測点は震度1 で見る', () => {
      expect(seismoWaveTriggered({ ...QUIET, stations: [{ stationId: 's1', lat: null, lon: null, intensity: -0.5, usualMeasured: null }] })).toBe(false)
      expect(seismoWaveTriggered({ ...QUIET, stations: [{ stationId: 's1', lat: null, lon: null, intensity: 0.5, usualMeasured: null }] })).toBe(true)
    })

    // 安全弁: 普段の値が壊れていても、震度1 の線へ戻る（NaN との比較は常に偽で、黙って出なくなる）。
    it('普段の値が数でなければ震度1 で見る', () => {
      expect(seismoWaveTriggered(at(0.5, Number.NaN))).toBe(true)
    })

    it('震度を出せていない観測点は数えない', () => {
      expect(seismoWaveTriggered({ ...QUIET, stations: [{ stationId: 's1', lat: null, lon: null, intensity: null, usualMeasured: -1.3 }] })).toBe(false)
    })
  })

  describe('EEW の有感範囲', () => {
    const NEAR = scope({ regionNames: new Set(['東京都23区']) })
    const areas = (name: string, s: number) =>
      [{ pref: '東京都', name, scaleFrom: s, scaleTo: s }] as EEWAlert['areas']

    it('自宅の区域が震度1 以上なら出す', () => {
      expect(seismoWaveTriggered({ ...QUIET, scope: NEAR, eews: [eew(areas('東京都23区', 10))] })).toBe(true)
    })

    // 対照: 区域はあるが自宅が対象外。遠方の地震でいちいち出さない。
    it('自宅の区域が対象外なら出さない', () => {
      expect(seismoWaveTriggered({ ...QUIET, scope: NEAR, eews: [eew(areas('静岡県中部', 60))] })).toBe(false)
    })

    // 安全弁: 取り消された報で出さない（行動チェックリストと同じ扱い）。
    it('取り消された報では出さない', () => {
      expect(
        seismoWaveTriggered({ ...QUIET, scope: NEAR, eews: [eew(areas('東京都23区', 60), true)] }),
      ).toBe(false)
    })

    // 地震計の場所での予測計測震度で決める（2026-10-22 ユーザー承認「カードと同じ予測震度」）。
    // 以前は区域の突き合わせで、区域を持たない小さい報は電文全体の最大で判定され、遠くの地震でも出ていた。
    describe('予測計測震度で決める', () => {
      const ST = stationAt(35.0, 135.0)

      // 正: 近くの中くらいの地震。区域を持たなくても、地震計まで届くと見込めれば出す。
      it('区域を持たない報でも、地震計まで届くと見込めれば出す', () => {
        expect(seismoWaveTriggered({ ...QUIET, scope: NEAR, stations: [ST], eews: [eewAt(35.1, 135.1, 10, 4.5)] })).toBe(true)
      })

      // 対照: 遠くの小さい地震（報告された症状）。区域を持たず電文全体では震度1 以上でも出さない。
      it('遠くの小さい地震では、電文全体の予想が震度1 以上でも出さない', () => {
        expect(seismoWaveTriggered({ ...QUIET, scope: NEAR, stations: [ST], eews: [eewAt(42.0, 143.0, 50, 4.0)] })).toBe(false)
      })

      // 対照: 区域に自宅の区域があっても、予測で届かないなら区域では出さない（物差しは予測の 1 本）。
      it('予測できるときは区域の突き合わせを使わない', () => {
        const far = { ...eewAt(42.0, 143.0, 50, 4.0), areas: areas('東京都23区', 10) } as EEWAlert
        expect(seismoWaveTriggered({ ...QUIET, scope: NEAR, stations: [ST], eews: [far] })).toBe(false)
      })

      // 安全弁: 仮の震源（M・深さが仮の値）は予測しない。区域の判定へ戻す。
      it('仮定震源要素の報は区域の判定へ戻す', () => {
        const provisional = { ...eewAt(42.0, 143.0, 10, 1.0, '仮定震源要素'), areas: areas('東京都23区', 10) } as EEWAlert
        expect(seismoWaveTriggered({ ...QUIET, scope: NEAR, stations: [ST], eews: [provisional] })).toBe(true)
      })

      // 普段が読めない間は −1.5 を下限にする（2026-10-22 ユーザー承認「−1.5 を下限にする」）。
      // 正: 近くの地震は普段が読めなくても出す。
      it('普段が読めなくても、近くの地震なら出す', () => {
        expect(seismoWaveTriggered({ ...QUIET, scope: NEAR, stations: [stationAt(35.0, 135.0, null)], eews: [eewAt(35.1, 135.1, 10, 4.5)] })).toBe(true)
      })

      // 対照: 地震カードのように下限なしへ倒すと、遠くの小さい地震でも出る（直した症状に戻る）。
      it('普段が読めなくても、遠くの小さい地震では出さない', () => {
        expect(EEW_REACH_FLOOR_WITHOUT_USUAL).toBe(-1.5)
        expect(seismoWaveTriggered({ ...QUIET, scope: NEAR, stations: [stationAt(35.0, 135.0, null)], eews: [eewAt(42.0, 143.0, 50, 4.0)] })).toBe(false)
      })

      // 「非常に強い揺れを検知」の報は M が判らず予測できないので、検知点から地震計までの距離で決める
      // （2026-10-22 ユーザー承認「検知点から 30km」）。
      it('非常に強い揺れを検知した報は、検知点が地震計から 30 km 以内なら出す', () => {
        const seismoScope = scope({ regionNames: new Set(['区域甲']), centers: [{ lat: 35.0, lng: 135.0 }] })
        const near = { ...eewAt(35.2, 135.0, 10, -1), strongShakingOnly: true, forecastMaxScale: 45 } as EEWAlert
        const far = { ...eewAt(35.3, 135.0, 10, -1), strongShakingOnly: true, forecastMaxScale: 45 } as EEWAlert
        expect(seismoWaveTriggered({ ...QUIET, scope: seismoScope, stations: [ST], eews: [near] })).toBe(true)
        expect(seismoWaveTriggered({ ...QUIET, scope: seismoScope, stations: [ST], eews: [far] })).toBe(false)
      })

      // 安全弁: 座標の無い観測点は予測できないので、区域の判定へ戻す。
      it('座標の無い観測点だけなら区域の判定へ戻す', () => {
        const noCoords: SeismoIntensityLike = { stationId: 's1', lat: null, lon: null, intensity: -1.3, usualMeasured: -1.3 }
        const e = { ...eewAt(42.0, 143.0, 50, 4.0), areas: areas('東京都23区', 10) } as EEWAlert
        expect(seismoWaveTriggered({ ...QUIET, scope: NEAR, stations: [noCoords], eews: [e] })).toBe(true)
      })
    })
  })

  describe('強震モニタの検知', () => {
    const NEAR = scope({ kyoshinKeys: new Set([HOME_KEY]) })

    it('半径内の確定メンバーが震度1 以上なら出す', () => {
      expect(seismoWaveTriggered({ ...QUIET, scope: NEAR, detectedPoints: [pt(HOME_KEY, 8)] })).toBe(true)
    })

    // 対照: 遠方だけが揺れているのは「近所は揺れていない」。
    it('半径内に確定メンバーが無ければ出さない', () => {
      expect(seismoWaveTriggered({ ...QUIET, scope: NEAR, detectedPoints: [pt(FAR_KEY, 19)] })).toBe(false)
    })

    // 対照: 震度0 は強震モニタでも階級値が震度1 と同値（どちらも 10）。ここを通すと
    // 平常時のノイズで出っぱなしになる（`actionChecklistTrigger.ts` の `scanPoints`）。
    it('震度0 のメンバーでは出さない', () => {
      expect(seismoWaveTriggered({ ...QUIET, scope: NEAR, detectedPoints: [pt(HOME_KEY, 6)] })).toBe(false)
    })
  })

  // 3 経路は or。どれか 1 つで足りる（行動チェックリストのように 1 つを選ぶ必要が無い）。
  it('経路をまたいで or になる', () => {
    const near = scope({ kyoshinKeys: new Set([HOME_KEY]) })
    expect(
      seismoWaveTriggered({
        ...QUIET,
        scope: near,
        stations: [{ stationId: 's1', lat: null, lon: null, intensity: -0.04, usualMeasured: null }],
        detectedPoints: [pt(FAR_KEY, 19)],
        eews: [eew([{ pref: '東京都', name: '東京都23区', scaleFrom: 10, scaleTo: 10 }] as EEWAlert['areas'])],
      }),
    ).toBe(true)
  })
})
