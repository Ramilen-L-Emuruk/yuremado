// 基板の再起動・Wi-Fi の繋ぎ直しを、ホストが代わりに頼む（#313 管理操作・2026-10-27 ユーザー承認）。
//
// - 基板の口は `POST /restart`・`POST /wifi-reconnect`（`firmware/seismo-node/seismo-node.ino`）。
//   どちらも**応答を返してから動く**ので、200 が返れば「頼めた」と言える
// - **基板のトークンは管理画面のトークンと分ける**（環境変数 `SEISMO_BOARD_ADMIN_TOKEN`。同日ユーザー承認）。
//   基板へは LAN の素の HTTP で送るので、通り道で読まれても漏れるのは基板を再起動できる鍵だけにする
// - 基板の住所は、受け取れたパケットの送り元から覚える（{@link BoardAddressBook}）
// - **断られ方は番号ごとに分けて返す**（501 と 403 を同じにしない。理由は基板の `adminAllowed`）

/** 基板が要求するトークンのヘッダ（基板の `ADMIN_TOKEN_HEADER` と同じ名前）。 */
export const BOARD_TOKEN_HEADER = 'X-Seismo-Token'

/** 頼める操作。値は基板の口の名前そのもの。 */
export type BoardAction = 'restart' | 'wifi-reconnect'

export function isBoardAction(value: string): value is BoardAction {
  return value === 'restart' || value === 'wifi-reconnect'
}

/**
 * 頼んだ結果。
 *
 * - `sent` —— 基板が受けた（200）
 * - `no-token` —— ホストに基板のトークンが無い（基板へは何も送らない）
 * - `no-address` —— 基板の住所が分からない（ホストが起動してからパケットが 1 つも届いていない）
 * - `closed` —— 501。基板の口は閉じている（`ADMIN_TOKEN` を入れずに焼いた）
 * - `bad-token` —— 403。トークンが違う
 * - `old-firmware` —— 404。この口を持つ前のファームのまま
 * - `unexpected` —— それ以外の番号
 * - `no-reply` —— 返事が無い。`cause` は画面へ出す種類（時間切れ・繋ぎを断られた・それ以外）、`reason` は記録に出す原文
 * - `busy` —— 同じ基板へ頼んでいる最中（{@link BoardActionGuard}。基板へは何も送らない）
 */
export type BoardActionResult =
  | { readonly kind: 'sent' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'no-token' }
  | { readonly kind: 'no-address' }
  | { readonly kind: 'closed' }
  | { readonly kind: 'bad-token' }
  | { readonly kind: 'old-firmware' }
  | { readonly kind: 'unexpected'; readonly status: number }
  | { readonly kind: 'no-reply'; readonly cause: BoardNoReplyCause; readonly reason: string }

/** 返事が無かった理由のうち、画面で言い分けるもの（2026-10-27 ユーザー承認「日本語で添える」）。 */
export type BoardNoReplyCause = 'timeout' | 'refused' | 'other'

/** 基板ごとの、最後にパケットが届いた送り元。 */
export class BoardAddressBook {
  private readonly addresses = new Map<string, string>()

  note(boardKey: string, address: string): void {
    this.addresses.set(boardKey, address)
  }

  addressOf(boardKey: string): string | null {
    return this.addresses.get(boardKey) ?? null
  }

  /** 住所の分かっている基板。 */
  known(): readonly string[] {
    return [...this.addresses.keys()]
  }
}

export interface BoardControlDeps {
  /** 基板のトークン。**空文字は無いのと同じ**（基板も空のトークンは必ず拒む）。 */
  readonly token: string | null
  readonly addressOf: (boardKey: string) => string | null
  readonly fetch: (
    url: string,
    init: { readonly method: 'POST'; readonly headers: Record<string, string>; readonly timeoutMs: number },
  ) => Promise<{ readonly status: number }>
  readonly timeoutMs: number
}

