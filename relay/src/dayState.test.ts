import { describe, it, expect } from 'vitest'

import {
  type ArchiveFacts,
  type DayFacts,
  type DayState,
  type DayStateParams,
  type LiveSession,
  DEFAULT_DAY_STATE_PARAMS as P,
  EMPTY_ARCHIVE_FACTS,
  covers,
  dayState,
  gapfillDecision,
  gapfillWindow,
  jstDayEndMs,
  jstDayOf,
  jstDayStartMs,
  needsIngest,
  nextManifestCheckMs,
  observedIntervals,
  recordManifestCheck,
  servesBundle,
  sessionEnd,
  sessionEndOnClose,
  validateDayStateParams,
} from './dayState'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = '20261020'
const START = jstDayStartMs(DAY) // 2026-10-20 00:00 JST
const END = jstDayEndMs(DAY) // 2026-10-21 00:00 JST
const OP_START = '20261019' // 運用開始の日（対象の日より前）
const LATER_OP_START = '20261025' // 対象の日が運用開始より前になる日
/** open を抜ける最初の時刻（日の終わり＋10 分＋削る 1 分）。 */
const CLOSE = END + 11 * MIN

function facts(over: Partial<DayFacts> = {}, archive: Partial<ArchiveFacts> = {}): DayFacts {
  return {
    day: DAY,
    classification: 'telegram.earthquake',
    telegramCount: 5,
    gapfills: [],
    archive: { ...EMPTY_ARCHIVE_FACTS, ...archive },
    ...over,
  }
}

/** 自分で閉じた回。 */
function closed(fromMs: number, toMs: number): LiveSession {
  return { connectedMs: fromMs, lastHeartbeatMs: toMs, endedMs: toMs }
}

/** 日の前から繋がり続け、いまも繋がっている回（最後の心拍は判定の時刻）。 */
function liveUntil(nowMs: number): LiveSession {
  return { connectedMs: START - 2 * MIN, lastHeartbeatMs: nowMs, endedMs: null }
}

describe('日の始まりと終わり（JST）', () => {
  it('2026-10-20 は UTC の 10-19 15:00 から 24 時間', () => {
    expect(new Date(START).toISOString()).toBe('2026-10-19T15:00:00.000Z')
    expect(END - START).toBe(24 * HOUR)
    expect(jstDayOf(START)).toBe(DAY)
    expect(jstDayOf(END - 1)).toBe(DAY)
    expect(jstDayOf(END)).toBe('20261021')
  })
  it('存在しない日・形の違う日・有限でない時刻は投げる', () => {
    expect(() => jstDayStartMs('20260230')).toThrow()
    expect(() => jstDayStartMs('2026-10-20')).toThrow()
    expect(() => jstDayOf(Number.NaN)).toThrow()
  })
})

describe('覆いの判定', () => {
  const target = { fromMs: 0, toMs: 100 }
  it.each([
    ['1 本で覆う', [{ fromMs: 0, toMs: 100 }], true],
    ['端が接する 2 本で覆う', [{ fromMs: 50, toMs: 100 }, { fromMs: 0, toMs: 50 }], true],
    ['1 ミリ秒の穴があれば覆わない', [{ fromMs: 0, toMs: 49 }, { fromMs: 50, toMs: 100 }], false],
    ['頭が欠ける', [{ fromMs: 1, toMs: 100 }], false],
    ['尻が欠ける', [{ fromMs: 0, toMs: 99 }], false],
    ['何も無い', [], false],
    ['逆向きの区間は数えない', [{ fromMs: 100, toMs: 0 }], false],
    ['有限でない端の区間は数えない', [{ fromMs: -Infinity, toMs: Infinity }], false],
    ['NaN の区間は数えない', [{ fromMs: Number.NaN, toMs: 100 }], false],
  ])('%s', (_name, intervals, expected) => {
    expect(covers(intervals, target)).toBe(expected)
  })
  it('目標が逆向き・有限でないなら投げる', () => {
    expect(() => covers([], { fromMs: 100, toMs: 0 })).toThrow()
    expect(() => covers([], { fromMs: 0, toMs: Number.NaN })).toThrow()
  })
})

