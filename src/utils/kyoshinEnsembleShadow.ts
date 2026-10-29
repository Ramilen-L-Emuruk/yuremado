/**
 * 組み合わせの揺れ検知器（`kyoshinEnsembleDetector.ts`）へフレームを積み、区切って処理する係。
 *
 * Web Worker の中で動かすのが普通で（`kyoshinEnsembleWorkerHost.ts`）、Worker が立たないときは主スレッドで動かす
 * （`kyoshinEnsembleWorkerClient.ts`）。結果は `onResult` で 1 フレームずつ返す。
 *
 * **フレームは待ち行列に積み、1 回 `sliceMs` までで区切って次へ譲る。** 1 フレームの処理は 1133 点で平均 3.4 ms・
 * 最も重い秒で 12 ms（2026-10-28・能登 2023 の窓で実測）。助走は最大 900 フレームを一度に渡すので、まとめて
 * 処理すると約 3 秒画面が止まる。区切っても順序は変わらないので、検知の結果は同期で流したときと同じになる。
 *
 * 作り直すのは 4 つのとき —— 観測点集合が替わった・時間軸が変わった（`reset`）・フレームの間隔が `resumeGapMs` を
 * 超えて空いた・検知器が例外を投げた（途中まで進んだ状態のまま続けない）。作り直すと、点ごとの直前のゆらぎの履歴も消える。
 * 作り直しそのものが投げたら検知器を持たないまま進め、次のフレームで作り直す（そのフレームは例外として捨てる）。
 * 平常のゆらぎの表が届いたとき（配る表・端末で学び直した表）は作り直さず、検知器へ差し替える。
 */
import { createEnsembleTracker, type EnsembleDetection, type EnsembleReporter } from './kyoshinEnsembleTracker'
import type { QuietTables } from './kyoshinQuietTables'

/** 係へ積む 1 秒ぶん。 */
export interface ShadowFrame {
  /** データ時刻（ミリ秒） */
  ms: number
  /** 計測震度のインデックス（Yahoo の生の値。負は欠測）。Worker へ渡すときは `Int8Array` にして転送する */
  indices: ArrayLike<number>
  /** このフレームが属する観測点集合の識別子 */
  sitesKey: string
  /**
   * 結果を画面へ出さないフレームか。助走・全滅区間の取り直し・待たせていた分（最後の 1 件を除く）は真。
   * 検知器の状態を進めるために食わせる過去の秒で、その結果を出すと、直前の揺れの音・通知・タブの移動が
   * 起動やリプレイの開始のたびに繰り返される
   */
  silent: boolean
}

/** 1 フレームを処理し終えたときに渡すもの。 */
export interface ShadowResult {
  ms: number
  detections: EnsembleDetection[]
  /** このフレームの観測点の並びの震度の段（平常のゆらぎを学び直す係へ渡す） */
  values: Int8Array
  /** このフレームを食わせた観測点の座標と、その集合の識別子 */
  sites: readonly (readonly [number, number])[]
  sitesKey: string
  /** 積んだフレームの `silent` をそのまま返す */
  silent: boolean
}

/** フレームを捨てた理由。 */
export type ShadowDropReason = 'sites-mismatch' | 'not-newer' | 'no-sites'

export interface EnsembleShadowOptions {
  /** 束ね役を作る（アプリでは `createEnsembleDetector`。テストでは偽物を渡す） */
  createReporter: (sites: [number, number][], tables: QuietTables) => EnsembleReporter
  /** 次の区切りを予約する（ブラウザでは `setTimeout(fn, 0)`）。戻り値で取り消せる */
  schedule: (fn: () => void) => () => void
  /** 区切りの長さを測る時計（ミリ秒） */
  now: () => number
  /** 1 回の区切りで処理してよい時間（ミリ秒） */
  sliceMs: number
  /** この幅を超えてフレームが空いたら作り直す（ミリ秒。`kyoshinNoiseFloor.ts` の `MAX_RESUME_GAP_MS`） */
  resumeGapMs: number
  /** 1 フレームを処理し終えるたびに呼ぶ */
  onResult: (r: ShadowResult) => void
  /** フレームを捨てたとき。数えるだけで、処理は止めない */
  onDrop: (reason: ShadowDropReason, frame: ShadowFrame) => void
  /** 検知器が例外を投げたとき・作れなかったとき。そのフレームは捨てて続ける */
  onError: (err: unknown, frame: ShadowFrame) => void
}

