/**
 * DMDATA の REST（一覧・詳細・電文本体・アーカイブ本体）へ「どこへ・どう繋ぐか」（docs/relay-server-design.md §7.1）。
 *
 * 一覧や本体を取る関数は、繋ぐ先と認証を自分で持たず、呼び出し側からこの値を受け取る。
 * いまある作り手は「自分の鍵で DMDATA へ繋ぐ」{@link dmdataKeyEndpoint} だけ。
 *
 * **見出しは値ではなく関数で持つ。** 鍵が空・不正なら、作った時点ではなく要求の直前に投げるため
 * （値で持つと、作った時点で投げるか、投げずに壊れた見出しを運ぶ）。投げない経路は先に `problem()` を見る。
 *
 * WebSocket（`DmdataConnection`）はこの値を受け取らない。チケットの払い出しと枠の返却は自分の鍵の経路そのものなので、
 * 中で {@link dmdataKeyEndpoint} を作って宛先だけをここから引く。
 */

import { authHeader, dmdataApiKeyProblem, type DmdataApiKeyProblem } from '../utils/dmdataApiKey'

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
  /** 繋げない理由（鍵が空・不正）。繋げるなら null。要求を投げる前に見る */
  problem(): DmdataApiKeyProblem | null
  /** 一覧・詳細・チケットへ付ける見出し。繋げないときは投げる（`authHeader` と同じ） */
  apiHeaders(): Record<string, string>
  /** 電文本体・アーカイブ本体へ付ける見出し。繋げないときは投げる */
  dataHeaders(): Record<string, string>
}

/** 自分の鍵で DMDATA へ繋ぐ。API にも本体にも Basic 認証を付ける */
export function dmdataKeyEndpoint(apiKey: string): DmdataEndpoint {
  return {
    apiBase: DMDATA_API_BASE,
    dataBase: DMDATA_DATA_BASE,
    problem: () => dmdataApiKeyProblem(apiKey),
    apiHeaders: () => ({ Authorization: authHeader(apiKey) }),
    dataHeaders: () => ({ Authorization: authHeader(apiKey) }),
  }
}