describe('見ていた区間の終わり（心拍）', () => {
  it('正: 知らないまま止められた回は最後の心拍で切る', () => {
    expect(sessionEnd({ connectedMs: 0, lastHeartbeatMs: 5 * MIN, endedMs: null })).toBe(5 * MIN)
  })
  it('対照: 閉じる合図を受けて閉じた回はその時刻で切る（最後に受けた時刻より後でも）', () => {
    expect(sessionEndOnClose('closed', 10 * MIN, 10 * MIN - 90_000)).toBe(10 * MIN)
  })
  it.each(['watchdog', 'error'] as const)(
    '安全弁: %s で閉じた回は、最後に何かを受けた時刻で切る',
    (reason) => {
      expect(sessionEndOnClose(reason, 10 * MIN, 10 * MIN - 90_000)).toBe(10 * MIN - 90_000)
      // 受けた時刻が閉じた時刻より後に記録されても、閉じた時刻を越えない
      expect(sessionEndOnClose(reason, 10 * MIN, 11 * MIN)).toBe(10 * MIN)
    },
  )
})

describe('時計のずれの余裕', () => {
  const now = 100 * MIN
  it('正: WebSocket の区間は両端で 1 分ずつ削る', () => {
    expect(observedIntervals([closed(0, 10 * MIN)], [], now, P)).toEqual([{ fromMs: MIN, toMs: 9 * MIN }])
  })
  it('対照: 一覧で取り戻した区間（DMDATA の時計）は削らない', () => {
    expect(observedIntervals([], [{ fromMs: 0, toMs: 10 * MIN }], now, P)).toEqual([{ fromMs: 0, toMs: 10 * MIN }])
  })
  it('安全弁: 2 分より短い回は数えない（逆向きの区間になり覆いに効かない）', () => {
    const [iv] = observedIntervals([closed(0, 2 * MIN - 1)], [], now, P)
    expect(iv.fromMs > iv.toMs).toBe(true)
    expect(covers([iv], { fromMs: 0, toMs: 2 * MIN })).toBe(false)
  })
  it('安全弁: 今より未来の心拍は今で頭打ちにする', () => {
    expect(observedIntervals([closed(0, 200 * MIN)], [], now, P)).toEqual([{ fromMs: MIN, toMs: now - MIN }])
  })
})

// 日の状態の表。**行を足すときは、状態を決める事実をなるべく 1 つだけ変える**（近い行と見比べて差が分かるように）。
type Row = [
  name: string,
  facts: DayFacts,
  sessions: readonly LiveSession[],
  operationStartDay: string | null,
  nowMs: number,
  expected: DayState,
]

const RECONNECT = END - 10 * MIN // 23:50 に止められ、23:52 に繋ぎ直した日
const broken = (nowMs: number): readonly LiveSession[] => [
  { connectedMs: START - 2 * MIN, lastHeartbeatMs: RECONNECT, endedMs: null },
  { connectedMs: RECONNECT + 2 * MIN, lastHeartbeatMs: nowMs, endedMs: null },
]
const GAPFILL = { fromMs: RECONNECT - 5 * MIN, toMs: RECONNECT + 3 * MIN }
const ABSENT_AT = END + 48 * HOUR

