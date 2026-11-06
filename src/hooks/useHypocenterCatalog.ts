import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  loadHypocenterIndex,
  loadHypocenterYear,
  type HypocenterIndex,
  type HypocenterYear,
} from '../utils/hypocenterCatalog'
import { jstYearOf, yearsInRange } from '../utils/hypocenterCatalogView'
import { tailYearFromQuakes } from '../utils/hypocenterTail'
import { fetchListedHypocenters } from '../services/dmdataReplayLive'
import { relayRestEndpoint } from '../services/relayEndpoint'
import { liveServerNow } from '../utils/clock'
import { log } from '../utils/logger'

// 長期震源カタログを、選んだ年の範囲ぶんだけ読む。
//
// **タブを開くまで何も取りに行かない。** 全期間で 108 ファイル・gzip 12.6MB あり、起動のたびに
// 取ると地震情報の表示までが遅くなる。読み込み自体は utils/hypocenterCatalog.ts が年ごとに
// キャッシュするので、一度見た年を選び直しても通信は起きない。

export interface HypocenterCatalogState {
  /** 索引。**年ファイルより先に必要**（どの年が存在するか・完全性の下限を持つ）。 */
  index: HypocenterIndex | null
  /**
   * 読めた年（昇順）。
   *
   * **必ず「いま選んでいる期間の一部」になる。** 取得に失敗しても前の期間のものを残さない。
   * 残すと、期間の表示・完全性の注意書きと地図の中身が食い違ったまま固定され、しかも
   * 読み込みが終わったように見えるため気づけない。
   */
  years: HypocenterYear[]
  /**
   * 読めた終端の年の年ファイルの終端（排他）。期間の端はこれで止める —— 年ファイル（控え 1 時間）は目次（10 分）より
   * 古いことがあり、目次の終端で止めると年ファイルに無い日を選べてしまう。終端の年を読めていない間は null
   */
  catalogEndMs: number | null
  /** 索引または年ファイルを取得中か。 */
  loading: boolean
  /** 索引を取得できなかった理由（利用者に見せる文言）。年ファイルの欠けは `missingYears`。 */
  error: string | null
  /** 取得できなかった年（昇順）。空なら欠けなし。**件数はこのぶん少なく出る。** */
  missingYears: number[]
  /**
   * 取りに行った年の数（索引に無い年は含まない）。
   *
   * **`missingYears` と突き合わせて「一部が欠けた」と「まるごと取れなかった」を言い分けるために要る。**
   * 件数が 0 のとき、絞り込みの結果なのか取得の失敗なのかは利用者から区別できない。
   */
  requestedYears: number
  /** もう一度取りに行く。期間を変えずに失敗から復帰する手段。 */
  retry: () => void
  /**
   * カタログの終端より後を、中継の地震情報の電文から足した範囲（`years` の最後の 1 つがその年）。取れていない・
   * 期間が掛からないなら null。**取りきれなかったときも null** —— 欠けたまま足すと、取れなかった地震が
   * 「起きなかった」に見える（期間の端もカタログの終端で止める。`catalogPeriodBounds`）。
   */
  tail: { fromMs: number; untilMs: number } | null
  /**
   * `years` から末尾を除いた並び（参照は年を読み直すまで変わらない）。期間が末尾に掛からない間は点群をこちらで組めば、
   * 末尾が届いても組み直さずに済む（届いた直後は期間の終わりがまだ前の端にあり、末尾の点は 1 つも入らない）
   */
  catalogYears: HypocenterYear[]
}

/** 末尾を取り直す間隔。タブを開き直すたびに電文一覧を引かないため（本文は端末の控えが効く） */
const TAIL_REFRESH_MS = 10 * 60_000
/**
 * 末尾として取る長さの上限（ヒートマップの末尾と同じ 30 日）。カタログの書き足しが止まって終端が古くなっても、
 * 電文一覧を際限なく引かない。**超えたら末尾を足さない** —— 一部だけ足すと、終端と末尾の間が「地震が無かった」に見える
 */
