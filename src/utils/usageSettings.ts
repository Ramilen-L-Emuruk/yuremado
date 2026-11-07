/**
 * 使用状況データの「設定のデータ」で送る項目と、値の決まり（設計書 §6.6・プライバシーポリシー §1「使用状況データ」）。
 *
 * **アプリと中継で同じものを使う**（中継は `scripts/sync-from-app.mjs` でこのファイルを写す）。アプリはここで値を記録の文字列にし、
 * 中継はここで届いた文字列を検めてから 1 項目 1 件で書く（任意の文字列を記録へ書かせない）。管理の画面の節と名前・既定値もここが持つ。
 * 写されるので、ほかのファイルを import しない。
 *
 * - 範囲は設定の窓の全項目（2026-11-05 ユーザー選択「全項目・秘密と場所は「入れたか」だけ (Recommended)」）。
 *   鍵・接続先・登録した地点は `present`（入れているかだけ）で、中身は送らない
 * - 通知する地域は選んだ都道府県の数だけ（2026-11-05 ユーザー選択「選んだ県の数だけ (Recommended)」）
 *
 * 項目が `AppSettings` を漏れなく覆っていることはアプリの `services/usageStats.ts` が型で縛り、
 * 選択肢と既定値が設定の読み込み（`hooks/useSettings.ts` の `sanitize`・`DEFAULTS`）と食い違わないことは `usageSettings.test.ts` が縛る。
 */

/** 値の決まり */
export type UsageSettingRule =
  /** オン・オフ。`1`／`0` */
  | { readonly kind: 'bool' }
  /** 決まった値のどれか。値をそのまま文字列にする */
  | { readonly kind: 'choice'; readonly values: readonly (string | number)[] }
  /** 幅のある数。小数は 3 桁に丸める。`nullable` なら未設定を `null` で送る */
  | { readonly kind: 'number'; readonly min: number; readonly max: number; readonly nullable?: true }
  /** 入れているかだけ（中身は送らない）。空でない文字列・null でない値・既定から変えた接続先で `1` */
  | { readonly kind: 'present' }
  /** 一覧の数だけ（中身は送らない） */
  | { readonly kind: 'count'; readonly max: number }

/** 管理の画面の節。並びは設定の窓の節の順 */
export const USAGE_SETTING_GROUPS = {
  connection: '接続',
  notification: 'ブラウザ通知',
  push: 'プッシュ通知',
  sound: '音と読み上げ',
  timeSignal: '時報',
  voicevox: 'VOICEVOX',
  tts: '読み上げ設定',
  telegramText: '気象庁の発表文',
  display: '表示設定',
  map: '地図',
  behavior: '動作設定',
  actionChecklist: '行動チェックリスト',
  location: 'ホーム地点',
  seismo: '自作地震計',
  wave: '波形グラフ',
  share: '共有と保存',
  about: 'このアプリについて',
  state: '画面の状態（設定の窓に行が無いもの）',
} as const

export type UsageSettingGroup = keyof typeof USAGE_SETTING_GROUPS

export interface UsageSettingSpec {
  readonly group: UsageSettingGroup
  /** 管理の画面に出す名前。設定の窓の行の名前（入れ子は「区分: 行」） */
  readonly label: string
  readonly rule: UsageSettingRule
  /** 既定値を記録の文字列にしたもの。管理の画面が「既定から変えた人」を数える */
  readonly default: string
}

const bool = (group: UsageSettingGroup, label: string, on: boolean): UsageSettingSpec =>
  ({ group, label, rule: { kind: 'bool' }, default: on ? '1' : '0' })
/** 選択肢の一覧は値の型のまま残す（アプリの `services/usageStats.ts` が、設定の型と同じ値の集まりかを型で見る） */
const choice = <const V extends readonly (string | number)[]>(group: UsageSettingGroup, label: string, values: V, def: V[number]) =>
  ({ group, label, rule: { kind: 'choice', values } as { readonly kind: 'choice'; readonly values: V }, default: String(def) })
const num = (group: UsageSettingGroup, label: string, min: number, max: number, def: number | null, nullable?: true): UsageSettingSpec =>
  ({ group, label, rule: nullable ? { kind: 'number', min, max, nullable } : { kind: 'number', min, max }, default: def === null ? 'null' : String(def) })
const present = (group: UsageSettingGroup, label: string): UsageSettingSpec =>
  ({ group, label, rule: { kind: 'present' }, default: '0' })

