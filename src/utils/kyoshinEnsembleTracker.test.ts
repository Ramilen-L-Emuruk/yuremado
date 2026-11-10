import { describe, expect, it } from 'vitest'
import { ENSEMBLE_KEEP_MS, type DetectorFrame, type EnsembleReport } from './kyoshinEnsembleDetector'
import { createEnsembleTracker, createPartnerTest, DRAWN_FADE_MS, DRAWN_KEEP_INDEX, HOLD_PARTNER_KM, HOLD_PARTNER_NEAREST, type EnsembleReporter } from './kyoshinEnsembleTracker'

const SITES: [number, number][] = [[35, 135], [35.1, 135], [35, 135], [36, 136]]
const T0 = Date.UTC(2026, 0, 1)

/** 秒ごとに決めた行を返す偽の束ね役 */
function scripted(rows: Record<number, EnsembleReport[]>): EnsembleReporter {
  return { push: (f: DetectorFrame) => rows[(f.ms - T0) / 1000] ?? [], setTables: () => {} }
}
const row = (tier: 'early' | 'confirmed', sites: number[], extra: Partial<EnsembleReport> = {}): EnsembleReport =>
  ({ id: 'e1', tier, lat: 35, lng: 135, startMs: T0, sites, sources: ['stat'], ...extra })
const frame = (sec: number, values = [8, 8, 8, 8]): DetectorFrame => ({ ms: T0 + sec * 1000, values: Int8Array.from(values) })

