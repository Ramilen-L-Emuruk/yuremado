// DMDATA が前回受け付けた購読区分を、鍵ごとに端末へ覚える。
//
// **なぜ覚えるか。** 履歴と起動時の復元は「この鍵で受けられる区分」を知ってから取りに行く
// （→ `dmdataClassifications.ts`）。それを知る手段は WebSocket のチケットの申し込みだけで、
// 発行には配信元の処理で 1.2〜2.2 秒かかり（2026-10-19 実測。同じ接続の一覧の取得は 33〜36 ms）、
// 同時接続の枠が埋まっていると 409 で決まらないまま最大 15 秒待つ。前回の答えを覚えておけば、
// 起動した直後に取りに行ける（2026-10-19 ユーザー承認「前回の区分はいいと思います」）。
//
// **覚えるのは、配信元が実際に受け付けた区分だけ**（チケットが通った応え）。既定の区分へ倒した結果
// （409 が続いた・認証エラー）は覚えない —— 受け付けられたかどうか分からない値を、次の起動の
// 前提にしないため。覚えた値と申し込みの結果が違えば、呼び出し側が新しい区分で取り直す。
//
// **鍵ごとに覚える。** 鍵を入れ替えたら、前の鍵が受けられた区分を当てない（契約の違う鍵かもしれない）。
// 鍵そのものは書かず、指紋だけを書く。

import { log } from '../utils/logger'
import { isDmdataClassification, type DmdataClassification } from './dmdataClassifications'

/** 保存先（localStorage）のキー。プライバシーポリシー §2 に載せている。 */
export const DMDATA_CLASSIFICATION_MEMORY_KEY = 'dmdss-accepted-classifications'

interface StoredMemory {
  /** 鍵の指紋（{@link keyFingerprint}）。 */
  readonly key: string
  readonly classifications: readonly DmdataClassification[]
}

/**
 * 鍵の指紋（FNV-1a 32 ビットの 16 進）。**取り違えを防ぐためだけのもの**で、鍵を守る役目は無い
 * （鍵そのものは設定と一緒に同じ端末へ保存されている）。
 */
function keyFingerprint(apiKey: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < apiKey.length; i++) {
    h ^= apiKey.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * この鍵について前回受け付けられた区分を読む。**覚えが無い・別の鍵の覚え・読めない値なら `null`。**
 *
 * 知らない区分が 1 つでも混じっていたら丸ごと使わない —— 一部だけ拾うと、実際より狭い区分で
 * 取りに行くことになる。
 */
export function loadRememberedClassifications(apiKey: string): readonly DmdataClassification[] | null {
  let raw: string | null
  try {
    raw = localStorage.getItem(DMDATA_CLASSIFICATION_MEMORY_KEY)
  } catch (e) {
    // 保存領域を使えない環境（プライベートモード等）では起動のたびに「覚え無し」になり、待ちが戻る。
    // 理由が分からないと「毎回遅い」を追えないので残す。**ページを開いている間に 1 度だけ**
    // （接続を張り直すたびに読むので、毎回出すと埋もれる）
    if (!storageReadWarned) {
      storageReadWarned = true
      log.warn('[DMDSS] 端末の保存領域を読めないため、前回受け付けられた区分を使えません', e)
    }
    return null
  }
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) throw new Error('形が違う')
    const { key, classifications } = parsed as Partial<StoredMemory>
    if (typeof key !== 'string' || !Array.isArray(classifications)) throw new Error('形が違う')
    if (key !== keyFingerprint(apiKey)) return null
    if (classifications.length === 0 || !classifications.every(isDmdataClassification)) throw new Error('区分が読めない')
    return classifications
  } catch (e) {
    log.warn('[DMDSS] 前回受け付けられた区分の覚えを読めないため使いません', e)
    return null
  }
}

/** 保存領域を読めないことを、このページでもう警告したか。 */
let storageReadWarned = false

/**
 * 受け付けられた区分を覚える。**空なら覚えない。失敗しても止めない**（次の起動で申し込みの結果を待つだけ）。
 *
 * **覚えている値と同じなら書かない。** 繋がるたびに呼ばれるので、毎回書くと、書けない環境では
 * 再接続のたびに警告が出る。
 */
export function rememberClassifications(apiKey: string, classifications: readonly DmdataClassification[]): void {
  if (classifications.length === 0) return
  const stored: StoredMemory = { key: keyFingerprint(apiKey), classifications: [...classifications] }
  const json = JSON.stringify(stored)
  try {
    if (localStorage.getItem(DMDATA_CLASSIFICATION_MEMORY_KEY) === json) return
    localStorage.setItem(DMDATA_CLASSIFICATION_MEMORY_KEY, json)
  } catch (e) {
    log.warn('[DMDSS] 受け付けられた区分を端末へ覚えられませんでした', e)
  }
}

/**
 * この鍵の覚えを消す。**別の鍵の覚えには触らない。** 認証エラーで、覚えた区分がこの鍵ではもう
 * 受けられないと分かったときに使う —— 残すと、起動のたびに受けられない区分で履歴を引いて断られる。
 */
export function forgetClassifications(apiKey: string): void {
  try {
    const raw = localStorage.getItem(DMDATA_CLASSIFICATION_MEMORY_KEY)
    if (raw === null) return
    // 読めない覚えは誰のものか分からないが、どの鍵でも使われない（→ `loadRememberedClassifications`）ので消してよい
    let parsed: unknown = null
    try { parsed = JSON.parse(raw) } catch { /* 下で消す */ }
    const key = typeof parsed === 'object' && parsed !== null ? (parsed as Partial<StoredMemory>).key : undefined
    if (typeof key === 'string' && key !== keyFingerprint(apiKey)) return
    localStorage.removeItem(DMDATA_CLASSIFICATION_MEMORY_KEY)
  } catch (e) {
    log.warn('[DMDSS] 前回受け付けられた区分の覚えを消せませんでした', e)
  }
}

/** テスト用。保存領域を読めない警告の「警告済み」を戻す。 */
export function resetClassificationMemoryWarningsForTest(): void {
  storageReadWarned = false
}

/** 2 つの区分の組が同じか（並びは問わない）。 */
export function sameClassifications(a: readonly DmdataClassification[], b: readonly DmdataClassification[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((c) => set.has(c))
}
