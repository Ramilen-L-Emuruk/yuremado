import type { PublicQuakeWave } from '../hooks/usePublicQuakeWaves'
import type { SeismoQuakeWave } from '../hooks/useSeismoQuakeWaves'
import type { Locale } from '../i18n/messages'
import { publicStationNameFor } from '../i18n/publicStationNames'
import { publicStationHeading } from '../components/SeismoWaveChart'

/** 訳した札の控え（元の札 → 言語と訳した札）。元の札が捨てられたら一緒に消える */
export type PublicCardNameCache = WeakMap<SeismoQuakeWave, { readonly locale: Locale; readonly card: SeismoQuakeWave }>

/**
 * 地震カードに出す公開観測点の波形の札を、見出しだけ画面の言語の名前にして返す（地震の鍵 → 札の並び）。
 *
 * 札は取った時に日本語の名前で組まれている（`usePublicQuakeWaves`）。言語は出す直前に当てる —— 取った時に当てると、
 * 言語を切り替えても控えた札の見出しが前の言語のまま残る。
 *
 * **元の札と言語が前回と同じなら、前回訳した札をそのまま返す。** 地震カードは札の参照で描き直すかを決める
 * （`utils/mergeQuakeWaves.ts`）ので、訳すたびに新しい札を作ると、揺れていないカードまで描き直す。
 * 日本語の画面は元の札を返す。
 */
export function localizePublicQuakeCards(
  waves: ReadonlyMap<string, readonly PublicQuakeWave[]>,
  locale: Locale,
  cache: PublicCardNameCache,
): Map<string, SeismoQuakeWave[]> {
  const out = new Map<string, SeismoQuakeWave[]>()
  for (const [key, list] of waves) {
    out.set(key, list.map((w) => {
      if (locale === 'ja') return w.card
      const hit = cache.get(w.card)
      if (hit !== undefined && hit.locale === locale) return hit.card
      const card = { ...w.card, displayName: publicStationHeading(w.number, publicStationNameFor(locale, w.nameJa)) }
      cache.set(w.card, { locale, card })
      return card
    }))
  }
  return out
}