/** 気象庁の震度階級（`utils/intensity.ts` の INTENSITY_LABELS）と、表示の下限の「すべて」（-1） */
const INTENSITY_SCALES = [-1, 10, 20, 30, 40, 45, 50, 55, 60, 70] as const

/** 気象庁の発表文の区分（`utils/ttsText.ts` の TELEGRAM_TEXT_BLOCK_KEYS）と、設定の窓での「種別: 行」の名前 */
export const USAGE_TELEGRAM_TEXT_BLOCKS = {
  quakeForecast: '地震情報: 固定付加文',
  quakeVarComment: '地震情報: 固定付加文（その他）',
  quakeFreeText: '地震情報: 自由付加文',
  tsunamiBody: '津波情報: 本文',
  tsunamiVarComment: '津波情報: 固定付加文',
  tsunamiFreeText: '津波情報: 自由付加文',
  lpgmForecast: '長周期地震動に関する観測情報: 固定付加文',
  lpgmVarComment: '長周期地震動に関する観測情報: 固定付加文（その他）',
  lpgmFreeText: '長周期地震動に関する観測情報: 自由付加文',
  nankaiSummary: '南海トラフ地震臨時情報: 要約',
  nankaiBody: '南海トラフ地震臨時情報: 本文',
  nankaiNextAdvisory: '南海トラフ地震臨時情報: 次回発表予定',
  nankaiCommentarySummary: '南海トラフ地震関連解説情報: 要約',
  nankaiCommentaryBody: '南海トラフ地震関連解説情報: 本文',
  nankaiCommentaryNextAdvisory: '南海トラフ地震関連解説情報: 次回発表予定',
  kohatsuSummary: '北海道・三陸沖後発地震注意情報: 要約',
  kohatsuBody: '北海道・三陸沖後発地震注意情報: 本文',
  earthquakeCountBody: '地震回数に関する情報: 本文',
  earthquakeCountFreeText: '地震回数に関する情報: 自由付加文',
  quakeNoticeBody: '地震・津波に関するお知らせ: 本文',
} as const

/** 読み上げから落とせる定型文（`utils/ttsText.ts` の TELEGRAM_BOILERPLATE_KEYS）の名前。既定はどれも読まない */
export const USAGE_TELEGRAM_BOILERPLATE = {
  starMark: '定型文: ＊印の説明',
  eewIssued: '定型文: 緊急地震速報の発表告知',
  lpgmClassTable: '定型文: 長周期地震動階級の目安',
  tsunamiHeightLegend: '定型文: 津波の高さの目安',
  earthquakeInfoAppendix: '定型文: 南海トラフ・後発地震の情報の参考情報',
} as const

/** 入れ子の項目の名前の区切り（`ttsTelegramTextBlocks.quakeForecast` の形） */
export const USAGE_SETTING_NESTED_SEPARATOR = '.'

/**
 * 送る項目（名前 → 決まり）。上の段が設定の項目そのもの、入れ子（発表文の区分と定型文）は下で足す。
 * 既定値はアプリの `DEFAULTS` と同じ（食い違えば `usageSettings.test.ts` が落ちる）
 */
