import { useCallback, useRef, useState } from 'react'
import { log } from '../utils/logger'
import { isDmdss } from '../utils/env'
import { isValidIntensityScale } from '../utils/intensity'
import { isObservedLpgmClass } from '../utils/lpgm'
// 読み上げ文の作り方を決める値なので、定義は読み上げ側（`utils/ttsText.ts`）に置く。
// ここ（設定）から生やすと utils → hooks の向きで参照が要り、依存が逆流する。
import type { TtsUnreceivedDetail, TelegramTextBlockKey, TelegramTextBlocks, TelegramBoilerplateKey, TelegramBoilerplateReads } from '../utils/ttsText'
import { TELEGRAM_TEXT_BLOCK_KEYS, TELEGRAM_BOILERPLATE_KEYS, TELEGRAM_BOILERPLATE_DEFAULT_READS } from '../utils/ttsText'
// 同じ理由（依存の向き）で、波形グラフの出し方の定義も utils 側に置いてある。
import type { SeismoWaveMode } from '../utils/seismoWaveTrigger'
import { DEFAULT_WAVE_SPAN_SEC, ensureWaveSpanSec, type WaveSpanSec } from '../utils/waveSpan'
import { SHARE_CARD_FORMATS, type ShareCardFormatId } from '../utils/shareCard'
import { DEFAULT_HEATMAP_PERIOD, isHeatmapPeriod, type HeatmapPeriod } from '../utils/quakeHeatmap'

/** 波形を展開していないときに出すもの（→ {@link AppSettings.seismoWaveCollapsedView}）。 */
export type SeismoWaveCollapsedView = 'composite' | 'overlay'

export type { TtsUnreceivedDetail, TelegramTextBlockKey, TelegramTextBlocks }
export { TELEGRAM_TEXT_BLOCK_KEYS, TELEGRAM_BOILERPLATE_KEYS }

// アイドル復帰時に戻すデフォルトタブの選択肢（津波情報・設定は対象外。津波の発表中は「津波発表中は津波情報を優先」で
// 津波へ戻れる。2026-10-23 ユーザー選択「今のまま記録する (Recommended)」）
export type DefaultTabSetting = 'earthquake' | 'realtime'

/**
 * 地図の凡例を畳んでいるか。
 *
 * `'auto'` は「利用者がまだ開閉していない」状態で、地図の高さから決める
 * （`LEGEND_AUTO_COLLAPSE_MAP_HEIGHT_PX`）。一度開閉したらその選択を固定する——画面の回転や
 * パネルの比率で勝手に開き直すと、閉じたつもりのものが戻ってくる。
 */
export type MapLegendCollapseSetting = 'auto' | 'open' | 'collapsed'

/** 津波の観測点を読み上げる件数の上限（設定で選べる範囲）。**`0` は無制限**（`ttsMaxRegions` と同じ意味）。 */
export const TTS_MAX_OBSERVATION_POINTS_MIN = 0
export const TTS_MAX_OBSERVATION_POINTS_MAX = 20