/** 外への取得のうち、{@link boardFetch} が使う分（テストで偽物を渡せるように）。 */
export type FetchLike = (
  url: string,
  init: { readonly method: string; readonly headers: Record<string, string>; readonly redirect: 'manual'; readonly signal: AbortSignal },
) => Promise<{ readonly status: number; readonly body: { cancel(): Promise<void> } | null }>

/**
 * {@link BoardControlDeps.fetch} を外への取得から作る。
 *
 * **リダイレクトに付いていかない**（トークンを載せたまま別の宛先へ送らない）。基板はリダイレクトを返さないので、
 * 返ってきたら「予期しない返事」として番号を出す。**本文は読まずに捨てる**（読まないと繋ぎが空かない）。
 */
export function boardFetch(fetchImpl: FetchLike): BoardControlDeps['fetch'] {
  return async (url, init) => {
    const res = await fetchImpl(url, {
      method: init.method,
      headers: init.headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(init.timeoutMs),
    })
    await res.body?.cancel().catch(() => {})
    return { status: res.status }
  }
}

/** 基板へ操作を頼む。**投げない。** */
export async function sendBoardAction(deps: BoardControlDeps, boardKey: string, action: BoardAction): Promise<BoardActionResult> {
  if (deps.token === null || deps.token.length === 0) return { kind: 'no-token' }
  const address = deps.addressOf(boardKey)
  if (address === null) return { kind: 'no-address' }
  let status: number
  try {
    const res = await deps.fetch(`http://${address}/${action}`, {
      method: 'POST',
      headers: { [BOARD_TOKEN_HEADER]: deps.token },
      timeoutMs: deps.timeoutMs,
    })
    status = res.status
  } catch (error) {
    return { kind: 'no-reply', cause: classifyNoReply(error), reason: describeNoReply(error) }
  }
  if (status === 200) return { kind: 'sent' }
  if (status === 501) return { kind: 'closed' }
  if (status === 403) return { kind: 'bad-token' }
  if (status === 404) return { kind: 'old-firmware' }
  return { kind: 'unexpected', status }
}

/**
 * 取得が投げたものから、返事が無かった種類を読む。**時間切れは `AbortSignal.timeout` が投げる
 * `TimeoutError`**、断られたのは undici が `fetch failed` の `cause` に載せる `ECONNREFUSED`。
 */
function classifyNoReply(error: unknown): BoardNoReplyCause {
  if (error instanceof Error && error.name === 'TimeoutError') return 'timeout'
  const code = (e: unknown): unknown => (typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined)
  if (code(error) === 'ECONNREFUSED') return 'refused'
  if (error instanceof Error && code(error.cause) === 'ECONNREFUSED') return 'refused'
  return 'other'
}

/** 記録に出す原文。undici の `fetch failed` だけでは何も分からないので、`cause` の文を添える。 */
function describeNoReply(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause = error.cause instanceof Error ? error.cause.message : null
  return cause !== null && cause !== error.message ? `${error.message}: ${cause}` : error.message
}

/**
 * 同じ基板へ重ねて頼まない（2026-10-27 ユーザー承認「頼んでいる最中」→ 文は「適用中」）。
 *
 * 基板は返事をしてから少し後に動くので、重ねて送ると再起動・繋ぎ直しを 2 回する。同じ画面の連打はボタンを
 * 押せなくして防いでいるが、別の画面・別の端末から同時に押した分はホストでしか止められない。
 *
 * **頼めた（`sent`）後も、その基板からパケットが届き直すまでは適用中のまま**（2026-10-27 ユーザー承認
 * 「届くまで保つ」）。返事の直後はまだ動き始めていないので、送り終えた時点で解くと、戻ってくる前の基板へ
 * 重ねて頼めてしまう。戻ってこない基板で永久に押せなくならないよう、{@link BOARD_ACTION_HOLD_MAX_MS} で解く。
 *
 * **「届き直した」は、{@link BOARD_ACTION_RETURN_GAP_MS} 以上途切れた後に届いたパケットで見る。** 基板は
 * 返事をしてから約 200 ms 後に動くので、その間も普段どおりパケットが届く（遅れて届く UDP もある）。
 * 届いただけで解くと、まだ落ちていない基板のパケットで解けてしまう。
 */