export const USAGE_TOP_LEVEL_SPECS = {
  // 接続
  dmdataApiKey: present('connection', 'APIキー'),
  forecastKey: present('connection', '予報キー'),
  dmdataTestDelivery: bool('connection', '試験報を受信（検証用）', false),
  // ブラウザ通知
  notifyEnabled: bool('notification', '通知を表示', true),
  notifyQuietWhileOpen: bool('notification', 'アプリを開いている間は通知しない', false),
  notifyQuake: bool('notification', '地震情報の通知', true),
  notifyMinScale: choice('notification', '通知する最低震度', INTENSITY_SCALES, 30),
  notifyDetection: bool('notification', '揺れ検知通知', false),
  notifyEEW: bool('notification', '緊急地震速報の通知', true),
  notifyTsunami: bool('notification', '津波通知', true),
  notifyNankai: bool('notification', '南海トラフ・後発地震の通知', true),
  notifyPrefectures: { group: 'notification', label: '通知する地域（選んだ都道府県の数。0 は全国）', rule: { kind: 'count', max: 47 }, default: '0' },
  pushNotifyEnabled: bool('push', 'プッシュ通知', false),
  // 音と読み上げ
  soundEnabled: bool('sound', '通知音', true),
  soundVolume: num('sound', '音量', 0, 1, 1),
  voicevoxEnabled: bool('voicevox', 'VOICEVOX 読み上げ', false),
  voicevoxUrl: present('voicevox', 'VOICEVOX URL（既定の localhost から変えたか）'),
  voicevoxSpeakerId: num('voicevox', '話者（番号）', 0, 100000, 0),
  nankaiCommentaryAlerts: bool('sound', '解説情報の音・読み上げ', true),
  quakeNoticeAlerts: bool('sound', 'お知らせの音・読み上げ', false),
  kyoshinDetectSpeech: bool('sound', '揺れ検知の読み上げ', false),
  // 読み上げ設定
  ttsIntensityLevels: num('tts', '読み上げ震度階数', 0, 10, 2),
  ttsAlwaysReadScale: choice('tts', '必ず読み上げる震度', INTENSITY_SCALES, 30),
  ttsAlwaysReadLpgmClass: choice('tts', '必ず読み上げる長周期地震動階級', [-1, 0, 1, 2, 3, 4], 1),
  ttsMaxRegions: num('tts', '読み上げ最大地域数', 0, 100, 10),
  ttsRegionTolerance: num('tts', '地域数の許容超過', 0, 100, 2),
  ttsReadHypocenterDetail: bool('tts', '震源の深さ・規模', true),
  ttsUnreceivedDetail: choice('tts', '震度を入手していない地点', ['stations', 'areas', 'none'], 'stations'),
  ttsMaxObservationPoints: num('tts', '津波観測点の読み上げ件数', 0, 20, 5),
  ttsReadEewLpgmClass: bool('tts', '緊急地震速報の長周期地震動階級', true),
  ttsReadEewWarningRegions: bool('tts', '緊急地震速報の警戒地域', true),
  ttsReadTelegramText: bool('telegramText', '気象庁の発表文', true),
  // 時報
  timeSignalEnabled: bool('timeSignal', '時報', false),
  timeSignalIntervalMin: choice('timeSignal', '間隔（分）', [60, 30, 15, 10, 5], 60),
  timeSignalSound: choice('timeSignal', '音', ['pips', 'pon', 'chime', 'none'], 'pips'),
  timeSignalOrder: choice('timeSignal', '順番', ['soundFirst', 'speechFirst'], 'soundFirst'),
  timeSignalPhrase: choice('timeSignal', '読み上げの文', ['oshirase', 'desu', 'narimashita', 'bare'], 'desu'),
  timeSignalClock: choice('timeSignal', '時刻の読み方', ['24h', '12h'], '24h'),
  timeSignalQuietEnabled: bool('timeSignal', '鳴らさない時間帯', false),
  timeSignalQuietStartMin: num('timeSignal', '鳴らさない時間帯の始まり（0 時からの分）', 0, 1439, 22 * 60),
  timeSignalQuietEndMin: num('timeSignal', '鳴らさない時間帯の終わり（0 時からの分）', 0, 1439, 7 * 60),
  timeSignalWhileSpeaking: choice('timeSignal', '読み上げと重なったとき', ['soundOnly', 'skip'], 'soundOnly'),
  timeSignalVolume: num('timeSignal', '時報の音量（null は通知音と同じ）', 0, 1, null, true),
  timeSignalSpeakerId: num('timeSignal', '時報の声（null は読み上げと同じ）', 0, 100000, null, true),
  // 表示設定
  uiScale: num('display', 'UI 倍率', 0.5, 3, 1),
  mapIconScale: num('display', '地図アイコンの倍率', 0.5, 3, 1),
  hypocenterDepthScale: num('display', '震源の深さの強調', 1, 20, 1),
  showBathymetry: bool('map', '海底地形を表示', true),
  showDayNight: bool('map', '昼夜の境目を表示', true),
  dayNightOpacity: num('map', '夜側の濃さ', 0.2, 0.95, 0.5),
  showPlateBoundaries: bool('map', 'プレート境界線を表示', true),
  showActiveFaults: bool('map', '活断層線を表示', true),
  activeFaultOpacity: num('map', '活断層線の濃さ', 0.05, 1, 0.4),
  showQuakeHeatmap: bool('map', '地震活動ヒートマップを表示', false),
  heatmapPeriod: choice('map', 'ヒートマップの期間', ['7d', '30d', '90d', '1y', '2y', '5y', '10y', '20y', '50y', 'all'], '30d'),
  showMapLegend: bool('map', '凡例を表示', true),
  quakeNoticeBanner: bool('display', 'お知らせを表示', true),
  // 動作設定
  defaultTab: choice('behavior', 'デフォルトタブ', ['earthquake', 'realtime'], 'earthquake'),
  tsunamiPriorityDefault: bool('behavior', '津波発表中は津波情報を優先', true),
  tsunamiTitleTemporary: bool('behavior', '津波タイトル表示を一定時間に制限', false),
  idleRevertSec: num('behavior', '自動復帰までの時間（秒）', 0, 3600, 30),
  actionChecklistEnabled: bool('actionChecklist', '行動チェックリスト', true),
  actionChecklistMinScale: choice('actionChecklist', '行動チェックリストを出す最低震度', INTENSITY_SCALES, 45),
  periodicReloadHours: num('behavior', '定期自動リロード（時間・0 は切）', 0, 168, 1),
  recordingMode: bool('behavior', '録画モード', false),
  // ホーム地点
  homeLat: present('location', 'ホーム地点（緯度を入れたか）'),
  homeLng: present('location', 'ホーム地点（経度を入れたか）'),
  arrivalToken: present('location', '到達予想キー'),
  // 自作地震計
  seismoEnabled: bool('seismo', '自作地震計と接続', false),
  seismoHostUrl: present('seismo', 'ホストのURL'),
  seismoWave: choice('seismo', '波形グラフ', ['off', 'auto', 'always'], 'auto'),
  seismoWaveCollapsedView: choice('seismo', '波形の表示', ['composite', 'overlay'], 'composite'),
  // 波形グラフ
  publicWaveEnabled: bool('wave', '公開観測点の波形を表示', true),
  waveSpanSec: choice('wave', '波形の時間幅（秒）', [60, 120, 180], 120),
  publicWaveAlwaysConnected: bool('wave', '公開観測点に常時接続', false),
  // 共有と保存
  shareCardFormat: choice('share', '共有カードの寸法', ['wide16x9', 'square1x1', 'portrait4x5'], 'wide16x9'),
  // このアプリについて（送っている端末では常にオン）
  usageStatsEnabled: bool('about', '使用状況データを送信する', false),
  // 画面の状態
  mapLegendCollapsed: choice('state', '凡例を畳んでいるか', ['auto', 'open', 'collapsed'], 'auto'),
  seismoWaveExpanded: bool('state', '自作地震計の波形を展開しているか', false),
  panelRatio: num('state', '上下に分けたときのパネルの比率', 0.2, 0.8, 0.45),
  panelWidthSide: num('state', '左右に分けたときのパネルの幅（PC・rem。null は既定）', 20, 200, null, true),
  panelWidthSideNarrow: num('state', '左右に分けたときのパネルの幅（スマホ横・rem。null は既定）', 20, 200, null, true),
  dmdataKeyReentryNotice: bool('state', 'API キーの入れ直しのお知らせを出しているか', false),
  // 地震タブの絞り込みと並び替え（地域と種類は数だけ。地域の名前は住んでいる場所に結びつきうるので送らない）
  quakeListScaleMin: choice('state', '地震タブ: 震度の下限（-1 は決めていない）', INTENSITY_SCALES, -1),
  quakeListScaleMax: choice('state', '地震タブ: 震度の上限（-1 は決めていない）', INTENSITY_SCALES, -1),
  quakeListMagnitudeMin: num('state', '地震タブ: 規模の下限（null は決めていない）', 0, 10, null, true),
  quakeListMagnitudeMax: num('state', '地震タブ: 規模の上限（null は決めていない）', 0, 10, null, true),
  quakeListDepthMin: num('state', '地震タブ: 深さの下限（km。null は決めていない）', 0, 700, null, true),
  quakeListDepthMax: num('state', '地震タブ: 深さの上限（km。null は決めていない）', 0, 700, null, true),
  quakeListRegionBasis: choice('state', '地震タブ: 地域の基準', ['epicenter', 'observed'], 'epicenter'),
  quakeListRegions: { group: 'state', label: '地震タブ: 選んだ地域の数（0 はすべて）', rule: { kind: 'count', max: 999 }, default: '0' },
  quakeListTypes: { group: 'state', label: '地震タブ: 選んだ種類の数（0 はすべて）', rule: { kind: 'count', max: 6 }, default: '0' },
  quakeListPeriodHours: choice('state', '地震タブ: 期間（時間。0 は決めていない）', [0, 24, 72, 168, 720], 0),
  quakeListPeriodFrom: present('state', '地震タブ: 期間の日付を指定したか（始め）'),
  quakeListPeriodTo: present('state', '地震タブ: 期間の日付を指定したか（終わり）'),
  quakeListSortKey: choice('state', '地震タブ: 並び替えの欄', ['time', 'scale', 'magnitude', 'depth', 'region'], 'time'),
  quakeListSortDir: choice('state', '地震タブ: 並び替えの向き', ['asc', 'desc'], 'desc'),
} as const satisfies Record<string, UsageSettingSpec>

