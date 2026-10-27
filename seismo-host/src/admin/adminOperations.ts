// 管理画面から頼む操作（基板の再起動・Wi-Fi の繋ぎ直し・流し直し・ホストの再起動）の、判定と文言（#313）。
//
// **文言はすべて 2026-10-27 ユーザー承認**（案 A ×4 と、追って諮った 3 つ）。言い換えるときは諮り直す
// （`docs/ui-wording-procedure.md`）。ホストの口の答え（`statusServer.ts` の `boardActionReply` ほか）を
// 画面の言葉へ写すのはここだけにして、タブの側で番号を読み分けない。

import { jstClock } from '../detection/detectionWording'
import { ApiError, describeAdminAuthFailure } from './api'

export type BoardAction = 'restart' | 'wifi-reconnect'

/** 確認の窓の中身（`confirmDialog.ts` へ渡す）。 */
export interface OperationConfirm {
  readonly title: string
  readonly body: string
  readonly confirmLabel: string
}

/** 結果の行。`error` なら赤で出す。 */
export interface OperationLine {
  readonly text: string
  readonly error: boolean
}

// ---- 基板の操作 ----

/** `GET /api/board-control` の答え。 */
export interface BoardControlView {
  readonly tokenConfigured: boolean
  readonly reachable: readonly string[]
}

/** `GET /api/board-control` の本文を読む。形が違えば null。 */
export function parseBoardControl(body: unknown): BoardControlView | null {
  if (typeof body !== 'object' || body === null) return null
  const b = body as Record<string, unknown>
  if (typeof b.tokenConfigured !== 'boolean') return null
  if (!Array.isArray(b.reachable) || !b.reachable.every((k) => typeof k === 'string')) return null
  return { tokenConfigured: b.tokenConfigured, reachable: b.reachable as string[] }
}

export const BOARD_ACTION_LABEL: Readonly<Record<BoardAction, string>> = {
  restart: '再起動',
  'wifi-reconnect': 'Wi-Fi を繋ぎ直す',
}

/**
 * 押せるか。押せないなら理由（ボタンの `title` に出す）。
 *
 * **材料が取れていない（`control` が null）ときは、取れなかった理由をそのまま出す**
 * （`unavailable`）。黙って押せなくすると、なぜ押せないのか読めない。
 */
export function boardActionAvailability(
  control: BoardControlView | null,
  unavailable: string | null,
  boardKey: string,
): { readonly enabled: boolean; readonly reason: string | null } {
  if (control === null) return { enabled: false, reason: unavailable }
  if (!control.tokenConfigured) return { enabled: false, reason: 'ホストに基板のトークンが無い（SEISMO_BOARD_ADMIN_TOKEN）' }
  if (!control.reachable.includes(boardKey)) {
    return { enabled: false, reason: '基板の住所が分からない（まだパケットが届いていない）' }
  }
  return { enabled: true, reason: null }
}

/** 基板の操作の確認の窓。`name` は表示名（無ければ基板 Key）。 */
export function boardActionConfirm(action: BoardAction, name: string): OperationConfirm {
  return action === 'restart'
    ? {
        title: `基板「${name}」を再起動しますか？`,
        body: '再起動の間は、この基板の波形が途切れます。',
        confirmLabel: '再起動する',
      }
    : {
        title: `基板「${name}」の Wi-Fi を繋ぎ直しますか？`,
        body: '繋ぎ直す間は、この基板の波形が途切れます。再起動はしません。',
        confirmLabel: '繋ぎ直す',
      }
}

/** 頼めたときの行。 */
export function boardActionSentLine(action: BoardAction): OperationLine {
  return { text: action === 'restart' ? '再起動を頼んだ' : '繋ぎ直しを頼んだ', error: false }
}

/**
 * 頼めなかったときの行。`error` は `apiFetch` が投げたもの。
 *
 * ホストは基板の断り方を 502 にまとめ、本文の `error` で分ける（`statusServer.ts` の `boardActionReply`）。
 * 認証・通信の失敗は、ほかのタブと同じ言い方へ回す。
 */
