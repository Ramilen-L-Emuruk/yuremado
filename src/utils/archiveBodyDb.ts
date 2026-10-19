/**
 * DMDATA のアーカイブ本体（`/v1/archive/:id`）の控え（IndexedDB）。
 *
 * **控えるのは配信元から受け取ったままの gzip。展開後ではない。**
 * 展開比は実測で ×11.5／×17.3／×18.1 あり、遡り幅に上限があった頃に測れた 58 日ぶんは
 * **gz 合計 2.3MB に対し展開後 41MB**。端末に置く物としては桁が違う。
 * 展開は読むたびにやり直せばよい（gunzip と tar の走査だけで、通信は伴わない）。
 *
 * **メモリの控え（`archiveBodyCache.ts`）の下に敷く二層目。** あちらは展開後を持っていて
 * 同じセッションの中では速いが、**タブを開き直すと空になる**。アプリの起動・リロード・
 * 録画で区間ごとに再生を開始し直す使い方では、そのたびにアーカイブを落とし直していた
 * （起動時の履歴 7 本・リプレイの開始 16 本）。
 *
 * **配信元が名指しで求めているのはこちら。** リファレンスは
 * 「同じ`id`に対して短期間にリクエストを繰り返さないように実装してください」と書いている
 * （→ [`docs/spec/data-sources-spec.md`](../../docs/spec/data-sources-spec.md) §2）。
 * 取得の間隔を空けることはこの要請に何も寄与しない —— 効くのは控えを持つことだけ。
 *
 * **鍵はアーカイブの URL。** 中に不変のアーカイブ id が入っているので内容に対して不変で、
 * メモリ層と同じ鍵になる（片方だけ別の鍵にすると、二層のどちらに当たったかを追いにくい）。
 *
 * **失敗しても本体を止めない。** プライベートモードや容量超過で IndexedDB が使えない環境がある。
 * 控えが無ければ通常の取得へ落ちるだけなので、警告を一度だけ出して黙って諦める
 * （構造は `telegramBodyCache.ts` と揃えてある）。
 */
import { log, createLogThrottle } from './logger'

const DB_NAME = 'dmdata-archive-bodies'
/**
 * 版。**2 へ上げたときに、版 1 で控えた中身を一度だけ捨てる**（`onupgradeneeded`）。
 *
 * 版 1 は当日ぶんだけを控えず、前日ぶんは目録に出た直後（00:30 頃）でも控えていた。その頃は 30 日で
 * 捨てていたが、版 2 から期限を置かない（→ 下の「控えに期限は置かない」）ので、育ちきる前に控えた
 * 中身が混じっていると消えなくなる。捨てても取り直すだけ（1 日 1 本）。
 */
const DB_VERSION = 2
/** 期限を置かなくなった版。これより前の版から上げるときだけ中身を捨てる（版をさらに上げても変えない） */
const FIRST_VERSION_WITHOUT_EXPIRY = 2
/**
 * 目録（`{ id, bytes, lastUsedAt }`）と本体（`{ id, gz }`）を**別のストアに分ける**。
 *
 * **捨てる判断に本体を読みたくないため。** IndexedDB には「レコードの一部だけ読む」手段が無く、
 * 1 つのストアに同居させると、古い順に捨てるたびに全件の gzip を読むことになる。
 * アーカイブ 1 本は地震の多い日で gz 1.46MB あり、目録だけなら 1 件数十バイトで済む。
 */
const STORE_META = 'meta'
const STORE_BODY = 'bodies'
/** 目録を古い順に辿るためのインデックス。 */
const INDEX_LAST_USED = 'lastUsedAt'

/**
 * 控える件数の上限。
 *
 * **バイト数の上限より先に効くことはほぼ無い**（gz は 1 日あたり中央値 0.01MB）。
 * 置いているのは、極端に小さいアーカイブが延々と積み上がる形を防ぐため。
 * 地震カードは窓 7 日ずつ遡り、リプレイは任意の過去日を再生できるので、**どちらも触る日数に
 * 上限が無い**（カードの遡りも在庫の端まで届く）—— 録画で何百日を通しても収まる幅を採った。
 */
