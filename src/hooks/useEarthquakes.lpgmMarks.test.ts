// 長周期地震動の報を 1 通当てたときの印（`applyLiveLpgmWithMarks`）。
//
// **キュー経路と DMDSS 版の WebSocket 経路が同じ関数を通る。** WebSocket 経路だけ
// `applyLiveLpgm` しか呼んでいなかった頃は、DMDSS 版のライブで長周期の一覧に印が付かなかった
// （キュー経路を通るテスト・リプレイでは付くので、実機でしか見えない）。
import { describe, it, expect } from 'vitest'
import { muteConsoleError } from '../test-utils/muteConsoleError'
import { applyLiveLpgmWithMarks } from './useEarthquakes'
import { lpgmMarkKey, rowMarkKey } from '../utils/quakeUpdateMark'
import type { JMALpgm } from '../types/earthquake'

const EVENT_ID = '20240101161000'

function lpgm(over: Partial<JMALpgm> & { maxLgInt: number; time: string }): JMALpgm {
  const { maxLgInt, ...rest } = over
  return {
    id: `dmdata-lpgm-${EVENT_ID}-${over.time}`,
    eventId: EVENT_ID,
    originTime: '2024-01-01T16:10:00+09:00',
    maxClass: maxLgInt,
    cancelled: false,
    regions: [{ code: '390', name: '石川県能登', maxLgInt }],
    points: [],
    prefs: [],
    ...rest,
  }
}

const EMPTY = {
  earthquakes: [],
  lpgmByEventId: new Map<string, JMALpgm>(),
  quakeUpdateMarks: new Map(),
  quakeMarkMemory: new Map(),
}

describe('applyLiveLpgmWithMarks', () => {
  // 対照: 初報には印を付けない（比べる相手が無い）。
  it('対照: 初報では印を付けない', () => {
    const s = applyLiveLpgmWithMarks(EMPTY, lpgm({ maxLgInt: 3, time: '2024-01-01T07:40:00Z' }), 1_000)

    expect(s.lpgmByEventId.get(EVENT_ID)?.maxClass).toBe(3)
    expect(s.quakeUpdateMarks.get(lpgmMarkKey(EVENT_ID))).toBeUndefined()
    expect(s.quakeMarkMemory.has(lpgmMarkKey(EVENT_ID))).toBe(true)
  })

  // 正: 続報で階級が動いた行に印が付く。
  it('正: 続報で階級が上がった区域に印を付ける', () => {
    const first = applyLiveLpgmWithMarks(EMPTY, lpgm({ maxLgInt: 3, time: '2024-01-01T07:40:00Z' }), 1_000)
    const second = applyLiveLpgmWithMarks(
      { ...EMPTY, ...first },
      lpgm({ maxLgInt: 4, time: '2024-01-01T07:50:00Z' }),
      2_000,
    )

    const marks = second.quakeUpdateMarks.get(lpgmMarkKey(EVENT_ID))
    expect(marks).toBeDefined()
    expect(marks!.rows.get(rowMarkKey.area('石川県能登'))).toBeDefined()
  })

  // 安全弁: 取消では印も記憶も進めない（一覧ごと消えるため）。
  it('安全弁: 取消では印を付けず、記憶も書き換えない', () => {
    const first = applyLiveLpgmWithMarks(EMPTY, lpgm({ maxLgInt: 3, time: '2024-01-01T07:40:00Z' }), 1_000)
    const cancelled = applyLiveLpgmWithMarks(
      { ...EMPTY, ...first },
      { ...lpgm({ maxLgInt: 3, time: '2024-01-01T08:00:00Z' }), cancelled: true, regions: undefined, points: undefined, prefs: undefined },
      2_000,
    )

    expect(cancelled.quakeUpdateMarks).toBe(first.quakeUpdateMarks)
    expect(cancelled.quakeMarkMemory).toBe(first.quakeMarkMemory)
  })

  // 安全弁: 印付けが投げても一覧は更新し、印と記憶は据え置く。更新関数の中で投げると
  // 画面ごと落ちるので、関数の中で受け止めて記録する。
  it('安全弁: 印付けが投げても一覧は更新し、印は据え置く', () => {
    const first = applyLiveLpgmWithMarks(EMPTY, lpgm({ maxLgInt: 3, time: '2024-01-01T07:40:00Z' }), 1_000)
    const broken = { ...lpgm({ maxLgInt: 4, time: '2024-01-01T07:50:00Z' }), regions: [null] } as unknown as JMALpgm
    const err = muteConsoleError()
    const s = applyLiveLpgmWithMarks({ ...EMPTY, ...first }, broken, 2_000)
    err.mockRestore()

    expect(s.lpgmByEventId.get(EVENT_ID)).toBe(broken)
    expect(s.quakeUpdateMarks).toBe(first.quakeUpdateMarks)
    expect(s.quakeMarkMemory).toBe(first.quakeMarkMemory)

    // 据え置いた記憶のまま、次の正常な報には印が付く（受け皿の後も印付けが止まらない）
    const next = applyLiveLpgmWithMarks({ ...EMPTY, ...s }, lpgm({ maxLgInt: 4, time: '2024-01-01T08:00:00Z' }), 3_000)
    expect(next.quakeUpdateMarks.get(lpgmMarkKey(EVENT_ID))?.rows.get(rowMarkKey.area('石川県能登'))).toBeDefined()
  })
})