export interface AppSettings {
  minDisplayScale: number   // 最低表示震度 (-1 = すべて)
  /**
   * ブラウザ通知をまとめて止める（false で、種類ごとの設定によらずどの通知も出さない）。
   * 種類ごとの値は書き換えないので、戻せば元どおり効く。判定は `utils/notificationGate.ts`。
   */
  notifyEnabled: boolean
  notifyQuake: boolean      // 地震情報（長周期地震動・推計震度分布図・地震回数を含む）のブラウザ通知を送る
  notifyMinScale: number    // 地震情報を通知する最低震度（階級値。入り切りは `notifyQuake`）
  // 地震後の行動チェックリストを出すか。最低震度とは別に持つ（切って入れ直しても最低震度を忘れないため）
  actionChecklistEnabled: boolean
  // 地震後の行動チェックリストを出す最低震度。ホーム地点を設定していれば
  // その周り（半径 NEARBY_RADIUS_KM）で、していなければ全国のどこかで、この震度に達したら出す
  actionChecklistMinScale: number
  soundEnabled: boolean     // 地震・EEW・津波の受信時に音を鳴らす
  soundVolume: number       // 通知音・VOICEVOX 読み上げ共通の全体音量 (0.0 〜 1.0)
  // 南海トラフ地震関連解説情報（VYSE51/52）の通知音と読み上げを行う。
  // 平常時でも毎月1回は必ず届く電文なので、煩わしいときに個別に切れるようにしている
  // （臨時情報＝段階の発表はこの設定に関わらず鳴る）。soundEnabled / voicevoxEnabled が
  // 無効ならそちらが優先される。
  nankaiCommentaryAlerts: boolean
  /**
   * 地震・津波に関するお知らせ（VZSE40。観測点の入電停止・配信試験などの運用連絡）を地図の下に帯で出す。
   * 既定は出す。切っても受信と記録は続く（画面に出さないだけ）。
   */
  quakeNoticeBanner: boolean
  /**
   * 地震・津波に関するお知らせ（VZSE40）の通知音と読み上げを行う（解説情報の `nankaiCommentaryAlerts` と同じ形）。
   * **既定は行わない**（運用連絡が大半で、平常時に音や声で知らせるほどの情報ではないため）。読み上げは
   * 最下位の層で行い、他の情報の読み上げを切らない。本文は「気象庁が書いた文」の設定
   * （`ttsReadTelegramText` と `quakeNoticeBody`）に従う。`soundEnabled` / `voicevoxEnabled` が
   * 無効ならそちらが優先される。有効なら受信時にパネルを一時的に開く（他の帯と同じ）。
   */
  quakeNoticeAlerts: boolean
  /**
   * 揺れ検知が確かな段に上がったとき、揺れている区域の名前を 1 回読み上げる（「〇〇で揺れを検知。」）。
   * 緊急地震速報の範囲内の揺れは読まない。`voicevoxEnabled` が無効なら読まない。
   * 既定は行わない（2026-10-31 ユーザー選択「設定を足し既定オフ」）。
   */
  kyoshinDetectSpeech: boolean
  uiScale: number           // UI 倍率 (1 = 100%)
  mapIconScale: number      // 地図アイコンの倍率 (1 = 100%、UI 倍率とは独立)
  // 地図を傾けたとき、震源をどれだけ深く見せるか (1 = 実際の深さ)。水平方向は常に実スケール。
  hypocenterDepthScale: number
  showBathymetry: boolean   // 背景に海底地形（GEBCO・NOAA NCEI）を表示する
  showActiveFaults: boolean // 地震情報・リアルタイムタブの地図に活断層線を表示する
  activeFaultOpacity: number // 活断層線の不透明度（濃さ、0.05〜1.0）
  showQuakeHeatmap: boolean // 地震情報・リアルタイムタブの地図に地震活動ヒートマップを表示する
  /** ヒートマップの期間（凡例のヒートマップ欄のスライダーで選ぶ。→ `utils/quakeHeatmap.ts` の `HEATMAP_PERIODS`）。 */
  heatmapPeriod: HeatmapPeriod
  showPlateBoundaries: boolean // 地震情報・リアルタイム・津波情報・震源カタログタブの地図にプレート境界線を表示する
  showMapLegend: boolean    // 地図に色の凡例（震度・津波の等級・深さなど）を重ねる
  /** 共有カード（地図を画像にして共有する）の寸法（→ `utils/shareCard.ts` の `SHARE_CARD_FORMATS`）。 */
  shareCardFormat: ShareCardFormatId
  mapLegendCollapsed: MapLegendCollapseSetting // 凡例を畳んでいるか（'auto' = 地図の高さで決める）
  showDayNight: boolean     // 地図に夜の側を重ねる（日の入りから夜が深まるまでを濃淡で表す）
  dayNightOpacity: number   // 夜側の濃さ（0.2〜0.95）
  defaultTab: DefaultTabSetting    // 起動時・アイドル復帰時に表示するタブ
  tsunamiPriorityDefault: boolean  // 津波発表中はデフォルトタブを津波情報にする
  tsunamiTitleTemporary: boolean   // ウィンドウタイトルの津波表示を受信後一定時間のみにする（false = 発表中ずっと表示）
  idleRevertSec: number            // 操作なしでデフォルトタブへ戻るまでの秒数 (0 = 無効)
  periodicReloadHours: number      // 定期自動リロード（0 = 無効、1以上 = 毎日午前5時に実行）
  // 画面録画のあいだ、表示に要らない再計算を控える。表示される内容そのものは変わらない
  // （止めるのは通知音・読み上げのキープアライブだけ。詳細は settings-pwa-spec §2）。
  recordingMode: boolean
  notifyEEW: boolean               // 緊急地震速報の発報・昇格時にブラウザ通知を送る
  notifyTsunami: boolean           // 津波のブラウザ通知（予報以上の発表・続報と全区域解除。→ audio-tts-spec §7）
  notifyDetection: boolean         // 強震モニタの揺れ検知時にブラウザ通知を送る
  notifyNankai: boolean            // 南海トラフ地震臨時情報・後発地震注意情報・臨時の解説情報のブラウザ通知（DMDSS 版。2026-10-24 ユーザー選択「南海は新設、他は地震情報に (Recommended)」）
  homeLat: number | null           // ホーム地点 緯度（null = 未設定）
  homeLng: number | null           // ホーム地点 経度（null = 未設定）
  /**
   * 到達予想トークン（空文字 = 未設定）。
   *
   * これが有効なときだけ、ホーム地点への主要動到達を自前の走時計算で出す。既定では気象庁が
   * 区域ごとに出した到達予測時刻を伝えるだけ —— 地点ごとの予想を自前で出すのは気象業務法
   * 第 17 条の許可を要する地震動の予報業務に当たりうるため（→ `utils/arrivalToken.ts`）。
   */
  arrivalToken: string
  dmdataApiKey: string             // DMDATA.JP APIキー（DMDSS版のみ使用、空文字 = 未設定）
  dmdataTestDelivery: boolean      // 試験報・訓練報を受信する（検証用）。DMDSS版は配信テスト VXSE42 等も、標準版は強震モニタ・P2PQuake の緊急地震速報の訓練報・試験報（→ admitTrainingEew）
  voicevoxEnabled: boolean         // VOICEVOX 読み上げを有効にする
  voicevoxUrl: string              // VOICEVOX の HTTP API ベース URL
  voicevoxSpeakerId: number        // VOICEVOX 話者 ID
  ttsIntensityLevels: number       // 読み上げる震度階数（最大震度に加えて何階級下まで。0 = 最大震度のみ）
  ttsMaxRegions: number            // 読み上げる最大地域数（0 = 無制限）
  ttsAlwaysReadScale: number       // 階数の設定を超えても読み上げる下限震度 (-1 = 無効)
  /**
   * 階数の設定を超えても読み上げる長周期地震動階級の下限（0〜4。-1 = 無効）。
   * 震度の下限（`ttsAlwaysReadScale`）は長周期には効かないので、別に持つ
   * （2026-10-22 ユーザー選択「必ず読む階級を設ける (Recommended)」。既定と文言は 2026-10-24 選択「この形でよい (Recommended)」）。
   * 階級 0 も選べる（2026-10-30 ユーザー選択「足す (Recommended)」）。
   */
  ttsAlwaysReadLpgmClass: number
  ttsRegionTolerance: number       // 最大地域数をこの数まで超える場合は省略せず全地域を読む (0 = 無効)
  /**
   * 気象庁が書いた文（本文・付加文）を読み上げる。既定は無効（画面にだけ出す従来の挙動）。
   *
   * **本文は電文本体とは別の発話として、最下位の層で読む。** 本体の末尾に足すと、
   * 南海トラフ臨時情報の本文（実電文で 1055 字・読み上げ実測 3 分）が地震情報を
   * 90 秒待たせ、そこで割り込まれて本文自体も途中で切れる。詳細は
   * docs/spec/audio-tts-spec.md §6「気象庁が書いた文は最下位の層で読む」。
   */
  ttsReadTelegramText: boolean
  /**
   * 気象庁が書いた文のうち、どのブロックを読むか（電文種別 × ブロック。一覧は
   * `TELEGRAM_TEXT_BLOCK_KEYS`）。**`ttsReadTelegramText` が偽ならここの指定は効かない** ——
   * あちらがマスタートグルで、こちらはその内訳。
   *
   * **この設定だけオブジェクトで持っている。** 19 個をフラットに並べると、型定義・既定値・
   * `sanitize` の 3 箇所へ 19 行ずつ増えて画面や音の設定と混ざる。ブロックの集合は電文の
   * 構造に由来するまとまりなので、1 つにしてキーの一覧から導く。
   */
  ttsTelegramTextBlocks: TelegramTextBlocks
  /**
   * 気象庁が書いた文のうち、どの定型文を読むか（一覧は `TELEGRAM_BOILERPLATE_KEYS`）。
   * 上の `ttsTelegramTextBlocks` が「付加文の枠ごと」を切るのに対し、こちらは**枠の中の
   * 特定の文だけ**を落とす。`ttsReadTelegramText` が偽ならどちらの指定も効かない。
   *
   * **こちらだけ既定が「読まない」側**（理由は `TELEGRAM_BOILERPLATE_DEFAULT_READS`）。
   */
  ttsTelegramBoilerplate: TelegramBoilerplateReads
  ttsUnreceivedDetail: TtsUnreceivedDetail  // 「震度5弱以上・未入電」の読み方
  ttsMaxObservationPoints: number  // 津波の観測点を読み上げる件数（波高更新・到達確認・欠測・警報相当で共通）
  ttsReadHypocenterDetail: boolean // 震源の深さ・規模を読む（無効なら震源名だけ）
  ttsReadEewLpgmClass: boolean     // 緊急地震速報の予想最大長周期地震動階級を読む
  /**
   * 緊急地震速報（警報）の対象地方を、震源を伝えたあと・予想値を伝える前に読む。
   *
   * **予想値の読み上げを遅らせることが目的**の項目でもある。待っているあいだに続報が届けば、
   * 予想震度はより新しい確定値で読まれる（詳細は docs/spec/audio-tts-spec.md §6
   * 「警報の対象地方を、予想値の前に伝える」）。
   */
  ttsReadEewWarningRegions: boolean
  /**
   * 自作地震計ホスト（`seismo-host/`）へ繋ぐ。
   *
   * 繋ぐと観測点ごとの計測震度が地図の右上へ出る（`components/SeismoOverlay/`）。
   * 波形の絵は別の設定（{@link seismoWave}）。
   *
   * **URL とは別にトグルを持つ。** 入れた URL を覚えたまま一時的に切れるようにするため
   * （モバイル回線に切り替えたとき・ホストを再起動している間）。**そのぶん繋がらない
   * 理由が「切っている」「URL が空」「URL の形が違う」「ホストが応えない」の 4 通りに
   * なる**ので、設定の窓の接続状態はこの 4 つを言い分けて出す（1 つの
   * 「繋がりません」へ潰さない。→ `components/SettingsTab/seismoStatusLine.ts`）。
   */
  seismoEnabled: boolean
  /**
   * 自作地震計ホストの基点 URL（空文字 = 未設定）。
   *
   * **既定は空文字で、`.env.local` からの自動投入もしない。** VOICEVOX と違い、
   * 繋ぎ先は端末ごとに違う（LAN の IP か Tailscale の名前か）ので、既定値を
   * 置いても当たらない。
   *
   * **iOS 実機ではホーム画面に追加した PWA からしか繋がらない**（実測の経緯は
   * `seismo-host/REQUIREMENTS.md` §13）。通常の Safari タブでは HTTPS でも失敗する。
   */
  seismoHostUrl: string
  /**
   * 自作地震計の波形グラフ（地図の下端）の出し方。
   *
   * **`'off'` 以外では波形を購読する**（`'auto'` でも）。揺れてから購読を上げたのでは
   * 間に合わないため —— 詳しくは `utils/seismoWaveTrigger.ts` の
   * {@link SeismoWaveMode}。合成波形は毎秒 15 KB あるので既定は `'off'`。
   */
  seismoWave: SeismoWaveMode
  /**
   * 波形を展開していないときに出すもの（地図の下端の波形と地震カードの波形の両方。2026-10-13 ユーザー承認）。
   *
   * - `'composite'`: 合成（3 成分のベクトルの大きさ）を 1 本
   * - `'overlay'`: 3 成分を重ねる
   */
  seismoWaveCollapsedView: SeismoWaveCollapsedView
  /**
   * 地図の下端の波形を展開しているか（合成＋東西・南北・上下の段）。**押した状態をリロードしても保つ**
   * （向きの切り替えと違い、見せ方の好みなので残す）。
   */
  seismoWaveExpanded: boolean
  /**
   * 地図の下端の波形の横の幅（秒。60 / 120 / 180）。**自作地震計と公開観測点で揃える**
   * （`docs/public-waveform-design.md` §0。2026-10-14 ユーザー承認）。
   */
  waveSpanSec: WaveSpanSec
  /**
   * 公開観測点（気象庁の広帯域地震計・EarthScope 経由）の波形を出すか。**既定はオン。** オフなら地図の下端・地震カード・
   * 地図の印のどれにも出さず、SeedLink にも保存庫にも取りに行かない（`docs/public-waveform-design.md` §0。2026-10-15 ユーザー承認）。
   */
  publicWaveEnabled: boolean
  /**
   * 公開観測点（EarthScope の SeedLink）へ揺れていないときも繋いでおくか。**既定はオフ**で、出すときだけ繋ぐ
   * （同 §0。繋ぎっぱなしは 1 日に約 130 MB）。
   */
  publicWaveAlwaysConnected: boolean
  panelRatio: number             // 縦積みレイアウト（スマホ縦など）でのパネル高さ比率（0.2〜0.8）
}