describe('組み合わせの検知のまとめ', () => {
  it('正: 確かな段の行が出たら確かな段になり、加わった観測点と支えた部分は積み上がる', () => {
    const t = createEnsembleTracker(SITES, scripted({
      0: [row('early', [0])],
      1: [row('early', [0, 1]), row('confirmed', [1], { sources: ['fast'] })],
    }))
    expect(t.push(frame(0))[0].confidence).toBe('likely')
    const d = t.push(frame(1, [8, 12, 8, 8]))[0]
    expect(d.confidence).toBe('confirmed')
    expect(d.firstConfirmedAtMs).toBe(T0 + 1000)
    expect(d.memberKeys).toEqual(['35.000,135.000', '35.100,135.000'])
    expect(d.sources.sort()).toEqual(['fast', 'stat'])
    // 段 12 = 計測震度 3.0
    expect(d.maxIntensity).toBe(3)
  })

  it('対照: 早い段の行だけが続く間は確かな段にならない', () => {
    const t = createEnsembleTracker(SITES, scripted({ 0: [row('early', [0])], 1: [row('early', [0])] }))
    t.push(frame(0))
    const d = t.push(frame(1))[0]
    expect(d.confidence).toBe('likely')
    expect(d.firstConfirmedAtMs).toBeNull()
  })

  it('安全弁: 一度確かな段になった束は、早い段の行しか出なくなっても確かな段のまま', () => {
    const t = createEnsembleTracker(SITES, scripted({ 0: [row('confirmed', [0])], 1: [row('early', [0])] }))
    t.push(frame(0))
    const d = t.push(frame(1))[0]
    expect(d.confidence).toBe('confirmed')
    expect(d.firstConfirmedAtMs).toBe(T0)
  })

  it('安全弁: 報告が途切れても寿命の間は残し、寿命を過ぎたら消す', () => {
    const keepSec = ENSEMBLE_KEEP_MS / 1000
    const t = createEnsembleTracker(SITES, scripted({ 0: [row('confirmed', [0])] }))
    t.push(frame(0))
    expect(t.push(frame(keepSec)).map(d => d.id)).toEqual(['e1'])
    expect(t.push(frame(keepSec + 1))).toEqual([])
  })

  it('座標が重なる観測点は別の点として数える', () => {
    const t = createEnsembleTracker(SITES, scripted({ 0: [row('early', [0, 2])] }))
    expect(t.push(frame(0))[0].memberKeys).toEqual(['35.000,135.000', '35.000,135.000#2'])
  })

  it('加わった点がいま全員欠測なら、最大の震度は持たない', () => {
    const t = createEnsembleTracker(SITES, scripted({ 0: [row('early', [0])] }))
    expect(t.push(frame(0, [-1, 8, 8, 8]))[0].maxIntensity).toBeNull()
  })

  it('束が 2 つあれば揺れ始めの早い順に返す', () => {
    const t = createEnsembleTracker(SITES, scripted({
      0: [row('early', [3], { id: 'e2', startMs: T0 + 500, lat: 36, lng: 136 }), row('early', [0])],
    }))
    expect(t.push(frame(0)).map(d => d.id)).toEqual(['e1', 'e2'])
  })

  describe('地図に描く点（drawnKeys）', () => {
    const fadeSec = DRAWN_FADE_MS / 1000
    /** 毎秒、点 0 と 1 の束を報告し続ける（寿命で消えないように） */
    const everySecond: EnsembleReporter = { push: () => [row('confirmed', [0, 1])], setTables: () => {} }
    /** 0 秒から lastSec 秒まで valuesAt の値を流し、最後の秒の検知を返す（段 3 は震度0 未満・段 6 は計測震度 0.0） */
    function run(lastSec: number, valuesAt: (sec: number) => number[]) {
      const t = createEnsembleTracker(SITES, everySecond)
      let d = t.push(frame(0, valuesAt(0)))[0]
      for (let s = 1; s <= lastSec; s++) d = t.push(frame(s, valuesAt(s)))[0]
      return d
    }
    const low = () => [3, 8, 8, 8]

    it('正: 震度0 未満が DRAWN_FADE_MS を超えて続いた点は描く点から外す', () => {
      const d = run(fadeSec + 1, low)
      expect(d.drawnKeys).toEqual(['35.100,135.000'])
    })

    it('対照: DRAWN_FADE_MS ちょうどまでは描く点に残す', () => {
      const d = run(fadeSec, low)
      expect(d.drawnKeys).toEqual(['35.000,135.000', '35.100,135.000'])
    })

    it('安全弁: 外した点も加わった点（memberKeys）からは外さない', () => {
      const d = run(fadeSec + 1, low)
      expect(d.memberKeys).toEqual(['35.000,135.000', '35.100,135.000'])
    })

    it('正: 外した点が震度0 以上へ戻ったら描き直す', () => {
      const d = run(fadeSec + 2, s => (s === fadeSec + 2 ? [6, 8, 8, 8] : low()))
      expect(d.drawnKeys).toEqual(['35.000,135.000', '35.100,135.000'])
    })

    it('対照: 欠測の秒は震度0 以上に数えない（描き直す理由にならない）', () => {
      // 揺れ始め（震度0 以上）の後は欠測が続き、最後の 1 秒だけ震度0 未満
      const d = run(fadeSec + 5, s => (s === 0 ? [8, 8, 8, 8] : s === fadeSec + 5 ? low() : [-1, 8, 8, 8]))
      expect(d.drawnKeys).toEqual(['35.100,135.000'])
    })

    it('安全弁: 外すと描く点が 1 つも残らないなら、最後に震度0 以上だった時刻が同じ点はすべて残す', () => {
      const d = run(fadeSec + 1, () => [3, 3, 8, 8])
      expect(d.drawnKeys).toEqual(['35.000,135.000', '35.100,135.000'])
    })

    // 2026-10-29 ユーザー選択「最後まで残っていた点だけ (Recommended)」
    it('正: 最後の描く点が外れるときは、その点だけを残す（先に外れた点を描き戻さない）', () => {
      // 点 0 は初めから震度0 未満・点 1 は 10 秒まで震度0 以上
      const d = run(10 + fadeSec + 1, s => [3, s <= 10 ? 8 : 3, 8, 8])
      expect(d.drawnKeys).toEqual(['35.100,135.000'])
      expect(d.memberKeys).toEqual(['35.000,135.000', '35.100,135.000'])
    })
  })

  // 2026-11-10 ユーザー選択「案D で入れる (Recommended)」（設計書§84）
  describe('描く点は相手の鎖で DRAWN_GROUP_MIN 点以上つながる塊に限る', () => {
    // 0〜2: 11 km おきの 3 点（塊 A）／3〜5: 約 550 km 先の 11 km おきの 3 点（塊 B）
    // 6: さらに約 700 km 先の 1 点（L）。7〜11 は L を囲む加わっていない点で、L から近い 5 点を埋める
    // 12〜14: 67 km おきに並び、間にも周りにも点の無い 3 点（まばらな所。40 km を超えるので近い 5 点でだけつながる）
    // 15〜20: 塊 A・B それぞれを囲む加わっていない点。A・B から近い 5 点がもう片方の塊に届かないようにする
    const G: [number, number][] = [
      [35, 135], [35.1, 135], [35.2, 135], [38, 140], [38.1, 140], [38.2, 140], [43, 145],
      [43.1, 145], [42.9, 145], [43, 145.1], [43, 144.9], [43.1, 145.1],
      [30, 125], [30.6, 125], [31.2, 125],
      [34.95, 135.1], [35.1, 135.1], [35.25, 135.1], [37.95, 140.1], [38.1, 140.1], [38.25, 140.1],
    ]
    const A = ['35.000,135.000', '35.100,135.000', '35.200,135.000']
    const B = ['38.000,140.000', '38.100,140.000', '38.200,140.000']
    const L = '43.000,145.000'
    /** 0 秒に `members` が加わった束の検知（加わった点は `value`、ほかは震度0 未満で値の届く点） */
    const drawnOf = (members: number[], value = 8) => {
      const t = createEnsembleTracker(G, scripted({ 0: [row('confirmed', members)] }))
      return t.push(frame(0, G.map((_, i) => (members.includes(i) ? value : 3))))[0]
    }

    it('正: どの点とも鎖でつながらない遠くの 1 点は描く点から外す（加わった点には残す）', () => {
      const d = drawnOf([0, 1, 2, 6])
      expect(d.drawnKeys).toEqual(A)
      expect(d.memberKeys).toEqual([...A, L])
    })

    it('安全弁: 3 点以上の塊が 2 つあれば、どちらも描く（前の検知に呑まれた別の地震の点）', () => {
      // 塊の大きさを 4 点と 3 点にして、いちばん大きい塊だけを描く形では落ちるようにする
      expect(drawnOf([0, 1, 2, 16, 3, 4, 5, 6]).drawnKeys).toEqual([...A, '35.100,135.100', ...B])
    })

    it('正: 塊の間の点が欠測なら、その先の点が近い 5 点に入ってつながる', () => {
      // A を囲む点（15〜17）と B を囲む点（18〜20）を欠測にすると、A から近い値の届く 5 点に B の点が入り、1 つの塊になる
      const t = createEnsembleTracker(G, scripted({ 0: [row('confirmed', [0, 3])] }))
      const missing = [1, 2, 4, 5, 15, 16, 17, 18, 19, 20]
      const d = t.push(frame(0, G.map((_, i) => (missing.includes(i) ? -1 : 8))))[0]
      expect(d.drawnKeys).toEqual([A[0], B[0]])
      // 対照: 欠測でなければ、A の点 0 と B の点 3 はどちらも 1 点の塊で、先に加わった点 0 の塊だけを描く
      const t2 = createEnsembleTracker(G, scripted({ 0: [row('confirmed', [0, 3])] }))
      expect(t2.push(frame(0, G.map(() => 8)))[0].drawnKeys).toEqual([A[0]])
    })

    it('対照: どの塊も 3 点に届かなければ、いちばん大きい塊を描く（描く点を空にしない）', () => {
      expect(drawnOf([6, 0, 1]).drawnKeys).toEqual(A.slice(0, 2))
    })

    it('対照: 大きさが同じなら、先に加わった点を含む塊を描く', () => {
      expect(drawnOf([6, 0]).drawnKeys).toEqual([L])
      expect(drawnOf([0, 6]).drawnKeys).toEqual([A[0]])
    })

    it('正: 40 km を超えても、互いに近い 5 点に入る 3 点は 1 つの塊として描く（まばらな所）', () => {
      expect(drawnOf([12, 13, 14, 6]).drawnKeys).toEqual(['30.000,125.000', '30.600,125.000', '31.200,125.000'])
    })

    // 2026-11-10 ユーザー選択「震度2相当以上は残す (Recommended)」
    it('正: 震度2 相当（DRAWN_KEEP_INDEX）以上の点は、1 点の塊でも描く', () => {
      const t = createEnsembleTracker(G, scripted({ 0: [row('confirmed', [0, 1, 2, 6])] }))
      const d = t.push(frame(0, G.map((_, i) => (i === 6 ? DRAWN_KEEP_INDEX : 8))))[0]
      expect(d.drawnKeys).toEqual([...A, L])
    })

    it('対照: 震度2 相当に 1 段届かない 1 点の塊は描かない', () => {
      const t = createEnsembleTracker(G, scripted({ 0: [row('confirmed', [0, 1, 2, 6])] }))
      const d = t.push(frame(0, G.map((_, i) => (i === 6 ? DRAWN_KEEP_INDEX - 1 : 8))))[0]
      expect(d.drawnKeys).toEqual(A)
    })

    // 2026-11-10 ユーザー発言「大前提震度0以下はP波の表示に必要です」
    it('安全弁: 震度0 未満の点も、塊にいれば描く', () => {
      expect(drawnOf([0, 1, 2, 6], 3).drawnKeys).toEqual(A)
    })
  })

  describe('揺れている点が残る間は消さない', () => {
    const keepSec = ENSEMBLE_KEEP_MS / 1000
    /** 0 秒に点 0・1 で確かな段になった束を、`toSec` 秒まで `values(s)` で流し、最後の秒の検知の id を返す */
    const idsAt = (toSec: number, values: (s: number) => number[]) => {
      const t = createEnsembleTracker(SITES, scripted({ 0: [row('confirmed', [0, 1])] }))
      let out: string[] = []
      for (let s = 0; s <= toSec; s++) out = t.push(frame(s, values(s))).map(d => d.id)
      return out
    }

    it('正: 報告が途切れても、加わった点の 2 点以上が震度1 以上なら寿命を過ぎても残す', () => {
      expect(idsAt(keepSec + 60, () => [7, 7, 0, 0])).toEqual(['e1'])
    })

    it('対照: 震度1 以上が 1 点だけなら寿命で消す', () => {
      expect(idsAt(keepSec + 1, () => [7, 6, 0, 0])).toEqual([])
    })

    it('安全弁: 揺れが収まってから寿命を過ぎたら消す', () => {
      const calmAt = 100
      const v = (s: number) => (s < calmAt ? [8, 8, 0, 0] : [6, 6, 0, 0])
      expect(idsAt(calmAt - 1 + keepSec, v)).toEqual(['e1'])
      expect(idsAt(calmAt + keepSec, v)).toEqual([])
    })

    it('対照: 欠測の点は震度1 以上に数えない', () => {
      expect(idsAt(keepSec + 1, () => [-1, -1, 0, 0])).toEqual([])
    })

    it('対照: 加わっていない点が震度1 以上でも残さない', () => {
      expect(idsAt(keepSec + 1, () => [0, 0, 7, 7])).toEqual([])
    })
  })

  // 2026-11-10 ユーザー選択「40km か近い5点で入れる (Recommended)」（設計書§83）
  describe('残すのは互いに相手になる 2 点（HOLD_PARTNER_KM・HOLD_PARTNER_NEAREST）', () => {
    const keepSec = ENSEMBLE_KEEP_MS / 1000
    // 0・1: 33 km 離れた 2 点／2: 0 から約 550 km（周りに 13〜17 の静かな点）／3・4: 67 km 離れ、間にも周りにも点の無い 2 点
    // 5・6: 61 km 離れた 2 点で、間（7〜12）に 9 km おきの点が並ぶ
    const P: [number, number][] = [
      [35, 135], [35.3, 135], [38, 140], [44, 145], [44.6, 145], [33, 131], [33.55, 131],
      [33.08, 131], [33.16, 131], [33.24, 131], [33.31, 131], [33.39, 131], [33.47, 131],
      [38.1, 140], [38.2, 140], [37.9, 140], [38, 140.1], [38, 139.9],
    ]
    const MIDDLE = [7, 8, 9, 10, 11, 12]
    /** 0 秒に `members` で確かな段になった束を、`toSec` 秒まで流し、最後の秒の検知の id を返す（`hot` の点は震度1・ほかは震度0 未満、`missing` の点は欠測） */
    const idsAt = (members: number[], hot: number[], toSec: number, missing: number[] = []) => {
      const t = createEnsembleTracker(P, scripted({ 0: [row('confirmed', members)] }))
      const values = P.map((_, i) => (missing.includes(i) ? -1 : hot.includes(i) ? 7 : 3))
      let out: string[] = []
      for (let s = 0; s <= toSec; s++) out = t.push(frame(s, values)).map(d => d.id)
      return out
    }

    it('正: 震度1 以上の 2 点が遠く離れ、どちらの近い 5 点にも入らなければ寿命で消す（全国へ広がった点の居座り）', () => {
      expect(idsAt([0, 1, 2, ...MIDDLE], [0, 2], keepSec + 1)).toEqual([])
    })

    it('対照: 40 km 以内の 2 点なら寿命を過ぎても残す', () => {
      expect(idsAt([0, 1, 2], [0, 1], keepSec + 60)).toEqual(['e1'])
    })

    it('正: 40 km を超えても、間にも周りにも点の無い 2 点は互いに近い 5 点に入るので残す（まばらな所）', () => {
      expect(idsAt([3, 4], [3, 4], keepSec + 60)).toEqual(['e1'])
    })

    it('対照: 40 km を超え、間に値の届く静かな点が 5 つ以上並ぶ 2 点は寿命で消す', () => {
      expect(idsAt([5, 6, ...MIDDLE], [5, 6], keepSec + 1)).toEqual([])
    })

    it('安全弁: 間の点が欠測なら近い 5 点に数えないので、同じ 2 点を残す', () => {
      expect(idsAt([5, 6, ...MIDDLE], [5, 6], keepSec + 60, MIDDLE)).toEqual(['e1'])
    })

    /** `sites` で、0 秒に `members` が確かな段になった束を `toSec` 秒まで流す（`hot` は震度1・`missing` は欠測・ほかは震度0 未満） */
    const idsOn = (sites: [number, number][], members: number[], hot: number[], toSec: number, missing: number[] = []) => {
      const t = createEnsembleTracker(sites, scripted({ 0: [row('confirmed', members)] }))
      const values = sites.map((_, i) => (missing.includes(i) ? -1 : hot.includes(i) ? 7 : 3))
      let out: string[] = []
      for (let s = 0; s <= toSec; s++) out = t.push(frame(s, values)).map(d => d.id)
      return out
    }

    it('正: 密な所で、間に値の届く点が 5 つ以上あっても 40 km 以内の 2 点は残す（近さの順だけなら切る形）', () => {
      // 0 と 1 は約 36 km。間に 4 km おきの点が 8 つ並ぶので、どちらの近い 5 点にも相手は入らない
      const dense: [number, number][] = [[35, 139], [35.32, 139], ...Array.from({ length: 8 }, (_, k) => [35.036 + k * 0.036, 139] as [number, number])]
      expect(idsOn(dense, [0, 1], [0, 1], keepSec + 60)).toEqual(['e1'])
    })

    it('正: 片方の近い 5 点にだけ相手が入る組も残す（まばらな点から密な所の点を見る形）', () => {
      // 0 は孤立した点で、いちばん近いのが 1（約 56 km）。1 の周りには 1 より 0 に近くない点が 6 つ密に並ぶ
      const lopsided: [number, number][] = [[33, 129], [33.5, 129], ...Array.from({ length: 6 }, (_, k) => [33.5 + (k + 1) * 0.02, 129.02] as [number, number])]
      // 加わった順を 0 → 1（組の 1 点目から見た近い 5 点で決まる）と 1 → 0（2 点目から見た近い 5 点で決まる）の両方で流す
      expect(idsOn(lopsided, [0, 1], [0, 1], keepSec + 60)).toEqual(['e1'])
      expect(idsOn(lopsided, [1, 0], [0, 1], keepSec + 60)).toEqual(['e1'])
    })

    it('安全弁: 近い順の初めの 16 点が欠測ばかりでも、その先までたどって相手を見つける', () => {
      // 0 と 1 は約 61 km。0 と 1 のそれぞれ外側に 20 点ずつあるが全部欠測なので、値の届く点では互いがいちばん近い点
      const shadowed: [number, number][] = [
        [33, 131], [33.55, 131],
        ...Array.from({ length: 20 }, (_, k) => [33 - (k + 1) * 0.01, 131.01] as [number, number]),
        ...Array.from({ length: 20 }, (_, k) => [33.55 + (k + 1) * 0.01, 131.01] as [number, number]),
      ]
      const missing = Array.from({ length: 40 }, (_, k) => k + 2)
      expect(idsOn(shadowed, [0, 1], [0, 1], keepSec + 60, missing)).toEqual(['e1'])
    })
  })

  it('観測点の数と値の数が食い違えば投げる', () => {
    const t = createEnsembleTracker(SITES, scripted({}))
    expect(() => t.push(frame(0, [8, 8]))).toThrow('食い違って')
  })
})

