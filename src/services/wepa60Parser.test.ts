import { describe, expect, it } from 'vitest'
import { parseWepa60Text, parseWepaTime, wepa60FailureReason, wepa60Id } from './wepa60Parser'

// 自作の文（実電文の行の並びに倣った。テストボタンの synthetic/wepa60-talaud.txt と同じ地震）
const BULLETIN = `WEPA60 RJTD 211247
TSUNAMI BULLETIN NUMBER 001
   ISSUED BY NWPTAC(JMA)
   ISSUED AT 1247Z 21 JAN 2021

HYPOCENTRAL PARAMETERS
ORIGIN TIME:1223Z 21 JAN 2021
PRELIMINARY EPICENTER:LAT4.8NORTH LON127.4EAST
 TALAUD ISLANDS, INDONESIA
MAG:7.0

EVALUATION
 NO DESTRUCTIVE TSUNAMI IS EXPECTED FROM THIS EARTHQUAKE.

=
`

// 自作の文（通信試験の題名と行の並びに倣った）
const COMM_TEST = [
  'WEPA60 RJTD 010300',
  'NWPTA COMMUNICATIONS TEST',
  '   ISSUED BY NWPTAC(JMA)',
  '   ISSUED AT 0300Z 01 MAR 2021',
  '',
  'TEST ONLY.',
  '=',
  '',
].join('\r\n')

describe('parseWepa60Text', () => {
  it('地震の報から題名・発表時刻・発生時刻を読み、本文を最後の = を落として残す', () => {
    const r = parseWepa60Text(BULLETIN)
    expect(r).toEqual({
      id: expect.stringMatching(/^WEPA60:2021-01-21T12:47:00\.000Z:TSUNAMI BULLETIN NUMBER 001:[0-9a-f]{8}$/),
      title: 'TSUNAMI BULLETIN NUMBER 001',
      time: '2021-01-21T12:47:00.000Z',
      originTime: '2021-01-21T12:23:00.000Z',
      isCommunicationsTest: false,
      text: expect.stringContaining('TALAUD ISLANDS, INDONESIA'),
    })
    expect(r!.text.startsWith('WEPA60 RJTD 211247\n')).toBe(true)
    expect(r!.text.endsWith('EXPECTED FROM THIS EARTHQUAKE.')).toBe(true)
  })

  it('通信試験は発生時刻を持たず、試験の印が立つ（改行が CRLF でも読める）', () => {
    const r = parseWepa60Text(COMM_TEST)
    expect(r?.isCommunicationsTest).toBe(true)
    expect(r?.originTime).toBeUndefined()
    expect(r?.time).toBe('2021-03-01T03:00:00.000Z')
    expect(r?.text).not.toContain('\r')
  })

  it('1 行目が WEPA60 でない・発表時刻が読めないなら null', () => {
    expect(parseWepa60Text('<Report/>')).toBeNull()
    expect(parseWepa60Text(BULLETIN.replace('ISSUED AT 1247Z', 'ISSUED AT 1263Z'))).toBeNull()
  })

  // 正: 同じ分・同じ題名でも本文が違えば別の報（後の報を同じ報として捨てない）
  // 対照: 同じ本文なら改行の形が違っても同じ鍵（ライブと取り戻しで 2 度受けても 1 通に畳める）
  it('鍵は本文ごとに違い、同じ本文なら改行の形によらず同じ', () => {
    const a = parseWepa60Text(BULLETIN)!
    const b = parseWepa60Text(BULLETIN.replace('MAG:7.0', 'MAG:7.1'))!
    expect(a.id).not.toBe(b.id)
    expect(parseWepa60Text(BULLETIN.replace(/\n/g, '\r\n'))!.id).toBe(a.id)
    expect(a.id).toBe(wepa60Id(a.time, a.title, a.text))
  })

  // 安全弁: 題名の空白の幅が揺れても通信試験と見分ける
  it('通信試験の題名は空白の幅が違っても見分ける', () => {
    expect(parseWepa60Text(COMM_TEST.replace('NWPTA COMMUNICATIONS TEST', 'NWPTA  COMMUNICATIONS  TEST'))?.isCommunicationsTest).toBe(true)
  })

  it('読めなかった理由を返す（読めた本文には null）', () => {
    expect(wepa60FailureReason('<Report/>')).toContain('WEPA60 で始まりません')
    expect(wepa60FailureReason(BULLETIN.replace('ISSUED AT 1247Z', 'ISSUED AT 1263Z'))).toContain('発表時刻を読めません')
    expect(wepa60FailureReason('WEPA60 RJTD 211247\n\n')).toContain('題名がありません')
    expect(wepa60FailureReason(BULLETIN)).toBeNull()
  })

  it('発生時刻だけ読めなければ、発生時刻を持たずに残りを返す', () => {
    const r = parseWepa60Text(BULLETIN.replace('ORIGIN TIME:1223Z', 'ORIGIN TIME:XXXXZ'))
    expect(r?.title).toBe('TSUNAMI BULLETIN NUMBER 001')
    expect(r?.originTime).toBeUndefined()
  })
})

describe('parseWepaTime', () => {
  it('存在しない日付は弾く', () => {
    expect(parseWepaTime('0000Z 30 FEB 2021')).toBeNull()
    expect(parseWepaTime('1200Z 28 FEB 2021')).toBe('2021-02-28T12:00:00.000Z')
  })
})
