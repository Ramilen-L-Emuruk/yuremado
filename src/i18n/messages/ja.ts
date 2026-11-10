import type { TelegramLogKind, TsunamiGrade } from '../../types/earthquake'
import { TELEGRAM_LOG_ERROR, type TelegramLogErrorMark } from '../../utils/telegramLogErrorMark'
import type { CatalogColorBy } from '../../utils/hypocenterCatalogView'

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
  /**
   * 電文ログ（`components/TelegramTab`）。電文の本文（XML・平文・推計震度分布図の要約）は辞書を通さない。
   * 行の名前は電文の `Control/Title` を `controlTitle` で引き、表に無い題名は電文の文字のまま出す。
   */
  telegramLog: {
    clear: 'クリア',
    allKinds: '全種別',
    skipped: 'スキップ',
    errors: 'エラー',
    allOrigins: 'すべての経路',
    /** 経路の名前（絞り込みの選択肢と、行の印） */
    origin: { live: 'ライブ', test: 'テスト', replay: '再生' },
    selectedCount: (n: number) => `${n}件選択中`,
    deselect: '選択解除',
    waiting: '電文を待機中…',
    noMatch: 'フィルタ条件に一致なし',
    selectAll: '全選択',
    timeUnknown: '時刻不明',
    download: 'ダウンロード',
    copy: 'コピー',
    copied: 'コピー済み',
    /** 訓練・試験の印（電文の `Control/Status`。名乗りが読めず配信元の試験の印だけがあれば `drillOrTest`） */
    operation: { drill: '訓練', test: '試験', drillOrTest: '訓練・試験' },
    /** 選んだ電文をまとめて落とすファイル名の、件数の部分（`<時刻>_telegrams_<これ>.json`） */
    downloadCount: (n: number) => `${n}件`,
    /** 種別の絞り込みの名前（`TelegramLogKind`。書いた順が選択肢の並び → `labels.ts` の `KIND_OPTIONS`） */
    kind: {
      eew: 'EEW',
      quake: '地震',
      tsunami: '津波',
      lpgm: '長周期',
      nankai: '南海トラフ臨時情報',
      nankaiCommentary: '南海トラフ解説情報',
      kohatsu: '後発地震注意情報',
      quakeNotice: 'お知らせ',
      earthquakeCount: '地震回数',
      estimatedIntensity: '推計震度分布図',
      internationalTsunami: '国際津波関連情報',
    } as Record<TelegramLogKind, string>,
    /**
     * 電文の `Control/Title`。電文種別ごとに 1 つに決まっている（控え 2020-11-18〜の 207,930 通で 18 種）。
     * 日本語は電文の文字のまま。鍵は電文の題名そのもの
     */
    controlTitle: {
      '津波警報・注意報・予報a': '津波警報・注意報・予報a',
      '津波情報a': '津波情報a',
      '沖合の津波観測に関する情報': '沖合の津波観測に関する情報',
      '緊急地震速報配信テスト': '緊急地震速報配信テスト',
      '緊急地震速報（警報）': '緊急地震速報（警報）',
      '緊急地震速報（予報）': '緊急地震速報（予報）',
      '緊急地震速報（地震動予報）': '緊急地震速報（地震動予報）',
      '震度速報': '震度速報',
      '震源に関する情報': '震源に関する情報',
      '震源・震度に関する情報': '震源・震度に関する情報',
      '地震の活動状況等に関する情報': '地震の活動状況等に関する情報',
      '地震回数に関する情報': '地震回数に関する情報',
      '顕著な地震の震源要素更新のお知らせ': '顕著な地震の震源要素更新のお知らせ',
      '長周期地震動に関する観測情報': '長周期地震動に関する観測情報',
      '南海トラフ地震臨時情報': '南海トラフ地震臨時情報',
      '南海トラフ地震関連解説情報': '南海トラフ地震関連解説情報',
      '北海道・三陸沖後発地震注意情報': '北海道・三陸沖後発地震注意情報',
      '地震・津波に関するお知らせ': '地震・津波に関するお知らせ',
    },
    /**
     * 電文種別コードから引く名前。`Control/Title` の読めない行（二進の推計震度分布図・復号に失敗した行・捨てた試験報）に出す。
     * 扱うコードはすべて載せる（漏れは `components/TelegramTab/labels.test.ts` が落とす）。名前の決め方は `labels.ts` の `HEAD_TYPE_LABEL`
     */
    headType: {
      VXSE42: 'EEW配信テスト',
      VXSE43: 'EEW警報',
      VXSE44: 'EEW予報（旧形式）',
      VXSE45: 'EEW地震動予報',
      VXSE51: '震度速報',
      VXSE52: '震源情報',
      VXSE53: '震源・震度',
      VXSE60: '地震回数に関する情報',
      VXSE61: '顕著な地震の震源要素更新のお知らせ',
      VXSE62: '長周期',
      VTSE41: '津波警報・注意報',
      VTSE51: '津波観測に関する情報',
      VTSE52: '沖合の津波観測に関する情報',
      VYSE50: '南海トラフ地震臨時情報',
      VYSE51: '南海トラフ地震関連解説情報（臨時解説）',
      VYSE52: '南海トラフ地震関連解説情報（定例解説）',
      VYSE60: '北海道・三陸沖後発地震注意情報',
      VZSE40: '地震・津波に関するお知らせ',
      IXAC41: '推計震度分布図作図用データ',
      IXAC40: '推計震度分布図作図用データ（旧形式）',
      WEPA60: '国際津波関連情報（英文）',
    },
    /**
     * 行の赤字の欄。受信の側が `errorMessage` に入れる印（鍵。`utils/telegramLogErrorMark.ts`）を、画面の文へ引く。表に無い印はそのまま出す
     */
    errorMessage: {
      [TELEGRAM_LOG_ERROR.bodyDecodeFailed]: '本文を復号できませんでした',
      [TELEGRAM_LOG_ERROR.bufrDecodeFailed]: '推計震度分布図を読めませんでした',
      [TELEGRAM_LOG_ERROR.fetchFailed]: '本文を取得できませんでした',
    } satisfies Record<TelegramLogErrorMark, string>,
  },
  /**
   * 震源カタログ（`components/CatalogTab` と、見出しの語を組む `utils/hypocenterCatalogView.ts`）。
   * 数は、呼び出し側が言語に合わせて桁を区切った文字も添えて渡す。出典の欄の中身（索引の `source`・`license`）は辞書を通さない
   */
  catalog: {
    showing: '表示中',
    showingHint: {
      loading: '年ごとのデータを取得しています',
      pending: '絞り込みを変えた直後です。数えなおしが終わると入れ替わります',
      idle: '地図に出ている点の数です',
    },
    /** 件数。`n` は数そのもの（複数形を分ける言語が使う）、`shown` は桁を区切った文字 */
    count: (_n: number, shown: string) => `${shown} 件`,
    unknownMagnitude: (_n: number, shown: string) => `（うち M 不明 ${shown} 件）`,
    loading: '読み込み中',
    updating: '更新中',
    indexFailed: '震源カタログを取得できず',
    /** 取りに行った年がすべて取れなかったとき（`years` は `missingYears` で詰めた年） */
    missingAllYears: (years: string) => `${years} 年を取得できず（この期間の地震は 1 件も出ていません）`,
    missingSomeYears: (years: string) => `${years} 年を取得できず（件数はそのぶん少なく出ています）`,
    /** 取れなかった年の続き（`1990〜1992`）と、その区切り */
    yearRun: (from: number, to: number) => `${from}〜${to}`,
    yearRunSeparator: ', ',
    retry: '再試行',
    completeness: (year: number, magnitude: string) =>
      `${year} 年まで遡ると、記録が揃うのは M ${magnitude} 以上です。 それより小さい地震は少なく見えます。`,
    filterSection: '絞り込み',
    viewSection: '見せ方',
    period: '期間',
    periodHint: '表示する期間です。スライダーは年ごとに動き、日付を選ぶと年の途中から指定できます。日付を選んだ側は、もう一方のつまみを動かしても保たれます',
    periodValue: (from: string, to: string, _days: number, shownDays: string) => `${from} 〜 ${to}（${shownDays}日ぶん）`,
    /** 期間のつまみの読み上げ名（`RangeSlider` の `ends`） */
    periodEnds: ['開始', '終了'],
    startDate: '期間の開始日',
    endDate: '期間の終了日',
    dateSeparator: '〜',
    /** 期間の下に添える行（`preliminaryNote`）。2 つ出るときは `joinNotes` で繋ぐ */
    preliminaryFrom: (date: string) => `${date}以降は速報値`,
    telegramTailFrom: (date: string) => `${date}以降は地震情報の電文から（無感の地震は載らない）`,
    joinNotes: (notes: readonly string[]) => notes.join('。'),
    magnitude: 'マグニチュード',
    magnitudeHint: '表示する規模の範囲です。端に置くとその側の制限を外します',
    depth: '深さ',
    depthHint: '表示する震源の深さの範囲です。端に置くとその側の制限を外します',
    latitude: '緯度',
    latitudeHint: '表示する南北の範囲です。経度・深さと合わせて、直方体で切り出せます。端に置くとその側の制限を外します',
    longitude: '経度',
    longitudeHint: '表示する東西の範囲です。端に置くとその側の制限を外します',
    /** 範囲の見出し（`rangeLabel` と `*BoundLabel`）。値は小数 1 桁に整えてから渡す */
    noLimit: '制限なし',
    range: (min: string, max: string) => `${min} 〜 ${max}`,
    magnitudeAtLeast: (m: string) => `M ${m} 以上`,
    magnitudeAtMost: (m: string) => `M ${m} 以下`,
    depthAtLeast: (km: number) => `${km} km 以深`,
    depthAtMost: (km: number) => `${km} km 以浅`,
    northOf: (lat: string) => `北緯 ${lat}° 以北`,
    southOf: (lat: string) => `北緯 ${lat}° 以南`,
    eastOf: (lng: string) => `東経 ${lng}° 以東`,
    westOf: (lng: string) => `東経 ${lng}° 以西`,
    external: '気象庁以外の機関の震源',
    externalHint: '気象庁以外の機関が決めた震源も表示します。ほとんどが海外の地震で、日本付近の一部は気象庁の震源と重なります。',
    colorBy: '色分け',
    colorByHint: '点の色を何で決めるかです。深さは浅いほど暖色、マグニチュードは大きいほど暖色、発生年は新しいほど明るくなります',
    /** 色分けの選択肢（書いた順が並び） */
    colorByOption: { depth: '深さ', magnitude: 'マグニチュード', time: '発生年' } as Record<CatalogColorBy, string>,
    emphasis: '強調表示',
    /** 倍率は実装（`pointSizePx`）から引いて渡す */
    emphasisHint: (atM3: string, atM9: string) =>
      `マグニチュードが大きいほど点を大きくします。下の基準サイズに対して、M3 で ${atM3} 倍・M9 で ${atM9} 倍です`,
    pointSize: '点の基準サイズ',
    pointSizeHint: '点の直径です。強調表示がオンのときは、この大きさに倍率が掛かります',
    source: '出典',
  },
} as const
