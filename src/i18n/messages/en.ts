import type { Messages } from '../messages'

/** 英語の辞書。気象庁の英語がある語はそれに合わせ、無い語は作った（語ごとの出どころは `docs/spec/i18n-spec.md` §4）。 */
export const en: Messages = {
  nav: {
    earthquake: 'Earthquake Information',
    realtime: 'Real-time',
    tsunami: 'Tsunami Information',
    catalog: 'Hypocenter Catalog',
    settings: 'Settings',
    telegrams: 'Telegram Log',
  },
}
