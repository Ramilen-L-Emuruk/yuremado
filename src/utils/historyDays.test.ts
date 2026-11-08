import { describe, expect, it } from 'vitest'
import {
  addDays, addIslandRange, clampPeriodRange, daysBetween, expiredIslandDays, extendMain, holdIslands,
  isEvictedCard, isHistoryCardShown, ISLAND_KEEP_MS, jstDayOf, missingRanges, nextLoadMoreWindow, nextWindowOf, periodDayRange,
  type IslandDays,
} from './historyDays'

const islands = (days: string[], releasedAt: number | null = null): IslandDays => new Map(days.map(d => [d, releasedAt]))

describe('日付の道具', () => {
  it('日本時間で日をずらし、月と年をまたぐ', () => {
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01')
    expect(daysBetween('2026-01-01', '2026-03-31')).toBe(89)
  })
  it('日本時間の 0 時をまたいだ時刻は翌日になる（UTC の日付ではない）', () => {
    // 2026-11-07T15:00Z = 2026-11-08 00:00 JST
    expect(jstDayOf(Date.parse('2026-11-07T15:00:00Z'))).toBe('2026-11-08')
    expect(jstDayOf(Date.parse('2026-11-07T14:59:59Z'))).toBe('2026-11-07')
  })
})

describe('periodDayRange', () => {
  const now = Date.parse('2026-11-08T03:00:00Z') // 12:00 JST
  it('時間で選ぶ期間は、始まりの時刻の日から今日まで', () => {
    expect(periodDayRange({ kind: 'hours', hours: 24 }, now)).toEqual({ from: '2026-11-07', to: '2026-11-08' })
    expect(periodDayRange({ kind: 'hours', hours: 30 * 24 }, now)).toEqual({ from: '2026-10-09', to: '2026-11-08' })
  })
  it('日付の期間はそのまま。未来の終わりは今日で切る', () => {
    expect(periodDayRange({ kind: 'range', from: '2026-01-01', to: '2026-03-31' }, now)).toEqual({ from: '2026-01-01', to: '2026-03-31' })
    expect(periodDayRange({ kind: 'range', from: '2026-11-01', to: '2026-11-30' }, now)).toEqual({ from: '2026-11-01', to: '2026-11-08' })
  })
})

describe('missingRanges', () => {
  const main = { from: '2026-11-01', to: '2026-11-08' }
  it('今日から続く分と期間で読んだ日を除き、新しい側からまとまりで返す', () => {
    const got = missingRanges({ from: '2026-10-20', to: '2026-11-03' }, main, islands(['2026-10-25', '2026-10-26']))
    expect(got).toEqual([
      { from: '2026-10-27', to: '2026-10-31' },
      { from: '2026-10-20', to: '2026-10-24' },
    ])
  })
  it('正: 開いたまま日付が変わっても、今日から続く分の上端より新しい日は足りない日にしない（ライブが届けている）', () => {
    expect(missingRanges({ from: '2026-11-07', to: '2026-11-10' }, main, islands([]))).toEqual([])
  })
  it('対照: 全部読んであれば空', () => {
    expect(missingRanges({ from: '2026-11-02', to: '2026-11-05' }, main, islands([]))).toEqual([])
  })
  it('今日から続く分がまだ無くても、範囲全体を 1 まとまりで返す', () => {
    expect(missingRanges({ from: '2026-01-01', to: '2026-01-03' }, null, islands([]))).toEqual([{ from: '2026-01-01', to: '2026-01-03' }])
  })
})

describe('nextWindowOf', () => {
  it('新しい側の端から、上端の日とその前 windowDays 日まで', () => {
    expect(nextWindowOf({ from: '2026-01-01', to: '2026-03-31' }, 7)).toEqual({ from: '2026-03-24', to: '2026-03-31' })
  })
  it('範囲が窓より短ければ範囲の端で切る', () => {
    expect(nextWindowOf({ from: '2026-03-29', to: '2026-03-31' }, 7)).toEqual({ from: '2026-03-29', to: '2026-03-31' })
  })
})

