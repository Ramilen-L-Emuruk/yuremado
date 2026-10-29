import { describe, expect, it } from 'vitest'
import type { DetectorFrame, EnsembleReport } from './kyoshinEnsembleDetector'
import {
  createEnsembleShadow,
  type ShadowDropReason,
  type ShadowFrame,
} from './kyoshinEnsembleShadow'
import type { EnsembleReporter } from './kyoshinEnsembleTracker'
import type { QuietTables } from './kyoshinQuietTables'
import { FALLBACK_QUIET_TABLES } from './kyoshinQuietTablesLoader'

const SITES: [number, number][] = [[35, 135], [35.1, 135]]
const T0 = Date.UTC(2026, 0, 1)
const frame = (sec: number, sitesKey = 'A', indices: number[] = [8, 8], silent = false): ShadowFrame => ({ ms: T0 + sec * 1000, indices, sitesKey, silent })

/**
 * 区切りを手で回す偽の環境。束ね役は 1 フレームごとに時計を `costMs` 進め、受け取った時刻を記録する。
 * `createReporter` が呼ばれた回数で作り直しを数える。
 */
function harness(costMs: number, sliceMs = 10) {
  let clock = 0
  const tasks: (() => void)[] = []
  const pushed: number[] = []
  const results: number[] = []
  const drops: ShadowDropReason[] = []
  const errors: unknown[] = []
  let builds = 0
  const tablesSet: QuietTables[] = []
  const reporter = (): EnsembleReporter => ({
    setTables: (t) => { tablesSet.push(t) },
    push: (f: DetectorFrame): EnsembleReport[] => {
      clock += costMs
      pushed.push((f.ms - T0) / 1000)
      return f.ms === T0 ? [{ id: 'e1', tier: 'early', lat: 35, lng: 135, startMs: T0, sites: [0], sources: ['stat'] }] : []
    },
  })
  const shadow = createEnsembleShadow(FALLBACK_QUIET_TABLES, {
    createReporter: () => { builds++; return reporter() },
    schedule: (fn) => { tasks.push(fn); return () => { const i = tasks.indexOf(fn); if (i >= 0) tasks.splice(i, 1) } },
    now: () => clock,
    sliceMs,
    resumeGapMs: 60_000,
    onResult: (r) => results.push((r.ms - T0) / 1000),
    onDrop: (reason) => drops.push(reason),
    onError: (err) => errors.push(err),
  })
  /** 予約された区切りを 1 つだけ回す。回したら true */
  const runOne = (): boolean => { const t = tasks.shift(); if (!t) return false; t(); return true }
  const runAll = (): number => { let n = 0; while (runOne()) n++; return n }
  return { shadow, tasks, pushed, results, drops, errors, tablesSet, builds: () => builds, runOne, runAll }
}

