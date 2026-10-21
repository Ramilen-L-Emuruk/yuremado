// 一時ファイルから置き換える rename を、**Windows で別のプロセスが一瞬掴んでいるときだけ**待ってやり直す。
//
// **Windows は、削除の共有を許さずに開かれているファイルを置き換え先にできない**（中身を開かれている
// フォルダの改名も同じ）。Node 側のハンドルを全部閉じていても、ウイルス対策・索引のような外のプロセスが
// 書いた直後のファイルを読みに来ると、その間だけ `rename` が `EPERM`（`EACCES`・`EBUSY` のこともある）で
// 落ちる。PowerShell で削除の共有なしに開いたまま置き換えると、ファイルでもフォルダでも同じ `EPERM` になり、
// 離すと通ることを確かめた（2026-10-21）。開発機の全件テストでは 2026-10-13〜10-15 に 6 回起きた
// （`stationStore.test.ts`・`storageMigration.test.ts`）。実機（ホストの機械）で 2026-10-02〜10-21 に取ったログには
// `EPERM`・`EACCES`・`EBUSY` が 1 度も出ていない（欠けの帳面は 5 秒ごとに置き換えている）。掴み手は特定していない。
//
// - **やり直すのは Windows のこの 3 つの符号だけ。** ほかの失敗（`ENOENT` など）と、Windows 以外では
//   すぐ投げる —— 待っても直らない失敗を遅らせない。`EPERM`・`EACCES` は恒久的な権限不足でも出るので、
//   その場合は 0.63 秒遅れて同じ失敗になる（情報は失わない）
// - **待ちは合計 0.63 秒まで**（`LOCK_RETRY_DELAYS_MS`）。それでも通らなければ、最後の失敗をそのまま投げる。
//   呼び出し側の失敗の扱い（ログ・数える・投げ返す）は今までどおり効く
// - **やり直したことを黙らない。** 待って通ったときも、待っても通らなかったときも 1 行残す。実機で起き始めたら
//   ログで分かる。同じ置き換え先の「通った」は 10 分に 1 回へ間引き、間引いた回数を次の行へ添える
//   （5 秒ごとに書く帳面で掴みが常態化しても、ログを埋めない）
// - **知らせるのは成否が決まった後。** 知らせる側が投げても、置き換えた結果は変わらない
// - 同期版は待つ間スレッドを止める（最悪 0.63 秒）。使うのは `stationStore`（起動時・管理画面の保存）・
//   `hostSettings`（管理画面の保存）・`shakeEventStore`（揺れの記録が閉じるたび。検出と同じスレッド）。
//   止まる間の UDP は受信バッファ（`main.ts` の `UDP_RECV_BUFFER_BYTES` ＝ 8 MB）に溜まり、処理停止の見張り
//   （`loopStall.ts` の 1 秒）にも掛からない長さに収めている

import { renameSync } from 'node:fs'
import { rename } from 'node:fs/promises'

/** 待つ長さ（ミリ秒）。1 回目の失敗の後に 10 ms 待ち、倍々で 6 回まで。合計 630 ms。 */
export const LOCK_RETRY_DELAYS_MS: readonly number[] = [10, 20, 40, 80, 160, 320]

/** 同じ置き換え先の「待って通した」を知らせる間隔の下限（既定のログだけ）。 */
export const LOCK_RETRY_LOG_INTERVAL_MS = 10 * 60_000

/** 掴まれているせいで落ちたとみなす符号（Windows だけ）。 */
const LOCK_CODES: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY'])

/** 待ったあとの結末。 */
export interface LockRetried {
  readonly from: string
  readonly to: string
  /** 待った回数（1 以上）。 */
  readonly retries: number
  /** 最後に掴まれて落ちたときの符号。 */
  readonly code: string
  /** 通ったか（false ＝ 上限まで待っても通らず、最後の失敗を投げた）。 */
  readonly ok: boolean
}

/** テストで差し替える口。本番では渡さない（既定は実物）。 */
interface CommonDeps {
  readonly platform?: NodeJS.Platform
  /** 1 回でも待ったときに、成否が決まった後で呼ぶ。投げても結果は変わらない。 */
  readonly onRetried?: (info: LockRetried) => void
}
export interface LockTolerantRenameSyncDeps extends CommonDeps {
  readonly renameImpl?: (from: string, to: string) => void
  readonly sleepImpl?: (ms: number) => void
}
export interface LockTolerantRenameDeps extends CommonDeps {
  readonly renameImpl?: (from: string, to: string) => Promise<void>
  readonly sleepImpl?: (ms: number) => Promise<void>
}

