/**
 * 中継（yuremado-relay）へ繋ぐ先と、中継が出す短い期限の札（docs/relay-server-design.md §6・§6.4 の C）。
 *
 * 中継の口は DMDATA と同じ道・同じ形で返すので、一覧や本体を取る関数は {@link DmdataEndpoint} のまま使える。
 * 違うのは認証だけ —— 利用者の鍵ではなく、中継が `POST /token` で出す札を `Authorization: Bearer` で付ける。
 * 電文本体と束は公開バケットから返るので、本体には何も付けない。
 *
 * **札は要求の直前に {@link RelayTokenStore.ensure} で用意する。** 見出しを作る関数は同期で呼ばれるため、
 * 札が無ければ投げる（値で持つ形にすると、札が切れた後も古い札を運ぶ）。
 */

import type { DmdataEndpoint } from './dmdataEndpoint'
import { fetchJsonOutcome, API_FETCH_TIMEOUT_MS } from '../utils/fetchWithTimeout'
import { log } from '../utils/logger'

/** 中継の Worker の土台（末尾の `/` なし） */
export const RELAY_ORIGIN = 'https://relay.yuremado.com'
/** 中継の API の土台。DMDATA の `/v2` と同じ道を返す */
export const RELAY_API_BASE = `${RELAY_ORIGIN}/v2`
/** 電文本体の土台（公開バケット。末尾の `/` あり。`${dataBase}${id}` で本体の URL になる） */
export const RELAY_DATA_BASE = 'https://data.yuremado.com/t/'
/**
 * 予報（`eew.forecast`）の本体と束の土台。予報は公開バケットに置かず、中継の口が予報キーの札を確かめて返す
 * （設計書 §0 の 2026-10-31「予報キー」の行）。一覧が返す `url` がこの土台で始まる
 */
export const RELAY_PRIVATE_BASE = `${RELAY_API_BASE}/private/`

/** 中継の口から返す本体か（札を付け、中継の回数の上限に並ぶ） */
export function isRelayPrivateUrl(url: string): boolean {
  return url.startsWith(RELAY_PRIVATE_BASE)
}

/**
 * 札の期限までこれより近くなったら取り直す。札は数時間もつので、要求の途中で切れない余裕を取る。
 * 端末の時計は中継の時計とずれうるので、期限は中継が返した時刻ではなく「残りの長さ」で持つ（→ {@link RelayTokenStore}）。
 */
const REFRESH_MARGIN_MS = 5 * 60_000

export class RelayTokenError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message)
    this.name = 'RelayTokenError'
  }
}

/**
 * 札を取ったときに中継が予報キーへ返した答え（設計書 §0 の 2026-10-31「予報キー」の行）。
 * `granted` が真なら、その札で予報（`eew.forecast`）も届く。`problem` は中継が断った理由
 * （`malformed`・`signature`・`expired` など。中継の `forecastKey.ts` の値をそのまま運ぶ）。
 */
export interface RelayForecastScope {
  granted: boolean
  problem: string | null
}

export interface RelayTokenStore {
  /** いま使える札。無い・期限が近いなら null */
  current(): string | null
  /**
   * 札を用意する。同時に呼ばれても `POST /token` は 1 本にまとめる。取れなければ投げる。
   * 予報キーの検証中（{@link forecastKeyChecking}）は、検証が済むまで札を取りに行かずに待つ ——
   * 検証の前に取ると、予報の印の無い札で繋いでから、キーが入った時点で繋ぎ直すことになる。
   * まとめた取得は誰の `signal` にも縛らない。`signal` が止まると、その呼び手だけが待ちを抜ける（`AbortError`）
   */
  ensure(signal?: AbortSignal | null): Promise<string>
  /** 中継に札を断られた（401）。次の `ensure` で取り直す */
  invalidate(): void
  /**
   * 札を取るときに添える予報キー（無ければ null）。**変わったら今の札を捨てる** —— 予報の印は札に
   * 署名されているので、キーを入れ直しても古い札のままでは予報が届かない（逆に消しても届き続ける）。
   *
   * @param checking 予報キーの手元の検証がまだ済んでいない（設定にキーはあるが、送るかが決まっていない）
   */
  setForecastKey(key: string | null, checking: boolean): void
  /** いま札に添えている予報キー（無ければ null） */
  forecastKey(): string | null
  /** 予報キーの手元の検証がまだ済んでいないか（済むまでは予報キーを送るかが決まらない） */
  forecastKeyChecking(): boolean
  /** 最後に取った札で中継が予報キーへ返した答え。予報キーを添えていない・まだ取っていないなら null */
  forecastScope(): RelayForecastScope | null
  /**
   * 使用状況データ（設計書 §6.6）。許可している間は一意の識別子と、札を取るときに添える報告を組む関数を渡す。
   * 許可していないなら両方 null。**識別子が変わったら今の札を捨てる** —— 識別子は札に署名されているので、
   * オフにしても古い札のままでは接続の長さが数えられ続ける。
   * `accepted` は、その報告を添えた札を中継が出したときに、送った報告と、中継が設定を記録できた件数（答えの `usagePrefsRecorded`。
   * 前の版の中継は返さないので null）を渡して呼ぶ（設定の全項目を 1 日 1 回だけ送るため、送れたことを覚える。→ `usageStats.ts` の `markPrefsSent`）
   */
  setUsage(install: string | null, report: (() => unknown) | null, accepted: ((report: unknown, prefsRecorded: number | null) => void) | null): void
  /** いま札に添えている識別子（許可していなければ null） */
  usageInstall(): string | null
  /** 札を取り直したり捨てたりしたら呼ぶ（予報の答えを画面へ出すため）。戻り値で外す */
  subscribe(listener: () => void): () => void
}