// パネル高さ比率の可動範囲。境界のつまみをドラッグしたときのクランプ幅と、
// localStorage 復元時の sanitize で同じ値を使う（UI とストレージで範囲がずれないようにする）。
export const PANEL_RATIO_MIN = 0.2
export const PANEL_RATIO_MAX = 0.8

/**
 * 夜側の濃さの範囲。UI のスライダーと localStorage 復元時の丸めで同じ値を使う。
 *
 * **上限を 1 にしないこと。** 1 段あたりの濃さは全体の濃さから段数で逆算するため、1 では各段が
 * 不透明になり、一番外側の段でいきなり最大の濃さに達してグラデーションが消える。
 */
export const DAY_NIGHT_OPACITY_MIN = 0.2
export const DAY_NIGHT_OPACITY_MAX = 0.95

// 通常版とDMDSS版の設定を localStorage 上で分離する
const STORAGE_KEY = isDmdss
  ? 'quake-viewer-settings-dmdss'
  : 'quake-viewer-settings'

/**
 * 設定の既定値。
 *
 * **テストから参照してよい。** 設定の一部だけを書いたオブジェクトを `as unknown as AppSettings`
 * でキャストすると、後から項目を足したときに `undefined` のまま実装へ渡り、**その項目に限って
 * 型が保証しているはずの既定値が効かない**。`{ ...DEFAULTS, 上書きしたいもの }` と書けば、
 * 項目が増えても既定の挙動から始まる。
 */