export const MAX_ENTRIES = 4000

/**
 * 控える合計バイト数（gzip のまま）の上限。
 *
 * **展開後ではなく gz で数える**（置いている物がそれなので）。実測では
 * 上限があった頃の 58 日ぶんで gz 合計 2.3MB、地震の多い日でも 1 本 1.46MB。
 * 200MB あれば、録画で何百日を通しても追い出しは起きない。
 *
 * **下回らせてはいけない境界は「1 回のまとまった取得が同時に落とす量」** ——
 * そこを割ると同じ取得の中で追い出しが起き、次の取得でまた落とし直す（控えの意味が消える）。
 * いちばん重いリプレイの開始でも 16 本なので、桁で余裕がある。
 */
export const MAX_TOTAL_BYTES = 200 * 1024 * 1024

/**
 * 読み取りで `lastUsedAt` を書き直す間隔。
 *
 * 古い順に捨てるには読むたびに時刻を更新したいが、リプレイの開始で 16 本読むたびに
 * 16 回書き込むのは割に合わない。この幅より新しい記録は触らない —— 捨てる順序が多少
 * ずれても、「最近の再生で読まれたものが残る」という性質は保たれる。
 */
const TOUCH_INTERVAL_MS = 6 * 60 * 60 * 1000

/*
 * **控えに期限は置かない**（2026-10-19 ユーザー承認。問い「永続層のアーカイブ本体（archiveBodyDb.ts、30 日）の
 * 期限も外す？」→「外す (推奨)」）。期限で捨てても取り直すだけで、前提が崩れたときに気づく手立てにならない。
 * **まだ育ちうる日は呼び出し側が控えない**（`dmdataReplay.ts` の `isArchiveCacheable`。翌日 6:00 JST を
 * 過ぎるまで控えない）。古い順に捨てるのは件数と合計の上限だけ。
 */

/**
 * 「控えたばかりのものを捨てた」と見なす幅。
 *
 * 上限が足りていないと、開始のたびに追い出しと取り直しを繰り返す。**件数と合計を
 * 守っているだけでは正常と見分けが付かない**ので記録する。
 */
const THRASH_WINDOW_MS = 60_000

/** 目録の 1 件。**本体（`gz`）を持たない**（上記のとおり捨てる判断で読むため）。 */
interface MetaEntry {
  id: string
  /** `gz` のバイト数。合計の上限を見るのに使う。 */
  bytes: number
  /** 最後に読んだ（または書いた）時刻。古い順に捨てるのに使う。 */
  lastUsedAt: number
  /**
   * 控えた時刻。控えたばかりのものを捨てたかの判定（`THRASH_WINDOW_MS`）に使う。
   */
  createdAt?: number
}

/** 控えたばかりで捨てた本数の累計。**控えが効かない状態を警告に出すために数える**。 */
let purgedRecentTotal = 0

/**
 * 上限を確かめる読み取りが失敗した回数。
 *
 * **「読めなかった」と「0 件だった」を潰さないために数える。** IndexedDB の読みは
 * 一時的に失敗しうる（容量の端境・別タブとの競合）。そのとき件数を 0 として扱うと、
 * **上限を超えているのに追い出しが走らない**まま肥大化する経路ができる。
 * 失敗したら間引いて警告する（`noteLimitCheckFailure`）。**`warnOnce` では足りない** ——
 * あちらは一度鳴らすと二度と鳴らないので、繰り返し起きていることが記録に残らない。
 */
let limitCheckFailures = 0

let warned = false
function warnOnce(message: string, e: unknown): void {
  if (warned) return
  warned = true
  log.warn(`[replay] ${message}`, e)
}

// 上限に達している間はパージが続くので、毎回鳴らさず間引く
const warnThrashing = createLogThrottle(60_000)
const warnLimitCheck = createLogThrottle(60_000)

function noteLimitCheckFailure(): void {
  limitCheckFailures++
  warnLimitCheck(() => log.warn(
    `[replay] アーカイブの控え（端末）の上限を確かめられませんでした（累計 ${limitCheckFailures} 回）。`
    + '上限を超えていても古いものが捨てられない可能性があります',
  ))
}

