import { useState, useEffect, useRef, useCallback } from 'react'
import { useLazyRef } from './useLazyRef'
import type { JMAQuake, JMATsunami, JMALpgm, JMANankai, JMANankaiCommentary, JMAKohatsu, JMAQuakeNotice, JMAEarthquakeCount, JMAEstimatedIntensity, EEWAlert, IntensityScale, EarthquakePoint, AppEvent, LiveEvent, LiveEventMeta, ConnectionStatus, TelegramLogEntry } from '../types/earthquake'
import { fetchHistory, fetchHistorySince, fetchJmaQuakePage, P2PQuakeWebSocket, P2P_LOAD_MORE_BATCH } from '../services/p2pquake'
import { historyCursorFromOldestDay, type HistoryCursor } from '../utils/historyCursor'
import type { QuakeHistoryResult, ReplayQuakeHistoryResult } from '../types/replay'
// 種別ごとの取得関数（`fetchDmdataEarthquakes` ほか 8 本）は撤去済み。履歴はアーカイブ経由の
// 1 本へ寄せてある（→ `data-sources-spec.md` §2「大量に取るならアーカイブを使う」）。
// **発表中の緊急地震速報だけは別**で、`/v2/telegram` にも当日のアーカイブにも無いため
// `/v2/gd/eew` を辿る専用の経路が要る。
import { DmdataWebSocket, fetchDmdataActiveEews, fetchDmdataActiveEewsOutcome } from '../services/dmdata'
// 履歴の取得はリプレイ開始時の復元と実装を共有する（→ `data-sources-spec.md` §2
// 「大量に取るならアーカイブを使う」）。同じ目的の実装を 2 本持たない。
import { fetchDmdataQuakeHistoryFor, HISTORY_WINDOW_DAYS } from '../services/dmdataReplay'
import { fetchLiveTelegramsBetween } from '../services/dmdataReplayLive'
import { PREFERRED_CLASSIFICATIONS, type DmdataClassification } from '../services/dmdataClassifications'
import {
  forgetClassifications, loadRememberedClassifications, rememberClassifications, sameClassifications,
} from '../services/dmdataClassificationMemory'
import { beginLoadMoreGateTag } from '../services/dmdataRequestGates'
import {
  type TelegramLoss, createEmptyTelegramLoss, telegramLossFrom, isTelegramLossEmpty,
  mergeHistoryLoss,
} from '../utils/telegramLoss'
import { appendToTelegramLog, dropTelegramLogOrigins, pruneTelegramLog } from '../utils/telegramLogBuffer'
import { mergeQuakeInto, mergeQuakeHistory, sameQuakeEntry, sortQuakes, quakeEventKey, coalesceByEventId, findExistingQuakeCard, isRetractedQuakeReport, findRetractionTie, logRetractionTie, quakeRetractionOf, addQuakeRetraction, quakeHoldBack, isQuakeCancelTarget, applyQuakeCancelToCard, compareReportAge, reportOrderKey, type ReportAge } from '../utils/quakeMerge'
import { advanceQuakeMarks, markIssuedAt, pruneQuakeMarks, rememberQuakeCard, trimQuakeMarkMemory, quakeFactSnapshot, quakeRowSnapshot, lpgmRowSnapshot, lpgmMarkKey, lpgmTelegramRevise, quakeTelegramRevise, type QuakeCardMarks, type QuakeMarkMemory } from '../utils/quakeUpdateMark'
import { UPDATE_MARK_TTL_MS } from '../utils/updateMark'
import type { QuakeRetraction } from '../utils/quakeMerge'
import { addLpgmRetraction, applyLiveLpgm, foldLpgmHistory, isRetractedLpgm, lpgmRetractionOf, MAX_LPGM_RETRACTIONS, recordLpgmRetractions, type LpgmRetraction } from '../utils/lpgmRetraction'
import { withBorrowedFromTsunami, borrowFromTsunamiIntoCards } from '../utils/borrowFromTsunami'
import { selectQuakeHistory } from '../utils/quakeHistorySelection'
import { loadStationCoords, onStationCoordsLoaded, areaPrefIndexOf, getAreaPrefIndexCache } from '../utils/stationCoords'
import type { AreaPrefIndex } from '../utils/quakePoints'
import {
  calcEEWCancelTime, eewSerial, eewEventKey, eewIssueTimeMs, mergeEewReport, eewStaleness, acceptEewReport,
  supplementEewReport, raisesEewAlert,
  noteEewNotified, isSameReportFromOtherOrigin, isOlderEewReport, type EewAcceptance,
  endedEewMatch, ACTIVE_EEW_WINDOW_MS, type EndedEew, admitTrainingEew, isLateEewCancel, rememberEewFirstIssueTime,
} from '../utils/eew'
import { recordReplayEvent, type ReplayTelegramSkip } from '../utils/replayEventLog'
import { replayTelegramFacts, type ReplayTelegramSource } from '../utils/replayTelegramRef'
import { upsertEstimatedIntensity, isNewEstimatedIntensity, rememberShownEstimatedIntensity } from '../utils/estimatedIntensity'
import { withInheritedTsunamiFacts, isSameTsunamiEvent, stepTsunamiState, tsunamiLiftText } from '../utils/tsunami'
import { log } from '../utils/logger'
import { serverNow, serverDate, isServerClockTrusted } from '../utils/clock'
import { isAbortedByCaller } from '../utils/fetchWithTimeout'

import { isDmdss } from '../utils/env'
import { isValidDmdataApiKey, DMDATA_API_KEY_INVALID_MESSAGE } from '../utils/dmdataApiKey'
// テストデータは押されてから読む（静的に取り込まない理由・失敗したときの扱い・先読みの
// 段取りは `utils/testDataLoader.ts` にまとめてある）。
import { loadTestTelegramScripts } from '../utils/testDataLoader'
import { buildTestTelegramEntries, type TestTelegramScript } from '../utils/testTelegrams'

/**
 * 画面・音へ回らずに落とした電文を、録画ツール向けに記録する
 * （→ `docs/spec/recording-interface-spec.md`）。
 *
 * **`onLiveEvent` まで届く電文は `useLiveEventHandler` が記録する。** ここで残すのは、
 * その手前で落としている分すべて —— 緊急地震速報の古い報・試験報・音も読み上げも起こさないと
 * 決めた種別（地震・津波に関するお知らせ）に加え、リプレイ初期状態のサイレント注入
 * （`silentReplayInit`）・反映されなかった電文（`notApplied`）も含む。**落としたことが
 * 残らないと、編集する側からは「配信が無かった」のと区別が付かない。**
 *
 * **投げないこと**（記録層の境界の不変条件）。呼び出し元はどれも受信処理の途中にいて、
 * 例外を受け止めない —— 抜けるとその電文の処理が丸ごと止まり、同じティックで捌く予定
 * だった後続の電文まで巻き添えになる。
 */
function recordSkippedTelegram(source: ReplayTelegramSource, skipped: ReplayTelegramSkip): void {
  try {
    recordReplayEvent({ type: 'telegram', ...replayTelegramFacts(source), skipped })
  } catch (err) {
    log.warn('[replay] 落とした電文を記録できなかった（本体は続行）', err)
  }
}

/**
 * 履歴の補助情報（nankai 等）を反映しつつ、例外を握り潰して呼び出し元へ伝える。
 *
 * **起動時の履歴復元で `applyXxx` の呼び出しを 1 箇所に集約する。** かつては 4 箇所
 * （nankai/nankaiCommentary/kohatsu/earthquakeCount）にほぼ同じ
 * `let applied = false; try { applied = applyXxx(...) } catch { ... }` を書き並べており、
 * 2 巡目の敵対的レビューでこの重複自体が「`recordSkippedTelegram` を誤って `try` の
 * 内側へ書き戻してしまう」ヒューマンエラーを実際に誘発した（レビュー中に一時的にその
 * 状態が発生したことを検出）。**`recordSkippedTelegram` の呼び出しはここに含めない**
 * ——呼び出し側で `kind` ごとにリテラル型を持たせたまま呼ぶことで、`ReplayTelegramSource`
 * の型安全性を保つ（`{ kind, data }` をジェネリックに組み立てると型検査をすり抜ける）。
 *
 * @returns 反映できたか。例外時は `false`（反映できたかどうかは確かめようがないため）
 */
function tryApplyExtra<T>(label: string, data: T, applyFn: (data: T) => boolean): boolean {
  try {
    return applyFn(data)
  } catch (err) {
    log.error(`[data] 履歴の${label}を反映できませんでした（この件だけ飛ばして続行）`, err)
    return false
  }
}

/**
 * lpgm が `onLiveEvent`（音・読み上げ・タブ移動）の対象になるか。
 *
 * - **発表**は階級 1 以上だけ（階級 0 は音読み上げの対象外と決めている）
 * - **取消**は常に（画面に出していない地震への取消でも伝える。2026-10-22 ユーザー選択「地震情報に揃えて伝える
 *   (Recommended)」で 2026-10-15 の「表示中を消した時だけ（推奨）」を覆した）。同じ取消の 2 通目は
 *   呼び出し側（`shouldDispatch`）が止める
 *
 * **他の 5 種別（nankai 等）と違い、これは「反映されたか」と一致しない。** あちらは
 * `applyXxx` が期限切れ等で棄却すると `lpgmByEventId` 相当の state 自体を書き換えないが、
 * lpgm は取消なら削除・それ以外なら必ず追加する形で **`lpgmByEventId` を常に書き換える**
 * （呼び出し側の `setState` を参照）。ここが偽でも画面（長周期一覧・バッジ）は更新されうる
 * ので、記録の理由はどちらも `notApplied`（＝反映されなかった）ではなく
 * `notDispatched`（＝音読み上げの対象外と決めている）にする（3 巡目レビューで指摘）。
 */
function lpgmNotifiable(lpgm: JMALpgm): boolean {
  return lpgm.cancelled || lpgm.maxClass >= 1
}

// 初回に一覧へ並べる**地震の件数**（設定の最大選択値に合わせる。standard 版の経路だけが使う ——
// DMDSS 版は日数で区切る）。リプレイ開始時の履歴復元（App の `fetchReplayQuakeHistory`）も
// この値をそのまま使うため export している。片方だけ動かすと、ライブと再生でカードの厚みが
// 黙って食い違う。
//
// **数えるのは地震で、電文ではない**（2026-10-14 ユーザー選択「ライブも地震 50 件に揃える」）。
// 電文で数えると、地震の多い期間ほど 1 地震あたりの報が枠を食い、同じ設定でも一覧の枚数が
// 期間ごとに変わる（実測で standard 版だけ 84 枚になったり、電文 50 通で切って 52 地震のうち
// 18 枚しか残らなかったりした）。選び方は `selectQuakeHistory`（リプレイの履歴と共有）。
export const MAX_HISTORY_RETAINED = 50

// ライブの初回履歴で 1 回に引く電文数（`/jma` の上限）。**リクエストは 1 回のまま。**
// 地震 50 件を選ぶ母数で、ここから `selectQuakeHistory` が地震の単位で絞る。
const INITIAL_HISTORY_PAGE_SIZE = 100
// 電文ログの保持は経路ごとに分ける（ライブは 24 時間・テストと再生は件数。→ `utils/telegramLogBuffer.ts`）
/** 何も届かない間に 24 時間より古いライブの行を捨てる間隔（ミリ秒）。 */
const TELEGRAM_LOG_PRUNE_INTERVAL_MS = 10 * 60 * 1000

const MAX_QUAKE_RETRACTIONS = 20  // 取消を見た事実の台帳の最大保持件数（`rememberQuakeRetraction`）

/**
 * 取消電文が効くカード（取消表示中でないもの）か。
 *
 * 照合の中身は `quakeMerge.ts` の `isQuakeCancelTarget`（情報名称の単位で、カードが取消より前に
 * その種別の報を受けていたか）。ライブは**取消表示中のカードを対象から外す**ところだけを足す
 * （二重に取消表示を張って 10 秒の purge を延ばさないため）。
 *
 * 台帳への記録（入口）と実際の取消の適用（`setState` の中）で**同じ述語を使う**ために切り出して
 * いる。書き写すと片方だけが変わり、記録と適用の範囲が静かにずれる。
 */
function isLiveQuakeCancelTarget(card: JMAQuake, cancel: JMAQuake, areaPrefIndex: AreaPrefIndex): boolean {
  return !card.cancelledAt && isQuakeCancelTarget(card, cancel, areaPrefIndex)
}

/** 取消電文が効くカードを探す。判定は `isLiveQuakeCancelTarget`。 */
function findQuakeCancelTarget(
  cards: readonly JMAQuake[],
  cancel: JMAQuake,
  areaPrefIndex: AreaPrefIndex,
): JMAQuake | undefined {
  return cards.find(card => isLiveQuakeCancelTarget(card, cancel, areaPrefIndex))
}
type QueuePayload =
  | { kind: 'event'; event: AppEvent }
  | { kind: 'lpgm'; data: JMALpgm }
  | { kind: 'nankai'; data: JMANankai }
  | { kind: 'nankaiCommentary'; data: JMANankaiCommentary }
  | { kind: 'kohatsu'; data: JMAKohatsu }
  | { kind: 'quakeNotice'; data: JMAQuakeNotice }
  | { kind: 'earthquakeCount'; data: JMAEarthquakeCount }
  | { kind: 'estimatedIntensity'; data: JMAEstimatedIntensity }
  | { kind: 'purge-cancelled-quake'; id: string }
  | { kind: 'purge-cancelled-eew'; key: string }
  /**
   * 最終報を名乗らない経路（P2PQuake）の見張りの解除。`receipts` は予約した時点で台帳が受けていた
   * 報の数（`EewAcceptance.receipts`）。発火した時点でそれより多く受けていれば、最新の報から張り直す。
   */
  | { kind: 'eew-watch-expiry'; key: string; receipts: number }
  | { kind: 'purge-cancelled-tsunami'; id: string }

interface QueueEntry {
  eventTime: Date
  payload: QueuePayload
  silent?: boolean
  /**
   * 電文ログへ積む行。電文から組んだものでなければ `null`。
   *
   * **積むのは発火のとき**（ディスパッチャが取り出した時点）。リプレイは窓ぶんを先に
   * 組んでキューへ入れるので、入れた時点で積むと**まだ画面に出ていない電文がログに並ぶ**。
   * ライブの行は受信＝画面反映なので、揃えるならこちら。
   *
   * **任意（`?`）にしない**（理由は `ReplayEntry.logEntry` と同じ）。キューへ積む経路は
   * 20 箇所を超えるので、渡し忘れても型が通る形にすると、その経路の電文だけ黙ってログから
   * 落ちる。
   */
  logEntry: TelegramLogEntry | null
}

/**
 * 発火時刻の昇順に並んだイベントキュー。
 *
 * **配列を外へ出さない**のが唯一の設計目的。かつては素の `QueueEntry[]` を ref に持たせていて、
 * 中身を書き換える側（挿入・取り出し）と作り直す側（`filter` での絞り込み）が同居していた。
 * ディスパッチャは 1 回のティックで複数のエントリを続けて処理するため、その途中で配列が
 * 差し替わると、それ以降に取り出したエントリが差し替え前の配列からしか消えず、新しい配列に
 * 残ったままになる。次のティックがそれを先頭から読み、同じ電文を再処理した（実測で 1 通の地震情報が
 * 数千回取り出され、受信音が鳴り続けた。再現の条件は `useEarthquakes.wiring.test.ts` 側に書いてある）。
 *
 * 画面には「カードが更新され続ける」ようにしか映らず、型検査でも例外でも捕まらない。**同じ誤りを
 * 書けなくするために、配列そのものは閉じ込めてある。**
 *
 * **持ち主の ref ごと差し替えるのも同じこと**（`eventQueueRef.current = createEventQueue()`）。
 * 差し替え前のキューに残っていた予約は、誰にも取り出されないまま消える。捨てたいときは
 * `clear()` を呼ぶこと。
 */
interface EventQueue {
  /**
   * 発火時刻の昇順を保って 1 件積む。
   *
   * **日時として読めない発火時刻のエントリは積まず、記録に残す。** 取り出し側（`shiftReady`）では
   * 弾けない。NaN は `<=` と `>` のどちらとも偽になるため、判定の書き方で転ぶ先が変わる（実測）:
   *
   *   - `eventTime > now` なら止める形 … 止まらず**即座に発火する**（現在の `shiftReady`）
   *   - `!(eventTime <= now)` なら止める形 … **止まる**。以後すべての電文が発火しない
   *
   * どちらも望ましくないので、**入口で落とすのが唯一の確実な手**。積む経路はこの `push` だけ
   * （配列は閉じ込めてある）なので、ここを通せば以降は有限値しか並ばない。ここで弾くのは
   * 呼び出し規約の違反なので、既定で消える詳細ログではなく `error` で残す。
   */
  push(entry: QueueEntry): void
  /**
   * `keep` が false を返した要素を取り除く。
   *
   * **`keep` は例外を投げてはならない。** 途中で抜けると「前半だけ詰め直され、後半は未走査」の
   * まま長さも切り詰められない。読み元は壊さないので要素が消えることはないが、**残すと決めた
   * エントリが重複したまま残る**。述語はフィールドの参照だけに留めること。
   */
  retain(keep: (entry: QueueEntry) => boolean): void
  /**
   * 発火時刻が `now` 以前の先頭を 1 件取り出す。無ければ `undefined`。
   *
   * **先頭で止まる**（時刻の来ていない先頭より後ろは見ない）。並びが崩れると後ろが取り残される
   * ため、順序は `push` だけが決める。
   *
   * 発火時刻が有限であることは `push` が保証している。**この判定の向きを変えるなら、
   * 読めない時刻が来たときにどちらへ転ぶかを `push` の注記で確かめてから変えること。**
   */
  shiftReady(now: Date): QueueEntry | undefined
  /**
   * 発火時刻が `now` より後、`now + horizonMs` までのエントリを**読むだけ**で列挙する。
   *
   * リプレイは窓ぶんの電文を先に持っているので、ここを覗けば「次に何が来るか」が分かる。
   * 読み上げの投機的な先行合成（`utils/speechPrefetch.ts`）がそれを使う。
   *
   * **`retain` を流用しないこと。** あちらの述語は「フィールドの参照だけに留める」規約で、
   * 例外を投げると詰め直しが途中で止まる。覗くだけの用途に副作用を持ちうる口を使うと、
   * その規約が破られたときに**キューが壊れる**（症状は同じ電文の再処理）。
   *
   * **返すのは配列の浅いコピー。** 配列そのものを外へ出さない設計は保つが、要素
   * （`QueueEntry`）は共有されるので、**受け取った側は中身を書き換えてはならない**。
   * 投機は payload を読むだけ。
   *
   * 発火時刻が既に来ているもの（`eventTime <= now`）は含めない —— 次のティックで取り出される
   * ので、いまから合成を始めても間に合わない。
   */
  peekUpcoming(now: Date, horizonMs: number): readonly QueueEntry[]
  /** すべて捨てる。 */
  clear(): void
}

function createEventQueue(): EventQueue {
  const entries: QueueEntry[] = []
  return {
    push(entry) {
      if (!Number.isFinite(entry.eventTime.getTime())) {
        // 何を捨てたかまで残す。`payload.kind` は大半の経路で 'event' 固定になり、
        // `String(new Date(NaN))` も常に 'Invalid Date' なので、それだけでは同じ読み込みで
        // 複数捨てたときに区別が付かない。
        const detail = entry.payload.kind === 'event'
          ? entry.payload.event.kind + ' id=' + String((entry.payload.event as { id?: unknown }).id ?? '(なし)')
          : entry.payload.kind
        log.error('[queue] 発火時刻が日時として読めないエントリを捨てた ' + detail
          + ' eventTime=' + String(entry.eventTime))
        return
      }
      let i = entries.length
      while (i > 0 && entries[i - 1].eventTime > entry.eventTime) i--
      entries.splice(i, 0, entry)
    },
    retain(keep) {
      // 配列を作り直さず、書き込みカーソルで前へ詰める（`write <= read` が常に成り立つので
      // 読む前に上書きすることはない）。
      let write = 0
      for (let read = 0; read < entries.length; read++) {
        if (keep(entries[read])) entries[write++] = entries[read]
      }
      entries.length = write
    },
    shiftReady(now) {
      if (entries.length === 0 || entries[0].eventTime > now) return undefined
      return entries.shift()
    },
    peekUpcoming(now, horizonMs) {
      const from = now.getTime()
      const until = from + horizonMs
      // 呼び出し側が壊れた値を渡しても走査を暴走させない（`NaN` はどの比較とも偽になるため、
      // 判定の書き方次第で「全部返す」にも「何も返さない」にも転ぶ。返さない側へ倒す）。
      if (!Number.isFinite(from) || !Number.isFinite(until)) return []
      const out: QueueEntry[] = []
      for (const entry of entries) {
        const t = entry.eventTime.getTime()
        if (t <= from) continue
        // 並びは昇順（`push` が保つ）なので、範囲を出たらそれ以降も全部範囲外
        if (t > until) break
        out.push(entry)
      }
      return out
    },
    clear() { entries.length = 0 },
  }
}

// DMDSS版 EEW の地域別予想震度には pref が含まれないため、細分区域名→都道府県の
// 逆引きインデックスで補完する（EEWカードの対象地域表示用。地図の色塗りは name のみで動く）。
function enrichEEWPref(eew: EEWAlert, index: ReadonlyMap<string, string> | null): EEWAlert {
  if (!index || !eew.areas || eew.areas.length === 0) return eew
  const areas = eew.areas.map(a =>
    a.pref ? a : { ...a, pref: index.get(a.name) ?? '' },
  )
  return { ...eew, areas }
}

type TestEEWKind = 'special' | 'warning' | 'forecast' | 'assumed' | 'deep' | 'strongShaking'
  | 'noForecast' | 'forecastZero' | 'retraction' | 'lateRetraction'

/**
 * 押すたびに進む台本の進み具合（→ `pressTestTelegramScript`）。
 *
 * **読み書きするのは待ち行列の中だけ**（種別ごとに 1 本ずつ処理する）。並べずに触ると、
 * 電文を組む `await` の間に次の押下が同じ値を読み、同じ段が 2 回流れる。
 */
type TestEEWPressEntry = { index: number; now: Date; finalizeTimer: number }
/**
 * 届いた報が、画面から消えた地震の報なら `true` を返し、弾いたことを記録に残す（→ `endedEewMatch`）。
 * 発表中の速報の取り直し（起動時・張り直し）と、ライブの入口（`handleEvent`）の両方が通る。
 * **黙って弾かない** —— 誤って本物を弾いたとき、画面には「出ない」としか現れない。
 */
function skipEndedEew(ended: ReadonlyMap<string, EndedEew>, eew: EEWAlert, path: string): boolean {
  const key = eewEventKey(eew)
  const record = ended.get(key)
  const nowMs = serverNow()
  const match = endedEewMatch(record, eew, nowMs, ACTIVE_EEW_WINDOW_MS)
  if (match === null || !record) return false
  const basis = match === 'cancelled'
    ? '取消で終えた'
    : match === 'serial'
      ? `消えるまでに第 ${record.serialByOrigin.get(eew.origin)} 報まで受けていた`
      : '消えるまでに受けた報より発表時刻が新しくない'
  log.info(`[eew] ${path}: ${key}（${eew.origin} 第 ${eewSerial(eew) ?? '?'} 報）は ${Math.round((nowMs - record.endedAtMs) / 1000)} 秒前に画面から消えた地震の報なので採りません（${basis}）`)
  return true
}

/**
 * 届いた報が、**その報自身の自動解除の時刻（`calcEEWCancelTime`）を既に過ぎている**なら `true` を返し、弾いたことを記録に残す。
 * ライブの入口（`handleEvent`）で、画面に出ていない地震の報にだけ使う。
 *
 * 標準版の Yahoo は、終わった速報の最終報を一覧に 150〜180 秒残す（2026-10-21 に 2 地震で実測）。一覧を前回との差分で見る処理（`diffHypoInfoEvents`）は作り直されると
 * 前に見た項目を忘れるので（起動・リプレイの開始と終わり）、その間に作り直すと最終報を「新しい項目」として出し直す。
 * 自動解除は最終報から 60 秒以上先なので、出直した報は音と読み上げを鳴らしてから、すぐ消える。消えた地震の記憶
 * （`skipEndedEew`）はリセットで捨てるので、ここでは報の時刻だけで判定する。
 *
 * **時計を信じられないときは弾かない**（`isServerClockTrusted`）。未較正の端末は壁時計がずれていることがあり、
 * 進んだ時計で比べると本物の報まで捨てる。弾かなかったことは debug に残す。
 * **発表時刻が読めない報も弾かない。** `calcEEWCancelTime` は発表時刻が読めないと震源時刻だけで解除の時刻を決め、
 * 「発表から 60 秒は残す」下限が外れる —— その値で比べると、届いたばかりの初報を古い報と取り違えうる。
 * 2026-10-21 ユーザー承認「おすすめで」
 */
function skipExpiredEew(eew: EEWAlert, path: string): boolean {
  const issueMs = eewIssueTimeMs(eew)
  if (issueMs === null) return false
  const cancelMs = calcEEWCancelTime(eew, new Date(issueMs)).getTime()
  if (!Number.isFinite(cancelMs)) return false
  const nowMs = serverNow()
  if (cancelMs > nowMs) return false
  const detail = `${eewEventKey(eew)}（${eew.origin} 第 ${eewSerial(eew) ?? '?'} 報`
    + ` 発表=${new Date(issueMs).toISOString()} 自動解除=${new Date(cancelMs).toISOString()} いま=${new Date(nowMs).toISOString()}`
    + ` M=${eew.earthquake.hypocenter.magnitude} 深さ=${eew.earthquake.hypocenter.depth}）`
  if (!isServerClockTrusted()) {
    log.debug(`[eew] ${path}: ${detail}は自動解除の時刻を過ぎて見えますが、時計が未較正なので採ります`)
    return false
  }
  log.info(`[eew] ${path}: ${detail}は自動解除の時刻を ${Math.round((nowMs - cancelMs) / 1000)} 秒過ぎた報なので採りません`)
  return true
}

/**
 * 画面から消えた地震の記憶を作る。**前に消えたときの記憶があれば、経路ごとの報番号と発表時刻は大きいほうを残す** ——
 * 台帳は消えた時点で捨てるので、載り直した地震の台帳は載り直した後の報しか数えていない。上書きすると記憶が縮み、
 * 前に消えたときの報を取り直しが返したとき通してしまう。取消で終えた印も、一度立てば落とさない（取消は終端）。
 */
function mergeEndedEew(
  previous: EndedEew | undefined, acceptance: EewAcceptance, cancelled: boolean, nowMs: number,
  lastReport: EEWAlert, firstIssueTime: string | null | undefined,
): EndedEew {
  const serialByOrigin = new Map(previous?.serialByOrigin)
  for (const [origin, serial] of acceptance.serialByOrigin) {
    serialByOrigin.set(origin, Math.max(serial, serialByOrigin.get(origin) ?? serial))
  }
  const issues = [previous?.latestIssueMs, acceptance.latestIssueMs].filter((v): v is number => typeof v === 'number')
  return {
    serialByOrigin,
    latestIssueMs: issues.length > 0 ? Math.max(...issues) : null,
    endedAtMs: nowMs,
    cancelled: cancelled || (previous?.cancelled ?? false),
    lastReport,
    // 第 1 報の時刻は一度覚えたら変えない（前に消えたときの記憶が先）
    firstIssueTime: previous?.firstIssueTime !== undefined ? previous.firstIssueTime : firstIssueTime,
  }
}

/**
 * 印と記憶を残しておく鍵の集合（地震カードと長周期）。
 *
 * **両方を数えること。** 片方の種別を受けたときにもう片方の鍵を渡し忘れると、その記憶が
 * 捨てられ、次に届いた続報が初報として扱われて印が出なくなる（初報では印を出さないため、
 * 症状は「印が出ない」だけで例外もログも出ない）。
 */
/**
 * 履歴を取り込んだときの印と記憶。
 *
 * **新しい印は出さない。** 履歴は「もう起きたこと」をまとめて再現するもので、取り込んだ
 * 直後のカードに印が付くと「いま動いた」と読める。
 *
 * **ただし、いま出ている印は消さない。** 履歴の取り込みはライブと非同期に走る
 * （`restoreQuakeHistory` はリプレイ開始の数秒後に完了し、「もっと見る」は利用者が
 * 押した瞬間に走る）。捨てていた頃は、**直前の続報で付いた印が履歴の到着で消えていた**
 * ——「もっと見る」を押すと表示中の印が全部落ちるのがそれ。一覧から消えたカードの分と
 * 寿命切れだけを落とす（ライブ経路の `advanceQuakeMarks` と同じ絞り方）。
 *
 * **記憶は畳み込みが作ったものを受け取る**（`mergeQuakeHistory` の `markMemory`）。あれは
 * 電文を 1 通ずつ当てるので、各段階が「その報の時点でカードが見せていた姿」になる。
 * **捨てていた頃は、次に届いた報が比べる相手を持たず印が出なかった** —— リプレイを
 * 21:30 直前から始めて能登本震の震源要素更新を受けても、座標・深さの印が出ないのがそれ
 * （直前の同じ地震の報は 16:24 で、再生が始まる前に畳み込まれている）。
 *
 * **刈り込みはここで行う**（`trimQuakeMarkMemory`）。長周期の記憶が同じ入れ物に同居して
 * いるので、カードの鍵だけで絞ると長周期の分を巻き込んで落とす。
 */
function marksFromHistory(
  markMemory: Map<string, QuakeMarkMemory>,
  cards: readonly JMAQuake[],
  lpgmByEventId: ReadonlyMap<string, JMALpgm>,
  prevMarks: ReadonlyMap<string, QuakeCardMarks>,
): Pick<EarthquakeState, 'quakeUpdateMarks' | 'quakeMarkMemory'> {
  const liveKeys = liveMarkKeys(cards, lpgmByEventId)
  // 寿命の判定は `pruneQuakeMarks` へ任せる。**同じ式をここへ書き写さない** —— 境界の
  // 不等号や `UPDATE_MARK_TTL_MS` の意味を変えたとき、片方だけ直す経路ができる。
  // **実時計で測る**（ライブ経路と同じ理由 —— 印は「画面に出してから何秒経ったか」の話で、
  // 電文の時刻軸には乗せない）。
  const alive = pruneQuakeMarks(prevMarks, Date.now())
  const marks = new Map<string, QuakeCardMarks>()
  for (const [key, mark] of alive) if (liveKeys.has(key)) marks.set(key, mark)
  return {
    // **変わっていなければ同じ参照を返す**（`pruneQuakeMarks` と同じ約束）。印の寿命の
    // 掃除タイマーがこの参照を依存に持つので、中身が同じまま作り直すと張り直しが空振りする。
    quakeUpdateMarks: marks.size === alive.size ? alive : marks,
    quakeMarkMemory: trimQuakeMarkMemory(markMemory, liveKeys),
  }
}

/**
 * ライブで届いた長周期地震動の報を 1 通当て、一覧と更新の印を進める。
 *
 * **キュー経路（`handleEvent`）と DMDSS 版の WebSocket 経路の両方がここを通る。** 片方だけに
 * 印付けを書いていた頃は、DMDSS 版のライブで長周期の一覧に印が付かなかった（キュー経路を
 * 通るテスト・リプレイでは付くので、実機でしか見えない）。
 *
 * 長周期の一覧にも、震度一覧と同じ印を付ける。**取消では付けない**（一覧ごと消えるため）。
 * 控えの 60 日では長周期の続報が 1 通も無かった（24 件すべて単発）。ただしそれは
 * 「見つからなかった」であって「来ない」ではないので、同じ構造の震度一覧に印を付ける以上
 * こちらだけ出ない形にはしない（→ `lpgmRowSnapshot`）。
 */
export function applyLiveLpgmWithMarks(
  prev: Pick<EarthquakeState, 'earthquakes' | 'lpgmByEventId' | 'quakeUpdateMarks' | 'quakeMarkMemory'>,
  lpgm: JMALpgm,
  now: number,
): Pick<EarthquakeState, 'lpgmByEventId' | 'quakeUpdateMarks' | 'quakeMarkMemory'> {
  const next = applyLiveLpgm(prev.lpgmByEventId, lpgm)
  const unmarked = { lpgmByEventId: next, quakeUpdateMarks: prev.quakeUpdateMarks, quakeMarkMemory: prev.quakeMarkMemory }
  if (lpgm.cancelled) return unmarked
  // **印付けが投げても一覧の更新は通す。** ここは `setState` の更新関数の中で走るので、
  // 投げると周りの受け皿に届かず描画中の例外になり、画面ごと落ちる。印は補助なので、
  // 付け損ねたら記録を残して据え置く。
  try {
    return markedLpgmState(prev, lpgm, next, now)
  } catch (err) {
    log.error('[lpgm] 長周期の一覧の更新の印を付けられなかった（一覧は更新した）', { eventId: lpgm.eventId, err })
    return unmarked
  }
}

function markedLpgmState(
  prev: Pick<EarthquakeState, 'earthquakes' | 'quakeUpdateMarks' | 'quakeMarkMemory'>,
  lpgm: JMALpgm,
  next: Map<string, JMALpgm>,
  now: number,
): Pick<EarthquakeState, 'lpgmByEventId' | 'quakeUpdateMarks' | 'quakeMarkMemory'> {
  const markState = advanceQuakeMarks({
    prev: { memory: prev.quakeMarkMemory, marks: prev.quakeUpdateMarks },
    key: lpgmMarkKey(lpgm.eventId),
    snapshot: {
      // 長周期は震源要素の欄を持たない（震源はカードの地震情報側が出す）。
      facts: new Map(),
      rows: lpgmRowSnapshot(lpgm.regions ?? [], lpgm.points ?? [], lpgm.prefs ?? []),
      issuedAt: markIssuedAt(lpgm.time),
      // 長周期地震動観測情報は 1 種類しか無いので、種別が変わることがない。
      reportType: 'lpgm',
      telegramType: 'lpgm',
      // 県・区域の行は電文の `Revise` で付ける（観測点は差分のまま。→ `lpgmTelegramRevise`）
      revise: lpgmTelegramRevise(lpgm),
    },
    liveKeys: liveMarkKeys(prev.earthquakes, next),
    now,
  })
  return { lpgmByEventId: next, quakeUpdateMarks: markState.marks, quakeMarkMemory: markState.memory }
}

/**
 * P2PQuake の津波の報（552）の束から、いま画面に出す津波を決める。
 *
 * **起動時の履歴と、張り直したときの取り戻しが同じ判断を通る**ためにここへ置く（片方だけ
 * 直すと、次に触る人がどちらが正なのか判らない）。P2PQuake の 552 は毎報が全区域の写しなので、
 * いちばん新しい 1 報だけを見ればよい。取消・失効していれば何も出さない。
 */
function selectP2pTsunamiSnapshot(
  tsunamiEvents: readonly JMATsunami[],
  now: Date,
): { latest: JMATsunami | undefined; active: JMATsunami[] } {
  const all = [...tsunamiEvents].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
  // DMDSS 側と同じ引き継ぎ。P2PQuake の 552 は有効期限を持たないため実際には何も変わらないが、
  // 経路ごとに扱いを違えない（片方だけ直すと、次に触る人がどちらが正なのか判断できない）。
  const latest = all[0] && withInheritedTsunamiFacts(all[0], all)
  const active = latest
    && !latest.cancelled
    && !(latest.validDateTime && new Date(latest.validDateTime) <= now)
    ? [latest] : []
  return { latest, active }
}

/**
 * 張り直したとき、最後に何かが届いた時刻からさらにこれだけ遡って取り戻す (ms)。
 *
 * 比べるのは手元の時計（`serverNow()`）と配信元が受け取った時刻なので、両者のずれと、
 * 切れる直前に届いていたはずの報が配信元で遅れて記録された分を見込む。重なって取った分は
 * 統合が同じ電文として重ねない（→ `utils/quakeMerge.ts` の `isSameTelegram`）。
 */
const P2P_RECONNECT_BACKFILL_MARGIN_MS = 5 * 60 * 1000
// DMDSS 版の取り戻しも同じ幅だけ遡る（最後に受け取った時刻の直前に出て、まだ届いていなかった電文を拾うため）
const DMDATA_RECONNECT_BACKFILL_MARGIN_MS = P2P_RECONNECT_BACKFILL_MARGIN_MS

function liveMarkKeys(
  earthquakes: readonly JMAQuake[],
  lpgmByEventId: ReadonlyMap<string, JMALpgm>,
): Set<string> {
  const keys = new Set<string>()
  for (const q of earthquakes) keys.add(quakeEventKey(q))
  for (const id of lpgmByEventId.keys()) keys.add(lpgmMarkKey(id))
  return keys
}