const rows: Row[] = [
  // ── 運用開始より後の日: 閉じる時刻 ──
  ['日が終わっていない', facts(), [liveUntil(END - 1)], OP_START, END - 1, 'open'],
  ['日の終わり＋11 分の 1 ミリ秒前はまだ open', facts(), [liveUntil(CLOSE - 1)], OP_START, CLOSE - 1, 'open'],
  ['日の終わり＋11 分・繋がり続けていた → observed', facts(), [liveUntil(CLOSE)], OP_START, CLOSE, 'observed'],
  ['隙間なく見ていて 1 通も無い（空の束を出す）', facts({ telegramCount: 0 }), [liveUntil(CLOSE)], OP_START, CLOSE, 'observed'],
  ['日の終わり＋10 分の直前で切れた', facts(), [closed(START - 2 * MIN, END + 10 * MIN)], OP_START, CLOSE, 'gapped'],
  // ── 切れて繋ぎ直した日 ──
  ['23:50 に止められ 23:52 に繋ぎ直した・取り戻し前', facts(), broken(CLOSE), OP_START, CLOSE, 'gapped'],
  ['同・取り戻しが後から済んだ（次の計算で抜けられる）', facts({ gapfills: [GAPFILL] }), broken(END + 20 * MIN), OP_START, END + 20 * MIN, 'observed'],
  [
    '同・取り戻しが削られた頭の 1 分まで届かない',
    facts({ gapfills: [{ ...GAPFILL, toMs: GAPFILL.toMs - 1 }] }),
    broken(END + 20 * MIN),
    OP_START,
    END + 20 * MIN,
    'gapped',
  ],
  [
    '数秒で繋ぎ直しても、削った 2 分が穴になる',
    facts(),
    [closed(START - 2 * MIN, RECONNECT), { connectedMs: RECONNECT + 3_000, lastHeartbeatMs: CLOSE, endedMs: null }],
    OP_START,
    CLOSE,
    'gapped',
  ],
  ['心拍が今より 30 秒遅れている（次の心拍までは gapped）', facts(), [liveUntil(CLOSE - 30_000)], OP_START, CLOSE, 'gapped'],
  ['未来の心拍が記録されていても、今で頭打ちにして判定する', facts(), [{ connectedMs: START - 2 * MIN, lastHeartbeatMs: CLOSE + HOUR, endedMs: null }], OP_START, CLOSE, 'observed'],
  ['中継が丸 1 日止まっていた（事実が無い＝見ていない）', facts(), [], OP_START, CLOSE, 'gapped'],
  ['運用開始の日そのもの（繋がる前の分を見ていない）', facts(), [{ ...liveUntil(CLOSE), connectedMs: START + HOUR }], DAY, CLOSE, 'gapped'],
  // ── 警報の区分 ──
  ['警報: 一覧の取り戻し区間があっても数えない', facts({ classification: 'eew.warning', telegramCount: 0, gapfills: [GAPFILL] }), broken(END + 20 * MIN), OP_START, END + 20 * MIN, 'gapped'],
  ['警報: 切れていない日は observed', facts({ classification: 'eew.warning', telegramCount: 0 }), [liveUntil(CLOSE)], OP_START, CLOSE, 'observed'],
  ['地震津波: 同じ取り戻し区間なら observed（警報の行と対）', facts({ telegramCount: 0, gapfills: [GAPFILL] }), broken(END + 20 * MIN), OP_START, END + 20 * MIN, 'observed'],
  ['警報: 48 時間載らなければ空と確定（警報の無い日は終点に着く）', facts({ classification: 'eew.warning', telegramCount: 0 }, { absentConfirmedAtMs: ABSENT_AT }), broken(ABSENT_AT), OP_START, ABSENT_AT, 'confirmed-empty'],
  // ── 突き合わせ ──
  ['アーカイブを取り込んだ', facts({}, { listedAtMs: END + HOUR, ingestedAtMs: END + HOUR }), [], OP_START, END + 2 * HOUR, 'reconciled'],
  ['見ていない時間があり、空で、DMDATA 側にも無い', facts({ telegramCount: 0 }, { absentConfirmedAtMs: ABSENT_AT }), [], OP_START, ABSENT_AT, 'confirmed-empty'],
  ['見ていない時間があり、空だが、まだ無いと確かめていない', facts({ telegramCount: 0 }), [], OP_START, ABSENT_AT, 'gapped'],
  ['見ていない時間があり、電文があるのにアーカイブが無い', facts({ telegramCount: 1 }, { absentConfirmedAtMs: ABSENT_AT }), [], OP_START, ABSENT_AT, 'gapped'],
  ['隙間なく見ていて空、DMDATA 側にも無い', facts({ telegramCount: 0 }, { absentConfirmedAtMs: ABSENT_AT }), [liveUntil(ABSENT_AT)], OP_START, ABSENT_AT, 'confirmed-empty'],
  ['空と確かめた後で目録に載った → 取り込むまで空の束を引っ込める', facts({ telegramCount: 0 }, { absentConfirmedAtMs: ABSENT_AT, listedAtMs: ABSENT_AT + HOUR }), [], OP_START, ABSENT_AT + 2 * HOUR, 'gapped'],
  ['隙間なく見ていて空でも、目録に載っていれば空の束を出さない', facts({ telegramCount: 0 }, { listedAtMs: END + HOUR }), [liveUntil(END + 2 * HOUR)], OP_START, END + 2 * HOUR, 'gapped'],
  ['空と確かめた後で載り、取り込んだ', facts({ telegramCount: 0 }, { absentConfirmedAtMs: ABSENT_AT, listedAtMs: ABSENT_AT + HOUR, ingestedAtMs: ABSENT_AT + HOUR }), [], OP_START, ABSENT_AT + 2 * HOUR, 'reconciled'],
  ['運用開始以降の日は取り込みに失敗しても failed にしない', facts({}, { listedAtMs: END + HOUR, lastFetchFailedAtMs: END + HOUR }), [], OP_START, END + 2 * HOUR, 'gapped'],
  // ── 運用開始より前の日（過去分の控え） ──
  ['前: まだ取っていない', facts(), [liveUntil(CLOSE)], LATER_OP_START, CLOSE, 'unfetched'],
  ['前: 中継がまだ一度も繋がっていない', facts(), [], null, CLOSE, 'unfetched'],
  ['前: 取れなかった', facts({}, { listedAtMs: END, lastFetchFailedAtMs: END + HOUR }), [], LATER_OP_START, END + 2 * HOUR, 'failed'],
  ['前: 取れなかった後で取れた', facts({}, { listedAtMs: END, lastFetchFailedAtMs: END + HOUR, ingestedAtMs: END + 2 * HOUR }), [], LATER_OP_START, END + 3 * HOUR, 'reconciled'],
  ['前: 48 時間たって目録に載らない', facts({ telegramCount: 0 }, { absentConfirmedAtMs: ABSENT_AT }), [], LATER_OP_START, ABSENT_AT, 'confirmed-empty'],
  ['前: 空と確かめた後で目録に載った → 取り込むまで unfetched', facts({ telegramCount: 0 }, { absentConfirmedAtMs: ABSENT_AT, listedAtMs: ABSENT_AT + HOUR }), [], LATER_OP_START, ABSENT_AT + 2 * HOUR, 'unfetched'],
  ['前: WebSocket の区間があっても見ない', facts({ telegramCount: 0 }), [liveUntil(CLOSE)], LATER_OP_START, CLOSE, 'unfetched'],
  ['前: 運用開始の前日（< で比べる）', facts({ day: '20261018' }), [], OP_START, CLOSE, 'unfetched'],
]

