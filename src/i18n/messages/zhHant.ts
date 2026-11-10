import type { Messages } from '../messages'

/** 中国語（繁体字）の辞書。気象庁の多言語辞書にある語はそれに合わせ、無い語は作った（語ごとの出どころは `docs/spec/i18n-spec.md` §4）。 */
export const zhHant: Messages = {
  nav: {
    earthquake: '地震訊息',
    realtime: '即時',
    tsunami: '海嘯訊息',
    catalog: '震源目錄',
    settings: '設定',
    telegrams: '電文紀錄',
  },
}