export interface EarthquakeState {
  earthquakes: JMAQuake[]
  tsunamis: JMATsunami[]
  activeEEWs: ReadonlyMap<string, EEWAlert>
  lpgmByEventId: ReadonlyMap<string, JMALpgm>
  nankai: JMANankai | null
  nankaiCommentary: JMANankaiCommentary | null
  kohatsu: JMAKohatsu | null
  /** 地震・津波に関するお知らせ（VZSE40）。最新の 1 通だけ持つ */
  quakeNotice: JMAQuakeNotice | null
  /** 地震回数に関する情報（VXSE60）。最新の 1 通だけ持つ */
  earthquakeCount: JMAEarthquakeCount | null
  /**
   * 推計震度分布図（IXAC41・IXAC40）。**地震ごとに 1 通**（その地震の最新）を持つ。
   *
   * 地震カードとの引き当ては地震発現時刻と震源（→ `estimatedIntensityFor`）。かつては最新の
   * 1 通だけを持っていたため、次の地震の分布が届いた時点で前の地震のカードから分布が消え、
   * 履歴（起動時・「もっと見る」・リプレイの補完）から取り込むこともできなかった。
   *
   * **件数に上限は置かない**（2026-10-05 ユーザー承認）。発表は震度5弱以上の地震だけで
   * （実配信 13 か月で 28 通）、1 通はふつう数千セル・十数 KB。実電文で観測した最大は
   * 能登半島地震の本震の 517,803 セル（型付き配列で約 4.7MB）。
   *
   * 入れるのは `upsertEstimatedIntensity` だけ（地震ごとに 1 通を保つ規則はそこにある）。
   */
  estimatedIntensities: readonly JMAEstimatedIntensity[]
  /**
   * 地震カードの更新の印（鍵は `quakeEventKey`）。**ライブで受けた続報にだけ付く。**
   *
   * 履歴の取り込み（起動時・「もっと見る」）では付けない —— あちらは何通もまとめて
   * 畳み込むので「この報で動いた」を指せない。
   */
  quakeUpdateMarks: ReadonlyMap<string, QuakeCardMarks>
  /**
   * 印を出すための、1 つ前のカードの写し（鍵は `quakeEventKey`）。
   *
   * **状態に持つ。ref にしない。** 差分は状態の更新関数の中で取るので、そこから ref へ
   * 書き込むと更新関数が純粋でなくなる（React が 2 度走らせたときに記憶が二重に進む）。
   */
  quakeMarkMemory: ReadonlyMap<string, QuakeMarkMemory>
  connectionStatus: ConnectionStatus
  /**
   * DMDSS 版で、配信元が受け付けた購読区分（最後に繋がった接続のもの）。まだ繋がっていなければ null。
   * 設定の窓の「受信している区分」と、リプレイが引く区分に使う（→ `services/dmdataClassifications.ts`）。
   * 標準版では常に null。
   */
  dmdataClassifications: readonly DmdataClassification[] | null
  lastUpdate: Date | null
  isLoading: boolean
  isLoadingMore: boolean
  hasMore: boolean
  error: string | null
  /**
   * 履歴取得で読めなかった取得元・取り込めなかった電文。**DMDSS 版限定。**
   *
   * 履歴取得は例外を投げずに一部の失敗を吸収するため、`error` は立たない。**画面には取れた分の
   * カードだけが出て、失敗は何も出ない**状態だった。取得元が「日」単位になったぶん、1 日落ちれば
   * 失う電文は多い（実測 2026-09-15: 起動時の電文本体 85 件のうち 81 件が 429 で失敗し、
   * 4 件しか出ていなかった）。
   *
   * **取得のたびに置き換える（積まない）。** あの取得は毎回「その時点の全範囲」を走査して
   * 数え直すので、積むと同じ損失を回数だけ数え、取得が回復しても消えない
   * （→ `utils/telegramLoss.ts` の表）。
   *
   * **標準版（P2PQuake）では常に空。** あちらの履歴取得は「全部取れたか全滅か」で、部分的な
   * 損失という概念を持たない（失敗は `error` へ落ちる）。**空であることは「欠けていない」ことの
   * 保証ではない。**
   *
   * 空へ戻すのは接続をやり直すときだけ。契機は下の接続 effect の依存が単一情報源で、
   * API キーの変更・試験報の受信設定の切り替え・リプレイの開始と終了が含まれる。
   */
  historyLoss: TelegramLoss
  /**
   * 直近の「もっと見る」がまるごと失敗したか。**両バリアント共通。**
   *
   * **`historyLoss` とは別に持つ。** こちらは押し直せば回復しうるもので、遡る日数も押す前の値へ
   * 戻してある。次に成功したら消す。
   */
  loadMoreFailed: boolean
  /**
   * 接続が切れていた間の電文を、取り戻せていないか。**両バリアント共通**（2026-10-21 ユーザー承認「A・X・揃える」）。
   *
   * **最初に取れなかった時点から立てる**（引き直しを待っている間も、諦めた後も）。引き直しは次に張り直したときにしか
   * 走らないので、接続が安定していればいつ来るか分からない —— その間も一覧には穴が空いている。
   * DMDSS 版は、持ち越した区間を後の取り戻しが埋めたら降ろす。諦めた区間（引き直しても取れなかった・一覧の
   * ページの上限に当たった）と、標準版の取り戻しの失敗は、再読み込みまで残す（どちらも同じ区間を引き直さない）。
   * 読めない形の電文は数えない（引き直しても再読み込みしても同じなので、知らせても直す手が無い）。
   *
   * 空へ戻すのは `historyLoss` と同じ契機（接続をやり直すとき・リプレイの開始）。
   */
  reconnectGapLoss: boolean
  telegramLog: TelegramLogEntry[]
}