/**
 * 接続は 1 本だけ持って使い回す。
 *
 * **呼び出しごとに開くと接続が積み上がる。** 閉じないまま溜まった接続は、将来 `DB_VERSION` を
 * 上げたときに版の昇格を塞ぎ（`onblocked`）、どのハンドラも発火しないまま止まる。
 */
let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  // 塞がれた昇格（`onblocked`）が後から通ったかを、同じ要求の `onsuccess` で知るための印
  let answered = false
  const pending: Promise<IDBDatabase | null> = new Promise<IDBDatabase | null>((resolveRaw) => {
    const resolve = (db: IDBDatabase | null) => {
      answered = true
      resolveRaw(db)
    }
    try {
      if (typeof indexedDB === 'undefined') {
        // 古いブラウザ・IndexedDB を持たない実行環境。控えを持てないだけなので警告は出さない
        resolve(null)
        return
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = (ev) => {
        const db = req.result
        // 版 1 の中身は捨てる（理由は `DB_VERSION`）
        if (ev.oldVersion > 0 && ev.oldVersion < FIRST_VERSION_WITHOUT_EXPIRY) {
          for (const name of [STORE_META, STORE_BODY]) {
            if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name)
          }
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: 'id' }).createIndex(INDEX_LAST_USED, 'lastUsedAt')
        }
        if (!db.objectStoreNames.contains(STORE_BODY)) {
          db.createObjectStore(STORE_BODY, { keyPath: 'id' })
        }
      }
      req.onsuccess = () => {
        const db = req.result
        // 塞がれていた昇格が後から通った。待たせた呼び出しには控えなしで答え済みなので、
        // ここで開いた接続を以後の呼び出しの答えにする（開き直すと要求が直列に並んで待たされ、接続も 2 本になる）
        const own = answered ? Promise.resolve<IDBDatabase | null>(db) : pending
        // 別のタブが版を上げようとしたら道を空ける（次の呼び出しで開き直す）
        db.onversionchange = () => {
          db.close()
          if (dbPromise === own) dbPromise = null
        }
        if (answered) dbPromise = own
        else resolve(db)
      }
      req.onerror = () => {
        warnOnce('アーカイブの控えを開けませんでした（毎回取得します）', req.error)
        if (!answered) resolve(null)
      }
      req.onblocked = () => {
        // **旧い版のタブが閉じるまで、控えなしで進める。** 要求そのものは生きていて、旧いタブが
        // `onversionchange` で接続を閉じれば昇格が通り、`onsuccess` がその接続を採る（上）。
        // ここで待つと、閉じないタブ（固まったタブなど）があるあいだ取得ごと止まる
        warnOnce('アーカイブの控えの版を上げられませんでした（別のタブが開いています）', null)
        resolve(null)
      }
    } catch (e) {
      warnOnce('アーカイブの控えを開けませんでした（毎回取得します）', e)
      resolve(null)
    }
  })
  dbPromise = pending
  return pending
}

/**
 * ストアを 1 つ触る。
 *
 * **目録と本体を同時に変える操作は `bothStores` を使う。** 別々のトランザクションで書くと、
 * 片方だけ成功した状態（目録にあるのに本体が無い等）が残りうる。
 */
function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null)
        try {
          const req = run(db.transaction(store, mode).objectStore(store))
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => {
            warnOnce('アーカイブの控えの読み書きに失敗しました', req.error)
            resolve(null)
          }
        } catch (e) {
          warnOnce('アーカイブの控えの読み書きに失敗しました', e)
          resolve(null)
        }
      }),
  )
}

/**
 * 目録と本体を 1 つの読み取りトランザクションでまとめて引く。
 *
 * **別々に開かない。** 1 件読むたびにトランザクションを 2 回張ると、その往復が
 * リプレイの開始（最大 16 本）や履歴の取得（最大 59 本）の本数だけ積み上がる ——
 * **この控えは速くするために置いたもの**なので、そこで往復を増やすのは本末転倒。
 */
