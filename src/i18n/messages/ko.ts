import type { Messages } from '../messages'

/** 韓国語の辞書。気象庁の多言語辞書にある語はそれに合わせ、無い語は作った（語ごとの出どころは `docs/spec/i18n-spec.md` §4）。 */
export const ko: Messages = {
  nav: {
    earthquake: '지진 정보',
    realtime: '실시간',
    tsunami: '지진해일 정보',
    catalog: '진원 목록',
    settings: '설정',
    telegrams: '전문 로그',
  },
}
