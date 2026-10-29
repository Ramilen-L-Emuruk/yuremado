/**
 * 組み合わせの揺れ検知器を Web Worker で動かすときの、主スレッド側の代理。
 *
 * 口は並走の係（`EnsembleShadow`）と同じなので、呼び出す側は Worker で動いているかを知らなくてよい。
 * 1 フレームの処理は 1133 点で平均 3.4 ms・最も重い秒で 12 ms、助走は最大 900 フレームを一度に渡す
 * （`kyoshinEnsembleShadow.ts` の冒頭）。主スレッドで区切って回すと、その間ずっと描画の合間を食う。
 *
 * **作り直しは世代番号で区切る。** `reset` と観測点集合の入れ替えのたびに世代を上げて Worker へ伝え、
 * 今の世代でない結果・捨てた知らせは数えずに捨てる（伝言の形と理由は `kyoshinEnsembleWorkerHost.ts`）。
 *
 * **Worker が立たない・落ちた・黙ったときは、主スレッドの係へ切り替える。** 黙ったとは、積んだフレームの返事を待って
 * いるのに `silenceMs` の間 Worker から何も届かないこと（無限ループ・止まったままの Worker）。実時間で測る ——
 * 助走は最大 900 フレームを一度に積むので、待っている件数や、結果のデータ時刻の遅れでは正当な処理と見分けられない。
 * 切り替えた時点で Worker の中に積んでいたフレームは失われる（次のフレームから続ける）。主スレッドで処理し直さないのは、
 * 黙った原因が特定のフレームでの無限ループなら、同じフレームで画面ごと止まるから。失った件数（うち画面へ出さない
 * フレームの件数）は `onFallback` で知らせる。切り替えは 1 度きりで、戻さない。
 */
import { createEnsembleShadow, type EnsembleShadow, type EnsembleShadowOptions, type ShadowFrame } from './kyoshinEnsembleShadow'
import type { EnsembleWorkerRequest, EnsembleWorkerResponse } from './kyoshinEnsembleWorkerHost'
import type { QuietTables } from './kyoshinQuietTables'

/** Worker の口（`Worker` そのもの。テストでは偽物） */
export interface EnsembleWorkerLike {
  postMessage(msg: EnsembleWorkerRequest, transfer?: Transferable[]): void
  onmessage: ((ev: { data: EnsembleWorkerResponse }) => void) | null
  onerror: ((ev: unknown) => void) | null
  onmessageerror: ((ev: unknown) => void) | null
  terminate(): void
}

export interface EnsembleWorkerClientOptions {
  /** Worker を作る。作れなければ例外を投げる（そのときは初めから主スレッドの係で動く） */
  createWorker: () => EnsembleWorkerLike
  /** Worker の中で 1 回に処理してよい時間（ミリ秒） */
  workerSliceMs: number
  /** 主スレッドの係へ切り替えたときに使う設定。`onResult`・`onDrop`・`onError` は Worker で動くときも使う */
  fallback: EnsembleShadowOptions
  /**
   * 返事を待っているのに Worker から何も届かないまま、この時間（ミリ秒・`fallback.now` の時計）が過ぎたら主スレッドの係へ
   * 切り替える。助走の最大 900 フレームでも Worker の中の処理は約 3 秒（`kyoshinEnsembleShadow.ts` の冒頭）
   */
  silenceMs: number
  /**
   * 主スレッドの係へ切り替えたとき（Worker を作れなかった・落ちた・黙った）。記録に使う。
   * `lost` は Worker の中に積んだまま返事の無かったフレームの数と、そのうち画面へ出さないフレーム（助走など）の数
   */
  onFallback: (reason: unknown, lost: { frames: number; silentFrames: number }) => void
}

/**
 * Worker の `onerror` が渡す ErrorEvent を、文面と位置の入った Error にする。ErrorEvent をそのまま記録へ渡すと、
 * 多くの環境で `[object ErrorEvent]` としか残らず、落ちた原因が追えない
 */
export function workerFailureReason(ev: unknown): unknown {
  if (ev instanceof Error) return ev
  if (typeof ev === 'object' && ev !== null) {
    const e = ev as { message?: unknown; filename?: unknown; lineno?: unknown; colno?: unknown; type?: unknown }
    if (typeof e.message === 'string' && e.message !== '') {
      const where = typeof e.filename === 'string' && e.filename !== '' ? `（${e.filename}:${String(e.lineno ?? '?')}:${String(e.colno ?? '?')}）` : ''
      return new Error(`Worker が落ちました: ${e.message}${where}`)
    }
    if (typeof e.type === 'string') return new Error(`Worker が落ちました（${e.type}・文面なし）`)
  }
  return ev
}

