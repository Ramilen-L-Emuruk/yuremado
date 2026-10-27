// 管理画面から頼まれた流し直し（`redetect.ts`）を、別のプロセスで 1 本ずつ走らせる係（#313）。
//
// **ホストのプロセスの中では流さない**（2026-10-27 ユーザー承認「別プロセスで起動」）。流し直しは
// 控えを何時間分も読み、P2PQuake へ 6.5 秒おきに問い合わせるので、受信と同じイベントループに載せると
// 受信が止まる。道具は元から「ホストが動いたままでよい」作り（控えは読むだけ・既にある記録は上書きしない）。
//
// **同時に走らせるのは 1 本だけ。** 2 本目は断る（`busy`）。同じ期間を 2 本で流すと、P2PQuake への
// 問い合わせが倍になり、どちらが書いたかも分からなくなる。
//
// 終わったら、道具が `--summary` に書いた結果を読んで、書いた件数・既にあった件数・失敗の理由を持つ。
// **理由は道具がログに出した文をそのまま使う**（2026-10-27 ユーザー承認「道具の文をそのまま」）。
//
// **子全体に時間切れは置かない。** 全期間を流すと何時間もかかりうる一方、固まりうる外への取得
// （P2PQuake）は道具の中で 1 件ずつ時間切れを持つ（`redetect.ts` の `FETCH_TIMEOUT_MS`）。

/** `redetect.ts --summary` が書く結果。 */
import type { DetectionSettings } from '../detection/detectionSettings'

export interface RedetectSummaryFile {
  readonly ok: boolean
  /** 書いた揺れの数（全観測点の合計）。 */
  readonly written: number
  /** 既にあったので書かなかった揺れの数。 */
  readonly existing: number
  /** 失敗として扱った理由（ログに出した文そのもの。出た順）。 */
  readonly problems: readonly string[]
  /**
   * 失敗にはしないが、流せなかった所の知らせ（読めなかった控えの時間。ログに出した文そのもの）。
   * **成功の行に添えて赤で出す**（2026-10-27 ユーザー承認「3 つとも足す」）。黙ると「流し直した」が
   * 起こせていない揺れを隠す。
   */
  readonly warnings: readonly string[]
}

/** 管理画面から頼まれる流し直しの範囲。 */
export interface RedetectRequest {
  readonly fromMs: number
  readonly toMs: number
  /** 流す観測点（null ならすべて）。 */
  readonly stationId: string | null
}

export type RedetectRunState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running'; readonly startedAtMs: number; readonly request: RedetectRequest }
  | {
      readonly kind: 'done'
      readonly startedAtMs: number
      readonly finishedAtMs: number
      readonly request: RedetectRequest
      readonly ok: boolean
      /** 結果を読めたときだけ数がある。 */
      readonly written: number | null
      readonly existing: number | null
      /** 失敗したときの理由（成功なら null）。 */
      readonly reason: string | null
      /** 成功したが流せなかった所（{@link RedetectSummaryFile.warnings}）。結果を読めなければ空。 */
      readonly warnings: readonly string[]
    }

/** 子が終わったときの知らせ。 */
export interface RedetectExit {
  /** 終了コード（シグナルで止まった・起動できなかったときは null）。 */
  readonly code: number | null
  /** 止めたシグナル（`SIGTERM` など）。 */
  readonly signal: string | null
  /** 起動できなかったときの文。 */
  readonly error: string | null
}

/** 起こした子プロセス。終わり方は 1 度だけ知らせる。 */
export interface RedetectChild {
  onExit(listener: (exit: RedetectExit) => void): void
  kill(): void
}

