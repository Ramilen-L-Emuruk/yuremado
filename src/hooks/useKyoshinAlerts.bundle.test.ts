// 揺れの束で「同じ地震」を覚える（2026-11-06 ユーザー選択「揺れの束ごとに覚える (Recommended)」
// 「走時で結べる束も含める (Recommended)」「結べる束なら鳴らさない (Recommended)」）。
//
//   正     : 速報に含めた束は、速報が解除されて新しい地域になっても「別の地点」にしない／
//            有感の半径の外でも、速報に走時で結べる束は「別の地点」にしない／
//            検知音を鳴らした速報に結べる束で確かな段が立ち直しても、検知音を鳴らさない
//   対照   : 解除の後に新しく立った束は「別の地点」として鳴らす／走時の窓の外で始まった束は鳴らす／
//            結べない揺れが混じった立ち直しは鳴らす
//   安全弁 : 束を持たない揺れは今までどおり／速報の発表が終わったら、立ち直しで鳴らす
import { describe, it, expect } from 'vitest'
import { createAlertRegionState, shouldSoundConfirmedStart, stepAlertRegions, type AlertShockInput } from './useKyoshinAlerts'
import type { EEWAlert, Hypocenter } from '../types/earthquake'
import { travelTimeSec } from '../utils/travelTime'
import { haversineKm } from '../utils/geo'

function fakeEEW(id: string, originTime: string, hypocenter: Hypocenter): EEWAlert {
  return {
    kind: 'eew', origin: 'dmdata', id, time: originTime, test: false, severity: 'Forecast', cancelled: false,
    earthquake: { originTime, arrivalTime: originTime, condition: '以上', hypocenter },
  }
}

type Bundle = NonNullable<AlertShockInput['bundle']>
const shock = (lat: number, lng: number, bundle?: Bundle): AlertShockInput => ({ lat, lng, index: 9, peak: { lat, lng }, bundle })

/** 能登 M8.0・深さ 10km の速報。有感の半径は福岡（約 780km）まで届く */
const NOTO_ORIGIN = '2026-01-01T07:10:00.000Z'
const notoEew = fakeEEW('noto', NOTO_ORIGIN, { name: '能登半島沖', latitude: 37.5, longitude: 137.2, depth: 10, magnitude: 8.0 })
const T = Date.parse(NOTO_ORIGIN) + 600_000 // 速報の半径が有感の半径で打ち止めになった後
const noto = (b?: Bundle) => shock(37.5, 137.0, b)
const fukuoka = (b?: Bundle) => shock(33.6, 130.4, b)
/** 能登から約 1,000km の北海道東部。解除後の束ねる距離（最大 800km）の外 */
const hokkaido = (b?: Bundle) => shock(43.3, 145.0, b)
const bundle = (id: string, lat: number, lng: number, startedAtMs = T - 300_000): Bundle => ({ id, startedAtMs, epicenter: { lat, lng } })

/** 能登で始まり、速報の間に福岡の束が加わる。速報が解除された後、福岡の束 `farId` の揺れが北海道へ移る */
function runExpiry(farId: string | undefined): unknown {
  const state = createAlertRegionState()
  const eews = new Map([[notoEew.id, notoEew]])
  const fb = bundle('f', 33.6, 130.4)
  stepAlertRegions(state, [noto(bundle('n', 37.5, 137.0))], T, eews)
  for (let i = 1; i <= 10; i++) stepAlertRegions(state, [noto(bundle('n', 37.5, 137.0)), fukuoka(fb)], T + i * 1000, eews)
  // 速報が解除された。同じ（または別の）束の揺れが離れた場所で続く
  const far = hokkaido(farId === undefined ? undefined : bundle(farId, 33.6, 130.4))
  let fired: unknown = null
  for (let i = 11; i <= 30; i++) fired = stepAlertRegions(state, [noto(bundle('n', 37.5, 137.0)), far], T + i * 1000, new Map()) ?? fired
  return fired
}

describe('stepAlertRegions: 速報に含めた束は解除の後も数え直さない', () => {
  it('[正] 速報の間に含めた束（f）の揺れが、解除の後に新しい地域になっても鳴らさない', () => {
    expect(haversineKm(37.5, 137.0, 43.3, 145.0)).toBeGreaterThan(800)
    expect(runExpiry('f')).toBeNull()
  })

  it('[対照] 解除の後に新しく立った束（g）は、別の地点として鳴らす', () => {
    expect(runExpiry('g')).not.toBeNull()
  })

  it('[安全弁] 束を持たない揺れは今までどおり鳴らす', () => {
    expect(runExpiry(undefined)).not.toBeNull()
  })
})

