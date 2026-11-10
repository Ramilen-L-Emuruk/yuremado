/**
 * 日本語の辞書。**この形が正で、ほかの言語の辞書は同じ形を持たねばならない**（→ `../messages.ts` の {@link Messages}）。
 *
 * 値は文字列か、値を受け取って文字列を返す関数。語順や助数詞が言語ごとに違う文は関数で書く
 * （差し込みの書式を決めず、言語ごとにその言語の文として組み立てる）。
 */
export const ja = {
  /** ナビのボタン名。各タブが落ちたときの表示（App の `ErrorBoundary` の `label`）にも使う。 */
  nav: {
    earthquake: '地震情報',
    realtime: 'リアルタイム',
    tsunami: '津波情報',
    catalog: '震源カタログ',
    settings: '設定',
    telegrams: '電文ログ',
  },
  /** ナビで選んでいるボタンの吹き出し。`collapsed` はパネルを畳んでいるか。 */
  navHint: {
    active: (name: string, collapsed: boolean) => `${name}（もう一度押すとパネルを${collapsed ? '開く' : '畳む'}）`,
  },
  /** 地図の上の、新しい版の知らせの札（`AppUpdateBadge`）。 */
  appUpdate: {
    reloadIn: (seconds: number) => `${seconds} 秒後に再読み込みします`,
    updateIn: (seconds: number) => `${seconds} 秒後に更新します`,
    later: '後で',
    newVersion: (version: string | null) => (version !== null ? `新しいバージョン ${version}` : '新しいバージョン'),
    whatsNew: '変更内容',
    updateNow: '今すぐ更新',
    updatedTo: (version: string) => `バージョン ${version} に更新しました`,
    close: '閉じる',
  },
  /** 「変更内容」の窓（`ReleaseNotesDialog`）。本文の各項目は日本語のまま出す（`docs/spec/i18n-spec.md` §5）。 */
  releaseNotes: {
    titleFor: (version: string) => `${version} の変更内容`,
    title: '変更内容',
    close: '閉じる',
    loading: '読み込み中',
    loadFailed: '変更内容を読み込めませんでした',
    retry: 'もう一度',
    minorOnly: '軽微な修正',
    added: '追加',
    fixed: '修正',
  },
  /** 画面が落ちたときの表示（`ErrorBoundary`）。 */
  errorScreen: {
    rootTitle: '画面を表示できなくなりました',
    rootReceivingStopped: '情報の受信も止まっています',
    reload: '再読み込み',
    cannotShow: (label: string) => `${label}を表示できません`,
    showAgain: '再表示',
    reloadMayFix: '再読み込みで直ることがあります',
    /** 地図が落ちたときに `cannotShow` へ渡す名前。 */
    mapLabel: '地図',
  },
  /** 地図の上の隅の表示（更新時刻・取得中・描画の不調・自作地震計）。 */
  mapCorner: {
    cannotDraw: (names: string) => `${names}を描けず`,
    notClickable: (names: string) => `${names}はクリックに応じず`,
    /** 名前を並べる。`rest` は並べきれなかった数（0 なら全部並べた）。 */
    nameList: (shown: readonly string[], rest: number) => (rest > 0 ? `${shown.join('・')} ほか ${rest} 件` : shown.join('・')),
    loadingData: 'データを取得中…',
    /** 地図の隅の更新時刻。`time` は書式を済ませた時刻（まだ受けていなければ null）。 */
    updatedAt: (time: string | null) => (time !== null ? `更新 ${time}` : '更新 受信待機中…'),
    seismoDisconnected: '地震計 未接続',
  },
  /** 地図と情報パネルの境のつまみ（読み上げソフト向けの名前）。 */
  panelBorder: {
    height: '地図と情報パネルの境界（ドラッグで高さ調整・タップで折りたたみ）',
    width: '地図と情報パネルの境界（ドラッグで幅調整・タップで折りたたみ）',
  },
  /** 範囲を選ぶつまみ（`RangeSlider`。読み上げソフト向けの名前）。 */
  rangeSlider: {
    lower: '下端',
    upper: '上端',
    thumb: (label: string, end: string) => `${label}の${end}`,
  },
  /** 地震を再生する前の確認の窓（`QuakeReplayConfirmDialog`）。 */
  replayConfirm: {
    title: 'この地震を再生しますか？',
    body: '再生している間は、新しく発表された地震情報や緊急地震速報は表示されません。',
    cancel: 'やめる',
    confirm: '再生する',
  },
  /** 地図を画像にするボタン（`ShareCardButton`）。 */
  shareCard: {
    idle: '地図を画像にして共有',
    working: '画像を作成中',
    error: '画像を作成できませんでした',
    copied: '画像を保存し、本文をコピーしました',
    copyFailed: '画像を保存しました（本文はコピーできませんでした）',
  },
  /** 使用状況データの同意の窓（`UsageConsentDialog`）。 */
  usageConsent: {
    title: '揺れ窓の改善にご協力ください',
    body: '使用状況データ（開いたタブ・使っている機能・設定・端末の種類など）を開発者に送信することを許可しますか？ 名前・IP アドレス・登録した地点は送信しません。この設定はいつでも変更できます。',
    privacyPolicy: 'プライバシーポリシー',
    deny: '許可しない',
    allow: '許可する',
  },
} as const
