import { describe, expect, it } from 'vitest'
import type { DetectorFrame, EnsembleReport } from './kyoshinEnsembleDetector'
import { createEnsembleShadow, type EnsembleShadowOptions, type ShadowDropReason, type ShadowFrame, type ShadowResult } from './kyoshinEnsembleShadow'
import type { EnsembleReporter } from './kyoshinEnsembleTracker'
import { createEnsembleWorkerClient, workerFailureReason, type EnsembleWorkerLike } from './kyoshinEnsembleWorkerClient'
import { attachEnsembleWorkerHost, type EnsembleWorkerRequest, type EnsembleWorkerResponse } from './kyoshinEnsembleWorkerHost'
import { FALLBACK_QUIET_TABLES } from './kyoshinQuietTablesLoader'

const SITES: [number, number][] = [[35, 135], [35.1, 135]]
const SILENCE_MS = 30_000
const T0 = Date.UTC(2026, 0, 1)
const frame = (sec: number, sitesKey = 'A', indices: number[] = [8, 8], silent = false): ShadowFrame => ({ ms: T0 + sec * 1000, indices, sitesKey, silent })

/** 秒 0 から 2 秒ごとに 1 つの束を報告し、1 秒目以降は確かな段にする偽の束ね役 */
const reporter = (): EnsembleReporter => ({
  setTables: () => {},
  push: (f: DetectorFrame): EnsembleReport[] => {
    const sec = (f.ms - T0) / 1000
    if (sec % 2 !== 0) return []
    return [{ id: 'e1', tier: sec >= 2 ? 'confirmed' : 'early', lat: 35, lng: 135, startMs: T0, sites: [0], sources: ['stat'] }]
  },
})

/**
 * 代理と受け口を、伝言を手で配る偽の Worker で繋ぐ。`deliver` を呼ぶまで伝言は相手へ届かない。
 * Worker の中の区切りも `runWorker` で手で回す。
 */
function wire() {
  const toWorker: EnsembleWorkerRequest[] = []
  const toClient: EnsembleWorkerResponse[] = []
  const workerTasks: (() => void)[] = []
  let hostHandler: ((m: EnsembleWorkerRequest) => void) | null = null
  let terminated = false
  attachEnsembleWorkerHost(
    { postMessage: (m) => { toClient.push(structuredClone(m)) }, setMessageHandler: (fn) => { hostHandler = fn } },
    { createReporter: reporter, schedule: (fn) => { workerTasks.push(fn); return () => {} }, now: () => 0 },
  )
  const fake: EnsembleWorkerLike = {
    postMessage: (m) => { toWorker.push(structuredClone(m)) },
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    terminate: () => { terminated = true },
  }
  const results: ShadowResult[] = []
  const drops: ShadowDropReason[] = []
  const errors: unknown[] = []
  const fallbacks: unknown[] = []
  const losts: { frames: number; silentFrames: number }[] = []
  const localTasks: (() => void)[] = []
  let clock = 0
  const fallback: EnsembleShadowOptions = {
    createReporter: reporter,
    schedule: (fn) => { localTasks.push(fn); return () => {} },
    now: () => clock,
    sliceMs: 1_000,
    resumeGapMs: 60_000,
    onResult: (r) => results.push(r),
    onDrop: (reason) => drops.push(reason),
    onError: (err) => errors.push(err),
  }
  const client = createEnsembleWorkerClient(FALLBACK_QUIET_TABLES, {
    createWorker: () => fake,
    workerSliceMs: 1_000,
    silenceMs: SILENCE_MS,
    fallback,
    onFallback: (r, lost) => { fallbacks.push(r); losts.push(lost) },
  })
  /** 主スレッド → Worker の伝言を配り、Worker の区切りを回す（結果は toClient に溜まったまま） */
  const runWorker = () => {
    for (const m of toWorker.splice(0)) hostHandler?.(m)
    while (workerTasks.length > 0) workerTasks.shift()?.()
  }
  /** runWorker に続けて、Worker → 主スレッドの伝言を配る */
  const deliver = () => {
    runWorker()
    for (const m of toClient.splice(0)) fake.onmessage?.({ data: m })
  }
  /** 主スレッドの時計を進める（Worker が黙った時間の見張りに使う） */
  const advance = (ms: number) => { clock += ms }
  return { client, fake, toWorker, toClient, results, drops, errors, fallbacks, losts, localTasks, runWorker, deliver, advance, terminated: () => terminated }
}

/** 同じ入力を主スレッドの係へ同期で流したときの結果 */
function syncResults(frames: ShadowFrame[]): ShadowResult[] {
  const out: ShadowResult[] = []
  const s = createEnsembleShadow(FALLBACK_QUIET_TABLES, {
    createReporter: reporter, schedule: (fn) => { fn(); return () => {} }, now: () => 0, sliceMs: 1_000, resumeGapMs: 60_000,
    onResult: (r) => out.push(r), onDrop: () => {}, onError: () => {},
  })
  s.setSites(SITES, 'A')
  s.enqueue(frames)
  return out
}

