import { describe, it, expect } from 'vitest'
import { resolveDays } from './eval-kyoshin-continuous'

const TODAY = '20261031'

describe('resolveDays', () => {
  it('--from〜--to を昇順の日へ展開し、--days は重複を除いて並べる', () => {
    expect(resolveDays(undefined, '20261026', '20261028', TODAY, 31)).toEqual(['20261026', '20261027', '20261028'])
    expect(resolveDays('20261020,20210108,20261020', undefined, undefined, TODAY, 31)).toEqual(['20210108', '20261020'])
  })

  it('実在しない日は弾く（繰り上がって別の日になる値を通さない）', () => {
    expect(() => resolveDays('20260230', undefined, undefined, TODAY, 31)).toThrow(/実在/)
    expect(() => resolveDays(undefined, '20261301', '20261302', TODAY, 31)).toThrow(/実在/)
  })

  it('今日以降の日は弾き、昨日までは通す（震源の控えがある日は新しくても流せる。出そろいの判定は取る直前に行う）', () => {
    expect(() => resolveDays('20261031', undefined, undefined, TODAY, 31)).toThrow(/今日/)
    expect(() => resolveDays(undefined, '20261030', '20261101', TODAY, 31)).toThrow(/今日/)
    expect(resolveDays('20261030', undefined, undefined, TODAY, 31)).toEqual(['20261030'])
  })

  it('日数の上限を超えたら弾く', () => {
    expect(() => resolveDays(undefined, '20260901', '20261002', TODAY, 31)).toThrow(/上限/)
    expect(resolveDays(undefined, '20260901', '20261001', TODAY, 31)).toHaveLength(31)
  })
})
