import { ja } from '../../i18n/messages/ja'
import type { QuakeWords } from '../../utils/quakeListView'

const ISSUE_KEYS = Object.keys(ja.quake.issueType) as (keyof typeof ja.quake.issueType)[]
const INFO_KEYS = Object.keys(ja.quake.infoName) as (keyof typeof ja.quake.infoName)[]

/**
 * 報の名前を、いまの言語の語にする。名前は日本語の報の種類（`IssueType`）か、添えて届く報の名前（長周期・推計震度分布図・
 * 国際津波関連情報・津波情報）か、電文の名乗りそのもの。後ろに「 #2」のような番号が付くことがある（報の一覧の行）。
 *
 * **辞書にある日本語の名前だけを置き換え、無い名前は電文の文字のまま出す**（電文の値は表にあるものだけ訳す決まり。
 * → docs/spec/i18n-spec.md §4）。日本語の画面では、どの名前もそのまま返る。
 */
export function quakeReportNameText(name: string, q: QuakeWords): string {
  const m = /^(.*?)( #\d+)?$/.exec(name)
  const base = m?.[1] ?? name
  const serial = m?.[2] ?? ''
  const issueKey = ISSUE_KEYS.find(k => ja.quake.issueType[k] === base)
  if (issueKey) return q.issueType[issueKey] + serial
  const infoKey = INFO_KEYS.find(k => ja.quake.infoName[k] === base)
  if (infoKey) return q.infoName[infoKey] + serial
  return name
}