const TAIL_MAX_MS = 30 * 24 * 3600_000
/** 末尾を取れなかった後、取り直すまでの間 */
const TAIL_RETRY_AFTER_FAILURE_MS = 60_000

const EMPTY_YEARS: HypocenterYear[] = []
const EMPTY_MISSING: number[] = []

/**
 * 同じ年の並びか。**中身の比較ではなく参照の比較で足りる**——`loadHypocenterYear` は年ごとに
 * 同じオブジェクトを返すため、同じ年を読めば同じ参照になる。
 */
function sameYears(a: readonly HypocenterYear[], b: readonly HypocenterYear[]): boolean {
  return a.length === b.length && a.every((y, i) => y === b[i])
}

/** 末尾の年が同じ地震を同じ値で持つか（取り直した結果が前と同じかを見る。件数は高々数百） */
function sameTailYear(a: HypocenterYear, b: HypocenterYear): boolean {
  if (a.count !== b.count) return false
  for (let i = 0; i < a.count; i++) {
    if (a.timeMs[i] !== b.timeMs[i] || a.lat[i] !== b.lat[i] || a.lng[i] !== b.lng[i] || a.external[i] !== b.external[i]) return false
    if (!Object.is(a.depth[i], b.depth[i]) || !Object.is(a.magnitude[i], b.magnitude[i])) return false
  }
  return JSON.stringify(a.telegramLabels) === JSON.stringify(b.telegramLabels) && JSON.stringify(a.names) === JSON.stringify(b.names)
    && a.nameIdx.every((n, i) => n === b.nameIdx[i])
}

function sameNumbers(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((n, i) => n === b[i])
}

/**
 * @param fromYear 表示する期間の始まり（両端を含む）
 * @param toYear 表示する期間の終わり（両端を含む）
 * @param enabled 取りに行ってよいか。false の間は何もせず、前回の内容を保つ
 */