export const DEFAULTS: AppSettings = {
  minDisplayScale: -1,
  // **地震情報の通知は既定で震度3以上**（2026-10-30 ユーザー選択「震度3以上 (Recommended)」。震度速報 VXSE51 の
  // 発表基準に揃える）。実際に出るのは利用者が通知を許可してから。保存した値はそのまま勝つ（最低震度 -1 を読み替えた端末の戻り先はこの既定）。
  notifyEnabled: true,
  notifyQuake: true,
  notifyMinScale: 30,
  actionChecklistEnabled: true,
  actionChecklistMinScale: 45,
  soundEnabled: true,
  soundVolume: 1.0,
  nankaiCommentaryAlerts: true,
  quakeNoticeBanner: true,
  // 既定でオフ（2026-10-23 選択「今のまま記録する (Recommended)」）。
  quakeNoticeAlerts: false,
  kyoshinDetectSpeech: false,
  uiScale: 1,
  mapIconScale: 1,
  hypocenterDepthScale: 1,
  showBathymetry: true,
  showActiveFaults: true,
  activeFaultOpacity: 0.4,
  // 既定でオフ（2026-10-23 選択「今のまま記録する (Recommended)」）。
  showQuakeHeatmap: false,
  // 既定は 30 日（2026-10-25 ユーザー選択「E の案でよい (Recommended)」）。
  heatmapPeriod: DEFAULT_HEATMAP_PERIOD,
  showPlateBoundaries: true,
  showMapLegend: true,
  shareCardFormat: 'wide16x9',
  // 既定は画面任せ。**利用者が一度も触っていない状態を表す値**で、`true`/`false` を初期値に
  // すると狭い画面と広い画面のどちらかで必ず具合が悪くなる。
  mapLegendCollapsed: 'auto',
  showDayNight: true,
  // 下げると海の上で効かなくなる（ベースマップの海がもともと濃紺のため）。上げると夜側の陸地と
  // 海底地形が読めなくなる。掛かるのは地形だけで、境界線・震度の面・観測点はこのレイヤーより
  // 前面にあるため（gl/layerOrder.ts）、濃くしても地震の情報は沈まない。
  // 既定は控えめに置き、はっきり暗くしたい場合はスライダーで上げてもらう。
  dayNightOpacity: 0.5,
  defaultTab: 'earthquake',
  tsunamiPriorityDefault: true,
  tsunamiTitleTemporary: false,
  idleRevertSec: 30,
  periodicReloadHours: 1,
  recordingMode: false,
  notifyEEW: true,
  notifyTsunami: true,
  // 揺れ検知の通知は既定でオフ（2026-10-23 選択「今のまま記録する (Recommended)」。検知ベンチの静かな窓 22 本・11.3 時間のうち 2 本で確定まで進んだ）。
  notifyDetection: false,
  notifyNankai: true,
  homeLat: null,
  homeLng: null,
  arrivalToken: '',
  dmdataApiKey: '',
  dmdataTestDelivery: false,
  voicevoxEnabled: false,
  voicevoxUrl: 'http://localhost:50021',
  voicevoxSpeakerId: 0,
  ttsIntensityLevels: 2,
  ttsMaxRegions: 10,
  ttsAlwaysReadScale: 30,
  // **既定は階級1（＝観測した階級をすべて読む）。** 「設定を入れる前の挙動」には揃えない ——
  // 前の挙動は上位 3 階級で切れ、4 階級そろった報で階級 1 の地域が声に出なかった（それを直す設定）。
  ttsAlwaysReadLpgmClass: 1,
  ttsRegionTolerance: 2,
  // **気象庁の発表文は既定で読む**（2026-10-30 ユーザー選択「発表文を既定で読む (Recommended)」。それまでは
  // 「この設定を入れる前の挙動」に揃えて既定でオフだった）。南海トラフ地震関連解説情報の本文も既定で読む。
  // 定型文 5 種（参考情報を含む）は下の `ttsTelegramBoilerplate` が既定で落とすので、読まないまま。
  // 保存した値はそのまま勝つ（この項目を持たない古い保存だけが新しい既定になる）。
  ttsReadTelegramText: true,
  // **全ブロックを読む。** マスタートグル（`ttsReadTelegramText`）が入っていれば
  // 「気象庁の発表文を読む」のだから、内訳の既定は全部読む側へ倒す。
  ttsTelegramTextBlocks: Object.fromEntries(
    TELEGRAM_TEXT_BLOCK_KEYS.map(key => [key, true]),
  ) as TelegramTextBlocks,
  // **既定は落とす側。** 理由は定義側（`TELEGRAM_BOILERPLATE_DEFAULT_READS`）に書いた。
  ttsTelegramBoilerplate: TELEGRAM_BOILERPLATE_DEFAULT_READS,
  // 以下 4 項目（`ttsUnreceivedDetail`・`ttsMaxObservationPoints`・`ttsReadHypocenterDetail`・
  // `ttsReadEewLpgmClass`）の既定は「この設定を入れる前の挙動」に揃えてある。既存の利用者の耳に
  // 届く内容を、設定を足しただけで変えないため。
  ttsUnreceivedDetail: 'stations',
  // 既定 5 件（設定で 0〜20）は 2026-10-21 ユーザー選択「今のまま記録する (Recommended)」
  ttsMaxObservationPoints: 5,
  ttsReadHypocenterDetail: true,
  ttsReadEewLpgmClass: true,
  // **この 1 つだけ「入れる前の挙動」に揃えていない。** 上の 4 つは既にある読み上げの詳しさを
  // 選ぶ項目なので既定を変えないが、これは新しく足す発話で、しかも「予想値の読み上げを
  // 遅らせる」ことが目的。既定で切っておくと、目的そのものが誰にも届かない。
  ttsReadEewWarningRegions: true,
  // 自作地震計は既定で無効。**URL の既定値も置かない** —— 繋ぎ先は端末ごとに違う。
  seismoEnabled: false,
  seismoHostUrl: '',
  // **波形は既定で「揺れたときだけ」**（2026-10-23 選択「既定を「揺れたときだけ」にする」）。合成波形は毎秒 15 KB
  // （1 日約 1.3 GB）を受け取り続けるので、設定の窓の注記にその量を出す。自作地震計そのものが既定で無効なので、
  // 繋いでいない端末では何も受け取らない。保存済みの「表示しない」は変えない。
  seismoWave: 'auto',
  seismoWaveCollapsedView: 'composite',
  seismoWaveExpanded: false,
  waveSpanSec: DEFAULT_WAVE_SPAN_SEC,
  publicWaveEnabled: true,
  publicWaveAlwaysConnected: false,
  panelRatio: 0.45,
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function ensureBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function ensureString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function ensureDefaultTab(value: unknown, fallback: DefaultTabSetting): DefaultTabSetting {
  return value === 'earthquake' || value === 'realtime' ? value : fallback
}

function ensureMapLegendCollapse(value: unknown, fallback: MapLegendCollapseSetting): MapLegendCollapseSetting {
  return value === 'auto' || value === 'open' || value === 'collapsed' ? value : fallback
}

function ensureShareCardFormat(value: unknown, fallback: ShareCardFormatId): ShareCardFormatId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SHARE_CARD_FORMATS, value) ? value as ShareCardFormatId : fallback
}

function ensureSeismoWave(value: unknown, fallback: SeismoWaveMode): SeismoWaveMode {
  return value === 'off' || value === 'auto' || value === 'always' ? value : fallback
}

function ensureSeismoWaveCollapsedView(value: unknown, fallback: SeismoWaveCollapsedView): SeismoWaveCollapsedView {
  return value === 'composite' || value === 'overlay' ? value : fallback
}

function ensureUnreceivedDetail(value: unknown, fallback: TtsUnreceivedDetail): TtsUnreceivedDetail {
  return value === 'stations' || value === 'areas' || value === 'none' ? value : fallback
}

/**
 * 気象庁の文のブロック指定を整える。
 *
 * **キーの一覧から作り直す** —— 保存された値をそのまま採ると、①後から足したキーが欠けたまま
 * 残り ②消したキーが居座り ③真偽でない値が入り込む。欠けたキーは既定（読む）で埋める。
 */
function ensureTelegramTextBlocks(value: unknown): TelegramTextBlocks {
  const saved = (value ?? {}) as Partial<Record<TelegramTextBlockKey, unknown>>
  return Object.fromEntries(
    TELEGRAM_TEXT_BLOCK_KEYS.map(key => [
      key,
      ensureBool(saved[key], DEFAULTS.ttsTelegramTextBlocks[key]),
    ]),
  ) as TelegramTextBlocks
}

