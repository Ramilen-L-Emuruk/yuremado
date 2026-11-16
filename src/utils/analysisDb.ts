import { createLogThrottle, log } from './logger'

/**
 * 地震カードに添える解析の控え（端末の IndexedDB）。中継の解析の口（`services/relayAnalysis.ts`）が返した答えを、
 * 地震（EventID）ごとに 1 件で持つ。カードを開いたらまず控えを出し、中継へ問い合わせて新しい答えで置き換える
 * （計画書 項目 98「端末の控え」）。
 *
 * **控えるのは答えの JSON そのままで、読み解いた形ではない**（`publicQuakeWaveDb.ts` と同じ理由）。読み方を変えたときに、
 * 古い形のまま残った結果を使い続けないため。読むたびに `parseQuakeAnalysis` を通す。
 *
 * **捨てる順は最後に書いた順**（＝最後に開いた順。開くたびに書き直すため）。上限は件数（{@link ANALYSIS_DB_MAX_ENTRIES}）。
 * 答えは 1 件 2〜50 KB（三陸沖 M4.7 が 1.5 KB・能登 M7.6 が 49 KB。2026-11-15 実測）。
 *
 * 作りは `publicQuakeWaveDb.ts` に揃える —— 接続は 1 本を使い回す、開けない・書けないときは控えを持たないだけで動きは止めない。
 */

const DB_NAME = 'quake-analysis'
const DB_VERSION = 1
const STORE = 'answers'
/** 書いた時刻の索引。捨てるときに本体を読まずに古い順に辿るため */
const BY_SAVED = 'savedAt'

/** 控える地震の数の上限。超えたら最後に書いたのが古い地震から捨てる */
export const ANALYSIS_DB_MAX_ENTRIES = 500

export interface AnalysisRow {
  readonly eventId: string
  /** 書いた時刻（端末の時計。捨てる順を決めるためだけに使う） */
  readonly savedAt: number
  /** 中継の答えの JSON そのまま */
  readonly body: unknown
}

// 記録は種類ごとに 1 分に 1 回へ間引く（1 本の旗にすると、最初の失敗の後は別の失敗まで黙る）
const warnOpen = createLogThrottle(60_000)
const warnTx = createLogThrottle(60_000)
const warnLimitCheck = createLogThrottle(60_000)

let dbPromise: Promise<IDBDatabase | null> | null = null

/** 開けなかったときは控えを持たないだけで止めない。**次に使うときに開き直す**（一時的な失敗でタブの寿命の間ずっと控えが効かなくならないように） */
function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  const opening = new Promise<IDBDatabase | null>((resolve) => {
    let settled = false
    const fail = (message: string, e: unknown): void => {
      warnOpen(() => log.warn(`[analysis] ${message}`, e))
      settled = true
      if (dbPromise === opening) dbPromise = null
      resolve(null)
    }
    try {
      if (typeof indexedDB === 'undefined') {
        resolve(null)
        return
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'eventId' }).createIndex(BY_SAVED, 'savedAt')
      }
      req.onsuccess = () => {
        const db = req.result
        // 待たされて（blocked）諦めた後に開けた接続は、誰も使わないので閉じる
        if (settled) {
          db.close()
          return
        }
        db.onversionchange = () => {
          db.close()
          dbPromise = null
        }
        settled = true
        resolve(db)
      }
      req.onerror = () => fail('解析の控えを開けませんでした（毎回取得します）', req.error)
      req.onblocked = () => fail('解析の控えの版を上げられませんでした（別のタブが開いています）', null)
    } catch (e) {
      fail('解析の控えを開けませんでした（毎回取得します）', e)
    }
  })
  dbPromise = opening
  return opening
}

function inTransaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => () => T): Promise<{ value: T } | null> {
  return openDb().then(
    (db) =>
      new Promise<{ value: T } | null>((resolve) => {
        if (!db) return resolve(null)
        try {
          const t = db.transaction(STORE, mode)
          const finish = run(t.objectStore(STORE))
          t.oncomplete = () => resolve({ value: finish() })
          t.onerror = () => {
            warnTx(() => log.warn('[analysis] 解析の控えの読み書きに失敗しました', t.error))
            resolve(null)
          }
          t.onabort = () => {
            warnTx(() => log.warn('[analysis] 解析の控えの読み書きが中断されました', t.error))
            resolve(null)
          }
        } catch (e) {
          warnTx(() => log.warn('[analysis] 解析の控えの読み書きに失敗しました', e))
          resolve(null)
        }
      }),
  )
}

/** 控えから 1 件読む。無い・読めなければ `null` */
export async function readAnalysis(eventId: string): Promise<AnalysisRow | null> {
  const got = await inTransaction('readonly', (s) => {
    const r = s.get(eventId) as IDBRequest<AnalysisRow | undefined>
    return () => r.result
  })
  return got?.value ?? null
}

/** 控えへ 1 件書き、上限を超えた分を捨てる。書けたかどうかを返す */
export async function writeAnalysis(eventId: string, body: unknown, savedAt: number): Promise<boolean> {
  const ok = await inTransaction('readwrite', (s) => {
    s.put({ eventId, savedAt, body } satisfies AnalysisRow)
    return () => true
  })
  if (ok === null) return false
  await evict()
  return true
}

/**
 * 上限を超えた分を、最後に書いたのが古い順に捨てる。数えるのと捨てるのを 1 つのトランザクションで行う
 * （複数のタブが同じ控えを触るため、毎回数え直す）。索引の鍵だけを辿り、本体は読まない
 */
async function evict(max = ANALYSIS_DB_MAX_ENTRIES): Promise<void> {
  const done = await inTransaction('readwrite', (s) => {
    const count = s.count()
    count.onsuccess = () => {
      let excess = count.result - max
      if (excess <= 0) return
      const cur = s.index(BY_SAVED).openKeyCursor()
      cur.onsuccess = () => {
        const c = cur.result
        if (!c || excess <= 0) return
        s.delete(c.primaryKey)
        excess -= 1
        c.continue()
      }
    }
    return () => true
  })
  if (done === null) {
    // 捨てられなかったことを「上限以内」と同じに潰さない
    warnLimitCheck(() => log.warn('[analysis] 解析の控えの上限を確かめられませんでした。古いものが捨てられない可能性があります'))
  }
}

/** テスト用: 上限を指定して捨てる */
export const evictAnalysisForTest = evict

/** すべて消す。消せたかどうかを返す */
export async function clearAnalysisDb(): Promise<boolean> {
  const ok = await inTransaction('readwrite', (s) => {
    s.clear()
    return () => true
  })
  return ok !== null
}
