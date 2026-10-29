import { describe, it, expect } from 'vitest'
import { createReonsetState, stepReonset, REONSET_QUIET_MS, REONSET_MIN_POINTS } from './kyoshinReonset'
import type { EnsembleDetection } from './kyoshinEnsembleTracker'
import { fakeEnsembleDetection } from '../test-utils/ensembleDetection'

// 同じ場所の 2 つ目の地震（設計書§40）。2026-10-24 ユーザー選択「60 秒静か・3 点 (Recommended)」

function ev(memberKeys: string[], confidence: EnsembleDetection['confidence'] = 'confirmed'): EnsembleDetection {
  return fakeEnsembleDetection({ id: 'evt-1', confidence, memberKeys, maxIntensity: 2 })
}

const T0 = 1_000_000
const members = ['a', 'b', 'c', 'd', 'e', 'f']

/** 1 つ目の地震の立ち上がり（a,b,c）を見せてから、静けさを quietMs 置いた状態を作る。 */
function settled(quietMs: number) {
  const s = createReonsetState()
  stepReonset(s, [ev(members)], ['a', 'b', 'c'], T0)
  // 立ち上がりは RECENT_ONSET_MS（床の係）で「直近」から外れる。外れた状態を挟む
  stepReonset(s, [ev(members)], [], T0 + 10_000)
  stepReonset(s, [ev(members)], [], T0 + quietMs)
  return s
}

