import { describe, it, expect } from 'vitest'
import {
  DAY_MS, DAY_SEC, JST_OFFSET_MS, MAX_GAP_MS, WARMUP_SEC, dayStartMs, streamDays, summarizeRun,
  type DayRun, type EventRow, type StreamDeps, type TrackedDetection,
} from './kyoshinContinuousEval'
import type { CatalogQuake } from './kyoshinCatalogMatch'

// ---------------------------------------------------------------------------
// 合成の道具
// ---------------------------------------------------------------------------

const D1 = '20261024'
const D2 = '20261025'
const D3 = '20261026'
const SITES: [number, number][] = [[35, 139], [36, 140]]

/** 日 `day` の頭からの秒 `sec` の控えの時刻 */
const at = (day: string, sec: number) => dayStartMs(day) + sec * 1000

/**
 * 控えの秒（日の頭からの秒の並び）を日ごとに渡し、偽の検知器で流す。本物の控えと同じく、日が無ければ時間ごとに null、
 * 日があればその時の秒の配列（1 秒も無ければ空の配列）を返す。
 * `detect` は控えの時刻ごとに検知器が返す検知（無ければ空）。点数が食い違う秒は `mismatched` に入れる。
 * `cfgOf` は秒ごとの観測点の版（既定 `c1`）、`sitesOf` は版ごとの観測点（既定 {@link SITES}）。
 */
function deps(
  secsOfDay: Record<string, number[]>,
  opts: {
    detect?: (ms: number) => TrackedDetection[]
    mismatched?: Set<number>
    cfgOf?: (day: string, sec: number) => string
    sitesOf?: (cfg: string) => [number, number][]
  } = {},
): StreamDeps & { trackers: number } {
  const d: StreamDeps & { trackers: number } = {
    trackers: 0,
    hourFrames(day, h) {
      const secs = secsOfDay[day]
      if (!secs) return null
      return secs.filter((s) => Math.floor(s / 3600) === h).map((s) => {
        const ms = at(day, s)
        const cfg = opts.cfgOf?.(day, s) ?? 'c1'
        const n = (opts.sitesOf?.(cfg) ?? SITES).length
        return { ms, cfg, values: new Int8Array(opts.mismatched?.has(ms) ? n + 1 : n) }
      })
    },
    loadSites: async (cfg) => opts.sitesOf?.(cfg) ?? SITES,
    createTracker() {
      d.trackers++
      return { push: (f) => opts.detect?.(f.ms) ?? [] }
    },
    onDayStreamed() {},
  }
  return d
}

/** `from` 以上 `to` 未満の秒 */
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i)
const detection = (id: string, confidence: 'likely' | 'confirmed' = 'likely'): TrackedDetection =>
  ({ id, confidence, epicenter: [35, 139], memberKeys: ['a', 'b'] })

// ---------------------------------------------------------------------------
// 流す
// ---------------------------------------------------------------------------

describe('streamDays: 助走の端', () => {
  it('正: 作り直してから 599 秒目は見ていない・600 秒目から見ている', async () => {
    const r = await streamDays([D1], deps({ [D1]: range(0, 700) }))
    expect(r.watched[WARMUP_SEC - 1]).toBe(0)
    expect(r.watched[WARMUP_SEC]).toBe(1)
    expect(r.days[0].watched).toBe(700 - WARMUP_SEC)
  })

  it('対照: 599 秒目に見え始めた検知は助走の内・600 秒目は外', async () => {
    const r = await streamDays([D1], deps({ [D1]: range(0, 700) }, {
      detect: (ms) => ms === at(D1, WARMUP_SEC - 1) ? [detection('a')] : ms === at(D1, WARMUP_SEC) ? [detection('b')] : [],
    }))
    const byId = new Map(r.events.map((e) => [e.id.split(':')[1], e]))
    expect(byId.get('a')?.inWarmup).toBe(true)
    expect(byId.get('b')?.inWarmup).toBe(false)
  })

  it('安全弁: 途切れて作り直した後も、改めて 600 秒の助走を置き、束の id を代で分ける', async () => {
    const restart = 700 + MAX_GAP_MS / 1000 + 1
    const t = deps({ [D1]: [...range(0, 701), ...range(restart, restart + 700)] }, {
      detect: (ms) => ms === at(D1, 650) || ms === at(D1, restart + 650) ? [detection('same')] : [],
    })
    const r = await streamDays([D1], t)
    expect(t.trackers).toBe(2)
    expect(r.watched[restart + WARMUP_SEC - 1]).toBe(0)
    expect(r.watched[restart + WARMUP_SEC]).toBe(1)
    expect(r.events.map((e) => e.id).sort()).toEqual(['1:same', '2:same'])
  })
})

