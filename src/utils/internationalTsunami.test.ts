import { describe, expect, it } from 'vitest'
import type { JMAInternationalTsunami, JMAQuake } from '../types/earthquake'
import { ORIGIN_MATCH_TOLERANCE_MS, internationalTsunamisFor, unattachedInternationalTsunamis, upsertInternationalTsunami } from './internationalTsunami'

// 結び付けが見るのは種別と発生時刻だけなので、その 2 つだけを持つ地震で足りる
const quake = (type: string, time: string): JMAQuake =>
  ({ issue: { type }, earthquake: { time } }) as unknown as JMAQuake

const bulletin = (over: Partial<JMAInternationalTsunami> = {}): JMAInternationalTsunami => ({
  id: 'WEPA60:2021-01-21T12:47:00.000Z:TSUNAMI BULLETIN NUMBER 001',
  title: 'TSUNAMI BULLETIN NUMBER 001',
  time: '2021-01-21T12:47:00.000Z',
  originTime: '2021-01-21T12:23:00.000Z',
  isCommunicationsTest: false,
  text: 'WEPA60 RJTD 211247',
  ...over,
})

const FOREIGN = quake('遠地地震', '2021-01-21T12:23:41.000Z')

describe('internationalTsunamisFor', () => {
  it('遠地地震のカードに、発生時刻が許すずれの内にある報を付ける', () => {
    const list = [bulletin()]
    expect(internationalTsunamisFor(FOREIGN, list)).toEqual(list)
  })

  it('許すずれの境目ちょうどは付け、1 ミリ秒外は付けない', () => {
    const at = (deltaMs: number) => bulletin({
      originTime: new Date(Date.parse(FOREIGN.earthquake.time) + deltaMs).toISOString(),
    })
    expect(internationalTsunamisFor(FOREIGN, [at(-ORIGIN_MATCH_TOLERANCE_MS)])).toHaveLength(1)
    expect(internationalTsunamisFor(FOREIGN, [at(-ORIGIN_MATCH_TOLERANCE_MS - 1)])).toHaveLength(0)
  })

  it('国内の地震のカード・通信試験・発生時刻の無い報には付けない', () => {
    expect(internationalTsunamisFor(quake('震源・震度情報', FOREIGN.earthquake.time), [bulletin()])).toHaveLength(0)
    expect(internationalTsunamisFor(FOREIGN, [bulletin({ isCommunicationsTest: true })])).toHaveLength(0)
    expect(internationalTsunamisFor(FOREIGN, [bulletin({ originTime: undefined })])).toHaveLength(0)
  })

  it('付かないときは毎回同じ空の配列を返す（カードの memo を素通りさせない）', () => {
    const a = internationalTsunamisFor(FOREIGN, [])
    const b = internationalTsunamisFor(quake('震源・震度情報', FOREIGN.earthquake.time), [bulletin()])
    expect(a).toBe(b)
  })
})

describe('upsertInternationalTsunami', () => {
  it('同じ id の報は足さず null を返し、別の報は発表時刻の古い順に並べる', () => {
    const later = bulletin({ id: 'b', time: '2021-01-21T13:30:00.000Z' })
    const first = bulletin()
    const list = upsertInternationalTsunami([later], first)
    expect(list?.map(x => x.id)).toEqual([first.id, 'b'])
    expect(upsertInternationalTsunami(list!, first)).toBeNull()
  })
})

// 付く先の無い報を拾う（記録に残すため）。
//   正  : 遠地地震のカードが無ければ拾う／対照: 付くカードがあれば拾わない／安全弁: 通信試験は拾わない
describe('unattachedInternationalTsunamis', () => {
  it('付く遠地地震のカードが無い報だけを返し、通信試験は返さない', () => {
    const b = bulletin({})
    const test = bulletin({ id: 't', isCommunicationsTest: true, originTime: undefined })
    expect(unattachedInternationalTsunamis([], [b, test]).map(x => x.id)).toEqual([b.id])
    expect(unattachedInternationalTsunamis([FOREIGN], [b, test])).toEqual([])
  })
})
