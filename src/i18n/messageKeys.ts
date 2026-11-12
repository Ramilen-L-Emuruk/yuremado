// 辞書（messages/*.ts）が鍵に使う型のうち、画面や地図の部品で定義していたもの。
//
// **このファイルは何も読み込まない。** 辞書はここと、同じく何も読まない小さな型のファイルだけを読む。辞書から画面の部品
// （地図・共有カード・設定の窓など）を型だけでも辿れると、通知の文を組むためにアプリの辞書を写す中継（Workers で動き、
// DOM も maplibre-gl も持たない）が、型チェックのためにそれらまで写すことになる。
// 元のファイル（ttsText・quakeListView など）はここから読んで書き出すので、使う側は今までどおり元のファイルから読めばよい。

/** 震源カタログの点の色を何で決めるか（元は utils/hypocenterCatalogView.ts） */
export type CatalogColorBy = 'depth' | 'magnitude' | 'time'

/** 地震タブの並べ替えの鍵（元は utils/quakeListView.ts） */
export type QuakeSortKey = 'time' | 'scale' | 'magnitude' | 'depth' | 'region'

/** 地震タブの絞り込みの条件の種類（帯の札と窓の節。元は utils/quakeListView.ts） */
export type QuakeFilterKind = 'scale' | 'magnitude' | 'depth' | 'region' | 'types' | 'period'

/** プレート境界の分類（元は utils/plateBoundaries.ts） */
export type PlateBoundaryClass = 'SUB' | 'OCB' | 'CCB' | 'OSR' | 'CRB' | 'OTF' | 'CTF'

/** 設定ファイルを読めなかった理由（元は utils/settingsIo.ts） */
export type SettingsFileError = 'empty' | 'notThisApp' | 'notSettings' | 'malformed' | 'newer' | 'noSettings' | 'noKeys'

/** 到達予想キーの検証で断った理由（元は utils/arrivalToken.ts） */
export type ArrivalTokenProblem = 'empty' | 'malformed' | 'signature' | 'no-expiry' | 'expired' | 'error'

/** 共有カードの寸法（元は utils/shareCard.ts） */
export type ShareCardFormatId = 'wide16x9' | 'square1x1' | 'portrait4x5'

/**
 * 気象庁が書いた文のうち、読み上げを個別に選べる単位。**電文種別 × ブロック**で並べる（使うのは utils/ttsText.ts）。
 *
 * 同じ「自由付加文」でも種別によって中身の性質が違う（地震情報は `＊` の説明が主、津波は
 * いつ来ていつまで続くかの説明、南海トラフは評価の本文）。種類でまとめて切る形にすると、
 * 片方を聞くためにもう片方も付いてくる。
 *
 * **一覧はここが単一情報源。** 設定の既定値（`useSettings.ts`）・設定の窓のラベル・
 * `telegramTextToSpeak` の判定がこの型から導かれるので、足したものを書き忘れると型検査で止まる。
 */
export const TELEGRAM_TEXT_BLOCK_KEYS = [
  // 地震情報
  'quakeForecast', 'quakeVarComment', 'quakeFreeText',
  // 津波
  'tsunamiBody', 'tsunamiVarComment', 'tsunamiFreeText',
  // 長周期地震動観測情報
  'lpgmForecast', 'lpgmVarComment', 'lpgmFreeText',
  // 南海トラフ地震臨時情報
  'nankaiSummary', 'nankaiBody', 'nankaiNextAdvisory',
  // 南海トラフ地震関連解説情報
  'nankaiCommentarySummary', 'nankaiCommentaryBody', 'nankaiCommentaryNextAdvisory',
  // 北海道・三陸沖後発地震注意情報
  // **次回発表予定は持たない。** 解説資料 Ⅱ.42 が定める VYSE60 の `Body` は `EarthquakeInfo` と
  // `Text` だけで `NextAdvisory` を含まない（実電文 7 通でも 0 件。→ data-sources-spec.md
  // 「3 種別に共通する要素は 1 箇所で読む」）。**切っても入れても何も起きない欄を設定に並べない。**
  // 気象庁がこの要素を出すようになったら、キーと `telegramTextToSpeak` の `pick` を戻す。
  'kohatsuSummary', 'kohatsuBody',
  // 地震回数に関する情報。本文（`Body/Text`）は回数を伴わない発表報だけが運ぶ
  // （2026-10-19 ユーザー承認「部品「本文」を足す (推奨)」）
  'earthquakeCountBody', 'earthquakeCountFreeText',
  // 地震・津波に関するお知らせ（本文は `Body/Text` の 1 枠だけ。自由付加文も同じ枠に従う）
  'quakeNoticeBody',
] as const

export type TelegramTextBlockKey = typeof TELEGRAM_TEXT_BLOCK_KEYS[number]

/**
 * 気象庁が書いた文のうち、**文の単位で**読み上げから落とせる定型文（使うのは utils/ttsText.ts。落とす判定と
 * 照合のコードの説明は ttsText.ts の `TELEGRAM_BOILERPLATE_SPECS`）。
 *
 * **一覧はここが単一情報源。** 設定の既定値・設定の窓のラベルと説明・落とす判定がこの型から
 * 導かれるので、足したものを書き忘れると型検査で止まる。
 */
export const TELEGRAM_BOILERPLATE_KEYS = [
  'starMark',
  'eewIssued',
  'lpgmClassTable',
  'tsunamiHeightLegend',
  // 南海トラフ・後発地震の情報の参考情報（`Body/EarthquakeInfo/Appendix`）。他の 4 つと違って
  // 文の照合で落とすものではなく、**要素ごと**読むかを決める（電文がこの文を独立した要素で運ぶため）。
  // 定型文の並びに置くのは、性質（情報の種類の説明で、事象によらずほぼ同じ文）と既定（読まない）が
  // 同じだから（2026-10-23 ユーザー選択「設定で読めるようにする (Recommended)」の「A1 の階級表などと揃える」）。
  'earthquakeInfoAppendix',
] as const

export type TelegramBoilerplateKey = typeof TELEGRAM_BOILERPLATE_KEYS[number]
