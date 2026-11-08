import { describe, expect, it } from 'vitest'
import { nearestTsunamiStation } from './wepa60RegionNames'

// 座標は手で置いた見本（実在の観測点の座標ではない）
const COORDS = {
  東の港: [40.0, 142.0],
  西の港: [40.0, 141.92],
  遠い港: [41.0, 142.0],
} as Record<string, [number, number]>

describe('nearestTsunamiStation', () => {
  // 正: 10km 以内の候補が 1 つなら、その名前を曖昧でないとして返す
  it('候補が 1 つなら曖昧でない', () => {
    expect(nearestTsunamiStation(COORDS, 41.0, 142.02)).toEqual({ name: '遠い港', ambiguous: false })
  })

  // 正: 10km 以内に候補が 2 つあれば、近い方を返して曖昧の印を立てる
  it('候補が 2 つなら近い方を返し、曖昧の印を立てる', () => {
    expect(nearestTsunamiStation(COORDS, 40.0, 141.99)).toEqual({ name: '東の港', ambiguous: true })
  })

  // 安全弁: 同じ距離の候補が並んだら、表で先に出てくる方に決まる（入れ替わらない）
  it('同じ距離なら表の先の方を返す', () => {
    const tie = { 先の港: [40.0, 142.0], 後の港: [40.0, 142.0] } as Record<string, [number, number]>
    expect(nearestTsunamiStation(tie, 40.0, 142.0)).toEqual({ name: '先の港', ambiguous: true })
  })

  // 対照: 10km より遠ければ引かない
  it('10km より遠ければ引かない', () => {
    expect(nearestTsunamiStation(COORDS, 39.5, 142.0)).toBeUndefined()
  })
})