/**
 * 定型文の読み上げ指定を整える。**隣の `ensureTelegramTextBlocks` と同じ作り**で、
 * 欠けたキーは既定（落とす）で埋める。
 */
function ensureTelegramBoilerplate(value: unknown): TelegramBoilerplateReads {
  const saved = (value ?? {}) as Partial<Record<TelegramBoilerplateKey, unknown>>
  return Object.fromEntries(
    TELEGRAM_BOILERPLATE_KEYS.map(key => [
      key,
      ensureBool(saved[key], DEFAULTS.ttsTelegramBoilerplate[key]),
    ]),
  ) as TelegramBoilerplateReads
}

// 震度は気象庁の階級値（10/20/30/40/45/50/55/60/70）と、無効を表す -1 しか取らない。
// 範囲だけを見ると 35 のような中間値が通り、設定画面の震度バッジが「不明」になる
// （getIntensityLabel が該当ラベルを持たないため）。判定自体は数値比較で動き続けるので
// 表示だけが壊れて原因を追えない。階級値でなければ既定値へ落とす。
//
// 範囲外の値をクランプせず既定値へ落とすため、notifyMinScale では「震度7以上のみ通知」ではなく
// 既定の最低震度に倒れる。無言で通知の範囲が変わると原因を追えないので、値があるのに弾いた
// ときだけログに残す（未設定は初回起動・項目追加時に必ず通るため対象外）。
function ensureIntensityScale(value: unknown, fallback: number, key: string): number {
  if (typeof value === 'number' && isValidIntensityScale(value)) return value
  if (value !== undefined) {
    log.warn(`[settings] ${key} が気象庁の震度階級値でないため既定値（${fallback}）に戻した`, value)
  }
  return fallback
}

/** 必ず読む長周期地震動階級。0〜4 か -1（無効）だけを通す。 */
function ensureAlwaysReadLpgmClass(value: unknown, fallback: number): number {
  if (value === -1 || (typeof value === 'number' && isObservedLpgmClass(value))) return value
  if (value !== undefined) {
    log.warn(`[settings] ttsAlwaysReadLpgmClass が長周期地震動階級（0〜4）でも無効（-1）でもないため既定値（${fallback}）に戻した`, value)
  }
  return fallback
}

function clampNumberOrNull(value: unknown, min: number, max: number): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(max, Math.max(min, value))
}