describe('組み合わせの検知器の並走', () => {
  it('正: 画面へ出さない印（silent）を、積んだフレームから結果へそのまま渡す', () => {
    const got: [number, boolean][] = []
    const s = createEnsembleShadow(FALLBACK_QUIET_TABLES, {
      createReporter: () => ({ setTables: () => {}, push: () => [] }),
      schedule: (fn) => { fn(); return () => {} }, now: () => 0, sliceMs: 1_000, resumeGapMs: 60_000,
      onResult: (r) => got.push([(r.ms - T0) / 1000, r.silent]), onDrop: () => {}, onError: () => {},
    })
    s.setSites(SITES, 'A')
    s.enqueue([frame(0, 'A', [8, 8], true), frame(1, 'A', [8, 8], true), frame(2)])
    expect(got).toEqual([[0, true], [1, true], [2, false]])
  })

  it('正: 積んだフレームを時刻の順に食わせ、1 フレームごとに結果を返す', () => {
    const h = harness(1)
    h.shadow.setSites(SITES, 'A')
    h.shadow.enqueue([frame(0), frame(1), frame(2)])
    h.runAll()
    expect(h.pushed).toEqual([0, 1, 2])
    expect(h.results).toEqual([0, 1, 2])
    expect(h.shadow.backlog()).toBe(0)
  })

  it('正: 結果には、学び直しの係へ渡す震度の段・観測点の座標・集合の識別子も載せる', () => {
    const got: { values: number[]; sites: (readonly [number, number])[]; sitesKey: string }[] = []
    const shadow = createEnsembleShadow(FALLBACK_QUIET_TABLES, {
      createReporter: () => ({ setTables: () => {}, push: () => [] }),
      schedule: (fn) => { fn(); return () => {} },
      now: () => 0,
      sliceMs: 10,
      resumeGapMs: 60_000,
      onResult: (r) => got.push({ values: [...r.values], sites: [...r.sites], sitesKey: r.sitesKey }),
      onDrop: () => {}, onError: () => {},
    })
    shadow.setSites(SITES, 'A')
    shadow.enqueue([frame(0, 'A', [5, -1])])
    expect(got).toEqual([{ values: [5, -1], sites: SITES, sitesKey: 'A' }])
  })

  it('正: 区切りの長さを使い切ったら次の区切りへ譲り、順序は変えない', () => {
    // 1 フレーム 6 ms・区切り 10 ms → 1 区切りで 2 フレーム（6 ms 経った時点ではまだ 10 ms 未満なので 2 つ目を処理する）
    const h = harness(6)
    h.shadow.setSites(SITES, 'A')
    h.shadow.enqueue([frame(0), frame(1), frame(2), frame(3), frame(4)])
    h.runOne()
    expect(h.pushed).toEqual([0, 1])
    expect(h.tasks).toHaveLength(1)
    expect(h.shadow.backlog()).toBe(3)
    h.runAll()
    expect(h.pushed).toEqual([0, 1, 2, 3, 4])
  })

  it('対照: 積むのは 1 回で、処理はその場ではなく予約した区切りで始める', () => {
    const h = harness(1)
    h.shadow.setSites(SITES, 'A')
    h.shadow.enqueue([frame(0)])
    h.shadow.enqueue([frame(1)])
    expect(h.pushed).toEqual([])
    expect(h.tasks).toHaveLength(1)
  })

  it('安全弁: 前に積んだ時刻以下のフレームは捨てる（助走・待たせた分・ライブが重なっても二度食わせない）', () => {
    const h = harness(1)
    h.shadow.setSites(SITES, 'A')
    h.shadow.enqueue([frame(0), frame(1)])
    h.shadow.enqueue([frame(1), frame(0), frame(2)])
    h.runAll()
    expect(h.pushed).toEqual([0, 1, 2])
    expect(h.drops).toEqual(['not-newer', 'not-newer'])
  })

  it('安全弁: 観測点集合が違うフレームは食わせない', () => {
    const h = harness(1)
    h.shadow.setSites(SITES, 'A')
    h.shadow.enqueue([frame(0, 'B'), frame(1, 'A')])
    h.runAll()
    expect(h.pushed).toEqual([1])
    expect(h.drops).toEqual(['sites-mismatch'])
  })

  it('正: 観測点集合を入れ替えたら、前の集合で積んだまま処理していないフレームは黙って外す', () => {
    const h = harness(1)
    h.shadow.setSites(SITES, 'A')
    h.shadow.enqueue([frame(0, 'A'), frame(1, 'A')])
    h.shadow.setSites(SITES, 'B')
    h.shadow.enqueue([frame(2, 'B')])
    h.runAll()
    expect(h.pushed).toEqual([2])
    expect(h.drops).toEqual([])
  })

  it('対照: 入れ替えた後に届いた前の集合のフレームは、合わないフレームとして数える', () => {
    const h = harness(1)
    h.shadow.setSites(SITES, 'A')
    h.shadow.setSites(SITES, 'B')
    h.shadow.enqueue([frame(0, 'A'), frame(1, 'B')])
    h.runAll()
    expect(h.pushed).toEqual([1])
    expect(h.drops).toEqual(['sites-mismatch'])
  })

  it('安全弁: 観測点集合をまだ受け取っていなければ食わせない', () => {
    const h = harness(1)
    h.shadow.enqueue([frame(0)])
    h.runAll()
    expect(h.pushed).toEqual([])
    expect(h.drops).toEqual(['no-sites'])
  })

  it('安全弁: 間隔が作り直しの幅を超えて空いたら作り直す（旧エンジンと同じ幅）', () => {
    const h = harness(1)
    h.shadow.setSites(SITES, 'A')
    expect(h.builds()).toBe(1)
    h.shadow.enqueue([frame(0), frame(60), frame(121)])
    h.runAll()
    // 0→60 秒はちょうど幅なので作り直さない。60→121 秒は超えるので作り直す
    expect(h.builds()).toBe(2)
    expect(h.pushed).toEqual([0, 60, 121])
  })

  it('安全弁: 時間軸が変わったら積んだ分を捨て、過去の時刻も受け付け直す', () => {
    const h = harness(1)
    h.shadow.setSites(SITES, 'A')
    h.shadow.enqueue([frame(10), frame(11)])
    h.shadow.reset()
    h.shadow.enqueue([frame(0)])
    h.runAll()
    expect(h.pushed).toEqual([0])
  })

  it('安全弁: 同じ観測点集合を渡し直しても作り直さない（作り直すと直前のゆらぎの履歴が消える）', () => {
    const h = harness(1)
    h.shadow.setSites(SITES, 'A')
    h.shadow.setSites(SITES, 'A')
    expect(h.builds()).toBe(1)
    h.shadow.setSites(SITES, 'B')
    expect(h.builds()).toBe(2)
  })

  it('正（作り直していた形を覆した）: 平常のゆらぎの表が届いたら、作り直さず検知器へ差し替える', () => {
    const h = harness(1)
    h.shadow.setSites(SITES, 'A')
    h.shadow.enqueue([frame(0)])
    h.runAll()
    h.shadow.setTables(FALLBACK_QUIET_TABLES)
    expect(h.builds()).toBe(1)
    expect(h.tablesSet).toEqual([FALLBACK_QUIET_TABLES])
  })

  it('安全弁: 差し替えた表は、観測点が替わって作り直したときにも使う', () => {
    // 作り直しのときに束ね役へ渡る表を拾う
    const seen: QuietTables[] = []
    const next: QuietTables = { ...FALLBACK_QUIET_TABLES, days: ['20260911'] }
    const shadow = createEnsembleShadow(FALLBACK_QUIET_TABLES, {
      createReporter: (_s, t) => { seen.push(t); return { push: () => [], setTables: () => {} } },
      schedule: () => () => {}, now: () => 0, sliceMs: 10, resumeGapMs: 60_000,
      onResult: () => {}, onDrop: () => {}, onError: () => {},
    })
    shadow.setTables(next)
    shadow.setSites(SITES, 'A')
    expect(seen).toEqual([next])
  })

  it('安全弁: 点数が合わないフレームは例外として知らせ、続きは止めない', () => {
    const h = harness(1)
    h.shadow.setSites(SITES, 'A')
    h.shadow.enqueue([frame(0, 'A', [8]), frame(1)])
    h.runAll()
    expect(h.errors).toHaveLength(1)
    expect(h.results).toEqual([1])
  })

  it('正: 検知器が例外を投げたら作り直す（途中まで進んだ状態のまま続けない）', () => {
    const h = harness(1)
    h.shadow.setSites(SITES, 'A')
    expect(h.builds()).toBe(1)
    h.shadow.enqueue([frame(0, 'A', [8]), frame(1)])
    h.runAll()
    expect(h.errors).toHaveLength(1)
    expect(h.builds()).toBe(2)
  })

  it('対照: 例外が無ければ作り直さない', () => {
    const h = harness(1)
    h.shadow.setSites(SITES, 'A')
    h.shadow.enqueue([frame(0), frame(1)])
    h.runAll()
    expect(h.builds()).toBe(1)
  })

  it('安全弁: 作り直しそのものが投げても止まらず、そのフレームを例外として知らせ、次のフレームで作り直す', () => {
    let failNext = true
    let builds = 0
    const errors: unknown[] = []
    const results: number[] = []
    const s = createEnsembleShadow(FALLBACK_QUIET_TABLES, {
      createReporter: () => {
        builds++
        if (failNext) { failNext = false; throw new Error('作れない') }
        return { setTables: () => {}, push: () => [] }
      },
      schedule: (fn) => { fn(); return () => {} }, now: () => 0, sliceMs: 1_000, resumeGapMs: 60_000,
      onResult: (r) => results.push((r.ms - T0) / 1000), onDrop: () => {}, onError: (e) => errors.push(e),
    })
    // 観測点集合を渡したときの作り直しが投げる（ここで外へ投げない）
    expect(() => s.setSites(SITES, 'A')).not.toThrow()
    s.enqueue([frame(0), frame(1)])
    // 秒 0 で作り直し、作れたのでそのまま食わせる
    expect(builds).toBe(2)
    expect(errors).toEqual([])
    expect(results).toEqual([0, 1])
  })

  it('安全弁: 作り直しが投げ続けたら、フレームごとに例外として知らせる（黙って捨てない）', () => {
    const errors: unknown[] = []
    const s = createEnsembleShadow(FALLBACK_QUIET_TABLES, {
      createReporter: () => { throw new Error('作れない') },
      schedule: (fn) => { fn(); return () => {} }, now: () => 0, sliceMs: 1_000, resumeGapMs: 60_000,
      onResult: () => {}, onDrop: () => {}, onError: (e) => errors.push(e),
    })
    s.setSites(SITES, 'A')
    s.enqueue([frame(0), frame(1)])
    expect(errors).toHaveLength(2)
    expect(String(errors[0])).toContain('作れない')
  })

  it('安全弁: 片付けたら予約を取り消し、以後は積んでも何もしない', () => {
    const h = harness(1)
    h.shadow.setSites(SITES, 'A')
    h.shadow.enqueue([frame(0)])
    h.shadow.dispose()
    expect(h.tasks).toHaveLength(0)
    h.shadow.enqueue([frame(1)])
    expect(h.tasks).toHaveLength(0)
    expect(h.pushed).toEqual([])
  })
})
