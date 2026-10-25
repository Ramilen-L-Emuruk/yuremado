// 電文ログの行を組み立てる（リプレイ・テストボタン用）。
//
// **ライブの 2 経路はここを通らない。** あちらは受信処理の中で配信元の `head` ごと持っている
// ので自前で組む（`dmdata.ts` の `makeLogEntry`・`p2pquake.ts` の `onRawMessage`）。こちらは
// 電文の本文しか手元に無く、`origin` も固定なので別に置く。
//
// 行の `origin` で「ライブで届いたのか、こちらが流したのか」を分ける（→ `TelegramOrigin`）。
import type { ReplayPayload } from '../types/replay'
import type { TelegramLogEntry, TelegramOrigin } from '../types/earthquake'
import { telegramKindOfHeadType, telegramKindOfPayload } from './dmdataTelegramPayload'
import { serverDate } from '../utils/clock'
import { readTelegramOperationStatus } from '../utils/telegramOperationStatus'

/**
 * 行の識別子に添える通し番号。
 *
 * **時刻だけでは足りない。** リプレイは 1 日ぶんを同じミリ秒の中で組むので、時刻で作ると
 * 鍵が衝突し、一覧の選択とダウンロードが別の行を掴む。
 */
let seq = 0

export interface ReplayLogEntryInput {
  /** 電文種別（DMDSS は `VXSE53` 等、標準版は P2PQuake の `code`）。 */
  headType: string
  /** どの経路で入ったか。ライブはここを通らないので除く。 */
  origin: Exclude<TelegramOrigin, 'live'>
  /** 画面と書き出しに出す本文。XML はそのまま、二進電文は要約の文字列、標準版は元の JSON。 */
  rawBody: unknown
  /**
   * 組み立てた結果。`null`（対象外の種別・読めなかった）なら行は `filtered`。
   *
   * **いまの呼び出し元はすべて読めたものしか渡さない。** リプレイ・テストボタンは
   * 読めなかった電文をその場で捨てて取りこぼしへ数えており（`windowSkips`・`skipCounter`）、
   * 行を作らない。つまり**再生では、読めなかった電文は電文ログに出ない**
   * （ライブは `error`・`filtered` の行で残す。2026-10-23 ユーザー選択「今回は載せない（推奨）」）。
   * `null` の分岐を残してあるのは、載せると決めたときにここを通せるようにするため。
   */
  payload: ReplayPayload | null
  /** 気象庁が訓練・試験として流した電文か（`Control/Status` 由来。標準版は常に false）。 */
  isTest: boolean
  /** 配信元。省略すると DMDSS。 */
  source?: TelegramLogEntry['source']
}

/** 電文ログの行を 1 つ組む（リプレイ・テストボタン用）。 */
export function makeReplayLogEntry(input: ReplayLogEntryInput): TelegramLogEntry {
  const { headType, origin, rawBody, payload, isTest, source = 'dmdss' } = input
  return {
    id: `${Date.now()}-${seq++}`,
    // **ここで入れるのは仮の値。** 積む側（`useEarthquakes.ts` のディスパッチャ）が発火の
    // ときに打ち直す。リプレイは窓ぶんをまとめて先に組むので、組んだ時刻のまま残すと
    // **1 時間ぶんの電文がほぼ同じ秒を名乗る**（しかも先読みで組んだ分だけ 10 分ずれる）。
    // 電文が名乗る発表時刻も入れない —— ライブの行は受け取った時刻なので、混ぜると
    // 一覧の時刻が経路によって意味を変える。
    receivedAt: serverDate(),
    source,
    origin,
    headType,
    isTest,
    // ライブ（`dmdata.ts` の `makeLogEntry`）と同じく本文から読む。リプレイの電文は XML のまま届く
    operationStatus: typeof rawBody === 'string' ? readTelegramOperationStatus(rawBody) : undefined,
    status: payload ? 'parsed' : 'filtered',
    // 読めたものは読んだ結果から、読めなかったものは種別コードから引く（ライブと同じ）
    kind: payload ? telegramKindOfPayload(payload) : telegramKindOfHeadType(headType),
    rawBody,
  }
}