// 壊れた JSON・型不一致・範囲外の値は既定値に落とす（不正な localStorage で App がクラッシュしない
// ようにするための境界防御。基本は型と範囲だけを担保し、震度を取る項目のみ階級値かどうかまで見る）。
// export はテスト向け（ランタイムからは load() 経由でのみ使う）。
export function sanitize(partial: Partial<AppSettings>): AppSettings {
  return {
    minDisplayScale: ensureIntensityScale(partial.minDisplayScale, DEFAULTS.minDisplayScale, 'minDisplayScale'),
    notifyEnabled: ensureBool(partial.notifyEnabled, DEFAULTS.notifyEnabled),
    notifyQuake: ensureBool(partial.notifyQuake, DEFAULTS.notifyQuake),
    notifyMinScale: ensureIntensityScale(partial.notifyMinScale, DEFAULTS.notifyMinScale, 'notifyMinScale'),
    actionChecklistEnabled: ensureBool(partial.actionChecklistEnabled, DEFAULTS.actionChecklistEnabled),
    actionChecklistMinScale: ensureIntensityScale(partial.actionChecklistMinScale, DEFAULTS.actionChecklistMinScale, 'actionChecklistMinScale'),
    soundEnabled: ensureBool(partial.soundEnabled, DEFAULTS.soundEnabled),
    soundVolume: clampNumber(partial.soundVolume, 0, 1, DEFAULTS.soundVolume),
    nankaiCommentaryAlerts: ensureBool(partial.nankaiCommentaryAlerts, DEFAULTS.nankaiCommentaryAlerts),
    quakeNoticeBanner: ensureBool(partial.quakeNoticeBanner, DEFAULTS.quakeNoticeBanner),
    quakeNoticeAlerts: ensureBool(partial.quakeNoticeAlerts, DEFAULTS.quakeNoticeAlerts),
    kyoshinDetectSpeech: ensureBool(partial.kyoshinDetectSpeech, DEFAULTS.kyoshinDetectSpeech),
    uiScale: clampNumber(partial.uiScale, 0.5, 3, DEFAULTS.uiScale),
    mapIconScale: clampNumber(partial.mapIconScale, 0.5, 3, DEFAULTS.mapIconScale),
    hypocenterDepthScale: clampNumber(partial.hypocenterDepthScale, 1, 20, DEFAULTS.hypocenterDepthScale),
    showBathymetry: ensureBool(partial.showBathymetry, DEFAULTS.showBathymetry),
    showActiveFaults: ensureBool(partial.showActiveFaults, DEFAULTS.showActiveFaults),
    activeFaultOpacity: clampNumber(partial.activeFaultOpacity, 0.05, 1, DEFAULTS.activeFaultOpacity),
    showQuakeHeatmap: ensureBool(partial.showQuakeHeatmap, DEFAULTS.showQuakeHeatmap),
    heatmapPeriod: isHeatmapPeriod(partial.heatmapPeriod) ? partial.heatmapPeriod : DEFAULTS.heatmapPeriod,
    showPlateBoundaries: ensureBool(partial.showPlateBoundaries, DEFAULTS.showPlateBoundaries),
    showMapLegend: ensureBool(partial.showMapLegend, DEFAULTS.showMapLegend),
    shareCardFormat: ensureShareCardFormat(partial.shareCardFormat, DEFAULTS.shareCardFormat),
    mapLegendCollapsed: ensureMapLegendCollapse(partial.mapLegendCollapsed, DEFAULTS.mapLegendCollapsed),
    showDayNight: ensureBool(partial.showDayNight, DEFAULTS.showDayNight),
    dayNightOpacity: clampNumber(partial.dayNightOpacity, DAY_NIGHT_OPACITY_MIN, DAY_NIGHT_OPACITY_MAX, DEFAULTS.dayNightOpacity),
    defaultTab: ensureDefaultTab(partial.defaultTab, DEFAULTS.defaultTab),
    tsunamiPriorityDefault: ensureBool(partial.tsunamiPriorityDefault, DEFAULTS.tsunamiPriorityDefault),
    tsunamiTitleTemporary: ensureBool(partial.tsunamiTitleTemporary, DEFAULTS.tsunamiTitleTemporary),
    idleRevertSec: clampNumber(partial.idleRevertSec, 0, 3600, DEFAULTS.idleRevertSec),
    periodicReloadHours: clampNumber(partial.periodicReloadHours, 0, 168, DEFAULTS.periodicReloadHours),
    recordingMode: ensureBool(partial.recordingMode, DEFAULTS.recordingMode),
    notifyEEW: ensureBool(partial.notifyEEW, DEFAULTS.notifyEEW),
    notifyTsunami: ensureBool(partial.notifyTsunami, DEFAULTS.notifyTsunami),
    notifyDetection: ensureBool(partial.notifyDetection, DEFAULTS.notifyDetection),
    notifyNankai: ensureBool(partial.notifyNankai, DEFAULTS.notifyNankai),
    homeLat: clampNumberOrNull(partial.homeLat, -90, 90),
    homeLng: clampNumberOrNull(partial.homeLng, -180, 180),
    arrivalToken: ensureString(partial.arrivalToken, DEFAULTS.arrivalToken),
    dmdataApiKey: ensureString(partial.dmdataApiKey, DEFAULTS.dmdataApiKey),
    dmdataTestDelivery: ensureBool(partial.dmdataTestDelivery, DEFAULTS.dmdataTestDelivery),
    voicevoxEnabled: ensureBool(partial.voicevoxEnabled, DEFAULTS.voicevoxEnabled),
    voicevoxUrl: ensureString(partial.voicevoxUrl, DEFAULTS.voicevoxUrl),
    voicevoxSpeakerId: clampNumber(partial.voicevoxSpeakerId, 0, 100000, DEFAULTS.voicevoxSpeakerId),
    ttsIntensityLevels: clampNumber(partial.ttsIntensityLevels, 0, 10, DEFAULTS.ttsIntensityLevels),
    // 地域数は連続量なので、UI の選択肢（最大 20 / 許容 5）を超える値でも表示は破綻しない。
    // sanitize の上限を UI に合わせると選択肢を増やすたび両方直す必要があるため、緩いままにする。
    ttsMaxRegions: clampNumber(partial.ttsMaxRegions, 0, 100, DEFAULTS.ttsMaxRegions),
    ttsAlwaysReadScale: ensureIntensityScale(partial.ttsAlwaysReadScale, DEFAULTS.ttsAlwaysReadScale, 'ttsAlwaysReadScale'),
    ttsAlwaysReadLpgmClass: ensureAlwaysReadLpgmClass(partial.ttsAlwaysReadLpgmClass, DEFAULTS.ttsAlwaysReadLpgmClass),
    ttsRegionTolerance: clampNumber(partial.ttsRegionTolerance, 0, 100, DEFAULTS.ttsRegionTolerance),
    ttsReadTelegramText: ensureBool(partial.ttsReadTelegramText, DEFAULTS.ttsReadTelegramText),
    ttsTelegramTextBlocks: ensureTelegramTextBlocks(partial.ttsTelegramTextBlocks),
    ttsTelegramBoilerplate: ensureTelegramBoilerplate(partial.ttsTelegramBoilerplate),
    ttsUnreceivedDetail: ensureUnreceivedDetail(partial.ttsUnreceivedDetail, DEFAULTS.ttsUnreceivedDetail),
    // `0` は無制限（`ttsMaxRegions` と同じ意味。選抜が `slice(0, maxPoints || Infinity)` を通す）。
    ttsMaxObservationPoints: clampNumber(
      partial.ttsMaxObservationPoints,
      TTS_MAX_OBSERVATION_POINTS_MIN, TTS_MAX_OBSERVATION_POINTS_MAX,
      DEFAULTS.ttsMaxObservationPoints,
    ),
    ttsReadHypocenterDetail: ensureBool(partial.ttsReadHypocenterDetail, DEFAULTS.ttsReadHypocenterDetail),
    ttsReadEewLpgmClass: ensureBool(partial.ttsReadEewLpgmClass, DEFAULTS.ttsReadEewLpgmClass),
    ttsReadEewWarningRegions: ensureBool(partial.ttsReadEewWarningRegions, DEFAULTS.ttsReadEewWarningRegions),
    seismoEnabled: ensureBool(partial.seismoEnabled, DEFAULTS.seismoEnabled),
    // **URL の形をここで検めない。** `voicevoxUrl` と同じ扱いで、文字列として通す
    // ——入力途中の値も保存されるので、ここで弾くと打っている最中に消える。
    // 形の判定は使う側（`isValidSeismoHostUrl`）の仕事。
    seismoHostUrl: ensureString(partial.seismoHostUrl, DEFAULTS.seismoHostUrl),
    seismoWave: ensureSeismoWave(partial.seismoWave, DEFAULTS.seismoWave),
    seismoWaveCollapsedView: ensureSeismoWaveCollapsedView(partial.seismoWaveCollapsedView, DEFAULTS.seismoWaveCollapsedView),
    seismoWaveExpanded: ensureBool(partial.seismoWaveExpanded, DEFAULTS.seismoWaveExpanded),
    waveSpanSec: ensureWaveSpanSec(partial.waveSpanSec, DEFAULTS.waveSpanSec),
    publicWaveEnabled: ensureBool(partial.publicWaveEnabled, DEFAULTS.publicWaveEnabled),
    publicWaveAlwaysConnected: ensureBool(partial.publicWaveAlwaysConnected, DEFAULTS.publicWaveAlwaysConnected),
    panelRatio: clampNumber(partial.panelRatio, PANEL_RATIO_MIN, PANEL_RATIO_MAX, DEFAULTS.panelRatio),
  }
}

/**
 * dev サーバーで自動投入する API キーを決める（検証のたびに設定の窓へ貼り直す手間を省く経路）。
 *
 * 値を渡しているのは vite.config.ts の devApiKeyDefine で、dev サーバー・DMDSS 版・`--host` なし
 * のときだけ define する。ここで重ねて見るのは本番ビルドとテストの 2 つ。
 *   - 本番ビルドでは `DEV` が false に畳まれ、この分岐ごと消える。
 *   - テスト（`MODE === 'test'`）では、vitest が vite.config.ts を読まない独立設定
 *     （vitest.config.ts）なので値がそもそも届かない。届くようになっても `.env.local` を持つ
 *     手元だけテストが落ちないようにする。
 *
 * 判定材料を引数で受けるのはテストのため（実行時は下の devApiKey が実際の値を渡す）。
 */
export function resolveDevApiKey(
  env: { DEV: boolean; MODE: string; DMDATA_API_KEY?: string },
  isDmdssVariant: boolean,
): string | undefined {
  if (!env.DEV || env.MODE === 'test') return undefined
  if (!isDmdssVariant) return undefined
  return env.DMDATA_API_KEY
}

function devApiKey(): string | undefined {
  return resolveDevApiKey(import.meta.env, isDmdss)
}

/**
 * 未設定のときだけ dev の API キーを差し込む。設定の窓で手入力した値は踏み潰さない。
 * 差し込むのは state の初期値だけで、localStorage には保存しない（保存側は stripDevApiKey）。
 *
 * export はテスト向け（ランタイムからは load 内でのみ使う）。
 */
export function injectDevApiKey(settings: AppSettings, key: string | undefined): AppSettings {
  if (!key || settings.dmdataApiKey !== '') return settings
  return { ...settings, dmdataApiKey: key }
}

