// 生成データ（public/data/*.json）のローダが共通で使う JSON 取得ヘルパー。
//
// 素の fetch はタイムアウトを持たないため、接続だけ張れて応答が返らない回線では
// Promise が永久に pending になる。呼び出し側は .then も .catch も呼ばれないまま
// 「読み込み中」で固まり、取得失敗時のフォールバック（区域塗り → 観測点ドット等）も
// 失敗ログも発生しない。それを避けるため、生成データの取得は必ずここを通す。

import { retryDelayAfter } from './retrySchedule'
import { log } from './logger'

/**
 * 生成データ取得のタイムアウト（ミリ秒）。
 *
 * 生成データは初回表示時にほぼ同時に要求されるため、1 本あたりではなく合計で見積もる。
 * gzip 後の合計は約 1.7MB（最大は `subregions.json` の約 680KB）で、低速 3G 相当
 * （実効 50KB/s ≒ 35 秒）でも取り切れる余裕を持たせた値。
 *
 * 値を詰めないこと。短くしても遅い回線の表示が早くなるわけではなく、正常な取得を
 * 打ち切った側の損失のほうが大きい。取り直し（{@link FetchJsonOptions.retryDelay}）は 1 回ごとに
 * この上限を持つので、短くするとそのぶん取り直しの回数を無駄に使う。
 */
export const DATA_FETCH_TIMEOUT_MS = 60_000

/**
 * abort によって中断された例外か。
 * `DOMException` は `Error` を継承しないため instanceof ではなく name で判定する。
 */
function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError'
}

/** 取れていないデータ 1 つ。 */
export interface DataLoadFailure {
  /** 取得の名前（`fetchJsonWithTimeout` の `label`） */
  label: string
  /** `retrying` … 間隔を空けて取り直している／`gaveUp` … 取り直しを諦めた（再読み込みまで戻らない） */
  state: 'retrying' | 'gaveUp'
}

/** 生成データの取得状況。UI（MapDataStatus）が購読する。 */
export interface DataLoadStatus {
  /** 取得中のデータ数 */
  pending: number
  /** 取得に失敗し、まだ取り直せていないデータ数（`failures.length` と同じ） */
  failed: number
  /** 取れていないデータ（名前を画面に出すため。並びは失敗した順） */
  failures: readonly DataLoadFailure[]
}

// 取得状況は label 単位で持つ。全ローダがこのヘルパーを通るため、ここで数えれば
// 個々のフックに状態を持たせなくても「今いくつ取得中か・いくつ落ちたか」が分かる。
//
// 取得中は「あるか無いか」ではなく本数を数える。同じ label で複数の取得が同時に走ることが
// あり（実地震テストシナリオの連続再生など）、Set だと 1 本終わっただけで残りが in-flight でも
// 「取得中が無くなった」と見えてしまう。
const pendingCounts = new Map<string, number>()
// Map は入れた順を保つので、画面の名前の並びは失敗した順になる
const failedLabels = new Map<string, DataLoadFailure['state']>()

function addPending(label: string): void {
  pendingCounts.set(label, (pendingCounts.get(label) ?? 0) + 1)
}

function removePending(label: string): void {
  const rest = (pendingCounts.get(label) ?? 0) - 1
  if (rest > 0) pendingCounts.set(label, rest)
  else pendingCounts.delete(label)
}
const statusListeners = new Set<() => void>()
// useSyncExternalStore は getSnapshot が同じ状態に対して同じ参照を返すことを要求する
// （毎回新しいオブジェクトを作ると再レンダリングが止まらない）ため、変化時だけ作り直す。
let statusSnapshot: DataLoadStatus = { pending: 0, failed: 0, failures: [] }

function sameFailures(a: readonly DataLoadFailure[]): boolean {
  if (a.length !== failedLabels.size) return false
  let i = 0
  for (const [label, state] of failedLabels) {
    if (a[i].label !== label || a[i].state !== state) return false
    i++
  }
  return true
}