function readBoth(key: string): Promise<{ body?: { id: string; gz: Uint8Array }; meta?: MetaEntry } | null> {
  return openDb().then(
    (db) =>
      new Promise<{ body?: { id: string; gz: Uint8Array }; meta?: MetaEntry } | null>((resolve) => {
        if (!db) return resolve(null)
        try {
          const t = db.transaction([STORE_META, STORE_BODY], 'readonly')
          const bodyReq = t.objectStore(STORE_BODY).get(key) as IDBRequest<{ id: string; gz: Uint8Array } | undefined>
          const metaReq = t.objectStore(STORE_META).get(key) as IDBRequest<MetaEntry | undefined>
          t.oncomplete = () => resolve({ body: bodyReq.result, meta: metaReq.result })
          t.onerror = () => {
            warnOnce('アーカイブの控えの読み取りに失敗しました', t.error)
            resolve(null)
          }
          t.onabort = () => {
            warnOnce('アーカイブの控えの読み取りが中断されました', t.error)
            resolve(null)
          }
        } catch (e) {
          warnOnce('アーカイブの控えの読み取りに失敗しました', e)
          resolve(null)
        }
      }),
  )
}

/** 目録と本体を 1 つのトランザクションで触る（片方だけ成功した状態を作らない）。 */
function bothStores(run: (meta: IDBObjectStore, body: IDBObjectStore) => void): Promise<boolean> {
  return openDb().then(
    (db) =>
      new Promise<boolean>((resolve) => {
        if (!db) return resolve(false)
        try {
          const t = db.transaction([STORE_META, STORE_BODY], 'readwrite')
          run(t.objectStore(STORE_META), t.objectStore(STORE_BODY))
          t.oncomplete = () => resolve(true)
          t.onerror = () => {
            warnOnce('アーカイブの控えの読み書きに失敗しました', t.error)
            resolve(false)
          }
          t.onabort = () => {
            warnOnce('アーカイブの控えの読み書きが中断されました', t.error)
            resolve(false)
          }
        } catch (e) {
          warnOnce('アーカイブの控えの読み書きに失敗しました', e)
          resolve(false)
        }
      }),
  )
}

/**
 * 控えから 1 件読む（gzip のまま）。無ければ `null`。
 *
 * 読めたら `lastUsedAt` を更新するが、**`TOUCH_INTERVAL_MS` より新しいものは触らない**。
 */
export async function readArchiveBody(key: string): Promise<Uint8Array | null> {
  // **本体と目録は 1 つのトランザクションで引く**（理由は `readBoth`）。
  const got = await readBoth(key)
  const body = got?.body
  if (!body || !(body.gz instanceof Uint8Array)) return null

  const meta = got?.meta
  const now = Date.now()
  if (meta && now - (meta.lastUsedAt ?? 0) > TOUCH_INTERVAL_MS) {
    // 更新の失敗は無視してよい（控えは読めているので、次に捨てる順序がずれるだけ）
    void tx(STORE_META, 'readwrite', (s) => s.put({ ...meta, lastUsedAt: now } satisfies MetaEntry))
  }
  return body.gz
}

/**
 * 控えへ 1 件書き、上限を超えた分を古い順に捨てる。
 *
 * **バッファ全体を抱えているビューはコピーしてから置く。** `Uint8Array` を構造化クローンで
 * 保存すると、`byteOffset` を持つ切り出しでも**元のバッファ全体が書き込まれる**ことがある。
 * いまの呼び出し元は取得した本体をそのまま渡すので該当しないが、切り出しを渡す経路が
 * できたときに、置いた覚えのない大きさが黙って積み上がる。
 */