/**
 * dev サーバーが注入した到達予想トークンを読む。
 *
 * **バリアントを問わない**（API キーと違う点）。トークンが開くのはホーム地点への到達予想で、
 * standard 版・DMDSS 版のどちらにもある機能。注入の可否そのものは
 * `scripts/dev-api-key-gate.ts` の `shouldInjectDevArrivalToken` が判定しており、
 * build には渡らない。
 */
export function resolveDevArrivalToken(env: { DEV: boolean; MODE: string; ARRIVAL_TOKEN?: string }): string | undefined {
  if (!env.DEV || env.MODE === 'test') return undefined
  return env.ARRIVAL_TOKEN
}

function devArrivalToken(): string | undefined {
  return resolveDevArrivalToken(import.meta.env)
}

/**
 * dev サーバーが注入した鍵（API キーと到達予想トークン）。設定の書き出し（`utils/settingsIo.ts`）が
 * 「鍵も含める」を選ばれても、注入値だけは外すために使う —— 利用者が入れた鍵ではなく `.env.local` の値なので、
 * 端末へ保存しない（`settingsToStore`）のと同じ扱いにする。
 */
export function devInjectedKeys(): { apiKey: string | undefined; arrivalToken: string | undefined } {
  return { apiKey: devApiKey(), arrivalToken: devArrivalToken() }
}

/** 未設定のときだけ dev のトークンを差し込む。手入力した値は踏み潰さない。 */
export function injectDevArrivalToken(settings: AppSettings, token: string | undefined): AppSettings {
  if (!token || settings.arrivalToken !== '') return settings
  return { ...settings, arrivalToken: token }
}

/**
 * localStorage へ書き出す形から、dev で自動投入したトークンを外す。
 *
 * 外さないと、トークン欄に触れていなくても注入値が永続化され、以降は手入力と区別できなくなる
 * （`injectDevArrivalToken` は空でない値を上書きしないため、`.env.local` を書き換えても
 * 反映されないブラウザが残る）。API キー側と同じ理由。
 */
export function stripDevArrivalToken(settings: AppSettings, injectedToken: string | undefined): AppSettings {
  if (!injectedToken || settings.arrivalToken !== injectedToken) return settings
  return { ...settings, arrivalToken: '' }
}

/**
 * localStorage へ書き出す形に整える。dev で自動投入したキーは保存しない。
 *
 * updateSetting は変更対象以外も含めた全項目を毎回保存するため、素通しにすると API キー欄に
 * 触れていなくても注入値が永続化される。そうなると以降は手入力と区別できず（injectDevApiKey は
 * 空でない値を上書きしないため）、`.env.local` を書き換えても反映されないブラウザが残る。
 *
 * export はテスト向け（ランタイムからは useSettings 内でのみ使う）。
 */
export function stripDevApiKey(settings: AppSettings, injectedKey: string | undefined): AppSettings {
  if (!injectedKey || settings.dmdataApiKey !== injectedKey) return settings
  return { ...settings, dmdataApiKey: '' }
}

/**
 * 設定の読み込みで localStorage へ書き出す形を決める。
 *
 * `keepApiKey` は「ファイルに明示されていたキーだから、注入値と同じ文字列でも残す」という指示。
 * これが無いと、**利用者がファイルへ書いた値がたまたま dev の注入値と一致したときに黙って消える**。
 *
 * `replaceSettings` の中へ直接書かず関数にしてあるのは、この判断をテストから確かめるため
 * （フック越しだと、テスト環境では注入値が常に `undefined` になり分岐を踏めない）。
 * export はテスト向け（ランタイムからは `replaceSettings` 内でのみ使う）。
 */
export function settingsToStore(
  settings: AppSettings,
  injectedKey: string | undefined,
  keepApiKey: boolean,
  /**
   * dev サーバーが注入したトークン（無ければ `undefined` を明示して渡す）。
   *
   * **省略可にしない。** 渡し忘れると `stripDevArrivalToken` が何も外さず、注入値がそのまま
   * localStorage へ残る —— トークンは「渡した相手だけが使える」ことが前提なので、
   * 永続化されるとその前提が崩れる。`useSWaveCountdown` の `allowOwnCalculation` と同じ扱い。
   */
  injectedArrivalToken: string | undefined,
): AppSettings {
  // **トークンは `keepApiKey` に関わらず外す。** あの指示は「ファイルに明示された API キーを
  // 残す」ためのもので、トークンには対応する指示が無い。外しても次の読み込みで注入し直される。
  const withoutToken = stripDevArrivalToken(settings, injectedArrivalToken)
  return keepApiKey ? withoutToken : stripDevApiKey(withoutToken, injectedKey)
}

// export はテスト向け（ランタイムからは useSettings 内でのみ使う）。
export function load(): AppSettings {
  return injectDevArrivalToken(injectDevApiKey(loadStored(), devApiKey()), devArrivalToken())
}

function loadStored(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULTS
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') {
      log.warn('[settings] localStorage の値が object でないため既定値で復旧', { key: STORAGE_KEY })
      return DEFAULTS
    }
    return migrateStoredSettings(parsed as Partial<AppSettings>, sanitize(parsed as Partial<AppSettings>))
  } catch (e) {
    log.warn('[settings] localStorage の読み込みに失敗、既定値で復旧', e)
    return DEFAULTS
  }
}

/**
 * 緊急地震速報・津波・南海トラフの通知を地震情報の通知から切り離す前に保存された設定を、**一度だけ**移し替える
 * （2026-10-24 ユーザー選択「一度だけ移し替える」）。
 *
 * かつては「ブラウザ通知」（`notifyMinScale` が負）を切ると、緊急地震速報・津波の通知もまとめて止まっていた。
 * 切り離した後もそのまま読むと、通知を全部止めたつもりの端末で、既定オンの緊急地震速報・津波と、新しい南海トラフの
 * 通知が出始める。そこで、**切り離す前の設定（`notifyNankai` を持たない）で地震情報の通知が切ってあれば**、3 つも切る。
 * 読み込みで変えた値は保存しない（保存は利用者が設定を変えたときだけ）ので、保存されるまでは読み込みのたびに同じ移し替えが
 * 走る（結果は同じ）。保存した時点で `notifyNankai` が入るので、以後は効かない（利用者が後から入れ直したものを戻さない）。
 *
 * **`sanitize()` の中では行わない。** 設定ファイルの読み込み（`settingsIo.ts`）は `sanitize()` の結果をファイルの中身と
 * 突き合わせて「読めなかった項目」を出すので、中で値を変えると誤ってそれに数えられる。端末の設定（`loadStored`）と
 * 設定ファイル（`parseSettingsFile`。2026-10-24 ユーザー選択「ファイルにも掛ける (Recommended)」）は、`sanitize()` の後でこれを通す。
 * 揺れ検知の通知（`notifyDetection`）は選んだ範囲に入っていないので変えない（既定はオフ）。
 */