interface TokenResponse {
  status?: unknown
  token?: unknown
  expiresAt?: unknown
  forecast?: unknown
  forecastProblem?: unknown
  usagePrefsRecorded?: unknown
  usagePrefsRejected?: unknown
}

const abortedByCaller = () => new DOMException('呼び出し元が中継の札の待ちを打ち切りました', 'AbortError')

/** 呼び手の `signal` が止まったら、その呼び手だけが待ちを抜ける。共有の `promise` は止めない */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | null): Promise<T> {
  if (signal === null) return promise
  if (signal.aborted) return Promise.reject(abortedByCaller())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortedByCaller())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (err: unknown) => { signal.removeEventListener('abort', onAbort); reject(err) },
    )
  })
}

/**
 * 札の持ち手。`nowMs` は端末の単調な時計（既定 `performance.now`）で、壁時計がずれても期限の判定は狂わない。
 * 期限は「中継が返した期限 − 中継の今」の長さを、受け取った時点の単調な時計に足して持つ。中継の今は応答の
 * `Date` 見出しから読み、読めなければ端末の壁時計で代える（そのときは端末の時計のずれがそのまま残る）。
 */
export function createRelayTokenStore(opts: {
  origin?: string
  nowMs?: () => number
  wallNowMs?: () => number
} = {}): RelayTokenStore {
  const origin = opts.origin ?? RELAY_ORIGIN
  const nowMs = opts.nowMs ?? (() => performance.now())
  const wallNowMs = opts.wallNowMs ?? (() => Date.now())
  let token: string | null = null
  let expiresAtMono = 0
  /** まとめた取得。`issuing` は検証の待ちを抜けて `POST /token` を投げたか（投げた後にキーが変わったら、次の取得を別に始める） */
  let inflight: { promise: Promise<string>; issuing: boolean } | null = null
  let forecastKey: string | null = null
  let checking = false
  /** 予報キーの検証が済んだら解ける。検証中でなければ解けたもの */
  let checked: Promise<void> = Promise.resolve()
  let resolveChecked: (() => void) | null = null
  let scope: RelayForecastScope | null = null
  let usageInstall: string | null = null
  let usageReport: (() => unknown) | null = null
  let usageAccepted: ((report: unknown, prefsRecorded: number | null) => void) | null = null
  /** 札を捨てるたびに進める。取りに行っている間にキーが変わったら、届いた札を使わない */
  let generation = 0
  const listeners = new Set<() => void>()
  const notify = () => { for (const l of listeners) l() }

  const usable = () => token !== null && nowMs() < expiresAtMono - REFRESH_MARGIN_MS

  // まとめた取得なので、呼び手の誰かが止めても打ち切らない（長さは取得の時間切れが抑える）
  async function issue(): Promise<string> {
    const startedGeneration = generation
    const sentKey = forecastKey
    const headers: Record<string, string> = sentKey === null ? {} : { Authorization: `Forecast ${sentKey}` }
    // 許可している間だけ、識別子と端末・設定の情報を本文に添える（許可していなければ本文を付けない）
    const sentInstall = usageInstall
    const sentAccepted = usageAccepted
    let requestBody: string | undefined
    let sentReport: unknown = undefined
    if (usageInstall !== null && usageReport !== null) {
      // 報告を組む処理が投げても札は取る（記録のために配信を止めない）。そのときは本文を付けない＝送らない側へ倒す
      try {
        const report = usageReport()
        requestBody = JSON.stringify({ usage: report })
        sentReport = report
        headers['Content-Type'] = 'application/json'
      } catch (err) {
        log.warn('[使用状況] 札に添える報告を組めなかった（この札では送らない）', err)
      }
    }
    const outcome = await fetchJsonOutcome(
      `${origin}/token`,
      {
        timeoutMs: API_FETCH_TIMEOUT_MS,
        signal: null,
        init: { method: 'POST', headers, ...(requestBody === undefined ? {} : { body: requestBody }) },
      },
      (res) => res.ok,
    )
    if (!outcome.ok) throw new RelayTokenError(`中継の札を受け取れませんでした（HTTP ${outcome.status}）`, outcome.status)
    if (!outcome.body || 'error' in outcome.body) throw new RelayTokenError('中継の札の応答を読めませんでした', outcome.status)
    const body = outcome.body.value as TokenResponse
    const expiresMs = typeof body.expiresAt === 'string' ? Date.parse(body.expiresAt) : Number.NaN
    if (body.status !== 'ok' || typeof body.token !== 'string' || body.token === '' || !Number.isFinite(expiresMs)) {
      throw new RelayTokenError('中継の札の応答の形が想定と違います', outcome.status)
    }
    const relayNow = Date.parse(outcome.headers?.get('Date') ?? '')
    const remaining = expiresMs - (Number.isFinite(relayNow) ? relayNow : wallNowMs())
    if (remaining <= REFRESH_MARGIN_MS) throw new RelayTokenError('中継の札の期限が短すぎます', outcome.status)
    // 取りに行っている間に使用状況データの識別子が変わった（許可を切り替えた）。古い識別子の札は渡さず取り直す
    // ——渡すと、許可を外した後もその札の接続に古い識別子が付いたままになる
    // 自分で取り直さず、まとめた取得に相乗りする（setUsage が前の取得を外しているので、新しい識別子の取得は 1 本で済む）
    if (startedGeneration !== generation && sentInstall !== usageInstall) return shared()
    // 中継が報告を添えた札を出した。送れたことを覚える側へ渡す（覚えられなくても札は使う）
    if (sentReport !== undefined && sentAccepted !== null && sentInstall === usageInstall) {
      const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null)
      // 中継が受け付けた件数（書けた＋決まりに合わず捨てた）。前の版の中継は返さないので null
      const rec = int(body.usagePrefsRecorded)
      const recorded = rec === null ? null : rec + (int(body.usagePrefsRejected) ?? 0)
      try { sentAccepted(sentReport, recorded) } catch (err) { log.warn('[使用状況] 送れた報告を覚えられなかった（次の札でも設定を送る）', err) }
    }
    // 取りに行っている間に予報キーが変わった。古いキーの札は渡すが覚えない（次の ensure で新しいキーで取り直す）
    if (startedGeneration !== generation) return body.token
    token = body.token
    expiresAtMono = nowMs() + remaining
    scope = sentKey === null
      ? null
      : { granted: body.forecast === true, problem: typeof body.forecastProblem === 'string' ? body.forecastProblem : null }
    notify()
    return body.token
  }

  function drop() {
    token = null
    expiresAtMono = 0
    generation += 1
  }

  /** まとめた取得を返す。検証中なら済むまで待ってから、そのときのキーで取る */
  function shared(): Promise<string> {
    if (inflight) return inflight.promise
    const entry: { promise: Promise<string>; issuing: boolean } = { promise: Promise.resolve(''), issuing: false }
    entry.promise = (async () => {
      // 待っている間に検証がもう一度始まることがある（キーを書き換え続けている）
      while (checking) await checked
      if (usable()) return token as string
      entry.issuing = true
      return issue()
    })().finally(() => {
      // 自分が置いた分だけを片付ける（予報キーの入れ替えで捨てた後に、次の取りに行きを消さないため）
      if (inflight === entry) inflight = null
    })
    inflight = entry
    return entry.promise
  }

  return {
    current: () => (usable() ? token : null),
    ensure(signal) {
      if (!checking && usable()) return Promise.resolve(token as string)
      // 止まった合図で呼ばれたら、札を取りに行かずに抜ける
      if (signal?.aborted) return Promise.reject(abortedByCaller())
      return untilAborted(shared(), signal ?? null)
    },
    invalidate() {
      drop()
    },
    setForecastKey(key, nextChecking) {
      const next = key === null || key.trim() === '' ? null : key.trim()
      const keyChanged = next !== forecastKey
      if (!keyChanged && nextChecking === checking) return
      if (nextChecking !== checking) {
        checking = nextChecking
        if (checking) {
          checked = new Promise<void>((resolve) => { resolveChecked = resolve })
        } else {
          resolveChecked?.()
          resolveChecked = null
        }
      }
      if (keyChanged) {
        forecastKey = next
        drop()
        // キーを外したら答えも消す。入れ替えたときは、次の札が取れるまで前のキーの答えを出さない
        scope = null
        // 前のキーで投げた取得には相乗りさせない。検証の待ちの中にいる取得は、待ちを抜けた時点のキーで取るので残す
        if (inflight?.issuing) inflight = null
      }
      notify()
    },
    forecastKey: () => forecastKey,
    forecastKeyChecking: () => checking,
    forecastScope: () => scope,
    setUsage(install, report, accepted) {
      usageReport = install === null ? null : report
      usageAccepted = install === null ? null : accepted
      if (install === usageInstall) return
      usageInstall = install
      drop()
      // 前の識別子で投げた取得には相乗りさせない
      if (inflight?.issuing) inflight = null
      notify()
    },
    usageInstall: () => usageInstall,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

/**
 * 中継の門。中継は回数の上限に当たると 429 と `Retry-After`（秒）を返す（設計書 §6.4 の B）。その秒数だけ、
 * 中継への API の要求を待たせる。待っている間の残り時間は「もっと見る」のボタンに出す（§0 の 2026-10-31 の行）。
 * 上限の値そのものはアプリが知らない（非公開側の設定）ので、前もって間隔を空けることはしない。
 */
export interface RelayGate {
  /** 中継が返した `Retry-After`（秒）を覚える。読めない・負なら何もしない */
  noteRetryAfter(seconds: number): void
  /** 待たされている間が明けるまでの残り（ミリ秒）。待っていなければ null */
  remainingMs(): number | null
  /** 待たされている間が明けるまで待つ */
  wait(): Promise<void>
}

export function createRelayGate(opts: {
  nowMs?: () => number
  sleep?: (ms: number) => Promise<void>
} = {}): RelayGate {
  const nowMs = opts.nowMs ?? (() => performance.now())
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  let untilMono = 0
  return {
    noteRetryAfter(seconds) {
      if (!Number.isFinite(seconds) || seconds < 0) return
      untilMono = Math.max(untilMono, nowMs() + seconds * 1000)
    },
    remainingMs: () => {
      const left = untilMono - nowMs()
      return left > 0 ? left : null
    },
    async wait() {
      // 待っている間に別の 429 で延びることがあるので、明けるまで測り直す
      for (let left = untilMono - nowMs(); left > 0; left = untilMono - nowMs()) await sleep(left)
    },
  }
}

/**
 * アプリが中継へ繋ぐときに使う 1 組の札と門。札も門も中継ひとつにつき 1 つでよく、
 * 「もっと見る」の残り時間（→ `components/EarthquakeTab/LoadMoreButton.tsx`）が同じ門を読むため、ここで持つ。
 */
export const relayTokenStore = createRelayTokenStore()
export const relayGate = createRelayGate()

/** 中継の門で待たされている残り（ミリ秒）。待っていなければ null */
export function relayThrottleRemainingMs(): number | null {
  return relayGate.remainingMs()
}

/** 札の見出し。札が無いなら投げる（見出しを作る前に `prepare` で用意する決まり） */
function bearer(store: RelayTokenStore): Record<string, string> {
  const t = store.current()
  if (t === null) throw new RelayTokenError('中継の札を用意する前に見出しを作ろうとしました', null)
  return { Authorization: `Bearer ${t}` }
}

/** 中継へ繋ぐ。API と予報の本体には札を付け、公開バケットの本体には何も付けない */
export function relayEndpoint(store: RelayTokenStore, gate: RelayGate): DmdataEndpoint {
  return {
    apiBase: RELAY_API_BASE,
    dataBase: RELAY_DATA_BASE,
    // 中継の電文一覧は警報 VXSE43 も載せる（加工データの `/v2/gd/eew` は中継に無い）
    telegramListHasEew: true,
    // 中継は鍵の不備で繋げなくなることが無い。札は ensure で取るので、ここでは理由を返さない
    problem: () => null,
    prepare: async (signal) => { await store.ensure(signal) },
    waitApiSlot: () => gate.wait(),
    // 本体と束は公開バケットから返り、Worker を通らない（§6.4 の A）ので待たない。予報の本体と束は中継の口
    // （Worker）を通るので、API と同じ 429 の待ちに並ぶ
    waitDataSlot: (url) => (isRelayPrivateUrl(url) ? gate.wait() : Promise.resolve()),
    observe: (status, headers) => {
      if (status === 401) store.invalidate()
      if (status === 429) gate.noteRetryAfter(Number(headers?.get('Retry-After') ?? Number.NaN))
    },
    apiHeaders: () => bearer(store),
    // 公開バケットには何も付けない（付けると CORS の下調べが走るうえ、要らない札を外へ出す）
    dataHeaders: (url) => (isRelayPrivateUrl(url) ? bearer(store) : {}),
  }
}

/** アプリの REST の取得（履歴・取り戻し・もっと見る・リプレイ）が使う中継の繋ぎ先。札と門は上の 1 組を共有する */
export const relayRestEndpoint: DmdataEndpoint = relayEndpoint(relayTokenStore, relayGate)
