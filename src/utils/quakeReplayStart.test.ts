import { describe, expect, it } from 'vitest'
import type { IssueType, JMAQuake } from '../types/earthquake'
import { QUAKE_MINUTE_LEAD_MS, ORIGIN_MINUTE_MARGIN_MS } from './quakeOriginSeconds'
import { QUAKE_REPLAY_LEAD_MS, hasDomesticQuakeReport, quakeReplayStartMs } from './quakeReplayStart'

type Q = Pick<JMAQuake, 'earthquake' | 'reports' | 'issue'>

const quakeOf = (time: string, originTime?: string, types: IssueType[] = ['震源・震度情報']): Q => ({
  earthquake: { time, ...(originTime !== undefined ? { originTime } : {}) },
  reports: types.map((type) => ({ type, keys: [type] })),
  issue: { type: types[types.length - 1] },
} as Q)

/** 最初の報の発表時刻（国内の報を持つカードでは使われないことを確かめるため、わざと地震から離した値） */
const FIRST_REPORT = Date.parse('2024-01-01T16:40:00+09:00')

describe('quakeReplayStartMs', () => {
  it('正: 秒まで決まった発生時刻があれば、その 30 秒前から始める', () => {
    const origin = Date.parse('2024-01-01T16:10:09.500+09:00')
    const start = quakeReplayStartMs(quakeOf('2024-01-01T16:10:00+09:00', '2024-01-01T16:10:00+09:00'), { originMs: origin, source: 'eew' }, FIRST_REPORT)
    expect(start).toBe(origin - QUAKE_REPLAY_LEAD_MS)
  })

  it('対照: 秒が決まらなければ、発生が入りうる最も早い時刻（発生時刻の分の頭の 5 秒前と、発現の分の頭の 30 秒前の早いほう）の 30 秒前', () => {
    // 発現の分（16:11）より発生時刻の分（16:10）のほうが早い地震（深い・遠い地震の形）
    const start = quakeReplayStartMs(quakeOf('2024-01-01T16:11:00+09:00', '2024-01-01T16:10:00+09:00'), undefined, FIRST_REPORT)
    const earliest = Date.parse('2024-01-01T16:10:00+09:00') - ORIGIN_MINUTE_MARGIN_MS
    expect(start).toBe(earliest - QUAKE_REPLAY_LEAD_MS)
  })

  it('対照: 発生時刻を持たない震度速報だけのカードは、検知の分の頭の 30 秒前を最も早い時刻にする', () => {
    const start = quakeReplayStartMs(quakeOf('2024-01-01T16:10:00+09:00', undefined, ['震度速報']), undefined, FIRST_REPORT)
    expect(start).toBe(Date.parse('2024-01-01T16:10:00+09:00') - QUAKE_MINUTE_LEAD_MS - QUAKE_REPLAY_LEAD_MS)
  })

  it('正: 国内の報を持たない遠地地震のカードは、発生ではなく最初の報の 30 秒前から始める', () => {
    const origin = Date.parse('2024-01-01T15:50:00+09:00')
    const start = quakeReplayStartMs(quakeOf('2024-01-01T15:50:00+09:00', '2024-01-01T15:50:00+09:00', ['遠地地震']), { originMs: origin, source: 'catalog' }, FIRST_REPORT)
    expect(start).toBe(FIRST_REPORT - QUAKE_REPLAY_LEAD_MS)
  })

  it('対照: 遠地地震の報の後に国内の報も届いたカードは、地震の 30 秒前から始める', () => {
    const start = quakeReplayStartMs(quakeOf('2024-01-01T16:10:00+09:00', undefined, ['遠地地震', '震度速報']), undefined, FIRST_REPORT)
    expect(start).toBe(Date.parse('2024-01-01T16:10:00+09:00') - QUAKE_MINUTE_LEAD_MS - QUAKE_REPLAY_LEAD_MS)
  })

  it('安全弁: 秒の値が読めない数なら使わず、電文の時刻へ戻る', () => {
    const start = quakeReplayStartMs(quakeOf('2024-01-01T16:10:00+09:00', undefined, ['震度速報']), { originMs: Number.NaN, source: 'catalog' }, FIRST_REPORT)
    expect(start).toBe(Date.parse('2024-01-01T16:10:00+09:00') - QUAKE_MINUTE_LEAD_MS - QUAKE_REPLAY_LEAD_MS)
  })

  it('安全弁: どの時刻も読めなければ NaN（再生しない）。国内の報が無く最初の報の時刻も無いときも同じ', () => {
    expect(quakeReplayStartMs(quakeOf('読めない時刻'), undefined, FIRST_REPORT)).toBeNaN()
    expect(quakeReplayStartMs(quakeOf('2024-01-01T15:50:00+09:00', undefined, ['遠地地震']), undefined, null)).toBeNaN()
  })
})

describe('hasDomesticQuakeReport', () => {
  it('種別の記録が無いカードは、最後の報の種別で見る', () => {
    expect(hasDomesticQuakeReport({ issue: { type: '遠地地震' } } as Q)).toBe(false)
    expect(hasDomesticQuakeReport({ issue: { type: '震度速報' } } as Q)).toBe(true)
  })
})
