// 強震モニタの「平常のゆらぎの表」（public/data/kyoshin-quiet-tables.json）を読み込む。
//
// 表の形と数え方は utils/kyoshinQuietTables.ts、焼くのは scripts/build-kyoshin-quiet-tables.ts。

import { fetchJsonWithTimeout } from './fetchJson'
import { validateQuietTables, type QuietTables, type TailCounts } from './kyoshinQuietTables'
import { log } from './logger'
import { retryDelayAfter } from './retrySchedule'

const DATA_URL = `${import.meta.env.BASE_URL}data/kyoshin-quiet-tables.json`

/**
 * 表が取れていない間に使う表。全点を合わせた数（`glob`）だけを持ち、観測点ごとの表は空にする。
 *
 * 観測点ごとの表に載らない点は、組み合わせの検知器がもともと全体の確率・既定のしきい値で動かす
 * （焼いた日に動いていなかった点と同じ扱い）。表が取れない間もその形で検知を止めずに動かす。
 * **`glob` は配る表の `glob` と同じ値を写してある**（`kyoshinQuietTablesLoader.test.ts` が突き合わせる）。
 * 表を焼き直したら、ここも写し直すこと。
 */
export const FALLBACK_GLOB: TailCounts = {
  n: 340409842,
  y: [5189650, 1308795, 386618, 105611, 29419, 9692, 4047, 295, 74, 35, 24, 6],
  y3: [2853288, 771821, 236698, 67552, 20135, 7434, 3417, 205, 50, 20, 12, 3],
}

export const FALLBACK_QUIET_TABLES: QuietTables = {
  version: 1,
  days: [],
  glob: FALLBACK_GLOB,
  tails: {},
  fire: {},
}

let cache: QuietTables | null = null
let inflight: Promise<QuietTables> | null = null
const waiters = new Set<(tables: QuietTables) => void>()

/**
 * 表を取得する。初回のみ取りに行き、以降は控えを返す。配信の破損は {@link validateQuietTables} で取得の失敗として数える。
 *
 * 取れない間は共有の規則で取り直す（`utils/retrySchedule.ts`）。規則が諦めたら reject する（呼び出し側が間を置いて
 * もう一度呼ぶ。`useKyoshinDetectorV2`）。地図の見た目には関わらないので
 * 取得状況（地図の「〇〇を取り込めず」）には数えない。取れるまでの間は {@link getKyoshinQuietTables} が
 * {@link FALLBACK_QUIET_TABLES} を返す。
 */
export function loadKyoshinQuietTables(): Promise<QuietTables> {
  if (cache) return Promise.resolve(cache)
  if (!inflight) {
    inflight = fetchJsonWithTimeout<QuietTables>(DATA_URL, 'kyoshin-quiet-tables', {
      trackStatus: false,
      validate: validateQuietTables,
      retryDelay: retryDelayAfter,
    })
      .then((tables) => {
        cache = tables
        // 購読者の例外は 1 人ずつ受け止める（1 人が投げて残りが表を受け取れないまま、取得の失敗に化けないように）
        for (const fn of waiters) {
          try {
            fn(tables)
          } catch (err) {
            log.error('[kyoshinEnsemble] 平常のゆらぎの表を受け取る側が例外を投げました:', err)
          }
        }
        waiters.clear()
        return tables
      })
      .catch((err) => {
        inflight = null
        throw err
      })
  }
  return inflight
}

/** 取れた表、まだ取れていなければ {@link FALLBACK_QUIET_TABLES}。 */
export function getKyoshinQuietTables(): QuietTables {
  return cache ?? FALLBACK_QUIET_TABLES
}

/**
 * 表が取れたときに一度だけ呼ばれるコールバックを登録する。既に取れていれば即座に呼ぶ。戻り値は購読解除関数。
 *
 * 検知器は作るときに表を受け取るので、取れた時点で作り直す側がこれを使う。
 */
export function onKyoshinQuietTablesLoaded(fn: (tables: QuietTables) => void): () => void {
  if (cache) {
    fn(cache)
    return () => {}
  }
  waiters.add(fn)
  return () => {
    waiters.delete(fn)
  }
}