export function boardActionFailureLine(error: unknown): OperationLine {
  if (error instanceof ApiError) {
    const body = error.body as (Record<string, unknown> & { error?: string }) | null
    switch (body?.error) {
      case 'board-closed':
        return { text: 'この基板は操作を受け付けない（ADMIN_TOKEN を入れずに焼いた）', error: true }
      case 'board-bad-token':
        return { text: '基板のトークンが違う', error: true }
      case 'board-old-firmware':
        return { text: 'この基板のファームは古い（焼き直しが要る）', error: true }
      case 'board-no-reply':
        // 種類だけ日本語で添え、英語の原文（`reason`）は画面に出さない —— ホストの記録に残る
        // （2026-10-27 ユーザー承認「日本語で添える」）。
        return { text: `基板から返事が無い${NO_REPLY_CAUSE_NOTE[String(body.cause)] ?? ''}`, error: true }
      case 'board-unexpected': {
        const status = typeof body.boardStatus === 'number' ? body.boardStatus : '?'
        return { text: `基板が予期しない返事をした（HTTP ${status}）`, error: true }
      }
      case 'no-board-token':
        return { text: 'ホストに基板のトークンが無い（SEISMO_BOARD_ADMIN_TOKEN）', error: true }
      case 'no-board-address':
        return { text: '基板の住所が分からない（まだパケットが届いていない）', error: true }
      case 'board-busy':
        // 別の画面・端末から同じ基板へ頼んでいる最中（2026-10-27 ユーザー承認「最後は適用中とかにして」）。
        return { text: 'この基板はいま適用中', error: true }
    }
  }
  return { text: describeFailure(error), error: true }
}

/** 返事が無かった種類の添え書き（`boardControl.ts` の `BoardNoReplyCause`）。それ以外は何も添えない。 */
const NO_REPLY_CAUSE_NOTE: Readonly<Record<string, string>> = {
  timeout: '（時間切れ）',
  refused: '（繋ぎを断られた）',
}

// ---- 流し直し ----

/** `GET /api/redetect` の答え（`redetectRunner.ts` の `RedetectRunState`）。 */
export type RedetectStateView =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running'; readonly startedAtMs: number }
  | {
      readonly kind: 'done'
      readonly startedAtMs: number
      readonly finishedAtMs: number
      readonly ok: boolean
      readonly written: number | null
      readonly existing: number | null
      readonly reason: string | null
      /** 成功したが流せなかった所（道具の警告の文）。 */
      readonly warnings: readonly string[]
    }

/** `GET /api/redetect` の本文を読む。形が違えば null。 */
export function parseRedetectState(body: unknown): RedetectStateView | null {
  if (typeof body !== 'object' || body === null) return null
  const b = body as Record<string, unknown>
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
  const countOrNull = (v: unknown): number | null | undefined => (v === null ? null : num(v) ? v : undefined)
  if (b.kind === 'idle') return { kind: 'idle' }
  if (b.kind === 'running') return num(b.startedAtMs) ? { kind: 'running', startedAtMs: b.startedAtMs } : null
  if (b.kind !== 'done') return null
  const written = countOrNull(b.written)
  const existing = countOrNull(b.existing)
  if (!num(b.startedAtMs) || !num(b.finishedAtMs) || typeof b.ok !== 'boolean') return null
  if (written === undefined || existing === undefined) return null
  if (b.reason !== null && typeof b.reason !== 'string') return null
  if (!Array.isArray(b.warnings) || !b.warnings.every((w) => typeof w === 'string')) return null
  return {
    kind: 'done',
    startedAtMs: b.startedAtMs,
    finishedAtMs: b.finishedAtMs,
    ok: b.ok,
    written,
    existing,
    reason: b.reason as string | null,
    warnings: b.warnings as string[],
  }
}

export const REDETECT_ALL_STATIONS_LABEL = 'すべての観測点'
export const REDETECT_BUTTON_LABEL = 'この期間を流し直す'

export const REDETECT_CONFIRM: OperationConfirm = {
  title: 'この期間を流し直しますか？',
  body: '保存してある波形を今の検出に通し、記録に無い揺れを書き足します。既にある記録は書き換えません。照合のために P2PQuake から地震情報を取ります。',
  confirmLabel: '流し直す',
}

/**
 * 進み具合の行（`idle` なら null）。`nowMs` はホストの時計（日付を添えるかを決める。`jstClock`）。
 */
