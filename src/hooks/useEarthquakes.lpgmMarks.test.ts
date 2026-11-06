// 長周期地震動の報を 1 通当てたときの印（`applyLiveLpgmWithMarks`）。
//
// **キュー経路と WebSocket 経路が同じ関数を通る。** WebSocket 経路だけ `applyLiveLpgm` を
// 呼ぶ形にすると、ライブで長周期の一覧に印が付かない（キュー経路を通るテスト・リプレイでは
// 付くので、実機でしか見えない）。
import { describe, it, expect } from 'vitest'
import { muteConsoleError } from '../test-utils/muteConsoleError'
import { applyLiveLpgmWithMarks } from './useEarthquakes'
import { lpgmMarkKey, rowMarkKey, rememberQuakeCard, quakeFactSnapshot } from '../utils/quakeUpdateMark'
import { quakeEventKey } from '../utils/quakeMerge'
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
  estimatedIntensities: [],
  tsunamis: [],
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

// 長周期が地震情報より新しい値を運んだら、地震カードの上段へ当て、出ていた値と比べて印を付ける
// （2026-11-03 ユーザー選択「発表時刻が最も新しい報 (Recommended)」「出ていた値と比べて付ける (Recommended)」）
describe('applyLiveLpgmWithMarks が地震カードへ当てる値', () => {
  const card = {
    kind: 'quake',
    id: `dmdata-quake-${EVENT_ID}-1`,
    time: '2024-01-01T16:16:00+09:00',
    issue: { source: '気象庁', time: '2024-01-01T16:16:00+09:00', type: '震源・震度情報', correct: 'なし' },
    earthquake: {
      time: '2024-01-01T16:10:00+09:00',
      hypocenter: { name: '石川県能登地方', latitude: 37.5, longitude: 137.2, depth: 0, magnitude: 7.4 },
      maxScale: 70,
      domesticTsunami: '警報等',
    },
    points: [],
  } as unknown as import('../types/earthquake').JMAQuake
  // カードが出していた値の記憶（本物の流れでは、地震情報を受けた時点で作られている）
  const memory = new Map<string, import('../utils/quakeUpdateMark').QuakeMarkMemory>()
  rememberQuakeCard(memory, quakeEventKey(card), {
    facts: quakeFactSnapshot(card), rows: new Map(), issuedAt: 0, reportType: '震源・震度情報', telegramType: '震源・震度情報', revise: null,
  })
  const withCard = { ...EMPTY, earthquakes: [card], quakeMarkMemory: memory }
  const newerLpgm = (magnitude: number) => lpgm({
    maxLgInt: 4, time: '2024-01-01T16:23:00+09:00', magnitude,
    hypocenter: { name: '石川県能登地方', latitude: 37.5, longitude: 137.2, depth: 0 },
  })

  // 正: 長周期のほうが新しく、規模が違えば上段を差し替え、規模に印を付ける
  it('正: 新しい長周期の規模を上段へ当て、規模に印を付ける', () => {
    const s = applyLiveLpgmWithMarks(withCard, newerLpgm(7.6), 1_000)
    expect(s.earthquakes[0].earthquake.hypocenter.magnitude).toBe(7.6)
    expect(s.quakeUpdateMarks.get(quakeEventKey(card))?.facts.get('magnitude')).toBe('raised')
  })

  // 対照: 同じ値なら一覧の参照を変えない（描き直させない）
  it('対照: 値が同じなら地震の一覧の参照を変えない', () => {
    const s = applyLiveLpgmWithMarks(withCard, newerLpgm(7.4), 1_000)
    expect(s.earthquakes).toBe(withCard.earthquakes)
  })

  // 正: 当てていた長周期が取り消されたら、上段を地震情報の値へ戻し、規模に印を付ける（2026-11-03 ユーザー選択「戻す (Recommended)」）
  it('正: 長周期の取消で、当てていた上段の値を地震情報の値へ戻す', () => {
    const applied = applyLiveLpgmWithMarks(withCard, newerLpgm(7.6), 1_000)
    const cancel = lpgm({ maxLgInt: 4, time: '2024-01-01T16:30:00+09:00', cancelled: true })
    const s = applyLiveLpgmWithMarks({ ...withCard, ...applied }, cancel, 2_000)
    expect(s.earthquakes[0].earthquake.hypocenter.magnitude).toBe(7.4)
    expect(s.earthquakes[0].quakeInfoFacts).toBeUndefined()
    expect(s.quakeUpdateMarks.get(quakeEventKey(card))?.facts.get('magnitude')).toBe('lowered')
  })

  // 安全弁: 長周期を当てても、記憶の電文の種別は直前の地震情報のまま（次の地震情報が Revise と欄の初出を使える）。
  // 直前の地震情報が付けた行の印も残す（行はこの報で変わっていない）
  it('安全弁: 記憶の種別と、直前の地震情報が付けた行の印を保つ', () => {
    const key = quakeEventKey(card)
    const rowMarks = new Map([['row:1', 'new' as const]])
    const marked = { ...withCard, quakeUpdateMarks: new Map([[key, { facts: new Map(), rows: rowMarks, markedAt: 500 }]]) }
    const s = applyLiveLpgmWithMarks(marked, newerLpgm(7.6), 1_000)
    expect(s.quakeMarkMemory.get(key)?.telegramType).toBe('震源・震度情報')
    expect(s.quakeUpdateMarks.get(key)?.rows).toBe(rowMarks)
    expect(s.quakeUpdateMarks.get(key)?.facts.get('magnitude')).toBe('raised')
  })
})
