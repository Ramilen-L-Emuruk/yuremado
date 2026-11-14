import { memo, useLayoutEffect, useMemo, useRef } from 'react'
import { RangeSlider } from '../RangeSlider'
import { DateField } from '../DateField'
import { Toggle } from '../Toggle'
import { DescriptionTip } from '../DescriptionTip'
import { useLocale, useMessages } from '../../i18n/I18nProvider'
import { localeTag } from '../../i18n/messages'
import type { HypocenterIndex } from '../../utils/hypocenterCatalog'
import {
  catalogCompleteness,
  catalogPeriodBounds,
  DEPTH_FILTER_MAX_KM,
  depthBoundLabel,
  MAGNITUDE_FILTER_RANGE,
  magnitudeBoundLabel,
  LATITUDE_FILTER_RANGE,
  LONGITUDE_FILTER_RANGE,
  latBoundLabel,
  lngBoundLabel,
  type CatalogColorBy,
  type CatalogFilter,
  formatMissingYears,
  formatJstDate,
  periodFromDateChange,
  periodFromYearChange,
  pointSizePx,
  jstYearEndMs,
  jstYearOf,
  jstYearStartMs,
  oldestYearOf,
  periodDayCount,
  preliminaryNote,
  rangeLabel,
  toDateInputValue,
  type CatalogViewOptions,
} from '../../utils/hypocenterCatalogView'

// 長期震源カタログの操作パネル。**描くのは地図の担当**で、ここは条件を決めるだけ。
// 点群への変換は utils/hypocenterCatalogView.ts、描画は components/Map/HypocenterCatalogGL.tsx。
//
// 絞り込みは 5 つとも**二つまみのスライダー 1 本**（期間・マグニチュード・深さ・緯度・経度。
// `RangeSlider`）。上下を別の行に分けると、どちらが範囲のどちら側か読み取りづらく、いま選んでいる
// 幅も見えない。**緯度・経度・深さの 3 つで直方体を切り出せる。**
// 説明文は常時表示せず、ラベルをホバー・タップしたときに出す（設定の窓と同じ `DescriptionTip`）。

interface Props {
  index: HypocenterIndex | null
  filter: CatalogFilter
  onFilterChange: (next: CatalogFilter) => void
  view: CatalogViewOptions
  onViewChange: (next: CatalogViewOptions) => void
  /** いま地図に出ている点の数。 */
  pointCount: number
  /** そのうち M が決まっていない地震の数（件数欄に内訳として出す）。 */
  unknownMagnitudeCount: number
  loading: boolean
  /**
   * 絞り込みを変えた直後で、件数と点群がまだ追いついていないか。
   *
   * **これが無いと「効いていない」と誤解される。** ラベルは即座に変わるのに件数は遅れて動くため、
   * 何も出さないと変更が無視されたように見える（期間以外のスライダーでは `loading` も立たない）。
   */
  pending: boolean
  /** 索引を取得できなかったか。年ファイルの欠けは `missingYears`。 */
  indexFailed: boolean
  /** 取得できなかった年（昇順）。空でなければ件数はそのぶん少ない。 */
  missingYears: number[]
  /**
   * 取りに行った年の数。
   *
   * **`missingYears` と同数なら「まるごと取れなかった」。** 件数 0 が絞り込みの結果なのか
   * 取得の失敗なのか、これが無いと言い分けられない。
   */
  requestedYears: number
  onRetry: () => void
  /**
   * カタログの終端より後を、中継の地震情報の電文から足した範囲。取れていなければ null（期間の端はカタログの終端で止め、
   * 添え書きの 2 つ目の文も出さない）。→ `useHypocenterCatalog` の `tail`
   */
  tail: { fromMs: number; untilMs: number } | null
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    // 設定の窓の節と同じ形（地も角丸も無く、上下の線と行の区切り線だけ。見出しは小さい弱い字）
    <section className="mb-4">
      {/* 巻いている間は、その節の見出しを件数の行の下に残す（2026-11-04 ユーザー選択「貼りつける (Recommended)」）。
          件数の行は折り返すことがあるので、高さは測った値（--catalog-head-h）を使う */}
      <h2
        className="sticky z-[1] bg-panel pt-1 pb-1.5 font-bold text-secondary"
        style={{ top: 'var(--catalog-head-h, 0px)', paddingInline: 'var(--qk-pad)' }}
      >
        {title}
      </h2>
      {/* isolate: スライダーのつまみの重なり順（3・4）を節の中に閉じる。閉じないと、巻いたときに貼りついた件数の行と見出しの上へ透ける */}
      <div className="isolate divide-y divide-border border-y border-border">{children}</div>
    </section>
  )
}

