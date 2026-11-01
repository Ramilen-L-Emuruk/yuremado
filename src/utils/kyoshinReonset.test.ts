import { describe, it, expect } from 'vitest'
import {
  createReonsetState, stepReonset, REONSET_QUIET_MS, REONSET_GUARD_MS, REONSET_SETTLED_MS, REONSET_PAIR_NEAR_KM, REONSET_ONSET_NEAR_KM,
} from './kyoshinReonset'
import type { EnsembleDetection } from './kyoshinEnsembleTracker'
import { fakeEnsembleDetection } from '../test-utils/ensembleDetection'

// 同じ場所の 2 つ目の地震（設計書§40・§51）

const T0 = 1_000_000

describe('stepReonset: もう一度の立ち上がり（2026-11-02 ユーザー選択「この形で実装へ進む (Recommended)」）', () => {
  // 能登付近の確かな束。点のキーは座標（`kyoshinSiteKeys` と同じ形）
  const EPI: [number, number] = [37.3, 137.0]
  const ev = (confidence: EnsembleDetection['confidence'] = 'confirmed') =>
    fakeEnsembleDetection({ id: 'evt-1', confidence, epicenter: EPI, originTimeMs: T0, memberKeys: [] })
  // 震央の近く（約 5〜8 km）
  const P = '37.300,137.050', Q = '37.350,137.000', R = '37.250,136.950'

  /** 束の揺れ始めに keys が立ち上がり、直近から外れた状態を作る */
  function rose(keys: string[], confidence: EnsembleDetection['confidence'] = 'confirmed') {
    const s = createReonsetState()
    stepReonset(s, [ev(confidence)], keys, T0 + 1000)
    stepReonset(s, [ev(confidence)], [], T0 + 10_000)
    return s
  }

  it('正: 束の中で上がった 2 点が、静けさの後にもう一度上がれば合図を出す', () => {
    const s = rose([P, Q])
    const t = T0 + 60_000
    expect(stepReonset(s, [ev()], [P, Q], t)).toEqual({ eventId: 'evt-1', atMs: t, keys: [P, Q] })
  })

  it('正: 3 秒の内に分かれて上がっても、まとまりとして数える', () => {
    const s = rose([P, Q])
    const t = T0 + 60_000
    expect(stepReonset(s, [ev()], [P], t)).toBeNull()
    expect(stepReonset(s, [ev()], [P, Q], t + 2000)?.keys).toEqual([P, Q])
  })

  it('対照: 1 点だけのもう一度の立ち上がりでは出さない', () => {
    const s = rose([P, Q])
    expect(stepReonset(s, [ev()], [P], T0 + 60_000)).toBeNull()
    expect(stepReonset(s, [ev()], [P], T0 + 65_000)).toBeNull()
  })

  it('対照: 前の立ち上がりから REONSET_QUIET_MS に届かない上がり（同じ揺れの続き）では出さない', () => {
    // 守り（REONSET_GUARD_MS）の内で一度上がり、守りを過ぎてから静けさに届かないうちにまた上がる。
    // 静けさの判定が無ければ、後の上がりは合図になる
    const s = rose([P, Q])
    const first = T0 + REONSET_GUARD_MS - 15_000
    expect(stepReonset(s, [ev()], [P, Q], first)).toBeNull()
    stepReonset(s, [ev()], [], first + 5000)
    const t = first + REONSET_QUIET_MS - 3000
    expect(t - T0).toBeGreaterThanOrEqual(REONSET_GUARD_MS)
    expect(stepReonset(s, [ev()], [P, Q], t)).toBeNull()
  })

  it('対照: 束の中で初めて上がった点は数えない（1 つ目の地震の波が届いただけのことが多い）', () => {
    const s = rose([R])
    expect(stepReonset(s, [ev()], [P, Q], T0 + 60_000)).toBeNull()
  })

  it('対照: 束が確かな段でなければ出さない', () => {
    const s = rose([P, Q], 'likely')
    expect(stepReonset(s, [ev('likely')], [P, Q], T0 + 60_000)).toBeNull()
  })

  it('対照: 束の地震の波で説明できる上がり（見かけの速さ 1.5〜8 km/s）は数えない', () => {
    // 震央から約 95 km の 3 点。束の揺れ始めから 62 秒で上がれば約 1.53 km/s
    const F1 = '38.155,137.000', F2 = '38.155,137.030', F3 = '38.150,137.015'
    const s = rose([F1, F2, F3])
    expect(stepReonset(s, [ev()], [F1, F2, F3], T0 + 62_000)).toBeNull()
  })

  it('対照: 近くの確かな束が始まって REONSET_GUARD_MS に届かない上がり（1 つ目の地震の揺れの続き）は数えない', () => {
    const s = rose([P, Q])
    expect(stepReonset(s, [ev()], [P, Q], T0 + 40_000)).toBeNull()
  })

  it('安全弁: 同じ遠さでも、波では届かない遅い上がり（1.5 km/s 未満）は数える', () => {
    const F1 = '37.750,137.000', F2 = '37.750,137.030'
    const s = rose([F1, F2])
    expect(stepReonset(s, [ev()], [F1, F2], T0 + 120_000)?.keys).toEqual([F1, F2])
  })

  it('対照: 束の位置から REONSET_ONSET_NEAR_KM より離れた点は数えない', () => {
    // 震央から約 111 km
    const G1 = '38.300,137.000', G2 = '38.300,137.030'
    expect(REONSET_ONSET_NEAR_KM).toBeLessThan(111)
    const s = rose([G1, G2])
    expect(stepReonset(s, [ev()], [G1, G2], T0 + 300_000)).toBeNull()
  })

  it(`対照: 2 点のまとまりは、束の位置から REONSET_PAIR_NEAR_KM より離れていれば出さない／安全弁: 3 点なら出す`, () => {
    // 震央から約 78 km（60 km より遠く、100 km より近い）
    const H1 = '38.000,137.000', H2 = '38.000,137.030', H3 = '37.990,137.010'
    expect(REONSET_PAIR_NEAR_KM).toBeLessThan(78)
    const two = rose([H1, H2])
    expect(stepReonset(two, [ev()], [H1, H2], T0 + 120_000)).toBeNull()
    const three = rose([H1, H2, H3])
    expect(stepReonset(three, [ev()], [H1, H2, H3], T0 + 120_000)?.keys).toEqual([H1, H2, H3])
  })

  it('対照: 座標を読めないキーは数えない', () => {
    const s = rose(['a', 'b'])
    expect(stepReonset(s, [ev()], ['a', 'b'], T0 + 60_000)).toBeNull()
  })

  it('安全弁: 合図を出した地震の波で説明できる、続く上がりでは鳴らし直さない', () => {
    // 合図の位置（P）から約 44 km の 2 点。合図の 20 秒後に上がると約 1.8 km/s（合図の揺れ始めは合図の 5 秒前）
    const N1 = '37.700,137.050', N2 = '37.700,137.080'
    const s = rose([P, Q, N1, N2])
    const t = T0 + 60_000
    expect(stepReonset(s, [ev()], [P, Q], t)).not.toBeNull()
    expect(stepReonset(s, [ev()], [], t + 10_000)).toBeNull()
    expect(stepReonset(s, [ev()], [N1, N2], t + 20_000)).toBeNull()
  })

  it('安全弁: 同じフレームを二度渡しても同じ結果を返す（StrictMode の二重実行）', () => {
    const s = rose([P, Q])
    const t = T0 + 60_000
    const first = stepReonset(s, [ev()], [P, Q], t)
    expect(first).not.toBeNull()
    expect(stepReonset(s, [ev()], [P, Q], t)).toEqual(first)
  })

  it('安全弁: データ時刻が巻き戻ったら（リプレイの開始）状態を捨てる', () => {
    const s = rose([P, Q])
    stepReonset(s, [ev()], [], T0 + 100_000)
    // 巻き戻した先（T0+60 秒）は、捨てなければ前の立ち上がり（T0+1 秒）から 20 秒以上たったもう一度の上がりに見える。
    // 捨てていれば前の時間軸の立ち上がりを覚えていないので、初めての上がりとして数えない
    expect(stepReonset(s, [ev()], [P, Q], T0 + 60_000)).toBeNull()
  })

  it('対照: 合図を出していなければ、同じ遠さ・同じ時刻の 2 点は合図になる（下の安全弁の対）', () => {
    const N1 = '37.700,137.050', N2 = '37.700,137.080'
    const s = rose([P, Q, N1, N2])
    stepReonset(s, [ev()], [], T0 + 60_000)
    stepReonset(s, [ev()], [], T0 + 70_000)
    expect(stepReonset(s, [ev()], [N1, N2], T0 + 80_000)?.keys).toEqual([N1, N2])
  })

  it('安全弁: 新しい束の合図が出たフレームでも、そのフレームの立ち上がりを覚える', () => {
    // 束 a（evt-1）が 60 秒以上続く最中に、約 28 km 離れた束 b が確かな段になる。同じフレームで P・Q も上がる
    const b = fakeEnsembleDetection({ id: 'evt-2', confidence: 'confirmed', epicenter: [37.5, 137.2], originTimeMs: T0 + 5_000, memberKeys: ['b1'] })
    const s = rose([P, Q])
    expect(stepReonset(s, [ev(), b], [P, Q], T0 + 61_000)?.eventId).toBe('evt-2')
    stepReonset(s, [ev(), b], [], T0 + 70_000)
    // 覚えていれば前の立ち上がりは T0+61 秒で、14 秒後の上がりは同じ揺れの続き。覚えていないと T0+1 秒から 74 秒たった上がりに見える
    expect(stepReonset(s, [ev(), b], [P, Q], T0 + 75_000)).toBeNull()
  })
})

