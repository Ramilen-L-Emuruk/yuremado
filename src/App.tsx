import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useSyncExternalStore, type CSSProperties } from 'react'
import type { MapHandle } from './components/Map/mapTypes'
import { IconNav, type TabId } from './components/IconNav'
import { useMessages, useMessagesRef, usePlaceNames, usePlaceNamesRef } from './i18n/I18nProvider'
import { useApplyLocaleSetting } from './i18n/useApplyLocaleSetting'
import { historicalArchiveLabel } from './utils/historicalArchiveLabel'
import { JA_MESSAGES } from './i18n/messages'
import { LocalizedError, errorText } from './utils/localizedError'
import { ErrorBoundary } from './components/ErrorBoundary'
import {
  TAB_PRIORITY, TAB_HOLD_MS, shouldAcceptAutoTab, decideFollowNow, idleRevertPriority,
  shouldRetakeAfterPreSpeech,
  resolveNonRealtimeTabSource, shouldResetTsunamiScroll, shouldDeferRevertWhileSpeaking,
  type TabHold, type TabPriority, type TabHoldSource, type TabFollowMark,
} from './utils/tabPriority'
import { PanelResizeHandle, PanelWidthHandle } from './components/PanelResizeHandle'
import { MapView, type MapMode } from './components/Map/MapView'
import type { ShakeFocus, MapFocusTarget } from './components/Map/mapTypes'
import { areaPrefIndexOf, getAreaPrefIndexCache, onStationCoordsLoaded, type LatLng } from './utils/stationCoords'
import { MapUpdateTime } from './components/MapUpdateTime'
import { MapDataStatus } from './components/MapDataStatus'
import { MapRenderStatus } from './components/MapRenderStatus'
import { ShareCardButton } from './components/ShareCardButton'
import { useShareCard } from './hooks/useShareCard'
import { usePushSubscription } from './hooks/usePushSubscription'
import { useNotificationOpen } from './hooks/useNotificationOpen'
import { installNotifyQuietVisibilityWatch, installServiceWorkerQuietAnswer, setNotifyQuietWhileOpen } from './services/notifyQuietWhileOpen'
import { SeismoLinkStatus } from './components/SeismoLinkStatus'
import { SeismoOverlay } from './components/SeismoOverlay'
import { useSeismoStation, type SeismoStationState } from './hooks/useSeismoStation'
import { useSeismoQuakeWavesWithStatus, type SeismoQuakeWave } from './hooks/useSeismoQuakeWaves'
import { useSeismoReplay } from './hooks/useSeismoReplay'
import { usePublicQuakeWaves } from './hooks/usePublicQuakeWaves'
import { mergeQuakeWaves } from './utils/mergeQuakeWaves'
import { useQuakeOriginSeconds } from './hooks/useQuakeOriginSeconds'
import { SeismoWaveChart } from './components/SeismoWaveChart'
import { hasWaveChartRows } from './components/SeismoWaveChart/chartRows'
import { useSeismoWaveVisibility } from './hooks/useSeismoWaveVisibility'
import { usePublicWaves } from './hooks/usePublicWaves'
import type { PublicStationMarker } from './components/Map/PublicStationMarkersGL'
import { EarthquakeTab } from './components/EarthquakeTab'
import { RealtimeTab } from './components/RealtimeTab'
import { resetEewForecastChangeSeen } from './utils/eewForecastChangeSeen'
import { useEewSpeakingCard } from './hooks/useEewSpeakingCard'
import { TsunamiTab } from './components/TsunamiTab'
import { SettingsTab } from './components/SettingsTab'
import { SettingsDialog } from './components/SettingsTab/SettingsDialog'
import { prefetchTestData } from './utils/testDataLoader'
import { TelegramTab } from './components/TelegramTab'
import { CatalogTab } from './components/CatalogTab'
import { useHypocenterCatalog } from './hooks/useHypocenterCatalog'
import {
  buildCatalogPointCloud, DEPTH_FILTER_MAX_KM, MAGNITUDE_FILTER_RANGE,
  LATITUDE_FILTER_RANGE, LONGITUDE_FILTER_RANGE,
  CATALOG_REBUILD_DEBOUNCE_MS,
  jstYearOf, jstYearStartMs, jstYearEndMs, catalogPeriodBounds, periodForBounds,
  type CatalogFilter, type CatalogViewOptions, type CatalogPointCloud,
} from './utils/hypocenterCatalogView'
import { SpecialInfoBanner, shareButtonBottomClass, shareButtonRowHeightClass } from './components/SpecialInfoBanner'
import { NO_BAND_ITEMS, useSpecialInfoBanners } from './components/SpecialInfoBanner/useSpecialInfoBanners'
import { MapLegend } from './components/MapLegend'
import { isMapAreaShort } from './components/MapLegend/autoCollapse'
import { buildLegendBlocks, EMPTY_LEGEND_SOURCES, withHeatmapPeriod, heatmapCompletenessNote, type MapLegendSources, type LegendBlock, type LegendHeatmapPeriod } from './components/MapLegend/legendBlocks'
import { formatHeatmapDate, type HeatmapPeriod } from './utils/quakeHeatmap'

import { ActionChecklist } from './components/ActionChecklist'
import { useActionChecklist } from './hooks/useActionChecklist'
import { useNearbyScope } from './hooks/useNearbyScope'
import { useSeismoScope } from './hooks/useSeismoScope'
import { useStationCoords } from './hooks/useStationCoords'
import { useEarthquakes } from './hooks/useEarthquakes'
import { useFetchThrottled } from './hooks/useFetchThrottled'
import { DEFAULTS as SETTINGS_DEFAULTS, SETTINGS_STORAGE_KEY, useSettings } from './hooks/useSettings'
import { waveStackLayout } from './utils/waveStackLayout'
import { useMediaQuery } from './hooks/useMediaQuery'
import { PANEL_WIDTH_DEFAULT_NARROW_REM, PANEL_WIDTH_DEFAULT_SIDE_REM, SIDE_NARROW_QUERY, panelWidthCss } from './utils/panelWidth'
import { useAlertTitle, resolveAlertTitle } from './hooks/useAlertTitle'
import { useReloadSchedule } from './hooks/useReloadSchedule'
import { AppUpdateBadge } from './components/AppUpdateBadge'
import { useLiveEventHandler, ttsRegionOptions } from './hooks/useLiveEventHandler'
import { useSpeechPrefetch } from './hooks/useSpeechPrefetch'
import { useTimeSignal } from './hooks/useTimeSignal'
import { useUnreceivedSpeechFollow } from './hooks/useUnreceivedSpeechFollow'
import { useBorrowedHypocenterFollow, type BorrowedHypocenterShowResult } from './hooks/useBorrowedHypocenterFollow'
import { useKyoshinAlerts } from './hooks/useKyoshinAlerts'
import { useKyoshinRealtime } from './hooks/useKyoshinRealtime'
import { useKyoshinDetectorV2 } from './hooks/useKyoshinDetectorV2'
import { useKyoshinMissingHold } from './hooks/useKyoshinMissingHold'
import { useDetectionDiagnostics } from './hooks/useDetectionDiagnostics'
import { createSpeechFollowController, telegramTextSubject, type SpeechFollowSession } from './utils/ttsFollow'
import { useTelegramTextSpeechFollow } from './hooks/useTelegramTextSpeechFollow'
import { deriveKyoshinView } from './utils/kyoshinDetectionView'
import { createReonsetState, keyLatLng, stepReonset } from './utils/kyoshinReonset'
import { filterSubThresholdIndices } from './utils/kyoshinSubThresholdFilter'
import { countdownBeepTarget, useSWaveCountdown } from './hooks/useSWaveCountdown'
import { pickArrivalEews, pickPublicWaveEews } from './utils/countdownEew'
import { useArrivalTokenCheck } from './hooks/useArrivalToken'
import { usePsWaveCalc } from './hooks/usePsWaveCalc'
import { useQuakeHeatmap } from './hooks/useQuakeHeatmap'
import { useDebouncedValue } from './hooks/useDebouncedValue'
import { collectQuakesToNotify, quakeCancelToNotify, scheduleQuakeCancelNotification, scheduleQuakeNotification, type QuakeNotification, type QuakeNotifiedState } from './utils/quakeNotification'
import { formatDateTimeLocal } from './utils/formatters'
import { computeEEWLevel, eewEventKey, eewMaxLpgmClass } from './utils/eew'
import { createDetectionSpreadLog } from './utils/eewSpreadHold'
import { quakeEventKey, quakeKeyForLpgmEventId, extractQuakeEventId, sameQuakeEntry } from './utils/quakeMerge'
import type { LpgmSectionFocus } from './utils/quakeCardScroll'
import { canOpenLpgmNotes } from './utils/lpgm'
import { estimatedIntensityFor, matchEstimatedIntensityArrival } from './utils/estimatedIntensity'
import { quakeHistoryEntries, quakeHistoryView, type QuakeHistoryInputs } from './utils/quakeReportHistory'
import {
  type QuakeOverlay, toggleLpgmOverlay, toggleDistributionOverlay, toggleUnreceivedOverlay,
  openDistributionOverlay, openLpgmOverlay,
  closeLpgmOverlay, closeEewLpgmOverlay, closeUnreceivedOverlay, closeUnreceivedOverlayFor,
  closeDistributionOverlayOnQuakeReport,
  decideUnreceivedSpeechOpen, shouldCloseOverlayOnSelection, type UnreceivedOpenResult,
  quakeOverlayChangeLog,
} from './utils/quakeOverlay'
import { findEndedTsunami, isTsunamiForecastOnly, tsunamiOverallGrade } from './utils/tsunami'
import {
  passesQuakeListFilter, quakeListFilterOf, quakeListFilterSettings, quakeListSortOf, keepIfSame, withLatestPinned, wantsAttachedTypes, quakeListMatchedCount,
  type QuakeFilterContext, type QuakeAttachedType, type QuakeListFilter, type QuakeListSort,
} from './utils/quakeListView'
import { useMinuteClock } from './hooks/useMinuteClock'
import { internationalTsunamiIndex, withInternationalTsunamiCards, NO_INTERNATIONAL_TSUNAMIS } from './utils/internationalTsunami'
import { playCountdownBeep, unlockAudio, setSoundVolume, setKeepAliveEnabled } from './utils/alertSound'
import { loadTtsPhraseBreakDict } from './utils/ttsPhraseBreakDict'
import { loadTtsStationReadings } from './utils/ttsStationReadings'
import { loadTtsEpicenterAccents } from './utils/ttsEpicenterAccents'
import { warmFixedPhrases, isValidVoicevoxUrl, VOICEVOX_URL_DEBOUNCE_MS, isSpeaking, msSinceAudible, onSpeechIdle, setSpeechSynthBudgetRelaxed, setSpeechVoice, clearVoicevoxDown } from './utils/voicevox'
import { unlockSystemSpeech } from './utils/systemSpeech'
import { EEW_LEAD_PHRASES } from './utils/ttsText'
import type { EEWAlert, JMAQuake, JMATsunami, LiveEvent, LiveEventMeta } from './types/earthquake'
import { useReplayController, WINDOW_MS as REPLAY_WINDOW_MS, PRE_WINDOW_MS as REPLAY_PRE_WINDOW_MS, type ReplayFetchPurpose } from './hooks/useReplayController'
import { fetchDmdataReplayEvents, fetchDmdataReplayInitialEvents, fetchDmdataQuakeHistoryFor, clearReplayCache, HISTORY_WINDOW_DAYS } from './services/dmdataReplay'
import { relayRestEndpoint, relayTokenStore } from './services/relayEndpoint'
import {
  browserUsageEnv, buildUsageReportNow, countUsage, flushUsage, markUsageConsentAnswered, setUsageCounting, syncInstallIdSafely,
  USAGE_FLUSH_INTERVAL_MS, usageConsentAnswered, usageCounter, type UsageSettingsFlags, usageSettingValues, markPrefsSentSafely, withUsageCount,
} from './services/usageStats'
import { UsageConsentDialog } from './components/UsageConsentDialog'
import { QuakeReplayConfirmDialog } from './components/QuakeReplayConfirmDialog'
import { useForecastKeyCheck } from './hooks/useForecastKey'
import { relayRestClassifications, restSources } from './services/dmdataClassifications'
import { dmdataKeyEndpoint } from './services/dmdataEndpoint'
import { fetchReplayFromSources } from './services/replaySources'
import { isValidDmdataApiKey } from './utils/dmdataApiKey'
import { withFetchWindow, withoutFetchWindow } from './services/replayQuakeHistory'
import type { ReplayQuakeHistoryResult } from './types/replay'
import type { GateTag } from './utils/requestGate'
import { findCoveringArchiveSync, findArchiveJustEndedSync, uncollectedFetchVerdict, emptyReplayFetchResult, fetchLocalArchiveEvents, fetchLocalArchiveQuakeHistory } from './services/localArchiveReplay'
import { useHistoricalArchiveIndex } from './hooks/useHistoricalArchiveIndex'
import { log } from './utils/logger'
import { quakeReplayStartMs } from './utils/quakeReplayStart'
import { deliverBrowserNotification, NOTIFICATION_ICON, notificationData, notificationWouldShow, showTestBrowserNotification } from './utils/notifications'
import { setReplayOffset as setClockReplayOffset, serverDate, serverNow } from './utils/clock'
import { isHistoryCardShown, jstDayOf, periodDayRange, quakeCardDays } from './utils/historyDays'
import { recordReplayEvent, drainReplayEvents, peekReplayEvents } from './utils/replayEventLog'
import { isLiveFeedHalted } from './utils/connectionStatus'
import { ROOT_FRAME_CLASS, ROOT_FRAME_TOP_INSET } from './rootFrame'
import { SHARE_CARD_FORMATS } from './utils/shareCard'
import { effectiveNotifyMinScale, notificationRegionAllowed } from './utils/notificationGate'
import { noIntensityQuakeHiddenByRegion, quakePrefectures } from './utils/notificationRegions'
import { AlertDock } from './components/AlertDock'
import { buildEewDockItems, buildTsunamiDockItem, homePrefectureCode } from './utils/alertDock'
import { usePrefectures } from './hooks/usePrefectures'
import { PREFECTURES } from './data/prefectureCodes'
import { TSUNAMI_ZONE_PREFECTURES } from './data/tsunamiZonePrefectures'

/** 凡例を切っているときに渡す空の組。**同一参照を使い回す**（毎回作ると共有カードの ref 更新が空回りする）。 */
const EMPTY_LEGEND_BLOCKS: LegendBlock[] = []
/** 下端の波形に自作地震計を出さないときに渡す空の組。同一参照を使い回す（毎回作ると波形の枠が描き直される）。 */
const EMPTY_SEISMO_STATIONS: readonly SeismoStationState[] = []

// 平常時のウィンドウタイトル（index.html の <title> と一致させる）。
// AutoHotKey 等が、情報更新時のタイトル変化を検知してイベントを発火できるようにする。
// 版を 1 つにまとめたので「揺れ窓」に揃える（docs/relay-server-design.md §0 の 2026-10-31 の行）。
const DEFAULT_TITLE = '揺れ窓'

// siteConfigId 切替直後に kyoshin.sites / kyoshin.indices の siteConfigId が揃うまで
// 下流へ渡す代替として使う空配列（毎レンダー新規生成しないようモジュール定数で共有）。
// 空配列を freeze せず可変配列として扱っているのは既存 SiteCoords 型定義が可変配列のため。
const EMPTY_SITES: [number, number][] = []
const EMPTY_INDICES: number[] = []
/** 降ろした検知が無いときに RealtimeTab へ渡す空の並び（参照を保って memo を効かせる）。 */
// 公開観測点の波形を出していないときに地図へ渡す空の印（毎回の新しい配列で地図の印を作り直させない）。
const NO_PUBLIC_STATIONS: readonly PublicStationMarker[] = []

// 地図の上の隅の列と、その下から始める行動チェックリストの帯の隙間（px）。
const TOP_CORNERS_GAP_PX = 12

// APIキーの入力が落ち着いたと見なすまでの待ち時間(ms)。手入力の打鍵間隔より長く、
// 貼り付け後の接続開始が待たされたと感じない程度に短く。
const API_KEY_DEBOUNCE_MS = 800

// 各タブのスクロール領域に共通で当てるクラス。パネルは縦一列の表示で横スクロールを想定しない。
// overflow-y だけを auto にすると CSS 仕様で overflow-x の visible も auto に格上げされるため、
// 中身が数 px でもはみ出すと指で左右に動いてしまう（パネル幅が最も狭い sideNarrow＝スマホ横で
// 顕在化する）。overflow-x-hidden で塞ぎ、overscroll-x-none で iOS の横ラバーバンドも止める。
const TAB_SCROLLER_CLASS = 'absolute inset-0 overflow-y-auto overflow-x-hidden overscroll-x-none'


/**
 * 地震情報のブラウザ通知を出す。出せなければ reject する（呼び出し側が「出せなかった」と記録し、通知済みを取り消す）。
 * **置き換えでも知らせ直す**（`renotify`）。同じ地震の前の通知が残っていると、付けなければ黙って差し替わる
 * （2026-10-26 ユーザー選択「カードが採った続報すべて (Recommended)」）。受け付けないブラウザの扱いは
 * {@link deliverBrowserNotification}。
 */
async function showQuakeNotification(n: QuakeNotification): Promise<boolean> {
  // 出たか（許可があり、「アプリを開いている間は通知しない」で止まらないか）は出す前に読む（→ `scheduleQuakeNotification`）
  const shown = notificationWouldShow()
  await deliverBrowserNotification(n.title, { body: n.body, icon: NOTIFICATION_ICON, tag: n.tag, renotify: true, data: notificationData(n.open) })
  return shown
}

/** 長周期の節を見せる求めが、紐づく地震カードを待つ上限（→ App の引き当ての effect）。 */
const LPGM_FOCUS_WAIT_MS = 10_000