export class BoardActionGuard {
  private readonly inFlight = new Set<string>()
  /** 頼めた基板ごとの、頼めた時刻と最後にパケットが届いた時刻（`nowMs`）。届き直すか上限を過ぎるまで残す。 */
  private readonly awaitingReturn = new Map<string, { readonly sentAtMs: number; lastPacketAtMs: number }>()

  constructor(
    private readonly nowMs: () => number,
    private readonly holdMaxMs: number = BOARD_ACTION_HOLD_MAX_MS,
    private readonly returnGapMs: number = BOARD_ACTION_RETURN_GAP_MS,
  ) {}

  async run(boardKey: string, send: () => Promise<BoardActionResult>): Promise<BoardActionResult> {
    if (this.inFlight.has(boardKey) || this.isAwaitingReturn(boardKey)) return { kind: 'busy' }
    this.inFlight.add(boardKey)
    try {
      const result = await send()
      if (result.kind === 'sent') {
        const now = this.nowMs()
        this.awaitingReturn.set(boardKey, { sentAtMs: now, lastPacketAtMs: now })
      }
      return result
    } finally {
      this.inFlight.delete(boardKey)
    }
  }

  /**
   * その基板からパケットが届いた（受信の経路から、読めたパケットごとに呼ぶ）。前に届いてから
   * {@link BOARD_ACTION_RETURN_GAP_MS} 以上空いていれば、落ちて戻ってきたとみて解く。続けて届いている間は
   * 最後に届いた時刻を進めるだけ。**読めなかった・速度の上限で捨てたパケットでは呼ばれない**ので、戻りの
   * 最初の数個がそうだと解けるのが遅れる（上限 {@link BOARD_ACTION_HOLD_MAX_MS} が救う）。
   */
  notePacket(boardKey: string): void {
    const entry = this.awaitingReturn.get(boardKey)
    if (entry === undefined) return
    const now = this.nowMs()
    if (now - entry.lastPacketAtMs >= this.returnGapMs) {
      this.awaitingReturn.delete(boardKey)
      return
    }
    entry.lastPacketAtMs = now
  }

  private isAwaitingReturn(boardKey: string): boolean {
    const entry = this.awaitingReturn.get(boardKey)
    if (entry === undefined) return false
    if (this.nowMs() - entry.sentAtMs < this.holdMaxMs) return true
    this.awaitingReturn.delete(boardKey)
    return false
  }
}

/**
 * 頼めた後に適用中として保つ上限。**実機の再起動で波形が抜けた長さは 15.4〜20.8 秒**（2026-10-27 に ホストの機械 の
 * ログの `基板が再起動した` 12 件を 100 Hz で換算。ほかに電源ごと止まっていた 1 件だけ 2.8 時間）。その最長の約 3 倍。
 * Wi-Fi の繋ぎ直しは再起動より短いので、同じ上限に収まる。
 */
export const BOARD_ACTION_HOLD_MAX_MS = 60_000

/**
 * これだけパケットが途切れた後に届いたら「落ちて戻ってきた」とみる。普段のパケットの間隔（1 秒に数個）より
 * 十分長く、再起動で抜けた最短（15.4 秒）より十分短い。繋ぎ直しがこれより短く済めば、上限まで保つ。
 */
export const BOARD_ACTION_RETURN_GAP_MS = 3_000

/** 管理画面が「押せるか」を決める材料（`GET /api/board-control`）。 */
export interface BoardControlState {
  readonly tokenConfigured: boolean
  /** 住所の分かっている基板の鍵。 */
  readonly reachable: readonly string[]
}

export function boardControlState(token: string | null, book: BoardAddressBook): BoardControlState {
  return { tokenConfigured: token !== null && token.length > 0, reachable: book.known() }
}
