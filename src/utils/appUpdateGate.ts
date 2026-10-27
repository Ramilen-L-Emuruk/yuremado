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
export type ReloadHoldCause = 'alert' | 'replay' | 'typing' | 'settings' | 'reading' | 'postponed'

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
  /**
   * 設定の窓を開いている間に最後に操作した時刻（`Date.now()` の値）。窓を閉じていれば `null`。
   * 窓は画面全体を覆い、後ろのページを `inert` にするので、秒読みの札も［後で］も見えず押せない。
   * トグルやボタンを触っているだけでは `typing` に当たらないので、別に待つ。
   * **ただし操作が無いまま `SETTINGS_IDLE_HOLD_LIMIT_MS` 経ったら待たない**（開けたまま離れた端末で、
   * 自動復帰を切っていると窓が閉じないため、待ちが終わらない）。
   */
  settingsLastActivityMs: number | null
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
  if (input.settingsLastActivityMs !== null && input.nowMs - input.settingsLastActivityMs < SETTINGS_IDLE_HOLD_LIMIT_MS) {
    return { kind: 'held', reason, cause: 'settings' }
  }
  if (input.reading) return { kind: 'held', reason, cause: 'reading' }
  if (input.postponedUntilMs !== null && input.nowMs < input.postponedUntilMs) {
    return { kind: 'held', reason, cause: 'postponed' }
  }
  return { kind: 'countdown', reason }
}

/**
 * 設定の窓を開いたまま操作が無いとき、読み直しを待つ長さ。過ぎたら窓の後ろで秒読みする（札と［後で］は窓に
 * 隠れて見えないので、窓の中で入力途中の値は読み直しで消える）（2026-10-27 ユーザー承認。選んだ選択肢
 * 「一定時間で待つのをやめる」「窓の後ろで秒読みする」「30 分 (Recommended)」）。
 */
export const SETTINGS_IDLE_HOLD_LIMIT_MS = 30 * 60 * 1000

/** 秒読みの長さ（秒）。 */
export const RELOAD_COUNTDOWN_SEC = 10

/** 「後で」を押したときに延ばす長さ（2026-10-26 ユーザー承認「1 時間待ち、その後また静かなときに秒読み」）。 */
export const RELOAD_POSTPONE_MS = 60 * 60 * 1000

/**
 * 設定の窓に付ける印（`SettingsDialog`）。窓の中の操作・入力欄を見分けるのに使う。
 */
export const SETTINGS_DIALOG_ATTR = 'data-settings-dialog'

/** 要素が設定の窓の中にあるか。 */
export function isInsideSettingsDialog(el: Element | null): boolean {
  return el !== null && el.closest(`[${SETTINGS_DIALOG_ATTR}]`) !== null
}

/**
 * 秒読みを待たせる「入力中」か。**設定の窓の中の入力欄は数えない** —— 窓の中は窓の待ち（`settingsLastActivityMs`）が
 * 受け持ち、操作が無いまま 30 分で明ける。入力中に数えると、欄にフォーカスを置いたまま離れた端末で待ちが終わらない
 * （2026-10-27 ユーザー承認の「一定時間で待つのをやめる」。入力途中の値が読み直しで消えるのも承知のうえ）。
 */
export function isTypingOutsideSettings(el: Element | null): boolean {
  return isTextEntryElement(el) && !isInsideSettingsDialog(el)
}

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
