import { describe, it, expect } from 'vitest'
import { decideRipple } from './KyoshinMaxEffectGL'
import type { DetectedPoint } from '../../utils/kyoshinDetectionView'

// 波紋は検知に入った点（検知点バッジと同じ集合）の最大階級が上がったときだけ出す
// （2026-10-22 ユーザー選択「検知に入った点だけにする」）。全観測点の生値は渡ってこないので、
// 検知の外の点がどれだけ跳ねても波紋は出ない —— それは呼び出し側の渡し方が担う。
const pt = (key: string, index: number): DetectedPoint => ({ key, lat: 35, lng: 139, index })

describe('decideRipple', () => {
  it('正: 検知点の最大階級が上がったら、その点で波紋を出す', () => {
    const r = decideRipple([pt('a', 7), pt('b', 11)], -1)
    expect(r.trigger?.point.key).toBe('b')
    expect(r.rank).toBeGreaterThan(0)
  })

  it('対照: 階級が変わらなければ出さない（同じ階級の中でインデックスが上がっても）', () => {
    const first = decideRipple([pt('a', 13)], -1)
    const second = decideRipple([pt('a', 14)], first.rank)   // どちらも震度4
    expect(second.trigger).toBeNull()
  })

  it('対照: 震度0（階級が MIN_TRIGGER_RANK 未満）では出さない', () => {
    expect(decideRipple([pt('a', 6)], -1).trigger).toBeNull()
  })

  it('安全弁: 検知が無くなったら階級を落とし、次の検知では最初の点で出る', () => {
    const first = decideRipple([pt('a', 11)], -1)
    const gone = decideRipple([], first.rank)
    expect(gone.rank).toBe(-1)
    expect(gone.trigger).toBeNull()
    expect(decideRipple([pt('b', 7)], gone.rank).trigger?.point.key).toBe('b')
  })
})
