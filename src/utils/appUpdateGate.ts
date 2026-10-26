/**
 * 読み直し（新しい版の適用・毎朝の定期の読み直し）を、いま秒読みしてよいかを決める。
 *
 * 読み直すと、接続の張り直し・履歴の取り直し・揺れ検知の助走のやり直しが起きる。だから
 * **いま画面を見ている理由があるあいだは読み直さない** —— 警報・情報の発表中、リプレイの再生中、
 * 文字を入力している最中。待つ理由が消えたら、秒読みから始め直す（2026-10-26 ユーザー承認
 * 「再生中・入力中は更新しない」「秒読み＋『後で』」）。
 *
 * 新しい版の適用と定期の読み直しが同時に待っているときは、適用を選ぶ。適用も読み直しを伴うので、
 * 定期の分はそれで済む。
 */

/** 読み直したい理由。 */
export type ReloadReason = 'update' | 'periodic'

/** 秒読みを待たせている理由。 */
export type ReloadHoldCause = 'alert' | 'replay' | 'typing' | 'reading' | 'postponed'

export interface ReloadGateInput {
  /** 新しい版が待っているか（サービスワーカーが waiting にいる）。 */
  updateWaiting: boolean
  /** 毎朝の定期の読み直しの時刻を過ぎたか。 */
  periodicDue: boolean
  /** 警報・情報の発表中か（ウィンドウのタイトルが警報の名乗りになっている間）。 */
  alertActive: boolean
  /** リプレイの再生中か。 */
  replaying: boolean
  /** 文字を入力する欄にフォーカスがあるか。 */
  typing: boolean
  /** 変更内容の窓を開いているか（窓は画面全体を覆うので、秒読みの札も［後で］も見えなくなる）。 */
  reading: boolean
  /** 「後で」で延ばした期限（端末の時計 `Date.now()` の値）。延ばしていなければ `null`。 */
  postponedUntilMs: number | null
  /** いまの `Date.now()`。 */
  nowMs: number
}

export type ReloadGate =
  | { kind: 'none' }
  | { kind: 'held'; reason: ReloadReason; cause: ReloadHoldCause }
  | { kind: 'countdown'; reason: ReloadReason }

/**
 * 待つ理由の並びは、利用者にとって重い順。発表中がいちばん重く、「後で」は本人が選んだ待ちなので
 * いちばん軽い（どの理由で待っているかは記録とテストで見分けるためで、並びが挙動を変えることは無い）。
 */
export function decideReloadGate(input: ReloadGateInput): ReloadGate {
  const reason: ReloadReason | null = input.updateWaiting ? 'update' : input.periodicDue ? 'periodic' : null
  if (reason === null) return { kind: 'none' }
  if (input.alertActive) return { kind: 'held', reason, cause: 'alert' }
  if (input.replaying) return { kind: 'held', reason, cause: 'replay' }
  if (input.typing) return { kind: 'held', reason, cause: 'typing' }
  if (input.reading) return { kind: 'held', reason, cause: 'reading' }
  if (input.postponedUntilMs !== null && input.nowMs < input.postponedUntilMs) {
    return { kind: 'held', reason, cause: 'postponed' }
  }
  return { kind: 'countdown', reason }
}

/** 秒読みの長さ（秒）。 */
export const RELOAD_COUNTDOWN_SEC = 10

/** 「後で」を押したときに延ばす長さ（2026-10-26 ユーザー承認「1 時間待ち、その後また静かなときに秒読み」）。 */
export const RELOAD_POSTPONE_MS = 60 * 60 * 1000

/**
 * 文字を入力する欄か。チェックボックスやボタンにフォーカスがあるだけでは入力中と見なさない
 * （押した直後にフォーカスが残るので、そこで待つと設定を 1 つ切り替えただけで更新が止まる）。
 */
export function isTextEntryElement(el: Element | null): boolean {
  if (el === null) return false
  const tag = el.tagName
  if (tag === 'TEXTAREA') return true
  if (tag === 'SELECT') return false
  if ((el as HTMLElement).isContentEditable === true) return true
  if (tag !== 'INPUT') return false
  const type = ((el as HTMLInputElement).type || 'text').toLowerCase()
  return TEXT_ENTRY_INPUT_TYPES.has(type)
}

const TEXT_ENTRY_INPUT_TYPES: ReadonlySet<string> = new Set([
  'text', 'search', 'url', 'email', 'password', 'tel', 'number',
  'date', 'datetime-local', 'time', 'month', 'week',
])
