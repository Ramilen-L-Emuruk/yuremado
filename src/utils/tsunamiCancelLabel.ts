import type { JMATsunami } from '../types/earthquake'
import { ja } from '../i18n/messages/ja'

// 解除表示（cancelledAt セット中）の見出し・説明文・オーバーレイ短文を cancelReason ごとに出し分ける。
// 気象庁の運用上、警報・注意報は「解除」、誤発表は「取消」、予報は解除電文を伴わず失効時刻の到来で
// 静かに消えるため、それぞれ表現が異なる（Issue #2）。
//
// **失効の語は電文の要素名（`ValidDateTime`＝失効時刻）へ揃えてある。** 読み上げ側
// （`tsunamiCancelToText`）も同じ述語を使う —— 画面と声で語が割れると、同じ出来事を指していることが
// 伝わらない。
//
// **見出し（`title`）はウィンドウタイトルにもそのまま出す**（`useAlertTitle` の `showTsunamiEndTitle`。
// 2026-10-12 ユーザー承認）。画面とタイトルで語を割らないため、語は辞書の `tsunami.cancel` 1 か所に持つ。
// 津波タブとウィンドウタイトルは同じ形をいまの言語の辞書から引く。この日本語の表は、ウィンドウタイトルが理由の値を
// 確かめるのに使う（表に無い値を「解除」へ倒す）。
export const CANCEL_REASON_LABEL: Record<NonNullable<JMATsunami['cancelReason']>, { title: string; desc: string; badge: string }> = ja.tsunami.cancel
