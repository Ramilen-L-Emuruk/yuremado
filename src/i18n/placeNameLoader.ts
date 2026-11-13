import { fetchJsonWithTimeout } from '../utils/fetchJson'
import type { Locale } from './messages'
import { validatePlaceNameTable, type PlaceNameTable } from './placeNames'

/**
 * ブラウザで言語の地名の表（`public/data/place-names/<言語>.json`）を取りに行く部分。
 * 引き方の型と関数は `placeNames.ts`（中継も写すので、取得の部品を読まないよう分けてある）。
 */

const cache = new Map<Locale, PlaceNameTable>()
const inflight = new Map<Locale, Promise<PlaceNameTable>>()

/** 読み終えた表（まだなら null）。言語を切り替え直したときに、最初の描画から訳を出すため */
export function getCachedPlaceNames(locale: Locale): PlaceNameTable | null {
  return cache.get(locale) ?? null
}

/**
 * 言語の地名の表を読む。日本語には表が無いので呼ばない。言語ごとに初回だけ取りに行き、失敗したら次回また取りに行く
 */
export function loadPlaceNames(locale: Locale): Promise<PlaceNameTable> {
  const hit = cache.get(locale)
  if (hit) return Promise.resolve(hit)
  let pending = inflight.get(locale)
  if (!pending) {
    pending = fetchJsonWithTimeout<PlaceNameTable>(`${import.meta.env.BASE_URL}data/place-names/${locale}.json`, `place-names/${locale}`, {
      // 地図の見た目の取得状況には数えない（引けなくても日本語の名前で出せる）
      trackStatus: false,
      validate: validatePlaceNameTable,
    })
      .then((table) => {
        cache.set(locale, table)
        return table
      })
      .finally(() => inflight.delete(locale))
    inflight.set(locale, pending)
  }
  return pending
}
