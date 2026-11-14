import type { ConnectionStatus } from '../../types/earthquake'
import type { RelayUpstreamStatus } from '../../services/dmdata'
import { formatHourMinute } from '../../utils/formatters'
import { log } from '../../utils/logger'
import type { Messages } from '../../i18n/messages'

/** 接続の札の文（辞書の `settings.connection`） */
export type ConnectionWords = Messages['settings']['connection']

/** 接続状態の行に出す文言と色。 */
export interface ConnectionLabel {
  text: string
  /** 文字色（`text-xs` は呼び出し側が付ける）。 */
  className: string
}

/**
 * 設定の窓の接続の 2 行（「電文」「予報（APIキー）」。2026-10-31 ユーザー選択「「電文」「予報（APIキー）」 (Recommended)」）。
 * 受けているもの 1 つに 1 行（docs/relay-server-design.md §0 の「接続状態は受けているものごとに出す」行）。
 *
 * **分岐を JSX の中に書かないこと。** `ConnectionStatus` に値を足したとき、書き忘れても
 * 型検査には掛からず「画面にだけ出ない」形で漏れる（三項演算子の連鎖は最後の `:` が
 * 全部を受けてしまう）。ここへ集めて網羅検査を置けば、足した時点で型検査が止まる。
 *
 * 文言の方針は「**利用者がすべきことが違うなら、文言も分ける**」。
 * - `crowded`（同時接続の上限）で「切断」と出すと、キーや回線を疑わせる。実際にすべきことは
 *   別のタブを閉じることだけで、しかも枠が空けば自動で繋がる（→ `dmdata.ts` の
 *   `RECONNECT_CROWDED_MAX_MS`）。
 * - キーが未設定・不正なときは予報の接続を試みていないので、通信の失敗と区別する。
 */

/**
 * 「電文」の行（中継の接続）。中継とは繋がっているのに中継が DMDATA.JP と切れている間は、
 * 届くはずの電文が届かないので「切断」と言い、切れた時刻を添える
 * （2026-10-31 ユーザー選択「設定の行＋地図は今の赤い更新時刻 (Recommended)」の文面
 * 「切断（配信サーバーが DMDATA.JP と切断中・15:42 から）」。中継が切れた時刻を知らないときは時刻を添えない）。
 */
export function telegramConnectionLabel(
  status: ConnectionStatus,
  upstream: RelayUpstreamStatus | null,
  words: ConnectionWords,
): ConnectionLabel {
  if (status === 'connected' && upstream !== null && !upstream.connected) {
    const since = upstream.disconnectedAtMs === null ? '' : words.upstreamSince(formatHourMinute(new Date(upstream.disconnectedAtMs)))
    return { text: words.upstreamDown(since), className: 'text-red-400' }
  }
  return status === 'disconnected' ? { text: words.disconnected, className: 'text-secondary' } : liveLabel(status, words)
}

/**
 * 「予報」の行。予報を受けている経路を括弧で添える（「接続中（配信サーバー経由）」「接続中（APIキー）」）。
 * 予報キーも APIキーも無ければ「APIキー未設定」。ほかの状態の文は「予報（APIキー）」の行のときのまま
 * （2026-10-31 ユーザー選択「「予報」1 行＋経路を括弧 (Recommended)」）。
 *
 * - `relayForecastLive`: 中継から予報を受けている（予報キーの札・中継が DMDATA と繋がっている）
 * - `keyStatus`: 自分の鍵の予報の接続。鍵が無い・使えないときは null
 * - `relayForecastAvailable`: 予報キーが中継に受け付けられている（受けられる見込みがある）。APIキーが無い端末で、
 *   中継と切れている間の状態を中継の接続の文で出すのに使う
 */
export function forecastConnectionLabel(
  state: {
    relayForecastLive: boolean
    keyStatus: ConnectionStatus | null
    relayStatus: ConnectionStatus
    relayUpstream: RelayUpstreamStatus | null
    relayForecastAvailable: boolean
  },
  opts: { apiKeySet: boolean; apiKeyInvalid: boolean },
  words: ConnectionWords,
): ConnectionLabel {
  if (state.relayForecastLive) return { text: words.viaRelay, className: 'text-green-400 font-medium' }
  if (state.keyStatus === 'connected') return { text: words.viaApiKey, className: 'text-green-400 font-medium' }
  // APIキーが無く予報キーだけの端末は、中継の接続の状態をそのまま出す（鍵で受ける道が無い）
  if (!opts.apiKeySet && state.relayForecastAvailable) return telegramConnectionLabel(state.relayStatus, state.relayUpstream, words)
  return keyForecastConnectionLabel(state.keyStatus, opts, words)
}

/**
 * 自分の鍵の予報の接続の状態の文（「予報」の行のうち、鍵の経路の分）。鍵が無い・使えないときは接続を作らない（`status` が `null`）。
 * 鍵が無いときは「APIキー未設定」（2026-10-31 ユーザー選択の説明「鍵が無ければ「APIキー未設定」」）。
 */
export function keyForecastConnectionLabel(
  status: ConnectionStatus | null,
  opts: { apiKeySet: boolean; apiKeyInvalid: boolean },
  words: ConnectionWords,
): ConnectionLabel {
  if (status === null || status === 'disconnected') {
    if (!opts.apiKeySet) return { text: words.apiKeyUnset, className: 'text-secondary' }
    if (opts.apiKeyInvalid) return { text: words.apiKeyInvalid, className: 'text-red-400' }
    return { text: words.disconnected, className: 'text-secondary' }
  }
  return liveLabel(status, words)
}

/** 切断以外の状態の文言（2 行で同じ） */
function liveLabel(status: Exclude<ConnectionStatus, 'disconnected'>, words: ConnectionWords): ConnectionLabel {
  switch (status) {
    case 'connected':
      return { text: words.connected, className: 'text-green-400 font-medium' }
    case 'connecting':
      return { text: words.connecting, className: 'text-blue-400' }
    case 'replay':
      // 過去再生中はライブ受信を意図的に止めている。「切断」と出すと異常のように見え、
      // 更新しないままだと「接続中」が残って実態と食い違う。
      return { text: words.replay, className: 'text-blue-400' }
    case 'crowded':
      return {
        text: words.crowded,
        className: 'text-amber-400',
      }
    // 配信元が理由を言って閉じ、繋ぎ直さない状態（→ `dmdata.ts` の `closeCodeAction`）。
    // 自動では戻らないので、利用者がすべきことを括弧に書く（2026-10-19 ユーザー承認、
    // 問い「4807（解約）・4808（終了の操作）で接続を止めたとき、設定タブの接続状態に何を出しますか？」に
    // 選択肢「理由ごとに出す (Recommended)」）
    case 'contract-ended':
      return {
        text: words.contractEnded,
        className: 'text-red-400',
      }
    case 'closed-by-user':
      return {
        text: words.closedByUser,
        className: 'text-amber-400',
      }
    default: {
      // 網羅検査。`ConnectionStatus` に値を足したらここで型検査が止まる。
      // **「切断」へ落とさない** —— 落とすと新しい状態が既存の文言に混ざり、
      // 気づく機会が画面からも型からも失われる。
      //
      // 型の上では到達しないが、記録は残す。型検査を通らない経路（別モジュールが
      // 文字列を渡す・型と呼び出し側の同期が崩れる）で来たとき、画面には出ても
      // **コンソールに手掛かりが無いと原因を追えない**。
      const exhaustive: never = status
      log.warn('[DMDSS] 未知の接続状態を受け取りました', { status: String(exhaustive) })
      return { text: String(exhaustive), className: 'text-secondary' }
    }
  }
}
