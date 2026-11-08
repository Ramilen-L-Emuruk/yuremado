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
 THERE IS NO POSSIBILITY OF A TSUNAMI

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
  it('地震の報から題名・発表時刻・発生時刻を読み、本文を終わりの印 = まで残す', () => {
    const r = parseWepa60Text(BULLETIN)
    expect(r).toEqual({
      id: expect.stringMatching(/^WEPA60:2021-01-21T12:47:00\.000Z:TSUNAMI BULLETIN NUMBER 001:[0-9a-f]{8}$/),
      title: 'TSUNAMI BULLETIN NUMBER 001',
      time: '2021-01-21T12:47:00.000Z',
      originTime: '2021-01-21T12:23:00.000Z',
      isCommunicationsTest: false,
      text: expect.stringContaining('TALAUD ISLANDS, INDONESIA'),
      epicenter: { latitude: 4.8, longitude: 127.4 },
      regionName: 'TALAUD ISLANDS, INDONESIA',
      magnitude: 7.0,
      bulletinNumber: 1,
      evaluation: 'none',
    })
    expect(r!.text.startsWith('WEPA60 RJTD 211247\n')).toBe(true)
    expect(r!.text.endsWith('THERE IS NO POSSIBILITY OF A TSUNAMI\n\n=')).toBe(true)
  })

  // 全期間の控え 181 通で、終わりの印 = の後ろに付いていた形: 制御文字 ETX だけの行（2024-05 以降の 92 通すべて）と、
  // 発表時刻と同じ ISO 8601 の時刻（2021-07〜2024-04 の 73 通）。どちらも画面に出すと化けて見える
  it('正: = の後ろの制御文字 ETX と ISO の時刻を本文から落とす', () => {
    const etx = parseWepa60Text(`${BULLETIN}\x03`)!
    expect(etx.text.endsWith('TSUNAMI\n\n=')).toBe(true)
    const stamped = parseWepa60Text(`${BULLETIN}\x03\n\n2021-01-21T12:47:00.000Z`)!
    expect(stamped.text.endsWith('TSUNAMI\n\n=')).toBe(true)
    expect(parseWepa60Text(`${BULLETIN}\n2021-01-21T12:47:00.000Z`)!.text.endsWith('TSUNAMI\n\n=')).toBe(true)
  })

  // 対照: 後ろに付くものが違っても本文は同じなので、同じ報として 1 通に畳める
  it('対照: = の後ろの形が違っても鍵は同じ', () => {
    const plain = parseWepa60Text(BULLETIN)!
    expect(parseWepa60Text(`${BULLETIN}\x03`)!.id).toBe(plain.id)
    expect(parseWepa60Text(`${BULLETIN}\x03\n\n2021-01-21T12:47:00.000Z`)!.id).toBe(plain.id)
  })

  // 安全弁: 最後の行の末尾に付く = （通信試験の報の …GO.JP= の形。値は架空）と、本文の行は落とさない
  it('安全弁: 行の末尾の = と、時刻だけではない最後の行は残す', () => {
    const tail = parseWepa60Text(COMM_TEST.replace('TEST ONLY.\r\n=', 'TEST_ONLY.EXAMPLE.INVALID=\r\n\x03'))!
    expect(tail.text.endsWith('TEST_ONLY.EXAMPLE.INVALID=')).toBe(true)
    const noMark = parseWepa60Text(BULLETIN.replace('\n=\n', '\nRECEIVED AT 2021-01-21T12:47:00.000Z\n'))!
    expect(noMark.text.endsWith('RECEIVED AT 2021-01-21T12:47:00.000Z')).toBe(true)
  })

  // 実電文の書式（全期間の控えの地震の報 163 通）: 南緯・西経は SOUTH・WEST、規模の種類は (MJMA)・(MW)、深さは FOCAL DEPTH の行で
  // 規模と同じ行に書かれることがある
  it('南緯・西経・規模の種類・深さ（規模と同じ行）を読む', () => {
    const r = parseWepa60Text(BULLETIN
      .replace('PRELIMINARY EPICENTER:LAT4.8NORTH LON127.4EAST', 'PRELIMINARY EPICENTER:LAT15.2SOUTH LON173.1WEST')
      .replace('MAG:7.0', 'FOCAL DEPTH:139KM MAG:7.3 (MW)'))
    expect(r).toMatchObject({ epicenter: { latitude: -15.2, longitude: -173.1 }, magnitude: 7.3, magnitudeType: 'Mw', depthKm: 139 })
    expect(parseWepa60Text(BULLETIN.replace('MAG:7.0', 'MAG:6.9 (MJMA)'))?.magnitudeType).toBe('Mj')
  })

  // 安全弁: 震源の値が無い報（通信試験）は、値を持たない
  it('震源の値が無い報は震央・地名・規模を持たない', () => {
    const r = parseWepa60Text(COMM_TEST)
    expect(r?.epicenter).toBeUndefined()
    expect(r?.regionName).toBeUndefined()
    expect(r?.magnitude).toBeUndefined()
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

  it('題名の番号と、評価の 5 種を読む（2 行に折れた文も 1 文として読む）', () => {
    const withEval = (lines: string) => parseWepa60Text(BULLETIN.replace(' THERE IS NO POSSIBILITY OF A TSUNAMI', lines))
    expect(parseWepa60Text(BULLETIN)).toMatchObject({ bulletinNumber: 1, evaluation: 'none' })
    expect(withEval(' THERE IS A POSSIBILITY OF A DESTRUCTIVE OCEAN-WIDE TSUNAMI')?.evaluation).toBe('oceanWide')
    expect(withEval(' THERE IS A POSSIBILITY OF A DESTRUCTIVE REGIONAL TSUNAMI')?.evaluation).toBe('regional')
    expect(withEval(' THERE IS A POSSIBILITY OF A DESTRUCTIVE LOCAL TSUNAMI\n NEAR THE EPICENTER')?.evaluation).toBe('localNearEpicenter')
    expect(withEval(' THERE IS A VERY SMALL POSSIBILITY OF A DESTRUCTIVE LOCAL\n TSUNAMI')?.evaluation).toBe('verySmall')
    expect(parseWepa60Text(BULLETIN.replace('NUMBER 001', 'NUMBER 003'))?.bulletinNumber).toBe(3)
  })

  it('5 種のどれでもない評価文は持たない（似た文を言い換えて当てない）', () => {
    const r = parseWepa60Text(BULLETIN.replace(' THERE IS NO POSSIBILITY OF A TSUNAMI', ' NO DESTRUCTIVE TSUNAMI IS EXPECTED.'))
    expect(r?.evaluation).toBeUndefined()
    expect(parseWepa60Text(COMM_TEST)).toMatchObject({ isCommunicationsTest: true })
    expect(parseWepa60Text(COMM_TEST)?.evaluation).toBeUndefined()
    expect(parseWepa60Text(COMM_TEST)?.bulletinNumber).toBeUndefined()
  })
})

describe('parseWepaTime', () => {
  it('存在しない日付は弾く', () => {
    expect(parseWepaTime('0000Z 30 FEB 2021')).toBeNull()
    expect(parseWepaTime('1200Z 28 FEB 2021')).toBe('2021-02-28T12:00:00.000Z')
  })
})