function publishStatus(): void {
  if (statusSnapshot.pending === pendingCounts.size && sameFailures(statusSnapshot.failures)) return
  const failures = [...failedLabels].map(([label, state]) => ({ label, state }))
  statusSnapshot = { pending: pendingCounts.size, failed: failures.length, failures }
  for (const fn of statusListeners) fn()
}

/** 取得状況の変化を購読する。戻り値は購読解除関数。 */
export function subscribeDataLoadStatus(fn: () => void): () => void {
  statusListeners.add(fn)
  return () => {
    statusListeners.delete(fn)
  }
}

/** 現在の取得状況を返す（同じ状態なら同じ参照を返す）。 */
export function getDataLoadStatus(): DataLoadStatus {
  return statusSnapshot
}

export interface FetchJsonOptions {
  /** タイムアウト（既定は {@link DATA_FETCH_TIMEOUT_MS}） */
  timeoutMs?: number
  /**
   * 取得状況（{@link getDataLoadStatus}）の集計対象にするか。既定は true。
   *
   * 集計結果は地図に重ねて表示するため、地図の見た目に関係しないデータは false にする。
   * 読み上げの句区切り辞書は音声にしか影響せず、実地震テストシナリオは設定タブ側に専用の
   * エラー表示がある。これらを数えると、地図が欠けていないのに「データを取得できませんでした」と
   * 地図上に出て利用者を誤解させる。
   */
  trackStatus?: boolean
  /**
   * 取り出した中身を検分する。想定外なら例外を投げること（戻り値は見ない）。
   *
   * **通信の成否だけでは配信の破損を捉えられない。** ビルドや配信が壊れて `{}` や `[]` が 200 で
   * 返ると、呼び出し側は「取得成功・0 件」として扱ってしまい、地図から要素が消えているのに失敗と
   * して検知されない。
   *
   * ここに渡す理由は**失敗の数え方**にある。取得後に呼び出し側で検証しても、この関数は既に
   * 成功として返した後——失敗の記録（{@link getDataLoadStatus}）は消され、地図の「〇〇を取り込めず」に
   * 出ず、取り直しも走らない。検分をこの中で行えば、通信失敗と同じ扱いになる。**呼び出し側の `.then()` に置くと、console にしか残らない。**
   */
  validate?: (data: unknown) => void
  /**
   * 失敗を `failures` 回重ねたあと、次に取り直すまでの間隔（ms）。`null` で諦める。
   *
   * **既定は、取得状況に数えるデータ（`trackStatus`）だけ共有の規則で取り直す**（30 秒から倍々・5 回。
   * → `utils/retrySchedule.ts`。2026-10-23 ユーザー選択「取り直し、欠けたものを名前で出す (Recommended)」）。
   * 地図のデータは要求元が 1 箇所しかないものが多く（活断層・プレート境界・津波海岸線・津波観測点）、
   * その 1 回が失敗すると再読み込みまで欠けたままになる。**数えないデータは取り直さない** —— 震源カタログ・
   * 気象庁の地震一覧は呼び手が自分の取り直しを持っていて、ここでも取り直すと二重になる。
   *
   * 取り直している間も Promise は解決しないまま待つ（呼び手は取れた時点でそのまま描ける）。
   */
  retryDelay?: (failures: number) => number | null
}

/** 取り直さない（{@link FetchJsonOptions.retryDelay} に渡す）。 */
export const NO_RETRY = (): null => null

/**
 * 取り直しの既定。数えるデータだけ共有の規則で取り直す（{@link FetchJsonOptions.retryDelay}）。
 *
 * **テストの実行中（`mode === 'test'`）は取り直さない。** 生成データのローダーのテストは「失敗したら
 * 例外になる」ことを確かめており、既定で取り直すと実時間で 30 秒待たされる（`vi.resetModules()` で
 * 読み直すテストがあるので、テストの設定から差し替える形では届かない）。取り直しそのものは
 * `retryDelay` を明示したテストと、この関数のテストで確かめる。
 */