export interface EnsembleShadow {
  /** 観測点集合を渡す。識別子が替わったら作り直す */
  setSites(sites: readonly (readonly [number, number])[], sitesKey: string): void
  /** 平常のゆらぎの表を渡す。作り直さず検知器へ差し替え、以後の作り直しでもこの表を使う */
  setTables(tables: QuietTables): void
  /** 時間軸が変わった。積んだフレームを捨てて作り直す */
  reset(): void
  /** 時刻の昇順で積む。前に積んだ時刻以下のものは捨てる */
  enqueue(frames: readonly ShadowFrame[]): void
  /** まだ処理していないフレームの数 */
  backlog(): number
  /**
   * 結果が返ってこなくなっていないかを確かめる（毎秒呼ぶ）。Worker の代理だけが見張り、主スレッドの係では何もしない
   * （同じ処理の中で回るので、黙ることがない）
   */
  checkResponsive(): void
  /** 予約した区切りを取り消し、以後は何もしない */
  dispose(): void
}

export function createEnsembleShadow(initialTables: QuietTables, opts: EnsembleShadowOptions): EnsembleShadow {
  let tables = initialTables
  let sites: [number, number][] | null = null
  let sitesKey: string | null = null
  let tracker: ReturnType<typeof createEnsembleTracker> | null = null
  /** 最後に処理したフレームの時刻（間隔の判定に使う） */
  let lastProcessedMs = -Infinity
  /** 最後に積んだフレームの時刻（同じ時刻・巻き戻りを積まないため） */
  let lastQueuedMs = -Infinity
  const queue: ShadowFrame[] = []
  let cancel: (() => void) | null = null
  let disposed = false
  /** 最後の作り直しが投げた例外（作れていれば null）。次のフレームで作り直し、作れなければそのフレームの例外にする */
  let buildError: unknown = null

  function rebuild(): void {
    lastProcessedMs = -Infinity
    buildError = null
    if (sites === null) { tracker = null; return }
    try {
      tracker = createEnsembleTracker(sites, opts.createReporter(sites, tables))
    } catch (err) {
      tracker = null
      buildError = err
    }
  }

  function pump(): void {
    cancel = null
    if (disposed) return
    const until = opts.now() + opts.sliceMs
    while (queue.length > 0 && opts.now() < until) {
      const f = queue.shift() as ShadowFrame
      if (sites === null) { opts.onDrop('no-sites', f); continue }
      if (f.sitesKey !== sitesKey) { opts.onDrop('sites-mismatch', f); continue }
      if (tracker === null || (f.ms - lastProcessedMs > opts.resumeGapMs && lastProcessedMs !== -Infinity)) rebuild()
      if (tracker === null) { opts.onError(buildError, f); continue }
      let result: ShadowResult
      try {
        const values = Int8Array.from(f.indices)
        const detections = tracker.push({ ms: f.ms, values })
        lastProcessedMs = f.ms
        result = { ms: f.ms, detections, values, sites, sitesKey: f.sitesKey, silent: f.silent }
      } catch (err) {
        opts.onError(err, f)
        // 途中まで進んだ状態（統計は進み波面は進んでいない、など）で続けない
        rebuild()
        continue
      }
      opts.onResult(result)
    }
    if (queue.length > 0) cancel = opts.schedule(pump)
  }

  return {
    setSites(next, key) {
      if (key === sitesKey && sites !== null) return
      sites = next.map(([lat, lng]) => [lat, lng])
      sitesKey = key
      // 前の集合で積んだまま処理していないフレームは、入れ替えの正規の残りなので黙って外す。残すと
      // 「観測点集合が合わない」の捨てとして数えられ、本当にずれているときの記録と混ざる。Worker では
      // その捨ての知らせが新しい世代の名で返り、代理の待ち件数を減らして見張りを効かなくする
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i].sitesKey !== key) queue.splice(i, 1)
      rebuild()
    },
    setTables(next) {
      // 作り直さず差し替える。端末での学び直し（`kyoshinQuietLearner`）が毎時渡すので、作り直すと
      // そのたびに点ごとの直前のゆらぎの履歴と追っている検知が消え、揺れの最中なら検知が途切れる
      tables = next
      tracker?.setTables(next)
    },
    reset() {
      queue.length = 0
      lastQueuedMs = -Infinity
      rebuild()
    },
    enqueue(frames) {
      if (disposed) return
      for (const f of frames) {
        if (f.ms <= lastQueuedMs) { opts.onDrop('not-newer', f); continue }
        lastQueuedMs = f.ms
        queue.push(f)
      }
      if (queue.length > 0 && cancel === null) cancel = opts.schedule(pump)
    },
    backlog: () => queue.length,
    checkResponsive() {},
    dispose() {
      disposed = true
      queue.length = 0
      cancel?.()
      cancel = null
    },
  }
}