// 長周期の欄に出す震源・規模・深さ・全国の最大震度にも、地震カードと同じ印を付ける
// （2026-10-29 ユーザー承認「地震カードと同じく付ける」。写しは `lpgmFactSnapshot`）。
describe('applyLiveLpgmWithMarks: 長周期の欄の値の印', () => {
  const withFacts = (time: string, magnitude: number, maxInt: JMALpgm['maxInt']) => lpgm({
    maxLgInt: 2, time, magnitude, magnitudeType: 'Mj', maxInt,
    hypocenter: { name: '石川県能登地方', depth: 20 },
  })

  // 正: 続報で規模が上がったら、規模の欄に「上がった」の印
  it('正: 続報で規模が上がると、規模の欄に印を付ける', () => {
    const first = applyLiveLpgmWithMarks(EMPTY, withFacts('2024-01-01T07:40:00Z', 5.7, 50), 1_000)
    const second = applyLiveLpgmWithMarks({ ...EMPTY, ...first }, withFacts('2024-01-01T07:50:00Z', 5.8, 50), 2_000)
    const facts = second.quakeUpdateMarks.get(lpgmMarkKey(EVENT_ID))?.facts
    expect(facts?.get('magnitude')).toBe('raised')
    expect(facts?.has('maxScale')).toBe(false)
    expect(facts?.has('hypocenterName')).toBe(false)
  })

  // 対照: 値が動かない続報では欄の印を付けない
  it('対照: 値が同じ続報では欄に印を付けない', () => {
    const first = applyLiveLpgmWithMarks(EMPTY, withFacts('2024-01-01T07:40:00Z', 5.7, 50), 1_000)
    const second = applyLiveLpgmWithMarks({ ...EMPTY, ...first }, withFacts('2024-01-01T07:50:00Z', 5.7, 50), 2_000)
    expect(second.quakeUpdateMarks.get(lpgmMarkKey(EVENT_ID))?.facts.size ?? 0).toBe(0)
  })

  // 安全弁: 初報では欄にも印を付けない（比べる相手が無い）
  it('安全弁: 初報では欄に印を付けない', () => {
    const s = applyLiveLpgmWithMarks(EMPTY, withFacts('2024-01-01T07:40:00Z', 5.7, 50), 1_000)
    expect(s.quakeUpdateMarks.get(lpgmMarkKey(EVENT_ID))).toBeUndefined()
  })
})