/** 送る項目のうち、設定の 1 項目そのもの（入れ子を除く）の名前 */
export type UsageTopLevelSettingName = keyof typeof USAGE_TOP_LEVEL_SPECS

/** 入れ子を持つ設定の項目（中身を区分ごとに 1 項目として送る） */
export const USAGE_NESTED_SETTINGS = ['ttsTelegramTextBlocks', 'ttsTelegramBoilerplate'] as const

export const USAGE_SETTING_SPECS: Readonly<Record<string, UsageSettingSpec>> = {
  ...USAGE_TOP_LEVEL_SPECS,
  ...Object.fromEntries(Object.entries(USAGE_TELEGRAM_TEXT_BLOCKS).map(([k, label]) =>
    [`ttsTelegramTextBlocks${USAGE_SETTING_NESTED_SEPARATOR}${k}`, bool('telegramText', label, true)])),
  ...Object.fromEntries(Object.entries(USAGE_TELEGRAM_BOILERPLATE).map(([k, label]) =>
    [`ttsTelegramBoilerplate${USAGE_SETTING_NESTED_SEPARATOR}${k}`, bool('telegramText', label, false)])),
}

/** 送る項目の数（中継が 1 回に書ける件数の上限 250 と比べる） */
export const USAGE_SETTING_COUNT = Object.keys(USAGE_SETTING_SPECS).length

