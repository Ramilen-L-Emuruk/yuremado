import type { Messages } from '../messages'

/** スペイン語の辞書。気象庁の多言語辞書にある語はそれに合わせ、無い語は作った（語ごとの出どころは `docs/spec/i18n-spec.md` §4）。 */
export const es: Messages = {
  nav: {
    earthquake: 'Información de terremotos',
    realtime: 'Tiempo real',
    tsunami: 'Información del tsunami',
    catalog: 'Catálogo de hipocentros',
    settings: 'Configuración',
    telegrams: 'Registro de telegramas',
  },
}
