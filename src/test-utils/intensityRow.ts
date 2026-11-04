import { fireEvent } from '@testing-library/react'

/**
 * 地震カードの震度一覧・長周期地震動の一覧の 1 行を、地名から引く（テスト用）。
 *
 * **行の DOM の形を前提にしている。** 行は `data-quake-row` を持ち、直下に 3 つの列を持つ ——
 * 「震度（階級の札）」「地名と `＊`」「その値についての印・開閉の記号」。地名は 2 つ目の列の先頭の
 * 子要素に入っており、その `textContent` を完全一致で見る（→ `EarthquakeCard` の `IntensityRow` /
 * `LpgmRow`。上位段では地名そのものが寄せの当たり判定になる）。
 *
 * **`getByText('〇〇＊')` では引けない。** `＊` は地名と別の要素で、Testing Library の既定の照合は
 * 直下のテキストノードしか繋がない。
 *
 * **2 つのテストファイルで共有する。** 同じ述語を書き写すと、行の形を変えたときに
 * 片方だけ直して静かに引けなくなる（実際に 2 ファイルへ分かれていたところを集約した）。
 */
export function findIntensityRow(name: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[data-quake-row]')]
    .find(el => el.children[1]?.children[0]?.textContent === name)
}

/** その地名の行に出ている文字列（印・`＊`・開閉の記号まで含む）。行が無ければ空文字。 */
export function intensityRowText(name: string): string {
  return findIntensityRow(name)?.textContent?.trim() ?? ''
}

/**
 * 震度一覧・長周期地震動の一覧を、上の段から順に開く（既定ではどの段も畳んである）。
 *
 * **カード自体も押せる**（`<button>`）うえ、そのテキストは配下の行を全部含む。行は
 * `<div role="button">` なので、そちらだけを拾う。
 *
 * **述語をテストファイルへ書き写さない。** 行の形や開閉の作りを変えたときに、一部だけ直して
 * 静かに開けなくなる（実際に 2 ファイルへ同じものが分かれていたところを集約した）。
 */
export function openIntensityRows(...labels: string[]): void {
  openIntensityRowsIn(document, ...labels)
}

/**
 * {@link openIntensityRows} を、渡した範囲の中だけで行う。開いた地震カードは震度の一覧と長周期地震動の一覧を
 * 別々の欄に並べるので、同じ県名が 2 つの一覧に出る（長周期の側を開くときに使う）。
 */
export function openIntensityRowsIn(root: ParentNode, ...labels: string[]): void {
  for (const label of labels) {
    const row = [...root.querySelectorAll('div[role="button"]')]
      .find(el => el.textContent?.includes(label))
    if (!row) throw new Error(`${label} の行が見つからない`)
    fireEvent.click(row)
  }
}