/** 待てば通りうる失敗か。 */
export function isLockError(error: unknown, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32') return false
  const code = (error as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' && LOCK_CODES.has(code)
}

function codeOf(error: unknown): string {
  return String((error as NodeJS.ErrnoException | null)?.code ?? '')
}

/** 置き換え先ごとの、最後に「通った」を出した時刻と、その後に間引いた回数。 */
const lastLogged = new Map<string, { atMs: number; suppressed: number }>()

/** 既定の知らせ方。行を組むところだけを切り出してテストする。 */
export function retriedLogLine(
  info: LockRetried,
  nowMs: number,
  book: Map<string, { atMs: number; suppressed: number }>,
): string | null {
  const head = `[fs] ${info.from} → ${info.to} の置き換えが掴まれていた（${info.code}）。`
  // 通らなかったときは間引かない（呼び出し側の失敗の記録と突き合わせられるように）
  if (!info.ok) return `${head}${info.retries} 回待っても通らなかった`
  const prev = book.get(info.to)
  if (prev !== undefined && nowMs - prev.atMs < LOCK_RETRY_LOG_INTERVAL_MS) {
    prev.suppressed += 1
    return null
  }
  book.set(info.to, { atMs: nowMs, suppressed: 0 })
  const skipped = prev !== undefined && prev.suppressed > 0 ? `（前の行から ${prev.suppressed} 回は書かずにおいた）` : ''
  return `${head}${info.retries} 回待って通した${skipped}`
}

function logRetried(info: LockRetried): void {
  const line = retriedLogLine(info, Date.now(), lastLogged)
  if (line !== null) console.warn(line)
}

/** 知らせる。知らせる側が投げても、置き換えの結果には響かせない。 */
function notify(deps: CommonDeps, info: LockRetried): void {
  try {
    ;(deps.onRetried ?? logRetried)(info)
  } catch {
    // 知らせられなくても、置き換えたかどうかは決まっている。
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** 同期版。**投げる**（通らなければ最後の失敗をそのまま）。 */
export function lockTolerantRenameSync(from: string, to: string, deps: LockTolerantRenameSyncDeps = {}): void {
  const platform = deps.platform ?? process.platform
  const doRename = deps.renameImpl ?? renameSync
  const sleep = deps.sleepImpl ?? sleepSync
  let code = ''
  for (let attempt = 0; ; attempt++) {
    let failure: unknown = null
    try {
      doRename(from, to)
    } catch (error) {
      failure = error
    }
    if (failure === null) {
      if (attempt > 0) notify(deps, { from, to, retries: attempt, code, ok: true })
      return
    }
    if (!isLockError(failure, platform)) throw failure
    code = codeOf(failure)
    if (attempt >= LOCK_RETRY_DELAYS_MS.length) {
      notify(deps, { from, to, retries: attempt, code, ok: false })
      throw failure
    }
    sleep(LOCK_RETRY_DELAYS_MS[attempt])
  }
}

/** 非同期版。**投げる**（通らなければ最後の失敗をそのまま）。 */
export async function lockTolerantRename(from: string, to: string, deps: LockTolerantRenameDeps = {}): Promise<void> {
  const platform = deps.platform ?? process.platform
  const doRename = deps.renameImpl ?? rename
  const sleep = deps.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let code = ''
  for (let attempt = 0; ; attempt++) {
    let failure: unknown = null
    try {
      await doRename(from, to)
    } catch (error) {
      failure = error
    }
    if (failure === null) {
      if (attempt > 0) notify(deps, { from, to, retries: attempt, code, ok: true })
      return
    }
    if (!isLockError(failure, platform)) throw failure
    code = codeOf(failure)
    if (attempt >= LOCK_RETRY_DELAYS_MS.length) {
      notify(deps, { from, to, retries: attempt, code, ok: false })
      throw failure
    }
    await sleep(LOCK_RETRY_DELAYS_MS[attempt])
  }
}
