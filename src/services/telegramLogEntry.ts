// 電文ログの行を組み立てる（リプレイ・テストボタン用）。
//
// **ライブの経路はここを通らない。** あちらは受信処理の中で自前で組む（`dmdata.ts` の `makeLogEntry`）。
// こちらは `origin` が固定で、受信時刻を発火のときに打ち直すので別に置く。行の形（`status`・
// `errorMessage`・本文の要約の文）はライブに揃える —— 再生はライブと同じに積む（2026-11-04 ユーザー選択
// 「ライブと同じに積む (Recommended)」）。
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
  /** 電文種別（`VXSE53` 等）。 */
  headType: string
  /** どの経路で入ったか。ライブはここを通らないので除く。 */
  origin: Exclude<TelegramOrigin, 'live'>
  /**
   * 配信元が電文に添えた見出し（DMDATA の `head`。`type`・`author`・`time`・`designation`・`test`）。
   * アーカイブは目録（`telegrams.json`）の `head`、当日経路は電文一覧の `head` をそのまま渡す。
   * 見出しを持たない経路（テストボタン）は `undefined` を明示して渡す。
   *
   * **任意（`?`）にしない。** 経路を足したときに渡し忘れると、その経路の行だけ見出しが黙って欠ける。
   */
  rawHead: unknown
  /** 画面と書き出しに出す本文。XML はそのまま、二進電文は要約の文字列。 */
  rawBody: unknown
  /**
   * 二進電文（推計震度分布図）の、断片を結合した元の電文。ダウンロードはこれを落とす
   * （2026-11-04 ユーザー選択「残して落とせる (Recommended)」）。二進でない電文と、結合待ちの断片は `null`。
   */
  rawBytes: Uint8Array | null
  /**
   * 組み立てた結果。`null` なら行は `filtered`（取り込まない種別・捨てた試験報・結合待ちの断片・読めなかった電文）
   * か `error`（`errorMessage` を渡したとき）。ライブも読めなかった XML は `filtered` で積む。
   */
  payload: ReplayPayload | null
  /**
   * 読めなかった理由（ライブと同じ語。`'bufr decode failed'` など）。渡すと行は `error` になる。
   * `payload` があるときは `null`。
   */
  errorMessage: string | null
  /** 気象庁が訓練・試験として流した電文か（配信元の `head.test`。二進電文は本文の電文の種類から）。 */
  isTest: boolean
}

/** 電文ログの行を 1 つ組む（リプレイ・テストボタン用）。 */
export function makeReplayLogEntry(input: ReplayLogEntryInput): TelegramLogEntry {
  const { headType, origin, rawHead, rawBody, rawBytes, payload, errorMessage, isTest } = input
  const status: TelegramLogEntry['status'] = payload ? 'parsed' : errorMessage !== null ? 'error' : 'filtered'
  return {
    id: `${Date.now()}-${seq++}`,
    // **ここで入れるのは仮の値。** 積む側（`useEarthquakes.ts` のディスパッチャ）が発火の
    // ときに打ち直す。リプレイは窓ぶんをまとめて先に組むので、組んだ時刻のまま残すと
    // **1 時間ぶんの電文がほぼ同じ秒を名乗る**（しかも先読みで組んだ分だけ 10 分ずれる）。
    // 電文が名乗る発表時刻も入れない —— ライブの行は受け取った時刻なので、混ぜると
    // 一覧の時刻が経路によって意味を変える。
    receivedAt: serverDate(),
    source: 'dmdss',
    origin,
    headType,
    isTest,
    // ライブ（`dmdata.ts` の `makeLogEntry`）と同じく本文から読む。リプレイの電文は XML のまま届く
    operationStatus: typeof rawBody === 'string' ? readTelegramOperationStatus(rawBody) : undefined,
    status,
    // 読めたものは読んだ結果から、読めなかったものは種別コードから引く
    kind: payload ? telegramKindOfPayload(payload) : telegramKindOfHeadType(headType),
    rawHead,
    rawBody,
    ...(rawBytes !== null ? { rawBytes } : {}),
    ...(errorMessage !== null && !payload ? { errorMessage } : {}),
  }
}