describe('stepReonset: 新しい束（2026-10-29 ユーザー選択「新しい束でも鳴らす (Recommended)」）', () => {
  // 能登付近。b は a から約 30 km、far は約 400 km 離れている
  const a = (confidence: EnsembleDetection['confidence'] = 'confirmed') =>
    fakeEnsembleDetection({ id: 'a', confidence, epicenter: [37.5, 137.2], memberKeys: ['a1', 'a2'] })
  const b = (confidence: EnsembleDetection['confidence'] = 'confirmed') =>
    fakeEnsembleDetection({ id: 'b', confidence, epicenter: [37.3, 137.0], memberKeys: ['b1', 'b2'] })
  const far = fakeEnsembleDetection({ id: 'far', confidence: 'confirmed', epicenter: [34.0, 136.0], memberKeys: ['f1'] })

  it('正: 近くの確かな束が REONSET_SETTLED_MS 以上続く最中に、別の束が確かな段になれば合図を出す', () => {
    const s = createReonsetState()
    stepReonset(s, [a()], [], T0)
    const t = T0 + REONSET_SETTLED_MS
    expect(stepReonset(s, [a(), b('likely')], [], t - 1000)).toBeNull()
    expect(stepReonset(s, [a(), b()], [], t)).toEqual({ eventId: 'b', atMs: t, keys: ['b1', 'b2'] })
  })

  it('対照: 続いている束が確かな段になってから REONSET_SETTLED_MS に届かなければ出さない', () => {
    const s = createReonsetState()
    stepReonset(s, [a()], [], T0)
    expect(stepReonset(s, [a(), b()], [], T0 + REONSET_SETTLED_MS - 1000)).toBeNull()
  })

  it('対照: 続いている束から REONSET_NEARBY_KM より離れた束では出さない（別地点の発報が受け持つ）', () => {
    const s = createReonsetState()
    stepReonset(s, [a()], [], T0)
    expect(stepReonset(s, [a(), far], [], T0 + REONSET_SETTLED_MS)).toBeNull()
  })

  it('対照: 続いている束が早い段のままなら出さない', () => {
    const s = createReonsetState()
    stepReonset(s, [a('likely')], [], T0)
    expect(stepReonset(s, [a('likely'), b()], [], T0 + REONSET_SETTLED_MS)).toBeNull()
  })

  it('安全弁: 新しい束が確かな段のまま続いても、合図は確かな段になったときの 1 回だけ', () => {
    const s = createReonsetState()
    stepReonset(s, [a()], [], T0)
    expect(stepReonset(s, [a(), b()], [], T0 + REONSET_SETTLED_MS)).not.toBeNull()
    expect(stepReonset(s, [a(), b()], [], T0 + REONSET_SETTLED_MS + 1000)).toBeNull()
  })

  describe('同じ地震の波（2026-10-29 ユーザー選択「同じ地震の波を速さで外す」）', () => {
    // a の約 233 km 南。a の揺れ始め T0 から c の揺れ始めまでの時間で、見かけの速さが決まる
    const c = (originTimeMs: number) =>
      fakeEnsembleDetection({ id: 'c', confidence: 'confirmed', epicenter: [35.4, 137.2], memberKeys: ['c1'], originTimeMs })
    const aAt = () => fakeEnsembleDetection({ id: 'a', confidence: 'confirmed', epicenter: [37.5, 137.2], memberKeys: ['a1', 'a2'], originTimeMs: T0 })

    it('対照: 見かけの速さが地震の波の速さ（約 3.9 km/s）なら、同じ地震の揺れが届いただけとみなして出さない', () => {
      const s = createReonsetState()
      stepReonset(s, [aAt()], [], T0)
      expect(stepReonset(s, [aAt(), c(T0 + 60_000)], [], T0 + REONSET_SETTLED_MS)).toBeNull()
    })

    it('正: 見かけの速さが地震の波より遅い（約 1.2 km/s）なら、別の地震として出す', () => {
      const s = createReonsetState()
      stepReonset(s, [aAt()], [], T0)
      const t = T0 + 200_000
      expect(stepReonset(s, [aAt(), c(t - 1000)], [], t)).toEqual({ eventId: 'c', atMs: t, keys: ['c1'] })
    })

    it('安全弁: 見かけの速さが地震の波より速い（約 11.6 km/s）なら、同じ地震の波とはみなさず出す', () => {
      const s = createReonsetState()
      stepReonset(s, [aAt()], [], T0)
      expect(stepReonset(s, [aAt(), c(T0 + 20_000)], [], T0 + REONSET_SETTLED_MS)).not.toBeNull()
    })
  })

  it('安全弁: 同じフレームで確かな段になった束どうしは、互いを続いている束とみなさない', () => {
    const s = createReonsetState()
    stepReonset(s, [a('likely'), b('likely')], [], T0)
    expect(stepReonset(s, [a(), b()], [], T0 + REONSET_SETTLED_MS)).toBeNull()
  })
})