/** 左にラベル・右にコントロールの行。説明文はラベルをホバー・タップしたときだけ出す。 */
function Row({
  label,
  description,
  children,
}: {
  label: string
  description?: string
  children: React.ReactNode
}) {
  return (
    // data-settings-row は説明の吹き出しが基準にする矩形の目印（`DescriptionTip` 参照）。
    <div data-settings-row className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2.5" style={{ paddingInline: 'var(--qk-pad)' }}>
      <div className="min-w-0 grow basis-32">
        {description
          ? <DescriptionTip label={label} description={description} />
          : <p className="text-white" style={{ fontSize: 'var(--qk-f)' }}>{label}</p>}
      </div>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  )
}

/**
 * スライダー 1 本ぶんの行。**ラベルの右に、いま選んでいる範囲を出す。**
 *
 * つまみを見ただけでは値が読めないので、数値は常に出す（説明文だけがホバーへ隠れる）。
 */
function RangeRow({
  label,
  description,
  valueText,
  note,
  children,
}: {
  label: string
  description: string
  valueText: string
  /** 範囲の下に添える 1 行。無ければ `null`（行ごと出さない）。 */
  note: string | null
  children: React.ReactNode
}) {
  return (
    <div data-settings-row className="py-2.5" style={{ paddingInline: 'var(--qk-pad)' }}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4">
        <DescriptionTip label={label} description={description} />
        <p className="text-secondary tabular-nums">{valueText}</p>
      </div>
      {note && <p className="text-secondary text-right">{note}</p>}
      <div className="mt-1">{children}</div>
    </div>
  )
}

const SELECT_CLASS =
  'bg-panel border border-border text-white rounded-sm px-2 py-1.5 focus:outline-hidden focus:border-blue-500'

// 日付ピッカー。**`color-scheme` を暗い側へ寄せる**——ブラウザが描くカレンダーのアイコンと
// ポップアップは配色をここから決めるため、指定しないと暗い背景の上に明るい部品が乗る。
const DATE_INPUT_CLASS = `${SELECT_CLASS} scheme-dark`