export function defaultRetryDelay(trackStatus: boolean, mode: string): (failures: number) => number | null {
  return trackStatus && mode !== 'test' ? retryDelayAfter : NO_RETRY
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * JSON を取得する。`timeoutMs` を過ぎても取り切れなければ中断して例外にする。
 *
 * タイムアウトは fetch 本体だけでなく `res.json()` による body 読み込みまでを含む
 * （ヘッダだけ返って body が流れてこない場合も同じ症状になるため）。
 * タイムアウトは通常の取得失敗と同じ経路（例外）に載せる。呼び出し側は成功／失敗の
 * 2 通りだけを扱えばよい。取り直しはこの中で行い（{@link FetchJsonOptions.retryDelay}）、
 * 諦めたときだけ最後の失敗を投げる。
 *
 * @param url 取得先
 * @param label 例外メッセージに載せるデータ名（例: `subregions`）
 * @param options タイムアウトと取得状況の集計可否（{@link FetchJsonOptions}）
 */
export async function fetchJsonWithTimeout<T>(
  url: string,
  label: string,
  options: FetchJsonOptions = {},
): Promise<T> {
  const { trackStatus = true, retryDelay = defaultRetryDelay(trackStatus, import.meta.env.MODE) } = options
  for (let failures = 1; ; failures++) {
    try {
      return await fetchJsonOnce<T>(url, label, options)
    } catch (err) {
      const delay = retryDelay(failures)
      if (trackStatus) {
        failedLabels.set(label, delay === null ? 'gaveUp' : 'retrying')
        publishStatus()
      }
      if (delay === null) throw err
      // 諦めるまで最長で十数分かかるので、取り直すたびに原因を残す（諦めたときの例外は呼び手が記録する）。
      // 時間切れか・応答の形の崩れかは、ここに残さないと諦めるまで分からない
      log.warn(`[data] ${label} の取得に失敗（${failures} 回目。${Math.round(delay / 1000)} 秒後に取り直す）`, err)
      await wait(delay)
    }
  }
}

/** 1 回だけ取る（失敗の記録は呼び手の {@link fetchJsonWithTimeout} が付ける）。 */
async function fetchJsonOnce<T>(url: string, label: string, options: FetchJsonOptions): Promise<T> {
  const { timeoutMs = DATA_FETCH_TIMEOUT_MS, trackStatus = true, validate } = options
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  if (trackStatus) {
    addPending(label)
    publishStatus()
  }
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) throw new Error(`${label} を取得できなかった: ${res.status}`)
    const data = (await res.json()) as T
    // 検分は **この try の中で**呼ぶ。投げた例外は通信失敗と同じく呼び手の取り直しと失敗の記録へ
    // 回る（呼び出し側の `.then()` に置くと、成功として返した後なので計上も取り直しもされない）。
    validate?.(data)
    // 取り直しに成功したら失敗の記録を消す（フォールバックからの復帰を表示にも反映する）
    if (trackStatus) failedLabels.delete(label)
    return data
  } catch (err) {
    // abort 由来の例外（AbortError）は原因が読み取れないため、タイムアウトと分かる文言に置き換える。
    // signal はこの関数内でしか使わないので、aborted が立つのはタイムアウトのときだけ。
    // ただし aborted だけで判定すると、時間切れの直後に届いた別種の例外（配信データ破損による
    // SyntaxError 等）まで「時間切れ」に化けて本当の原因が消える。abort 由来かどうかまで見る。
    if (controller.signal.aborted && isAbortError(err)) {
      throw new Error(`${label} の取得が ${timeoutMs}ms で時間切れになった`)
    }
    throw err
  } finally {
    clearTimeout(timer)
    if (trackStatus) {
      removePending(label)
      publishStatus()
    }
  }
}
