// 稼働状況の警告 1 行ぶんの形（稼働状況タブの「⚠」の行と、通知の見張りが共有する）。
//
// - **表示は `html`、通知は `text` を使う。** どちらも同じ組み立てから作るので、画面と通知で文面がずれない。
//   `html` に差し込む値は `escapeHtml` を通し、`text` には素の値を入れる（通知の本文は HTML として解釈されない）。
// - **出た・解消したは `key` と項目の `key` で見る。** 文面には経過時間やずれの量のように毎回変わる値が入るので、
//   文面で比べると 5 秒ごとに「出た」になる。
// - **項目は対象ごと**（基板・センサー・観測点）。2 枚目の基板が黙ったら、その 1 枚だけを「出た」として知らせる。

import { escapeHtml } from './dom'

/** 警告の対象 1 つ（基板 1 枚など）。 */
export interface WarningItem {
  /** 警告の中での対象の鍵（基板の boardKey など）。 */
  readonly key: string
  /** 解消したときに出す、毎回変わらない呼び名（素の文）。 */
  readonly label: string
  /** いまの文（素の文。経過時間などを含む）。 */
  readonly text: string
  /** いまの文（HTML。`text` と同じ中身をエスケープして組んだもの）。 */
  readonly html: string
}

/** 警告 1 行。 */
export interface StatusWarning {
  /** 警告の種類の鍵（保存先のように対象が分かれるものは対象まで含む）。 */
  readonly key: string
  /** 行の頭（素の文）。対象の並ぶ行では「:」の前まで。 */
  readonly head: string
  /** 解消したときに出す、毎回変わらない呼び名（素の文）。対象の無い行で使う。 */
  readonly label: string
  /** 対象の並び。対象の無い行では空。 */
  readonly items: readonly WarningItem[]
  /** 画面に出す行（HTML）。 */
  readonly html: string
  /** 画面に出す行と同じ中身の素の文。 */
  readonly text: string
}

/**
 * 対象の無い警告（行全体で 1 つ）。`dynamicPart` は運用者や UDP 由来の値で、HTML ではエスケープする。
 * 解消したときの呼び名は `head`（`dynamicPart` は毎回変わりうるので含めない）。
 */
export function singleWarning(key: string, head: string, dynamicPart?: string): StatusWarning {
  if (dynamicPart === undefined) return { key, head, label: head, items: [], html: head, text: head }
  return {
    key,
    head,
    label: head,
    items: [],
    html: `${head}: ${escapeHtml(dynamicPart)}`,
    text: `${head}: ${dynamicPart}`,
  }
}

/**
 * 対象の無い警告で、行の中に数値が埋まっているもの（空き容量など）。**`text` はこちらで組んだ文だけで、
 * 運用者や UDP 由来の値を含めないこと**（エスケープせずに HTML へ出す）。解消したときは `label` を出す。
 */
export function namedWarning(key: string, label: string, text: string): StatusWarning {
  return { key, head: label, label, items: [], html: text, text }
}

/** 対象の並ぶ警告。対象が 1 つも無ければ null（行を出さない）。 */
export function listWarning(key: string, head: string, items: readonly WarningItem[]): StatusWarning | null {
  if (items.length === 0) return null
  return {
    key,
    head,
    label: head,
    items,
    html: `${head}: ${items.map((i) => i.html).join('、')}`,
    text: `${head}: ${items.map((i) => i.text).join('、')}`,
  }
}

/**
 * 対象 1 つ。`name` は運用者や UDP 由来の呼び名（エスケープする）、`detail` は括弧の中に添える
 * こちらで組んだ文（エスケープ済みの部分と素の部分を両方渡す）。
 */
export function warningItem(
  key: string,
  name: string,
  detail?: { readonly html: string; readonly text: string },
): WarningItem {
  if (detail === undefined) return { key, label: name, text: name, html: escapeHtml(name) }
  return {
    key,
    label: name,
    text: `${name}（${detail.text}）`,
    html: `${escapeHtml(name)}（${detail.html}）`,
  }
}

/** 素の文と HTML が同じ（こちらで組んだ文だけの）括弧の中身。 */
export function plainDetail(text: string): { readonly html: string; readonly text: string } {
  return { html: text, text }
}