// 設計書§84: 近い点を升から探す形が、全点を総当たりする形と同じ相手を返すこと
describe('相手の判定（升で探す形と総当たりの突き合わせ）', () => {
  const R = 6371
  const rad = Math.PI / 180
  const dist = (a: [number, number], b: [number, number]) => {
    const x = Math.sin((b[0] - a[0]) * rad / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin((b[1] - a[1]) * rad / 2) ** 2
    return 2 * R * Math.asin(Math.sqrt(x))
  }
  /** 種から決まる 0〜1 の数の列（毎回同じ点の並びにする） */
  const rng = (seed: number) => () => (seed = (seed * 16807) % 2147483647) / 2147483647
  /** 総当たり: i から近い順（同じ距離なら番号の小さい点が先）に、値の届く点を HOLD_PARTNER_NEAREST 個 */
  const bruteNearest = (sites: [number, number][], i: number, values: number[]) =>
    sites.map((_, k) => k).filter(k => k !== i && values[k] >= 0)
      .sort((x, y) => dist(sites[i], sites[x]) - dist(sites[i], sites[y]) || x - y).slice(0, HOLD_PARTNER_NEAREST)
  const brutePartner = (sites: [number, number][], i: number, j: number, values: number[]) =>
    dist(sites[i], sites[j]) <= HOLD_PARTNER_KM || bruteNearest(sites, i, values).includes(j) || bruteNearest(sites, j, values).includes(i)

  for (const [name, seed, missing] of [['欠測なし', 7, 0], ['欠測 3 割', 11, 0.3], ['欠測 9 割', 13, 0.9]] as const) {
    it(`正: ${name}で、相手の組と相手として渡す点が総当たりと一致する（北緯 24〜46°・同じ距離の点を含む）`, () => {
      const r = rng(seed)
      const sites: [number, number][] = []
      for (let k = 0; k < 300; k++) sites.push([24 + r() * 22, 123 + r() * 23])
      // 升の境目をまたぐ近い点と、ある点から同じ距離に並ぶ点
      for (let k = 0; k < 30; k++) { const [a, b] = sites[k]; sites.push([a + (r() - 0.5) * 0.6, b + (r() - 0.5) * 0.6]) }
      sites.push([45.4, 141.7], [45.4, 142.2], [45.9, 141.7], [44.9, 141.7])
      const values = sites.map(() => (r() < missing ? -1 : 8))
      const t = createPartnerTest(sites)
      t.beginFrame(values)
      for (let i = 0; i < sites.length; i += 3) {
        const got = new Set<number>()
        t.eachPartnerFrom(i, values, k => got.add(k))
        const want = new Set([...sites.map((_, k) => k).filter(k => k !== i && dist(sites[i], sites[k]) <= HOLD_PARTNER_KM), ...bruteNearest(sites, i, values)])
        expect([...got].sort((a, b) => a - b)).toEqual([...want].sort((a, b) => a - b))
        for (let j = 0; j < sites.length; j += 17) if (j !== i) expect(t.isPartner(i, j, values)).toBe(brutePartner(sites, i, j, values))
      }
    })
  }

  it('正: 距離がちょうど同じ点は、番号の小さい点を先に近い点へ入れる', () => {
    // 0 から真東と真西へ同じ経度差の点を並べる（距離は浮動小数でも完全に一致する）。近い 5 点の 5 番目で同じ距離の 2 点が競う
    const sites: [number, number][] = [[35, 135], [35, 135.6], [35, 134.4], [35, 135.7], [35, 134.3], [35, 135.9], [35, 134.1]]
    expect(dist(sites[0], sites[5])).toBe(dist(sites[0], sites[6]))
    const t = createPartnerTest(sites)
    const all = sites.map(() => 8)
    t.beginFrame(all)
    const got: number[] = []
    t.eachPartnerFrom(0, all, k => got.push(k))
    expect(got).toContain(5)
    expect(got).not.toContain(6)
  })

  it('安全弁: beginFrame の前に使うと止まる（その秒の値を数えずに相手を決めない）', () => {
    const t = createPartnerTest([[35, 135], [36, 136]])
    expect(() => t.isPartner(0, 1, [8, 8])).toThrow()
  })

  it('安全弁: 秒が替わったら（beginFrame）、前の秒の値で求めた近い点を使わない', () => {
    const sites: [number, number][] = [[35, 135], [35.6, 135], [36.2, 135], [36.8, 135], [37.4, 135], [38, 135], [38.6, 135]]
    const t = createPartnerTest(sites)
    const all = sites.map(() => 8)
    t.beginFrame(all)
    expect(t.isPartner(0, 6, all)).toBe(false)
    // 間の点がすべて欠測になった秒は、離れた点 6 が近い 5 点に入る
    const gap = [8, -1, -1, -1, -1, 8, 8]
    t.beginFrame(gap)
    expect(t.isPartner(0, 6, gap)).toBe(true)
  })
})