describe('nextLoadMoreWindow', () => {
  const main = { from: '2026-11-01', to: '2026-11-08' }
  it('今日から続く分の一番古い日の前から、窓 1 つぶん（もっと見るの今までの窓と同じ 8 日）', () => {
    expect(nextLoadMoreWindow(main, '2026-11-08', islands([]), 7)).toEqual({ promote: [], window: { from: '2026-10-24', to: '2026-10-31' } })
  })
  it('起動時の履歴が無ければ、起動時と同じ窓を読み直す', () => {
    expect(nextLoadMoreWindow(null, '2026-11-08', islands([]), 7)).toEqual({ promote: [], window: { from: '2026-11-01', to: '2026-11-08' } })
  })
  it('すぐ下を期間で読んであれば、読み直さずに今日から続く分へ入れ、その先から読む', () => {
    const got = nextLoadMoreWindow(main, '2026-11-08', islands(['2026-10-31', '2026-10-30']), 7)
    expect(got.promote).toEqual(['2026-10-31', '2026-10-30'])
    expect(got.window).toEqual({ from: '2026-10-22', to: '2026-10-29' })
  })
  it('窓の途中に期間で読んだ日があれば、その手前で切る（同じ日を二度読まない）', () => {
    const got = nextLoadMoreWindow(main, '2026-11-08', islands(['2026-10-27']), 7)
    expect(got).toEqual({ promote: [], window: { from: '2026-10-28', to: '2026-10-31' } })
  })
})

describe('extendMain', () => {
  const main = { from: '2026-11-01', to: '2026-11-08' }
  it('接していれば古い側へ伸ばす', () => {
    expect(extendMain(main, { from: '2026-10-24', to: '2026-10-31' })).toEqual({ from: '2026-10-24', to: '2026-11-08' })
  })
  it('安全弁: 間に読めていない日があれば伸ばさない（飛び地を今日から続く分にしない）', () => {
    expect(extendMain(main, { from: '2026-10-20', to: '2026-10-29' })).toEqual(main)
  })
  it('まだ無ければ、読んだ範囲がそのまま今日から続く分になる', () => {
    expect(extendMain(null, { from: '2026-11-01', to: '2026-11-08' })).toEqual({ from: '2026-11-01', to: '2026-11-08' })
  })
})

describe('期間で読んだ日の持ち方と捨て方', () => {
  const main = { from: '2026-11-01', to: '2026-11-08' }
  const t0 = Date.parse('2026-11-08T00:00:00Z')
  it('足した日はいまの期間の日（外れた時刻なし）。今日から続く分の日は足さない', () => {
    const got = addIslandRange(new Map(), { from: '2026-10-30', to: '2026-11-02' }, main)
    expect([...got.entries()]).toEqual([['2026-10-30', null], ['2026-10-31', null]])
  })
  it('期間を外すと外れた時刻を付け、3 日たったら捨てる', () => {
    const held = holdIslands(islands(['2026-01-01', '2026-01-02']), null, t0)
    expect(expiredIslandDays(held, t0 + ISLAND_KEEP_MS - 1, ISLAND_KEEP_MS)).toEqual([])
    expect(expiredIslandDays(held, t0 + ISLAND_KEEP_MS, ISLAND_KEEP_MS)).toEqual(['2026-01-01', '2026-01-02'])
  })
  it('選び直した期間に入る日は、外れた時刻を消して持ち続ける', () => {
    const released = holdIslands(islands(['2026-01-01', '2026-01-02']), null, t0)
    const again = holdIslands(released, { from: '2026-01-02', to: '2026-01-31' }, t0 + 1000)
    expect(again.get('2026-01-02')).toBeNull()
    expect(again.get('2026-01-01')).toBe(t0)
  })
  it('既に外れていた日は、外れた時刻を後ろへずらさない（選び直すたびに延びない）', () => {
    const released = holdIslands(islands(['2026-01-01']), null, t0)
    expect(holdIslands(released, { from: '2026-05-01', to: '2026-05-31' }, t0 + 5000).get('2026-01-01')).toBe(t0)
  })
  it('何も変わらなければ同じ Map を返す（描き直しを起こさない）', () => {
    const m = islands(['2026-01-01'])
    expect(holdIslands(m, { from: '2026-01-01', to: '2026-01-31' }, t0)).toBe(m)
  })
})