export const CatalogTab = memo(function CatalogTab({
  index,
  filter,
  onFilterChange,
  view,
  onViewChange,
  pointCount,
  unknownMagnitudeCount,
  loading,
  pending,
  indexFailed,
  missingYears,
  requestedYears,
  onRetry,
  tail,
}: Props) {
  const { catalog: cm, formats: fw } = useMessages()
  const tag = localeTag(useLocale())
  // 桁の区切りは言語ごと。整形の部品は言語が変わったときだけ作る（スライダーを動かすたびに作り直さない）
  const numberFormat = useMemo(() => new Intl.NumberFormat(tag), [tag])
  const num = (n: number) => numberFormat.format(n)
  const years = index?.years ?? []
  // **収録の両端をスライダーの端にする。** 索引が来るまでは選んでいる値をそのまま端にして
  // おく（つまみが範囲外に置かれると、ブラウザが勝手に丸めて値が飛ぶ）。
  // **終わりはデータの最終日**（`catalogPeriodBounds`）。年の終わりまで選べると、まだ取れて
  // いない日が「地震が無かった日」に見える。
  const fromYear = jstYearOf(filter.fromMs)
  const toYear = jstYearOf(filter.toMs)
  const bounds = index && years.length > 0 ? catalogPeriodBounds(index, tail?.untilMs ?? null) : null
  const periodMin = bounds?.minMs ?? jstYearStartMs(fromYear)
  const periodMax = bounds?.maxMs ?? jstYearEndMs(toYear)
  const firstYear = jstYearOf(periodMin)
  const lastYear = jstYearOf(periodMax)
  const completeness = index ? catalogCompleteness(index, filter) : null
  const dayCount = periodDayCount(filter.fromMs, filter.toMs)

  // 貼りついた件数の行の高さを、節の見出しが貼りつく位置として渡す。描き直さずに済むよう CSS の変数で渡す
  const scopeRef = useRef<HTMLDivElement>(null)
  const headRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const scope = scopeRef.current
    const head = headRef.current
    if (!scope || !head) return
    const apply = () => scope.style.setProperty('--catalog-head-h', `${head.getBoundingClientRect().height}px`)
    apply()
    // 見張れない環境（試験の環境など）では、最初に測った高さのまま
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(apply)
    ro.observe(head)
    return () => ro.disconnect()
  }, [])

  // 期間の決め方そのものは `hypocenterCatalogView` の純粋関数に置いてある（単体テストの対象）。
  // ここは値を繋ぐだけ。
  const changeYears = (nextFrom: number, nextTo: number) => {
    onFilterChange({ ...filter, ...periodFromYearChange(filter, nextFrom, nextTo, periodMin, periodMax) })
  }

  // **読めない値では何もしない。** 日付ピッカーは打鍵の途中で空や不完全な値を返す。
  const changeDate = (value: string, edge: 'from' | 'to') => {
    const next = periodFromDateChange(filter, value, edge, periodMin, periodMax)
    if (next == null) return
    onFilterChange({ ...filter, ...next })
  }


  return (
    // 文字と余白は地震一覧と同じ 2 組（器の幅 520px で切り替え。値は src/index.css の quake-list）
    <div className="quake-list">
    <div ref={scopeRef} className="quake-list-scope pb-3" style={{ fontSize: 'var(--qk-fs)' }}>
      {/* 件数は一番上に貼りつける。絞り込みを動かしながら数が見えるように（2026-11-04 ユーザー選択
          「上に貼りつける (Recommended)」。前は一番下の「表示中」の枠にあり、狭い画面ではスライダーと同時に見えなかった） */}
      {/* data-settings-row は説明の吹き出しが基準にする矩形の目印（`DescriptionTip` 参照）。説明の文は前の
          「件数」の行のまま（2026-11-04 ユーザー選択「「表示中」に戻す (Recommended)」） */}
      <div ref={headRef} data-settings-row className="sticky top-0 z-[2] flex flex-wrap items-baseline gap-x-2 border-b border-border bg-panel" style={{ padding: '8px var(--qk-pad)' }}>
        <DescriptionTip
          label={cm.showing}
          description={loading ? cm.showingHint.loading : pending ? cm.showingHint.pending : cm.showingHint.idle}
        />
        <span className="text-white tabular-nums" style={{ fontSize: 'var(--qk-f)' }}>
          {cm.count(pointCount, num(pointCount))}
          {/* 2026-10-18 ユーザー選択「内訳を出す」。0 件なら括弧ごと出さない。 */}
          {unknownMagnitudeCount > 0 && cm.unknownMagnitude(unknownMagnitudeCount, num(unknownMagnitudeCount))}
        </span>
        {(loading || pending) && (
          <span className="text-secondary">{loading ? cm.loading : cm.updating}</span>
        )}
      </div>
      {/* 件数を読み違えないための知らせは、件数の行の真下に置く（取得できなかった年があると件数は少なく出る）。
          下の節の後ろに置くと、件数を見ながら絞り込みを動かしている間は目に入らない */}
      {(indexFailed || missingYears.length > 0) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-2" style={{ paddingInline: 'var(--qk-pad)' }}>
          <p className="text-red-400">
            {/* **まるごと取れなかったときは言い方を変える。** 「そのぶん少なく」では、
                1 件も出ていない状態が「少し欠けている」と読める。 */}
            {indexFailed
              ? cm.indexFailed
              : missingYears.length >= requestedYears
                ? cm.missingAllYears(formatMissingYears(missingYears, cm))
                : cm.missingSomeYears(formatMissingYears(missingYears, cm))}
          </p>
          <button
            onClick={onRetry}
            className="rounded-md border border-border bg-panel px-3 py-1.5 text-white whitespace-nowrap transition-colors motion-reduce:transition-none hover:bg-white/10"
          >
            {cm.retry}
          </button>
        </div>
      )}
      {completeness?.belowComplete && (
        <p className="text-yellow-400 pt-2" style={{ paddingInline: 'var(--qk-pad)' }}>
          {cm.completeness(oldestYearOf(filter), completeness.completeMin.toFixed(1))}
        </p>
      )}
      <div className="pt-3">
      <Section title={cm.filterSection}>
        <RangeRow
          label={cm.period}
          description={cm.periodHint}
          valueText={cm.periodValue(formatJstDate(filter.fromMs, fw), formatJstDate(filter.toMs, fw), dayCount, num(dayCount))}
          note={index ? preliminaryNote(index, filter, tail?.fromMs ?? null, cm, fw) : null}
        >
          <RangeSlider
            label={cm.period}
            ends={cm.periodEnds}
            min={firstYear}
            max={lastYear}
            step={1}
            from={fromYear}
            to={toYear}
            disabled={years.length === 0}
            onChange={changeYears}
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <DateField
              label={cm.startDate}
              value={toDateInputValue(filter.fromMs)}
              min={toDateInputValue(periodMin)}
              max={toDateInputValue(periodMax)}
              disabled={years.length === 0}
              onCommit={(v) => changeDate(v, 'from')}
              className={DATE_INPUT_CLASS}
            />
            <span className="text-secondary">{cm.dateSeparator}</span>
            <DateField
              label={cm.endDate}
              value={toDateInputValue(filter.toMs)}
              min={toDateInputValue(periodMin)}
              max={toDateInputValue(periodMax)}
              disabled={years.length === 0}
              onCommit={(v) => changeDate(v, 'to')}
              className={DATE_INPUT_CLASS}
            />
          </div>
        </RangeRow>

        <RangeRow
          label={cm.magnitude}
          note={null}
          description={cm.magnitudeHint}
          valueText={rangeLabel(
            magnitudeBoundLabel(filter.minMagnitude, 'min', cm),
            magnitudeBoundLabel(filter.maxMagnitude, 'max', cm),
            cm,
          )}
        >
          <RangeSlider
            label={cm.magnitude}
            min={MAGNITUDE_FILTER_RANGE.min}
            max={MAGNITUDE_FILTER_RANGE.max}
            step={0.1}
            from={filter.minMagnitude}
            to={filter.maxMagnitude}
            onChange={(minMagnitude, maxMagnitude) => onFilterChange({ ...filter, minMagnitude, maxMagnitude })}
          />
        </RangeRow>

        <RangeRow
          label={cm.depth}
          note={null}
          description={cm.depthHint}
          valueText={rangeLabel(depthBoundLabel(filter.minDepthKm, 'min', cm), depthBoundLabel(filter.maxDepthKm, 'max', cm), cm)}
        >
          <RangeSlider
            label={cm.depth}
            min={0}
            max={DEPTH_FILTER_MAX_KM}
            step={10}
            from={filter.minDepthKm}
            to={filter.maxDepthKm}
            onChange={(minDepthKm, maxDepthKm) => onFilterChange({ ...filter, minDepthKm, maxDepthKm })}
          />
        </RangeRow>

        <RangeRow
          label={cm.latitude}
          note={null}
          description={cm.latitudeHint}
          valueText={rangeLabel(latBoundLabel(filter.minLat, 'min', cm), latBoundLabel(filter.maxLat, 'max', cm), cm)}
        >
          <RangeSlider
            label={cm.latitude}
            min={LATITUDE_FILTER_RANGE.min}
            max={LATITUDE_FILTER_RANGE.max}
            step={0.5}
            from={filter.minLat}
            to={filter.maxLat}
            onChange={(minLat, maxLat) => onFilterChange({ ...filter, minLat, maxLat })}
          />
        </RangeRow>

        <RangeRow
          label={cm.longitude}
          note={null}
          description={cm.longitudeHint}
          valueText={rangeLabel(lngBoundLabel(filter.minLng, 'min', cm), lngBoundLabel(filter.maxLng, 'max', cm), cm)}
        >
          <RangeSlider
            label={cm.longitude}
            min={LONGITUDE_FILTER_RANGE.min}
            max={LONGITUDE_FILTER_RANGE.max}
            step={0.5}
            from={filter.minLng}
            to={filter.maxLng}
            onChange={(minLng, maxLng) => onFilterChange({ ...filter, minLng, maxLng })}
          />
        </RangeRow>

        {/* 既定は出さず、切り替えで足す（2026-10-25 ユーザー選択「既定は J だけ・切り替えで足す (Recommended)」）。
            文言は 2026-10-25 ユーザー承認「D の案でよい (Recommended)」。 */}
        <Row
          label={cm.external}
          description={cm.externalHint}
        >
          <Toggle
            label={cm.external}
            checked={filter.includeExternal}
            onChange={(v) => onFilterChange({ ...filter, includeExternal: v })}
          />
        </Row>
      </Section>

      <Section title={cm.viewSection}>
        <Row label={cm.colorBy} description={cm.colorByHint}>
          <select
            value={view.colorBy}
            onChange={(e) => onViewChange({ ...view, colorBy: e.target.value as CatalogColorBy })}
            className={SELECT_CLASS}
          >
            {(Object.keys(cm.colorByOption) as CatalogColorBy[]).map((k) => (
              <option key={k} value={k}>{cm.colorByOption[k]}</option>
            ))}
          </select>
        </Row>
        {/* **倍率は実装から引く。** 数値を書き写すと、効き方を変えたときに説明文だけ古い値のまま残る。 */}
        <Row
          label={cm.emphasis}
          description={cm.emphasisHint(pointSizePx(1, 3, 'magnitude').toFixed(2), pointSizePx(1, 9, 'magnitude').toFixed(2))}
        >
          <Toggle
            label={cm.emphasis}
            checked={view.sizeBy === 'magnitude'}
            onChange={(v) => onViewChange({ ...view, sizeBy: v ? 'magnitude' : 'fixed' })}
          />
        </Row>
        <Row label={cm.pointSize} description={cm.pointSizeHint}>
          {/* **値は隠さない。** 隠してよいのは説明文だけ（スライダーを見ても px は読めない）。 */}
          <span className="text-secondary tabular-nums">{view.sizePx.toFixed(1)} px</span>
          <input
            type="range"
            aria-label={cm.pointSize}
            min={1}
            max={8}
            step={0.5}
            value={view.sizePx}
            onChange={(e) => onViewChange({ ...view, sizePx: Number(e.target.value) })}
            className="w-32"
          />
        </Row>
      </Section>

      {/* 「 / 」で繋いだ出典は 1 つ 1 行にする。器の幅 520px 未満はラベルの下に左寄せ、以上はラベルの右に右寄せ
          （設定の窓からの横展開。2026-11-04 ユーザー選択済み） */}
      {index && (
        <div className="flex flex-col gap-x-4 text-secondary @min-[520px]:flex-row @min-[520px]:justify-between" style={{ paddingInline: 'var(--qk-pad)' }}>
          <span className="shrink-0">{cm.source}</span>
          <div className="flex flex-col @min-[520px]:items-end @min-[520px]:text-right">
            {index.source.split(' / ').map((s) => <span key={s}>{s}</span>)}
            <span>{fw.paren(index.license)}</span>
          </div>
        </div>
      )}
      </div>
    </div>
    </div>
  )
})