describe('streamDays: 検知器を作り直した点を日に残す', () => {
  it('正: 時間の中で 60 秒を超えて途切れたら、直前の秒と作り直した秒を残す', async () => {
    const r = await streamDays([D1], deps({ [D1]: [...range(0, 1001), ...range(1061, 1800)] }))
    expect(r.days[0].restarts).toEqual([{ afterMs: null, atMs: at(D1, 0) }, { afterMs: at(D1, 1000), atMs: at(D1, 1061) }])
  })

  it('対照: 間隔が 60 秒以下の欠けは作り直さないので、期間の頭の 1 回だけ', async () => {
    const r = await streamDays([D1], deps({ [D1]: [...range(0, 1001), ...range(1060, 1100)] }))
    expect(r.days[0].restarts).toEqual([{ afterMs: null, atMs: at(D1, 0) }])
  })

  it('安全弁: 控えの無い時間の後と観測点の版の変わり目も残し、作り直した日の側に入れる', async () => {
    const sitesOf = (cfg: string): [number, number][] => (cfg === 'c2' ? [[35, 139], [40, 141]] : SITES)
    const r = await streamDays([D1, D2], deps(
      { [D1]: [...range(0, 3600), ...range(7200, 7300)], [D2]: range(0, 100) },
      { cfgOf: (d) => (d === D2 ? 'c2' : 'c1'), sitesOf },
    ))
    expect(r.days[0].restarts).toEqual([{ afterMs: null, atMs: at(D1, 0) }, { afterMs: at(D1, 3599), atMs: at(D1, 7200) }])
    expect(r.days[1].restarts).toEqual([{ afterMs: at(D1, 7299), atMs: at(D2, 0) }])
  })
})

describe('streamDays: 前の秒との間隔が 60 秒以下の欠けを埋める', () => {
  it('正: 間隔がちょうど 60 秒（欠け 59 秒）なら作り直さず、間の秒を見ていたものとして埋める', async () => {
    const t = deps({ [D1]: [...range(0, 1001), ...range(1060, 1100)] })
    const r = await streamDays([D1], t)
    expect(t.trackers).toBe(1)
    expect([...r.watched.subarray(1001, 1060)].every((v) => v === 1)).toBe(true)
    expect(r.days[0].watched).toBe(1100 - WARMUP_SEC)
    expect(r.days[0].frames).toBe(1001 + 40)
    expect(r.days[0].lostSec).toBe(DAY_SEC - 1041)
  })

  it('対照: 間隔が 61 秒（欠け 60 秒）なら埋めず、作り直して助走からやり直す', async () => {
    const t = deps({ [D1]: [...range(0, 1001), ...range(1061, 1800)] })
    const r = await streamDays([D1], t)
    expect(t.trackers).toBe(2)
    expect([...r.watched.subarray(1001, 1061 + WARMUP_SEC)].every((v) => v === 0)).toBe(true)
    expect(r.watched[1061 + WARMUP_SEC]).toBe(1)
  })

  it('安全弁: 点数が食い違う秒は流さずに数え、途切れの起点にはしない（間隔が 60 秒以下なら埋まる）', async () => {
    const bad = new Set(range(1001, 1031).map((s) => at(D1, s)))
    const t = deps({ [D1]: range(0, 1100) }, { mismatched: bad })
    const r = await streamDays([D1], t)
    expect(t.trackers).toBe(1)
    expect(r.days[0].mismatched).toBe(30)
    expect(r.days[0].frames).toBe(1100 - 30)
    expect([...r.watched.subarray(1001, 1031)].every((v) => v === 1)).toBe(true)
  })
})

