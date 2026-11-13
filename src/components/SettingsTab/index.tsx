import { ensureWaveSpanSec, WAVE_SPAN_CHOICES } from '../../utils/waveSpan'
import { formatArchiveCoverage } from '../../utils/historicalArchiveCoverage'
import { memo, useState, useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { currentAppUpdater, type ManualCheckResult } from '../../services/appUpdate'
import type { AppSettings, TtsUnreceivedDetail, TtsVoice } from '../../hooks/useSettings'
import { DAY_NIGHT_OPACITY_MIN, DAY_NIGHT_OPACITY_MAX, devInjectedKeys } from '../../hooks/useSettings'
import { Toggle } from '../Toggle'
import { quakeTileColors } from '../EarthquakeTab/QuakeListRow'
import { DisclosureCaret, Reveal } from '../EarthquakeTab/quakeMotion'
import { PrefecturePicker } from './PrefecturePicker'
import { pushSupported, requestPushPermission } from '../../services/pushSubscription'
import { TELEGRAM_TEXT_BLOCK_KEYS, TELEGRAM_BOILERPLATE_KEYS, type TelegramTextBlockKey, type TelegramTextBlocks, type TelegramBoilerplateReads } from '../../utils/ttsText'
import type { ConnectionStatus } from '../../types/earthquake'
import { forecastConnectionLabel, telegramConnectionLabel } from './connectionLabel'
import type { RelayUpstreamStatus } from '../../services/dmdata'
import { useMessages } from '../../i18n/I18nProvider'
import { LOCALE_LOAD_FAILED_EN, LOCALE_LOAD_FAILED_JA, LOCALES, type LocaleSetting, type Messages } from '../../i18n/messages'
import { useLocaleLoadFailed } from '../../i18n/I18nProvider'
import { classificationLabel, type DmdataClassification } from '../../services/dmdataClassifications'
import { INTENSITY_SCALE_COUNT, intensityLabel, intensityShortLabel, getIntensityColor, INTENSITY_LABELS } from '../../utils/intensity'
import { kyoshinIndexLabelText, kyoshinIntensityColor } from '../../utils/kyoshinIntensity'
import { readableTextColor } from '../../utils/contrast'
import { playAlertSound, playCountdownBeep, playKyoshinUpdateSound, unlockAudio } from '../../utils/alertSound'
import { checkVoicevoxAvailable, clearVoicevoxDown, fetchVoicevoxSpeakers, isValidVoicevoxUrl, speakSequentially, VOICEVOX_URL_DEBOUNCE_MS, type VoicevoxSpeaker } from '../../utils/voicevox'
import { voicevoxPreviewTexts } from '../../utils/ttsText'
import { log } from '../../utils/logger'
import { serverDate, getServerClockOffsetMs } from '../../utils/clock'
import type { HistoricalArchiveIndex } from '../../types/historicalArchive'
import { isValidDmdataApiKey } from '../../utils/dmdataApiKey'
import { useDebouncedValue } from '../../hooks/useDebouncedValue'
import { DescriptionTip } from '../DescriptionTip'
import { zipSync } from 'fflate'
import { countRecords, listRecords, clearRecords, onRecordsChanged, hasStorageError } from '../../utils/detectionDiagnosticsDb'
import { formatFileStamp } from '../../utils/formatters'
import { historicalArchiveLabel } from '../../utils/historicalArchiveLabel'
import { screenErrorMessage } from '../../utils/localizedError'
import {
  arrivalTokenStatusLine, type ArrivalTokenStatus, type ArrivalTokenStatusTone,
} from '../../utils/arrivalToken'
import { fetchSeismoStatus, isValidSeismoHostUrl } from '../../services/seismoStream'
import {
  seismoStatusLine, seismoUnreadableLine, SEISMO_STATUS_TONE_CLASS, type SeismoUiStatus,
} from './seismoStatusLine'
import { useKyoshinImport, type KyoshinImportFileError } from '../../hooks/useKyoshinImport'
import { buildSettingsFile, keysFileNotice, parseSettingsFile, settingsFileHasKeys, settingsFileName } from '../../utils/settingsIo'
import { isValidHomeLocation, parseCoordinateNumber, splitPastedLatLng } from '../../utils/homeLocationInput'
import { SHARE_CARD_FORMATS } from '../../utils/shareCard'
import { HEATMAP_PERIODS, isHeatmapPeriod } from '../../utils/quakeHeatmap'
import {
  TIME_SIGNAL_CLOCKS, TIME_SIGNAL_INTERVALS, TIME_SIGNAL_ORDERS, TIME_SIGNAL_PHRASES, TIME_SIGNAL_SOUNDS, TIME_SIGNAL_WHILE_SPEAKING,
  minuteToTimeValue, timeSignalSpeechText, timeValueToMinute,
  type TimeSignalClock, type TimeSignalIntervalMin, type TimeSignalOrder, type TimeSignalPhrase, type TimeSignalSound, type TimeSignalWhileSpeaking,
} from '../../utils/timeSignal'
import { ReleaseNotesDialog } from '../ReleaseNotesDialog'
import { allNotes, type ReleaseNoteEntry } from '../../utils/releaseNotes'
import { useIsSettingsCategoryActive, type SettingsCategoryId } from './SettingsDialog'

/**
 * 操作の結果として行の下に出す文（案内・誤り）。状態には文そのものではなく、辞書を受けて文を組む関数を持ち、
 * 描くときの辞書で組む。文を持つと、出ている間に言語が変わってもその文だけ前の言語のまま残る。
 */
type SettingsMessage = (m: Messages['settings']) => string
/** `setState` へ渡す形にする。関数をそのまま渡すと React が更新の関数として呼んでしまう */
function message(f: SettingsMessage): () => SettingsMessage {
  return () => f
}

export interface TestFunctions {
  earthquake: () => void
  foreignQuake: () => void
  foreignQuakeHuge: () => void
  foreignQuakeInternationalTsunami: () => void
  /** 国際津波関連情報が国内の地震に付く形と、英文だけのカードになる形。 */
  internationalTsunamiDomesticAndOnly: () => void
  headlineOnlyCity: () => void
  noIntensityQuake: () => void
  eew: () => void
  eewWarning: () => void
  eewForecast: () => void
  eewAssumed: () => void
  /** 「非常に強い揺れを検知」の EEW。予報（VXSE45）でしか届かない形なので、ボタンは自分の鍵を入れた人にだけ出す（`hasForecastKey`）。 */
  eewStrongShaking?: () => void
  eewDeep: () => void
  /** 精度ランク 1 で予想震度が付かないまま取り消される EEW。予報にしか無い形なので、ボタンは自分の鍵を入れた人にだけ出す（`hasForecastKey`）。 */
  eewNoForecast: () => void
  /** 最大予想震度 0 の初報から震度1 へ上がる EEW。予報にしか無い形なので、ボタンは自分の鍵を入れた人にだけ出す（`hasForecastKey`）。 */
  eewForecastZero: () => void
  eewRetraction: () => void
  /** 自動解除で画面から消えた後に、同じ地震の誤報取消を届ける EEW（→ `isLateEewCancel`） */
  eewLateRetraction: () => void
  tsunami: () => void
  tsunamiWarning: () => void
  tsunamiWatch: () => void
  tsunamiForecast: () => void
  tsunamiRetraction: () => void
  nankaiChecking?: () => void
  nankaiWatch?: () => void
  nankaiWarning?: () => void
  nankaiRetraction?: () => void
  nankaiCommentaryAdHoc?: () => void
  nankaiCommentaryRetraction?: () => void
  nankaiCommentaryRoutine?: () => void
  activityInfo?: () => void
  kohatsu?: () => void
  kohatsuRetraction?: () => void
  quakeNotice?: () => void
  earthquakeCount?: () => void
  earthquakeCountRetraction?: () => void
  lpgmRetraction?: () => void
  lpgmClassZero?: () => void
  lpgmCategories?: () => void
  lpgmClassZeroRegion?: () => void
  areaUnreceivedQuake?: () => void
  trainingQuake?: () => void
  quakeAmendment: () => void
  quakeReportSequence: () => void
  /** 地震情報の取消。 */
  quakeCancel?: () => void
  /** 地震情報の一部の取消（震度速報だけの取消）。 */
  quakePartialCancel?: () => void
  borrowFromTsunami?: () => void
  /** 津波の続報が地震情報より新しい規模を伝える場面。 */
  magnitudeFromTsunami?: () => void
  unreceivedQuake?: () => void
  maxScaleOrAboveQuake?: () => void
  tsunamiGradeChange?: () => void
  tsunamiQuietReports?: () => void
  tsunamiExpiry?: () => void
  /** 津波の原因地震が後から加わる（`EventID` の番号が書き足される）。 */
  tsunamiSourceAdded?: () => void
  /** 津波情報（VTSE51）だけの取消。 */
  tsunamiInfoRetraction?: () => void
  estimatedIntensity?: () => void
  notification: () => void
}

interface Props {
  settings: AppSettings
  onUpdate: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void
  /**
   * 到達予想キーの検証結果。**自前計算を開く門と同じ 1 つの結果を受け取る**
   * （ここで検証し直すと、期限の境目で画面と門が食い違う。→ `hooks/useArrivalToken.ts`）。
   */
  arrivalTokenStatus: ArrivalTokenStatus
  /** 予報キーの検証結果（→ `hooks/useForecastKey.ts`）。中継へ送るかの判断と同じ 1 つの結果を受け取る */
  forecastKeyStatus: ArrivalTokenStatus
  /** 配信サーバー（中継）が予報キーを受け付けなかったか（札を取ったときの答え） */
  forecastKeyRelayRejected: boolean
  /** 中継から予報を受けているか（「予報」の行の経路） */
  relayForecastLive: boolean
  /**
   * 設定の読み込みで全項目をまとめて差し替える。渡す値は `sanitize()` 済みであること。
   * 戻り値は「この端末へ保存できたか」。
   */
  onReplaceSettings: (next: AppSettings, keepApiKey?: boolean) => boolean
  onTest: TestFunctions
  /** リプレイ中なら再生時刻と実時刻の差（null = 再生していない）。「再生中」表示の判定に使う。 */
  kyoshinTimeOffset: number | null
  kyoshinInputDateTime: string
  onSetKyoshinInputDateTime: (value: string) => void
  /** 中継の接続（「電文」の行） */
  dmdataConnectionStatus: ConnectionStatus
  /** 中継が DMDATA.JP と繋がっているか（まだ知らせが無い・再生中は null）。「電文」の行 */
  relayUpstream: RelayUpstreamStatus | null
  /** 自分の鍵の予報の接続（「予報（APIキー）」の行）。鍵が無い・使えない・再生中は null */
  keyForecastStatus: ConnectionStatus | null
  /**
   * 配信元が受け付けた購読区分（まだ繋がっていなければ null）。「受信している区分」の行に出す。
   * **出すのは繋がっている間だけ**（2026-10-14 ユーザー承認）—— 切れている間に前回の値を出すと、
   * いま受けているように読める。
   */
  dmdataClassifications: readonly DmdataClassification[] | null
  replayIsFetching?: boolean
  /** 直近のリプレイ取得エラー（null = 正常）。ボタン下に赤字で表示する。 */
  replayError?: string | null
  onStartReplay: (date: Date) => void
  onStopReplay: () => void
  /** 収録済みローカル履歴アーカイブの一覧（DMDATAに無い期間を代替する）。表示専用。 */
  historicalArchives?: HistoricalArchiveIndex
  /** 上記一覧の読み込みが完了していないか。読み込み中に「確定」を押すとローカルアーカイブが判定から漏れるため、完了まで「確定」を無効化する。 */
  historicalArchivesLoading?: boolean
  /**
   * 自作地震計の押し出しのうち、読めなかったものの累計（`useSeismoStation` の `unreadableCount`）。
   * 0 でなければ自作地震計の節に赤い行で出す（2026-10-22 選択「設定タブに出す (Recommended)」）。
   */
  seismoUnreadableCount: number
}

// historicalArchivesはoptionalなpropのため、未指定時に`?? []`をインライン展開すると毎レンダーで
// 新しい配列インスタンスが生まれる。KyoshinImportRow内部のuseCallback/useEffectの依存配列に
// そのまま渡ると、参照の不安定さが原因で不要な再フェッチ・エフェクト再実行を招くため、
// モジュールレベルの安定した空配列を使い回す。
const EMPTY_HISTORICAL_ARCHIVES: HistoricalArchiveIndex = []

// ---- Reusable UI parts ----

/**
 * 設定の見出し。`category` の分類が選ばれているときだけ出す（→ `SettingsDialog.tsx`）。
 *
 * **開け閉めは持たない。中身は常に開いて出す**（2026-10-27 ユーザー承認。選んだ選択肢「窓では常に開く (Recommended)」）。
 * 窓では分類を選んだ時点で 1〜6 個の見出ししか出ないので、閉じたままだと「分類を押す→見出しを押す」の 2 手になる。
 * 選ばれていない分類の見出しは**外さずに隠す**。中の行（設定の読み込みの結果・診断ログの件数など）が持つ状態を、
 * 分類を移るたびに捨てないため。
 *
 * 見た目は「小さな灰色の見出し＋細い線で区切った行」（2026-10-27 ユーザー承認。選んだ選択肢「これで進める」）。
 * 窓そのものが枠を持つので、見出しを帯にして箱で囲むと枠の中に枠が入る。
 * 見出しが分類名と同じ（「音と読み上げ」など）なら、分類の一覧（幅の狭い画面では窓の上端）と同じ名前の
 * 繰り返しになるので画面には出さない（読み上げ用には残す）。
 * 見出しどうしの間は外枠（`SettingsTab` の根の `gap`）が空ける。隠した見出しは間を取らない。
 *
 * **出している見出しは、その見出しの行を巻いている間だけ窓の上に貼りつける**（2026-11-04 津波タブの見直しでユーザーが選んだ
 * 「巻いたときに上に残すもの: 段の見出し」を全画面へ広げたもの。見出しが流れると、どの段を見ているか分からなくなるため）。
 * 貼りつく範囲は `section` の中だけなので、次の見出しが来れば押し上げられて入れ替わる。見出しの下の線は見出し自身が持つ
 * （貼りついている間も、下へ潜る行との境が残るように）。
 */
function Section({ category, title, children }: { category: SettingsCategoryId; title: string; children: React.ReactNode }) {
  const active = useIsSettingsCategoryActive(category)
  const sameAsCategory = useMessages().settings.categories[category] === title
  return (
    <section hidden={!active}>
      <h3 className={sameAsCategory ? 'sr-only' : 'sticky top-0 z-10 border-b border-border bg-app px-4 py-1.5 text-xs font-bold text-secondary'}>{title}</h3>
      <div className={`divide-y divide-border border-b border-border ${sameAsCategory ? 'border-t' : ''}`}>{children}</div>
    </section>
  )
}

/**
 * 設定の書き出しと読み込み。
 *
 * 端末を移るとき・ブラウザのデータを消すとき・用途別の設定一式を作り置きするときに使う。
 * 設定は localStorage にしか無いので、これが無いと持ち出す手段が無い。
 *
 * 書式と検証は `utils/settingsIo.ts`。ここは画面の口だけを持つ。
 */
function SettingsIoRow({ settings, onReplace }: {
  settings: AppSettings
  onReplace: (s: AppSettings, keepApiKey?: boolean) => boolean
}) {
  const w = useMessages().settings
  const inputRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<SettingsMessage | null>(null)
  const [notice, setNotice] = useState<SettingsMessage | null>(null)
  // 鍵も含めるか。**既定は含めない**（2026-10-23 ユーザー選択「含めるかを書き出すときに選べる」）。
  // 端末へは保存しない —— 開くたびに外れた状態から始め、うっかり鍵入りのファイルを作らないようにする。
  const [includeKeys, setIncludeKeys] = useState(false)

  const download = useCallback(() => {
    setError(null)
    setNotice(null)
    try {
      const now = new Date()
      const file = buildSettingsFile(settings, { includeKeys, injected: devInjectedKeys() }, now)
      const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = settingsFileName(now)
      // 文書へ入れてから押す。入れずに click() を呼ぶと、環境によっては例外も出さずに
      // 何も起きない（押しても反応が無い理由がどこにも残らない）。
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      // 文面は 2026-10-25 ユーザー選択「この文面で、含めない時も直す (Recommended)」
      const withKeys = settingsFileHasKeys(file)
      setNotice(message(m => withKeys ? m.io.exportedWithKeys : m.io.exportedWithoutKeys))
    } catch (e) {
      // 黙って飲み込むと、押しても何も起きない理由が利用者に分からない
      const detail = e instanceof Error ? e.message : String(e)
      setError(message(m => m.common.exportFailed(detail)))
    }
  }, [settings, includeKeys])

  const handleFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    // 同じファイルを選び直しても onChange が発火するようにする
    e.target.value = ''
    if (!file) return
    setError(null)
    setNotice(null)
    let raw: unknown
    try {
      raw = JSON.parse(await file.text())
    } catch (err) {
      // 文面は原因を絞れないが、記録には残す。構文の誤り・読み取りの失敗・
      // 文字コードの異常が同じ文言になるため、これが無いと原因を追えない。
      log.warn('[settings] 設定ファイルを読めませんでした', err)
      setError(message(m => m.io.unreadable))
      return
    }
    const result = parseSettingsFile(raw, settings)
    if (!result.ok) {
      const reason = result.error
      setError(message(m => m.io.fileErrors[reason]))
      return
    }
    const persisted = onReplace(result.settings, result.usedFileApiKey)

    const keysOnly = result.keysOnly
    if (keysOnly) {
      setNotice(message(m => {
        const keyNotes = [keysFileNotice(keysOnly, m.io)]
        if (!persisted) keyNotes.push(m.io.notSaved)
        return keyNotes.join('\n')
      }))
      return
    }

    const exportedAt = result.exportedAt == null ? null : new Date(result.exportedAt)
    const exportedAtText = exportedAt && Number.isFinite(exportedAt.getTime()) ? exportedAt.toLocaleString('ja-JP') : null
    const { rejectedKeys, usedFileApiKey } = result
    setNotice(message(m => {
      const notes: string[] = [exportedAtText == null ? m.io.loaded : m.io.loaded + m.io.exportedAt(exportedAtText)]
      // 保存できたかは必ず伝える。黙ると「反映された」と思ったまま端末を移して、次に開いたときに
      // 元へ戻っていることになる。
      if (!persisted) notes.push(m.io.notSaved)
      // 値が入っていたのに読めなかった項目。黙ると、壊れたファイルでも成功にしか見えない。
      if (rejectedKeys.length > 0) notes.push(m.io.rejectedKeys(rejectedKeys))
      // 版を 1 つにまとめる前に書き出したファイル（印が dmdss・standard）も設定の型は同じなので、そのまま読む
      if (usedFileApiKey) notes.push(m.io.usedFileApiKey)
      return notes.join('\n')
    }))
  }, [settings, onReplace])

  return (
    <div className="flex flex-col items-end gap-1">
      <input ref={inputRef} type="file" accept=".json,application/json" onChange={e => { void handleFile(e) }} className="hidden" />
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1 text-xs text-secondary cursor-pointer">
          <input
            type="checkbox"
            checked={includeKeys}
            onChange={e => setIncludeKeys(e.target.checked)}
            className="accent-white w-3 h-3"
          />
          {w.io.includeKeys}
        </label>
        <button onClick={download} className={ACTION_BUTTON_CLASS}>
          {w.common.export}
        </button>
        <button onClick={() => inputRef.current?.click()} className={ACTION_BUTTON_CLASS}>
          {w.io.import}
        </button>
      </div>
      {includeKeys && (
        <span className="text-xs text-amber-300 text-right">{w.io.keysWarning}</span>
      )}
      {notice && <span className="text-xs text-secondary text-right whitespace-pre-line">{notice(w)}</span>}
      {error && <span className="text-xs text-red-400 text-right">{error(w)}</span>}
    </div>
  )
}

