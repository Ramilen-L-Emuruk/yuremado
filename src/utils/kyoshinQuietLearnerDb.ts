/**
 * 平常のゆらぎを端末で学び直した状態（`kyoshinQuietLearner.ts` の {@link QuietLearnerState}）の保存先（IndexedDB）。
 *
 * 観測点ごとの数（約 1,700 点 × 約 30 個の数）を 1 件にまとめて持つので数百 KB になる。localStorage（5MB・同期・設定と同居）
 * には置かない。学び直しの係が 1 時間に 1 回渡すたびに上書きする（1 件しか持たない）。
 *
 * **失敗しても本体を止めない。** 保存できない端末では、開くたびに配る表から学び直すだけになる。
 * 警告は文面ごとに一度きりに絞る（毎時の保存のたびに積み上げない）。開けなかったときは接続を持たず、次の読み書きで開き直す。
 *
 * **読めなかったことと、まだ何も残していないことを分けて返す。** 読み込みだけが一時的に失敗した起動で「初めから」学び直すと、
 * 1 時間後の保存が残してあった数を、ほぼ空の数で上書きする。読めなかった起動では保存しない（呼び出し側が決める）。
 */
import { parseQuietLearnerState, type QuietLearnerState } from './kyoshinQuietLearner'
import { QUIET_COUNTS_VERSION } from './kyoshinQuietTables'
import { log } from './logger'

const DB_NAME = 'kyoshin-quiet-learner'
const DB_VERSION = 1
const STORE = 'state'
const KEY = 'current'

/**
 * 警告は文面ごとに一度きり。開けない・読めない・書けないを 1 つの旗で絞ると、最初の 1 種類しか残らず、
 * 「開けるが毎時の保存だけ失敗し続けている」状態が記録から見えなくなる
 */
const warned = new Set<string>()
function warnOnce(message: string, e: unknown): void {
  if (warned.has(message)) return
  warned.add(message)
  log.warn(`[kyoshinQuietLearner] ${message}`, e)
}

/**
 * 開くのを待つ上限（ミリ秒）。open が成功も失敗も返さないまま居座った場合（起きる環境は確かめていない）に備える。待ち続けると
 * 学び直しが記録も残さず始まらない。切れたら開けなかったものとして扱い、次の読み書きで開き直す
 */
export const QUIET_LEARNER_OPEN_TIMEOUT_MS = 10_000

/** 接続は 1 本だけ持って使い回す（理由は `detectionDiagnosticsDb.ts` の同じ箇所） */
let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  // 開けなかったら接続を持たない。持ったままだと、一時的な失敗のあとも毎時の保存が永久に null を受け取る。
  // `self` は待ち受けの中から自分の約束を指す入れ物（同期に投げたときは、まだ約束が出来ていない）
  const self: { p: Promise<IDBDatabase | null> | null; failed: boolean } = { p: null, failed: false }
  const opening = new Promise<IDBDatabase | null>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const fail = (message: string, e: unknown) => {
      if (settled) return
      if (timer !== null) clearTimeout(timer)
      warnOnce(message, e)
      settled = true
      self.failed = true
      // 同期に投げたときはまだ `dbPromise` に入っていない（下で入れない）
      if (self.p !== null && dbPromise === self.p) dbPromise = null
      resolve(null)
    }
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
      }
      req.onsuccess = () => {
        const db = req.result
        // 待ち切れずに諦めた後で開けたなら、使わずに閉じる（持ち主のいない接続を残さない）
        if (settled) { db.close(); return }
        settled = true
        if (timer !== null) clearTimeout(timer)
        const drop = () => { if (dbPromise === self.p) dbPromise = null }
        db.onversionchange = () => {
          db.close()
          drop()
        }
        // ブラウザが接続を閉じた（記憶域の削除など）。次の読み書きで開き直す
        db.onclose = drop
        resolve(db)
      }
      req.onerror = () => fail('IndexedDB を開けませんでした（平常のゆらぎの学び直しは開くたびに始め直します）', req.error)
      req.onblocked = () => fail('IndexedDB の版を上げられませんでした（別のタブが開いています）', null)
      timer = setTimeout(
        () => fail(`IndexedDB が ${QUIET_LEARNER_OPEN_TIMEOUT_MS / 1000} 秒たっても開けませんでした（次の読み書きで開き直します）`, null),
        QUIET_LEARNER_OPEN_TIMEOUT_MS,
      )
    } catch (e) {
      fail('IndexedDB を開けませんでした（平常のゆらぎの学び直しは開くたびに始め直します）', e)
    }
  })
  self.p = opening
  if (!self.failed) dbPromise = opening
  return opening
}