describe('streamDays: 日をまたいで埋めた秒は、その秒の日に数える', () => {
  // 2 日目の終わりの 59 秒が欠け、3 日目の頭で埋まる形
  const fullDay = range(0, DAY_SEC)

  it('正: 埋めた日の終わりの秒は、その日の見ていた秒と見ていない続きに効く', async () => {
    const r = await streamDays([D1, D2, D3], deps({ [D1]: fullDay, [D2]: range(0, DAY_SEC - 59), [D3]: fullDay }))
    const [d1, d2, d3] = r.days
    expect(d1.watched).toBe(DAY_SEC - WARMUP_SEC)
    expect(d2.watched).toBe(DAY_SEC)
    expect(d2.longestBlindSec).toBe(0)
    expect(d3.watched).toBe(DAY_SEC)
  })

  it('対照: 境の隣（欠け 60 秒）なら埋めず、その日の終わりが見ていない続きに残り、翌日は助走から', async () => {
    const r = await streamDays([D1, D2, D3], deps({ [D1]: fullDay, [D2]: range(0, DAY_SEC - 60), [D3]: fullDay }))
    const [, d2, d3] = r.days
    expect(d2.watched).toBe(DAY_SEC - 60)
    expect(d2.longestBlindSec).toBe(60)
    expect(d3.watched).toBe(DAY_SEC - WARMUP_SEC)
    expect(d3.longestBlindSec).toBe(WARMUP_SEC)
  })

  it('安全弁: 日ごとの見ていた秒の和は、見ていた秒の列の和と一致する', async () => {
    const r = await streamDays([D1, D2, D3], deps({ [D1]: fullDay, [D2]: range(0, DAY_SEC - 59), [D3]: fullDay }))
    const total = r.watched.reduce((s, v) => s + v, 0)
    expect(r.days.reduce((s, d) => s + d.watched, 0)).toBe(total)
  })
})

describe('streamDays: 控えの無い時間と壊れた控え', () => {
  it('正: 控えはあっても 1 秒も無い時間は、控えの無い時間として数える', async () => {
    const r = await streamDays([D1], deps({ [D1]: [...range(0, 3600), ...range(7200, 7300)] }))
    expect(r.days[0].missingHours).toContain(1)
    expect(r.days[0].missingHours).not.toContain(0)
    expect(r.days[0].missingHours).not.toContain(2)
  })

  it('対照: 時間の中で数秒欠けるだけなら、控えの無い時間には数えない（無い秒にだけ数える）', async () => {
    const secs = range(0, DAY_SEC).filter((s) => s % 3600 !== 1800)
    const r = await streamDays([D1], deps({ [D1]: secs }))
    expect(r.days[0].missingHours).toEqual([])
    expect(r.days[0].lostSec).toBe(24)
  })

  it('安全弁: 観測点の版が書かれていない秒では止まる', async () => {
    const noCfg = deps({ [D1]: range(0, 10) }, { cfgOf: () => '' })
    await expect(streamDays([D1], noCfg)).rejects.toThrow(/観測点の版が書かれていない/)
  })
})

describe('streamDays: その時に入らない時刻の秒', () => {
  /** 1 時台（3600〜7199 秒）にだけ、控えの時刻 ms の秒を 1 つ置いた控え */
  const oneFrameIn1h = (ms: number) => {
    const d = deps({ [D1]: [] })
    d.hourFrames = (_day, h) => (h === 1 ? [{ ms, cfg: 'c1', values: new Int8Array(2) }] : [])
    return d
  }
  const h1 = at(D1, 3600)

  it('正: その時の頭の 1 ms 前・次の時の頭・秒の刻みでない時刻は止まる', async () => {
    for (const ms of [h1 - 1, h1 + 3_600_000, h1 + 500]) {
      await expect(streamDays([D1], oneFrameIn1h(ms))).rejects.toThrow(/その時に入らない時刻/)
    }
  })

  it('対照: その時の頭ちょうどと、終わりの秒は流す', async () => {
    for (const ms of [h1, h1 + 3_599_000]) {
      const r = await streamDays([D1], oneFrameIn1h(ms))
      expect(r.days[0].frames).toBe(1)
    }
  })

  it('安全弁: 止めるのは壊れた秒だけで、正常な秒の続きは時をまたいで流れる', async () => {
    const r = await streamDays([D1], deps({ [D1]: range(3500, 3700) }))
    expect(r.days[0].frames).toBe(200)
  })
})