/** 小数を 3 桁に丸めて文字列にする（`0.1 + 0.2` のような端数で値が割れないように） */
function numberText(v: number): string {
  return String(Math.round(v * 1000) / 1000)
}

/**
 * 設定の値を記録の文字列にする（アプリが使う）。決まりに合わない値は null（送らない）。
 * `present` の接続先（VOICEVOX）は既定の値のままなら「入れていない」とみなす
 */
export function encodeUsageSetting(spec: UsageSettingSpec, value: unknown, defaultValue?: unknown): string | null {
  const rule = spec.rule
  switch (rule.kind) {
    case 'bool':
      return typeof value === 'boolean' ? (value ? '1' : '0') : null
    case 'choice':
      return rule.values.includes(value as string | number) ? String(value) : null
    case 'number':
      if (value === null) return rule.nullable ? 'null' : null
      if (typeof value !== 'number' || !Number.isFinite(value) || value < rule.min || value > rule.max) return null
      return numberText(value)
    case 'present':
      if (value === null || value === undefined) return '0'
      if (typeof value === 'string') return value !== '' && value !== defaultValue ? '1' : '0'
      return typeof value === 'number' && Number.isFinite(value) ? '1' : null
    case 'count':
      return Array.isArray(value) && value.length <= rule.max ? String(value.length) : null
  }
}

/** 届いた文字列が、その項目の決まりに合うか（中継が使う）。合わなければ null、合えばそのまま返す */
export function validUsageSettingValue(name: string, raw: unknown): string | null {
  if (!Object.prototype.hasOwnProperty.call(USAGE_SETTING_SPECS, name)) return null
  if (typeof raw !== 'string' || raw.length > 16) return null
  const rule = USAGE_SETTING_SPECS[name].rule
  switch (rule.kind) {
    case 'bool':
    case 'present':
      return raw === '0' || raw === '1' ? raw : null
    case 'choice':
      return rule.values.some(v => String(v) === raw) ? raw : null
    case 'number': {
      if (raw === 'null') return rule.nullable ? raw : null
      if (!/^-?\d+(\.\d{1,3})?$/.test(raw)) return null
      const v = Number(raw)
      return v >= rule.min && v <= rule.max ? raw : null
    }
    case 'count': {
      if (!/^\d{1,3}$/.test(raw)) return null
      return Number(raw) <= rule.max ? raw : null
    }
  }
}
