// 設定の分類の並び（辞書が鍵の型を読むので、JSX を含まないファイルに置く）

/**
 * 設定の分類。**並び順はここが単一情報源**で、分類の一覧はこの順に出る。各分類にどの見出しが入るかは
 * `SettingsTab` の `<Section category=…>` で決まり、分類の中の並びは `<Section>` の出現順。
 *
 * 分け方と名前は 2026-10-27 ユーザー承認（選んだ選択肢「9 分類にまとめる (Recommended)」）。
 * `separated` は一覧で区切り線の下に置く分類（開発・検証）。名前は辞書（`settings.categories`）が持つ。
 */
export const SETTINGS_CATEGORIES = [
  { id: 'connection' },
  { id: 'notification' },
  { id: 'sound' },
  { id: 'display' },
  { id: 'behavior' },
  { id: 'location' },
  { id: 'share' },
  { id: 'about' },
  { id: 'dev', separated: true },
] as const satisfies readonly { id: string; separated?: true }[]

export type SettingsCategoryId = typeof SETTINGS_CATEGORIES[number]['id']
