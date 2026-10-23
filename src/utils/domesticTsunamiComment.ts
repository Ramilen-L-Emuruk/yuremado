import type { DomesticTsunamiCode } from '../types/earthquake'
import { createPerLabelLogGate, log } from './logger'

/**
 * 区分を決める固定付加文の文（地震火山関連コード表・固定付加文の原文）。
 *
 * **固定付加文は文面がコードごとに決まっている**ので、電文の原文を読むのと同じ文になる。電文の原文
 * （`forecastText`）を読まないのは、そこに津波の文以外（0226「震源の近傍で津波発生の可能性があります。」・
 * 0241 の緊急地震速報の文など）も入るため —— それらは「気象庁の発表文」の内訳「固定付加文」で選んで読む
 * （→ `telegramTextToSpeak` の `quakeForecast`。2026-10-23 ユーザー選択「A: 発表文の内訳に足す (Recommended)」）。
 *
 * 読み上げ（`ttsText.ts`）と地震カード（`EarthquakeCard.tsx`）が同じ表を引くので、ここに置く。
 */
export const DOMESTIC_TSUNAMI_CODE_TEXT: Readonly<Record<DomesticTsunamiCode, string>> = {
  '0211': '津波警報等（大津波警報・津波警報あるいは津波注意報）を発表中です。',
  '0212': 'この地震により、日本の沿岸では若干の海面変動があるかもしれませんが、被害の心配はありません。',
  '0213': '今後もしばらく海面変動が続くと思われますので、海水浴や磯釣り等を行う際は注意してください。',
  '0214': '今後もしばらく海面変動が続くと思われますので、磯釣り等を行う際は注意してください。',
  '0215': 'この地震による津波の心配はありません。',
  '0216': '震源が海底の場合、津波が発生するおそれがあります。',
  '0217': '今後の情報に注意してください。',
  '0229': '日本への津波の有無については現在調査中です。',
  '0230': 'この地震による日本への津波の影響はありません。',
}

const SENTENCES: readonly string[] = Object.values(DOMESTIC_TSUNAMI_CODE_TEXT)

/** 固定付加文の原文に、区分を決めるコードの文が 1 つでも入っているか。 */
function hasDomesticTsunamiSentence(text: string): boolean {
  return SENTENCES.some(sentence => text.includes(sentence))
}

/**
 * コードを持つのに、区分を決めるコードの文が原文に 1 つも無いとき（気象庁が文面を変えた疑い）に記録を残す。
 *
 * **一致しなくなっても症状は「文が残る」だけ**で、画面では札の下に津波の文が重なって出るだけ、読み上げでは
 * 同じ事実を 2 度言うだけになる。記録が無いと気づく手掛かりがどこにも無いので、読み上げと地震カードの
 * 両方から呼ぶ（読み上げ側は「気象庁の発表文」を読む設定のときしか通らず、既定はオフ）。
 *
 * **原文に別のコードの文があるだけなら記録しない** —— 震源要素更新が区分だけを運んだ形（原文は前の報のまま）が
 * これで、文面の変更ではない。**塞げない誤報が 1 つある** —— 震度速報の統合で、既存のカードの区分が「不明」のときは
 * 区分とコードを新しい報から採り、原文は既存を残す（`quakeMerge.ts`）。既存の原文に津波の文が無ければ、文面は変わって
 * いないのにこの記録が出る。表示は壊れない（除く文が無いだけ）。記録はコードごとに間引く（毎報・毎描画で出ると記録が埋まり、1 本だと別のコードの
 * 変更が隠れる）。間引きは読み上げとカードで共有する（同じ事実の記録なので）。
 */
export function warnIfDomesticTsunamiSentenceMissing(code: DomesticTsunamiCode | undefined, text: string): void {
  if (!code || hasDomesticTsunamiSentence(text)) return
  missingGate(code, text, () => log.warn(`[固定付加文] 地震情報の固定付加文に、区分を決めるコードの文が見つかりません（コード ${code}。気象庁が文面を変えた疑い）: ${text}`))
}

const missingGate = createPerLabelLogGate(4, 60_000)

/**
 * 固定付加文の原文から、区分を決めるコードの文を**すべて**取り除いた残り。何も残らなければ空文字。
 * 読み上げ（「気象庁の発表文」の内訳「固定付加文」）が使う。地震カードは {@link domesticTsunamiCardForecastText}。
 *
 * 読み上げでは本体の津波の一文がコードの文を全文読んでいるので、原文の側に残すと同じ事実を 2 度言う。
 * **コードの有無によらず全部除く** —— 原文が本体の一文と別の報のものになる形が 3 つある（区分を津波電文から
 * 借りた・震源要素更新が区分だけを運んだ・コードを持たない経路）。どれも原文に残った津波の文を読むと、
 * 本体と食い違う事実を続けて言う（「津波警報等を発表中です」のあとに「津波の心配はありません」）。
 *
 * **照合は表の文との完全一致。** 文とコードの対応は電文に載っていないので、文を切り分けて推し量らない ——
 * 気象庁が文面を一字でも変えれば一致しなくなり、その文は残るだけ（落とし過ぎない向きに倒れる）。
 */
export function withoutDomesticTsunamiSentences(text: string): string {
  return removeSentences(text, SENTENCES)
}

/**
 * 地震カードの津波の札が、気象庁の文の中身を伝えきれていないコード。札の語（→ `formatDomesticTsunami`）と
 * 突き合わせて落ちるもの:
 * - 0211: 「等」に何が含まれるか（札では `title` のホバーでしか出ず、タッチ端末では読めない）
 * - 0212: 「被害の心配はありません」
 * - 0213・0214: 「しばらく続く」「海水浴や磯釣り等」
 */
const CODES_KEPT_ON_CARD: ReadonlySet<DomesticTsunamiCode> = new Set(['0211', '0212', '0213', '0214'])

/**
 * 地震カードの枠に出す固定付加文。区分を決めるコードの文を除くが、**カード自身のコードが札で伝えきれない
 * もの（{@link CODES_KEPT_ON_CARD}）なら、そのコードの文だけ残す**（2026-10-23 ユーザー選択「Aでお願いします。」。
 * 案は「札が伝えきれていない文だけ残す」）。何も残らなければ空文字。
 *
 * **コードを持たないカードでは全部除く。** 区分を津波電文から借りたとき（借りるときにコードを捨てる）と
 * 標準版がこれに当たり、原文の津波の文を残すと札と食い違う事実を並べうる（「津波警報等」の札の下に 0212 の文）。
 * 残すのはカード自身のコードの文だけなので、別のコードの文は同じ理由で除く。
 *
 * 読み上げは本体が津波の一文を全文読むので、こちらではなく {@link withoutDomesticTsunamiSentences} を使う。
 */
export function domesticTsunamiCardForecastText(text: string, code: DomesticTsunamiCode | undefined): string {
  const kept = code && CODES_KEPT_ON_CARD.has(code) ? DOMESTIC_TSUNAMI_CODE_TEXT[code] : undefined
  return removeSentences(text, kept ? SENTENCES.filter(s => s !== kept) : SENTENCES)
}

/**
 * 表の文を取り除く。**表のどの文も別の文の一部になっていない**ので、取り除く順で結果は変わらない
 * （`domesticTsunamiComment.test.ts` が固定する）。
 */
function removeSentences(text: string, sentences: readonly string[]): string {
  let rest = text
  for (const sentence of sentences) rest = rest.split(sentence).join('')
  return rest.trim()
}