/** 硫黄島近海 M4.8・深さ 10km の速報（2026-11-04 01:48 に似せた）。有感の半径は約 417km */
const IWO_ORIGIN = '2026-11-03T16:48:33.000Z'
const iwoEew = fakeEEW('iwo', IWO_ORIGIN, { name: '硫黄島近海', latitude: 25.9, longitude: 141.8, depth: 10, magnitude: 4.8 })
const IO = Date.parse(IWO_ORIGIN)
const BOSO = { lat: 35.1, lng: 139.8 }
/** 房総から 300km（同じ地域にまとめる距離）より離れた福岡。震源から約 1,800km */
const FAR = { lat: 33.6, lng: 130.4 }
const sArrivalMs = (p: { lat: number; lng: number }) => IO + travelTimeSec('S', haversineKm(25.9, 141.8, p.lat, p.lng), 10) * 1000

describe('stepAlertRegions: 有感の半径の外でも、走時で結べる束は速報の揺れに含める', () => {
  function run(farStartedAtMs: number): unknown {
    const state = createAlertRegionState()
    const eews = new Map([[iwoEew.id, iwoEew]])
    const t0 = sArrivalMs(BOSO)
    const boso = shock(BOSO.lat, BOSO.lng, bundle('p', BOSO.lat, BOSO.lng, t0))
    const far = shock(FAR.lat, FAR.lng, bundle('a', FAR.lat, FAR.lng, farStartedAtMs))
    stepAlertRegions(state, [boso], t0, eews)
    let fired: unknown = null
    for (let i = 1; i <= 15; i++) fired = stepAlertRegions(state, [boso, far], t0 + i * 1000, eews) ?? fired
    return fired
  }

  it('[正] S 波の到達の見込みに始まった福岡の束（半径の外）は鳴らさない', () => {
    expect(haversineKm(25.9, 141.8, FAR.lat, FAR.lng)).toBeGreaterThan(1000)
    expect(haversineKm(BOSO.lat, BOSO.lng, FAR.lat, FAR.lng)).toBeGreaterThan(300)
    expect(run(sArrivalMs(FAR))).toBeNull()
  })

  it('[対照] S 波の到達の 90 秒後より遅く始まった束は、別の地点として鳴らす', () => {
    expect(run(sArrivalMs(FAR) + 120_000)).not.toBeNull()
  })
})

describe('shouldSoundConfirmedStart: 検知音を鳴らした速報に結べる束で立ち直したら鳴らさない', () => {
  const eews = new Map([[iwoEew.id, iwoEew]])
  const pBundle = shock(BOSO.lat, BOSO.lng, bundle('p', BOSO.lat, BOSO.lng, sArrivalMs(BOSO) - 120_000))
  const sBundle = shock(BOSO.lat, BOSO.lng, bundle('s', BOSO.lat, BOSO.lng, sArrivalMs(BOSO)))

  it('[正] P 波の束で鳴らした後、S 波の束で立ち直したときは鳴らさない', () => {
    const sounded = new Set<string>()
    expect(shouldSoundConfirmedStart(sounded, [pBundle], eews, true)).toBe(true)
    expect(shouldSoundConfirmedStart(sounded, [sBundle], eews, true)).toBe(false)
  })

  it('[対照] 結べない揺れ（走時の窓の外で始まった束）が混じれば鳴らす', () => {
    const sounded = new Set<string>()
    shouldSoundConfirmedStart(sounded, [pBundle], eews, true)
    const later = shock(FAR.lat, FAR.lng, bundle('x', FAR.lat, FAR.lng, sArrivalMs(FAR) + 600_000))
    expect(shouldSoundConfirmedStart(sounded, [sBundle, later], eews, true)).toBe(true)
  })

  it('[対照] 最初の立ち上がりは、速報に結べても鳴らす', () => {
    expect(shouldSoundConfirmedStart(new Set(), [sBundle], eews, true)).toBe(true)
  })

  it('[安全弁] 速報の発表が終わったら、立ち直しで鳴らす', () => {
    const sounded = new Set<string>()
    shouldSoundConfirmedStart(sounded, [pBundle], eews, true)
    expect(shouldSoundConfirmedStart(sounded, [sBundle], new Map(), true)).toBe(true)
    expect(sounded.size).toBe(0)
  })

  it('[安全弁] 束を持たない揺れは鳴らす', () => {
    const sounded = new Set<string>(['iwo'])
    expect(shouldSoundConfirmedStart(sounded, [shock(BOSO.lat, BOSO.lng)], eews, true)).toBe(true)
  })
})

