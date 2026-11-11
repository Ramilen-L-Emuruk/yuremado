// 地震の直後に出す行動チェックリストの中身。
//
// 【何を載せるか】公的機関が挙げているものだけを載せる。独自の判断で項目を足さない。出典は画面にも
// 出し、最後に「気象庁・自治体の指示を優先する」と添える。ここは行動を促す場所であって、公的な
// 指示に置き換わるものではない。
//
// 【なぜ 2 部構成か】使う場面が違う。直後の行動は揺れが収まってすぐ、持ち出すものは避難を決めた後。
// 同時に全部見せると、いま読むべきものが埋もれる。帯には最初の 3 つだけを出し、残りは開いて読む。
//
// 【文はどこにあるか】項目・持ち出すもの・出典の名前は辞書（`i18n/messages/*.ts` の `actionChecklist`）にある。
// 行動の**並び順が優先順位**を表す（先頭 3 つの身の安全・火の元・靴を、畳んだ状態でも見える位置に置く）。
// 持ち出すものの分類は消防庁のチェックシートに合わせる。ここに残すのは、言語によらない出典のリンク先と畳んだときの件数。
//
// 出典:
//   - 東京消防庁「地震 その時10のポイント」https://www.tfd.metro.tokyo.lg.jp/lfe/bou_topic/jisin/point10.html
//   - 消防庁「非常用持出品チェックシート」https://www.fdma.go.jp/relocation/bousai_manual/too/pdf/mocidashi.pdf

/** 出典のリンク先。並びは辞書の `actionChecklist.sources`（名前）と同じ */
export const CHECKLIST_SOURCE_URLS: readonly string[] = [
  'https://www.tfd.metro.tokyo.lg.jp/lfe/bou_topic/jisin/point10.html',
  'https://www.fdma.go.jp/relocation/bousai_manual/too/pdf/mocidashi.pdf',
]

/** 帯を畳んだ状態で見せる項目数。揺れた直後に読める量に絞る。 */
export const COLLAPSED_ACTION_COUNT = 3