export function redetectLine(state: RedetectStateView, nowMs: number): OperationLine | null {
  if (state.kind === 'idle') return null
  if (state.kind === 'running') return { text: `流し直している（${jstClock(state.startedAtMs, nowMs)} から）`, error: false }
  if (state.ok) {
    const counts = `流し直した: 書いた ${state.written ?? '?'} 件・既にあった ${state.existing ?? '?'} 件`
    // **読めなかった控えがあれば、成功の行でも赤で添える**（2026-10-27 ユーザー承認「3 つとも足す」）。
    // 緑のままだと、起こせていない揺れがあることが画面から消える。
    if (state.warnings.length > 0) {
      return { text: `${counts}。ただし読めなかった所がある: ${state.warnings.join('／')}`, error: true }
    }
    return { text: counts, error: false }
  }
  return redetectFailureLine(state.reason ?? '終了コード ?')
}

export function redetectFailureLine(reason: string): OperationLine {
  return { text: `流し直しがうまくいかなかった: ${reason}`, error: true }
}

/**
 * 走っているのを見ていたのに、次に訊いたら何もしていない（`idle`）と返ったときの行。ホストが起動し直すと
 * 流し直しの記憶ごと消えるので、この形でしか分からない（2026-10-27 ユーザー承認「3 つとも足す」）。
 */
export const REDETECT_INTERRUPTED_LINE: OperationLine = {
  text: '流し直しが途中で止まった（ホストが起動し直したため）',
  error: true,
}

/** 進み具合を訊けなかったときの行（2026-10-27 ユーザー承認「3 つとも足す」）。 */
export function redetectPollFailureLine(error: unknown): OperationLine {
  return { text: `流し直しの進み具合を訊けない: ${describeFailure(error)}`, error: true }
}

/** ホストが流し直しの範囲を断った理由（`parseRedetectRequest`）。2026-10-27 ユーザー承認「案のとおり出す」。 */
const REDETECT_REJECT_REASON: Readonly<Record<string, string>> = {
  'range-in-future': '期間の始まりが未来になっている',
  'bad-range': '期間の指定が正しくない',
  'bad-station': '観測点の指定が正しくない',
}

/** 始められなかったとき（`POST /api/redetect` が投げた）の理由。 */
export function redetectStartFailureLine(error: unknown): OperationLine {
  if (error instanceof ApiError && error.status === 400) {
    const code = (error.body as { error?: unknown } | null)?.error
    const reason = typeof code === 'string' ? REDETECT_REJECT_REASON[code] : undefined
    if (reason !== undefined) return redetectFailureLine(reason)
  }
  return redetectFailureLine(describeFailure(error))
}

/** 流す観測点の一覧を取れなかったときの行（2026-10-27 ユーザー承認「案のとおり出す」）。 */
export function redetectStationsFailureLine(error: unknown): OperationLine {
  return { text: `観測点の一覧を取れなかった（すべての観測点だけ選べる）: ${describeFailure(error)}`, error: true }
}

// ---- ホストの再起動 ----

export const HOST_RESTART_BUTTON_LABEL = 'ホストを再起動'

export const HOST_RESTART_CONFIRM: OperationConfirm = {
  title: 'ホストを再起動しますか？',
  body: '締めくくってから終わり、サービスが約 1 分後に起動し直します。その間は受信も記録も止まります。サービスで動かしていないときは、止まったままになります。',
  confirmLabel: '再起動する',
}

/** `POST /api/restart` が 202 で返したときの行（`status` は本文の欄）。 */
export function hostRestartAcceptedLine(status: unknown): OperationLine {
  return status === 'already-closing'
    ? { text: 'もう締めくくりの途中で、再起動は頼めなかった', error: true }
    : { text: '再起動を頼んだ。起動し直すまで繋がらない', error: false }
}

/** `POST /api/restart` が投げたときの行。 */
export function hostRestartFailureLine(error: unknown): OperationLine {
  if (error instanceof ApiError && error.status === 503 && error.body?.error === 'not-ready') {
    return { text: '起動の途中なので、まだ頼めない。少し待ってから押し直す', error: true }
  }
  return { text: describeFailure(error), error: true }
}

/** 認証の理由はほかのタブと同じ言い方へ（`describeAdminAuthFailure`）、それ以外は投げた文のまま。 */
function describeFailure(error: unknown): string {
  if (error instanceof ApiError) {
    const auth = describeAdminAuthFailure(error.message)
    if (auth !== null) return auth
  }
  return error instanceof Error ? error.message : String(error)
}