export function createEnsembleWorkerClient(initialTables: QuietTables, opts: EnsembleWorkerClientOptions): EnsembleShadow {
  const { onResult, onDrop, onError } = opts.fallback
  let tables = initialTables
  let sites: [number, number][] | null = null
  let sitesKey: string | null = null
  let gen = 0
  /** 今の世代で Worker へ積み、まだ結果・知らせの返っていないフレームの数 */
  let pending = 0
  /** `pending` のうち、画面へ出さないフレーム（`silent`）の数 */
  let pendingSilent = 0
  let disposed = false
  let worker: EnsembleWorkerLike | null = null
  let local: EnsembleShadow | null = null
  /** Worker から最後に何か届いた時刻（返事を待ち始めた時刻を含む） */
  let lastHeard = opts.fallback.now()

  function toLocal(reason: unknown): void {
    if (local !== null || disposed) return
    if (worker !== null) {
      worker.onmessage = null
      worker.onerror = null
      worker.onmessageerror = null
      worker.terminate()
      worker = null
    }
    const lost = { frames: pending, silentFrames: pendingSilent }
    pending = 0
    pendingSilent = 0
    local = createEnsembleShadow(tables, opts.fallback)
    if (sites !== null && sitesKey !== null) local.setSites(sites, sitesKey)
    opts.onFallback(reason, lost)
  }

  function onMessage(msg: EnsembleWorkerResponse): void {
    if (disposed) return
    // 古い世代の返事も、Worker が動いている印にはなる
    lastHeard = opts.fallback.now()
    if (msg.gen !== gen) return
    pending = Math.max(0, pending - 1)
    if (msg.silent) pendingSilent = Math.max(0, pendingSilent - 1)
    if (msg.type === 'result') {
      // 世代が今と同じなら、Worker が処理した観測点集合は今の集合（入れ替えると世代が上がる）
      if (sites === null || msg.sitesKey !== sitesKey) return
      onResult({ ms: msg.ms, detections: msg.detections, values: msg.values, sites, sitesKey: msg.sitesKey, silent: msg.silent })
    } else if (msg.type === 'drop') {
      onDrop(msg.reason, { ms: msg.ms, indices: [], sitesKey: msg.sitesKey, silent: msg.silent })
    } else {
      onError(new Error(`組み合わせの検知器（Worker）が例外を投げました: ${msg.message}`), { ms: msg.ms, indices: [], sitesKey: msg.sitesKey, silent: msg.silent })
    }
  }

  try {
    worker = opts.createWorker()
    worker.onmessage = (ev) => onMessage(ev.data)
    worker.onerror = (ev) => toLocal(workerFailureReason(ev))
    worker.onmessageerror = (ev) => toLocal(workerFailureReason(ev))
    worker.postMessage({ type: 'init', tables, sliceMs: opts.workerSliceMs, resumeGapMs: opts.fallback.resumeGapMs })
  } catch (err) {
    worker = null
    toLocal(err)
  }

  /** いま主スレッドの係で動いていれば、その係（送れずに切り替わった直後にも読み直すため関数にしている） */
  const localShadow = (): EnsembleShadow | null => local

  /** Worker へ送る。送れなければ主スレッドの係へ切り替え、false を返す */
  function send(msg: EnsembleWorkerRequest, transfer?: Transferable[]): boolean {
    if (worker === null) return false
    try {
      worker.postMessage(msg, transfer)
      return true
    } catch (err) {
      toLocal(err)
      return false
    }
  }

  return {
    setSites(next, key) {
      if (disposed || (key === sitesKey && sites !== null)) return
      sites = next.map(([lat, lng]) => [lat, lng])
      sitesKey = key
      if (local !== null) { local.setSites(sites, key); return }
      gen++
      pending = 0
      pendingSilent = 0
      if (!send({ type: 'sites', gen, sites, sitesKey: key })) localShadow()?.setSites(sites, key)
    },
    setTables(next) {
      if (disposed) return
      tables = next
      if (local !== null) { local.setTables(next); return }
      if (!send({ type: 'tables', tables: next })) localShadow()?.setTables(next)
    },
    reset() {
      if (disposed) return
      if (local !== null) { local.reset(); return }
      gen++
      pending = 0
      pendingSilent = 0
      if (!send({ type: 'reset', gen })) localShadow()?.reset()
    },
    enqueue(frames: readonly ShadowFrame[]) {
      if (disposed || frames.length === 0) return
      if (local !== null) { local.enqueue(frames); return }
      const packed = frames.map((f) => ({ ms: f.ms, indices: Int8Array.from(f.indices), sitesKey: f.sitesKey, silent: f.silent }))
      if (send({ type: 'frames', frames: packed }, packed.map((f) => f.indices.buffer))) {
        // 待っていなかったなら、ここから黙っている時間を測る
        if (pending === 0) lastHeard = opts.fallback.now()
        pending += packed.length
        for (const f of packed) if (f.silent) pendingSilent++
        return
      }
      localShadow()?.enqueue(frames)
    },
    backlog: () => (local !== null ? local.backlog() : pending),
    checkResponsive() {
      if (disposed || local !== null || worker === null || pending === 0) return
      const silent = opts.fallback.now() - lastHeard
      if (silent > opts.silenceMs) toLocal(new Error(`Worker が ${Math.round(silent / 1000)} 秒応答しません（返事を待っているフレーム ${pending} 件）`))
    },
    dispose() {
      disposed = true
      local?.dispose()
      if (worker !== null) {
        worker.onmessage = null
        worker.onerror = null
        worker.onmessageerror = null
        worker.terminate()
        worker = null
      }
    },
  }
}
