/**
 * 読み上げ文の句読点をどう扱うかを決める文字の集合。
 *
 * **2 つの集合は独立ではない。** 「文末とみなす記号」は「チャンクの切れ目になる記号」の
 * 部分集合でなければならない。片方だけを書き換えると、次のどちらかが**例外もログも出さずに**
 * 起きる。
 *
 * | ずれ方 | 症状 |
 * |---|---|
 * | 文末とみなす記号がチャンクを割らない | 合成エンジンはそこに間を置かない。**後ろに続く文と 1 つながりに聞こえる**（各地の満潮時刻の見出し文で実測: 間 0.355 秒が 0 になる。アクセント句の数も核の位置も変わらないので、誤読の突き合わせにも句割りの判定にも掛からない） |
 * | チャンクを割る記号が文末とみなされない | そこで句点を足してしまう。読点がその例で、**これは正しい**（読点は文の中の区切り）。だから部分集合であって一致ではない |
 *
 * **1 つのファイルに置いて導出する**のはこのため。別々のリテラルとして持つと、片方を
 * 触ったときに他方が付いてこない（[`tts-sentence-inventory.md`](../../docs/spec/tts-sentence-inventory.md)
 * §4-8 で実際にそうなりかけた）。
 *
 * **このモジュールは外部依存を持たない。** 読み上げ文を組む側（`ttsText.ts`）と
 * 合成へ渡す側（`voicevox.ts`）の両方から読まれるので、どちらにも依存できない（言語の型だけは型として読む）。
 */
import type { Locale } from '../i18n/messages'

/**
 * 文の終わりとみなす記号。
 *
 * **`．`（全角ピリオド）は入れない。** 下記 {@link CHUNK_BREAK_PUNCTUATION} へ足して揃える手も
 * あるが、そうすると `Ｍ７．１` が文の切れ目になる。実電文の走査でも、文末が `．` の例は
 * 1 件も観測していない（控え 5 日分・`<Text>` 要素 1270 件）。
 */
export const SENTENCE_END: ReadonlySet<string> = new Set(['。', '！', '？'])

/** {@link SENTENCE_END} の末尾判定。**集合を書き写さず、必ずここから組む。** */
export const SENTENCE_END_RE = new RegExp(`[${[...SENTENCE_END].join('')}]$`)

/**
 * チャンクを割る句読点。**{@link SENTENCE_END} に読点を足したもの**として導出する。
 *
 * 読点を含むのは、長い文を途中で区切って合成の単位を短くするため（文の終わりではない）。
 */
export const CHUNK_BREAK_PUNCTUATION = [...SENTENCE_END, '、'].join('')

/**
 * 日本語以外の読み上げの文の区切り（端末の声で読む単位を決める。VOICEVOX は日本語だけなので、上の集合とは別に持つ）。
 *
 * - `sentenceEnd` … 文の終わり。中国語は日本語と同じ全角の句点など。英語・韓国語・ポルトガル語・スペイン語は半角の `.!?` で、
 *   **後ろに空白か文の終わりが来るときだけ**（`6.5` のような数の中の点で割らない）
 * - `chunkBreak` … 文の中の区切り（{@link CHUNK_BREAK_PUNCTUATION} の読点にあたる）。**`sentenceEnd` を含む**（上と同じ理由）
 *
 * どちらも、記号の直後の位置で一致する（`lastIndex` がそこまでを 1 つの単位にする位置）。
 */
export const FOREIGN_SPEECH_BREAKS: Readonly<Record<Exclude<Locale, 'ja'>, { sentenceEnd: RegExp; chunkBreak: RegExp }>> = (() => {
  const cjk = { sentenceEnd: /[。！？]/g, chunkBreak: /[。！？、，：；]/g }
  const latin = { sentenceEnd: /[.!?](?=\s|$)/g, chunkBreak: /[.!?,:;](?=\s|$)/g }
  return { 'zh-Hans': cjk, 'zh-Hant': cjk, en: latin, ko: latin, 'pt-BR': latin, es: latin }
})()