export function useEarthquakes(
  onLiveEvent?: (event: LiveEvent, meta?: LiveEventMeta) => void,
  dmdataApiKey = '',
  dmdataTestDelivery = false,
  replayTimeOffset: number | null = null,
  /**
   * 復元した「発表中のもの」を画面へ見せてよいと伝える。
   *
   * **`onLiveEvent` とは別の口にする。** 復元は音も読み上げも起こさないので `onLiveEvent` を
   * 通らない（`silent` を立ててキューへ積むため）。それでも**画面だけは見せたい**——揺れてから
   * 開いた利用者にとって、発表中の警報は最初に目に入るべきものだから。
   *
   * **呼ばれるのは起動時だけではない。** この接続の effect は API キーの編集やリプレイの往復でも
   * 再実行され、そのたびに復元と通知が走る。**「初回だけ」に絞ろうとしないこと** —— React の
   * StrictMode は開発時に effect を 2 回実行し、1 回目は cleanup で破棄されるため、「初回か」を
   * ref で覚えると**開発モードでだけ通知が一度も出なくなる**（本番では出るので、食い違いに
   * 気づけない）。再接続で通知が出ても実害は小さい: 発表中の警報が無ければ何も起こらず、
   * あるなら見せるべきものだから。
   *
   * 優先度と駆動源は受け取る側（`App`）が決める。ここで決めると、タブ切替の規則が
   * `utils/tabPriority.ts` と 2 箇所へ分かれる。
   */
  onStartupRestore?: (tab: 'realtime' | 'tsunami') => void,
  /**
   * 起動時に復元した「発表中の緊急地震速報」を、読み上げ側（`useLiveEventHandler` の `restoreStartupEews`）へ渡す。
   *
   * **`onLiveEvent` を通らない分を、ここで別に伝える。** 復元は `silent` で積むので読み上げ側には届かず、
   * 渡さないとその後の取消が「表示中の速報ではない」と判定されて鳴らず読まれない（→ eew-spec.md §2
   * 「起動時に、発表中のものを復元する」）。**この引数だけ任意なのは、前の引数がすべて任意だから**
   * （必須の引数は任意の後ろに置けない。必須にするなら前の引数ごと必須へ直し、テストの呼び出しもすべて直すことになる）。
   * `useEarthquakes.wiring.test.ts` が固定するのは「渡せば呼ばれる」ところまでで、
   * **`App.tsx` が渡しているかは型でもテストでも捕まらない**（渡し忘れると取消が声にならないだけで、例外もログも出ない）。
   */
  onStartupRestoreEews?: (eews: readonly EEWAlert[]) => void,
) {
  const [state, setState] = useState<EarthquakeState>({
    earthquakes: [],
    tsunamis: [],
    activeEEWs: new Map(),
    lpgmByEventId: new Map(),
    nankai: null,
    nankaiCommentary: null,
    kohatsu: null,
    quakeNotice: null,
    earthquakeCount: null,
    estimatedIntensities: [],
    quakeUpdateMarks: new Map(),
    quakeMarkMemory: new Map(),
    connectionStatus: (isDmdss && !isValidDmdataApiKey(dmdataApiKey)) ? 'disconnected' : 'connecting',
    dmdataClassifications: null,
    lastUpdate: null,
    isLoading: !(isDmdss && !isValidDmdataApiKey(dmdataApiKey)),
    isLoadingMore: false,
    hasMore: false,
    error: null,
    historyLoss: createEmptyTelegramLoss(),
    loadMoreFailed: false,
    reconnectGapLoss: false,
    telegramLog: [],
  })

  // 「いま」は行の `receivedAt` と同じ時計で測る（→ `utils/telegramLogBuffer.ts` の `isExpiredLive`）
  const appendTelegramLog = useCallback((entry: TelegramLogEntry) => {
    setState(prev => ({ ...prev, telegramLog: appendToTelegramLog(prev.telegramLog, entry, serverNow()) }))
  }, [])

  // 何も届かない間も 24 時間より古いライブの行を捨てる。積むときだけでは、静かな時間が続くと残り続ける。
  // 捨てるものが無ければ同じ配列が返るので、描き直しは起きない。
  useEffect(() => {
    const timer = setInterval(() => {
      setState(prev => {
        const next = pruneTelegramLog(prev.telegramLog, serverNow())
        return next === prev.telegramLog ? prev : { ...prev, telegramLog: next }
      })
    }, TELEGRAM_LOG_PRUNE_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [])

  const clearTelegramLog = useCallback(() => {
    setState(prev => ({ ...prev, telegramLog: [] }))
  }, [])

  const wsRef = useRef<P2PQuakeWebSocket | null>(null)
  // 最新のコールバックを ref で保持し、handleEvent を安定させる
  const onLiveEventRef = useRef(onLiveEvent)
  onLiveEventRef.current = onLiveEvent
  const onStartupRestoreRef = useRef(onStartupRestore)
  onStartupRestoreRef.current = onStartupRestore
  const onStartupRestoreEewsRef = useRef(onStartupRestoreEews)
  onStartupRestoreEewsRef.current = onStartupRestoreEews
  // キューディスパッチャーがサイレントエントリを処理中は true にして通知音を抑制する
  const isSilentRef = useRef(false)
  // 緊急地震速報のテストの進み具合を種別ごとに独立管理（複数の EEW を同時に流せる）
  const testEEWPressRef = useRef<Map<TestEEWKind, TestEEWPressEntry>>(new Map())
  /**
   * テストボタンの世代。**リセット（リプレイの開始・停止）とアンマウントで進める。**
   *
   * **電文を組むには `await` が要る**（台本の読み込みと電文の取得）。その間にリセットが入ると、
   * 待ちをキューに持たせていても**まだキューに載っていない**ので落とせない —— リセット後の
   * 画面へ、消したはずの電文がまるごと届く。積む直前に世代を照らし合わせて捨てる。
   */
  const testGenerationRef = useRef(0)
  /** 遅れた誤報取消テストが張る待ち（→ `simulateEEWLateRetraction`）。 */
  const testEEWLateRetractionTimerRef = useRef<number | null>(null)
  /**
   * 押すたびに進む台本の待ち行列（種別ごとに 1 本）。
   *
   * **連打と最終報を、同じ列へ並べて 1 本ずつ処理する。** 電文を組むには `await` が要るので、
   * 並べないと「前の押下が台帳を書く前に、次の押下が台帳を読む」が起きる —— 同じ段が違う
   * 識別子で 2 枚のカードになり、待ちも二重に張られる（→ `pressTestTelegramScript`）。
   */
  const testPressChainRef = useRef<Map<TestEEWKind, Promise<void>>>(new Map())
  /** 待ち行列の末尾へ足す。**失敗しても列は止めない**（次の押下が動かなくなる）。 */
  const enqueueTestPress = useCallback((kind: TestEEWKind, task: () => Promise<void>): Promise<void> => {
    const prev = testPressChainRef.current.get(kind) ?? Promise.resolve()
    const next = prev.then(task, task)
    testPressChainRef.current.set(kind, next.catch(() => {}))
    return next
  }, [])

  /**
   * テストボタンが張った「待ち」をすべて落とす。**アンマウントと `resetState` の両方から呼ぶ。**
   *
   * **1 箇所にまとめてあるのは、配線を落としやすいから。** 待ちには 2 系統あり、
   * 南海トラフ・地震回数の取消テストはイベントキューへ積むが、**津波と EEW のテストは
   * `handleEvent` を直接呼ぶ** —— `eventQueueRef.current.clear()` では止まらない。
   * 追い忘れると、画面を閉じた後やリプレイへ切り替えた後に、消えたはずの電文が 1 通だけ
   * 単独で届く。**例外もログも出ない。**
   *
   * 落とすのは「これから発火する待ち」だけで、画面に出ているものの扱いには触れない
   * （そちらは `resetState` の他の行が決めている）。
   *
   * **待ちを持つ ref を増やしたら、ここへ足すこと。**
   */
  const clearTestSimulationTimers = useCallback(() => {
    // 緊急地震速報のテストが張った最終報の待ち。**種別ごとに独立して張られる**ので Map を走査する。
    // 1 つでも残ると、リセット後の画面へ緊急地震速報がまるごと 1 通生える。
    for (const entry of testEEWPressRef.current.values()) {
      window.clearTimeout(entry.finalizeTimer)
    }
    testEEWPressRef.current.clear()
    // **組んでいる途中のものも捨てる。** タイマーを落とすだけでは、`await` の中にいる押下が
    // この後でキューへ積んでしまう（→ `testGenerationRef`）。
    // 遅れた誤報取消テストの待ち（自動解除の後に取消を流す。キューを通らない）
    if (testEEWLateRetractionTimerRef.current !== null) {
      window.clearTimeout(testEEWLateRetractionTimerRef.current)
      testEEWLateRetractionTimerRef.current = null
    }
    testGenerationRef.current++
  }, [])
  // 帯に出している南海トラフ臨時情報・後発地震注意情報の識別情報（無ければ null）。取消の照合に使う。
  //
  // **`stateRef` では判定できない。** あれはレンダー時にしか進まないが、キューのディスパッチャは
  // 1 ティックの中で複数のイベントを処理する（理由は `eewAcceptanceRef` の宣言箇所に同じ）。
  // こちらは反映した時点で即座に進むため、同じティックの中でも正しく比べられる。
  const shownNankaiEventIdRef = useRef<string | null>(null)
  const shownKohatsuEventIdRef = useRef<string | null>(null)
  // 解説情報だけは `id`（識別情報と号数の組）で持つ。理由は `applyNankaiCommentary` の照合箇所。
  const shownCommentaryIdRef = useRef<string | null>(null)
  // 表示中のお知らせ。取消は元のお知らせの `EventID` しか持たないので、`id` と並べて覚える
  // （照合は `applyQuakeNotice`）。
  const shownQuakeNoticeRef = useRef<{ id: string; eventId: string } | null>(null)
  // 表示中の地震回数の群発識別子。**取消が自分宛かを同期的に判定する**ために持つ
  // （`setState` の中で照合すると、読み上げを起こすかどうかをその場で返せない）。
  const shownEarthquakeCountEventIdRef = useRef<string | null>(null)
  // 現在の state を WS コールバック内から参照するための ref
  const stateRef = useRef(state)
  stateRef.current = state
  /**
   * 失効予約の土台（DMDSS 版）。直前に報を当てた結果と、そのとき `stateRef` が見せていた津波の組。
   * `stateRef` がまだ同じ津波を見せていれば（同じ周回に報が続けて届いた）、当てた結果のほうを土台にする。
   * 理由は失効予約を積む箇所の注記。
   */
  const expiryBasisRef = useRef<{ shownAtStep: JMATsunami | undefined; tsunami: JMATsunami | undefined } | null>(null)
  /**
   * DMDSS 版で、ライブで当てた津波の報（解除・取消・失効を含む）のうちいちばん新しいものの並べる鍵
   * （`reportOrderKey`。作成時刻、無ければ発表時刻）。
   *
   * **起動時履歴の取り込みはこれより新しい報でしか津波を書き換えない。** 履歴の取得はライブの接続と並行して
   * 走り、数十秒〜数分かかる。その間にライブで当てた報（引き上げ・解除）を、取り込みの最後に履歴の古い最新報
   * （または空）で上書きすると、引き上げが巻き戻る・ライブで出た津波が消える・解除した津波が甦る。
   * 標準版の `p2pTsunamiSeenMs` と同じ考え方。時間軸が変わるリセットで空に戻す。
   */
  const liveTsunamiSeenKeyRef = useRef(Number.NEGATIVE_INFINITY)
  /**
   * **同じティックで受理した地震カードの写し**（同じ地震につき 1 枚）。
   *
   * 据え置き判定（`isQuakeReportHeldBack`）は既存カードと突き合わせるが、`stateRef` は
   * **レンダー時にしか進まない**。キューのディスパッチャは 1 ティックで発火済みのエントリを
   * すべて捌くので（`shiftReady` のループ）、そのあいだ判定は直前に受理した報を見られない。
   * 判定のたびに `stateRef` の古さを例外で埋める形にすると、鮮度が足りない場面が見つかるたびに
   * ガードが増える —— 実際に「取消の台帳と照合する」「その照合に発表時刻の境界を置く」と
   * 2 段継ぎ足し、どちらも別の抜け道を残した。**参照そのものを進めるほうが筋がよい。**
   *
   * **画面の状態そのものではない。** 統合の畳み込み（`coalesceByEventId`・津波からの借り物・
   * 取消の 10 秒後の purge）は再現しない —— 据え置き判定が見るのは種別・発表時刻・震度の有無・
   * 取消済みかの 4 つだけ（→ `quakeHoldBack`）で、そこに足りる粒度で足りる。
   *
   * レンダーが走れば `stateRef` が追いつくので、そこで捨てる（上限は置かない。溜まるのは
   * 1 ティックのあいだだけで、レンダーが走らない状況ではアプリ自体が動いていない）。
   */
  const pendingQuakeCardsRef = useRef<JMAQuake[]>([])
  pendingQuakeCardsRef.current = []
  /**
   * **もう受け手へ流した取消の電文**（`<種別>:<電文の id>|<発表時刻>`）。同じ取消が二度届いたら 2 通目は流さない。
   *
   * 臨時情報・後発地震・関連解説情報・長周期・地震回数の取消は、**画面に出していない情報への取消でも
   * 音と声で伝える**（2026-10-22 ユーザー選択「地震情報に揃えて伝える (Recommended)」。解説情報は 2026-10-24
   * ユーザー選択「伝える (Recommended)」）。帯や一覧を消したかでは判定しないので、二重配信を見分ける手掛かりは
   * 電文そのものになる。2 通目を黙らせるのは地震情報の取消と同じ（2026-10-15 ユーザー承認「2通目は鳴らさない（推奨）」）。
   *
   * **鍵に発表時刻を含める。** 取消の id は取り消す対象と同じ形（EventID と号数）で作られ、号数が欠けると `1` に倒れる
   * ので、id だけだと別の取消を二重配信と取り違えうる。テストボタンも同じ実電文を時刻だけずらして流すので、id だけだと
   * 2 回目に押した取消が無音になる。本当の二重配信は時刻まで同じ。
   *
   * リプレイの開始・リセットで空にする（前の時間軸で伝えた取消を、新しい軸で黙らせないため）。
   */
  const conveyedCancelsRef = useRef<Set<string>>(new Set())
  /**
   * 帯の電文（と長周期）を受け手へ流すかを決める。戻り値は流すなら `'dispatch'`、流さないなら記録の理由。
   *
   * - **取消でない報**は画面へ当てたか（`applied`）で決める（従来どおり）
   * - **取消**は画面へ当てたかによらず流し、同じ電文の 2 通目だけ止める（`'notDispatched'`）
   * - **サイレント注入**（リプレイの初期状態）は流さない。取消なら「伝えた」に数える —— 画面は既に取消を
   *   反映しているので、同じ取消が後からライブで届いても鳴らさない（地震情報の取消と同じ）
   * - **別の情報単位の帯が出ているときの、古い単位への取消**（`otherUnitShown`。臨時情報・後発地震注意情報）は流さない。
   *   「〇〇は取り消されました」と言うと、いま出ている帯の情報が取り消されたように聞こえる（2026-10-24 ユーザー選択
   *   「別単位の帯が出ていれば黙る (Recommended)」）。帯が何も出ていないときの取消は伝える
   */
  const decideDispatch = (
    kind: string, telegram: { id: string; time: string; cancelled: boolean }, applied: boolean, silent: boolean | undefined,
    otherUnitShown: boolean,
  ): 'dispatch' | ReplayTelegramSkip => {
    if (!telegram.cancelled) return !applied ? 'notApplied' : silent ? 'silentReplayInit' : 'dispatch'
    const duplicate = !noteConveyedCancel(kind, telegram)
    if (silent) return 'silentReplayInit'
    if (otherUnitShown) {
      log.info(`[${kind}] 別の情報単位の帯を出しているので、古い単位への取消は音と読み上げを出さない id=${telegram.id}`)
      return 'notApplied'
    }
    if (duplicate) {
      log.info(`[${kind}] 既に伝えた取消なので音と読み上げを出さない id=${telegram.id}`)
      return 'notDispatched'
    }
    if (!applied) log.info(`[${kind}] 画面に出していない情報への取消も伝えます id=${telegram.id}`)
    return 'dispatch'
  }
  /**
   * 取消を「伝えた」に数える。**初めてなら真**（もう数えてあれば偽＝二重配信）。起動時の履歴で当てた取消も
   * ここを通す —— 通さないと、同じ取消が後からライブで届いたとき（再接続・重複配信）に鳴り直す。
   */
  const noteConveyedCancel = (kind: string, telegram: { id: string; time: string }): boolean => {
    const key = `${kind}:${telegram.id}|${telegram.time}`
    if (conveyedCancelsRef.current.has(key)) return false
    // 取消は年に数通しか無いが、上限は置く（長く開いたままの端末で増え続けないように）
    if (conveyedCancelsRef.current.size >= 500) conveyedCancelsRef.current.clear()
    conveyedCancelsRef.current.add(key)
    return true
  }
  /** 履歴の長周期を記録する理由（流さない経路。取消は「伝えた」に数える。→ {@link decideDispatch}）。 */
  const silentLpgmSkip = (lpgm: JMALpgm): ReplayTelegramSkip => {
    if (!lpgmNotifiable(lpgm)) return 'notDispatched'
    const decision = decideDispatch('lpgm', lpgm, true, true, false)
    return decision === 'dispatch' ? 'silentReplayInit' : decision
  }
  /**
   * 臨時情報・後発地震注意情報の取消が、**いま出ている別の情報単位の帯の下で届いた古い取消か**。帯へ当てる前に見る
   * （当てた後では、消したのか元から別だったのかが分からない）。判定の形は `applyNankai`・`applyKohatsu` の照合と同じ。
   */
  const cancelOverOtherUnit = (shownEventId: string | null, telegram: { eventId: string; cancelled: boolean; retracted?: boolean }): boolean =>
    telegram.cancelled && telegram.retracted === true && shownEventId !== null && shownEventId !== telegram.eventId
  // 受理した EEW の報番号（キーは `eewEventKey`）。古い報の判定に使う。
  //
  // **`stateRef` では判定できない。** あれはレンダー時にしか進まないが、キューのディスパッチャは
  // 1 ティックの中で `handleEvent` を連続で呼ぶ（同じ秒の報がまとめてキューに載るため、まさに
  // 順序が入れ替わりうる場面で起きる）。その間 `stateRef` は前のレンダーの値のままなので、
  // 直前に受理した報より古い報を「新しい」と誤判定して通してしまう。こちらは受理した時点で
  // 即座に進むため、同じティックの中でも正しく比べられる。
  //
  // **経路ごとの報番号と、経路をまたいだ発表時刻を持つ**（→ `EewAcceptance`）。standard 版は
  // Yahoo と P2PQuake が同じ地震を運び、報番号の数え方が違う（P2PQuake の 1 と Yahoo の 17 が
  // 同じ報）。番号 1 つの台帳で比べると、P2PQuake の報を毎回「古い」と見なして捨てる。
  const eewAcceptanceRef = useRef<Map<string, EewAcceptance>>(new Map())
  /**
   * **表示を終えた（自動解除・取消で画面から消えた）地震**（キーは `eewEventKey`）。台帳は画面から消えた時点で
   * 捨てるので、それとは別に `ACTIVE_EEW_WINDOW_MS` だけ覚えておく。
   *
   * 発表中の速報の取り直し（起動時・張り直し）が、もう終えた地震を「発表中」として返すことがある —— 取り直しの
   * 最中に自動解除が先に起きた場合。台帳には何も残っていないので、そのまま戻すと**読み上げ側の帳面に終わった
   * 速報が居座り**、本物の速報が全部解除されてもタイトルが戻らない。取り直しの結果はここで弾く（→ `skipEndedEew`）。
   */
  const eewEndedRef = useRef<Map<string, EndedEew>>(new Map())
  /**
   * 直前に画面へ載っていた地震の鍵と、そのとき取消済みだったか。`eewEndedRef` へ覚えるのは、ここにあって今回消えたものだけ
   */
  const prevActiveEewKeysRef = useRef<ReadonlyMap<string, EEWAlert>>(new Map())
  /**
   * 地震ごとに、手元で最初に受けた報の発表時刻（→ `rememberEewFirstIssueTime`）。画面から消えた地震の記憶
   * （`eewEndedRef`）へ移し、消えた後に届いた誤報取消の読み上げに使う。読み上げ側も同じものを覚えているが、
   * あちらは解除のときに捨てる（`forgetEewTracking`）。表示が終わった分は台帳と一緒に掃除する
   */
  const eewFirstIssueTimeRef = useRef<Map<string, string | null>>(new Map())
  /**
   * 自動解除を入口で受け、状態にはまだ反映されていない地震の鍵（→ 入口の自動解除の分岐）。**同じティックに続けて届いた
   * 誤報取消**を「消えた後の取消」として扱うために要る —— 状態の反映を待つと、その間 `stateRef` には地震が残り、
   * `eewEndedRef` にはまだ記憶が無い。状態が反映されたら（`state.activeEEWs` の effect）空にする
   */
  const eewExpiringRef = useRef<Set<string>>(new Set())
  /**
   * **同じティックで統合した EEW の写し**（キーは `eewEventKey`）。
   *
   * 統合（`mergeEewReport`）は入口で 1 回だけ行い、その値を状態にも読み上げ・通知にも渡す。
   * 土台を `stateRef` にすると、同じティックに続けて届いた報（Yahoo と P2PQuake の同じ報など）が
   * 直前に統合した値を見られない。理由は `pendingQuakeCardsRef` と同じ。
   *
   * 表示が終わった EEW の分は台帳と一緒に掃除する。
   */
  const eewLatestRef = useRef<Map<string, EEWAlert>>(new Map())
  /**
   * 見張りの解除（`eew-watch-expiry`）のうち、いま生きている 1 本の印（キーは `eewEventKey`・値は
   * 予約したときの受理回数）。P2PQuake の報が届くたびに張り直すので、前の見張りはこれと合わなければ捨てる。
   */
  const eewWatchReceiptsRef = useRef<Map<string, number>>(new Map())
  // VXSE51 受信時に震度データをキャッシュし、後続の VXSE52（震源情報）に補完する。
  // VXSE52 は震源のみで震度を持たないため、VXSE51 の maxScale・points を引き継ぐ。
  // `report` は控えた震度速報の発表時刻・作成時刻（取消がこの報より後かを比べるため）
  const quakeIntensityCacheRef = useRef<Map<string, { maxScale: IntensityScale; points: EarthquakePoint[]; report: ReportAge }>>(new Map())
  // 取消を見た事実の台帳。取消の後に届いた報のうち「取消より前に発表されたもの」を捨てるために使う
  // （判定は `isRetractedQuakeReport`。切り分けの理由は docs/spec/quake-spec.md §6.2）。
  //
  // **カードの `cancelledAt` を見るだけでは足りない。** 取消済みカードは 10 秒後に purge されるため、
  // それを過ぎて届いた古い報を弾けない。順序の入れ替わりを拾うのが目的なのに、10 秒で記憶が
  // 消えては用を成さない。履歴経路（`mergeQuakeHistory`）はカードごと消すので、そちらの取消も
  // ここに集めて両経路で共有する。
  const quakeRetractionsRef = useRef<QuakeRetraction[]>([])
  // 長周期地震動の取消の台帳（→ `utils/lpgmRetraction.ts`）。地震情報の台帳と同じ理由で ref に持つ。
  const lpgmRetractionsRef = useRef<LpgmRetraction[]>([])
  // 持っている推計震度分布図の一覧（`EarthquakeState.estimatedIntensities` と同じもの）。
  // **反映の判定を同期に行うために ref でも持つ**（理由は `applyEstimatedIntensity`）。
  // 要素は state と同じ参照なので、本体を二重に抱えることはない。
  const estimatedIntensitiesRef = useRef<readonly JMAEstimatedIntensity[]>([])
  // 分布を伝えた地震（発現時刻）の台帳。読み上げが「受信しました」と「更新されました」を
  // 言い分けるのに使う（→ `isNewEstimatedIntensity`）。**持っている一覧では代われない** ——
  // 履歴から黙って取り込んだ分布は持っているが、まだ伝えていない。
  const shownEstimatedIntensityArrivalsRef = useRef<string[]>([])
  // 後発地震注意情報（VYSE60）の帯を発表から 7 日で畳むタイマー（電文に期限は無く、7 日はアプリの都合）
  const kohatsuExpireTimerRef = useRef<number | undefined>(undefined)
  // 南海トラフ地震関連解説情報（VYSE51/52）の7日間有効期限タイマー。
  // 解説情報には解除電文が無く、定例解説は平常時にも毎月届く。期限で畳まないと帯が常駐する。
  const nankaiCommentaryExpireTimerRef = useRef<number | undefined>(undefined)
  const quakeNoticeExpireTimerRef = useRef<number | undefined>(undefined)
  const earthquakeCountExpireTimerRef = useRef<number | undefined>(undefined)
  // イベントキュー: ディスパッチャーが 10ms ごとに、発火時刻の来たものを先頭から処理する。
  // リプレイ時は eventTime と再生時刻を比較して発火制御する（並びと取り出しの規約は `EventQueue`）。
  const eventQueueRef = useLazyRef<EventQueue>(createEventQueue)
  /**
   * ライブ接続を張り直すたびに進む番号。**時間軸が変わったことを、後から走る取得へ伝える。**
   *
   * 履歴の電文本体は最長で数分かけて届く（→ `services/telegramBody.ts` の取得間隔）。
   * その途中でリプレイが始まる・API キーが変わると、届いた電文は**別の時間軸の一覧**へ
   * 流し込まれることになる。接続 effect の中の `cancelled` はそのスコープに閉じていて
   * 「もっと見る」からは触れないため、共有できる形で持つ。
   */
  const liveGenerationRef = useRef(0)
  /** 現在の時間軸の履歴取得を打ち切る合図（接続 effect が世代と一緒に作り直す）。 */
  const liveHistoryAbortRef = useRef<AbortController | null>(null)
  const dmdataApiKeyRef = useRef(dmdataApiKey)
  dmdataApiKeyRef.current = dmdataApiKey
  // 「もっと見る」は依存を持たない `useCallback` なので、設定は ref で見る
  const dmdataTestDeliveryRef = useRef(dmdataTestDelivery)
  dmdataTestDeliveryRef.current = dmdataTestDelivery
  /**
   * 「もっと見る」が履歴を引くときの区分。接続 effect が、接続の取り決めが済んだ時点で書く
   * （→ `DmdataWebSocket.classificationsReady`）。取り決め前に押されたら既定の区分で引く。
   */
  const dmdataRestClassificationsRef = useRef<readonly DmdataClassification[]>(PREFERRED_CLASSIFICATIONS)
  /**
   * DMDSS 版の履歴の版の通し番号（`startRestFetches` が進める）。「もっと見る」が、取得の途中で
   * 取り直し（覚えた区分が外れていた）を挟んだかを見分ける。
   */
  const dmdataRestRunRef = useRef(0)
  /**
   * 進行中の DMDSS 版の履歴の取得が決着したら解ける約束（成否を問わない）。**「もっと見る」はこれを
   * 待ってからカーソルを読む** —— 待たずに読むと、後から終わった取り直しがカーソルを新しい側へ
   * 戻し、次の「もっと見る」が同じ窓を読み直す。
   */
  const dmdataHistorySettledRef = useRef<Promise<void>>(Promise.resolve())
  /**
   * 次に読む窓の上端（→ `HistoryCursor`）。**「もっと見る」のたびに古い方へ進める。**
   *
   * 初回の履歴を読み終えるまでは `null`。初回が読めなかった場合もそのままなので、
   * その状態で押されたら現在時刻から読み直す（＝初回と同じ範囲をもう一度試す）。
   */
  const historyCursorRef = useRef<HistoryCursor>(null)
  /**
   * 再生中の「もっと見る」で続きを読む口（→ `ReplayQuakeHistoryResult.loadMore`）。**再生中はこちらだけを使う。**
   *
   * リプレイの開始時の履歴（`restoreQuakeHistory`）が置き、押すたびに次の口へ差し替わる。`null` なら再生中は
   * 遡らない（ローカル履歴アーカイブ・在庫の端・履歴の取得に失敗した）。ライブの経路（`historyCursorRef`・
   * `p2pRawOffsetRef`）は読む先が `serverDate()`（いま）なので、再生中に使うと再生時刻より未来の地震が並ぶ。
   */
  const replayLoadMoreRef = useRef<ReplayQuakeHistoryResult['loadMore']>(null)
  /**
   * 再生の履歴の世代。`resetState` と `restoreQuakeHistory` で進める。押した時点の値と違えば、
   * 届いた続きは別の再生（または差し替わった履歴）のものなので捨てる。
   */
  const replayHistoryGenerationRef = useRef(0)
  /** 再生中の「もっと見る」の取得を打ち切る合図。`restoreQuakeHistory` が作り、`resetState` で立てる。 */
  const replayLoadMoreAbortRef = useRef<AbortController | null>(null)
  /**
   * いま再生中か（`replayTimeOffset` が決める。接続 effect が書く）。**「もっと見る」がライブの経路へ
   * 落ちないための判定に使う** —— 再生中に続きの口が無ければ、ライブの最新履歴を読まずに止める。
   */
  const replayActiveRef = useRef(replayTimeOffset !== null)
  // 通常版「もっと見る」用の生 API 取得件数（重複除去後の earthquakes.length とは別管理）
  // offset = earthquakes.length だと重複除去ズレで古いデータが抜け落ちるため、API 呼び出し回数ベースで管理する
  const p2pRawOffsetRef = useRef(0)
  /**
   * 初回履歴で**選から漏れた電文**（標準版）。次の「もっと見る」で、新しい取得分と一緒に畳む。
   *
   * **捨てると、その地震は一覧に二度と出ない。** `offset` は引いた電文の数だけ進むので、次の取得は
   * 漏れた電文より古いところから始まる。100 通に 51 地震以上が入る形＝**地震の多い期間ほど起きる**。
   */
  const p2pCarryOverRef = useRef<JMAQuake[]>([])

  // 予約の発火時刻は、リプレイ中でもそのまま使う。キューへ入るものはすべて再生時計の
  // 時間軸に乗っているため:
  //   - 過去の電文は loadReplayEvents が電文時刻で直接積む
  //   - 解除・失効の予約（EEW 最終報からの自動解除・津波の有効期限）は電文時刻か
  //     getTimeRef（=再生時刻）を起点に組み立てる
  //   - リプレイ中はライブ接続を張らないので、実時刻のイベントは入ってこない
  //     （下の接続 effect が replayTimeOffset !== null で早期 return する）
  //   - リプレイの開始・停止では resetState がキューを空にするため、ライブ中に積んだ
  //     予約が再生へ持ち越されることもない
  //
  // かつては「実時刻ベースの予約が擬似過去の now から見て未来になり永久滞留する」対策として、
  // リプレイ中だけ発火時刻を now へ潰していた（VAR-1）。ライブ接続を止める根治が入った後も
  // 潰しだけが残り、再生時間軸の予約まで受信直後に発火させていた（EEW は最終報の 9ms 後に
  // 自動解除され猶予が消える・津波は validDateTime を待たず即失効する）。リプレイ中もライブ
  // 接続を張る方針に戻すなら、一律で潰すのではなく予約ごとに時間軸を持たせること。

  // WebSocket 受信時のエントリポイント: event.time を基準にキューへ挿入する
  // live モードでは event.time ≈ now なので次のティック（最大 10ms 後）に即時発火する
  const enqueueEvent = useCallback((event: AppEvent, overrideTime?: Date) => {
    const parsed = overrideTime ?? new Date((event as { time?: string }).time ?? serverNow())
    // 日時として読めない時刻は `push` が捨てる（失敗モードは `EventQueue` の注記に集約）。
    // ここは捨てさせず、**現在時刻で代替して必ず流す**。ライブ受信の電文は画面に出ないと
    // 気づけないため、時刻が壊れていても「いま届いた」として扱うほうが害が小さい。
    const eventTime = Number.isFinite(parsed.getTime()) ? parsed : serverDate()
    // 電文ログの行は付けない。この口を通るのはライブ受信（`onLiveEvent`）で、行は
    // 受信側（`dmdata.ts`・`p2pquake.ts`）が既に積んでいる。
    eventQueueRef.current.push({ eventTime, payload: { kind: 'event', event }, logEntry: null })
  }, [])

  // 時刻ソースはアプリ時計(serverDate)に一元化。ライブ時はサーバー同期、
  // リプレイ時は clock.setReplayOffset により再生時刻を返すため差し替え不要。
  const getTimeRef = useRef<() => Date>(serverDate)

  // 南海トラフ地震関連解説情報を反映し、期限（発表から7日）で自動的に畳むタイマーを張り替える。
  // 反映できたら true を返す。
  //
  // 期限の判定に使う「いま」は getTimeRef（= clock の serverDate）。clock 側で再生オフセットを
  // 織り込んでいるため、過去日のアーカイブ再生でも「発表から7日」が再生時計の上で評価される
  // （serverNow() も同じオフセットを見るので両者に機能差はない。この hook 内の他のタイマーと
  // 時刻源を揃える意図でこちらを使う）。
  // 期限切れの電文を弾くのは、アーカイブ再生で流れてきた古い解説が帯として残らないようにするため。
  // 畳むときに id を照合するのは、待っている間に新しい解説へ入れ替わっていた場合に
  // そちらを消してしまわないため。
  /**
   * 南海トラフ臨時情報を帯へ反映する。
   *
   * **ライブ受信（WebSocket）とキュー（リプレイ・テストボタン）の両方から呼ぶこと。**
   * 同じ規則を 2 箇所に書くと片方だけ更新が漏れる ―― 実際に、取消の照合をキュー側だけに入れて
   * ライブ受信が素通りする状態を作った。関連解説情報（`applyNankaiCommentary`）と同じ形に揃える。
   *
   * @returns 帯へ反映したか。**取消は `false` でも呼び出し側が音と読み上げを起こす**（画面に出していない
   *   情報への取消も伝える。→ `decideDispatch`）。
   */
  const applyNankai = useCallback((nankai: JMANankai): boolean => {
    if (!nankai.cancelled) {
      shownNankaiEventIdRef.current = nankai.eventId
      setState(prev => ({ ...prev, nankai }))
      return true
    }
    // **照合するのは取消（`retracted`）だけ。**
    //
    // 「調査終了」は気象庁が調査の結果として発表する別の報で、臨時情報は**発表ごとに別の識別情報**を
    // 割り振る（実測。→ docs/spec/data-sources-spec.md §2 の表）。つまり段階の報と調査終了の報で
    // `EventID` は一致しない。ここを照合すると、**正常な調査終了で帯が永久に消えなくなる**。
    //
    // 取消は「その電文が指す情報単位」を取り消すので、対象と同じ識別情報を持つ（電文解説資料
    // Ⅰ.別紙ウ）。遅れて届いた古い取消が新しい段階の帯を消さないよう、そちらだけ照合する。
    if (nankai.retracted && shownNankaiEventIdRef.current !== nankai.eventId) {
      // 表示していない場合（記憶が空）もここへ来る。帯は触らない（音と読み上げは呼び出し側が起こす）。
      log.info(shownNankaiEventIdRef.current === null
        ? `[nankai] 表示していない情報単位への取消のため帯は触りません received=${nankai.eventId}`
        : `[nankai] 別の情報単位への取消のため帯を残します received=${nankai.eventId} shown=${shownNankaiEventIdRef.current}`)
      return false
    }
    shownNankaiEventIdRef.current = null
    setState(prev => ({ ...prev, nankai: null }))
    return true
  }, [])

  /**
   * 後発地震注意情報を帯へ反映する。失効の予約もここで持つ。
   * 呼ぶ場所と戻り値の意味は `applyNankai` に同じ。
   */
  const applyKohatsu = useCallback((kohatsu: JMAKohatsu): boolean => {
    // **期限タイマーは、この報を帯へ当てると決めてから止める。** 先に止めると、別の情報単位宛ての取消や
    // 期限切れの古い報が届いたとき、帯は残るのに表示中の報の期限だけが失われて居座る（お知らせと同じ）。
    const clearExpireTimer = () => {
      if (kohatsuExpireTimerRef.current !== undefined) {
        window.clearTimeout(kohatsuExpireTimerRef.current)
        kohatsuExpireTimerRef.current = undefined
      }
    }
    if (!kohatsu.cancelled) {
      const expireMs = new Date(kohatsu.expireAt).getTime() - getTimeRef.current().getTime()
      // **期限切れは出さない。** かつては取得側（`fetchDmdataKohatsu`）が期限切れを除いて
      // 返していたので、ここへは届かなかった。履歴をアーカイブ経由の 1 本へ寄せたことで
      // **遡り幅の中の最新 1 通がそのまま渡る**ようになり、期限切れも届く。
      // タイマーを張らないだけでは足りない —— 表示は出たまま、消える契機が 1 つも無くなる。
      //
      // 「日時が壊れている」と「正当に期限切れ」を同じ無言の false に潰さない
      // （解説情報・地震回数・お知らせと同じ方針）。
      if (!Number.isFinite(expireMs)) {
        log.warn('[data] 後発地震注意情報の期限を計算できません', kohatsu.expireAt)
        return false
      }
      if (expireMs <= 0) return false

      clearExpireTimer()
      kohatsuExpireTimerRef.current = window.setTimeout(() => {
        kohatsuExpireTimerRef.current = undefined
        shownKohatsuEventIdRef.current = null
        setState(prev => ({ ...prev, kohatsu: null }))
      }, expireMs)
      shownKohatsuEventIdRef.current = kohatsu.eventId
      setState(prev => ({ ...prev, kohatsu }))
      return true
    }
    // 照合は取消だけ（理由は `applyNankai`）。後発地震に「調査終了」相当の段階は無いが、
    // 判定の形を揃えておく ―― 片方だけ違う規則にすると、次に触る人がどちらが正しいか判らない。
    if (kohatsu.retracted && shownKohatsuEventIdRef.current !== kohatsu.eventId) {
      // 表示していない場合もここへ来る（理由は `applyNankai` の同じ箇所に同じ）
      log.info(shownKohatsuEventIdRef.current === null
        ? `[kohatsu] 表示していない情報単位への取消のため帯は触りません received=${kohatsu.eventId}`
        : `[kohatsu] 別の情報単位への取消のため帯を残します received=${kohatsu.eventId} shown=${shownKohatsuEventIdRef.current}`)
      return false
    }
    clearExpireTimer()
    shownKohatsuEventIdRef.current = null
    setState(prev => ({ ...prev, kohatsu: null }))
    return true
  }, [])

  const applyNankaiCommentary = useCallback((commentary: JMANankaiCommentary): boolean => {
    // 取消電文は帯を消す。**戻り値は帯を消したか**（他の帯と同じ）。音と読み上げは帯を消したかによらず
    // 起こす（解説情報の設定がオンの端末だけ。2026-10-22 ユーザー選択「設定を入れたときだけ鳴らし読む
    // (Recommended)」・2026-10-24 ユーザー選択「伝える (Recommended)」。→ `decideDispatch`）
    if (commentary.cancelled) {
      // 失効の予約と同じく、消す前に `id` を照合する（待っている間に新しい解説へ入れ替わって
      // いた場合にそちらを消さないため）。
      //
      // **`eventId` では足りない。** 臨時解説（VYSE51）は一連の期間で `eventId` が固定で、
      // 号数は `Serial` にしか出ない（→ docs/spec/data-sources-spec.md §2 の表）。`eventId` だけを
      // 比べると、連日届く別の号を同じものとして扱い、照合が素通りする。`id` は両方を含む。
      //
      // **`id` を要求しても正当な取消は弾かれない。** 取消電文の `Serial` は「直前の時点における
      // 最新の情報番号の値」と定められている（電文解説資料 Ⅰ.別紙ウ 2.）ので、帯に出している号
      // （＝最新号）と一致する。古い号を指す取消だけが弾かれる ―― それがここで防ぎたいもの。
      const shown = shownCommentaryIdRef.current
      if (shown !== commentary.id) {
        log.info(`[nankaiCommentary] 別の号への取消のため帯を残します received=${commentary.id} shown=${shown}`)
        return false
      }
      // **期限タイマーは号を照合した後で止める**（お知らせと同じ）。先に止めると、別の号への取消で
      // 帯は残るのに 7 日の期限だけが失われて居座る。
      if (nankaiCommentaryExpireTimerRef.current !== undefined) {
        window.clearTimeout(nankaiCommentaryExpireTimerRef.current)
        nankaiCommentaryExpireTimerRef.current = undefined
      }
      shownCommentaryIdRef.current = null
      setState(prev => ({ ...prev, nankaiCommentary: null }))
      return true
    }

    const remainMs = new Date(commentary.expireAt).getTime() - getTimeRef.current().getTime()
    // 「日時が壊れている」と「正当に期限切れ」を同じ無言の false に潰さない。前者はパーサや
    // 時刻シフト（testScenarioReplay）のバグを示すため記録を残す。
    if (!Number.isFinite(remainMs)) {
      log.warn('[data] 南海トラフ関連解説情報の期限を計算できません', commentary.expireAt)
      return false
    }
    if (remainMs <= 0) return false

    if (nankaiCommentaryExpireTimerRef.current !== undefined) {
      window.clearTimeout(nankaiCommentaryExpireTimerRef.current)
    }
    shownCommentaryIdRef.current = commentary.id
    setState(prev => ({ ...prev, nankaiCommentary: commentary }))
    nankaiCommentaryExpireTimerRef.current = window.setTimeout(() => {
      nankaiCommentaryExpireTimerRef.current = undefined
      if (shownCommentaryIdRef.current === commentary.id) shownCommentaryIdRef.current = null
      setState(prev => (
        prev.nankaiCommentary?.id === commentary.id ? { ...prev, nankaiCommentary: null } : prev
      ))
    }, remainMs)
    return true
  }, [])

  /**
   * 地震・津波に関するお知らせ（VZSE40）を反映する。
   *
   * 帯の扱いは南海トラフ関連解説情報とほぼ同じ（最新の 1 通・7 日で畳む・取消で消す）。
   * **7 日は表示上の都合**で、気象庁が期限を定めているわけではない（後発地震注意情報の帯の 7 日も同じ）。
   *
   * 戻り値は「画面の状態を変えたか」（帯を出した・取消で帯を消した）。呼び出し側は真のときだけ
   * `onLiveEvent` へ流す（読み上げるかは受け手が設定で決める）。偽なら流さず、録画向けの記録を
   * `notApplied` で残す —— 隣の `applyNankaiCommentary`・`applyKohatsu` と同じ形。
   *
   * **記録はこの関数の中で行わない。** かつてはお知らせだけが音も読み上げも持たず、この関数が
   * `notDispatched` を自分で記録する唯一の例外だった。読み上げを持った（設定で有効にしたとき）ので、
   * 他の帯と同じく呼び出し側が「流した／流さなかった理由」を記録する。
   */
  const applyQuakeNotice = useCallback((notice: JMAQuakeNotice): boolean => {
    if (notice.cancelled) {
      // 消す前に、取消が表示中のお知らせ宛てかを照合する（待っている間に新しいお知らせへ
      // 入れ替わっていたら、そちらを消さない）。
      //
      // **照合は `EventID` で行う。`id` ではない。** 取消は元のお知らせの `EventID` を引き継ぐ ——
      // 気象庁公式のサンプル（`jmaxml_20260723_Samples.zip` の `42_03_01_220402_VZSE40.xml`）は発表時刻が 2022-04-02 06:58 なのに
      // `EventID` は `20220402050100`（＝05:01）で、自分の発表時刻ではなく**取り消す対象の発表時刻**を
      // 指している（発表側のサンプルでは `EventID` ＝自分の発表時刻）。`id` には電文の作成時刻が
      // 入るので（→ `quakeNoticeId`）、発表と取消で一致しない。
      //
      // **同じ分に別のお知らせが出ていたら、どちら宛てかは電文から決められない。** 取消が持つのは
      // 分までの `EventID` だけで、元のお知らせの作成時刻は載らない。表示中の 1 通と分が一致すれば
      // 消す。**実配信の取消は未観測**（アーカイブの控えのお知らせ 605 通に 0 通。→ docs/spec/data-sources-spec.md §2
      // 「扱う電文種別」）なので、届いたら形を確かめること。
      //
      // **`EventID` が空の取消は照合しない。** 空どうしは「同じお知らせ」の証拠にならない
      // （パーサーは空を記録して通す）。
      const shown = shownQuakeNoticeRef.current
      if (shown == null) {
        log.info(`[quakeNotice] 表示中のお知らせが無いため取消を当てません received=${notice.eventId}`)
        return false
      }
      if (notice.eventId === '' || shown.eventId !== notice.eventId) {
        log.info(`[quakeNotice] 別のお知らせへの取消のため帯を残します received=${notice.eventId} shown=${shown.eventId}`)
        return false
      }
      // どのお知らせを消したかは記録に残す。同じ分に別のお知らせが出ていた場合、取消の本来の宛先とは
      // 別の 1 通を消した可能性があり、それは後から id を突き合わせないと分からない。
      log.info(`[quakeNotice] 取消で帯を消します eventId=${notice.eventId} shown=${shown.id} cancel=${notice.id}`)
      // **期限タイマーは id を照合した後で止める。** 先に止めると、別のお知らせ宛ての取消が届いたとき、
      // 表示中のお知らせの 7 日の期限だけが失われて帯が居座る。
      if (quakeNoticeExpireTimerRef.current !== undefined) {
        window.clearTimeout(quakeNoticeExpireTimerRef.current)
        quakeNoticeExpireTimerRef.current = undefined
      }
      shownQuakeNoticeRef.current = null
      setState(prev => ({ ...prev, quakeNotice: null }))
      // **取消しの理由（パーサーは `body` に読んでいる）は画面に出さない。** 取消では帯ごと消え、
      // 中身が運用連絡なので、消すためだけに帯を出し直すほどのものでもない。読み上げを有効にした
      // 端末では、理由は読み上げが伝える（→ `quakeNoticeToText`）。
      // **真を返す** —— 帯を消した（画面が変わった）ので、受け手へ流して取消を読ませる。
      return true
    }

    const remainMs = new Date(notice.expireAt).getTime() - getTimeRef.current().getTime()
    // 「日時が壊れている」と「正当に期限切れ」を同じ無言の false に潰さない（解説情報と同じ）。
    if (!Number.isFinite(remainMs)) {
      log.warn('[data] 地震・津波に関するお知らせの期限を計算できません', notice.expireAt)
      return false
    }
    if (remainMs <= 0) return false

    if (quakeNoticeExpireTimerRef.current !== undefined) {
      window.clearTimeout(quakeNoticeExpireTimerRef.current)
    }
    shownQuakeNoticeRef.current = { id: notice.id, eventId: notice.eventId }
    setState(prev => ({ ...prev, quakeNotice: notice }))
    quakeNoticeExpireTimerRef.current = window.setTimeout(() => {
      quakeNoticeExpireTimerRef.current = undefined
      if (shownQuakeNoticeRef.current?.id === notice.id) shownQuakeNoticeRef.current = null
      setState(prev => (prev.quakeNotice?.id === notice.id ? { ...prev, quakeNotice: null } : prev))
    }, remainMs)
    return true
  }, [])

  /**
   * 地震回数に関する情報（VXSE60）を反映する。
   *
   * 帯の扱いは南海トラフ関連解説情報・お知らせと同じ（最新の 1 通・7 日で畳む・取消で消す）。
   * **7 日は表示上の都合**で、気象庁が期限を定めているわけではない —— この情報に終わりの宣言は
   * 無く、群発が収まれば発表が止まるだけ。畳む契機を次報と取消だけにすると、収まったあとも
   * 帯が居座る。
   *
   * **区間も本文も無い報は反映しない。** 中身が空の帯を出しても伝わるものが無く、
   * 読み取りの失敗はパーサー側が記録している。**回数を伴わない発表報（区間が 0 件で本文
   * `body` だけを運ぶ）は反映する** —— 帯の見出しは種別名、開くと本文（2026-10-19 ユーザー承認
   * 「-1 を「発表なし」に (推奨)」）。
   */
  const applyEarthquakeCount = useCallback((count: JMAEarthquakeCount): boolean => {
    if (count.cancelled) {
      // 取消は id ではなく eventId で照合する。回数情報は同じ群発について報を重ねるので、
      // 取消が指すのは「その群発について直前に出した報」＝いま出している報になる。
      if (shownEarthquakeCountEventIdRef.current !== count.eventId) {
        log.info(`[earthquakeCount] 別の群発への取消のため帯を残します received=${count.eventId} shown=${shownEarthquakeCountEventIdRef.current}`)
        return false
      }
      if (earthquakeCountExpireTimerRef.current !== undefined) {
        window.clearTimeout(earthquakeCountExpireTimerRef.current)
        earthquakeCountExpireTimerRef.current = undefined
      }
      shownEarthquakeCountEventIdRef.current = null
      setState(prev => ({ ...prev, earthquakeCount: null }))
      // **true を返す。** 読み上げ側が「取り消された」ことを伝えるため。false にすると
      // 取消がどこへも流れず、直前に読み上げた回数が訂正されないまま残る。
      return true
    }
    if (count.items.length === 0 && !count.body) return false

    const remainMs = new Date(count.expireAt).getTime() - getTimeRef.current().getTime()
    // 「日時が壊れている」と「正当に期限切れ」を同じ無言の false に潰さない（解説情報と同じ）。
    if (!Number.isFinite(remainMs)) {
      log.warn('[data] 地震回数に関する情報の期限を計算できません', count.expireAt)
      return false
    }
    if (remainMs <= 0) return false

    if (earthquakeCountExpireTimerRef.current !== undefined) {
      window.clearTimeout(earthquakeCountExpireTimerRef.current)
    }
    shownEarthquakeCountEventIdRef.current = count.eventId
    setState(prev => ({ ...prev, earthquakeCount: count }))
    earthquakeCountExpireTimerRef.current = window.setTimeout(() => {
      earthquakeCountExpireTimerRef.current = undefined
      if (shownEarthquakeCountEventIdRef.current === count.eventId) shownEarthquakeCountEventIdRef.current = null
      setState(prev => (prev.earthquakeCount?.id === count.id ? { ...prev, earthquakeCount: null } : prev))
    }, remainMs)
    return true
  }, [])

  /**
   * 推計震度分布図（IXAC41）を反映する。**地震ごとに 1 通**を持つ（→ `upsertEstimatedIntensity`）。
   *
   * **古い報で退行させない。** 同じ地震について続報が出る（実電文で M7.4 → M7.6 の 6 分後、
   * セル数も変わった）うえ、DMDATA は内容が同一の重複配信もする。到着順が入れ替わったときに
   * 古い分布へ戻ると、画面が理由もなく前の姿へ巻き戻る。判定は**同じ地震どうしの発表時刻の比較**
   * で行う ——この電文は `eventId` を持たないので報番号の台帳が作れない。
   *
   * **別の地震の分布は置き換えずに足す。** 前の地震のカードは自分の分布を出し続ける。
   *
   * **初報か続報かを併せて返す。** 読み上げが「受信しました」と「更新されました」を言い分ける
   * のに要る（→ `isNewEstimatedIntensity`）。判定に使う台帳はここが持っているので、受け取る側で
   * 数え直すことはできない。
   *
   * @param announce 音・読み上げを伴うか。偽（初期状態の注入）なら台帳へ積まない
   * @returns 反映したら初報かどうか。反映しなかったら null
   */
  const applyEstimatedIntensity = useCallback((
    data: JMAEstimatedIntensity, announce: boolean,
  ): { isNew: boolean } | null => {
    // **判定は ref で同期に行う。** `setState` の更新関数の中で判定すると、React が
    // 開発時に更新関数を二度呼ぶため副作用が二重になり、しかも呼び出し元へ結果を返せない
    // （更新が後回しになりうる）。地震回数の帯が同じ理由で ref を持っている。
    // 判定は純関数へ切り出してある（`upsertEstimatedIntensity`）。地震ごとに 1 通を保つ規則と
    // 「同じ地震の古い報では退行しない」規則をテストで固定したいため。
    const { list, update } = upsertEstimatedIntensity(estimatedIntensitiesRef.current, data)
    if (update.reason === 'stale') {
      log.info(`[ixac41] 同じ地震の、発表が古い報なので反映しません received=${data.time}/${data.arrivalTime}`)
      return null
    }
    if (!update.apply) return null
    estimatedIntensitiesRef.current = list
    setState(prev => ({ ...prev, estimatedIntensities: list }))
    // 初報か続報かは**台帳**で決める。`update.reason` では決められない —— 履歴から黙って
    // 取り込んだ分布も「持っている」側に入るので、まだ伝えていない地震の分布が `newer` になる。
    const isNew = isNewEstimatedIntensity(shownEstimatedIntensityArrivalsRef.current, data.arrivalTime)
    if (announce) rememberShownEstimatedIntensity(shownEstimatedIntensityArrivalsRef.current, data.arrivalTime)
    return { isNew }
  }, [])

  /**
   * 取消を見た事実を台帳へ積む。件数に上限を置き、古いものから落とす。
   *
   * 上限を置くのは、長時間つないだままの端末で無制限に伸びるのを避けるため。**判定は毎回全件を
   * 走査する**ので、伸びると受信ごとの処理も重くなる。取り下げ済みの報が届くのは順序の
   * 入れ替わりか誤認識なので、直近の取消だけ覚えていれば足りる。
   */
  // 重複の排除と上限の管理は `addQuakeRetraction` が持つ（そちらに理由とテストがある）
  const rememberQuakeRetraction = useCallback((retraction: QuakeRetraction) => {
    addQuakeRetraction(quakeRetractionsRef.current, retraction, MAX_QUAKE_RETRACTIONS)
  }, [])

  /** 履歴バッチに含まれる取消電文を台帳へ取り込む（ライブ経路と記憶を共有するため）。 */
  const rememberQuakeRetractionsFromBatch = useCallback((quakes: readonly JMAQuake[]) => {
    for (const q of quakes) {
      if (q.cancelled) rememberQuakeRetraction(quakeRetractionOf(q))
    }
  }, [rememberQuakeRetraction])

  /**
   * 据え置き判定に使う既存カードを引く。**同じティックで受理した写しを先に見る。**
   *
   * `stateRef` はレンダー時にしか進まないので、それだけを見ると同じティックで捌かれた直前の報を
   * 反映できない（理由と、継ぎ足しで埋めようとして失敗した経緯は `pendingQuakeCardsRef`）。
   */
  /**
   * 震度を持たない電文（VXSE52/53）を、震度速報の震度で補う。
   *
   * **統合側と据え置き判定側で同じ述語を通す。** 補完の有無で `hasIntensity(incoming)` が
   * 変わり、`quakeHoldBack` はそこで判定軸を切り替える（実震度を持つなら発表時刻・
   * 持たないなら種別優先度）。片方だけ補完すると、**同じ電文について統合は受け入れ・判定は
   * 据え置きと答える**形でずれる。
   */
  const fillIntensityFromCache = useCallback((quake: JMAQuake): JMAQuake => {
    if (quake.earthquake.maxScale >= 0 || quake.points.length > 0) return quake
    const cached = quakeIntensityCacheRef.current.get(quakeEventKey(quake))
    if (!cached) return quake
    // **補ったことに印を付ける**（`intensityFromCache`）。補った電文はそのままカードの控え
    // （`sourceTelegrams`）へ積まれるので、元の震度速報が取り消されたとき、当て直しがこの印を
    // 見て補った震度を外す（→ `quakeMerge.ts` の `applyQuakeCancelToCard`）。
    return {
      ...quake,
      earthquake: { ...quake.earthquake, maxScale: cached.maxScale },
      points: cached.points,
      intensityFromCache: true,
    }
  }, [])

  const findQuakeCardForHoldBack = useCallback((quake: JMAQuake, index: AreaPrefIndex) => {
    const pending = pendingQuakeCardsRef.current
    // **写しにその地震が載っているなら、そちらで完結させる**（`?? stateRef` へ落とさない）。
    // 取消済みとして載っている場合、`findExistingQuakeCard` はそれを候補から外して `undefined`
    // を返す —— そこで `stateRef` へ落ちると**取消前のカードを拾う**ことになり、この写しを
    // 置いた理由そのものが消える。
    if (pending.some(c => sameQuakeEntry(c, quake, index))) {
      return findExistingQuakeCard(pending, quake, index)
    }
    return findExistingQuakeCard(stateRef.current.earthquakes, quake, index)
  }, [])

  /**
   * 受理した電文を、同じティックの写し（`pendingQuakeCardsRef`）へ載せる。
   *
   * **取消も載せる。** 取消済みのカードは `findExistingQuakeCard` が候補から外すので、以後の
   * 判定は「既存カードなし」＝据え置かない側へ倒れる。統合側（`setState` の中）も取消済みの
   * カードを外して**別カードとして立てる**ので、両者の見え方が揃う。
   *
   * **統合と同じ述語（`mergeQuakeInto`）を通す。** 生の電文をそのまま載せると、続報で上書き
   * するときの引き継ぎ（§6.4。震度速報に震源要素は無い等）が反映されず、`hasIntensity` の
   * 見え方が統合側とずれる。
   */
  const trackPendingQuakeCard = useCallback((existing: JMAQuake | undefined, quake: JMAQuake, index: AreaPrefIndex) => {
    // 取消は「対象のカードを取消済みにする」だけ。**対象の絞り込みは統合側と同じ述語
    // （`isQuakeCancelTarget`）を通す** —— `sameQuakeEntry` だけで当てると、種別の違う取消報
    // （遠地地震は VXSE53 を共有する）が無関係なカードを取消済みにして、直後の続報の判定が
    // 「取消済みだから受け入れる」側へ誤って倒れる。**探し方まで揃える**（下の `canceled`）。
    //
    // **`cancelledAt` の値は真偽としてしか読まれない**（`findExistingQuakeCard` も
    // `quakeHoldBack` も有無だけを見る）。写しは次のレンダーで捨てるので、リプレイ時計に
    // 乗せる意味も無い —— それでも時計を揃えるのは、値を読む経路が増えたときに壁時計が
    // 混ざらないようにするため。
    // **取消の対象は `existing` を流用せず、統合側と同じ探し方で選ぶ。** `existing` は据え置き
    // 判定のために `findExistingQuakeCard` で引いたもので、`sameQuakeEntry` の一致だけを見て
    // **発表時刻がいちばん早い 1 枚**を返す（種別は見ない）。`sameQuakeEntry` で一致するカードが
    // 2 枚並ぶ状態（暫定 ID と確定 ID。→ `coalesceByEventId`）では、**早い方が取消対象でないと
    // 写しに何も載らない** —— 直後に同じティックで届く電文の判定が、取消済みのカードを
    // 「まだ生きている既存」として見ることになる。
    const canceled = quake.cancelled
      ? findQuakeCancelTarget(pendingQuakeCardsRef.current, quake, index)
        ?? findQuakeCancelTarget(stateRef.current.earthquakes, quake, index)
      : undefined
    // 取消の当て方も統合側と同じ（`applyQuakeCancelToCard`）。一部の取消なら写しも当て直した
    // カードにする —— 取消済みと載せると、直後の続報の判定が「取消済みだから受け入れる」側へ倒れる。
    const effect = quake.cancelled && canceled
      ? applyQuakeCancelToCard(canceled, quake, quakeRetractionsRef.current, index)
      : undefined
    const card = quake.cancelled
      ? (effect?.kind === 'partial' ? effect.card
        : effect?.kind === 'whole' && canceled ? { ...canceled, cancelledAt: getTimeRef.current() } : undefined)
      // 記録は統合側（`setState` の中）が出す。ここで出すと同じ電文について二重に残る。
      : mergeQuakeInto(existing, quake, { quiet: true })
    if (!card) return
    const list = pendingQuakeCardsRef.current
    const at = list.findIndex(c => sameQuakeEntry(c, card, index))
    if (at < 0) list.push(card)
    else list[at] = card
  }, [])

  /**
   * その地震情報を**地震カードが採らないか**（据え置くか）。真なら音・読み上げ・ウィンドウ
   * タイトル・自動タブ切替を起こさない（→ {@link LiveEventMeta.quakeHeldBack}。何を止めるかは
   * 受け取る側が決める）。
   *
   * **判定は `quakeHoldBack` を統合側と共有する**（写しを持たない）。実例: 2024-11-26
   * 22:47 の大阪府北部（完全版・最大震度1）の 55 秒後に、1 分後に起きた石川県西方沖の揺れが
   * 紛れ込んだ震度速報（福井県嶺南・滋賀県北部の震度3）が同じ EventID で届く。カードは
   * 据え置いていたのに、読み上げだけが「新たに最大震度3を…観測しました」と言い、ウィンドウ
   * タイトルも「最大震度3」へ変わっていた。
   * → docs/spec/quake-spec.md §6.3「据え置いた電文は、音・読み上げ・タイトル・タブ移動・選択・
   * 分布モードのクローズも起こさない」
   *
   * **既存カードは同じティックの写しから引く**（`findQuakeCardForHoldBack`）。`stateRef` だけを
   * 見ると鮮度が足りず、取消を処理した直後に**取消前のカードを既存として拾って**「画面には
   * 新しいカードが出ているのに声だけ止まる」逆向きの食い違いを作る。
   */
  const isQuakeReportHeldBack = useCallback((existing: JMAQuake | undefined, quake: JMAQuake, retracted: boolean): boolean => {
    // **統合側がその報を採らない門は 2 つある。** 片方だけを見ると、もう片方で捨てられた電文が
    // 音・読み上げ・タイトル・タブ移動だけを動かす（→ docs/spec/quake-spec.md §6.3
    //「カードが採らない門は 2 つ」）。
    //
    // ① 取消より前に発表された報（§6.2）。**`existing` を見ても分からない** —— 対象カードは
    //    取消済みなので `findExistingQuakeCard` が候補から外し、`existing` は `undefined` に
    //    なる。そのまま「据え置かない」へ倒すと、**画面には何も出ないのに声だけが鳴る**。
    //    判定は統合側と同じ述語をそのまま使う（狭い条件＝種別一致・同じ地震・取消以前を持って
    //    いる。ここを「取消を見たか」へ広げると、取消を経験した地震で以後ずっと黙る）。
    //    **判断は受け取るだけ**（`retracted`）—— 入口で 1 回決めて、写しの更新と状態更新にも
    //    同じ値が渡る（理由は `handleEvent` の `quakeRetracted`）。
    if (retracted) {
      log.info('[quake] 取消以前に発表された報なので音・読み上げ・タイトル・タブ移動を起こさない', {
        incomingId: quake.id, incomingType: quake.issue.type, incomingTime: quake.time,
      })
      return true
    }
    // ② 据え置き（`quakeHoldBack`）。
    if (!existing) return false
    const held = quakeHoldBack(existing, quake)
    if (!held) return false
    // **記録するかも述語が決める**（`notable`）。ここで条件を書き下すと統合側の絞り込みを
    // 書き写すことになり、片方だけ古くなったときにこちらの記録だけが溢れる。
    if (held.notable) {
      log.info('[quake] カードが採らない電文なので音・読み上げ・タイトル・タブ移動を起こさない', {
        reason: held.reason, incomingId: quake.id, incomingType: quake.issue.type,
        existingType: existing.issue.type,
        droppedMaxScale: quake.earthquake.maxScale, droppedPoints: quake.points.length,
      })
    }
    return true
  }, [])

  /**
   * **特別警報だった印（`everSpecialWarning`）だけを、表示中の速報へ移す**（→ eew-spec.md §4「特別警報の下げ止まり」）。
   * 起動時・張り直しの復元は、詳細の全報から「途中で特別警報だった」を載せてくる（`fetchDmdataActiveEews`）。取得の間に
   * ライブの新しい報が先に着くと、復元の報は古い報として捨てられ（入口の古い報の判定・張り直しの報番号の絞り込み）、印も
   * 一緒に消える —— 印は報ではなく地震についての事実なので、報を捨てても印は残す。音・読み上げ・タブ移動は起こさない
   * （報としては採っていない）。取り消された速報・表示から消えた速報には付けない
   */
  const carryEverSpecialWarning = useCallback((key: string, from: string): void => {
    const previous = eewLatestRef.current.get(key) ?? stateRef.current.activeEEWs.get(key)
    if (!previous || previous.everSpecialWarning || previous.cancelled || previous.cancelledAt) return
    if (eewLatestRef.current.has(key)) eewLatestRef.current.set(key, { ...previous, everSpecialWarning: true })
    setState(prev => {
      const existing = prev.activeEEWs.get(key)
      if (!existing || existing.everSpecialWarning || existing.cancelledAt) return prev
      return { ...prev, activeEEWs: new Map(prev.activeEEWs).set(key, { ...existing, everSpecialWarning: true }) }
    })
    log.debug(`[eew] 報は採らず、特別警報だった印だけ移した: key=${key}（${from}）`)
  }, [])

  const handleEvent = useCallback((rawEvent: AppEvent) => {
    // 標準版の訓練報・試験報は、設定「試験報を受信」が真なら印を付けて普通の報として流す（→ `admitTrainingEew`）。
    // 入口の最初で決める —— 下の判定・状態・読み上げ・通知が同じ 1 つの値を見るように。
    const event: AppEvent = rawEvent.kind === 'eew' ? admitTrainingEew(rawEvent, dmdataTestDeliveryRef.current) : rawEvent
    // 古い報は**入口で**捨てる。この下の通知（読み上げ・ウィンドウタイトル）と自動解除の予約は
    // setState の外で走るため、状態更新の直前で弾いても間に合わない。地図・カードだけが新しい報を
    // 保ち、読み上げとタイトルが古い報で上書きされる——画面と音声が食い違う方が始末が悪い。
    // 取消・失効・テスト報は報番号に関わらず通す（弾くと誤報を消せなくなる）。
    //
    // **統合も入口で 1 回だけ行う**（`mergeEewReport`）。状態に入れる値と、読み上げ・通知へ渡す値を
    // 同じものにするため —— かつては状態だけが統合され、読み上げには届いた電文がそのまま渡っていた
    // （Yahoo の続報は区域も仮定震源の別も持たないので、P2PQuake が運んだ値が声から消えていた）。
    let eewMerged: EEWAlert | undefined
    // 別の経路から既に受けて知らせた報と同じ報か（→ `LiveEventMeta.eewSameReport`）。
    let eewSameReport = false
    // 別の経路が先に運んだ新しい報へ、遅れて届いた P2PQuake の報の区域・仮定震源の別だけを補ったか
    // （→ `supplementEewReport`）。状態側でも同じ補い方をする。
    let eewSupplement = false
    // 取消の前に画面から消えた（自動解除された）地震へ届いた誤報取消（→ `isLateEewCancel`・`LiveEventMeta.eewLateCancel`）。
    // 立てば読み上げ側へ印を渡し、状態側は最後の報（`eewLateCancelBase`）に取消を載せて 10 秒だけ戻す
    let eewLateCancel: LiveEventMeta['eewLateCancel']
    let eewLateCancelBase: EEWAlert | undefined
    if (event.kind === 'eew') {
      const incoming = event as EEWAlert
      const key = eewEventKey(incoming)
      if (!incoming.cancelled && !incoming.expired && !incoming.test) {
        const acceptance = eewAcceptanceRef.current.get(key)
        const staleness = eewStaleness(acceptance, incoming)
        const previous = eewLatestRef.current.get(key) ?? stateRef.current.activeEEWs.get(key)
        if (previous?.cancelled || previous?.cancelledAt) {
          // **取消は終端**（状態側と同じ。docs/spec/eew-spec.md §10）。入口で止めないと、状態は無視するのに
          // 音・通知が鳴り、見張りの解除も積まれる。
          log.debug(`[eew] 取消済みの速報へ届いた報を破棄: key=${key} 経路=${incoming.origin}`
            + ` 受信=#${eewSerial(incoming) ?? '(なし)'}`)
          recordSkippedTelegram(incoming, 'notApplied')
          return
        }
        // **画面から消えた地震の報は採らない**（→ `eewEndedRef`・`endedEewMatch`）。台帳と写しは消えた時点で捨てるので、
        // 消えた後に届いた同じ報・古い報は上の比べ方では「新しい報」に見え、終わった速報が音と読み上げごと戻る
        // （標準版の Yahoo は、一覧から 2 回続けて欠けた項目が戻ると同じ報を出し直す）。取消で終えた地震は
        // 報番号によらず採らない（取消は終端）。2026-10-21 ユーザー承認「おすすめで」
        if (!acceptance && !previous && skipEndedEew(eewEndedRef.current, incoming, 'ライブの受信')) {
          recordSkippedTelegram(incoming, 'notApplied')
          return
        }
        // **自動解除の時刻を過ぎた報も採らない**（→ `skipExpiredEew`）。消えた地震の記憶はリセットで捨てるので、
        // 差分を見る処理を作り直した直後に Yahoo の一覧に残る最終報が届くと、上の判定では止まらない。
        // **画面に出ている地震には掛けない** —— 出ている地震は最終報（自動解除の予約）か取消で終わるので、
        // 古い時刻の続報を入口で落とすと、続報が運ぶ値が届かないだけになる。
        // **静かに積まれた報（`isSilentRef`）にも掛けない** —— 起動時・張り直しの復元とリプレイの初期状態で、
        // 鳴らないうえ、古さは取得側が判定している（`selectActiveEews`）。ここで落とすと、復元した側は読み上げの記憶と
        // タブ移動を「戻した」つもりで進め、画面だけが空になる。
        if (!acceptance && !previous && !isSilentRef.current && skipExpiredEew(incoming, 'ライブの受信')) {
          recordSkippedTelegram(incoming, 'notApplied')
          return
        }
        // 第 1 報の時刻を覚える（一度覚えたら変えない。→ `eewFirstIssueTimeRef`）
        rememberEewFirstIssueTime(eewFirstIssueTimeRef.current, key, incoming)
        if (staleness === 'olderFromOtherOrigin' && incoming.origin === 'p2pquake' && previous) {
          // **捨てない。** Yahoo は 1 秒ごとに取りに行くので、速報が続くあいだは P2PQuake の報が
          // Yahoo の次の報より後に着くことがある。捨てると区域と仮定震源の別が一度も入らない。
          // 震源・震度・報番号は新しい側のまま。新しい報ではないので音・タブ移動は起こさない
          // （区分や予想の最大震度が上がったときだけ知らせる。2026-10-19 ユーザー承認・選んだ選択肢「上がったときだけ鳴らす」）。
          eewMerged = supplementEewReport(previous, incoming)
          eewSupplement = true
          eewSameReport = !raisesEewAlert(eewMerged, previous)
          eewAcceptanceRef.current.set(key, acceptEewReport(acceptance, incoming))
          eewLatestRef.current.set(key, eewMerged)
          log.debug(`[eew] 遅れて届いた P2PQuake の報で区域・仮定震源を補った: key=${key}`
            + ` 受信=#${eewSerial(incoming) ?? '(なし)'}/${eewIssueTimeMs(incoming) ?? '(なし)'}`
            + ` 受理済み=${acceptance?.latestIssueMs ?? '(なし)'}`)
        } else if (staleness !== 'fresh') {
          // 順序の入れ替わり自体は想定内だが、判定が誤り続けるとその EEW は以降更新されない。
          // 捨てた事実が残らないと原因に辿り着けないため記録する（頻度は 1 地震あたり数件）。
          log.debug(`[eew] 古い報を破棄: key=${key} 経路=${incoming.origin}`
            + ` 受理済み=#${acceptance?.serialByOrigin.get(incoming.origin) ?? '(なし)'}/${acceptance?.latestIssueMs ?? '(なし)'}`
            + ` 受信=#${eewSerial(incoming) ?? '(なし)'}/${eewIssueTimeMs(incoming) ?? '(なし)'}`)
          recordSkippedTelegram(incoming, 'staleSerial')
          // 報は捨てても、運んできた特別警報の印だけは移す（→ `carryEverSpecialWarning`）
          if (incoming.everSpecialWarning) carryEverSpecialWarning(key, `入口で古い報として捨てた報 経路=${incoming.origin}`)
          return
        } else {
          eewMerged = mergeEewReport(previous, incoming)
          // **区分や予想の最大震度が上がった報は「同じ報」として黙らせない**（上がったこと自体を知らせる）。
          // 同じ秒に別の報が出ることがある（能登本震の実配信で 46 報中 13 報）ので、秒だけでは
          // 「同じ報」と言い切れない —— 値が上がっていれば知らせる側へ倒す。
          eewSameReport = previous !== undefined
            && isSameReportFromOtherOrigin(acceptance, incoming)
            && !raisesEewAlert(eewMerged, previous)
          if (eewSameReport) {
            log.debug(`[eew] 別の経路から受けた同じ報のため音・タブ移動を止める: key=${key} 経路=${incoming.origin}`
              + ` 発表=${eewIssueTimeMs(incoming) ?? '(なし)'}`)
          }
          const accepted = acceptEewReport(acceptance, incoming)
          eewAcceptanceRef.current.set(key, eewSameReport ? accepted : noteEewNotified(accepted, incoming))
          eewLatestRef.current.set(key, eewMerged)
        }
      } else if (incoming.expired || incoming.test) {
        // 自動解除は、消えた地震の記憶をこの場で書く（effect でも書くが、それを待つと同じティックに続けて届いた誤報取消を
        // 「消えた後の取消」と見分けられない。2026-10-22 ユーザー承認「直す (Recommended)」）。取消で終えた地震は対象外
        if (incoming.expired) {
          const shown = eewLatestRef.current.get(key) ?? stateRef.current.activeEEWs.get(key)
          const acceptance = eewAcceptanceRef.current.get(key)
          if (shown && acceptance && !shown.cancelled && !shown.cancelledAt) {
            const { cancelledAt: _cancelledAt, ...lastReport } = shown
            eewEndedRef.current.set(key, mergeEndedEew(
              eewEndedRef.current.get(key), acceptance, false, serverNow(), lastReport, eewFirstIssueTimeRef.current.get(key),
            ))
            eewExpiringRef.current.add(key)
          }
        }
        // 状態側がこの EEW を消す。写しを残すと、同じ地震の報がまた届いたときに消えた値を土台にする。
        eewLatestRef.current.delete(key)
      } else if (incoming.cancelled) {
        // 写しにも取消を載せる。取消前の値のまま残すと、同じティックに遅れて届いた報を入口が通してしまう。
        const latest = eewLatestRef.current.get(key)
        if (latest) eewLatestRef.current.set(key, { ...latest, cancelled: true })
        // 画面から消えた後に取消が届いたら、消えた地震の記憶にも取消を載せる（載せないと、その後に届いた新しい
        // 報番号の報が「続いている速報」として通る）。**誤報取消なら、普通の誤報取消と同じく伝える** —— 自動解除の後に
        // 本物の取消が届くことがあり、通知だけでは「さっきの速報は誤りだった」が画面にも声にも出ない
        // （2026-10-21 ユーザー承認「直す (Recommended)」）。同じ取消が別の経路から遅れて届いても、記憶に取消が
        // 載っているので 2 度は伝えない
        const ended = eewEndedRef.current.get(key)
        const gone = !stateRef.current.activeEEWs.has(key) || eewExpiringRef.current.has(key)
        if (ended && !ended.cancelled && !latest && gone) {
          const sinceEndedSec = Math.round((serverNow() - ended.endedAtMs) / 1000)
          if (isLateEewCancel(ended, incoming, serverNow(), ACTIVE_EEW_WINDOW_MS)) {
            eewLateCancelBase = ended.lastReport
            eewLateCancel = {
              firstIssueTime: ended.firstIssueTime,
              hypocenterName: ended.lastReport.earthquake.hypocenter.name,
            }
            log.info(`[eew] 画面から消えた後に届いた誤報取消: 最後の報に取消を載せて 10 秒戻し、読み上げ側へ印を渡す key=${key}`
              + ` 経路=${incoming.origin} 消えてから=${sinceEndedSec}秒`)
          } else if (!incoming.expired) {
            // 伝えなかった理由を残す（窓切れ・時計の巻き戻り・最後の報が無い）。残さないと「遅れた取消が声にならない」を切り分けられない
            log.debug(`[eew] 画面から消えた地震の誤報取消は通知だけにする: key=${key} 経路=${incoming.origin}`
              + ` 消えてから=${sinceEndedSec}秒 最後の報=${ended.lastReport ? 'あり' : 'なし'}`)
          }
          eewEndedRef.current.set(key, { ...ended, cancelled: true })
        }
      }
      // 取り消された・消えた速報の見張りは要らない（写しは取消前の値のままなので、見張りの側では見分けられない）。
      if (incoming.cancelled || incoming.expired) eewWatchReceiptsRef.current.delete(key)
    }
    // 地震情報は**入口で**「カードが内容を採るか」を見て、採らない電文では音・読み上げ・
    // ウィンドウタイトル・自動タブ切替を起こさない。理由は上の EEW と同じ ——「地図・カードだけが
    // 新しい報を保ち、読み上げとタイトルが別の報で上書きされる」状態を作らないため。
    //
    // **`onLiveEvent` を呼ばない形にはしない。** 止めたいのはその 4 つだけで、カードの選択・
    // 震度分布モードを閉じること・「この報は見た」の記録は、カードが内容を採ったかどうかと
    // 無関係に要る（分布モードは §9 が「その地震の電文を受けたら閉じる」「種別で絞らない。
    // 手で開いた分も閉じる」と定めている）。印だけを渡し、何を止めるかは受け取る側が決める。
    //
    // **判定が投げても本体を止めない。** ここは `setState` より手前で、しかも呼び出し元
    // （キューのディスパッチャ・WebSocket の受信）は例外を受け止めない。投げると状態更新まで
    // 到達せず**その電文が画面からも丸ごと消える**（例外は `globalErrorLog` に残るだけで、画面には
    // 何も起きない）。従来どおり通知する側へ倒して記録を残す。
    //
    // **判定と写しの更新で受け止めを分ける。** 1 つの `try` にまとめると、判定が済んだあとに
    // 写しの更新だけが投げたときに**確定していた「据え置く」を握り潰す**（記録の文面も嘘になる）。
    // 逆に写しが更新できなかったことは、同じティックで続く電文の判定が画面の状態（レンダー待ち
    // で古い）へ落ちることを意味するので、そちらも別の言葉で残す。
    // **震度の補完は入口で 1 回だけ行い、判定と統合が同じ値を見る。** あの補完は
    // `hasIntensity(incoming)` を変え、据え置き判定はそこで判定軸を切り替える（実震度を持つなら
    // 発表時刻・持たないなら種別優先度）。**`setState` の更新関数はレンダー時に走る**ので、
    // 中で補完し直すと「判定は補完前・統合は補完後」の組み合わせが起きる —— 同じティックで
    // 震源情報のあとに震度速報が捌かれると、震度速報の書き込みが両者のあいだに挟まる。
    const filledQuake = event.kind === 'quake' ? fillIntensityFromCache(event) : undefined
    /**
     * **その電文を状態がそもそも受理しないか**（取消より前に発表された報。→ §6.2）。
     *
     * **入口で 1 回だけ決め、この報を扱う 3 か所すべてが共有する** —— 据え置き判定・同じ
     * ティックの写しの更新・状態更新。**別々に呼ぶ形にしない**: 同じ判断が 3 か所へ分かれて
     * いて、**写しの更新だけがこの門を通っていなかった** ―― 取消より前に発表された報が写しの
     * 取消済みカードを未取消カードで上書きし、そのあとに届いた正規の再発表が汚染された写しを
     * 既存として見て据え置き扱いになる（画面には新しいカードが出るのに声だけ止まる）。
     */
    const quakeRetracted = filledQuake !== undefined
      && isRetractedQuakeReport(quakeRetractionsRef.current, filledQuake, getAreaPrefIndexCache())
    // 取消と同じ時刻だったために捨てる報なら、その取消もここで決める。**更新関数の中で台帳を
    // 読み直さない**（理由は `quakeRetracted` と同じ。読み直すと別の時点の台帳で判定が食い違う）。
    const quakeRetractionTie = quakeRetracted && filledQuake !== undefined
      ? findRetractionTie(quakeRetractionsRef.current, filledQuake, getAreaPrefIndexCache())
      : undefined
    let quakeHeldBack = false
    let quakeCancel: LiveEventMeta['quakeCancel']
    if (event.kind === 'quake') {
      const index = getAreaPrefIndexCache()
      const quake = filledQuake ?? event
      // 取消がどのカードにどう効くかを、写しを進める前に決める（→ `LiveEventMeta.quakeCancel`）。
      // 探し方と当て方は写し・状態更新と同じ（`findQuakeCancelTarget`・`applyQuakeCancelToCard`）。
      if (event.cancelled) {
        try {
          // **写しにその地震が載っているなら写しで完結させる**（`findQuakeCardForHoldBack` と同じ）。
          // 写しで当たらなかったからと画面の状態へ落ちると、同じティックで先に当てた取消の前の姿
          // （取り下げた報がまだ控えに残るカード）を拾い、2 通目の取消が「一部の取消」を名乗る。
          const pending = pendingQuakeCardsRef.current
          const target = pending.some(c => sameQuakeEntry(c, quake, index))
            ? findQuakeCancelTarget(pending, quake, index)
            : findQuakeCancelTarget(stateRef.current.earthquakes, quake, index)
          const effect = target ? applyQuakeCancelToCard(target, quake, quakeRetractionsRef.current, index) : undefined
          // 台帳に当たる取消（`quakeRetracted`）は、同じ取消か同じ種別のより新しい取消を既に見ている
          // ＝もう伝えた取消（この取消を台帳へ積むのは下の入口の記録で、ここより後）
          // 発表時刻が空の取消は前後を決められないので「もう伝えた」とは言えない（黙らせない）
          quakeCancel = { target, retracted: effect?.kind === 'partial' ? effect.retracted : undefined, duplicate: quakeRetracted && !!quake.time }
        } catch (e) {
          log.error('[quake] 取消の当たり先を決められなかった（読み上げは地震情報全体の取消として言う）', {
            incomingId: event.id, incomingType: event.issue.type, error: e,
          })
          quakeCancel = { target: undefined, retracted: undefined, duplicate: false }
        }
      }
      let existing: JMAQuake | undefined
      // **既存カードを引けたかどうかを別に持つ。** 引けずに投げたときの `undefined` を
      // 「既存カードが無い」として下の写しへ渡すと、`mergeQuakeInto(undefined, ...)` が
      // **新規カード相当のスタブ**を作り、同じ地震について積み上げてきた写しをそれで置き換える
      // （以後その地震の判定は、震源も震度も欠けた写しを既存として見る）。
      let resolved = false
      try {
        existing = findQuakeCardForHoldBack(quake, index)
        resolved = true
        // 取消は内容の更新ではなくカードを消す操作なので、据え置き判定の対象外。
        if (!isSilentRef.current && !event.cancelled) {
          quakeHeldBack = isQuakeReportHeldBack(existing, quake, quakeRetracted)
        }
      } catch (e) {
        log.error('[quake] 据え置き判定に失敗したので、従来どおり音・読み上げ・タイトル・タブ移動を起こす', {
          incomingId: event.id, incomingType: event.issue.type, error: e,
        })
        quakeHeldBack = false
      }
      // **引けなかった電文は写しへ載せない。** 判定が投げた場合と、写しの更新そのものが投げた
      // 場合の両方で、**その地震の写しは 1 つ前の電文のまま残る**（`findQuakeCardForHoldBack` は
      // 写しにその地震が載っていれば画面の状態へ落ちないので、以後の判定もその写しを見る）。
      // **状態が受理しない報は写しへも載せない**（`quakeRetracted`）。状態更新は同じ判断で
      // `return prev`（何も触らない）へ倒れるので、写しだけが進むと両者が食い違う。
      if (resolved && !quakeRetracted) {
        try {
          // **写しは取消もサイレント注入も含めて進める。** 次の電文の判定がこれを既存として見る。
          trackPendingQuakeCard(existing, quake, index)
        } catch (e) {
          log.error('[quake] 同じティックの写しを更新できなかった（以後この地震の判定は、直前に書けた写しか画面の状態を見る）', {
            incomingId: event.id, incomingType: event.issue.type, error: e,
          })
        }
      }
    }
    // ライブ受信／テスト送信のイベントを通知（サイレントモード中は抑制）
    if (!isSilentRef.current) {
      // EEW は統合した値を渡す（理由は入口の `eewMerged`）。取消・失効・テスト報は届いたまま。
      onLiveEventRef.current?.(eewMerged ?? event, {
        quakeHeldBack, eewSameReport, ...(quakeCancel && { quakeCancel }), ...(eewLateCancel && { eewLateCancel }),
      })
    } else {
      // 録画ツール向けの記録。**`onLiveEvent` を呼ばない以上、`recordReplayTelegram`
      // （`handleLiveEvent` 側）へは届かない**——ここで拾わないと、リプレイ開始時の
      // サイレント注入（窓の手前の初期状態）が電文一覧から丸ごと抜け落ちる。
      recordSkippedTelegram(event, 'silentReplayInit')
    }

    // 556（EEW）: 最終報受信時、解除時刻にキャンセルイベントをキューへ挿入する。
    // standard版の Yahoo hypoInfo 経由 EEW は useKyoshinRealtime 側の消滅検出（diffHypoInfoEvents）
    // でも独立に解除イベントが発生しうるため、同一 eventId に対しここでのタイマー式解除と
    // 二重に発火することがある。2発目は activeEEWs から既に消えているため
    // useEarthquakes/useLiveEventHandler の hadKey チェックで無視される（意図した重複）。
    //
    // **最終報を名乗らない経路（P2PQuake）は、受けるたびに見張りの解除を予約し直す。**
    // P2PQuake の 556 は最終報の印を運ばないので、Yahoo が拾わなかった速報（Yahoo の取得が
    // 止まっているときなど）は解除の予約が 1 つも積まれず、画面に残り続けていた。見張りは
    // 発火した時点で台帳を見て、**どの経路からでも**より新しい報を受けていれば、その報から
    // 張り直す（`eew-watch-expiry`）。捨てると、Yahoo の続報のあと Yahoo の取得が止まった
    // ときに解除の予約が 1 つも残らない。比べるのは受理した回数で、発表時刻や報番号は見ない
    // （どちらも読めない報がある）。DMDATA には広げない（2026-10-14 ユーザー承認「解除の予約も続報の
    // 音・声も直す」の説明「見張りの解除は P2PQuake に限る」）—— あちらは最終報を名乗る。
    if (event.kind === 'eew') {
      const eew = event as EEWAlert
      const basis = eewMerged ?? eew
      if (!eew.cancelled && !eew.test && !eew.isFinal && eew.origin === 'p2pquake') {
        const key = eewEventKey(eew)
        const acceptance = eewAcceptanceRef.current.get(key)
        // 起点は受理した中でいちばん新しい発表時刻（遅れて届いた報で補ったときは、この報より新しい）。
        const issueMs = acceptance?.latestIssueMs ?? eewIssueTimeMs(eew)
        const cancelTime = calcEEWCancelTime(basis, new Date(issueMs ?? Number.NaN))
        if (!Number.isFinite(cancelTime.getTime())) {
          log.error('[eew] 発表時刻も震源時刻も読めないため見張りの解除を予約できません（取消が来るまで表示が残ります）'
            + ` id=${eew.id} eventId=${eew.issue?.eventId ?? '(なし)'}`
            + ` time="${eew.issue?.time ?? eew.time}" originTime="${eew.earthquake.originTime}"`)
        } else {
          const receipts = acceptance?.receipts ?? 0
          eewWatchReceiptsRef.current.set(key, receipts)
          eventQueueRef.current.push({
            eventTime: cancelTime,
            payload: { kind: 'eew-watch-expiry', key, receipts },
            logEntry: null,
          })
        }
      }
      if (!eew.cancelled && !eew.test && eew.isFinal) {
        const cancelTime = calcEEWCancelTime(basis, new Date(eew.time))
        // **予約できなかったことを、この経路の言葉で残す。** キューは発火時刻が読めない
        // エントリを捨てて記録するが（`createEventQueue` の `push`）、その文言は
        // 「捨てた」までしか言わない。ここで書かないと、症状（**その EEW が自動では
        // 消えず画面に居座る**）と原因が結び付かない。
        //
        // 解除時刻は発表時刻と震源時刻のどちらか一方が読めれば決まる（`calcEEWCancelTime`）。
        // ここへ来るのは両方読めなかったときだけ。
        if (!Number.isFinite(cancelTime.getTime())) {
          log.error('[eew] 発表時刻も震源時刻も読めないため自動解除を予約できません（取消が来るまで表示が残ります）'
            + ` id=${eew.id} eventId=${eew.issue?.eventId ?? '(なし)'}`
            + ` time="${eew.time}" originTime="${eew.earthquake.originTime}"`)
        } else {
          eventQueueRef.current.push({
            eventTime: cancelTime,
            payload: { kind: 'event', event: { ...eew, cancelled: true, expired: true } as AppEvent },
            logEntry: null,
          })
        }
      }
    }

    // 地震情報（551）の震度キャッシュ更新は setState の外で行う
    if (event.kind === 'quake') {
      const quake = event as JMAQuake
      // キャッシュのキーはイベントの安定キー。DMDATA は eventId なので全報で一致する。
      // P2PQuake は報ごとに別キーになるためこのキャッシュは実質効かず、通常経路では
      // mergeQuakeInto（既存カードの震度で埋める）が同じ補完を担う。ただし対象カードが
      // 既に消えている場合（取消の 10 秒後 purge など）はどちらも効かず震度は欠落する。
      // ここを earthquake.time に戻すと、同じ分に起きた別の地震の震度を引いてしまう。
      const cacheKey = quakeEventKey(quake)
      // VXSE51 の震度データをキャッシュ（後続 VXSE52 への補完用）。
      // **据え置き（`quakeHeldBack`）・取消より前に発表された報（`quakeRetracted`）は書かない。**
      // どちらもカードが内容を採らない・採れない電文で、書くと裏口からカードへ入り込む——
      // 据え置かれた震度速報 B の points がキャッシュへ残ったまま、後続の震源情報（震度を
      // 持たない）が `fillIntensityFromCache` で B を取り込むと `hasIntensity(incoming)` が
      // 真になり、`mergeQuakeInto` の「既存の震度で補完する」分岐を通らず、カード側は正しく
      // 据え置いた A の points ではなく B の points をそのまま採用してしまう
      // （既存カードが完全版なら `isSupersededByExistingCard` が先に守るが、震度速報の段階
      // では守りが無い）。
      if (!quakeHeldBack && !quakeRetracted
        && quake.issue.type === '震度速報' && quake.earthquake.maxScale >= 0) {
        quakeIntensityCacheRef.current.set(cacheKey, {
          maxScale: quake.earthquake.maxScale,
          points: quake.points,
          report: { time: quake.time, ...(quake.createdAtMs !== undefined && { createdAtMs: quake.createdAtMs }) },
        })
      }
      // 取消を見た事実も**入口で**台帳へ積む（EEW 側の台帳と同じ置き方）。`setState` の更新関数は
      // 再実行されうるため、そこに副作用を置くと同じ記録が二重に積まれ、台帳の実効容量が縮む。
      if (quake.cancelled) {
        // 当たったカードを渡せると照合の材料が揃う（理由は `QuakeRetraction`）。当たり先は入口で
        // 決めたもの（`quakeCancel`。写しも見ている）を使う。決められなかったときだけ状態から引く。
        const target = quakeCancel?.target ?? findQuakeCancelTarget(stateRef.current.earthquakes, quake, getAreaPrefIndexCache())
        rememberQuakeRetraction(quakeRetractionOf(quake, target))
        // **震度速報の取消なら、その震度の控えも捨てる。** 残すと、取消の後に届く震度を持たない報
        // （震源情報）が取り消された震度で埋め戻される。鍵は電文とカードの両方で引く（暫定 EventID の
        // 付け替えでカードの鍵が電文と違うことがある。→ `quakeEventKey`）。
        // **捨てるのは取消より前に発表された震度速報の控えだけ**（カードへの当て方と同じ規則）。
        // 取消の後に発表し直された震度速報が先に届いて控えられていれば、それは残す。
        if (quake.issue.type === '震度速報') {
          const keys = new Set([cacheKey, ...(target ? [quakeEventKey(target)] : [])])
          for (const key of keys) {
            const cached = quakeIntensityCacheRef.current.get(key)
            if (cached && (!quake.time || compareReportAge(cached.report, quake) <= 0)) quakeIntensityCacheRef.current.delete(key)
          }
        }
      }
    }

    // 津波: 期限切れ時刻に失効のイベント（`cancelReason: 'expired'`）をキューへ積む。
    //
    // **DMDSS 版は「この報を当てたあとの津波」の期限で決める**（`stepTsunamiState`。状態更新と同じ答え）。
    // 届いた報の期限だけを見ると、状態が報の種類ごとに決め直す期限と食い違う —— 期限を載せない
    // 津波警報・注意報（VTSE41）で状態の期限は消えるのに古い予約が残って注意報の発表中に「失効」する、
    // 津波情報だけの取消で予約がすべて外れて予報が失効しない、の 2 つが起きていた。
    // 表示中の津波に当たらない報（別の津波の解除など）では予約に触れない。
    //
    // **`stateRef` はレンダー待ちで同じティックの間は進まない**（下の EEW の分岐に理由）。同じティックに
    // 津波の報が同じ周回に続けて届いたときの土台は、下の `expiryBasisRef` の注記。
    //
    // TSU-5A: standard 版（P2PQuake）は API 仕様上 validDateTime を持たないため、解除電文が届かない
    // 例外ケースに備えて 24h 後の自動非表示フェイルセーフを積む（この経路は従来どおり届いた報で決める。
    // 識別子も種類も無いので、当てたあとの津波を求めても答えが変わらない）。
    if (event.kind === 'tsunami') {
      const tsunami = event as JMATsunami
      const now = getTimeRef.current()
      // 失効の予約を積む（既に過ぎていれば、初期状態の再現に限りその場で失効させる）
      const pushExpiry = (expireTime: Date, base: JMATsunami, failsafe: boolean) => {
        // 初期状態の再現では、遡り幅（24 時間）の境目ぶんだけ「発表から 24 時間を過ぎた」
        // 電文が紛れうる。未来の予約しか積まないと、そういう津波は失効予約を持たないまま
        // 画面に残り、リプレイ中はライブ更新も止まっているので消す手段が無くなる。
        // その場で失効させる（silent 注入なので音は鳴らない）。
        const alreadyExpired = expireTime <= now
        if (!alreadyExpired || isSilentRef.current) {
          eventQueueRef.current.push({
            eventTime: alreadyExpired ? now : expireTime,
            silent: alreadyExpired ? true : undefined,
            // 畳んだ報（`foldedReports`）は失効の判定に要らないので持ち回さない。
            // 標準版の安全弁で積んだ消去には印を付ける（→ `JMATsunami.failsafeExpiry`。「失効」と名乗らずに畳む）。
            payload: { kind: 'event', event: { ...base, foldedReports: undefined, cancelled: true, cancelReason: 'expired', ...(failsafe && { failsafeExpiry: true as const }) } as AppEvent },
            logEntry: null,
          })
        }
      }
      // 津波は「常に 1 件スロット」（tsunami-spec §5・TSU-3）で管理されるため、expired 予約は最新 1 件だけ
      // 残せば充分。P2PQuake 経路は eventId が無く id も続報ごとに変わるため、id/eventId 一致条件を課すと
      // 古い予約が消えず積み上がる問題があった。
      const purgeExpiry = () => eventQueueRef.current.retain(entry => {
        if (entry.payload.kind !== 'event') return true
        const ev = entry.payload.event
        if (ev.kind !== 'tsunami') return true
        return (ev as JMATsunami).cancelReason !== 'expired'
      })
      const parseValid = (t: JMATsunami): Date | null => {
        if (!t.validDateTime) return null
        // 日時として読めない期限で予約を積まないこと（`push` も捨てるが、そちらは
        // 呼び出し規約の違反として `error` に残る。**電文が期限を持たないのは正常** なので、
        // ここで分けて `warn` に留める。失敗モードは `EventQueue` の注記）。
        const parsed = new Date(t.validDateTime)
        if (Number.isFinite(parsed.getTime())) return parsed
        log.warn(`[tsunami] 有効期限を日時として読めないため失効予約を積みません: id=${t.id} validDateTime=${t.validDateTime}`)
        return null
      }
      if (isDmdss) {
        // **土台は「この周回で直前に当てた結果」。** `stateRef` は描き直しのたびにしか進まないので、同じ周回に
        // 2 通目が届くと 1 通目を当てる前の津波のままになる。それを土台にすると、1 通目（期限なしの注意報）で
        // 外した予約を 2 通目（津波情報）が古い予報の期限で積み直し、注意報の発表中に失効する。
        // `stateRef` が直前の判定から動いていなければ（＝まだ描き直していない）、自分が当てた結果を使う。
        // 動いていれば状態更新のほうが新しい（解除表示の片付け・リプレイの初期化を含む）ので、そちらに従う。
        const shown = stateRef.current.tsunamis[0]
        const pending = expiryBasisRef.current
        const base = pending && pending.shownAtStep === shown ? pending.tsunami : shown
        const step = stepTsunamiState(base, tsunami, now)
        if (step.kind !== 'ignored') {
          expiryBasisRef.current = { shownAtStep: shown, tsunami: step.kind === 'live' ? step.tsunami : undefined }
          // 起動時履歴の取り込みが、これより古い報で津波を書き換えないように覚えておく（→ `liveTsunamiSeenKeyRef`）。
          // **状態を変えなかった報（`ignored`）では進めない。** 履歴の取得中は表示中の津波が無いので、一部取消などは
          // 何も当たらずに捨てられる。それで鍵だけ進めると、取り消されていない履歴の津波まで当たらなくなる。
          // 時刻を読めない報（鍵が非有限）は覚えない。パーサーが津波の日時を入口で確かめるので、ライブでは届かない
          const seenKey = reportOrderKey(tsunami)
          if (Number.isFinite(seenKey) && seenKey > liveTsunamiSeenKeyRef.current) liveTsunamiSeenKeyRef.current = seenKey
        }
        if (step.kind !== 'ignored') {
          purgeExpiry()
          const expireTime = step.kind === 'live' ? parseValid(step.tsunami) : null
          if (step.kind === 'live' && expireTime) pushExpiry(expireTime, step.tsunami, false)
        }
      } else {
        let expireTime: Date | null = null
        // 実際の失効時刻（中継などで `validDateTime` が届いた報）なら、その時刻で「失効」と名乗る。安全弁は名乗らない。
        let failsafe = false
        if (!tsunami.cancelled) {
          expireTime = parseValid(tsunami)
          if (!expireTime) {
            failsafe = true
            const FAILSAFE_MS = 24 * 60 * 60 * 1000
            // 初期状態の再現（silent 注入）では、過去に発表された電文をまとめて「いま」流し直す。
            // 受信時刻を基準にすると、20 時間前に出ていた津波が再生開始からさらに 24 時間残り、
            // 実際の失効タイミングとずれる。この経路だけは発表時刻を基準にする。
            const issuedAt = new Date(tsunami.time)
            const baseMs = isSilentRef.current && Number.isFinite(issuedAt.getTime())
              ? issuedAt.getTime()
              : now.getTime()
            expireTime = new Date(baseMs + FAILSAFE_MS)
          }
        }
        // 明示解除電文でも purge するのは、TSU-5A の 24h 予約を解決済み津波に対して発火させないため。
        if (tsunami.cancelled || expireTime) purgeExpiry()
        if (expireTime) pushExpiry(expireTime, tsunami, failsafe)
      }
    }

    setState(prev => {
      const now = getTimeRef.current()
      switch (event.kind) {
        case 'quake': {
          let quake = event as JMAQuake

          // 取消電文: 取り消された種別の報を受けていたカードに当てる（`applyQuakeCancelToCard`。
          // 履歴の `mergeQuakeHistory` と同じ関数）。残る報が無ければカード全体の取消で、
          // cancelledAt を付けて 10 秒後に purge する。残る報があれば当て直したカードに差し替える
          // （取り消された種別の内容だけが消え、カードは残る）。
          // 種別まで見るのは、遠地地震の取消報が「震源・震度情報」のカードを巻き込まないようにするため
          // （遠地地震は VXSE53 を共有し Head/Title だけが異なる。dmdataParser の resolveIssueType 参照）。
          if (quake.cancelled) {
            let found = false
            let markMemory: Map<string, QuakeMarkMemory> | null = null
            const earthquakes = prev.earthquakes.map(e => {
              if (!isLiveQuakeCancelTarget(e, quake, getAreaPrefIndexCache())) return e
              const effect = applyQuakeCancelToCard(e, quake, quakeRetractionsRef.current, getAreaPrefIndexCache())
              if (effect.kind === 'none') return e
              found = true
              if (effect.kind === 'partial') {
                // 当て直しは借りた震源・津波区分を持たない（控えの電文から組み直すため）。
                // 通常の続報と同じく、統合の後で借り直す（→ 下の `withBorrowedFromTsunami`）。
                const card = withBorrowedFromTsunami(effect.card, prev.tsunamis, prev.earthquakes)
                // 当て直したカードの姿を記憶へ写す（履歴の同じ分岐と揃える。写すのは借り直した後の
                // 画面に出る値）。**印は出さない** —— 取り消されて消えた値は「いま動いた」ではない。
                markMemory ??= new Map(prev.quakeMarkMemory)
                rememberQuakeCard(markMemory, quakeEventKey(card), {
                  facts: quakeFactSnapshot(card),
                  rows: quakeRowSnapshot(card.points, card.cities ?? [], getAreaPrefIndexCache()),
                  issuedAt: markIssuedAt(card.issue.time),
                  reportType: card.issue.type,
                  // 取消を当て直した姿は電文の報ではない。次の報が `Revise` を使えないようにする
                  // （何に対する変化かを言えない）。
                  telegramType: null,
                  revise: null,
                })
                return card
              }
              eventQueueRef.current.push({
                eventTime: new Date(now.getTime() + 10_000),
                payload: { kind: 'purge-cancelled-quake', id: e.id },
                silent: true,
                logEntry: null,
              })
              // 津波側と同じく、取消電文だけが持つ項目は名指しで移す（土台は表示中のカード）。
              return { ...e, cancelledAt: now, ...(quake.cancelText && { cancelText: quake.cancelText }) }
            })
            if (!found) {
              // 取消対象が見つからない＝取消がどのカードにも効いていない。無言で捨てると
              // 「取り消されたはずの地震が残り続ける」原因を後から追えないため記録する。
              log.warn('[quake] 取消電文に対応するカードが見つからず無視した', {
                id: quake.id, issueType: quake.issue.type, quakeTime: quake.earthquake.time,
              })
              return prev
            }
            return { ...prev, earthquakes, quakeMarkMemory: markMemory ?? prev.quakeMarkMemory, lastUpdate: now }
          }

          // VXSE52/53 の震度の補完（VXSE51 キャッシュから maxScale・points を補う）は
          // **入口で済ませてある** —— 判定と同じ値を見るため（理由は `handleEvent` の
          // `filledQuake` のコメント）。ここで呼び直すと、そのあいだに進んだキャッシュを読む。
          quake = filledQuake ?? quake

          // 同一イベントの既存カードを探し、リアルタイム統合コアで1枚に統合する。
          // 同一性の判定は sameQuakeEntry、VXSE61 の震源マージ・震度保持・優先度判定は
          // mergeQuakeInto に委譲する（いずれも履歴経路と同一ロジック）。
          // 一致するカードが 2 枚あることがある（暫定 ID と確定 ID）。どちらを既存として
          // 扱うかで統合後の eventKey が変わるため、選び方は findExistingQuakeCard に集約する。
          // 取消の後に届いた報のうち、取消より前に発表されたもの（＝取り下げ済みの内容）は
          // 採らない。判定の中身と 2 通りの異常の切り分けは `isRetractedQuakeReport`。
          // **判断は入口で 1 回だけ**（`quakeRetracted`）。ここで呼び直すと、この更新関数は
          // レンダー時に走るぶん、判定・写しとは別の時点の台帳を読む。
          if (quakeRetracted) {
            log.warn('[quake] 取消以前に発表された報を捨てた', {
              id: quake.id, issueType: quake.issue.type, time: quake.time,
            })
            if (quakeRetractionTie) logRetractionTie(quake, quakeRetractionTie)
            return prev
          }
          const existing = findExistingQuakeCard(prev.earthquakes, quake, getAreaPrefIndexCache())
          const mergedCard = mergeQuakeInto(existing, quake)
          if (mergedCard === existing) return prev
          // 震源が未確定のまま残ったら、同じ地震の津波電文が載せている震源を借りる。
          // 津波警報を伴う地震では、気象庁は地震情報より先に津波電文で震源を伝える
          // （能登 2024/1/1 は 16:12 の津波警報が最初の震源で、地震情報は 16:16）。
          //
          // **統合の後に置くこと。** 既存カードが地震情報由来の震源を持っていれば
          // `mergeQuakeInto` がそちらを補うので、借り物で上書きしなくなる。
          // **据え置き（`mergedCard === existing`）の経路は上で抜けている** —— そこで借りると
          // 中身が同じでも参照だけが変わり、「変化なし＝同一参照」の約束が崩れる。
          // 津波が後から届く順序は、下の 'tsunami' 側が拾う。
          const merged = withBorrowedFromTsunami(mergedCard, prev.tsunamis, prev.earthquakes)
          // 統合の結果、暫定 ID で作られたカードが確定 ID を持つカードと重複することがある。
          // 履歴経路（mergeQuakeHistory）と同じ畳み込みをここでも通す（理由は coalesceByEventId）。
          //
          // **取消表示中のカードは差し替えの対象から外す（残す）。** ここで落とすと 10 秒表示を
          // 待たずに消え、しかも purge 予約（`id` で対象を引く）が空振りする。
          const next = coalesceByEventId([
            merged,
            ...prev.earthquakes.filter(e => e.cancelledAt || !sameQuakeEntry(e, quake, getAreaPrefIndexCache())),
          ])
          // カードの更新の印。**併合が済んだここで取る** —— 続報の持ち越し規則（§6.4）を
          // 適用したあとの「画面に出ている値」どうしを比べたいので、電文の側では取れない。
          // 受信ハンドラ（`useLiveEventHandler`）はこの統合より前に呼ばれるため、あちらでも取れない。
          //
          // **写すのは畳み込みまで済んだカード。** `coalesceByEventId` は暫定 ID と確定 ID の
          // カードを 1 枚へ畳むとき、もう一方の中身を吸収する。`merged` を写すと、その吸収分が
          // この報の印から漏れ、記憶にも入らないので**次の報で「いま動いた」と誤って光る**。
          const settled = next.find(c => sameQuakeEntry(c, quake, getAreaPrefIndexCache())) ?? merged
          const markState = advanceQuakeMarks({
            prev: { memory: prev.quakeMarkMemory, marks: prev.quakeUpdateMarks },
            key: quakeEventKey(settled),
            snapshot: {
              facts: quakeFactSnapshot(settled),
              rows: quakeRowSnapshot(settled.points, settled.cities ?? [], getAreaPrefIndexCache()),
              // 刈り込みで落とす順に使う（→ `MARK_MEMORY_MAX_ROWS`）。
              issuedAt: markIssuedAt(settled.issue.time),
              // 種別が変わった報では行の初出に印を付けない（→ `diffQuakeRows`）。
              reportType: settled.issue.type,
              // **届いた電文そのものから取る**（`quake` は震度の控えで補った後の姿。→ `quakeTelegramRevise`）
              telegramType: (event as JMAQuake).issue.type,
              revise: quakeTelegramRevise(event as JMAQuake),
            },
            // **長周期の鍵も数える。** 地震の鍵だけを渡すと、地震を 1 通受けただけで
            // 長周期の記憶が丸ごと捨てられ、その次の長周期の続報が初報として扱われる。
            liveKeys: liveMarkKeys(next, prev.lpgmByEventId),
            // **実時計で測る。** `now` は再生時計になりうる（`getTimeRef`）ので、
            // 印の寿命に使うと再生中は消えないか、即座に消えるかのどちらかになる。
            // 印は「画面に出してから何秒経ったか」の話なので、電文の時刻軸には乗せない。
            now: Date.now(),
          })
          return {
            ...prev,
            earthquakes: sortQuakes(next),
            quakeUpdateMarks: markState.marks,
            quakeMarkMemory: markState.memory,
            lastUpdate: now,
          }
        }
        case 'tsunami': {
          const tsunami = event as JMATsunami
          const current = prev.tsunamis[0]
          // **報を当てた結果は `stepTsunamiState` が決める**（失効予約の積み直しと同じ答えを使うため。
          // 片方だけ書き換えると、画面の津波と失効の予約が別の期限で動く）。
          const step = stepTsunamiState(current, tsunami, now)
          if (step.kind === 'ignored') return prev
          if (step.kind === 'ended') {
            if (step.reason === 'retractedAll') {
              // 津波情報・沖合の観測だけの取消で、組み立てに使った報がその種類だけだった（警報等を受けていない）。
              log.warn(`[tsunami] ${tsunami.headType} の取消で組み直す報が残らないため、津波を外します: id=${current?.id}`)
              return { ...prev, tsunamis: [], lastUpdate: now }
            }
            if (step.reason === 'outdated') return { ...prev, tsunamis: [], lastUpdate: now }
            // **標準版の 24 時間の安全弁は帯を出さずに消す**（→ `JMATsunami.failsafeExpiry`）。気象庁が言っていない時刻に
            // 「津波予報 失効」と出すと、発表値の顔で推測を並べることになる。タイトルも、解除の表示を経ずに消えた津波として
            // 終わりの語を出さない（`App.tsx` の `findEndedTsunami`）。
            if (tsunami.failsafeExpiry) {
              log.info(`[tsunami] 標準版の安全弁（24 時間）で津波を外します（失効とは名乗らない）: id=${current?.id}`)
              return { ...prev, tsunamis: [], lastUpdate: now }
            }
            // 解除・取消・期限切れのいずれも同じ10秒表示を経る。表示内容は cancelReason で出し分ける（TsunamiTab側）。
            if (current && !current.cancelledAt) {
              // TSU-4: purge 予約に対象 id を持たせ、他イベントが後で置換した場合に誤って
              // 新しいカードを 10 秒前に消してしまうレースを防ぐ。
              eventQueueRef.current.push({
                eventTime: new Date(now.getTime() + 10_000),
                payload: { kind: 'purge-cancelled-tsunami', id: current.id },
                silent: true,
                logEntry: null,
              })
              // **解除・取消の報から移すのは 3 つ（`cancelReason`・`cancelText`・`liftText`。`cancelledAt` はいまの時刻）。** 表示中のカードを土台にするので、
              // その報だけが持つ項目は名指しで移さないと落ちる（`cancelText` は気象庁が書いた取消しの
              // 理由、`liftText` は全区域解除の報に気象庁が書いた文で、どちらも他のどこにも無い）。
              const liftText = tsunami.cancelReason === 'lifted' ? tsunamiLiftText(tsunami) : undefined
              return {
                ...prev,
                tsunamis: [{
                  ...current,
                  cancelledAt: now,
                  cancelReason: tsunami.cancelReason,
                  ...(tsunami.cancelText && { cancelText: tsunami.cancelText }),
                  ...(liftText && { liftText }),
                }],
                lastUpdate: now,
              }
            }
            return { ...prev, tsunamis: [], lastUpdate: now }
          }
          // 番号が 1 つも重ならない津波が、表示中の津波の解除を待たずに届いた。
          //
          // **置き換える（2026-10-14 ユーザー承認「置き換える（推奨）」）。** 気象庁は別の地震が寄与すると
          // 同じ警報を切り替えて番号を足すので（電文解説資料 Ⅰ.別02-7 出現例６）、同じ津波は番号が重なる。
          // 重ならない報は別の津波として扱い、最新の発表を見せる。置き換えた事実はログから追えるようにする。
          if (!step.continued && current && current.eventId && tsunami.eventId
              && !isSameTsunamiEvent(current, tsunami) && !current.cancelledAt) {
            log.warn(`[tsunami] 番号の重ならない津波で表示中の津波を置き換えます: prev=${current.eventId} next=${tsunami.eventId}`)
          }
          // 続報の引き継ぎ（観測のみ電文で区域を保つ・観測点のマージ等）は `mergeTsunamiReports` の 1 箇所に
          // ある（`stepTsunamiState` 経由）。ここへ書き写すと、履歴からの復元（`withInheritedTsunamiFacts`）との
          // 間で片方だけに項目が足され、「ライブ受信では出るのにリロードすると消える」形の欠落が生まれる。
          return {
            ...prev,
            tsunamis: [step.tsunami],
            // 津波が先に震源を伝える順序を拾う（→ `borrowFromTsunamiIntoCards`）。続報でも配り直すのは、
            // 津波電文の震源が更新されるため（能登では 16:22 に Ｍ７．４→Ｍ７．６。地震情報が同じ更新を
            // 伝えるのは 2 分後の 16:24）。
            earthquakes: borrowFromTsunamiIntoCards(prev.earthquakes, [step.tsunami]),
            lastUpdate: now,
          }
        }
        case 'eew': {
          const eew = event as EEWAlert
          // 台帳（`eewAcceptanceRef`）と同じキーで引く。式を書き写すと、導出が変わったときに
          // 片方だけ追従して台帳と状態のキーが割れ、同一ティックの判定が静かに壊れる。
          const key = eewEventKey(eew)
          if (eew.test) {
            const next = new Map(prev.activeEEWs)
            next.delete(key)
            return { ...prev, activeEEWs: next, lastUpdate: now }
          }
          if (eew.cancelled) {
            // 最終報タイマー満了（expired）は即削除、誤報取消電文は 10秒表示
            if (eew.expired) {
              const next = new Map(prev.activeEEWs)
              next.delete(key)
              return { ...prev, activeEEWs: next, lastUpdate: now }
            }
            // 画面から消えた後に届いた誤報取消は、消える直前の報を土台にして 10 秒だけ戻す（→ 入口の `eewLateCancelBase`）
            const existing = prev.activeEEWs.get(key) ?? eewLateCancelBase
            if (!existing || existing.cancelledAt) return prev
            eventQueueRef.current.push({
              eventTime: new Date(now.getTime() + 10_000),
              payload: { kind: 'purge-cancelled-eew', key },
              silent: true,
              logEntry: null,
            })
            const next = new Map(prev.activeEEWs)
            // 地震・津波と同じく、取消電文だけが持つ項目は名指しで移す（土台は表示中の EEW）。
            next.set(key, { ...existing, cancelledAt: now, ...(eew.cancelText && { cancelText: eew.cancelText }) })
            return { ...prev, activeEEWs: next, lastUpdate: now }
          }
          const existing = prev.activeEEWs.get(key)
          // 入口（`handleEvent` の先頭）でも同じ判定をしているが、ここにも置く。キューの
          // ディスパッチャは 1 ティックで複数のイベントを処理し、その間 `stateRef` は
          // レンダー待ちで進まないため、入口だけでは同じティックに積まれた報を取りこぼす。
          // 記録は入口に集約する（setState は再実行されうるので副作用を持たせない）。
          // 遅れて届いた P2PQuake の報（`eewSupplement`）は古いのが前提なので、この判定を通さず補う。
          if (existing && isOlderEewReport(existing, eew) && !eewSupplement) return prev
          // **取消は終端。非取消の報で復活させない。** 取消電文は報番号の台帳を進めず
          // （入口のガードは `!incoming.cancelled` のときだけ記録する）、状態側も取消前の
          // 報番号を保ったまま `cancelledAt` を足すだけなので、**同じ報番号の非取消報が
          // 届くと `isStaleEewReport` をすり抜けて上書きする**。上書きされた側は
          // `cancelledAt` を失い、取消の表示が消えたうえに 10 秒後の purge も空振りする
          // （purge は `cancelledAt` の有無で判定するため）。
          //
          // これが現実に起きるのは、起動時の復元が取消の直前に発表された報を拾ったとき
          // （一覧 API が取消を反映するまでの遅れ）と、ライブで報の到着順が入れ替わったとき。
          if (existing?.cancelledAt && !eew.cancelled) {
            log.debug(`[eew] 取消済みのため非取消の報を無視: key=${key} 受信=#${eew.issue?.serial ?? '(なし)'}`)
            return prev
          }
          // **入口で統合した値をそのまま入れる**（読み上げ・通知へ渡した値と同じもの）。経路が
          // 運ばない欄を保つ・severity を引き上げだけにする・特別警報の下げ止まりは
          // `mergeEewReport` が担う。特別警報の印だけは、入口が見た土台より新しい状態
          // （同じティックに先に適用された報）があれば、そちらとも OR する —— 一度立てた印は
          // 消さない（eew-spec.md §4）。
          // 補う報は、同じティックに先に適用された報があってもその上へ補う（入口の土台より新しいため）。
          const fromEntry = eewSupplement && existing
            ? supplementEewReport(existing, eew)
            : eewMerged ?? mergeEewReport(existing, eew)
          const merged: EEWAlert = {
            ...fromEntry,
            everSpecialWarning: fromEntry.everSpecialWarning || (existing?.everSpecialWarning ?? false),
          }
          return {
            ...prev,
            activeEEWs: new Map(prev.activeEEWs).set(key, merged),
            lastUpdate: now,
          }
        }
        default:
          return { ...prev, lastUpdate: now }
      }
    })
  }, [carryEverSpecialWarning])

  // 表示が終わった EEW の報番号は覚えておく必要がない。掃除しないと台帳が伸び続ける
  // （EEW は 1 日に数十件届き、画面は長く開かれたままになる）。`activeEEWs` から消えたものを
  // 落とすだけなので、判定に要る間は残る。
  useEffect(() => {
    // 消える前に、終えた地震として覚える（→ `eewEndedRef`）。古い記憶はここで落とす（経過が負＝時計が巻き戻ったものも）。
    // **覚えるのは前回の画面に載っていて今回消えた地震だけ** —— 台帳は入口で状態より先に書くので、状態が採らなかった
    // 報の地震も台帳には残る。それを「終えた」とすると、画面に一度も出ていない地震の取り直しを弾いてしまう。
    // リセットは台帳を先に空にするので、ここでは何も覚えない
    const nowMs = serverNow()
    for (const [key, ended] of eewEndedRef.current) {
      const elapsed = nowMs - ended.endedAtMs
      if (elapsed < 0 || elapsed > ACTIVE_EEW_WINDOW_MS) eewEndedRef.current.delete(key)
    }
    for (const [key, shown] of prevActiveEewKeysRef.current) {
      const acceptance = eewAcceptanceRef.current.get(key)
      if (acceptance && !state.activeEEWs.has(key)) {
        // 取消で終えたかは、消える直前の画面の値で見る（取消は `cancelledAt` を付けて 10 秒出してから消す。
        // 自動解除は付けずにすぐ消す）。最後の報は取消の表示を外した姿で覚える（消えた後の誤報取消で戻す土台）
        const wasCancelled = shown.cancelled || !!shown.cancelledAt
        const { cancelledAt: _cancelledAt, ...lastReport } = shown
        eewEndedRef.current.set(key, mergeEndedEew(
          eewEndedRef.current.get(key), acceptance, wasCancelled, nowMs, lastReport, eewFirstIssueTimeRef.current.get(key),
        ))
      }
    }
    prevActiveEewKeysRef.current = new Map(state.activeEEWs)
    eewExpiringRef.current.clear()
    for (const ledger of [eewAcceptanceRef.current, eewLatestRef.current, eewWatchReceiptsRef.current, eewFirstIssueTimeRef.current]) {
      for (const key of [...ledger.keys()]) {
        if (!state.activeEEWs.has(key)) ledger.delete(key)
      }
    }
  }, [state.activeEEWs])

  // キューディスパッチャー: 10ms ごとに eventTime <= 現在時刻のエントリを処理する
  useEffect(() => {
    const id = setInterval(() => {
      const now = getTimeRef.current()
      // 1 件ずつキューへ問い合わせる。下の `handleEvent` は津波の失効予約を張り替える際に
      // キューの中身を変えるため、**取り出し済みの一覧をこちら側で保持してはいけない**
      // （理由と実測値は `EventQueue` の注記）。
      for (;;) {
        const entry = eventQueueRef.current.shiftReady(now)
        if (!entry) break
        const { payload, silent } = entry
        isSilentRef.current = !!silent
        // **電文ログへはここで積む。** 画面へ出るのと同じ時点なので、ライブの行（受信＝反映）
        // と並びの意味が揃う。**この下の `continue`（取消済みの報を捨てる等）より手前に置く**
        // —— 捨てた電文も「届いた」ことは事実なので、行は残す（ただし取消済みの報を捨てた
        // ことは行に出ない。ライブ側もその棄却は `parsed` のままで、`filtered` が付くのは
        // 受信側の振り分け＝扱わない種別・結合待ちの断片・試験報の破棄だけ）。
        //
        // **`receivedAt` はここで打ち直す。** 組んだ時刻のままだと、窓ぶんをまとめて組む
        // リプレイで 1 時間ぶんが同じ秒を名乗る（→ `makeReplayLogEntry`）。
        if (entry.logEntry) appendTelegramLog({ ...entry.logEntry, receivedAt: now })
        if (payload.kind === 'event') {
          handleEvent(payload.event)
        } else if (payload.kind === 'lpgm') {
          const lpgm = payload.data
          // 取消は台帳へ積む（起動時の履歴・もっと見るで、取り消された報が戻らないように。
          // → `utils/lpgmRetraction.ts`）。取消より前に発表された報が後から届いても採らない。
          if (lpgm.cancelled) addLpgmRetraction(lpgmRetractionsRef.current, lpgmRetractionOf(lpgm), MAX_LPGM_RETRACTIONS)
          else if (isRetractedLpgm(lpgmRetractionsRef.current, lpgm)) {
            log.warn('[lpgm] 取消以前に発表された報を捨てた', { eventId: lpgm.eventId, time: lpgm.time })
            recordSkippedTelegram({ kind: 'lpgm', data: lpgm }, 'notApplied')
            // **飛ばす前にサイレントの印を戻す。** ループ末尾の戻しを通らないので、サイレント注入の
            // 項目だと印が立ったまま残り、次の項目までの間に届いたライブの電文（テストボタン・
            // EEW の格上げの再評価）が `onLiveEvent` を呼ばれずに黙る。
            isSilentRef.current = false
            continue
          }
          // 印付けの規則は `applyLiveLpgmWithMarks`（WebSocket 経路と共通）
          setState(prev => ({ ...prev, ...applyLiveLpgmWithMarks(prev, lpgm, Date.now()) }))
          // **他の 6 種別（nankai/nankaiCommentary/kohatsu/earthquakeCount/estimatedIntensity/
          // quakeNotice）と同じく、`onLiveEvent` を呼ばない場合はすべて記録する。** かつては
          // `lpgm.cancelled`（取消）・`maxClass < 1`（階級 0）を「既存の正常な振り分け」として
          // 除外していたが、この 2 ケースは `silent` の真偽を問わずどちらの記録も残さないまま
          // 画面の長周期一覧・バッジには反映されうる（`setState` は上で必ず走る）。「全件出す」
          // という仕様の主張と食い違うため、他の種別と同じ if/else へ揃える。
          //
          // **理由は `notApplied` ではなく `notDispatched`。** `lpgmNotifiable` が偽でも
          // `lpgmByEventId` は必ず書き換わるので、「反映されなかった」を意味する `notApplied`
          // を使うと嘘になる（他の 5 種別は棄却＝ state 不変が一致するが lpgm だけ一致しない）。
          const lpgmDecision = lpgmNotifiable(lpgm) ? decideDispatch('lpgm', lpgm, true, silent, false) : 'notDispatched'
          if (lpgmDecision === 'dispatch') {
            onLiveEventRef.current?.({ kind: 'lpgm', data: lpgm })
          } else {
            recordSkippedTelegram({ kind: 'lpgm', data: lpgm }, lpgmDecision)
          }
        } else if (payload.kind === 'nankai') {
          const nankai = payload.data
          // 取消は帯へ当てたかによらず伝える（→ `decideDispatch`）
          const otherUnit = cancelOverOtherUnit(shownNankaiEventIdRef.current, nankai)
          const decision = decideDispatch('nankai', nankai, applyNankai(nankai), silent, otherUnit)
          if (decision === 'dispatch') {
            onLiveEventRef.current?.({ kind: 'nankai', data: nankai })
          } else {
            recordSkippedTelegram({ kind: 'nankai', data: nankai }, decision)
          }
        } else if (payload.kind === 'nankaiCommentary') {
          const commentary = payload.data
          // 期限切れなら反映も通知もしない（画面に出ないものを読み上げても意味がない）。取消は帯へ当てたかに
          // よらず伝える（→ `decideDispatch`）
          const decision = decideDispatch('nankaiCommentary', commentary, applyNankaiCommentary(commentary), silent, false)
          if (decision === 'dispatch') {
            onLiveEventRef.current?.({ kind: 'nankaiCommentary', data: commentary })
          } else {
            recordSkippedTelegram({ kind: 'nankaiCommentary', data: commentary }, decision)
          }
        } else if (payload.kind === 'purge-cancelled-quake') {
          const { id } = payload
          setState(prev => {
            const earthquakes = prev.earthquakes.filter(e => e.id !== id || !e.cancelledAt)
            if (earthquakes.length === prev.earthquakes.length) return prev
            // 消えたカードの印と記憶もここで落とす。**次のライブ電文まで待たない** ——
            // `advanceQuakeMarks` の `liveKeys` による刈り込みは受信のときしか走らないので、
            // 静かな時間帯が続くと観測点の写し（大きいもので数千件）が残り続ける。
            const live = liveMarkKeys(earthquakes, prev.lpgmByEventId)
            return {
              ...prev,
              earthquakes,
              quakeUpdateMarks: new Map([...prev.quakeUpdateMarks].filter(([k]) => live.has(k))),
              quakeMarkMemory: new Map([...prev.quakeMarkMemory].filter(([k]) => live.has(k))),
            }
          })
        } else if (payload.kind === 'eew-watch-expiry') {
          const { key } = payload
          const shown = eewLatestRef.current.get(key) ?? stateRef.current.activeEEWs.get(key)
          if (eewWatchReceiptsRef.current.get(key) !== payload.receipts) {
            // P2PQuake の新しい報が見張りを張り直した。生きているのはそちら。
            log.debug(`[eew] 見張りの解除を捨てた（後から張り直した見張りがある）: key=${key}`)
          } else if (!shown || shown.cancelled || shown.cancelledAt) {
            eewWatchReceiptsRef.current.delete(key)
            log.debug(`[eew] 見張りの解除を捨てた（既に消えている・取り消されている）: key=${key}`)
          } else {
            const acceptance = eewAcceptanceRef.current.get(key)
            if (acceptance && acceptance.receipts > payload.receipts) {
              // **経路をまたいで見る** —— Yahoo が続報を出し続けている間にこの見張りが発火すると、
              // まだ発表中の速報を消し、次の Yahoo の報で「新規発表」として鳴り直す。捨てずに、
              // いちばん新しい報から測り直す（Yahoo の取得が止まったら、そこから解除される）。
              const cancelTime = calcEEWCancelTime(shown, new Date(acceptance.latestIssueMs ?? Number.NaN))
              if (Number.isFinite(cancelTime.getTime())) {
                eewWatchReceiptsRef.current.set(key, acceptance.receipts)
                eventQueueRef.current.push({
                  eventTime: cancelTime,
                  payload: { kind: 'eew-watch-expiry', key, receipts: acceptance.receipts },
                  logEntry: null,
                })
                log.debug(`[eew] 見張りの解除を新しい報から張り直した: key=${key} 解除=${cancelTime.toISOString()}`)
              } else {
                // 張り直す時刻が読めない。残すと取消が来るまで画面に居座るので、ここで解除する。
                log.error(`[eew] 見張りの解除を張り直す時刻が読めないため、いま解除します: key=${key}`)
                eewWatchReceiptsRef.current.delete(key)
                handleEvent({ ...shown, cancelled: true, expired: true })
              }
            } else {
              eewWatchReceiptsRef.current.delete(key)
              handleEvent({ ...shown, cancelled: true, expired: true })
            }
          }
        } else if (payload.kind === 'purge-cancelled-eew') {
          const { key } = payload
          setState(prev => {
            const existing = prev.activeEEWs.get(key)
            if (!existing?.cancelledAt) return prev
            const next = new Map(prev.activeEEWs)
            next.delete(key)
            return { ...prev, activeEEWs: next }
          })
        } else if (payload.kind === 'purge-cancelled-tsunami') {
          setState(prev => {
            // TSU-4: 現在の tsunami が purge 対象と id 一致し、かつ cancelledAt が付いていれば消去する。
            // 別 id の tsunami に置き換わっている場合は誤消去せず据え置く。
            if (prev.tsunamis.length === 0 || !prev.tsunamis[0].cancelledAt) return prev
            if (prev.tsunamis[0].id !== payload.id) return prev
            return { ...prev, tsunamis: [] }
          })
        } else if (payload.kind === 'kohatsu') {
          const kohatsu = payload.data
          const otherUnit = cancelOverOtherUnit(shownKohatsuEventIdRef.current, kohatsu)
          const decision = decideDispatch('kohatsu', kohatsu, applyKohatsu(kohatsu), silent, otherUnit)
          if (decision === 'dispatch') {
            onLiveEventRef.current?.({ kind: 'kohatsu', data: kohatsu })
          } else {
            recordSkippedTelegram({ kind: 'kohatsu', data: kohatsu }, decision)
          }
        } else if (payload.kind === 'quakeNotice') {
          const notice = payload.data
          // 帯へ反映できたものだけ流す（他の帯と同じ形）。読み上げるかは受け手が設定で決める
          // （既定は読まない → `handleExtraLiveEvent`）。
          const applied = applyQuakeNotice(notice)
          if (applied && !silent) {
            onLiveEventRef.current?.({ kind: 'quakeNotice', data: notice })
          } else {
            recordSkippedTelegram({ kind: 'quakeNotice', data: notice }, applied ? 'silentReplayInit' : 'notApplied')
          }
        } else if (payload.kind === 'earthquakeCount') {
          const count = payload.data
          const decision = decideDispatch('earthquakeCount', count, applyEarthquakeCount(count), silent, false)
          if (decision === 'dispatch') {
            onLiveEventRef.current?.({ kind: 'earthquakeCount', data: count })
          } else {
            recordSkippedTelegram({ kind: 'earthquakeCount', data: count }, decision)
          }
        } else if (payload.kind === 'estimatedIntensity') {
          const ei = payload.data
          // **`onLiveEvent` へ流す。** 音・読み上げ・地図の分布モードを開く処理がその先にある。
          // 反映できなかったとき（古い報・重複配信）は流さない —— 画面が変わっていないのに
          // 音だけ鳴る。
          const applied = applyEstimatedIntensity(ei, !silent)
          if (applied && !silent) {
            onLiveEventRef.current?.({ kind: 'estimatedIntensity', data: ei, isNew: applied.isNew })
          } else {
            recordSkippedTelegram({ kind: 'estimatedIntensity', data: ei }, applied ? 'silentReplayInit' : 'notApplied')
          }
        }
        isSilentRef.current = false
      }
    }, 10)
    return () => clearInterval(id)
  }, [handleEvent])

  // アンマウント時にタイマーとキューをクリア。
  // 7日タイマーは 4 つある（後発地震・南海トラフ関連解説情報・地震津波に関するお知らせ・地震回数）。
  // **1 つでも落とし忘れると**、残った側が最大7日後にアンマウント済みのクロージャの setState を呼ぶ。
  useEffect(() => {
    return () => {
      if (kohatsuExpireTimerRef.current !== undefined) {
        window.clearTimeout(kohatsuExpireTimerRef.current)
      }
      if (nankaiCommentaryExpireTimerRef.current !== undefined) {
        window.clearTimeout(nankaiCommentaryExpireTimerRef.current)
      }
      if (quakeNoticeExpireTimerRef.current !== undefined) {
        window.clearTimeout(quakeNoticeExpireTimerRef.current)
      }
      if (earthquakeCountExpireTimerRef.current !== undefined) {
        window.clearTimeout(earthquakeCountExpireTimerRef.current)
      }
      // テストボタンが張った待ちも全部落とす（→ `clearTestSimulationTimers`）。
      // **キューを空にするだけでは足りない** —— 津波と EEW のテストはキューを通らず
      // `handleEvent` を直接呼ぶ。
      clearTestSimulationTimers()
      eventQueueRef.current.clear()
    }
  }, [clearTestSimulationTimers])

  useEffect(() => {
    let cancelled = false
    // 「もっと見る」がどちらの経路を使うか（→ `replayActiveRef`）
    replayActiveRef.current = replayTimeOffset !== null
    // 時間軸が変わった印。ここより前に始まった取得は、以後の結果を捨てる
    liveGenerationRef.current++
    // この時間軸の履歴の取得（初回・もっと見る）を打ち切る合図。クリーンアップで立てる。
    // 世代番号（結果を捨てる判定）と対で持つ —— こちらは目録・一覧のページを辿り続けないため。
    const historyAbort = new AbortController()
    liveHistoryAbortRef.current = historyAbort
    // カーソルも初期値へ戻す（戻さないと、接続を張り直したあとの「もっと見る」が
    // 前の時間軸で読んだ位置から続きを読む）
    historyCursorRef.current = null
    dmdataHistorySettledRef.current = Promise.resolve()
    // 履歴の損失もここで空へ戻す。**これから読み直す範囲の話**なので、前の接続で欠けた分を
    // 持ち越すと直っても表示が消えない。遡り幅と同じ同期ブロックで戻す。
    setState(prev => (
      isTelegramLossEmpty(prev.historyLoss) && !prev.loadMoreFailed && !prev.reconnectGapLoss
        ? prev
        : { ...prev, historyLoss: createEmptyTelegramLoss(), loadMoreFailed: false, reconnectGapLoss: false }
    ))

    // VAR-1: リプレイ中はライブ接続を止める（両バリアント共通）。過去の電文を流している最中に
    // 現在時刻のライブ更新が混ざると、再生時刻より未来の地震がカードに並んで実際の経過を追えない。
    // かつては standard 版だけ P2PQuake WS を継続していた（リプレイが強震モニタの時計ずらしに
    // 過ぎず、地震・津波は何も流れなかったため）。現在は standard 版も当時の地震情報・津波を
    // 取得して流すので、DMDSS 版と同じ扱いにする。
    if (replayTimeOffset !== null) {
      // 状態表示を再生中のものへ畳む。
      //
      // ひとつは `connectionStatus`。ここで更新せずに抜けると直前の値（多くは 'connected'）が
      // 残り、実際にはライブ接続を切っているのに「接続中」と表示され続ける。再生は分〜時間の
      // 単位で続くため、その間ずっと実態と食い違う。'disconnected' ではなく専用の 'replay' に
      // するのは、地図の切断警告（App の overlayError）を出さないため——意図して止めているものを
      // 異常として見せない。
      //
      // もうひとつは `isLoading` と `error`。ページを開いた直後（初回履歴の取得中・取得失敗直後）に
      // リプレイを始めると、その取得は cleanup で破棄され、以後この effect は早期 return するため、
      // これらを戻す経路がどこにも無くなる。地震タブは isLoading → error の順に優先して表示するので、
      // 放置すると再生した電文が「データを取得中…」や「データの取得に失敗」の裏に
      // 隠れたままになる。
      //
      // 同じ参照を返す分岐を挟んで、無関係な再レンダーは起こさない。
      setState(prev => (
        prev.connectionStatus === 'replay' && !prev.isLoading && !prev.error
          ? prev
          : { ...prev, connectionStatus: 'replay', isLoading: false, error: null }
      ))
      return
    }

    if (isDmdss) {
      // --- DMDSS版: APIキー未設定なら接続しない ---
      if (!dmdataApiKey) {
        setState(prev => ({ ...prev, connectionStatus: 'disconnected', isLoading: false }))
        return
      }

      // 通信へ載せられない文字（全角・日本語入力の変換途中の値など）を含むキーでも接続しない。
      // 素通しにすると Basic 認証ヘッダを組む時点で例外になり、履歴取得は英語の DOMException を
      // そのまま画面に出し、WebSocket は理由を伏せたまま永久に再接続を繰り返す。
      // 未設定と違って「入れたのに繋がらない」状態なので、理由を error に載せて画面へ出す。
      if (!isValidDmdataApiKey(dmdataApiKey)) {
        log.warn(`[data] ${DMDATA_API_KEY_INVALID_MESSAGE}`)
        setState(prev => ({
          ...prev,
          connectionStatus: 'disconnected',
          isLoading: false,
          error: DMDATA_API_KEY_INVALID_MESSAGE,
        }))
        return
      }

      setState(prev => ({ ...prev, isLoading: true, connectionStatus: 'connecting', error: null, dmdataClassifications: null }))

      // DMDSS WebSocket 接続（dmdataTestDelivery 有効時は試験報・訓練報も受信）。
      // **作るのは先、繋ぐのは後**（`connect()` は下）。履歴と起動時の復元は、受けられる区分が
      // 分かってから取りに行くため —— 一部の区分しか受けられない人に、受けられない区分の一覧を
      // 引いて断られる取得を出さない（→ `services/dmdataClassifications.ts`）。
      const ws = new DmdataWebSocket(dmdataApiKey, dmdataTestDelivery)
      wsRef.current = null
      // **前回受け付けられた区分を覚えていれば、申し込みの結果を待たずにその区分で取りに行く**
      // （→ `services/dmdataClassificationMemory.ts`）。チケットの発行は配信元の処理で 1.2〜2.2 秒かかり、
      // 同時接続の枠が埋まっていると決まらないまま最大 15 秒待つ（2026-10-19 実測）。
      // 覚えが無ければ（初めて開いた・鍵を入れ替えた）、今までどおり申し込みの結果
      // （`classificationsReady`）を待つ。
      const remembered = loadRememberedClassifications(dmdataApiKey)
      // 履歴と復元の取得の版。覚えた区分で始めた取得が申し込みの結果と食い違ったら、版を進めて
      // 前の版を打ち切り、その結果を捨てる（→ `startRestFetches`）。
      let restRun = 0
      let restAbort: AbortController | null = null
      // 履歴と復元がキューへ積んだ EEW の電文 id（津波の失効予約は、外してから積むのでここに載せない）。**版をまたいで持つ** ——
      // 前の版が打ち切られる前に積み終えていると、取り直しの版が同じものをもう一度積むことになる
      // （EEW の報番号の台帳は同じ報番号の再送を通すので、入口では弾かれない）。
      const restoredQueueKeys = new Set<string>()
      // 覚えた区分で始めたときに、申し込みの結果との突き合わせを済ませたか。**最初に受け付けられた
      // 区分とだけ比べる** —— 再接続のたびに比べ直すと、そのたびに履歴を取り直すことになる。
      let rememberedChecked = remembered === null
      // 起動時の履歴が目録を引いた右端（エポックミリ秒）。まだ引いていなければ `null`（→ `ws.onStarted`）
      let historyBeforeMs: number | null = null

      // **取れた分から順に画面へ出す。** 電文本体の取得は配信元の上限に合わせて
      // 6 秒に 1 件へ直列化されるので（→ `services/telegramBody.ts`）、控えが空の初回は
      // 全件が揃うまで数分かかる。揃うまで待つ形だと、そのあいだ地震の履歴が空のままになる。
      // **控えが埋まっている 2 回目以降は待ちが無いので、実質いままでどおり一度に出る。**
      // 取り直しで捨てた版の部分結果は当てない（`stale`）。
      const applyPartialQuakesFor = (stale: () => boolean) => (partial: JMAQuake[]): void => {
        if (stale()) return
        // 記録する側が重複を弾くので、部分結果ごとに呼んでよい（`rememberQuakeRetraction`）
        rememberQuakeRetractionsFromBatch(partial)
        // **base は空ではなく現在値。** 取得のあいだにライブで届いた地震を消さないため
        // （`mergeQuakeHistory` は電文の一意鍵（`telegramKey`）で同じ電文を二度数えないので、
        // 同じ部分結果を重ねて当てても結果は変わらない）。
        setState(prev => {
          // 畳み込みが作った記憶を受け取る（印は出さない。→ `marksFromHistory`）。
          const { cards, markMemory } = mergeQuakeHistory(
            partial, prev.earthquakes, quakeRetractionsRef.current, getAreaPrefIndexCache(), prev.quakeMarkMemory,
          )
          return {
            ...prev,
            ...marksFromHistory(markMemory, cards, prev.lpgmByEventId, prev.quakeUpdateMarks),
            earthquakes: borrowFromTsunamiIntoCards(cards, prev.tsunamis),
            lastUpdate: serverDate(),
          }
        })
        // **触るのは地震だけ。** 津波・長周期・補助情報は別経路で、ここで混ぜると
        // まだ取得していないものを「無い」として画面へ出すことになる。
        // `isLoading` も倒さない —— まだ増える途中なので、読み込み中のままが正しい。
      }

      // **履歴はアーカイブ経由で 1 本にまとめて取る。**
      //
      // かつては地震・津波・補助情報 5 本を `Promise.all` で並行に取り、どれも
      // 一覧（`/v2/telegram`）＋本体（`/v1/:id`）を 1 件ずつ叩いていた（実測で起動あたり
      // 110 件超）。**大量に取るならアーカイブを使う** —— 1 日分が 1 ファイル（実測 gzip 10KB）で、
      // 中の目録から地震・津波・帯・長周期を全部取り出せる（→ `data-sources-spec.md` §2
      // 「大量に取るならアーカイブを使う」）。
      //
      // 実装はリプレイ開始時の履歴復元と共有する（`fetchDmdataQuakeHistoryFor`）。同じ目的の
      // 実装を 2 本持つと、片方だけがアーカイブを使う今までの形に戻る。
      //
      // **履歴と発表中の緊急地震速報の復元を、区分を受け取って 1 版として走らせる。** 呼ぶのは
      // 覚えた区分で始めるとき・申し込みの結果を待って始めるとき・覚えた区分が食い違って取り直すとき。
      // 新しい版を始めると前の版を打ち切り、前の版の結果は `stale` で捨てる。
      const startRestFetches = (classifications: readonly DmdataClassification[]): void => {
        const run = ++restRun
        restAbort?.abort()
        const abort = new AbortController()
        restAbort = abort
        // 時間軸が変わったとき（クリーンアップ）にも打ち切る。前の版のリスナは外さない —— 版は
        // 多くて 2 つ（覚え・取り直し）で、打ち切り済みの版へもう一度 abort が届いても何も起きない
        historyAbort.signal.addEventListener('abort', () => abort.abort(), { once: true })
        const stale = () => cancelled || run !== restRun
        dmdataRestRunRef.current++
        dmdataRestClassificationsRef.current = classifications
        const historyBefore = serverDate()
        // 最初の版の右端だけ覚える（→ `ws.onStarted`。取り直しの版は右端が後ろへ伸びるだけで、隙間を作らない）
        if (historyBeforeMs === null) historyBeforeMs = historyBefore.getTime()
        // **取り直しなら読み込み中へ戻し、前の版のエラー表示を消す。** 前の版が覚えた区分のせいで
        // 失敗していると、取り直しが数分かかる間「読み込み中」が消えたままエラーが残る
        if (run > 1) setState(prev => ({ ...prev, isLoading: true, error: null }))
        dmdataHistorySettledRef.current = Promise.resolve()
          .then(() => (stale() ? Promise.reject(new Error('cancelled')) : fetchDmdataQuakeHistoryFor(
            classifications,
            dmdataApiKey, historyBefore, HISTORY_WINDOW_DAYS, dmdataTestDelivery, abort.signal,
            applyPartialQuakesFor(stale), stale,
          )))
          .then((history) => {
            if (stale()) return
            // **「もっと見る」はここの続きから読む。** 初回が読めなければ `null` のままで、
            // 押されたときは初回と同じ範囲をもう一度試す。
            //
            // **`stale` を見たあとに置くこと。** 時間軸が変わった後の結果でカーソルを
            // 進めると、新しい時間軸の「もっと見る」が古い軸で読んだ位置から続きを読む。
            historyCursorRef.current = historyCursorFromOldestDay(history.oldestLoadedDay)
            const quakeEvents = history.quakes
            const tsunamiEvents = history.tsunamis
            // 種別横断の生電文を eventId ごとに統合（リアルタイムと同一ロジック）。
            rememberQuakeRetractionsFromBatch(quakeEvents)
            // 新しい順。**作成時刻（秒まで）で並べる**（→ `reportOrderKey`）。同じ津波の津波警報等と津波情報は同じ分に
            // 並ぶことがあり、履歴の並びは取得の完了順なので、分で並べると古い報が「最新」として画面に載りうる。
            // **時刻を読めない報は先に外す。** `reportOrderKey` は読めない報を `Infinity`（昇順の末尾）にするので、
            // 新しい順に並べると先頭へ来て、壊れた報が「最新」として画面に載る。外した件数は記録する。
            const orderable = tsunamiEvents.filter(t => Number.isFinite(reportOrderKey(t)))
            if (orderable.length < tsunamiEvents.length) {
              const dropped = tsunamiEvents.filter(t => !Number.isFinite(reportOrderKey(t)))
              const droppedCancels = dropped.filter(t => t.cancelled).length
              log.warn(`[data] 時刻を読めない津波の報 ${dropped.length} 通（うち取消・解除 ${droppedCancels} 通）を、起動時履歴の最新報の候補から外しました`)
            }
            const allTsunami = orderable
              .sort((a, b) => reportOrderKey(b) - reportOrderKey(a))
            // 画面へ載せるのは最新報 1 通だけ。その報が有効期限を持たなくても、同じ津波の過去報が
            // 伝えていれば引き継ぐ（引き継がないと下の失効予約が積まれず、期限切れの津波が消えない）。
            const latestTsunami = allTsunami[0] && withInheritedTsunamiFacts(allTsunami[0], allTsunami)
            // 気象庁は予報のみになった津波に必ず期限を付ける（tsunami-spec.md §3）。それが引き継げて
            // いないなら、期限を伝えた報が取得件数の上限から押し出された疑いがある。放っておくと
            // 「消えない津波」に化けるが、画面には何の痕跡も出ないので記録だけは残す。
            if (latestTsunami && !latestTsunami.validDateTime && latestTsunami.areas.length > 0
                && latestTsunami.areas.every(a => a.grade === 'Forecast')) {
              log.warn(`[data] 予報のみの津波に有効期限が付いていません（期限を伝えた報を取得できていない可能性）: id=${latestTsunami.id}`)
            }
            const now = serverDate()
            // **ライブで当てた報より古い履歴では津波を書き換えない**（→ `liveTsunamiSeenKeyRef`）。履歴の最新報が
            // ライブで当てたどの報より新しいときだけ当てる。履歴に津波が無くても、ライブで当てた報があれば今の状態を残す。
            const historyTsunamiKey = allTsunami[0] ? reportOrderKey(allTsunami[0]) : Number.NEGATIVE_INFINITY
            const liveSeenKey = liveTsunamiSeenKeyRef.current
            const applyHistoryTsunami = !(Number.isFinite(liveSeenKey) && liveSeenKey >= historyTsunamiKey)
            if (!applyHistoryTsunami) {
              const liveAt = new Date(liveSeenKey).toISOString()
              if (allTsunami[0]) {
                log.info(`[tsunami] 起動時履歴の最新報はライブで当てた報より新しくないので、津波は今の状態を残します: history=${allTsunami[0].id}（${new Date(historyTsunamiKey).toISOString()}） ライブ=${liveAt}`)
              } else {
                log.info(`[tsunami] 起動時履歴に津波は無かったが、ライブで津波の報を当てているので今の状態を残します: ライブ=${liveAt}`)
              }
            }
            const tsunamis = applyHistoryTsunami && latestTsunami
              && !latestTsunami.cancelled
              && !(latestTsunami.validDateTime && new Date(latestTsunami.validDateTime) <= now)
              ? [latestTsunami] : []

            // 長周期は同じアーカイブに入っているので、拾うだけで追加の通信は要らない
            const lpgmEvents = history.extras
              .map(e => e.payload)
              .filter((p): p is { kind: 'lpgm'; data: JMALpgm } => p.kind === 'lpgm')
              .map(p => p.data)
            for (const lpgm of lpgmEvents) {
              // **キュー経路（`lpgmNotifiable`）と同じ判定で記録する。** ここも `onLiveEvent` を
              // 呼ばないサイレント経路なので、通知しうる中身（階級1以上の発表）でも
              // `silentReplayInit`、それ以外は `notDispatched`（→ `lpgmNotifiable` のコメント）。
              // 取消は「伝えた」に数える（→ `decideDispatch`）—— 同じ取消が後からライブで届いても鳴らさない。
              recordSkippedTelegram({ kind: 'lpgm', data: lpgm }, silentLpgmSkip(lpgm))
            }
            if (stale()) return
            // 地震ごとの 1 通へ畳む。**取消を台帳へ積み、その地震の取消より前の報は採らない**
            // （取消を飛ばすだけだった頃は、取り消された長周期の表示が起動のたびに戻っていた）。
            // 台帳へ積むのは `stale` を見た後 —— 見る前に積むと、リプレイの開始で空にした台帳へ
            // 捨てるはずだった履歴の取消が入る。
            recordLpgmRetractions(lpgmEvents, lpgmRetractionsRef.current)
            const lpgmByEventId = foldLpgmHistory(new Map(), lpgmEvents, lpgmRetractionsRef.current)
            setState(prev => {
              // **ここも base は現在値。** 空から組み直すと、履歴を取っているあいだに
              // ライブで届いた地震が最後に消える。取得が 6 秒に 1 件へ直列化されたことで
              // その窓が数分に伸びたため、取りこぼしが実際に起きうる
              // （→ `services/telegramBody.ts` の取得間隔）。
              const { cards, markMemory } = mergeQuakeHistory(
                quakeEvents, prev.earthquakes, quakeRetractionsRef.current, getAreaPrefIndexCache(), prev.quakeMarkMemory,
              )
              const nextTsunamis = applyHistoryTsunami ? tsunamis : prev.tsunamis
              return {
                ...prev,
                // 畳み込みが作った記憶を受け取る（印は出さない。→ `marksFromHistory`）。
                // **長周期の鍵はこの更新で復元する `lpgmByEventId` から数える。`prev` ではない** ——
                // 起動時は前の状態が空なので、そちらを見ると復元した長周期の記憶ごと落とす。
                ...marksFromHistory(markMemory, cards, lpgmByEventId, prev.quakeUpdateMarks),
                // **貸し手は同じ更新で復元する `tsunamis`。`prev.tsunamis` ではない** ——
                // 起動時の復元では前の状態が空なので、そちらを見ると 1 枚も借りられない。
                earthquakes: borrowFromTsunamiIntoCards(cards, nextTsunamis),
                tsunamis: nextTsunamis,
                lpgmByEventId,
                lastUpdate: serverDate(),
                isLoading: false,
                hasMore: history.hasMore,
                error: null,
                // **一部が読めなかったことは画面へ出す。** ここへ来るのは「全滅しなかった」
                // ときだけで、`error` は立たない。出さないと「取れた分だけのカード」が
                // 「これが最新の地震情報のすべて」に見える。
                //
                // **置き換える。** ここは起動時の 1 回きりで、遡りの起点になる
                // （「もっと見る」側は壊れた電文だけ積む —— 理由はそちら）。
                historyLoss: telegramLossFrom(history.skippedByDay, history.failedArchiveUrls, {
                  sources: history.rateLimitedSources, telegrams: history.rateLimitedTelegrams,
                }),
              }
            })
            // 発表中の津波は画面にも見せる。**設定を尊重するかどうかは受け取る側が決める**
            // （`tsunamiPriorityDefault`）——その設定は「津波発表中はどのタブを既定にするか」を
            // 定めており、判定材料は `App` が持っている。
            if (tsunamis.length > 0) onStartupRestoreRef.current?.('tsunami')
            // **臨時情報・後発地震・解説情報はヘルパ経由で入れる。** ここで state を直書きすると、
            // 表示中の識別情報を覚える記憶（`shownNankaiEventIdRef` 等）が進まず、以後に届いた
            // 取消の照合が「表示していない」と誤判定して無条件に帯を消す。後発地震の期限タイマーも
            // `applyKohatsu` が張るので、ここで重ねて張らない。
            // **`extras` は種別ごとに振り分けてヘルパへ渡す。** 再生キューへ流す形（リプレイ側）は
            // ここでは採れない —— あちらは `silent` で音を抑えるが、こちらは音・読み上げ・通知を
            // 起こす経路（`handleEvent`）を通ることになる。
            //
            // 期限切れ・取消の判定は apply 側が持つ（取得側へ写すと片方だけ直したときに食い違う）。
            for (const e of history.extras) {
              const p = e.payload
              // **1 件ずつ独立させる。** この `for` は一回性（キュー経路のように `setInterval`
              // で汲み直す仕組みが無い）なので、途中の 1 件が例外を投げるとループ全体・ループ
              // 直後の津波失効イベント予約（下記）まで巻き添えになる（敵対的レビューで検出）。
              // **例外時も `recordSkippedTelegram` を呼ぶ**（2 巡目レビューで検出）——`catch` で
              // ログに残すだけだと、`applyXxx` が例外を投げた電文だけ録画イベントログから
              // 完全に消え、「onLiveEvent を呼ぶかどうかに関わらず全件記録する」という
              // このログの不変条件（ファイル冒頭のコメント）が例外時にだけ破られる。
              // 反映できたかは確かめようがないので `notApplied`（反映されなかった）で記録する。
              switch (p.kind) {
                case 'lpgm': break            // 上で記録・`lpgmByEventId` へ入れた
                // **`applied` を見て記録する。** キュー経路の silent 分岐（`applyNankai` 等の
                // 呼び出し）と同じパターン——反映できたら `silentReplayInit`、棄却されたら
                // `notApplied`。ここも `onLiveEvent` を呼ばないので、他 3 種別と同じ記録が漏れていた。
                case 'nankai': {
                  const applied = tryApplyExtra('南海トラフ臨時情報', p.data, applyNankai)
                  // 取消は「伝えた」に数える（同じ取消がライブで届いても鳴り直さない。→ `noteConveyedCancel`）
                  if (p.data.cancelled) noteConveyedCancel('nankai', p.data)
                  recordSkippedTelegram({ kind: 'nankai', data: p.data }, applied ? 'silentReplayInit' : 'notApplied')
                  break
                }
                case 'nankaiCommentary': {
                  const applied = tryApplyExtra('南海トラフ関連解説情報', p.data, applyNankaiCommentary)
                  // 取消は「伝えた」に数える（同じ取消がライブで届いても鳴り直さない。→ `noteConveyedCancel`）
                  if (p.data.cancelled) noteConveyedCancel('nankaiCommentary', p.data)
                  recordSkippedTelegram({ kind: 'nankaiCommentary', data: p.data }, applied ? 'silentReplayInit' : 'notApplied')
                  break
                }
                case 'kohatsu': {
                  const applied = tryApplyExtra('後発地震注意情報', p.data, applyKohatsu)
                  // 取消は「伝えた」に数える（同じ取消がライブで届いても鳴り直さない。→ `noteConveyedCancel`）
                  if (p.data.cancelled) noteConveyedCancel('kohatsu', p.data)
                  recordSkippedTelegram({ kind: 'kohatsu', data: p.data }, applied ? 'silentReplayInit' : 'notApplied')
                  break
                }
                case 'earthquakeCount': {
                  const applied = tryApplyExtra('地震回数に関する情報', p.data, applyEarthquakeCount)
                  // 取消は「伝えた」に数える（同じ取消がライブで届いても鳴り直さない。→ `noteConveyedCancel`）
                  if (p.data.cancelled) noteConveyedCancel('earthquakeCount', p.data)
                  recordSkippedTelegram({ kind: 'earthquakeCount', data: p.data }, applied ? 'silentReplayInit' : 'notApplied')
                  break
                }
                case 'quakeNotice': {
                  const applied = tryApplyExtra('お知らせ', p.data, applyQuakeNotice)
                  recordSkippedTelegram({ kind: 'quakeNotice', data: p.data }, applied ? 'silentReplayInit' : 'notApplied')
                  break
                }
                // **推計震度分布図は地震ごとに持つ**ので、過去の地震の分布も入れてよい
                // （同じ地震の古い報では退行しない → `upsertEstimatedIntensity`）。音・読み上げは
                // 起こさない（`announce` 偽）——聞いていない分布を「伝えた」台帳にも積まない。
                case 'estimatedIntensity': {
                  const applied = tryApplyExtra('推計震度分布図', p.data, data => applyEstimatedIntensity(data, false) !== null)
                  recordSkippedTelegram({ kind: 'estimatedIntensity', data: p.data }, applied ? 'silentReplayInit' : 'notApplied')
                  break
                }
                case 'event':
                  // `HISTORY_EXTRA_TYPES` に入らないので届かない。**種別を足したときに
                  // ここで止まるよう、既定へ落とさず名指しで書く。**
                  // （「もっと見る」側の同一分岐にも同じ注記がある。片方だけ直さないこと）
                  break
                default: {
                  const exhaustive: never = p
                  log.warn('[data] 履歴の補助情報に未知の種別', exhaustive)
                }
              }
            }
            // 初回ロードで津波が有効（validDateTime未来）の場合、キューへ解除イベントを挿入する。
            // **履歴で津波を当てたときは、積む前に古い失効予約を外す**（ライブで報を当てるときと同じ。外さないと、
            // ライブで先に当てた報の予約と履歴の予約が並び、早いほうが今の津波を終わらせる）。当てなかったときは触らない。
            // **津波の予約は `restoredQueueKeys` で重複を止めない。** 外してから積むので重なりようがなく、区分の食い違いで
            // 取り直す 2 回目は、1 回目の予約を外したあと同じ鍵で止められて、期限つきの津波が失効しなくなる。
            if (applyHistoryTsunami) {
              eventQueueRef.current.retain(entry => {
                if (entry.payload.kind !== 'event') return true
                const ev = entry.payload.event
                return ev.kind !== 'tsunami' || (ev as JMATsunami).cancelReason !== 'expired'
              })
            }
            if (tsunamis.length > 0 && latestTsunami?.validDateTime) {
              const expireTime = new Date(latestTsunami.validDateTime)
              if (expireTime > serverDate()) {
                eventQueueRef.current.push({
                  eventTime: expireTime,
                  payload: { kind: 'event', event: { ...latestTsunami, cancelled: true, cancelReason: 'expired' } as AppEvent },
                  logEntry: null,
                })
              }
            }
          })
          .catch((err: unknown) => {
            if (stale()) {
              // **取り直しで捨てた版の失敗は、画面には出さず記録にだけ残す。** 覚えた区分が外れていた
              // 証拠なので、黙って捨てると「なぜ取り直したか」を追えない。時間軸が変わった後の
              // 打ち切り（`cancelled`）は、従来どおり黙る
              // 打ち切りによる失敗は想定内なので info、打ち切る前に起きた本物の失敗（402・500 等）は warn に分ける
              if (!cancelled) {
                const aborted = isAbortedByCaller(err) || (err instanceof Error && err.message === 'cancelled')
                if (aborted) log.info('[data] 取り直しで打ち切った DMDATA 履歴取得', { 区分: classifications })
                else log.warn('[data] 取り直しで捨てた版の DMDATA 履歴取得が失敗していた', { 区分: classifications, err })
              }
              return
            }
            // 記録を残すのは state と別の話。standard 版側の同じ .catch と揃える。
            // ここへ来るのはキーの形が正しい場合の失敗（ネットワーク断・401・500 等）で、
            // 画面には理由の分からないメッセージしか出ないため、手がかりを残さないと追えない。
            // **引いた区分も添える** —— 前回受け付けられた区分の覚えで引いた場合、覚えが外れていた
            // のか通信の失敗なのかをここで見分ける
            log.error('[data] DMDATA 履歴取得失敗', { 区分: classifications, err })
            const msg = err instanceof Error ? err.message : '取得失敗'
            setState(prev => ({ ...prev, isLoading: false, error: msg }))
          })

        // **発表中の緊急地震速報を復元する。** 地震・津波の履歴とは別に走らせる —— 緊急地震速報の
        // 取得は地震ごとに詳細を辿るぶん遅くなりうるのに、いちばん早く見せたいものだから。
        // `Promise.all` へ入れると、取得の遅いこちらが地震一覧の表示まで待たせることになる。
        //
        // **音も読み上げも鳴らさない。** 開いた本人は既に揺れを体験しているので、起動直後の
        // 警報音は情報を足さずに驚かせるだけ（無音のままにすることは 2026-10-21 ユーザー承認
        // 「無音のまま記録する (Recommended)」）。`silent` を立ててキューへ積むと、状態の更新と
        // 自動解除の予約（`handleEvent` が `calcEEWCancelTime` で積む）は通り、`onLiveEvent`
        // だけが呼ばれない。画面を見せる側はタブ要求として別に出す。
        // **この取得は打ち切りの合図を受け取らない**（`fetchDmdataActiveEews` が signal を持たない）。取り直しで
        // 版が古くなっても通信は最後まで走り、結果だけ `stale` で捨てる。余分になるのは取り直しが起きた起動の
        // 一覧 1 回ぶんだけなので、打ち切りの配線は足していない
        void Promise.resolve()
          .then(() => (stale() ? [] : fetchDmdataActiveEews(dmdataApiKey, classifications, dmdataTestDeliveryRef.current)))
          .then(eews => {
            if (stale() || eews.length === 0) return
            // 前の版が積み終えた電文は積まない（→ `restoredQueueKeys`）。取り直しの最中に終えた地震も戻さない（→ `eewEndedRef`）
            const fresh = eews.filter(eew => !restoredQueueKeys.has(`eew:${eew.id}`) && !skipEndedEew(eewEndedRef.current, eew, '起動時の復元'))
            if (fresh.length === 0) return
            for (const eew of fresh) {
              restoredQueueKeys.add(`eew:${eew.id}`)
              eventQueueRef.current.push({
                eventTime: serverDate(),
                silent: true,
                payload: { kind: 'event', event: eew as AppEvent },
                logEntry: null,
              })
            }
            log.info(`[data] 発表中の緊急地震速報を復元しました: ${fresh.length} 件`)
            // 読み上げ側の記憶にも載せる（キューの報は silent なので読み上げ側へ届かない）。
            // ここで投げても画面の要求は出す——記憶に載らなければ取消が声にならないだけで済むが、
            // 画面が移らないと発表中の速報そのものに気づけない。
            try {
              onStartupRestoreEewsRef.current?.(fresh)
            } catch (err) {
              log.error('[data] 復元した緊急地震速報を読み上げ側へ渡せませんでした（取り消されても読み上げません）:', err)
            }
            onStartupRestoreRef.current?.('realtime')
          })
          .catch((err: unknown) => {
            // 取得側で失敗はすべて捕まえて空配列を返すため、ここへは届かない想定。
            // 万一漏れた場合に地震・津波の履歴を巻き込まないための保険なので、素通しにせず記録を残す。
            log.error('[data] 発表中の緊急地震速報の復元で想定外の失敗', err)
          })
      }

      if (remembered !== null) {
        startRestFetches(remembered)
      } else {
        // 覚えが無ければ、申し込みの結果（決まらなければ上限の 15 秒で既定の区分）を待つ
        void ws.classificationsReady.then((classifications) => {
          if (!cancelled) startRestFetches(classifications)
        })
      }

      // EEW の pref 補完用に細分区域名→都道府県の逆引きインデックスを先読みする。
      // インデックスは取得成功の購読で受ける。この変数は接続中に届く「すべての」EEW に使い回される
      // ため、単に .then で一度だけ埋めると、初回取得が一時的に失敗しただけでこの接続の間ずっと
      // 補完が効かない状態に固定されてしまう。購読しておけば、他の呼び出し元（地図・地震カード）の
      // 再取得が成功した時点で以降の EEW から補完が復帰する。
      // 取得できなくても EEW 自体は流す（都道府県名が付かないだけ）が、無音にはしない。
      let areaPrefIndex: ReadonlyMap<string, string> | null = null
      const unsubscribeStationCoords = onStationCoordsLoaded(data => {
        areaPrefIndex = areaPrefIndexOf(data)
      })
      loadStationCoords()
        .catch(err => {
          log.warn('[data] station-coords 取得失敗（EEW 予想震度の都道府県名が補完されない。読み上げの地域順も気象庁順に並ばない）', err)
        })

      ws.onEvent = (ev) => {
        if (ev.kind === 'lpgm') {
          const lpgm = ev.data
          // 台帳の扱いはキュー経路と同じ（→ `utils/lpgmRetraction.ts`）
          if (lpgm.cancelled) addLpgmRetraction(lpgmRetractionsRef.current, lpgmRetractionOf(lpgm), MAX_LPGM_RETRACTIONS)
          else if (isRetractedLpgm(lpgmRetractionsRef.current, lpgm)) {
            log.warn('[lpgm] 取消以前に発表された報を捨てた', { eventId: lpgm.eventId, time: lpgm.time })
            recordSkippedTelegram({ kind: 'lpgm', data: lpgm }, 'notApplied')
            return
          }
          // 印付けもキュー経路と同じ関数で（→ `applyLiveLpgmWithMarks`）
          setState(prev => ({ ...prev, ...applyLiveLpgmWithMarks(prev, lpgm, Date.now()) }))
          // 流すかの判定もキュー経路と同じ（→ `lpgmNotifiable`・`decideDispatch`）。この経路は常にライブ
          // （silent の概念を持たない）。流さないものは録画ツール向けに必ず記録する（3巡目レビューで、ここだけ
          // else が無く記録が丸ごと抜けていたのを検出した）。
          const lpgmDecision = lpgmNotifiable(lpgm) ? decideDispatch('lpgm', lpgm, true, false, false) : 'notDispatched'
          if (lpgmDecision === 'dispatch') {
            onLiveEventRef.current?.({ kind: 'lpgm', data: lpgm })
          } else {
            recordSkippedTelegram({ kind: 'lpgm', data: lpgm }, lpgmDecision)
          }
        } else if (ev.kind === 'nankai') {
          const nankai = ev.data
          // キュー経路と同じ関数を通す（規則を 2 箇所に書かない。理由は `applyNankai`）。
          const otherUnit = cancelOverOtherUnit(shownNankaiEventIdRef.current, nankai)
          const decision = decideDispatch('nankai', nankai, applyNankai(nankai), false, otherUnit)
          if (decision === 'dispatch') {
            onLiveEventRef.current?.({ kind: 'nankai', data: nankai })
          } else {
            recordSkippedTelegram({ kind: 'nankai', data: nankai }, decision)
          }
        } else if (ev.kind === 'nankaiCommentary') {
          const commentary = ev.data
          const decision = decideDispatch('nankaiCommentary', commentary, applyNankaiCommentary(commentary), false, false)
          if (decision === 'dispatch') {
            onLiveEventRef.current?.({ kind: 'nankaiCommentary', data: commentary })
          } else {
            recordSkippedTelegram({ kind: 'nankaiCommentary', data: commentary }, decision)
          }
        } else if (ev.kind === 'kohatsu') {
          const kohatsu = ev.data
          const otherUnit = cancelOverOtherUnit(shownKohatsuEventIdRef.current, kohatsu)
          const decision = decideDispatch('kohatsu', kohatsu, applyKohatsu(kohatsu), false, otherUnit)
          if (decision === 'dispatch') {
            onLiveEventRef.current?.({ kind: 'kohatsu', data: kohatsu })
          } else {
            recordSkippedTelegram({ kind: 'kohatsu', data: kohatsu }, decision)
          }
        } else if (ev.kind === 'quakeNotice') {
          const notice = ev.data
          if (applyQuakeNotice(notice)) {
            onLiveEventRef.current?.({ kind: 'quakeNotice', data: notice })
          } else {
            recordSkippedTelegram({ kind: 'quakeNotice', data: notice }, 'notApplied')
          }
        } else if (ev.kind === 'earthquakeCount') {
          const count = ev.data
          const decision = decideDispatch('earthquakeCount', count, applyEarthquakeCount(count), false, false)
          if (decision === 'dispatch') {
            onLiveEventRef.current?.({ kind: 'earthquakeCount', data: count })
          } else {
            recordSkippedTelegram({ kind: 'earthquakeCount', data: count }, decision)
          }
        } else if (ev.kind === 'estimatedIntensity') {
          const ei = ev.data
          const applied = applyEstimatedIntensity(ei, true)
          if (applied) {
            onLiveEventRef.current?.({ kind: 'estimatedIntensity', data: ei, isNew: applied.isNew })
          } else {
            recordSkippedTelegram({ kind: 'estimatedIntensity', data: ei }, 'notApplied')
          }
        } else {
          const data = ev.data
          const enriched = data.kind === 'eew' ? enrichEEWPref(data as EEWAlert, areaPrefIndex) : data
          enqueueEvent(enriched)
        }
      }
      ws.onStatusChange = status =>
        setState(prev => ({ ...prev, connectionStatus: status }))
      ws.onRawMessage = appendTelegramLog
      ws.onClassifications = (classifications) => {
        if (cancelled) return
        // 配信元が受け付けた区分を覚える（次に開いたとき、申し込みの結果を待たずに履歴を取るため）
        rememberClassifications(dmdataApiKey, classifications)
        // **覚えた区分で始めていたら、最初に受け付けられた区分と突き合わせる。** 食い違えば
        // （契約・鍵の権限が変わった）、受け付けられた区分で履歴と復元を取り直す
        if (!rememberedChecked) {
          rememberedChecked = true
          if (remembered !== null && !sameClassifications(remembered, classifications)) {
            log.info('[DMDSS] 前回と受け付けられた区分が違うため、履歴と発表中の緊急地震速報を取り直します', {
              前回: remembered, 今回: classifications,
            })
            startRestFetches(classifications)
          }
        }
        // 「もっと見る」は押した時点の最新の区分で引く（最初の取り決めが既定の区分へ倒れた後で、
        // 再接続が一部の区分だけで通った場合も追随する）
        dmdataRestClassificationsRef.current = classifications
        // 再接続のたびに同じ区分で状態を作り直さない（リプレイの取得関数まで作り直される）
        setState(prev => (
          prev.dmdataClassifications?.join(',') === classifications.join(',')
            ? prev
            : { ...prev, dmdataClassifications: classifications }
        ))
      }
      // **覚えで始めて、最初の取り決めが受け付けを得ないまま決着したとき。** 突き合わせの相手が
      // 無いので、理由で分ける
      ws.onClassificationsUnsettled = (reason) => {
        if (cancelled || remembered === null || rememberedChecked) return
        if (reason === 'auth') {
          // この鍵では繋がらない（認証エラー・受けられる区分が無い）。覚えを残すと、次の起動でも
          // 受けられない区分で履歴を引いて断られるので消す。次の起動からは今までどおり申し込みの
          // 結果を待つ。**この起動の履歴は覚えで走っているが、取り直さない** —— 既定の区分で引いても
          // 同じく断られる見込みで、失敗は履歴取得の側が画面へ出す
          rememberedChecked = true
          forgetClassifications(dmdataApiKey)
          log.warn('[DMDSS] 認証エラーのため、前回受け付けられた区分の覚えを消しました', { 前回: remembered })
          return
        }
        // 409・通信の失敗が続いて決まらない。覚えのまま続ける（既定の区分より、前回実際に受け付け
        // られた区分のほうが当たっている見込みが高い）。**突き合わせは止めない** —— 後で繋がって
        // 受け付けられた区分が違えば、そこで取り直す
        log.info('[DMDSS] 受けられる区分をチケットで確かめられないため、前回受け付けられた区分のまま履歴と復元を続けます', { 前回: remembered })
      }
      // **繋がっていなかった間に出た電文を取り戻す**（#927）。DMDATA の WebSocket は張り直しても
      // 切れていた間の電文を送り直さない。隙間は 2 つある ——
      //   - 張り直し: 前の接続で最後に何か受け取った時刻から、いま繋がった時刻まで
      //   - 起動: 履歴が目録を引いた時刻から、最初に繋がった時刻まで。申し込みの結果を待つ形でも、
      //     区分はチケットの応えで決まり、その後に WebSocket が開くので隙間がある。前回受け付けられた
      //     区分で先に始めた形・決まらないまま既定の区分で始めた形（409 が続く）では秒単位に伸びる。
      //     最初に繋がった時点で履歴がまだ始まっていなければ、履歴が繋がった後の分まで引くので取りに行かない
      // 起動時の履歴と同じく音・読み上げ・タブ移動は起こさない（標準版の張り直しの取り戻しと同じ扱い。
      // 2026-10-20 ユーザー承認「おすすめで」）。キューへ `silent` で積み、ライブの報と同じ `handleEvent` を通す
      // —— 統合（同じ電文を二度数えない・古い報で退行しない）と津波の新旧の比べ方をライブと共有するため。
      //
      // **取り戻しは 1 本ずつ順に走らせる**（標準版の `p2pBackfillChain` と同じ理由）。区間は下の `owedFromMs` 1 つに
      // 寄せ、回が始まるときに受け取る —— 履歴を待っている間に張り直しが重なっても、最初の回がいちばん古い左端から
      // 1 度だけ引き、後の回は引く区間が残っていないので何もせずに終わる（回線が明滅したとき、同じ左端あたりの窓を
      // 回数ぶん引き直さない）。どの段が投げても鎖は解決済みに戻す —— 戻さないと、以後の張り直しの取り戻しが 1 つも走らなくなる。
      //
      // **緊急地震速報は別の鎖で回す。** 地震・津波の取り戻しは履歴を当て終えるまで待つが、発表中の速報を戻すのに
      // 履歴は要らない。同じ鎖に並べると、履歴の取得が長引く間、張り直しの直後にいちばん要る速報が戻らない。
      const makeChain = (label: string) => {
        let chain: Promise<void> = Promise.resolve()
        return (step: () => Promise<void>): void => {
          chain = chain.then(step).catch((err: unknown) => {
            if (!cancelled) log.error(`[DMDSS] ${label}の順番待ちで想定外の失敗`, err)
          })
        }
      }
      const enqueueBackfill = makeChain('取り戻し')
      const enqueueEewRestore = makeChain('緊急地震速報の取り戻し')
      // まだ取り戻せていない区間の左端（エポックミリ秒）。張り直しのたびに古いほうへ寄せ、取り戻しが始まるときに
      // 受け取る。取れなかったとき（通信の失敗・取得制限で見送った電文・取り直せば読めうる電文がある）は戻す ——
      // 次の窓は新しい「最後に受けた時刻」から始まるので、戻さないとその区間が二度と引かれない。
      //
      // **戻すのは 1 度だけ**（`owedIsRetry`）。引き直した回でもまた取れなければ、記録して諦める。回数を限らないと、
      // 恒久的に読めない電文が 1 通あるだけで左端が古いまま窓が伸び続け、張り直しのたびに同じ区間を引き直す。
      // 持ち越した区間に新しい張り直しの区間が合流すると、印は 1 つなので合流した分も引き直しの回になり、
      // 次の回が失敗すると両方を諦める（張り直しが続くときに起きうる既知の制約。諦めたことは記録に残る）
      let owedFromMs: number | null = null
      let owedReason = ''
      let owedIsRetry = false
      const oweFrom = (fromMs: number, reason: string): void => {
        if (owedFromMs === null || fromMs < owedFromMs) {
          owedFromMs = fromMs
          owedReason = reason
        }
      }
      // 画面に「接続が切れていた間の電文を取り込めず」を出すかの 2 つの理由（→ `reconnectGapLoss`）。
      // 持ち越した区間は次の回が引き直すので、回が始まるたびに降ろし、その回がまた取れなければ立て直す。
      // 諦めた区間はこの接続の間は二度と引かないので、立てたら降ろさない（再読み込みで履歴が取り直す）
      let gapCarried = false
      let gapGivenUp = false
      // 張り直しの間の緊急地震速報を取り直せなかった（→ `restoreEewsAfterReconnect`）。次の張り直しの取り直しは
      // その時点で発表中のものを全部引き直すので、取れたら降ろす（2026-10-21 ユーザー承認「案1で」）
      let eewGap = false
      const publishGapLoss = (): void => {
        const missing = gapCarried || gapGivenUp || eewGap
        setState(prev => (prev.reconnectGapLoss === missing ? prev : { ...prev, reconnectGapLoss: missing }))
      }
      // **履歴を当て終えるまで待つ。** 先に当てると、履歴が過去の報から引き継ぐ津波の有効期限より前に、同じ報が
      // 引き継ぎ元の無いまま当たる（履歴の取得は成否を問わず決着する）。待っている間に取り直しが始まったら、その新しい
      // 版も待つ（「もっと見る」と同じ。1 本だけ待つと、待ち始めた時点の版しか見ない）
      const waitHistorySettled = async (): Promise<void> => {
        for (let waiting = dmdataHistorySettledRef.current; ; waiting = dmdataHistorySettledRef.current) {
          await waiting.catch(() => {})
          if (dmdataHistorySettledRef.current === waiting) return
        }
      }
      const runBackfill = async (): Promise<void> => {
        await waitHistorySettled()
        // 始まる時点で区間を受け取る。ここより後に来た張り直しは、次の回が引く
        if (cancelled || owedFromMs === null) return
        const startMs = owedFromMs
        const reason = owedReason
        const isRetry = owedIsRetry
        owedFromMs = null
        owedIsRetry = false
        // 持ち越していた区間はこの回が引き直す。取れなければ下でまた立てる
        gapCarried = false
        const from = new Date(startMs - DMDATA_RECONNECT_BACKFILL_MARGIN_MS)
        const to = serverDate()
        // 取れなかった区間を次の張り直しへ持ち越す。引き直しの回だったなら持ち越さずに諦める（→ `owedIsRetry`）
        const carryOrGiveUp = (detail: string, err?: unknown, carryFromMs = startMs): void => {
          if (isRetry) {
            log.error(`[DMDSS] ${reason}の取り戻しを諦めました（${from.toISOString()}〜${to.toISOString()}。引き直しても${detail}。この間の電文が一覧に無いことがあります）`, ...(err === undefined ? [] : [err]))
            gapGivenUp = true
            return
          }
          oweFrom(carryFromMs, reason)
          owedIsRetry = true
          gapCarried = true
          log.warn(`[DMDSS] ${reason}の取り戻しで${detail}（次に繋がり直したとき、1 度だけ引き直します）`, ...(err === undefined ? [] : [err]))
        }
        let got: Awaited<ReturnType<typeof fetchLiveTelegramsBetween>>
        try {
          got = await fetchLiveTelegramsBetween(
            dmdataApiKey, from, to, dmdataTestDelivery, id => ws.hasReceivedTelegram(id), historyAbort.signal,
          )
        } catch (err) {
          if (cancelled) return
          // その場では取り直さない（次に繋がり直したとき、この区間から引き直す）。7 日の履歴を取り直すことはしない
          // （2026-10-20 ユーザー承認「おすすめで」）。取れなかったことは地震タブの帯にも出す（→ `reconnectGapLoss`）
          carryOrGiveUp('電文の一覧を引けませんでした', err)
          publishGapLoss()
          return
        }
        if (cancelled) return
        // 取れた分を当てる途中で投げたら、区間はもう受け取ってあるので持ち越されない。帯を立ててから投げ直す
        // （投げ直した先は鎖の catch が記録する）。立てないと、取れていない区間があるのに帯が出ない
        try {
          const timed: { at: number; payload: QueuePayload }[] = []
          // 受信時刻は取得側が必ず添える。万一引けなければ窓の右端に置く（先頭へ回して古い報として当てない）
          const atOf = (e: JMAQuake | JMATsunami) => got.receivedAt.get(e)?.getTime() ?? to.getTime()
          for (const q of got.quakes) timed.push({ at: atOf(q), payload: { kind: 'event', event: q } })
          for (const t of got.tsunamis) timed.push({ at: atOf(t), payload: { kind: 'event', event: t } })
          for (const e of got.extras) timed.push({ at: e.replayTime.getTime(), payload: e.payload })
          // 受け取った順に当てる（キューは同じ発火時刻なら積んだ順に出す）
          timed.sort((a, b) => a.at - b.at)
          const eventTime = serverDate()
          // **取り戻した電文は電文ログに載らない**（`logEntry: null`）。この経路は WebSocket を
          // 通らないので `onRawMessage` が呼ばれず、本文も `ReplayPayload` へ読んだ後しか
          // 手元に無い。**今回の変更より前からの穴**で、載せるには取得側が本文を保つ必要がある。
          for (const { payload } of timed) eventQueueRef.current.push({ eventTime, silent: true, payload, logEntry: null })
          log.info(`[DMDSS] ${reason}の取り戻し（${from.toISOString()}〜${to.toISOString()}）: 地震情報 ${got.quakes.length} 通・津波 ${got.tsunamis.length} 通・ほか ${got.extras.length} 通を当てます（ライブで受け取り済み ${got.alreadyReceivedCount} 通）`)
          // 持ち越すときの左端。ページの上限に当たったなら、読めた新しい側だけに絞る（古い側をまた引くと同じところで止まる）
          let carryFromMs = startMs
          if (got.reachedOnlyBack !== null) {
            // 一覧のページの上限に当たった。新しい側の読めた分は上で当てた。届かなかった古い側は、引き直しても同じところで
            // 止まるので持ち越さずに諦める（2026-10-20 ユーザー承認「おすすめで」。7 日の履歴も取り直さない）
            log.error(`[DMDSS] ${reason}の取り戻しで、電文一覧のページの上限に当たりました（${from.toISOString()}〜${got.reachedOnlyBack.toISOString()} の電文は取り戻していません。一覧に無いことがあります）`)
            carryFromMs = got.reachedOnlyBack.getTime() + DMDATA_RECONNECT_BACKFILL_MARGIN_MS
            gapGivenUp = true
          }
          // 待てば取れうる電文（取得制限で見送った・取得か読み取りが例外で終わった）があれば、次の取り戻しで同じ区間から引き直す
          const retryable = got.rateLimitedTelegrams + got.failedTelegrams
          if (retryable > 0 && got.failedTelegrams === 0) {
            // 取得制限だけなら、引き直しの回数に数えない。429 の窓は待てば明けるので、明けた後の回で取れる
            oweFrom(carryFromMs, reason)
            owedIsRetry = isRetry
            gapCarried = true
            log.warn(`[DMDSS] ${reason}の取り戻しで、取得制限のため ${got.rateLimitedTelegrams} 通を見送りました（次に繋がり直したとき、引き直します）`)
          } else if (retryable > 0) {
            carryOrGiveUp(` ${retryable} 通を取れませんでした（取得制限で見送り ${got.rateLimitedTelegrams} 通・取得の失敗 ${got.failedTelegrams} 通）`, undefined, carryFromMs)
          }
          // 読めない形の電文と、断片が揃わなかった推計震度分布図。引き直しても同じなので持ち越さない
          const unreadable = got.skipped - got.failedTelegrams
          // 画面には数えない（→ `reconnectGapLoss`。引き直しても再読み込みしても同じ）
          if (unreadable > 0) log.warn(`[DMDSS] ${reason}の取り戻しで、読めなかった電文（推計震度分布図の断片が揃わなかったものを含む）が ${unreadable} 通ありました`)
          publishGapLoss()
        } catch (err) {
          gapGivenUp = true
          publishGapLoss()
          throw err
        }
      }
      const backfillFrom = (fromMs: number, reason: string): void => {
        oweFrom(fromMs, reason)
        enqueueBackfill(runBackfill)
      }
      // 切れていた間に発表された緊急地震速報を戻す（起動時の復元と同じ取得）。音は鳴らさない。
      // **台帳の報番号より新しい報だけ積む** —— 表示中の速報の続報もここで入る（地震単位で除くと、切れる前から
      // 出ていた速報が古い予想のまま残る）。同じ報番号は入口が通してしまうので、ここで止める。
      // **切れていた間に始まった地震（台帳に無い）があれば、起動時の復元と同じ画面の要求を出す**
      // （2026-10-21 ユーザー承認「おすすめで」）。ライブなら発報で実時間タブへ移るので、出さないと音も画面の
      // 移動も無いまま戻り、別のタブを見ている人は気づけない。強さは起動時と同じ（`onStartupRestore`）。
      // 見ていた地震の続報だけなら出さない —— その画面は切れる前にもう移している
      const restoreEewsAfterReconnect = async (): Promise<void> => {
        if (cancelled) return
        const classifications = dmdataRestClassificationsRef.current
        if (!classifications) {
          log.warn('[DMDSS] 受けられる区分がまだ決まっていないため、張り直しの間の緊急地震速報は取り直しません')
          eewGap = true
          publishGapLoss()
          return
        }
        const { eews, complete } = await fetchDmdataActiveEewsOutcome(dmdataApiKey, classifications, dmdataTestDeliveryRef.current)
        if (cancelled) return
        eewGap = !complete
        publishGapLoss()
        let endedCount = 0
        let startedWhileAway = false
        const fresh = eews.filter((eew) => {
          if (restoredQueueKeys.has(`eew:${eew.id}`)) return false
          // 取り直しの最中に終えた地震は戻さない（台帳は画面から消えた時点で捨てているので、下の比較では弾けない）
          if (skipEndedEew(eewEndedRef.current, eew, '張り直しの復元')) { endedCount++; return false }
          const key = eewEventKey(eew)
          const acceptance = eewAcceptanceRef.current.get(key)
          if (!acceptance) startedWhileAway = true
          const accepted = acceptance?.serialByOrigin.get(eew.origin)
          const serial = eewSerial(eew)
          if (accepted === undefined || serial === null || serial > accepted) return true
          // 報は積まないが、詳細の全報から載せた特別警報の印は移す（→ `carryEverSpecialWarning`）。取得の間にライブが追いつくと
          // ここで落ちるので、移さないと切れていた間に特別警報だった速報が警報として残る
          if (eew.everSpecialWarning) carryEverSpecialWarning(key, '張り直しの復元で受け取り済みの報')
          return false
        })
        if (fresh.length === 0) {
          if (eews.length > 0) log.info(`[DMDSS] 張り直しの間の緊急地震速報: 発表中の ${eews.length} 件はどれも戻しません（受け取り済みの報 ${eews.length - endedCount} 件・画面から消えた地震の報 ${endedCount} 件）`)
          return
        }
        for (const eew of fresh) {
          restoredQueueKeys.add(`eew:${eew.id}`)
          // 1 つ上の取り戻しと同じ理由で電文ログには載らない（`logEntry: null`）
          eventQueueRef.current.push({ eventTime: serverDate(), silent: true, payload: { kind: 'event', event: eew as AppEvent }, logEntry: null })
        }
        log.info(`[DMDSS] 張り直しの間に発表された緊急地震速報を戻しました: ${fresh.length} 件（発表中 ${eews.length} 件のうち。受け取り済みの報 ${eews.length - fresh.length - endedCount} 件・画面から消えた地震の報 ${endedCount} 件は戻さない）${startedWhileAway ? '。切れていた間に始まった地震があるので実時間タブを要求します' : ''}`)
        try {
          onStartupRestoreEewsRef.current?.(fresh)
        } catch (err) {
          log.error('[DMDSS] 張り直しで戻した緊急地震速報を読み上げ側へ渡せませんでした（取り消されても読み上げません）:', err)
        }
        if (startedWhileAway) onStartupRestoreRef.current?.('realtime')
      }
      ws.onStarted = ({ previousAliveAtMs }) => {
        if (cancelled) return
        if (previousAliveAtMs !== null) {
          backfillFrom(previousAliveAtMs, '張り直し')
          enqueueEewRestore(restoreEewsAfterReconnect)
        } else if (historyBeforeMs !== null) {
          backfillFrom(historyBeforeMs, '起動から接続まで')
        } else {
          log.info('[DMDSS] 最初に繋がった時点で履歴がまだ始まっていないため、起動から接続までの取り戻しは見送ります（履歴が繋がった後の分まで引きます）')
        }
      }
      ws.connect()

      return () => {
        cancelled = true
        historyAbort.abort()
        unsubscribeStationCoords()
        ws.disconnect()
      }
    }

    // --- 通常版: P2PQuake ---
    // 取得に入る前に読み込み中へ戻す（DMDSS 分岐と対称）。これが無いと、リプレイを「リセット」で
    // 終えた直後に地震一覧が一瞬「地震情報はありません」と出る——再生中は上の早期 return で
    // isLoading を畳んでおり、stop() が state を空にした状態でこの分岐へ入るため、未取得なのに
    // 「0 件」として表示されてしまう（EarthquakeTab は isLoading → error → 0件 の順に見る）。
    setState(prev => (prev.isLoading && !prev.error ? prev : { ...prev, isLoading: true, error: null }))

    // **この接続で見た津波の報のうち、いちばん新しい発表時刻**（エポックミリ秒）。張り直したときの
    // 取り戻しは、これより新しい報があるときだけ津波を差し替える —— 張り直した直後にライブで
    // 届いた取消を取り戻した古い発表報で上書きし、終わった津波を甦らせないため。
    let p2pTsunamiSeenMs = Number.NEGATIVE_INFINITY
    // 張り直しの取り戻しを順に並べる鎖（→ `ws.onReconnected`）。**先頭は起動時の履歴**（下で繋ぐ）
    let p2pBackfillChain: Promise<void>
    const noteP2pTsunamiSeen = (t: JMATsunami | undefined): void => {
      if (!t) return
      const ms = new Date(t.time).getTime()
      if (Number.isFinite(ms) && ms > p2pTsunamiSeenMs) p2pTsunamiSeenMs = ms
    }
    // 有効な津波（validDateTime が未来）なら、キューへ解除イベントを挿入する。
    // VAR-1 の副作用対応: standard 版で kyoshin リプレイのトグル時にこの effect が cleanup→
    // 再実行されるため、同一 eventId の既存 expired 予約を除去してから積む（TSU-1 と同じ排除）。
    // 起動時の履歴と、張り直したときの取り戻しの両方が通る。
    const armP2pTsunamiExpiry = (latestTsunami: JMATsunami): void => {
      if (!latestTsunami.validDateTime) return
      const purgeKey = latestTsunami.eventId
      eventQueueRef.current.retain(entry => {
        if (entry.payload.kind !== 'event') return true
        const ev = entry.payload.event
        if (ev.kind !== 'tsunami') return true
        const evAny = ev as JMATsunami
        if (evAny.cancelReason !== 'expired') return true
        if (purgeKey && evAny.eventId) return evAny.eventId !== purgeKey
        return evAny.id !== latestTsunami.id
      })
      const expireTime = new Date(latestTsunami.validDateTime)
      if (expireTime > serverDate()) {
        eventQueueRef.current.push({
          eventTime: expireTime,
          payload: { kind: 'event', event: { ...latestTsunami, cancelled: true, cancelReason: 'expired' } as AppEvent },
          logEntry: null,
        })
      }
    }

    // **張り直しの取り戻しは、この取得が片付いてから走らせる**（鎖の先頭に置く）。この取得は一覧を
    // 空から組み直して丸ごと差し替えるので、取り戻しが先に終わると積んだ分を消してしまう。
    // 失敗しても下の `.catch` で受けるので、鎖は止まらない
    p2pBackfillChain = Promise.all([
      fetchJmaQuakePage({ limit: INITIAL_HISTORY_PAGE_SIZE }, historyAbort.signal, 'foreground'),
      fetchHistory([552], 10, 0, historyAbort.signal),
    ])
      .then(([quakePage, tsunamiEvents]) => {
        const quakeEvents = quakePage.events
        if (cancelled) return
        // 種別横断の生電文をイベントごとに統合する（DMDSS 版・リアルタイムと同一ロジック）。
        // 以前は earthquake.time をキーにした Map で「優先度が最も高い 1 報」を選んでいたが、
        // P2PQuake の earthquake.time は分単位のため、同じ分に起きた別の地震が 1 枚に潰れていた。
        rememberQuakeRetractionsFromBatch(quakeEvents)
        // **地震の単位で選ぶ**（→ `MAX_HISTORY_RETAINED`・`selectQuakeHistory`）。API のページングは
        // 電文単位なので、そのまま畳むと地震の多い期間ほど一覧が薄くなる。**取消の台帳へは選ぶ前の
        // 全電文を積む** —— 選から漏れた地震の取消でも、後から届いた古い報を弾くのに要る。
        //
        // **時刻を読めない電文は選ぶ前に外す。** `selectQuakeHistory` は並べ替えに時刻を使うので、
        // `NaN` が混ざると並びが壊れる（外した分は畳み込みへも渡さない —— どのみち新旧を決められない）。
        // P2PQuake の時刻は読み取りの入口で ISO の形へ直してあるので（`services/p2pquake.ts` の `p2pTime`）、
        // ここで外れるのは入口でも直せなかった電文だけ。**外したら記録する** —— 黙ると、一覧から地震が
        // 消えた理由が残らない（かつて Safari で受信時刻を読めず、全件がここで黙って消えた）。
        const historyTimed = quakeEvents.map(q => ({ q, time: new Date(q.time).getTime() }))
        const historyCandidates = historyTimed.filter(c => Number.isFinite(c.time))
        const historyUntimed = historyTimed.filter(c => !Number.isFinite(c.time))
        if (historyUntimed.length > 0) {
          log.warn(
            `[p2pquake] 初回履歴で時刻を読めない地震情報 ${historyUntimed.length} 通を外した`,
            historyUntimed.slice(0, 3).map(c => ({ id: c.q.id, time: c.q.time })),
          )
        }
        const selected = selectQuakeHistory(
          historyCandidates, c => c.q, c => c.time,
          { maxEvents: MAX_HISTORY_RETAINED, windowStartMs: null },
          getAreaPrefIndexCache(),
        )
        const selectedQuakes = selected.map(c => c.q)
        // **選から漏れた電文は次の「もっと見る」へ回す。** 捨てると、その地震は一覧に二度と出ない ——
        // `offset` は引いた電文の数だけ進むので、次の取得はこれより古い電文から始まる
        // （100 通に 51 地震以上が入る形＝地震の多い期間ほど起きる）。
        // **持ち越すのは選抜に掛けた電文のうち漏れたものだけ。** `quakeEvents` から引くと、
        // 時刻を読めず選抜の手前で外した電文まで持ち越してしまい、次の「もっと見る」では
        // 畳み込みへ入る —— 同じ電文が初回では外れ、次では入る食い違いになる
        // （`readTime` は直せない時刻でも警告を出して元の文字列を返すので、この形は通り抜ける）。
        const selectedSet = new Set(selectedQuakes)
        p2pCarryOverRef.current = historyCandidates.filter(c => !selectedSet.has(c.q)).map(c => c.q)
        // 畳み込みが作った記憶も受け取る（印は出さない。→ `marksFromHistory`）。
        const { cards: earthquakes, markMemory } = mergeQuakeHistory(selectedQuakes, [], quakeRetractionsRef.current, getAreaPrefIndexCache())
        const { latest: latestTsunami, active: tsunamis } = selectP2pTsunamiSnapshot(tsunamiEvents as JMATsunami[], serverDate())
        // **「もっと見る」の起点は配信元が返した電文の数。** 選んだ地震の数でも、読めた電文の数でも
        // ない —— API の `offset` は配信元が並べた電文で数えるので、読めなかった分まで進めないと
        // 次の取得が同じ電文を引き直す（漏れた地震は上の `p2pCarryOverRef` が持ち越す）。
        p2pRawOffsetRef.current = quakePage.rawCount
        setState(prev => ({
          ...prev,
          // 畳み込みが作った記憶を受け取る（印は出さない。→ `marksFromHistory`）。
          ...marksFromHistory(markMemory, earthquakes, prev.lpgmByEventId, prev.quakeUpdateMarks),
          // ライブ経路・DMDSS の復元と同じ扱いを通す。**standard 版では貸し手が居ない**
          // （P2PQuake は津波電文の原因地震を配信しない）ので実際には何も変わらないが、
          // 経路ごとに扱いを違えない —— 片方だけ直すと、次に触る人がどちらが正なのか判らない。
          earthquakes: borrowFromTsunamiIntoCards(earthquakes, tsunamis),
          tsunamis,
          lastUpdate: serverDate(),
          isLoading: false,
          // **配信元が返した電文の数で見る**（2026-10-23 ユーザー承認「引けた電文の数で見る」
          // 「生の件数で見る」）。上限まで返ってきたなら、その先にまだ電文がある。
          // **読めた電文の数では見ない** —— 1 通でも読めないと上限に届かず、先があるのに
          // ボタンが消える。選んだ地震の数でも見ない（地震の少ない期間に 50 件へ届かない）。
          //
          // **持ち越しがあるときも出す。** 上限に届かない応答でも 50 地震を超えていれば漏れが出る
          // （配信元の障害・短い応答）。ボタンが無いと、その地震は一覧に二度と出ない。
          hasMore: quakePage.rawCount === INITIAL_HISTORY_PAGE_SIZE || p2pCarryOverRef.current.length > 0,
          error: null,
        }))
        noteP2pTsunamiSeen(latestTsunami)
        // 津波の復元は **standard 版でも効く**（DMDSS 版限定なのは緊急地震速報のほうだけで、
        // P2PQuake には発表中の緊急地震速報を取る経路が無い）。
        if (tsunamis.length > 0) onStartupRestoreRef.current?.('tsunami')
        if (tsunamis.length > 0 && latestTsunami) armP2pTsunamiExpiry(latestTsunami)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        log.error('[fetch] 初回データ取得失敗', err)
        const msg = err instanceof Error ? err.message : '取得失敗'
        setState(prev => ({ ...prev, isLoading: false, error: msg }))
      })

    const ws = new P2PQuakeWebSocket()
    wsRef.current = ws
    // P2PQuake WS の EEW（VXSE43/45 相当・内部 code=556）も、Yahoo hypoInfo と同じく全処理（音・読み上げ・
    // 通知・タブ移動）へ通す。どちらの経路から来ても `handleEvent` の入口で同じ地震の報として統合し
    // （`mergeEewReport`）、同じ報を別の経路から受けたときは音・通知を起こさない（`eewSameReport`）。
    // かつては Yahoo が先に拾った速報だけ P2PQuake を区域の注入に回していて、P2PQuake が先に拾った
    // 速報の続報まで注入に回り、続報の音・読み上げ・通知が出なかった。
    ws.onEvent = (event: AppEvent) => {
      if (event.kind === 'eew') {
        // 試験報は設定「試験報を受信」が真なら流す（印は `handleEvent` の入口で付く。→ `admitTrainingEew`）
        if (event.test && !dmdataTestDeliveryRef.current) { recordSkippedTelegram(event, 'testReport'); return }
        const eew = event as EEWAlert
        // この key はそのまま台帳（`eewAcceptanceRef`）のキーになる。式を書き写すと
        // 導出が変わったときに片方だけ追従し、台帳と状態のキーが割れる。
        const key = eewEventKey(eew)
        if (event.cancelled) {
          // Yahoo が検出する前に誤報取消された場合は hypoInfo 消滅イベントが来ない。
          // activeEEWs に残っていれば解除処理を通す。**取消の前に画面から消えた地震の誤報取消も通す**
          // （普通の誤報取消と同じく伝える。→ `isLateEewCancel`。2026-10-22 ユーザー承認「効かせる (Recommended)」）。
          // 判定は入口でもう一度行う（キューで待つ間に記憶が変わりうる）
          const lateCancel = isLateEewCancel(eewEndedRef.current.get(key), eew, serverNow(), ACTIVE_EEW_WINDOW_MS)
          if (stateRef.current.activeEEWs.has(key) || lateCancel) {
            enqueueEvent(event)
          } else {
            // 画面に無く、消えた地震の記憶でも伝える取消ではない（窓切れ・取消済み・一度も出ていない）
            log.debug(`[eew] P2PQuake の誤報取消を通さない（画面に無い地震）: key=${key}`)
            recordSkippedTelegram(event, 'notApplied')
          }
          return
        }
        enqueueEvent(eew)
        return
      }
      if (event.kind === 'tsunami') noteP2pTsunamiSeen(event as JMATsunami)
      enqueueEvent(event)
    }
    ws.onStatusChange = status =>
      setState(prev => ({ ...prev, connectionStatus: status }))
    ws.onRawMessage = appendTelegramLog
    // **張り直したら、切れていた間の情報を取り戻す**（2026-10-06 ユーザー承認。見張りの張り直しも
    // 普通の切断からの張り直しも同じ）。切れていた間に配信された報はこの接続では二度と届かない。
    // 起動時の履歴と同じ扱いで積み、音・読み上げは出さない（2026-10-06 ユーザー承認）。
    //
    // **取り戻しは 1 本ずつ順に走らせる。** 回線が明滅して張り直しが重なると、取り戻しが並行して
    // 同じ時間を何度も取る（`/history` の枠を想定より早く使う）。前の回を打ち切る形にしないのは、
    // 前の回が担う「それより前に切れていた間」を落とすため。
    ws.onReconnected = lastReceivedAtMs => {
      p2pBackfillChain = p2pBackfillChain.then(() => backfillSince(lastReceivedAtMs))
    }
    // 取り戻せなかった区間はこの接続の間は引き直さないので、立てたら再読み込みまで降ろさない（→ `reconnectGapLoss`）
    const markP2pGapLoss = (): void => {
      setState(prev => (prev.reconnectGapLoss ? prev : { ...prev, reconnectGapLoss: true }))
    }
    const backfillSince = (lastReceivedAtMs: number): Promise<void> => {
      if (cancelled) return Promise.resolve()
      const sinceMs = lastReceivedAtMs - P2P_RECONNECT_BACKFILL_MARGIN_MS
      return fetchHistorySince([551, 552], sinceMs, historyAbort.signal)
        .then(({ events, rawCount, truncated }) => {
          if (cancelled) return
          if (truncated) {
            // 黙って切ると、遡り切れなかった時間が「何も無かった」に化ける
            log.warn(`[p2pquake] 張り直し後の取り戻しがページ上限に達しました（${new Date(sinceMs).toISOString()} まで遡り切れていない可能性・取得 ${events.length} 件）`)
            // 遡り切れなかった古い側は、次の張り直しでも引き直さない（次の窓は新しい「最後に受けた時刻」から始まる）
            markP2pGapLoss()
          }
          const quakes = events.filter((e): e is JMAQuake => e.kind === 'quake')
          const tsunamiEvents = events.filter((e): e is JMATsunami => e.kind === 'tsunami')
          const { latest: latestTsunami, active } = selectP2pTsunamiSnapshot(tsunamiEvents, serverDate())
          const latestMs = latestTsunami ? new Date(latestTsunami.time).getTime() : Number.NaN
          const replaceTsunami = latestTsunami !== undefined && Number.isFinite(latestMs) && latestMs > p2pTsunamiSeenMs
          // 届いた件数も並べる。差は壊れていて捨てた分で、個々の理由は変換側が記録する
          log.info(`[p2pquake] 張り直し後に取り戻した報: 配信元 ${rawCount} 件のうち 地震情報 ${quakes.length} 件・津波 ${tsunamiEvents.length} 件${replaceTsunami ? '（津波を差し替え）' : ''}`)
          if (quakes.length === 0 && !replaceTsunami) return
          noteP2pTsunamiSeen(latestTsunami)
          rememberQuakeRetractionsFromBatch(quakes)
          setState(prev => {
            const tsunamis = replaceTsunami ? active : prev.tsunamis
            // 既存カード群を base に統合する（「もっと見る」と同じ扱い）。同じ電文は重ねず、
            // 古い報が後から当たっても当て直すので、ライブで届いた分と順番が前後しても崩れない。
            const { cards, markMemory } = mergeQuakeHistory(
              quakes, prev.earthquakes, quakeRetractionsRef.current, getAreaPrefIndexCache(), prev.quakeMarkMemory,
            )
            return {
              ...prev,
              ...marksFromHistory(markMemory, cards, prev.lpgmByEventId, prev.quakeUpdateMarks),
              earthquakes: borrowFromTsunamiIntoCards(cards, tsunamis),
              tsunamis,
              lastUpdate: serverDate(),
            }
          })
          if (replaceTsunami && active.length > 0 && latestTsunami) {
            onStartupRestoreRef.current?.('tsunami')
            armP2pTsunamiExpiry(latestTsunami)
          }
        })
        .catch((err: unknown) => {
          if (cancelled) return
          // 失敗しても再試行しない（次に張り直したときは、その接続で最後に受けた時刻から取る）。切れていた間の分は
          // 一覧に無いまま残るので、地震タブの帯にも出す（2026-10-21 ユーザー承認「A・X・揃える」。2026-10-06 には
          // 記録だけと決めていた）。ここで投げ直さないので、順に並べる鎖（`p2pBackfillChain`）は止まらない
          log.error('[p2pquake] 張り直し後の取り戻しに失敗', err)
          markP2pGapLoss()
        })
    }
    ws.connect()

    return () => {
      cancelled = true
      historyAbort.abort()
      ws.disconnect()
    }
  }, [handleEvent, enqueueEvent, appendTelegramLog, dmdataApiKey, dmdataTestDelivery, replayTimeOffset, carryEverSpecialWarning])

  /**
   * 「もっと見る」で読んだ履歴を画面へ当てる。**ライブの DMDSS 版と再生中（両バリアント）が通る。**
   *
   * 地震カードは既存のカードを base に統合し、長周期・推計震度分布図は反映し、帯（南海トラフ臨時情報・
   * 解説情報・後発地震注意情報・地震回数・お知らせ）は当てずに記録だけ残す。経路ごとに書き分けると、
   * 片方だけ帯を当てる・長周期を落とす形でずれる。
   *
   * @param hasMore 続きを出すか。**決め方は経路が持つ**（ライブは取得側の在庫の判定、再生中は続きの口の有無）
   */
  const applyLoadedHistory = useCallback((history: QuakeHistoryResult, hasMore: boolean) => {
    const events = history.quakes
    // 既存カード群を base に、新バッチの生電文を eventId ごとに統合する。
    // これによりバッチ跨ぎ（先に届いた VXSE61 単独カードへ後続の VXSE53 の震度を合流など）も
    // リアルタイムと同一結果になる。
    // 台帳への記録は setState の外で行う（更新関数は再実行されうるため副作用を持たせない）。
    rememberQuakeRetractionsFromBatch(events)
    // 長周期は同じアーカイブに入っているので、拾うだけで追加の通信は要らない
    const lpgmEvents = history.extras
      .map(e => e.payload)
      .filter((p): p is { kind: 'lpgm'; data: JMALpgm } => p.kind === 'lpgm')
      .map(p => p.data)
    // **記録は setState の外で行う**（台帳と同じ理由——更新関数は再実行されうるため
    // 副作用を持たせない）。
    //
    // **「もっと見る」は nankai 等を画面へ反映しない**（ライブ・再生中とも。2026-09-25 ユーザー承認。
    // 選択「記録だけ追加（推奨）」・2026-10-14 維持）。起動時の履歴復元と違い、ここは既存カードの
    // 厚みを増やすためにさらに古い日を遡る経路——古い日にあった南海トラフ等の電文を `applyNankai` 等へ
    // 通すと、無条件に上書きする実装のため、**現在表示中の最新の帯情報を古い内容で置き換えてしまう**。
    // lpgm だけは地震カードに紐づく情報で「もっと見る」が増やすカードの一部なので反映する。
    //
    // 反映しない種別でも、録画ログの原則（onLiveEvent を呼ぶかどうかに関わらず全件記録する）
    // に従い、届いた事実は記録する（お知らせも他の帯と同じく記録する）。
    for (const lpgm of lpgmEvents) {
      // 取消の扱いは起動時と同じ（「伝えた」に数える。→ `decideDispatch`）
      recordSkippedTelegram({ kind: 'lpgm', data: lpgm }, silentLpgmSkip(lpgm))
    }
    for (const e of history.extras) {
      const p = e.payload
      // **起動時側と違い try/catch は置いていない。** この 2 行の switch は
      // `recordSkippedTelegram`（自己保護済み）と `break`/`log.warn` しか呼ばず、
      // 起動時側のような `applyXxx` の呼び出しを持たないため、例外源が無い。
      switch (p.kind) {
        case 'lpgm': break // 上で記録・下の setState で `lpgmByEventId` へ入れる
        // **常に `notDispatched`。** 電文の中身（取消・階級等）を見て決めているのではなく、
        // 「もっと見る」という**この取得経路自体**が nankai 等を反映しないと決めている
        // ——`notDispatched` の型定義（`replayEventLog.ts`）が想定する「電文の内容で
        // 除外する」ケースとは理由が異なるが、他に当てはまる値が無いため転用する
        // （型定義側の docstring にもこの経路単位の用法を追記済み。敵対的レビューで指摘）。
        case 'nankai':
          recordSkippedTelegram({ kind: 'nankai', data: p.data }, 'notDispatched')
          break
        case 'nankaiCommentary':
          recordSkippedTelegram({ kind: 'nankaiCommentary', data: p.data }, 'notDispatched')
          break
        case 'kohatsu':
          recordSkippedTelegram({ kind: 'kohatsu', data: p.data }, 'notDispatched')
          break
        case 'earthquakeCount':
          recordSkippedTelegram({ kind: 'earthquakeCount', data: p.data }, 'notDispatched')
          break
        case 'quakeNotice':
          recordSkippedTelegram({ kind: 'quakeNotice', data: p.data }, 'notDispatched')
          break
        // **推計震度分布図は反映する**（帯と違い、長周期と同じく「もっと見る」が増やす
        // カードの一部）。地震ごとに持つので、古い日の分布が今の地震の分布を上書きすることは
        // ない（同じ地震の古い報でも退行しない → `upsertEstimatedIntensity`）。音・読み上げは
        // 起こさない。**例外源があるので個別に囲う**（上の注記の例外）。
        case 'estimatedIntensity': {
          const applied = tryApplyExtra('推計震度分布図', p.data, data => applyEstimatedIntensity(data, false) !== null)
          recordSkippedTelegram({ kind: 'estimatedIntensity', data: p.data }, applied ? 'silentReplayInit' : 'notApplied')
          break
        }
        case 'event':
          // `HISTORY_EXTRA_TYPES` に入らないので届かない（起動時側の同一分岐と同じ注記。
          // 片方だけ直さないこと）。
          break
        default: {
          const exhaustive: never = p
          log.warn('[data] 履歴の補助情報に未知の種別（もっと見る）', exhaustive)
        }
      }
    }
    // **津波も画面へは当てず、届いた事実だけを記録する**（帯と同じ理由。古い日の津波の報で、いま
    // 表示中の津波を上書き・復活させない）。記録しないと、録画ログからは届いたこと自体が消える
    for (const tsunami of history.tsunamis) {
      recordSkippedTelegram(tsunami, 'notDispatched')
    }
    // 台帳へ積むのは状態更新の関数の外（あちらは 2 度呼ばれうる）
    recordLpgmRetractions(lpgmEvents, lpgmRetractionsRef.current)
    setState(prev => {
      // 画面の値へ積み増す。**台帳に当たる報は採らない** —— ライブで取り消して消した長周期が、
      // 古い日を読み足したときに戻らないように（→ `utils/lpgmRetraction.ts`）。
      const lpgmByEventId = foldLpgmHistory(prev.lpgmByEventId, lpgmEvents, lpgmRetractionsRef.current)
      // 畳み込みが作った記憶を受け取る（印は出さない。→ `marksFromHistory`）。
      const { cards, markMemory } = mergeQuakeHistory(
        events, prev.earthquakes, quakeRetractionsRef.current, getAreaPrefIndexCache(), prev.quakeMarkMemory,
      )
      const merged = borrowFromTsunamiIntoCards(cards, prev.tsunamis)
      return {
        ...prev,
        // **長周期の鍵はこの更新で積み増した `lpgmByEventId` から数える** ——
        // このバッチで増えた長周期もこの更新で入るので、`prev` を見るとその記憶を落とす。
        ...marksFromHistory(markMemory, cards, lpgmByEventId, prev.quakeUpdateMarks),
        earthquakes: merged,
        lpgmByEventId,
        // **残し方の判断は `mergeHistoryLoss` が持つ**（中身によって違う。理由はそちら）。
        //
        // **「積むか置き換えるか」をここで決めないこと。** そう見えるときは、中身が
        // 「同じものを二度数えうる」形になっている —— 直す先は持ち方のほう。
        historyLoss: mergeHistoryLoss(prev.historyLoss, history),
        // 押し直せば回復しうる側の表示は、成功したので消す
        loadMoreFailed: false,
        hasMore,
      }
    })
  }, [rememberQuakeRetractionsFromBatch, applyEstimatedIntensity])

  /**
   * 再生中の「もっと見る」。リプレイの開始時の履歴が置いた続きの口（`replayLoadMoreRef`）で読む。
   *
   * **口が無ければ読まずにボタンを畳む。** ライブの経路へは落とさない —— あちらは `serverDate()`（いま）から
   * 遡るので、再生時刻より未来の地震が一覧に並ぶ。
   */
  const loadMoreReplayHistory = useCallback(async () => {
    const loadMore = replayLoadMoreRef.current
    if (loadMore === null) {
      // **通常は届かない。** 口が無いときは `hasMore` も偽で、ボタンが出ていない ——
      // `restoreQuakeHistory` が口の有無で決め、開始時の履歴の取得に失敗したときは呼ばれないので
      // `resetState` が落とした偽のまま残る。ここへ来たら、ライブで立った `hasMore` が残ったまま
      // 再生へ切り替わったなど前提が崩れているので、記録してボタンを畳む
      log.warn('[data] 再生中の「もっと見る」に続きを読む先がありません（ボタンを畳みます）')
      setState(prev => (prev.hasMore ? { ...prev, hasMore: false } : prev))
      return
    }
    const generation = replayHistoryGenerationRef.current
    const stale = () => replayHistoryGenerationRef.current !== generation
    const signal = replayLoadMoreAbortRef.current?.signal ?? null
    setState(prev => ({ ...prev, isLoadingMore: true }))
    try {
      const history = await loadMore(signal)
      // 再生を止めた・始め直した・履歴が差し替わった後に届いた分は捨てる（「取得中」の解除は finally が担う）
      if (stale()) return
      // **次の口へ進めるのは成功したときだけ。** 失敗したら同じ口のまま、押し直せば同じ範囲を読み直す
      replayLoadMoreRef.current = history.loadMore
      applyLoadedHistory(history, history.loadMore !== null)
    } catch (err) {
      // 時間軸が変わった後の失敗は誰も困っていない（ライブの「もっと見る」と同じ扱い）
      if (stale()) {
        log.debug('[data] 古い再生の追加読み込みが失敗（結果は破棄）', err)
        return
      }
      log.error('[data] 再生中の地震履歴の追加読み込みに失敗', err)
      setState(prev => ({ ...prev, loadMoreFailed: true }))
    } finally {
      setState(prev => (prev.isLoadingMore ? { ...prev, isLoadingMore: false } : prev))
    }
  }, [applyLoadedHistory])

  const loadMoreEarthquakes = useCallback(async () => {
    if (stateRef.current.isLoadingMore || !stateRef.current.hasMore) return
    // **再生中は再生の続きだけを読む**（→ `loadMoreReplayHistory`）。下のライブの経路はいまから遡る
    if (replayActiveRef.current) {
      await loadMoreReplayHistory()
      return
    }
    // **この取得が「まだ有効か」を測る物差し。**
    // 電文本体の取得は最長で数分かかる（→ `services/telegramBody.ts` の取得間隔）。そのあいだに
    // リプレイが始まる・接続が張り直されると、届いた電文は**別の時間軸の一覧**へ流し込まれる。
    // 接続 effect の `cancelled` はそちらのスコープに閉じていて、ここからは触れないので、
    // 作り直しのたびに進む世代の番号で見分ける。
    const generation = liveGenerationRef.current
    // DMDSS 版の履歴の取り直しを挟んだ取得も古い（前の区分で読んだ続きを、取り直した一覧へ足さない）。
    // 下で、進行中の履歴の取得を待った後の番号に取り直す
    let restRun = dmdataRestRunRef.current
    const stale = () => liveGenerationRef.current !== generation || dmdataRestRunRef.current !== restRun
    // 同じ時間軸の打ち切りの合図（接続 effect が作り、作り直しのクリーンアップで立てる）
    const signal = liveHistoryAbortRef.current?.signal ?? null
    setState(prev => ({ ...prev, isLoadingMore: true }))
    try {
      if (isDmdss) {
        const apiKey = dmdataApiKeyRef.current
        // 初回と同じ理由で逐次に反映する。**控えが空のうちは 1 件 6 秒**なので、
        // 揃うまで待つ形だと押してから数分ボタンが無反応に見える。
        const applyPartialMore = (partial: JMAQuake[]): void => {
          if (stale()) return
          rememberQuakeRetractionsFromBatch(partial)
          setState(prev => {
            // 畳み込みが作った記憶を受け取る（印は出さない。→ `marksFromHistory`）。
            const { cards, markMemory } = mergeQuakeHistory(
              partial, prev.earthquakes, quakeRetractionsRef.current, getAreaPrefIndexCache(), prev.quakeMarkMemory,
            )
            return {
              ...prev,
              ...marksFromHistory(markMemory, cards, prev.lpgmByEventId, prev.quakeUpdateMarks),
              earthquakes: borrowFromTsunamiIntoCards(cards, prev.tsunamis),
            }
          })
        }
        // **前回の続きから、窓 1 つぶんを丸ごと読む**（→ `historyCursorRef`）。件数では打ち切らない
        // （→ `HISTORY_WINDOW_DAYS` の「件数の上限は置かない」）。
        //
        // カーソルが無いのは初回の履歴を読めていない場合。そのときは初回と同じ範囲を
        // もう一度試す（進めないだけで、押しても何も起きない状態にはしない）。
        // **進行中の履歴の取得（取り直しを含む）が決着するまで待つ**（→ `dmdataHistorySettledRef`）。
        // 待つ間もボタンは「取得中…」のまま
        // **待っている間に取り直しが始まったら、その新しい版も待つ**（待った約束が ref の中身と一致するまで繰り返す）。
        // 1 本だけ待つと、新しい版がまだカーソルを書いていない（null の）うちに初回と同じ窓を読みに行く
        for (let waiting = dmdataHistorySettledRef.current; ; waiting = dmdataHistorySettledRef.current) {
          await waiting
          if (dmdataHistorySettledRef.current === waiting) break
        }
        if (liveGenerationRef.current !== generation) return
        restRun = dmdataRestRunRef.current
        const before = historyCursorRef.current ?? serverDate()
        // **押すたびに新しい印を付けて取る**（`beginLoadMoreGateTag`）。ボタンが、この取得が門を
        // 通り終えるまでの残り時間を数える（→ `components/EarthquakeTab/LoadMoreButton.tsx`）。
        // 使い回さないのは、中断された前回の待ちを今回の分として数えないため（理由はその関数）。
        const history = await fetchDmdataQuakeHistoryFor(
          dmdataRestClassificationsRef.current,
          apiKey, before, HISTORY_WINDOW_DAYS, dmdataTestDeliveryRef.current, signal,
          applyPartialMore, stale, beginLoadMoreGateTag(),
        )
        // 時間軸が変わっていたら、取れた分ごと捨てる（「取得中」の解除は finally が担う）
        if (stale()) return
        // **カーソルを進めるのは成功したときだけ。** 失敗（catch）や時間軸の変化では据え置き、
        // 次に押したとき同じ窓を読み直す。先に進めて失敗時に戻す形にすると、接続を張り直す
        // effect のリセット（`historyCursorRef.current = null`）を後から踏み潰しうる。
        //
        // **進まなかったのに「まだある」と言われたら記録する。** 押しても永久に増えない状態で、
        // 画面には何の痕跡も出ない。取得側は読み切った日をカーソルにするので（地震が 0 件の日も
        // 含む）、通常は在庫がある限り必ず進む。
        const nextCursor = historyCursorFromOldestDay(history.oldestLoadedDay)
        if (nextCursor) historyCursorRef.current = nextCursor
        else if (history.hasMore) {
          // **429 の待機と本物の不具合を混ぜない。** 窓の最新の日が 429 の窓に入っていると
          // その日は読み切れず、カーソルは進まない —— それは待てば解ける正常な足踏みで、
          // 警告にすると解消するまで押すたび出続けて診断の価値が落ちる。
          if (history.rateLimitedSources.length > 0) {
            log.info('[data] 履歴のカーソルは進みませんでした（429 の窓が明けるまでの足踏み）')
          } else {
            log.warn('[data] 履歴のカーソルが進みませんでした（押しても増えない状態になります）')
          }
        }
        // **続きを出すかは取得側に任せる**（在庫＝アーカイブの目録が空になったか。→ `hasMore`）。
        // 増えたかどうかでは判定しない —— 30 日まるごと震度1以上の地震が無いことは起きうるが、
        // それは「もっと古い在庫が無い」ことを何も意味しない。遡り幅の上限も見ない（件数で打ち切って
        // 読み残した日があってもボタンが死ぬ）。
        applyLoadedHistory(history, history.hasMore)
      } else {
        const offset = p2pRawOffsetRef.current
        const page = await fetchJmaQuakePage({ limit: P2P_LOAD_MORE_BATCH, offset }, signal, 'foreground')
        // **配信元が返した数だけ進める**（読めた数ではない。理由は初回履歴の側と同じ）。
        p2pRawOffsetRef.current += page.rawCount
        // **初回に選から漏れた電文をここで合流させる**（→ `p2pCarryOverRef`）。取り込んだら空にする ——
        // 残すと次の「もっと見る」でも同じ電文を畳み直す（`mergeQuakeHistory` は冪等なので
        // カードは壊れないが、毎回無駄に畳むことになる）。
        const events = [...p2pCarryOverRef.current, ...page.events]
        p2pCarryOverRef.current = []
        // 既存カード群を base に新バッチを統合する（DMDSS 版と同じ扱い）。
        // バッチ跨ぎで同一イベントの続報が届いた場合もリアルタイムと同一結果になる。
        // 台帳への記録は setState の外で行う（理由は DMDSS 版側と同じ）。
        rememberQuakeRetractionsFromBatch(events)
        setState(prev => {
          // 畳み込みが作った記憶を受け取る（印は出さない。→ `marksFromHistory`）。
          const { cards, markMemory } = mergeQuakeHistory(
            events, prev.earthquakes, quakeRetractionsRef.current, getAreaPrefIndexCache(), prev.quakeMarkMemory,
          )
          return {
            ...prev,
            ...marksFromHistory(markMemory, cards, prev.lpgmByEventId, prev.quakeUpdateMarks),
            earthquakes: borrowFromTsunamiIntoCards(cards, prev.tsunamis),
            // **配信元が返した数で見る**（持ち越し分を足した `events.length` では見ない ——
            // 足したぶん上限を超えて、先が無いのにボタンが残る）。
            hasMore: page.rawCount === P2P_LOAD_MORE_BATCH,
            // 成功したので、押し直せば回復しうる側の表示は消す（DMDSS 版と揃える）
            loadMoreFailed: false,
          }
        })
      }
    } catch (err) {
      // **時間軸が変わった後の失敗は「失敗」として記録しない。** 結果ごと捨てる取得なので、
      // 誰も困っていない。理由が本物なら新しい世代が同じ理由で失敗して、そちらが記録する。
      // 痕跡は詳細ログへ落とす。
      if (stale()) {
        log.debug('[data] 古い世代の追加読み込みが失敗（結果は破棄）', err)
        return
      }
      // 追加読み込みの失敗は画面では「増えなかった」だけに見える（初回ロード用の error state は
      // 触らない）。ユーザーが再度押せる状態に戻すだけなので、理由はログに残す。
      //
      // **カーソルは触らない。** 進めるのは成功した後だけなので、ここへ来た時点で前回の位置の
      // まま。押し直せば同じ窓をもう一度読む。
      log.error('[data] 地震履歴の追加読み込みに失敗', err)
      // **画面にも出す。** 出さないと「押したのに何も起きない」だけに見え、もう一度押せば
      // 直るのか、これ以上遡れないのかが分からない。
      setState(prev => ({ ...prev, loadMoreFailed: true }))
    } finally {
      // **「取得中」の解除は抜け道を作らず、必ずここで行う。**
      // 成功パスの `setState` の中に混ぜていた頃は、`stale()` での早期 return だけが解除を
      // 通らなかった。冒頭のガード（`isLoadingMore` なら何もしない）と噛み合って、
      // **押してから API キーを変えた・リプレイを始めただけでボタンがリロードまで死ぬ**。
      // 画面には「取得中…」のまま押せないボタンが残るだけで、例外もログも出ない。
      setState(prev => (prev.isLoadingMore ? { ...prev, isLoadingMore: false } : prev))
    }
  }, [applyLoadedHistory, loadMoreReplayHistory])

  /**
   * テストボタンの台本（電文 XML の並び）を読み、**受信と同じイベントキューへ積む**
   * （→ `utils/testTelegrams.ts`）。
   *
   * 電文は**ライブ・リプレイと同じ入口**（`buildXmlPayload`）でパーサーを通るので、テストボタンが
   * 電文の読み取りまで確かめる。間を置いて次の報を流す待ちはキューが抱えるので、リセット
   * （リプレイの開始・停止）とアンマウントでキューごと落ちる。
   *
   * **ただしキューへ積むまでに `await` が 2 つある**（台本の読み込みと電文の取得）。その間に
   * リセットが入ると、キューを空にしても間に合わない —— 積む直前に世代を照らし合わせて捨てる
   * （→ `testGenerationRef`）。
   *
   * **失敗は記録に残す。** ボタンは Promise を待たないので、ここで握らないと「押したのに何も
   * 起きない」だけになる（電文の取得失敗・台本の書き換え先が見つからない、など）。
   */
  const runTestTelegramScript = useCallback(async (
    pick: (scripts: Awaited<ReturnType<typeof loadTestTelegramScripts>>) => TestTelegramScript,
  ) => {
    const generation = testGenerationRef.current
    try {
      const scripts = await loadTestTelegramScripts()
      const built = await buildTestTelegramEntries(pick(scripts), { isDmdss, now: serverDate() })
      if (generation !== testGenerationRef.current) {
        log.debug('[test] 組んでいる間にリセットされたので、テスト用の電文を捨てました')
        return
      }
      for (const { entry } of built) {
        eventQueueRef.current.push({ eventTime: entry.replayTime, payload: entry.payload, logEntry: entry.logEntry })
      }
    } catch (err) {
      log.error('[test] テスト用の電文を流せませんでした', err)
    }
  }, [])

  /**
   * 地震テスト（能登本震の震源・震度に関する情報。→ `testTelegramScripts.ts` の `EARTHQUAKE`）。
   * 長周期地震動の観測情報も一緒に流す（DMDSS 版だけ。電文そのものが標準版の受信元から届かない）。
   */
  const simulateEarthquake = useCallback(() => runTestTelegramScript(s => s.EARTHQUAKE), [runTestTelegramScript])

  /**
   * 津波の続報で区域ごとに等級が動くテスト（一部解除・一部引き上げ）。
   *
   * 発表 → `TEST_AUTO_DISMISS_MS` の半分で続報 → その `TEST_TSUNAMI_HIGH_TIDE_DELAY_MS` 後に
   * 各地の満潮時刻の報 → 満了で解除、と 4 段で進む。**続報を挟むのが要点** ——
   * 「〇〇から切り替え」の印は前報との比較（`areaGradeChangedKeys`）で立つので、1 通だけ流しても
   * 出ない。全体の最上位等級は大津波警報のまま動かないため、区域単位の変化を見る経路
   * （→ docs/spec/tsunami-spec.md §10）はここでしか通らない。
   *
   * **4 段目（満潮時刻の報）は、その印が消えないことを確かめるためにある。** 等級について何も
   * 言っていない続報で、アプリから見れば「まだ声にしていない等級変化が 1 件も無い報」になる。
   * かつては受信のたびに印を置き換えていたので、**これが届くと印が寿命を待たずに消えていた**。
   *
   * **DMDSS 版のみ。** 前回の等級（`LastKind`）は P2PQuake が配信しない。
   */
  const simulateTsunamiGradeChange = useCallback(() => runTestTelegramScript(s => s.TSUNAMI_GRADE_CHANGE), [runTestTelegramScript])

  /**
   * 「変化の小さい続報」テスト（DMDSS 版のみ。→ `testTelegramScripts.ts` の `TSUNAMI_QUIET_REPORTS`）。
   *
   * **通知音だけが鳴って何も声にならなかった報を、実機で確かめる唯一の入口。** 発表 → 11 通の続報 →
   * 全解除と進む。段の表と、段ごとに動かす 1 項目は台本にある。間隔は読み上げが終わる程度に空ける
   * （これらは最下位の層で読むので、前の発話が続いていると待たされ、待ちきれなければ黙る）。
   */
  const simulateTsunamiQuietReports = useCallback(() => runTestTelegramScript(s => s.TSUNAMI_QUIET_REPORTS), [runTestTelegramScript])

  /**
   * 訓練報のテスト。
   *
   * 気象庁は訓練・試験の電文をヘッダ（`Control/Status`）でだけ区別し、中身は本物と同じ形で
   * 流す。アプリは**あえて画面へ通し**（`test: false`）、代わりに「訓練報」の印を出して
   * 見分けられるようにしている（→ docs/spec/quake-spec.md §5「電文の運用種別」）。
   *
   * **その印を出す手段がこれしかない。** 実配信の訓練報は事前に予告されて流れるもので、
   * こちらの都合では受け取れない。印が出るかどうかを実機で確かめられる唯一の入口になる。
   */
  const simulateTrainingQuake = useCallback(() => runTestTelegramScript(s => s.TRAINING_QUAKE), [runTestTelegramScript])

  /**
   * 訂正報のテスト。**初報を先に出し、少し置いてから訂正報を流す**（初報 M7.4 → 訂正報 M7.6。
   * 電文と書き換えの中身は → `testTelegramScripts.ts` の `QUAKE_AMENDMENT`）。
   *
   * 訂正報は前の報を直すもので、単独では届かない。1 通だけ流すと「訂正」の印は出せても
   * **何が訂正されたのかが画面に出ない**ので、規模が変わる前後を続けて流す。
   */
  const simulateQuakeAmendment = useCallback(() => runTestTelegramScript(s => s.QUAKE_AMENDMENT), [runTestTelegramScript])

  /**
   * 種別が前後して届く報のテスト。**7 通を順に流す**（→ `testTelegramScripts.ts` の `QUAKE_REPORT_SEQUENCE`）。
   *
   * 3 通目で見出しが「震度速報#2/震源情報」になり、4 通目で速報段階が畳まれる
   * （→ docs/spec/quake-spec.md §8「見出しには受け取った種別を並べる」）。5 通目は観測点・市町村だけが
   * 増える続報、6 通目は完全版のあとに届く震度速報（据え置かれて**何も動かない**のが正しい。→
   * `utils/quakeMerge.ts` の `isSupersededByExistingCard`）、7 通目は観測点の震度が上下する続報。
   * **その見え方を実機で確かめられる入口がここしかない。**
   */
  const simulateQuakeReportSequence = useCallback(() => runTestTelegramScript(s => s.QUAKE_REPORT_SEQUENCE), [runTestTelegramScript])

  /**
   * 地震情報の取消のテスト（2024-01-01 23:05 の誤発表と 23:13 の取消。→ `QUAKE_CANCEL`）。
   * **DMDSS 版のみ**（P2PQuake は地震情報の取消を配信しない）。取消はカードへ印を付け、
   * 10 秒後に一覧から外す予約もキューへ積む（`useEarthquakes` の取消の分岐）。
   */
  const simulateQuakeCancel = useCallback(() => runTestTelegramScript(s => s.QUAKE_CANCEL), [runTestTelegramScript])

  /** 地震情報の一部の取消のテスト（→ `QUAKE_PARTIAL_CANCEL`）。**DMDSS 版のみ**。 */
  const simulateQuakePartialCancel = useCallback(() => runTestTelegramScript(s => s.QUAKE_PARTIAL_CANCEL), [runTestTelegramScript])

  /**
   * 震源を津波電文から借りる場面のテスト（能登本震の実電文の並び。→ `HYPOCENTER_FROM_TSUNAMI`）。
   *
   * **受信と同じ経路（イベントキュー）へ積む。** 借りる処理は状態更新と読み上げの両方に
   * 入っているので、`handleEvent` を直接呼ぶと片方しか踏まない。
   *
   * **DMDSS 版のみ。** P2PQuake は津波電文の原因地震を配信しないため、standard 版では
   * 借りる相手が居ない。
   */
  const simulateHypocenterFromTsunami = useCallback(() => runTestTelegramScript(s => s.HYPOCENTER_FROM_TSUNAMI), [runTestTelegramScript])

  /**
   * 津波の原因地震が後から加わる場面のテスト（→ `createTestTsunamiSourceAdded`）。
   *
   * **受信と同じ経路（イベントキュー）へ時刻つきで積む。** 解除まで含めて積むので待ちを張らずに済み、
   * リプレイ開始・リセットの `eventQueueRef.current.clear()` でそのまま落ちる。
   *
   * **DMDSS 版のみ。** P2PQuake は津波電文の `EventID` も原因地震も配信しない。
   */
  const simulateTsunamiSourceAdded = useCallback(() => runTestTelegramScript(s => s.TSUNAMI_SOURCE_ADDED), [runTestTelegramScript])

  /**
   * 津波情報（VTSE51）だけが取り消される場面のテスト（→ `createTestTsunamiInfoRetraction`）。
   *
   * 積み方は {@link simulateTsunamiSourceAdded} と同じ。**DMDSS 版のみ**（P2PQuake は情報名称ごとの
   * 取消を配信しない）。
   */
  const simulateTsunamiInfoRetraction = useCallback(() => runTestTelegramScript(s => s.TSUNAMI_INFO_RETRACTION), [runTestTelegramScript])

  /**
   * 市町村の未入電を含む地震情報のテスト（日向灘 2022-01-22）。
   *
   * 「地震テスト」（能登本震）では**市町村の未入電が 1 件も出ない** —— 発表条件が
   * 「配下に未入電の観測点があり、かつ市町村の最大震度が震度4以下（又は入電なし）」で、
   * 能登本震の未入電 3 地点が属する市町村はいずれも震度6強・6弱のため当たらない
   * （→ docs/spec/quake-spec.md §5「市町村の震度」）。
   *
   * **DMDSS 版のみ。** 市町村の粒度は DMDATA 経路でしか配信されない。
   */
  const simulateUnreceivedQuake = useCallback(() => runTestTelegramScript(s => s.UNRECEIVED_QUAKE), [runTestTelegramScript])

  /**
   * 最大震度に「以上」が付く地震情報のテスト（石川県西方沖 2024-11-26）。
   *
   * **他の地震テストでは出ない形。** 未入電の観測点は下限の 45（5弱）へ寄せてあるので、
   * 電文全体の最大震度が 45 の地震でだけ階級が一致し、カードの最大震度が「5弱以上」になる
   * （→ docs/spec/quake-spec.md §4「震度5弱以上未入電」）。地震テスト（能登本震・震度7）と
   * 未入電テスト（日向灘・震度5強）はどちらも階級が一致しないため、この形を持たない。
   *
   * **DMDSS 版のみ。** 未入電は DMDATA 経路でしか配信されない。
   */
  const simulateMaxScaleOrAboveQuake = useCallback(() => runTestTelegramScript(s => s.MAX_SCALE_OR_ABOVE_QUAKE), [runTestTelegramScript])

  /**
   * 区域まるごと「震度5弱以上未入電」の地震情報のテスト（日向灘の未入電テストの組み替え）。
   *
   * **実電文の標本が無い形を出す唯一の入口。** 配下の市町村がすべて未入電のとき、気象庁は区域の
   * 最大震度を載せない（→ `createTestAreaUnreceivedQuake`）。その区域が一覧・読み上げから
   * 消えないことを実機で確かめる。
   *
   * **DMDSS 版のみ。** 未入電は DMDATA 経路でしか配信されない。
   */
  const simulateAreaUnreceivedQuake = useCallback(() => runTestTelegramScript(s => s.AREA_UNRECEIVED_QUAKE), [runTestTelegramScript])

  /**
   * 推計震度分布図のテスト（→ `testTelegramScripts.ts` の `ESTIMATED_INTENSITY`）。
   *
   * **地震情報を先に出し、少し置いてから分布を流す。** 実運用では地震から数分後に届くもので、
   * そのころ地震カードは既に画面にある。同時に流すと、分布モードを開く側がカードを見つけられない
   * （引き当ては発現時刻だが、探す先の一覧にまだ載っていない）。続報と、そのあとの地震情報まで
   * 流すので、読み上げの言い分け（「受信しました」／「更新されました」）と、分布モードが閉じて
   * 発表値へ戻る遷移まで確かめられる。
   */
  const simulateEstimatedIntensity = useCallback(() => runTestTelegramScript(s => s.ESTIMATED_INTENSITY), [runTestTelegramScript])

  /** 遠地地震テスト（2026-07-17 メキシコ、チアパス州沿岸。→ `testTelegramScripts.ts` の `FOREIGN_QUAKE`）。 */
  const simulateForeignQuake = useCallback(() => runTestTelegramScript(s => s.FOREIGN_QUAKE), [runTestTelegramScript])

  /** 規模が「Ｍ８を超える巨大地震」の遠地地震テスト（→ `testTelegramScripts.ts` の `FOREIGN_QUAKE_HUGE`）。 */
  const simulateForeignQuakeHuge = useCallback(() => runTestTelegramScript(s => s.FOREIGN_QUAKE_HUGE), [runTestTelegramScript])

  /**
   * 押すたびに台本の次の 1 通を流す（緊急地震速報のテスト。→ `TestTelegramScript.stepByPress`）。
   *
   * **「いま」は最初の押下のものを使い回す。** 時刻の寄せ方と事象の識別子はそこから決まるので
   * （→ `utils/testScenarioReplay.ts` の `instantiateScenario`）、押すたびに取り直すと続報が
   * 別の地震として立ち、カードが増える。
   *
   * **何も押されないまま `silenceMs` が過ぎたら、残りを飛ばして最後の報を流す**（最終報か取消）。
   * 実配信では続報が自動で届くが、テストボタンは押した人が段を進める作りにしてある
   * （2026-10-22 ユーザー選択「押すたびに 1 通のまま」）。
   *
   * ## 種別ごとに 1 本ずつ、順に処理する
   *
   * 電文を組むには台本の読み込みと取得を待つ。**待っている間に次が始まると、どれも例外も
   * ログも出ないまま緊急地震速報が 1 通余計に生える** —— 連打で同じ段が 2 枚のカードになる、
   * 最終報と押下が同時に走って台帳から待ちが外れる、など。
   *
   * 割り込みを見つけて捨てる形は**判定が増えるほど穴が残る**（種別をまたいで捨ててしまう、
   * 照合を 1 か所書き忘れる）。代わりに**種別ごとの待ち行列へ並べて 1 本ずつ処理する** ——
   * 連打しても捨てずに順に進み、最終報も同じ列に乗るので押下と重ならない。
   *
   * 残る競合はリセット（`resetState`）だけで、そちらは世代（`testGenerationRef`）で捨てる。
   */
  const pressTestTelegramScript = useCallback((
    kind: TestEEWKind,
    pick: (scripts: Awaited<ReturnType<typeof loadTestTelegramScripts>>) => TestTelegramScript,
  ): Promise<void> => enqueueTestPress(kind, async () => {
    const generation = testGenerationRef.current
    try {
      const scripts = await loadTestTelegramScripts()
      const script = pick(scripts)
      const byPress = script.stepByPress
      if (!byPress) throw new Error('押すたびに進む台本ではありません')
      const prev = testEEWPressRef.current.get(kind)
      const now = prev?.now ?? serverDate()
      // **最後の 1 通は押しても出さない。** そこは最終報（または取消）で、黙ったときに流す
      const lastIndex = script.steps.length - 1
      const next = (prev?.index ?? -1) + 1
      if (next > lastIndex - 1) {
        // **末尾まで進んだら、押しても何もしない。** 同じ報をもう一度積んでも、報番号が同じなので
        // 古い報として弾かれる —— 画面からは「進まない」のか「壊れた」のか見分けが付かない。
        log.debug(`[test] 緊急地震速報のテスト（${kind}）は最後まで進んでいます（黙れば最終報が届きます）`)
        return
      }
      const built = await buildTestTelegramEntries(script, { isDmdss, now, limit: next + 1 })
      const current = built[next]
      if (!current) throw new Error(`テスト用の台本の ${next + 1} 通目を組めませんでした`)
      if (generation !== testGenerationRef.current) {
        log.debug(`[test] 組んでいる間にリセットされたので、テスト用の電文（${kind}）を捨てました`)
        return
      }
      if (prev) window.clearTimeout(prev.finalizeTimer)
      eventQueueRef.current.push({ eventTime: serverDate(), payload: current.entry.payload, logEntry: current.entry.logEntry })
      const finalizeTimer = window.setTimeout(() => {
        // **最終報も同じ列へ並べる。** 押下と重なると、台帳を見る順番で取り違える
        void enqueueTestPress(kind, async () => {
          try {
            const tail = await buildTestTelegramEntries(script, { isDmdss, now })
            const last = tail[byPress.cancelIndex ?? tail.length - 1]
            if (generation !== testGenerationRef.current) {
              log.debug(`[test] 組んでいる間にリセットされたので、テスト用の最終報（${kind}）を捨てました`)
              return
            }
            if (last) eventQueueRef.current.push({ eventTime: serverDate(), payload: last.entry.payload, logEntry: last.entry.logEntry })
            testEEWPressRef.current.delete(kind)
          } catch (err) {
            log.error('[test] テスト用の最終報を流せませんでした', err)
          }
        })
      }, byPress.silenceMs)
      testEEWPressRef.current.set(kind, { index: next, now, finalizeTimer })
    } catch (err) {
      log.error('[test] テスト用の電文を流せませんでした', err)
    }
  }), [enqueueTestPress])

  /** 予報テスト（豊後水道の第 1〜3 報。→ `testTelegramScripts.ts` の `EEW_FORECAST`）。 */
  const simulateEEWForecast = useCallback(() => pressTestTelegramScript('forecast', s => s.EEW_FORECAST), [pressTestTelegramScript])

  /** 警報テスト（**予報 → 警報の格上げ**を含む。→ `EEW_WARNING`）。 */
  const simulateEEWWarning = useCallback(() => pressTestTelegramScript('warning', s => s.EEW_WARNING), [pressTestTelegramScript])

  /** 特別警報テスト（震度6弱まで上がる。→ `EEW_SPECIAL_WARNING`）。 */
  const simulateEEW = useCallback(() => pressTestTelegramScript('special', s => s.EEW_SPECIAL_WARNING), [pressTestTelegramScript])

  /** 単独点処理テスト（仮定震源要素の初報 → 震源が決まった続報。→ `EEW_ASSUMED`）。 */
  const simulateEEWAssumed = useCallback(() => pressTestTelegramScript('assumed', s => s.EEW_ASSUMED), [pressTestTelegramScript])

  /** 強い揺れ検知テスト（仮定震源要素のまま予想震度を持つ報。→ `EEW_STRONG_SHAKING`）。 */
  const simulateEEWStrongShaking = useCallback(() => pressTestTelegramScript('strongShaking', s => s.EEW_STRONG_SHAKING), [pressTestTelegramScript])

  /** 深発地震テスト（深さ 450km。警報へ上がらない。→ `EEW_DEEP`）。 */
  const simulateEEWDeep = useCallback(() => pressTestTelegramScript('deep', s => s.EEW_DEEP), [pressTestTelegramScript])

  /**
   * 「予想震度なしのまま取消」テスト（DMDSS 版のみ。→ `EEW_NO_FORECAST`）。予想震度の欄そのものを
   * 持たない報が続き、値が付かないまま取り消される。
   */
  const simulateEEWNoForecast = useCallback(() => pressTestTelegramScript('noForecast', s => s.EEW_NO_FORECAST), [pressTestTelegramScript])

  /** 「予想震度0」テスト（震度1 未満の予想から、震度3 へ上がる。→ `EEW_FORECAST_ZERO`）。 */
  const simulateEEWForecastZero = useCallback(() => pressTestTelegramScript('forecastZero', s => s.EEW_FORECAST_ZERO), [pressTestTelegramScript])

  /** 誤報取消テスト（**実電文の取消**で終わる。→ `EEW_RETRACTION`）。 */
  const simulateEEWRetraction = useCallback(() => pressTestTelegramScript('retraction', s => s.EEW_RETRACTION), [pressTestTelegramScript])

  /**
   * 遅れた誤報取消テスト。最終報を流し、**自動解除で画面から消えた後に**同じ地震の取消を届ける
   * （→ `isLateEewCancel`。2026-10-22 ユーザー承認「足す (Recommended)」）。
   *
   * **押すたびには進まない。** 自動解除の時刻は電文ではなくアプリが決めるので（本番と同じ
   * `calcEEWCancelTime`）、台本の `atMs` では表せない —— ここで待ちを張る。
   *
   * **待ちは ref で追う**（リセット・アンマウントで落とす。→ `clearTestSimulationTimers`）。
   * 押し直したら前の待ちを捨てる。
   */
  const simulateEEWLateRetraction = useCallback((): Promise<void> => enqueueTestPress('lateRetraction', async () => {
    const generation = testGenerationRef.current
    try {
      const scripts = await loadTestTelegramScripts()
      const built = await buildTestTelegramEntries(scripts.EEW_LATE_RETRACTION, { isDmdss, now: serverDate() })
      const [final, cancel] = built
      if (!final || !cancel) throw new Error('遅れた誤報取消テストの電文を組めませんでした')
      if (generation !== testGenerationRef.current) {
        log.debug('[test] 組んでいる間にリセットされたので、遅れた誤報取消テストを捨てました')
        return
      }
      if (testEEWLateRetractionTimerRef.current !== null) window.clearTimeout(testEEWLateRetractionTimerRef.current)
      eventQueueRef.current.push({ eventTime: serverDate(), payload: final.entry.payload, logEntry: final.entry.logEntry })
      const payload = final.entry.payload
      const eew = payload.kind === 'event' && payload.event.kind === 'eew' ? payload.event : null
      const expiresAtMs = eew ? calcEEWCancelTime(eew, new Date(eew.time)).getTime() : NaN
      if (!Number.isFinite(expiresAtMs)) {
        log.error('[test] 遅れた誤報取消テスト: 自動解除の時刻を求められないため取消を流しません')
        return
      }
      const delayMs = Math.max(0, expiresAtMs - serverNow()) + scripts.EEW_LATE_RETRACTION_AFTER_EXPIRY_MS
      testEEWLateRetractionTimerRef.current = window.setTimeout(() => {
        testEEWLateRetractionTimerRef.current = null
        if (generation !== testGenerationRef.current) {
          log.debug('[test] 待っている間にリセットされたので、遅れた誤報取消を捨てました')
          return
        }
        eventQueueRef.current.push({ eventTime: serverDate(), payload: cancel.entry.payload, logEntry: cancel.entry.logEntry })
      }, delayMs)
    } catch (err) {
      log.error('[test] テスト用の電文を流せませんでした', err)
    }
  }), [enqueueTestPress])

  /** 大津波警報テスト（2011 東北の気象庁サンプル電文。観測状態を一通り持つ。→ `TSUNAMI_MAJOR_WARNING`）。 */
  const simulateTsunami = useCallback(() => runTestTelegramScript(s => s.TSUNAMI_MAJOR_WARNING), [runTestTelegramScript])

  /** 津波警報テスト（能登本震 16:12。→ `testTelegramScripts.ts` の `TSUNAMI_WARNING`）。 */
  const simulateTsunamiWarning = useCallback(() => runTestTelegramScript(s => s.TSUNAMI_WARNING), [runTestTelegramScript])

  /** 津波注意報テスト（2015-11-14 薩摩半島西方沖。→ `TSUNAMI_WATCH`）。 */
  const simulateTsunamiWatch = useCallback(() => runTestTelegramScript(s => s.TSUNAMI_WATCH), [runTestTelegramScript])

  /**
   * 津波予報テスト（2024-11-26 石川県西方沖。→ `TSUNAMI_FORECAST`）。
   *
   * 予報だけの津波は、DMDSS 版の実運用では失効時刻（`validDateTime`）で静かに消える（解除の電文を
   * 伴わない）。標準版は失効の予約を持たないので、台本が片付けの報を標準版だけに流す。
   */
  const simulateTsunamiForecast = useCallback(() => runTestTelegramScript(s => s.TSUNAMI_FORECAST), [runTestTelegramScript])

  /**
   * 「津波注意報 → 津波予報（失効時刻つき）」テスト（DMDSS 版のみ。→ `TSUNAMI_EXPIRY`）。
   *
   * **等級の引き下げとして失効時刻が届く形を実機へ出せる入口はここだけ。** 1 通だけ流しても降格に
   * ならない —— 判定は前報の最上位等級との比較なので、注意報の報を先に通す。解除の報は流さない
   * （予報だけになった津波は失効時刻で消える）。
   */
  const simulateTsunamiExpiry = useCallback(() => runTestTelegramScript(s => s.TSUNAMI_EXPIRY), [runTestTelegramScript])

  /** 津波の誤報取消テスト（→ `TSUNAMI_RETRACTION`）。 */
  const simulateTsunamiRetraction = useCallback(() => runTestTelegramScript(s => s.TSUNAMI_RETRACTION), [runTestTelegramScript])

  /** 南海トラフ地震臨時情報のテスト（調査中・巨大地震注意は 2024-08-08 の実電文、巨大地震警戒はサンプル電文）。 */
  const simulateNankai = useCallback((kindName: '調査中' | '巨大地震注意' | '巨大地震警戒') =>
    runTestTelegramScript(s => (kindName === '調査中' ? s.NANKAI_CHECKING : kindName === '巨大地震注意' ? s.NANKAI_WATCH : s.NANKAI_WARNING)),
  [runTestTelegramScript])

  /**
   * 南海トラフ地震臨時情報の取消テスト（調査中 → `TSUNAMI_DISMISS_MS` 後に同じ `eventId` の取消。
   * → `NANKAI_RETRACTION`）。受信と同じ経路（イベントキュー）へ積むので、取消の照合（`eventId` の
   * 一致確認）を実運用と同じところで通る。
   */
  const simulateNankaiRetraction = useCallback(() => runTestTelegramScript(s => s.NANKAI_RETRACTION), [runTestTelegramScript])

  /** 南海トラフ地震関連解説情報のテスト（臨時解説は 2024-08-15 第７号、定例解説は 2026-09-07 第109回の実電文）。 */
  const simulateNankaiCommentary = useCallback((serialName: '臨時解説' | '定例解説') =>
    runTestTelegramScript(s => (serialName === '臨時解説' ? s.NANKAI_COMMENTARY_AD_HOC : s.NANKAI_COMMENTARY_ROUTINE)),
  [runTestTelegramScript])

  /** 関連解説情報の取消テスト（→ `NANKAI_COMMENTARY_RETRACTION`）。 */
  const simulateNankaiCommentaryRetraction = useCallback(() => runTestTelegramScript(s => s.NANKAI_COMMENTARY_RETRACTION), [runTestTelegramScript])

  /** 北海道・三陸沖後発地震注意情報のテスト（サンプル電文。→ `KOHATSU`）。 */
  const simulateKohatsu = useCallback(() => runTestTelegramScript(s => s.KOHATSU), [runTestTelegramScript])

  /** 後発地震注意情報の取消テスト（→ `KOHATSU_RETRACTION`）。 */
  const simulateKohatsuRetraction = useCallback(() => runTestTelegramScript(s => s.KOHATSU_RETRACTION), [runTestTelegramScript])

  /** 地震・津波に関するお知らせのテスト（サンプル電文。→ `QUAKE_NOTICE`）。 */
  const simulateQuakeNotice = useCallback(() => runTestTelegramScript(s => s.QUAKE_NOTICE), [runTestTelegramScript])

  /**
   * 地震回数に関する情報のテスト（→ `EARTHQUAKE_COUNT`）。音の無いお知らせと違い、こちらは通知音と
   * 読み上げを起こす（群発の総数は他のどの経路でも伝わらない）。
   */
  const simulateEarthquakeCount = useCallback(() => runTestTelegramScript(s => s.EARTHQUAKE_COUNT), [runTestTelegramScript])

  /**
   * 地震回数に関する情報の取消テスト（→ `EARTHQUAKE_COUNT_RETRACTION`）。**取消の理由が届く先は
   * 読み上げだけ** —— 帯ごと消えるのでカードに残せない。ボタンが無いと、その文が一度も声にならない。
   */
  const simulateEarthquakeCountRetraction = useCallback(() => runTestTelegramScript(s => s.EARTHQUAKE_COUNT_RETRACTION), [runTestTelegramScript])

  /**
   * 長周期地震動の取消テスト（→ `LPGM_RETRACTION`。DMDSS 版のみ）。**取消の理由が届く先は読み上げだけ**
   * —— 取消で長周期の一覧・バッジごと消える。読み上げへ渡すかの判定（`lpgmNotifiable`・`decideDispatch`）を
   * ライブと同じ形で通す。
   */
  const simulateLpgmRetraction = useCallback(() => runTestTelegramScript(s => s.LPGM_RETRACTION), [runTestTelegramScript])
  /** 階級 0 の長周期地震動テスト（→ `LPGM_CLASS_ZERO`。DMDSS 版のみ）。画面にだけ出て、音と読み上げは無い。 */
  const simulateLpgmClassZero = useCallback(() => runTestTelegramScript(s => s.LPGM_CLASS_ZERO), [runTestTelegramScript])
  /** 長周期地震動の観測情報の種類 1・3 のテスト（→ `LPGM_CATEGORIES`。DMDSS 版のみ）。 */
  const simulateLpgmCategories = useCallback(() => runTestTelegramScript(s => s.LPGM_CATEGORIES), [runTestTelegramScript])

  const resetState = useCallback(() => {
    // 台帳もここで空にする。掃除の `useEffect` に任せると、リセットから次のコミットまでの間に
    // 同じ eventId の報が届いたとき、消えたはずの報番号と比べて誤って捨てうる。
    eewAcceptanceRef.current.clear()
    eewLatestRef.current.clear()
    eewWatchReceiptsRef.current.clear()
    eewFirstIssueTimeRef.current.clear()
    eewExpiringRef.current.clear()
    // 終えた地震の記憶も前の時間軸のもの。残すと、新しい軸で同じ地震の報を取り直したときに戻さなくなる
    eewEndedRef.current.clear()
    // 取消の台帳も空にする。リプレイの開始・リセットで時間軸が変わるため、前の軸で見た取消の
    // 発表時刻と新しい軸の報を比べると、正常な報を取り下げ済みと誤判定する。
    quakeRetractionsRef.current = []
    lpgmRetractionsRef.current = []
    // 帯を消すので、表示中の識別情報の記憶も落とす（残すと、次に届いた取消の照合が
    // 消えた帯の識別情報と比べられる）。取消テストの待ちも落とす ―― リプレイへ切り替えた後で
    // テスト用の取消がキューへ紛れ込むのを防ぐ。
    shownNankaiEventIdRef.current = null
    shownKohatsuEventIdRef.current = null
    shownCommentaryIdRef.current = null
    shownQuakeNoticeRef.current = null
    shownEarthquakeCountEventIdRef.current = null
    // 伝えた取消の記憶も前の時間軸のもの（→ `conveyedCancelsRef`）
    conveyedCancelsRef.current.clear()
    estimatedIntensitiesRef.current = []
    // 分布を伝えた地震の台帳も空にする。リプレイの開始・リセットで時間軸が変わるため、前の軸で
    // 伝えた分布を「もう伝えた」と数えると、新しい軸の初報が「更新されました」と読まれる。
    shownEstimatedIntensityArrivalsRef.current = []
    // ライブで当てた津波の報の鍵も落とす。前の時間軸の報より古い履歴が、新しい軸で当たらなくなる。
    liveTsunamiSeenKeyRef.current = Number.NEGATIVE_INFINITY
    // 再生中の「もっと見る」の続きの口も前の時間軸のもの。進行中の取得は打ち切り、届いても世代で捨てる
    replayHistoryGenerationRef.current++
    replayLoadMoreAbortRef.current?.abort()
    replayLoadMoreAbortRef.current = null
    replayLoadMoreRef.current = null
    clearTestSimulationTimers()
    setState(prev => ({
      ...prev,
      earthquakes: [],
      tsunamis: [],
      activeEEWs: new Map(),
      lpgmByEventId: new Map(),
      nankai: null,
      nankaiCommentary: null,
      kohatsu: null,
      quakeNotice: null,
      earthquakeCount: null,
      estimatedIntensities: [],
      // 時間軸が変わるので、印とその記憶も落とす（残すと再生開始直後の報が
      // 旧い軸のカードとの差分で光る）。
      quakeUpdateMarks: new Map(),
      quakeMarkMemory: new Map(),
      // 「最終更新」も落とす。残すと、リプレイ開始直後（まだ 1 件も処理していない間）に
      // 地図の更新時刻へ**リプレイ前のライブ受信時刻**が出たままになる。
      lastUpdate: null,
      // 「もっと見る」を畳む。カードを空にしても hasMore を残すと、前の時間軸の続きを読むボタンが
      // 残る。立て直すのは、再生中は `restoreQuakeHistory`（続きの口の有無）、ライブへ戻る側は
      // 履歴の取得完了時。
      hasMore: false,
      // 履歴の損失も落とす。前の時間軸で欠けた分を残すと、新しい時間軸の話と混ざって読めない。
      // 再生を始めたときの履歴の取りこぼしはリプレイ側（設定の窓のリプレイの欄）が出し、ここへは
      // 再生中の「もっと見る」の取りこぼしだけが積まれる（2026-10-25 ユーザー選択「地震タブの帯のまま
      // (Recommended)」）。ライブへ戻る側は履歴の取得完了時に立て直すので落としてよい（`hasMore` と同じ理由）。
      historyLoss: createEmptyTelegramLoss(),
      loadMoreFailed: false,
      reconnectGapLoss: false,
      // **電文ログは、テストと再生の行だけ空にする。** 再生は「その窓を見る」ための機能なので
      // 始めた時点で窓に合わせるが、**ライブで受けた記録は残す** —— あれは後から「本物がいつ
      // 何を受け取ったか」を調べる唯一の記録で、作り直せない
      // （2026-10-23 ユーザー選択「守る（推奨）」）。
      telegramLog: dropTelegramLogOrigins(prev.telegramLog, ['test', 'replay']),
    }))
    eventQueueRef.current.clear()
    quakeIntensityCacheRef.current.clear()
    // 後発地震注意情報の7日タイマーもリセット対象。resetState 後に古いタイマーが残ると、
    // リプレイモード切替→ライブ復帰後に発火して新しく設定された kohatsu を null に上書きしうる。
    if (kohatsuExpireTimerRef.current !== undefined) {
      window.clearTimeout(kohatsuExpireTimerRef.current)
      kohatsuExpireTimerRef.current = undefined
    }
    // 解説情報の7日タイマーも同じ理由でリセットする
    if (nankaiCommentaryExpireTimerRef.current !== undefined) {
      window.clearTimeout(nankaiCommentaryExpireTimerRef.current)
      nankaiCommentaryExpireTimerRef.current = undefined
    }
    // 地震・津波に関するお知らせ（VZSE40）・地震回数（VXSE60）の7日タイマーも同じ
    if (quakeNoticeExpireTimerRef.current !== undefined) {
      window.clearTimeout(quakeNoticeExpireTimerRef.current)
      quakeNoticeExpireTimerRef.current = undefined
    }
    if (earthquakeCountExpireTimerRef.current !== undefined) {
      window.clearTimeout(earthquakeCountExpireTimerRef.current)
      earthquakeCountExpireTimerRef.current = undefined
    }
  }, [clearTestSimulationTimers])

  /**
   * リプレイ開始時に、指定時刻より前の地震カードを一覧へ流し込む（音・読み上げは経由しない）。
   *
   * 統合を `mergeQuakeHistory` に任せるのはライブの履歴取得・「もっと見る」と同じ理由で、
   * 経路ごとに畳み込み方が分かれると同じ電文から違うカードができる。既存のカードを base に
   * 置くのは、この復元が pre-window の注入や本編の再生より後に完了しうるため
   *（先に出来ていたカードを消さず、同じイベントなら統合する）。
   *
   * **続きを読む口（`loadMore`）も覚え、再生中の「もっと見る」をその有無で出す**（→ `loadMoreReplayHistory`）。
   * 地震が 0 件でも口は覚える —— 静かな期間から始めた再生でも、その手前へ遡れる。帯・長周期などの
   * `extras` はここでは当てない（初期状態の材料へ回る。→ `useReplayController` の `assemblePreWindowMaterial`）。
   */
  const restoreQuakeHistory = useCallback((history: ReplayQuakeHistoryResult) => {
    // 前に覚えた口の取得が進んでいれば打ち切る（同じ再生の中で履歴が差し替わった場合）
    replayHistoryGenerationRef.current++
    replayLoadMoreAbortRef.current?.abort()
    replayLoadMoreAbortRef.current = history.loadMore === null ? null : new AbortController()
    replayLoadMoreRef.current = history.loadMore
    const hasMore = history.loadMore !== null
    setState(prev => (prev.hasMore === hasMore ? prev : { ...prev, hasMore }))
    const quakes = history.quakes
    if (quakes.length === 0) return
    rememberQuakeRetractionsFromBatch(quakes)
    // **ここで作った記憶が、再生が始まってから届く報の「比べる相手」になる。**
    // 畳み込みは 1 通ずつ当てるので、各段階がその報の時点でカードが見せていた姿になる
    // （→ `marksFromHistory`・`utils/quakeUpdateMark.ts` の `rememberQuakeCard`）。
    setState(prev => {
      const { cards, markMemory } = mergeQuakeHistory(
        quakes, prev.earthquakes, quakeRetractionsRef.current, getAreaPrefIndexCache(), prev.quakeMarkMemory,
      )
      return {
        ...prev,
        ...marksFromHistory(markMemory, cards, prev.lpgmByEventId, prev.quakeUpdateMarks),
        earthquakes: borrowFromTsunamiIntoCards(cards, prev.tsunamis),
      }
    })
  }, [])

  const loadReplayEvents = useCallback((entries: import('../types/replay').ReplayEntry[]) => {
    for (const { payload, replayTime, silent, logEntry } of entries) {
      // 電文ログの行はキューへ預け、発火のときに積む（理由は `QueueEntry.logEntry`）
      eventQueueRef.current.push({ eventTime: replayTime, payload, silent, logEntry })
    }
  }, [])

  // 印の寿命の掃除。**次の報が来ればそちらで置き換わる**ので、ここが受け持つのは
  // 「次が来ないまま置かれた印」だけ。いちばん古い印が寿命を迎える時刻に 1 度起こし、
  // 印ごとにタイマーを張らない（群発では 1 分のあいだに何枚ものカードが印を持つ）。
  const { quakeUpdateMarks } = state
  useEffect(() => {
    if (quakeUpdateMarks.size === 0) return
    let oldest = Infinity
    for (const m of quakeUpdateMarks.values()) oldest = Math.min(oldest, m.markedAt)
    const timer = window.setTimeout(() => {
      setState(prev => {
        const kept = pruneQuakeMarks(prev.quakeUpdateMarks, Date.now())
        // 落とすものが無ければ同じ参照を返す（「変化なし＝同一参照」の約束を保つ）。
        return kept === prev.quakeUpdateMarks ? prev : { ...prev, quakeUpdateMarks: kept }
      })
    }, Math.max(0, UPDATE_MARK_TTL_MS - (Date.now() - oldest)))
    return () => window.clearTimeout(timer)
  }, [quakeUpdateMarks])

  /**
   * 近く発火する電文を覗く（読み上げの投機的先行合成が使う。→ `utils/speechPrefetch.ts`）。
   *
   * **返すのは payload だけ。** キューの内部型（`QueuePayload`）には表示を片付けるための
   * 予約（`purge-*`）が混ざっていて、電文ではないので投機の対象にならない。ここで
   * `ReplayPayload` へ絞っておけば、受け取る側が電文だけを見ればよくなる。
   *
   * **`silent` のエントリは外す。** 初期状態の復元（窓の手前 24 時間ぶん）は音も読み上げも
   * 鳴らさずに状態だけ入れるもので、焼いても一度も使われない。発火時刻が過去なので
   * `peekUpcoming` の時点でも落ちるが、**その理由に頼らない** —— サイレント注入の時刻の
   * 決め方が変われば、大量の無駄な合成が静かに始まる。
   */
  const peekUpcomingPayloads = useCallback((horizonMs: number): import('../types/replay').ReplayPayload[] => {
    const upcoming = eventQueueRef.current.peekUpcoming(getTimeRef.current(), horizonMs)
    const out: import('../types/replay').ReplayPayload[] = []
    for (const entry of upcoming) {
      if (entry.silent) continue
      const payload = entry.payload
      if (payload.kind === 'purge-cancelled-quake') continue
      if (payload.kind === 'purge-cancelled-eew') continue
      if (payload.kind === 'purge-cancelled-tsunami') continue
      // 見張りの解除は電文ではなく、発火しても読み上げるものが無い（失効は黙って消える）。
      if (payload.kind === 'eew-watch-expiry') continue
      out.push(payload)
    }
    return out
  }, [])

  return {
    ...state,
    injectEvent: handleEvent,
    loadMoreEarthquakes,
    clearTelegramLog,
    simulateEarthquake,
    simulateForeignQuake,
    simulateForeignQuakeHuge,
    simulateEEW, simulateEEWWarning, simulateEEWForecast, simulateEEWAssumed, simulateEEWStrongShaking, simulateEEWDeep, simulateEEWNoForecast, simulateEEWForecastZero, simulateEEWRetraction, simulateEEWLateRetraction,
    simulateTsunami, simulateTsunamiWarning, simulateTsunamiWatch, simulateTsunamiForecast, simulateTsunamiRetraction,
    simulateNankai, simulateNankaiRetraction, simulateNankaiCommentary, simulateNankaiCommentaryRetraction, simulateKohatsu, simulateKohatsuRetraction,
    simulateQuakeNotice, simulateEarthquakeCount, simulateEarthquakeCountRetraction, simulateLpgmRetraction, simulateLpgmClassZero, simulateLpgmCategories, simulateEstimatedIntensity,
    simulateTrainingQuake, simulateUnreceivedQuake, simulateMaxScaleOrAboveQuake, simulateAreaUnreceivedQuake, simulateTsunamiGradeChange, simulateTsunamiQuietReports, simulateTsunamiExpiry, simulateQuakeAmendment,
    simulateQuakeReportSequence,
    simulateQuakeCancel,
    simulateQuakePartialCancel,
    simulateHypocenterFromTsunami,
    simulateTsunamiSourceAdded,
    simulateTsunamiInfoRetraction,
    resetState,
    loadReplayEvents,
    peekUpcomingPayloads,
    restoreQuakeHistory,
  }
}