describe('日の状態の表', () => {
  it.each(rows)('%s', (_name, f, sessions, opStart, now, expected) => {
    expect(dayState(f, sessions, opStart, now, P).state).toBe(expected)
  })

  it.each<[string, DayFacts, readonly string[]]>([
    ['電文があるのにアーカイブが無い', facts({ telegramCount: 1 }, { absentConfirmedAtMs: ABSENT_AT }), ['telegrams-without-archive']],
    ['隙間なく見ていたのに、目録に載っている日の索引が空', facts({ telegramCount: 0 }, { listedAtMs: END + HOUR }), ['listed-but-index-empty']],
    ['目録に載ったのに取り込みに失敗', facts({}, { listedAtMs: END + HOUR, lastFetchFailedAtMs: END + 2 * HOUR }), ['archive-fetch-failed']],
    ['何も起きていない', facts(), []],
  ])('異常の印: %s', (_name, f, expected) => {
    expect(dayState(f, [liveUntil(ABSENT_AT)], OP_START, ABSENT_AT, P).anomalies).toEqual(expected)
  })

  it.each<[string, readonly LiveSession[], string | null]>([
    ['見ていない時間があった日（取り込み待ちは普通の形）', [], OP_START],
    ['運用開始より前の日', [liveUntil(ABSENT_AT)], LATER_OP_START],
  ])('印を付けない: 目録に載り索引が空でも %s', (_name, sessions, opStart) => {
    const f = facts({ telegramCount: 0 }, { listedAtMs: END + HOUR, lastFetchFailedAtMs: END + 2 * HOUR })
    const anomalies = dayState(f, sessions, opStart, ABSENT_AT, P).anomalies
    expect(anomalies).not.toContain('listed-but-index-empty')
    if (opStart === LATER_OP_START) expect(anomalies).toEqual([])
  })

  it('束を出すのは observed・reconciled・confirmed-empty だけ', () => {
    const all: DayState[] = ['open', 'observed', 'gapped', 'reconciled', 'confirmed-empty', 'unfetched', 'failed']
    expect(all.filter(servesBundle)).toEqual(['observed', 'reconciled', 'confirmed-empty'])
  })

  it.each<[string, () => unknown]>([
    ['存在しない日', () => dayState(facts({ day: '20261332' }), [], OP_START, CLOSE, P)],
    ['運用開始の日の形が違う', () => dayState(facts(), [], '2026-10-19', CLOSE, P)],
    ['今が有限でない', () => dayState(facts(), [], OP_START, Number.NaN, P)],
    ['件数が負', () => dayState(facts({ telegramCount: -1 }), [], OP_START, CLOSE, P)],
    ['件数が整数でない', () => dayState(facts({ telegramCount: Number.NaN }), [], OP_START, CLOSE, P)],
    ['運用開始より前の日でも、日の形を確かめる', () => dayState(facts({ day: '2026' }), [], LATER_OP_START, CLOSE, P)],
  ])('壊れた入力は投げる: %s', (_name, call) => {
    expect(call).toThrow()
  })
})