export async function writeArchiveBody(key: string, gz: Uint8Array): Promise<void> {
  const owned = gz.byteOffset === 0 && gz.byteLength === gz.buffer.byteLength ? gz : gz.slice()
  const bytes = owned.byteLength
  const now = Date.now()
  const ok = await bothStores((meta, body) => {
    meta.put({ id: key, bytes, lastUsedAt: now, createdAt: now } satisfies MetaEntry)
    body.put({ id: key, gz: owned })
  })
  if (!ok) return

  // **読み取りの失敗を「0 件」に潰さない。** 潰すと「上限を超えているのに読めなかった」が
  // 「上限以内」と同じ扱いになり、**追い出しが黙って走らなくなる**。
  // 読めなかったときは数えたうえで追い出しを試みる側へ倒す（`purgeOldest` が読めれば直る）。
  const n = await tx<number>(STORE_META, 'readonly', (s) => s.count())
  if (n === null) {
    noteLimitCheckFailure()
  } else if (n <= MAX_ENTRIES) {
    // 件数が上限以内でも、大きいアーカイブが並べば合計は超えうる。目録は軽いので数える
    const bytesTotal = await totalBytes()
    if (bytesTotal === null) noteLimitCheckFailure()
    else if (bytesTotal <= MAX_TOTAL_BYTES) return
  }
  await purgeOldest()
}

/**
 * 目録から合計バイト数を数える（本体は読まない）。**読めなければ `null`。**
 *
 * 「0 バイトだった」と区別する（→ `limitCheckFailures`）。
 */
async function totalBytes(): Promise<number | null> {
  const all = await tx<MetaEntry[]>(STORE_META, 'readonly', (s) => s.getAll() as IDBRequest<MetaEntry[]>)
  if (all === null) return null
  return all.reduce((sum, e) => sum + (e.bytes ?? 0), 0)
}

/**
 * 古い順に捨てて、件数とバイト数の両方を上限以下へ戻す。
 *
 * **合計はここで数え直す。** 複数のタブが同じ控えを触るため、プロセス内に持った推定値は
 * ずれる。捨てるときだけ実際の値を見れば、ずれが積み上がらない。
 */
async function purgeOldest(): Promise<void> {
  const all = await tx<MetaEntry[]>(STORE_META, 'readonly', (s) => s.getAll() as IDBRequest<MetaEntry[]>)
  // **ここでも「読めなかった」と「0 件」を潰さない。** 潰すと、上限超えと判定されて
  // 呼ばれたのに**何も消さずに黙って返る** —— しかも数えていないので、
  // 追い出しが機能していないことがどの記録にも出ない（`limitCheckFailures` と同じ枠で数える）。
  if (all === null) {
    noteLimitCheckFailure()
    return
  }
  if (all.length === 0) return
  // 古い順（`lastUsedAt` 昇順）。時刻を持たない壊れた記録は先に捨てる
  all.sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0))
  let entries = all.length
  let bytes = all.reduce((sum, e) => sum + (e.bytes ?? 0), 0)
  const doomed: string[] = []
  for (const e of all) {
    if (entries <= MAX_ENTRIES && bytes <= MAX_TOTAL_BYTES) break
    doomed.push(e.id)
    entries--
    bytes -= e.bytes ?? 0
  }
  if (doomed.length === 0) return
  // **1 つのトランザクションでまとめて消す。** 1 件ずつ開くと、上限付近で書き込みが続いたときに
  // トランザクションの数だけ待ちが積み上がる
  const ok = await bothStores((meta, body) => {
    for (const victim of doomed) {
      meta.delete(victim)
      body.delete(victim)
    }
  })
  if (!ok) return

  const now = Date.now()
  const doomedSet = new Set(doomed)
  const recent = all
    .filter(e => doomedSet.has(e.id))
    .filter(e => now - (e.createdAt ?? e.lastUsedAt ?? 0) < THRASH_WINDOW_MS).length
  if (recent > 0) {
    purgedRecentTotal += recent
    warnThrashing(() => log.warn(
      `[replay] アーカイブの控え（端末）が上限に達しています（控えたばかりの ${recent} 本を捨てました`
      + ` / 累計 ${purgedRecentTotal} 本）。同じアーカイブを取り直している可能性があります`,
    ))
  }
}

/** すべて消す。消せたかどうかを返す。 */
export async function clearArchiveBodyDb(): Promise<boolean> {
  return bothStores((meta, body) => {
    meta.clear()
    body.clear()
  })
}
