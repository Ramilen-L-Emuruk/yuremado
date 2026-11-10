import type { TsunamiGrade } from '../../types/earthquake'

/** 等級ごとの避難の呼びかけ（気象庁の付加文が採れなかったときに出す。読み上げも同じ文を読む → `utils/tsunami.ts` の `fallbackEvacuationAction`）。 */
const TSUNAMI_EVACUATION: Record<Exclude<TsunamiGrade, 'Unknown'>, string> = {
  MajorWarning: 'ただちに高台や避難ビルなど安全な場所へ避難してください。',
  Warning: 'ただちに高台や避難ビルなど安全な場所へ避難してください。',
  Watch: '海の中にいる人はただちに海から上がって、海岸から離れてください。',
  Forecast: '若干の海面変動が予想されますが、被害の心配はありません。',
}

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
  /**
   * 津波タブ（`components/TsunamiTab`）。電文の決まった語（等級名・高さの語・押し引き・訓練／試験）は、日本語では電文の語をそのまま出す。
   * 読み上げ・通知は `utils/tsunami.ts` の日本語の関数を使い続ける（読み上げの文は辞書へ移さない。`docs/spec/i18n-spec.md` §5）。
   */
  tsunami: {
    grade: { MajorWarning: '大津波警報', Warning: '津波警報', Watch: '津波注意報', Forecast: '津波予報（若干の海面変動）', Unknown: '不明' } as Record<TsunamiGrade, string>,
    /** 電文の等級の名前（`Kind/Name`・`LastKind/Name`） */
    kindName: (name: string) => name,
    inEffect: (grade: string) => `${grade} 発表中`,
    inEffectWord: '発表中',
    updated: (time: string) => `更新 ${time}`,
    observedAsOf: (time: string) => `観測 ${time} 時点`,
    expires: (time: string) => `失効 ${time}`,
    estimatedArrival: (time: string) => `到達予想 ${time}`,
    /** 沿岸への推定の行の、高さの後ろに続ける形 */
    estimatedArrivalAfter: (time: string) => `${time}到達予想`,
    highTide: (time: string) => `満潮 ${time}`,
    maxWave: (time: string) => `最大波 ${time}`,
    /** 第 1 波の到達時刻。`initial` は電文の押し引き（無ければ null） */
    firstWave: (time: string, initial: string | null) => (initial ? `${time} ${initial}波` : time),
    gradeChangedFrom: (label: string, raised: boolean) => `${label}から${raised ? '引き上げ' : '切り替え'}`,
    liftedHeader: '解除',
    /** 解除された区域の行。`grade` は前の等級の名前（読めなければ null） */
    gradeLifted: (grade: string | null) => (grade ? `${grade}を解除` : '解除'),
    notesFromJma: '気象庁からの補足',
    earthquakeLink: '▶ 地震情報',
    offshoreObservations: '沖合観測',
    coastalEstimates: '沿岸への推定（気象庁発表）',
    depth: (depth: string) => `深さ ${depth}`,
    editingOffice: (office: string) => `編集官署 ${office}`,
    issuingOffice: (office: string) => `発表官署 ${office}`,
    noneTitle: '津波情報はありません',
    noneBody: '現在、津波警報・注意報は発表されていません。',
    /** 運用の種別の札（電文の `Control/Status`。訓練・試験） */
    operationStatus: (status: string) => `${status}報`,
    forecastChip: '予測',
    badge: {
      measured: '実測',
      arrivalConfirmed: '到達確認',
      missing: '欠測',
      rising: '上昇中',
      aboveCriteriaOffshore: '大津波警報・津波警報の基準超',
      aboveCriteria: '大津波警報の基準超',
      warningLevelObserved: '津波警報相当を観測',
    },
    forecastHeightImportant: '予想の高さを数値で発表・引き上げ',
    arrivalCondition: { imminent: 'まもなく到達', arriving: '到達中', firstArrived: '第1波到達' },
    observing: '観測中',
    estimating: '推定中',
    weak: '微弱',
    arrivalUnknown: '到達時刻不明',
    /** 高さの語。`over` は上限を定めない値か（数字の後ろに「以上」を付ける）。電文の語に既に「以上」があれば重ねない */
    height: (description: string, over: boolean) =>
      !over || description.includes('以上') || !/[\d０-９]/.test(description) ? description : `${description}以上`,
    cancel: {
      lifted: { title: '津波情報 解除', badge: '解除', desc: 'この津波情報は解除されました' },
      retracted: { title: '津波情報 取消', badge: '取消', desc: 'この津波情報は誤って発表されたため取り消されました' },
      expired: { title: '津波予報 失効', badge: '失効', desc: 'この津波予報は失効しました' },
    },
    /** 避難の行。日本語は気象庁の付加文の 1 行目（`telegramLine`）を優先し、無ければ等級ごとの文 */
    evacuation: (grade: TsunamiGrade, telegramLine: string | undefined) => telegramLine ?? (grade === 'Unknown' ? '' : TSUNAMI_EVACUATION[grade]),
    /** 等級ごとの避難の文（読み上げと共有。→ `utils/tsunami.ts` の `fallbackEvacuationAction`） */
    evacuationByGrade: TSUNAMI_EVACUATION,
  },
} as const
