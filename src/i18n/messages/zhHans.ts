import type { Messages } from '../messages'

/** 中国語（簡体字）の辞書。気象庁の多言語辞書にある語はそれに合わせ、無い語は作った（語ごとの出どころは `docs/spec/i18n-spec.md` §4）。 */
export const zhHans: Messages = {
  nav: {
    earthquake: '地震信息',
    realtime: '实时',
    tsunami: '海啸信息',
    catalog: '震源目录',
    settings: '设置',
    telegrams: '电文记录',
  },
}
