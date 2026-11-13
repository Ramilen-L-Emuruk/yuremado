import type { IssueType, TelegramLogKind, TelegramOperationStatus, TsunamiGrade } from '../../types/earthquake'
import { EPICENTER_RANK_LABEL, MAGNITUDE_RANK_LABEL } from '../../utils/eewAccuracyRanks'
import type { EnsembleSource } from '../../utils/kyoshinEnsembleDetector'
import { TELEGRAM_LOG_ERROR, type TelegramLogErrorMark } from '../../utils/telegramLogErrorMark'
import type { CatalogColorBy } from '../../utils/hypocenterCatalogView'
import type { QuakeHoldBackReason } from '../../utils/quakeMerge'
import type { JmaCommentKind } from '../../utils/jmaCommentGroups'
import type { UnreceivedUnit } from '../../utils/quakePoints'
import type { QuakeFilterKind, QuakeSortKey } from '../../utils/quakeListView'
import type { MapLayerName } from '../../utils/renderHealth'
import type { PlateBoundaryClass } from '../../utils/plateBoundaries'
import type { HeatmapPeriod } from '../../utils/quakeHeatmap'
import type { SettingsCategoryId } from '../../components/SettingsTab/settingsCategories'
import type { TelegramBoilerplateKey, TelegramTextBlockKey } from '../../utils/ttsText'
import type { TimeSignalClock, TimeSignalIntervalMin, TimeSignalOrder, TimeSignalSound, TimeSignalWhileSpeaking } from '../../utils/timeSignal'
import type { DmdataClassification } from '../../services/dmdataClassifications'
import type { SettingsFileError } from '../../utils/settingsIo'
import type { ArrivalTokenProblem } from '../../utils/arrivalToken'
import type { ShareCardFormatId } from '../../utils/shareCard'
import { EVALUATION_SPEECH, type InternationalTsunamiNoticeParts } from '../../utils/internationalTsunamiSpeech'
import type { UpdateStatus } from '../../utils/updateMark'

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
    /** 地図の生成データの名前（取得の名前 → 画面の名前。`utils/mapDataStatusText.ts`） */
    dataNames: {
      prefectures: '県境',
      subregions: '区域の境界',
      'station-coords': '観測点の位置',
      'tsunami-zones': '津波予報区',
      'active-faults': '活断層',
      'plate-boundaries': 'プレート境界',
      'tsunami-obs-coords': '津波観測点の位置',
      'public-stations': '公開観測点',
    } as Record<string, string>,
    /** 表に無い取得の名前のときの語（取得の名前の英字を画面に出さない） */
    unknownData: '地図のデータ',
    /** 欠けたデータの名前を並べる。`rest` は並べきれなかった数 */
    dataNameList: (names: readonly string[], rest: number) => (rest > 0 ? `${names.join('・')}ほか${rest}件` : names.join('・')),
    /** 欠けたデータの 1 行。`gaveUp` は 1 つでも取り直しを諦めたか */
    dataLoadFailed: (subject: string, gaveUp: boolean) => `${subject}を取り込めず（${gaveUp ? '再読み込みで取得し直します' : '取り直しています'}）`,
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
    /** 地図の海岸線の吹き出しの予想波高の行（`utils/tsunami.ts` の `tsunamiAreaPopupLines`） */
    forecastHeight: (height: string) => `予想 ${height}`,
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
    /** 地図の吹き出しの第1波の行（「第1波 05:12 押し波」） */
    firstWaveRow: (rest: string) => `第1波 ${rest}`,
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
     * 二進電文（推計震度分布図の BUFR）の行で、本文の代わりに出す文（行は鍵と値 `bodyNote` を持ち、描くときにここで文にする。
     * → `utils/telegramBodyNote.ts`）。`bytes` は長さ（バイト）
     */
    bodyNote: {
      bufr: (bytes: number) => `（BUFR ${bytes} バイト）`,
      bufrFragment: (bytes: number) => `（BUFR の断片 ${bytes} バイト）`,
      bufrFragmentWaiting: (bytes: number) => `（BUFR の断片 ${bytes} バイト・結合待ち）`,
      bufrKind: (bytes: number, telegramKind: number) => `（BUFR ${bytes} バイト・電文の種類 ${telegramKind}）`,
      bufrCells: (bytes: number, cells: number) => `（BUFR ${bytes} バイト・${cells} セル）`,
      bufrFragmentSkipped: '（BUFR の断片・本文は取りません）',
      bufrFile: (file: string) => `（BUFR ${file}）`,
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
  /**
   * リアルタイムタブ（緊急地震速報のカード・主要動のカウントダウン・揺れ検知のカード・注記）。
   * 震度の札の語（「5弱」「程度以上」「0未満」「長周期3」）と、時刻・M・深さの値の書き方は共有の書式（段 9）で移す。
   */
  realtime: {
    /** 区分の見出し（予報級＝VXSE45・警報級＝VXSE43。区分は `computeDisplayEEWLevel`） */
    eewKind: { forecast: '地震動予報', warning: '緊急地震速報（警報）', special: '緊急地震速報（特別警報）' },
    /** 運用種別の札（電文の `Control/Status`） */
    operation: { 訓練: '訓練報', 試験: '試験報' } as Record<TelegramOperationStatus, string>,
    /** 報番号の札の後ろに添える語 */
    finalSuffix: ' 最終報',
    cancelTitle: '取消',
    cancelText: 'この緊急地震速報は取り消されました',
    /** 予想震度が付かない報の理由（`eewNoForecastReason`） */
    noForecastReason: { deep: '深発地震のため', singleStation: '単独点処理のため' },
    maxForecastIntensity: '予想最大震度',
    /** 予想震度の付かない報の枠の中の 2 行 */
    noForecast: ['予想震度', 'なし'],
    unknownHypocenter: '震源調査中',
    provisional: '（震源未確定）',
    /** 電文の `LandOrSea` */
    landOrSea: { 内陸: '（内陸）', 海域: '（海域）' } as Record<'内陸' | '海域', string>,
    depth: '深さ',
    arrivalTimeHint: '観測点が地震を検知した時刻',
    /** 警報の対象に加わった地方・府県予報区の名前の区切り */
    nameSeparator: '・',
    prefSeparator: ' / ',
    targets: '対象:',
    warningPrefs: '警報:',
    forecastPrefs: '予報:',
    arrivalHeading: '主要動の到達（予測）',
    arrivalHint: [
      '気象庁が区域ごとに出す予測です。強い揺れが予想される区域だけが載ります。',
      '左の数字＝その区域の予想最大震度。',
      '秒数＝主要動が届くまでの残り時間。気象庁の到達予測時刻から計算しています。',
      '到達済み＝気象庁が「既に主要動到達と推測」と伝えてきた区域。実際に揺れを観測したという意味ではありません。',
      '未到達＝主要動がまだ届いていないと推測される区域。到達時刻を出せない区域（下記）も含みます。',
      '時刻不明＝周辺の観測点で実際に観測された揺れから震度を予測している区域（気象庁のPLUM法）。震源からの伝わり方を計算しないため、到達時刻は出ません。',
    ].join('\n'),
    arrivalCounts: (arrived: number, notYet: number) => `到達済み ${arrived} ／ 未到達 ${notYet}`,
    /** PLUM 法の区域を初めて予測した時刻（`time` は整えた時刻） */
    plumStart: (time: string) => `${time} に予測開始`,
    arrived: '到達済み',
    timeUnknown: '時刻不明',
    etaUnknown: '不明',
    etaSec: (sec: number) => `${sec}秒`,
    soon: 'まもなく',
    accuracyHeading: '精度情報',
    accuracyHint: [
      '気象庁が震源とマグニチュードをどう決めたかを、電文に書かれている語のまま出しています。',
      'IPF法＝観測点に届いたP波から震源を絞り込む手法（かっこ内は使った観測点の数）。',
      'P相・全相＝マグニチュードの計算にP波だけを使ったか、後続の波も使ったか。',
      'EPOS・防災科研システム＝震源を決めた計算機システムの名前。',
      '〔観測網外〕〔観測網内〕＝地震が陸上の観測網の外（主に海域）で起きたか、内（陸域）で起きたか。',
    ].join('\n'),
    accuracyRow: { hypocenter: '震源', epicenter: '震央', epicenterIpf: '震央（IPF法）', depth: '深さ', magnitude: 'Ｍ' },
    /** 震央位置・深さの精度ランク（電文解説資料 Ⅱ.21 1-4-2-1）。日本語は資料の語そのもの */
    epicenterRank: EPICENTER_RANK_LABEL,
    /** マグニチュードの精度ランク（同 1-4-2-3） */
    magnitudeRank: MAGNITUDE_RANK_LABEL,
    /** マグニチュードの計算に使った観測点の数。5 は「5点以上」（同 1-4-2-4） */
    magnitudePoints: (n: number) => (n >= 5 ? '5点以上' : `${n}点`),
    accuracyJoin: '・',
    hypocenterSettled: '震源とＭはこれ以降変わりません',
    /** 最大予測値の変化（電文の `Appendix`。`direction` の向きと、理由 `MaxIntChangeReason` の語） */
    forecastChange: (direction: 'up' | 'down' | 'changed', reason: string | undefined) => {
      const d = direction === 'changed' ? '変わりました' : direction === 'up' ? '大きくなりました' : '小さくなりました'
      return reason ? `予想が${d}（${reason}）` : `予想が${d}`
    },
    forecastChangeReason: {
      1: 'マグニチュードが変わったため',
      2: '震央の位置が変わったため',
      3: 'マグニチュードと震央の位置が変わったため',
      4: '震源の深さが変わったため',
      9: 'PLUM法による予測で変わったため',
    } as Readonly<Record<number, string>>,
    /** 主要動のカウントダウン */
    countdown: {
      heading: '主要動',
      noForecastHeading: '主要動の到達予測なし',
      homePoint: '登録地点',
      distance: (km: string) => `震源から ${km} km`,
      noteTelegram: '※気象庁が発表した地域ごとの到達予測時刻です。同じ地域の中でも場所によって異なります',
      noteOwn: '※推定値。実際の到達時間は異なる場合があります',
      noForecastRow: '登録地点の地域には、気象庁の到達予測時刻が出ていません',
      arrivedNow: '主要動が到達しています',
      /** 大きな数字（残り秒数）の後ろに添える語 */
      secondsUntil: (_sec: number) => '秒後に到達予想',
      estimating: '到達時間を推定中…',
    },
    /** 揺れ検知のカード */
    detection: {
      tier: { confirmed: '検知', likely: '可能性' },
      heading: '揺れ検知',
      headingWide: (regions: number) => `揺れ検知（広域・${regions}地域）`,
      maxRealtime: '最大リアルタイム震度',
      /** 震度ごとの棒の右端の点数 */
      pointCount: (n: number) => `${n}点`,
      strongest: (name: string) => `最も強く揺れている地域：${name}`,
      regionsSuffix: (regions: number) => ` ・ ${regions}地域`,
      reacting: (stations: number) => `${stations}観測点で反応`,
      /** `scale` は「震度0未満」（震度の語は段 9 で移す） */
      reactingBelowZero: (stations: number, scale: string) => `${stations}観測点で${scale}の反応`,
      settled: '観測点の反応は収まりました',
      detailOpen: '判定の内訳',
      detailClose: '判定の内訳を閉じる',
      /** 内訳の地域ごとの見出し（`name` は最も強く揺れている区域。引けなければ null） */
      region: (index: number, name: string | null, tier: string) => `地域 ${index}${name ? `・${name}` : ''}（${tier}）`,
      intensityNote: '※気象庁が発表する震度とは計算方法が異なり、単純には比較できません。',
    },
    /** 検知の根拠（`utils/kyoshinEnsembleEvidence.ts`） */
    evidence: {
      sources: { stat: '平常時のゆらぎ', cluster: '揺れの広がり', fast: '強い揺れの急な上昇', sparse: '観測点の少ない地域' } as Record<EnsembleSource, string>,
      sourceSeparator: '・',
      footnote: '※「加わった観測点」は、上の観測点数と数え方が異なります',
      /** 確かな段の要約（`scale` は震度の語「5弱」） */
      confirmedAt: (stations: number, scale: string) => `${stations}点・震度${scale}で確定`,
      reactedBy: (sources: string) => `${sources}で反応`,
      rowSources: '判定した仕組み',
      rowMembers: '加わった観測点',
      rowMaxIntensity: '最大震度',
      rowUntilConfirmed: '確定まで',
      members: (n: number) => `${n}点`,
      maxIntensity: (scale: string) => `震度${scale}`,
      untilConfirmed: (sec: number) => `検知から${sec}秒`,
    },
    monitorTitle: 'リアルタイム震度モニタ',
    monitorHint: '各観測点のリアルタイム震度を地図に表示します。1秒ごとに更新されます。気象庁の震度は1分間の揺れから計算するため、ここではそれを実時間で近似した値を出しています。緊急地震速報の発報時は予報円も表示します。青が P 波、赤が S 波です。',
    footerNote: '※ 表示される震度は、気象庁が発表する震度とは計算方法が異なり、単純には比較できません。観測の状況によっては実際の揺れとは異なる場合があります。',
  },
  /**
   * 地震タブ（`components/EarthquakeTab`・地震カードから開く波形の詳細の窓 `components/SeismoWaveDetail`）と、
   * 地震タブの語を組む utils（`quakeListView.ts`・`lpgm.ts` の観測情報の種類と周期・`estimatedIntensity.ts` の目印の食い違い）。
   * 震度の札の語（「5弱」「以上」「長周期3」）・時刻と規模と深さの書式・日付は段 9 の語で、ここには置かない。
   * 震央地名・県名・官署名・見出し文・気象庁の付加文と取消の本文は電文の文字のまま出す
   */
  quake: {
    /** 報の種類（`IssueType`）。一覧の行と開いたカードの見出し・種類の絞り込みに出す */
    issueType: {
      '震度速報': '震度速報',
      '震源情報': '震源情報',
      '震源・震度情報': '震源・震度情報',
      '各地の震度情報': '各地の震度情報',
      '顕著な地震の震源要素更新のお知らせ': '顕著な地震の震源要素更新のお知らせ',
      '遠地地震': '遠地地震',
      'その他': 'その他',
    } as Record<IssueType, string>,
    /** 地震の報に添えて届く報の名前（報の一覧・種類の絞り込み）。長周期は電文の名乗りがあればそちらを出す */
    infoName: {
      lpgm: '長周期地震動に関する観測情報',
      internationalTsunami: '国際津波関連情報',
      estimatedIntensity: '推計震度分布図',
      tsunami: '津波情報',
    },
    /** 運用種別の札（電文の `Control/Status`） */
    operation: { 訓練: '訓練報', 試験: '試験報' } as Record<TelegramOperationStatus, string>,
    /** 時刻を日時として読めなかったとき（一覧の時刻の列・報の一覧） */
    timeUnknown: '不明',
    /** 震央地名の無い報 */
    unknownHypocenter: '震源調査中',
    cancelTitle: '取消',
    cancelText: 'この地震情報は取り消されました',
    /** 一部の報だけの取消。`name` は報の種類の名前 */
    retracted: (name: string) => `${name}は取り消されました`,
    jmaNotes: '気象庁からの補足',
    /** 補足の中の見出し（`utils/jmaCommentGroups.ts` の種類） */
    jmaNoteHeading: { tsunami: '津波', eew: '緊急地震速報', var: 'その他', free: '自由付加文' } as Record<JmaCommentKind, string>,
    /** 津波情報から借りた値の印の説明（印は `※`） */
    borrowedFrom: '津波情報より',
    borrowedWhat: { hypocenter: '震源', domesticTsunami: '津波の有無' },
    /** 借りた値のホバー。`info` は津波の電文の名前（電文の文字のまま）、`at` は発表時刻（読めなければ null） */
    borrowedSentence: (what: string, info: string, at: string | null) =>
      at ? `${what}は${at}に発表された${info}で伝えられました。` : `${what}は${info}で伝えられました。`,
    /** 文をつなぐ（借りた値のホバーで、震源と津波の有無の 2 文を並べる） */
    joinSentences: (sentences: readonly string[]) => sentences.join(''),
    replay: '▶ 再生',
    replayHint: 'この地震の30秒前から再生します',
    replayHintFirstReport: 'この地震の最初の報の30秒前から再生します',
    /** 見出しの行の報の一覧の開閉（後ろに最後の報の時刻が付く） */
    updated: '更新',
    maxIntensity: '最大震度',
    tsunami: '津波',
    depth: '深さ',
    intensities: '各地の震度',
    /** 各地の震度の見出しの右の、地図の見せ方の切り替え */
    segment: { observed: '観測点', official: '推計震度分布', simple: '簡易推定', lpgm: '長周期' },
    segmentHint: {
      official: '気象庁が地盤の揺れやすさまで考慮して推計した震度の分布です',
      simple: '観測点の震度をこのアプリが補間した目安です。気象庁の推計とは精度が違います',
    },
    /** 震度の列の下に添える印。own＝その行の震度が届いていない、some＝範囲の中に届いていない地点がある */
    unreceivedOwn: '（未入電）',
    unreceivedSome: '（未入電あり）',
    unreceivedOwnHint: '気象庁は震度5弱以上と推定していますが、震度が届いていません（未入電）',
    unreceivedSomeHint: 'この範囲に、震度が届いていない地点があります',
    /** 未入電の地点のボタン。鍵は単位（`utils/quakePoints.ts` の `unreceivedUnitLabel`） */
    unreceivedButton: { 地点: '震度を入手していない地点', 地域: '震度を入手していない地域', 件: '震度を入手していない件' } as Record<UnreceivedUnit, string>,
    unreceivedCount: (n: number, unit: UnreceivedUnit) => `${n}${unit}`,
    unreceivedButtonHint: '気象庁が震度5弱以上と推定しているのに、震度が届いていない地点です。押すと一覧と地図に出します',
    lpgmHeading: '長周期地震動',
    /** 長周期の「観測情報の種類」（`LgCategory`）の意味（`utils/lpgm.ts` の `lpgmCategoryNote`） */
    lpgmCategory: {
      highFloors: '震度が小さくても高層階が大きく揺れた地域があります',
      class1: '長周期地震動階級1以上を観測した地域は、いずれも震度5弱以上です',
      class3: '長周期地震動階級3以上を観測した地域は、いずれも震度5弱以上です',
    },
    /** 見出し文に並んだ地域名を一文に添える（地域名は電文の文字のまま） */
    lpgmCategoryRegions: (note: string, regions: readonly string[]) => `${note}（${regions.join('・')}）`,
    /** 周期ごとの内訳の見出しと読み方（地図の観測点の吹き出しも `utils/lpgm.ts` の定数を通して同じ文を出す） */
    lpgmPeriodsHeading: '揺れの周期ごと（階級・揺れの大きさ）',
    lpgmPeriodsNote: '周期が長いほど、高い建物が大きく揺れます',
    /** 周期帯の中心周期 */
    lpgmPeriod: (sec: number) => `${sec}秒`,
    lpgmPeriodUnknown: '周期不明',
    lpgmDetailLink: '気象庁の詳細ページ（波形・スペクトル）',
    /** 国際津波関連情報の英文の欄。日本語訳と原文の切り替えは日本語の画面にだけ出す */
    intlHeading: '国際津波関連情報（英文）',
    intlTranslation: '日本語訳',
    intlOriginal: '原文',
    intlUntranslated: '（未訳）',
    editorialOffice: '編集官署',
    publishingOffice: '発表官署',
    /**
     * 報の一覧で、カードが採らなかった報のホバー（`utils/quakeMerge.ts` の `QuakeHoldBackReason`。2026-11-07 ユーザー選択
     * 「末尾をそろえた 3 つ (Recommended)」）。完全版の後の速報・種別として劣る報・震源要素更新の後の報は、どれもカードの
     * 種別の並びで下にある報なので同じ文にする
     */
    heldBack: {
      superseded: '下位電文のため、カードに反映していません。',
      lowerPriority: '下位電文のため、カードに反映していません。',
      amendment: '下位電文のため、カードに反映していません。',
      olderReport: '発表時刻が前後しているため、カードに反映していません。',
      noTime: '発表時刻が無いため、カードに反映していません。',
    } as Record<QuakeHoldBackReason, string>,
    /** 推計震度分布図の目印が地震カードと食い違うときの一文（`utils/estimatedIntensity.ts` の `estimatedMarkMismatchNote`） */
    estimatedMark: (mark: string, direction: string, km: number) => `推計の電文では ${mark}の${direction}${km}km付近`,
    /** 目印の名前が分からないときの呼び名 */
    markFallback: (code: number) => `目印${code}`,
    /** 16 方位（北から時計回り） */
    direction16: ['北', '北北東', '北東', '東北東', '東', '東南東', '南東', '南南東', '南', '南南西', '南西', '西南西', '西', '西北西', '北西', '北北西'],
    /** 自作地震計・公開観測点の波形（地震カードの欄と、そこから開く詳細の窓） */
    seismo: {
      failed: '自作地震計: 波形を取得できなかった',
      /** 時間軸の 0（秒まで取れた発生時刻） */
      origin: '発生',
      compositePartial: '合成の無い区間あり',
      part: { max: '最大', measured: '計測', usual: '普段' },
      partHint: {
        max: '最大リアルタイム震度',
        measured: '計測震度',
        usual: '直前 1 時間の、同じ長さの区間の計測震度の中央値です',
      },
      enlarge: '波形を大きく表示',
      detailTitle: (name: string) => `${name} の波形の詳細`,
      distance: (km: number) => `震源距離 約${km} km`,
      composite: '合成',
      peak: '最大',
      realtimeTrend: 'リアルタイム震度の推移',
      close: '閉じる',
      zoomIn: '拡大',
      zoomOut: '縮小',
      fit: '全体',
    },
    /** 一覧の状態と読み足し */
    list: {
      loading: 'データを取得中…',
      loadFailed: 'データの取得に失敗',
      loadFailedWith: (reason: string) => `データの取得に失敗（${reason}）`,
      noMatch: '条件に合う地震はありません',
      none: '地震情報はありません',
      clearAll: 'すべて解除',
      noMore: 'これ以上は遡れません',
      loadMore: 'もっと見る',
      fetching: '取得中…',
      /** 取得の制限で待っている間。`left` は「1:30」の形 */
      throttled: (left: string) => `取得制限中（あと ${left}）`,
      /**
       * 履歴の取りこぼしの帯（`utils/telegramLoss.ts`）。内訳は取得元と電文を分けて数える。`parts` は内訳の語
       * （`lossSources`・`lossTelegrams`、再生では `replayBanner.prefetchBlocks` も）
       */
      lossSources: (n: number) => `取得元${n}件`,
      lossTelegrams: (n: number) => `電文${n}件`,
      historyLoss: (parts: readonly string[]) => `${parts.join('・')}を取り込めず（再読み込みで取得し直します）`,
      loadMoreFailed: '続きの読み込みに失敗（もう一度お試しください）',
      reconnectGapLoss: '接続が切れていた間の電文を取り込めず（再読み込みで取得し直します）',
      fetchThrottled: 'リクエスト過多のため、取得制限中（自動で再開します）',
      rateLimited: (parts: readonly string[]) => `リクエスト過多のため、取得制限中（${parts.join('・')}が未取得）`,
      /**
       * 鍵の入れ直しの案内（地震タブの青い帯と、設定のキー欄の下）。古い URL の橋渡しのページから来て、前の設定に鍵があった端末にだけ出す
       * （橋渡しは鍵を渡さない）。文面は 2026-10-31 ユーザー選択「地震タブの帯＋設定のキー欄 (Recommended)」
       */
      keyReentry: '予報を受けるには、設定で API キーを入れ直してください（アドレスが変わったため引き継いでいません）',
      /** 期間の読み足し。`day` は日付（段 9 まで「10月31日」の形） */
      loadingBackTo: (day: string) => `${day}まで読み込んでいます…`,
      loadingSuffix: '（読み込み中）',
      notLoadedBefore: (day: string) => `${day}以前は未読込みです。`,
      loadedFrom: (day: string) => `（${day}以降を読込済み）`,
      close: '閉じる',
    },
    /** 絞り込みの帯と窓 */
    filter: {
      title: '絞り込み',
      titleCount: (n: number) => `絞り込み（${n}）`,
      section: { scale: '震度', magnitude: '規模', depth: '深さ', region: '地域', types: '種類', period: '期間' } as Record<QuakeFilterKind, string>,
      count: (total: number) => `${total}件`,
      countOf: (total: number, shown: number) => `${total}件中 ${shown}件`,
      clearSelection: '選択を解除',
      clearAll: 'すべて解除',
      close: '閉じる',
      noLimit: '制限なし',
      /** 期間の札。鍵は時間（`utils/quakeListView.ts` の `QUAKE_PERIOD_HOURS`） */
      periodHours: { 24: '24時間', 72: '3日', 168: '7日', 720: '30日' } as Record<number, string>,
      periodHoursOther: (hours: number) => `${hours}時間`,
      chooseDates: '日付を指定',
      startDate: '期間の開始日',
      endDate: '期間の終了日',
      periodLimit: '期間は90日までです。',
      basis: { epicenter: '震央地名', observed: '震度を観測した地域' },
      mode: { list: '一覧', map: '地図' },
      search: '地名で探す',
      mapFailed: '地図を読み込めませんでした。下の一覧から選べます。',
      mapLoading: '地図を読み込んでいます…',
      mapLabel: '地図',
      zoomIn: '拡大',
      zoomOut: '縮小',
      fitLabel: '全体を表示',
      fit: '全体',
      /** 地域の一覧の、県でない組の名前（組の鍵は日本語のまま `utils/quakeListView.ts` が持つ） */
      groupName: {
        海域: '海域', 遠方: '遠方',
        /** 地方の段の名前（一般の 8 地方区分。地図の地方名とは別の区分） */
        北海道: '北海道', 東北: '東北', 関東: '関東', 中部: '中部', 近畿: '近畿', 中国: '中国', 四国: '四国', 九州沖縄: '九州沖縄',
      } as Record<string, string>,
      /** 帯の札（震度の札の語は段 9 の語のまま差し込む） */
      chip: {
        scaleRange: (from: string, to: string) => `震度${from}〜${to}`,
        scaleMin: (from: string) => `震度${from}以上`,
        scaleMax: (to: string) => `震度${to}以下`,
        magnitudeRange: (from: string, to: string) => `M${from}〜${to}`,
        magnitudeMin: (from: string) => `M${from}以上`,
        magnitudeMax: (to: string) => `M${to}以下`,
        depthRange: (from: number, to: number) => `深さ${from}〜${to}km`,
        depthMin: (from: number) => `深さ${from}km以上`,
        depthMax: (to: number) => `深さ${to}km以下`,
        picked: (label: string, n: number) => `${label}（${n}）`,
      },
    },
    /** 並べ替え（一覧の頭の欄） */
    sort: {
      label: { scale: '震度', time: '時刻', region: '震央地名', magnitude: '規模', depth: '深さ' } as Record<QuakeSortKey, string>,
      /** 一覧の頭に出す語。欄の幅（震度 50px・時刻 37px）に入らない言語だけ短くし、全文の label は指を当てたときと読み上げで出す */
      heading: { scale: '震度', time: '時刻', region: '震央地名', magnitude: '規模', depth: '深さ' } as Record<QuakeSortKey, string>,
      asc: { scale: '小さい順', time: '古い順', region: '北から順', magnitude: '小さい順', depth: '浅い順' } as Record<QuakeSortKey, string>,
      desc: { scale: '大きい順', time: '新しい順', region: '南から順', magnitude: '大きい順', depth: '深い順' } as Record<QuakeSortKey, string>,
    },
    /** 並べ替えたときの区切りの行 */
    section: {
      depthUnknown: '深さ不明',
      depthUnder30: '深さ30km未満',
      depth30to100: '深さ30〜100km',
      depth100to300: '深さ100〜300km',
      depth300plus: '深さ300km以上',
      scale: (label: string) => `震度${label}`,
      scaleUnknown: '震度不明',
      magnitude: (m: number) => `M${m}`,
      magnitudeUnknown: 'M不明',
    },
  },
  /**
   * 地図（吹き出し・凡例・描けなかったものの名前・地図を作れないときの表示・自作地震計の札）。
   * 震度の札・長周期の階級名・時刻と規模と深さの書式・津波の高さの語は共有の書式なので、ここでは持たない
   * （値は書式を済ませた文字列で受ける）。
   */
  map: {
    /**
     * 地図の地方名のラベル（気象庁の地方予報区。鍵は `utils/regions.ts` の日本語の名前）。地図の字は焼いた字形で描くので、
     * 字形に無い字を使うと描けない（`scripts/build-glyphs.mjs`。日本語の地名と ASCII だけを焼いている）
     */
    regionName: {
      北海道: '北海道', 東北: '東北', 関東: '関東', 伊豆諸島: '伊豆諸島', 小笠原: '小笠原', 北陸: '北陸', 甲信: '甲信',
      東海: '東海', 近畿: '近畿', 中国: '中国', 四国: '四国', 九州: '九州', 奄美: '奄美', 沖縄: '沖縄',
    } as Record<string, string>,
    /** 地図の隅の「〜を描けず」「〜はクリックに応じず」に入る名前（`utils/renderHealth.ts` が鍵で持つ） */
    layerName: {
      eewEpicenters: '緊急地震速報の震源',
      quakeHypocenters: '地震の震源',
      tsunamiSource: '津波の原因地震の震源',
      catalog: '震源カタログ',
      psWave: '緊急地震速報の予報円',
      estimatedIntensity: '推計震度分布図',
      subThreshold: '弱い揺れの観測点',
      dayNight: '昼夜の境目',
    } satisfies Record<MapLayerName, string>,
    /** 地図を作れなかったとき（WebGL2 が使えないなど）に地図の場所へ出す文 */
    unavailable: {
      title: '地図を表示できません',
      reason: 'お使いの環境が地図の描画に対応していない可能性があります（WebGL2 非対応・ハードウェアアクセラレーション無効など）',
      rest: '地図以外の機能はこのまま利用できます。',
    },
    popup: {
      region: '一次細分区域',
      regionRepresentative: '一次細分区域（代表点）',
      activeFault: '活断層（産総研 活断層データベース）',
      /** プレート境界。`cls` は分類の名前（分類が読めなければ null） */
      plateBoundary: (cls: string | null) => (cls ? `プレート境界（${cls}・PB2002モデル）` : 'プレート境界（PB2002モデル）'),
      plateClass: {
        SUB: '沈み込み帯',
        OCB: '海洋の収束境界',
        CCB: '大陸の収束境界',
        OSR: '海洋の拡大軸',
        CRB: '大陸のリフト',
        OTF: '海洋のトランスフォーム断層',
        CTF: '大陸のトランスフォーム断層',
      } satisfies Record<PlateBoundaryClass, string>,
      eewKind: { warning: '警報', forecast: '地震動予報' },
      eewFinal: '最終報',
      eewSerial: (serial: string) => `第${serial}報`,
      unknownHypocenter: '震源調査中',
      /** 規模と深さの行。どちらも書式を済ませた値 */
      magnitudeDepth: (magnitude: string, depth: string) => `${magnitude} / 深さ ${depth}`,
      maxForecastIntensity: (scale: string) => `予想最大震度 ${scale}`,
      forecastIntensity: (scale: string) => `予想震度 ${scale}`,
      strongShaking: '非常に強い揺れを検知（震源未確定）',
      strongShakingNote: '地名は揺れを検知した観測点の位置です',
      assumedHypocenter: '仮定震源要素（震源未確定）',
      assumedHypocenterNote: '地名は最初に揺れを検知した観測点の位置です',
      eewEnded: 'この緊急地震速報は終了しました',
      mainShakingArrived: '主要動 到達済み',
      mainShakingIn: (sec: number) => `主要動の到達まで 約${sec}秒`,
      /** `cls` は階級名（「階級3」。共有の書式） */
      forecastLpgm: (cls: string) => `予想 長周期地震動${cls}`,
      lpgm: (cls: string) => `長周期地震動${cls}`,
      /** 区域の塗りの吹き出しの 2 行目。`intensity` は震度の札（無ければ null） */
      lpgmRegion: (cls: string, intensity: string | null) => `長周期地震動 ${cls}${intensity !== null ? `　震度 ${intensity}` : ''}`,
      intensity: (scale: string) => `震度 ${scale}`,
      maxIntensity: (scale: string) => `最大震度 ${scale}`,
      /** 長周期の観測点の揺れの大きさ（絶対速度応答スペクトル）。`value` は小数 1 桁の値 */
      maxShaking: (value: string) => `揺れの大きさ 最大 ${value} cm/s`,
      morePrefectures: (n: number) => `ほか ${n} 都道府県`,
      moreMunicipalities: (n: number) => `ほか ${n} 市町村`,
      moreStations: (n: number) => `ほか ${n} 観測点`,
      someUnreceived: '未入電あり',
      unreceivedNote: '気象庁は震度5弱以上と推定していますが、震度が届いていません（未入電）',
      code: (code: string) => `コード ${code}`,
      distance: (km: number) => `震源から約 ${km}km`,
      depth: (depth: string) => `深さ ${depth}`,
      depthUnknown: '深さ不明',
      magnitudeUnknown: 'M 不明',
      preliminary: '速報値',
      telegram: '地震情報の電文',
      /** 震源カタログの最大震度の欄の、震度ではない記号の語（気象庁のフォーマット仕様の語） */
      catalogOther: { F: '有感', X: '付近有感', L: '局発地震', S: '小局発地震', M: 'やや顕著地震', R: '顕著地震' },
      externalHypocenter: '気象庁以外の機関の震源',
      epicenterUnknown: '震源地不明',
      nearbyCount: (n: number) => `この付近 ${n.toLocaleString('ja-JP')} 件`,
      nearbyTitle: (n: number) => `この付近の地震 ${n.toLocaleString('ja-JP')} 件`,
      largest: '最大',
      latest: (time: string) => `最新 ${time}`,
      arrivalConfirmed: '到達を確認',
      maxHeightObserving: '最大波高は観測中',
      /** `height` は書式を済ませた波高（共有の書式） */
      maxWaveSoFar: (height: string) => `これまでの最大波 ${height}`,
      tsunamiMissing: '欠測（観測データが得られていません）',
      /** 海岸線の等級（凡例と海岸線の吹き出し） */
      tsunamiGrade: { MajorWarning: '大津波警報', Warning: '津波警報', Watch: '津波注意報', Forecast: '津波予報', Unknown: '津波予報' } satisfies Record<TsunamiGrade, string>,
    },
    legend: {
      /** 密度の欄の、観測網の疎な時代の注記（カタログタブの `catalog.completeness` と同じ意味） */
      completeness: (year: number, magnitude: string) => `${year} 年まで遡ると、記録が揃うのは M ${magnitude} 以上です。それより小さい地震は少なく見えます。`,
      /** 密度の期間の行。`start` は書式を済ませた始まりの日付、`replay` は再生中か */
      periodRange: (start: string, replay: boolean) => `期間 ${start} 〜 ${replay ? '再生時刻' : 'いま'}`,
      /** 密度の期間のつまみ（読み上げの名前） */
      period: '期間',
      heatmapPeriod: {
        '7d': '7日', '30d': '30日', '90d': '90日', '1y': '1年', '2y': '2年', '5y': '5年', '10y': '10年', '20y': '20年', '50y': '50年', all: '1919年から',
      } satisfies Record<HeatmapPeriod, string>,
      catalog: {
        depth: { title: '震源の深さ', short: '深さ' },
        magnitude: { title: 'マグニチュード', short: 'M' },
        time: { title: '発生年', short: '発生年' },
      } satisfies Record<CatalogColorBy, { title: string; short: string }>,
      externalHypocenter: '気象庁以外の機関の震源',
      depthUnknown: '深さ不明',
      magnitudeUnknown: 'M 不明',
      intensity: '震度',
      realtimeIntensity: 'リアルタイム震度',
      eewForecast: '緊急地震速報の予想',
      lpgmClass: '長周期地震動階級',
      lpgmClassShort: '長周期階級',
      /** 見出しに名前を並べるときの区切り */
      nameSeparator: '・',
      unreceivedTitle: '震度を入手していない地点',
      unreceived: '未入電',
      psWave: '緊急地震速報の予報円',
      psWaveShort: '予報円',
      pWave: 'P波',
      sWave: 'S波',
      tsunami: '津波',
      tsunamiObsHeight: '観測した津波の高さ',
      tsunamiObsHeightShort: '観測波高',
      arrivalConfirmed: '到達確認',
      missing: '欠測',
      tideStations: '潮位観測点',
      tideStationsShort: '観測点',
      density: '地震活動の密度',
      few: '少',
      many: '多',
      activeFaults: '活断層',
      plateSubduction: 'プレート境界（沈み込み帯）',
      plateConvergent: 'プレート境界（収束）',
      plateDivergent: 'プレート境界（拡大・リフト）',
      plateTransform: 'プレート境界（トランスフォーム断層）',
      lines: '線',
    },
    /** 地図に重ねる自作地震計の行の、震度の出どころの札 */
    seismo: {
      waveOnly: '波形のみ',
      unseen: '未着',
      singleUnverified: '単独（裏付けなし）',
      maxOfSensors: (n: number) => `単独 ${n}本の最大`,
      sensors: (n: number) => `単独 ${n}本`,
    },
  },
  /**
   * 設定の窓（分類・見出し・行・状態の文・テストボタン）。震度の札の語・日付の書式は共有の書式なので、ここでは持たない
   * （値は書式を済ませた文字列で受ける）。出典の名称は配信元が求める表記のまま、コードに日本語で置く。
   */
  settings: {
    categories: {
      connection: '接続',
      notification: '通知',
      sound: '音と読み上げ',
      display: '表示',
      behavior: '動作',
      location: '登録地点と地震計',
      share: '共有と保存',
      about: 'このアプリについて',
      dev: '開発・検証',
    } satisfies Record<SettingsCategoryId, string>,
    dialog: {
      title: '設定',
      back: '戻る',
      close: '閉じる',
      categoryList: '設定の分類',
    },
    sections: {
      connection: '接続',
      notify: '通知',
      sound: '音と読み上げ',
      timeSignal: '時報',
      speech: '読み上げ設定',
      display: '表示設定',
      map: '地図',
      intensityScale: '震度スケール',
      behavior: '動作設定',
      checklist: '行動チェックリスト',
      home: '登録地点',
      seismo: '自作地震計',
      wave: '波形グラフ',
      share: '共有と保存',
      about: 'このアプリについて',
      soundTest: '通知音テスト',
      test: 'テスト機能',
      replay: 'テスト時刻設定',
      knet: 'K-NETデータの取り込み',
      diag: '診断ログ',
    },
    common: {
      exportFailed: (reason: string) => `書き出しに失敗しました: ${reason}`,
      export: '書き出す',
      clear: '消去',
      deleting: '削除中…',
      delete: '削除',
      show: '表示',
      sent: '送信済み',
      fetching: '取得中…',
      checking: '確認中…',
      unlimited: '無制限',
      seconds: (n: number) => `${n}秒`,
      minutes: (n: number) => `${n}分`,
      listSeparator: '・',
      preview: '▶ 試聴',
    },
    rows: {
      apiKeyNote: 'APIキーはこのブラウザにのみ保存されます。第三者と共有しないでください。',
      telegram: {
        label: '電文',
      },
      forecast: {
        label: '予報',
      },
      classifications: {
        label: '受信している区分',
      },
      apiKey: {
        label: 'APIキー',
        description: 'DMDATA.JP のAPIキーを入力してください',
        placeholder: 'APIキーを入力',
      },
      forecastKey: {
        label: '予報キー',
      },
      testDelivery: {
        label: '試験報を受信（検証用）',
        description: '試験報・訓練報も受信します。国際津波関連情報の通信試験は、入のときだけ音・通知・読み上げで伝えます。緊急地震速報の配信テストは接続の確認だけに使い、画面には出しません',
      },
      notifyEnabled: {
        label: '通知を表示',
        description: 'オフにすると、ブラウザ通知をすべて止めます',
      },
      notifyQuietWhileOpen: {
        label: 'アプリを開いている間は通知しない',
        description: 'アプリが画面に出ている間は、通知（プッシュ通知を含む）を出しません。画面の表示と、通知音・読み上げはそのままです',
      },
      notifyQuake: {
        label: '地震情報の通知',
        description: '地震情報・長周期地震動・推計震度分布図・地震回数に関する情報を受けたときに通知します',
      },
      notifyMinScale: {
        label: '通知する最低震度',
        description: 'この震度以上で通知を送信します',
        noneLabel: '震度1以上',
      },
      notifyDetection: {
        label: '揺れ検知通知',
        description: '揺れを検知したときに通知します。リアルタイム震度から判定するため、通知は多めになります',
      },
      notifyEEW: {
        label: '緊急地震速報の通知',
        description: '緊急地震速報が出たときと、警報・特別警報へ上がったときに通知します',
      },
      notifyTsunami: {
        label: '津波通知',
        description: '津波警報・注意報・予報が発表されたときと、全て解除されたときに通知します',
      },
      notifyNankai: {
        label: '南海トラフ・後発地震の通知',
        description: '南海トラフ地震臨時情報・北海道・三陸沖後発地震注意情報と、臨時の解説情報を受けたときに通知します',
      },
      notifyNankaiRoutine: {
        label: '定例の解説情報の通知',
        description: '南海トラフ地震関連解説情報の定例解説を受けたときに通知します。この情報は平常時も毎月届きます',
      },
      notifyQuakeNotice: {
        label: 'お知らせの通知',
        description: '地震・津波に関するお知らせを受けたときに通知します',
      },
      notifyPrefectures: {
        label: '通知する地域',
        description: '選んだ都道府県に関わる情報だけを通知します。地震情報は震度を観測した都道府県、緊急地震速報は対象の地域、津波は予報区で見ます。選ばなければ全国の情報を通知します。南海トラフ・後発地震・地震回数など、地域を持たない情報は絞りません',
      },
      notifyPermission: {
        label: '通知許可',
        description: 'ブラウザの通知権限を確認・許可します',
        deniedDescription: 'ブラウザで通知が拒否されています。通知を受け取るには、ブラウザのサイトの設定で通知を許可してください',
        unsupportedDescription: 'このブラウザは通知に対応していません',
      },
      testNotification: {
        label: 'テスト通知',
        description: 'テスト通知を即時送信（要通知許可）',
        button: '通知テスト',
      },
      sound: {
        label: '通知音',
        description: '地震・緊急地震速報・津波の受信時に音を鳴らします',
      },
      tts: {
        label: '読み上げ',
        description: '地震・緊急地震速報・津波情報を読み上げます',
      },
      ttsVoice: {
        label: '読み上げの声',
        description: 'VOICEVOX に繋がらないときは、システムの読み上げで読み上げます',
        system: 'システムの読み上げ',
      },
      volume: {
        label: '音量',
        description: '通知音と読み上げに共通の音量です',
      },
      nankaiCommentaryAlerts: {
        label: '解説情報の音・読み上げ',
        description: '南海トラフ地震関連解説情報の通知音と読み上げを行います。この情報は平常時も毎月届きます',
      },
      quakeNoticeAlerts: {
        label: 'お知らせの音・読み上げ',
        description: '地震・津波に関するお知らせの通知音と読み上げを行います',
      },
      kyoshinDetectSpeech: {
        label: '揺れ検知の読み上げ',
        description: '揺れを検知したとき、最も強く揺れている地域の名前を読み上げます。緊急地震速報の範囲内の揺れは読み上げません',
      },
      voicevoxUrl: {
        description: 'VOICEVOXのHTTP APIのURL',
        hint: '要：VOICEVOXアプリ起動',
        invalid: 'URLの形式が正しくありません。http:// または https:// で始まる、ホスト名を含むURLを入力してください。',
      },
      voicevoxStatus: {
        label: '接続状態',
        available: '起動中',
        unavailable: '起動していません',
        invalid: 'URLが無効',
      },
      voicevoxSpeaker: {
        label: '話者',
        description: '読み上げに使う声を選択します',
      },
      voicevoxTest: {
        label: 'テスト読み上げ',
      },
      ttsIntensityLevels: {
        label: '読み上げ震度階数',
        description: '最大震度から何階級下まで、地域名を読み上げるかです',
        maxOnly: '最大震度のみ',
        all: 'すべての階級',
        plus: (n: number) => `最大＋${n}階級`,
      },
      ttsAlwaysReadScale: {
        label: '必ず読み上げる震度',
        description: '階数の設定を超えても、この震度以上の階級は地域名を読み上げます。長周期地震動には効きません',
        noneLabel: '階数の設定どおり',
      },
      ttsAlwaysReadLpgmClass: {
        label: '必ず読み上げる長周期地震動階級',
        description: '階数の設定を超えても、この階級以上の地域名を読み上げます',
        option: (n: number) => `階級${n}`,
      },
      ttsMaxRegions: {
        label: '読み上げ最大地域数',
        description: '1階級あたりに読み上げる地域名の上限です',
        option: (n: number) => `${n}地域`,
      },
      ttsRegionTolerance: {
        label: '地域数の許容超過',
        description: '上限をこの数まで超えるだけなら「ほかN地域」とせず全地域を読み上げます',
        none: '許容しない',
        option: (n: number) => `+${n}地域まで`,
      },
      ttsReadHypocenterDetail: {
        label: '震源の深さ・規模',
        description: '「石川県能登地方、深さ10キロメートルを震源とするマグニチュード5.2の地震が発生しました」のように読み上げます。切ると震源の地名だけを読みます',
      },
      ttsUnreceivedDetail: {
        label: '震度を入手していない地点',
        description: '震度5弱以上と推定されるのに観測値が届いていない地点の読み方。「区域名」は地点名の代わりに地域名でまとめます（例: 石川県能登では、一部の地点で…）。「地名を読まない」でも、件数と「震度5弱以上と推定されるが未入電」であることは読み上げます',
        stations: '地点名',
        areas: '区域名',
        none: '地名を読まない',
      },
      ttsMaxObservationPoints: {
        label: '津波観測点の読み上げ件数',
        description: '津波の観測情報で読み上げる観測点の数。波高の更新・津波警報相当の観測・到達確認・欠測でそれぞれこの件数まで読み、残りは「ほかN地点」と件数で伝えます',
        option: (n: number) => `${n}地点`,
      },
      ttsReadEewLpgmClass: {
        label: '緊急地震速報の長周期地震動階級',
        description: '予想震度に続けて「予想最大階級3」のように読み上げます。長周期地震動観測情報そのものには影響しません',
      },
      ttsReadEewWarningRegions: {
        label: '緊急地震速報の警戒地域',
        description: '警報が出ている地方を、震源に続けて「北陸、甲信、東海では強い揺れに警戒してください」のように読み上げます。予想震度はそのあとに読み上げます',
      },
      ttsReadTelegramText: {
        label: '気象庁の発表文',
        description: '電文に添えられた本文・付加文（南海トラフ地震臨時情報の本文など）を読み上げます。震度や津波の読み上げが終わってから読むため、電文が続いている間は読み上げられないことがあります',
      },
      // 名前に英語を添える（読めない言語になった人が英語で探せるように）。言語の名前は辞書に置かない（→ messages.ts の LOCALES）
      // （2026-11-12 ユーザー選択「言語 (Language) (Recommended)」「この文面でよい (Recommended)」・説明は同日「この文面に変える (Recommended)」）
      locale: {
        label: '言語 (Language)',
        description: '画面と通知の言葉。読み上げは日本語のまま。',
        auto: '端末に合わせる',
        // 辞書を読めないときに行の下へ出す知らせは辞書の外（messages.ts の LOCALE_LOAD_FAILED_JA・_EN）
      },
      uiScale: {
        label: 'UI 倍率',
        description: '画面全体の表示倍率を変更します',
      },
      mapIconScale: {
        label: '地図アイコンの倍率',
        description: '地図上の震度マーカーなどの大きさを変更します。UI 倍率とは別に効きます',
      },
      hypocenterDepthScale: {
        label: '震源の深さの強調',
        description: '地図を傾けたとき、震源をどれだけ深く見せるかの倍率です。水平方向は実際の縮尺のままです',
        actual: '実際の深さ',
        times: (n: number) => `${n} 倍`,
      },
      quakeNoticeBanner: {
        label: 'お知らせを表示',
        description: '地震・津波に関するお知らせを地図の下に表示します',
      },
      showBathymetry: {
        label: '海底地形を表示',
        description: '背景の海域に海底地形（陰影）を表示します',
      },
      showDayNight: {
        label: '昼夜の境目を表示',
        description: '地図に夜の側を重ねます。日の入りから夜が深まるまでを、濃さの変化で表します',
      },
      dayNightOpacity: {
        label: '夜側の濃さ',
        description: '夜の側をどれだけ暗くするかを調整します。暗くなるのは陸地と海底地形だけです',
      },
      showPlateBoundaries: {
        label: 'プレート境界線を表示',
        description: '地震情報・リアルタイム・津波情報タブの地図に世界のプレート境界線を表示します（PB2002モデル）',
      },
      showActiveFaults: {
        label: '活断層線を表示',
        description: '地震情報・リアルタイムタブの地図に全国の活断層線を表示します（産総研 活断層データベース）',
      },
      activeFaultOpacity: {
        label: '活断層線の濃さ',
        description: '活断層線の濃さを調整します',
      },
      showQuakeHeatmap: {
        label: '地震活動ヒートマップを表示',
        description: '地震情報・リアルタイムタブの地図に地震活動をヒートマップで表示します。期間は下の欄か地図の凡例で変えられます',
      },
      heatmapPeriod: {
        label: 'ヒートマップの期間',
        description: 'どこまで遡った地震を描くかを選びます。地図の凡例のつまみと同じ設定です',
      },
      showMapLegend: {
        label: '凡例を表示',
        description: '地図の右下に、いま地図で使っている色の意味（震度・津波の等級・震源の深さなど）を重ねます。見出しをタップすると畳めます',
      },
      defaultTab: {
        label: 'デフォルトタブ',
        description: '操作や情報更新が一定時間ないとこのタブに戻ります',
      },
      tsunamiPriorityDefault: {
        label: '津波発表中は津波情報を優先',
        description: '津波情報の発表中はデフォルトタブを津波情報にします',
      },
      tsunamiTitleTemporary: {
        label: '津波タイトル表示を一定時間に制限',
        description: 'ONで受信のたびに自動復帰までの時間だけ表示し、発表中でも自動的に戻ります',
      },
      idleRevertSec: {
        label: '自動復帰までの時間',
        description: '操作・情報更新がこの時間ないとデフォルトタブに戻ります',
        off: '無効',
      },
      periodicReload: {
        label: '定期自動リロード',
        description: '毎日午前5時に画面を再起動してメモリを解放します。地震・津波・緊急地震速報の発表中は延期します',
      },
      recordingMode: {
        label: '録画モード',
        description: '画面録画中のコマ落ちを減らします。表示される内容は変わりません',
      },
      actionChecklist: {
        label: '行動チェックリスト',
        description: '強い揺れのときに、とるべき行動と持ち出すものを画面上部に出します。緊急地震速報・リアルタイム震度・地震情報のいずれかで判定します',
      },
      actionChecklistMinScale: {
        label: '出す最低震度',
        description: '地点を登録していればその周辺（半径30km）で、していなければ全国のどこかでこの震度に達したときに出します',
      },
      arrivalToken: {
        label: '到達予想キー',
      },
      seismoEnabled: {
        label: '自作地震計と接続',
        description: 'ご自宅に設置した地震計ホストへ接続します',
        hint: '要：ホーム画面に追加してから開く',
      },
      seismoHostUrl: {
        label: 'ホストのURL',
        description: '地震計ホストのURL（例: https://seismo.example.ts.net）',
      },
      seismoStatus: {
        label: '接続状態',
      },
      seismoStations: {
        label: '観測点',
        description: 'ホストに設定されている観測点',
      },
      seismoWave: {
        label: '波形グラフ',
        description: '地図の下端に直近の揺れを表示します。「表示しない」にすると、地震カードの自作地震計の波形と震度も表示しません',
        hint: '「表示しない」以外は波形を受信し続けます（1日約1.3GB）',
        off: '表示しない',
        auto: '揺れたときだけ',
        always: '常に表示',
      },
      seismoWaveCollapsedView: {
        label: '波形の表示',
        description: '波形を展開していないときに表示するものです',
        composite: '合成',
        overlay: '3成分を重ねる',
      },
      publicWave: {
        label: '公開観測点の波形を表示',
        description: '揺れたとき、近くの公開観測点（気象庁の広帯域地震計）の波形を地図の下端と地震カードに表示します',
      },
      waveSpan: {
        label: '波形の時間幅',
        description: '地図の下端に表示する長さです',
      },
      publicWaveAlwaysConnected: {
        label: '公開観測点に常時接続',
        description: '揺れていないときも接続しておき、揺れ始めから表示します',
        hint: '通信量が増えます（1日に約130MB）',
      },
      shareCardFormat: {
        label: '共有カードの寸法',
        description: '地図を画像にして共有するときの縦横の比率です。',
      },
      settingsFile: {
        label: '設定ファイル',
        description: 'いまの設定をファイルへ書き出し、別の端末やブラウザで読み込めます。' +
          'APIキーは書き出しに含まれません（読み込んでも、いま入力してある値は消えません）。',
      },
      usageStats: {
        label: '使用状況データを送信する',
        description: '開いたタブ・使っている機能・設定・端末の種類などを送ります。名前・IP アドレス・登録した地点は送りません。' +
          'オフにすると、この端末の識別子も消えます。',
      },
      serverClockOffset: {
        label: 'サーバー時刻オフセット',
        description: '端末の時計と、サーバーから得た時刻の差です。診断用です。「未較正」は、まだサーバーの時刻を得られていない状態です',
      },
    },
    connection: {
      disconnected: '切断',
      upstreamSince: (time: string) => `・${time} から`,
      upstreamDown: (since: string) => `切断（配信サーバーが DMDATA.JP と切断中${since}）`,
      viaRelay: '接続中（配信サーバー経由）',
      viaApiKey: '接続中（APIキー）',
      apiKeyUnset: 'APIキー未設定',
      apiKeyInvalid: 'APIキーが無効',
      connected: '接続中',
      connecting: '接続試行中…',
      replay: '再生中（ライブ受信は停止）',
      crowded: '同時接続の上限（別のタブか端末が接続中。閉じれば自動で繋がります）',
      contractEnded: '接続を停止（受信できる区分がなくなりました。契約を確かめてから再読み込みしてください）',
      closedByUser: '接続を停止（DMDATA.JP 側で接続が終了されました。再読み込みで繋ぎ直します）',
    },
    classifications: {
      labels: {
        'eew.forecast': '緊急地震（予報）',
        'eew.warning': '緊急地震（警報）',
        'telegram.earthquake': '地震・津波関連',
      } satisfies Record<DmdataClassification, string>,
      separator: '・',
    },
    apiKeyInvalid: 'APIキーに使用できない文字が含まれています。半角の英数字・記号のみで入力してください。',
    signedKey: {
      remove: '消す',
      relayRejected: '配信サーバーがこのキーを受け付けませんでした',
      checking: '確認中',
      valid: '有効',
      validUntil: (at: string) => `有効（${at} まで）`,
      expiredAt: (at: string) => `${at} に`,
      problems: {
        malformed: 'キーの形が違います。渡された文字列をそのまま貼ってください',
        signature: 'このアプリでは使えないキーです。配布元へ問い合わせてください',
        'no-expiry': 'キーに有効期限がありません。発行し直してもらってください',
        expired: '有効期限が切れています。発行し直してもらってください',
        error: 'キーを検証できませんでした',
      } satisfies Record<Exclude<ArrivalTokenProblem, 'empty'>, string>,
    },
    prefecture: {
      nationwide: '全国',
      summary: (first: string, rest: number) => `${first}ほか ${rest}`,
      title: '通知する地域',
      close: '閉じる',
    },
    scale: {
      all: 'すべて表示',
      orAbove: (label: string) => `震度${label}以上`,
      badge: (label: string) => `震度${label}`,
    },
    permission: {
      granted: '許可済み',
      denied: 'ブラウザで拒否済み',
      unsupported: '非対応',
      request: '通知を許可する',
    },
    clock: {
      uncalibrated: '未較正',
    },
    home: {
      noGeolocation: 'このブラウザは位置情報をサポートしていません',
      permissionNeeded: '位置情報の許可が必要です',
      failed: '位置情報の取得に失敗しました',
      current: {
        label: '現在地',
        hint: '現在地を主要動到達の基準点として使用します。HTTPS または localhost が必要です。',
      },
      lat: (value: string) => `北緯${value}°`,
      lng: (value: string) => `東経${value}°`,
      unset: '未設定',
      getCurrent: '現在地を取得',
      clear: 'クリア',
      manual: '緯度・経度で入れる',
      latitude: '緯度',
      longitude: '経度',
      apply: 'この地点にする',
    },
    seismoStatus: {
      noUrl: 'ホストのURLを入力してください',
      invalid: 'URLの形式が正しくない。http:// または https:// から入力してください',
      checking: '確認中…',
      noStations: '接続済み: 観測点は未設定',
      notArrived: (stations: number) => `接続済み: 観測点 ${stations}・まだ届いていない`,
      ok: (stations: number, sensors: number) => `接続済み: 観測点 ${stations}・センサー ${sensors}`,
      timeout: (seconds: number) => `応答がない: ${seconds}秒待って打ち切った。ホストが起動しているか確かめてください`,
      mixedContent: '繋げない: このページは https なので http のホストへは繋げない。https:// のURLを入力してください',
      offline: '繋げない: この端末がオフライン。ネットワークに繋いでください',
      unknown: '応答がない。ホストが起動しているか確かめてください',
      httpError: (status: number) => `応答がエラー: HTTP ${status}`,
      unreadable: '応答を読めない。URLが地震計のホストを指しているか確かめてください',
      unreadableData: (count: number) => `読めないデータが届いている: ${count} 件。ホストとアプリの版が合っているか確かめてください`,
    },
    timeSignal: {
      enabled: {
        label: '時報',
        description: '決めた間隔で、音と読み上げで時刻を知らせます',
      },
      interval: {
        label: '間隔',
      },
      sound: {
        label: '音',
      },
      order: {
        label: '順番',
      },
      phrase: {
        label: '読み上げの文',
      },
      clock: {
        label: '時刻の読み方',
      },
      quiet: {
        label: '鳴らさない時間帯',
        description: '日をまたいで指定できます',
      },
      from: 'から',
      until: 'まで',
      whileSpeaking: {
        label: '読み上げと重なったとき',
        description: '地震や津波の読み上げの最中に時刻が来たときの扱いです。通知音とは重ねて鳴らします',
      },
      volume: {
        label: '時報の音量',
      },
      sameAsAlert: '通知音と同じ',
      voice: {
        label: '時報の声',
      },
      sameAsSpeech: '読み上げと同じ',
      intervals: { 60: '1時間ごと', 30: '30分ごと', 15: '15分ごと', 10: '10分ごと', 5: '5分ごと' } satisfies Record<TimeSignalIntervalMin, string>,
      sounds: { pips: 'ピッ・ピッ・ピッ・ポーン', pon: 'ポーン', chime: 'チャイム', none: '鳴らさない' } satisfies Record<TimeSignalSound, string>,
      orders: { soundFirst: '音が先', speechFirst: '読み上げが先' } satisfies Record<TimeSignalOrder, string>,
      clocks: { '24h': '24時間制', '12h': '12時間制' } satisfies Record<TimeSignalClock, string>,
      whileSpeakingOptions: { soundOnly: '音だけ鳴らす', skip: '鳴らさない' } satisfies Record<TimeSignalWhileSpeaking, string>,
    },
    textBlocks: {
      heading: '読み上げる文の内訳',
      count: (on: number, total: number) => `${on} / ${total} 項目`,
      groups: {
        quake: '地震情報',
        tsunami: '津波情報',
        lpgm: '長周期地震動に関する観測情報',
        nankai: '南海トラフ地震臨時情報',
        nankaiCommentary: '南海トラフ地震関連解説情報',
        kohatsu: '北海道・三陸沖後発地震注意情報',
        earthquakeCount: '地震回数に関する情報',
        quakeNotice: '地震・津波に関するお知らせ',
      },
      labels: {
        quakeForecast: '固定付加文',
        quakeVarComment: '固定付加文（その他）',
        quakeFreeText: '自由付加文',
        tsunamiBody: '本文',
        tsunamiVarComment: '固定付加文',
        tsunamiFreeText: '自由付加文',
        lpgmForecast: '固定付加文',
        lpgmVarComment: '固定付加文（その他）',
        lpgmFreeText: '自由付加文',
        nankaiSummary: '要約',
        nankaiBody: '本文',
        nankaiNextAdvisory: '次回発表予定',
        nankaiCommentarySummary: '要約',
        nankaiCommentaryBody: '本文',
        nankaiCommentaryNextAdvisory: '次回発表予定',
        kohatsuSummary: '要約',
        kohatsuBody: '本文',
        earthquakeCountBody: '本文',
        earthquakeCountFreeText: '自由付加文',
        quakeNoticeBody: '本文',
      } satisfies Record<TelegramTextBlockKey, string>,
      descriptions: {
        quakeForecast: '津波の一文のほかに添えられる定型文です。津波の一文そのものは、この設定によらず読み上げます。例:「震源の近傍で津波発生の可能性があります。」',
        quakeVarComment: '気象庁以外が運用する観測点（＊印）の説明や、「震源要素を訂正します。」といった定型文です。例:「＊印は気象庁以外の震度観測点についての情報です。」',
        quakeFreeText: 'その電文にだけ添えられる説明です。内容は報ごとに変わります。例:「この地震とほぼ同時刻に別の地震が発生していますが、緊急作業中で震度を分離できないため、この情報で震度を取りまとめて発表しています。」',
        tsunamiBody: '津波がいつ来て、いつまで続くかの説明です。津波予報では区域に波高も到達時刻も付かないため、この文にしか書かれていません。例:「これらの沿岸では今後２、３時間程度は若干の海面変動が継続する可能性が高いと考えられます。」',
        tsunamiVarComment: '避難の呼びかけ、満潮時刻、沿岸・沖合の観測についての定型文です。避難の呼びかけ自体は、この設定によらず読み上げます。例:「ただちに避難してください。」に続けて、大津波警報・津波警報・津波注意報それぞれの行動が書かれます（約 600 字）',
        tsunamiFreeText: 'その電文にだけ添えられる説明です。例:「［予想される津波の高さの解説］」に続けて、１０ｍ超から１ｍまで 5 段階の被害が書かれます',
        lpgmForecast: '「この地震について、緊急地震速報を発表しています。」のような定型文です',
        lpgmVarComment: '気象庁以外が運用する観測点（＊印）の説明です。例:「＊印は気象庁以外の長周期地震動観測点についての情報です。」',
        lpgmFreeText: '階級と揺れの大きさの対応表など、その電文の補足です。例:「各長周期地震動階級に対する簡易な現象表現」に続けて「階級１やや大きな揺れ」から階級４までが並び、詳しい観測結果の参照先が付きます',
        nankaiSummary: '発表内容を一文にまとめたものです。画面の帯に出ている見出しと同じ文です。地震の発生時刻・震源・規模に続けて、想定震源域の状況と防災対応の呼びかけが書かれます',
        nankaiBody: '調査の結果や評価の根拠です。実際の電文では 1000 字を超えることがあります',
        nankaiNextAdvisory: '次の情報がいつ出るかの案内です。例:「次回の情報発表は、２１時頃を予定しています。」',
        nankaiCommentarySummary: '発表内容を一文にまとめたものです。画面の帯に出ている見出しと同じ文です。例:「第１０９回南海トラフ沿いの地震に関する評価検討会で、南海トラフ周辺の地殻活動を評価しました。」',
        nankaiCommentaryBody: '地殻活動の観測状況と評価です。実際の電文では 1600 字を超えることがあります。地震の観測状況・地殻変動の観測状況・地殻活動の評価の 3 節立てで、深部低周波地震が起きた区間などを日付付きで挙げます',
        nankaiCommentaryNextAdvisory: '次の情報がいつ出るかの案内です。例:「次回の情報発表は、２２日１５時３０分頃を予定しています。」',
        kohatsuSummary: '発表内容を一文にまとめたものです。画面の帯に出ている見出しと同じ文です。地震の発生と、想定震源域で大規模地震の可能性が平常時より高まっていることが書かれます',
        kohatsuBody: '発表の理由と、とるべき防災対応の説明です',
        earthquakeCountBody: '地震回数に関する情報の本文です。',
        earthquakeCountFreeText: '地震回数の補足です。例:「８月２４日１５時過ぎから伊豆半島東方沖で地震が発生しています。」に続けて、震度２以下はこの情報でまとめて発表する旨が書かれます',
        quakeNoticeBody: 'お知らせの本文と自由付加文です。例:「本日（１０月１６日）１２時４０分頃、緊急地震速報（警報）を北海道、東北、関東、北陸、甲信、東海、伊豆諸島に発表しましたが、震度２以上を観測した場所はありませんでした。」',
      } satisfies Record<TelegramTextBlockKey, string>,
    },
    boilerplate: {
      heading: '定型文の読み上げ',
      note: '事象によらずほぼ同じ文です。切っても画面には出ます',
      labels: {
        starMark: '＊印の説明',
        eewIssued: '緊急地震速報の発表告知',
        lpgmClassTable: '長周期地震動階級の目安',
        tsunamiHeightLegend: '津波の高さの目安',
        earthquakeInfoAppendix: '南海トラフ・後発地震の情報の参考情報',
      } satisfies Record<TelegramBoilerplateKey, string>,
      descriptions: {
        starMark: '気象庁以外が運用する観測点（＊印）の説明です。例:「＊印は気象庁以外の震度観測点についての情報です。」（長周期地震動観測情報では「長周期地震動観測点」）。読み上げでは＊が音にならないため、何と対比しているのかが伝わりません',
        eewIssued: '例:「この地震について、緊急地震速報を発表しています。」緊急地震速報そのものは画面と音でお知らせしているため、切っても取り逃しません',
        lpgmClassTable: '階級と揺れの大きさの対応表と、詳しい観測結果の参照先です。例:「各長周期地震動階級に対する簡易な現象表現」に続けて「階級１やや大きな揺れ」から階級４までが並びます。長周期地震動観測情報のほぼ全報に入ります',
        tsunamiHeightLegend: '予想される津波の高さと被害の対応表です。例:「［予想される津波の高さの解説］」に続けて、１０ｍ超から１ｍまで 5 段階の被害が書かれます（307 字。読み上げるとおよそ 50 秒）',
        earthquakeInfoAppendix: '南海トラフ地震臨時情報・同関連解説情報・北海道・三陸沖後発地震注意情報の末尾に付く、情報の種類や発表条件の説明です。毎報ほぼ同じ文です。画面では帯の「この種類の情報について」で開けます',
      } satisfies Record<TelegramBoilerplateKey, string>,
    },
    io: {
      exportedWithKeys: '書き出しました（鍵も含まれています）',
      exportedWithoutKeys: '書き出しました（鍵は含まれていません）',
      unreadable: '設定ファイルとして読み取れませんでした',
      notSaved: '※ この端末に保存できませんでした。次にアプリを開くと元の設定に戻ります',
      loaded: '設定を読み込みました',
      exportedAt: (at: string) => `（${at} に書き出されたファイル）`,
      rejectedKeys: (keys: readonly string[]) => `※ 次の項目は読めなかったため、はじめの値にしました: ${keys.join('、')}`,
      usedFileApiKey: '※ ファイルに APIキーが書かれていたため、それを使いました',
      includeKeys: '鍵も含める',
      import: '読み込む',
      keysWarning: '鍵が入ったファイルは、人に渡したり公開の場所に置いたりしないでください',
      fileErrors: {
        empty: '設定ファイルとして読めません（中身がありません）',
        notThisApp: 'このアプリの設定ファイルではありません',
        notSettings: 'このアプリのファイルですが、設定ではありません',
        malformed: '設定ファイルの形式が正しくありません（壊れている可能性があります）',
        newer: 'より新しいアプリで書き出されたファイルです。アプリを更新してください',
        noSettings: '設定の中身がありません',
        noKeys: 'キーが入っていません',
      } satisfies Record<SettingsFileError, string>,
      keysLoaded: (forecastKey: boolean, arrivalToken: boolean) =>
        `${[forecastKey ? '予報キー' : null, arrivalToken ? '到達予想キー' : null].filter(Boolean).join('・')}を読み込みました（ほかの設定はそのままです）`,
    },
    shareCardFormats: { wide16x9: 'X（16:9）', square1x1: '正方形（1:1）', portrait4x5: '縦長（4:5）' } satisfies Record<ShareCardFormatId, string>,
    version: {
      checking: '確認しています…',
      latest: '最新です',
      offline: '確認できませんでした（回線が切れています）',
      failed: '確認できませんでした',
      newVersion: (version: string | null) => `新しいバージョン${version !== null ? ` ${version}` : ''}`,
      applyNow: '今すぐ更新',
      row: {
        label: 'バージョン',
      },
      check: '更新を確認',
    },
    history: {
      row: {
        label: '変更履歴',
      },
    },
    credits: {
      terms: {
        label: '規約',
      },
      termsOfService: '利用規約',
      privacy: 'プライバシーポリシー',
      licenses: '使用ソフトウェアのライセンス',
      quakeData: {
        label: '地震・津波データ',
      },
      publicWave: {
        label: '公開観測点の波形',
      },
      map: {
        label: '地図',
      },
      /**
       * 出典の名称に添える語。**名称（気象庁・EarthScope・NSF NGF・CC BY 4.0 など）は配信元の表記のまま**で辞書を通さず、
       * 用途の添え書きと「配信」だけを訳す。`paren` は括弧（日本語は全角、ほかの言語は半角と前の空白）
       */
      paren: (text: string) => `（${text}）`,
      jpNetwork: 'JP 網',
      /**
       * 配信した施設の名前（と括弧の添え書き）を「配信」の語と並べた文。`name` の位置に名前が入る（画面はそこへ名前のリンクを置く）。
       * 語順は言語で違う（日本語「配信 EarthScope」・韓国語「EarthScope 배포」・中国語「由 EarthScope（NSF NGF）发布」。
       * 2026-11-12 ユーザー選択「言語ごとに語順を変える (Recommended)」）。名前との間の空きもこの文が持つ（中国語は括弧の後ろに空きを置かない）
       */
      distributedBy: (name: string) => `配信 ${name}`,
      boundaries: '境界・海岸線',
      seafloor: '海底地形',
      plateBoundaries: 'プレート境界',
    },
    soundTest: {
      intensityTitle: (label: string) => `震度${label} の更新音を試聴`,
      countdownTitle: (second: number) => `S 波到達まで残り ${second} 秒の音を試聴`,
      note: '押すと各通知音を試聴できます。通知音を切っていても鳴ります',
      kyoshinCandidate: {
        label: '揺れ検知（候補）',
        description: 'マリンバ単発 F#5（確定前の予兆通知・控えめ）',
      },
      kyoshin: {
        label: '揺れ検知（初回）',
        description: 'マリンバ2音 C#6→A5（下行長3度）',
      },
      eewForecast: {
        label: '緊急地震速報 予報（低震度）',
        description: 'ダークピアノ F4→A4（緩やか）',
      },
      eew: {
        label: '緊急地震速報 初報（警報）',
        description: '警報音 Bb3 の2連',
      },
      eewSpecial: {
        label: '緊急地震速報 特別警報',
        description: '警報音 Bb4/F4 の交互9連打 + 低音（震度6弱以上）',
      },
      eewUpdate: {
        label: '緊急地震速報 続報',
        description: 'ダークピアノ F4 単音',
      },
      eewFinal: {
        label: '緊急地震速報 最終報',
        description: 'ダークピアノ F4→C4 の降下2音',
      },
      eewCancel: {
        label: '緊急地震速報 取消',
        description: 'ダークピアノ A4→F4→C4 降下3音',
      },
      earthquakePrompt: {
        label: '地震情報（震度速報）',
        description: 'ピアノ上昇3音 G#4→B4→E5',
      },
      earthquake: {
        label: '地震情報（震源・震度 / 各地の震度）',
        description: 'ピアノ上昇4音 E4→G#4→B4→E5',
      },
      earthquakeInfo: {
        label: '地震情報（震源情報・遠地地震）',
        description: 'ピアノ2音 G4→B4',
      },
      earthquakeCancel: {
        label: '地震情報・長周期地震動・地震回数の取消',
        description: 'ピアノ降下3音 E5→B4→E4',
      },
      tsunamiForecast: {
        label: '津波予報（若干の海面変動）',
        description: '石川県能登・加賀ほか – tsunamiForecast 音 / 90秒後に失効',
      },
      tsunamiWatch: {
        label: '津波注意報',
        description: '鹿児島県西部・種子島屋久島ほか – tsunamiWatch 音',
      },
      tsunami: {
        label: '津波警報',
        description: '新潟・富山・石川県能登ほか – tsunami 音',
      },
      tsunamiMajor: {
        label: '大津波警報',
        description: '岩手・宮城・福島ほか – tsunamiMajor 音',
      },
      tsunamiUpdate: {
        label: '津波情報更新（等級はそのまま）',
        description: '純音2音 F#4→C#5（穏やかな通知）',
      },
      tsunamiCancel: {
        label: '津波解除・取消・失効',
        description: '純音 G4→C4 の終止形（3 つの理由を単一音で伝える）',
      },
      specialInfo: {
        label: '南海トラフ地震臨時情報・北海道・三陸沖後発地震注意情報',
        description: '純音 A4×2連打 → D5',
      },
      specialInfoCommentary: {
        label: '南海トラフ地震関連解説情報',
        description: '純音の下降2音 D5→A4（臨時情報の上昇と向きで区別）',
      },
      earthquakeCount: {
        label: '地震回数に関する情報',
        description: '純音の同音3連 C5（上の2つと違い音程を動かさない）',
      },
      specialInfoCancel: {
        label: '南海トラフ・後発地震の取消',
        description: '純音の降下3音 D5→A4→D4',
      },
      kyoshinUpdate: {
        label: '揺れ検知・震度更新',
        description: '警告ビープ。震度が上がるほど音数が増え間隔が詰まる。震度をタップして試聴',
      },
      countdown: {
        label: 'S 波到達カウントダウン',
        description: '残り秒数をタップして試聴（秒が減るほど速く・多く鳴る。残り 1 秒はサブ低音2本と高音を重ねる）',
      },
    },
    test: {
      note: '動作確認用です。実際のデータは変更されません。',
      note2: '緊急地震速報は押すたびに次の報が届き、10 秒押さないと最終報で終わります（どれも 2024-04-17 豊後水道 M6.6 の気象庁サンプル電文が元です）。津波と特別情報は 90 秒後に解除・取消が届きます。',
      eewForecast: {
        label: '地震動予報',
        description: '予報のまま進む報。押すと予想震度が 3 → 4 と上がる – eewForecast 音',
        button: '予報テスト',
      },
      eewStrongShaking: {
        label: '地震動予報（非常に強い揺れを検知）',
        description: '震源を決める前に、強い揺れを検知した観測点だけで出る第1報（最大震度5弱）。M・深さ・発生時刻を出さず、気象庁の本文を震源名の下に出す – eewForecast 音',
        button: '強い揺れ検知テスト',
      },
      eewAssumed: {
        label: '地震動予報（単独点処理）',
        description: '震源が決まっていない初報（気象庁が入れる固定値 M1.0 深さ10km）。押すと震源が決まり、震度5弱予想の警報へ格上げされる。格上げの伝え方は、読み上げ中に押すか読み終えてから押すかで変わる – eewForecast 音',
        button: '単独点処理テスト',
      },
      eewDeep: {
        label: '地震動予報（深発地震）',
        description: '深さ450km（小笠原諸島西方沖 M6.5）。地域別の震度予想が出ないため「深発地震のため、予想震度なし。」と読み、続報も予報級のまま – eewForecast 音',
        button: '深発地震テスト',
      },
      eewNoForecast: {
        label: '地震動予報（予想震度なしのまま取消）',
        description: '予想震度の欄そのものが無い報。3秒待っても値が付かないため「単独点処理のため、予想震度なし。」と読み、最後は取消で終わる – eewForecast 音 → eewCancel 音',
        button: '予想震度なしテスト',
      },
      eewForecastZero: {
        label: '地震動予報（予想震度0）',
        description: '最大予想震度が0の初報。値は出ているので待たずに「予想最大震度0。」と読み、押すと予想震度4へ言い直す – eewForecast 音',
        button: '予想震度0テスト',
      },
      eewWarning: {
        label: '緊急地震速報（警報）',
        description: '予報から警報へ上がる報。押すと予想震度が 5弱 → 5強 – eew 音',
        button: '警報テスト',
      },
      eew: {
        label: '緊急地震速報（特別警報）',
        description: '震度6弱まで上がり、特別警報相当になる – eewSpecial 音',
        button: '特別警報テスト',
      },
      eewRetraction: {
        label: '緊急地震速報（誤報取消）',
        description: '警報まで上がったあと、実電文の取消が届く – eewCancel 音（通知・読み上げあり）',
        button: '誤報取消テスト',
      },
      eewLateRetraction: {
        label: '緊急地震速報（自動解除の後の誤報取消）',
        description: '最終報まで流し、自動解除で画面から消えた 10 秒後に取消が届く – eewCancel 音（通知・読み上げあり）',
        button: '遅れた誤報取消テスト',
      },
      earthquake: {
        label: '地震情報',
        description: '令和6年能登半島地震・本震 M7.6 最大震度7（実データ）をリストと地図に追加',
        button: '地震テスト',
      },
      unreceivedQuake: {
        label: '地震情報（震度を入手していない地点が多い報）',
        description: '日向灘 M6.4 最大震度5強（実電文）– 震度を入手していない地点が 60。市町村・区域・県の行に「未入電あり」の印が付き、値そのものが届いていない 18 市町村は「5弱以上」と出る',
        button: '未入電テスト',
      },
      maxScaleOrAboveQuake: {
        label: '地震情報（最大震度が「5弱以上」になる報）',
        description: '石川県西方沖 M6.4 最大震度5弱（実電文）– 未入電の地点が 1。観測できた最大震度と同じ階級なので、カードの最大震度が「5弱以上」と出る（この形になるのは最大震度が5弱の地震だけ）',
        button: '5弱以上テスト',
      },
      areaUnreceivedQuake: {
        label: '地震情報（区域まるごと「5弱以上・未入電」の報）',
        description: '未入電テストの1区域を、配下の市町村がすべて未入電の形へ組み替えたもの（気象庁の資料が定める形で、実電文の標本は無い）。区域の最大震度が載らなくても一覧と読み上げに残る',
        button: '区域未入電テスト',
      },
      foreignQuake: {
        label: '遠地地震',
        description: 'メキシコ・チアパス州沿岸 M7.4 深さ不明（実データ）– earthquakeInfo 音 / 国内震度なし・日本への津波影響なし',
        button: '遠地地震テスト',
      },
      foreignQuakeHuge: {
        label: '遠地地震（規模を速報できない報）',
        description: 'チリ中部沿岸 M8を超える巨大地震 – earthquakeInfo 音 / 規模が数値で出ない第一報。日本への津波の有無は調査中',
        button: '巨大地震テスト',
      },
      foreignQuakeInternationalTsunami: {
        label: '遠地地震と国際津波関連情報（英文）',
        description: 'インドネシア付近 M7.0（実データ）の遠地地震と、同じ地震の国際津波関連情報（英文） – earthquakeInfo 音 / 3 秒後に英文が届き、遠地地震のカードに原文の欄が付く。英文が届くと earthquakeInfo 音と通知が出て、日本語で要約を読み上げる',
        button: '国際津波関連情報テスト',
      },
      internationalTsunamiDomesticAndOnly: {
        label: '国内の地震と英文だけの国際津波関連情報',
        description: '日向灘 M7.1（実データ）の震源・震度情報と、同じ地震の国際津波関連情報（英文） – earthquakeInfo 音 / 3 秒後に英文が届き、日向灘の地震カードに原文が付く / 6 秒後に、地震情報の無い地震の英文が届き、一覧に英文だけのカード（国際津波関連情報）が出る / 9 秒後に通信試験の英文が届く（「試験報を受信（検証用）」が入のときだけ音・通知・読み上げと帯が出る。切なら電文ログにだけ残る）。英文が届くと earthquakeInfo 音と通知が出て、日本語で要約を読み上げる',
        button: '英文だけテスト',
      },
      headlineOnlyCity: {
        label: '見出しにだけある市町村',
        description: '2024-01-01 佐渡付近の震源・震度に関する情報（実データ）で、輪島市が見出しにだけ載っている形 – earthquakeInfo 音 / 震度一覧の石川県能登の下に輪島市（震度3）が並ぶ。この市町村には観測点の行が無い',
        button: '見出しの市町村テスト',
      },
      noIntensityQuake: {
        label: '震度を観測しなかった地震',
        description: '2024-08-08 日向灘の震源・震度に関する情報（実データ）から震度の欄を外した形 – earthquakeInfo 音 / 最低震度の設定に関係なく「日向灘 Mj7.1（震度1以上の観測なし）」の通知が出る',
        button: '震度なしテスト',
      },
      quakeAmendment: {
        label: '訂正報',
        description: '地震情報 → 規模を訂正した報（M7.4 → M7.6）。同じカードが更新され「震源を訂正」の印が付き、気象庁の「震源要素を訂正します。」の一文も並ぶ',
        button: '訂正報テスト',
      },
      quakeReportSequence: {
        label: '種別が前後する報',
        description: '震度速報 → 震源情報 → 震度速報 → 震源・震度情報 → その続報 → 震度速報 → その続報、の7通（前半4通は2024年能登半島地震の前震と同じ順序）。見出しに受け取った種別が並び、震源・震度情報で速報段階が畳まれる。1通目は震度がまだ出そろっていない形（最大震度5弱）で、3通目で5強が出るため、ブラウザ通知を有効にしていれば「最大震度更新」の通知が出る。遅れて届く震度速報でカードが動かないこと、震度が上下した行に印が付くこともここで見られる',
        button: '種別遷移テスト',
      },
      quakeCancel: {
        label: '地震情報（取消）',
        description: '震度速報を出し、10秒後に取り消す。カードに「取消」が重なり、10秒後に一覧から消える',
        button: '取消テスト',
      },
      quakePartialCancel: {
        label: '地震情報（一部の取消）',
        description: '震度速報と震源・震度情報を出し、震源・震度情報の10秒後に震度速報だけを取り消す。カードは残り、見出しの下に「震度速報は取り消されました」と気象庁の本文が出る',
        button: '一部取消テスト',
      },
      borrowFromTsunami: {
        label: '津波が先に伝える震源',
        description: '震度速報 → 津波警報 → 震度速報の続報 → 津波の続報（2024年能登半島地震の本震と同じ順序）。震度速報は震源を持たないが、津波警報が載せている震源を借りてカードと読み上げに出し、行に「津波情報より」と出どころが付く',
        button: '震源の借用テスト',
      },
      magnitudeFromTsunami: {
        label: '津波が後から伝える規模',
        description: '震源・震度情報（M7.4）→ 津波の続報（M7.6）→ 震源・震度情報の続報（M7.6）（2024年能登半島地震の本震と同じ順序）。津波の続報が地震情報より新しい規模を伝えると、カードの規模も M7.6 になり、行に「津波情報より」と出どころが付く。次の震源・震度情報が届くと出どころの印は消える',
        button: '規模の更新テスト',
      },
      trainingQuake: {
        label: '訓練報',
        description: '中身は地震テストと同じ（地震情報と長周期地震動に関する観測情報）で、電文ヘッダの運用種別（訓練）だけが違う。本物と同じく画面・音・読み上げへ流し、カードと長周期の欄に「訓練報」の印を出す',
        button: '訓練報テスト',
      },
      tsunamiForecast: {
        label: '津波予報（若干の海面変動）',
        description: '北海道沿岸 – tsunamiForecast 音 / 90秒後に失効',
        button: '予報テスト',
      },
      tsunamiWatch: {
        label: '津波注意報',
        description: '北海道沿岸 – tsunamiWatch 音 / 90秒後に解除',
        button: '注意報テスト',
      },
      tsunamiWarning: {
        label: '津波警報',
        description: '青森・茨城等 – tsunami 音 / 90秒後に解除',
        button: '警報テスト',
      },
      tsunami: {
        label: '大津波警報',
        description: '岩手・宮城・福島等 – tsunamiMajor 音 / 90秒後に解除',
        button: '大津波警報テスト',
      },
      tsunamiExpiry: {
        label: '津波警報 → 津波予報（失効時刻つき）',
        description: '津波注意報 → 続報で17区域すべてが津波予報へ下がる → 等級は同じまま期限だけが延びる続報 → 失効時刻が来てカードが消える。予報だけになった津波に解除電文は出ないので、消えるのは失効時刻のときだけ。バナー右上の「失効」の行と、読み上げの末尾の失効時刻をここで確かめられる',
        button: '失効時刻テスト',
      },
      tsunamiGradeChange: {
        label: '津波警報・注意報（区域ごとに等級が動く続報）',
        description: '津波警報 → 石川県能登が大津波警報へ上がり、やがて警報へ戻る続報（間に満潮時刻の報を挟む）。全体の等級が動かない報では、区域ごとの「〇〇から引き上げ」「〇〇から切り替え」の印でしか変化が分からない',
        button: '区域の等級変化テスト',
      },
      tsunamiSourceAdded: {
        label: '津波注意報（原因の地震が加わる）',
        description: '津波注意報 → 原因の地震 → 2つ目の地震 → 2つの地震を原因とする続報。カードは別の津波に入れ替わらず、バナーに2つの地震が並ぶ（気象庁は同じ津波の続報として地震の番号を書き足す）',
        button: '原因地震の追加テスト',
      },
      tsunamiQuietReports: {
        label: '津波警報・注意報（変化の小さい続報）',
        description: '大津波警報（2011年東北地方太平洋沖地震のサンプル電文）→ 10秒おきに続報を16通。等級も波高の数値も動かない報が、通知音だけ鳴って何も声にならないことを確かめる。1通ずつ釜石・大船渡・沖合の値が動き、値を持たない観測点に印だけが付く報もある、釜石が欠測へ転じ、欠測のまま最大波の観測時刻だけが進む報もある',
        button: '変化の小さい続報テスト',
      },
      tsunamiRetraction: {
        label: '津波注意報（取消）',
        description: '鹿児島県西部・種子島屋久島ほか – tsunamiWatch 音 / 90秒後に誤報として取消',
        button: '誤報取消テスト',
      },
      tsunamiInfoRetraction: {
        label: '津波情報の取消（注意報は続く）',
        description: '津波注意報 → 各地の満潮時刻・到達予想の情報 → その情報だけを取り消す。消えるのはその情報が運んだ観測点だけで、注意報の区域は残る。読み上げは取り消された事実だけを伝え、音は鳴らない',
        button: '津波情報の取消テスト',
      },
      nankaiChecking: {
        label: '南海トラフ地震臨時情報（調査中）',
        description: 'バナー表示 + specialInfo 音（バナー消去ボタンなし・再テストで上書き）',
        button: '調査中テスト',
      },
      nankaiWatch: {
        label: '南海トラフ地震臨時情報（巨大地震注意）',
        description: 'バナー表示 + specialInfo 音',
        button: '注意テスト',
      },
      nankaiWarning: {
        label: '南海トラフ地震臨時情報（巨大地震警戒）',
        description: 'バナー表示 + specialInfo 音',
        button: '警戒テスト',
      },
      nankaiRetraction: {
        label: '南海トラフ地震臨時情報（取消）',
        description: '調査中を発表し、同じ識別情報の取消を流す。バナーが「取消」の表示に替わって 10 秒で消え、取消の音が鳴り、読み上げは取り消された事実と理由を伝える（発生可能性については何も述べない）',
        button: '取消テスト',
      },
      nankaiCommentaryAdHoc: {
        label: '南海トラフ地震関連解説情報（臨時解説）',
        description: 'バナー表示 + specialInfoCommentary 音（閉じるボタンあり・7日で自動消去）',
        button: '臨時解説テスト',
      },
      nankaiCommentaryRetraction: {
        label: '南海トラフ地震関連解説情報（取消）',
        description: '臨時解説を発表し、同じ号の取消を流す。バナーが「取消」の表示に替わって 10 秒で消え、取消の音が鳴り、読み上げは取り消された事実と理由を伝える',
        button: '解説情報 取消テスト',
      },
      nankaiCommentaryRoutine: {
        label: '南海トラフ地震関連解説情報（定例解説）',
        description: '平常時に毎月届く電文。バナー表示 + specialInfoCommentary 音（閉じるボタンあり・7日で自動消去）',
        button: '定例解説テスト',
      },
      activityInfo: {
        label: '地震の活動状況等に関する情報',
        description: '電文ログに「スキップ」の行が 1 行出るだけ。カード・帯・音は出ない（この種類は読まず、電文ログに本文ごと積む）',
        button: '活動状況等テスト',
      },
      kohatsu: {
        label: '北海道・三陸沖後発地震注意情報',
        description: 'バナー表示 + specialInfo 音',
        button: '後発地震テスト',
      },
      kohatsuRetraction: {
        label: '北海道・三陸沖後発地震注意情報（取消）',
        description: '後発地震注意情報を発表し、同じ識別情報の取消を流す。バナーが「取消」の表示に替わって 10 秒で消え、取消の音が鳴り、読み上げは取り消された事実と理由を伝える',
        button: '取消テスト',
      },
      estimatedIntensity: {
        label: '推計震度分布図',
        description: '気象庁が推計した震度の広がり。地図とカードのボタンが公式の表示へ替わる。初報 → 続報 → 地震情報の続報と流れ、読み上げが「受信しました」から「更新されました」へ変わり、最後に地図が発表値へ戻る（実際の発表は地震から数分後）',
        button: '推計震度分布図テスト',
      },
      lpgmRetraction: {
        label: '長周期地震動に関する観測情報（取消）',
        description: '地震テストの長周期地震動 → その取消。取消は音を鳴らさず、取り消されたことと理由の文を読み上げる（長周期の表示は消える）',
        button: '長周期 取消テスト',
      },
      lpgmClassZero: {
        label: '長周期地震動に関する観測情報（階級0）',
        description: '階級1以上を観測しなかった長周期地震動の観測情報を流します。階級1以上の報と同じく、音・読み上げ・通知があります',
        button: '長周期地震動（階級0）テスト',
      },
      lpgmCategories: {
        label: '長周期地震動に関する観測情報（種類1・3）',
        description: '観測情報の種類1・3の実電文（2024年1月1日 石川県能登地方・2024年8月8日 日向灘）を流します。長周期地震動の欄の下に、階級を観測した地域がいずれも震度5弱以上だったことを伝える一文が出ます',
        button: '長周期地震動（種類1・3）テスト',
      },
      lpgmClassZeroRegion: {
        label: '長周期地震動に関する観測情報（階級0の地域を含む）',
        description: '階級1以上の地域に階級0の地域が混ざった長周期地震動の観測情報を流します。階級0の地域も、他の階級と同じ設定で読み上げます。3秒後に規模を書き換えた続報が届き、長周期地震動の欄の値に更新の印が付きます',
        button: '長周期地震動（階級0の地域）テスト',
      },
      earthquakeCount: {
        label: '地震回数に関する情報（バナー）',
        description: '群発時の回数経過（21時間で有感1回）をバナー表示 + earthquakeCount 音・短い読み上げ。有感以外は「発表なし」で届くので、表には「—」が並ぶ（閉じるボタンあり・7日で自動消去）',
        button: '地震回数テスト',
      },
      earthquakeCountRetraction: {
        label: '地震回数に関する情報（取消）',
        description: '発表 → その取消。バナーが「取消」の表示（理由の文つき）に替わって 10 秒で消え、読み上げも理由を伝える（実電文どおり回数の表は持たない）',
        button: '地震回数 取消テスト',
      },
      quakeNotice: {
        label: '地震・津波に関するお知らせ',
        description: '観測点の入電停止などの運用連絡。バナー表示（音と読み上げは「お知らせの音・読み上げ」が有効なときだけ・閉じるボタンあり・7日で自動消去）',
        button: 'お知らせテスト',
      },
    },
    replay: {
      note: '指定した日時の地震情報・津波・緊急地震速報を再生します（2020年11月18日以降。緊急地震速報だけは2022年7月20日以降）。 リアルタイム震度は直近の期間と、下記の地震でのみ再生できます。',
      archives: {
        label: '収録済みの地震',
        description: 'ここから再生すると地震情報・津波は再現されますが、リアルタイム震度は含まれません。必要な場合は下記の「K-NETデータの取り込み」から読み込んでください。',
        /**
         * 収録済みの地震の名前（鍵は目録 `public/data/historical-archives/index.json` の `id`）。表に無い地震は目録の `label` のまま出す
         * （→ `utils/historicalArchiveLabel.ts`）
         */
        names: {
          '2016-kumamoto': '2016年熊本地震',
          '2016-tottori': '2016年鳥取県中部地震',
          '2018-osaka': '2018年大阪府北部地震',
          '2018-iburi': '2018年北海道胆振東部地震',
        } as Record<string, string>,
      },
      play: '再生',
      start: {
        label: '開始時刻',
        description: '確定すると指定時刻から1秒ずつ進みます',
      },
      preparing: '準備中…',
      confirm: '確定',
      warning: '再生中の警告',
      failed: '取得失敗',
      playing: {
        label: '再生中',
      },
      since: (at: string) => `${at} から`,
      reset: 'リセット',
    },
    knet: {
      importing: '取り込み中…',
      chooseZip: 'ZIPを選択',
      archiveCount: (label: string, n: number) => `${label}: ${n}件`,
      storageError: '読み込んだデータの一部を読み出せていません。一覧に出ていない地震があるかもしれません',
      excluded: (fileName: string, n: number) => `${fileName}：読めない、または震度を計算できない観測点 ${n} 点を除いて取り込みました`,
      row: {
        label: '地震波形データを読み込む',
        description: '防災科研（NIED）のサイトからダウンロードしたK-NET/KiK-netの地震波形ファイル（ZIP）を選ぶと、その地震の揺れを「リアルタイム震度」タブで再生できるようになります。複数のファイルをまとめて選ぶと、1つの地震としてまとめて読み込まれます。データはこの端末だけに保存され、外部には送信されません。',
        hint: '上の地震一覧にある地震のみ読み込めます',
      },
      noArchive: (at: string) => `この地震（${at}）に対応するデータが見つかりません`,
      saveFailed: '保存に失敗しました（この端末では保存機能が使えない可能性があります）',
      deleteFailed: '削除に失敗しました（この端末では保存機能が使えない可能性があります）',
    },
    diag: {
      noStorage: 'この端末では記録を保存できません。プライベートモードでは保存できないことがあります',
      nothingToExport: '書き出せる記録がありません',
      downloadCount: (n: number) => `${n}件`,
      clearFailed: '消去に失敗しました',
      count: (n: number) => `${n} 件`,
      row: {
        label: '揺れ検知の記録',
        description: '揺れ検知が走ったとき、その前後 30 秒の観測値・検知の内訳・学習状態を端末内に残します。地震でないのに検知した場合、この記録があれば原因を追えます。書き出すまで端末の外へは出ません。',
      },
    },
  },
  /**
   * どのタブからでも見える速報・津波の帯（`components/AlertDock`・`utils/alertDock.ts`。段 9b）。
   * 区分名・訓練の札・震度と長周期の札・高さの語は、リアルタイムタブ・津波タブ・共有の書式の語を使う。県名・区域名・観測点名は電文のまま
   */
  alertDock: {
    /** 右上の更新時刻（押すとそのタブへ移る印「›」を添える） */
    updated: (time: string) => `更新 ${time} ›`,
    maxWave: '最大波',
    firstWave: '第1波到達',
    moreAreas: (n: number) => `ほか ${n} 区域`,
    homePoint: '登録地点',
    forecastHeight: '予想の高さ',
    estimatedArrival: '到達予想',
    /**
     * 「ただちに津波来襲と予測」の区域の到達。`labelled` は名目（`estimatedArrival`）を添えるか。日本語は名目「到達予想」に
     * 電文の文を添える（津波タブの区域の行と同じ）。ほかの言語は名目を付けず、津波タブの札と同じ語を出す。
     * `as boolean` は型を `true` に狭めないため（ほかの言語が `false` を入れる）
     */
    immediateArrival: { labelled: true as boolean, text: 'ただちに津波来襲と予測' },
    hypocenter: '震源',
    /** 警報の都道府県の残りの数 */
    more: (n: number) => `ほか ${n}`,
    forecast: '予想',
    mainShaking: '主要動',
    seconds: (sec: number) => `${sec}秒`,
  },
  /**
   * 画面の下端の特別情報の帯（`components/SpecialInfoBanner`。南海トラフ臨時情報・後発地震注意情報・解説情報・お知らせ・地震回数・
   * 国際津波関連情報と取消の表示。段 9b）。電文の見出し・本文・号数・地震回数の表の区間の語は電文のまま。日時は数字の形なのでどの言語もそのまま
   */
  specialInfo: {
    issued: (time: string) => `発表: ${time}`,
    nextAdvisory: '次の情報',
    appendix: (open: boolean) => `この種類の情報について${open ? '（閉じる）' : '（開く）'}`,
    more: (n: number) => `ほか ${n} 件`,
    noticeBadge: 'お知らせ',
    countBadge: '地震回数',
    /** 南海トラフ地震関連解説情報の札（電文の `InfoSerial/Name`）。表に無い語は電文のまま出す */
    commentarySerial: { 臨時解説: '臨時解説', 定例解説: '定例解説' } as Record<string, string>,
    /** 南海トラフ地震臨時情報の札（電文の `InfoSerial/Name`）。表に無い語は電文のまま出す */
    nankaiKind: { 巨大地震警戒: '巨大地震警戒', 巨大地震注意: '巨大地震注意', 調査中: '調査中', 調査終了: '調査終了' } as Record<string, string>,
    internationalTsunami: '国際津波関連情報',
    internationalTsunamiTest: '国際津波関連情報 通信試験',
    /** 帯の右端の ×（積まれている全件を閉じる）の読み上げ名 */
    closeAll: {
      nankai: '臨時情報を閉じる',
      kohatsu: '後発地震注意情報を閉じる',
      nankaiCommentary: '解説情報を閉じる',
      quakeNotice: 'お知らせを閉じる',
      earthquakeCount: '地震回数を閉じる',
      internationalTsunami: '国際津波関連情報を閉じる',
    },
    /** 開いた一覧の行の ×（1 件だけ閉じる）の読み上げ名 */
    closeOne: {
      kohatsu: 'この後発地震注意情報を閉じる',
      nankaiCommentary: 'この解説情報を閉じる',
      quakeNotice: 'このお知らせを閉じる',
      earthquakeCount: 'この地震回数の情報を閉じる',
      internationalTsunami: 'この国際津波関連情報を閉じる',
    },
    /** 取消の表示。`name` は報の名前（電文ログの題名の語） */
    cancelTitle: (name: string) => `${name} 取消`,
    cancelText: (name: string) => `${name}は取り消されました`,
    cancelClose: (name: string) => `${name}の取消の表示を閉じる`,
    /**
     * 地震回数の帯の見出し（`utils/earthquakeCountSummary.ts`）。`since` は区間の初め（日本時間の「月/日」と時）、
     * `count`・`felt` は桁を区切った回数（発表なしは null）。両方 null では呼ばない
     */
    countHeadline: (since: { monthDay: string; hour: string } | null, count: string | null, felt: string | null) => {
      const s = since ? `${since.monthDay} ${since.hour}時から ` : ''
      if (count === null) return `${s}有感 ${felt}回`
      if (felt === null) return `${s}${count}回`
      return `${s}${count}回（うち有感 ${felt}回）`
    },
    countHeadlineNone: '地震回数に関する情報',
    countTable: { interval: '区間', period: '期間', count: '回数', felt: 'うち有感' },
    countPeriodUnknown: '期間不明',
    countFeltNote: '「うち有感」は震度1以上を観測した地震の数',
  },
  /** 地震の直後に地図の上に出す行動チェックリスト（`components/ActionChecklist`。段 9b） */
  actionChecklist: {
    /** 見出し。速報だけ、登録地点の周りで判定したとき（`scoped`）と全国で判定したとき（`global`）で言い分ける */
    headline: {
      eew: { scoped: '強い揺れが来ます', global: '強い揺れが予想されています' },
      kyoshin: { scoped: '強い揺れを観測しています', global: '強い揺れを観測しています' },
      quake: { scoped: '強い揺れがありました', global: '強い揺れがありました' },
    },
    /** 見出しの下の 1 行の、どの経路の値か */
    source: { eew: '緊急地震速報', kyoshin: 'リアルタイム震度', quake: '地震情報' },
    /** 見出しの下の 1 行の、どの範囲の値か。`s` は経路の名前、`km` は登録地点の周りの半径 */
    basis: {
      nationwide: (s: string) => `${s}・全国の最大`,
      eewNearDetected: (s: string, km: number) => `${s}・登録地点から ${km}km 以内で検知`,
      eewArea: (s: string) => `${s}・登録地点の地域の予想`,
      kyoshinNear: (s: string, km: number) => `${s}・登録地点から ${km}km 以内`,
      nearArea: (s: string) => `${s}・登録地点の地域`,
      nearStations: (s: string, km: number) => `${s}・登録地点から ${km}km 以内の観測点`,
    },
    /** 震度の札（「震度5弱」）。リアルタイム震度は上に小さく `realtimePrefix` を乗せる */
    scale: (label: string) => `震度${label}`,
    realtimePrefix: 'リアルタイム',
    /** 札を 1 行で言う形（ボタンの読み上げ名） */
    realtimeScale: (label: string) => `リアルタイム震度${label}`,
    openLabel: (scale: string) => `${scale}の行動チェックリストを開く`,
    button: '行動チェック',
    close: 'チェックリストを閉じる',
    collapse: '閉じる',
    showAll: (n: number) => `続きを見る（全 ${n} 項目）`,
    /** 揺れた直後の行動（並び順のまま番号を振る。畳んだ状態は先頭の 3 つ） */
    actions: [
      { text: '身の安全を確保する', detail: '丈夫な机の下など、物が落ちてこない・倒れてこない・移動してこない場所へ' },
      { text: '火の元を確認する', detail: 'ガスの元栓を閉め、ストーブを切る。地震後の火災はガス機器・暖房器具が原因になりやすい' },
      { text: '靴を履く', detail: '床にガラスの破片が散っている。室内でも裸足で歩かない' },
      { text: '出口を確保する', detail: 'ドアや窓を開ける。建物がゆがむと閉じ込められる' },
      { text: '余震に備える', detail: '大きな地震のあとは続けて揺れることがある。倒れやすい物から離れる' },
      { text: 'エレベーターを使わない', detail: '停止して閉じ込められる。乗っている場合は全階のボタンを押して最初に止まった階で降りる' },
      { text: '避難するならブレーカーを落とす', detail: '電気が復旧したときの通電火災を防ぐ。ガスの元栓も閉める' },
    ],
    kitHeading: '避難するとき持ち出すもの',
    kitNote: '両手が空くリュックにまとめ、軽くコンパクトに。持病の薬・杖・乳幼児用品など、必要なものは各自で足してください。',
    /** 持ち出すもの（消防庁「非常用持出品チェックシート」の分類） */
    kit: [
      { label: '避難用具', items: ['懐中電灯', '携帯ラジオ', '予備の乾電池', 'ヘルメット・防災ずきん'] },
      { label: '貴重品', items: ['現金（公衆電話用の10円玉も）', '預金通帳', '印鑑', '保険証・免許証'] },
      { label: '生命維持', items: ['飲料水（1人 500ml×2〜3本）', '常備薬', '救急用品'] },
      { label: '生活用品', items: ['携帯電話の充電器', 'マスク', 'タオル', 'ウェットティッシュ'] },
    ],
    kitItemSeparator: '・',
    sourcesLabel: '出典:',
    /** 出典の名前。並びは `utils/actionChecklist.ts` の `CHECKLIST_SOURCE_URLS` と同じ */
    sources: ['東京消防庁「地震 その時10のポイント」', '消防庁「非常用持出品チェックシート」'],
    sourceSeparator: '／',
    followOfficial: '。実際の避難は気象庁・自治体の指示に従ってください。',
  },
  /**
   * 共有カードの画像に焼く文と、共有先へ渡す本文（`utils/shareCardContent.ts`・`utils/shareCard.ts`。段 9b）。
   * 震度・長周期の札・時刻の名前・規模の条件は共有の書式の語を使う
   */
  shareImage: {
    quakeTitle: '地震情報',
    tsunamiTitle: '津波情報',
    realtimeTitle: 'リアルタイム震度',
    maxIntensity: (label: string) => `最大震度 ${label}`,
    detected: '揺れ検知',
    possible: '揺れの可能性',
    maxRealtime: (label: string) => `最大リアルタイム震度 ${label}`,
    /** 規模の条件も数値も無いときの規模 */
    magnitudeUnknown: 'M不明',
    depth: (text: string) => `深さ ${text}`,
    depthUnknown: '深さ 不明',
    areas: (n: number) => `${n} 区域`,
    issued: (time: string) => `${time} 発表`,
    serial: (n: string) => `第${n}報`,
    unknownHypocenter: '震源調査中',
    maxForecast: (label: string) => `予想最大震度 ${label}`,
    lpgmForecast: (label: string) => `予想長周期地震動 ${label}`,
    /** 見出しの項目を並べる（読点より軽く見せる全角の空きで区切る） */
    joinParts: (parts: readonly string[]) => parts.join('　'),
    /** 名前と値の組（「地震発現時刻 2026/11/11 12:00」） */
    labeled: (label: string, value: string) => `${label} ${value}`,
    /** 見出しの 1 項目に時刻を添える（同じ文の別の地震を見分けるとき） */
    withTime: (text: string, time: string) => `${text}（${time}）`,
    /** 警報（特別警報を含む）の見出し */
    eewTitle: '緊急地震速報',
    /** 出典の行。`asIs` は配信をそのまま描くもの、`derived` は加工して描くもの */
    attribution: (asIs: readonly string[], derived: readonly string[]) => {
      const segments: string[] = []
      if (asIs.length > 0) segments.push(asIs.join('、'))
      if (derived.length > 0) segments.push(`${derived.join('、')} を加工して作成`)
      return `出典: ${segments.join('／')}`
    },
    /** 出典の名前（`utils/shareCard.ts` の `AttributionSourceId`。どれを挙げるかの決まりはそちら） */
    sourceNames: {
      jma: '気象庁',
      /**
       * 海底地形。**配信元のサービスが求める帰属表示をそのまま採る**——ArcGIS Online のサービスメタデータ（`?f=json` の
       * `copyrightText`）は「General Bathymetric Chart of the Oceans (GEBCO); NOAA National Centers for Environmental
       * Information (NCEI)」と定めており、GEBCO だけでは足りない
       */
      bathymetry: 'GEBCO・NOAA NCEI（Esri のタイルサービス経由）',
      activeFaults: '産総研 活断層データベース',
      plateBoundaries: 'PB2002 (Bird, 2003)',
      earthScope: 'EarthScope',
    },
    /**
     * 緊急地震速報を含むカードに足す注意文。気象庁・DM-D.S.S が利用者へ示すべきとしている注意事項を、画像 1 枚に収まる長さで
     * まとめたもの。**「震源に近い場所では間に合わないことがある」を落とさないこと**——精度の話だけを残すと、速報が届く前に
     * 揺れが来る場合があるという、行動に直結する留保が伝わらない
     */
    eewNotice:
      '緊急地震速報は地震発生直後の推定情報です。誤報や震源・規模・予想震度の誤差を伴うことがあり、震源に近い場所では強い揺れに間に合わないことがあります。',
    incomplete: '一部の地図データは読み込み中に撮影されました',
  },
  /**
   * 再生の帯の文（`hooks/useReplayController.ts`）。`from` は書式を済ませた日時、`reason` は失敗の中身の文。
   * 記録とログに残す文は日本語のまま組む
   */
  replayBanner: {
    unreadable: '再生する日時として読み取れません',
    tooEarly: (year: number) => `${year} 年より前は再生できません（どの取得元にもデータがありません）`,
    future: '未来の時刻は再生できません',
    mainFailed: (from: string, reason: string) => `本編（${from} 以降）の取得に失敗: ${reason}`,
    initialFailed: (reason: string) => `初期状態（過去 24 時間）の取得に失敗: ${reason}`,
    historyFailed: (reason: string) => `地震カードの履歴を復元できませんでした（再生開始より前の地震が一覧に出ません。再生は継続中）: ${reason}`,
    archiveFailed: (reason: string) => `${reason}（地震・津波の電文は再生されません。リアルタイム震度の再生は継続します）`,
    prefetchLost: (from: string, reason: string) => `先読みに失敗しました。${from} からの 1 時間ぶんは再生されません: ${reason}`,
    prefetchRetrying: (from: string, reason: string) => `先読みに失敗しました。${from} からの 1 時間ぶんを取り直しています: ${reason}`,
    /** 取りこぼしの内訳の、読めなかった先読みの区間 */
    prefetchBlocks: (n: number) => `先読み${n}区間`,
    /** 取りこぼしの 1 行。`parts` は内訳の語（`quake.list.lossSources` など） */
    lossNotice: (parts: readonly string[]) => `${parts.join('・')}を取り込めず（再生は継続中・詳細はコンソール）`,
  },
  /** 地図の下端の波形グラフ（`components/SeismoWaveChart`）と、同じ語を使う地震カードの波形・波形の詳細の窓 */
  waveChart: {
    /** 波形が届かなくなっているとき（接続は生きていて震度は届いている。「接続断」とは書かない） */
    stale: '波形 途絶',
    /** 公開観測点の接続が続けて断られているとき（接続数の上限とみなす） */
    publicRefused: '公開観測点 接続数の上限',
    composite: '合成',
    /** 合成が止まってセンサー単独を描いている間の、段の名前と見出しの印 */
    sensorLane: '単独',
    compositeStopped: '合成 途絶',
    /** 3 成分の名前。並びはホストの `gal` の並び（東・北・上） */
    axes: ['東西', '南北', '上下'] as readonly [string, string, string],
    /** 波形を抱えている間に起きたことの数え上げ（0 でないものだけを並べる） */
    tallyGaps: (n: number) => `欠測 ${n}`,
    tallyRestarts: (n: number) => `引き直し ${n}`,
    tallyDuplicates: (n: number) => `重複 ${n}`,
    tallySeparator: ' / ',
    collapse: '波形を畳む',
    expand: '波形を展開',
    /** 縦を圧縮して描いた段の、縦の範囲に添えるホバーの一言（地図の下端と地震カード） */
    compressedNote: '縦は対数に近い目盛りで描いています。',
  },
  /** 「この報で動いた」の印の意味（ホバーと読み上げソフト向けの名前。`components/UpdateDot.tsx`） */
  updateMark: {
    new: '最新の情報で初めて出た値です',
    raised: '最新の情報で上がりました',
    lowered: '最新の情報で下がりました',
    changed: '最新の情報で変わりました',
  } satisfies Record<UpdateStatus, string>,
  /**
   * 画面に届くエラーの文（再生の帯・地震タブの履歴の帯・K-NET の取り込みの失敗。→ `utils/localizedError.ts`）。
   * エラーの `message` もこの日本語の文で組むので、ログと記録には日本語が残る。ほかの言語の、普段は出ない実装の誤りの文には
   * 頭に「Internal error:」の類を付ける。ファイル名・値・URL・K-NET のファイルの欄の名前（`Scale Factor` など）はそのまま
   */
  errorText: {
    /** 通信そのものの失敗（ブラウザの英語の文は出さない。2026-11-03 ユーザー選択「通信の失敗だけ日本語に (Recommended)」） */
    networkFailure: () => '通信できませんでした',
    /** エラーでない値で失敗したとき */
    fetchFailed: () => '取得失敗',
    fetchTimeout: (seconds: number, url: string) => `取得が ${seconds} 秒以内に終わりませんでした: ${url}`,
    apiKeyInvalid: () => 'APIキーに使用できない文字が含まれています。半角の英数字・記号のみで入力してください。',
    apiKeyMissing: () => 'APIキーが未設定です。DM-D.S.S の APIキーを設定してください。',
    relayTokenHttp: (status: number) => `中継の札を受け取れませんでした（HTTP ${status}）`,
    relayTokenUnreadable: () => '中継の札の応答を読めませんでした',
    relayTokenMalformed: () => '中継の札の応答の形が想定と違います',
    relayTokenShort: () => '中継の札の期限が短すぎます',
    relayTokenNotReady: () => '中継の札を用意する前に見出しを作ろうとしました',
    archiveListHttp: (status: number) => `アーカイブの一覧を取得できなかった: ${status}`,
    archiveListNotOk: () => 'アーカイブの一覧が成功（ok）を返さなかった',
    archiveListCutOff: (maxPages: number, start: string, end: string, count: number) =>
      `アーカイブの一覧が途中で切れた: ページ上限（${maxPages}）に達した 範囲=${start}~${end} 件数=${count}`,
    archiveAllFailed: (sources: number) => `アーカイブを取得できなかった: 取得元${sources}件すべてを読み取れませんでした`,
    sameDayRangeTooLong: (days: number, max: number, from: string, to: string) =>
      `当日経路の対象期間が広すぎます（${days} 日 / 上限 ${max} 日）: ${from}〜${to}`,
    /** ローカル履歴アーカイブ。`name` は収録済みの地震の名前（`utils/historicalArchiveLabel.ts`） */
    localArchiveNoDay: (name: string) => `ローカル履歴アーカイブ「${name}」は、この日の電文を収録していません`,
    localArchiveEnded: (name: string) => `ローカル履歴アーカイブ「${name}」の収録範囲の終端に達しました。これ以降は再生できません`,
    /** K-NET の取り込み（`utils/knet`）。`file` はファイル名、`origin` は発生時刻（日本時間の数字の形） */
    knetComponentFromName: (file: string) => `ファイル名から成分(NS/EW/UD)を判定できません: "${file}"`,
    knetScaleFactorFormat: (file: string, value: string) => `${file} ヘッダー: Scale Factor の形式が不明です "${value}"`,
    knetScaleFactorDenominator: (file: string, value: string) => `${file} ヘッダー: Scale Factor の分母が不正です "${value}"`,
    knetSamplingFreq: (file: string, value: string) => `${file} ヘッダー: Sampling Freq を解釈できません "${value}"`,
    knetDateFormat: (file: string, value: string) => `${file} ヘッダー: 日時の形式が不明です "${value}"`,
    knetTooShort: (file: string, headerLines: number) => `${file}: ヘッダー行数(${headerLines}行)に満たないデータです`,
    knetNoMemo: (file: string, line: number) =>
      `${file}: ${line}行目が"Memo."で始まっていません（ヘッダー行数の前提が実ファイルと食い違っている可能性があります）`,
    /** `field` はファイルの欄の名前（`Station Code` など） */
    knetFieldMissing: (file: string, field: string) => `${file}: ${field} が見つかりません`,
    knetNonNumericToken: (file: string, token: string, line: number) => `${file}: データ行に数値でないトークンがあります ("${token}", 行${line})`,
    knetNoData: (file: string) => `${file}: データが0件です`,
    knetStepSec: () => 'stepSec は正の整数（秒）で指定してください',
    /** 読めたファイルが 1 つも無い。`items` はファイルごとの失敗の文（先頭 20 件）、`more` はそれより多いか */
    knetNoReadableStation: (count: number, items: readonly string[], more: boolean) =>
      `${count}件のファイルでパースに失敗し、読めた観測点がありません: ${items.join(' / ')}${more ? ' ...' : ''}`,
    /** ファイルごとの失敗（`reason` はそのファイルの失敗の文） */
    knetFileFailure: (file: string, reason: string) => `${file}: ${reason}`,
    knetNoWaveFiles: () => 'ZIP内にNS/EW/UD波形ファイルが1件も見つかりませんでした',
    knetMixedOrigin: (kinds: number) =>
      `ZIP内に異なる地震のOrigin Timeが混在しています（${kinds}種類）。複数の地震のファイルを1つのZIPにまとめていないか確認してください`,
    knetNoCompleteStation: (origin: string) => `origin=${origin}: 3成分が揃った観測点が0件です`,
    knetIncompleteRatio: (origin: string, percent: number) =>
      `origin=${origin}: 3成分が揃わない観測点が${percent}%に達しました（成分・深度の判定ロジックに誤りがある可能性があります）`,
    /** 外した観測点が多すぎる。`examples` は外した観測点と理由（先頭 5 件。`knetExcludedItem`） */
    knetTooManyExcluded: (origin: string, percent: number, incomplete: number, unreadable: number, uncomputable: number, examples: readonly string[]) =>
      `origin=${origin}: 外した観測点が${percent}%に達しました（3成分が揃わない ${incomplete}点・読めない ${unreadable}点・震度を計算できない ${uncomputable}点）。例: ${examples.join(' / ')}`,
    knetExcludedItem: (station: string, reason: string) => `${station} ${reason}`,
    knetExcludedUnreadable: (reason: string) => `読めない（${reason}）`,
    knetExcludedUncomputable: (reason: string) => `震度を計算できない（${reason}）`,
    knetUncomputableReason: (hz: number, reason: string) => `毎秒 ${hz} 回: ${reason}`,
    knetNoIntensity: (origin: string) =>
      `origin=${origin}: 有効な計測震度を1件も算出できませんでした（全ウィンドウがデータ不足でnullでした）。サンプリング周波数・スケールファクタ等、算出パイプラインの誤りを疑ってください`,
    knetSampleRate: () => 'sampleRateHz は正の数で指定すること',
    knetFilterDiverges: (hz: number, stage: number) => `毎秒 ${hz} 回では近似フィルタの ${stage} 段目が発散する（サンプリング周波数が低すぎる）`,
    knetDurationUnjudgeable: (seconds: number, hz: number) => `${seconds} 秒の判定ができない（毎秒 ${hz} 回）`,
    knetNonFiniteSample: (position: number) => `有限でないサンプルが混じっている: 位置 ${position}`,
    knetStepSecPositive: () => 'stepSec は正の数で指定すること',
    fftLengthMismatch: (n: number, m: number) => `実部と虚部の長さが違う: ${n}/${m}`,
    fftNotPowerOfTwo: (n: number) => `長さが 2 の冪でない: ${n}`,
  },
  /**
   * ブラウザ通知の文と、ウィンドウの題名（段 10）。震度・規模・長周期の札は共有の書式の語、情報名は電文ログの題名の語、
   * 津波の等級・高さは津波の節の語を使う。電文の値（震源名・区域名・観測点名・気象庁の文）は辞書を通さない。
   * 中継のプッシュ通知は日本語の辞書（`JA_MESSAGES`）を渡して同じ文を組む。
   * **ウィンドウの題名は外の道具が字面を見るので、日本語の文を変えない**
   */
  alertText: {
    /** 文の項目を並べる（緊急地震速報の通知の本文・ウィンドウの題名・長周期の通知の本文） */
    joinParts: (parts: readonly string[]) => parts.join(' '),
    quakeTitle: '地震情報',
    quakeCancelTitle: '地震情報 取消',
    /** 最大震度を観測した区域が複数あるときの区域の語 */
    areaAndOthers: (name: string) => `${name}ほか`,
    /** 震度速報（震源がまだ判らない報）。`area` は最大震度を観測した区域（読めなければ null） */
    scalePrompt: (area: string | null, scale: string) =>
      area === null ? `震度速報 最大震度${scale}` : `震度速報 ${area} 最大震度${scale}`,
    /** 震源が判った報 */
    hypocenter: (name: string, scale: string, magnitude: string) => `${name} 最大震度${scale} ${magnitude}`,
    /** 最大震度が上がった報。`body` は震源が判った報の文 */
    maxScaleRaised: (body: string) => `最大震度更新 ${body}`,
    /** 最大震度を持たない国内の地震。`noneObserved` は電文が震度1以上を観測しなかったと言っているか（震源・震度情報） */
    noIntensity: (name: string, magnitude: string, noneObserved: boolean) => {
      const base = name ? `${name} ${magnitude}` : magnitude
      return noneObserved ? `${base}（震度1以上の観測なし）` : base
    },
    /** 遠地地震（通知の本文とウィンドウの題名）。名前が無ければ省く */
    foreignQuake: (name: string, magnitude: string) => (name ? `遠地地震 ${name} ${magnitude}` : `遠地地震 ${magnitude}`),
    /** 取り消された通知の文 */
    quakeCancelled: (body: string) => `${body} は取り消されました`,
    /** 緊急地震速報の通知の見出し。予報級は区分の名前（`eewKind.forecast`）を使う */
    eewWarningTitle: '緊急地震速報 警報',
    eewSpecialWarningTitle: '緊急地震速報 特別警報',
    eewFinal: (title: string) => `${title}（最終報）`,
    eewCancelTitle: '緊急地震速報 取消',
    /** 誤報取消の本文。震央地名を引けなければ名前抜き */
    eewCancelled: (name: string | undefined) => (name ? `${name} の緊急地震速報は取り消されました` : '緊急地震速報は取り消されました'),
    /** ウィンドウの題名・通知の見出しの区分の名前（警報級・予報級） */
    eewKind: { warning: '緊急地震速報', forecast: '地震動予報' },
    maxScaleForecast: (scale: string) => `最大震度${scale}予想`,
    lpgmForecast: (cls: string) => `長周期地震動${cls}予想`,
    /** 発表中の緊急地震速報がほかにもある数 */
    eewMore: (n: number) => `他${n}件`,
    kyoshinDetected: '揺れを検知中',
    kyoshinOtherPlace: '別の地点で揺れを検知',
    kyoshinReonset: '同じ場所で再び揺れを検知',
    kyoshinMax: (label: string) => `最大リアルタイム震度 ${label}`,
    /** 区域名・観測点名を並べる区切り */
    nameSeparator: '、',
    tsunamiLifted: (areas: string) => `解除：${areas}`,
    tsunamiMoreAreas: (names: string, n: number) => `${names} ほか ${n} 区域`,
    tsunamiMorePoints: (names: string, n: number) => `${names} ほか ${n} 地点`,
    tsunamiLiftTitle: '津波警報等の解除',
    tsunamiAllLifted: '津波警報等は全て解除されました。',
    /** 観測情報の通知の見出し（電文が情報名を持たないとき） */
    tsunamiObservationTitle: '津波観測に関する情報',
    tsunamiInfoRetractTitle: '津波情報の取消',
    /** 取り消された報の名前（電文が情報名を持たないとき） */
    tsunamiInfo: '津波情報',
    tsunamiInfoRetracted: (name: string) => `${name}は取り消されました。`,
    tsunamiRetractTitle: '津波警報等の取消',
    tsunamiRetracted: '津波警報等は誤って発表されたため取り消されました。',
    tsunamiExpireTitle: '津波予報の失効',
    tsunamiExpired: '津波予報は失効しました。',
    /** 南海トラフ地震臨時情報の段階を添えた見出し（通知とウィンドウの題名） */
    withStage: (name: string, stage: string) => `${name}（${stage}）`,
    /** 長周期地震動の取消の件名。`infoName` は情報名 */
    lpgmFor: (name: string, infoName: string) => `${name}の${infoName}`,
    lpgmMaxClass: (cls: number) => `最大長周期地震動階級${cls}`,
    /** 推計震度分布図の通知。`at` は地震発現時刻（日本時間。読めなければ null）、`name` は情報名 */
    estimatedIntensity: (at: { hour: number; minute: number } | null, name: string, isNew: boolean) =>
      `${at ? `${at.hour}時${String(at.minute).padStart(2, '0')}分頃発生した地震の` : ''}${name}${isNew ? 'を受信しました' : 'が更新されました'}`,
    /** 国際津波関連情報の通知の本文。`when` は発生時刻（その瞬間）で、日本時間で書く */
    internationalTsunami: (p: InternationalTsunamiNoticeParts) => {
      const jst = p.when ? new Date(p.when.getTime() + 9 * 3_600_000) : null
      const when = jst ? `${jst.getUTCDate()}日${jst.getUTCHours()}時${jst.getUTCMinutes()}分頃、` : ''
      const depth = p.depthKm !== null ? `深さ${p.depthKm}キロメートル、` : ''
      const mag = p.magnitude !== null ? `マグニチュード${p.magnitude.toFixed(1)}の` : ''
      const subject = `${when}${p.where ? `${p.where}で` : ''}発生した${depth}${mag}地震`
      return p.evaluation ? `${subject}について、${p.evaluation}と発表されました。` : `${subject}について、${p.name}が発表されました。`
    },
    /** 国際津波関連情報の評価（英文の 5 種）。日本語は読み上げと同じ語 */
    internationalTsunamiEvaluation: EVALUATION_SPEECH,
    /** 震源名を引けないときの震央の位置。日本語は読み上げと同じ言い方 */
    internationalTsunamiCoordinate: (lat: number, lon: number, _coordinate: (lat: string, lng: string, south: boolean, west: boolean) => string) =>
      `${lat < 0 ? '南緯' : '北緯'}${Math.abs(lat).toFixed(1)}度、${lon < 0 ? '西経' : '東経'}${Math.abs(lon).toFixed(1)}度`,
    communicationsTest: '通信試験です。',
    /** ウィンドウの題名 */
    titleTsunamiWarnings: '津波警報・注意報 発表中',
    titleTsunamiForecast: '津波予報 発表中',
    titleShakingDetected: '揺れ検知',
    titlePossibleShaking: '揺れの可能性',
    titleInEffect: (name: string) => `${name} 発表中`,
    titleLpgm: '長周期地震動',
    titleLpgmMaxClass: (cls: number) => `最大階級${cls}`,
    titleQuake: (name: string, scale: string) => `地震情報 ${name} 最大震度${scale}`,
    titleForeignQuake: (name: string, magnitude: string) => `遠地地震 ${name} ${magnitude}`,
    /** 読み直しの数え下げ。`periodic` は定期の読み直し（そうでなければ新しい版の適用） */
    titleReloadCountdown: (sec: number, periodic: boolean, app: string) => `${sec}秒後に${periodic ? '再読み込みします' : '更新します'} — ${app}`,
    /** 設定の窓のテスト通知 */
    testTitle: '地震情報テスト',
    testBody: '東京都内陸部（テスト） 最大震度4 M5.5',
    /** テスト通知を押したのに通知の許可が無いとき。`button` は許可のボタンの語 */
    permissionFirst: (button: string) => `先に「${button}」を押してください。`,
  },
  /**
   * いくつもの画面が使う書式の語（段 9）。震度・長周期の札・深さ・規模・緯度経度・津波の区分・訂正の種類・日付。
   * 読み上げの文面は日本語のまま組むので、そちらはこの日本語の節を直に渡す（`JA_MESSAGES.formats`）。通知はいまの言語の節を渡す。
   */
  formats: {
    /** 震度の札（一覧・カードの枠・文の中） */
    intensity: { '-1': '不明', 10: '1', 20: '2', 30: '3', 40: '4', 45: '5弱', 50: '5強', 55: '6弱', 60: '6強', 70: '7' },
    /** 地図の震度の丸の中の札（丸は 2 文字までの大きさ）。日本語は札と同じ */
    intensityShort: { '-1': '不明', 10: '1', 20: '2', 30: '3', 40: '4', 45: '5弱', 50: '5強', 55: '6弱', 60: '6強', 70: '7' },
    /** 「5弱以上」の形（電文の「震度５弱以上未入電」） */
    orAbove: (label: string) => `${label}以上`,
    /** 「5弱程度以上」の形（緊急地震速報の上限を定めない予想） */
    approxAbove: (label: string) => `${label}程度以上`,
    /** 「3〜4」の形（緊急地震速報の区域の予想の幅） */
    range: (from: string, to: string) => `${from}〜${to}`,
    /** 長周期地震動階級の札 */
    lpgmClass: (cls: number) => `階級${cls}`,
    lpgmClassUnknown: '階級不明',
    /** 地震タブ・速報の札の短い形（「長周期3」） */
    lpgmShort: (cls: number) => `長周期${cls}`,
    /** 階級が読めないときの短い札（「長周期不明」） */
    lpgmShortUnknown: '長周期不明',
    /** 札の枠の下に別の要素で小さく添える「以上」の語 */
    orAboveSuffix: '以上',
    /** 札の前後に別の要素で添える「程度以上」の語。札の前に来る語は関数で持つ（日本語・韓国語は無いので空の文字列を返す） */
    approxAboveBefore: () => '',
    approxAboveAfter: '程度以上',
    /** 揺れ検知の震度0 未満の呼び名 */
    belowZero: '0未満',
    unknown: '不明',
    magnitudeConditions: { 'M不明': 'M不明', 'M8を超える巨大地震': 'M8を超える巨大地震' },
    veryShallow: 'ごく浅い',
    depth: (km: number) => `${km}km`,
    depthAtLeast: (km: number) => `${km}km以上`,
    hypocenterSource: (source: string) => `震源決定: ${source}（気象庁以外）`,
    magnitudeJma: '気象庁マグニチュード',
    magnitude: 'マグニチュード',
    /** 緯度・経度。値は桁をそろえた絶対値 */
    coordinate: (lat: string, lng: string, south: boolean, west: boolean) =>
      `${south ? '南緯' : '北緯'} ${lat}° ${west ? '西経' : '東経'} ${lng}°`,
    originTime: '地震発生時刻',
    arrivalTime: '地震発現時刻',
    arrivalTimeUnknown: '地震発現時刻不明',
    /** 国内の津波の区分（地震情報の付加文の区分） */
    domesticTsunami: {
      なし: '津波の心配なし',
      不明: '不明',
      調査中: '調査中',
      海面変動の可能性: '津波発生のおそれあり',
      若干の海面変動: '若干の海面変動',
      注意報: '津波注意報',
      警報等: '津波警報等',
    },
    /** 付加文のコードで語を分けるもの */
    domesticTsunamiCode: {
      '0213': '海面変動に注意',
      '0214': '海面変動に注意',
      '0216': '津波のおそれ（震源が海底の場合）',
      '0217': '今後の情報に注意',
      '0230': '日本への影響なし',
    },
    tsunamiGroupTitle: '大津波警報・津波警報あるいは津波注意報のいずれかが発表されています',
    correct: {
      訂正: '訂正（内容不明）',
      震度のみ訂正: '震度を訂正',
      震源を訂正: '震源を訂正',
      '震度・震源を訂正': '震度・震源を訂正',
    },
    nonJmaStation: '気象庁以外の機関が運用する観測点です',
    /** 地図の津波の観測の凡例 */
    tsunamiObsLegend: { m3: '3m以上', m1: '1m以上', m02: '0.2m以上', under02: '0.2m未満' },
    /** 月・日と時刻（「11月11日 11:32」） */
    monthDayTime: (d: Date) => `${d.getMonth() + 1}月${d.getDate()}日 ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`,
    /** 日と時刻（報の更新の「11日 11:46」）。ほかの言語は月・日と時刻で出す */
    dayTime: (d: Date) => `${d.getDate()}日 ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`,
    /** 月・日（「11月11日」） */
    monthDay: (d: Date) => `${d.getMonth() + 1}月${d.getDate()}日`,
    /** 年・月・日（日付の区切り「2026年11月11日」） */
    fullDate: (d: Date) => `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`,
    /** 曜日の無い年・月・日（震源カタログの期間など）。日本語は日付の区切りと同じ */
    calendarDate: (d: Date) => `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`,
    /**
     * 語・値の後ろに添える括弧（段 10e）。前の語とのあいだの空白も含む —— 日本語・中国語は全角の括弧だけ、
     * 韓国語は半角の括弧を詰めて、英語・スペイン語・ポルトガル語は前に空白を置いた半角の括弧。前の語に続けて `${語}${paren(添え書き)}` と書く
     */
    paren: (text: string) => `（${text}）`,
    /** 名前などを並べる区切り（「、」） */
    listSep: '、',
    /** 語と語を空けて並べる区切り（全角空白）。空白だけの語なので、空の文字列を落とす辞書の検査に掛からないよう関数で持つ */
    spaceSep: () => '　',
    /** 種類などを詰めて並べる区切り（「／」） */
    slash: '／',
    /** 前後に空白を置いて並べる区切り（「 ／ 」） */
    slashSpaced: ' ／ ',
    /** 日時の範囲を前後に空白を置いて書く形（「A 〜 B」）。詰めて書く範囲は `range` */
    rangeSpaced: (from: string, to: string) => `${from} 〜 ${to}`,
  },
} as const
