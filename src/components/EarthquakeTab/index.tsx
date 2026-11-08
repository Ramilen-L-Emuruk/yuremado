import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { JMAQuake, JMALpgm, JMAEstimatedIntensity, JMAInternationalTsunami } from '../../types/earthquake'
import { EarthquakeCard } from './EarthquakeCard'
import { LoadMoreButton } from './LoadMoreButton'
import { QuakeListHeader, QuakeListDayLabel } from './QuakeListRow'
import { QuakeListFilterButton, QuakeListFilterDialog } from './QuakeListFilterBar'
import {
  clearQuakeListFilter, isQuakeListFiltered, nextQuakeListSort, quakeListAutoLoadAllowed, quakeListPeriodStartLabel, quakeListSection, quakeListUnloadedBefore, sortQuakeList,
  type QuakeListFilter, type QuakeListSort, type QuakeSortKey,
} from '../../utils/quakeListView'
import { serverNow } from '../../utils/clock'
import { log } from '../../utils/logger'
import { extractQuakeEventId, quakeEventKey } from '../../utils/quakeMerge'
import type { SeismoQuakeWave } from '../../hooks/useSeismoQuakeWaves'
import type { SeismoWaveCollapsedView } from '../../hooks/useSettings'
import { lpgmMarkKey, type QuakeCardMarks } from '../../utils/quakeUpdateMark'
import { estimatedIntensityFor } from '../../utils/estimatedIntensity'
import { NO_INTERNATIONAL_TSUNAMIS } from '../../utils/internationalTsunami'
import type { LatLng } from '../../utils/stationCoords'
import type { QuakeHistoryInputs, QuakeHistoryView } from '../../utils/quakeReportHistory'
import { quakeCardScrollTarget, type LpgmSectionFocus, QUAKE_CARD_KEY_ATTR } from '../../utils/quakeCardScroll'
import { useFollowScroll } from '../../hooks/useFollowScroll'
import { growFrom, ROW_INSERT_MS, CARD_RESIZE_ANIMATION_ID } from './quakeMotion'
import {
  type TelegramLoss, formatHistoryLossNotice, HISTORY_LOAD_MORE_FAILED_NOTICE, RECONNECT_GAP_LOSS_NOTICE,
  formatRateLimitedNotice, FETCH_THROTTLED_NOTICE, KEY_REENTRY_NOTICE,
} from '../../utils/telegramLoss'