/** `node:child_process` の `ChildProcess` のうち、ここで使う分（テストで偽物を渡せるように）。 */
export interface ChildProcessLike {
  /** 起動できなかったときは undefined。 */
  readonly pid?: number | undefined
  once(event: 'error', listener: (error: Error) => void): unknown
  once(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown
  kill(): boolean
}

/**
 * `ChildProcess` を {@link RedetectChild} へ写す。
 *
 * **`error` を終わりとして扱うのは、起動できなかった（`pid` が無い）ときだけ。** Node の `error` は
 * `kill()` に失敗したときにも出る —— そこで終わりとすると、子が生きたまま次の流し直しを受け付けて
 * 2 本が並ぶ。起動した後の `error` はログへ残して `exit` を待つ。
 */
export function adaptRedetectChild(child: ChildProcessLike, log: (line: string) => void): RedetectChild {
  return {
    onExit: (listener) => {
      child.once('error', (error) => {
        if (child.pid === undefined) listener({ code: null, signal: null, error: error.message })
        else log(`[redetect] 流し直しの子（pid ${child.pid}）で失敗が起きた（終わるのを待つ）: ${error.message}`)
      })
      child.once('exit', (code, signal) => listener({ code, signal, error: null }))
    },
    kill: () => {
      if (!child.kill()) log(`[redetect] 流し直しの子（pid ${child.pid ?? '?'}）を止められなかった`)
    },
  }
}

/** 結果のファイルを読むのに使う分（テストで偽物を渡せるように）。 */
export interface SummaryFileOps {
  readonly readFile: (path: string) => string
  readonly unlink: (path: string) => void
}

/**
 * 結果のファイルを読んで消す（無い・読めないなら null）。
 *
 * **読むのと消すのを分ける。** 消せなかっただけで読めた結果を捨てると、うまくいった流し直しが
 * 「結果を読めなかった」に化ける。無い（ENOENT）のは子が書く前に止まった印なので黙ってよいが、
 * それ以外の読めなさ・消せなさは理由をログに残す。
 */
export function readRedetectSummaryFile(path: string, ops: SummaryFileOps, warn: (line: string) => void): string | null {
  let text: string
  try {
    text = ops.readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      warn(`[redetect] 流し直しの結果のファイルを読めなかった: ${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
    return null
  }
  try {
    ops.unlink(path)
  } catch (error) {
    warn(`[redetect] 流し直しの結果のファイルを消せなかった: ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return text
}

export interface RedetectRunnerDeps {
  /** 道具へ渡す引数で子を起こす（`redetect.ts` の後ろに続く分だけ）。 */
  readonly spawn: (args: readonly string[]) => RedetectChild
  /** 結果のファイルの置き場所（回ごとに別の名前）。 */
  readonly summaryPath: () => string
  /** 結果のファイルを読む（無い・読めないなら null）。読んだ後に消すのも呼び出し側。 */
  readonly readSummary: (path: string) => string | null
  /** 道具へ渡す置き場所。ホストと同じ場所を見させる（保存先は管理画面で変えられるため）。 */
  readonly dirs: () => { readonly wave: string; readonly events: string; readonly stations: string }
  /** いまのホストが使っている検出の値。子へそのまま渡す（`redetect.ts` の `--detection`）。 */
  readonly detection: DetectionSettings
  readonly now: () => number
  readonly log: (line: string) => void
}

export type RedetectStartResult = 'started' | 'busy' | 'bad-range'

/** 結果のファイルを読む。形が違えば null（「結果を読めなかった」として扱う）。 */
export function parseRedetectSummary(text: string): RedetectSummaryFile | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const count = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
  const lines = (v: unknown): v is string[] => Array.isArray(v) && v.every((p) => typeof p === 'string')
  if (typeof r.ok !== 'boolean' || !count(r.written) || !count(r.existing)) return null
  if (!lines(r.problems) || !lines(r.warnings)) return null
  return { ok: r.ok, written: r.written, existing: r.existing, problems: r.problems, warnings: r.warnings }
}

/** 道具へ渡す引数（`--from`・`--to` は ISO の文字列。道具は `Date.parse` で読む）。 */
export function redetectArgs(
  request: RedetectRequest,
  dirs: { readonly wave: string; readonly events: string; readonly stations: string },
  summaryPath: string,
  detection: DetectionSettings,
): string[] {
  const args = [
    '--from',
    new Date(request.fromMs).toISOString(),
    '--to',
    new Date(request.toMs).toISOString(),
    '--wave',
    dirs.wave,
    '--events',
    dirs.events,
    '--stations',
    dirs.stations,
    '--summary',
    summaryPath,
    '--detection',
    JSON.stringify(detection),
  ]
  if (request.stationId !== null) args.push('--station', request.stationId)
  return args
}

/** 終わり方と結果から、失敗の理由を決める（成功なら null）。 */
export function redetectFailureReason(exit: RedetectExit, summary: RedetectSummaryFile | null): string | null {
  if (exit.error !== null) return `起動できなかった: ${exit.error}`
  // 道具が理由を書いていれば、終了コードより先にそれを出す（何が起きたかが分かる）。
  if (summary !== null && summary.problems.length > 0 && (!summary.ok || exit.code !== 0)) return summary.problems.join('／')
  // **シグナルで止まったときは、終了コード（null）ではなくシグナルを言う**（2026-10-27 ユーザー承認「案のとおり出す」）。
  if (exit.code === null && exit.signal !== null) return `シグナル ${exit.signal} で止まった`
  if (exit.code !== 0) return `終了コード ${exit.code ?? '?'}`
  if (summary === null) return '結果を読めなかった'
  if (!summary.ok) return `終了コード ${exit.code}`
  return null
}

export class RedetectRunner {
  private state: RedetectRunState = { kind: 'idle' }
  private child: RedetectChild | null = null
  /** 止めるのを頼んだか（締めくくりとプロセスの終わりの両方から呼ばれても、ログと kill を 1 度にする）。 */
  private stopping = false

  constructor(private readonly deps: RedetectRunnerDeps) {}

  current(): RedetectRunState {
    return this.state
  }

  start(request: RedetectRequest): RedetectStartResult {
    if (!Number.isFinite(request.fromMs) || !Number.isFinite(request.toMs) || request.fromMs >= request.toMs) {
      return 'bad-range'
    }
    if (this.state.kind === 'running') return 'busy'
    const startedAtMs = this.deps.now()
    const summaryPath = this.deps.summaryPath()
    this.state = { kind: 'running', startedAtMs, request }
    // **running にした後で投げうるものは、すべてこの try の中に置く。** 外で投げると子も終わりの
    // 知らせも無いまま running が残り、以後の流し直しがホストを起こし直すまで `busy` で断られる
    // （日付にならない範囲で `toISOString()` が投げたことがある）。
    let child: RedetectChild
    try {
      const station = request.stationId ?? 'すべての観測点'
      this.deps.log(
        `[redetect] 管理画面から流し直しを始めた（${new Date(request.fromMs).toISOString()} 〜 ${new Date(request.toMs).toISOString()}・${station}）`,
      )
      child = this.deps.spawn(redetectArgs(request, this.deps.dirs(), summaryPath, this.deps.detection))
    } catch (e) {
      this.finish(request, startedAtMs, { code: null, signal: null, error: e instanceof Error ? e.message : String(e) }, summaryPath)
      return 'started'
    }
    this.child = child
    let settled = false
    child.onExit((exit) => {
      if (settled) return
      settled = true
      this.child = null
      this.stopping = false
      this.finish(request, startedAtMs, exit, summaryPath)
    })
    return 'started'
  }

  /** 締めくくりのときに走っている子を止める（記録は一時ファイル経由で置き換えるので、途中で止めても壊れない）。 */
  stop(): void {
    if (this.child === null || this.stopping) return
    this.stopping = true
    // **止めたことをログに残す。** 起動し直したホストは何も覚えていないので、ログに無いと
    // 流し直しが途中で消えた理由を後から辿れない。
    this.deps.log('[redetect] ホストの締めくくりで流し直しを止めた')
    this.child.kill()
  }

  private finish(request: RedetectRequest, startedAtMs: number, exit: RedetectExit, summaryPath: string): void {
    const text = exit.error === null ? this.deps.readSummary(summaryPath) : null
    const summary = text === null ? null : parseRedetectSummary(text)
    const reason = redetectFailureReason(exit, summary)
    const warnings = summary?.warnings ?? []
    this.state = {
      kind: 'done',
      startedAtMs,
      finishedAtMs: this.deps.now(),
      request,
      ok: reason === null,
      written: summary?.written ?? null,
      existing: summary?.existing ?? null,
      reason,
      warnings,
    }
    this.deps.log(
      reason === null
        ? `[redetect] 管理画面からの流し直しが終わった: 書いた ${summary?.written ?? '?'} 件・既にあった ${summary?.existing ?? '?'} 件` +
            (warnings.length > 0 ? `（流せなかった所 ${warnings.length} 件）` : '')
        : `[redetect] 管理画面からの流し直しがうまくいかなかった: ${reason}`,
    )
  }
}
