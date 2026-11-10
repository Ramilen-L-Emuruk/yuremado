/**
 * 日本語の辞書。**この形が正で、ほかの言語の辞書は同じ形を持たねばならない**（→ `../messages.ts` の {@link Messages}）。
 *
 * 値は文字列か、値を受け取って文字列を返す関数。語順や助数詞が言語ごとに違う文は関数で書く
 * （差し込みの書式を決めず、言語ごとにその言語の文として組み立てる）。
 */
export const ja = {
  /** ナビのボタン名。各タブが落ちたときの表示（App の `ErrorBoundary` の `label`）にも使う。 */
  nav: {
    earthquake: '地震情報',
    realtime: 'リアルタイム',
    tsunami: '津波情報',
    catalog: '震源カタログ',
    settings: '設定',
    telegrams: '電文ログ',
  },
} as const