describe('stepReonset', () => {
  it('正: 静けさのあと 3 点がまとまって立ち上がれば合図を出す', () => {
    const s = settled(REONSET_QUIET_MS + 1000)
    const t = T0 + REONSET_QUIET_MS + 2000
    expect(stepReonset(s, [ev(members)], ['d', 'e', 'f'], t)).toEqual({ eventId: 'evt-1', atMs: t, keys: ['d', 'e', 'f'] })
  })

  it('正: 3 秒の内に分かれて立ち上がっても、まとまりとして数える', () => {
    const s = settled(REONSET_QUIET_MS + 1000)
    const t = T0 + REONSET_QUIET_MS + 2000
    expect(stepReonset(s, [ev(members)], ['d'], t)).toBeNull()
    expect(stepReonset(s, [ev(members)], ['d', 'e'], t + 1000)).toBeNull()
    expect(stepReonset(s, [ev(members)], ['d', 'e', 'f'], t + 2000)?.keys).toEqual(['d', 'e', 'f'])
  })

  it('対照: 立ち上がりが REONSET_MIN_POINTS に届かなければ出さない', () => {
    const s = settled(REONSET_QUIET_MS + 1000)
    const keys = ['d', 'e', 'f'].slice(0, REONSET_MIN_POINTS - 1)
    expect(stepReonset(s, [ev(members)], keys, T0 + REONSET_QUIET_MS + 2000)).toBeNull()
  })

  it('対照: 静けさが REONSET_QUIET_MS に届かない立ち上がり（揺れの続き）では出さない', () => {
    const s = createReonsetState()
    stepReonset(s, [ev(members)], ['a'], T0)
    stepReonset(s, [ev(members)], [], T0 + 5000)
    // 最後の立ち上がりから 30 秒（イベントは 70 秒前から）
    stepReonset(s, [ev(members)], ['b'], T0 + 40_000)
    stepReonset(s, [ev(members)], [], T0 + 45_000)
    expect(stepReonset(s, [ev(members)], ['c', 'd', 'e'], T0 + 70_000)).toBeNull()
  })

  it('対照: 確定していないイベントでは出さない', () => {
    const s = createReonsetState()
    stepReonset(s, [ev(members, 'likely')], ['a'], T0)
    stepReonset(s, [ev(members, 'likely')], [], T0 + 10_000)
    expect(stepReonset(s, [ev(members, 'likely')], ['d', 'e', 'f'], T0 + REONSET_QUIET_MS + 2000)).toBeNull()
  })

  it('安全弁: イベントが現れてから REONSET_QUIET_MS の間は出さない（1 つ目の立ち上がりそのもの）', () => {
    const s = createReonsetState()
    expect(stepReonset(s, [ev(members)], ['a', 'b', 'c', 'd'], T0)).toBeNull()
  })

  // 鳴らした時刻はそのまま「最後の立ち上がり」になるので、鳴らした後は静けさの条件で止まる
  it('安全弁: 鳴らした後は、また静けさを挟まないと同じイベントで鳴らさない', () => {
    const s = settled(REONSET_QUIET_MS + 1000)
    const t = T0 + REONSET_QUIET_MS + 2000
    expect(stepReonset(s, [ev(members)], ['d', 'e', 'f'], t)).not.toBeNull()
    // 直後にまた静けさを挟んで 3 点（静けさは 60 秒あるが、鳴らしてから 60 秒経っていない）
    expect(stepReonset(s, [ev(members)], [], t + 10_000)).toBeNull()
    expect(stepReonset(s, [ev(members, 'confirmed')], ['a', 'b', 'c'], t + 30_000)).toBeNull()
  })

  it('安全弁: 同じフレームを二度渡しても同じ結果を返す（StrictMode の二重実行）', () => {
    const s = settled(REONSET_QUIET_MS + 1000)
    const t = T0 + REONSET_QUIET_MS + 2000
    const first = stepReonset(s, [ev(members)], ['d', 'e', 'f'], t)
    expect(first).not.toBeNull()
    expect(stepReonset(s, [ev(members)], ['d', 'e', 'f'], t)).toEqual(first)
  })

  describe('新しい束（2026-10-29 ユーザー選択「新しい束でも鳴らす (Recommended)」）', () => {
    // 能登付近。b は a から約 30 km、far は約 400 km 離れている
    const a = (confidence: EnsembleDetection['confidence'] = 'confirmed') =>
      fakeEnsembleDetection({ id: 'a', confidence, epicenter: [37.5, 137.2], memberKeys: ['a1', 'a2'] })
    const b = (confidence: EnsembleDetection['confidence'] = 'confirmed') =>
      fakeEnsembleDetection({ id: 'b', confidence, epicenter: [37.3, 137.0], memberKeys: ['b1', 'b2'] })
    const far = fakeEnsembleDetection({ id: 'far', confidence: 'confirmed', epicenter: [34.0, 136.0], memberKeys: ['f1'] })

    it('正: 近くの確かな束が REONSET_QUIET_MS 以上続く最中に、別の束が確かな段になれば合図を出す', () => {
      const s = createReonsetState()
      stepReonset(s, [a()], [], T0)
      const t = T0 + REONSET_QUIET_MS
      expect(stepReonset(s, [a(), b('likely')], [], t - 1000)).toBeNull()
      expect(stepReonset(s, [a(), b()], [], t)).toEqual({ eventId: 'b', atMs: t, keys: ['b1', 'b2'] })
    })

    it('対照: 続いている束が確かな段になってから REONSET_QUIET_MS に届かなければ出さない', () => {
      const s = createReonsetState()
      stepReonset(s, [a()], [], T0)
      expect(stepReonset(s, [a(), b()], [], T0 + REONSET_QUIET_MS - 1000)).toBeNull()
    })

    it('対照: 続いている束から REONSET_NEARBY_KM より離れた束では出さない（別地点の発報が受け持つ）', () => {
      const s = createReonsetState()
      stepReonset(s, [a()], [], T0)
      expect(stepReonset(s, [a(), far], [], T0 + REONSET_QUIET_MS)).toBeNull()
    })

    it('対照: 続いている束が早い段のままなら出さない', () => {
      const s = createReonsetState()
      stepReonset(s, [a('likely')], [], T0)
      expect(stepReonset(s, [a('likely'), b()], [], T0 + REONSET_QUIET_MS)).toBeNull()
    })

    it('安全弁: 新しい束が確かな段のまま続いても、合図は確かな段になったときの 1 回だけ', () => {
      const s = createReonsetState()
      stepReonset(s, [a()], [], T0)
      expect(stepReonset(s, [a(), b()], [], T0 + REONSET_QUIET_MS)).not.toBeNull()
      expect(stepReonset(s, [a(), b()], [], T0 + REONSET_QUIET_MS + 1000)).toBeNull()
    })

    describe('同じ地震の波（2026-10-29 ユーザー選択「同じ地震の波を速さで外す」）', () => {
      // a の約 233 km 南。a の揺れ始め T0 から c の揺れ始めまでの時間で、見かけの速さが決まる
      const c = (originTimeMs: number) =>
        fakeEnsembleDetection({ id: 'c', confidence: 'confirmed', epicenter: [35.4, 137.2], memberKeys: ['c1'], originTimeMs })
      const aAt = () => fakeEnsembleDetection({ id: 'a', confidence: 'confirmed', epicenter: [37.5, 137.2], memberKeys: ['a1', 'a2'], originTimeMs: T0 })

      it('対照: 見かけの速さが地震の波の速さ（約 3.9 km/s）なら、同じ地震の揺れが届いただけとみなして出さない', () => {
        const s = createReonsetState()
        stepReonset(s, [aAt()], [], T0)
        expect(stepReonset(s, [aAt(), c(T0 + 60_000)], [], T0 + REONSET_QUIET_MS)).toBeNull()
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
        expect(stepReonset(s, [aAt(), c(T0 + 20_000)], [], T0 + REONSET_QUIET_MS)).not.toBeNull()
      })
    })

    it('安全弁: 同じフレームで確かな段になった束どうしは、互いを続いている束とみなさない', () => {
      const s = createReonsetState()
      stepReonset(s, [a('likely'), b('likely')], [], T0)
      expect(stepReonset(s, [a(), b()], [], T0 + REONSET_QUIET_MS)).toBeNull()
    })
  })

  it('安全弁: データ時刻が巻き戻ったら（リプレイの開始）状態を捨てる', () => {
    const s = settled(REONSET_QUIET_MS + 1000)
    // 巻き戻った先でイベントを初めて見たことにし直す。捨てないと、イベントを初めて見た時刻が
    // 巻き戻る前（未来）のまま残り、いつまで経っても「現れてから 60 秒」を満たさない
    const back = T0 - 1_000_000
    expect(stepReonset(s, [ev(members)], ['a', 'b', 'c'], back)).toBeNull()
    stepReonset(s, [ev(members)], [], back + 10_000)
    expect(stepReonset(s, [ev(members)], ['d', 'e', 'f'], back + REONSET_QUIET_MS + 2000)).not.toBeNull()
  })
})