/**
 * 診断ログの件数表示と書き出し・消去。
 *
 * 書き出しはブラウザのダウンロードとして行う（許可なくファイルシステムへ書き込む口が無いため、
 * 自動保存はできない）。1 件あたり 100KB 前後になるので ZIP に固めて出す。
 */
function DiagnosticLogRow() {
  const w = useMessages().settings
  const [count, setCount] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<SettingsMessage | null>(null)
  const refresh = useCallback(() => {
    void countRecords().then(setCount)
    if (hasStorageError()) setError(message(m => m.diag.noStorage))
  }, [])
  // 記録が増減したら読み直す。設定の窓は常時マウントされたまま CSS で隠れるだけなので、
  // 一定間隔で問い合わせる作りにすると、開いていない間も IndexedDB を叩き続けることになる
  useEffect(() => {
    refresh()
    return onRecordsChanged(refresh)
  }, [refresh])

  const download = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const records = await listRecords()
      if (records.length === 0) {
        setError(message(m => m.diag.nothingToExport))
        return
      }
      const enc = new TextEncoder()
      const files: Record<string, Uint8Array> = {}
      for (const r of records) {
        const ts = formatFileStamp(r.dataTimeMs)
        files[`${ts}_${r.reachedConfidence}_${r.event.id}.json`] = enc.encode(JSON.stringify(r))
      }
      const stamp = formatFileStamp(Date.now())
      const blob = new Blob([zipSync(files)], { type: 'application/zip' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${stamp}_kyoshin-diagnostics_${w.diag.downloadCount(records.length)}.zip`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      // 失敗を黙って飲み込むと、押しても何も起きない理由が利用者に分からない
      const detail = e instanceof Error ? e.message : String(e)
      setError(message(m => m.common.exportFailed(detail)))
    } finally {
      setBusy(false)
    }
  }, [w])

  const clear = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      if (!(await clearRecords())) setError(message(m => m.diag.clearFailed))
    } finally {
      setBusy(false)
    }
  }, [])

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <span className="text-xs text-secondary">{count == null ? '—' : w.diag.count(count)}</span>
        <button
          onClick={() => { void download() }}
          disabled={busy || !count}
          className={ACTION_BUTTON_CLASS}
        >
          {w.common.export}
        </button>
        <button
          onClick={() => { void clear() }}
          disabled={busy || !count}
          className={ACTION_BUTTON_CLASS}
        >
          {w.common.clear}
        </button>
      </div>
      {error && <span className="text-xs text-red-400 text-right">{error(w)}</span>}
    </div>
  )
}

/**
 * 取り込めなかったファイルの理由の文。そのほかの失敗は、鍵と引数を持てば言語の辞書で組み（→ `utils/localizedError.ts`）、
 * 持たなければ投げられた文をそのまま出す
 */
function kyoshinImportErrorText(e: KyoshinImportFileError, words: Messages['settings']['knet'], errorWords: Messages['errorText']): string {
  switch (e.kind) {
    case 'noArchive': return words.noArchive(e.originTime.toLocaleString('ja-JP'))
    case 'saveFailed': return words.saveFailed
    case 'other': return e.error instanceof Error ? screenErrorMessage(e.error, errorWords) : e.message
  }
}

/**
 * NIEDから手動でダウンロードしたK-NET/KiK-net ZIPを取り込む。対応するアーカイブは
 * ZIPヘッダーのOrigin Timeから自動検出するため、ファイルを選ぶだけでよい（useKyoshinImport参照）。
 */
function KyoshinImportRow({ historicalArchives }: { historicalArchives: HistoricalArchiveIndex }) {
  const w = useMessages().settings
  const errorWords = useMessages().errorText
  const { summaries, importing, deletingArchiveId, errors, exclusions, deleteFailed, storageError, importFiles, deleteArchive } = useKyoshinImport(historicalArchives)
  const inputRef = useRef<HTMLInputElement>(null)
  const busy = importing || deletingArchiveId !== null

  const handleFiles = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (files && files.length > 0) void importFiles(files)
    // 同じファイルを選び直しても onChange が発火するようにする（selectしたまま失敗を直して
    // 再選択するケースがあるため）。
    e.target.value = ''
  }, [importFiles])

  return (
    <div className="flex flex-col items-end gap-2">
      <input
        ref={inputRef}
        type="file"
        accept=".zip"
        multiple
        onChange={handleFiles}
        disabled={busy}
        className="hidden"
      />
      <button
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        className={ACTION_BUTTON_CLASS}
      >
        {importing ? w.knet.importing : w.knet.chooseZip}
      </button>
      {summaries.length > 0 && (
        <div className="flex flex-col gap-1.5 items-end">
          {summaries.map((s) => (
            <div key={s.archiveId} className="flex items-center gap-2">
              <span className="text-xs text-secondary whitespace-nowrap">{w.knet.archiveCount(s.label, s.eventCount)}</span>
              <button
                onClick={() => { void deleteArchive(s.archiveId) }}
                disabled={busy}
                className={ACTION_BUTTON_CLASS}
              >
                {deletingArchiveId === s.archiveId ? w.common.deleting : w.common.delete}
              </button>
            </div>
          ))}
        </div>
      )}
      {storageError && (
        <span className="text-xs text-red-400 text-right">
          {w.knet.storageError}
        </span>
      )}
      {deleteFailed && <span className="text-xs text-red-400 text-right">{w.knet.deleteFailed}</span>}
      {/* 文面は 2026-10-24 ユーザー選択「1 行出す (Recommended)」・「理由をまとめて書く (Recommended)」。
          取り込みは成功しているので赤にしない。どの観測点をなぜ外したかは記録（log.warn）に残る */}
      {exclusions.length > 0 && (
        <div className="flex flex-col gap-0.5 items-end">
          {exclusions.map((e, i) => (
            <span key={`${i}-${e.fileName}`} className="text-xs text-secondary text-right break-all">
              {w.knet.excluded(e.fileName, e.excludedStations)}
            </span>
          ))}
        </div>
      )}
      {errors.length > 0 && (
        <div className="flex flex-col gap-0.5 items-end">
          {errors.map((e, i) => (
            <span key={`${i}-${e.fileName}`} className="text-xs text-red-400 text-right break-all">{e.fileName}: {kyoshinImportErrorText(e, w.knet, errorWords)}</span>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * ブロックの名前と説明は辞書（`settings.textBlocks.labels`・`descriptions`）が持つ。鍵の欠けは `satisfies` で型が落とす。
 *
 * **「固定付加文」「自由付加文」は気象庁の電文用語をそのまま使っている** —— 利用者へ出す語は
 * 気象庁の表現と揃える方針（→ quake-spec.md §8）に沿うが、語だけでは何が読まれるか判らないので、説明で中身を補う。
 * **実例（「例:」）を添えるのは、実配信の電文でその文を確かめられたものだけ**（確かめていない文を例として書くと、
 * アプリの作文が気象庁の文の顔をして画面に出る）。「例:」を持たない項目と理由・長い文の引き方は辞書の側の文面のとおり。
 */

/**
 * 電文種別ごとのまとまり。並びは通知設定・テスト機能と同じカテゴリ順
 * （地震情報 → 津波情報 → 長周期 → 南海トラフ系 → 地震回数）。
 *
 * **全キーがどこかのグループに入っていること**は `telegramTextBlockGroups.test.ts` が検査する
 * （ここから漏れたキーは設定の窓に出ず、既定のまま触れなくなる）。
 */
type TextBlockGroupWords = Messages['settings']['textBlocks']['groups']

const TELEGRAM_TEXT_BLOCK_GROUPS: readonly {
  /** まとまりの見出し（辞書の `settings.textBlocks.groups` から引く） */
  readonly title: (groups: TextBlockGroupWords) => string
  readonly keys: readonly TelegramTextBlockKey[]
}[] = [
  { title: g => g.quake, keys: ['quakeForecast', 'quakeVarComment', 'quakeFreeText'] },
  { title: g => g.tsunami, keys: ['tsunamiBody', 'tsunamiVarComment', 'tsunamiFreeText'] },
  { title: g => g.lpgm, keys: ['lpgmForecast', 'lpgmVarComment', 'lpgmFreeText'] },
  { title: g => g.nankai, keys: ['nankaiSummary', 'nankaiBody', 'nankaiNextAdvisory'] },
  {
    title: g => g.nankaiCommentary,
    keys: ['nankaiCommentarySummary', 'nankaiCommentaryBody', 'nankaiCommentaryNextAdvisory'],
  },
  {
    // **次回発表予定は無い。** 理由は `TELEGRAM_TEXT_BLOCK_KEYS`（`utils/ttsText.ts`）
    title: g => g.kohatsu,
    keys: ['kohatsuSummary', 'kohatsuBody'],
  },
  { title: g => g.earthquakeCount, keys: ['earthquakeCountBody', 'earthquakeCountFreeText'] },
  { title: g => g.quakeNotice, keys: ['quakeNoticeBody'] },
]

/**
 * 気象庁が書いた文の内訳（電文種別 × ブロック）。
 *
 * **既定は畳んでおく。** 19 行＋グループの見出し 8 行を常に開くと、設定の窓の中でこの
 * セクションだけが突出して伸びる。見出しには「何個を読む設定か」を出す —— 畳んだままでも、
 * 全部読むのか一部だけかが分かる。
 */
function TelegramTextBlockRows({ blocks, onChange }: {
  blocks: TelegramTextBlocks
  onChange: (next: TelegramTextBlocks) => void
}) {
  const w = useMessages().settings
  const [open, setOpen] = useState(false)
  const enabled = TELEGRAM_TEXT_BLOCK_KEYS.filter(key => blocks[key]).length
  return (
    <>
      <div className="px-4 py-3">
        <button
          type="button"
          onClick={() => setOpen(v => !v)}
          aria-expanded={open}
          className="w-full flex items-center justify-between gap-2 text-left"
        >
          <span className="text-white text-sm">
            {w.textBlocks.heading}
            <span className="text-secondary text-xs ml-2">
              {w.textBlocks.count(enabled, TELEGRAM_TEXT_BLOCK_KEYS.length)}
            </span>
          </span>
          <span className="text-secondary text-xs"><DisclosureCaret open={open} /></span>
        </button>
      </div>
      {/* 区切り線は窓の行と同じ（Section の divide-y は直下の子にしか効かないので、包んだ分をここで引き直す） */}
      <Reveal open={open} className="divide-y divide-border">{() => TELEGRAM_TEXT_BLOCK_GROUPS.map(group => (
        <div key={group.keys[0]} className="divide-y divide-border">
          <div className="px-4 py-1.5 bg-panel/60 text-secondary text-xs">{group.title(w.textBlocks.groups)}</div>
          {group.keys.map(key => (
            <Row
              key={key}
              label={w.textBlocks.labels[key]}
              description={w.textBlocks.descriptions[key]}
            >
              <Toggle
                checked={blocks[key]}
                onChange={v => onChange({ ...blocks, [key]: v })}
              />
            </Row>
          ))}
        </div>
      ))}</Reveal>
    </>
  )
}

/**
 * 読み上げから落とす定型文の名前と説明は辞書（`settings.boilerplate`）が持つ。**実例はすべて実配信の電文で文面を確かめたもの**
 * （内訳と同じ規約）。**落としても画面には出ることを書く** —— ここで切るのは声だけだと分からないと、情報そのものを捨てる設定に見える。
 */

/**
 * 毎報ほぼ同じ定型文を、文の単位で読み上げから落とす指定。
 *
 * **上の「読み上げる文の内訳」より細かい。** あちらは付加文の枠ごと切るので、その枠にだけ入る
 * 非定型の告知（震度速報の訂正・精査後のマグニチュードなど）まで一緒に消える。こちらは文で
 * 落とすため、定型のあとに何か足された報ではその足された分だけが声になる。
 *
 * **既定は全項目オフ（＝読み上げない）。** 理由は `TELEGRAM_BOILERPLATE_DEFAULT_READS`。
 * 畳んでおくのと見出しに件数を出すのは内訳と同じ。
 */
function TelegramBoilerplateRows({ reads, onChange }: {
  reads: TelegramBoilerplateReads
  onChange: (next: TelegramBoilerplateReads) => void
}) {
  const w = useMessages().settings
  const [open, setOpen] = useState(false)
  const enabled = TELEGRAM_BOILERPLATE_KEYS.filter(key => reads[key]).length
  return (
    <>
      <div className="px-4 py-3">
        <button
          type="button"
          onClick={() => setOpen(v => !v)}
          aria-expanded={open}
          className="w-full flex items-center justify-between gap-2 text-left"
        >
          <span className="text-white text-sm">
            {w.boilerplate.heading}
            <span className="text-secondary text-xs ml-2">
              {w.textBlocks.count(enabled, TELEGRAM_BOILERPLATE_KEYS.length)}
            </span>
          </span>
          <span className="text-secondary text-xs"><DisclosureCaret open={open} /></span>
        </button>
      </div>
      <Reveal open={open}>{() => (
        <div className="divide-y divide-border">
          <div className="px-4 py-1.5 bg-panel/60 text-secondary text-xs">
            {w.boilerplate.note}
          </div>
          {TELEGRAM_BOILERPLATE_KEYS.map(key => (
            <Row
              key={key}
              label={w.boilerplate.labels[key]}
              description={w.boilerplate.descriptions[key]}
            >
              <Toggle
                checked={reads[key]}
                onChange={v => onChange({ ...reads, [key]: v })}
              />
            </Row>
          ))}
        </div>
      )}</Reveal>
    </>
  )
}

/**
 * 「バージョン」の行。番号の横の［更新を確認］で、定期の確認を待たずに新しい版を確かめる
 * （2026-10-27 ユーザー承認。選んだ選択肢「バージョンの行」「行に［今すぐ更新］」「案 A：短く」）。
 *
 * **見つかったら、この行から適用できるようにする。** 設定の窓を開いている間は自動の適用を待ち、
 * 地図左上の札も窓に隠れて押せない（→ `utils/appUpdateGate.ts`）。
 */
function AppVersionRow() {
  const w = useMessages().settings
  const updater = currentAppUpdater()
  const update = useSyncExternalStore(updater.subscribe, updater.getSnapshot)
  const [result, setResult] = useState<ManualCheckResult | 'checking' | null>(null)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
  const check = () => {
    setResult('checking')
    updater.checkManually()
      .then((r) => { if (mountedRef.current) setResult(r) })
      .catch((err: unknown) => {
        log.warn('[更新] 押して確かめるのに失敗した', err)
        if (mountedRef.current) setResult('failed')
      })
  }
  // 押した後に待っている版が現れたら（いつもの確認や取り込みの遅れで）、どの結果でも見つかった表示へ替える。
  // 見つかった後に待っている版が取り下げられたら、もう適用するものが無い
  const shown = result !== null && result !== 'checking' && update.waiting ? 'found'
    : result === 'found' && !update.waiting ? null
      : result
  let status: React.ReactNode = null
  if (shown === 'checking') status = <span>{w.version.checking}</span>
  else if (shown === 'latest') status = <span>{w.version.latest}</span>
  else if (shown === 'offline') status = <span>{w.version.offline}</span>
  else if (shown === 'failed') status = <span>{w.version.failed}</span>
  else if (shown === 'found') {
    status = (
      <>
        <span>{w.version.newVersion(update.newVersion)}</span>
        <button type="button" onClick={() => updater.apply()} className={ACTION_BUTTON_CLASS}>{w.version.applyNow}</button>
      </>
    )
  }
  return (
    <Row label={w.version.row.label}>
      <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1 text-xs text-secondary">
        <span>{__APP_VERSION__}</span>
        <button type="button" onClick={check} disabled={shown === 'checking'} className={ACTION_BUTTON_CLASS}>
          {w.version.check}
        </button>
        {status}
      </div>
    </Row>
  )
}

/**
 * 設定の窓の操作ボタン（取得・確定・書き出し・消すなど）の形。すべてこの 1 つにそろえる（2026-11-04 ユーザー選択
 * 「枠のボタンにそろえる (Recommended)」。説明「…全部、枠の形（地は面の色・線はテーマの線・角丸 6px・押せる所は
 * 乗せると明るく）にそろえる。…電文・通知音のテストボタンの色分けは種類を表しているので残す（角丸だけ 6px に）」）。
 */
const ACTION_BUTTON_CLASS = 'rounded-md border border-border bg-panel px-3 py-1.5 text-xs text-white whitespace-nowrap transition-colors motion-reduce:transition-none hover:bg-white/10 disabled:opacity-40 disabled:hover:bg-panel'

/** 「変更履歴」の行。［表示］で全部の版の変更内容を窓に出す（2026-10-26 ユーザー承認「［表示］で窓を開く」）。 */
function ReleaseHistoryRow() {
  const w = useMessages().settings
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  return (
    <Row label={w.history.row.label}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={ACTION_BUTTON_CLASS}
      >
        {w.common.show}
      </button>
      {open && <ReleaseNotesDialog title={w.history.row.label} select={selectAllNotes} onClose={close} />}
    </Row>
  )
}

const selectAllNotes = (entries: readonly ReleaseNoteEntry[]) => allNotes(entries)

/** 読み上げの文の選択肢に出す例の時刻（15時30分） */
const TIME_SIGNAL_EXAMPLE_AT = new Date(2026, 0, 1, 15, 30).getTime()

/**
 * 時報の行（→ `hooks/useTimeSignal.ts`・audio-tts-spec.md §2「時報」）。文言は 2026-11-04 ユーザー選択（行ごとの答えは
 * settings-pwa-spec.md §2「時報」）。読み上げにだけ効く行は VOICEVOX 読み上げが有効なときだけ出す。
 */
export function TimeSignalRows({ settings, onUpdate, voicevoxSpeakers }: {
  settings: AppSettings
  onUpdate: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void
  /** 選べる声。VOICEVOX に繋がっていないときは空（声の行を出さない） */
  voicevoxSpeakers: readonly VoicevoxSpeaker[]
}) {
  const { settings: w, formats: fw } = useMessages()
  const selectClass = 'bg-panel border border-border rounded-sm px-2 py-1 text-xs text-white'
  const speech = settings.ttsEnabled
  return (
    <>
      <Row label={w.timeSignal.enabled.label} description={w.timeSignal.enabled.description}>
        <Toggle checked={settings.timeSignalEnabled} onChange={v => onUpdate('timeSignalEnabled', v)} />
      </Row>
      {settings.timeSignalEnabled && (
        <>
          <Row label={w.timeSignal.interval.label}>
            <select value={settings.timeSignalIntervalMin} className={selectClass}
              onChange={e => onUpdate('timeSignalIntervalMin', ensureTimeSignalInterval(Number(e.target.value)))}>
              {TIME_SIGNAL_INTERVALS.map(v => <option key={v} value={v}>{w.timeSignal.intervals[v]}</option>)}
            </select>
          </Row>
          <Row label={w.timeSignal.sound.label}>
            <select value={settings.timeSignalSound} className={selectClass}
              onChange={e => onUpdate('timeSignalSound', e.target.value as TimeSignalSound)}>
              {TIME_SIGNAL_SOUNDS.map(v => <option key={v} value={v}>{w.timeSignal.sounds[v]}</option>)}
            </select>
          </Row>
          {speech && (
            <>
              <Row label={w.timeSignal.order.label}>
                <select value={settings.timeSignalOrder} className={selectClass}
                  onChange={e => onUpdate('timeSignalOrder', e.target.value as TimeSignalOrder)}>
                  {TIME_SIGNAL_ORDERS.map(v => <option key={v} value={v}>{w.timeSignal.orders[v]}</option>)}
                </select>
              </Row>
              <Row label={w.timeSignal.phrase.label}>
                <select value={settings.timeSignalPhrase} className={selectClass}
                  onChange={e => onUpdate('timeSignalPhrase', e.target.value as TimeSignalPhrase)}>
                  {TIME_SIGNAL_PHRASES.map(v => (
                    <option key={v} value={v}>{timeSignalSpeechText(TIME_SIGNAL_EXAMPLE_AT, settings.timeSignalClock, v)}</option>
                  ))}
                </select>
              </Row>
              <Row label={w.timeSignal.clock.label}>
                <select value={settings.timeSignalClock} className={selectClass}
                  onChange={e => onUpdate('timeSignalClock', e.target.value as TimeSignalClock)}>
                  {TIME_SIGNAL_CLOCKS.map(v => <option key={v} value={v}>{w.timeSignal.clocks[v]}</option>)}
                </select>
              </Row>
            </>
          )}
          <Row label={w.timeSignal.quiet.label} description={w.timeSignal.quiet.description}>
            <div className="flex flex-wrap items-center justify-end gap-2 text-xs text-white">
              {settings.timeSignalQuietEnabled && (
                <>
                  <input type="time" value={minuteToTimeValue(settings.timeSignalQuietStartMin)} className={selectClass}
                    onChange={e => { const m = timeValueToMinute(e.target.value); if (m !== null) onUpdate('timeSignalQuietStartMin', m) }} />
                  <span>{w.timeSignal.from}</span>
                  <input type="time" value={minuteToTimeValue(settings.timeSignalQuietEndMin)} className={selectClass}
                    onChange={e => { const m = timeValueToMinute(e.target.value); if (m !== null) onUpdate('timeSignalQuietEndMin', m) }} />
                  <span>{w.timeSignal.until}</span>
                </>
              )}
              <Toggle checked={settings.timeSignalQuietEnabled} onChange={v => onUpdate('timeSignalQuietEnabled', v)} />
            </div>
          </Row>
          {speech && (
            <Row label={w.timeSignal.whileSpeaking.label} description={w.timeSignal.whileSpeaking.description}>
              <select value={settings.timeSignalWhileSpeaking} className={selectClass}
                onChange={e => onUpdate('timeSignalWhileSpeaking', e.target.value as TimeSignalWhileSpeaking)}>
                {TIME_SIGNAL_WHILE_SPEAKING.map(v => <option key={v} value={v}>{w.timeSignal.whileSpeakingOptions[v]}</option>)}
              </select>
            </Row>
          )}
          <Row label={w.timeSignal.volume.label}>
            <div className="flex items-center gap-2 text-xs text-white">
              {settings.timeSignalVolume !== null && (
                <>
                  <span className="text-secondary w-8 text-right">{Math.round(settings.timeSignalVolume * 100)}%</span>
                  <input type="range" min={0} max={1} step={0.05} value={settings.timeSignalVolume}
                    onChange={e => onUpdate('timeSignalVolume', Number(e.target.value))} className="w-24 accent-blue-500" />
                </>
              )}
              <span>{w.timeSignal.sameAsAlert}</span>
              <Toggle checked={settings.timeSignalVolume === null}
                onChange={v => onUpdate('timeSignalVolume', v ? null : settings.soundVolume)} />

            </div>
          </Row>
          {speech && voicevoxSpeakers.length > 0 && (
            <Row label={w.timeSignal.voice.label}>
              <select value={settings.timeSignalSpeakerId ?? ''} className={selectClass}
                onChange={e => onUpdate('timeSignalSpeakerId', e.target.value === '' ? null : Number(e.target.value))}>
                <option value="">{w.timeSignal.sameAsSpeech}</option>
                {voicevoxSpeakers.flatMap(spk =>
                  spk.styles.map(st => <option key={st.id} value={st.id}>{spk.name}{fw.paren(st.name)}</option>),
                )}
              </select>
            </Row>
          )}
        </>
      )}
    </>
  )
}

/** select の値を間隔に戻す（選択肢に無い値は毎正時） */
const ensureTimeSignalInterval = (v: number): TimeSignalIntervalMin =>
  (TIME_SIGNAL_INTERVALS as readonly number[]).includes(v) ? v as TimeSignalIntervalMin : 60

function Row({ label, description, hint, children }: {
  label: string
  description?: string
  /**
   * 常時表示する前置き。説明文（`description`）はホバー・タップまで隠れるため、
   * **隠すと失敗の原因が辿れなくなる前提条件**だけをここに置く。
   * 例: VOICEVOX 読み上げは別アプリの起動が要る。それを知らないまま ON にすると
   * 「接続状態: 起動していません」だけが出て、何を起動すべきか分からない。
   */
  hint?: string
  children?: React.ReactNode
}) {
  // **ラベルが 1 行のままコントロールと横に並ぶ行だけ横並びにし、入らない行はコントロールを下の段へ落とす**
  // （2026-11-04 ユーザー発言「収まらないものだけ下にしてほしいんだけど。なんで折り返してるものと、説明とボタンを分けてる
  // 行があるの？」）。ラベルを折り返してまで横に詰めると、コントロールの幅しだいで同じ並びの中に
  // 「ラベルを折り返して横並び」と「コントロールだけ下」が混ざる。
  // 仕組み: ラベルの箱の flex-basis を既定（auto＝中身の 1 行の幅）にし、flex-wrap に任せる。ラベル 1 行＋コントロールが
  // 行に入らなければ、コントロールが次の段へ回る。ラベル自身が行より長いときだけ、ラベルがその段の中で折れる（min-w-0）。
  // 前提の文（hint）は判定に数えない（`w-0 min-w-full` で中身の幅を 0 として扱い、表示は全幅）。長い前提の文があるだけで
  // コントロールが下へ落ちないように。右のコントロールは幅を譲らない（select の選択肢や URL 入力は縮めると読めなくなる）。
  // 伸長指定に flex-1 を使わないこと: flex ショートハンドが flex-basis を 0% で上書きし、ラベル 1 行の幅で判定できなくなる。
  return (
    // data-settings-row は説明の吹き出しが基準にする矩形の目印。ラベルではなく行を基準に
    // することで、2 段に折り返した行でコントロールを覆わない（DescriptionTip 参照）。
    <div data-settings-row className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
      <div className="min-w-0 grow">
        {/* 説明文は常時表示せず、ラベルをホバー・タップしたときだけ吹き出しで出す。
            設定の窓は行数が多く、全行に説明文を敷くと縦が 3 割伸びる（4804px→6310px）。 */}
        {description
          ? <DescriptionTip label={label} description={description} />
          : <p className="text-white text-sm">{label}</p>}
        {/* 改行は行を分ける（言語の行の「読み込めない」知らせは日本語と英語の 2 行） */}
        {hint && <p className="text-secondary text-xs mt-0.5 w-0 min-w-full whitespace-pre-line">{hint}</p>}
      </div>
      {/* ml-auto は 2 段に落ちた行のためにある。折り返した 2 行目はコントロール 1 個だけの行になり、
          アイテムが 1 個の行では justify-between が flex-start にフォールバックして左寄せになる
          （コントロール側が自前で持つ justify-end は中身の並びにしか効かない）。
          1 行に収まる行では先にラベルの grow が余白を使い切るので、この ml-auto は何もしない。
          max-w-full は行幅を超える中身への歯止め。flex-shrink-0 は「余白が足りないとき縮まない」
          という指定でしかなく、中身が行より広い場合ははみ出して窓の中身の overflow-x-hidden に
          切り取られる（データ出典の一行がこれに当たった。その行は現在 CreditRow へ移している）。
          max-width なら shrink とは別の制約として効くので、幅を譲らせたくない select や
          入力欄はそのままに、超過分だけ折り返せる。 */}
      <div className="shrink-0 ml-auto max-w-full">{children}</div>
    </div>
  )
}

/**
 * 出典表記の行。**1 つの出典を 1 行**に並べ、窓の幅で並べ方を変える —— 520px 未満（スマホ）はラベルの下に
 * 左寄せ、520px 以上はラベルの右に右寄せ（2026-11-04 ユーザー選択「幅で並べ方を変える (Recommended)」。説明「どの幅でも
 * 『1 つの出典＝1 行』にそろえる。…区切りの『 / 』『・』は行を分けるので消える。出典の文面そのものは変えない。
 * 切り替えの 520px は地震タブと同じ境」）。きっかけは、出典を「/」で繋いだ 1 行が 390px で
 * 「使用ソフトウェアのライセン／ス」のように値の途中で折れていたこと。
 *
 * `Row` の並べ方（ラベル 1 行＋コントロールが入らなければ下へ）は使わない。出典行は値が長いので、ラベルは自然幅にする
 * （`shrink-0`）。1 つの出典が行より長いときだけ、その中で折れる（`min-w-0`）。
 */
function CreditRow({ label, items }: { label: string; items: readonly React.ReactNode[] }) {
  return (
    // data-settings-row は Row と同じ目印。この行は今のところ説明文を持たないため吹き出しは
    // 出ないが、後から説明を足したときに基準が行全体になるよう先に付けておく（付け忘れると
    // ラベル 1 個分の矩形が基準になり、値を覆わないための設計が効かなくなる）。
    <div data-settings-row className="flex flex-col gap-1 px-4 py-3 min-[520px]:flex-row min-[520px]:items-start min-[520px]:gap-x-4">
      <p className="text-white text-sm shrink-0">{label}</p>
      <ul className="min-w-0 grow flex flex-col items-start gap-0.5 text-xs text-secondary min-[520px]:items-end min-[520px]:text-right">
        {items.map((item, i) => <li key={i}>{item}</li>)}
      </ul>
    </div>
  )
}

const CREDIT_LINK_CLASS = 'text-blue-400 hover:text-blue-300'

/** 名前の位置の目印（辞書の文に名前の代わりに渡し、その位置へリンクを置く。文の中に現れない字） */
const CREDIT_NAME_SLOT = '\u0000'

/**
 * 配信した施設（EarthScope）の出典。語順は言語ごとに辞書の `credits.distributedBy` が決め（日本語「配信 EarthScope」・
 * 韓国語「EarthScope 배포」・中国語「由 EarthScope（NSF NGF）发布」）、名前の位置にリンクと括弧の添え書きを置く
 */
function DistributedByCredit({ sentence, paren }: { sentence: (name: string) => string; paren: string }) {
  const [before, after = ''] = sentence(CREDIT_NAME_SLOT).split(CREDIT_NAME_SLOT)
  return (
    <>
      {before}
      <a href="https://www.earthscope.org/" target="_blank" rel="noopener noreferrer" className={CREDIT_LINK_CLASS}>EarthScope</a>{paren}
      {after}
    </>
  )
}

const SCALE_OPTIONS = [10, 20, 30, 40, 45, 50, 55, 60, 70] as const

function ScaleSelect({ value, onChange, noneLabel, includeNone = true }: {
  value: number
  onChange: (v: number) => void
  noneLabel?: string
  /**
   * 「絞らない」を表す -1 の選択肢を出すか。
   *
   * 有効・無効を別のトグルで持つ項目では出さない。出すと `SCALE_OPTIONS` の最小値と同じ文言
   * （「震度1以上」）が 2 つ並び、どちらを選んでも同じ結果になる紛らわしい一覧になる。
   */
  includeNone?: boolean
}) {
  const { settings: w, formats: fw } = useMessages()
  return (
    <select
      value={value}
      onChange={e => onChange(Number(e.target.value))}
      className="bg-panel border border-border text-white text-xs rounded-sm px-2 py-1.5 focus:outline-hidden focus:border-blue-500"
    >
      {includeNone && <option value={-1}>{noneLabel ?? w.scale.all}</option>}
      {SCALE_OPTIONS.map(s => (
        <option key={s} value={s}>{w.scale.orAbove(intensityLabel(s, fw))}</option>
      ))}
    </select>
  )
}

/**
 * 選んだ震度の横の札。地震一覧の小さな震度の枠と同じ作り（震度の濃い地・震度の色の縁・白い字）にそろえる
 * （2026-11-04 ユーザー選択「地震タブの枠にそろえる (Recommended)」）。
 */
function IntensityBadge({ scale }: { scale: number }) {
  const { settings: w, formats: fw } = useMessages()
  if (scale === -1) return null
  return (
    <span
      className="inline-block text-xs font-bold px-1.5 py-0.5 rounded-md"
      style={quakeTileColors(scale)}
    >
      {w.scale.badge(intensityLabel(scale, fw))}
    </span>
  )
}

type ButtonColor = 'red' | 'orange' | 'yellow' | 'purple' | 'blue' | 'green' | 'teal'

// 白文字（text-white）を載せるため、通常時・ホバー時とも WCAG AA（4.5:1）を満たす濃さにする。
// orange / yellow / green は従来の色（Tailwind v3 の値で測った比）だとホバー時に 3.56 / 1.92 / 3.30 まで落ちていたため、
// 一段ずつ暗い側へずらした（従来の通常時の色がホバー時の色に来る形）。比は Tailwind v4 の色
// （oklch）で測った値で、最小は red のホバー 4.76。
const BUTTON_CLASSES: Record<ButtonColor, string> = {
  red:    'bg-red-700 hover:bg-red-600',
  orange: 'bg-orange-800 hover:bg-orange-700',
  yellow: 'bg-yellow-800 hover:bg-yellow-700',
  purple: 'bg-purple-700 hover:bg-purple-600',
  blue:   'bg-blue-700 hover:bg-blue-600',
  green:  'bg-green-800 hover:bg-green-700',
  // 解説情報バナー（teal）に合わせた色。green と同じ理由で一段暗い側を使う（ホバー時 5.4:1）
  teal:   'bg-teal-800 hover:bg-teal-700',
}

function TestButton({ color, onClick, children, disabled }: {
  color: ButtonColor
  onClick: () => void
  children: React.ReactNode
  disabled?: boolean
}) {
  const w = useMessages().settings
  const [fired, setFired] = useState(false)

  const handle = () => {
    onClick()
    setFired(true)
    setTimeout(() => setFired(false), 2000)
  }

  return (
    <button
      onClick={handle}
      disabled={disabled}
      className={`text-xs text-white px-3 py-1.5 rounded-md transition-colors motion-reduce:transition-none disabled:opacity-40 disabled:cursor-not-allowed ${
        fired ? 'bg-gray-600' : BUTTON_CLASSES[color]
      }`}
    >
      {fired ? w.common.sent : children}
    </button>
  )
}

/**
 * VOICEVOX の試聴。**発話ごとに分けて渡す**（1 つの文字列へ繋げない。理由は
 * `voicevoxPreviewTexts` と `speakSequentially` のコメント）。
 *
 * 読み上げ文の組み立てもこの中で行う。呼び出し側の引数として評価すると、組み立てが投げた例外は
 * `speakSequentially` が Promise を返す前に起きるため `catch` に入らず、押しても無音のまま
 * 画面には何も出ない。
 */
async function speakVoicevoxPreview(baseUrl: string, speakerId: number, volume: number): Promise<void> {
  // 試聴は VOICEVOX をもう一度試す（「繋がらない」の印が残ったままだと、VOICEVOX が直っていても端末の声で鳴る）
  clearVoicevoxDown()
  await speakSequentially(baseUrl, voicevoxPreviewTexts(), speakerId, volume)
}

// 震度別の色付き小ボタン（通知音テスト用）。表記と色は強震モニタのインデックスから引く
// （震度0 は地震情報の階級表に無いため。地図の強震モニタの点と同じ色になる）
function IntensityPlayButton({ kyoshinIndex }: { kyoshinIndex: number }) {
  const { settings: w, formats: fw } = useMessages()
  const [active, setActive] = useState(false)
  const handle = () => {
    unlockAudio()
    playKyoshinUpdateSound(kyoshinIndex)
    setActive(true)
    setTimeout(() => setActive(false), 600)
  }
  const label = kyoshinIndexLabelText(kyoshinIndex, fw) ?? '?'
  const fill = kyoshinIntensityColor(kyoshinIndex) ?? '#666666'
  return (
    <button
      onClick={handle}
      title={w.soundTest.intensityTitle(label)}
      className={`text-xs font-bold px-2 py-1 rounded-md transition-opacity motion-reduce:transition-none ${active ? 'opacity-40' : 'hover:opacity-75'}`}
      style={{ backgroundColor: fill, color: readableTextColor(fill) }}
    >
      {label}
    </button>
  )
}

/**
 * S 波到達カウントダウン音（残り 5〜1 秒）を 1 段階だけ試聴する小ボタン。
 * 実運用では登録地点を設定したうえで S 波到達が残り 5 秒を切らないと鳴らないため、
 * 段階ごとの差（ゲート周波数の上昇・残り 1 秒の重ね音）はここでしか聞き分けられない。
 */
function CountdownPlayButton({ second }: { second: number }) {
  const w = useMessages().settings
  const [active, setActive] = useState(false)
  const handle = () => {
    unlockAudio()
    playCountdownBeep(second)
    setActive(true)
    setTimeout(() => setActive(false), 600)
  }
  // 残り 1 秒だけ音の構成が変わる（サブ低音とトーンを重ねる）ため、色でも区別する。
  return (
    <button
      onClick={handle}
      title={w.soundTest.countdownTitle(second)}
      className={`text-xs font-bold text-white px-2 py-1 rounded-md transition-opacity motion-reduce:transition-none ${
        active ? 'opacity-40' : ''
      } ${second === 1 ? BUTTON_CLASSES.red : BUTTON_CLASSES.blue}`}
    >
      {second}
    </button>
  )
}

function NotificationPermissionButton() {
  const w = useMessages().settings
  const [perm, setPerm] = useState<NotificationPermission>(
    typeof Notification !== 'undefined' ? Notification.permission : 'denied',
  )

  const request = useCallback(async () => {
    if (typeof Notification === 'undefined') return
    const result = await Notification.requestPermission()
    setPerm(result)
  }, [])

  if (perm === 'granted') return <span className="text-xs text-green-400 font-medium">{w.permission.granted}</span>
  if (perm === 'denied') return <span className="text-xs text-red-400">{w.permission.denied}</span>
  return (
    <button
      onClick={request}
      className={ACTION_BUTTON_CLASS}
    >
      {w.permission.request}
    </button>
  )
}

// LOW-A5: サーバー時刻オフセット表示。Yahoo 強震モニタ経由で較正済みなら差分（ms）を、
// 未較正（Yahoo 到達不能など）なら「未較正」を表示する。5 秒ごとに再取得。
function ServerClockOffsetDisplay() {
  const w = useMessages().settings
  const [offsetMs, setOffsetMs] = useState<number | null>(getServerClockOffsetMs())
  useEffect(() => {
    const id = window.setInterval(() => setOffsetMs(getServerClockOffsetMs()), 5000)
    return () => window.clearInterval(id)
  }, [])
  if (offsetMs === null) {
    return <span className="text-xs text-secondary">{w.clock.uncalibrated}</span>
  }
  const sign = offsetMs > 0 ? '+' : ''
  return <span className="text-xs text-secondary">{sign}{offsetMs} ms</span>
}

// ---- Main component ----

function HomeLocationSection({
  homeLat,
  homeLng,
  onUpdate,
}: {
  homeLat: number | null
  homeLng: number | null
  onUpdate: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void
}) {
  const w = useMessages().settings
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<SettingsMessage | null>(null)

  const handleGetLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setError(message(m => m.home.noGeolocation))
      return
    }
    setLoading(true)
    setError(null)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        onUpdate('homeLat', pos.coords.latitude)
        onUpdate('homeLng', pos.coords.longitude)
        setLoading(false)
      },
      (err) => {
        const denied = err.code === 1
        setError(message(m => denied ? m.home.permissionNeeded : m.home.failed))
        setLoading(false)
      },
      { enableHighAccuracy: false, timeout: 10000 },
    )
  }, [onUpdate])

  const handleClear = useCallback(() => {
    onUpdate('homeLat', null)
    onUpdate('homeLng', null)
    setError(null)
  }, [onUpdate])

  const isSet = homeLat !== null && homeLng !== null

  // 手で入れる欄（2026-10-25 ユーザー選択「緯度・経度の欄だけ (Recommended)」）。いまの地点を入れた状態から始め、
  // 現在地の取得やクリアで地点が変わったら欄も追う。
  const [latText, setLatText] = useState(homeLat === null ? '' : String(homeLat))
  const [lngText, setLngText] = useState(homeLng === null ? '' : String(homeLng))
  useEffect(() => {
    setLatText(homeLat === null ? '' : String(homeLat))
    setLngText(homeLng === null ? '' : String(homeLng))
  }, [homeLat, homeLng])
  const typedLat = parseCoordinateNumber(latText)
  const typedLng = parseCoordinateNumber(lngText)
  // 範囲の外・読めない値ではボタンを押せない（文言は足さない。欄の名前とボタンだけで伝える）
  const canApply = isValidHomeLocation(typedLat, typedLng) && (typedLat !== homeLat || typedLng !== homeLng)
  // 地図の道具から「37.5, 137.2」を 1 つの欄へ貼った形は、どちらの欄へ貼っても 2 つの欄へ割って入れる
  const handleCoordinateChange = useCallback((text: string, setOwn: (t: string) => void) => {
    const pair = splitPastedLatLng(text)
    if (pair) {
      setLatText(pair.lat)
      setLngText(pair.lng)
      return
    }
    setOwn(text)
  }, [])
  const handleApply = useCallback(() => {
    if (typedLat === null || typedLng === null || !isValidHomeLocation(typedLat, typedLng)) return
    onUpdate('homeLat', typedLat)
    onUpdate('homeLng', typedLng)
    setError(null)
  }, [typedLat, typedLng, onUpdate])

  // 他の設定と同じ行の形（ラベル左・操作右）で 2 行に並べる（2026-11-04 ユーザー選択「行の形にそろえる (Recommended)」。
  // 説明「1 行目はラベル『現在地』、下に今の説明文…をそのまま常に出し、右に今の値…と［現在地を取得］［クリア］。
  // 2 行目はラベル『緯度・経度で入れる』、右に緯度・経度の欄と［この地点にする］」）
  return (
    <>
      <Row label={w.home.current.label} hint={w.home.current.hint}>
        <div className="flex flex-col items-end gap-1">
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className="text-xs text-secondary font-mono">
              {isSet
                ? <><span className="whitespace-nowrap">{w.home.lat(homeLat!.toFixed(4))}</span> <span className="whitespace-nowrap">{w.home.lng(homeLng!.toFixed(4))}</span></>
                : w.home.unset}
            </span>
            <button onClick={handleGetLocation} disabled={loading} className={ACTION_BUTTON_CLASS}>
              {loading ? w.common.fetching : w.home.getCurrent}
            </button>
            {isSet && (
              <button onClick={handleClear} className={ACTION_BUTTON_CLASS}>
                {w.home.clear}
              </button>
            )}
          </div>
          {error && <span className="text-xs text-red-400 text-right">{error(w)}</span>}
        </div>
      </Row>
      {/* ラベルの下に、緯度・経度の欄と［この地点にする］を行の幅いっぱいに 1 列で並べる（2026-11-04 ユーザー発言
          「緯度経度で選ぶところが気に食わん」の後、見本を見ての選択「案 A：全幅で 1 列 (Recommended)」）。右寄せで詰めると
          欄が行の途中に浮いて見えるので、この行だけは `Row` の「ラベル左・操作右」を使わない。2 つの欄は同じ幅 */}
      <div data-settings-row className="flex flex-col gap-2 px-4 py-3">
        <p className="text-white text-sm">{w.home.manual}</p>
        <div className="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
          <label className="flex min-w-0 items-center gap-1 whitespace-nowrap text-xs text-secondary">
            {w.home.latitude}
            <input
              type="text"
              inputMode="decimal"
              value={latText}
              onChange={e => handleCoordinateChange(e.target.value, setLatText)}
              className="w-full min-w-0 bg-panel border border-border rounded-sm px-1.5 py-1 text-xs text-white font-mono"
            />
          </label>
          <label className="flex min-w-0 items-center gap-1 whitespace-nowrap text-xs text-secondary">
            {w.home.longitude}
            <input
              type="text"
              inputMode="decimal"
              value={lngText}
              onChange={e => handleCoordinateChange(e.target.value, setLngText)}
              className="w-full min-w-0 bg-panel border border-border rounded-sm px-1.5 py-1 text-xs text-white font-mono"
            />
          </label>
          <button onClick={handleApply} disabled={!canApply} className={ACTION_BUTTON_CLASS}>
            {w.home.apply}
          </button>
        </div>
      </div>
    </>
  )
}

// React.memo 化の理由と props 参照安定性の要件は docs/spec/architecture-spec.md 参照。
/**
 * 到達予想キー・予報キーの行（入っている端末にだけ出す）。
 *
 * **入れる欄は出さない**（設定の読み込みでだけ入れる。設計書 §0 の 2026-10-31「予報キーの欄」「到達予想キーの欄」の行）。
 * 行には名前とボタン「消す」と今の状態の文だけを出し、キーの文字列は出さない。
 *
 * **キーの文字列は見えないので、貼った値を目で確かめられない。** 結果を添えていなかった頃は、
 * 成功も 5 通りの失敗も画面の見た目が同じ（何も出ない）で、確かめる手段が開発者コンソールか
 * 実際の緊急地震速報しか無かった。とくに「鍵の組を作り直したのに公開鍵を貼り忘れた」事故は、
 * 症状が「署名が合わない」だけなので気づく契機がここにしか無い。
 *
 * **未入力では何も出さない** —— 触っていない利用者に「使えません」と読める表示を置かない
 * （入力欄の `未設定` が既にそれを伝えている）。
 *
 * **理由ごとに文を分ける**（→ `utils/arrivalToken.ts` の `arrivalTokenProblemMessage`）。
 * 期限切れと鍵違いで次の行動が変わるので、1 つの「無効です」へ畳まない。
 *
 * **何を出すかは `arrivalTokenStatusLine` が決める。** ここは調子（`tone`）を色へ写すだけ
 * —— 分岐を JSX の中に置くとテストで押さえられない。
 */
const ARRIVAL_TOKEN_TONE_CLASS: Record<ArrivalTokenStatusTone, string> = {
  checking: 'text-secondary',
  valid: 'text-green-400 font-medium',
  problem: 'text-red-400',
}

function SignedKeyRowBody(
  { status, onClear, relayRejected }: { status: ArrivalTokenStatus, onClear: () => void, relayRejected: boolean },
) {
  const w = useMessages().settings
  const line = arrivalTokenStatusLine(status, w.signedKey)
  return (
    // 状態の文と［消す］を 1 行に並べる（2026-11-04 ユーザー選択「行の形にそろえる (Recommended)」。説明「到達予想キーは
    // 『有効（2027/09/22 10:16 まで）』と［消す］を同じ 1 行に並べる」）。入らない幅では文が［消す］の左で折れる
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center justify-end gap-2">
        {line && (
          <span className={`text-xs text-right leading-snug ${ARRIVAL_TOKEN_TONE_CLASS[line.tone]}`}>
            {line.text}
          </span>
        )}
        <button
          type="button"
          onClick={onClear}
          className={ACTION_BUTTON_CLASS}
        >
          {w.signedKey.remove}
        </button>
      </div>
      {relayRejected && (
        <span className="text-xs text-right leading-snug text-red-400">{w.signedKey.relayRejected}</span>
      )}
    </div>
  )
}

export const SettingsTab = memo(function SettingsTab({ settings, onUpdate, arrivalTokenStatus, forecastKeyStatus, forecastKeyRelayRejected, relayForecastLive, onReplaceSettings, onTest, kyoshinTimeOffset, kyoshinInputDateTime, onSetKyoshinInputDateTime, dmdataConnectionStatus, relayUpstream, keyForecastStatus, dmdataClassifications, replayIsFetching, replayError, onStartReplay, onStopReplay, historicalArchives, historicalArchivesLoading, seismoUnreadableCount }: Props) {
  const m = useMessages()
  const w = m.settings
  const fw = m.formats
  const localeLoadFailed = useLocaleLoadFailed()
  const [voicevoxStatus, setVoicevoxStatus] = useState<'idle' | 'checking' | 'available' | 'unavailable' | 'invalid'>('idle')
  const [voicevoxSpeakers, setVoicevoxSpeakers] = useState<VoicevoxSpeaker[]>([])

  // 通信を起こす側へ渡す URL は入力が落ち着くまで待つ。保存と入力欄の表示は即座に反映したいので、
  // 遅らせるのは通信する側だけにする。**設定の変化で通信するものは全部待たせること** ——
  // ここの確認 effect のほかに、切り出し語の作り置き（`App.tsx` の `warmFixedPhrases`）が
  // 同じ性質を持つ。試聴・実際の読み上げはユーザー操作・電文の受信の時点でしか通信しない。
  const debouncedVoicevoxUrl = useDebouncedValue(settings.voicevoxUrl, VOICEVOX_URL_DEBOUNCE_MS)
  // 入力が止まって確認が走るまでの間、前回の結果（例:「起動中」）を出したままにすると、
  // 入力欄に見えている URL とは別の URL の結果を指してしまう。確認予定であることを見せる。
  const isVoicevoxCheckPending = settings.voicevoxUrl !== debouncedVoicevoxUrl

  useEffect(() => {
    // VOICEVOX の欄を出すのは声が VOICEVOX のときだけなので、確かめるのもそのときだけ
    if (!settings.ttsEnabled || settings.ttsVoice !== 'voicevox') {
      setVoicevoxStatus('idle')
      setVoicevoxSpeakers([])
      return
    }
    // URL として成立していない値では通信しない。「起動していません」と出すと VOICEVOX 側の
    // 問題に見えるため、入力の誤りとして区別する。
    if (!isValidVoicevoxUrl(debouncedVoicevoxUrl)) {
      setVoicevoxStatus('invalid')
      setVoicevoxSpeakers([])
      return
    }
    let cancelled = false
    setVoicevoxStatus('checking')
    checkVoicevoxAvailable(debouncedVoicevoxUrl).then(ok => {
      if (cancelled) return
      if (!ok) { setVoicevoxStatus('unavailable'); return }
      return fetchVoicevoxSpeakers(debouncedVoicevoxUrl).then(spks => {
        if (cancelled) return
        setVoicevoxSpeakers(spks)
        setVoicevoxStatus('available')
      })
    }).catch(() => { if (!cancelled) setVoicevoxStatus('unavailable') })
    return () => { cancelled = true }
  }, [settings.ttsEnabled, settings.ttsVoice, debouncedVoicevoxUrl])

  // 自作地震計ホストの確認。**VOICEVOX と同じ流儀**（通信する側だけデバウンス後の値を使う）。
  const debouncedSeismoUrl = useDebouncedValue(settings.seismoHostUrl, VOICEVOX_URL_DEBOUNCE_MS)
  const isSeismoCheckPending = settings.seismoHostUrl !== debouncedSeismoUrl
  const [seismoStatus, setSeismoStatus] = useState<SeismoUiStatus>({ kind: 'disabled' })
  const seismoStatusText = seismoStatusLine(seismoStatus, w.seismoStatus)

  useEffect(() => {
    if (!settings.seismoEnabled) {
      setSeismoStatus({ kind: 'disabled' })
      return
    }
    // **空欄と「形が違う」を分ける。** 空欄は「まだ入れていない」ので促す側の文に、
    // 形が違うのは直せる誤りなので赤で出す。どちらも通信しない。
    if (debouncedSeismoUrl.trim() === '') {
      setSeismoStatus({ kind: 'no-url' })
      return
    }
    if (!isValidSeismoHostUrl(debouncedSeismoUrl)) {
      setSeismoStatus({ kind: 'invalid' })
      return
    }
    let cancelled = false
    setSeismoStatus({ kind: 'checking' })
    fetchSeismoStatus(debouncedSeismoUrl)
      .then(result => { if (!cancelled) setSeismoStatus(result) })
      // **投げさせない。** `fetchSeismoStatus` は理由を戻り値で返す契約だが、
      // ここで漏れると設定の窓が「確認中…」のまま固まる。
      .catch((error: unknown) => {
        log.warn('[seismo] 接続確認が失敗した', error)
        if (!cancelled) setSeismoStatus({ kind: 'unreachable', detail: 'check-threw', reason: 'unknown' })
      })
    return () => { cancelled = true }
  }, [settings.seismoEnabled, debouncedSeismoUrl])

  const handleTimeConfirm = () => {
    if (!kyoshinInputDateTime) return
    const specified = new Date(kyoshinInputDateTime)
    if (isNaN(specified.getTime())) return
    onStartReplay(specified)
  }

  const replayStartLabel = kyoshinTimeOffset != null
    ? serverDate().toLocaleString('ja-JP')
    : null

  // 入力済みのキーが通信に載せられない文字を含んでいるか。空欄は「未設定」として別に扱うため
  // ここには含めない（入力途中に赤字が出続けるのを避ける）。
  const isApiKeyInvalid = settings.dmdataApiKey !== '' && !isValidDmdataApiKey(settings.dmdataApiKey)
  // 予報（VXSE45）にしか無い形の電文を流すテストボタンは、予報を受けられる人（鍵を入れた人・中継が予報キーを
  // 受け付けた人）にだけ出す（docs/isdmdss-allocation.md の「DMDSS 版だけのテストボタン」の行。§0「予報だけ各自の鍵」・2026-10-31「予報キー」）
  const hasForecastKey = (settings.dmdataApiKey !== '' && !isApiKeyInvalid) || (forecastKeyStatus.valid && !forecastKeyRelayRejected)

  // スクロールと余白は窓の中身の領域（`SettingsDialog`）が受け持つ。見出しどうしの間を `gap` で空けるのは、
  // 隠した見出し（`hidden`）が間を取らないため（余白を見出し側に持たせると、隠れた見出しの分だけ末尾がずれる）。
  return (
    <div className="flex flex-col gap-6">

      {/* 見出しと接続の 2 行は 2026-10-31 ユーザー選択「「電文」「予報（APIキー）」 (Recommended)」 */}
      <Section category="connection" title={w.sections.connection}>
        <div className="px-4 py-2 bg-yellow-900/30 border-b border-yellow-700/40">
          <p className="text-yellow-400 text-xs">{w.rows.apiKeyNote}</p>
        </div>
        {/* 文言と色の対応は `connectionLabel.ts` が単一情報源。**ここに分岐を戻さないこと**
            —— 三項演算子の連鎖は最後の `:` が全部を受けるので、`ConnectionStatus` に値を
            足したときの書き忘れが型検査に掛からない。 */}
        <Row label={w.rows.telegram.label}>
          {(() => {
            const label = telegramConnectionLabel(dmdataConnectionStatus, relayUpstream, w.connection)
            return <span className={`text-xs ${label.className}`}>{label.text}</span>
          })()}
        </Row>
        {/* 行名と経路の添え方は 2026-10-31 ユーザー選択「「予報」1 行＋経路を括弧 (Recommended)」 */}
        <Row label={w.rows.forecast.label}>
          {(() => {
            const label = forecastConnectionLabel({
              relayForecastLive,
              keyStatus: keyForecastStatus,
              relayStatus: dmdataConnectionStatus,
              relayUpstream,
              relayForecastAvailable: forecastKeyStatus.valid && !forecastKeyRelayRejected,
            }, {
              apiKeySet: Boolean(settings.dmdataApiKey),
              apiKeyInvalid: isApiKeyInvalid,
            }, w.connection)
            return <span className={`text-xs ${label.className}`}>{label.text}</span>
          })()}
        </Row>
        {/* 受けていない区分は出さない（ログにだけ残す。2026-10-14 ユーザー承認）。値は DMDATA の購入区分名 */}
        {dmdataConnectionStatus === 'connected' && dmdataClassifications !== null && (
          <Row label={w.rows.classifications.label}>
            <span className="text-xs text-secondary">{classificationLabel(dmdataClassifications, w.classifications)}</span>
          </Row>
        )}
        <Row label={w.rows.apiKey.label} description={w.rows.apiKey.description}>
          {/* 不正な文字は入力時に弾かず、入ったことを見せて本人に直させる。入力欄から黙って
              取り除くと、貼り付けたキーが勝手に変わって「合っているのに繋がらない」状態になる。 */}
          <div className="flex flex-col items-end gap-1">
            <input
              type="password"
              value={settings.dmdataApiKey}
              onChange={e => onUpdate('dmdataApiKey', e.target.value)}
              placeholder={w.rows.apiKey.placeholder}
              autoComplete="off"
              className={`bg-panel border text-white text-xs rounded-sm px-2 py-1.5 focus:outline-hidden w-48 ${
                isApiKeyInvalid ? 'border-red-500 focus:border-red-500' : 'border-border focus:border-blue-500'
              }`}
            />
            {isApiKeyInvalid && (
              <p className="text-xs text-red-400 w-48 text-left leading-snug">{w.apiKeyInvalid}</p>
            )}
            {settings.dmdataKeyReentryNotice && settings.dmdataApiKey === '' && (
              <p className="text-xs text-sky-300 w-48 text-left leading-snug">{m.quake.list.keyReentry}</p>
            )}
          </div>
        </Row>
        {/* 予報キーは入っている端末にだけ、APIキーの行のすぐ下に出す（2026-10-31 ユーザー選択「名前＋消すボタン (Recommended)」） */}
        {settings.forecastKey !== '' && (
          <Row label={w.rows.forecastKey.label}>
            <SignedKeyRowBody
              status={forecastKeyStatus}
              onClear={() => onUpdate('forecastKey', '')}
              relayRejected={forecastKeyRelayRejected}
            />
          </Row>
        )}
        <Row label={w.rows.testDelivery.label} description={w.rows.testDelivery.description}>
          <Toggle
            checked={settings.dmdataTestDelivery}
            onChange={v => onUpdate('dmdataTestDelivery', v)}
          />
        </Row>
      </Section>

      {/* ブラウザ通知。**まとめて止めると、種類ごとの行とテスト通知を隠す**（値は書き換えないので、戻せば元どおり効く。
          文言とこの見せ方は 2026-10-25 ユーザー承認）。通知を出すかの判定は `utils/notificationGate.ts` の 1 箇所。
          「通知許可」だけは止めていても出す（許可はブラウザ側の状態で、この設定とは別）。 */}
      <Section category="notification" title={w.sections.browserNotify}>
        <Row label={w.rows.notifyEnabled.label} description={w.rows.notifyEnabled.description}>
          <Toggle checked={settings.notifyEnabled} onChange={v => onUpdate('notifyEnabled', v)} />
        </Row>
        {settings.notifyEnabled && (
          <>
            {/* 名前と説明は 2026-11-05 ユーザー選択「画面に出ている間だけ止める (Recommended)」。止める場所は
                services/notifyQuietWhileOpen.ts（プッシュ通知は中継が送る前に尋ねる。2026-11-05 選択「受け取りを待って送る (Recommended)」） */}
            <Row label={w.rows.notifyQuietWhileOpen.label} description={w.rows.notifyQuietWhileOpen.description}>
              <Toggle checked={settings.notifyQuietWhileOpen} onChange={v => onUpdate('notifyQuietWhileOpen', v)} />
            </Row>
            {/* **種別のトグルは地震情報の通知から独立させる**（2026-10-22 ユーザー選択「3 種を切り離す (Recommended)」。
                行の文面は 2026-10-24 ユーザー選択「この案でよい (Recommended)」）。入り切りは最低震度と別の値で持つ
                （切って入れ直しても最低震度を忘れない。2026-10-25 ユーザー承認）。 */}
            <Row label={w.rows.notifyQuake.label} description={w.rows.notifyQuake.description}>
              <Toggle checked={settings.notifyQuake} onChange={v => onUpdate('notifyQuake', v)} />
            </Row>
            {settings.notifyQuake && (
              <Row label={w.rows.notifyMinScale.label} description={w.rows.notifyMinScale.description}>
                <div className="flex items-center gap-2">
                  <IntensityBadge scale={settings.notifyMinScale} />
                  <ScaleSelect
                    value={settings.notifyMinScale}
                    onChange={v => onUpdate('notifyMinScale', v === -1 ? 10 : v)}
                    noneLabel={w.rows.notifyMinScale.noneLabel}
                  />
                </div>
              </Row>
            )}
            {/* ── 種別トグル: テスト系と同じ 揺れ検知 → EEW → 津波 → 南海トラフ の順 ── */}
            <Row label={w.rows.notifyDetection.label} description={w.rows.notifyDetection.description}>
              <Toggle checked={settings.notifyDetection} onChange={v => onUpdate('notifyDetection', v)} />
            </Row>
            <Row label={w.rows.notifyEEW.label} description={w.rows.notifyEEW.description}>
              <Toggle checked={settings.notifyEEW} onChange={v => onUpdate('notifyEEW', v)} />
            </Row>
            <Row label={w.rows.notifyTsunami.label} description={w.rows.notifyTsunami.description}>
              <Toggle checked={settings.notifyTsunami} onChange={v => onUpdate('notifyTsunami', v)} />
            </Row>
            <Row label={w.rows.notifyNankai.label} description={w.rows.notifyNankai.description}>
              <Toggle checked={settings.notifyNankai} onChange={v => onUpdate('notifyNankai', v)} />
            </Row>
            {/* 定例解説とお知らせの通知は既定オフ（2026-11-09 ユーザー選択「新設・既定オフ」） */}
            <Row label={w.rows.notifyNankaiRoutine.label} description={w.rows.notifyNankaiRoutine.description}>
              <Toggle checked={settings.notifyNankaiRoutine} onChange={v => onUpdate('notifyNankaiRoutine', v)} />
            </Row>
            <Row label={w.rows.notifyQuakeNotice.label} description={w.rows.notifyQuakeNotice.description}>
              <Toggle checked={settings.notifyQuakeNotice} onChange={v => onUpdate('notifyQuakeNotice', v)} />
            </Row>
            {/* 地域の絞りは画面内の通知にもプッシュ通知にも効く（2026-11-03 ユーザー選択「両方に掛ける (Recommended)」。
                名前と説明は 2026-11-03 ユーザー選択「通知する地域」） */}
            <Row label={w.rows.notifyPrefectures.label} description={w.rows.notifyPrefectures.description}>
              <PrefecturePicker value={settings.notifyPrefectures} onChange={v => onUpdate('notifyPrefectures', v)} />
            </Row>
          </>
        )}
        <Row label={w.rows.notifyPermission.label} description={w.rows.notifyPermission.description}>
          <NotificationPermissionButton />
        </Row>
        {/* 試すボタンは設定の隣に置く（読み上げの「テスト読み上げ」と同じ）。まとめて止めている間は出さない */}
        {settings.notifyEnabled && (
          <Row label={w.rows.testNotification.label} description={w.rows.testNotification.description}>
            <TestButton color="green" onClick={onTest.notification}>{w.rows.testNotification.button}</TestButton>
          </Row>
        )}
      </Section>

      {/* プッシュ通知（docs/relay-server-design.md §6.7）は配信サーバーへ届け先を登録する別の仕組みなので、見出しを分ける
          （2026-11-06 ユーザー選択「プッシュ通知」）。上の種類ごとの通知・地域の絞りがそのまま効くので、
          通知をまとめて止めている間は見出しごと出さない。購読を扱えないブラウザ（安全な接続でない・Push API が無い）でも出さない。
          名前と説明は 2026-11-03 ユーザー選択「プッシュ通知」 */}
      {settings.notifyEnabled && pushSupported() && (
        <Section category="notification" title={w.sections.push}>
          <Row label={w.rows.pushNotify.label} description={w.rows.pushNotify.description}>
            {/* 入れるときは、押した操作の中で最初に許可を求める（Safari・Firefox は操作から離れた許可の要求を尋ねない）。
                許可されなければ入れない */}
            <Toggle
              checked={settings.pushNotifyEnabled}
              onChange={v => {
                if (!v) { onUpdate('pushNotifyEnabled', false); return }
                void requestPushPermission()
                  .then(ok => { if (ok) onUpdate('pushNotifyEnabled', true) })
                  .catch((err: unknown) => log.warn('[push] 通知の許可を求められませんでした', err))
              }}
            />
          </Row>
        </Section>
      )}

      <Section category="sound" title={w.sections.sound}>
        <Row label={w.rows.sound.label} description={w.rows.sound.description}>
          <Toggle
            checked={settings.soundEnabled}
            onChange={v => onUpdate('soundEnabled', v)}
          />
        </Row>
        {/* 読み上げの入り切りと声（2026-11-08 ユーザー選択「声を 2 択＋自動で落とす (Recommended)」「この並べ方で足す (Recommended)」）。
            声を選んでも VOICEVOX に繋がらない報は端末の声で読む（`utils/voicevox.ts` の `routesToSystemVoice`） */}
        <Row label={w.rows.tts.label} description={w.rows.tts.description}>
          <Toggle checked={settings.ttsEnabled} onChange={v => onUpdate('ttsEnabled', v)} />
        </Row>
        {settings.ttsEnabled && (
          <Row label={w.rows.ttsVoice.label} description={w.rows.ttsVoice.description}>
            <div className="flex items-center gap-2">
              <select
                value={settings.ttsVoice}
                onChange={e => onUpdate('ttsVoice', e.target.value as TtsVoice)}
                className="bg-panel border border-border rounded-sm px-2 py-1 text-xs text-white"
              >
                <option value="voicevox">VOICEVOX</option>
                <option value="system">{w.rows.ttsVoice.system}</option>
              </select>
              {/* 試聴は今の声で読む（VOICEVOX に繋がらなければ端末の声へ落ちるのも本番と同じ）。通信先はデバウンス後の URL（下の VOICEVOX の試聴と同じ理由） */}
              <TestButton color="blue" onClick={() => {
                unlockAudio()
                speakVoicevoxPreview(debouncedVoicevoxUrl, settings.voicevoxSpeakerId, settings.soundVolume)
                  .catch(err => log.warn('[settings] 試聴の読み上げに失敗', err))
              }}>{w.common.preview}</TestButton>
            </div>
          </Row>
        )}
        {/* 時報も鳴らすので数える（時報の「通知音と同じ」はこの音量を指す。切ると行ごと消えて辿れない） */}
        {(settings.soundEnabled || settings.ttsEnabled || settings.timeSignalEnabled) && (
          <Row label={w.rows.volume.label} description={w.rows.volume.description}>
            <div className="flex items-center gap-2">
              <span className="text-xs text-secondary w-8 text-right">
                {Math.round(settings.soundVolume * 100)}%
              </span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={settings.soundVolume}
                onChange={e => onUpdate('soundVolume', Number(e.target.value))}
                className="w-24 accent-blue-500"
              />
            </div>
          </Row>
        )}
        {/* 解説情報は平常時でも毎月1回は必ず届くため、音と読み上げを個別に切れるようにしている。
            臨時情報（段階の発表）はこの設定に関わらず鳴る。 */}
        <Row
          label={w.rows.nankaiCommentaryAlerts.label}
          description={w.rows.nankaiCommentaryAlerts.description}
        >
          <Toggle
            checked={settings.nankaiCommentaryAlerts}
            onChange={v => onUpdate('nankaiCommentaryAlerts', v)}
          />
        </Row>
        <Row
          label={w.rows.quakeNoticeAlerts.label}
          description={w.rows.quakeNoticeAlerts.description}
        >
          <Toggle
            checked={settings.quakeNoticeAlerts}
            onChange={v => onUpdate('quakeNoticeAlerts', v)}
          />
        </Row>
        {/* 文言は 2026-10-31 ユーザー選択「「揺れ検知の読み上げ」 (Recommended)」、説明文の最後の一文は同日「範囲内と書く (Recommended)」。既定はオフ */}
        <Row
          label={w.rows.kyoshinDetectSpeech.label}
          description={w.rows.kyoshinDetectSpeech.description}
        >
          <Toggle
            checked={settings.kyoshinDetectSpeech}
            onChange={v => onUpdate('kyoshinDetectSpeech', v)}
          />
        </Row>
      </Section>

      {/* 時報は地震・津波の音や読み上げとは別の機能なので、見出しを分ける（2026-11-06 ユーザー発言「時報は独立したセクションにしたいです。」、
          置き場所は選択「音と読み上げのすぐ下」、行の名前は選択「「時報」のまま (Recommended)」） */}
      <Section category="sound" title={w.sections.timeSignal}>
        <TimeSignalRows settings={settings} onUpdate={onUpdate} voicevoxSpeakers={voicevoxStatus === 'available' ? voicevoxSpeakers : []} />
      </Section>

      {/* VOICEVOX の接続と声（2026-11-06 ユーザー選択「VOICEVOX」）。読み上げの声が VOICEVOX のときだけ出す
          （2026-11-08 ユーザー選択「この並べ方で足す (Recommended)」。入り切りは上の「音と読み上げ」の「読み上げ」） */}
      {settings.ttsEnabled && settings.ttsVoice === 'voicevox' && (
      <Section category="sound" title="VOICEVOX">
          <>
            {/* 「要：VOICEVOXアプリ起動」は hint に置いて常時見せる。説明文に混ぜて隠すと、
                「接続状態: 起動していません」だけが見えて原因に辿り着けない。 */}
            <Row label="VOICEVOX URL" description={w.rows.voicevoxUrl.description} hint={w.rows.voicevoxUrl.hint}>
              {/* 赤枠と理由は入力が落ち着いてから出す（判定に使うのはデバウンス後の値）。
                  打鍵ごとに判定すると、書き直している最中ずっと赤いままになる。 */}
              <div className="flex flex-col items-end gap-1">
                <input
                  type="text"
                  value={settings.voicevoxUrl}
                  onChange={e => onUpdate('voicevoxUrl', e.target.value)}
                  className={`bg-panel border rounded-sm px-2 py-1 text-xs text-white w-44 ${
                    voicevoxStatus === 'invalid' ? 'border-red-500' : 'border-border'
                  }`}
                  spellCheck={false}
                />
                {voicevoxStatus === 'invalid' && (
                  <p className="text-xs text-red-400 w-44 text-left leading-snug">
                    {w.rows.voicevoxUrl.invalid}
                  </p>
                )}
              </div>
            </Row>
            <Row label={w.rows.voicevoxStatus.label} description="">
              <span className={`text-xs ${
                isVoicevoxCheckPending ? 'text-secondary'
                : voicevoxStatus === 'available' ? 'text-green-400'
                : voicevoxStatus === 'unavailable' || voicevoxStatus === 'invalid' ? 'text-red-400'
                : 'text-secondary'
              }`}>
                {isVoicevoxCheckPending || voicevoxStatus === 'checking' ? w.common.checking
                  : voicevoxStatus === 'available' ? w.rows.voicevoxStatus.available
                  : voicevoxStatus === 'unavailable' ? w.rows.voicevoxStatus.unavailable
                  : voicevoxStatus === 'invalid' ? w.rows.voicevoxStatus.invalid
                  : '—'}
              </span>
            </Row>
            {voicevoxStatus === 'available' && voicevoxSpeakers.length > 0 && (
              <>
                <Row label={w.rows.voicevoxSpeaker.label} description={w.rows.voicevoxSpeaker.description}>
                  <select
                    value={settings.voicevoxSpeakerId}
                    onChange={e => onUpdate('voicevoxSpeakerId', Number(e.target.value))}
                    className="bg-panel border border-border rounded-sm px-2 py-1 text-xs text-white"
                  >
                    {voicevoxSpeakers.flatMap(spk =>
                      spk.styles.map(st => (
                        <option key={st.id} value={st.id}>{spk.name}{fw.paren(st.name)}</option>
                      ))
                    )}
                  </select>
                </Row>
                <Row label={w.rows.voicevoxTest.label} description="">
                  {/* 通信先はデバウンス後の URL。ここに並ぶ話者は「確認が済んだ URL」から取ったもので、
                      選べる話者と鳴らす相手が食い違わないよう揃える。生の値を使うと、URL を書き換えている
                      最中（接続状態が「確認中…」の間）に押したとき、入力途中の未検証の宛先へ投げて
                      黙って無音に終わる。 */}
                  {/* 読ませる文は `voicevoxPreviewTexts` が実運用と同じ関数から組む。ここに
                      文字列を書くと、緊急地震速報の文型を変えたとき試聴だけ古い形で残る。 */}
                  <TestButton color="blue" onClick={() => {
                    unlockAudio()
                    speakVoicevoxPreview(debouncedVoicevoxUrl, settings.voicevoxSpeakerId, settings.soundVolume)
                      .catch(err => log.warn('[settings] 試聴の読み上げに失敗', err))
                  }}>{w.common.preview}</TestButton>
                </Row>
              </>
            )}
          </>
      </Section>
      )}

      {/* 読み上げの詳しさ。読み上げを入れたときだけ出す（切った端末では何も効かないため）。
          並びは「地域の列挙 → 1 件ごとの詳しさ → 気象庁の発表文」。中の順序は
          通知設定・テスト機能と同じカテゴリ順（地震情報 → 津波情報 → 緊急地震速報）。 */}
      {settings.ttsEnabled && (
        <Section category="sound" title={w.sections.speech}>
          <Row label={w.rows.ttsIntensityLevels.label} description={w.rows.ttsIntensityLevels.description}>
            <select
              value={settings.ttsIntensityLevels}
              onChange={e => onUpdate('ttsIntensityLevels', Number(e.target.value))}
              className="bg-panel border border-border rounded-sm px-2 py-1 text-xs text-white"
            >
              {/* 最後の選択肢は「すべての階級」。値は階級の段数から導く（数を直接書くと、
                  階級が増減したときに選択肢だけが古い段数のまま残る）。 */}
              {[0, 1, 2, 3, 4, INTENSITY_SCALE_COUNT - 1].map(n => (
                <option key={n} value={n}>
                  {n === 0 ? w.rows.ttsIntensityLevels.maxOnly : n === INTENSITY_SCALE_COUNT - 1 ? w.rows.ttsIntensityLevels.all : w.rows.ttsIntensityLevels.plus(n)}
                </option>
              ))}
            </select>
          </Row>
          <Row label={w.rows.ttsAlwaysReadScale.label} description={w.rows.ttsAlwaysReadScale.description}>
            <div className="flex items-center gap-2">
              <IntensityBadge scale={settings.ttsAlwaysReadScale} />
              <ScaleSelect
                value={settings.ttsAlwaysReadScale}
                onChange={v => onUpdate('ttsAlwaysReadScale', v)}
                noneLabel={w.rows.ttsAlwaysReadScale.noneLabel}
              />
            </div>
          </Row>
          <Row label={w.rows.ttsAlwaysReadLpgmClass.label} description={w.rows.ttsAlwaysReadLpgmClass.description}>
            {/* 震度の下限は長周期に効かないので別に持つ（2026-10-22 ユーザー選択「必ず読む階級を設ける (Recommended)」、
                文言は 2026-10-24 選択「この形でよい (Recommended)」）。階級 0 も選べる（2026-10-30 ユーザー選択「足す (Recommended)」）。 */}
            <select
              value={settings.ttsAlwaysReadLpgmClass}
              onChange={e => onUpdate('ttsAlwaysReadLpgmClass', Number(e.target.value))}
              className="bg-panel border border-border rounded-sm px-2 py-1 text-xs text-white"
            >
              <option value={-1}>{w.rows.ttsAlwaysReadScale.noneLabel}</option>
              {[0, 1, 2, 3, 4].map(n => (
                <option key={n} value={n}>{w.rows.ttsAlwaysReadLpgmClass.option(n)}</option>
              ))}
            </select>
          </Row>
          <Row label={w.rows.ttsMaxRegions.label} description={w.rows.ttsMaxRegions.description}>
            <select
              value={settings.ttsMaxRegions}
              onChange={e => onUpdate('ttsMaxRegions', Number(e.target.value))}
              className="bg-panel border border-border rounded-sm px-2 py-1 text-xs text-white"
            >
              {[0, 3, 5, 10, 15, 20].map(n => (
                <option key={n} value={n}>{n === 0 ? w.common.unlimited : w.rows.ttsMaxRegions.option(n)}</option>
              ))}
            </select>
          </Row>
          {settings.ttsMaxRegions > 0 && (
            <Row label={w.rows.ttsRegionTolerance.label} description={w.rows.ttsRegionTolerance.description}>
              <select
                value={settings.ttsRegionTolerance}
                onChange={e => onUpdate('ttsRegionTolerance', Number(e.target.value))}
                className="bg-panel border border-border rounded-sm px-2 py-1 text-xs text-white"
              >
                {[0, 1, 2, 3, 5].map(n => (
                  <option key={n} value={n}>{n === 0 ? w.rows.ttsRegionTolerance.none : w.rows.ttsRegionTolerance.option(n)}</option>
                ))}
              </select>
            </Row>
          )}
          <Row label={w.rows.ttsReadHypocenterDetail.label} description={w.rows.ttsReadHypocenterDetail.description}>
            <Toggle
              checked={settings.ttsReadHypocenterDetail}
              onChange={v => onUpdate('ttsReadHypocenterDetail', v)}
            />
          </Row>
          <Row label={w.rows.ttsUnreceivedDetail.label} description={w.rows.ttsUnreceivedDetail.description}>
            <select
              value={settings.ttsUnreceivedDetail}
              onChange={e => onUpdate('ttsUnreceivedDetail', e.target.value as TtsUnreceivedDetail)}
              className="bg-panel border border-border rounded-sm px-2 py-1 text-xs text-white"
            >
              <option value="stations">{w.rows.ttsUnreceivedDetail.stations}</option>
              <option value="areas">{w.rows.ttsUnreceivedDetail.areas}</option>
              <option value="none">{w.rows.ttsUnreceivedDetail.none}</option>
            </select>
          </Row>
          <Row label={w.rows.ttsMaxObservationPoints.label} description={w.rows.ttsMaxObservationPoints.description}>
            <select
              value={settings.ttsMaxObservationPoints}
              onChange={e => onUpdate('ttsMaxObservationPoints', Number(e.target.value))}
              className="bg-panel border border-border rounded-sm px-2 py-1 text-xs text-white"
            >
              {[0, 1, 3, 5, 10, 15, 20].map(n => (
                <option key={n} value={n}>{n === 0 ? w.common.unlimited : w.rows.ttsMaxObservationPoints.option(n)}</option>
              ))}
            </select>
          </Row>
          <Row label={w.rows.ttsReadEewLpgmClass.label} description={w.rows.ttsReadEewLpgmClass.description}>
            <Toggle
              checked={settings.ttsReadEewLpgmClass}
              onChange={v => onUpdate('ttsReadEewLpgmClass', v)}
            />
          </Row>
          <Row label={w.rows.ttsReadEewWarningRegions.label} description={w.rows.ttsReadEewWarningRegions.description}>
            <Toggle
              checked={settings.ttsReadEewWarningRegions}
              onChange={v => onUpdate('ttsReadEewWarningRegions', v)}
            />
          </Row>
          <Row label={w.rows.ttsReadTelegramText.label} description={w.rows.ttsReadTelegramText.description}>
            <Toggle
              checked={settings.ttsReadTelegramText}
              onChange={v => onUpdate('ttsReadTelegramText', v)}
            />
          </Row>
          {/* 内訳はマスタートグルが入っているときだけ出す（切っていれば何を選んでも読まない）。 */}
          {settings.ttsReadTelegramText && (
            <TelegramTextBlockRows
              blocks={settings.ttsTelegramTextBlocks}
              onChange={next => onUpdate('ttsTelegramTextBlocks', next)}
            />
          )}
          {settings.ttsReadTelegramText && (
            <TelegramBoilerplateRows
              reads={settings.ttsTelegramBoilerplate}
              onChange={next => onUpdate('ttsTelegramBoilerplate', next)}
            />
          )}
        </Section>
      )}

      {/* 地震の一覧の絞り込みは地震タブの一覧の上へ移した（2026-11-07 選択「地震タブに置き、設定から外す (Recommended)」・
          移したことは設定の窓に書かない: 選択「書かない (Recommended)」） */}
      <Section category="display" title={w.sections.display}>
        {/* 表示設定の先頭に置く（2026-11-12 ユーザー選択「表示の節の先頭 (Recommended)」）。言語の名前はどの言語の画面でも
            その言語自身の書き方（→ i18n/messages.ts の LOCALES） */}
        <Row
          label={w.rows.locale.label}
          description={w.rows.locale.description}
          // 選んだ言語の辞書を読めず日本語で出しているときだけ。そのときは選んだ言語では書けないので、日本語と英語で出す
          // （2026-11-12 ユーザー選択「日本語＋英語で出す (Recommended)」）
          hint={localeLoadFailed !== null ? `${LOCALE_LOAD_FAILED_JA}\n${LOCALE_LOAD_FAILED_EN}` : undefined}
        >
          <select
            value={settings.locale}
            onChange={e => onUpdate('locale', e.target.value as LocaleSetting)}
            className="bg-panel border border-border text-white text-xs rounded-sm px-2 py-1.5 focus:outline-hidden focus:border-blue-500"
          >
            <option value="auto">{w.rows.locale.auto}</option>
            {LOCALES.map(l => (
              <option key={l.id} value={l.id} lang={l.tag}>{l.name}</option>
            ))}
          </select>
        </Row>
        <Row label={w.rows.uiScale.label} description={w.rows.uiScale.description}>
          <select
            value={settings.uiScale}
            onChange={e => onUpdate('uiScale', Number(e.target.value))}
            className="bg-panel border border-border text-white text-xs rounded-sm px-2 py-1.5 focus:outline-hidden focus:border-blue-500"
          >
            {[0.5, 0.6, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3].map(s => (
              <option key={s} value={s}>{Math.round(s * 100)}%</option>
            ))}
          </select>
        </Row>
        <Row label={w.rows.mapIconScale.label} description={w.rows.mapIconScale.description}>
          <select
            value={settings.mapIconScale}
            onChange={e => onUpdate('mapIconScale', Number(e.target.value))}
            className="bg-panel border border-border text-white text-xs rounded-sm px-2 py-1.5 focus:outline-hidden focus:border-blue-500"
          >
            {[0.5, 0.6, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3].map(s => (
              <option key={s} value={s}>{Math.round(s * 100)}%</option>
            ))}
          </select>
        </Row>
        <Row
          label={w.rows.hypocenterDepthScale.label}
          description={w.rows.hypocenterDepthScale.description}
        >
          <select
            value={settings.hypocenterDepthScale}
            onChange={e => onUpdate('hypocenterDepthScale', Number(e.target.value))}
            className="bg-panel border border-border text-white text-xs rounded-sm px-2 py-1.5 focus:outline-hidden focus:border-blue-500"
          >
            {[1, 2, 3, 5, 8, 12, 20].map(s => (
              <option key={s} value={s}>{s === 1 ? w.rows.hypocenterDepthScale.actual : w.rows.hypocenterDepthScale.times(s)}</option>
            ))}
          </select>
        </Row>
        {/* 2026-10-23 ユーザー選択「やることとして積む (Recommended)」・寸法と文面は 2026-10-24 ユーザー選択 */}
        {/* 地震・津波に関するお知らせ（運用連絡）。帯と、音・読み上げを別々に切り替える
            （文言は 2026-10-18 ユーザー承認）。 */}
        <Row
          label={w.rows.quakeNoticeBanner.label}
          description={w.rows.quakeNoticeBanner.description}
        >
          <Toggle
            checked={settings.quakeNoticeBanner}
            onChange={v => onUpdate('quakeNoticeBanner', v)}
          />
        </Row>
      </Section>

      {/* 地図に重ねるものの入り切り（2026-11-06 ユーザー選択「地図」） */}
      <Section category="display" title={w.sections.map}>
        {/* ── 地図レイヤー: 地形 → 明るさ → 地質構造 → 観測データ の順。
            濃さのような従属する項目は、親のトグルがオンのときだけ出す（VOICEVOX の関連設定と同じ） ── */}
        <Row label={w.rows.showBathymetry.label} description={w.rows.showBathymetry.description}>
          <Toggle
            checked={settings.showBathymetry}
            onChange={v => onUpdate('showBathymetry', v)}
          />
        </Row>
        <Row label={w.rows.showDayNight.label} description={w.rows.showDayNight.description}>
          <Toggle
            checked={settings.showDayNight}
            onChange={v => onUpdate('showDayNight', v)}
          />
        </Row>
        {settings.showDayNight && (
          <Row label={w.rows.dayNightOpacity.label} description={w.rows.dayNightOpacity.description}>
            <div className="flex items-center gap-2">
              <span className="text-xs text-secondary w-8 text-right">
                {Math.round(settings.dayNightOpacity * 100)}%
              </span>
              <input
                type="range"
                min={DAY_NIGHT_OPACITY_MIN}
                max={DAY_NIGHT_OPACITY_MAX}
                step={0.05}
                value={settings.dayNightOpacity}
                onChange={e => onUpdate('dayNightOpacity', Number(e.target.value))}
                className="w-24 accent-blue-500"
              />
            </div>
          </Row>
        )}
        <Row label={w.rows.showPlateBoundaries.label} description={w.rows.showPlateBoundaries.description}>
          <Toggle
            checked={settings.showPlateBoundaries}
            onChange={v => onUpdate('showPlateBoundaries', v)}
          />
        </Row>
        <Row label={w.rows.showActiveFaults.label} description={w.rows.showActiveFaults.description}>
          <Toggle
            checked={settings.showActiveFaults}
            onChange={v => onUpdate('showActiveFaults', v)}
          />
        </Row>
        {settings.showActiveFaults && (
          <Row label={w.rows.activeFaultOpacity.label} description={w.rows.activeFaultOpacity.description}>
            <div className="flex items-center gap-2">
              <span className="text-xs text-secondary w-8 text-right">
                {Math.round(settings.activeFaultOpacity * 100)}%
              </span>
              <input
                type="range"
                min={0.05}
                max={1}
                step={0.05}
                value={settings.activeFaultOpacity}
                onChange={e => onUpdate('activeFaultOpacity', Number(e.target.value))}
                className="w-24 accent-blue-500"
              />
            </div>
          </Row>
        )}
        <Row label={w.rows.showQuakeHeatmap.label} description={w.rows.showQuakeHeatmap.description}>
          <Toggle
            checked={settings.showQuakeHeatmap}
            onChange={v => onUpdate('showQuakeHeatmap', v)}
          />
        </Row>
        {/* 凡例を出さない設定や点が 0 件のときも期間を変えられるように置く（2026-10-25 ユーザー選択「A1 設定タブにも足す (Recommended)」）。 */}
        {settings.showQuakeHeatmap && (
          <Row label={w.rows.heatmapPeriod.label} description={w.rows.heatmapPeriod.description}>
            <select
              value={settings.heatmapPeriod}
              onChange={e => { if (isHeatmapPeriod(e.target.value)) onUpdate('heatmapPeriod', e.target.value) }}
              className="bg-panel border border-border text-white text-xs rounded-sm px-2 py-1.5 focus:outline-hidden focus:border-blue-500"
            >
              {HEATMAP_PERIODS.map(p => (
                <option key={p.key} value={p.key}>{m.map.legend.heatmapPeriod[p.key]}</option>
              ))}
            </select>
          </Row>
        )}
        <Row label={w.rows.showMapLegend.label} description={w.rows.showMapLegend.description}>
          <Toggle
            checked={settings.showMapLegend}
            onChange={v => onUpdate('showMapLegend', v)}
          />
        </Row>
      </Section>

      <Section category="display" title={w.sections.intensityScale}>
        <div className="px-4 py-3 flex flex-wrap gap-2">
          {Object.keys(INTENSITY_LABELS)
            .map(Number)
            .filter(scale => scale !== -1)
            .map(scale => {
              const fill = getIntensityColor(scale)
              return (
                <div key={scale} className="flex items-center gap-1.5">
                  {/* 四角は 2 文字までの大きさなので、地図の丸と同じ短い札（英語などは「5-」） */}
                  <span
                    className="w-6 h-6 rounded-md flex items-center justify-center text-xs font-bold"
                    style={{ backgroundColor: fill, color: readableTextColor(fill) }}
                  >
                    {intensityShortLabel(scale, fw)}
                  </span>
                  <span className="text-xs text-secondary">{w.scale.badge(intensityLabel(scale, fw))}</span>
                </div>
              )
            })}
        </div>
      </Section>

      <Section category="behavior" title={w.sections.behavior}>
        <Row label={w.rows.defaultTab.label} description={w.rows.defaultTab.description}>
          <select
            value={settings.defaultTab}
            onChange={e => onUpdate('defaultTab', e.target.value as AppSettings['defaultTab'])}
            className="bg-panel border border-border text-white text-xs rounded-sm px-2 py-1.5 focus:outline-hidden focus:border-blue-500"
          >
            <option value="earthquake">{m.nav.earthquake}</option>
            <option value="realtime">{m.nav.realtime}</option>
          </select>
        </Row>
        <Row label={w.rows.tsunamiPriorityDefault.label} description={w.rows.tsunamiPriorityDefault.description}>
          <Toggle
            checked={settings.tsunamiPriorityDefault}
            onChange={v => onUpdate('tsunamiPriorityDefault', v)}
          />
        </Row>
        <Row label={w.rows.tsunamiTitleTemporary.label} description={w.rows.tsunamiTitleTemporary.description}>
          <Toggle
            checked={settings.tsunamiTitleTemporary}
            onChange={v => onUpdate('tsunamiTitleTemporary', v)}
          />
        </Row>
        <Row label={w.rows.idleRevertSec.label} description={w.rows.idleRevertSec.description}>
          <select
            value={settings.idleRevertSec}
            onChange={e => onUpdate('idleRevertSec', Number(e.target.value))}
            className="bg-panel border border-border text-white text-xs rounded-sm px-2 py-1.5 focus:outline-hidden focus:border-blue-500"
          >
            <option value={0}>{w.rows.idleRevertSec.off}</option>
            <option value={15}>{w.common.seconds(15)}</option>
            <option value={30}>{w.common.seconds(30)}</option>
            <option value={60}>{w.common.minutes(1)}</option>
            <option value={120}>{w.common.minutes(2)}</option>
            <option value={180}>{w.common.minutes(3)}</option>
            <option value={300}>{w.common.minutes(5)}</option>
            <option value={600}>{w.common.minutes(10)}</option>
            <option value={1800}>{w.common.minutes(30)}</option>
          </select>
        </Row>
        <Row label={w.rows.periodicReload.label} description={w.rows.periodicReload.description}>
          <Toggle
            checked={settings.periodicReloadHours > 0}
            onChange={v => onUpdate('periodicReloadHours', v ? 1 : 0)}
          />
        </Row>
        <Row label={w.rows.recordingMode.label} description={w.rows.recordingMode.description}>
          <Toggle checked={settings.recordingMode} onChange={v => onUpdate('recordingMode', v)} />
        </Row>
      </Section>

      {/* 行動チェックリスト（→ action-checklist-spec.md）。タブの切り替えとは別の機能なので見出しを分ける（2026-11-06 ユーザー選択「行動チェックリスト」） */}
      <Section category="behavior" title={w.sections.checklist}>
        <Row label={w.rows.actionChecklist.label} description={w.rows.actionChecklist.description}>
          <Toggle
            checked={settings.actionChecklistEnabled}
            onChange={v => onUpdate('actionChecklistEnabled', v)}
          />
        </Row>
        {settings.actionChecklistEnabled && (
          <Row label={w.rows.actionChecklistMinScale.label} description={w.rows.actionChecklistMinScale.description}>
            <div className="flex items-center gap-2">
              <IntensityBadge scale={settings.actionChecklistMinScale} />
              <ScaleSelect
                value={settings.actionChecklistMinScale}
                onChange={v => onUpdate('actionChecklistMinScale', v)}
                includeNone={false}
              />
            </div>
          </Row>
        )}
      </Section>

      <Section category="location" title={w.sections.home}>
        <HomeLocationSection
          homeLat={settings.homeLat}
          homeLng={settings.homeLng}
          onUpdate={onUpdate}
        />
        {/* 到達予想キーも入っている端末にだけ出す（2026-10-31 ユーザー選択「隠す（予報キーと同じ形）」） */}
        {settings.arrivalToken !== '' && (
          <Row label={w.rows.arrivalToken.label}>
            <SignedKeyRowBody
              status={arrivalTokenStatus}
              onClear={() => onUpdate('arrivalToken', '')}
              relayRejected={false}
            />
          </Row>
        )}
      </Section>

      {/* 前提条件は hint に置いて常時見せる。VOICEVOX の「要：VOICEVOXアプリ起動」と
          同じ判断で、吹き出しに隠すと有効にしたとき「応答がない」だけが見えて、
          何を直せばよいか分からなくなる（iOS 実機では通常の Safari タブから繋がらない。
          seismo-host/REQUIREMENTS.md §13）。
          **「PWA」と書かない。** 利用者向けの文言でこの語を使っているのはここだけで、
          設定の窓を開く人が意味を知っている前提は置けない。VOICEVOX 側が
          「アプリを起動する」と行動で書いているのと揃える。 */}
      <Section category="location" title={w.sections.seismo}>
        <Row
          label={w.rows.seismoEnabled.label}
          description={w.rows.seismoEnabled.description}
          hint={w.rows.seismoEnabled.hint}
        >
          <Toggle checked={settings.seismoEnabled} onChange={v => onUpdate('seismoEnabled', v)} />
        </Row>
        {settings.seismoEnabled && (
          <>
            <Row label={w.rows.seismoHostUrl.label} description={w.rows.seismoHostUrl.description}>
              {/* 赤枠と理由は入力が落ち着いてから出す（判定に使うのはデバウンス後の値）。
                  打鍵ごとに判定すると、書き直している最中ずっと赤いままになる。 */}
              <input
                type="text"
                value={settings.seismoHostUrl}
                onChange={e => onUpdate('seismoHostUrl', e.target.value)}
                className={`bg-panel border rounded-sm px-2 py-1 text-xs text-white w-44 ${
                  seismoStatus.kind === 'invalid' ? 'border-red-500' : 'border-border'
                }`}
                spellCheck={false}
                inputMode="url"
              />
            </Row>
            <Row label={w.rows.seismoStatus.label} description="">
              <span className="flex flex-col items-end gap-0.5 w-56">
                <span
                  className={`text-xs text-right leading-snug ${
                    isSeismoCheckPending
                      ? SEISMO_STATUS_TONE_CLASS.muted
                      : SEISMO_STATUS_TONE_CLASS[seismoStatusText.tone]
                  }`}
                >
                  {isSeismoCheckPending ? w.common.checking : seismoStatusText.text}
                </span>
                {/* 読めない押し出しが届いているときだけ 2 行目に出す（文面は 2026-10-24 ユーザー選択「その文でよい (Recommended)」）。
                    地図には出さない（2026-09-30 の決定「接続だけ出す」）。 */}
                {seismoUnreadableCount > 0 && (
                  <span className={`text-xs text-right leading-snug ${SEISMO_STATUS_TONE_CLASS.problem}`}>
                    {seismoUnreadableLine(seismoUnreadableCount, w.seismoStatus)}
                  </span>
                )}
              </span>
            </Row>
            {seismoStatus.kind === 'ok' && seismoStatus.stations.length > 0 && (
              <Row label={w.rows.seismoStations.label} description={w.rows.seismoStations.description}>
                <span className="text-xs text-secondary w-56 text-right leading-snug">
                  {seismoStatus.stations.map(s => s.displayName).join(w.common.listSeparator)}
                </span>
              </Row>
            )}
            {/* **「揺れたときだけ」でも波形は受け取り続ける。** 揺れてから受け取り始めたのでは
                立ち上がりが絵に入らないので、切り替えるのは表示だけ（→
                `utils/seismoWaveTrigger.ts`）。通信量が増えることは hint で伝える。 */}
            {/* 説明の 2 文目は 2026-10-24 ユーザー選択「その文でよい (Recommended)」（「表示しない」は地震カードの波形と震度も止める
                —— `App.tsx` の `useSeismoQuakeWaves` の `enabled`）。注記の通信量は同日の選択「「（1日約1.3GB）」を添える
                (Recommended)」（合成の押し出しは毎秒約 15 KB。`services/seismoStream.ts` の `SeismoWaveWant`）。 */}
            <Row
              label={w.rows.seismoWave.label}
              description={w.rows.seismoWave.description}
              hint={w.rows.seismoWave.hint}
            >
              <select
                value={settings.seismoWave}
                onChange={e => onUpdate('seismoWave', e.target.value as AppSettings['seismoWave'])}
                className="bg-panel border border-border text-white text-xs rounded-sm px-2 py-1.5 focus:outline-hidden focus:border-blue-500"
              >
                <option value="off">{w.rows.seismoWave.off}</option>
                <option value="auto">{w.rows.seismoWave.auto}</option>
                <option value="always">{w.rows.seismoWave.always}</option>
              </select>
            </Row>
            {/* 地図の下端の波形と地震カードの波形の両方に効く（2026-10-13 ユーザー承認）。展開すると
                合成＋3 成分になるので、ここで選ぶのは畳んでいるときだけ。 */}
            <Row label={w.rows.seismoWaveCollapsedView.label} description={w.rows.seismoWaveCollapsedView.description}>
              <select
                value={settings.seismoWaveCollapsedView}
                onChange={e => onUpdate('seismoWaveCollapsedView', e.target.value as AppSettings['seismoWaveCollapsedView'])}
                className="bg-panel border border-border text-white text-xs rounded-sm px-2 py-1.5 focus:outline-hidden focus:border-blue-500"
              >
                <option value="composite">{w.rows.seismoWaveCollapsedView.composite}</option>
                <option value="overlay">{w.rows.seismoWaveCollapsedView.overlay}</option>
              </select>
            </Row>
          </>
        )}
      </Section>

      {/* **自作地震計の節の外に置く。** 時間幅は自作地震計と公開観測点の両方に効く（物差しを揃える）。
          文言は 2026-10-15 ユーザー承認（`docs/public-waveform-design.md` §0「案A」）。通信量は注記で常に見せる
          ——ホバーに隠すと、繋ぎっぱなしにしてから増えたことに気づけない。 */}
      <Section category="location" title={w.sections.wave}>
        {/* 文言は 2026-10-15 ユーザー承認（`docs/public-waveform-design.md` §0「案A」）。オフなら下の常時接続は押せない */}
        <Row
          label={w.rows.publicWave.label}
          description={w.rows.publicWave.description}
        >
          <Toggle checked={settings.publicWaveEnabled} onChange={v => onUpdate('publicWaveEnabled', v)} />
        </Row>
        <Row label={w.rows.waveSpan.label} description={w.rows.waveSpan.description}>
          <select
            value={settings.waveSpanSec}
            onChange={e => onUpdate('waveSpanSec', ensureWaveSpanSec(Number(e.target.value), settings.waveSpanSec))}
            className="bg-panel border border-border text-white text-xs rounded-sm px-2 py-1.5 focus:outline-hidden focus:border-blue-500"
          >
            {WAVE_SPAN_CHOICES.map(sec => (
              <option key={sec} value={sec}>{w.common.seconds(sec)}</option>
            ))}
          </select>
        </Row>
        <Row
          label={w.rows.publicWaveAlwaysConnected.label}
          description={w.rows.publicWaveAlwaysConnected.description}
          hint={w.rows.publicWaveAlwaysConnected.hint}
        >
          <fieldset disabled={!settings.publicWaveEnabled} className={settings.publicWaveEnabled ? '' : 'opacity-40'}>
            <Toggle checked={settings.publicWaveAlwaysConnected} onChange={v => onUpdate('publicWaveAlwaysConnected', v)} />
          </fieldset>
        </Row>
      </Section>

      <Section category="share" title={w.sections.share}>
        <Row label={w.rows.shareCardFormat.label} description={w.rows.shareCardFormat.description}>
          <select
            value={settings.shareCardFormat}
            onChange={e => onUpdate('shareCardFormat', e.target.value as AppSettings['shareCardFormat'])}
            className="bg-panel border border-border text-white text-xs rounded-sm px-2 py-1.5 focus:outline-hidden focus:border-blue-500"
          >
            {Object.values(SHARE_CARD_FORMATS).map(f => <option key={f.id} value={f.id}>{w.shareCardFormats[f.id]}</option>)}
          </select>
        </Row>
        <Row
          label={w.rows.settingsFile.label}
          description={w.rows.settingsFile.description}
        >
          <SettingsIoRow settings={settings} onReplace={onReplaceSettings} />
        </Row>
      </Section>

      <Section category="about" title={w.sections.about}>
        <AppVersionRow />
        <ReleaseHistoryRow />
        {/* 使用状況データ（設計書 §6.6）。既定はオフで、初めて開いたときの同意の窓（UsageConsentDialog）か、
            ここでオンにした間だけ送る。文面は 2026-11-03 ユーザー選択「VS Code・Apple の形」 */}
        <Row
          label={w.rows.usageStats.label}
          description={w.rows.usageStats.description}
        >
          <Toggle checked={settings.usageStatsEnabled} onChange={v => onUpdate('usageStatsEnabled', v)} />
        </Row>
        {/* 利用規約・プライバシーポリシーへの導線。
            **規約に同意を求める画面は出さない。** 無償・アカウント不要のアプリなので、起動を 1 手止めてまで
            読ませる筋合いが無い（通例もこの形）。読みたい人がここから辿れることを担保する。
            使用状況データの送信だけは、送る前に同意の窓で尋ねる（上の行）。

            **規約の本体はリポジトリの Markdown へ置き、ここからは GitHub を開く。**
            同じサイト内で配信する形（HTML を用意する）も採れるが、更新のたびに
            Markdown と HTML の 2 つを保たねばならず、片方だけ古くなる。
            第三者ライセンスだけは配信物に含まれる（`public/`）ので同一サイト内で開く。 */}
        <CreditRow label={w.credits.terms.label} items={[
          <a href="https://github.com/Ramilen-L-Emuruk/yuremado/blob/main/docs/terms-of-service.md" target="_blank" rel="noopener noreferrer" className={CREDIT_LINK_CLASS}>{w.credits.termsOfService}</a>,
          <a href="https://github.com/Ramilen-L-Emuruk/yuremado/blob/main/docs/privacy-policy.md" target="_blank" rel="noopener noreferrer" className={CREDIT_LINK_CLASS}>{w.credits.privacy}</a>,
          <a href={`${import.meta.env.BASE_URL}third-party-licenses.txt`} target="_blank" rel="noopener noreferrer" className={CREDIT_LINK_CLASS}>{w.credits.licenses}</a>,
        ]} />
        <CreditRow label={w.credits.quakeData.label} items={[
          <a href="https://dmdata.jp/" target="_blank" rel="noopener noreferrer" className={CREDIT_LINK_CLASS}>Project DM-D.S.S</a>,
        ]} />
        {/* 下部の波形に出す公開観測点（気象庁の広帯域地震計・JP 網）。文面は `docs/public-waveform-design.md` §0
            （2026-10-15 ユーザー承認）。EarthScope は運用者がライセンスを宣言していない網を CC BY 4.0 で配るので、
            運用者（気象庁）・配信した施設（EarthScope）・ライセンスの 3 つを挙げる（同 §2）。 */}
        <CreditRow label={w.credits.publicWave.label} items={[
          <><a href="https://www.jma.go.jp/" target="_blank" rel="noopener noreferrer" className={CREDIT_LINK_CLASS}>気象庁</a>{w.credits.paren(w.credits.jpNetwork)}</>,
          <DistributedByCredit sentence={w.credits.distributedBy} paren={w.credits.paren('NSF NGF')} />,
          <a href="https://creativecommons.org/licenses/by/4.0/deed.ja" target="_blank" rel="noopener noreferrer" className={CREDIT_LINK_CLASS}>CC BY 4.0</a>,
        ]} />
        {/* 地図に描いているデータの出典。実体は各生成スクリプト・ローダーの冒頭コメント
            （scripts/build-prefectures.mjs・build-subregions.mjs・build-tsunami-zones.mjs・
            build-active-faults.mjs・build-plate-boundaries.mjs・build-hypocenter-catalog.ts、
            utils/gebcoPrefetch.ts）で、ライセンス名と配布元、加工した旨まで含む完全な帰属は
            README.md「データ・地図・フォントの出典」に置く。ここはその要約。

            活断層（政府標準利用規約 2.0）・プレート境界（Open Data Commons Attribution License）・
            長期震源カタログ（気象庁 公共データ利用規約 第1.0版）は、出典の表示そのものが利用条件に
            あたる。**地図へレイヤーを足したらここへも足すこと。** 常時描く下地とは限らない——
            長期震源カタログは震源カタログタブでしか描かないが、描いている以上ここに挙げる。

            義務が無いものも、地図が描いていれば挙げる。**この行の範囲は「地図そのものを形づくる
            もの」**——地物の形（境界・海岸線・活断層線・プレート境界線）、下地の絵（海底地形）、
            地図が主題として描く点群（長期震源カタログ）。
            そこから外れるものは挙げていない。震度観測点の座標は、観測点や区域の名前から座標・
            読み上げの並び順・都道府県を引く汎用の索引で（地図の震度点を置くのはその用途の一つ）、
            供給するのは位置だけ。値そのものの出所は上の「地震・津波データ」が担う（座標の出典は
            data-sources-spec.md §6。一次出典は build-station-coords.mjs の冒頭コメント）。
            長期震源カタログを挙げるのは、あちらは位置も値もその出典自身のデータだから。
            地名ラベルの書体（M PLUS Rounded 1c・SIL OFL 1.1）は画面での表示を求められない。

            出典の名称は配信元が求める表記をそのまま使い、言い換えない（帰属としての要件を外すため）。
            添えるものは 2 種類あり、記号で書き分ける。**（）は用途**——名称だけでは地図の何に
            使われているか読めないものに付ける（「活断層データベース」は名称が用途を兼ねるので
            付けない）。**「」は元の資料名**——通称で呼んでいるものに付ける。
            PB2002 だけ用途が後ろへ回るのは、`PB2002 (Bird, 2003)` が割ってはならない引用の単位だから。 */}
        <CreditRow label={w.credits.map.label} items={[
          `気象庁 予報区等 GIS データ${w.credits.paren(w.credits.boundaries)}`,
          '気象庁 震源カタログ「地震月報」「震源リスト」',
          `GEBCO・NOAA NCEI${w.credits.paren(w.credits.seafloor)}`,
          '産総研 活断層データベース',
          `PB2002 (Bird, 2003)${w.credits.paren(w.credits.plateBoundaries)}`,
        ]} />
        <Row label={w.rows.serverClockOffset.label} description={w.rows.serverClockOffset.description}>
          <ServerClockOffsetDisplay />
        </Row>
      </Section>

      {/* ここから下は動作確認と記録の道具。分類の一覧では区切り線の下に置く（→ `SETTINGS_CATEGORIES` の `separated`） */}
      <Section category="dev" title={w.sections.soundTest}>
        <div className="px-4 py-2 bg-blue-900/30 border-b border-blue-700/40">
          <p className="text-blue-300 text-xs">{w.soundTest.note}</p>
        </div>
        {/* ── 揺れ検知（候補 → 初回 → 更新の順） ── */}
        <Row label={w.soundTest.kyoshinCandidate.label} description={w.soundTest.kyoshinCandidate.description}>
          <TestButton color="blue" onClick={() => { unlockAudio(); playAlertSound('kyoshinCandidate') }}>{w.common.preview}</TestButton>
        </Row>
        <Row label={w.soundTest.kyoshin.label} description={w.soundTest.kyoshin.description}>
          <TestButton color="blue" onClick={() => { unlockAudio(); playAlertSound('kyoshin') }}>{w.common.preview}</TestButton>
        </Row>
        <Row label={w.soundTest.kyoshinUpdate.label} description={w.soundTest.kyoshinUpdate.description}>
          <div className="flex flex-wrap gap-1.5 justify-end">
            <IntensityPlayButton kyoshinIndex={6} />
            <IntensityPlayButton kyoshinIndex={7} />
            <IntensityPlayButton kyoshinIndex={9} />
            <IntensityPlayButton kyoshinIndex={11} />
            <IntensityPlayButton kyoshinIndex={13} />
            <IntensityPlayButton kyoshinIndex={15} />
            <IntensityPlayButton kyoshinIndex={16} />
            <IntensityPlayButton kyoshinIndex={17} />
            <IntensityPlayButton kyoshinIndex={18} />
            <IntensityPlayButton kyoshinIndex={19} />
          </div>
        </Row>
        {/* ── 緊急地震速報（EEW） ── */}
        <Row label={w.soundTest.eewForecast.label} description={w.soundTest.eewForecast.description}>
          <TestButton color="blue" onClick={() => { unlockAudio(); playAlertSound('eewForecast') }}>{w.common.preview}</TestButton>
        </Row>
        <Row label={w.soundTest.eew.label} description={w.soundTest.eew.description}>
          <TestButton color="orange" onClick={() => { unlockAudio(); playAlertSound('eew') }}>{w.common.preview}</TestButton>
        </Row>
        <Row label={w.soundTest.eewSpecial.label} description={w.soundTest.eewSpecial.description}>
          <TestButton color="red" onClick={() => { unlockAudio(); playAlertSound('eewSpecial') }}>{w.common.preview}</TestButton>
        </Row>
        <Row label={w.soundTest.eewUpdate.label} description={w.soundTest.eewUpdate.description}>
          <TestButton color="orange" onClick={() => { unlockAudio(); playAlertSound('eewUpdate') }}>{w.common.preview}</TestButton>
        </Row>
        <Row label={w.soundTest.eewFinal.label} description={w.soundTest.eewFinal.description}>
          <TestButton color="blue" onClick={() => { unlockAudio(); playAlertSound('eewFinal') }}>{w.common.preview}</TestButton>
        </Row>
        <Row label={w.soundTest.eewCancel.label} description={w.soundTest.eewCancel.description}>
          <TestButton color="blue" onClick={() => { unlockAudio(); playAlertSound('eewCancel') }}>{w.common.preview}</TestButton>
        </Row>
        {/* S 波到達カウントダウンは重大度の系列とは別軸の補助音のため EEW の末尾に置く */}
        <Row label={w.soundTest.countdown.label} description={w.soundTest.countdown.description}>
          <div className="flex flex-wrap gap-1.5 justify-end">
            <CountdownPlayButton second={5} />
            <CountdownPlayButton second={4} />
            <CountdownPlayButton second={3} />
            <CountdownPlayButton second={2} />
            <CountdownPlayButton second={1} />
          </div>
        </Row>
        {/* ── 地震情報 ── */}
        <Row label={w.soundTest.earthquakePrompt.label} description={w.soundTest.earthquakePrompt.description}>
          <TestButton color="orange" onClick={() => { unlockAudio(); playAlertSound('earthquakePrompt') }}>{w.common.preview}</TestButton>
        </Row>
        <Row label={w.soundTest.earthquake.label} description={w.soundTest.earthquake.description}>
          <TestButton color="red" onClick={() => { unlockAudio(); playAlertSound('earthquake') }}>{w.common.preview}</TestButton>
        </Row>
        <Row label={w.soundTest.earthquakeInfo.label} description={w.soundTest.earthquakeInfo.description}>
          <TestButton color="blue" onClick={() => { unlockAudio(); playAlertSound('earthquakeInfo') }}>{w.common.preview}</TestButton>
        </Row>
        <Row label={w.soundTest.earthquakeCancel.label} description={w.soundTest.earthquakeCancel.description}>
          <TestButton color="blue" onClick={() => { unlockAudio(); playAlertSound('earthquakeCancel') }}>{w.common.preview}</TestButton>
        </Row>
        {/* ── 津波情報 ── */}
        <Row label={w.soundTest.tsunamiForecast.label} description={w.soundTest.tsunamiForecast.description}>
          <TestButton color="blue" onClick={() => { unlockAudio(); playAlertSound('tsunamiForecast') }}>{w.common.preview}</TestButton>
        </Row>
        <Row label={w.soundTest.tsunamiWatch.label} description={w.soundTest.tsunamiWatch.description}>
          <TestButton color="blue" onClick={() => { unlockAudio(); playAlertSound('tsunamiWatch') }}>{w.common.preview}</TestButton>
        </Row>
        <Row label={w.soundTest.tsunami.label} description={w.soundTest.tsunami.description}>
          <TestButton color="purple" onClick={() => { unlockAudio(); playAlertSound('tsunami') }}>{w.common.preview}</TestButton>
        </Row>
        <Row label={w.soundTest.tsunamiMajor.label} description={w.soundTest.tsunamiMajor.description}>
          <TestButton color="red" onClick={() => { unlockAudio(); playAlertSound('tsunamiMajor') }}>{w.common.preview}</TestButton>
        </Row>
        <Row label={w.soundTest.tsunamiUpdate.label} description={w.soundTest.tsunamiUpdate.description}>
          <TestButton color="blue" onClick={() => { unlockAudio(); playAlertSound('tsunamiUpdate') }}>{w.common.preview}</TestButton>
        </Row>
        <Row label={w.soundTest.tsunamiCancel.label} description={w.soundTest.tsunamiCancel.description}>
          <TestButton color="blue" onClick={() => { unlockAudio(); playAlertSound('tsunamiCancel') }}>{w.common.preview}</TestButton>
        </Row>
        {/* ── 臨時情報・関連解説情報・後発地震 ── */}
        <Row label={w.soundTest.specialInfo.label} description={w.soundTest.specialInfo.description}>
          <TestButton color="orange" onClick={() => { unlockAudio(); playAlertSound('specialInfo') }}>{w.common.preview}</TestButton>
        </Row>
        <Row label={w.soundTest.specialInfoCommentary.label} description={w.soundTest.specialInfoCommentary.description}>
          <TestButton color="teal" onClick={() => { unlockAudio(); playAlertSound('specialInfoCommentary') }}>{w.common.preview}</TestButton>
        </Row>
        <Row label={w.soundTest.earthquakeCount.label} description={w.soundTest.earthquakeCount.description}>
          <TestButton color="teal" onClick={() => { unlockAudio(); playAlertSound('earthquakeCount') }}>{w.common.preview}</TestButton>
        </Row>
        <Row label={w.soundTest.specialInfoCancel.label} description={w.soundTest.specialInfoCancel.description}>
          <TestButton color="teal" onClick={() => { unlockAudio(); playAlertSound('specialInfoCancel') }}>{w.common.preview}</TestButton>
        </Row>
      </Section>

      <Section category="dev" title={w.sections.test}>
        <div className="px-4 py-2 bg-yellow-900/30 border-b border-yellow-700/40">
          <p className="text-yellow-400 text-xs">{w.test.note}</p>
          <p className="text-yellow-400/80 text-xs mt-1">
            {w.test.note2}
          </p>
        </div>
        {/* ── 緊急地震速報（EEW）: 軽 → 重、取消は末尾 ── */}
        <Row label={w.test.eewForecast.label} description={w.test.eewForecast.description}>
          <TestButton color="yellow" onClick={onTest.eewForecast}>{w.test.eewForecast.button}</TestButton>
        </Row>
        {hasForecastKey && onTest.eewStrongShaking && (
          <Row label={w.test.eewStrongShaking.label} description={w.test.eewStrongShaking.description}>
            <TestButton color="yellow" onClick={onTest.eewStrongShaking}>{w.test.eewStrongShaking.button}</TestButton>
          </Row>
        )}
        <Row label={w.test.eewAssumed.label} description={w.test.eewAssumed.description}>
          <TestButton color="yellow" onClick={onTest.eewAssumed}>{w.test.eewAssumed.button}</TestButton>
        </Row>
        <Row label={w.test.eewDeep.label} description={w.test.eewDeep.description}>
          <TestButton color="yellow" onClick={onTest.eewDeep}>{w.test.eewDeep.button}</TestButton>
        </Row>
        {/* 文面は 2026-10-15 ユーザー承認「足す(推奨)」 */}
        {hasForecastKey && (
          <Row label={w.test.eewNoForecast.label} description={w.test.eewNoForecast.description}>
            <TestButton color="yellow" onClick={onTest.eewNoForecast}>{w.test.eewNoForecast.button}</TestButton>
          </Row>
        )}
        {/* 文面は 2026-10-20 ユーザー承認「1 で、足してコミットして」 */}
        {hasForecastKey && (
          <Row label={w.test.eewForecastZero.label} description={w.test.eewForecastZero.description}>
            <TestButton color="yellow" onClick={onTest.eewForecastZero}>{w.test.eewForecastZero.button}</TestButton>
          </Row>
        )}
        <Row label={w.test.eewWarning.label} description={w.test.eewWarning.description}>
          <TestButton color="orange" onClick={onTest.eewWarning}>{w.test.eewWarning.button}</TestButton>
        </Row>
        <Row label={w.test.eew.label} description={w.test.eew.description}>
          <TestButton color="red" onClick={onTest.eew}>{w.test.eew.button}</TestButton>
        </Row>
        <Row label={w.test.eewRetraction.label} description={w.test.eewRetraction.description}>
          <TestButton color="purple" onClick={onTest.eewRetraction}>{w.test.eewRetraction.button}</TestButton>
        </Row>
        {/* 文面は 2026-10-22 ユーザー承認（「この形で進めてよいか、テストボタンの文面もこれでよいか」への「進めて」） */}
        <Row label={w.test.eewLateRetraction.label} description={w.test.eewLateRetraction.description}>
          <TestButton color="purple" onClick={onTest.eewLateRetraction}>{w.test.eewLateRetraction.button}</TestButton>
        </Row>
        {/* ── 地震情報 ── */}
        <Row label={w.test.earthquake.label} description={w.test.earthquake.description}>
          <TestButton color="red" onClick={onTest.earthquake}>{w.test.earthquake.button}</TestButton>
        </Row>
        {onTest.unreceivedQuake && (
          <Row label={w.test.unreceivedQuake.label} description={w.test.unreceivedQuake.description}>
            <TestButton color="orange" onClick={onTest.unreceivedQuake}>{w.test.unreceivedQuake.button}</TestButton>
          </Row>
        )}
        {onTest.maxScaleOrAboveQuake && (
          <Row label={w.test.maxScaleOrAboveQuake.label} description={w.test.maxScaleOrAboveQuake.description}>
            <TestButton color="orange" onClick={onTest.maxScaleOrAboveQuake}>{w.test.maxScaleOrAboveQuake.button}</TestButton>
          </Row>
        )}
        {onTest.areaUnreceivedQuake && (
          <Row label={w.test.areaUnreceivedQuake.label} description={w.test.areaUnreceivedQuake.description}>
            <TestButton color="orange" onClick={onTest.areaUnreceivedQuake}>{w.test.areaUnreceivedQuake.button}</TestButton>
          </Row>
        )}
        <Row label={w.test.foreignQuake.label} description={w.test.foreignQuake.description}>
          <TestButton color="purple" onClick={onTest.foreignQuake}>{w.test.foreignQuake.button}</TestButton>
        </Row>
        <Row label={w.test.foreignQuakeHuge.label} description={w.test.foreignQuakeHuge.description}>
          <TestButton color="purple" onClick={onTest.foreignQuakeHuge}>{w.test.foreignQuakeHuge.button}</TestButton>
        </Row>
        <Row label={w.test.foreignQuakeInternationalTsunami.label} description={w.test.foreignQuakeInternationalTsunami.description}>
          <TestButton color="purple" onClick={onTest.foreignQuakeInternationalTsunami}>{w.test.foreignQuakeInternationalTsunami.button}</TestButton>
        </Row>
        <Row label={w.test.internationalTsunamiDomesticAndOnly.label} description={w.test.internationalTsunamiDomesticAndOnly.description}>
          <TestButton color="purple" onClick={onTest.internationalTsunamiDomesticAndOnly}>{w.test.internationalTsunamiDomesticAndOnly.button}</TestButton>
        </Row>
        <Row label={w.test.headlineOnlyCity.label} description={w.test.headlineOnlyCity.description}>
          <TestButton color="purple" onClick={onTest.headlineOnlyCity}>{w.test.headlineOnlyCity.button}</TestButton>
        </Row>
        <Row label={w.test.noIntensityQuake.label} description={w.test.noIntensityQuake.description}>
          <TestButton color="purple" onClick={onTest.noIntensityQuake}>{w.test.noIntensityQuake.button}</TestButton>
        </Row>
        <Row label={w.test.quakeAmendment.label} description={w.test.quakeAmendment.description}>
          <TestButton color="yellow" onClick={onTest.quakeAmendment}>{w.test.quakeAmendment.button}</TestButton>
        </Row>
        <Row label={w.test.quakeReportSequence.label} description={w.test.quakeReportSequence.description}>
          <TestButton color="yellow" onClick={onTest.quakeReportSequence}>{w.test.quakeReportSequence.button}</TestButton>
        </Row>
        {onTest.quakeCancel && (
          <Row label={w.test.quakeCancel.label} description={w.test.quakeCancel.description}>
            <TestButton color="purple" onClick={onTest.quakeCancel}>{w.test.quakeCancel.button}</TestButton>
          </Row>
        )}
        {onTest.quakePartialCancel && (
          <Row label={w.test.quakePartialCancel.label} description={w.test.quakePartialCancel.description}>
            <TestButton color="purple" onClick={onTest.quakePartialCancel}>{w.test.quakePartialCancel.button}</TestButton>
          </Row>
        )}
        {onTest.borrowFromTsunami && (
          <Row label={w.test.borrowFromTsunami.label} description={w.test.borrowFromTsunami.description}>
            <TestButton color="yellow" onClick={onTest.borrowFromTsunami}>{w.test.borrowFromTsunami.button}</TestButton>
          </Row>
        )}
        {onTest.magnitudeFromTsunami && (
          <Row label={w.test.magnitudeFromTsunami.label} description={w.test.magnitudeFromTsunami.description}>
            <TestButton color="yellow" onClick={onTest.magnitudeFromTsunami}>{w.test.magnitudeFromTsunami.button}</TestButton>
          </Row>
        )}
        {onTest.trainingQuake && (
          <Row label={w.test.trainingQuake.label} description={w.test.trainingQuake.description}>
            <TestButton color="yellow" onClick={onTest.trainingQuake}>{w.test.trainingQuake.button}</TestButton>
          </Row>
        )}
        {/* ── 津波情報: 軽 → 重、取消は末尾 ── */}
        <Row label={w.test.tsunamiForecast.label} description={w.test.tsunamiForecast.description}>
          <TestButton color="blue" onClick={onTest.tsunamiForecast}>{w.test.tsunamiForecast.button}</TestButton>
        </Row>
        <Row label={w.test.tsunamiWatch.label} description={w.test.tsunamiWatch.description}>
          <TestButton color="blue" onClick={onTest.tsunamiWatch}>{w.test.tsunamiWatch.button}</TestButton>
        </Row>
        <Row label={w.test.tsunamiWarning.label} description={w.test.tsunamiWarning.description}>
          <TestButton color="orange" onClick={onTest.tsunamiWarning}>{w.test.tsunamiWarning.button}</TestButton>
        </Row>
        <Row label={w.test.tsunami.label} description={w.test.tsunami.description}>
          <TestButton color="purple" onClick={onTest.tsunami}>{w.test.tsunami.button}</TestButton>
        </Row>
        {onTest.tsunamiExpiry && (
          <Row label={w.test.tsunamiExpiry.label} description={w.test.tsunamiExpiry.description}>
            <TestButton color="blue" onClick={onTest.tsunamiExpiry}>{w.test.tsunamiExpiry.button}</TestButton>
          </Row>
        )}
        {onTest.tsunamiGradeChange && (
          <Row label={w.test.tsunamiGradeChange.label} description={w.test.tsunamiGradeChange.description}>
            <TestButton color="orange" onClick={onTest.tsunamiGradeChange}>{w.test.tsunamiGradeChange.button}</TestButton>
          </Row>
        )}
        {onTest.tsunamiSourceAdded && (
          <Row label={w.test.tsunamiSourceAdded.label} description={w.test.tsunamiSourceAdded.description}>
            <TestButton color="orange" onClick={onTest.tsunamiSourceAdded}>{w.test.tsunamiSourceAdded.button}</TestButton>
          </Row>
        )}
        {onTest.tsunamiQuietReports && (
          <Row label={w.test.tsunamiQuietReports.label} description={w.test.tsunamiQuietReports.description}>
            <TestButton color="blue" onClick={onTest.tsunamiQuietReports}>{w.test.tsunamiQuietReports.button}</TestButton>
          </Row>
        )}
        <Row label={w.test.tsunamiRetraction.label} description={w.test.tsunamiRetraction.description}>
          <TestButton color="red" onClick={onTest.tsunamiRetraction}>{w.test.tsunamiRetraction.button}</TestButton>
        </Row>
        {onTest.tsunamiInfoRetraction && (
          <Row label={w.test.tsunamiInfoRetraction.label} description={w.test.tsunamiInfoRetraction.description}>
            <TestButton color="red" onClick={onTest.tsunamiInfoRetraction}>{w.test.tsunamiInfoRetraction.button}</TestButton>
          </Row>
        )}
        {/* ── 臨時情報・関連解説情報・後発地震 ── */}
        {onTest.nankaiChecking && (
          <Row label={w.test.nankaiChecking.label} description={w.test.nankaiChecking.description}>
            <TestButton color="yellow" onClick={onTest.nankaiChecking}>{w.test.nankaiChecking.button}</TestButton>
          </Row>
        )}
        {onTest.nankaiWatch && (
          <Row label={w.test.nankaiWatch.label} description={w.test.nankaiWatch.description}>
            <TestButton color="orange" onClick={onTest.nankaiWatch}>{w.test.nankaiWatch.button}</TestButton>
          </Row>
        )}
        {onTest.nankaiWarning && (
          <Row label={w.test.nankaiWarning.label} description={w.test.nankaiWarning.description}>
            <TestButton color="red" onClick={onTest.nankaiWarning}>{w.test.nankaiWarning.button}</TestButton>
          </Row>
        )}
        {onTest.nankaiRetraction && (
          <Row label={w.test.nankaiRetraction.label} description={w.test.nankaiRetraction.description}>
            <TestButton color="blue" onClick={onTest.nankaiRetraction}>{w.test.nankaiRetraction.button}</TestButton>
          </Row>
        )}
        {onTest.nankaiCommentaryAdHoc && (
          <Row label={w.test.nankaiCommentaryAdHoc.label} description={w.test.nankaiCommentaryAdHoc.description}>
            <TestButton color="teal" onClick={onTest.nankaiCommentaryAdHoc}>{w.test.nankaiCommentaryAdHoc.button}</TestButton>
          </Row>
        )}
        {onTest.nankaiCommentaryRetraction && (
          <Row label={w.test.nankaiCommentaryRetraction.label} description={w.test.nankaiCommentaryRetraction.description}>
            <TestButton color="teal" onClick={onTest.nankaiCommentaryRetraction}>{w.test.nankaiCommentaryRetraction.button}</TestButton>
          </Row>
        )}
        {onTest.nankaiCommentaryRoutine && (
          <Row label={w.test.nankaiCommentaryRoutine.label} description={w.test.nankaiCommentaryRoutine.description}>
            <TestButton color="teal" onClick={onTest.nankaiCommentaryRoutine}>{w.test.nankaiCommentaryRoutine.button}</TestButton>
          </Row>
        )}
        {onTest.activityInfo && (
          <Row label={w.test.activityInfo.label} description={w.test.activityInfo.description}>
            <TestButton color="teal" onClick={onTest.activityInfo}>{w.test.activityInfo.button}</TestButton>
          </Row>
        )}
        {onTest.kohatsu && (
          <Row label={w.test.kohatsu.label} description={w.test.kohatsu.description}>
            <TestButton color="blue" onClick={onTest.kohatsu}>{w.test.kohatsu.button}</TestButton>
          </Row>
        )}
        {onTest.kohatsuRetraction && (
          <Row label={w.test.kohatsuRetraction.label} description={w.test.kohatsuRetraction.description}>
            <TestButton color="blue" onClick={onTest.kohatsuRetraction}>{w.test.kohatsuRetraction.button}</TestButton>
          </Row>
        )}
        {/* ── その他の地震情報 ── */}
        {onTest.estimatedIntensity && (
          <Row label={w.test.estimatedIntensity.label} description={w.test.estimatedIntensity.description}>
            <TestButton color="teal" onClick={onTest.estimatedIntensity}>{w.test.estimatedIntensity.button}</TestButton>
          </Row>
        )}
        {onTest.lpgmRetraction && (
          <Row label={w.test.lpgmRetraction.label} description={w.test.lpgmRetraction.description}>
            <TestButton color="teal" onClick={onTest.lpgmRetraction}>{w.test.lpgmRetraction.button}</TestButton>
          </Row>
        )}
        {/* ボタン名と説明は 2026-10-24 ユーザー選択「ボタンを足す (Recommended)」で決めた文面 */}
        {onTest.lpgmClassZero && (
          <Row label={w.test.lpgmClassZero.label} description={w.test.lpgmClassZero.description}>
            <TestButton color="teal" onClick={onTest.lpgmClassZero}>{w.test.lpgmClassZero.button}</TestButton>
          </Row>
        )}
        {/* 文面は 2026-10-24 ユーザー選択「この文面でよい (Recommended)」 */}
        {onTest.lpgmCategories && (
          <Row label={w.test.lpgmCategories.label} description={w.test.lpgmCategories.description}>
            <TestButton color="teal" onClick={onTest.lpgmCategories}>{w.test.lpgmCategories.button}</TestButton>
          </Row>
        )}
        {/* ボタン名と説明は 2026-10-29 ユーザー承認「新しいボタンを足す (Recommended)」「続報も流す (Recommended)」で決めた文面 */}
        {onTest.lpgmClassZeroRegion && (
          <Row label={w.test.lpgmClassZeroRegion.label} description={w.test.lpgmClassZeroRegion.description}>
            <TestButton color="teal" onClick={onTest.lpgmClassZeroRegion}>{w.test.lpgmClassZeroRegion.button}</TestButton>
          </Row>
        )}
        {onTest.earthquakeCount && (
          <Row label={w.test.earthquakeCount.label} description={w.test.earthquakeCount.description}>
            <TestButton color="teal" onClick={onTest.earthquakeCount}>{w.test.earthquakeCount.button}</TestButton>
          </Row>
        )}
        {onTest.earthquakeCountRetraction && (
          <Row label={w.test.earthquakeCountRetraction.label} description={w.test.earthquakeCountRetraction.description}>
            <TestButton color="teal" onClick={onTest.earthquakeCountRetraction}>{w.test.earthquakeCountRetraction.button}</TestButton>
          </Row>
        )}
        {onTest.quakeNotice && (
          <Row label={w.test.quakeNotice.label} description={w.test.quakeNotice.description}>
            <TestButton color="blue" onClick={onTest.quakeNotice}>{w.test.quakeNotice.button}</TestButton>
          </Row>
        )}
      </Section>

      <Section category="dev" title={w.sections.replay}>
        <div className="px-4 py-2 bg-blue-900/30 border-b border-blue-700/40">
          <p className="text-blue-300 text-xs">
            {w.replay.note}
          </p>
        </div>
        {/* 公開版の履歴アーカイブにリアルタイム震度が入らないこと（NIED の再配布禁止）と、案内をここだけに
            出し、再生中のリアルタイムタブには出さないことは承認済み（2026-10-22 ユーザー選択
            「今のまま記録する」）。 */}
        {historicalArchives != null && historicalArchives.length > 0 && (
          <Row
            label={w.replay.archives.label}
            description={w.replay.archives.description}
          >
            <div className="flex flex-col gap-1.5 items-end">
              {historicalArchives.map(a => (
                <div key={a.id} className="flex items-center gap-2">
                  <DescriptionTip
                    label={historicalArchiveLabel(a, w.replay.archives)}
                    description={formatArchiveCoverage(a, fw)}
                  />
                  <button
                    onClick={() => onStartReplay(new Date(new Date(a.firstEventTime).getTime() - 60_000))}
                    disabled={replayIsFetching || historicalArchivesLoading}
                    className={ACTION_BUTTON_CLASS}
                  >
                    {w.replay.play}
                  </button>
                </div>
              ))}
            </div>
          </Row>
        )}
        <Row label={w.replay.start.label} description={w.replay.start.description}>
          <div className="flex gap-2 items-center flex-wrap justify-end">
            <input
              type="datetime-local"
              value={kyoshinInputDateTime}
              onChange={e => onSetKyoshinInputDateTime(e.target.value)}
              className="bg-panel border border-border text-white text-xs rounded-sm px-2 py-1.5 focus:outline-hidden focus:border-blue-500"
            />
            <button
              onClick={handleTimeConfirm}
              disabled={!kyoshinInputDateTime || replayIsFetching || historicalArchivesLoading}
              className={ACTION_BUTTON_CLASS}
            >
              {replayIsFetching ? w.common.fetching : historicalArchivesLoading ? w.replay.preparing : w.replay.confirm}
            </button>
          </div>
        </Row>
        {replayError && (
          // 再生が始まっていれば「再生中に起きたこと」（部分的な取りこぼし、先読みの失敗）、
          // 始まっていなければ取得そのものの失敗。同じ赤字でも、再生中に「取得失敗」と
          // 大書きすると本文の「継続中」と矛盾して見える。深刻度の差は本文で伝える。
          <Row label={replayStartLabel != null ? w.replay.warning : w.replay.failed}>
            <span className="text-xs text-red-400 break-all">{replayError}</span>
          </Row>
        )}
        {replayStartLabel != null && (
          <Row label={w.replay.playing.label}>
            <div className="flex gap-2 items-center">
              <span className="text-xs text-green-400">{w.replay.since(replayStartLabel)}</span>
              <button
                onClick={onStopReplay}
                className={ACTION_BUTTON_CLASS}
              >
                {w.replay.reset}
              </button>
            </div>
          </Row>
        )}
      </Section>

      <Section category="dev" title={w.sections.knet}>
        <Row
          label={w.knet.row.label}
          description={w.knet.row.description}
          hint={w.knet.row.hint}
        >
          <KyoshinImportRow historicalArchives={historicalArchives ?? EMPTY_HISTORICAL_ARCHIVES} />
        </Row>
      </Section>

      <Section category="dev" title={w.sections.diag}>
        <Row
          label={w.diag.row.label}
          description={w.diag.row.description}
        >
          <DiagnosticLogRow />
        </Row>
      </Section>

    </div>
  )
})