/** 読み書きの結果。`ok` が偽なら失敗した（記録は済んでいる） */
type TxResult<T> = { ok: true; value: T } | { ok: false }

/**
 * 1 回の読み書き。**書き込みは、要求の成功ではなく取引の完了（`oncomplete`）で成功とする** ——
 * 容量の超過などは要求が成功した後に取引の中止（`onabort`）として届くので、要求だけ見ていると失敗を取りこぼす。
 */
function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<TxResult<T>> {
  const opened = openDb()
  return opened.then(
    (db) =>
      new Promise<TxResult<T>>((resolve) => {
        if (!db) return resolve({ ok: false })
        const fail = (e: unknown) => {
          warnOnce(mode === 'readonly' ? '学び直した状態を読めませんでした' : '学び直した状態を残せませんでした', e)
          // 閉じた知らせが届かないまま死んだ接続を持ち続けないよう、失敗したら次の読み書きで開き直す
          if (dbPromise === opened) dbPromise = null
          resolve({ ok: false })
        }
        try {
          const t = db.transaction(STORE, mode)
          const req = run(t.objectStore(STORE))
          let value: T
          req.onsuccess = () => {
            value = req.result
            if (mode === 'readonly') resolve({ ok: true, value })
          }
          req.onerror = () => fail(req.error)
          t.oncomplete = () => resolve({ ok: true, value })
          t.onabort = () => fail(t.error)
          t.onerror = () => fail(t.error)
        } catch (e) {
          fail(e)
        }
      }),
  )
}

/** 端末に残した状態を読んだ結果。`readable` が偽なら読めなかった（無いのとは別。保存してはいけない） */
export interface LoadedQuietLearnerState {
  readable: boolean
  /** 残した状態。無い・形が崩れていたなら null */
  state: QuietLearnerState | null
}

/** 残した状態を読む（形が崩れていたことは記録する） */
export async function loadQuietLearnerState(): Promise<LoadedQuietLearnerState> {
  const r = await tx<unknown>('readonly', (s) => s.get(KEY))
  if (!r.ok) return { readable: false, state: null }
  if (r.value === null || r.value === undefined) return { readable: true, state: null }
  const state = parseQuietLearnerState(r.value)
  if (state === null) {
    // 数え方を変えて版を上げた後の古い分は崩れではない（版が違えば捨てて数え直す。QUIET_COUNTS_VERSION）
    const version = (r.value as { counts?: { version?: unknown } }).counts?.version
    if (typeof version === 'number' && version !== QUIET_COUNTS_VERSION) {
      log.info(`[kyoshinQuietLearner] 端末に残した学び直しの状態は数え方が古い版（${version}）なので、配る表から学び直します`)
    } else {
      log.warn('[kyoshinQuietLearner] 端末に残した学び直しの状態の形が崩れていたので、配る表から学び直します')
    }
  }
  return { readable: true, state }
}

/** 状態を上書きして残す。書けたら true */
export async function saveQuietLearnerState(state: QuietLearnerState): Promise<boolean> {
  return (await tx('readwrite', (s) => s.put(state, KEY))).ok
}