interface Props {
  /**
   * 地震タブが表に出ているか。**離れたら絞り込みの窓を閉じる**（タブは常時マウントで、窓は body の最前面に描く。
   * 緊急地震速報などで自動で移ったとき、警報の上に窓と幕が残らないように。2026-11-07 選択「地震タブを離れたら閉じる (Recommended)」）。
   */
  shown: boolean
  /** 絞り込みを通した一覧（時刻の新しい順。並べ替えはここで行う）。 */
  earthquakes: JMAQuake[]
  /** 条件に合う地震の数（窓の「◯件中 ◯件」の後ろ。条件に合わないまま出す最新の 1 枚・飛んで開いた 1 件は数えない。2026-11-08 選択「条件に合う数だけ」） */
  matchedCount: number
  /** 絞り込みの条件（→ `utils/quakeListView.ts`）。 */
  filter: QuakeListFilter
  onFilterChange: (next: QuakeListFilter) => void
  /** 並べ替え。見出しを押すと変わる。 */
  sort: QuakeListSort
  onSortChange: (next: QuakeListSort) => void
  /** 地域の窓の一覧と件数を作る元（絞る前の、読み込んだ地震すべて）。 */
  filterSourceQuakes: readonly JMAQuake[]
  /** 読み込んだ一番古い日（日本時間の `YYYY-MM-DD`）。期間の絞りの「〇〇以前は未読込みです。」に使う。 */
  historyOldestDay: string | null
  selectedId: string | null
  /**
   * 選択が呼ばれるたびに進む番号（→ App の `quakeSelectSeq`）。選ばれたカードにだけ渡す
   * （他のカードへ渡すと、選ぶたびに全カードの memo が素通りする）。
   */
  selectSeq: number
  /**
   * いま読み上げが語っている地震の鍵（`quakeEventKey`。語っていなければ null）。
   * 読み上げが有効なあいだ、一覧はこのカードへ寄せる（→ `utils/quakeCardScroll.ts`）。
   */
  speakingKey: string | null
  /** 読み上げが有効か。無効なら、受信した時点で寄せる（→ `utils/quakeCardScroll.ts`）。 */
  followSpeech: boolean
  onSelect: (id: string) => void
  isLoading: boolean
  isLoadingMore: boolean
  hasMore: boolean
  /**
   * 「もっと見る」の取得。返る promise は取得が終わったら、**読んだ結果を一覧へ反映したか**で解決する（期間に合わせた
   * 自動の読み足しが、終わったことと「読んだのに一番古い日が動かなかった」ことをこれで見る）
   */
  onLoadMore: () => Promise<boolean>
  /**
   * 「もっと見る」が取得制限で待たされている間、ボタンに残り時間を出すか（→ `LoadMoreButton`）。
   */
  watchLoadMoreThrottle: boolean
  error: string | null
  /**
   * 履歴取得で確定した損失。**カードが 1 件も無いときも出す** —— 出さないと
   * 「7 日のうち 6 日が落ちて 0 件」が「まったく静かな期間だった」と同じ画になる。
   */
  historyLoss: TelegramLoss
  /** 直近の「もっと見る」がまるごと失敗したか（押し直せば回復しうる側）。 */
  loadMoreFailed: boolean
  /** 接続が切れていた間の電文を取り戻せていないか（→ `hooks/useEarthquakes.ts` の `reconnectGapLoss`）。 */
  reconnectGapLoss: boolean
  /**
   * いま配信元の上限に達していて、取得が待たされているか（→ `hooks/useFetchThrottled.ts`）。
   *
   * **損失ではない。** 枠が空けばそのまま取りに行くので、欠けは出ない。
   */
  fetchThrottled: boolean
  /**
   * 鍵の入れ直しの案内を閉じる。案内を出さないときは null（→ `utils/telegramLoss.ts` の `KEY_REENTRY_NOTICE`）
   */
  onDismissKeyReentry: (() => void) | null
  lpgmByEventId: ReadonlyMap<string, JMALpgm>
  /**
   * カードの更新の印。鍵は地震が `quakeEventKey`、長周期が {@link lpgmMarkKey}。
   * **同じ入れ物に入っているので、引くときは鍵の作り方を間違えないこと。**
   */
  updateMarks: ReadonlyMap<string, QuakeCardMarks>
  activeLpgmEventId: string | null
  onToggleLpgm: (eventId: string) => void
  /**
   * 長周期地震動の節を見せる求め（長周期地震動観測情報の受信・長周期の通知を押したとき。→ `App.tsx` の
   * `focusLpgmSection`）。どのカードのどこを見せるかは `quakeCardScrollTarget` が決める。
   */
  lpgmFocus: LpgmSectionFocus | null
  /**
   * アプリが持っている推計震度分布図（IXAC41・地震ごとに 1 通）。どのカードのものかは
   * ここで引き当て、カードへはその地震の 1 通だけを渡す（→ `EarthquakeCard` の同名の props）。
   */
  estimatedIntensities: readonly JMAEstimatedIntensity[]
  /** 国際津波関連情報（WEPA60）をカードの鍵ごとに結んだもの（→ `internationalTsunamiIndex` の `byQuakeKey`） */
  internationalTsunamisByQuake: ReadonlyMap<string, readonly JMAInternationalTsunami[]>
  /**
   * 選択中のカードの報の一覧を組む材料（→ `utils/quakeReportHistory.ts`）。選択中のカードが無ければ null。
   * 開いたカードはこれで「更新 ▾」の一覧を組む。
   */
  historyInputs: QuakeHistoryInputs | null
  /** 報の一覧で押している行（無ければ null）。 */
  historyPickedId: string | null
  /** 押している行の時点の姿。開いたカードの中身をこれへ差し替える（無ければ最新のまま）。 */
  historyView: QuakeHistoryView | null
  /** 報の一覧の行を押した（同じ行をもう一度押すと最新へ戻す）。`count` はカードが組んだ一覧の行数。 */
  onPickHistory: (entryId: string, count: number) => void
  /** カードの「▶ 再生」を押した（その地震からリプレイを始める。→ `EarthquakeCard` の `onReplay`）。 */
  onReplayQuake: (eventKey: string, firstReportMs: number | null) => void
  /**
   * 再生を始められなかった・取りこぼした知らせ（設定の窓「テスト時刻設定」の赤字と同じ文。→ `useReplayController` の `error`）。無ければ null。
   * 地震カードの「▶ 再生」から始めた人は設定の窓を開いていないので、一覧の上にも同じ文を出す（2026-11-08 ユーザー選択「地震タブにも同じ赤字 (Recommended)」）
   */
  replayError: string | null
  /** 震度分布モードを開いている地震の `eventKey`。 */
  distributionQuakeKey: string | null
  onToggleDistribution: (eventKey: string) => void
  /** 未入電の一覧を開いている地震の `eventKey`。 */
  unreceivedQuakeKey: string | null
  onToggleUnreceived: (eventKey: string) => void
  /**
   * 一覧の行をクリックしたときに、その場所へ地図を寄せる（1 点でも範囲でも）。観測点の行は観測点名も渡す
   * （座標が同じ観測点の吹き出しを取り違えないため。範囲の行は `null`）。
   */
  onFocusMap: (positions: LatLng[], stationName: string | null) => void
  /**
   * いま気象庁が書いた文を読み上げている主題（読んでいなければ null）。
   * 長周期の補足を読み上げているあいだ、そのカードの補足を開く。
   *
   * **任意にしない。** 渡し忘れても画面が動かないだけで例外もログも出ないので、
   * 型検査で止める唯一の機会がここ（→ audio-tts-spec.md §6）。
   */
  speakingTelegramTextSubject: string | null
  /**
   * 地震の鍵ごとの、自作地震計から読み返した合成波形（→ `hooks/useSeismoQuakeWaves`）。
   *
   * **鍵は `quakeEventKey`。** 選択・印と同じものを使う ——別の鍵で持つと、
   * 同じ分に起きた別の地震で片方のカードへ他方の波形が出る。
   */
  seismoWaves: ReadonlyMap<string, readonly SeismoQuakeWave[]>
  /** ライブで自作地震計の波形を読み返せなかった地震の鍵（→ `useSeismoQuakeWavesWithStatus` の `failedEventKeys`）。 */
  seismoWaveFailedKeys: ReadonlySet<string>
  /** 波形を畳んでいるときに出すもの（設定「波形の表示」。地図の下端の波形と共有）。 */
  seismoWaveView: SeismoWaveCollapsedView
}

