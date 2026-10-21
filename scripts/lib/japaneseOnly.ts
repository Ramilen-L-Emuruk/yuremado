/**
 * 「英語の文が紛れ込んでいないか」の判定。判定の本体は `hasEnglishProse`。
 *
 * **英語らしさでは判定しない。** 「日本語を 1 文字も含まないのに、英単語が残る」ものを落とす。
 * 英語らしさ（英単語が何語続くか・機能語があるか）で見ると、`fix` のような 1 語や、機能語を含まない
 * 短い文（`custom layer add failed`）がすり抜ける。2026-10-21 の調査では実際にそれで漏れた。
 *
 * 英単語として数えないもの（コードや記号として残してよいもの）:
 * - バッククォートで囲んだ部分・URL・パス
 * - 書式の指定（`%s`・`%lu`・`%.2f`）と `key=value` の組
 * - 角括弧の札（`[kyoshin]`。中に空白を挟む文があれば数える）
 * - 識別子らしい語（`_`・`.`・`-`・数字を含む、途中に大文字がある、2 文字以上の大文字だけ）
 * - 2 文字以下の語（`x`・`ms`・`Hz`）。ただし機能語（`to`・`is`・`of` など）は数える
 *
 * **すり抜ける形が残る**（2026-10-21 の敵対的レビューで確かめた）: 大文字だけの英語（`ERROR FAILED`。
 * 頭字語の `JMA`・`DMDSS` と見分けられない）、ハイフンで繋いだ語（`failed-to-fetch`）、`key=value` の値
 * （`status=failed`。ファームのログの書式）。
 *
 * 判定の対象と例外の扱いは `scripts/japaneseOnly.test.ts`（ソース側）と
 * `scripts/check-commit-messages.ts`（コミットメッセージ）にある。
 */

/** 漢字・かな・和文の約物（。、「」〜 など）・全角の英数記号。 */
const JAPANESE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}　-〿＀-￯]/u

export function hasJapanese(text: string): boolean {
  return JAPANESE.test(text)
}

/** 識別子らしい語（英単語として数えない）。 */
function isIdentifierLike(token: string): boolean {
  if (/[_.\-/\\0-9]/.test(token)) return true
  if (/[a-z][A-Z]/.test(token)) return true // camelCase・MapLibre・WebGL
  if (/^[A-Z]{2,}$/.test(token)) return true // JMA・MPU・ADMIN
  return false
}

/** 文に混ざると英語の文だと分かる 2 文字の機能語。 */
const SHORT_FUNCTION_WORDS = new Set(['to', 'is', 'of', 'in', 'on', 'at', 'it', 'be', 'we', 'no', 'do', 'if', 'or', 'as', 'by', 'an', 'so'])

/** 日本語の文脈を抜きにして、英単語として残る語の一覧。 */
export function proseWords(text: string): string[] {
  const stripped = text
    .replace(/`[^`]*`/g, ' ')
    .replace(/\$\{[^}]*\}/g, ' ')
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ')
    .replace(/%[-+ 0#]*\d*(?:\.\d+)?(?:hh|h|ll|l|z)?[a-zA-Z]/g, ' ')
    .replace(/[\w.\-]+=\S*/g, ' ')
    .replace(/\[[\w.\-/]*\s*\]/g, ' ') // 札（`[kyoshin]`）だけ外す。中に文があれば数える
  const words: string[] = []
  for (const token of stripped.split(/[\s,;:()<>{}"'!?*|&=+#@~^$]+/)) {
    const word = token.replace(/^[^A-Za-z0-9_]+|[^A-Za-z0-9_]+$/g, '')
    // 2 文字以下は単位（ms・Hz・km）として数えない。ただし機能語（to・is・of …）は数える ——
    // 数えないと `Failed to fetch 取得失敗` が「英単語 2 語」になって通る
    if (word.length < 3) {
      if (SHORT_FUNCTION_WORDS.has(word.toLowerCase())) words.push(word)
      continue
    }
    if (!/^[A-Za-z][A-Za-z0-9_.\-/\\]*$/.test(word)) continue
    if (isIdentifierLike(word)) continue
    words.push(word)
  }
  return words
}

const JAPANESE_RUNS = new RegExp(JAPANESE.source + '+', 'gu')

/** 日本語の文に混ぜてよい英単語の数（`Socket Start 失敗` は通し、`Archive fetch failed: 取得元…` は落とす）。 */
const MAX_WORDS_BETWEEN_JAPANESE = 2

/**
 * 英語の文として落とすか。次のどちらか:
 * - 日本語を 1 文字も含まないのに、英単語が残る
 * - 日本語に挟まれた区間に、英単語が 3 語以上残る（英語の句を日本語の文に継ぎ足した形）
 */
export function hasEnglishProse(text: string): boolean {
  if (!hasJapanese(text)) return proseWords(text).length > 0
  // 引用（バッククォート）は日本語で区切る前に外す。中に日本語を含む引用が区切りで割れるため
  const unquoted = text.replace(/`[^`]*`/g, ' ')
  return unquoted.split(JAPANESE_RUNS).some((segment) => proseWords(segment).length > MAX_WORDS_BETWEEN_JAPANESE)
}

/** コミットメッセージの 1 件分の違反。 */
export interface MessageProblem {
  /** 1 始まりの行番号（1 が件名）。 */
  line: number
  text: string
}

/** git が自動で書く件名・npm version の件名。日本語でなくてよい。 */
const SUBJECT_EXEMPT = [
  /^\d+\.\d+\.\d+(?:-[\w.]+)?$/, // npm version
  /^Merge (?:branch |remote-tracking branch |tag |commit )?'?[^\s']+'?(?: of \S+)?(?: into \S+)?$/,
  /^Merge branches .+ into \S+$/,
  /^Merge pull request #\d+ from \S+$/,
]

/** 本文で日本語でなくてよい行。 */
const BODY_LINE_EXEMPT = [
  // 名前とアドレスのトレーラー。キーを決めておく（`Something happened <a@b.c>` を通さない）
  /^(?:Co-Authored-By|Signed-off-by|Reviewed-by|Acked-by|Tested-by|Reported-by|Suggested-by|Helped-by): [^<>]+ <[^<>\s]+@[^<>\s]+>$/i,
  /^# Conflicts:$/, // git が衝突の解消で書く一覧
  /^#\t\S+$/,
  /^\(cherry picked from commit [0-9a-f]+\)$/,
  /^This reverts commit [0-9a-f]+\.$/,
]

/**
 * コミットメッセージのうち、日本語を含まない英語の行を返す。
 * 件名は git の自動の件名と版番号だけを例外にする（`fix` の 1 語も落とす）。
 */
export function checkCommitMessage(message: string): MessageProblem[] {
  const lines = message.replace(/\r\n/g, '\n').split('\n')
  const problems: MessageProblem[] = []
  lines.forEach((raw, i) => {
    const text = raw.trimEnd()
    if (text.trim() === '') return
    const exempt = i === 0 ? SUBJECT_EXEMPT : BODY_LINE_EXEMPT
    if (exempt.some((re) => re.test(text.trim()))) return
    if (hasEnglishProse(text)) problems.push({ line: i + 1, text })
  })
  return problems
}
