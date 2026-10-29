/**
 * 組み合わせの揺れ検知器を Web Worker の中で動かす受け口と、主スレッドとの間でやり取りする伝言の形。
 *
 * Worker の中では並走の係（`kyoshinEnsembleShadow.ts`）をそのまま動かす。区切り（`sliceMs`）は主スレッドより
 * 長くてよい —— 区切るのは画面を止めないためではなく、作り直しの伝言（`reset`・観測点集合の入れ替え）を
 * 次の区切りで受け取るため。
 *
 * **世代番号。** 主スレッドは作り直すたびに世代を上げて伝える。Worker は処理した時点の世代を結果に付けて返し、
 * 主スレッドは今の世代でない結果を捨てる。伝言は送った順に届くので、作り直しより前に積んだフレームの結果は
 * 必ず古い世代を名乗る。
 *
 * 受け口は Worker の外でも動く（`attachEnsembleWorkerHost` に伝言の口を渡す）。テストはこれを主スレッドの
 * 代理（`kyoshinEnsembleWorkerClient.ts`）と直に繋いで確かめる。
 */
import { createEnsembleDetector } from './kyoshinEnsembleDetector'
import { createEnsembleShadow, type ShadowDropReason } from './kyoshinEnsembleShadow'
import type { EnsembleDetection, EnsembleReporter } from './kyoshinEnsembleTracker'
import type { QuietTables } from './kyoshinQuietTables'

/** 主スレッド → Worker */
export type EnsembleWorkerRequest =
  | { type: 'init'; tables: QuietTables; sliceMs: number; resumeGapMs: number }
  | { type: 'sites'; gen: number; sites: [number, number][]; sitesKey: string }
  | { type: 'tables'; tables: QuietTables }
  | { type: 'reset'; gen: number }
  /** `indices` は `Int8Array` で転送する */
  | { type: 'frames'; frames: { ms: number; indices: Int8Array; sitesKey: string; silent: boolean }[] }

/** Worker → 主スレッド */
export type EnsembleWorkerResponse =
  /** `values` は転送する */
  | { type: 'result'; gen: number; ms: number; detections: EnsembleDetection[]; values: Int8Array; sitesKey: string; silent: boolean }
  | { type: 'drop'; gen: number; reason: ShadowDropReason; ms: number; sitesKey: string; silent: boolean }
  | { type: 'error'; gen: number; ms: number; sitesKey: string; silent: boolean; message: string }

/** 伝言の口。Worker では `self`、テストでは偽物 */
export interface EnsembleWorkerPort {
  postMessage(msg: EnsembleWorkerResponse, transfer?: Transferable[]): void
  setMessageHandler(fn: (msg: EnsembleWorkerRequest) => void): void
}

export interface EnsembleWorkerHostOptions {
  /** 束ね役を作る（既定は `createEnsembleDetector`。テストでは偽物を渡す） */
  createReporter?: (sites: [number, number][], tables: QuietTables) => EnsembleReporter
  schedule?: (fn: () => void) => () => void
  now?: () => number
}

export function attachEnsembleWorkerHost(port: EnsembleWorkerPort, opts: EnsembleWorkerHostOptions = {}): void {
  let shadow: ReturnType<typeof createEnsembleShadow> | null = null
  let gen = 0
  port.setMessageHandler((msg) => {
    if (msg.type === 'init') {
      shadow?.dispose()
      shadow = createEnsembleShadow(msg.tables, {
        createReporter: opts.createReporter ?? createEnsembleDetector,
        schedule: opts.schedule ?? ((fn) => {
          const id = setTimeout(fn, 0)
          return () => clearTimeout(id)
        }),
        now: opts.now ?? (() => performance.now()),
        sliceMs: msg.sliceMs,
        resumeGapMs: msg.resumeGapMs,
        onResult: (r) => {
          port.postMessage({ type: 'result', gen, ms: r.ms, detections: r.detections, values: r.values, sitesKey: r.sitesKey, silent: r.silent }, [r.values.buffer])
        },
        onDrop: (reason, f) => port.postMessage({ type: 'drop', gen, reason, ms: f.ms, sitesKey: f.sitesKey, silent: f.silent }),
        onError: (err, f) => {
          const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
          port.postMessage({ type: 'error', gen, ms: f.ms, sitesKey: f.sitesKey, silent: f.silent, message })
        },
      })
      return
    }
    // 初期化より前の伝言は来ない（代理は作った直後に init を送る）。来たら捨てる
    if (shadow === null) return
    switch (msg.type) {
      case 'sites':
        gen = msg.gen
        shadow.setSites(msg.sites, msg.sitesKey)
        return
      case 'tables':
        shadow.setTables(msg.tables)
        return
      case 'reset':
        gen = msg.gen
        shadow.reset()
        return
      case 'frames':
        shadow.enqueue(msg.frames)
        return
    }
  })
}
