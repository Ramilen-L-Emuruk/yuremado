import { loadMessages, type Locale } from '../i18n/messages'
import { loadPlaceNames } from '../i18n/placeNameLoader'

/**
 * 言語の配り役（`I18nProvider`）を日本語以外で立てたテストで、辞書と地名の表の読み込みが
 * 成功でも失敗でも片付くまで待つ。**描画や言語の切り替えと同じ `act()` の中で呼ぶ。**
 *
 * 配り役は読み終えたとき（地名の表は読めなかったときも）に状態を変える。テストの環境
 * （jsdom）では地名の表の取得が失敗するので、その更新が `act()` の外で走るとテストが落ちる
 * （`src/vitestSetup.ts`）。
 *
 * ここで待つ読み込みは、配り役のものと同じ Promise とは限らない。同じ `act()` の中で描画した
 * 場合、配り役の effect は `act()` を抜けるときに走るので、ここが先に自分で取りに行くことがある。
 * 配り役の更新を `act()` の中へ収めているのは、`act()` を抜けるときに待ちの列が空になるまで
 * 流す働きのほう。ここは、その間に読み込みの結果（辞書の差し替え・表の失敗）が出そろうまでの
 * 時間を稼ぐ。取得の回数を数えるテストでは、この重複を前提にしないこと。
 */
export async function settleI18n(locale: Locale): Promise<void> {
  if (locale !== 'ja') {
    await loadMessages(locale).catch(() => {})
    await loadPlaceNames(locale).catch(() => {})
  }
  // 配り役の then の中で積まれた描き直しを流す
  await new Promise((r) => setTimeout(r, 0))
}