export function App() {
  const { settings, updateSetting, updateSettings, replaceSettings, adoptExternalSetting } = useSettings()
  // 各画面が落ちたときの表示に出す画面の名前（ナビのボタン名と同じ辞書の語）
  const messages = useMessages()
  // 帯に載せる地名を表示する言語へ訳す表（日本語のときはそのまま返す）
  const placeNames = usePlaceNames()
  // 後から呼ばれる組み立て（地震情報の通知の待ち行列）が、呼ばれた時点の言語の辞書を読むための参照
  const messagesRef = useMessagesRef()
  // 同じく、通知の本文の地名を呼ばれた時点の言語で訳すための参照
  const placeNamesRef = usePlaceNamesRef()
  const tabNames = messages.nav
  // 設定の言語を画面へ渡す（端末に合わせるときは、端末の言語の変化も追う）
  useApplyLocaleSetting(settings.locale)
  // プッシュ通知の購読を設定に合わせる（docs/relay-server-design.md §6.7）
  usePushSubscription(settings)
  // 設定「アプリを開いている間は通知しない」を、通知の出し口・中継への名乗り・Service Worker の問いへ渡す
  // （→ services/notifyQuietWhileOpen.ts）
  useEffect(() => { setNotifyQuietWhileOpen(settings.notifyQuietWhileOpen) }, [settings.notifyQuietWhileOpen])
  useEffect(() => installServiceWorkerQuietAnswer(), [])
  useEffect(() => installNotifyQuietVisibilityWatch(), [])
  const [activeTab, setActiveTabState] = useState<TabId>(settings.defaultTab)
  // 津波タブを自動で見せた回数。増えるたびに津波カードのスクロールを先頭へ戻す
  // （増やす条件と理由は `requestAutoTab`）。
  const [tsunamiAutoShowTick, setTsunamiAutoShowTick] = useState(0)
  // パネルの折りたたみ状態。地図を全画面で見るための一時的な状態なので、意図的に設定へ
  // 保存しない（起動直後に情報が見えない状態を作らないため、リロードで必ず展開に戻る）。
  const [panelCollapsed, setPanelCollapsed] = useState(false)
  // 縦積みレイアウト（スマホ縦など）でのパネル高さ比率。ドラッグ中は毎フレームここだけを
  // 更新し、指を離した時点で設定（localStorage）へ保存する。
  const [panelRatio, setPanelRatio] = useState(settings.panelRatio)
  // 左右分割でのパネルの幅（rem・null は既定）。PC とスマホ横で別に持つ（2026-11-05 ユーザー選択
  // 「PC とスマホ横で別々に覚える (Recommended)」）。離した時点でここと設定へ入れる（ドラッグ中は `handlePanelWidthChange`）。
  const [panelWidthSide, setPanelWidthSide] = useState(settings.panelWidthSide)
  const [panelWidthSideNarrow, setPanelWidthSideNarrow] = useState(settings.panelWidthSideNarrow)
  const sideNarrow = useMediaQuery(SIDE_NARROW_QUERY)
  // 保存した値が外から変わったら（設定の読み込み）見せる値も合わせる。つまみを離した時点の保存は
  // 同じ値なので何も起きず、ドラッグ中は保存しないので引き戻されない。
  useEffect(() => { setPanelRatio(settings.panelRatio) }, [settings.panelRatio])
  useEffect(() => { setPanelWidthSide(settings.panelWidthSide) }, [settings.panelWidthSide])
  useEffect(() => { setPanelWidthSideNarrow(settings.panelWidthSideNarrow) }, [settings.panelWidthSideNarrow])
  // 特別情報（南海トラフ臨時情報・後発地震注意情報・関連解説情報）の受信でパネルを一時的に
  // 開いたときの「元の状態」。null = 追跡していない／true = 元は畳んでいた（戻すとき畳む）／
  // false = 元から開いていた（戻すときは何もしない）。
  const [specialInfoPanelHold, setSpecialInfoPanelHold] = useState<boolean | null>(null)
  // タイマー・イベントリスナーのコールバックから最新値を読むための同期（値の代入は毎レンダー）。
  const panelCollapsedRef = useRef(panelCollapsed)
  panelCollapsedRef.current = panelCollapsed
  const specialInfoPanelHoldRef = useRef<boolean | null>(specialInfoPanelHold)
  specialInfoPanelHoldRef.current = specialInfoPanelHold

  // タブ切替は「その内容をユーザーに見せる」意図なので、パネルが折りたたまれていれば必ず展開する。
  // ラッパーにしているのは、activeTab の変化を監視する useEffect では拾えない経路があるため。
  // EEW のレベルアップ・揺れ検知の続報・津波の続報はいずれも「既に表示中のタブ」へ
  // setActiveTab を呼ぶ（値が変わらない）ため、監視型だと畳んだまま気付けない。
  // 以降 App 内の全てのタブ切替（フックへ props で渡すものも含む）はこのラッパーを通す。
  //
  // **この関数を直接呼べるのは `requestAutoTab` だけ**（不変条件）。他から呼ぶと優先度の保持
  // （`tabHoldRef`）を通らず、張るべき保持を張らないまま動いてしまう。実際に配り忘れを 3 箇所
  // 作り、いずれも「画面が別の情報に奪われる」「アイドル復帰が二度と効かない」という
  // 再現しにくい不具合になった。外部フックへ渡すときも必ず優先度を付けた関数を渡すこと。
  /**
   * 最後に「記録した」タブ。**録画ツール向けの記録だけが読む。**
   *
   * `activeTabRef`（最後に描いたタブ）とは別に持つ —— あちらは同じティックで 2 回要求
   * されても値が進まないので、2 回目の記録が「変わっていない」と誤判定する。逆に
   * あちらを要求のたび進めると、それを読んでいる 3 箇所の意味が変わる。
   */
  const recordedTabRef = useRef<TabId>(activeTab)
  /**
   * 設定の窓が開いているか（→ `components/SettingsTab/SettingsDialog.tsx`）。設定はタブではなく窓で、
   * 開いている間も下のタブ（`activeTab`）と地図はそのまま残る。
   *
   * **画面を移すときは必ず閉じる**（下の `setActiveTab`）。自動のタブ移動（警報・揺れ検知・既定タブへの
   * 復帰）とテストボタンは、設定を見ている人からも画面を移す（2026-10-27 ユーザー承認。選んだ選択肢
   * 「窓を閉じて移る (Recommended)」）。
   */
  const [settingsOpen, setSettingsOpen] = useState(false)
  // 写しは `changeSettingsOpen` が先回りで書き、確定した値はここで追いかける。描画のたびに書き戻すと、
  // 窓の開け閉めがまだ載っていない別の更新の描画が、先回りで書いた値を古い値へ戻しうる。
  const settingsOpenRef = useRef(settingsOpen)
  useLayoutEffect(() => {
    settingsOpenRef.current = settingsOpen
  }, [settingsOpen])
  // ナビの歯車。窓を閉じたらフォーカスをここへ戻す（→ `SettingsDialog` の `returnFocusRef`）
  const settingsButtonRef = useRef<HTMLButtonElement>(null)
  /**
   * 設定の窓の開け閉めはここだけを通す。録画ツール向けの記録（`overlay: 'settings'`）を、
   * **実際に変わったときだけ** 1 回残すため。写しの ref をその場で書き換えるのは、同じティックで
   * 2 度呼ばれたとき（自動のタブ移動が続けて来る等）に、描き直しを待たずに 2 度目を「変化なし」と見るため。
   */
  const changeSettingsOpen = useCallback((open: boolean, reason: string) => {
    if (settingsOpenRef.current === open) return
    settingsOpenRef.current = open
    setSettingsOpen(open)
    if (open) countUsage('settings')
    recordReplayEvent({ type: 'overlay', overlay: 'settings', open, reason, subject: null })
  }, [])
  const setActiveTab = useCallback((tab: TabId) => {
    setPanelCollapsed(false)
    // 移動先が今のタブと同じでも閉じる。画面を移す要求は「その画面を見せたい」という要求で、
    // 窓が覆ったままでは見せられない。閉じた理由は後から追えるように残す（開くときの記録と対にする）。
    if (settingsOpenRef.current) log.info(`[tab] 画面を移すので設定の窓を閉じる (移動先=${tab})`)
    changeSettingsOpen(false, '画面の移動')
    // 録画ツール向けの記録（→ `docs/spec/recording-interface-spec.md`）。**実際に変わった
    // ときだけ残す** —— 同じタブへの要求も届くので（保持を張り直す・畳んだパネルを開き直す
    // ために呼ばれる）、そのまま記録すると変化していないものが変化として並ぶ。
    // **記録用の写しは `activeTabRef` と分けて持つ。** あちらは「最後に描いたタブ」で、
    // 津波カードの先頭復帰・畳みトグル・アイドル復帰の 3 箇所が**その意味で**読んでいる。
    // 録画の都合で意味を「最後に要求したタブ」へ変えると、同じティックで 2 回要求された
    // とき、一度も描かれていない中間の値を基準に 3 箇所が判断してしまう。
    if (recordedTabRef.current !== tab) {
      recordReplayEvent({ type: 'tab', tab, prevTab: recordedTabRef.current })
      recordedTabRef.current = tab
    }
    setActiveTabState(tab)
  }, [changeSettingsOpen])
  const [selectedQuakeId, setSelectedQuakeId] = useState<string | null>(null)
  /**
   * 直前に選択していた地震（`selectedQuakeId` と同じ鍵）。**`selectQuake` が「別の地震へ移ったか」を
   * 見るためだけに持つ。**
   *
   * state を `selectQuake` の依存へ入れると関数の参照が毎レンダー変わり、子タブ（`React.memo`）の
   * memo が破れる。そのため前値はここから読む。
   *
   * **選択を変える経路は `selectQuake` に限ること。** `setSelectedQuakeId` を直に呼ぶとこの ref が
   * 取り残され、次の呼び出しで「変わっていない」と誤判定して追加表示（下記 `quakeOverlay`）が居残る。
   */
  const selectedQuakeIdRef = useRef<string | null>(null)
  // 地震カードのユーザー明示選択カウンタ。QuakeFitGL が「明示選択」と「電文更新起点の自動追従」を
  // 区別するために使う（明示選択中はユーザー操作中フラグを無視して強制フィット・
  // CameraFollowsGL.tsx QuakeFitGL 参照）。
  const [quakeSelectionTick, setQuakeSelectionTick] = useState(0)
  // 選択が呼ばれるたびに進む番号（利用者の操作・続報・読み上げのどれでも）。選んだまま畳んだ地震カードは、
  // これが進んだら開き直す（2026-11-03 選択「どれが来ても開き直す (Recommended)」。→ EarthquakeCard の `reopenSignal`）
  const [quakeSelectSeq, setQuakeSelectSeq] = useState(0)
  const [focusedObsName, setFocusedObsName] = useState<{ name: string; ts: number } | null>(null)
  /**
   * カードの一覧の行をクリックしたときの寄り先（地震カードの観測点・県・区域・市町村と、
   * 津波カードの区域名）。
   *
   * **津波の `focusedObsName` とは別に持つ。** あちらは名前で地図側が引く仕組みで、震度観測点と
   * 潮位観測点は名前が衝突しうるため、同じ入れ物に混ぜると互いの点集合から引いてしまう。
   *
   * こちらは座標で渡すので、地震カードと津波カードのどちらから来ても同じ入れ物で扱える
   * （同時に 2 つの寄せ要求は立たない —— 押せるのは表示中のタブの一覧だけ）。
   */
  const [focusedMapTarget, setFocusedMapTarget] = useState<MapFocusTarget | null>(null)
  /**
   * 地震カードに紐づく追加表示（長周期地震動階級／震度分布モード）。null なら何も重ねない。
   * **選択中の地震のものとは限らない**（EEW カードから開いた長周期・引き当てる地震カードが
   * 無い長周期。詳細は `quakeOverlay.ts`）。
   *
   * **同時に 1 つだけなので 1 つの state で持つ。** 排他の理由・鍵の取り方・遷移は
   * [`utils/quakeOverlay.ts`](utils/quakeOverlay.ts)。**前の状態を見て決める遷移（トグル・
   * 条件付きで閉じる）は必ずそこの関数を通すこと** —— 同じ判定を呼び出し側へ散らすと、
   * 一方だけ直したときに排他が崩れる。開くだけ・全部閉じるだけの経路はここで組み立てる。
   */
  const [quakeOverlay, setQuakeOverlayState] = useState<QuakeOverlay | null>(null)
  /**
   * 最後に要求した追加表示。**「最後に描いた値」ではない。**
   *
   * 録画ツール向けの記録は「実際に開いた／閉じたときだけ残す」ので、直前の値が要る。
   * レンダー本体で同期する形にすると**その写しは嘘をつく** —— 受信キューは 1 ティックで
   * 溜まった電文をすべて捌くのに、状態はレンダーまで進まない。同じティックで 2 通目を
   * 捌くときに 1 通目より前の値を見て、画面は 1 度しか動いていないのに記録は 2 行出る。
   * 同じ関数の中で `selectQuake` が先に閉じている場合も同様にずれる。
   */
  const quakeOverlayRef = useRef<QuakeOverlay | null>(null)
  /**
   * 追加表示を書き換える唯一の口。**`setQuakeOverlayState` を直接呼ばないこと**（不変条件）。
   *
   * 写しをここで進めるので、素の setter を使うと写しだけ取り残されて上記の嘘が戻る。
   * 更新関数もここで適用する（React に渡して二度呼ばれると、記録まで二重になる）。
   *
   * **録画ツール向けの記録もここが出す**（→ `docs/spec/recording-interface-spec.md`）。
   * 呼び出し側ごとに「変わったか」を判定して記録する形にしていたが、書き手が 13 あるので
   * **足すたびに抜けた** —— 自動で開く経路だけが記録され、カードのボタンを押した回と
   * 長周期の開閉が丸ごと落ちていた。判定を書き込み口へ寄せれば、経路を足しても漏れない。
   * 呼び出し側に残るのは `reason` を書くことだけで、それは引数が必須なので忘れられない。
   *
   * @param reason 何がきっかけで動いたか（記録に載る短い語）
   * @returns 書き換えの前後（呼び出し側が「実際に動いたか」で分岐したいときに使う）
   */
  const applyQuakeOverlay = useCallback((
    next: QuakeOverlay | null | ((prev: QuakeOverlay | null) => QuakeOverlay | null),
    reason: string,
  ): { before: QuakeOverlay | null, after: QuakeOverlay | null } => {
    const before = quakeOverlayRef.current
    const after = typeof next === 'function' ? next(before) : next
    quakeOverlayRef.current = after
    setQuakeOverlayState(after)
    // 差し替え（別の追加表示へ移る）は「閉じた」「開いた」の 2 件になる（→ `quakeOverlayChangeLog`）。
    // `subject`（どの地震の開閉か）は `quakeOverlayChangeLog` が eventId/eventKey から組む。
    for (const e of quakeOverlayChangeLog(before, after)) {
      recordReplayEvent({ type: 'overlay', overlay: e.overlay, open: e.open, reason, subject: e.subject })
    }
    return { before, after }
  }, [])
  // 参照側（子コンポーネントの props・地図へ渡す値）は従来の 3 つの形で読む。排他は型が担保する。
  const activeLpgmEventId = quakeOverlay?.kind === 'lpgm' ? quakeOverlay.eventId : null
  const activeLpgmSource = quakeOverlay?.kind === 'lpgm' ? quakeOverlay.source : null
  const distributionQuakeKey = quakeOverlay?.kind === 'distribution' ? quakeOverlay.eventKey : null
  const unreceivedQuakeKey = quakeOverlay?.kind === 'unreceived' ? quakeOverlay.eventKey : null
  // 子タブ（React.memo 化済み）へ props として渡すため useCallback で参照を安定化する
  // （毎レンダー再生成すると memo が破られる）。
  //
  // opts.explicit は「ユーザーがカード（や津波→地震リンク）を直接クリックした」ことを示す。
  // 電文受信ハンドラ（useLiveEventHandler）からも新規・続報のたびに selectQuake を呼んで
  // 選択状態を最新カードへ追従させるが、こちらは explicit=false（省略）で呼び、
  // QuakeFitGL に「電文起点の自動更新」として扱わせる（isUserInteracting を尊重）。
  // explicit=true の呼び出しだけが quakeSelectionTick を進め、QuakeFitGL が isUserInteracting
  // を無視して強制フィットする（CameraFollowsGL.tsx の QuakeFitGL 参照）。
  //
  // **受け取るのはカードの `eventKey` で、生電文の `id` ではない。** 引数名でそれを示す ——
  // 選択中カードの導出は `quakeEventKey(q)` と突き合わせるので、`id` を渡すとどのカードにも
  // 一致せず、黙って「一覧の最新カード」へ落ちる（例外もログも出ない）。
  // 選んだときに地震タブの一覧に無かった地震（絞りの例外として一時的に一覧に出す）。通知・津波タブの原因地震の行・読み上げの追従・
  // 国際津波関連情報の受信のように、絞りで隠れた地震へ飛ぶ口はどれも `selectQuake` を通るので、ここで 1 か所で立てる
  // （2026-11-08 選択「例外をやめる (Recommended)」の説明「津波タブなどからその地震へ飛んだときだけは、通知から開いたときと同じくその 1 件を一時的に出す」）。
  // 手で選べるのは一覧に見えている行だけなので、手の操作では立たない。選択が別の地震へ移るか、絞りを変えたら外す（→ 下の effect）
  const [notificationPinKey, setNotificationPinKey] = useState<string | null>(null)
  /**
   * 直近の描画で地震タブの一覧に出ていた地震の鍵と、絞る前の全カードの鍵（`selectQuake` が、隠れた地震を選んだかを見分ける）。
   * **全カードに無い鍵は固定しない** —— 新しく届いた地震は、カードが状態へ入る前に選ばれる。それは最新の 1 枚として必ず出るので、
   * 固定すると受信のたびに一覧を余分に作り直すだけになる
   */
  const shownQuakeKeysRef = useRef<ReadonlySet<string>>(new Set())
  const allQuakeKeysRef = useRef<ReadonlySet<string>>(new Set())
  const selectQuake = useCallback((eventKey: string | null, opts?: { explicit?: boolean }) => {
    if (eventKey !== null && allQuakeKeysRef.current.has(eventKey) && !shownQuakeKeysRef.current.has(eventKey)) setNotificationPinKey(eventKey)
    // **追加表示を閉じるのは、別の地震へ移るときだけ**（判定と理由は `shouldCloseOverlayOnSelection`）。
    const closeOverlay = shouldCloseOverlayOnSelection(selectedQuakeIdRef.current, eventKey)
    selectedQuakeIdRef.current = eventKey
    // 別の地震へ移ったら、長周期の節を見せる求めは捨てる。残すと、後でその地震を選び直したときに
    // カードの頭ではなく長周期の節へ巻く
    // （引き当て前の求めは捨てない。引き当てる側が選択中のカードと照らす。同じ地震の続報が同じ瞬間に
    // 届いて選び直されても、求めを落とさないため）
    setLpgmFocus(f => (f && f.key !== eventKey ? null : f))
    setSelectedQuakeId(eventKey)
    setQuakeSelectSeq(n => n + 1)
    if (closeOverlay) applyQuakeOverlay(null, '別の地震を選んだ')
    if (opts?.explicit) setQuakeSelectionTick(t => t + 1)
  }, [])
  /**
   * 長周期地震動の節を見せる求め（→ `quakeCardScrollTarget`）。長周期地震動観測情報の受信と、長周期の通知を
   * 押したときに、長周期の札を押したときと同じ位置へ巻く（2026-11-06 ユーザー選択「長周期の節へ巻く
   * (Recommended)」「同じく巻く (Recommended)」）。**巻くのは地震タブの中だけ** —— タブは動かさない
   * （受信はタブの追従、通知はタブを移す口がそれぞれ受け持つ）。
   */
  const [lpgmFocus, setLpgmFocus] = useState<LpgmSectionFocus | null>(null)
  /**
   * 求めは電文の `eventId` のまま受け、カードへの引き当ては次の描画で行う（→ 下の引き当ての effect）。
   * **ここで `earthquakesRef` から引かない** —— あの控えは描画のたびに書き換わるので、同じ瞬間に届いた
   * 地震情報（テストの台本や、続けて配られた電文）はまだ載っておらず、カードを引けずに求めを落とす。
   */
  const [lpgmFocusRequest, setLpgmFocusRequest] = useState<{ eventId: string; seq: number; at: number } | null>(null)
  const lpgmFocusSeqRef = useRef(0)
  const focusLpgmSection = useCallback((eventId: string) => {
    lpgmFocusSeqRef.current += 1
    setLpgmFocusRequest({ eventId, seq: lpgmFocusSeqRef.current, at: performance.now() })
  }, [])
  // 地震情報タブ / EEW（リアルタイム）タブそれぞれで長周期の表示をトグルするハンドラー。
  // 同じ eventId を再度渡すと非表示化、それ以外の eventId なら表示中の source を切り替える。
  // 震度分布モードを開いていれば、それは閉じる（同時に 1 つだけ）。
  const toggleLpgm = useCallback((eventId: string, source: 'earthquake' | 'eew') => {
    applyQuakeOverlay(prev => toggleLpgmOverlay(prev, eventId, source), '長周期地震動のボタン')
  }, [])
  /**
   * 地震カードの長周期バッジ。**押したカードを選択の実体へ合わせてからトグルする。**
   *
   * カードが「選択中」に見えていても `selectedQuakeId` は null のことがある —— null のときは
   * 取消でない最新のカードへフォールバックして選択扱いで開くため（→ `selectedQuake` の導出）。
   * 実体が null のまま表示を開くと、**その地震の続報が届いた瞬間に `selectQuake` が
   * 「別の地震へ移った」と判定して閉じる**（起動直後・リプレイ開始直後・取消で選択が解かれた
   * 後がこれに当たる）。
   *
   * 鍵の体系が違うので、電文の `eventId` からカードを引いて `eventKey` へ直す
   * （長周期電文の自動表示と同じ述語）。**カメラは寄せない** —— `explicit` を渡さないので
   * `quakeSelectionTick` は進まない。ボタンは表示を切り替える操作で、画角を動かす合図ではない。
   */
  const toggleLpgmFromEarthquake = useCallback((eventId: string) => {
    const key = quakeKeyForLpgmEventId(earthquakesRef.current, eventId)
    if (key) selectQuake(key)
    toggleLpgm(eventId, 'earthquake')
  }, [toggleLpgm, selectQuake])
  const toggleLpgmFromEew = useCallback((eventId: string) => {
    toggleLpgm(eventId, 'eew')
  }, [toggleLpgm])
  /**
   * 長周期地震動観測情報の受信で階級の表示を開く（`useLiveEventHandler` から呼ぶ）。
   *
   * **`source` は `'earthquake'`。** 地震情報側の表示であって EEW カードから開いたものとは
   * 自動解除の条件が違う（EEW 由来は EEW が消えたら閉じる）。
   */
  const openLpgmFromQuake = useCallback((eventId: string) => {
    applyQuakeOverlay(prev => openLpgmOverlay(prev, eventId, 'earthquake'), '長周期地震動を自動で開いた')
    focusLpgmSection(eventId)
  }, [focusLpgmSection])
  // 長周期・推計の通知を押したとき（→ `useNotificationOpen`）。開き方は受信と同じで、記録の理由だけ分ける。
  // 推計は、通知の側で選んだ地震カードの鍵でそのまま開く（受信の口のように時刻で引き直さない。選んだカードと食い違わないため）
  const openLpgmFromNotification = useCallback((eventId: string) => {
    applyQuakeOverlay(prev => openLpgmOverlay(prev, eventId, 'earthquake'), '長周期地震動の通知を押した')
    focusLpgmSection(eventId)
  }, [focusLpgmSection])
  const openDistributionFromNotification = useCallback((eventKey: string) => {
    applyQuakeOverlay(prev => openDistributionOverlay(prev, eventKey), '推計震度分布図の通知を押した')
  }, [])
  // 震度分布ボタン。こちらは鍵が `eventKey` なのでそのまま渡せる
  // （選択の実体を合わせる理由は `toggleLpgmFromEarthquake`）。
  const toggleDistribution = useCallback((eventKey: string) => {
    selectQuake(eventKey)
    applyQuakeOverlay(prev => toggleDistributionOverlay(prev, eventKey), '震度分布のボタン')
  }, [selectQuake])
  // 未入電ボタン。鍵は分布と同じ `eventKey`。
  const toggleUnreceived = useCallback((eventKey: string) => {
    selectQuake(eventKey)
    applyQuakeOverlay(prev => toggleUnreceivedOverlay(prev, eventKey), '未入電のボタン')
  }, [selectQuake])
  // EEW カードから長周期の表示を閉じる。**分布は触らない** —— 排他なので開いていないが、
  // この操作の意味は「長周期を閉じる」であって追加表示すべてではない。
  const deactivateLpgm = useCallback(() => {
    applyQuakeOverlay(closeLpgmOverlay, '長周期地震動を閉じた')
  }, [])
  // 津波タブで観測点名をクリックしたときにフォーカス対象として通知する。
  const focusTsunamiObs = useCallback((name: string) => {
    setFocusedObsName({ name, ts: Date.now() })
  }, [])
  // カードの一覧の行をクリックしたときに、その場所を地図の寄り先として通知する。
  // 座標の解決はカード側が行う（押せるかどうかの判定と同じ引き当てを使うため）。
  // 1 点なら flyTo、複数点ならその外接矩形へ寄る（→ `FocusTargetGL`）。
  const focusMapTarget = useCallback((positions: LatLng[], stationName: string | null) => {
    setFocusedMapTarget({ positions, stationName, ts: Date.now() })
  }, [])
  // 観測点名を持たない一覧（津波の区域・公開観測点の段）から寄せる口。
  const focusMapPositions = useCallback((positions: LatLng[]) => focusMapTarget(positions, null), [focusMapTarget])
  // EEW 発報中（cancelledAt 除外済み）・揺れ検知フラグ・地震情報リスト・デフォルトタブを
  // タイマーコールバック内やフック間で参照するための ref。
  // 値の確定はレンダー後半（useEarthquakes / useKyoshinDetectorV2 の後）で毎レンダー代入する。
  const activeEEWsRef = useRef<ReadonlyMap<string, EEWAlert>>(new Map())
  const kyoshinDetectedRef = useRef(false)
  const earthquakesRef = useRef<JMAQuake[]>([])
  // 津波リスト（続報判定に使う）。値の確定は下方で毎レンダー tsunamis で更新する。
  const tsunamisRef = useRef<JMATsunami[]>([])
  // 南海トラフ地震臨時情報が発表中か（受信処理が関連解説情報をタイトルに出すかの判定に使う。代入は下）
  const nankaiActiveRef = useRef(false)
  const defaultTabRef = useRef<TabId>(settings.defaultTab)
  // 自動復帰までの時間。**読み上げ中に既定の状態へ戻すのを見送ってよいか**の判定に使う
  // （`shouldDeferRevertWhileSpeaking`）。ref で持つのは、`revertToDefaultTab` を受け取る側
  // （`useKyoshinAlerts` / `useLiveEventHandler`）が依存を絞った effect の中で呼ぶため
  // ——設定の変化で関数が作り直されても、古い値を掴んだままになる。値は毎レンダー同期する。
  const idleRevertSecRef = useRef(settings.idleRevertSec)
  idleRevertSecRef.current = settings.idleRevertSec
  // 表示中のタブ。「同じタブをもう一度押したら折りたたむ」判定に使う。
  // handleTabChange の deps に activeTab を入れると切替のたびに関数の参照が変わり、
  // React.memo 化した IconNav が再レンダーされるため ref で参照する（値は毎レンダー同期）。
  const activeTabRef = useRef<TabId>(activeTab)
  activeTabRef.current = activeTab
  // ウィンドウタイトル（情報タイトル）管理
  const title = useAlertTitle({ activeEEWsRef, kyoshinDetectedRef })
  // WS接続中は現在時刻を毎秒更新して地図上の更新時刻をリアルタイム表示する
  const [nowTick, setNowTick] = useState<Date | null>(null)

  // 自動タブ切替の保持状態。「いつまで」「どの優先度で」確保しているかを持つ。
  // 従来は「非 realtime へ移ったあと 15 秒は EEW 続報に realtime を奪わせない」という
  // 片方向の抑制しか無く、**EEW が確保した realtime を地震情報が即座に奪えていた**
  // （声は EEW を守るのに画面だけ取られる）。優先度付きの保持に一般化してある。
  const tabHoldRef = useRef<TabHold>({ until: 0, priority: TAB_PRIORITY.quake, source: 'hold' })
  // 直前の読み上げ追従の記録。追従が立て続けに走るときの間引きに使う（理由は shouldFollowNow）。
  const lastFollowRef = useRef<TabFollowMark | null>(null)

  /**
   * 自動タブ切替の要求。保持中の優先度より低ければ拒否する（同格以上は移動できる。
   * 新しい情報が勝つという点は読み上げと同じ）。
   *
   * 拒否したときもパネルの折りたたみだけは解除する。保持は「今見せるべきものを守る」ための
   * 仕組みであって、情報を隠したままにするためのものではない。
   *
   * 拒否した切替は後で実行しない。読み上げと違い、画面は「今どこを見せるか」だけの問題で、
   * 遅れて出てきても意味が薄いため（読み上げは待ち行列に載せる）。
   *
   * @returns 実際に移動したか。呼び出し側が「動いたときだけ記録する」ために使う
   *   （拒否のログは本関数が出す。両方で出すと二重になる）。
   *
   * 呼び出し側（`useLiveEventHandler`）は移動の**要求**としてログを出す。ここで拒否されうるため、
   * 「→ タブ名」ではなく「タブ名を要求」と書いてもらっている。ログの 1 行目だけを読んで
   * 「移動した」と誤読しないように。
   */
  const requestAutoTab = useCallback((
    tab: TabId,
    priority: TabPriority,
    // **既定値を置かない。** 駆動源の選択を誤ると、症状は例外もログも出さずに戻る
    // （`'hold'` で出すと EEW 発表中に画面が動かず、`'receipt'` で出すと読み上げ中の EEW から
    // 画面を奪う）。`forceTab` が既定値を撤廃しているのと同じ理由で、全呼び出しに明示させる。
    source: TabHoldSource,
    // **実際に声に出す瞬間の追従か**（`followSpeechTab` だけ true。先出しと受信時要求は false）。
    // 効くのは 2 箇所で、どちらも「いま声になるか」で決まるため 1 つの旗にまとめてある。
    //
    // - **最小滞留時間の床を掛ける。** 受信の瞬間に出す要求（EEW の新規発報・続報）に掛けると、
    //   続報が 1.5 秒未満で連投されたときに保持の張り直しを落とす。床の目的は「無音のまま追従が
    //   連打されるのを抑える」ことで、受信時要求はそもそも連打の原因ではない
    // - **EEW 続報の片方向抑制を素通りする**（`shouldAcceptAutoTab` の判定 3）。抑制が止めたい
    //   のは続報のたび無条件に飛ぶ受信時要求であって、読み上げを奪って喋る追従ではない
    //
    // **用途が分かれる要求が出ても、この旗を割らないこと。** どちらの効果も「いま声になるか」
    // という同じ事実から出ている。片方だけ欲しい要求が現れたら、意味を変えるのではなく別の
    // 引数を足す——ここの意味をこっそり変えると、既存の全電文の挙動が無言で変わる。
    //
    // **既定値は置かない**（`source` と同じ理由）。渡し忘れの症状は「タブが動かない」で、
    // 例外もログも出ない。必須にしておけば、新しい呼び出しを足したときに型が捕まえる。
    follow: boolean,
    // **起動時の復元による要求か。** 判定 3（EEW 続報の片方向抑制）だけを素通りさせる。
    // あの抑制は「続報が連投されて画面が往復する」のを防ぐもので、接続ごとに 1 回きりの
    // 復元には当たらない。**渡し忘れると優先度表が逆転する**——復元の EEW(4) が、先に
    // 完了した津波の保持(3)を越えられなくなる（理由は `shouldAcceptAutoTab` の引数）。
    //
    // **既定値は置かない**（`source`・`follow` と同じ理由）。
    isStartupRestore: boolean,
  ): boolean => {
    const hold = tabHoldRef.current
    const now = Date.now()
    // **床を免除するかは「床と同じ長さの窓に音があったか」で決める**（理由は `shouldFollowNow`）。
    // **`follow` の内側で読むこと** —— 受信時要求・先出しはこの値を使わない。
    const sinceAudible = follow ? msSinceAudible() : null
    const followDecision = follow
      ? decideFollowNow(lastFollowRef.current, priority, now, sinceAudible)
      : 'pass'
    if (followDecision === 'throttle') {
      // **「無音」と言い切らない。** 床が効いたのは「窓の中に音が無い」ことで、その前に鳴って
      // いた可能性はある。実際の経過を出す。
      const audibleNote = sinceAudible === null ? '音の記録なし' : `最後の音から${Math.round(sinceAudible)}ms`
      log.debug(`[tab] → ${tab} 追従を間引き (直前の追従から${now - (lastFollowRef.current?.at ?? 0)}ms・${audibleNote}・駆動${source})`)
      setPanelCollapsed(false)
      return false
    }
    // **追従かどうかもログに残すこと。** 受信時要求・先出し・追従はどれも駆動源が `'speech'` で、
    // 優先度も同じ値を取りうる（EEW の続報は 3 つとも `eewUpdate`）。この印が無いと、拒否の記録を
    // 見ても「受信時要求が抑制で弾かれた（意図どおり）」のか「追従が別の理由で弾かれた（疑わしい）」
    // のかを事後に切り分けられない。
    const followNote = follow ? '・追従' : ''
    if (!shouldAcceptAutoTab(hold, priority, now, source, follow, isStartupRestore)) {
      // **保持の側の駆動源も出すこと。** どの優先度に負けたかだけでは「何がその保持を張ったか」が
      // 分からず、拒否の原因（受信時要求か・手動選択か・アイドル復帰か）を突き合わせられない。
      log.debug(`[tab] → ${tab} スキップ (優先度${priority}・駆動${source}${followNote} < 保持中${hold.priority}・駆動${hold.source}・残り${hold.until - now}ms)`)
      setPanelCollapsed(false)
      return false
    }
    tabHoldRef.current = { until: now + TAB_HOLD_MS, priority, source }
    // **床の読み書きは同じ条件で行うこと**（上の間引き判定と同じ `follow`）。書き込みだけを
    // 広く取ると、床を使わない要求（先出し・EEW の受信時要求）が床を進め、後から実際に声が出る
    // 側の追従を弾く。それは「声は出ているのに画面が動かない」という、この仕組みで直したかった
    // 症状そのもの。実際に踏んだ形: EEW の新規発報が受信時に床を進める → 1.5 秒以内に順番が来た
    // 津波の追従が弾かれ、津波を読んでいるのに画面が realtime に留まる。
    if (follow) lastFollowRef.current = { at: now, priority }
    // 読み上げ系の移動は呼び出し元が名前付きの記録を持たないものがあるため、ここで成立を残す。
    // 拒否だけが記録されて成立が残らないと、ログから「動いたのか何も起きなかったのか」を区別できない。
    //
    // **越えた保持も残すこと。** 「保持が切れていたから通った」のと「生きている保持を突破した」のは
    // 意味が違う。突破できるのは駆動源で名指しした例外だけなので（`shouldAcceptAutoTab`）、
    // 事後にそれが働いたのかを確かめる手掛かりがここに無いと、拒否ログの履歴を遡る作業になる。
    const heldNote = hold.until - now > 0
      ? `・保持中${hold.priority}/${hold.source}を突破`
      : '・保持切れ'
    // **床を音で免除して通ったことも残す。** 「床に掛からなかった」のと意味が違い、この印が
    // 無いと免除が将来効かなくなったときにログから切り分けられない（判定は `decideFollowNow`）。
    const floorNote = followDecision === 'audible' ? '・床を音で免除' : ''
    log.debug(`[tab] → ${tab} 移動 (優先度${priority}・駆動${source}${followNote}${floorNote}${heldNote})`)
    // 特別情報のためにパネルを開いていた場合、**ここでは畳まないが追跡も捨てない。**
    // 畳まないのは、タブ移動が「その内容を見せる」ための展開であり、打ち消すと移動の意味が
    // 無くなるため。追跡を捨てないのは、捨てると畳んだ状態へ戻す機会が二度と来ないため
    // （実際に「畳んで地図を見ている最中に特別情報 → 揺れ検知で自動移動」の順で踏むと、
    // 以後ユーザー操作でもアイドル復帰でも畳めなくなっていた）。
    // **他のタブから自動で連れてきたときだけ、津波カードを先頭から見せる。**
    // 判定は `shouldResetTsunamiScroll` に集約してある（除外する 2 条件の理由もそちら）。
    // **津波カードの先頭復帰はここが唯一の経路。** 復帰系の呼び出しも `forceTab` からここを
    // 通るので、別に要求を出す口を作らないこと。
    if (shouldResetTsunamiScroll(tab, priority, activeTabRef.current)) {
      setTsunamiAutoShowTick(t => t + 1)
    }
    setActiveTab(tab)
    return true
  }, [setActiveTab])

  /**
   * 特別情報（南海トラフ臨時情報・後発地震注意情報・関連解説情報・地震回数に関する情報）の
   * 受信でパネルを開く。
   *
   * **地震・津波に関するお知らせ（VZSE40）だけは呼ばない**（運用連絡なので、画面を組み替えて
   * まで割り込ませない。→ docs/spec/architecture-spec.md §4）。
   *
   * これらは地図に重ねた帯（`SpecialInfoBanner`）で伝える情報で、パネル側に居場所がない。
   * パネルを畳んで地図だけを見ている状態でも気づけるよう、いったん通常の表示に戻す。
   * **元の状態は覚えておき**、ユーザーが何か操作したときとアイドル復帰のときに戻す
   * （戻す実体は `restoreSpecialInfoPanel`）。
   */
  const expandPanelForSpecialInfo = useCallback(() => {
    // **ref の読み取りは updater の外で行う。** updater の中で読むと、React が更新関数を
    // 再実行する場面（開発時の二重呼び出しなど）で「展開後の値」を読んでしまい、
    // 元が畳んだ状態だったことを取り違える（実測: 常に「元から開いていた」と記録されていた）。
    const wasCollapsed = panelCollapsedRef.current
    log.debug(`[panel] 特別情報で展開 (元は${wasCollapsed ? '畳んでいた' : '開いていた'})`)
    // 追跡中に続報が来ても最初の状態を上書きしない（`??` は false を保つ）。
    setSpecialInfoPanelHold(prev => prev ?? wasCollapsed)
    setPanelCollapsed(false)
    // 録画ツール向けの記録。**畳んでいたときだけ画面が動く**（開いていたならそのまま）。
    if (wasCollapsed) {
      recordReplayEvent({ type: 'overlay', overlay: 'specialInfoPanel', open: true, reason: '特別情報の受信', subject: null })
    }
  }, [])

  /** 特別情報のために開いたパネルを元の状態へ戻す（追跡していなければ何もしない）。 */
  const restoreSpecialInfoPanel = useCallback(() => {
    if (specialInfoPanelHoldRef.current === null) return
    log.debug(`[panel] 特別情報の展開を解除 (${specialInfoPanelHoldRef.current ? '畳む' : 'そのまま'})`)
    const collapsing = specialInfoPanelHoldRef.current
    if (collapsing) setPanelCollapsed(true)
    setSpecialInfoPanelHold(null)
    // 録画ツール向けの記録。**畳み直したときだけ**（元から開いていたなら画面は動かない）。
    if (collapsing) {
      recordReplayEvent({ type: 'overlay', overlay: 'specialInfoPanel', open: false, reason: '特別情報の展開を解除', subject: null })
    }
  }, [])

  /**
   * **拒否されない**タブ移動。保持を捨ててから指定の優先度で張り直す。
   *
   * 拒否されてはいけない経路が 2 種類ある。どちらも 1 つの実装に寄せておくこと。
   * 別々に書くと、片方だけ保持の破棄を忘れて「操作しても切り替わらない」という
   * 再現しにくい不具合になる（実際に一度作り込んだ）。
   *
   * - **ユーザー操作**（ナビの選択・津波カードから地震情報へのリンク）。押したのだから必ず動く
   * - **アイドル復帰**。既定の状態へ戻す操作で、拒否されると一発限りのタイマーが再スケジュール
   *   されないため二度と復帰しない。とくに設定「自動復帰までの時間」の 15 秒は `TAB_HOLD_MS` と
   *   一致するため、直前の手動操作と必ず衝突する
   *
   * @param source 移動後に張る保持の駆動源。**既定値を置かず必須にしてある。** 既定の状態へ戻す
   *   経路で `'idleRevert'` を渡し忘れると読み上げ追従を弾く保持になり、「喋っているのに画面が
   *   動かない」が復活する（理由は `shouldAcceptAutoTab`）。省略できる形にすると、次に復帰経路を
   *   足す人が既定値のまま通してしまい、型でも実行時でも気づけない
   */
  const forceTab = useCallback((tab: TabId, priority: TabPriority, source: TabHoldSource) => {
    tabHoldRef.current = { until: 0, priority: TAB_PRIORITY.quake, source: 'hold' }
    // 追従ではない。ユーザー操作と既定の状態への復帰はどちらも「いま声になる」経路ではない
    requestAutoTab(tab, priority, source, false, false)
  }, [requestAutoTab])

  /**
   * 揺れ検知（強震モニタ）による realtime 移動。地震情報・長周期地震動情報には奪われず、
   * 津波・EEW には譲る。`useKyoshinAlerts` と `useLiveEventHandler`（EEW 全解除後に揺れ検知が
   * 続いている経路）の両方がここを通る。**生の `setActiveTab` を渡してはいけない**。
   */
  const requestTabForKyoshin = useCallback((tab: TabId) => {
    // 駆動源は `'hold'`。**`'receipt'` にしない** ——揺れ検知も読み上げを持たない経路だが、
    // 移動先が realtime で、EEW の保持中はすでに realtime を出しているため越える必要がない。
    requestAutoTab(tab, TAB_PRIORITY.kyoshin, 'hold', false, false)
  }, [requestAutoTab])

  /** ユーザー操作によるタブ移動。以後 TAB_HOLD_MS は自動切替に奪わせない。 */
  const setActiveTabByUser = useCallback((tab: TabId) => {
    forceTab(tab, TAB_PRIORITY.manual, 'hold')
  }, [forceTab])

  /**
   * ナビの歯車。設定の窓を開け閉めする。
   *
   * **開くときは手動のタブ選択と同じ保持（`TAB_PRIORITY.manual`）を張る**（タブを移さずに）。開いた直後に
   * 届いた地震情報などが、窓を閉じて画面を奪わないため。保持より強い要求（EEW の新規発報など）は
   * 窓を閉じて画面を移す。
   */
  const toggleSettings = useCallback(() => {
    if (settingsOpenRef.current) {
      changeSettingsOpen(false, '歯車')
      return
    }
    log.info('[tab] 設定の窓を開く (手動選択)')
    tabHoldRef.current = { until: Date.now() + TAB_HOLD_MS, priority: TAB_PRIORITY.manual, source: 'hold' }
    changeSettingsOpen(true, '歯車')
  }, [changeSettingsOpen])
  // ×・Esc・窓の外（→ `SettingsDialog`）
  const closeSettings = useCallback(() => changeSettingsOpen(false, '閉じる操作'), [changeSettingsOpen])

  // 地震情報・長周期地震動情報・津波の受信によるタブ移動（`useLiveEventHandler` から呼ぶ）。
  // 優先度は移動先から決める（earthquake=地震情報・長周期／tsunami=津波）。
  //
  // **駆動源は読み上げの設定で変える。** ここへ来る経路が 2 種類あり、意味が違うため。
  //
  // - **読み上げが無効な端末**（`'receipt'`）: この電文はそもそも声にならないので、画面が唯一の
  //   伝え手になる。EEW 続報が張った保持を越えさせる（理由は `shouldAcceptAutoTab`）。越えないと
  //   EEW 発表中は震度速報も津波警報も画面へ出せない
  // - **読み上げが有効な端末**（`'hold'`）: ここへ来るのは「読み上げ文が空になった」ときだけで
  //   （長周期の読み上げ範囲設定・等級が不明な津波・文が組めなかった保険）、本来は追従で動く電文。
  //   **越えさせてはいけない** ——EEW を実際に読み上げている最中に画面を奪い、予想震度・予報円が
  //   見えなくなる（この優先度の仕組みが最初に直した症状そのもの）
  const setActiveTabNonRealtime = useCallback((tab: Exclude<TabId, 'realtime'>) => {
    const source = resolveNonRealtimeTabSource(settings.ttsEnabled)
    requestAutoTab(tab, tab === 'tsunami' ? TAB_PRIORITY.tsunami : TAB_PRIORITY.quake, source, false, false)
  }, [requestAutoTab, settings.ttsEnabled])

  /**
   * 気象庁の推計震度分布図が届いたときに、その地震の分布モードを開く。
   *
   * **タブ移動はここでは行わない。** 見せ先が地図の面なので画面を移す必要はあるが、それは
   * 読み上げに同調させる（呼び出し側が `speakNonEEWDelayed` の追従先として渡す。→
   * audio-tts-spec.md §6「推計震度分布図は地震情報の音を借りる」）。受信の瞬間に要求を
   * 出すだけだと、その要求が EEW の保持に弾かれたきり、**読み上げの番が来ても画面が合わない**
   * ——リアルタイムタブのまま「更新されました」とだけ声が出る。
   *
   * **二度呼ばれる前提で冪等にしてある**（受信の瞬間と、読み上げの順番が来た瞬間）。読み上げは
   * 優先度の待ち行列を通るので、順番が回るまでに別の地震情報が届いて選択がそちらへ移っている
   * ことがある（選択は受信した瞬間に同期で動く）。受信時の 1 回きりだと、そのとき分布が
   * 閉じたまま声だけが出る。開く遷移は `openDistributionOverlay`（トグルではない）。
   *
   * 引き当ては受信側と同じ述語（`matchEstimatedIntensityArrival`）。**該当するカードが無ければ
   * 何もしない** ——別の地震の分布モードを勝手に開くよりは、開かないほうがまし。
   *
   * **開けたかどうかを返し、記録するかは呼び出し側が決める。** 2 回呼ばれるうち受信の時点で
   * 開けないのは珍しくなく（分布図が地震情報より先に届けば、まだどのカードにも結び付かない）、
   * ここで毎回記録すると本当に開けなかった回が埋もれる。
   *
   * @returns 分布モードを開けたか
   */
  const openEstimatedIntensity = useCallback((arrivalTime: string, lat: number, lon: number): boolean => {
    const target = earthquakesRef.current.find(
      q => !q.cancelledAt && matchEstimatedIntensityArrival(q, arrivalTime, lat, lon),
    )
    if (!target) return false
    // **カードの選択も合わせる。** 地図が出すのは選択中の地震（`mapQuake`）で、分布モードも
    // 公式の面もそこから引く。鍵を書き替えるだけだと、利用者が別の地震カードを見ている間に
    // 届いたとき**カードのボタンは押された状態なのに地図には何も出ない**——エラーもログも
    // 出ないので、手掛かりが何も残らない。長周期の自動表示も同じ 2 つを対にしている。
    const eventKey = quakeEventKey(target)
    selectQuake(eventKey)
    // **記録は `applyQuakeOverlay` が出す。** この関数は 1 つの分布図につき 2 回呼ばれる
    // 決まりで（受信の瞬間と、読み上げの順番が来た瞬間）、2 回目は既に開いているので
    // 画面は動かず記録も出ない。
    applyQuakeOverlay(prev => openDistributionOverlay(prev, eventKey), '推計震度分布図の受信')
    return true
  }, [selectQuake])

  /**
   * その地震の電文を受けたとき、開いている震度分布モードを閉じる
   * （判定と理由は `closeDistributionOverlayOnQuakeReport`）。
   *
   * **`selectQuake` の後に呼ぶ。** 別の地震へ移ったときは選択の側が先に閉じており、ここは
   * 「同じ地震の続報でも閉じる」ぶんを受け持つ。
   */
  const closeDistributionOnQuakeReport = useCallback((eventKey: string) => {
    // 閉じる要求は開いていなくても届くが、**記録は `applyQuakeOverlay` が実際に動いた
    // ときだけ出す**ので、画面が動いていない回は並ばない。
    applyQuakeOverlay(prev => closeDistributionOverlayOnQuakeReport(prev, eventKey), 'その地震の電文を受信')
  }, [])

  // EEW の受信による realtime タブ移動。
  //
  // **読み上げ系（`'speech'`）として出す。** EEW は必ず読み上げを持つ情報で、この要求は
  // その系列の一部だから。保持機構系（`'hold'`）で張ると、直後に読み上げの番が来た
  // 津波・地震情報の追従を優先度比較で弾いてしまい、声と画面が食い違う元の不具合に戻る
  // （実測: 読み終えた EEW の保持に大津波警報が弾かれていた）。
  //
  // 読み上げが無効な端末でも `'speech'` で張る（追従が起きないので形式的な指定）。ただし
  // **その端末では電文の受信が `'receipt'` で出るため、続報（`eewUpdate`）の保持は越えられる**
  // （`setActiveTabNonRealtime` と `shouldAcceptAutoTab`）。新規発報・レベルアップ・誤報取消の
  // `eewUrgent` は越えられないままで、そこは従来どおり優先度で弾かれる。

  // 続報。手動選択より弱く、地震情報・津波より強い。
  // 動いたときだけ記録する（拒否は requestAutoTab 側が debug で残す）。
  const setActiveTabRealtimeOnUpdate = useCallback(() => {
    if (requestAutoTab('realtime', TAB_PRIORITY.eewUpdate, 'speech', false, false)) log.info('[tab] → realtime (EEW続報)')
  }, [requestAutoTab])

  // 新規発報・レベルアップ・誤報取消。手動選択より強い。
  const setActiveTabRealtimeUrgent = useCallback(() => {
    requestAutoTab('realtime', TAB_PRIORITY.eewUrgent, 'speech', false, false)
  }, [requestAutoTab])

  /**
   * 読み上げの発話に同調したタブ移動（`useLiveEventHandler` が発話を投入する直前に呼ぶ）。
   *
   * 読み上げは「重いものが先」を待ち行列で保証している（`waitForSpeechSlot` /
   * `chainEEWSpeech`）。その順番が来た＝いま声に出すものが決まった瞬間に画面も合わせる。
   * 追従どうしでは保持を見ない（理由は `shouldAcceptAutoTab`）。手動選択の保持には従来どおり
   * 譲るが、揺れ検知とアイドル復帰の保持は追従を妨げない（同じく `shouldAcceptAutoTab`）。
   *
   * **例外が 1 つある。** 受信時の先出しで既に画面を取れていた場合（`alreadyShown`）に限り、
   * 揺れ検知そのものが持っている画面は取り返さない（`shouldRetakeAfterPreSpeech`）。
   *
   * **画面は声よりわずかに先に出る。** `speakWithVoicevox` は再生完了で解決する作りで、
   * 「音が鳴り始めた瞬間」を呼び出し側から観測できないため、掴めるのは合成を投入した時点まで。
   */
  const followSpeechTab = useCallback((
    tab: TabId,
    priority: TabPriority,
    // 受信時の先出しで既に画面を取れていたか。取れていた場合、揺れ検知に奪われていても
    // 取り返さない（理由は `shouldRetakeAfterPreSpeech`）。
    opts?: { alreadyShown?: boolean },
  ) => {
    if (opts?.alreadyShown && !shouldRetakeAfterPreSpeech(tabHoldRef.current, Date.now())) {
      // **省いた事実は必ず残す。** 残さないと「揺れ検知に譲った」のか「要求が届いていない」のかを
      // 後から区別できない（要求を出さない以上、`requestAutoTab` 側の記録も出ない）。
      log.debug(`[tab] → ${tab} 追従を省略 (先出しで見せた画面を揺れ検知が保持中・取り返さない)`)
      // **畳んだパネルは開く。** `requestAutoTab` は成立でも拒否でも開く（保持は「今見せるべき
      // ものを守る」ためで、情報を隠すためではない）。ここだけ通らないと、畳んだまま揺れ検知が
      // 続いている端末で、読み上げが始まってもパネルが閉じたままになる。
      setPanelCollapsed(false)
      return
    }
    requestAutoTab(tab, priority, 'speech', true, false)
  }, [requestAutoTab])

  /**
   * 通知音と同時に出す**先出し**の追従（`speakNonEEWDelayed` が、待たされずに読めると判断したとき）。
   *
   * **最小滞留時間の床を使わない。** 床は「無音のまま追従が連打されるのを抑える」ためのもので、
   * 先出しは「これから読む予定」にすぎない。予定で床を消費すると、先に届いた重い電文の先出しが、
   * 後から実際に声が出る軽い電文の追従を弾く。
   *
   * 具体的に踏んだ形（当時の大津波警報は間が 4.2 秒、震度速報は 0.5 秒。大津波警報は現在 2.3 秒）:
   * 津波を受信して tsunami を先出し → 直後に届いた地震情報は床で弾かれる → 0.5 秒後に地震情報の
   * **声が始まっても**床が明けておらず画面は tsunami のまま → 津波の声が出るのは 4.2 秒後。
   * 地震情報を読んでいる 3.7 秒間、声と画面が食い違っていた（まさに直したかった症状）。
   *
   * **画面を取れたかを返す。** ただし返すのは**呼び出した瞬間の成否**で、そのあと誰かに
   * 奪われたかは含まない。呼び出し側はこれを `followSpeechTab` の `alreadyShown` に渡し、
   * 取り返すかどうかの判断は保持の中身を見て決める（`shouldRetakeAfterPreSpeech`）。
   */
  const preSpeechTab = useCallback((tab: TabId, priority: TabPriority) => (
    requestAutoTab(tab, priority, 'speech', false, false)
  ), [requestAutoTab])

  // デフォルトタブへ復帰する。デフォルトタブが realtime の場合は
  // 抑制タイマーをセットせずそのまま移動する（realtime への強制移動を
  // 抑制する意味がないため）。
  //
  // **津波カードのスクロールをここから動かさない。** 先頭へ戻すかどうかは `forceTab` の先
  // （`requestAutoTab` の `tsunamiAutoShowTick`）が `shouldResetTsunamiScroll` で決める。
  // かつてここから別に要求を出していたが、**タブが変わっていなくても戻す**形だったため、
  // 津波優先の既定タブで津波カードを読んでいる間、無操作 30 秒ごとに位置が捨てられていた。
  // @param reason どの経路から戻そうとしたか。**見送ったときの記録に出すために必須**にして
  //   ある —— 呼び出し元は 4 つあり、見送りの記録が同じ文言だとどれが止まったのか分からない。
  const revertToDefaultTab = (reason: string) => {
    // **読み上げている間は戻さない**（理由と例外は `shouldDeferRevertWhileSpeaking`）。
    // アイドル復帰だけでなくここへ寄せてあるのは、呼び出し元が 4 つあり**どれも同じ症状を
    // 起こす**ため —— 未入電を読み上げている最中に「揺れの可能性」が失効しただけで、
    // 地震情報タブから引き離される。見送った分はアイドル復帰が後で拾う。
    if (shouldDeferRevertWhileSpeaking(isSpeaking(), idleRevertSecRef.current)) {
      log.info(`[tab] 読み上げ中のため既定タブへの復帰を見送り（${reason}・アイドル復帰が後で戻す）`)
      return
    }
    const tab = defaultTabRef.current
    // 既定の状態へ戻す操作なので必ず動かす（理由は forceTab）。呼び出し元は EEW 発報中・
    // 揺れ検知中を除外しているため、警報級の表示を消すことはない。
    // 呼び出し元はここだけで 4 つある（アイドル復帰・EEW 全解除・揺れ検知終了・揺れの可能性の失効）。
    // `'idleRevert'` は**この呼び出しでは実質的な差を生まない**（張る重みが最低の 1 なので、
    // 追従は優先度比較だけで通る）。それでも渡すのは、復帰という理由に駆動源を一致させておくため。
    // 将来ここが 1 以外の重みを使うようになったとき、渡し忘れに気づく手立てが無くなる。
    forceTab(tab, TAB_PRIORITY.quake, 'idleRevert')
  }

  // 読み上げの進行を津波カードへ伝える（追従スクロール）。
  //
  // **状態を更新するのは読み上げの開始と終了だけ。** チャンクの境界ごとに更新すると、
  // ここから全タブが再描画される（非表示タブの描画を 0 回に保つ設計。architecture-spec.md）。
  // 途中で届く予約の通知はセッションのオブジェクトへ直接積み、読む側は rAF で拾う。
  // 世代の管理は `createSpeechFollowController` に閉じてある（そちらでテストしている）。
  const [speechFollowSession, setSpeechFollowSession] = useState<SpeechFollowSession | null>(null)
  const speechFollow = useMemo(() => createSpeechFollowController(setSpeechFollowSession), [])

  // 未入電モードの自動開閉も同じ仕組みで動かす。**枠は分ける** —— 津波側の門
  // （`hasFollowTarget`）は津波カードの行を引ける参照だけを通す作りで、地震情報の参照を
  // 混ぜると津波カードが動く（→ `ttsFollow.ts`）。仕組み自体は同じものを 2 本立てる。
  const [unreceivedFollowSession, setUnreceivedFollowSession] = useState<SpeechFollowSession | null>(null)
  const unreceivedFollow = useMemo(() => createSpeechFollowController(setUnreceivedFollowSession), [])

  // 気象庁が書いた文の自動展開も同じ仕組みで動かす（3 本目）。**枠を分ける理由は上と同じ** ——
  // 門が見る参照が違うので、相乗りさせると気象庁の文を読むたびに津波カードが動く。
  const [telegramTextFollowSession, setTelegramTextFollowSession] = useState<SpeechFollowSession | null>(null)
  const telegramTextFollow = useMemo(() => createSpeechFollowController(setTelegramTextFollowSession), [])
  /**
   * いま気象庁の文を読み上げている電文の主題（読んでいなければ null。書式は
   * `telegramTextSubject` が決める —— 長周期だけ地震の識別子まで含む）。
   *
   * バナー・津波カード・地震カードがこれを見て自分の表示を開く。**開いた側が「自分が開いた分」を
   * 覚える**ので、利用者が手で開いていたものを読み終わりで閉じることはない。
   */
  const [speakingTelegramTextSubject, setSpeakingTelegramTextSubject] = useState<string | null>(null)
  useTelegramTextSpeechFollow({
    session: telegramTextFollowSession,
    onSubjectChange: setSpeakingTelegramTextSubject,
  })

  // 借りた震源のカード表示も同じ仕組みで動かす（4 本目）。**枠を分ける理由は上の 2 つと同じ。**
  const [borrowedHypocenterFollowSession, setBorrowedHypocenterFollowSession] = useState<SpeechFollowSession | null>(null)
  const borrowedHypocenterFollow = useMemo(() => createSpeechFollowController(setBorrowedHypocenterFollowSession), [])

  // 「いま声が語っている緊急地震速報」の印。**上の 4 本とは別の仕組み** —— あちらは読み上げ文の
  // 断片が持つ参照から範囲を判定するもので、緊急地震速報の読み上げは断片列を通らない
  // （理由は `useEewSpeakingCard`）。
  const { speakingKey: speakingEewKey, follow: eewSpeakingCard } = useEewSpeakingCard()
  // 「いま声が語っている地震情報」の印（取消の読み上げを含む）。地震情報タブの一覧が寄せる相手を
  // 決めるのに使う（→ `utils/quakeCardScroll.ts`）。**同じ仕組みをもう 1 つ持つ** —— 緊急地震速報の
  // 印と混ぜると、地震情報を読んでいるあいだ緊急地震速報のカードまで光る（鍵の体系も別）。
  const { speakingKey: speakingQuakeKey, follow: quakeSpeakingCard } = useEewSpeakingCard()

  // ブラウザ通知を考える地震情報。**ライブで届き、カードが内容を採った報だけを積む**（下の通知の effect が
  // 状態へ反映された後のカードを見て決め、空にする）。起動時の履歴・「もっと見る」・リプレイの初期状態は
  // `onLiveEvent` を通らないので積まれず、過去の地震で通知が出ない（2026-10-21 選択「履歴では出さない (Recommended)」）。
  // 据え置いた報（`quakeHeldBack`）と取消は積まない —— 音・読み上げと同じく、カードが採らない報では動かさない。
  const pendingQuakeNotifyRef = useRef<JMAQuake[]>([])
  // ライブで届き、**カードに当たった**地震情報の取消（通知していた地震なら、取消の通知で置き換える。→ `scheduleQuakeCancelNotification`）。
  // 当たらなかった取消（種別違い・同じ取消の再到着）は積まない —— 積むと次の続報のときに取り出され、取り消されていない通知を
  // 「取り消されました」で置き換える。全体か一部かは、取消を当てた側が決めた結果（`LiveEventMeta.quakeCancel`）から取る
  const pendingQuakeCancelNotifyRef = useRef<{ cancel: JMAQuake; whole: boolean }[]>([])
  // ライブイベント受信処理（通知音・タイトル・タブ切替・読み上げ・ブラウザ通知）
  const { handleLiveEvent, resetTracking, restorePreWindowTracking, restoreStartupEews, obsUpdateStatus, areaGradeChangedKeys, tsunamiValueMarks, focusedDistrict, eewNoForecastSettledKeys, speakKyoshinDetection } = useLiveEventHandler({
    settings, title, earthquakesRef, tsunamisRef, nankaiActiveRef,
    setActiveTabNonRealtime, setActiveTabRealtimeOnUpdate, setActiveTabRealtimeUrgent,
    followSpeechTab, preSpeechTab, speechFollow, unreceivedFollow, telegramTextFollow,
    borrowedHypocenterFollow, eewSpeakingCard, quakeSpeakingCard,
    expandPanelForSpecialInfo,
    selectQuake, openLpgmFromQuake, openEstimatedIntensity,
    closeDistributionOnQuakeReport,
  })

  const [replayTimeOffset, setReplayTimeOffset] = useState<number | null>(null)

  // 通信を起こす側へ渡す APIキーは、入力が落ち着くまで待つ。設定欄は 1 文字ごとに保存するため、
  // 生の値を effect 依存に渡すと手入力・修正のたびに未完成のキーで接続と履歴取得をやり直し、
  // そのすべてが 401/403 で失敗してコンソールを埋める（無駄なリクエストとレート消費も伴う）。
  // 保存と画面表示は即座に反映したいので、遅らせるのはここだけにする。
  const debouncedApiKey = useDebouncedValue(settings.dmdataApiKey, API_KEY_DEBOUNCE_MS)

  /**
   * 起動時の復元で、発表中のものを画面へ見せる。
   *
   * **緊急地震速報は `eewUrgent`(6) ではなく `eewUpdate`(4) で出す。** 復元するのは新規発報では
   * なく**既に出ている報**で、手動選択（5）を奪う理由が無い——履歴の取得は非同期なので、
   * 完了までに利用者が設定の窓などを開いていることがある。何も触っていなければ保持が空なので
   * そのまま通る（`tabHoldRef` の初期値は `until: 0`）。
   *
   * **津波は `tsunamiPriorityDefault` に従う。** 「津波発表中はどのタブを既定にするか」を利用者が
   * 既に選んでいるので、起動時だけそれを無視する理由が無い（アイドル復帰では従来から効いていた）。
   *
   * **駆動源は `receipt` で固定しない。** 復元そのものが声にならないことと、**この端末が
   * 読み上げを使わない**ことは別の話。`receipt` は `eewUpdate` の保持を無条件に越える特権を
   * 持っており（`shouldAcceptAutoTab` の判定 4）、それは「読み上げが無効な端末だけがそこへ
   * 来る」前提で成り立っている。読み上げが有効な端末で固定すると、**実際に声に出ている
   * 緊急地震速報から画面を奪う**——この優先度の仕組みが最初に直した症状そのもの。
   * 振り分けは電文の受信と同じ `resolveNonRealtimeTabSource` に任せる。
   */
  const handleStartupRestore = useCallback((tab: 'realtime' | 'tsunami') => {
    if (tab === 'tsunami' && !settings.tsunamiPriorityDefault) return
    requestAutoTab(
      tab,
      tab === 'realtime' ? TAB_PRIORITY.eewUpdate : TAB_PRIORITY.tsunami,
      resolveNonRealtimeTabSource(settings.ttsEnabled),
      false,
      true,
    )
  }, [requestAutoTab, settings.tsunamiPriorityDefault, settings.ttsEnabled])

  // 予報キー（設計書 §0 の 2026-10-31「予報キー」の行）。手元の検証が通ったときだけ中継の札に添える ——
  // 通らないキーを送っても中継は断るだけなので、送る前に止めておく。予報を流すかを決めるのは中継の側。
  // 検証中であることも札の置き場へ伝える（済むまで中継の札を取らず、自分の鍵の予報の接続も張らない）。
  // **`useEarthquakes` より前に置く** —— 同じ部品の副作用は書いた順に走るので、後ろに置くと、ページを開いた直後の
  // 接続の副作用が検証中であることを知らないまま鍵の接続を張る
  const forecastKeyStatus = useForecastKeyCheck(settings.forecastKey)
  const forecastKeyToSend = forecastKeyStatus.valid ? settings.forecastKey.trim() : null
  const forecastKeyChecking = forecastKeyStatus.checking
  useEffect(() => { relayTokenStore.setForecastKey(forecastKeyToSend, forecastKeyChecking) }, [forecastKeyToSend, forecastKeyChecking])

  // 使用状況データ（設計書 §6.6）。許可している間だけ一意の識別子を持ち、札を取るときに端末と設定の情報を添え、
  // 操作の回数を数える。報告は札を取るたびに組み直すので、設定の使い方は ref で最新を読む
  // （設定の全項目を記録の文字列にするのも札を取るときだけ。描き直しのたびには組まない）
  const usageFlagsRef = useRef<UsageSettingsFlags>({ apiKey: false, tts: false, sound: false, notify: false, seismo: false })
  usageFlagsRef.current = {
    apiKey: settings.dmdataApiKey !== '', tts: settings.ttsEnabled, sound: settings.soundEnabled,
    notify: settings.notifyEnabled, seismo: settings.seismoEnabled,
  }
  const usageSettingsRef = useRef(settings)
  usageSettingsRef.current = settings
  const applyUsageEnabled = (enabled: boolean) => {
    const install = syncInstallIdSafely(enabled)
    relayTokenStore.setUsage(
      install,
      // 設定の全項目は、変わったときと日（日本時間・サーバーの時刻）が替わったときだけ添える（同じ日に同じ値なら空）
      install === null ? null : () => buildUsageReportNow(
        install, usageFlagsRef.current, usageSettingValues(usageSettingsRef.current, SETTINGS_DEFAULTS),
        browserUsageEnv(__APP_VERSION__), serverNow(),
      ),
      install === null ? null : (report, recorded) => markPrefsSentSafely(install, report, recorded),
    )
    setUsageCounting(install !== null)
  }
  // 最初の描画の前に 1 度だけ渡しておく。effect を待つと、先に走る中継の接続（useEarthquakes）が識別子の無い札を取ってから
  // 繋ぎ直すことになる（同じ値を渡し直しても札は捨てないので、二重に呼ばれても害は無い）
  const usageAppliedRef = useRef(false)
  if (!usageAppliedRef.current) {
    usageAppliedRef.current = true
    applyUsageEnabled(settings.usageStatsEnabled)
  }
  useEffect(() => {
    applyUsageEnabled(settings.usageStatsEnabled)
    // applyUsageEnabled は ref と定数しか読まない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.usageStatsEnabled])
  // 別のタブ（ブラウザで開いたものとホーム画面から開いたもの）で切り替えたら追う。追わないと、古いタブが
  // 許可を外した後も識別子を持ったまま送り、設定を保存したときに古い「オン」を書き戻す。
  // 「通知を表示」も同じ（プッシュ通知の購読はこれで決まる。古いタブが「オン」を書き戻すと、消した購読をそのタブが作り直す）
  const usageEnabledRef = useRef(settings.usageStatsEnabled)
  usageEnabledRef.current = settings.usageStatsEnabled
  const notifyEnabledRef = useRef(settings.notifyEnabled)
  notifyEnabledRef.current = settings.notifyEnabled
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== SETTINGS_STORAGE_KEY || e.newValue === null) return
      let other: { usageStatsEnabled?: unknown; notifyEnabled?: unknown }
      try { other = JSON.parse(e.newValue) as typeof other } catch { return }
      if (typeof other.usageStatsEnabled === 'boolean' && other.usageStatsEnabled !== usageEnabledRef.current) {
        adoptExternalSetting('usageStatsEnabled', other.usageStatsEnabled)
      }
      if (typeof other.notifyEnabled === 'boolean' && other.notifyEnabled !== notifyEnabledRef.current) {
        adoptExternalSetting('notifyEnabled', other.notifyEnabled)
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [adoptExternalSetting])
  useEffect(() => {
    if (!settings.usageStatsEnabled) return
    const flush = () => { void flushUsage(usageCounter, relayTokenStore) }
    const timer = setInterval(flush, USAGE_FLUSH_INTERVAL_MS)
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush() }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [settings.usageStatsEnabled])
  // 同意の窓。その端末でまだ答えていなければ 1 度だけ出す（答えた・閉じた印は USAGE_CONSENT_ASKED_KEY）
  const [usageConsentOpen, setUsageConsentOpen] = useState(() => !usageConsentAnswered())
  const answerUsageConsent = useCallback((allowed: boolean) => {
    markUsageConsentAnswered()
    if (allowed) updateSetting('usageStatsEnabled', true)
    setUsageConsentOpen(false)
  }, [updateSetting])
  const handleLiveEventWithNotify = useCallback((event: LiveEvent, meta?: LiveEventMeta) => {
    if (event.kind === 'quake' && !event.cancelled && !meta?.quakeHeldBack) pendingQuakeNotifyRef.current.push(event)
    if (event.kind === 'quake' && event.cancelled) {
      const queued = quakeCancelToNotify(meta?.quakeCancel)
      if (queued) {
        pendingQuakeCancelNotifyRef.current.push({ cancel: event, whole: queued.whole })
      } else {
        log.debug(`[notify] 地震情報の取消がカードに当たらない（または再到着）ので、取消の通知を考えない（${event.id}・${event.issue.type}）`)
      }
    }
    handleLiveEvent(event, meta)
  }, [handleLiveEvent])
  // 揺れ検知の束の広がり。下の検知結果から毎秒流し込み、EEW の自動解除を広がっている間は待たせる（eew-spec §7）
  const [eewSpreadLog] = useState(createDetectionSpreadLog)
  const {
    earthquakes, tsunamis, activeEEWs, lpgmByEventId, quakeUpdateMarks, nankai, nankaiCommentaryList, kohatsuList, quakeNoticeList, earthquakeCountList, internationalTsunamiBandList, specialInfoCancels, estimatedIntensities, internationalTsunamis, tsunamiFactSteps, connectionStatus, relayUpstream, keyForecastStatus, relayForecastLive, dmdataClassifications, keyForecastRefused, lastUpdate, isLoading, isLoadingMore, hasMore, error,
    historyLoss, loadMoreFailed, reconnectGapLoss, historyDays,
    telegramLog, clearTelegramLog,
    injectEvent, loadMoreEarthquakes, loadHistoryPeriod, holdHistoryPeriod,
    simulateEarthquake, simulateForeignQuake, simulateForeignQuakeHuge, simulateForeignQuakeInternationalTsunami, simulateHeadlineOnlyCity, simulateNoIntensityQuake,
    simulateEEW, simulateEEWWarning, simulateEEWForecast, simulateEEWAssumed, simulateEEWStrongShaking, simulateEEWDeep, simulateEEWNoForecast, simulateEEWForecastZero, simulateEEWRetraction, simulateEEWLateRetraction,
    simulateTsunami, simulateTsunamiWarning, simulateTsunamiWatch, simulateTsunamiForecast, simulateTsunamiRetraction,
    simulateNankai, simulateNankaiRetraction, simulateNankaiCommentary, simulateNankaiCommentaryRetraction, simulateActivityInfo, simulateKohatsu, simulateKohatsuRetraction,
    simulateQuakeNotice, simulateEarthquakeCount, simulateEarthquakeCountRetraction, simulateLpgmRetraction, simulateLpgmClassZero, simulateLpgmCategories, simulateLpgmClassZeroRegion, simulateEstimatedIntensity,
    simulateTrainingQuake, simulateUnreceivedQuake, simulateMaxScaleOrAboveQuake, simulateAreaUnreceivedQuake, simulateTsunamiGradeChange, simulateTsunamiQuietReports, simulateTsunamiExpiry, simulateQuakeAmendment,
    simulateQuakeReportSequence, simulateQuakeCancel, simulateQuakePartialCancel, simulateHypocenterFromTsunami, simulateMagnitudeFromTsunami, simulateInternationalTsunamiDomesticAndOnly,
    simulateTsunamiSourceAdded, simulateTsunamiInfoRetraction,
    resetState, loadReplayEvents, peekUpcomingPayloads, restoreQuakeHistory,
  } = useEarthquakes(handleLiveEventWithNotify, debouncedApiKey, settings.dmdataTestDelivery, replayTimeOffset, handleStartupRestore, restoreStartupEews, eewSpreadLog)
  earthquakesRef.current = earthquakes
  // 地震タブの絞り込み（→ `utils/quakeListView.ts`）。条件の項目だけを依存に置く（設定の別の項目が変わるたびに一覧を作り直さない）
  const quakeListFilter = useMemo(
    () => quakeListFilterOf(settings),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings.quakeListScaleMin, settings.quakeListScaleMax, settings.quakeListMagnitudeMin, settings.quakeListMagnitudeMax,
      settings.quakeListDepthMin, settings.quakeListDepthMax, settings.quakeListRegionBasis, settings.quakeListRegions,
      settings.quakeListTypes, settings.quakeListRegionView, settings.quakeListPeriodHours, settings.quakeListPeriodFrom, settings.quakeListPeriodTo],
  )
  // 期間を「今から遡る時間」で絞っている間だけ、1 分ごとに「今」を進める（時間が経って範囲から出た地震を外すため）
  const quakeListNowMs = useMinuteClock(quakeListFilter.period?.kind === 'hours')
  // 期間の絞りが掛かる日の範囲（→ `utils/historyDays.ts` の `periodDayRange`）。期間で読んだ地震を一覧に出すかと、
  // いつまで持つかに使う。日付の文字列で依存を取る（1 分ごとの「今」で範囲が同じなら作り直さない）
  // 「今」は 1 分ごとの時計を使うが、時間で選ぶ期間でないときは 0 を返すので、そのときはいまの時刻で切る（0 のまま渡すと今日が 1970 年になり、
  // 日付で選んだ期間の範囲が逆さになって、期間で読んだ地震が全部隠れる）
  const historyPeriodRange = quakeListFilter.period === null ? null : periodDayRange(quakeListFilter.period, quakeListNowMs !== 0 ? quakeListNowMs : serverNow())
  const historyPeriodFrom = historyPeriodRange?.from ?? null
  const historyPeriodTo = historyPeriodRange?.to ?? null
  // 選んでいる期間を履歴へ知らせる（期間で読んだ日のうち、外れた日は 3 日で捨てる。2026-11-08 選択「3日 (Recommended)」）
  useEffect(() => {
    holdHistoryPeriod(historyPeriodFrom === null || historyPeriodTo === null ? null : { from: historyPeriodFrom, to: historyPeriodTo })
  }, [historyPeriodFrom, historyPeriodTo, holdHistoryPeriod])
  // 期間で読んだ地震を出すかの判定（2026-11-08 選択「一覧には出さない (Recommended)」。判定は `isHistoryCardShown`）。
  // 期間で読んだ日が無ければ隠すものも無いので null（毎回の判定を省く）
  const historyCardShown = useMemo(() => {
    if (historyDays.islands.size === 0) return null
    // 今日から続く分の端。起動時の履歴が無いうちは今日で補う（捨てる側 `evictExpiredIslands` と同じ補い方）
    const mainFrom = historyDays.main?.from ?? historyDays.top ?? jstDayOf(serverNow())
    const active = historyPeriodFrom === null || historyPeriodTo === null ? null : { from: historyPeriodFrom, to: historyPeriodTo }
    const islands = historyDays.islands
    return (q: JMAQuake) => isHistoryCardShown(quakeCardDays(q), mainFrom, active, islands)
  }, [historyDays, historyPeriodFrom, historyPeriodTo])
  const shownEarthquakes = useMemo(() => {
    if (historyCardShown === null) return earthquakes
    const shown = earthquakes.filter(historyCardShown)
    return shown.length === earthquakes.length ? earthquakes : shown
  }, [earthquakes, historyCardShown])
  // 配信元の上限に達して取得を待たせているあいだ、地震タブにその旨を出す。
  // **損失とは別**（枠が空けばそのまま取りに行くので、欠けは出ない）。
  const fetchThrottled = useFetchThrottled(true)
  // 鍵の入れ直しの案内（地震タブの帯・設定のキー欄）。鍵を入れたら印を下ろす —— 消したあとにまた出さない
  const showKeyReentry = settings.dmdataKeyReentryNotice && settings.dmdataApiKey === ''
  const dismissKeyReentry = useCallback(() => updateSetting('dmdataKeyReentryNotice', false), [updateSetting])
  useEffect(() => {
    if (settings.dmdataKeyReentryNotice && settings.dmdataApiKey !== '') updateSetting('dmdataKeyReentryNotice', false)
  }, [settings.dmdataKeyReentryNotice, settings.dmdataApiKey, updateSetting])
  tsunamisRef.current = tsunamis
  nankaiActiveRef.current = nankai !== null

  // EarthquakeTab のカードクリックからの選択。ユーザーが自らカードをクリックした挙動なので
  // explicit=true を渡し、QuakeFitGL に isUserInteracting を無視して強制フィットさせる。
  const selectQuakeFromCard = useCallback((id: string) => {
    selectQuake(id, { explicit: true })
  }, [selectQuake])

  // 津波タブから地震情報カードへのリンク（地震タブへ移動して該当カードを選択する）。
  // selectQuake は上で useCallback 化、setActiveTabByUser も useCallback 化済み。
  // ユーザーが自らリンクをクリックした挙動なので explicit=true で明示選択扱いにし、
  // モード切替（tsunami→quake）で QuakeFitGL がリマウントされた直後でも強制フィットさせる。
  // 絞りで隠れている地震でも一時的に一覧へ出す（`selectQuake` が立てる。→ `notificationPinKey`）
  const linkTsunamiToEarthquake = useCallback((quakeKey: string) => {
    selectQuake(quakeKey, { explicit: true })
    setActiveTabByUser('earthquake')
  }, [selectQuake, setActiveTabByUser])
  // テストボタンのデータ（`utils/testData.ts`）を、設定の窓を開いた時点で読み始める。
  //
  // **押されてから読むと待ちが入る。** その待ちのあいだに初回履歴取得の応答が割り込むと、
  // いま流したテスト電文が上書きされうる（履歴の取り込みは表示中のイベントを置き換える）。
  //
  // **`SettingsTab` 側の mount では駄目。** 設定の窓は閉じている間も中身を外さずに隠すだけなので、
  // `SettingsTab` の `useEffect` は起動時に走ってしまい、分割した意味が無くなる
  // （実際にそうなっていて、初回表示で 864 KB の chunk を取りに行っていた）。
  useEffect(() => {
    if (settingsOpen) prefetchTestData()
  }, [settingsOpen])

  // SettingsTab の onTest オブジェクトはメモ化して同一参照を保つ（毎レンダー再生成すると
  // React.memo 化された SettingsTab が無駄に再レンダーされる）。
  // WARNING: 新規テストハンドラーを追加するときは、対応する simulate* 関数を必ず
  // 下方の deps 配列にも追加すること。deps を更新し忘れると testHandlers 内で古い
  // クロージャを握り続け、テスト関数のバグが再現できなくなる（`react-hooks/exhaustive-deps`
  // による自動検出は現状の lint 設定では実行されない）。
  const testHandlers = useMemo(() => ({
    earthquake:        simulateEarthquake,
    foreignQuake:      simulateForeignQuake,
    foreignQuakeHuge:  simulateForeignQuakeHuge,
    foreignQuakeInternationalTsunami: simulateForeignQuakeInternationalTsunami,
    internationalTsunamiDomesticAndOnly: simulateInternationalTsunamiDomesticAndOnly,
    headlineOnlyCity:  simulateHeadlineOnlyCity,
    noIntensityQuake:  simulateNoIntensityQuake,
    eew:               simulateEEW,
    eewWarning:        simulateEEWWarning,
    eewForecast:       simulateEEWForecast,
    eewAssumed:        simulateEEWAssumed,
    eewStrongShaking:  simulateEEWStrongShaking,
    eewDeep:           simulateEEWDeep,
    eewNoForecast:     simulateEEWNoForecast,
    eewForecastZero:   simulateEEWForecastZero,
    eewRetraction:     simulateEEWRetraction,
    eewLateRetraction: simulateEEWLateRetraction,
    tsunami:           simulateTsunami,
    tsunamiWarning:    simulateTsunamiWarning,
    tsunamiWatch:      simulateTsunamiWatch,
    tsunamiForecast:   simulateTsunamiForecast,
    tsunamiRetraction: simulateTsunamiRetraction,
    nankaiChecking:    () => simulateNankai('調査中'),
    nankaiWatch:       () => simulateNankai('巨大地震注意'),
    nankaiWarning:     () => simulateNankai('巨大地震警戒'),
    nankaiRetraction:  simulateNankaiRetraction,
    nankaiCommentaryAdHoc:   () => simulateNankaiCommentary('臨時解説'),
    nankaiCommentaryRetraction: simulateNankaiCommentaryRetraction,
    nankaiCommentaryRoutine: () => simulateNankaiCommentary('定例解説'),
    activityInfo: simulateActivityInfo,
    kohatsu:           simulateKohatsu,
    kohatsuRetraction: simulateKohatsuRetraction,
    quakeNotice:       simulateQuakeNotice,
    earthquakeCount:   simulateEarthquakeCount,
    earthquakeCountRetraction: simulateEarthquakeCountRetraction,
    lpgmRetraction:    simulateLpgmRetraction,
    lpgmClassZero:     simulateLpgmClassZero,
    lpgmCategories:    simulateLpgmCategories,
    lpgmClassZeroRegion: simulateLpgmClassZeroRegion,
    trainingQuake:     simulateTrainingQuake,
    quakeAmendment:    simulateQuakeAmendment,
    quakeReportSequence: simulateQuakeReportSequence,
    quakeCancel: simulateQuakeCancel,
    quakePartialCancel: simulateQuakePartialCancel,
    borrowFromTsunami: simulateHypocenterFromTsunami,
    magnitudeFromTsunami: simulateMagnitudeFromTsunami,
    unreceivedQuake:   simulateUnreceivedQuake,
    maxScaleOrAboveQuake: simulateMaxScaleOrAboveQuake,
    areaUnreceivedQuake: simulateAreaUnreceivedQuake,
    tsunamiGradeChange: simulateTsunamiGradeChange,
    tsunamiQuietReports: simulateTsunamiQuietReports,
    tsunamiExpiry: simulateTsunamiExpiry,
    tsunamiSourceAdded: simulateTsunamiSourceAdded,
    tsunamiInfoRetraction: simulateTsunamiInfoRetraction,
    estimatedIntensity: simulateEstimatedIntensity,
    notification:      () => {
      // まとめて止めている間はテストも出さない（設定の窓では行ごと隠れるが、呼び出し口でも止める）
      if (!settings.notifyEnabled) {
        log.info('[notify] ブラウザ通知をまとめて止めているので、テスト通知を出さない')
        return
      }
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
        alert(messages.alertText.permissionFirst(messages.settings.permission.request))
        return
      }
      showTestBrowserNotification(messages.alertText.testTitle, messages.alertText.testBody, 'test-notification')
    },
  }), [
    simulateEarthquake, simulateForeignQuake, simulateForeignQuakeHuge, simulateForeignQuakeInternationalTsunami, simulateHeadlineOnlyCity, simulateNoIntensityQuake,
    simulateEEW, simulateEEWWarning, simulateEEWForecast, simulateEEWAssumed, simulateEEWStrongShaking, simulateEEWDeep, simulateEEWNoForecast, simulateEEWForecastZero, simulateEEWRetraction, simulateEEWLateRetraction,
    simulateTsunami, simulateTsunamiWarning, simulateTsunamiWatch, simulateTsunamiForecast, simulateTsunamiRetraction,
    simulateNankai, simulateNankaiRetraction, simulateNankaiCommentary, simulateNankaiCommentaryRetraction, simulateActivityInfo, simulateKohatsu, simulateKohatsuRetraction,
    simulateQuakeNotice, simulateEarthquakeCount, simulateEarthquakeCountRetraction, simulateLpgmRetraction, simulateLpgmClassZero, simulateLpgmCategories, simulateLpgmClassZeroRegion, simulateEstimatedIntensity,
    simulateTrainingQuake, simulateUnreceivedQuake, simulateMaxScaleOrAboveQuake, simulateAreaUnreceivedQuake, simulateTsunamiGradeChange, simulateTsunamiQuietReports, simulateTsunamiExpiry, simulateQuakeAmendment,
    simulateQuakeReportSequence, simulateQuakeCancel, simulateQuakePartialCancel, simulateHypocenterFromTsunami, simulateMagnitudeFromTsunami, simulateInternationalTsunamiDomesticAndOnly,
    simulateTsunamiSourceAdded, simulateTsunamiInfoRetraction,
    settings.notifyEnabled, messages,
  ])
  // 設定の窓のテストボタンは、押した回数を使用状況データに数える（許可している間だけ。→ `countUsage`）
  const countedTestHandlers = useMemo(() => withUsageCount('test', testHandlers), [testHandlers])
  // IconNav の onTabChange。手動選択は必ず即時反映し、以後 TAB_HOLD_MS の間は自動切替に
  // 奪わせない（EEW の新規発報・レベルアップ・誤報取消だけはこれより強い）。
  // 表示中のタブをもう一度押した場合はタブ切替ではなく、パネルの折りたたみをトグルする
  // （地図を全画面で見るための操作。特に画面の狭いスマホ向け）。
  const handleTabChange = useCallback((tab: TabId) => {
    if (tab === activeTabRef.current) {
      setPanelCollapsed(c => !c)
      return
    }
    log.info(`[tab] → ${tab} (手動選択)`)
    countUsage(`tab:${tab}`)
    setActiveTabByUser(tab)
  }, [setActiveTabByUser])

  // パネル境界のつまみ操作。ドラッグ中（Change）は state だけを更新して追従性を保ち、
  // 指を離した時点（Commit）で設定へ保存する。折りたたみ中にドラッグされた場合は
  // 「引き出す」操作とみなして展開する。
  const handlePanelRatioChange = useCallback((ratio: number) => {
    setPanelCollapsed(false)
    setPanelRatio(ratio)
  }, [])
  const handlePanelRatioCommit = useCallback((ratio: number) => {
    setPanelCollapsed(false)
    setPanelRatio(ratio)
    updateSetting('panelRatio', ratio)
  }, [updateSetting])
  const togglePanelCollapsed = useCallback(() => setPanelCollapsed(c => !c), [])
  // 左右分割の境のつまみ。いま出ている側（PC かスマホ横か）の幅だけを変え、もう片方は触らない。
  // 折りたたみ中にドラッグされたら、縦積みのつまみと同じく「引き出す」操作とみなして展開する。
  // **ドラッグ中は state を更新せず、CSS 変数を器へ直に書く。** state を通すと pointermove のたびに App 全体を
  // 描き直す。離した時点で state へ入れると、React が同じ値を書き直す（state が同じ値のままなら React は触らず、
  // 直に書いた値が残る。それも離した時点の値なので食い違わない）。
  const handlePanelWidthChange = useCallback((rem: number) => {
    if (panelCollapsedRef.current) setPanelCollapsed(false)
    layoutRef.current?.style.setProperty(sideNarrow ? '--panel-w-narrow' : '--panel-w-side', panelWidthCss(rem) ?? null)
  }, [sideNarrow])
  const handlePanelWidthCommit = useCallback((rem: number) => {
    setPanelCollapsed(false)
    if (sideNarrow) {
      setPanelWidthSideNarrow(rem)
      updateSetting('panelWidthSideNarrow', rem)
    } else {
      setPanelWidthSide(rem)
      updateSetting('panelWidthSide', rem)
    }
  }, [sideNarrow, updateSetting])

  const {
    points: quakeHeatPoints,
    windowStartMs: heatWindowStartMs,
    completeness: heatCompleteness,
    intensityScale: heatIntensityScale,
  } = useQuakeHeatmap(settings.showQuakeHeatmap, shownEarthquakes, replayTimeOffset, settings.heatmapPeriod)

  // 最新の非解除津波電文から観測データを収集（地図バー描画用）
  const latestTsunamiObservations = useMemo(() => {
    const latest = [...tsunamis].reverse().find((t) => !t.cancelled && (t.observations?.length ?? 0) > 0)
    return latest?.observations ?? []
  }, [tsunamis])

  // UI 倍率: ルート要素の font-size を変えて rem ベースの UI 全体を拡大縮小する。
  // 倍率変更で地図コンテナ幅が変わるため、Leaflet の再計算用に resize を発火する。
  useEffect(() => {
    document.documentElement.style.fontSize = `${16 * settings.uiScale}px`
    window.dispatchEvent(new Event('resize'))
  }, [settings.uiScale])

  // 音量設定の変化を alertSound モジュールに反映する
  useEffect(() => {
    setSoundVolume(settings.soundVolume)
  }, [settings.soundVolume])

  // 通知音・読み上げ・時報のどれかが有効なときだけキープアライブを鳴らす（どれも無効なら
  // 実際に鳴らすものが無く、常時再生する意味も無い）。setSoundVolume() 側の
  // 「音量0=無音」という既存の契約と同じ理由で、鳴らす予定が無いのに鳴らし続けない。
  // **録画モード中は止める**（2026-09-27 13:26 JST ユーザー選択「このまま進める（推奨）」）。20Hz の常時ループ音は動画のエンコード・シークで可聴の
  // アーティファクトに化けうるため、それを消すことを優先する。**このトレードオフとして、
  // 通知音の間隔が長く空く録画中はキープアライブが守っていたハードウェア起床遅延が
  // 再発しうる**ことを受け入れている（→ audio-tts-spec.md §2「キープアライブ」）。
  useEffect(() => {
    setKeepAliveEnabled((settings.soundEnabled || settings.ttsEnabled || settings.timeSignalEnabled) && !settings.recordingMode)
  }, [settings.soundEnabled, settings.ttsEnabled, settings.timeSignalEnabled, settings.recordingMode])

  // TTS の読み辞書をアプリ起動時に事前ロードする（VOICEVOX 有効・無効に関わらず）。
  // 手で書いた句区切り辞書と、生成物 2 つ（震度観測点名の読み・震央地名の句割り）。
  // ここで揃えておけば読み上げ時に待たされない。失敗しても読み上げは成立する（句区切りが
  // 効かない／観測点名が誤読される／長い震央地名の抑揚が崩れる）が、
  // 「なぜそうなっているのか」を後から追えるようログは残す。
  //
  // **片方の失敗で他方を落とさない。** 別のファイルで、欠けたときに失われるものも違う。
  useEffect(() => {
    // 起動時に 1 回だけなので、他の生成データローダと同じ warn で残す
    // （読み上げ時の再試行は繰り返されうるため voicevox.ts 側は debug）。
    loadTtsPhraseBreakDict().catch((err) => {
      log.warn('[data] tts-phrase-break-dict 事前ロード失敗（読み上げの句区切りが効かない）', err)
    })
    loadTtsStationReadings().catch((err) => {
      log.warn('[data] tts-station-readings 事前ロード失敗（観測点名が誤読される）', err)
    })
    loadTtsEpicenterAccents().catch((err) => {
      log.warn('[data] tts-epicenter-accents 事前ロード失敗（長い震央地名の抑揚が崩れる）', err)
    })
  }, [])

  // 緊急地震速報の切り出し語をあらかじめ合成しておく。
  // EEW は通知音との間を置かずに読み始めるため先行合成（prewarmVoicevox）が使えず、合成の
  // 往復がそのまま声の出遅れになる。切り出し語は 3 通りの固定句なので先に作っておける。
  // 接続先・話者が変われば作り直す（別の声のまま鳴らさないため）。
  //
  // **接続先は入力が落ち着くのを待ってから使う。** ここは設定の変化で通信する数少ない経路で、
  // 生の値を依存に渡すと URL を手で打つあいだ 1 文字ごとに合成要求が飛ぶ（3 句ぶん × 打鍵数）。
  // 通信前の検分も設定の窓の接続確認と揃える——スキームの書き忘れのような直らない誤りで
  // 叩き続けないため。
  const debouncedVoicevoxUrl = useDebouncedValue(settings.voicevoxUrl, VOICEVOX_URL_DEBOUNCE_MS)
  useEffect(() => {
    // 端末の声を選んでいるなら VOICEVOX へは繋がない（作り置きは VOICEVOX の音のため）
    if (!settings.ttsEnabled || settings.ttsVoice !== 'voicevox') return
    if (!isValidVoicevoxUrl(debouncedVoicevoxUrl)) {
      // **黙って戻らない。** 設定の窓は同じ条件を「接続先の URL が正しくありません」として
      // 画面に出すが、こちらは画面を持たないため、記録が無いと「作り置きが一度も効かない」
      // 原因を追えない（`warmFixedPhrases` 側の早期 return と同じ流儀）。
      // 値が変わるまで effect は走り直さないので、間引きは要らない。
      log.debug('[VoiceVox] 切り出し語の作り置きをスキップ (接続先の URL が不正)')
      return
    }
    warmFixedPhrases(debouncedVoicevoxUrl, settings.voicevoxSpeakerId, EEW_LEAD_PHRASES)
  }, [settings.ttsEnabled, settings.ttsVoice, debouncedVoicevoxUrl, settings.voicevoxSpeakerId])

  // 録画中は合成待ちの予算を緩める（→ `RECORDING_SYNTH_BUDGET_MS`）。負荷で音が途切れた
  // ぶんだけ予算が削られるため、既定のままだと長い文の後半が落ちる。
  useEffect(() => {
    setSpeechSynthBudgetRelaxed(settings.recordingMode)
  }, [settings.recordingMode])

  // 読み上げの声（VOICEVOX か端末の声か）。呼び出し側は声を知らずに読むので、ここで渡しておく（→ `utils/voicevox.ts` の `SpeechVoice`）
  useEffect(() => {
    setSpeechVoice(settings.ttsVoice)
  }, [settings.ttsVoice])
  // 接続先・話者を直したら「VOICEVOX に繋がらない」の印を解く（直した設定を次の報からすぐ試す）
  useEffect(() => {
    clearVoicevoxDown()
  }, [debouncedVoicevoxUrl, settings.voicevoxSpeakerId])

  // リプレイ中は、これから届く電文の読み上げを先に合成しておく（→ hooks/useSpeechPrefetch.ts）。
  // 負荷で合成が再生に追いつかなくなる場面（録画中）への手当てで、**投機は本番を邪魔しない**
  // （読み上げ中は投げず、始まれば打ち切る）。設定の入口は作り置きと同じものを通す。
  const ttsSpeechOptions = useMemo(() => ttsRegionOptions(settings), [settings])
  useSpeechPrefetch({
    enabled: replayTimeOffset !== null && settings.ttsEnabled && settings.ttsVoice === 'voicevox',
    replayKey: replayTimeOffset,
    peekUpcoming: peekUpcomingPayloads,
    baseUrl: debouncedVoicevoxUrl,
    speakerId: settings.voicevoxSpeakerId,
    opts: ttsSpeechOptions,
  })

  // 時報（→ hooks/useTimeSignal.ts）。読み上げの接続先は作り置きと同じく、入力が落ち着いた値を使う
  useTimeSignal(settings, debouncedVoicevoxUrl)

  // ブラウザの自動再生制限に対応: 利用者の操作で音声を有効化する
  useEffect(() => {
    // 効果音も端末の声も、ブラウザが操作と数える瞬間（指を離したとき・クリック・キー入力）に有効化する。指で触れた瞬間の pointerdown は
    // 数えられず、iPhone ではそこで再開・発話しても効かない（→ `unlockAudio`・`unlockSystemSpeech`）。済むまで操作のたびに試す。
    // click はどの環境でも操作と数えられる保険（マウスの pointerup を操作と数えるかはブラウザによる）
    const UNLOCK_EVENTS = ['pointerup', 'click', 'keydown'] as const
    const watch = (fn: () => boolean) => {
      const handler = () => { if (fn()) UNLOCK_EVENTS.forEach(t => window.removeEventListener(t, handler)) }
      UNLOCK_EVENTS.forEach(t => window.addEventListener(t, handler))
      return () => UNLOCK_EVENTS.forEach(t => window.removeEventListener(t, handler))
    }
    const unwatchSound = watch(unlockAudio)
    const unwatchSpeech = watch(unlockSystemSpeech)
    return () => { unwatchSound(); unwatchSpeech() }
  }, [])

  // 国際津波関連情報の結び付けは、絞る前の全カードで 1 回だけ作る（→ `internationalTsunamiIndex`）。付く地震カードの無い報は、
  // ここで英文だけのカードにして差し込む。状態の一覧には入れないので、カードを足しても音・読み上げ・通知は起きない（報そのものは受けたときに useEarthquakes から流す）
  const internationalTsunamiIdx = useMemo(
    () => internationalTsunamiIndex(earthquakes, internationalTsunamis),
    [earthquakes, internationalTsunamis],
  )
  // 絞る前の全カード（英文だけのカードを含む）。時刻の新しい順
  const allQuakeCards = useMemo(
    // 英文だけのカードを足した後で、期間で読んだ地震の出し分けを掛ける（英文だけのカードも期間で読んだ日のものは隠す）
    () => {
      const cards = withInternationalTsunamiCards(earthquakes, internationalTsunamiIdx)
      if (historyCardShown === null) return cards
      const shown = cards.filter(historyCardShown)
      return shown.length === cards.length ? cards : shown
    },
    [earthquakes, internationalTsunamiIdx, historyCardShown],
  )
  // キャンセル表示中のカードは選択対象から除外する（フォールバック用）。**絞る前の全カードから取る** ——
  // 絞った一覧から取ると、絞りから外れる地震が届いたとき、読み上げ・通知はその地震なのにカードと地図は前の地震のまま残る
  const latestNonCancelled = allQuakeCards.find(q => !q.cancelledAt) ?? null
  const latest = allQuakeCards[0] ?? null

  // 隠れた地震の固定を、選択が別の地震へ移ったら外す（state は `selectQuake` の上）
  useEffect(() => {
    if (notificationPinKey !== null && selectedQuakeId !== notificationPinKey) setNotificationPinKey(null)
  }, [notificationPinKey, selectedQuakeId])
  // 絞りを変えたときも外す（選んでいる地震を絞りで外したら、その地震も一覧から外れる。→ quake-spec.md §8）
  // 比べるのは条件の中身（設定の読み直しで配列の参照だけが変わっても外さない）
  // 一覧と地図の切り替え（`region.view`）は絞りではないので比べない
  const quakeListFilterSignature = JSON.stringify({ ...quakeListFilter, region: { ...quakeListFilter.region, view: undefined } })
  useEffect(() => { setNotificationPinKey(null) }, [quakeListFilterSignature])
  // filter は毎回新規配列を返すため useMemo で参照を安定化する
  // （EarthquakeTab / TsunamiTab へ props として渡すため。毎レンダー新配列を渡すと
  // shallow compare で常に不一致となり React.memo が実質無効化される）。
  //
  // **最新の 1 枚は、絞りで外れていても一覧に出す**（2026-11-07 選択「最新の1枚は一覧にも出す (Recommended)」、
  // 選んでいる地震によらず常に —— 同日選択「いつも一覧に出す (Recommended)」）。カード・地図・読み上げ・通知を同じ地震にそろえる。
  //
  // **選択には依存させない**: 一覧は絞り・通知の固定・最新の 1 枚だけで決まり、選び替えでは作り直さない。
  // 中身が前回と同じなら前回の配列を返す（`keepIfSame`）。こうしないと、毎分の時計や条件の再計算のたびに、
  // 下流の並べ替え・波形の取り先の選び直しが空回りする。
  // 区域→県の索引は座標表から引く。**読み込みを待って絞り直す**（読み込み前に絞ると、震度を観測した地域の判定が
  // 索引なしのまま残る。地域を保存したまま起動した直後に当たる）
  const [areaPrefIndex, setAreaPrefIndex] = useState(() => getAreaPrefIndexCache())
  useEffect(() => (areaPrefIndex ? undefined : onStationCoordsLoaded(d => setAreaPrefIndex(areaPrefIndexOf(d)))), [areaPrefIndex])
  const conditionFilteredRef = useRef<JMAQuake[] | null>(null)
  // 種類の絞りに長周期・推計・英文が入っていないときは、それらの電文が届いても絞り直さない（引く口を空にし、依存からも外す）
  const quakeListWantsAttached = wantsAttachedTypes(quakeListFilter)
  const attachedLpgm = quakeListWantsAttached ? lpgmByEventId : null
  const attachedEstimated = quakeListWantsAttached ? estimatedIntensities : null
  const attachedIntl = quakeListWantsAttached ? internationalTsunamiIdx : null
  const quakeFilterCtx = useMemo((): Omit<QuakeFilterContext, 'pinnedKeys'> => ({
      nowMs: quakeListNowMs,
      keyOf: quakeEventKey, areaPrefIndex,
      // 種類の絞りの「長周期・推計・英文」は、その地震カードに付いている報で当てる（取り消された長周期は入れない。カードの報の一覧と同じ）
      attachedTypesOf: (q) => {
        if (attachedLpgm === null || attachedEstimated === null || attachedIntl === null) return []
        const out: QuakeAttachedType[] = []
        const lpgm = attachedLpgm.get(extractQuakeEventId(q) ?? '')
        if (lpgm && !lpgm.cancelled) out.push('長周期地震動に関する観測情報')
        if (estimatedIntensityFor(q, attachedEstimated)) out.push('推計震度分布図')
        if (q.fromInternationalTsunami || (attachedIntl.byQuakeKey.get(quakeEventKey(q))?.length ?? 0) > 0) out.push('国際津波関連情報')
        return out
      },
  }), [quakeListNowMs, areaPrefIndex, attachedLpgm, attachedEstimated, attachedIntl])
  const conditionFiltered = useMemo(() => {
    const ctx: QuakeFilterContext = { ...quakeFilterCtx, pinnedKeys: new Set<string>(notificationPinKey !== null ? [notificationPinKey] : []) }
    // 津波の原因地震・国際津波関連情報の付いた地震（英文だけのカードも）も絞りどおりに外す（2026-11-08 選択「例外をやめる (Recommended)」）
    const next = allQuakeCards.filter(q => passesQuakeListFilter(q, quakeListFilter, ctx))
    const kept = keepIfSame(conditionFilteredRef.current, next)
    conditionFilteredRef.current = kept
    return kept
  }, [allQuakeCards, quakeListFilter, quakeFilterCtx, notificationPinKey])
  // 窓の「◯件中 ◯件」の後ろ。条件に合う数だけを数え、飛んで開いた 1 件（固定）と最新の 1 枚は数えない（2026-11-08 選択「条件に合う数だけ」）
  const quakeListMatched = useMemo(
    () => quakeListMatchedCount(conditionFiltered, quakeListFilter, { ...quakeFilterCtx, pinnedKeys: new Set<string>(notificationPinKey !== null ? [notificationPinKey] : []) }),
    [conditionFiltered, notificationPinKey, quakeListFilter, quakeFilterCtx],
  )
  const filteredEarthquakes = useMemo(
    () => withLatestPinned(conditionFiltered, allQuakeCards, latestNonCancelled),
    [conditionFiltered, allQuakeCards, latestNonCancelled],
  )
  // 地震タブに出ている地震の鍵（波形を取りに行く先を絞る。→ `usePublicQuakeWaves`・`useSeismoQuakeWaves`）
  const allQuakeKeys = useMemo(() => new Set(allQuakeCards.map(quakeEventKey)), [allQuakeCards])
  const shownQuakeKeys = useMemo(() => new Set(filteredEarthquakes.map(quakeEventKey)), [filteredEarthquakes])
  shownQuakeKeysRef.current = shownQuakeKeys
  allQuakeKeysRef.current = allQuakeKeys
  // 地震タブの並べ替えと、条件を書き換える口（設定へまとめて書く。地震タブは memo なので参照を保つ）
  const quakeListSort = useMemo(
    () => quakeListSortOf(settings),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings.quakeListSortKey, settings.quakeListSortDir],
  )
  const changeQuakeListFilter = useCallback((next: QuakeListFilter) => updateSettings(quakeListFilterSettings(next)), [updateSettings])
  const changeQuakeListSort = useCallback(
    (next: QuakeListSort) => updateSettings({ quakeListSortKey: next.key, quakeListSortDir: next.dir }),
    [updateSettings],
  )

  // 選択中の地震: selectedQuakeId はカードの eventKey。eventKey は続報でも変わらないため、
  // 電文が更新されても選択は同じカードに追従する（以前は earthquake.time を選択 ID にしていたが、
  // VXSE51→52/53 で時刻が 1 分ずれる問題に加え、同じ分に起きた別の地震と衝突していた）。
  // 該当カードが消えている・取消表示中・絞りで外れた場合はキャンセル除外の最新にフォールバックする（最新は一覧にも出る）。
  const selectedQuake = (() => {
    if (!selectedQuakeId) return latestNonCancelled
    return filteredEarthquakes.find(q => quakeEventKey(q) === selectedQuakeId && !q.cancelledAt)
      ?? latestNonCancelled
  })()
  // 選択中に見えているカードの鍵。**開いているカードに従うものは `selectedQuakeId` ではなくこちらを見る** ——
  // 起動直後や選んだカードが取り消された後は `selectedQuakeId` が表示中のカードを指していない。
  const selectedQuakeKey = selectedQuake ? quakeEventKey(selectedQuake) : null
  // 「更新 ▾」の報の一覧で押した報（→ `utils/quakeReportHistory.ts`。2026-11-07 ユーザー依頼）。押した報の時点のカードを
  // 地震カードと地図へ出す（同日選択「カードの中身を差し替え (Recommended)」「地図もその報の時点にする (Recommended)」）。
  // **同じ行をもう一度押すと最新へ戻る**（同日のユーザー発言「もっかいタップでいいんじゃないの？前のUIの長周期地震動の
  // 切り替えみたいに。」）。**画面のカードが別の地震になる・そのカードの報の一覧が伸びたら最新へ戻す**（同日選択
  // 「カードが変わるか一覧が伸びたら (Recommended)」）。届いた電文の種類ではなく画面の状態で見るので、選択を動かす経路が
  // 増えても漏れない。`count` は押したときの行数
  const [historyPick, setHistoryPick] = useState<{ quakeKey: string; entryId: string; count: number } | null>(null)
  const historyInputs = useMemo<QuakeHistoryInputs | null>(() => selectedQuake ? {
    card: selectedQuake,
    lpgm: lpgmByEventId.get(extractQuakeEventId(selectedQuake) ?? ''),
    internationalTsunamis: internationalTsunamiIdx.byQuakeKey.get(quakeEventKey(selectedQuake)) ?? NO_INTERNATIONAL_TSUNAMIS,
    estimatedIntensity: estimatedIntensityFor(selectedQuake, estimatedIntensities),
    tsunamiSteps: tsunamiFactSteps,
    tsunamis,
    quakes: earthquakes,
    areaPrefIndex: getAreaPrefIndexCache(),
  } : null, [selectedQuake, lpgmByEventId, internationalTsunamiIdx, estimatedIntensities, tsunamiFactSteps, tsunamis, earthquakes])
  // 行数と押した行の姿は、押している間だけ組む（組むのは当て直しと印で、何度も走る経路に載せない）
  const historyEntryCount = useMemo(
    () => historyPick && historyInputs ? quakeHistoryEntries(historyInputs).length : 0,
    [historyPick, historyInputs],
  )
  const historyPickLive = historyPick !== null && historyPick.quakeKey === selectedQuakeKey && historyPick.count === historyEntryCount
  const historyView = useMemo(
    () => historyPickLive && historyPick && historyInputs ? quakeHistoryView(historyInputs, historyPick.entryId) : null,
    [historyPickLive, historyPick, historyInputs],
  )
  useEffect(() => {
    if (historyPick && !historyPickLive) {
      log.info('[地震タブ] 報の一覧で押した報から最新へ戻す（画面のカードが変わったか、報の一覧が伸びた）')
      setHistoryPick(null)
    } else if (historyPick && historyPickLive && historyView === null) {
      // 押した行の姿を組めなかった（行の鍵が一覧に無い・カードがまだ無い時点）。押した見た目だけ残すと、最新の姿を前の報と
      // 読み違えるので、最新へ戻して記録する
      log.warn('[地震タブ] 報の一覧で押した行の時点のカードを組めず、最新へ戻します', { entryId: historyPick.entryId })
      setHistoryPick(null)
    }
  }, [historyPick, historyPickLive, historyView])
  // 押す口は参照を変えない（地震タブは `React.memo`）。押した瞬間に見えているカードの鍵を読む。`count` は押したカードが
  // 見ていた行数（カードが組んだ一覧と同じもの）
  const selectedQuakeKeyRef = useRef(selectedQuakeKey)
  selectedQuakeKeyRef.current = selectedQuakeKey
  const pickHistoryEntry = useCallback((entryId: string, count: number) => {
    const quakeKey = selectedQuakeKeyRef.current
    if (!quakeKey) return
    setHistoryPick(prev => prev && prev.quakeKey === quakeKey && prev.entryId === entryId ? null : { quakeKey, entryId, count })
  }, [])
  // 長周期の節を見せる求めを、地震カードへ引き当てる（求めの受け口は `focusLpgmSection`）。引き当てるのは
  // 選択中のカードに当たったときだけで、当たらなければ求めを捨てる（別の地震を見ている人の画面は動かさない）。
  // 紐づくカードがまだ無いなら、一覧が次に変わるまで待つ（同じ瞬間に届いた地震情報が載るのを待つため）。
  // 待つのは `LPGM_FOCUS_WAIT_MS` まで。過ぎた求めは捨てる —— 後でその地震が届いたときに、利用者が
  // 何もしていないのに急に巻くことになる。
  // `quakeId` は引き当てた時点のカードの報（読み上げが無効なとき、この後の続報でカードの頭へ戻すため）
  useEffect(() => {
    if (!lpgmFocusRequest) return
    const { eventId, seq, at } = lpgmFocusRequest
    // 期限はカードが見つかったかどうかより先に見る（期限の後に届いたカードへ巻かない）。
    // 評価するのは一覧か選択が変わった描画だけで、変わらなければ求めは残るが、残っても巻く先が無い
    if (performance.now() - at > LPGM_FOCUS_WAIT_MS) {
      setLpgmFocusRequest(null)
      log.info(`[地震タブ] 長周期の節へ巻かない（紐づく地震カードを待ちきれなかった・${eventId}）`)
      return
    }
    const key = quakeKeyForLpgmEventId(earthquakes, eventId)
    const quake = key ? earthquakes.find(q => quakeEventKey(q) === key) : undefined
    if (!key || !quake) return
    setLpgmFocusRequest(null)
    if (key !== selectedQuakeKey) {
      log.info(`[地震タブ] 長周期の節へ巻かない（選択中のカードが別の地震・${eventId}）`)
      return
    }
    setLpgmFocus({ key, seq, quakeId: quake.id })
  }, [lpgmFocusRequest, earthquakes, selectedQuakeKey])
  // 地図に表示中の LPGM（バッジクリックでトグル）
  const activeLpgm = activeLpgmEventId ? (lpgmByEventId.get(activeLpgmEventId) ?? null) : null

  /**
   * 長周期の補足を読み上げたのに、開く先が最後まで無かったことを記録する。
   *
   * **画面には何も現れないのに声は本文を読む。** この機能が直したのと同じ症状（声だけが
   * 本文を伝える）が別の理由で起きても、記録が無ければ気づけない —— 実際、長周期が対象から
   * 漏れていた間、例外もログも出なかった（→ docs/spec/audio-tts-spec.md §6）。
   *
   * **残すのは「最後の機会」でだけ。** 読み上げの途中はカードがまだ無いことがありうるので、
   * その場で残すと正常な経過で記録が埋まる（推計震度分布図の診断と同じ考え方）。
   * 一度でも開ける状態になったかを覚えておき、読み終わりに判定する。
   */
  const lpgmNotesOpenableRef = useRef<{ subject: string; openable: boolean } | null>(null)
  useEffect(() => {
    const subject = speakingTelegramTextSubject
    const prefix = telegramTextSubject('lpgm', '')
    if (subject === null || !subject.startsWith(prefix)) {
      const prev = lpgmNotesOpenableRef.current
      lpgmNotesOpenableRef.current = null
      // 読み上げが終わった（別の種別へ移った場合も含む）。開けないまま終わっていたら残す。
      if (prev && !prev.openable) {
        log.warn(`[quake] 長周期地震動の補足を読み上げたのに、開く先の地震カードがありませんでした（eventId ${prev.subject.slice(prefix.length)}）`)
      }
      return
    }
    const eventId = subject.slice(prefix.length)
    const openable = earthquakes.some(q => extractQuakeEventId(q) === eventId)
      && canOpenLpgmNotes(lpgmByEventId.get(eventId))
    const prev = lpgmNotesOpenableRef.current
    // 後からカードが届いて開けるようになった場合も拾う（依存に一覧を入れてあるのはこのため）
    lpgmNotesOpenableRef.current = {
      subject,
      openable: (prev?.subject === subject && prev.openable) || openable,
    }
  }, [speakingTelegramTextSubject, earthquakes, lpgmByEventId])

  // 選択中の地震カードがキャンセル状態になったら即座に選択解除する。
  // **`selectQuake` を通す** —— 直に state を書くと前値の ref（`selectedQuakeIdRef`）が
  // 取り残され、追加表示（`quakeOverlay`）も取消されたカードのまま居残る。
  useEffect(() => {
    if (!selectedQuakeId) return
    const selected = filteredEarthquakes.find(q => quakeEventKey(q) === selectedQuakeId)
    if (selected?.cancelledAt) {
      selectQuake(null)
    }
  }, [filteredEarthquakes, selectedQuakeId, selectQuake])

  // 通知を押したときの開き先（docs/relay-server-design.md §6.7「押したときの開き先」）。手で選んだのと同じ扱いで
  // タブを移し、地震を選ぶ（2026-11-05 ユーザー選択「手で選んだのと同じ扱い (Recommended)」）
  useNotificationOpen(filteredEarthquakes, allQuakeCards, { activeTab, selectionTick: quakeSelectionTick }, {
    openTab: setActiveTabByUser,
    selectQuake: selectQuakeFromCard,
    // 絞りで隠れていた地震は、絞りの例外として一覧にも出して開く（2026-11-07 選択「その地震を一覧にも出して開く (Recommended)」）
    pinQuake: setNotificationPinKey,
    openLpgm: openLpgmFromNotification,
    openDistribution: openDistributionFromNotification,
  })

  // 未入電が 1 件も無くなったら未入電モードを閉じる。
  //
  // **開いたまま閉じられなくなる形がある。** カードのボタンは件数で出しているので、続報で
  // 観測点が入電して 0 件になると消える。一方 `quakeOverlay` は選択が別の地震へ移るまで残り、
  // 地図は未入電モードの間だけ震度の表現を引っ込めるので、**震源の印だけの画面で固定される**。
  //
  // 判定はカードの件数と同じ述語にする（`partitionUnreceivedPoints` は名前を持たない点を外す）。
  // 引き当てられない（カードが消えた・リプレイで作り直された）ときも閉じる。
  useEffect(() => {
    if (!unreceivedQuakeKey) return
    const target = filteredEarthquakes.find(q => quakeEventKey(q) === unreceivedQuakeKey)
    if (target?.points.some(p => p.unreceived && p.addr)) return
    applyQuakeOverlay(closeUnreceivedOverlay, '未入電の地点が無くなった')
  }, [filteredEarthquakes, unreceivedQuakeKey])

  // cancelledAt（10秒表示中）の EEW は地図・挙動系から除外する
  const activeEEWsNoCancelled = useMemo(
    () => new Map([...activeEEWs].filter(([, v]) => !v.cancelledAt)),
    [activeEEWs],
  )
  // cancelledAt 除外済みのアクティブ EEW が1件以上あるか（S波カウントダウン等が参照する）
  const hasActiveEEW = activeEEWsNoCancelled.size > 0

  // 地図・パネルへ渡す EEW 配列は参照を安定させる。JSX 内で Array.from を直接呼ぶと毎レンダー
  // 新しい配列になり、psWave の 100ms tick 等で App が再レンダーするたびに useEewLayerData の
  // eewAreaFills（useMemo）が中身同一のまま再計算され、EEW 区域塗りが同一ジオメトリを冗長に
  // setData → geojson-vt 再タイル化 → 連続自己再描画（weak GPU でのカクつき要因）を招く。
  // useMemo で EEW データが実際に変わったときだけ配列を作り直す。
  const eewsForMap = useMemo(() => Array.from(activeEEWsNoCancelled.values()), [activeEEWsNoCancelled])
  const eewsForPanel = useMemo(() => Array.from(activeEEWs.values()), [activeEEWs])

  // EEW カード経由で選択したLPGMは、次報で長周期地震動階級（地域別lgIntTo優先）が
  // なくなった場合や EEW 解除時に自動的に選択解除する
  useEffect(() => {
    if (!activeLpgmEventId || activeLpgmSource !== 'eew') return
    const eew = activeEEWsNoCancelled.get(activeLpgmEventId)
    if (!eew || eewMaxLpgmClass(eew) < 1) {
      // 落とすのは EEW 由来の長周期だけ（この effect が走るあいだに別の追加表示へ
      // 切り替わっていたら、そちらは触らない）。
      applyQuakeOverlay(closeEewLpgmOverlay, '緊急地震速報が消えた')
    }
  }, [activeEEWs, activeLpgmEventId, activeLpgmSource])

  // ブラウザ通知。中身と出すかどうかは `decideQuakeNotification`（カードが採った報ごとに出す。
  // 文面と、同じ報を 2 度出さない決まりはそちら）。
  // **見るのは、ライブで届いてカードが内容を採った報の地震すべて**（`pendingQuakeNotifyRef`）——
  // 一覧の先頭 1 件だけを見ると、続けて届いた別の地震の報や、先頭でない地震の続報を取りこぼす
  // （2026-10-21 選択「直す (Recommended)」）。報からカードは受信側と同じ当て方（`sameQuakeEntry`）で引く。
  // 重複抑止は eventKey で行う（earthquake.time では、同じ分に起きた 2 件目の地震が
  // 「通知済み」と誤判定されて通知が出ない）。
  // 覚えるのは地震ごと（`rememberQuakeNotified`）。1 件だけだと、2 つの地震の報が交互に届いたとき
  // 前の地震を忘れて同じ通知を出し直す。
  const notifiedQuakesRef = useRef(new Map<string, QuakeNotifiedState>())
  // 地震ごとの通知の列（同じ地震の通知を、前が済んでから出す。→ `scheduleQuakeNotification`）
  const quakeNotifyChainsRef = useRef(new Map<string, Promise<void>>())
  // 通知しないとき（まとめて止めている・地震情報の通知を切っている）は -1（`effectiveNotifyMinScale`）
  const notifyMinScaleRef = useRef(effectiveNotifyMinScale(settings))
  notifyMinScaleRef.current = effectiveNotifyMinScale(settings)
  // 設定「通知する地域」（docs/relay-server-design.md §6.7）。地域を選んでいれば、その県で震度を観測した地震だけ通知する
  const notifyPrefecturesRef = useRef(settings.notifyPrefectures)
  notifyPrefecturesRef.current = settings.notifyPrefectures
  useEffect(() => {
    const cancels = pendingQuakeCancelNotifyRef.current
    pendingQuakeCancelNotifyRef.current = []
    const pending = pendingQuakeNotifyRef.current
    if (pending.length === 0 && cancels.length === 0) return
    pendingQuakeNotifyRef.current = []
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
      // 許可の無い間に届いた報は、後で許可しても通知しない（その時点の報ではないので）
      log.debug(`[notify] 通知の許可が無いので、地震情報 ${pending.length} 通を通知しない（${typeof Notification === 'undefined' ? '通知に非対応' : Notification.permission}）`)
      return
    }
    const index = getAreaPrefIndexCache()
    // 取消: 取消が当たったカード（全体の取消なら取消済みの印付き、一部なら当て直したカード）を引き、その地震を通知していれば
    // 同じ tag の取消の通知で置き換える（2026-11-09 ユーザー選択「同じ札で置き換え、何を取り消したか言う (Recommended)」）
    for (const { cancel, whole } of cancels) {
      const target = earthquakes.find(c => sameQuakeEntry(c, cancel, index))
      if (!target) {
        log.info(`[notify] 地震情報の取消が当たったカードを状態から引けず、取消の通知を考えない（${cancel.id}・${cancel.issue.type}）`)
        continue
      }
      scheduleQuakeCancelNotification({
        chains: quakeNotifyChainsRef.current,
        memory: notifiedQuakesRef.current,
        target,
        cancel,
        whole,
        notifyMinScale: notifyMinScaleRef.current,
        m: messagesRef.current,
        show: showQuakeNotification,
      }).catch((err: unknown) => {
        log.error(`[notify] 地震情報の取消の通知を出せず（${target.eventKey ?? target.id}）`, err)
      })
    }
    const { cards, unmatched } = collectQuakesToNotify(pending, earthquakes, index)
    // 引けなかった報は、状態が採らなかった（取消より前の報など）か、取り消されたカードに当たった報。
    // 通知が出ない理由を後から追えるよう記録する
    for (const incoming of unmatched) {
      log.debug(`[notify] 地震情報の報からカードを引けず、通知を考えない（${incoming.id}・${incoming.issue.type}・最大震度 ${incoming.earthquake.maxScale}）`)
    }
    for (const { card, reportKeys } of cards) {
      // 選んだ地域で震度を観測していない地震は通知しない。覚えもしない（続報で選んだ県が加われば、そのとき初めて通知する）
      if (!notificationRegionAllowed({ notifyPrefectures: notifyPrefecturesRef.current }, quakePrefectures(card))) {
        log.debug(`[notify] 選んだ地域で震度を観測していない地震なので通知しない（${card.eventKey ?? card.id}）`)
        continue
      }
      if (noIntensityQuakeHiddenByRegion({ notifyPrefectures: notifyPrefecturesRef.current }, card)) {
        log.debug(`[notify] 地域を選んでいて、震度を持たない地震の報なので通知しない（${card.eventKey ?? card.id}）`)
        continue
      }
      // **通知は補助の経路なので、ここで投げても画面を落とさない**（App のレンダー・effect の例外は
      // 根の受け皿でしか拾えず、画面全体が消える）。1 件が投げても残りの地震は見る。失敗は記録に残す。
      try {
        // **出せてから覚える。** 先に覚えると、出せなかった報が「通知済み」になり、同じ報が届き直しても
        // 出さない。最大震度が上がったかの比べる相手もずれる。出せたかは Service Worker の返事を待たないと分からないので、
        // 同じ地震の通知は前が済んでから判定する（`scheduleQuakeNotification`）
        scheduleQuakeNotification({
          chains: quakeNotifyChainsRef.current,
          memory: notifiedQuakesRef.current,
          quake: card,
          reportKeys,
          notifyMinScale: notifyMinScaleRef.current,
          areaPrefIndex: index,
          m: messagesRef.current,
          place: placeNamesRef.current,
          show: showQuakeNotification,
        }).catch((err: unknown) => {
          log.error(`[notify] 地震の通知を出せず（${card.eventKey ?? card.id}・最大震度 ${card.earthquake.maxScale}）`, err)
        })
      } catch (err) {
        log.error(`[notify] 地震の通知を出せず（${card.eventKey ?? card.id}・最大震度 ${card.earthquake.maxScale}）`, err)
      }
    }
  }, [earthquakes])

  // 情報更新時にウィンドウタイトルを変更し、平常時は既定タイトルに戻す。
  // 優先順位: 警報タイトル > アップデートカウントダウン > デフォルトタイトル
  // 津波の発表中は、名乗り（予報だけか）をいまの津波から決める（`resolveAlertTitle`）。
  // **解除の表示だけが残る描画では直前の値を使う。** 解除の描画では、タイトルが終わりの語へ替わる（App の
  // 解除の検出の effect）より先に津波が解除の表示だけになるので、そのまま判定すると予報だけの津波が 1 描画
  // だけ「津波警報・注意報 発表中」と名乗る。それ以外（発表中がある・画面に何も無い）はそのまま判定する ——
  // 何も無いのに直前の「予報だけ」を引きずると、軽いほうへ名乗る値が残る。
  const tsunamiForecastOnlyRef = useRef(false)
  const onlyCancelledShown = tsunamis.length > 0 && tsunamis.every(t => t.cancelled || !!t.cancelledAt)
  if (!onlyCancelledShown) tsunamiForecastOnlyRef.current = isTsunamiForecastOnly(tsunamis)
  const tsunamiForecastOnly = tsunamiForecastOnlyRef.current
  const alertTitleText = resolveAlertTitle(title.alertTitle, tsunamiForecastOnly, messages)
  // 読み直し（新しい版の適用・毎朝 5 時の定期の読み直し）の段取り。発表中・再生中・入力中は待つ
  // （→ hooks/useReloadSchedule.ts）。
  const reloadSchedule = useReloadSchedule({
    alertActive: title.alertTitle !== null,
    replaying: replayTimeOffset !== null,
    periodicReloadEnabled: settings.periodicReloadHours > 0,
    settingsOpen,
  })
  const reloadCountdown = reloadSchedule.countdown
  const reloadCountdownReason = reloadSchedule.countdownReason
  useEffect(() => {
    if (alertTitleText) {
      document.title = alertTitleText
    } else if (reloadCountdown !== null) {
      document.title = messages.alertText.titleReloadCountdown(reloadCountdown, reloadCountdownReason === 'periodic', DEFAULT_TITLE)
    } else {
      document.title = DEFAULT_TITLE
    }
  }, [alertTitleText, reloadCountdown, reloadCountdownReason, messages])

  // アプリ時計とログのタイムスタンプをリプレイ時刻に追従させる
  // （clock はライブ時サーバー同期、リプレイ時は setReplayOffset で絶対制御）
  useEffect(() => {
    setClockReplayOffset(replayTimeOffset)
  }, [replayTimeOffset])

  // リプレイ中はリプレイ時刻で毎秒更新、WS接続中は実時刻で毎秒更新、それ以外は null
  useEffect(() => {
    if (replayTimeOffset !== null) {
      const tick = () => setNowTick(serverDate())
      tick()
      const id = setInterval(tick, 1000)
      return () => clearInterval(id)
    }
    if (connectionStatus !== 'connected') {
      setNowTick(null)
      return
    }
    setNowTick(serverDate())
    const id = setInterval(() => setNowTick(serverDate()), 1000)
    return () => clearInterval(id)
  }, [connectionStatus, replayTimeOffset])

  // 電文ログタブ表示中は、地図には直前に表示していたタブの内容をそのまま残す。
  // （設定は窓なので、開いている間も `activeTab` は下のタブのまま変わらない。）
  const [lastContentTab, setLastContentTab] = useState<TabId>(settings.defaultTab)
  useEffect(() => {
    if (activeTab !== 'telegrams') setLastContentTab(activeTab)
  }, [activeTab])
  const mapTab = activeTab === 'telegrams' ? lastContentTab : activeTab
  // 常時表示する地図の内容は mapTab（電文ログタブ中は直前のタブ）に応じて切り替える。
  // mapTab から MapMode への写像は kyoshinSubIndices の分岐（PERF-1）でも使うため
  // ここ 1 箇所で導出し、下流はこれを参照する（マッピング重複を避ける）。
  const mapMode: MapMode =
    mapTab === 'tsunami' ? 'tsunami'
      : mapTab === 'realtime' ? 'kyoshin'
        : mapTab === 'catalog' ? 'catalog'
          : 'quake'

  // ── 長期震源カタログ（震源カタログタブ） ──────────────────────────────────
  // **タブを開くまで取りに行かない。** 全期間で 108 ファイル・gzip 12.6MB あり、起動時に
  // 読むと地震情報の表示まで遅れる。年ごとの取得はローダー側がキャッシュする。
  const [catalogFilter, setCatalogFilter] = useState<CatalogFilter>(() => {
    // **年は日本時間で数える。** 端末の時計が別のタイムゾーンだと、年明け前後に収録の無い年を選ぶ。
    const thisYear = jstYearOf(Date.now())
    return {
      // 初期表示は直近 10 年。マグニチュードの下限は期間に合わせて引き上げない（下の効果の注記）。
      // 終わりは仮の値で、索引が届いたらデータの最終日へ収める（下の効果）。
      fromMs: jstYearStartMs(thisYear - 9),
      toMs: jstYearEndMs(thisYear),
      minMagnitude: MAGNITUDE_FILTER_RANGE.min,
      maxMagnitude: MAGNITUDE_FILTER_RANGE.max,
      minDepthKm: 0,
      maxDepthKm: DEPTH_FILTER_MAX_KM,
      minLat: LATITUDE_FILTER_RANGE.min,
      maxLat: LATITUDE_FILTER_RANGE.max,
      minLng: LONGITUDE_FILTER_RANGE.min,
      maxLng: LONGITUDE_FILTER_RANGE.max,
      includeExternal: false,
    }
  })
  const [catalogView, setCatalogView] = useState<CatalogViewOptions>({ colorBy: 'depth', sizeBy: 'fixed', sizePx: 3 })
  // **重い側はスライダーが止まってから動かす。** つまみと数値のラベルは元の値で即座に動く。
  // 遅らせる先は 2 つあり、どちらも止めないと意味がない。
  //  - 点群の組み立て: 全期間（約 102 万点）で 1 回 16ms（最悪 45ms）＋ GPU 転送 52ms
  //  - **年ファイルの取得**: つまみを 1919 まで引きずると途中の 100 通りすべてで取得が走る。
  //    効果の後始末は打ち切りの印を立てるだけで**発行済みの取得は止めない**ため、
  //    ドラッグ 1 回で収録の全ファイル（33MB）を取りに行くことになる。
  const settledFilter = useDebouncedValue(catalogFilter, CATALOG_REBUILD_DEBOUNCE_MS)
  const settledView = useDebouncedValue(catalogView, CATALOG_REBUILD_DEBOUNCE_MS)
  const catalog = useHypocenterCatalog(
    jstYearOf(settledFilter.fromMs),
    jstYearOf(settledFilter.toMs),
    mapTab === 'catalog',
  )
  // 期間の端は、目次の終端ではなく読めた年ファイルの終端で止める（`useHypocenterCatalog` の `catalogEndMs`）
  const catalogIndex = useMemo(
    () => (catalog.index && catalog.catalogEndMs !== null && catalog.catalogEndMs !== catalog.index.coveredThroughMs
      ? { ...catalog.index, coveredThroughMs: catalog.catalogEndMs }
      : catalog.index),
    [catalog.index, catalog.catalogEndMs],
  )
  const catalogTailUntilMs = catalog.tail?.untilMs ?? null
  // 期間の終わりが前の端にあったか（末尾が届いて端が伸びたとき、終わりも一緒に伸ばすため）
  const catalogMaxRef = useRef<number | null>(null)
  // 索引が届いたら、期間を収録範囲へ収める。
  // **収める側も必要。** 年が明けた直後は「今年」がまだ収録されておらず、選択肢に無い値が残る。
  // **終わりはデータの最終日へ収める**（`catalogPeriodBounds`）。既定の終わり（今年の 12 月 31 日）は
  // 索引が来るまでの仮の値で、ここでデータの終端（2 日前前後）まで下がる。
  //
  // **マグニチュードの下限・上限は期間に合わせて動かさない**（2026-10-23 ユーザー選択「引き上げず
  // 注記で示す (Recommended)」）。完全性を割っていることは、手で下げたときと同じ注記
  // （`catalogCompleteness` → 震源カタログタブ）で示す。
  useEffect(() => {
    if (!catalogIndex || catalogIndex.years.length === 0) return
    const { minMs: lo, maxMs: hi } = catalogPeriodBounds(catalogIndex, catalogTailUntilMs)
    const prevMax = catalogMaxRef.current
    catalogMaxRef.current = hi
    // **終わりが前の端にあったら、伸びた端まで一緒に伸ばす**（`periodForBounds`）。
    // **収めるのは日ごと**（`clampPeriodToRange`）。両端をそれぞれ時刻で丸めると、選んでいる
    // 期間が丸ごと収録の外にあるときに同じ 1 点へ潰れ、1 件も残らないのに見出しは
    // 「1 日ぶん」と出る。
    setCatalogFilter((prev) => {
      const { fromMs, toMs } = periodForBounds(prev, prevMax, { minMs: lo, maxMs: hi })
      if (fromMs === prev.fromMs && toMs === prev.toMs) return prev
      return { ...prev, fromMs, toMs }
    })
  }, [catalogIndex, catalogTailUntilMs])
  const handleCatalogFilterChange = useCallback((next: CatalogFilter) => {
    setCatalogFilter(next)
  }, [])
  // **タブを離れても点群は捨てない。** 捨てると往復のたびに数十万点を詰め直すことになる
  // （地図側は visible で隠すだけ）。
  //
  // **離れている間は作り直しもしない。** つまみを動かした直後（150ms 以内）に別のタブへ移ると、
  // 待ちが明けたところで組み立て（最悪 45ms）と GPU 転送（52ms）が走る。移った先が
  // リアルタイム震度や EEW だと、そこでフレームが飛ぶ。**EEW の自動タブ切替とも重なりうる。**
  // 最後に組んだものを持ったまま止め、タブへ戻った時に一度だけ追いつかせる。
  const catalogCloudRef = useRef<CatalogPointCloud | null>(null)
  const catalogActive = mapTab === 'catalog'
  // **期間が末尾に掛かるまでは、末尾の無い並びで組む。** 末尾は索引より後に届き、届いた直後は期間の終わりがまだ前の端に
  // ある（伸ばすのは上の効果）。そこで末尾の入った並びに替えると、末尾の点が 1 つも入らない組み直しが 1 回余計に走る。
  // 年ファイルの終端は日の 0 時（日ごとに書き足す）なので、伸ばす前の終わり（前の日の最後の瞬間）はこの門を開けない。
  // 終端が日の途中になっても、その日の終わりまで選んだ期間には末尾の点が入るので、開いた組み直しは無駄にならない
  const catalogTailFromMs = catalog.tail?.fromMs ?? null
  const catalogCloudYears = catalogTailFromMs !== null && Math.max(settledFilter.fromMs, settledFilter.toMs) >= catalogTailFromMs
    ? catalog.years
    : catalog.catalogYears
  const catalogCloud = useMemo(() => {
    if (!catalogActive) return catalogCloudRef.current
    const next = catalogCloudYears.length > 0
      ? buildCatalogPointCloud(catalogCloudYears, settledFilter, settledView)
      : null
    catalogCloudRef.current = next
    return next
  }, [catalogActive, catalogCloudYears, settledFilter, settledView])

  // 津波発表中フラグ（解除済みでない津波情報があるか。Forecast＝若干の海面変動も含む）とバッジ用グレード
  // tsunamiGrade は色分け用のため MajorWarning/Warning/Watch のみ（Forecast は除外）。ナビのバッジへ渡すときだけ、予報だけの
  // 津波を `Forecast` として足す（→ IconNav へ渡す箇所）
  // cancelledAt（10秒表示中）は解除表示に切り替わっているため非アクティブ扱いにする（EEW・地震カードと同じ扱い）
  const tsunamiGrade = tsunamiOverallGrade(tsunamis)
  const tsunamiActive = tsunamis.some(t => !t.cancelled && !t.cancelledAt)

  // 初回ページロード時に REST API で取得した既存の EEW/津波状態をタイトルに反映する
  // （WebSocket 受信前に既にアクティブな情報がある場合のみ一度だけ動作）
  const initialTitleAppliedRef = useRef(false)
  useEffect(() => {
    if (initialTitleAppliedRef.current) return
    if (activeEEWsNoCancelled.size === 0 && !tsunamiActive) return
    initialTitleAppliedRef.current = true
    // 津波のみアクティブ・一定時間表示モード ON の場合は表示ウィンドウを開始する
    if (tsunamiActive && activeEEWsNoCancelled.size === 0 && settings.tsunamiTitleTemporary) {
      title.showTsunamiTitle()
    } else {
      // tsunami はタイトルフラグではなく実際の発表中フラグを渡す（初期反映のため override 必須）
      title.applyPriority({
        eews: activeEEWsNoCancelled,
        tsunami: tsunamiActive,
        priority: settings.tsunamiPriorityDefault,
        kyoshinDetected: false,
      })
    }
  }, [activeEEWsNoCancelled, tsunamiActive, settings.tsunamiPriorityDefault, settings.tsunamiTitleTemporary])

  // 津波解除検出: true→false の遷移でタイマーをキャンセルし優先度ロジックを即時適用
  //
  // **終わったことをタイトルへ出すのもここ**（「津波予報 失効」など。2026-10-12 ユーザー承認）。画面で
  // 発表中として出ていた津波が、画面の上で解除・取消・失効の表示へ変わったときだけ出す（`findEndedTsunami`）。起動時から
  // 解除の表示で入った津波・黙って消えた津波に出さないのは 2026-10-21 ユーザー選択「今のまま記録する (Recommended)」。
  // 受信処理ではなくここで決めるのは、どの津波に向いた解除かを画面の更新が既に決めているから（理由は
  // `findEndedTsunami`）。遷移は津波ごとに 1 度しか起きないので、重ねて届いた解除で出し直すこともない。
  const prevTsunamiActiveRef = useRef(false)
  useEffect(() => {
    if (!prevTsunamiActiveRef.current && tsunamiActive) {
      log.info(`[tsunami] 発表検出 grade=${tsunamiGrade}`)
    } else if (prevTsunamiActiveRef.current && !tsunamiActive) {
      const ended = findEndedTsunami(tsunamis)
      if (ended) {
        log.info(`[tsunami] 解除検出 (tsunamiActive: true→false) 終わりの語を出す cancelReason=${ended.cancelReason ?? 'なし'}`)
        title.showTsunamiEndTitle(ended.cancelReason)
      } else {
        log.info('[tsunami] 解除検出 (tsunamiActive: true→false) 解除の表示を経ずに消えたため終わりの語は出さない')
        title.endTsunamiTitleWindow()
        title.applyPriority({ tsunami: false })
      }
    }
    prevTsunamiActiveRef.current = tsunamiActive
  }, [tsunamiActive, tsunamiGrade, tsunamis])

  // アイドル復帰で戻すデフォルトタブ。津波優先トグル ON かつ津波発表中なら
  // 津波情報、それ以外は設定のデフォルトタブ（宣言はコンポーネント冒頭・代入はここ）。
  defaultTabRef.current =
    settings.tsunamiPriorityDefault && tsunamiActive ? 'tsunami' : settings.defaultTab
  // タイマーコールバック内で最新値を参照するための毎レンダー同期（activeEEWsRef と title 内部 ref）
  activeEEWsRef.current = activeEEWsNoCancelled
  title.syncInputs({
    tsunamiActive,
    tsunamiPriority: settings.tsunamiPriorityDefault,
    tsunamiTitleTemporary: settings.tsunamiTitleTemporary,
    idleRevertSec: settings.idleRevertSec,
  })

  // 設定秒数 情報更新（activeTab の自動切替・DMDSS 更新）もユーザー操作もなければ
  // デフォルトタブへ戻す。activeTab / lastUpdate の変化、操作のたび、および**読み上げが
  // 終わったとき**にリセット（4 つ目は下の `onSpeechIdle`）。
  // idleRevertSec が 0 以下なら自動復帰は無効。
  useEffect(() => {
    if (settings.idleRevertSec <= 0) return
    const ms = settings.idleRevertSec * 1000
    // 宣言を `revert` より前に置く（`revert` の中から張り直すため）。初回のセットは下。
    let timer: number | undefined
    // EEW 発報中または揺れ検知中はリアルタイムタブを維持する。それ以外はデフォルトタブへ戻す。
    const revert = () => {
      // **読み上げている間は既定の状態へ戻さない。** アイドル復帰は「離席したら速報へ返す」
      // ための仕組みで、声が流れているあいだは離席と見なせない。見ないと、各地の震度のように
      // 読み切りに 2 分近くかかる読み上げの最中に画面だけが持っていかれる —— 読み上げ追従が
      // 画面を要求するのは発話を投入する瞬間の 1 回だけなので、奪われても取り返せない
      // （→ docs/spec/audio-tts-spec.md §6「読み上げている間は既定の状態へ戻さない」）。
      //
      // **下の realtime へ留める経路（EEW 発報中・揺れ検知中）にも掛かる。** そちらを通すと、
      // EEW が生きているあいだ 30 秒ごとにリアルタイムへ引き戻され、直したい症状が残る。
      // 代償として、無関係な読み上げが続く間はリアルタイムへの引き戻しも遅れるが、**EEW と
      // 揺れ検知は自前の経路で画面を取る**（新規発報・レベルアップ・誤報取消は `eewUrgent`、
      // 揺れ検知は `requestTabForKyoshin`、読み上げが始まれば追従）。ここは取りこぼしの受け皿。
      //
      // 判定は `revertToDefaultTab` と同じ述語を通す（`idleRevertSec` が 0 以下の端末では
      // この effect 自体が動かないので、ここでは第 2 引数が偽になることはない）。
      if (shouldDeferRevertWhileSpeaking(isSpeaking(), settings.idleRevertSec)) {
        log.info('[tab] 読み上げ中のためアイドル復帰を見送り（読み終わってから計り直す）')
        // 読み上げの終わりでも計り直すが（下の `onSpeechIdle`）、通知を取りこぼしても
        // 永久に復帰しなくならないよう、ここでも張り直しておく。**発火済みのタイマーを
        // 消す必要はない**ので `reset` は通さない（あちらは宣言がこの下にある）。
        timer = window.setTimeout(revert, ms)
        return
      }
      // 特別情報のために一時的に開いたパネルも、ここで平常へ戻す（アイドル復帰は既定の状態へ
      // 戻す操作なので、パネルの畳みも元に戻すのが筋）。**判定はタブ移動の前に取る**。
      // 移動が追跡を消すため（`requestAutoTab`）、後から見ると常に「追跡なし」になる。
      // 畳むのは移動の後。タブ移動は必ずパネルを開くので、先に畳んでも打ち消される。
      const collapseAfterRevert = specialInfoPanelHoldRef.current === true
      // **震源カタログを見ている間は既定タブへ戻さない。** アイドル復帰は「離席したら速報へ返す」
      // ための仕組みだが、カタログは腰を据えて眺めるタブで、見ているだけの時間は操作として
      // 数えられない。実測では 1 分ほどで画面ごと持っていかれ、点群の探索が成立しなかった。
      // **EEW・揺れ検知への移動は従来どおり行う**（下の分岐）。進行中の揺れは過去の記録より優先する。
      if (activeEEWsRef.current.size > 0 || kyoshinDetectedRef.current) {
        const hasActiveEew = activeEEWsRef.current.size > 0
        log.info(`[tab] → realtime (アイドル復帰・${hasActiveEew ? 'EEW中' : '揺れ検知中'} idleRevertSec=${settings.idleRevertSec})`)
        // 必ず通したうえで保持も張る。優先度判定に任せると、直前の手動操作の保持（manual）に
        // 負けて拒否され、一発限りのタイマーは再スケジュールされないため二度と復帰しない。
        // 保持を張るのは、戻したはずの realtime を直後の地震情報に奪われないため
        // （実測: 復帰の 20 秒後に届いた地震情報が realtime を取っていた）。
        // 重みは張る理由に合わせる（揺れ検知だけのときに EEW 相当を張らない。理由は idleRevertPriority）。
        // 駆動源は `'idleRevert'`。読み上げ追従には譲る保持になる（理由は shouldAcceptAutoTab）。
        forceTab('realtime', idleRevertPriority(hasActiveEew), 'idleRevert')
      } else if (activeTabRef.current === 'catalog' && !settingsOpenRef.current) {
        // 設定の窓を開いたまま離れた場合は、下がカタログでも既定タブへ戻す（窓も閉じる。下の else）。
        // 眺めているのは設定で、カタログではない。
        log.info(`[tab] 震源カタログのためアイドル復帰を見送り (idleRevertSec=${settings.idleRevertSec})`)
        // **タイトルだけは他のタブと同じ時刻に平常へ戻す**（2026-10-23 ユーザー選択「復帰しないまま、タイトルだけ戻す
        // (Recommended)」）。カタログを眺めている間に古い地震情報のタイトルが出続けると、いま起きているように見える。
        if (!title.tsunamiTitleFlag()) {
          title.setTitle(null)
        }
      } else {
        log.info(`[tab] ${defaultTabRef.current} を要求 (アイドル復帰 idleRevertSec=${settings.idleRevertSec})`)
        revertToDefaultTab(`アイドル復帰 idleRevertSec=${settings.idleRevertSec}`)
        if (!title.tsunamiTitleFlag()) {
          title.setTitle(null)
        }
      }
      if (collapseAfterRevert) setPanelCollapsed(true)
      setSpecialInfoPanelHold(null)
    }
    timer = window.setTimeout(revert, ms)
    const reset = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(revert, ms)
    }
    // ドラッグ中のパン操作: ボタン押下中の移動のみリセット（ホバーだけでは反応させない）。
    const resetOnDrag = (e: PointerEvent) => {
      if (e.buttons) reset()
    }
    // 操作（クリック・キー入力・ホイール/タッチ/スクロール/ドラッグ）のたびにリセット。
    // すべて capture 段階で購読する。Leaflet は地図のホイールズームやドラッグ時に
    // stopPropagation でイベントを止めるため、バブリングでは window まで届かない。
    // capture なら Leaflet が止める前に window で先に拾える。scroll は非バブリングのため
    // もともと capture が必要。
    const opts = { passive: true, capture: true } as const
    window.addEventListener('pointerdown', reset, opts)
    window.addEventListener('pointermove', resetOnDrag, opts)
    window.addEventListener('keydown', reset, opts)
    window.addEventListener('wheel', reset, opts)
    window.addEventListener('touchmove', reset, opts)
    window.addEventListener('scroll', reset, opts)
    // **読み上げが終わった時点から計り直す。** 見送り（上の `isSpeaking`）だけだと、読み終えた
    // 直後に見送り分のタイマーが発火して唐突に画面が動く。見送りは最大 idleRevertSec の粒度
    // でしか判定できないため、終わりの瞬間はこちらで拾う。
    // **ここだけ記録を分ける。** `reset` は操作のたびにも呼ばれるので、ログが無いと
    // 「操作で計り直したのか、読み上げが終わって計り直したのか」を後から区別できない。
    const stopWatchingSpeech = onSpeechIdle(() => {
      log.debug('[tab] 読み上げが終わったのでアイドル復帰を計り直す')
      reset()
    })
    return () => {
      stopWatchingSpeech()
      window.clearTimeout(timer)
      window.removeEventListener('pointerdown', reset, true)
      window.removeEventListener('pointermove', resetOnDrag, true)
      window.removeEventListener('keydown', reset, true)
      window.removeEventListener('wheel', reset, true)
      window.removeEventListener('touchmove', reset, true)
      window.removeEventListener('scroll', reset, true)
    }
  // `settingsOpen` も計り直しの契機に入れる。窓の開け閉めは `activeTab` を変えないが、操作には違いない。
  }, [activeTab, settingsOpen, lastUpdate, settings.idleRevertSec])

  // 特別情報のために開いたパネルを、ユーザーが何か操作した時点で元へ戻す。
  // 「気づかせる」ための一時的な展開なので、気づいた合図（操作）があれば役目は終わり。
  // バナー自身の閉じるボタンを押した場合もクリックとして拾える。
  // 追跡していないときはリスナーを張らない（常時購読を増やさない）。
  useEffect(() => {
    if (specialInfoPanelHold === null) return
    const opts = { passive: true, capture: true } as const
    const restore = () => restoreSpecialInfoPanel()
    window.addEventListener('pointerdown', restore, opts)
    window.addEventListener('keydown', restore, opts)
    window.addEventListener('wheel', restore, opts)
    window.addEventListener('touchmove', restore, opts)
    return () => {
      window.removeEventListener('pointerdown', restore, true)
      window.removeEventListener('keydown', restore, true)
      window.removeEventListener('wheel', restore, true)
      window.removeEventListener('touchmove', restore, true)
    }
  }, [specialInfoPanelHold, restoreSpecialInfoPanel])

  // 強震モニタ（常時ポーリング: タブ非表示中も揺れ検知を継続する）
  // Yahoo hypoInfo の EEW を injectEvent で状態に注入する（音・タブ切替も発火）
  // 初期値は現在時刻なので日時として読めないことは起こらないが、`formatDateTimeLocal` は
  // 読めない値で `null` を返す。空文字へ落として `datetime-local` の未入力扱いにする
  // （`null` を `value` に渡すと制御・非制御が切り替わったと React に警告される）。
  const [kyoshinInputDateTime, setKyoshinInputDateTime] = useState(() => formatDateTimeLocal(new Date()) ?? '')
  const relayForecastScope = useSyncExternalStore(relayTokenStore.subscribe, relayTokenStore.forecastScope)
  const forecastKeyRelayRejected = forecastKeyToSend !== null && relayForecastScope !== null && !relayForecastScope.granted
  // 中継が予報キーを受け付けている。リプレイ・履歴・発生時刻の秒も中継から予報を引く（→ `relayRestClassifications`）
  const relayForecastGranted = forecastKeyToSend !== null && relayForecastScope?.granted === true
  // 過去の電文（リプレイ・発生時刻の秒）をどこからどの区分で引くか。鍵があれば、鍵が予報を断らない限り予報を鍵で
  // DMDATA から引く —— ライブと同じ電文で再生する（設計書 §0 の 2026-10-31「自分で契約した鍵を入れた利用者も、予報キーの端末と同じ動きになるようにする」の行。→ `restSources`）
  const keyRestEndpoint = useMemo(
    () => (isValidDmdataApiKey(debouncedApiKey) ? dmdataKeyEndpoint(debouncedApiKey) : null),
    [debouncedApiKey],
  )
  const pastSources = useMemo(
    () => restSources(dmdataClassifications, relayForecastGranted, keyRestEndpoint !== null, keyForecastRefused),
    [dmdataClassifications, relayForecastGranted, keyRestEndpoint, keyForecastRefused],
  )
  // リプレイの取得・世代管理は useReplayController に集約している（非同期の完了順序に
  // 依存する状態機械のため、単体でテストできる形に切り出した）。
  // 時計への反映（setClockReplayOffset）は上の useEffect が replayTimeOffset を見て行う。
  // 取得元は中継（`relayRestEndpoint`）経由の DMDATA のアーカイブで、当時の電文をまとめて取る。
  // 対象期間がローカル履歴アーカイブに重なればそちらから読む（下記）。
  // 設定の窓の「テスト時刻設定」に出す、収録済みローカル履歴アーカイブの一覧。
  // DMDATAのアーカイブが存在しない期間（DMDATAアーカイブの最古=2020-11-18より前等）を
  // 再現するための同梱データで、対象時刻がこの中の期間に該当すれば下記 fetchReplayEvents が
  // 通常のアーカイブ取得の代わりにこちらを使う（localArchiveReplay.ts 参照）。
  const { archives: historicalArchives, isLoading: historicalArchivesLoading } = useHistoricalArchiveIndex()
  const fetchReplayEvents = useCallback(
    (from: Date, to: Date, signal: AbortSignal, purpose: ReplayFetchPurpose) => {
      // 収録範囲の中でも、電文を集めていない日だけを見る窓は止める（2018 年北海道胆振東部地震は
      // 余震の前後 6 日だけを集めている）。空の成功で返すと「何も無かった」と区別が付かない
      // （2026-10-22 ユーザー選択「止めて理由を出す (Recommended)」）。目的ごとの扱いは `uncollectedFetchVerdict`。
      const verdict = uncollectedFetchVerdict(historicalArchives, from, to, purpose)
      if (verdict.kind === 'empty') return Promise.resolve(emptyReplayFetchResult())
      if (verdict.kind === 'reject') {
        // 帯は画面の言語の地震の名前で、ログと記録に残る `message` は日本語の名前で組む
        return Promise.reject(new LocalizedError(
          errorText('localArchiveNoDay', historicalArchiveLabel(verdict.archive, messagesRef.current.settings.replay.archives)),
          JA_MESSAGES.errorText.localArchiveNoDay(historicalArchiveLabel(verdict.archive, JA_MESSAGES.settings.replay.archives)),
        ))
      }
      const covering = findCoveringArchiveSync(historicalArchives, from, to)
      if (covering) return fetchLocalArchiveEvents(covering, from, to)
      // 収録範囲の終端を過ぎた直後（先読みが1時間ごとに次のウィンドウを取りに来た結果、
      // ここで初めて収録範囲外に出た）場合、DMDATAにはそもそもデータの無い時代
      // なので静かにフォールバックせず、専用のエラーで知らせる（見つからなければ null で
      // 通常どおりのフォールバックへ進む）。
      const justEnded = findArchiveJustEndedSync(historicalArchives, from, REPLAY_WINDOW_MS)
      if (justEnded) {
        return Promise.reject(new LocalizedError(
          errorText('localArchiveEnded', historicalArchiveLabel(justEnded, messagesRef.current.settings.replay.archives)),
          JA_MESSAGES.errorText.localArchiveEnded(historicalArchiveLabel(justEnded, JA_MESSAGES.settings.replay.archives)),
        ))
      }
      // 「試験報を受信（検証用）」はライブだけでなく再生にも効かせる。**設定の文面は
        // 経路を限っていない**のに、ここへ渡さないと「ライブでは届くが再生では届かない」
        // という、名前から読み取れない食い違いになる。訓練報は年に数回しか流れないので、
        // 再生で拾えないと実電文で確かめる手段が事実上テストボタンだけになる。
        // 区分はライブの接続が取り決めたものを使う（再生中はライブを止めているが、値は残っている）。
        // 一度も繋がっていなければ中継の既定の区分で引く。予報は、中継が予報キーを受け付けていれば中継から、
        // 自分の鍵の予報が通っていれば鍵から引く（→ `restSources`・`fetchReplayFromSources`）
      return fetchReplayFromSources(
        // 初期状態（窓の手前 24 時間）は電文ログの行を載せないので、その本体を取りに行かない入口を使う
        (endpoint, classifications) => (purpose === 'initial' ? fetchDmdataReplayInitialEvents : fetchDmdataReplayEvents)(
          endpoint, from, to, settings.dmdataTestDelivery, classifications, signal,
        ),
        relayRestEndpoint, keyRestEndpoint, pastSources,
      )
    },
    [settings.dmdataTestDelivery, historicalArchives, pastSources, keyRestEndpoint],
  )
  // 再生開始時刻より前の履歴（地震カードの一覧と、初期状態に足す 24 時間より前の電文）。
  // 取得元は再生用と同じく中継経由の DMDATA のアーカイブ。**ライブ接続時の初回履歴と同じ範囲を読む**
  // —— 日次アーカイブを 7 日ぶん（件数では打ち切らない。→ `HISTORY_WINDOW_DAYS`）。
  // こちらも fetchReplayEvents と同じく、対象期間がローカル履歴アーカイブに重なればそちらを使う
  // （重ならなければ DMDATA 側は「そもそもデータの無い時代」で必ず失敗するため）。
  // ローカル履歴アーカイブも 7 日ぶんを全部返し、件数では切らない（2026-10-14 ユーザー選択）。
  // 重なり判定には履歴の遡り幅（7 日）ではなく fetchReplayEvents の「初期状態」と同じ
  // REPLAY_PRE_WINDOW_MS（24時間）を使う。ここを独自の幅にすると、本編・初期状態はアーカイブに
  // 重ならないのに履歴だけ数日先の無関係なアーカイブに重なってしまい、再生は実データ側で
  // 止まっているのに地震カードだけローカルアーカイブ由来の古い1件を表示する、という不整合が起きる。
  //
  // **結果には再生中の「もっと見る」で続きを読む口（`loadMore`）を付ける**（→ `ReplayQuakeHistoryResult`）。
  // 続きも同じ取得元から、再生開始より前の側へ読む。ローカル履歴アーカイブは収録範囲の外を持たないので付けない。
  const fetchReplayQuakeHistory = useCallback(
    (before: Date, signal: AbortSignal): Promise<ReplayQuakeHistoryResult> => {
      const covering = findCoveringArchiveSync(historicalArchives, new Date(before.getTime() - REPLAY_PRE_WINDOW_MS), before)
      if (covering) return fetchLocalArchiveQuakeHistory(covering, before, HISTORY_WINDOW_DAYS).then(r => withoutFetchWindow(r, before))
      // 履歴（再生開始より前の地震カード）も本編と同じ扱いにする。片方だけ通すと
      // 「再生には訓練報が出るのにカードの一覧には無い」形でずれる。
      const classifications = relayRestClassifications(dmdataClassifications, relayForecastGranted)
      const { dmdataTestDelivery } = settings
      // 窓を 1 つ読む口。再生中の「もっと見る」と期間の読み足しも同じ口で読む（どの日を読むかは useEarthquakes が決める）
      const fetchWindow = (windowBefore: Date, maxDays: number, windowSignal: AbortSignal | null, gateTag: GateTag | undefined) =>
        fetchDmdataQuakeHistoryFor(
          classifications, relayRestEndpoint, windowBefore, maxDays, dmdataTestDelivery, windowSignal,
          undefined, undefined, gateTag,
        )
      return fetchWindow(before, HISTORY_WINDOW_DAYS, signal, undefined).then(result => withFetchWindow(result, before, fetchWindow))
    },
    [settings.dmdataTestDelivery, historicalArchives, dmdataClassifications, relayForecastGranted],
  )
  /**
   * 行動チェックリストのリセット。**宣言が `useReplayController` より後になる**ため、
   * `defaultTabRef` と同じ作法で ref 経由に渡す（実体の代入は下方・呼ばれるのは
   * 常にレンダー後なのでタイミング上問題ない）。
   */
  // 地図に重ねる凡例。**中身は地図が決める** —— 各レイヤーの表示条件から組んだものを受け取り、
  // ここでは並べ方（`buildLegendBlocks`）だけを担う。
  const [legendSources, setLegendSources] = useState<MapLegendSources>(EMPTY_LEGEND_SOURCES)
  const heatLegendPeriod = useMemo<LegendHeatmapPeriod | null>(
    () =>
      heatWindowStartMs === null
        ? null
        : {
            period: settings.heatmapPeriod,
            startLabel: formatHeatmapDate(heatWindowStartMs),
            replay: replayTimeOffset !== null,
            note: heatmapCompletenessNote(heatCompleteness, messages),
            text: messages.map.legend.periodRange(formatHeatmapDate(heatWindowStartMs), replayTimeOffset !== null),
          },
    [heatWindowStartMs, settings.heatmapPeriod, replayTimeOffset, heatCompleteness, messages],
  )
  const legendBlocks = useMemo(
    () => withHeatmapPeriod(buildLegendBlocks(legendSources, messages), heatLegendPeriod),
    [legendSources, heatLegendPeriod, messages],
  )
  const changeHeatmapPeriod = useCallback((period: HeatmapPeriod) => {
    updateSetting('heatmapPeriod', period)
  }, [updateSetting])
  // 地図が低い画面では畳んだ状態から始める。**測るのは地図領域の実寸**で、画面の幅や
  // ブレークポイントでは決まらない（上下分割の比率つまみと折りたたみで変わる）。
  const mapAreaRef = useRef<HTMLDivElement | null>(null)
  const [mapAreaShort, setMapAreaShort] = useState(false)
  // 判定は `isMapAreaShort` の 1 つだけ（`undefined` は「決めない」＝前の判定を据え置く）。
  // **初回だけは描画の前に測る。** `ResizeObserver` のコールバックは必ず非同期で来るので、
  // 待つと狭い画面（既定は畳む）でも 1 フレームだけ開いた凡例が見えてから畳まれる。
  // `useLayoutEffect` ならブラウザが描く前に state が確定する。
  useLayoutEffect(() => {
    const short = isMapAreaShort(mapAreaRef.current?.getBoundingClientRect().height)
    if (short !== undefined) setMapAreaShort(short)
  }, [])
  useEffect(() => {
    const el = mapAreaRef.current
    // **測れないときは記録を残す。** `mapAreaShort` は偽のままなので「狭い画面でも畳まない」側へ
    // 倒れるが、画面には「`auto` なのに一度も畳まれない」としか現れず、機能が発火していないことに
    // 気づけない。
    if (!el || typeof ResizeObserver === 'undefined') {
      log.warn('[legend] 地図領域の高さを測れないため、凡例の自動折りたたみは働きません', {
        hasElement: !!el,
        hasResizeObserver: typeof ResizeObserver !== 'undefined',
      })
      return
    }
    const ro = new ResizeObserver((entries) => {
      const short = isMapAreaShort(entries[0]?.contentRect.height)
      if (short !== undefined) setMapAreaShort(short)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // 地図の上の隅の列（左上の状態・右上の自作地震計）の下端と、地図の高さ。行動チェックリストの帯は隅の下端から始め、
  // 地図の高さで上限を掛ける（→ `checklistTopPadding`）。隅の列は異常の行や観測点の数で縦に伸びるので、
  // 帯の上の余白を固定にすると重なる。
  // **初回は描画の前に測る**（凡例の `mapAreaShort` と同じ理由。帯が一度重なってから下がるのを見せない）。
  // **見張るのは隅の列と地図の両方。** 隅の列だけだと、回転などで位置（`offsetTop`）だけが動いたときに気づけない。
  const topCornersRef = useRef<HTMLDivElement | null>(null)
  const [topCornersBottom, setTopCornersBottom] = useState(0)
  // 地図に重ねる縦並びの伸びる空白。上端に並ぶもの（行動チェックリスト）の下端を、開いた帯の本文の上限に使う
  const overlayStackSpacerRef = useRef<HTMLDivElement | null>(null)
  const [mapAreaHeight, setMapAreaHeight] = useState<number | null>(null)
  useLayoutEffect(() => {
    const el = topCornersRef.current
    const area = mapAreaRef.current
    // **測れないときは記録を残す。** 帯は下限の 3rem から始まり、隅の列が伸びると重なるが、画面には異常として現れない。
    if (!el || !area) {
      log.warn('[layout] 地図の上の隅の列か地図を測れないため、行動チェックリストの帯は上の余白 3rem で出します', {
        hasCorners: !!el,
        hasMapArea: !!area,
      })
      return
    }
    const measure = () => {
      setTopCornersBottom(el.offsetTop + el.offsetHeight)
      setMapAreaHeight(area.clientHeight)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') {
      log.warn('[layout] 地図の上の隅の列の高さを見張れないため、行動チェックリストの帯の始まりが初回の値のままになります')
      return
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    ro.observe(area)
    return () => ro.disconnect()
  }, [])
  // 縦積みで下部の波形が出ている間の高さの配り方に使う寸法（→ utils/waveStackLayout.ts）。
  // 測るのは器（地図の列・つまみ・パネル・下のナビを積む）と地図の列とパネル、それに波形の先頭の段。
  // **つまみとナビの高さは「器 − 地図の列 − パネル ＋ 重ねている量」で出す** —— 1 つずつ測ると、器に何かを足したときに
  // 引き忘れる。パネルを地図の列へ重ねている間は、重ねた分だけ差が縮むので足し戻す（足し戻さないと、重ねるほど
  // つまみとナビが低く測れ、重ねる量がまた増える）。
  const waveOverlapRef = useRef(0)
  const layoutRef = useRef<HTMLDivElement | null>(null)
  const mapColumnRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [layoutSize, setLayoutSize] = useState<{ width: number; height: number; other: number } | null>(null)
  // 波形の先頭の段の高さ。**測れていない・枠が無いなら `null`**（SeismoWaveChart が外すときに戻す）。
  const [waveLeadRowHeight, setWaveLeadRowHeight] = useState<number | null>(null)
  useLayoutEffect(() => {
    const el = layoutRef.current
    const column = mapColumnRef.current
    const panel = panelRef.current
    // **測れないときは記録を残す。** 波形の 1 段を残す配り方が働かず、画面には「波形が出ると波形が押し出される」
    // （直す前の症状）としか現れないため（凡例の自動折りたたみと同じ扱い）。
    if (!el || !column || !panel || typeof ResizeObserver === 'undefined') {
      log.warn('[layout] 地図の列とパネルの高さを測れないため、縦積みの画面で波形の 1 段を残す配り方は働きません', {
        hasContainer: !!el,
        hasMapColumn: !!column,
        hasPanel: !!panel,
        hasResizeObserver: typeof ResizeObserver !== 'undefined',
      })
      return
    }
    const report = () => {
      const r = el.getBoundingClientRect()
      const other = r.height - column.getBoundingClientRect().height - panel.getBoundingClientRect().height + waveOverlapRef.current
      setLayoutSize((prev) => (prev !== null && prev.width === r.width && prev.height === r.height && prev.other === other
        ? prev
        : { width: r.width, height: r.height, other }))
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    ro.observe(column)
    ro.observe(panel)
    return () => ro.disconnect()
  }, [])
  // `'auto'` は「まだ触っていない」状態。触ったらその選択を設定へ固定する。
  const legendCollapsed = settings.mapLegendCollapsed === 'auto'
    ? mapAreaShort
    : settings.mapLegendCollapsed === 'collapsed'
  const toggleLegend = useCallback(() => {
    updateSetting('mapLegendCollapsed', legendCollapsed ? 'open' : 'collapsed')
  }, [legendCollapsed, updateSetting])

  const resetActionChecklistRef = useRef<() => void>(() => {})
  /** 別地点発報のエピソード状態のリセット。上と同じ理由で ref 経由に渡す。 */
  const resetKyoshinAlertsRef = useRef<() => void>(() => {})
  // 同じ場所の 2 つ目の地震（`utils/kyoshinReonset.ts`）の記憶。使うのは下の `useMemo` だが、
  // リプレイの開始・停止で落とすために `resetLocalState` より前に置く
  const reonsetStateRef = useRef(createReonsetState())
  /**
   * リプレイの開始・停止で落とす画面側の一時状態。
   *
   * **時間軸に紐づくものだけを落とす。** 利用者の意思で決まったもの（パネルの折りたたみ・
   * 震源カタログの絞り込み・タブ・行動チェックリストの抑止記録）は残す。判断の一覧と
   * 落とさない理由は [`docs/spec/settings-pwa-spec.md`](../docs/spec/settings-pwa-spec.md) §6。
   */
  const resetLocalState = useCallback(() => {
    // 選択中の地震（`selectedQuakeIdRef` も揃う）。落とさないと、同じ地震が再び届いた瞬間に
    // 選択が復活する（`selectedQuake` の引き当ては鍵だけを見るため）。
    selectQuake(null)
    // **追加表示は無条件に落とす。** `selectQuake(null)` が閉じるのは選択の実体が非 null
    // だったときだけで、EEW カードから開いた長周期は選択を通らない（実体が null のまま開いて
    // いることがある）。そちらは EEW が消えた副作用で別の effect が閉じるが、1 テンポ遅れる
    // うえ「ここを見ればリセットが完結している」と読めなくなる。
    applyQuakeOverlay(null, 'リセット')
    // 長周期の節を見せる求め。引き当て済みの分は上の `selectQuake(null)` が落とすので、ここは引き当て前の分。
    // 残すと、新しい時間軸で同じ地震のカードが現れた瞬間に古い求めで巻く
    setLpgmFocusRequest(null)
    // 特別情報でパネルを開いたときの「元の状態」。持ち越すと、次にバナーが消えたときに
    // 切り替え前の状態へ戻す。
    setSpecialInfoPanelHold(null)
    // ブラウザ通知の重複抑止。残すと、同じ地震を再生したときに 2 回目の通知が出ない。
    // 積んだままの報も捨てる（旧い時間軸の報で、新しい画面のカードを引き当てないように）。
    // **空にせず差し替える。** 通知は Service Worker の返事を待ってから覚えるので、リセットより前に出した
    // 通知が後から済むと、同じ Map なら新しい時間軸の記憶へ覚えてしまう。差し替えれば古いほうへ覚えるだけ。
    notifiedQuakesRef.current = new Map()
    quakeNotifyChainsRef.current = new Map()
    pendingQuakeNotifyRef.current = []
    pendingQuakeCancelNotifyRef.current = []
    resetActionChecklistRef.current()
    // 別地点発報のエピソード状態。旧い時間軸の「発報済み」が残ると、新しい軸で鳴るべき
    // 別地点発報が黙って抑え込まれる（時刻の巻き戻りでは自動で切り替わるが、前へ飛ばした
    // 切替では発火しない）。
    resetKyoshinAlertsRef.current()
    // 緊急地震速報の「予想が変わった」の帯を初めて見た時刻。残すと、同じ窓を再生し直したとき帯が一度も出ない。
    resetEewForecastChangeSeen()
    // 2 つ目の地震と取り下げカードの記憶。時刻の巻き戻りでは自動で捨てるが、前へ飛ばした切替では
    // 旧い時間軸の「立ち上がった点」「降ろした検知」が残る
    reonsetStateRef.current = createReonsetState()
  }, [selectQuake])

  const replay = useReplayController({
    fetchEvents: fetchReplayEvents,
    fetchQuakeHistory: fetchReplayQuakeHistory,
    restoreQuakeHistory,
    clearCache: clearReplayCache,
    timeOffset: replayTimeOffset,
    setTimeOffset: setReplayTimeOffset,
    resetState,
    resetTracking,
    resetLocalState,
    restorePreWindowTracking,
    loadReplayEvents,
  })
  // 設定の窓・地震カードの再生ボタンからリプレイを始めた回数を使用状況データに数える（許可している間だけ）。診断アクセサ（下）からの開始は数えない
  const replayStart = replay.start
  const startReplayCounted = useCallback((...args: Parameters<typeof replayStart>) => {
    countUsage('replay')
    return replayStart(...args)
  }, [replayStart])

  // 外からリプレイを操るための診断アクセサ（`__frameProfiler`・`__cameraUpdateSkip` 等と同じ流儀）。
  //
  // **設定の窓の UI を叩かせないために置いている** —— UI 経由にすると、文言やレイアウトを
  // 変えるたびに外部からの操作が壊れ、「画面の見た目」と「外から操る口」が結びついてしまう。
  //
  // `speaking()` は「読み上げが終わったか」を待つために使う。固定の秒数で待つと、読み上げの
  // 長さは読む地域の数で変わるぶん足りたり余ったりする。
  const replayAccessRef = useRef({
    offset: replayTimeOffset, fetching: replay.isFetching, error: replay.error,
    start: replay.start, stop: replay.stop,
  })
  // レンダー中に ref を書き換えない（React が捨てたレンダーの書き込みだけが残りうるため）。
  useEffect(() => {
    replayAccessRef.current = {
      offset: replayTimeOffset, fetching: replay.isFetching, error: replay.error,
      start: replay.start, stop: replay.stop,
    }
  })
  useEffect(() => {
    ;(window as unknown as Record<string, unknown>).__replay = {
      /** 再生中のシナリオ時刻（epoch ms）。ライブ中は実時刻。 */
      now: () => serverNow(),
      /** 壁時計に足しているオフセット(ms)。`null` ならライブ。 */
      offset: () => replayAccessRef.current.offset,
      /** 電文を取りに行っている最中か。落ち着いてから次の操作へ移るため。 */
      fetching: () => replayAccessRef.current.fetching,
      /**
       * 取得の失敗。`null` なら失敗していない。
       *
       * **これが無いと、外から見て成功と失敗が同じ形になる** —— `fetching()` は成否に
       * かかわらず最後は `false` へ戻るので、それだけを見ていると失敗を「開始できた」と読む。
       */
      error: () => replayAccessRef.current.error,
      /** 読み上げの最中か。 */
      speaking: () => isSpeaking(),
      /**
       * 溜まったイベントを汲み出す（返した分はバッファから消える）。
       *
       * **`speaking()` だけでは、連続して読み上げたものが 1 本に融ける。** あちらが答えるのは
       * 「いま読み上げているか」だけで、どの発話かを持たないため。イベントログは 1 本ごとに
       * 開始と終了を出し、それぞれがどの電文のものかを指す
       * （→ `docs/spec/recording-interface-spec.md`）。
       *
       * **定期的に汲むこと。** 溜めておける件数には上限があり、超えると古い方から捨てる。
       * 捨てた件数は戻り値の `dropped` に出る（`seq` の飛びからも読める）。
       *
       * **コールバックではなくポーリングの形にしてある。** 外の録画ツールは CDP 越しに
       * `window.__replay.*()` を呼ぶだけで、ページからの通知は受け取れない。
       */
      drainEvents: () => drainReplayEvents(),
      /** 消さずに覗く（デバッグ用）。汲み出しの妨げにならないよう `dropped` も持ち越す。 */
      peekEvents: () => peekReplayEvents(),
      /** 指定した日時から再生を始める。 */
      start: (iso: string) => {
        const at = new Date(iso)
        if (!Number.isFinite(at.getTime())) throw new Error(`日時として読めません: ${iso}`)
        // **`void` で捨てない。** `useReplayController` の `start` は、取得処理こそ内部で
        // 捕まえるが、その手前の同期処理（セッションの採番・状態のリセット・時刻オフセットの
        // 適用）は try の外にある。そこで投げると拾い手のない拒否になり、ログにも画面にも
        // 残らない。
        replayAccessRef.current.start(at).catch((e: unknown) => {
          log.error('[replay] __replay.start が失敗しました', e)
        })
      },
      /** 再生を止めてライブへ戻す。 */
      stop: () => { replayAccessRef.current.stop() },
    }
    return () => { delete (window as unknown as Record<string, unknown>).__replay }
  }, [])

  // リプレイ中、対象時刻がローカル履歴アーカイブの収録範囲に重なる場合、そのidを
  // useKyoshinRealtime へ渡す。ローカル限定生成の強震モニタ風データ（scripts/capture-kyoshin-waveform.ts）
  // が存在すればそちらを使い、無ければ何も供給されない（従来どおりYahooには到達不能な時代のため）。
  // nowTickをdepsに入れて毎秒再評価する。timeOffset自体が変わるタイミング（再生開始・ジャンプ）
  // でしか判定しないと、収録範囲の外から連続再生で境界を跨いだ場合に一生ローカルアーカイブへ
  // 切り替わらない（敵対的レビューで指摘）。
  // ただし評価に使う「今」はnowTickの値そのものではなくDate.now()+replayTimeOffsetを都度
  // 組み立てる（nowTickは「再評価のきっかけ」としてdepsに入れているだけ）。nowTickの値は
  // ライブ接続中は実時刻、リプレイ中はリプレイ時刻を指すため、replayTimeOffsetが変わった
  // 直後の最初のレンダーではまだ古いモードの値のまま（例: ライブの2026年時刻）残っている
  // ことがあり、それをそのまま使うと一瞬だけ「収録範囲外」と誤判定してYahooのアーカイブ
  // ソースが起動し、2018年等の到達不能な日付へのfetchが403エラーとしてコンソールに残る
  // （実機確認で発覚。テスト時刻設定の手動入力で再現した）。
  const localKyoshinArchiveId = useMemo(() => {
    if (replayTimeOffset == null) return null
    const now = new Date(Date.now() + replayTimeOffset)
    return findCoveringArchiveSync(historicalArchives, now, new Date(now.getTime() + 1))?.id ?? null
  }, [replayTimeOffset, nowTick, historicalArchives])

  // 強震モニタ（Yahoo hypoInfo）の緊急地震速報は全員が受ける。同じ地震は DMDATA の報が届いたら丸ごと置き換える
  // （`mergeEewReport`。docs/relay-server-design.md §0 の 2026-10-30 の行）
  const kyoshin = useKyoshinRealtime(true, {
    onEEWEvent: injectEvent,
    timeOffset: replayTimeOffset,
    localArchiveId: localKyoshinArchiveId,
  })
  // 強震モニタの揺れ検知は組み合わせの検知器（`utils/kyoshinEnsembleDetector`）で行う。
  // 検知結果は音・自動タブ切替・自動フィット・地図オーバーレイ・リアルタイムタブのカードを駆動する。
  const kyoshinV2 = useKyoshinDetectorV2(kyoshin.sites, kyoshin.indices, kyoshin.dataTime, kyoshin.sitesSiteConfigId, kyoshin.indicesSiteConfigId, true, kyoshin.supplyKey, kyoshin.warmup, kyoshin.backfill)
  // 検知の束の広がりを EEW の自動解除へ渡す（`utils/eewSpreadHold.ts`）。供給が作り直される（時間軸が変わる）と
  // データ時刻が空になり、検知器は束の名前を振り直すので、そのとき覚えた束を捨てる
  useEffect(() => {
    if (kyoshinV2.dataTime === '') {
      eewSpreadLog.reset()
      return
    }
    eewSpreadLog.push(Date.parse(kyoshinV2.dataTime), kyoshinV2.detections)
  }, [eewSpreadLog, kyoshinV2.dataTime, kyoshinV2.detections])
  // 最寄りの観測点へ P 波が届くまでは解除を待つので、観測点の座標も渡す（観測網から遠い海域の地震。eew-spec §7）
  // 一覧を取り直す間に空になっても前の一覧を保つ（空にすると、待っている解除が観測網への波を待たずに消える）
  useEffect(() => {
    if (kyoshin.sites.length > 0) eewSpreadLog.setSites(kyoshin.sites)
  }, [eewSpreadLog, kyoshin.sites])
  // siteConfigId 切替直後の一時的な「新 indices・旧 sites」状態では sites[i] と indices[i] を
  // 位置対応で使う下流（描画・タブ表示・派生ビュー）でも誤ペアリングが起きるため、両者の
  // siteConfigId が揃うまで空配列にゲートする。sitelist の非同期取得が完了した次フレームで
  // 元の実データに戻る（切替頻度は年数回、非表示時間はネットワーク往復 1 回分）。
  const kyoshinSitesGated = kyoshin.sitesSiteConfigId != null
    && kyoshin.sitesSiteConfigId === kyoshin.indicesSiteConfigId
    ? kyoshin.sites : EMPTY_SITES
  const kyoshinIndicesGated = kyoshin.sitesSiteConfigId != null
    && kyoshin.sitesSiteConfigId === kyoshin.indicesSiteConfigId
    ? kyoshin.indices : EMPTY_INDICES
  // 表示用インデックス: 1〜2 秒で復帰する欠測（瞬断）を直前値で埋め、保持中の点を stale で示す。
  // Yahoo の秒データは強く揺れている観測点でも単発で欠測を返すため、素通しすると震度6強級の
  // バッジが 1 秒だけ消えて次の秒で戻る明滅になる（実測は utils/kyoshinMissingHold.ts 冒頭）。
  // **検知（上の useKyoshinDetectorV2）には生の kyoshin.indices を渡し続ける**——欠測判定・
  // 慢性ノイズ床の学習を保持値で汚さない。一方で、下の deriveKyoshinView を通す表示状態には保持値を
  // 使う。そのため音・通知・地域単位発報の入力（candidateMaxIndex / confirmedShocks）も保持値を見る
  // ことになるが、これは意図した設計（欠測を素通しすると最大震度を担う点の 1 秒欠測が「揺れが弱まった」
  // と解釈され、復帰時に更新音が誤って鳴る）。範囲の詳細は utils/kyoshinMissingHold.ts 冒頭。
  const kyoshinHeld = useKyoshinMissingHold(kyoshinIndicesGated, kyoshin.dataTime, kyoshin.sitesSiteConfigId)
  // 検知が走ったとき、その前後の生の観測値を記録する（設定の窓から書き出せる）。
  // 渡すのは表示用の保持値ではなく**検知エンジンと同じ生値**——記録の目的は
  // 「エンジンが何を見て検知したか」を後から再生することなので、加工前の値でなければ意味がない。
  useDetectionDiagnostics(
    kyoshinV2.detections,
    kyoshinSitesGated,
    kyoshinIndicesGated,
    kyoshin.dataTime,
    kyoshin.indicesSiteConfigId,
  )
  // V2 検知イベント → 表示状態（confirmed/candidate・検知点・候補点）へ変換する
  const kyoshinView = useMemo(
    () =>
      deriveKyoshinView(
        kyoshinV2.detections,
        kyoshinSitesGated,
        kyoshinHeld.indices,
        kyoshinHeld.stale,
      ),
    [kyoshinV2.detections, kyoshinSitesGated, kyoshinHeld],
  )
  // 検知点マーカーが描く点列そのものを検知カードにも渡す（地図とカードで数える集合を構造的に揃える。
  // 以前はカード側でも同じ計算を組み立てていたが、同一の結果になることに頼ると片方の変更で黙って
  // 食い違う。詳細は docs/spec/kyoshin-detection-spec.md §8）。
  const kyoshinDetectedPoints = useMemo(
    () => [...kyoshinView.detectedPoints, ...kyoshinView.unconfirmedPoints],
    [kyoshinView],
  )
  // 同じ場所の 2 つ目の地震の合図（`utils/kyoshinReonset.ts`）。寄せる先は、まとまって立ち上がった
  // 観測点のうち最も強い点（保持値を含む表示用の値で比べる。揺れフォーカスの寄せ先と同じ考え方）。
  // 同じフレームを二度渡しても結果は変わらない（StrictMode の二重実行で崩れない）。
  //
  // **時刻は検知結果の `kyoshinV2.dataTime` を使う**（強震モニタの取得の時刻 `kyoshin.dataTime` ではない）。
  // 検知結果は取得の時刻が進んだ後のレンダーで更新されるので、取得の時刻を使うと「時刻 T・検知 T-1」で
  // 呼ばれ、同じ時刻の二度目を捨てる `stepReonset` が検知を常に 1 フレーム遅れて取り込む。
  const kyoshinReonset = useMemo(() => {
    const alert = stepReonset(
      reonsetStateRef.current,
      kyoshinV2.detections,
      kyoshinV2.recentOnsetKeys,
      new Date(kyoshinV2.dataTime).getTime(),
    )
    if (!alert) return null
    const keys = new Set(alert.keys)
    let best: { lat: number; lng: number; index: number } | null = null
    for (const p of kyoshinView.detectedPoints) {
      if (keys.has(p.key) && (best === null || p.index > best.index)) best = p
    }
    // 印（`key`）はイベント ID と合図を出したデータ時刻から作る。同じ合図を作り直しても（依存の
    // `kyoshinView` だけが変わったレンダー・StrictMode の二重描画）印は同じなので、鳴らす側は 1 回だけ動く
    const stamp = { key: `${alert.eventId}@${alert.atMs}`, atMs: alert.atMs }
    if (best) return { ...stamp, focus: { lat: best.lat, lng: best.lng }, index: best.index }
    // 立ち上がった点が地図の点に無い（まだ描いていない・観測点リストの入れ替え中など）ときは、
    // 点のキーの座標へ寄せる。それも読めなければイベントの重心へ寄せる。
    // **合図は捨てない** —— `stepReonset` は既に鳴らしたことにしていて、合図はその地震の波で説明できる間
    // 次の合図を止めるので、ここで捨てると知らせないまま黙る（`confirmedShocks` の寄せ先と同じ考え方）
    const keyPos = alert.keys.map(keyLatLng).find((p) => p !== null)
    if (keyPos) return { ...stamp, focus: { lat: keyPos[0], lng: keyPos[1] }, index: null }
    const ep = kyoshinV2.detections.find((d) => d.id === alert.eventId)?.epicenter
    if (ep) return { ...stamp, focus: { lat: ep[0], lng: ep[1] }, index: null }
    log.warn(`[kyoshin] 同じ場所の 2 つ目の揺れの寄せ先を引けなかった（${alert.eventId}）。寄せずに音だけ鳴らす`)
    return { ...stamp, focus: null, index: null }
  }, [kyoshinV2.detections, kyoshinV2.recentOnsetKeys, kyoshinV2.dataTime, kyoshinView])
  // 震度0ドット表示専用: 検知エンジンが学習した慢性ノイズ床でフィルタする（震度1+表示には手を入れない）
  // PERF-1: kyoshin モード以外では KyoshinSubThreshold レイヤーが表示されないため、
  // 他モードのとき filterSubThresholdIndices の毎秒 1725 点走査をスキップする
  // （`undefined` を返せば JapanMapGL 側で kyoshinIndices にフォールバックする）。
  //
  // 床は観測点の並びで対応づけるため、**床がこの観測点配列に対して計算されたものか**を参照で確かめる
  // （`floorsSites`。理由は useKyoshinDetectorV2 の同フィールド）。不一致の間はフィルタをかけずに素の
  // 震度を出す（消すより出す方へ倒す）。
  //
  // ここで「フィルタが効いていない」ことを別途記録しないのは、素通りが続く状況の**主な原因が別の形で
  // 記録される**ため。観測点リストの差し替え直後の不一致は次のデータ時刻で解消し、解消しない場合は
  // 原因側が記録を出し続ける——観測点リストの取得が失敗し続けるなら useKyoshinRealtime が、
  // 組み合わせの検知器が例外を投げ続ける・観測点数と震度の件数が食い違うなら useKyoshinDetectorV2 が。
  // 記録に現れない経路も 1 つ残っている（観測点リストを並行して取りに行ったときの応答順の入れ替わり。
  // 取得は成功しているので失敗の記録には出ない。docs/spec/data-sources-spec.md の「残る既知の課題」）。
  const kyoshinSubIndices = useMemo(
    () => (mapMode === 'kyoshin' && kyoshinV2.floorsSites === kyoshinSitesGated
      ? filterSubThresholdIndices(kyoshinSitesGated, kyoshinHeld.indices, kyoshinV2.floors)
      : undefined),
    [mapMode, kyoshinSitesGated, kyoshinHeld, kyoshinV2.floors, kyoshinV2.floorsSites],
  )
  // タイマーコールバック内から最新の confirmed 値を参照する ref（宣言はコンポーネント冒頭・代入はここ）
  kyoshinDetectedRef.current = kyoshinView.confirmed

  // 警報級の状況（EEW 発報中・津波発表中・揺れ検知中）が立ち上がったときの保険。
  // 通常はタブ切替（setActiveTab ラッパー）が展開を担うが、優先度の保持（tabHoldRef）で
  // 自動移動が拒否されている間はタブ切替自体が起きないため、
  // 状況の変化そのものからも展開できるようにしておく。
  const alertActive = hasActiveEEW || tsunamiActive || kyoshinView.confirmed
  useEffect(() => {
    if (alertActive) setPanelCollapsed(false)
  }, [alertActive])

  // EEWデータから P波・S波半径を自前計算（100ms更新でスムーズ拡張）
  // eewsForMap（activeEEWsNoCancelled の配列）と同一内容のため使い回して二重 useMemo を避ける。
  const psWave = usePsWaveCalc(eewsForMap, replayTimeOffset)

  const home = useMemo(
    () => (settings.homeLat !== null && settings.homeLng !== null
      ? { lat: settings.homeLat, lng: settings.homeLng }
      : null),
    [settings.homeLat, settings.homeLng],
  )
  // 地点ごとの到達予想を自前の走時計算で出してよいか。**トークンが有効なときだけ true。**
  // 自前で出すのは気象業務法第 17 条の許可を要する地震動の予報業務に当たりうるため、既定では
  // 気象庁が区域ごとに出した到達予測時刻を伝えるだけにする（→ `utils/arrivalToken.ts`）。
  // **門と設定の窓の表示は同じ 1 つの検証結果から出す。** 別々に検証すると、期限の境目で
  // 「画面は有効と言っているのに自前計算は動かない」が起きる（→ `hooks/useArrivalToken.ts`）。
  const arrivalTokenStatus = useArrivalTokenCheck(settings.arrivalToken)
  const allowOwnArrivalCalc = arrivalTokenStatus.valid
  const swaveArrival = useSWaveCountdown(psWave, eewsForMap, home, hasActiveEEW, allowOwnArrivalCalc)
  // 地図の下端の波形（自作地震計・公開観測点）へ P/S の到達線を引く相手。**予報円のある速報すべて**
  // （`utils/countdownEew.ts`。2026-10-14 ユーザー決定「地震ごとに並べて出す」。どの地震の線かは見分けない ——
  // 2026-10-18 ユーザー承認「見分けない」）。**到達予想キーの門は掛けない**（2026-10-14 ユーザー承認）——線は到達時刻を
  // 過ぎてから描くだけで、これから来る時刻を出さないので予報業務に当たらないと整理した（`docs/forecast-computation-audit.md`
  // の 11）。歯止めは波形の側の「右端＝いま、それより先の線は描かない」（`SeismoWaveChart/liveLanes.ts` の `liveArrivalMarks`）。
  // **配列は顔ぶれが変わったときだけ作り直す** —— `psWave` は 100ms ごとに新しい配列になるが、波形の側は
  // 速報の参照が変わったときだけ走時を解き直す。毎回新しい配列を渡すと、そのたびに全観測点の走時を引き直す。
  // 鍵は予報円の顔ぶれ（地震の鍵の並び）。速報そのものが続報で差し替わったときは `eewsForMap` の参照で拾う。
  // 区切りは改行（地震の鍵に空白が入っても割り戻しがずれないように）。
  const arrivalCircleKey = psWave.map((c) => c.eventId).join('\n')
  const seismoArrivalEews = useMemo(
    () => pickArrivalEews(psWave, eewsForMap),
    // `psWave` を鍵に入れない（100ms ごとに変わる）。顔ぶれは `arrivalCircleKey` が表す。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [arrivalCircleKey, eewsForMap],
  )
  // **引き当てられない円は線を引かない**（`pickArrivalEews`）。黙って消えないよう記録する ——
  // 記録は副作用なので `useMemo` の中で出さない（StrictMode で 2 回出る）。
  // **見るのは円の顔ぶれが変わったときだけ**（鍵に `seismoArrivalEews` を入れない）。速報の一覧はどの地震の続報でも
  // 作り直され、取消のときは一覧が先に縮んで円が最大 100ms 残る —— 一覧の変化で見ると、取消のたびに
  // 「引き当てられない」と記録して本物の食い違いを埋もれさせる。
  useEffect(() => {
    const missing = arrivalCircleKey === ''
      ? []
      : arrivalCircleKey.split('\n').filter((id) => !seismoArrivalEews.some((e) => eewEventKey(e) === id))
    if (missing.length > 0) log.debug('[eew] P/S 線の相手を引き当てられない予報円', { eventIds: missing })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrivalCircleKey])
  const toggleSeismoWaveExpanded = useCallback(() => {
    updateSetting('seismoWaveExpanded', !settings.seismoWaveExpanded)
  }, [settings.seismoWaveExpanded, updateSetting])

  // 地震後の行動チェックリスト。EEW・強震モニタ・地震情報の 3 経路で発火する（詳細は
  // useActionChecklist）。観測点座標は他の利用箇所と同じキャッシュを共有するため、ここで
  // 呼んでも追加の取得は起きない。
  const stationCoordsForChecklist = useStationCoords()
  // **チェックリストには取消を当てた直後の EEW も渡す。** 出している帯の元が取り消されたことを
  // 知る手段がこれしか無い（判定からは向こうで外す。理由は useActionChecklist の `eews`）。
  const eewListForChecklist = useMemo(() => [...activeEEWs.values()], [activeEEWs])
  const eewListNoCancelled = useMemo(() => [...activeEEWsNoCancelled.values()], [activeEEWsNoCancelled])
  // どのタブからでも見える速報・津波の帯（→ components/AlertDock・utils/alertDock.ts）。
  // **今いるタブの項目は出さない**（速報はリアルタイムタブ、津波は津波タブ。2026-11-09 ユーザー選択「移った先では消す」）。
  // 登録地点の県は、県の境界の点内判定で引く（津波の登録地点の段は、その県に掛かる津波予報区から選ぶ）。
  const prefectureShapes = usePrefectures()
  const homePrefCode = useMemo(
    () => (home && prefectureShapes ? homePrefectureCode(home.lat, home.lng, prefectureShapes, PREFECTURES) : null),
    [home, prefectureShapes],
  )
  // 登録地点があるのに県が引けないと、津波の帯の登録地点の段が黙って消える。座標が海上・県境データの外なら起きうるので記録する
  useEffect(() => {
    if (home && prefectureShapes && homePrefCode === null) log.warn('[帯] 登録地点の座標がどの都道府県にも入らず 5 km 以内にも無いので、津波の帯に登録地点の段を出さない')
  }, [home, prefectureShapes, homePrefCode])
  const dockEews = useMemo(
    () => (activeTab === 'realtime' ? [] : buildEewDockItems(eewListNoCancelled, swaveArrival, messages, placeNames)),
    [activeTab, eewListNoCancelled, swaveArrival, messages, placeNames],
  )
  const dockTsunami = useMemo(
    () => (activeTab === 'tsunami' ? null : buildTsunamiDockItem(tsunamis, homePrefCode, TSUNAMI_ZONE_PREFECTURES, messages, placeNames)),
    [activeTab, tsunamis, homePrefCode, messages, placeNames],
  )
  // 登録地点の周り（半径 30km）。**行動チェックリストと自作地震計の波形が同じものを見る**
  // ので、ここで 1 つだけ作って両方へ渡す（→ hooks/useNearbyScope.ts）。
  const nearbyScope = useNearbyScope({
    home,
    stationCoords: stationCoordsForChecklist,
    kyoshinSites: kyoshinSitesGated,
  })
  const actionChecklist = useActionChecklist({
    // 切ってあるときは -1（`useActionChecklist` の取り決め）。最低震度そのものは切っても残す
    minScale: settings.actionChecklistEnabled ? settings.actionChecklistMinScale : -1,
    scope: nearbyScope,
    // 検知エンジンが確定した揺れのメンバー観測点を渡す（音・地図の検知点と同じ集合）。
    // 生の観測値を渡すと 1 点の跳ね上がりがそのまま表示される震度になる（理由は
    // kyoshinScaleForScope）。値は保持値なので、強く揺れている最中の単発の欠測でも落ちない。
    detectedPoints: kyoshinView.detectedPoints,
    // エンジンが詰まって検知結果を出せない間は、空の結果を「揺れていない」と読ませない。
    kyoshinStalled: kyoshinV2.stalled,
    eews: eewListForChecklist,
    quakes: earthquakes,
  })
  // 宣言が useReplayController より後になるため ref 経由で渡す（上記 resetLocalState 参照）。
  resetActionChecklistRef.current = actionChecklist.resetForReplay
  // 地図が低い画面では、行動チェックリストを畳んだ札で出し、押したら地図の上に重ねて開く
  // （2026-11-04 ユーザー選択「狭いときは札で出す (Recommended)」。開いたまま出すと、帯と合わせて地図の 9 割以上を覆っていた）。
  // 低いかの境は凡例が自動で畳む境と同じ（`mapAreaShort`）。**フックの「閉じた」記録には触らない** ——
  // ここで畳むのは見せ方だけで、閉じるボタンを押したときの扱い（次の余震を畳んで出す）はフックが持つ。
  // 札を押して開いた帯の識別子を覚え、別の揺れの帯に替わったら札へ戻す。
  const [checklistPeekKey, setChecklistPeekKey] = useState<string | null>(null)
  const checklistKey = actionChecklist.state?.key ?? null
  const checklistCompact = mapAreaShort && !actionChecklist.collapsed && checklistPeekKey !== checklistKey
  const checklistOverlay = mapAreaShort && !actionChecklist.collapsed && checklistPeekKey === checklistKey
  const restoreChecklist = useCallback(() => {
    setChecklistPeekKey(checklistKey)
    actionChecklist.restore()
  }, [checklistKey, actionChecklist.restore])
  // 閉じた・帯が消えた（リプレイの開始と停止を含む）ら、札を開いた記録を捨てる。残すと、同じ揺れが震度を上げて
  // フックが開き直したときや、同じ地震を再生し直したときに、札を押していないのに重ねて開く
  const checklistGone = actionChecklist.state === null || actionChecklist.collapsed
  useEffect(() => {
    if (checklistGone) setChecklistPeekKey(null)
  }, [checklistGone])

  // 直前に鳴らした（鳴らす機会のあった）地震と秒数。**地震の鍵と組で覚える** —— 秒数だけで比べると、
  // 地震が替わった直後に前の地震と同じ秒数だったとき鳴らない。
  const prevBeepRef = useRef<{ key: string; etaSec: number } | null>(null)
  useEffect(() => {
    // 地震が複数あっても音は 1 本 —— まだ届いていない地震のうち到達がいちばん早いもの
    // （2026-10-18 ユーザー承認「いちばん早く届く地震」→ `countdownBeepTarget`）。
    const target = countdownBeepTarget(swaveArrival)
    const prev = prevBeepRef.current
    if (
      settings.soundEnabled &&
      target !== null &&
      target.etaSec >= 1 &&
      target.etaSec <= 5 &&
      (prev === null || prev.key !== target.key || prev.etaSec !== target.etaSec)
    ) {
      playCountdownBeep(target.etaSec)
    }
    prevBeepRef.current = target
  }, [swaveArrival, settings.soundEnabled])

  // 揺れの強まり（レベルアップ・再エスカレーション）と別地点発報で、その 1 点へ一時的に寄せる合図。
  // 通知音を鳴らすのと同じ判定で useKyoshinAlerts が出し、地図（FitToDetectionGL）が消費する。
  const [shakeFocus, setShakeFocus] = useState<ShakeFocus | null>(null)
  const handleShakeFocus = useCallback((point: { lat: number; lng: number }) => {
    setShakeFocus((prev) => ({
      lat: point.lat,
      lng: point.lng,
      // 同じ座標が続いても寄り直せるよう連番で進める（座標の等値では「さらに強まった」を表せない）。
      tick: (prev?.tick ?? 0) + 1,
      atMs: Date.now(),
    }))
  }, [])

  // 揺れ検知の開始/終了・レベル変化に応じたタブ切替・タイトル・通知音・ブラウザ通知
  const kyoshinAlerts = useKyoshinAlerts({
    confirmed: kyoshinView.confirmed,
    candidate: kyoshinView.candidate,
    candidateMaxIndex: kyoshinView.candidateMaxIndex,
    confirmedShocks: kyoshinView.confirmedShocks,
    dataTime: kyoshin.dataTime,
    // 検知が「止まった」ことによる消失と、揺れが収まったことによる消失を見分けさせる
    // （見分けないと、上流の異常から復帰したときに同じ地震で警報が鳴り直す）。
    stalled: kyoshinV2.stalled,
    settings,
    title,
    activeEEWsRef,
    defaultTabRef,
    // 揺れ検知の優先度を付けて渡す（生の setActiveTab を渡すと保持が張られず、直後の
    // 地震情報に画面を奪われる）
    setActiveTab: requestTabForKyoshin,
    revertToDefaultTab,
    onShakeFocus: handleShakeFocus,
    reonset: kyoshinReonset,
    detectedPoints: kyoshinView.detectedPoints,
    speakDetection: speakKyoshinDetection,
  })
  // 宣言が useReplayController より後になるため ref 経由で渡す（上記 resetLocalState 参照）。
  resetKyoshinAlertsRef.current = kyoshinAlerts.resetForReplay

  // 報の一覧で前の報を押している間は、地図もその報の時点にする（→ `historyView`）
  const mapHistoryView = mapTab === 'earthquake' ? historyView : null
  const mapQuake = mapHistoryView ? mapHistoryView.quake : mapTab === 'earthquake' ? selectedQuake : latest
  // 地図に出す推計震度分布図。**地図が出している地震のものだけ**を渡す（引き当ては
  // 発現時刻。→ `estimatedIntensityFor`）。別の地震のものを渡すと、まるで違う場所の
  // 分布が「気象庁の推計」として重なる。
  const mapEstimatedIntensity = mapHistoryView ? mapHistoryView.estimatedIntensity : estimatedIntensityFor(mapQuake, estimatedIntensities)
  const mapDistributionMode = !!mapQuake && distributionQuakeKey === quakeEventKey(mapQuake)
  // 未入電の印を寄り具合に関わらず出すか。**地図が出している地震のものだけ**を見る
  // （分布モードと同じ理由）。
  const mapUnreceivedMode = !!mapQuake && unreceivedQuakeKey === quakeEventKey(mapQuake)

  // 未入電を声に出しているあいだだけ未入電モードを開く（→ `useUnreceivedSpeechFollow`）。
  //
  // **開く相手はセッションが持つ主題（読んでいる地震）で決める。** 「いま選ばれている地震」で
  // 代用すると、読み上げの順番待ちのあいだに別の地震が届いて選択が移ったとき、**A の未入電を
  // 読みながら B の一覧を開く**（選択は受信した瞬間に同期で動き、読み上げの番とは独立している）。
  //
  // **開かない条件は 4 つ**（追わない条件。津波の追従が 4 つ持っているのと同じ形）。
  // 「開かないことを選んだ」（`declined`）と「開くべきなのに開けない」（`mismatch`）を
  // 分けて返すのは、前者を診断へ載せると正常な見送りで記録が埋まるため。
  //
  // - **地震タブを見ていない** → `declined`。津波やリアルタイムを見ている最中に地図だけ
  //   未入電の画へ変わるのを防ぐ（タブ移動は読み上げ追従の側が別に判断する）
  // - **他の追加表示が開いている** → `declined`。3 つは排他（`quakeOverlay.ts`）なので、ここで
  //   開くと利用者が手で開いた震度分布・長周期が閉じる。しかも閉じる番は元へ戻さないので、
  //   操作していないのに消えたようにしか見えない
  // - **読んでいる地震が画面に出ていない** → `mismatch`。主題を持たない読み上げ（地震以外）も
  //   ここへ来る。本来この経路は地震の読み上げしか通らない
  // - **その地震に未入電の地点が 1 つも無い** → `mismatch`。未入電を読み上げているのに地点が
  //   無いのは、読み上げ文と画面のカードが食い違っている印
  const openUnreceivedForSpeech = useCallback((subject: string | undefined): UnreceivedOpenResult => {
    const decision = decideUnreceivedSpeechOpen({
      activeTab,
      overlay: quakeOverlay,
      subject,
      selectedKey: selectedQuakeKey,
      // **見るのは地点名の有無まで。** 座標表で引けるかは見ない（引けない地点はカードの一覧に
      // 出る。地図へ置けなかったことは別に記録する）。カードのボタンを出す条件・自動で閉じる
      // 条件と同じ述語に揃えてある。
      hasUnreceivedPoints: !!selectedQuake?.points.some(p => p.unreceived && p.addr),
    })
    if (decision === 'opened') applyQuakeOverlay({ kind: 'unreceived', eventKey: subject! }, '未入電の読み上げ')
    return decision
  }, [selectedQuake, selectedQuakeKey, activeTab, quakeOverlay])
  // **開いたときと同じ地震のものだけ閉じる。** 開けてから閉じるまでの間に選択が移っていれば、
  // そこにあるのは利用者が開き直した別の表示（`closeUnreceivedOverlayFor`）。
  const closeUnreceivedForSpeech = useCallback((subject: string | undefined, reason: string) => {
    if (!subject) return
    // 記録は `applyQuakeOverlay` が出す。ここが渡すのは理由だけ（別の経路が先に閉じていれば
    // 何も動かないので、記録も出ない）。
    applyQuakeOverlay(prev => closeUnreceivedOverlayFor(prev, subject), reason)
  }, [])
  useUnreceivedSpeechFollow({
    session: unreceivedFollowSession,
    isOpen: unreceivedQuakeKey !== null,
    open: openUnreceivedForSpeech,
    close: closeUnreceivedForSpeech,
  })
  /**
   * 津波の読み上げが借りた震源を語っているあいだ、その原因地震のカードを見せる。
   *
   * **見送る条件は 1 つだけ**（主題を持たない読み上げ＝`declined`）。未入電の自動開閉が 4 つ
   * 持っているのに対して少ないのは、**要求する中身が「排他の追加表示を開くこと」ではなく
   * 「タブとカードの選択」だから** —— 他人が開いたものを閉じることも、地図の画を作り替える
   * こともしない。見ているタブで絞らないのも同じ理由で、津波タブを見ている最中に震源を語るのは
   * まさに追従したい場面（→ `hooks/useBorrowedHypocenterFollow.ts`）。
   *
   * **カードが見つからないのは `mismatch`。** 震源を借りられるのはカードがある地震だけなので、
   * 語っているのに相手がいないのは読み上げ文と画面が食い違っている印。
   *
   * 優先度は地震情報のもの（`quake`）。津波の追従（`tsunami`）より低いが、**読み上げ追従どうしは
   * 保持を見ない**ので弾かれない（→ `utils/tabPriority.ts` の `shouldAcceptAutoTab`）。
   */
  const showQuakeForBorrowedHypocenter = useCallback((subject: string | undefined): BorrowedHypocenterShowResult => {
    if (!subject) return 'declined'
    const card = earthquakesRef.current.find(q => quakeEventKey(q) === subject)
    if (!card) return 'mismatch'
    // **渡すのはカードの `eventKey`（＝ここでは `subject` そのもの）で、`card.id` ではない。**
    // `selectedQuakeId` は選択中カードの導出で `quakeEventKey(q)` と突き合わされるため、生電文の
    // `id` を入れるとどのカードにも一致せず、**黙って「一覧の最新カード」へ落ちる**
    // （`latestNonCancelled` のフォールバック）。語っている地震とは別のカードが選ばれるのに、
    // 例外もログも出ない。
    //
    // **`explicit` は渡さない。** 利用者の操作ではないので、地図の強制フィットまでは起こさない
    // （電文起点の自動追従と同じ扱い → `selectQuake` の注記）。
    selectQuake(subject)
    followSpeechTab('earthquake', TAB_PRIORITY.quake)
    return 'shown'
  }, [selectQuake, followSpeechTab])
  useBorrowedHypocenterFollow({
    session: borrowedHypocenterFollowSession,
    show: showQuakeForBorrowedHypocenter,
  })
  // 共有カード（表示中の地図を 1 枚の画像にする）。撮影は地図そのものを操作するため実体が要る
  // ——地図の生成時に受け取って持つ。地図へ重ねる UI は App が配置する決まりなので、
  // それを起こすボタンもここに置く。
  // 公開観測点（気象庁の広帯域地震計・EarthScope 経由）の下部の波形（→ hooks/usePublicWaves.ts）。
  //
  // **再生中は再生時刻の分を保存庫から取る**（`docs/public-waveform-design.md` §0）。
  const publicWaves = usePublicWaves({
    // 設定「公開観測点の波形を表示」がオフなら繋がない・取らない（地図の印もこれと地震カードから作るので一緒に消える）
    enabled: settings.publicWaveEnabled,
    replayOffsetMs: replayTimeOffset,
    spanSec: settings.waveSpanSec,
    alwaysConnected: settings.publicWaveAlwaysConnected,
    // 発表中の速報すべてで地震ごとに選んで合わせる。予報円を描かない速報（仮定震源要素・深さ不明）も含む（→ `pickPublicWaveEews`）。
    eews: pickPublicWaveEews(psWave, eewsForMap),
    detectedPoints: kyoshinView.detectedPoints,
  })

  // 自作地震計（`seismo-host/`）の観測点の震度。**設定が切れていれば繋がない。**
  //
  // **再生中は押し出しへ繋がない。** ホストが押し出すのは「いまの震度」だけなので、繋いだままにすると
  // **画面の他が過去なのにここだけ現在**という食い違いが起きる。ライブ接続を止めるのと同じ扱いへ揃える
  // （`ConnectionStatus` の `replay`）。**代わりに再生時刻のぶんをホストから読み返して出す**（`useSeismoReplay`。
  // 2026-10-22 選択「当時のデータで出す (Recommended)」）。
  //
  // 波形は「表示しない」以外で要求する。**「揺れたときだけ」でも受け取り続ける** ——
  // 切り替えると SSE を繋ぎ直すので、揺れを検知してから上げたのでは間に合わない
  // （繋ぎ直しに数百 ms〜数秒かかり、しかもその時点から 0 秒ぶんしか波形が無い）。
  // 60 秒のリングバッファを持つ意味も、揺れる前から溜めておいてこそ。
  const seismo = useSeismoStation({
    enabled: settings.seismoEnabled && replayTimeOffset === null,
    baseUrl: settings.seismoHostUrl,
    wave: settings.seismoWave === 'off' ? 'none' : 'station',
  })
  const seismoReplay = useSeismoReplay({
    enabled: settings.seismoEnabled,
    baseUrl: settings.seismoHostUrl,
    replayOffsetMs: replayTimeOffset,
    wave: settings.seismoWave === 'off' ? 'none' : 'station',
  })
  // 地図の帯・下端の波形・波形を出すかの判定が見る観測点。**再生中は読み返した再生時刻のぶん。**
  const seismoView = replayTimeOffset === null ? seismo : seismoReplay
  // **帯は震度のある行だけ**（再生中に震度の記録が無い時刻は出さない。波形だけ読めた行は下端の波形のために残す）。
  const seismoOverlayStations = useMemo(
    () => (replayTimeOffset === null ? seismoView.stations : seismoView.stations.filter((s) => s.source.kind === 'station')),
    [replayTimeOffset, seismoView.stations],
  )
  // 有感の地震カードへ出す、その区間の波形（→ hooks/useSeismoQuakeWaves.ts）。
  //
  // **押し出しと違って再生中も動かす。** 時刻の範囲を指定して取るので、
  // 「いまの値が過去の画面へ混ざる」ことが起きない（2026-09-29 のユーザー判断）。
  //
  // **波形を出さない設定なら取りに行かない。** `seismoWave` は「いまの波形」を
  // 出すかどうかの設定だが、絵そのものを見たくないという意思表示でもある。
  // 地震カードの発生時刻を秒まで決める（P/S 線の起点。→ hooks/useQuakeOriginSeconds.ts）。
  // **波形を出す設定のときだけ動かす** —— 出さないなら取りに行く理由も、端末に残す理由も無い。
  const quakeOriginSeconds = useQuakeOriginSeconds({
    // 自作・公開のどちらかの波形カードに使うときだけ、発生秒を取りに行く。
    enabled: settings.publicWaveEnabled || (settings.seismoEnabled && settings.seismoWave !== 'off'),
    // 引く先と区分はリプレイの取得と同じ（→ 上の `fetchReplayFromSources` の呼び出し）
    sources: pastSources,
    keyEndpoint: keyRestEndpoint,
    quakes: filteredEarthquakes,
    activeEEWs,
    replayOffsetMs: replayTimeOffset,
  })
  // 地震カードの「▶ 再生」（→ `EarthquakeCard` の `onReplay`）。その地震の 30 秒前から再生する（→ utils/quakeReplayStart.ts）。
  //
  // **ライブ中だけ確認の窓を挟む**（2026-11-08 ユーザー選択「ライブ中だけ確認する (Recommended)」）。始めるとライブの受信が止まり、
  // 表示中の地震・津波・速報は捨てられる。再生中は既にライブが止まっているので、確かめずに始め直す。
  //
  // 発生時刻の秒（`quakeOriginSeconds`）は波形の設定が入っているときだけ求めている。求めていなければ
  // 電文の時刻から「発生が入りうる最も早い時刻」を起点にする（待ちが少し長くなるだけで、揺れ始めは取りこぼさない）。
  //
  // **関数は ref 越しに最新の一覧を読む。** 一覧や秒の表を依存に入れると、届くたびに関数が変わり、
  // 地震タブとカードの memo が素通りする。
  const [quakeReplayConfirmAt, setQuakeReplayConfirmAt] = useState<number | null>(null)
  const quakeReplayInputsRef = useRef({ quakes: filteredEarthquakes, originSeconds: quakeOriginSeconds, replaying: replayTimeOffset !== null })
  useEffect(() => {
    quakeReplayInputsRef.current = { quakes: filteredEarthquakes, originSeconds: quakeOriginSeconds, replaying: replayTimeOffset !== null }
  })
  const startQuakeReplayAt = useCallback((startMs: number) => {
    // `void` で捨てない（→ 上の `__replay.start` と同じ理由。同期部分で投げると拾い手が無い）
    startReplayCounted(new Date(startMs)).catch((e: unknown) => {
      log.error('[replay] 地震カードからの再生を始められませんでした', e)
    })
  }, [startReplayCounted])
  const replayQuakeFromCard = useCallback((eventKey: string, firstReportMs: number | null) => {
    const { quakes, originSeconds, replaying } = quakeReplayInputsRef.current
    const quake = quakes.find((q) => quakeEventKey(q) === eventKey)
    if (quake === undefined) {
      log.warn(`[replay] 再生ボタンの地震が一覧に見つかりません: ${eventKey}`)
      return
    }
    const startMs = quakeReplayStartMs(quake, originSeconds.get(eventKey), firstReportMs)
    if (!Number.isFinite(startMs)) {
      log.warn(`[replay] 再生を始める時刻を決められません: ${eventKey} time=${quake.earthquake.time}`)
      return
    }
    if (replaying) startQuakeReplayAt(startMs)
    else setQuakeReplayConfirmAt(startMs)
  }, [startQuakeReplayAt])
  // 答えは窓が開いている間の値で始める。状態の更新関数の中で始めない（開発時の二重実行で 2 回始まる）
  const answerQuakeReplayConfirm = useCallback((start: boolean) => {
    if (start && quakeReplayConfirmAt !== null) startQuakeReplayAt(quakeReplayConfirmAt)
    setQuakeReplayConfirmAt(null)
  }, [quakeReplayConfirmAt, startQuakeReplayAt])
  // 波形を出すかを見る範囲は、登録地点ではなく自作地震計の周り（座標が無ければ登録地点。→ hooks/useSeismoScope.ts）。
  // 地図の下端の波形（下の `useSeismoWaveVisibility`）と地震カードの波形（すぐ下）の両方が使う。
  const seismoScope = useSeismoScope({
    stations: seismoView.stations,
    homeScope: nearbyScope,
    stationCoords: stationCoordsForChecklist,
    kyoshinSites: kyoshinSitesGated,
  })
  const { waves: seismoQuakeWaves, failedEventKeys: seismoWaveFailedKeys } = useSeismoQuakeWavesWithStatus({
    enabled: settings.seismoEnabled && settings.seismoWave !== 'off',
    baseUrl: settings.seismoHostUrl,
    // 打ち切りは届いた地震すべてで決め、取りに行くのは地震タブに出ている地震だけ（2026-11-07 選択「届いた全部の地震で切る (Recommended)」）
    quakes: earthquakes,
    shownEventKeys: shownQuakeKeys,
    scope: seismoScope,
    readWave: seismo.readWave,
    replayOffsetMs: replayTimeOffset,
    originSeconds: quakeOriginSeconds,
    subscribeWaveRevised: seismo.subscribeWaveRevised,
  })
  // 地震カードに出す公開観測点の波形（→ hooks/usePublicQuakeWaves.ts）。
  //
  // **再生中も動かす**（`docs/public-waveform-design.md` §0「リプレイ中は、地震カードに加えて下部の波形も再生時刻の分を出す」）。
  // 地震の時刻を指定して保存庫から取るので、いまの値が過去の画面へ混ざらない（自作地震計のカードと同じ）。
  //
  // **下部の波形に出している地震は、その番号を引き継ぐ**（カードの番号を地図の印と揃える。2026-10-15 ユーザー決定）。
  const publicLiveNumbers = useMemo(
    () => (publicWaves.visible ? new Map(publicWaves.stations.map((st) => [st.code, st.number])) : null),
    [publicWaves.visible, publicWaves.stations],
  )
  const publicQuakeWaves = usePublicQuakeWaves({
    enabled: settings.publicWaveEnabled,
    quakes: earthquakes,
    shownEventKeys: shownQuakeKeys,
    originSeconds: quakeOriginSeconds,
    openedEventKey: selectedQuakeKey,
    liveNumbers: publicLiveNumbers,
    readLiveRaw: publicWaves.readRawWave,
    replayOffsetMs: replayTimeOffset,
  })
  // 自作地震計を先に、続けて公開観測点を番号順に（§6.3）。**変わっていない地震は前の配列を使い回す**（→ utils/mergeQuakeWaves.ts）。
  const quakeWavesRef = useRef<ReadonlyMap<string, readonly SeismoQuakeWave[]>>(new Map())
  const quakeWaves = useMemo(() => {
    const cards = new Map([...publicQuakeWaves].map(([key, list]) => [key, list.map((w) => w.card)]))
    const merged = mergeQuakeWaves(seismoQuakeWaves, cards, quakeWavesRef.current)
    quakeWavesRef.current = merged
    return merged
  }, [seismoQuakeWaves, publicQuakeWaves])
  // 地図の公開観測点の印。**下部の波形を出している間はそちらを優先し**、出していなければ開いている地震カードの観測点を出す
  // （2026-10-15 ユーザー決定）。
  const openedPublicWaves = selectedQuakeKey === null ? undefined : publicQuakeWaves.get(selectedQuakeKey)
  const publicStationMarkers: readonly PublicStationMarker[] = publicWaves.visible
    ? publicWaves.stations
    : mapMode === 'quake' && openedPublicWaves !== undefined
      ? openedPublicWaves
      : NO_PUBLIC_STATIONS
  const [mapHandle, setMapHandle] = useState<MapHandle | null>(null)
  const shareCard = useShareCard(mapHandle, {
    mode: mapMode,
    quake: mapQuake,
    tsunamis,
    tsunamiSourceQuakes: allQuakeCards,
    eews: eewsForMap,
    // 出典に何を挙げるかは「地図に描かれているか」で決まるため、表示の設定をそのまま渡す。
    showBathymetry: settings.showBathymetry,
    showActiveFaults: settings.showActiveFaults,
    showPlateBoundaries: settings.showPlateBoundaries,
    // 公開観測点の三角は、下部に波形を出している間か、地震カードを開いている間だけ地図に描く（`PublicStationMarkersGL`）。
    showPublicStations: publicStationMarkers.length > 0,
    // 揺れ検知中の見出し（緊急地震速報が無いとき）。最大リアルタイム震度の段は、ブラウザ通知の本文が使う値と同じ式で決める
    // （確定中は確定した点の最大・可能性の段階は主候補の最大。`useKyoshinAlerts` の `effectiveKyoshinMaxIndex`）。
    // どちらも値を持つ点が無ければ -1（欠測）——0 は「0未満」と焼かれるので、欠測を 0 から始めない
    kyoshinDetection: kyoshinView.confirmed
      ? { state: 'confirmed', maxIndex: kyoshinView.confirmedShocks.reduce((max, s) => Math.max(max, s.index), -1) }
      : kyoshinView.candidate
        ? { state: 'candidate', maxIndex: kyoshinView.candidatePeakIndex }
        : null,
  }, settings.showMapLegend ? legendBlocks : EMPTY_LEGEND_BLOCKS, SHARE_CARD_FORMATS[settings.shareCardFormat])
  // 絵を出すかどうかは受け取るかどうかと別に決める（→ hooks/useSeismoWaveVisibility.ts）。
  //
  // **再生中も設定どおりに判定する**（観測点は再生時刻のぶん。→ `useSeismoReplay`）。再生している EEW・強震モニタの
  // 検知・自作地震計の震度で、ライブと同じく出し入れする。
  const showSeismoWave = useSeismoWaveVisibility({
    mode: settings.seismoWave,
    scope: seismoScope,
    eews: eewListNoCancelled,
    detectedPoints: kyoshinView.detectedPoints,
    stations: seismoView.stations,
  })
  // 地図に重ねる特別情報の帯の束。**閉じた帯を除いた「いま出す帯」を、帯の描画と共有ボタンの置き場所が同じ値で見る。**
  // お知らせの帯は設定で隠せるので、隠しているときは元データごと渡さない。
  // 国際津波関連情報の通信試験は、設定「試験報を受信」を入れている間だけ出す（切った後に残っていた分も隠す。→ `admitInternationalTsunami`）
  const internationalTsunamiBand = useMemo(
    () => settings.dmdataTestDelivery ? internationalTsunamiBandList : internationalTsunamiBandList.filter(x => !x.report.isCommunicationsTest),
    [settings.dmdataTestDelivery, internationalTsunamiBandList],
  )
  // 取消の表示も、その種類の帯を隠している間は出さない（お知らせの帯の設定）
  const bandCancels = useMemo(
    () => settings.quakeNoticeBanner ? specialInfoCancels : specialInfoCancels.filter(c => c.kind !== 'quakeNotice'),
    [settings.quakeNoticeBanner, specialInfoCancels],
  )
  const specialInfoBanners = useSpecialInfoBanners({
    nankai, nankaiCommentary: nankaiCommentaryList, kohatsu: kohatsuList,
    quakeNotice: settings.quakeNoticeBanner ? quakeNoticeList : NO_BAND_ITEMS,
    earthquakeCount: earthquakeCountList,
    internationalTsunami: internationalTsunamiBand,
    cancels: bandCancels,
  })
  // 地図の下の波形の枠に渡すもの。**出さないなら空・null**（出すかどうかはここで決める）。
  const waveChartStations = showSeismoWave ? seismoView.stations : EMPTY_SEISMO_STATIONS
  const waveChartPublic = publicWaves.visible ? publicWaves : null
  // 枠が実際に段を描くか。描くと地図の高さが削れ、地図に重ねた帯は画面の下端に届かなくなる。
  // **「出す」と判定しただけでは足りない** —— 段が 0 なら枠は何も描かない（→ SeismoWaveChart/chartRows.ts）。
  const waveChartDrawn = hasWaveChartRows(waveChartStations, waveChartPublic)
  // 縦積みで波形が出ている間は、パネルを広げるとまず地図が縮み、地図が器の高さの一定の割合まで縮んだ所で
  // 地図と波形が止まり、その先はパネルが下から重なって覆う（→ utils/waveStackLayout.ts。2026-11-04 ユーザー選択）。
  // **パネルの比率は動かさない。** 左右分割では重なりも地図の下限も CSS 側で効かない（`side:` の指定）。
  const panelShownRatio = panelCollapsed ? 0 : panelRatio
  const waveLayout = waveStackLayout({
    containerHeight: layoutSize?.height ?? 0,
    otherHeight: layoutSize?.other ?? 0,
    leadRowHeight: waveChartDrawn ? waveLeadRowHeight : null,
    panelRatio: panelShownRatio,
  })
  waveOverlapRef.current = waveLayout.overlap
  // 波形の枠を描いているか。地図に重ねた帯の下端の余白はこれで決める（パネルに覆われていても、
  // 帯は地図の下端にあって画面の下端には届かない）。
  const waveChartShown = waveChartDrawn

  // 地図左上の更新時刻: リアルタイム表示はリアルタイム震度(kyoshin)の更新時刻、
  // 接続中は現在時刻を毎秒更新、それ以外は最終受信時刻を表示する。
  const overlayUpdateTime =
    mapTab === 'realtime'
      ? kyoshin.dataTime
        ? new Date(kyoshin.dataTime)
        : null
      : nowTick !== null
        ? nowTick
        : lastUpdate
  // 更新がエラーで停止しているか（リアルタイム=取得連続失敗 / それ以外=WS切断）。
  // **`crowded`（同時接続枠が埋まっている）や、配信元が閉じて止めた状態も更新は止まっている**ので
  // 同じく警告を出す（どれが当たるかは `isLiveFeedHalted`）。
  // 理由まで伝えるのは設定の窓の接続状態の側（→ types/earthquake.ts の `ConnectionStatus`）。
  const overlayError =
    mapTab === 'realtime'
      ? kyoshin.error
      : isLiveFeedHalted(connectionStatus, relayUpstream)

  return (
    // 画面いっぱいの高さは h-dvh（100dvh）で取る。dvh はブラウザ UI の出入りに追従するため、
    // iOS Safari でツールバーが出ている間もナビが画面外へ押し出されない。
    // 画面端の safe-area は、上端だけ root が余白で避け（理由は ROOT_FRAME_TOP_INSET）、
    // 下・左・右は端に接する要素が各自で避ける。
    // 外枠は固定配置にする（iOS が上端に重ねるぼかしと、横向きのあとのずれを避ける。理由は ROOT_FRAME_CLASS）。
    // 規則と端ごとの担当は docs/spec/architecture-spec.md
    // 「画面いっぱいへの広がりとセーフエリア」に集約している。
    <div className={`${ROOT_FRAME_CLASS} flex flex-col bg-app text-white overflow-hidden`} style={{ paddingTop: ROOT_FRAME_TOP_INSET }}>
      {/* 地図(左) | パネル | アイコンナビ(右端)。
          side ブレークポイント未満（スマホ縦など）は縦積み(地図上・つまみ・パネル・ナビ下)になり、
          パネルの高さは --panel-ratio（つまみのドラッグで可変・折りたたみ時 0）で決まる。
          side 以上（PC・スマホ横）は左右分割で、パネル幅は境の縦のつまみで変えられる（--panel-w-side / --panel-w-narrow）。 */}
      <div
        ref={layoutRef}
        className="flex-1 overflow-hidden flex flex-col side:flex-row"
        style={{
          '--panel-ratio': panelShownRatio,
          '--map-min-height': `${waveLayout.mapMinHeight}px`,
          '--wave-overlap': `${waveLayout.overlap}px`,
          '--panel-w-side': panelWidthCss(panelWidthSide),
          '--panel-w-narrow': panelWidthCss(panelWidthSideNarrow),
        } as CSSProperties}
      >
        {/* 常時表示の地図エリア（タブに応じて内容を切替） */}
        {/* 地図と自作地震計の波形を縦に積む器。

            **波形は地図に重ねない。** 自動フィット（`utils/camera.ts`）は地図の全高で
            目標範囲を計算するので、重ねると画に入れたはずのものが波形の下へ隠れる
            （2026-09-29 のユーザー指摘）。**地図の高さを実際に削れば、フィットの計算は
            そのまま正しくなる** —— 余白を差し引く形にすると、フィットを呼ぶ側すべてが
            その事情を知っていなければならない。

            **凡例と特別情報バナーは地図に重ねたまま。** あちらは地図の上に出すもので、
            地の絵が透けて見えることに意味がある（波形は観測値そのものなので透かさない）。 */}
        <div ref={mapColumnRef} className="flex-1 min-h-0 flex flex-col isolate">
          {/* 縦積みで波形が出ている間だけ高さの下限を置く（波形の先頭の段を押し出させない。→ utils/waveStackLayout.ts）。
              下限があるので、波形の枠は 1 段を残して縮み、2 段目以降は枠の中でずらして見る。 */}
          <div ref={mapAreaRef} className="relative flex-1 min-h-(--map-min-height) side:min-h-0">
            {/* **包むのは地図だけ。** ここで受け止めれば App の state は生きたままなので、地図が
                落ちてもカード・ブラウザ通知・読み上げは動き続ける。同じ親にいる左上の情報ブロック・
                行動チェックリスト・特別情報バナーは境界の外に残す——中へ入れると地図と一緒に消える。
                **MapLibre のカスタムレイヤーが描画ループ（rAF）で投げた例外はここへ届かない**。
                そちらは各レイヤーの render() を包んで utils/renderHealth.ts へ報告する側の担当。 */}
            <ErrorBoundary variant="region" label={messages.errorScreen.mapLabel}>
              <MapView
                mode={mapMode}
                publicStationMarkers={publicStationMarkers}
                catalogCloud={catalogCloud}
                catalogColorBy={settledView.colorBy}
                onLegendSourcesChange={setLegendSources}
                quake={mapQuake}
                tsunamis={tsunamis}
                tsunamiSourceQuakes={allQuakeCards}
                observations={latestTsunamiObservations}
                lpgm={(mapHistoryView && activeLpgm && activeLpgm.eventId === extractQuakeEventId(mapHistoryView.quake) ? mapHistoryView.lpgm : activeLpgm) ?? undefined}
                distributionMode={mapDistributionMode}
                unreceivedMode={mapUnreceivedMode}
                estimatedIntensity={mapEstimatedIntensity}
                iconScale={settings.mapIconScale}
                recording={settings.recordingMode}
                hypocenterDepthScale={settings.hypocenterDepthScale}
                showBathymetry={settings.showBathymetry}
                showActiveFaults={settings.showActiveFaults}
                activeFaultOpacity={settings.activeFaultOpacity}
                heatPoints={quakeHeatPoints}
                heatIntensityScale={heatIntensityScale}
                showPlateBoundaries={settings.showPlateBoundaries}
                showDayNight={settings.showDayNight}
                dayNightOpacity={settings.dayNightOpacity}
                kyoshinSites={kyoshinSitesGated}
                kyoshinIndices={kyoshinHeld.indices}
                kyoshinStale={kyoshinHeld.stale}
                kyoshinSubIndices={kyoshinSubIndices}
                kyoshinPsWave={psWave}
                eews={eewsForMap}
                detectedPoints={kyoshinView.detectedPoints}
                candidatePoints={kyoshinView.candidatePoints}
                unconfirmedPoints={kyoshinView.unconfirmedPoints}
                candidateId={kyoshinView.candidateId}
                shakeFocus={shakeFocus}
                eewLpgmEventId={activeLpgmSource === 'eew' ? activeLpgmEventId : null}
                focusObsName={focusedObsName}
                focusTarget={focusedMapTarget}
                obsUpdateStatus={obsUpdateStatus}
                quakeSelectionTick={quakeSelectionTick}
                onMapReady={setMapHandle}
              />
            </ErrorBoundary>
            {/* 地図の上の隅。左にアプリの状態、右に観測している値（自作地震計の観測点ごとの震度）。
                **左右を 1 本の横並びにする** —— 別々に絶対配置すると互いの幅を知らないので、狭い画面や
                行が伸びたときに横で重なって両方読めなくなる（実測は docs/spec/architecture-spec.md の改訂履歴）。
                幅が足りないときは、左の異常の行が折り返し、右の観測点名が短く切れる。更新時刻は折り返さない
                （2026-10-27 ユーザー選択「左右を1本の横並びにする (Recommended)」）。
                **状態と観測値は左右で分ける** —— 混ぜると、異常表示が伸びたときに観測値がそのぶん押し下がる。
                状態を左・観測値を右にしているのは、日本列島が右上へ伸びていて左上のほうが
                陸を隠しにくいから（2026-10-27 ユーザー指示「そもそも右上じゃなくて左上にしたい(地震計と入れ替える。日本列島が右上向きだから)」）。
                **下端の帯（凡例・特別情報バナー）とは重ならない** —— あちらは全幅の絶対配置で、
                下側へ置いたものは押し上げてもらえずに重なる。行動チェックリストの帯は、この列の下端から始める（`topCornersBottom`）。
                z-99999: 地図の中の物（HTML マーカー・MapLibre の操作ボタン・撮影中の静止画）と、地図の吹き出し
                （`.maplibregl-popup` の 99998。→ src/index.css）より前に出す。地図の要素は重なりの文脈を作らないので、
                吹き出しの z はここと直に比べられる。値を変えるときは吹き出しの側も合わせる
                （→ src/components/Map/popupLayering.test.ts）。 */}
            <div
              ref={topCornersRef}
              className="absolute z-99999 pointer-events-none flex items-start justify-between gap-2"
              style={{
                // 上端のステータスバーは root が余白で避けている（ROOT_FRAME_TOP_INSET）。ここでも足すと二重に下がる
                top: '0.5rem',
                left: 'max(0.5rem, env(safe-area-inset-left, 0px))',
                right: 'max(0.5rem, env(safe-area-inset-right, 0px))',
              }}
            >
              {/* 左は空いた幅いっぱいまで広がり、それより狭くは更新時刻の幅で止まる（`basis-0 grow`）。
                  右は自分の幅を取り、足りなければ観測点名から縮む（`min-w-0`）。 */}
              <div className="flex flex-col items-start gap-1 basis-0 grow">
                <MapUpdateTime lastUpdate={overlayUpdateTime} error={overlayError} />
                <MapDataStatus />
                <MapRenderStatus />
                <SeismoLinkStatus stream={seismoView.stream} urlUnusable={seismoView.urlUnusable} />
                {/* 新しい版の知らせ・秒読み・更新した直後の知らせ（→ components/AppUpdateBadge.tsx）。
                    列は押せない（pointer-events-none）ので、札の側で押せるようにしている */}
                <AppUpdateBadge schedule={reloadSchedule} />
              </div>
              <div className="flex flex-col items-end gap-1 min-w-0">
                <SeismoOverlay stations={seismoOverlayStations} />
              </div>
            </div>
            {/* 地図に重ねる縦並び。上端に行動チェックリスト、下端に凡例・特別情報バナー。
                **地図の高さを 1 本の縦並びで分け合う**（足りないときは中身が縮み、それぞれの中で
                スクロールする）。上と下を別々に絶対配置して画面の高さ（`dvh`）で上限を掛けると、
                地図が低いときに下端の束が地図の上へはみ出す。仕組み・下限・既知の限界は
                docs/spec/architecture-spec.md §4「地図の上に重ねる帯は、地図の高さを 1 本の縦並びで分け合う」。
                z は地図の上の隅（そのコメント）と同じ理由で高く取る。

                **自作地震計の波形はここに入れない。** 地図の外（この器の下）へ置く ——
                重ねると自動フィットで画に入れたものが隠れるため（2026-09-29 のユーザー指摘。
                理由はこの div を含む器のコメント）。 */}
            {/* **子はすべてこの縦並びの直下に並べる**（中間の枠を作らない）。枠を挟むと、その枠の
                下限を子の下限の合計に合わせ続けなければならず、子が空でも高さを取る。
                下限は各コンポーネントが自分の外枠に値で書く（`min-height` を書かない子は中身の高さで
                止まって縮まず、`min-h-0` の子は見出しまで潰れる）。 */}
            <div className="absolute inset-0 z-99999 pointer-events-none flex flex-col">
              {actionChecklist.state && !checklistOverlay && (
                <ActionChecklist
                  reason={actionChecklist.state.reason}
                  scale={actionChecklist.state.scale}
                  unreceived={actionChecklist.state.unreceived}
                  scope={actionChecklist.state.scope}
                  collapsed={actionChecklist.collapsed || checklistCompact}
                  focusOnOpen={false}
                  onDismiss={actionChecklist.dismiss}
                  onRestore={restoreChecklist}
                  topInset={topCornersBottom + TOP_CORNERS_GAP_PX}
                  areaHeight={mapAreaHeight}
                  below={{
                    legend: settings.showMapLegend && legendBlocks.length > 0,
                    shareRow: shareCard.ready,
                    shareRowAtScreenBottom: !waveChartShown,
                    banner: specialInfoBanners.shown,
                  }}
                />
              )}
              {/* 伸びる空白。上端のチェックリストと下端の凡例・帯を両端へ分ける（`mt-auto` を
                  凡例と帯のどちらに付けるかを出し分けずに済む）。縮むときは 0 まで縮む。 */}
              <div ref={overlayStackSpacerRef} className="flex-1 min-h-0" />
              {settings.showMapLegend && legendBlocks.length > 0 && (
                // `shrink-8`: 凡例を優先して縮める（特別情報の帯より軽い。縮みは高さに比例して
                // 配られるので、帯も少しは縮む）。
                // `pt-[0.6rem]`: 凡例の見出しは当たり判定を枠の外へ広げている（`MapLegend` の
                // `hit`。畳んだ狭い画面で上へ最大 0.55rem）。包みがスクロール領域なのでその縁で
                // 切られ、指で押せる範囲が縮む —— 余白で逃がす（`pointer-events-none` なので地図の操作は妨げない）。
                // 包みは凡例が描くものを持つときだけ出す（`MapLegend` は空なら何も描かないが、包みの余白は残る）。
                // 右下に置くのは、日本列島が左下から右上へ伸びていて右下が海（太平洋）だから —— 常に出ていて
                // 面積の大きい凡例を陸の無い側へ寄せる（承認の日付と原文は docs/spec/map-rendering-spec.md §20「置き場所」）。
                <div className="min-h-0 pt-[0.6rem] shrink-8 overflow-y-auto overflow-x-hidden overscroll-x-none flex flex-col items-end">
                  <MapLegend blocks={legendBlocks} collapsed={legendCollapsed} onToggle={toggleLegend} compact={mapAreaShort} onHeatmapPeriodChange={changeHeatmapPeriod} />
                </div>
              )}
              {/* 地図左下の共有ボタン（表示中の地図を画像にする。右下は凡例）。**特別情報の帯のすぐ上に置く** —— 縦並びの外に
                  絶対配置すると、帯が出ても押し上げてもらえずに帯へ重なる。高さ 0 の行を足場にしてその上へ
                  はみ出させるので、凡例の縮み方（縦並びの高さの分け合い）には加わらない。
                  **行動チェックリストの帯が出ている間だけは、ボタンぶんの高さを持つ**（`shareButtonRowHeightClass`）——
                  帯は地図の下端まで伸びうるので、高さ 0 のままだとボタンが帯の左下に重なる。
                  帯が無い（閉じた帯しか残っていない場合も含む）ときは地図の下端に付く。ホームインジケータ分を
                  避けるのは帯と同じ条件 —— スマホの横画面で、地図の下に波形が出ていないときだけ（`shareButtonBottomClass`。
                  帯の SAFE_BOTTOM の隣に置いてある）。 */}
              {shareCard.ready && (
                <div className={`relative shrink-0 ${shareButtonRowHeightClass(actionChecklist.state !== null, specialInfoBanners.shown, !waveChartShown)}`}>
                  <div
                    className={`absolute pointer-events-auto ${shareButtonBottomClass(specialInfoBanners.shown, !waveChartShown)}`}
                    style={{ left: 'max(0.5rem, env(safe-area-inset-left, 0px))' }}
                  >
                    <ShareCardButton state={shareCard.state} onClick={() => shareCard.share()} />
                  </div>
                </div>
              )}
              <SpecialInfoBanner banners={specialInfoBanners} speakingTelegramTextSubject={speakingTelegramTextSubject}
                // 参考情報を読む設定なら、読んでいる間は帯の「この種類の情報について」も開く
                readsAppendix={settings.ttsEnabled && settings.ttsReadTelegramText && settings.ttsTelegramBoilerplate.earthquakeInfoAppendix}
                // 地図の下に波形が出ていると、帯は画面の下端に届かない（下端の余白を付けない）
                atScreenBottom={!waveChartShown}
                // 開いた帯の本文を重ねてよい上端。行動チェックリストを開いたときと同じ（上の隅の表示の下）で、
                // 上端に行動チェックリストが並んでいればその下（伸びる空白の上端）で止まる
                bodyTopInset={topCornersBottom + TOP_CORNERS_GAP_PX}
                bodyTopEdgeRef={overlayStackSpacerRef}
              />
            </div>
            {/* 地図が低いときに札から開いた行動チェックリスト。**縦並びの外に重ねる** —— 縦並びに入れると
                凡例・帯と高さを分け合って中で切れる。ここでは地図の高さいっぱいまで伸び、凡例と帯の上にも重なる
                （閉じれば札に戻る。→ `checklistOverlay`）。下に残すものは無いので `below` はすべて偽。 */}
            {actionChecklist.state && checklistOverlay && (
              <div className="absolute inset-0 z-99999 pointer-events-none flex flex-col">
                <ActionChecklist
                  reason={actionChecklist.state.reason}
                  scale={actionChecklist.state.scale}
                  unreceived={actionChecklist.state.unreceived}
                  scope={actionChecklist.state.scope}
                  collapsed={false}
                  focusOnOpen
                  onDismiss={actionChecklist.dismiss}
                  onRestore={restoreChecklist}
                  topInset={topCornersBottom + TOP_CORNERS_GAP_PX}
                  areaHeight={mapAreaHeight}
                  below={{ legend: false, shareRow: false, shareRowAtScreenBottom: false, banner: false }}
                />
              </div>
            )}
          </div>
          {/* 自作地震計の合成波形。**地図の外**（→ すぐ上の器のコメント）。
              包みは地図の下限に押されて縮む（中の枠がスクロールする）。パネルを上限より広げたら高さ 0 で隠す
              （外さない理由は `waveChartShown`）。 */}
          {waveChartDrawn && (
            <div className="min-h-0 flex flex-col overflow-hidden" {...(waveLayout.waveCovered ? { inert: '' } : {})}>
            <SeismoWaveChart
              stations={waveChartStations}
              readWave={seismoView.readLiveWave}
              publicWaves={waveChartPublic}
              collapsedView={settings.seismoWaveCollapsedView}
              expanded={settings.seismoWaveExpanded}
              onToggleExpanded={toggleSeismoWaveExpanded}
              arrivalEews={seismoArrivalEews}
              spanSec={settings.waveSpanSec}
              onFocusStation={focusMapPositions}
              onLeadRowHeightChange={setWaveLeadRowHeight}
              paused={waveLayout.waveCovered}
            />
            </div>
          )}
        </div>

        {/* 地図とパネルの境界（縦積み時のみ）。ドラッグで高さ比率を変え、タップで折りたたむ。 */}
        <PanelResizeHandle
          // 畳んでいるときは展開したときの比率。波形が出ていてもパネルの比率は動かさないので、保存した比率そのまま
          ratio={panelRatio}
          collapsed={panelCollapsed}
          onRatioChange={handlePanelRatioChange}
          onRatioCommit={handlePanelRatioCommit}
          onToggleCollapse={togglePanelCollapsed}
        />
        {/* 地図とパネルの境界（左右分割時のみ）。横へのドラッグで幅を変え、タップで折りたたむ。 */}
        <PanelWidthHandle
          widthRem={sideNarrow ? panelWidthSideNarrow : panelWidthSide}
          defaultRem={sideNarrow ? PANEL_WIDTH_DEFAULT_NARROW_REM : PANEL_WIDTH_DEFAULT_SIDE_REM}
          collapsed={panelCollapsed}
          onWidthChange={handlePanelWidthChange}
          onWidthCommit={handlePanelWidthCommit}
          onToggleCollapse={togglePanelCollapsed}
        />

        {/* パネル（タブに応じて内容を切替）。縦積み時は --panel-ratio 由来の高さ + スクロール。
            折りたたみ時は縦積みなら高さ（--panel-ratio=0）、左右分割なら幅が 0 になり地図が全画面になる。
            各タブを absolute で重ねて visibility で切り替えることで、スクロール位置をタブごとに独立管理する。
            **地の色（bg-app）を敷く。** 縦積みで波形が出ている間はパネルが波形の上へ重なる（→ utils/waveStackLayout.ts）ので、
            背景を持たない中身（日付の区切り・見出し・空の案内）から下の波形が透けないようにする。重ならないときは画面の地と同じ色。
            折りたたみを含め display:none（hidden クラス）を使わないのは、scrollTop がリセットされるため。
            左右分割時の幅は `w-panel` / `w-panel-narrow`（src/index.css で定義）。境のつまみで変えた幅は
            --panel-w-side / --panel-w-narrow で受ける（→ utils/panelWidth.ts）。 */}
        <div ref={panelRef} className={`shrink-0 h-[calc(var(--panel-ratio)*100%)] overflow-hidden side:h-auto side:flex-none border-border bg-app relative z-10 flex flex-col ${
          panelCollapsed ? 'side:w-0 side:border-l-0' : 'side:w-panel sideNarrow:w-panel-narrow side:border-l'
        }`}>
          {/* 速報・津波の帯。上下分割では一覧の下（ナビの上）、左右分割では一番上（→ components/AlertDock）。
              パネルを畳むとパネルごと隠れる（2026-11-09 ユーザー選択「畳んだら帯も隠す」） */}
          <div className="order-last side:order-first">
            <AlertDock eews={dockEews} tsunami={dockTsunami} onOpen={handleTabChange} />
          </div>
          {/* 各タブのスクロール容器（`absolute inset-0`）の基準。帯が場所を取った残りの高さになる */}
          <div className="relative min-h-0 flex-1">
          <div className={`${TAB_SCROLLER_CLASS}${activeTab !== 'earthquake' ? ' invisible pointer-events-none' : ''}`}>
            {/* **タブごとに境界を置く。** 6 タブは常時マウントで `invisible` を付け外ししている
                だけなので、1 つのタブが投げた例外は境界が無ければ App ごと巻き込む。ここで
                受け止めれば、落ちたタブ以外はそのまま見られる。 */}
            <ErrorBoundary variant="region" label={tabNames.earthquake}>
              <EarthquakeTab
                shown={activeTab === 'earthquake'}
                earthquakes={filteredEarthquakes}
                matchedCount={quakeListMatched}
                filter={quakeListFilter}
                onFilterChange={changeQuakeListFilter}
                sort={quakeListSort}
                onSortChange={changeQuakeListSort}
                filterSourceQuakes={allQuakeCards}
                historyDays={historyDays}
                onLoadPeriod={loadHistoryPeriod}
                selectedId={selectedQuakeKey}
                selectSeq={quakeSelectSeq}
                speakingKey={speakingQuakeKey}
                followSpeech={settings.ttsEnabled}
                onSelect={selectQuakeFromCard}
                isLoading={isLoading}
                isLoadingMore={isLoadingMore}
                hasMore={hasMore}
                onLoadMore={loadMoreEarthquakes}
                watchLoadMoreThrottle={true}
                error={error}
                historyLoss={historyLoss}
                loadMoreFailed={loadMoreFailed}
                reconnectGapLoss={reconnectGapLoss}
                fetchThrottled={fetchThrottled}
                onDismissKeyReentry={showKeyReentry ? dismissKeyReentry : null}
                lpgmByEventId={lpgmByEventId}
                updateMarks={quakeUpdateMarks}
                activeLpgmEventId={activeLpgmEventId}
                onToggleLpgm={toggleLpgmFromEarthquake}
                lpgmFocus={lpgmFocus}
                estimatedIntensities={estimatedIntensities}
                internationalTsunamisByQuake={internationalTsunamiIdx.byQuakeKey}
                historyInputs={historyInputs}
                historyPickedId={historyView ? historyView.entryId : null}
                historyView={historyView}
                onPickHistory={pickHistoryEntry}
                onReplayQuake={replayQuakeFromCard}
                // 再生中だけ渡す。弾かれた開始（範囲外）はライブのまま知らせだけが残り、消す口が地震タブに無いため
                replayError={replayTimeOffset !== null ? replay.error : null}
                distributionQuakeKey={distributionQuakeKey}
                onToggleDistribution={toggleDistribution}
                unreceivedQuakeKey={unreceivedQuakeKey}
                onToggleUnreceived={toggleUnreceived}
                onFocusMap={focusMapTarget}
                speakingTelegramTextSubject={speakingTelegramTextSubject}
                seismoWaves={quakeWaves}
                seismoWaveFailedKeys={seismoWaveFailedKeys}
                seismoWaveView={settings.seismoWaveCollapsedView}
              />
            </ErrorBoundary>
          </div>
          <div className={`${TAB_SCROLLER_CLASS}${activeTab !== 'realtime' ? ' invisible pointer-events-none' : ''}`}>
            <ErrorBoundary variant="region" label={tabNames.realtime}>
              <RealtimeTab
                eews={eewsForPanel}
                kyoshinV2Detections={kyoshinV2.detections}
                kyoshinDetectedPoints={kyoshinDetectedPoints}
                swaveArrival={swaveArrival}
                visible={activeTab === 'realtime' && !panelCollapsed}
                speakingEewKey={speakingEewKey}
                eewNoForecastSettledKeys={eewNoForecastSettledKeys}
                activeLpgmEventId={activeLpgmEventId}
                onToggleLpgm={toggleLpgmFromEew}
                onDeactivateLpgm={deactivateLpgm}
              />
            </ErrorBoundary>
          </div>
          <div className={`${TAB_SCROLLER_CLASS}${activeTab !== 'tsunami' ? ' invisible pointer-events-none' : ''}`}>
            <ErrorBoundary variant="region" label={tabNames.tsunami}>
              <TsunamiTab
                tsunamis={tsunamis}
                earthquakes={allQuakeCards /* 原因地震は地震タブの絞りによらず引く */}
                onEarthquakeLink={linkTsunamiToEarthquake}
                onObservationClick={focusTsunamiObs}
                onFocusMap={focusMapPositions}
                focusedDistrict={focusedDistrict}
                obsUpdateStatus={obsUpdateStatus}
              areaGradeChangedKeys={areaGradeChangedKeys}
              tsunamiValueMarks={tsunamiValueMarks}
                speechSession={speechFollowSession}
                speakingTelegramText={speakingTelegramTextSubject === telegramTextSubject('tsunami')}
                /* 読み上げ追従の可否。タブは invisible で隠すだけなので**非表示でもスクロールは
                   効いてしまう**（戻ってきたら知らない位置にいる）。折りたたみ時はさらに幅か
                   高さが 0 になり、視野の高さが取れない。 */
                isVisible={activeTab === 'tsunami' && !panelCollapsed}
                /* 読み上げが有効なら受信時スクロールを止め、追従に任せる（逆向きの動きを消す） */
                speechFollowEnabled={settings.ttsEnabled}
                /* 自動で見せたときは先頭から見せる（手動選択では位置を保つ） */
                autoShowTick={tsunamiAutoShowTick}
              />
            </ErrorBoundary>
          </div>
          <div className={`${TAB_SCROLLER_CLASS}${activeTab !== 'catalog' ? ' invisible pointer-events-none' : ''}`}>
            <ErrorBoundary variant="region" label={tabNames.catalog}>
              <CatalogTab
                index={catalogIndex}
                filter={catalogFilter}
                onFilterChange={handleCatalogFilterChange}
                view={catalogView}
                onViewChange={setCatalogView}
                pointCount={catalogCloud?.columns.count ?? 0}
                unknownMagnitudeCount={catalogCloud?.unknownMagnitudeCount ?? 0}
                loading={catalog.loading}
                /* 絞り込みを変えた直後は件数が追いついていない（デバウンスした側で作るため）。
                   参照が同じなら落ち着いている（`useDebouncedValue` は同じ値なら同じ参照を返す）。 */
                pending={catalogFilter !== settledFilter || catalogView !== settledView}
                indexFailed={catalog.indexFailed}
                missingYears={catalog.missingYears}
                requestedYears={catalog.requestedYears}
                onRetry={catalog.retry}
                tail={catalog.tail}
              />
            </ErrorBoundary>
          </div>
          <div className={`${TAB_SCROLLER_CLASS}${activeTab !== 'telegrams' ? ' invisible pointer-events-none' : ''}`}>
            <ErrorBoundary variant="region" label={tabNames.telegrams}>
              <TelegramTab telegramLog={telegramLog} onClear={clearTelegramLog} active={activeTab === 'telegrams'} />
            </ErrorBoundary>
          </div>
          </div>
        </div>

        {/* 設定は窓（2026-10-27 ユーザー承認）。閉じている間も中身を外さずに隠す（→ `SettingsDialog`） */}
        {usageConsentOpen && <UsageConsentDialog onAnswer={answerUsageConsent} />}
        {quakeReplayConfirmAt !== null && <QuakeReplayConfirmDialog onAnswer={answerQuakeReplayConfirm} />}
        <SettingsDialog open={settingsOpen} onClose={closeSettings} returnFocusRef={settingsButtonRef}>
            <ErrorBoundary variant="region" label={tabNames.settings}>
              <SettingsTab
                settings={settings}
                onUpdate={updateSetting}
                arrivalTokenStatus={arrivalTokenStatus}
                forecastKeyStatus={forecastKeyStatus}
                forecastKeyRelayRejected={forecastKeyRelayRejected}
                relayForecastLive={relayForecastLive}
                onReplaceSettings={replaceSettings}
                dmdataConnectionStatus={connectionStatus}
                relayUpstream={relayUpstream}
                keyForecastStatus={keyForecastStatus}
                dmdataClassifications={dmdataClassifications}
                onTest={countedTestHandlers}
                kyoshinTimeOffset={replayTimeOffset}
                kyoshinInputDateTime={kyoshinInputDateTime}
                onSetKyoshinInputDateTime={setKyoshinInputDateTime}
                replayIsFetching={replay.isFetching}
                replayError={replay.error}
                onStartReplay={startReplayCounted}
                onStopReplay={replay.stop}
                historicalArchives={historicalArchives}
                historicalArchivesLoading={historicalArchivesLoading}
                seismoUnreadableCount={seismo.unreadableCount}
              />
            </ErrorBoundary>
        </SettingsDialog>

        {/* アイコンナビ（一番外側＝右端 / 縦積み時は最下部） */}
        <IconNav
          activeTab={activeTab}
          onTabChange={handleTabChange}
          panelCollapsed={panelCollapsed}
          settingsOpen={settingsOpen}
          onToggleSettings={toggleSettings}
          settingsButtonRef={settingsButtonRef}
          tsunamiGrade={tsunamiGrade ?? (isTsunamiForecastOnly(tsunamis) ? 'Forecast' : null)}
          eewLevel={computeEEWLevel(activeEEWsNoCancelled)}
        />
      </div>
    </div>
  )
}