describe('設定値の検査', () => {
  it('既定値は通る', () => {
    expect(() => validateDayStateParams(P)).not.toThrow()
  })
  it.each<[string, Partial<DayStateParams>]>([
    ['余裕が負（区間を広げてしまう）', { clockMarginMs: -1 }],
    ['閉じる待ちが負', { closeDelayMs: -1 }],
    ['「無い」と読む待ちが 24 時間より短い', { absentWaitMs: 24 * HOUR - 1 }],
    ['取り戻しの上限が負', { gapfillMaxBodies: -1 }],
    ['取り戻しの上限が整数でない', { gapfillMaxBodies: 1.5 }],
    ['目録を見る間隔が 0', { manifestDailyEveryMs: 0 }],
    ['有限でない', { clockMarginMs: Number.NaN }],
  ])('投げる: %s', (_name, over) => {
    expect(() => validateDayStateParams({ ...P, ...over })).toThrow()
    expect(() => dayState(facts(), [], OP_START, CLOSE, { ...P, ...over })).toThrow()
  })
})

describe('目録を見た結果の書き足し', () => {
  const base = EMPTY_ARCHIVE_FACTS
  const absentCheck = (atMs: number) => ({ atMs, outcome: 'absent-from-complete-listing' as const })
  const listedCheck = (atMs: number) => ({ atMs, outcome: 'listed' as const })
  it('正: 日が終わって 48 時間たって載らなければ「無い」の印を立てる', () => {
    expect(recordManifestCheck(base, DAY, absentCheck(END + 48 * HOUR), P).absentConfirmedAtMs).toBe(END + 48 * HOUR)
  })
  it('対照: 48 時間に 1 ミリ秒足りなければ立てない', () => {
    expect(recordManifestCheck(base, DAY, absentCheck(END + 48 * HOUR - 1), P)).toBe(base)
  })
  it('安全弁: 一度載ったのを見た日は、後で載っていなくても「無い」と読まない', () => {
    const listed = recordManifestCheck(base, DAY, listedCheck(END + HOUR), P)
    expect(listed.listedAtMs).toBe(END + HOUR)
    expect(recordManifestCheck(listed, DAY, absentCheck(END + 72 * HOUR), P)).toBe(listed)
  })
  it('印は最初の時刻のまま動かさない', () => {
    const once = recordManifestCheck(base, DAY, absentCheck(END + 48 * HOUR), P)
    expect(recordManifestCheck(once, DAY, absentCheck(END + 72 * HOUR), P)).toBe(once)
    const listed = recordManifestCheck(once, DAY, listedCheck(END + 96 * HOUR), P)
    expect(recordManifestCheck(listed, DAY, listedCheck(END + 97 * HOUR), P)).toBe(listed)
    expect(listed.absentConfirmedAtMs).toBe(END + 48 * HOUR)
  })
  it('時刻が有限でなければ投げる', () => {
    expect(() => recordManifestCheck(base, DAY, absentCheck(Number.NaN), P)).toThrow()
  })
})

describe('取り込み待ち', () => {
  it.each<[string, Partial<ArchiveFacts>, boolean]>([
    ['目録に載り、まだ取り込んでいない', { listedAtMs: 1 }, true],
    ['取り込みに失敗した（周回ごとに取り直す）', { listedAtMs: 1, lastFetchFailedAtMs: 2 }, true],
    ['取り込んだ', { listedAtMs: 1, ingestedAtMs: 2 }, false],
    ['目録に載っていない', {}, false],
  ])('%s', (_name, archive, expected) => {
    expect(needsIngest({ ...EMPTY_ARCHIVE_FACTS, ...archive })).toBe(expected)
  })
})