/**
 * 履歴について知らせる帯。
 *
 * **全画面のエラー表示（`error`）とは分ける。** あちらは 1 件も取れなかったときのもので、
 * こちらは取れた分のカードを覆ってはいけない。
 *
 * **色は 3 通り。**
 *
 * | `tone` | 意味 | 色 |
 * |---|---|---|
 * | `loss` | **何かが欠けている。** 生成データの取得失敗（`MapDataStatus`）と揃える | 琥珀 |
 * | `info` | **欠けていない。** いま待っているだけで、放っておけば取れる | 青 |
 * | `replay` | **リプレイの知らせ。** 設定の窓「テスト時刻設定」の赤字と同じ文を同じ赤で出す（2026-11-08 ユーザー選択「地震タブにも同じ赤字 (Recommended)」） | 赤 |
 *
 * **待ちを琥珀で出さないこと。** あれは損失の色で、並べると「取りこぼした」と読まれる。
 */
function HistoryNotice({ tone, children, onClose }: { tone: NoticeTone; children: React.ReactNode; onClose?: () => void }) {
  const color = tone === 'info'
    ? 'border-sky-500/40 bg-sky-500/10 text-sky-300'
    : tone === 'replay'
      ? 'border-red-500/40 bg-red-500/10 text-red-400'
      : 'border-amber-500/40 bg-amber-500/10 text-amber-300'
  return (
    <div className={`flex items-start gap-2 rounded-lg border px-2 py-1.5 text-xs roomy:text-sm roomy:px-3 roomy:py-2 ${color}`}>
      <div className="flex-1">{children}</div>
      {onClose && (
        <button type="button" onClick={onClose} aria-label="閉じる" className="shrink-0 leading-none opacity-70 hover:opacity-100">×</button>
      )}
    </div>
  )
}

type NoticeTone = 'loss' | 'info' | 'replay'
interface Notice { text: string; tone: NoticeTone; onClose?: () => void }

