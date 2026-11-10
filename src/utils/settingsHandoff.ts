/**
 * 旧 URL（github.io の `/yuremado/`・`/yuremado/dmdss/`）に置く橋渡しのページから、端末の設定を受け取る。
 *
 * 橋渡しのページ（`bridge/handoff.js`）は、旧アドレスに保存された設定を読み、URL の `#` の後ろに載せて
 * 新しいアドレスを開く（`#` 以降はサーバーへ送られない）。ここはその受け手。形はあちらと対で、
 * `scripts/bridgeHandoff.test.ts` が往復で固定している。
 *
 * **鍵は受け取らない**（設計書 §0 2026-10-30「橋渡しのページは鍵を渡さない」）。橋渡し側でも外しているが、
 * こちらでも外す。代わりに「旧アドレスで API キーを使っていたか」だけを受け取り、鍵の入れ直しの案内を出す。
 *
 * **新しいアドレスに設定の保存が既にあれば、渡された設定は捨てる**（2026-10-31 ユーザー選択「上書きしない (Recommended)」）。
 * 新しいアドレスで変えた設定が、旧アドレスの古い設定で消えないようにするため。
 * 設定は利用者が変えたときにしか保存されないので、保存が無いことを「この端末で初めて開いた」の目印にできる。
 *
 * **案内のページから来たときだけ受け取る**（2026-10-31 ユーザー決定「来た元を確かめる」）。`#` の形は誰でも作れるので、
 * そのままだと他人の作ったリンクで VOICEVOX・自作地震計の接続先や登録地点を差し込める。来た元は `document.referrer` の
 * 生成元で見る。案内のページのリンクは `referrerpolicy="origin"` で生成元を必ず届ける（`bridge/index.html` の `a#go`）。
 */

/**
 * 案内のページ（旧アドレス）の生成元。GitHub Pages の配信先で、`/yuremado/` と `/yuremado/dmdss/` の両方がこの生成元に入る
 * （`.github/workflows/deploy.yml` の橋渡しのページの配信。アドレスは README の「以前のアドレス」と同じ）。
 */
export const BRIDGE_ORIGIN = 'https://ramilen-l-emuruk.github.io'

/** URL の `#` の後ろの形。橋渡し側（`bridge/handoff.js` の `HANDOFF_PREFIX`）と同じ値にする */
export const SETTINGS_HANDOFF_PREFIX = '#yuremado-settings='

/** 橋渡しで渡さない欄。鍵（DMDATA の API キー・到達予想キー・予報キー）は渡さない */
export const HANDOFF_SECRET_KEYS = ['dmdataApiKey', 'arrivalToken', 'forecastKey'] as const

export interface SettingsHandoff {
  /** 旧アドレスに保存されていた設定（鍵の欄は外したもの）。値の検査は読み込みの `sanitize()` に任せる */
  settings: Record<string, unknown>
  /** 旧アドレスで DMDATA の API キーを入れていたか */
  hadApiKey: boolean
}

export type HandoffResult =
  /** URL に渡された設定が無かった */
  | 'none'
  /** 渡された設定が読めなかった */
  | 'invalid'
  /** 案内のページ以外から来た（来た元が届かなかったときも含む）ので、渡された設定は読まずに捨てた */
  | 'foreign'
  /** 新しいアドレスに設定が既にあったので、渡された設定は捨てた */
  | 'kept'
  /** 渡された設定を保存した */
  | 'applied'

function fromBase64Url(text: string): string {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0))
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** URL の `#` から渡された設定を読む。形が違えば null（読めない値を半端に採らない） */
export function decodeSettingsHandoff(hash: string): SettingsHandoff | null {
  if (!hash.startsWith(SETTINGS_HANDOFF_PREFIX)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(fromBase64Url(hash.slice(SETTINGS_HANDOFF_PREFIX.length)))
  } catch {
    return null
  }
  if (!isPlainObject(parsed) || parsed.v !== 1) return null
  if (!isPlainObject(parsed.settings) || typeof parsed.hadApiKey !== 'boolean') return null
  const settings = { ...parsed.settings }
  for (const key of HANDOFF_SECRET_KEYS) delete settings[key]
  return { settings, hadApiKey: parsed.hadApiKey }
}

export interface HandoffEnv {
  hash: string
  /** URL から `#` を消す。渡された設定を履歴に残さないため、読めても読めなくても消す */
  clearHash: () => void
  storage: Pick<Storage, 'getItem' | 'setItem'>
  storageKey: string
  /** 来た元（`document.referrer`）。届かなければ空文字 */
  referrer: string
}

/** 来た元が案内のページの生成元か。読めない・空なら偽 */
function isFromBridge(referrer: string): boolean {
  try {
    return new URL(referrer).origin === BRIDGE_ORIGIN
  } catch {
    return false
  }
}

/**
 * URL に渡された設定があれば受け取り、新しいアドレスにまだ保存が無ければ保存する。案内のページから来たときだけ受け取り、
 * それ以外は何も保存しない（`#` はどちらでも消す）。
 *
 * 保存するのは渡された値そのもの（鍵を外し、鍵の入れ直しの案内の印を足したもの）。値の検査と古い形からの移し替えは、
 * 端末の設定を読むときの `sanitize()` と `migrateStoredSettings()` に任せる —— ここで `sanitize()` を通すと、
 * 古い形の目印（足される前の欄が無いこと）が既定値で埋まり、移し替えが効かなくなる。
 */
export function consumeSettingsHandoff(env: HandoffEnv): HandoffResult {
  if (!env.hash.startsWith(SETTINGS_HANDOFF_PREFIX)) return 'none'
  env.clearHash()
  if (!isFromBridge(env.referrer)) return 'foreign'
  const handoff = decodeSettingsHandoff(env.hash)
  if (handoff === null) return 'invalid'
  if (env.storage.getItem(env.storageKey) !== null) return 'kept'
  env.storage.setItem(env.storageKey, JSON.stringify({ ...handoff.settings, dmdataKeyReentryNotice: handoff.hadApiKey }))
  return 'applied'
}