describe('次に目録を見る時刻', () => {
  it.each<[string, DayState, number | null, number | null]>([
    ['まだ見ていない日は日の終わりから', 'gapped', null, END],
    ['48 時間までは 1 時間おき', 'gapped', END + 47 * HOUR, END + 48 * HOUR],
    ['48 時間を過ぎたら 1 日おき', 'gapped', END + 48 * HOUR, END + 72 * HOUR],
    ['observed の日も突き合わせのために見る', 'observed', END + HOUR, END + 2 * HOUR],
    ['confirmed-empty の後も 1 日おきに見続ける', 'confirmed-empty', END + 100 * HOUR, END + 124 * HOUR],
    ['過去分の取れなかった日も見る', 'failed', END + 100 * HOUR, END + 124 * HOUR],
    ['reconciled の日は見ない', 'reconciled', END + HOUR, null],
    ['今日は見ない', 'open', null, null],
  ])('%s', (_name, state, last, expected) => {
    expect(nextManifestCheckMs(state, DAY, last, P)).toBe(expected)
  })
  it('最後に見た時刻が有限でなければ投げる（見に行かなくなるのを防ぐ）', () => {
    expect(() => nextManifestCheckMs('gapped', DAY, Number.NaN, P)).toThrow()
  })
})

describe('張り直したときの取り戻し', () => {
  const prev: LiveSession = { connectedMs: 0, lastHeartbeatMs: 100 * MIN, endedMs: null }
  const cur: LiveSession = { connectedMs: 102 * MIN, lastHeartbeatMs: 102 * MIN, endedMs: null }

  it('正: 起点は前の回の最後の心拍の 5 分前、終わりは新しい回の始まり＋1 分', () => {
    expect(gapfillWindow(prev, cur, P)).toEqual({
      range: { fromMs: 95 * MIN, toMs: 103 * MIN },
      readyAtMs: 104 * MIN,
    })
  })
  it('正: 前の回が自分で切れたと知った回なら、その時刻から', () => {
    expect(gapfillWindow({ ...prev, endedMs: 100 * MIN + 30_000 }, cur, P)?.range.fromMs).toBe(95 * MIN + 30_000)
  })
  it('対照: 初めての接続は取り戻さない', () => {
    expect(gapfillWindow(null, cur, P)).toBeNull()
  })
  it('安全弁: 取り戻した範囲が、両方の回の削った端どうしの穴を埋める', () => {
    const w = gapfillWindow(prev, cur, P)!
    const now = 200 * MIN
    const live = observedIntervals([prev, { ...cur, lastHeartbeatMs: now }], [], now, P) // [1, 99] と [103, 199]
    const span = { fromMs: MIN, toMs: 199 * MIN }
    expect(covers(live, span)).toBe(false)
    expect(covers([...live, w.range], span)).toBe(true)
  })
  it('安全弁: 範囲が逆向きになる（時計が跳んだ）なら取り戻さない', () => {
    expect(gapfillWindow({ ...prev, lastHeartbeatMs: 300 * MIN }, cur, P)).toBeNull()
  })
  it('有限でない時刻は投げる', () => {
    expect(() => gapfillWindow({ ...prev, lastHeartbeatMs: Number.NaN }, cur, P)).toThrow()
  })

  it.each<[string, boolean, number, 'fetch' | 'leave-to-reconciliation']>([
    ['正: 40 件までは取り戻す', true, 40, 'fetch'],
    ['対照: 41 件なら突き合わせに任せる', true, 41, 'leave-to-reconciliation'],
    ['安全弁: 一覧を辿りきれなければ 0 件でも任せる', false, 0, 'leave-to-reconciliation'],
  ])('%s', (_name, complete, missing, expected) => {
    expect(gapfillDecision(complete, missing, P)).toBe(expected)
  })
  it('件数が負・整数でないなら投げる', () => {
    expect(() => gapfillDecision(true, -1, P)).toThrow()
    expect(() => gapfillDecision(true, Number.NaN, P)).toThrow()
  })
})