describe('stepAlertRegions: 覚える束の範囲', () => {
  it('[対照] 速報が無い間に、知らせ済みの地域へ照合されただけの束は覚えない（後で離れれば別の地点として鳴る）', () => {
    const state = createAlertRegionState()
    const n = bundle('n', 37.5, 137.0)
    stepAlertRegions(state, [noto(n)], T, new Map())
    // 能登の地域へ照合される別の束 z（約 50km 先）
    const z = bundle('z', 37.9, 137.2)
    stepAlertRegions(state, [noto(n), shock(37.9, 137.2, z)], T + 1000, new Map())
    expect(state.knownBundleIds.has('n')).toBe(true)
    expect(state.knownBundleIds.has('z')).toBe(false)
  })

  it('[安全弁] 確かな段が消えたら、覚えた束を忘れる', () => {
    const state = createAlertRegionState()
    stepAlertRegions(state, [noto(bundle('n', 37.5, 137.0))], T, new Map())
    expect(state.knownBundleIds.size).toBe(1)
    stepAlertRegions(state, [], T + 1000, new Map())
    expect(state.knownBundleIds.size).toBe(0)
  })
})

describe('shouldSoundConfirmedStart: 鳴らしていない速報は覚えない', () => {
  it('[対照] 音も通知も出さない（announce=false）ときは速報を覚えず、次の立ち直しで鳴らす', () => {
    const eews = new Map([[iwoEew.id, iwoEew]])
    const sounded = new Set<string>()
    const p = shock(BOSO.lat, BOSO.lng, bundle('p', BOSO.lat, BOSO.lng, sArrivalMs(BOSO) - 120_000))
    const s2 = shock(BOSO.lat, BOSO.lng, bundle('s', BOSO.lat, BOSO.lng, sArrivalMs(BOSO)))
    expect(shouldSoundConfirmedStart(sounded, [p], eews, false)).toBe(true)
    expect(sounded.size).toBe(0)
    expect(shouldSoundConfirmedStart(sounded, [s2], eews, true)).toBe(true)
  })
})

describe('stepAlertRegions: 知らせ済みの束が入った地域', () => {
  it('[安全弁] 知らない束が作った地域に、覚えた束が先に照合されても、その地域を作った束は別の地点として鳴る', () => {
    const state = createAlertRegionState()
    const eews = new Map([[notoEew.id, notoEew]])
    stepAlertRegions(state, [noto(bundle('n', 37.5, 137.0))], T, eews)
    // 速報の間に福岡で束 f が加わり、速報の揺れに含められる（f を覚える）
    for (let i = 1; i <= 3; i++) stepAlertRegions(state, [noto(bundle('n', 37.5, 137.0)), fukuoka(bundle('f', 33.6, 130.4))], T + i * 1000, eews)
    expect(state.knownBundleIds.has('f')).toBe(true)
    // 解除の後、北海道で知らない束 h が地域を作る
    const h = shock(43.4, 145.1, bundle('h', 43.4, 145.1))
    stepAlertRegions(state, [noto(bundle('n', 37.5, 137.0)), fukuoka(bundle('f', 33.6, 130.4)), h], T + 4000, new Map())
    // 以後、覚えた束 f の揺れもその地域へ照合され、h より先に処理される
    let fired: unknown = null
    for (let i = 5; i <= 30; i++) {
      fired = stepAlertRegions(state, [noto(bundle('n', 37.5, 137.0)), hokkaido(bundle('f', 33.6, 130.4)), h], T + i * 1000, new Map()) ?? fired
    }
    expect(fired).not.toBeNull()
  })

})

describe('stepAlertRegions: 覚えた束が作った地域', () => {
  it('[対照] 覚えた束の揺れが作った地域は知らせ済みとし、その場所で後から始まった別の束でも別の地点としては鳴らさない（同じ場所の 2 つ目が受け持つ）', () => {
    const state = createAlertRegionState()
    const eews = new Map([[notoEew.id, notoEew]])
    stepAlertRegions(state, [noto(bundle('n', 37.5, 137.0))], T, eews)
    for (let i = 1; i <= 3; i++) stepAlertRegions(state, [noto(bundle('n', 37.5, 137.0)), fukuoka(bundle('f', 33.6, 130.4))], T + i * 1000, eews)
    // 解除の後、覚えた束 f の揺れが北海道で地域を作り、続いて同じ場所で知らない束 a が始まる
    let fired: unknown = null
    fired = stepAlertRegions(state, [noto(bundle('n', 37.5, 137.0)), hokkaido(bundle('f', 33.6, 130.4))], T + 4000, new Map()) ?? fired
    for (let i = 5; i <= 30; i++) {
      fired = stepAlertRegions(state, [noto(bundle('n', 37.5, 137.0)), hokkaido(bundle('f', 33.6, 130.4)), shock(43.4, 145.1, bundle('a', 43.4, 145.1))], T + i * 1000, new Map()) ?? fired
    }
    expect(fired).toBeNull()
  })
})