describe('組み合わせの検知器を Web Worker で動かす代理', () => {
  it('正: Worker 越しでも、主スレッドで同期に流したときと同じ検知・震度の段・観測点を返す', () => {
    const w = wire()
    const frames = [frame(0), frame(1, 'A', [10, -1]), frame(2), frame(3)]
    w.client.setSites(SITES, 'A')
    w.client.enqueue(frames)
    w.deliver()
    const expected = syncResults(frames)
    expect(w.results.map((r) => ({ ms: r.ms, d: r.detections, v: [...r.values], sites: r.sites, key: r.sitesKey })))
      .toEqual(expected.map((r) => ({ ms: r.ms, d: r.detections, v: [...r.values], sites: r.sites, key: r.sitesKey })))
    expect(w.fallbacks).toEqual([])
  })

  it('正: 画面へ出さない印（silent）を Worker の往復で落とさない', () => {
    const w = wire()
    w.client.setSites(SITES, 'A')
    w.client.enqueue([frame(0, 'A', [8, 8], true), frame(1)])
    w.deliver()
    expect(w.results.map((r) => [(r.ms - T0) / 1000, r.silent])).toEqual([[0, true], [1, false]])
  })

  it('正: 震度の段は Int8Array にして転送する（伝言は構造化複製で配る）', () => {
    const w = wire()
    w.client.setSites(SITES, 'A')
    w.client.enqueue([frame(0, 'A', [5, -1])])
    const sent = w.toWorker.find((m) => m.type === 'frames')
    expect(sent?.type === 'frames' && sent.frames[0].indices).toBeInstanceOf(Int8Array)
  })

  it('正: まだ返っていないフレームの数を backlog に出し、返るたびに減らす', () => {
    const w = wire()
    w.client.setSites(SITES, 'A')
    w.client.enqueue([frame(0), frame(1), frame(2)])
    expect(w.client.backlog()).toBe(3)
    w.deliver()
    expect(w.client.backlog()).toBe(0)
  })

  it('対照: reset の前に積んだフレームの結果は、後から届いても捨てる', () => {
    const w = wire()
    w.client.setSites(SITES, 'A')
    w.client.enqueue([frame(0), frame(1)])
    // Worker は reset を受け取る前に処理し終えて返す（結果はまだ主スレッドへ届いていない）
    w.runWorker()
    expect(w.toClient.filter((m) => m.type === 'result')).toHaveLength(2)
    w.client.reset()
    w.deliver()
    expect(w.results).toEqual([])
    expect(w.client.backlog()).toBe(0)
  })

  it('対照: 観測点集合を入れ替える前の結果も捨て、入れ替えた後の結果だけ返す', () => {
    const w = wire()
    w.client.setSites(SITES, 'A')
    w.client.enqueue([frame(0, 'A')])
    w.runWorker()
    expect(w.toClient.filter((m) => m.type === 'result')).toHaveLength(1)
    w.client.setSites([[36, 140], [36.1, 140]], 'B')
    w.client.enqueue([frame(1, 'B')])
    w.deliver()
    expect(w.results.map((r) => [r.sitesKey, (r.ms - T0) / 1000])).toEqual([['B', 1]])
    expect(w.results[0].sites).toEqual([[36, 140], [36.1, 140]])
  })

  it('正: 捨てたフレームも理由ごとに知らせる', () => {
    const w = wire()
    w.client.setSites(SITES, 'A')
    w.client.enqueue([frame(1), frame(0)])
    w.deliver()
    expect(w.drops).toEqual(['not-newer'])
    expect(w.client.backlog()).toBe(0)
  })

  it('安全弁: Worker を作れなければ、初めから主スレッドの係で動かす', () => {
    const results: number[] = []
    const fallbacks: unknown[] = []
    const client = createEnsembleWorkerClient(FALLBACK_QUIET_TABLES, {
      createWorker: () => { throw new Error('使えない') },
      workerSliceMs: 50,
      silenceMs: SILENCE_MS,
      fallback: {
        createReporter: reporter, schedule: (fn) => { fn(); return () => {} }, now: () => 0, sliceMs: 1_000, resumeGapMs: 60_000,
        onResult: (r) => results.push((r.ms - T0) / 1000), onDrop: () => {}, onError: () => {},
      },
      onFallback: (r) => fallbacks.push(r),
    })
    client.setSites(SITES, 'A')
    client.enqueue([frame(0), frame(1)])
    expect(results).toEqual([0, 1])
    expect(fallbacks).toHaveLength(1)
  })

  it('安全弁: Worker が落ちたら主スレッドの係へ切り替え、観測点集合を引き継いで続ける', () => {
    const w = wire()
    w.client.setSites(SITES, 'A')
    w.client.enqueue([frame(0)])
    w.deliver()
    w.fake.onerror?.(new Error('落ちた'))
    expect(w.terminated()).toBe(true)
    expect(w.fallbacks).toHaveLength(1)
    w.client.enqueue([frame(1)])
    while (w.localTasks.length > 0) w.localTasks.shift()?.()
    expect(w.results.map((r) => (r.ms - T0) / 1000)).toEqual([0, 1])
    // 切り替えた後は Worker へ何も送らない
    expect(w.toWorker).toEqual([])
  })

  it('正: 返事を待っているのに Worker が黙ったまま時間が過ぎたら、主スレッドの係へ切り替える', () => {
    const w = wire()
    w.client.setSites(SITES, 'A')
    w.client.enqueue([frame(0)])
    // Worker は伝言を受け取らない（止まっている）
    w.advance(SILENCE_MS + 1)
    w.client.checkResponsive()
    expect(w.terminated()).toBe(true)
    expect(w.fallbacks).toHaveLength(1)
    expect(String(w.fallbacks[0])).toContain('応答しません')
    // 切り替えた後は主スレッドの係で続ける
    w.client.enqueue([frame(1)])
    while (w.localTasks.length > 0) w.localTasks.shift()?.()
    expect(w.results.map((r) => (r.ms - T0) / 1000)).toEqual([1])
  })

  it('正: 切り替えるとき、返事の無かったフレームの数とそのうち画面へ出さないフレームの数を知らせる', () => {
    const w = wire()
    w.client.setSites(SITES, 'A')
    w.client.enqueue([frame(0, 'A', [8, 8], true), frame(1, 'A', [8, 8], true), frame(2)])
    w.advance(SILENCE_MS + 1)
    w.client.checkResponsive()
    expect(w.losts).toEqual([{ frames: 3, silentFrames: 2 }])
  })

  it('対照: 返事の届いたフレームは失った数に入れない', () => {
    const w = wire()
    w.client.setSites(SITES, 'A')
    w.client.enqueue([frame(0, 'A', [8, 8], true), frame(1)])
    w.deliver()
    w.client.enqueue([frame(2)])
    w.advance(SILENCE_MS + 1)
    w.client.checkResponsive()
    expect(w.losts).toEqual([{ frames: 1, silentFrames: 0 }])
  })

  it('対照: 返事が届き続けていれば、長く動いていても切り替えない', () => {
    const w = wire()
    w.client.setSites(SITES, 'A')
    for (let s = 0; s < 5; s++) {
      w.client.enqueue([frame(s)])
      w.advance(SILENCE_MS - 1)
      w.deliver()
      w.client.checkResponsive()
    }
    expect(w.fallbacks).toEqual([])
    expect(w.terminated()).toBe(false)
  })

  it('安全弁: 返事を待っていなければ、長く何も届かなくても切り替えない（静かなのは正常）', () => {
    const w = wire()
    w.client.setSites(SITES, 'A')
    w.client.enqueue([frame(0)])
    w.deliver()
    w.advance(SILENCE_MS * 10)
    w.client.checkResponsive()
    expect(w.fallbacks).toEqual([])
  })

  it('安全弁: 片付けた後は、遅れて届いた結果を返さない', () => {
    const w = wire()
    w.client.setSites(SITES, 'A')
    w.client.enqueue([frame(0)])
    const handler = w.fake.onmessage
    w.runWorker()
    expect(w.toClient.filter((m) => m.type === 'result')).toHaveLength(1)
    w.client.dispose()
    expect(w.terminated()).toBe(true)
    for (const m of w.toClient.splice(0)) handler?.({ data: m })
    expect(w.results).toEqual([])
  })
})

describe('workerFailureReason（Worker が落ちた理由を記録に残せる形にする）', () => {
  it('正: ErrorEvent の文面と位置を Error へ移す', () => {
    const r = workerFailureReason({ type: 'error', message: '読めません', filename: 'kyoshinEnsemble.worker.js', lineno: 3, colno: 7 })
    expect(r).toBeInstanceOf(Error)
    expect(String(r)).toContain('読めません')
    expect(String(r)).toContain('kyoshinEnsemble.worker.js:3:7')
  })

  it('対照: 文面の無い ErrorEvent（読み込みに失敗した Worker など）も、種類を残した Error にする', () => {
    expect(String(workerFailureReason({ type: 'error', message: '' }))).toContain('error')
  })

  it('安全弁: もとから Error ならそのまま返す（主スレッドで投げた例外・黙った見張り）', () => {
    const err = new Error('使えない')
    expect(workerFailureReason(err)).toBe(err)
  })
})
