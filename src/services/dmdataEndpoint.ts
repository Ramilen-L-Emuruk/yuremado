/**
 * DMDATA の REST（一覧・詳細・電文本体・アーカイブ本体）へ「どこへ・どう繋ぐか」（docs/relay-server-design.md §7.1）。
 *
 * 一覧や本体を取る関数は、繋ぐ先と認証を自分で持たず、呼び出し側からこの値を受け取る。
 * 作り手は「自分の鍵で DMDATA へ繋ぐ」{@link dmdataKeyEndpoint} と、中継へ繋ぐ `relayEndpoint`（`relayEndpoint.ts`）。
 *
 * **見出しは値ではなく関数で持つ。** 鍵が空・不正なら、作った時点ではなく要求の直前に投げるため
 * （値で持つと、作った時点で投げるか、投げずに壊れた見出しを運ぶ）。投げない経路は先に `problem()` を見る。
 *
 * WebSocket（`DmdataConnection`）はこの値を受け取らない。チケットの払い出しと枠の返却は自分の鍵の経路そのものなので、
 * 中で {@link dmdataKeyEndpoint} を作って宛先だけをここから引く。
 */

import { authHeader, dmdataApiKeyProblem, type DmdataApiKeyProblem } from '../utils/dmdataApiKey'
import { waitForApiSlot, waitForDataApiSlot } from './dmdataRequestGates'
import type { GateTag } from '../utils/requestGate'
import type { RelayListGaps } from './relayListGaps'

/** 門で待つときの指定（`urgent` は待ち行列を追い越す・`tag` は誰の待ちかの印） */
export interface GateSlotOptions {
  urgent?: boolean
  tag?: GateTag
}

/** DMDATA の API の土台（末尾の `/` なし） */
export const DMDATA_API_BASE = 'https://api.dmdata.jp/v2'
/**
 * DMDATA の電文本体の土台（末尾の `/` あり。`${dataBase}${id}` で本体の URL になる）。
 * 一覧が返す `url` と同じ形を id から組むのに使う（リプレイの当日経路と起動時の EEW 復元）。
 */
export const DMDATA_DATA_BASE = 'https://data.api.dmdata.jp/v1/'

export interface DmdataEndpoint {
  /** 一覧・詳細・チケットの土台（末尾の `/` なし） */
  readonly apiBase: string
  /** 電文本体の土台（末尾の `/` あり） */
  readonly dataBase: string
  /**
   * 電文一覧（`/v2/telegram`）が緊急地震速報（警報 VXSE43）の電文も返すか。DMDATA の一覧は返さないので
   * 加工データの `/v2/gd/eew` を辿る。中継の一覧は返す（中継だけの拡張。docs/relay-server-design.md §6・
   * §0 の 2026-10-31 の「加工データは配らない」の行）ので、そこから取る
   */
  readonly telegramListHasEew: boolean
  /** 繋げない理由（鍵が空・不正）。繋げるなら null。要求を投げる前に見る */
  problem(): DmdataApiKeyProblem | null
  /**
   * 要求の前に済ませる用意（中継なら札を取る・期限が近ければ取り直す）。見出しを作る前に必ず待つ。
   * 自分の鍵の経路では何もしない
   */
  prepare(signal?: AbortSignal | null): Promise<void>
  /**
   * 一覧・詳細・チケットの門（繋ぐ先が決める回数の上限）が空くまで待つ。鍵の経路は DMDATA の門
   * （`dmdataRequestGates.ts` の `waitForApiSlot`）、中継の経路は中継が返す 429 の待ち（`relayEndpoint.ts`）
   */
  waitApiSlot(opts?: GateSlotOptions): Promise<void>
  /**
   * 電文本体・アーカイブ本体の門。鍵の経路は `waitForDataApiSlot`。中継は公開バケットから返す本体なら待たず、
   * 中継の口から返す本体（予報。`relayEndpoint.ts` の `RELAY_PRIVATE_BASE`）なら API と同じ 429 の待ちに並ぶ
   * @param url 取りに行く本体の URL（一覧が返した `url` か、`dataBase` から組んだもの）
   */
  waitDataSlot(url: string, opts?: GateSlotOptions): Promise<void>
  /**
   * 一覧・本体の応答の状態番号と見出しを繋ぎ先へ返す。中継は 401（札が切れた）で札を捨て、429 で `Retry-After` を
   * 門へ覚えさせる。鍵の経路は何もしない（DMDATA の 429 は `dmdataRequestGates.ts` の側で扱う）
   */
  observe(status: number, headers: Headers | null): void
  /**
   * 電文一覧の応答が語った、繋ぎ先が見ていない区間（→ `relayListGaps.ts`）。中継は帳面へ取り込み、地震タブの帯が読む。
   * DMDATA の一覧は印を返さないので、鍵の経路へは呼ばれない（呼ばれても何もしない）
   */
  noteListGaps(gaps: RelayListGaps): void
  /** 一覧・詳細・チケットへ付ける見出し。繋げないときは投げる（`authHeader` と同じ） */
  apiHeaders(): Record<string, string>
  /**
   * 電文本体・アーカイブ本体へ付ける見出し。繋げないときは投げる。中継は本体の置き場所で変わる（公開バケットは
   * 何も付けず、中継の口から返す予報の本体には札を付ける）ので、URL を受け取る
   */
  dataHeaders(url: string): Record<string, string>
}

/** 自分の鍵で DMDATA へ繋ぐ。API にも本体にも Basic 認証を付ける */
export function dmdataKeyEndpoint(apiKey: string): DmdataEndpoint {
  return {
    apiBase: DMDATA_API_BASE,
    dataBase: DMDATA_DATA_BASE,
    telegramListHasEew: false,
    problem: () => dmdataApiKeyProblem(apiKey),
    prepare: async () => {},
    waitApiSlot: (opts) => waitForApiSlot(opts),
    waitDataSlot: (_url, opts) => waitForDataApiSlot(opts),
    observe: () => {},
    noteListGaps: () => {},
    apiHeaders: () => ({ Authorization: authHeader(apiKey) }),
    dataHeaders: () => ({ Authorization: authHeader(apiKey) }),
  }
}
