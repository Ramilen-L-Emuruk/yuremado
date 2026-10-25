import { describe, it, expect } from 'vitest'
import { mapDataFailureText } from './mapDataStatusText'

describe('地図のデータが欠けたときの 1 行', () => {
  it('欠けが無ければ出さない', () => {
    expect(mapDataFailureText([])).toBeNull()
  })

  it('取り直している間は名前と「取り直しています」', () => {
    expect(mapDataFailureText([
      { label: 'prefectures', state: 'retrying' },
      { label: 'active-faults', state: 'retrying' },
    ])).toBe('県境・活断層を取り込めず（取り直しています）')
  })

  it('諦めた後は「再読み込みで取得し直します」', () => {
    expect(mapDataFailureText([{ label: 'prefectures', state: 'gaveUp' }])).toBe('県境を取り込めず（再読み込みで取得し直します）')
  })

  // 待っても戻らないものが混ざっているのに「取り直しています」と出さない
  it('1 つでも諦めたものがあれば再読み込みを促す', () => {
    expect(mapDataFailureText([
      { label: 'prefectures', state: 'retrying' },
      { label: 'active-faults', state: 'gaveUp' },
    ])).toBe('県境・活断層を取り込めず（再読み込みで取得し直します）')
  })

  it('名前は 3 つまで並べ、残りは「ほかN件」', () => {
    expect(mapDataFailureText([
      { label: 'prefectures', state: 'retrying' },
      { label: 'subregions', state: 'retrying' },
      { label: 'station-coords', state: 'retrying' },
      { label: 'tsunami-zones', state: 'retrying' },
      { label: 'active-faults', state: 'retrying' },
    ])).toBe('県境・区域の境界・観測点の位置ほか2件を取り込めず（取り直しています）')
  })

  // 安全弁: 取得の名前（英字）をそのまま画面に出さない
  it('表に無い名前は「地図のデータ」にまとめる', () => {
    expect(mapDataFailureText([
      { label: 'something-new', state: 'retrying' },
      { label: 'another-new', state: 'retrying' },
    ])).toBe('地図のデータを取り込めず（取り直しています）')
  })
})
