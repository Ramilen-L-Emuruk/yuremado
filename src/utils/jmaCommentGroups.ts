/**
 * 地震カードの「気象庁からの補足」に出す付加文を、見出しつきのまとまりへ組む。
 *
 * **1 文 1 行にし、種類ごとに中身で呼ぶ見出しを付ける**（→ docs/quake-tab-redesign.md
 * 「決まっていること」。2026-11-01 発言「1文1行＋種類の見出しで固定付加文が被るなら何のやつか書いたら？」、
 * 続く選択「中身で呼ぶ (Recommended)」）。見出しは固定付加文のコードで分ける ——
 * 0211〜0230 は「津波」、0241〜0249 は「緊急地震速報」、固定付加文（その他）は「その他」、
 * 自由付加文は「自由付加文」。**種類が 1 つだけの報には見出しを付けない**（震度速報・震源に関する
 * 情報・お知らせ）。
 *
 * 地震情報と長周期地震動観測情報の両方がこの形を使う（同じ決定の「書き方は地震情報の付加文と同じ」）。
 * 長周期の固定付加文は、全期間の控え（2020-11〜2026-10）の VXSE62 182 通のうち 46 通にあり、すべて 0241
 * （緊急地震速報の文）だった（2026-11-03 に数えた）ので、長周期で「津波」の見出しが立つことは無い。
 */

/** 見出しの語（→ docs/quake-tab-redesign.md の同じ行）。 */
export const JMA_COMMENT_HEADINGS = {
  tsunami: '津波',
  eew: '緊急地震速報',
  var: 'その他',
  free: '自由付加文',
} as const

export interface JmaCommentGroup {
  readonly kind: keyof typeof JMA_COMMENT_HEADINGS
  readonly heading: string
  /** 1 文 1 行に割った文。自由付加文の表（全角空白で桁を揃えた行）は行のまま残る。 */
  readonly lines: readonly string[]
}

/**
 * 文を 1 文ずつに割る。**句点の後ろで割り、句点は文に残す。** 改行もそこで割る
 * （自由付加文は改行で表を組んでいるので、行の中身＝全角空白の並びには触らない）。
 */
export function splitJmaSentences(text: string): string[] {
  const out: string[] = []
  for (const line of text.split(/\r?\n/)) {
    for (const piece of line.split(/(?<=。)/)) {
      // 行頭の全角空白は表の桁揃えなので残し、末尾の空白だけ落とす
      const s = piece.replace(/\s+$/u, '')
      if (s.trim() !== '') out.push(s)
    }
  }
  return out
}

/**
 * 固定付加文（`ForecastComment/Text`）の 1 文が緊急地震速報についての文（0241〜0249）か。
 *
 * **文とコードの対応は電文に載っていない**（コードは `0215 0241` のように 1 要素へまとまり、文も
 * 1 つの `Text` に続けて書かれる）ので、文面で見分ける。0241〜0249 の文はどれも「緊急地震速報」を
 * 名指しし（0241「この地震について、緊急地震速報を発表しています。」・0245「この地震で緊急地震速報を
 * 発表しましたが、強い揺れは観測されませんでした。」）、0211〜0230 の津波の文には現れない。
 */
function isEewSentence(sentence: string): boolean {
  return sentence.includes('緊急地震速報')
}

/**
 * 付加文の 3 種を、出す順（固定付加文 → その他 → 自由付加文）にまとまりへ組む。
 * 空の種類は出さない。`showHeadings` はまとまりが 2 つ以上のときだけ真。
 */
export function jmaCommentGroups(src: {
  forecast?: string
  varComment?: string
  free?: string
}): { groups: JmaCommentGroup[]; showHeadings: boolean } {
  const groups: JmaCommentGroup[] = []
  const forecast = splitJmaSentences(src.forecast ?? '')
  const tsunamiLines = forecast.filter(s => !isEewSentence(s))
  const eewLines = forecast.filter(isEewSentence)
  if (tsunamiLines.length > 0) groups.push({ kind: 'tsunami', heading: JMA_COMMENT_HEADINGS.tsunami, lines: tsunamiLines })
  if (eewLines.length > 0) groups.push({ kind: 'eew', heading: JMA_COMMENT_HEADINGS.eew, lines: eewLines })
  const varLines = splitJmaSentences(src.varComment ?? '')
  if (varLines.length > 0) groups.push({ kind: 'var', heading: JMA_COMMENT_HEADINGS.var, lines: varLines })
  const freeLines = splitJmaSentences(src.free ?? '')
  if (freeLines.length > 0) groups.push({ kind: 'free', heading: JMA_COMMENT_HEADINGS.free, lines: freeLines })
  return { groups, showHeadings: groups.length >= 2 }
}
