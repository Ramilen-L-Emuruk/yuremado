import type { Messages } from '../messages'

/** ポルトガル語（ブラジル式）の辞書。気象庁の多言語辞書にある語はそれに合わせ、無い語は作った（語ごとの出どころは `docs/spec/i18n-spec.md` §4）。 */
export const ptBR: Messages = {
  nav: {
    earthquake: 'Informação sobre terremotos',
    realtime: 'Tempo real',
    tsunami: 'Informação sobre tsunami',
    catalog: 'Catálogo de hipocentros',
    settings: 'Configurações',
    telegrams: 'Registro de telegramas',
  },
}