describe('streamDays: 観測点の版', () => {
  const sitesOf = (cfg: string): [number, number][] => (cfg === 'c2' ? [[35, 139], [40, 141], [41, 142]] : SITES)

  it('正: 版が変わる秒で作り直し、その日の観測点は使われた版の和集合にする', async () => {
    const t = deps({ [D1]: range(0, 2000) }, { cfgOf: (_d, s) => (s < 1000 ? 'c1' : 'c2'), sitesOf })
    const r = await streamDays([D1], t)
    expect(t.trackers).toBe(2)
    expect(r.watched[1000 + WARMUP_SEC - 1]).toBe(0)
    expect(r.sitesOfDay.get(D1)).toHaveLength(4)
  })

  it('対照: 版が変わらなければ作り直さず、その日の観測点はその版の点だけ', async () => {
    const t = deps({ [D1]: range(0, 2000) }, { sitesOf })
    const r = await streamDays([D1], t)
    expect(t.trackers).toBe(1)
    expect(r.sitesOfDay.get(D1)).toEqual(SITES)
  })

  it('安全弁: 後の日の新しい版の点で、前の日の観測網を広げない', async () => {
    const full = range(0, DAY_SEC)
    const r = await streamDays([D1, D2], deps({ [D1]: full, [D2]: full }, { cfgOf: (d) => (d === D2 ? 'c2' : 'c1'), sitesOf }))
    expect(r.sitesOfDay.get(D1)).toEqual(SITES)
    expect(r.sitesOfDay.get(D2)).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// 数える
// ---------------------------------------------------------------------------

/** 期間の頭（D1 の 0 時）の実時刻（UTC） */
const FROM_UTC = dayStartMs(D1) - JST_OFFSET_MS

function run(day: string, over: Partial<DayRun> = {}): DayRun {
  return {
    day, frames: DAY_SEC, lostSec: 0, watched: DAY_SEC, longestBlindSec: 0, mismatched: 0, missingHours: [], restarts: [],
    quakeSource: '確定値', quakeCount: 0, unreadableQuakeRows: 0, tableDay: false, ...over,
  }
}

function event(id: string, firstLikelyMs: number, pos: [number, number], over: Partial<EventRow> = {}): EventRow {
  return { id, firstLikelyMs, firstConfirmedMs: null, pos, maxMembers: 2, lastMs: firstLikelyMs, inWarmup: false, ...over }
}

const quake = (t: number, over: Partial<CatalogQuake> = {}): CatalogQuake => ({ t, lat: 35, lng: 139, depth: 10, mag: 2, ...over })

function summarize(over: Partial<Parameters<typeof summarizeRun>[0]>) {
  const days = over.runs?.map((r) => r.day) ?? [D1]
  return summarizeRun({
    runs: days.map((d) => run(d)),
    events: [],
    quakes: [],
    sitesOfDay: new Map(days.map((d) => [d, SITES])),
    watched: new Uint8Array(days.length * DAY_SEC).fill(1),
    fromFrameMs: dayStartMs(D1),
    prevDayQuakes: true,
    prevDayUnreadableRows: 0,
    earlyQuakeDays: [],
    ...over,
  })
}

describe('summarizeRun: 助走の内の検知は数えない', () => {
  it('正・対照: 助走の内の検知は行にも件数にも入らず、助走の外は入る', () => {
    const t = FROM_UTC + 3_600_000
    const s = summarize({
      quakes: [quake(t)],
      events: [
        event('in', t + JST_OFFSET_MS + 5_000, [35, 139], { inWarmup: true }),
        event('out', t + JST_OFFSET_MS + 5_000, [35, 139]),
      ],
    })
    expect(s.rows.map((r) => r.id)).toEqual(['out'])
    expect(s.summary.warmupEvents).toBe(1)
    expect(s.summary.likelyOnly).toBe(1)
  })

  it('安全弁: 助走の内の検知は、偶然でも当たる見込みにも足さない', () => {
    const t = FROM_UTC + 3_600_000
    const only = summarize({ quakes: [quake(t)], events: [event('out', t + JST_OFFSET_MS + 5_000, [35, 139])] })
    const withWarmup = summarize({
      quakes: [quake(t)],
      events: [
        event('in', t + JST_OFFSET_MS + 5_000, [35, 139], { inWarmup: true }),
        event('out', t + JST_OFFSET_MS + 5_000, [35, 139]),
      ],
    })
    expect(withWarmup.chances.has('in')).toBe(false)
    expect(withWarmup.summary.likelyOnlyChance).toBe(only.summary.likelyOnlyChance)
    expect(only.summary.likelyOnlyChance).toBeGreaterThan(0)
  })
})

describe('summarizeRun: 欠けの印', () => {
  it('正: 控えの無い時間・点数の食い違い・読めなかった震源の行のどれかがある日は、欠けのある日として印を付ける', () => {
    for (const over of [{ missingHours: [3] }, { mismatched: 1 }, { unreadableQuakeRows: 1 }]) {
      const s = summarize({ runs: [run(D1, over)] })
      expect(s.summary.complete).toBe(false)
      expect(s.blindDays.map((r) => r.day)).toEqual([D1])
    }
  })

  it('対照: 時間の中で数秒欠けた（無い秒がある）だけの日には印を付けない', () => {
    const s = summarize({ runs: [run(D1, { frames: DAY_SEC - 24, lostSec: 24 })] })
    expect(s.summary.complete).toBe(true)
    expect(s.blindDays).toEqual([])
  })

  it('安全弁: 印を付けるのは欠けのあった日だけ', () => {
    const s = summarize({ runs: [run(D1), run(D2, { missingHours: [0] })], watched: new Uint8Array(2 * DAY_SEC).fill(1) })
    expect(s.summary.complete).toBe(false)
    expect(s.blindDays.map((r) => r.day)).toEqual([D2])
  })
})

describe('summarizeRun: 期間の外から来る欠けの印', () => {
  it('正: 前日の震源に読めなかった行がある・出そろう前の震源リストを使った日があるなら、欠けの印を付けて結果に出す', () => {
    const a = summarize({ prevDayUnreadableRows: 2 })
    expect(a.summary.complete).toBe(false)
    expect(a.summary.prevDayUnreadableRows).toBe(2)
    const b = summarize({ earlyQuakeDays: [D1] })
    expect(b.summary.complete).toBe(false)
    expect(b.summary.earlyQuakeDays).toEqual([D1])
  })

  it('対照: どちらも無ければ印を付けない', () => {
    const s = summarize({})
    expect(s.summary.complete).toBe(true)
    expect(s.summary.prevDayUnreadableRows).toBe(0)
    expect(s.summary.earlyQuakeDays).toEqual([])
  })

  it('安全弁: 期間の外から来る欠けは、欠けのある日（blindDays）には数えない', () => {
    const s = summarize({ prevDayUnreadableRows: 1, earlyQuakeDays: [D1] })
    expect(s.blindDays).toEqual([])
  })
})

describe('summarizeRun: 日本時間と UTC', () => {
  const t = FROM_UTC + 3_600_000

  it('正: 控えの時刻から 9 時間を引いて震源の実時刻と突き合わせる', () => {
    const s = summarize({ quakes: [quake(t)], events: [event('a', t + JST_OFFSET_MS + 5_000, [35, 139])] })
    expect(s.summary.likelyOnlyMatched).toBe(1)
  })

  it('対照: 控えの時刻を実時刻のまま渡した検知（9 時間ずれる）は当たらない', () => {
    const s = summarize({ quakes: [quake(t)], events: [event('a', t + 5_000, [35, 139])] })
    expect(s.summary.likelyOnlyMatched).toBe(0)
  })

  it('安全弁: 当たった震源の時刻は日本時間の ISO 文字列で出す', () => {
    const s = summarize({ quakes: [quake(t)], events: [event('a', t + JST_OFFSET_MS + 5_000, [35, 139])] })
    // D1 の 0 時（日本時間）から 1 時間後
    expect(s.rows[0].matched?.at).toBe('2026-10-24T01:00:00+09:00')
    expect(s.rows[0].firstLikelyAt).toBe('2026-10-24T01:00:05+09:00')
  })
})

describe('summarizeRun: 日をまたぐときの偶然でも当たる見込み', () => {
  // 2 日目の頭の 30 秒前（1 日目の終わり）に起きた地震。揺れが届く窓は 2 日目の 0〜90 秒にかかる
  const tq = FROM_UTC + DAY_MS - 30_000
  // 1 日目は全部見ていて、2 日目は頭の 100 秒だけ見ていた
  const watched = new Uint8Array(2 * DAY_SEC)
  watched.fill(1, 0, DAY_SEC)
  watched.fill(1, DAY_SEC, DAY_SEC + 100)
  const runs = [run(D1), run(D2, { watched: 100 })]
  const pos: [number, number] = [35, 139]
  const q = quake(tq, { depth: NaN })

  it('正: 2 日目の検知は前日の地震も見て、2 日目に見ていた秒だけで割る', () => {
    const s = summarize({ runs, watched, quakes: [q], events: [event('d2', dayStartMs(D2) + 10_000, pos)] })
    expect(s.chances.get('d2')).toBeCloseTo(91 / 100, 10)
  })

  it('対照: 同じ地震でも 1 日目の検知は 1 日目の秒で割る', () => {
    const s = summarize({ runs, watched, quakes: [q], events: [event('d1', dayStartMs(D1) + 3_600_000, pos)] })
    expect(s.chances.get('d1')).toBeCloseTo(40 / DAY_SEC, 10)
  })

  it('安全弁: 2 日目を 1 秒も見ていなければ、1 日目を全部見ていても見込みは 0', () => {
    const onlyD1 = new Uint8Array(2 * DAY_SEC).fill(1, 0, DAY_SEC)
    const s = summarize({ runs: [run(D1), run(D2, { watched: 0 })], watched: onlyD1, quakes: [q], events: [event('d2', dayStartMs(D2) + 10_000, pos)] })
    expect(s.chances.get('d2')).toBe(0)
  })
})

describe('summarizeRun: 期間の内外', () => {
  const big = (t: number) => quake(t, { mag: 3 })
  const edges = [big(FROM_UTC - 1), big(FROM_UTC), big(FROM_UTC + DAY_MS - 1), big(FROM_UTC + DAY_MS)]

  it('正: 秒フレームの無い日の M3 以上は、期間の頭ちょうどと終わりの 1 ms 前までを数える', () => {
    const s = summarize({ quakes: edges, sitesOfDay: new Map() })
    expect(s.summary.noSiteDayTargets).toBe(2)
  })

  it('対照: 見ていない間に起きた網の中の地震も、期間の内だけを数える（前日・翌日に観測点があっても）', () => {
    const sitesOfDay = new Map([['20261023', SITES], [D1, SITES], [D2, SITES]])
    const s = summarize({ quakes: edges, watched: new Uint8Array(DAY_SEC), sitesOfDay })
    expect(s.summary.blindTargets).toBe(2)
  })

  it('安全弁: 期間の終わりの直前の地震は、その後を見続けていないので取りこぼしに数えない', () => {
    const s = summarize({ quakes: edges })
    expect(s.summary.targets).toBe(1)
    expect(s.summary.blindTargets).toBe(1)
  })
})

describe('summarizeRun: 深い地震は分けて数える', () => {
  const t0 = FROM_UTC + 3_600_000
  const quakes = [
    quake(t0, { mag: 3, depth: 100 }),
    quake(t0 + 3_600_000, { mag: 3, depth: 99.9 }),
    quake(t0 + 7_200_000, { mag: 3, depth: NaN }),
  ]

  it('正: 深さ 100 km ちょうどは深い地震に数え、取りこぼしの母数から外す', () => {
    const s = summarize({ quakes })
    expect(s.summary.deepTargets).toBe(1)
    expect(s.summary.targets).toBe(2)
    expect(s.summary.missed).toBe(2)
  })

  it('対照: 深い地震に束が当たれば別の行で数え、浅い地震の取りこぼしは変わらない', () => {
    const s = summarize({ quakes, events: [event('deep', t0 + JST_OFFSET_MS + 20_000, [35, 139])] })
    expect(s.summary.deepWithBundle).toBe(1)
    expect(s.summary.missed).toBe(2)
  })

  it('安全弁: 深さの分からない地震は浅い側に残し、束が当たれば取りこぼしから外れる', () => {
    const s = summarize({ quakes, events: [event('nan', t0 + 7_200_000 + JST_OFFSET_MS + 20_000, [35, 139])] })
    expect(s.summary.deepWithBundle).toBe(0)
    expect(s.summary.missed).toBe(1)
    expect(s.missed.map((q) => q.depth)).toEqual([99.9])
  })
})