describe('isHistoryCardShown', () => {
  const d = (origin: string | null, newest: string | null) => ({ origin, newest })
  const isl = islands(['2026-01-14', '2026-01-15', '2026-01-16'])
  it('最新の報の日が今日から続く分なら出す', () => {
    expect(isHistoryCardShown(d('2026-11-03', '2026-11-03'), '2026-11-01', null, isl)).toBe(true)
  })
  it('正: 前の日の深夜に発生し、報が今日から続く分の日に届いた地震も出す（窓の端で落とさない）', () => {
    expect(isHistoryCardShown(d('2026-10-31', '2026-11-01'), '2026-11-01', null, isl)).toBe(true)
  })
  it('期間で読んだ日の地震は、いまの期間に発生時刻が入るときだけ出す', () => {
    expect(isHistoryCardShown(d('2026-01-15', '2026-01-15'), '2026-11-01', null, isl)).toBe(false)
    expect(isHistoryCardShown(d('2026-01-15', '2026-01-15'), '2026-11-01', { from: '2026-01-01', to: '2026-03-31' }, isl)).toBe(true)
    expect(isHistoryCardShown(d('2026-01-15', '2026-01-15'), '2026-11-01', { from: '2026-02-01', to: '2026-03-31' }, isl)).toBe(false)
  })
  it('正: 期間で読んだ日の前の日に発生し、期間で読んだ日に報が届いた地震も隠す（窓の端で拾った地震を残さない）', () => {
    expect(isHistoryCardShown(d('2026-01-13', '2026-01-14'), '2026-11-01', null, isl)).toBe(false)
  })
  it('安全弁: 期間で読んだ日に関わらない古い地震（保存してあった報など）は触らない', () => {
    expect(isHistoryCardShown(d('2026-03-26', '2026-03-26'), '2026-11-01', null, isl)).toBe(true)
  })
  it('時刻を読めない地震は出す（絞りの外で黙って消さない）', () => {
    expect(isHistoryCardShown(d(null, null), '2026-11-01', null, isl)).toBe(true)
  })
})

describe('isEvictedCard', () => {
  const drop = new Set(['2026-01-15'])
  it('捨てる日に発生し、今日から続く分に報が無い地震を外す', () => {
    expect(isEvictedCard({ origin: '2026-01-15', newest: '2026-01-16' }, '2026-11-01', drop)).toBe(true)
  })
  it('捨てる日に報が届いた（前の日に発生した）地震も外す', () => {
    expect(isEvictedCard({ origin: '2026-01-14', newest: '2026-01-15' }, '2026-11-01', drop)).toBe(true)
  })
  it('安全弁: 今日から続く分の日に報が届いている地震は外さない', () => {
    expect(isEvictedCard({ origin: '2026-01-15', newest: '2026-11-02' }, '2026-11-01', drop)).toBe(false)
  })
  it('対照: 捨てない日の地震は外さない', () => {
    expect(isEvictedCard({ origin: '2026-01-13', newest: '2026-01-13' }, '2026-11-01', drop)).toBe(false)
  })
  it('安全弁: 最新の報の時刻を読めない地震は外さない（黙って消さない）', () => {
    expect(isEvictedCard({ origin: '2026-01-15', newest: null }, '2026-11-01', drop)).toBe(false)
  })
})

describe('clampPeriodRange', () => {
  const today = '2026-11-08'
  it('90 日（両端を含む）までならそのまま', () => {
    expect(clampPeriodRange('2026-01-01', '2026-03-31', 'to', today)).toEqual({ from: '2026-01-01', to: '2026-03-31', clampedByLength: false })
  })
  it('超えたら打った欄はそのまま、反対の欄を 90 日の内へ寄せる', () => {
    expect(clampPeriodRange('2026-01-01', '2026-04-01', 'to', today)).toEqual({ from: '2026-01-02', to: '2026-04-01', clampedByLength: true })
    expect(clampPeriodRange('2026-01-01', '2026-06-30', 'from', today)).toEqual({ from: '2026-01-01', to: '2026-03-31', clampedByLength: true })
  })
  it('寄せた先は今日より後にしない', () => {
    expect(clampPeriodRange('2026-09-01', '2026-12-31', 'from', today).to).toBe('2026-11-08')
  })
  it('安全弁: 日付として読めない値は寄せずにそのまま返す（投げない）', () => {
    expect(clampPeriodRange('', '2026-04-01', 'to', today)).toEqual({ from: '', to: '2026-04-01', clampedByLength: false })
  })
  it('前後が逆なら、今までどおり反対の欄を同じ日へ寄せる（長さの注記は出さない）', () => {
    expect(clampPeriodRange('2026-05-01', '2026-04-01', 'from', today)).toEqual({ from: '2026-05-01', to: '2026-05-01', clampedByLength: false })
    expect(clampPeriodRange('2026-05-01', '2026-04-01', 'to', today)).toEqual({ from: '2026-04-01', to: '2026-04-01', clampedByLength: false })
  })
})