// 地震情報タブの右パネル。地震カードの一覧を表示し、クリックで地図表示対象を選択する。
// 地図そのものは App が常時表示する。
// React.memo 化の理由と props 参照安定性の要件は docs/spec/architecture-spec.md 参照。
export const EarthquakeTab = memo(function EarthquakeTab({ shown, earthquakes, matchedCount, filter, onFilterChange, sort, onSortChange, filterSourceQuakes, historyOldestDay, selectedId, selectSeq, speakingKey, followSpeech, onSelect, isLoading, isLoadingMore, hasMore, onLoadMore, watchLoadMoreThrottle, error, historyLoss, loadMoreFailed, reconnectGapLoss, fetchThrottled, onDismissKeyReentry, lpgmByEventId, updateMarks, activeLpgmEventId, onToggleLpgm, lpgmFocus, estimatedIntensities, internationalTsunamisByQuake, historyInputs, historyPickedId, historyView, onPickHistory, onReplayQuake, replayError, distributionQuakeKey, onToggleDistribution, unreceivedQuakeKey, onToggleUnreceived, onFocusMap, speakingTelegramTextSubject, seismoWaves, seismoWaveFailedKeys, seismoWaveView }: Props) {
  // **早期 return より前に置く**（フックの数を回ごとに変えないため）。一覧が無い回は寄せずに持ち越す。
  const listRef = useRef<HTMLDivElement>(null)
  // 並べ替え（見出しを押して選ぶ。→ `sortQuakeList`）
  const sorted = useMemo(() => sortQuakeList(earthquakes, sort), [earthquakes, sort])
  const onSort = (key: QuakeSortKey) => onSortChange(nextQuakeListSort(sort, key))
  const filtered = isQuakeListFiltered(filter)
  // 窓の開閉と窓そのものはここで持つ（ボタンを置く見出しの行は一覧が空の画面には無く、並んだ画面でも作り直されるので、
  // そちらに持つと 0 件との行き来で窓が作り直される）。窓はどの画面でも `withDialog` で先頭の同じ位置に描く
  const [openFilter, setOpenFilter] = useState(false)
  // 離れた描画で窓を出さず（open に false を渡す）、state は次の描画で掃除する
  useEffect(() => { if (!shown) setOpenFilter(false) }, [shown])
  const filterButton = <QuakeListFilterButton filter={filter} open={openFilter} onOpen={() => setOpenFilter(true)} />
  // **期間の始まりが読み込んだ範囲より前なら、届くまで読み足す**（2026-11-08 ユーザー発言「期間で取得してない日付を設定できるのは
  // おかしい」の後、選択「選んだら足りない日を読み込む (Recommended)」）。「もっと見る」と同じ口で 1 回 7 日ずつ進み、
  // 読み込んだ一番古い日が動くたびにもう一度見る。地震タブを見ている間だけ走る。
  // **止まる条件は 2 つ**: 読み込みに失敗した（`loadMoreFailed`）・読み込みが終わったのに一番古い日が動かなかった
  // （429 の足踏み・カーソルが進まない日。失敗として現れないので、見ないと間隔なしに呼び続ける）。押し直しは「もっと見る」、
  // 期間を選び直すか一番古い日が動けば自動に戻る
  // 自動で読み足すのは期間の始まりが今日から 90 日前より新しいときだけ（→ `QUAKE_LIST_AUTO_LOAD_DAYS`）
  const nowMs = serverNow()
  const unloadedBefore = quakeListUnloadedBefore(filter.period, historyOldestDay, nowMs)
  const periodNeedsMore = unloadedBefore !== null && quakeListAutoLoadAllowed(filter.period, nowMs)
  // 自動で呼んだときの一番古い日（呼んでいなければ undefined）。**終わりは呼んだ promise の解決で知る** —— 読み込み中の印
  // （isLoadingMore）の移り変わりで見ると、印を立てずに返る経路（再生で続きの口が無い等）で控えが外れず、自動が止まったまま
  // 「読み込んでいます…」を出し続ける。解決したら autoDoneSeq を進め、次の描画（取得で変わった一番古い日が載った後）で判定する
  const autoFromRef = useRef<string | null | undefined>(undefined)
  const [autoDoneSeq, setAutoDoneSeq] = useState(0)
  const seenDoneSeqRef = useRef(0)
  // 自動で呼んだ取得が、読んだ結果を一覧へ反映したか（読まずに返った・捨てた・失敗したなら false。進まなかったとは見なさない）
  const autoAppliedRef = useRef(false)
  const [autoStalled, setAutoStalled] = useState(false)
  useEffect(() => { setAutoStalled(false) }, [filter.period, historyOldestDay])
  useEffect(() => {
    if (autoDoneSeq !== seenDoneSeqRef.current) {
      seenDoneSeqRef.current = autoDoneSeq
      const from = autoFromRef.current
      const applied = autoAppliedRef.current
      autoFromRef.current = undefined
      autoAppliedRef.current = false
      // 止めるのは「まだ読む必要があり、失敗でもないのに一番古い日が動かなかった」ときだけ（失敗は loadMoreFailed が止める。
      // 期間を外した・90 日より古くした後に返ったなら止める理由が無い）
      if (applied && from !== undefined && from === historyOldestDay && periodNeedsMore && hasMore && !loadMoreFailed) {
        log.warn(`[地震タブ] 期間に合わせた読み足しで、読み込んだ一番古い日が ${historyOldestDay ?? '（なし）'} から動かなかったので止めた`)
        setAutoStalled(true)
        return
      }
    }
    // 呼んだ結果がまだ返っていない間は呼ばない（StrictMode の二度目の effect でも二重に呼ばない）
    if (autoFromRef.current !== undefined) return
    if (!shown || !periodNeedsMore || !hasMore || isLoadingMore || loadMoreFailed || autoStalled) return
    autoFromRef.current = historyOldestDay
    onLoadMore()
      .then(applied => { autoAppliedRef.current = applied }, () => { autoAppliedRef.current = false /* 失敗は onLoadMore が loadMoreFailed と記録に残す */ })
      .finally(() => setAutoDoneSeq(s => s + 1))
  }, [shown, periodNeedsMore, historyOldestDay, hasMore, isLoadingMore, loadMoreFailed, autoStalled, autoDoneSeq, onLoadMore])
  // 読み足しの様子（2026-11-08 選択「読み込み中と止まった後を分けて出す (Recommended)」）。読み込み中は期間の始まりまで読んでいる途中、
  // 止まった後（失敗・進まない・90 日より古い期間）は読めた範囲を添える。どちらでもなければ出さない。もう遡れない（hasMore が偽）なら注記も出さない
  const autoLoading = shown && periodNeedsMore && hasMore && !loadMoreFailed && !autoStalled
  const oldestLabel = historyOldestDay === null ? null : `${Number(historyOldestDay.slice(5, 7))}月${Number(historyOldestDay.slice(8, 10))}日`
  const loadNote = unloadedBefore === null || !hasMore || filter.period === null
    ? null
    : autoLoading
      ? { note: `${quakeListPeriodStartLabel(filter.period, nowMs)}まで読み込んでいます…`, countSuffix: '（読み込み中）', loading: true }
      : { note: `${unloadedBefore}以前は未読込みです。`, countSuffix: oldestLabel === null ? '' : `（${oldestLabel}以降を読込済み）`, loading: false }
  const filterDialog = <QuakeListFilterDialog filter={filter} onChange={onFilterChange} quakes={filterSourceQuakes} open={shown && openFilter} onClose={() => setOpenFilter(false)} shownCount={matchedCount} totalCount={filterSourceQuakes.length} loadNote={loadNote} />
  const withDialog = (screen: React.ReactNode) => <>{filterDialog}{screen}</>
  // 一覧が空・読み込み中・取得失敗の画面にも、一覧と同じ見出しの行（漏斗と並べ替えの欄）を上に置く。置かないと、絞りで空になったとき
  // 条件の一部を緩める口が無い（2026-11-08 選択「空でも見出しと漏斗を出す」）。幅で欄を切り替える作りは一覧と同じ枠（quake-list）に入れて揃える
  const emptyHeader = (
    <div className="quake-list shrink-0 overflow-visible">
      <div className="quake-list-scope"><QuakeListHeader sort={sort} onSort={onSort} filterButton={filterButton} /></div>
    </div>
  )
  // 寄せる相手と寄せ直す合図は `quakeCardScrollTarget`、寄せ方は共有のフック（→ docs/spec/quake-spec.md §8「一覧の寄せ方」）。
  const scrollTarget = quakeCardScrollTarget({ earthquakes, selectedKey: selectedId, speakingKey, followSpeech, lpgmFocus })
  // 長周期の節を見せる番なら、巻くのはそのカード（長周期の札と同じ巻き方。→ `EarthquakeCard` の `lpgmFocusSeq`）。
  // 一覧の寄せ（カードの頭へ）は止める —— 両方動くと、カードが節へ巻いた直後に一覧が頭へ引き戻す
  const lpgmFocusTarget = scrollTarget?.section === 'lpgm' && lpgmFocus ? { key: scrollTarget.key, seq: lpgmFocus.seq } : null
  // 新しい地震が一覧の先頭に届いたら、上から差し込む（2026-11-03 選択「新しい地震の差し込み」。説明「起動時に
  // 履歴をまとめて読むときと『もっと見る』では動かさない。続報で値が変わったときは今の更新の印のまま」）。
  // 見たことのある鍵を覚え、読み込みが落ち着いた後に**先頭へ**初めて現れた鍵だけを動かす（もっと見るは末尾に足される）
  const seenKeysRef = useRef<Set<string> | null>(null)
  useLayoutEffect(() => {
    if (earthquakes.length === 0) {
      seenKeysRef.current = null
      return
    }
    if (isLoading) return
    const keys = earthquakes.map(quakeEventKey)
    const seen = seenKeysRef.current
    seenKeysRef.current = new Set(keys)
    if (seen === null || isLoadingMore || seen.has(keys[0])) return
    // 先頭に 1 件だけ足された形（2 件目以降はすべて前に見た鍵）のときだけ。一覧が丸ごと差し替わった
    // （絞り込み・リプレイの開始と停止など）ときは、先頭が変わっても新着ではないので動かさない
    if (!keys.slice(1).every(k => seen.has(k))) return
    const el = listRef.current?.querySelector<HTMLElement>(`[${QUAKE_CARD_KEY_ATTR}="${CSS.escape(keys[0])}"]`)
    // 寄せ（useFollowScroll）は、この名前の動きが走っている間は待つ（伸びている途中の高さで寄せ方を決めない）
    if (el) growFrom(el, 0, ROW_INSERT_MS, CARD_RESIZE_ANIMATION_ID)
  }, [earthquakes, isLoading, isLoadingMore])
  useFollowScroll(listRef, scrollTarget?.section === 'card' ? scrollTarget.signature : null, () =>
    scrollTarget ? listRef.current?.querySelector<HTMLElement>(`[${QUAKE_CARD_KEY_ATTR}="${CSS.escape(scrollTarget.key)}"]`) ?? null : null)
  // 履歴について知らせる帯。**5 つを別に持つ**（確定した損失／429 で見送った分／押し直せば
  // 回復しうる失敗／接続が切れていた間の取りこぼし／いま待っているだけ）。混ぜると、戻せない損失と戻せるものが同じ重さに見える。
  //
  // **待っているだけの告知は最後・青で出す。** 上の 4 つは「何かが欠けた・失敗した」だが、
  // これは欠けていない（枠が空けばそのまま取りに行く）。
  const notices: Notice[] = [
    formatHistoryLossNotice(historyLoss),
    formatRateLimitedNotice(historyLoss),
    loadMoreFailed ? HISTORY_LOAD_MORE_FAILED_NOTICE : null,
    reconnectGapLoss ? RECONNECT_GAP_LOSS_NOTICE : null,
  ].filter((t): t is string => t !== null).map(text => ({ text, tone: 'loss' as const }))
  // **取得に失敗しても、カードがあれば一覧は残す**（2026-10-21 ユーザー承認「直す (Recommended)」。
  // カードがあれば一覧を残し、失敗は既存の帯で。文言は足さない）。起動時の履歴より先に、または失敗の後に
  // ライブで届いた地震は state にあるので、画面ごと差し替えると張り直すまでそれが見えない。
  // 文面は 1 件も無いときの全面表示と同じ語（2026-10-21 ユーザー選択「おすすめで」＝括弧に中身を添える形）。
  // 損失の帯の先頭に置く —— 履歴がまるごと取れていないので、日ごとの欠けより重い。
  // 中身が空の例外（`new Error('')`）でも失敗は失敗なので、`null` かどうかで見る。空なら括弧を付けない。
  const failed = error !== null
  if (failed && earthquakes.length > 0) {
    notices.unshift({ text: error.trim() === '' ? 'データの取得に失敗' : `データの取得に失敗（${error}）`, tone: 'loss' })
  }
  // 再生の知らせは先頭に置く（再生中は、ここに出る欠けが画面の中身そのものを左右する）
  if (replayError !== null) notices.unshift({ text: replayError, tone: 'replay' })
  if (fetchThrottled) notices.push({ text: FETCH_THROTTLED_NOTICE, tone: 'info' })
  // 鍵の入れ直しの案内は欠けではないので青。閉じられる（2026-10-31 ユーザー選択の説明「［×］で閉じる」）
  const keyReentryNotice: Notice | null = onDismissKeyReentry === null
    ? null
    : { text: KEY_REENTRY_NOTICE, tone: 'info', onClose: onDismissKeyReentry }
  if (keyReentryNotice !== null) notices.push(keyReentryNotice)
  // **1 件も無いときだけ読み込み中の画面にする。**
  // 履歴は日ごとにアーカイブを読むので、全件が揃うのは数秒後になる
  // （→ `docs/spec/data-sources-spec.md` §2「窓ごとの上限を守る」）。取得側は
  // 取れた分から順に流しているので、`isLoading` だけで覆うと**その間ずっとスピナーのままになり、
  // 逐次に出す仕組みが画面へ一度も現れない**。
  if (isLoading && earthquakes.length === 0) {
    return withDialog(
      <div className="flex flex-col h-full">
       {emptyHeader}
       <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-secondary text-sm">データを取得中…</p>
        </div>
       </div>
      </div>
    )
  }

  // 全画面の失敗表示には「欠けた」系の帯を重ねない（一部が欠けたのか、まるごと失敗したのか読めなくなる）。
  // **鍵の入れ直しの案内だけは出す** —— 取得の成否と別の話で、中継に繋がらない初回こそ要る
  if (failed && earthquakes.length === 0) {
    return withDialog(
      <div className="flex flex-col h-full">
        {emptyHeader}
        {keyReentryNotice !== null && (
          <div className="p-2 roomy:p-3">
            <HistoryNotice tone={keyReentryNotice.tone} onClose={keyReentryNotice.onClose}>{keyReentryNotice.text}</HistoryNotice>
          </div>
        )}
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="text-center">
            <p className="text-red-400 text-sm mb-2">データの取得に失敗</p>
            <p className="text-secondary text-xs">{error}</p>
          </div>
        </div>
      </div>
    )
  }

  // 期間の絞りが、まだ読み込んでいない日にかかるときの注記。読み込み中は「〇〇まで読み込んでいます…」、止まった後は
  // 「〇〇以前は未読込みです。」（文面はユーザー原文「〇〇以前は未読込みです。で」）。窓の期間の節にも同じ文を出す（→ `loadNote`）
  const unloadedNotice = loadNote !== null
    ? <p className="px-[var(--qk-pad)] pt-2 text-xs text-secondary roomy:text-sm">{loadNote.note}</p>
    : null

  if (earthquakes.length === 0) {
    return withDialog(
      <div className="flex flex-col h-full">
        {emptyHeader}
        {notices.length > 0 && (
          <div className="p-2 space-y-1.5 roomy:p-3 roomy:space-y-2">
            {notices.map(n => <HistoryNotice key={n.text} tone={n.tone} onClose={n.onClose}>{n.text}</HistoryNotice>)}
          </div>
        )}
        {/* 絞っていて空のときだけ文面を変える（2026-11-07 選択「絞っているときだけ変える (Recommended)」） */}
        <div className="flex-1 flex flex-col items-center justify-center gap-2">
          <p className="text-secondary text-sm">{filtered ? '条件に合う地震はありません' : '地震情報はありません'}</p>
          {filtered && (
            <button type="button" onClick={() => onFilterChange(clearQuakeListFilter(filter))} className="rounded-md border border-border bg-panel px-3 py-1.5 text-xs text-white hover:bg-white/10">
              すべて解除
            </button>
          )}
        </div>
        {unloadedNotice}
        {/* **空でも「もっと見る」を出す。** 絞りを掛けていて、読んだ範囲に条件に合う地震が無いと
            一覧は空になるが、遡れば出る地震はある。出さないと押す口が無くなる（2026-11-03 ユーザー選択
            「空でもボタンを出す (Recommended)」。1 回に読む日数も文面も一覧の末尾と同じ） */}
        {hasMore && (
          <div className="p-2 roomy:p-3">
            <LoadMoreButton onLoadMore={onLoadMore} isLoadingMore={isLoadingMore} watchThrottle={watchLoadMoreThrottle} />
          </div>
        )}
      </div>
    )
  }

  // 並べた欄の値が前の行と変わったところに区切りを置く。時刻の並びは日付（見本の「11月1日」。年は常に添える）、
  // 震度は階級・規模は整数・深さは幅（2026-11-07 選択「並べた欄の幅ごとに区切る (Recommended)」）、地域の並びは区切らない（→ `quakeListSection`）。
  // 比べる相手は直前に区切りを置いた値（読めない行を挟んでも同じ区切りを二度置かない）
  // **区切りから次の区切りの手前までを 1 つの束にする。** 区切りの行は束の中で一覧の見出しの行の下へ貼りつき、
  // 束の終わりで次の区切りの行に押し上げられる（2026-11-05 ユーザー発言「普通にヘッダ(震度 時刻 震央地名 規模 深さ)の下に
  // 張り付くイメージ」）。束の鍵は区切りの鍵（区切りより前の行だけの束は先頭の行の鍵）
  // 同じ区切りの束が離れて 2 つできたとき（並びから外れた行を挟んだとき）だけ、鍵に番号を添える
  const dayGroups: { key: string; label: string | null; quakes: JMAQuake[] }[] = []
  const dayKeyCount = new Map<string, number>()
  let lastDayKey: string | null = null
  for (const q of sorted) {
    const day = quakeListSection(q, sort.key)
    if (day && day.key !== lastDayKey) {
      lastDayKey = day.key
      const n = dayKeyCount.get(day.key) ?? 0
      dayKeyCount.set(day.key, n + 1)
      dayGroups.push({ key: n === 0 ? day.key : `${day.key}:${n}`, label: day.label, quakes: [q] })
    } else if (dayGroups.length === 0) {
      dayGroups.push({ key: `lead:${quakeEventKey(q)}`, label: null, quakes: [q] })
    } else {
      dayGroups[dayGroups.length - 1].quakes.push(q)
    }
  }

  return withDialog(
    // 大きさは一覧自身の幅で切り替える（2026-11-02 選択「パネル自身の幅 (Recommended)」。値は src/index.css の quake-list）
    <div ref={listRef} className="quake-list">
     {/* 区切りを出さない並び（震央地名）では区切りの高さを 0 にする。開いたカードの帯は区切りの下に貼りつくので、
         高さを残すと見出しとの間に隙間ができ、巻いた中身が透ける */}
     <div className="quake-list-scope" style={sort.key === 'region' ? ({ '--qk-day-h': '0px' } as React.CSSProperties) : undefined}>
      {notices.length > 0 && (
        <div className="space-y-1.5 p-2 roomy:p-3">
          {notices.map(n => <HistoryNotice key={n.text} tone={n.tone} onClose={n.onClose}>{n.text}</HistoryNotice>)}
        </div>
      )}
      <QuakeListHeader sort={sort} onSort={onSort} filterButton={filterButton} />
      {dayGroups.map(group => (
       <section key={group.key}>
        {group.label && <QuakeListDayLabel label={group.label} />}
        {group.quakes.map(quake => {
        const key = quakeEventKey(quake)
        const selected = key === selectedId
        // 報の一覧で前の報を押している間は、そのカードの中身だけをその報の時点へ差し替える（→ `historyView`）。
        // ほかのカードには何も渡さない（memo が効く）
        const view = selected && historyView ? historyView : null
        return (
        // QUAKE-4: 続報で id 末尾の serial が変わるたびに EarthquakeCard がリマウントされ、
        // isSelected の副作用（強制スクロール）が発火してユーザー操作を妨害する。
        // eventKey は続報でも変わらないため、React の key・選択判定の両方をこれで安定させる
        // （どちらも quakeEventKey に統一。earthquake.time は同じ分に起きた別の地震と衝突する）。
        <EarthquakeCard
          key={quakeEventKey(quake)}
          quake={quake}
          isSelected={quakeEventKey(quake) === selectedId}
          reopenSignal={quakeEventKey(quake) === selectedId ? selectSeq : 0}
          // **包まずにそのまま渡す。** ここで包むと毎レンダー新しい関数になり、
          // `EarthquakeCard` の memo が素通りする（地震の鍵はカード側で作る）。
          onSelect={onSelect}
          lpgm={view ? view.lpgm : lpgmByEventId.get(extractQuakeEventId(quake) ?? '')}
          marks={view ? view.marks : updateMarks.get(quakeEventKey(quake))}
          historyQuake={view?.quake ?? null}
          historyInputs={selected ? historyInputs : null}
          historyPickedId={selected ? historyPickedId : null}
          onPickHistory={onPickHistory}
          onReplay={onReplayQuake}
          // 前の報を見ている間は長周期の印を出さない（その報の時点の長周期の印は組んでいない。最新の印が混ざると時点の画面にならない）
          lpgmMarks={view ? undefined : updateMarks.get(lpgmMarkKey(extractQuakeEventId(quake) ?? ''))}
          activeLpgmEventId={activeLpgmEventId}
          onToggleLpgm={onToggleLpgm}
          // 求めの番号は、見せる番のカードにだけ渡す（ほかのカードは 0 のままなので memo が効く）
          lpgmFocusSeq={lpgmFocusTarget?.key === quakeEventKey(quake) ? lpgmFocusTarget.seq : 0}
          estimatedIntensity={view ? view.estimatedIntensity : estimatedIntensityFor(quake, estimatedIntensities)}
          internationalTsunamis={view ? view.internationalTsunamis : internationalTsunamisByQuake.get(quakeEventKey(quake)) ?? NO_INTERNATIONAL_TSUNAMIS}
          distributionActive={quakeEventKey(quake) === distributionQuakeKey}
          onToggleDistribution={onToggleDistribution}
          unreceivedActive={quakeEventKey(quake) === unreceivedQuakeKey}
          onToggleUnreceived={onToggleUnreceived}
          onFocusMap={onFocusMap}
          speakingTelegramTextSubject={speakingTelegramTextSubject}
          seismoWaves={seismoWaves.get(quakeEventKey(quake))}
          seismoWaveFailed={seismoWaveFailedKeys.has(quakeEventKey(quake))}
          seismoWaveView={seismoWaveView}
          showListDate={sort.key !== 'time'}
        />
        )
        })}
       </section>
      ))}
      {unloadedNotice}
      {hasMore && (
        <LoadMoreButton onLoadMore={onLoadMore} isLoadingMore={isLoadingMore} watchThrottle={watchLoadMoreThrottle} />
      )}
      {!hasMore && earthquakes.length > 0 && (
        // 「すべての履歴」とは書かない。**止まる理由は経路で違う**（`useEarthquakes` の `hasMore`）。
        // ライブはアーカイブの目録が空になったとき（在庫の端。地震津波関連は 2020-11-18 から）。
        // 再生中は続きを読む口が
        // 無いとき（ローカル履歴アーカイブは収録範囲の外を持たない・在庫の端・開始時の履歴の取得に失敗した）。
        // どれも「これ以上は遡れない」ことは共通なので、文言は 1 つで足りる。
        <p className="text-center text-xs text-secondary py-2">これ以上は遡れません</p>
      )}
     </div>
    </div>
  )
})