export function migrateDetachedNotifications(stored: Partial<AppSettings>, settings: AppSettings): AppSettings {
  // 地震情報の通知を**切ってあると保存されているとき**だけ（値が無い＝選んでいない設定は、既定のまま読む）
  if (stored.notifyNankai !== undefined || stored.notifyMinScale === undefined || settings.notifyMinScale >= 0) return settings
  if (!settings.notifyEEW && !settings.notifyTsunami && !settings.notifyNankai) return settings
  log.info('[settings] 地震情報の通知を切っていた設定なので、緊急地震速報・津波・南海トラフの通知も切ります（一度だけ）')
  return { ...settings, notifyEEW: false, notifyTsunami: false, notifyNankai: false }
}

/**
 * 「切る」を最低震度の -1 で表していた頃の設定を、入り切りと最低震度に分けて読む（地震情報の通知・行動チェックリスト）。
 *
 * かつては切ると最低震度を -1 に書き換え、入れ直すと決まった値（地震情報は震度4・行動チェックリストは震度5弱）へ
 * 戻していた。そのため、入れ直すと選んでいた最低震度を忘れていた。いまは入り切りを別の値で持つ。
 *
 * - 入り切りの値（`notifyQuake` / `actionChecklistEnabled`）が無い古い設定で、最低震度が -1 なら「切ってある」と読む
 * - 最低震度が -1 のまま残っていれば、既定の最低震度へ戻す（-1 は「切る」の印で、震度ではない）
 *
 * **`sanitize()` の中では行わない**（理由は `migrateDetachedNotifications` と同じ。設定ファイルの「読めなかった項目」を
 * 誤って数える）。読み込んだ値は保存しないので、保存されるまでは読み込みのたびに同じ読み替えが走る（結果は同じ）。
 */
export function migrateScaleToggles(stored: Partial<AppSettings>, settings: AppSettings): AppSettings {
  let next = settings
  // 入り切りが「保存されている」とみなすのは boolean のときだけ。壊れた値は `sanitize()` が既定（入れる）へ
  // 落とすので、それを採ると、-1 で切ってあった設定が黙って「入れる」へ反転する
  if (next.notifyMinScale < 0) {
    const savedToggle = typeof stored.notifyQuake === 'boolean'
    next = { ...next, notifyQuake: savedToggle ? next.notifyQuake : false, notifyMinScale: DEFAULTS.notifyMinScale }
    log.info(`[settings] 地震情報の通知の最低震度が -1 だったので、${savedToggle ? '入り切りは保存された値のまま' : '通知を切ったものとして'}最低震度を既定（${DEFAULTS.notifyMinScale}）へ戻して読む`)
  }
  if (next.actionChecklistMinScale < 0) {
    const savedToggle = typeof stored.actionChecklistEnabled === 'boolean'
    next = { ...next, actionChecklistEnabled: savedToggle ? next.actionChecklistEnabled : false, actionChecklistMinScale: DEFAULTS.actionChecklistMinScale }
    log.info(`[settings] 行動チェックリストの最低震度が -1 だったので、${savedToggle ? '入り切りは保存された値のまま' : '切ったものとして'}最低震度を既定（${DEFAULTS.actionChecklistMinScale}）へ戻して読む`)
  }
  return next
}

/**
 * 保存されていた設定の読み替えを順に掛ける（端末の設定と設定ファイルの両方で使う）。
 *
 * **順序に意味がある。** `migrateDetachedNotifications` は「地震情報の通知を切ってあったか」を最低震度の -1 で見るので、
 * -1 を消す `migrateScaleToggles` より先に掛ける。
 */
export function migrateStoredSettings(stored: Partial<AppSettings>, settings: AppSettings): AppSettings {
  return migrateScaleToggles(stored, migrateDetachedNotifications(stored, settings))
}

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(load)
  // dev で自動投入した値を保存対象から外すために覚えておく（理由は stripDevApiKey）。
  const injectedApiKey = useRef(devApiKey())
  const injectedArrivalToken = useRef(devArrivalToken())

  // useCallback で参照を安定化する（React.memo 化された SettingsTab へ props として
  // 渡されるため、毎レンダー新関数だと memo が破られる）。
  // UI から来る値は、選択肢が限定されているか、型チェックだけで足りる自由入力（URL・API キー）の
  // どちらかなので sanitize を通さない（設定 1 つの変更で全項目を検証し直す必要がない）。
  // localStorage を直接書き換えられた場合は次回起動の load() で正される。
  const updateSetting = useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings(prev => {
      const next = { ...prev, [key]: value }
      try {
        // 保存する形を決める窓口は `settingsToStore` の 1 つに寄せる（`replaceSettings` と共有）。
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settingsToStore(next, injectedApiKey.current, false, injectedArrivalToken.current)))
      } catch (e) {
        // 容量超過・プライベートブラウジング等で保存できないケース。state には反映するので
        // 操作自体は効くが、次回の起動時には既定値へ戻る。無言だと「設定が勝手に戻る」
        // 症状の原因を追えないため、読み込み側（load）と同じくログには残す。
        log.warn('[settings] localStorage への保存に失敗（この変更は次回起動時に失われる）', e)
      }
      return next
    })
  }, [])

  /**
   * 全項目をまとめて差し替える（設定の読み込み用）。
   *
   * `updateSetting` を項目の数だけ呼ぶ形にしない —— 途中の状態が一度ずつ描画へ流れるうえ、
   * 保存も項目の数だけ走る。読み込みは「前の設定を捨てて新しいものにする」操作なので、
   * 1 回で置き換える。
   *
   * **渡す値は `sanitize()` を通したものであること**（`utils/settingsIo.ts` の
   * `parseSettingsFile` が通している）。ここでは検証し直さない。
   *
   * **保存できたかを返す。** `updateSetting` は 1 項目の変更なので黙って記録するだけで済むが、
   * こちらは今の設定を丸ごと捨てて入れ替える操作で、しかも「端末を移す」という保存の成否が
   * いちばん効く場面で使う。失敗を伝えないと、画面は「読み込みました」のまま次回起動で元へ戻る。
   *
   * @param keepApiKey ファイルに明示されていた API キーをそのまま保存する。既定では dev の
   *   注入値と同じ文字列を保存対象から外す（`stripDevApiKey`）が、**利用者がファイルへ書いた値が
   *   たまたま注入値と一致した場合に、書いたはずのキーが黙って消える**。その取り違えを防ぐ。
   * @returns localStorage へ保存できたか。state への反映は失敗時も行う。
   */
  const replaceSettings = useCallback((next: AppSettings, keepApiKey = false): boolean => {
    let persisted = true
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settingsToStore(next, injectedApiKey.current, keepApiKey, injectedArrivalToken.current)))
    } catch (e) {
      log.warn('[settings] localStorage への保存に失敗（この読み込みは次回起動時に失われる）', e)
      persisted = false
    }
    setSettings(next)
    return persisted
  }, [])

  return { settings, updateSetting, replaceSettings }
}
