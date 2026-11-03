// 予報キーの検証。
//
// 中継（配信サーバー）は、緊急地震速報の予報（`eew.forecast`）を予報キーを持つ端末にだけ流す。
// 予報は DMDATA.JP の規約（第 15 条）で第三者へ見せられないので、配る相手を鍵で限る
// （設計書 `docs/relay-server-design.md` §0 の 2026-10-31「予報キー」の行）。
//
// **予報を流すかを決めるのは中継の側。** ここでの検証は、設定の窓へ状態を出すためと、
// 中継へキーを送るかを決めるためのもの。ブラウザの中で通っても、中継が受け付けなければ予報は届かない。
//
// 形・署名・期限の見方は到達予想キーと同じ（`utils/arrivalToken.ts` の `verifySignedKey`）。
// 鍵の組は別にしてある —— 到達予想キーを渡した相手に予報まで流れないようにするため。
// 発行は `scripts/sign-arrival-token.ts --kind=forecast`（秘密鍵は `.env.local` にあり配らない）。

import { verifySignedKey, type ArrivalTokenCheck } from './arrivalToken'
import { log } from './logger'

/**
 * 予報キーの署名を確かめる公開鍵（SPKI DER の base64）。中継の `FORECAST_PUBLIC_KEY` と同じ値にする。
 *
 * **公開してよい値。** 公開鍵からは署名を作れない。差し替えると発行済みの予報キーが全部無効になる。
 * 空にすると、どのキーも通らない（鍵の組を取り下げたいときの形）。
 */
const FORECAST_PUBLIC_KEY_SPKI_BASE64 =
  'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEnRLM4MCkUtXZS0YaPKhVbRgd0ic2V0+9/gKlAC3vW/Gzu0GCMRGq6go5CRod9LQ0Ka50BeY620hlTRFl3VKr1g=='

/** 予報キーが本物で、まだ失効していないか。判らないときは通らない側を返す（到達予想キーと同じ）。 */
export async function verifyForecastKey(key: string): Promise<ArrivalTokenCheck> {
  if (key.trim() && !FORECAST_PUBLIC_KEY_SPKI_BASE64) {
    log.warn('[forecast] 予報キーの公開鍵が組み込まれていません')
    return { valid: false, expMs: null, problem: 'signature' }
  }
  return verifySignedKey(key, FORECAST_PUBLIC_KEY_SPKI_BASE64, true, '[forecast]')
}
