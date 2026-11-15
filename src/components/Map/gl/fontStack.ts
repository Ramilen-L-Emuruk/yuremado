import type { ExpressionSpecification } from 'maplibre-gl'
import type { Locale } from '../../../i18n/messages'

// 事前生成 SDF グリフのフォントスタック名の単一情報源。
//
// この値は 2 箇所で完全一致していなければならない:
//   - symbol レイヤーの `text-font`（LabelsGL.tsx）。MapLibre はこの値を glyphs URL の {fontstack} に展開する。
//   - 生成物の出力ディレクトリ名 `public/fonts/<stack>/`（scripts/build-glyphs.mjs の STACKS）。
//
// 両者がずれると MapLibre はエラーを出さず、該当テキストが**無音で消える**だけになる（背景・レイヤー自体は
// 正常に描かれるためデバッグしにくいサイレント障害）。そこでアプリ側の唯一の定義をここに集約し、
// build-glyphs.mjs は本ファイルを読んで自分の組と突き合わせ、不一致ならビルドを失敗させる。
export const JP_FONT_STACK = 'M PLUS Rounded 1c'

/**
 * 県名・区域名の訳を、M PLUS ではなく言語ごとの組で描く言語（2026-11-15 ユーザー承認。経緯は docs/spec/i18n-spec.md §5）。
 * M PLUS に無い字（简体の县・한글など）を使うため。訳の無い名前（日本語のまま出る名前）は M PLUS で描く。
 *
 * **build-glyphs.mjs がこの表をソースから読む。** 1 行に 1 言語の `'言語': '組の名前',` の書き方を変えると読めなくなる。
 */
export const PLACE_LABEL_FONT_STACKS: Readonly<Partial<Record<Locale, string>>> = {
  'zh-Hans': 'Noto Sans SC Black',
  'zh-Hant': 'Noto Sans TC Black',
  ko: 'Noto Sans KR Black',
}

/** 県名・区域名のラベル 1 枚を描く組。訳して出す名前だけ、その言語の組を使う */
export function placeLabelFontStack(locale: Locale, translated: boolean): string {
  return (translated && PLACE_LABEL_FONT_STACKS[locale]) || JP_FONT_STACK
}

/** 組の名前ごとの `text-font` の式（地物の `font` から選ぶ。知らない名前は M PLUS） */
export const LABEL_TEXT_FONT_EXPR = [
  'match',
  ['get', 'font'],
  ...Object.values(PLACE_LABEL_FONT_STACKS).flatMap((stack) => [stack, ['literal', [stack]]]),
  ['literal', [JP_FONT_STACK]],
] as unknown as ExpressionSpecification