export function useHypocenterCatalog(
  fromYear: number,
  toYear: number,
  enabled: boolean,
): HypocenterCatalogState {
  const [index, setIndex] = useState<HypocenterIndex | null>(null)
  const [years, setYears] = useState<HypocenterYear[]>(EMPTY_YEARS)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [missingYears, setMissingYears] = useState<number[]>(EMPTY_MISSING)
  const [requestedYears, setRequestedYears] = useState(0)
  // 取り直しの合図。期間が変わらなくても効果を回し直すために連番で持つ。
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt((n) => n + 1), [])

  // 索引は 1 度だけ。年ファイルの取得はこれが揃ってからでないと、存在しない年を叩く。
  useEffect(() => {
    if (!enabled || index) return
    let cancelled = false
    setLoading(true)
    // **始める前に前回の失敗を消す。** 残すと、新しい取得の最中に古いエラーと
    // 「読み込み中」が同時に出る。
    setError(null)
    loadHypocenterIndex()
      .then((idx) => {
        if (cancelled) return
        setIndex(idx)
      })
      .catch((err: unknown) => {
        // **打ち切られていても記録は残す。** タブを離れた瞬間に失敗すると、ここで黙ると
        // 痕跡が一つも残らない。画面へ出すのは打ち切られていないときだけ。
        log.error('[useHypocenterCatalog] 索引を取得できませんでした', err)
        if (cancelled) return
        setError('震源カタログを取得できず')
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [enabled, index, attempt])

  useEffect(() => {
    if (!enabled || !index) return
    const wanted = yearsInRange(index, fromYear, toYear)
    setRequestedYears(wanted.length)
    if (wanted.length === 0) {
      setYears(EMPTY_YEARS)
      setMissingYears(EMPTY_MISSING)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    // **1 年でも失敗したら全部捨てる、にはしない。** `Promise.all` だと 1 本の不調で期間全体が
    // 消えるうえ、どこが欠けたかも判らない。取れた年で描き、欠けた年は名指しで伝える。
    void Promise.allSettled(wanted.map(loadHypocenterYear)).then((results) => {
      const loaded: HypocenterYear[] = []
      const missing: number[] = []
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') {
          loaded.push(r.value)
          return
        }
        missing.push(wanted[i])
        log.error(`[useHypocenterCatalog] ${wanted[i]} 年を取得できませんでした`, r.reason)
      })
      // **範囲が変わっていたら捨てる。** 年を素早く動かすと古い応答が後から届き、
      // 選んでいない期間が描かれる（しかも次の操作まで直らない）。
      if (cancelled) return
      // **中身が同じなら前の配列をそのまま返す。** この効果は `enabled` を依存に持つので、
      // タブを離れて戻るだけで回り直す（通信は起きない。年ごとにキャッシュ済みのため）。
      // そこで新しい配列を作ると参照が変わり、下流の点群の組み立てと GPU への転送が
      // まるごと走り直す（全期間で 16ms ＋ 52ms）。**捨てていないのに詰め直すことになる。**
      setYears((prev) => (sameYears(prev, loaded) ? prev : loaded))
      setMissingYears((prev) => (sameNumbers(prev, missing) ? prev : missing.length > 0 ? missing : EMPTY_MISSING))
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [enabled, index, fromYear, toYear, attempt])

  // ── 末尾（カタログの終端より後の約 2 日。2026-11-06 ユーザー選択「カタログタブにも足す (Recommended)」）──
  // ヒートマップの末尾と同じく、中継の電文一覧から震源の電文を選んで読む（`fetchListedHypocenters`）
  //
  // **始まりは目次の終端ではなく、読めた終端の年ファイルの終端。** 年ファイル（書き足す年は 1 時間）と目次（10 分）は
  // 中継の控えの寿命が違うので、目次だけが 1 日先へ進んでいることも、その逆もある。目次の終端から足すと、前者では
  // 年ファイルに無い 1 日が抜け、後者では同じ地震が 2 つ並ぶ。年ファイルの終端から足せば、点の列は必ず繋がる。
  // 終端の年を読めていない（読み込み中・取れなかった）間は末尾を足さない。
  //
  // **終端の年は、選んだ期間の年とは別に読む。** 年をまたいだ直後（末尾だけが新しい年に入り、その年のファイルが
  // まだ無い数日）に期間を新しい年だけにすると、期間の年からは終端の年が消え、末尾まで消える。読み込みは年ごとに
  // 控えが効くので、期間に入っている年なら通信は増えない
  const endYear = index ? jstYearOf(index.coveredThroughMs) : null
  const endYearListed = index !== null && endYear !== null && index.years.includes(endYear)
  const [endYearFile, setEndYearFile] = useState<{ year: number; coveredThroughMs: number } | null>(null)
  useEffect(() => {
    if (!enabled || !endYearListed || endYear === null || toYear < endYear) return
    let cancelled = false
    loadHypocenterYear(endYear)
      .then((y) => {
        if (!cancelled) setEndYearFile((prev) => (prev?.year === y.year && prev.coveredThroughMs === y.coveredThroughMs ? prev : { year: y.year, coveredThroughMs: y.coveredThroughMs }))
      })
      .catch((err: unknown) => {
        // 期間の年として読んでいれば missingYears にも出る。ここは末尾を足さないことだけ残す
        log.error(`[useHypocenterCatalog] 終端の ${endYear} 年を読めないので、震源カタログの末尾を足しません`, err)
      })
    return () => { cancelled = true }
  }, [enabled, endYearListed, endYear, toYear, attempt])
  /** 読めた年ファイルの終端。年の頭ちょうどが終端（新しい年のファイルがまだ無い）なら目次の終端 */
  const catalogEndMs = !index ? null
    : !endYearListed ? index.coveredThroughMs
      : endYearFile?.year === endYear ? endYearFile.coveredThroughMs : null
  const wantsTail = index !== null && catalogEndMs !== null && toYear >= jstYearOf(catalogEndMs)
  const [tail, setTail] = useState<{ year: HypocenterYear; fromMs: number; untilMs: number } | null>(null)
  const tailFetchedRef = useRef<{ fromMs: number; atMs: number } | null>(null)
  // 取れなかった・取りきれなかった時刻。失敗が続く間、タブの出入りのたびに電文一覧を引き直さない
  const tailFailedAtRef = useRef(0)
  /** 最後に末尾の効果を回したときの attempt（手で押した再試行を見分ける） */
  const tailAttemptRef = useRef(0)
  useEffect(() => {
    if (!enabled || !wantsTail || catalogEndMs === null) return
    const fromMs = catalogEndMs
    const untilMs = liveServerNow()
    if (untilMs <= fromMs) return
    if (untilMs - fromMs > TAIL_MAX_MS) {
      log.error(`[useHypocenterCatalog] 震源カタログの終端（${new Date(fromMs).toISOString()}）が 30 日より前のため、末尾を足しません（中継の書き足しが止まっている）`)
      return
    }
    const last = tailFetchedRef.current
    if (last && last.fromMs === fromMs && untilMs - last.atMs < TAIL_REFRESH_MS) return
    // 手で押した再試行（attempt が進んだ）は、失敗の後の間を待たずに取り直す
    const manualRetry = attempt !== tailAttemptRef.current
    tailAttemptRef.current = attempt
    if (!manualRetry && untilMs - tailFailedAtRef.current < TAIL_RETRY_AFTER_FAILURE_MS) {
      log.debug('[useHypocenterCatalog] 震源カタログの末尾は失敗して間もないので、まだ取り直しません')
      return
    }
    const controller = new AbortController()
    fetchListedHypocenters(relayRestEndpoint, new Date(fromMs), new Date(untilMs), controller.signal)
      .then((r) => {
        if (controller.signal.aborted) return
        if (!r.complete) {
          // 欠けたまま足さない（上の `tail` の注記）。少し置いて、次に開いたときにまた取りに行く
          tailFailedAtRef.current = liveServerNow()
          log.warn(`[useHypocenterCatalog] 震源カタログの末尾を取りきれなかったので、カタログの終端までを出します（読めた電文 ${r.quakes.length} 件）`)
          return
        }
        tailFetchedRef.current = { fromMs, atMs: liveServerNow() }
        const year = tailYearFromQuakes(r.quakes, fromMs, untilMs)
        // **中身が同じなら前の年をそのまま使う**（下流の点群の組み立てと GPU への転送を走らせ直さない）。範囲の終わりだけ進める
        setTail((prev) => ({
          year: prev && prev.fromMs === fromMs && sameTailYear(prev.year, year) ? prev.year : year,
          fromMs,
          untilMs,
        }))
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        tailFailedAtRef.current = liveServerNow()
        log.error('[useHypocenterCatalog] 震源カタログの末尾を取得できませんでした（カタログの終端までを出します）', err)
      })
    return () => controller.abort()
  }, [enabled, wantsTail, catalogEndMs, attempt])

  // 始まりが今の終端と違う末尾（年ファイルが書き足されて終端が進んだ）は使わない。取り直すまで、カタログの終端までを出す
  const tailInUse = tail !== null && wantsTail && tail.fromMs === catalogEndMs ? tail : null
  const tailYear = tailInUse?.year ?? null
  // **参照を保つ。** 末尾が変わらなければ同じ配列を返す（下流の点群の組み立てと GPU への転送を走らせ直さない）
  const merged = useMemo(() => (tailYear ? [...years, tailYear] : years), [years, tailYear])
  const tailFromMs = tailInUse?.fromMs ?? null
  const tailUntilMs = tailInUse?.untilMs ?? null
  const tailRange = useMemo(
    () => (tailFromMs !== null && tailUntilMs !== null ? { fromMs: tailFromMs, untilMs: tailUntilMs } : null),
    [tailFromMs, tailUntilMs],
  )

  return { index, catalogEndMs, years: merged, catalogYears: years, loading, error, missingYears, requestedYears, retry, tail: tailRange }
}
