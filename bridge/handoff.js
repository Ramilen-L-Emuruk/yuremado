// @ts-check
/**
 * 旧 URL（github.io の `/yuremado/`・`/yuremado/dmdss/`）に置く橋渡しのページの本体。
 *
 * 旧アドレスに保存された設定を読み、URL の `#` の後ろに載せて新しいアドレスへ渡す（`#` 以降はサーバーへ送られない）。
 * 受け手は `src/utils/settingsHandoff.ts`。形は対で、`scripts/bridgeHandoff.test.ts` が往復で固定している。
 *
 * - 読む順は `quake-viewer-settings-dmdss` が先、無ければ `quake-viewer-settings`（設計書 §0 2026-10-30）
 * - **鍵は渡さない**（同 §0「橋渡しのページは鍵を渡さない」）。API キーを使っていたかだけを渡す
 * - ビルドを通さずそのまま配る。依存を持たない
 */

export const NEW_APP_URL = 'https://yuremado.com/'

/** 受け手（`SETTINGS_HANDOFF_PREFIX`）と同じ値にする */
export const HANDOFF_PREFIX = '#yuremado-settings='

const OLD_SETTINGS_KEYS = ['quake-viewer-settings-dmdss', 'quake-viewer-settings']
const SECRET_KEYS = ['dmdataApiKey', 'arrivalToken', 'forecastKey']

/**
 * 旧アドレスに保存された設定を読む。読めない値の鍵は飛ばして次を見る。どちらも無ければ null。
 * @param {Pick<Storage, 'getItem'>} storage
 * @returns {Record<string, unknown> | null}
 */
export function readOldSettings(storage) {
  for (const key of OLD_SETTINGS_KEYS) {
    let raw
    try {
      raw = storage.getItem(key)
    } catch {
      return null
    }
    if (raw === null) continue
    try {
      const parsed = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed
    } catch {
      // 壊れた値は採らずに次の候補を見る
    }
  }
  return null
}

/** @param {string} text */
function toBase64Url(text) {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * 引き継ぐ欄が 1 つでもあるか（案内のページの文の出し分け）。鍵の欄と、値が null の欄は数えない。
 * 偽・0・空文字は利用者が選んだ値なので数える。
 * @param {Record<string, unknown> | null} old
 */
export function hasSettingsToCarry(old) {
  if (old === null) return false
  return Object.entries(old).some(([key, value]) => !SECRET_KEYS.includes(key) && value !== null && value !== undefined)
}

/** 旧アプリの Service Worker の scope のパス。同じ生成元（github.io の利用者ごとのサブドメイン）にある別のアプリの登録は外さない */
const OLD_APP_SCOPE_PATH = '/yuremado/'

/**
 * 外してよい登録か（旧アプリのもの）。scope のパスが `/yuremado/` で始まるものだけ。読めない scope は外さない。
 * @param {string} scope `ServiceWorkerRegistration.scope`
 */
export function isOldAppRegistration(scope) {
  try {
    return new URL(scope).pathname.startsWith(OLD_APP_SCOPE_PATH)
  } catch {
    return false
  }
}

/**
 * 新しいアドレスの URL を組む。設定が無ければ素の URL。
 * @param {Record<string, unknown> | null} old
 */
export function buildHandoffUrl(old) {
  if (old === null) return NEW_APP_URL
  const settings = { ...old }
  for (const key of SECRET_KEYS) delete settings[key]
  const hadApiKey = typeof old.dmdataApiKey === 'string' && old.dmdataApiKey !== ''
  return NEW_APP_URL + HANDOFF_PREFIX + toBase64Url(JSON.stringify({ v: 1, settings, hadApiKey }))
}

/**
 * ページに文と行き先を入れる。旧アプリの Service Worker が残っていれば外す。
 * 行き先のリンク（`a#go`）は `referrerpolicy="origin"` で、受け手が来た元（この生成元）を確かめられるようにしてある
 * （→ `src/utils/settingsHandoff.ts` の `BRIDGE_ORIGIN`）。
 */
function start() {
  const old = readOldSettings(localStorage)
  const link = /** @type {HTMLAnchorElement} */ (document.getElementById('go'))
  link.href = buildHandoffUrl(old)
  const carried = document.getElementById(hasSettingsToCarry(old) ? 'carried' : 'no-settings')
  if (carried !== null) carried.hidden = false
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations()
      .then(regs => Promise.all(regs.filter(r => isOldAppRegistration(r.scope)).map(r => r.unregister())))
      .catch(() => {})
  }
}

if (typeof document !== 'undefined') start()
