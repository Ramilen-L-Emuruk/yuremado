import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { ARCHIVE_START_DAY } from '../../services/dmdataReplay'
import { createPortal } from 'react-dom'
import type { JMAQuake } from '../../types/earthquake'
import { PREFECTURES } from '../../data/prefectureCodes'
import { RangeSlider } from '../RangeSlider'
import { DateField } from '../DateField'
import { useSubRegions } from '../../hooks/useSubRegions'
import { serverNow } from '../../utils/clock'
import { OVERLAY_BACKDROP_PAD } from '../../rootFrame'
import { areaPrefIndexOf, getStationCoordsCache, onStationCoordsLoaded, regionOrderIndexOf, regionOrderRank, type StationCoordsData } from '../../utils/stationCoords'
import { clampPeriodRange } from '../../utils/historyDays'
import { useMessages } from '../../i18n/I18nProvider'
import { quakeReportNameText } from './quakeNames'
import {
  clearQuakeListFilter, QUAKE_DEPTH_RANGE, QUAKE_LIST_TYPES, QUAKE_MAGNITUDE_RANGE, QUAKE_PERIOD_HOURS, QUAKE_SCALE_STEPS,
  isQuakeListFiltered, quakeFilterChipLabels, quakePeriodHoursLabel, type QuakeFilterKind, quakeRegionBlocks, quakeRegionGroups, type QuakeRegionOption,
  type QuakeListFilter, type QuakeRange, type QuakeRegionBasis, type QuakeListType, type QuakeRegionView,
} from '../../utils/quakeListView'

/**
 * 地震タブの絞り込み（2026-11-07 ユーザー選択。決まったことは docs/spec/quake-spec.md「地震タブの絞り込みと並び替え」）。
 * 一覧の見出しの行の左端に漏斗の印のボタンを置き、押すと 6 つの条件を節に分けた窓を 1 つ開く
 * （2026-11-08 ユーザー発言「地震タブの上を使ってるのはありえない。もったいなすぎる。フィルタボタンとかで出すべき。」
 * 「震央地名の横じゃなくて普通に左端(震度の横)においてみて。」・選択「漏斗の印＋数 (Recommended)」）。
 */
export type FilterKind = QuakeFilterKind

const KINDS: readonly FilterKind[] = ['scale', 'magnitude', 'depth', 'region', 'types', 'period']

const BUTTON_CLASS = 'rounded-md border border-border bg-panel px-3 py-1.5 text-xs text-white whitespace-nowrap transition-colors motion-reduce:transition-none hover:bg-white/10 disabled:opacity-40 disabled:hover:bg-panel'
/** 震源カタログタブの日付の欄と同じ見た目（`CatalogTab` の `DATE_INPUT_CLASS`）。 */
const DATE_INPUT_CLASS = 'bg-panel border border-border text-white rounded-sm px-2 py-1.5 focus:outline-hidden focus:border-blue-500 scheme-dark'
/** 期間の日付で選べる最も古い日（地震情報のアーカイブの始まり）。読み込んでいない日を選ぶと、地震タブが読み足してから絞る。 */
const PERIOD_MIN_DAY = ARCHIVE_START_DAY

/** 日本時間の `YYYY-MM-DD`（期間の絞りを日本時間で切るのとそろえる。2026-11-08 選択「日本時間で切る」）。 */
function jstYmd(ms: number): string {
  const d = new Date(ms + 9 * 3_600_000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

function activeKinds(filter: QuakeListFilter): Record<FilterKind, boolean> {
  return {
    scale: filter.scale.min !== null || filter.scale.max !== null,
    magnitude: filter.magnitude.min !== null || filter.magnitude.max !== null,
    depth: filter.depth.min !== null || filter.depth.max !== null,
    region: filter.region.names.length > 0,
    types: filter.types.length > 0,
    period: filter.period !== null,
  }
}

/**
 * 絞り込みのボタン（漏斗の印）。絞っている条件があれば青くし、その数を漏斗の右上に小さく重ねる（絞っていることはここで分かる）。
 * 数を横に並べないのは、震度の欄（狭い幅で 50px）に「震度▼」と並べると隣の欄へはみ出すから（2026-11-08 選択「数を漏斗の右上に小さく重ねる (Recommended)」）
 */
export function QuakeListFilterButton({ filter, open, onOpen }: { filter: QuakeListFilter; open: boolean; onOpen: () => void }) {
  const q = useMessages().quake
  const count = Object.values(activeKinds(filter)).filter(Boolean).length
  return (
    <button
      type="button"
      data-filter-button
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={count > 0 ? q.filter.titleCount(count) : q.filter.title}
      onClick={onOpen}
      // 押せる範囲は見た目より広くする（負の余白で打ち消すので、並びの中で占める幅は漏斗の 12px だけ）。スマホで指が届く大きさにする
      className={`relative -mx-1.5 -my-1.5 flex shrink-0 items-center rounded-sm px-1.5 py-1.5 hover:text-white ${count > 0 ? 'text-blue-400' : ''}`}
    >
      <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3 w-3" fill="currentColor"><path d="M1.5 2h13l-5 6.2V13l-3 1.5V8.2z" /></svg>
      {count > 0 && <span aria-hidden="true" className="absolute top-0.5 left-[15px] text-[9px] leading-none font-bold tabular-nums">{count}</span>}
    </button>
  )
}

interface DialogProps {
  filter: QuakeListFilter
  onChange: (next: QuakeListFilter) => void
  /** 地域の一覧と件数を作る元（絞る前の、読み込んだ地震すべて）。 */
  quakes: readonly JMAQuake[]
  /**
   * 開いているか。**持ち主は地震タブ**で、窓もボタンとは別に地震タブが描く（一覧が空の画面と並んだ画面で
   * 見出しの行が作り直されても、窓の中身を捨てない）。
   */
  open: boolean
  onClose: () => void
  /**
   * 条件に合う地震の数と、読み込んだ地震の数。窓の見出しの横に出す。条件に合わないまま一覧に出す最新の 1 枚・飛んで開いた 1 件は
   * 数えない（2026-11-08 選択「条件に合う数だけ」）
   */
  shownCount: number
  totalCount: number
  /**
   * 期間に合わせた読み足しの様子（2026-11-08 選択「読み込み中と止まった後を分けて出す (Recommended)」）。読み込み中か、止まって
   * 期間の始まりまで読めていないときだけ渡す。`note` は期間の節に出す文、`countSuffix` は件数の後ろに添える語
   */
  loadNote: { note: string; countSuffix: string; loading: boolean } | null
}

/**
 * 条件を選ぶ窓。**地震タブの、一覧の画面の枝より外の決まった位置に描く**（読み込み中・空・一覧のどの画面でも
 * 同じ位置にあるので、画面が替わっても作り直されない。body へ描くので見た目の位置は変わらない）。
 */
export function QuakeListFilterDialog({ filter, onChange, quakes, open, onClose, shownCount, totalCount, loadNote }: DialogProps) {
  const q = useMessages().quake
  if (!open) return null
  const labels = quakeFilterChipLabels(filter, q)
  const active = activeKinds(filter)
  const body: Record<FilterKind, ReactNode> = {
    scale: <ScaleRange value={filter.scale} text={labels.scale} onChange={scale => onChange({ ...filter, scale })} />,
    magnitude: (
      <NumberRange
        range={QUAKE_MAGNITUDE_RANGE} value={filter.magnitude} label={q.filter.section.magnitude} text={labels.magnitude}
        onChange={magnitude => onChange({ ...filter, magnitude })}
      />
    ),
    depth: (
      <NumberRange
        range={QUAKE_DEPTH_RANGE} value={filter.depth} label={q.filter.section.depth} text={labels.depth}
        onChange={depth => onChange({ ...filter, depth })}
      />
    ),
    region: <RegionPicker filter={filter} quakes={quakes} onChange={onChange} />,
    types: <TypePicker value={filter.types} onChange={types => onChange({ ...filter, types })} />,
    period: (
      <>
        <PeriodPicker filter={filter} nowMs={serverNow()} onChange={onChange} />
        {loadNote && <p className="mt-2 text-xs text-secondary">{loadNote.note}</p>}
      </>
    ),
  }
  return (
    <FilterDialog
      title={q.filter.title}
      // 今の条件で一覧に出る数（2026-11-08 ユーザー発言「選んでる条件で表示される地震の数は…あらかじめ表示しておくべき」・選択「窓の見出しの横「50件中 12件」 (Recommended)」）
      count={(isQuakeListFiltered(filter) ? q.filter.countOf(totalCount, shownCount) : q.filter.count(totalCount)) + (loadNote?.countSuffix ?? '')}
      // 自動で読み足している間は読み上げない（7 日ずつ増えるたびに読むと続けて鳴る）。読み終わった件数は読む
      countLive={!(loadNote?.loading ?? false)}
      onClose={onClose} onClearAll={isQuakeListFiltered(filter) ? () => onChange(clearQuakeListFilter(filter)) : null}>
      {KINDS.map(kind => (
        <section key={kind} className="border-b border-border py-3 first:pt-0 last:border-b-0">
          <div className="mb-2 flex items-center gap-2">
            <h3 className="text-white">{q.filter.section[kind]}</h3>
            {active[kind] && (
              <button type="button" className="ml-auto px-1 underline-offset-2 hover:text-white hover:underline" onClick={() => onChange(clearKind(filter, kind))}>
                {q.filter.clearSelection}
              </button>
            )}
          </div>
          {body[kind]}
        </section>
      ))}
    </FilterDialog>
  )
}

function clearKind(f: QuakeListFilter, kind: FilterKind): QuakeListFilter {
  const none = { min: null, max: null }
  switch (kind) {
    case 'scale': return { ...f, scale: none }
    case 'magnitude': return { ...f, magnitude: none }
    case 'depth': return { ...f, depth: none }
    case 'region': return { ...f, region: { ...f.region, names: [] } }
    case 'types': return { ...f, types: [] }
    case 'period': return { ...f, period: null }
  }
}

/**
 * 窓の枠。作りは設定の「通知する地域」の窓（`PrefecturePicker`）に揃える —— body に描き、開いたらフォーカスを［閉じる］へ移し、
 * Esc は先に受けて伝わりを止める。閉じたらフォーカスを開いたボタンへ戻す（ブラウザが押した要素を覚えているので、閉じる側で戻す）。
 * 選んだものはその場で一覧へ効かせる（2026-11-07 選択「地域で絞る／地名で探す／海域／選択を解除 (Recommended)」の説明「決定のボタンは置かない」）。
 */
function FilterDialog({ title, count, countLive, onClose, onClearAll, children }: { title: string; count: string; countLive: boolean; onClose: () => void; onClearAll: (() => void) | null; children: ReactNode }) {
  const q = useMessages().quake
  const closeRef = useRef<HTMLButtonElement | null>(null)
  // **開いたときに 1 回だけ**フォーカスを移し、閉じたときに戻す。`onClose` は描くたびに新しい関数になるので、
  // 依存に置くと値を変えるたびにフォーカスがボタンと［閉じる］を往復し、スライダーの矢印キーが 2 回目から届かない
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const opener = document.activeElement
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return
      e.stopImmediatePropagation()
      onCloseRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      // 開いている間に一覧が空の画面と行き来すると見出しの行が作り直され、開いたボタンは DOM から外れている。そのときは今のボタンへ戻す
      // Safari はボタンを押してもフォーカスを移さないので、開いた時点の要素が body のことがある。そのときも退避先へ戻す
      const back = opener instanceof HTMLElement && opener !== document.body && opener.isConnected
        ? opener
        : document.querySelector<HTMLElement>('[data-filter-button]')
      back?.focus()
    }
  }, [])
  // 暗幕で押し始めて暗幕で離したときだけ閉じる（つまみを窓の外まで引いて離しても、暗幕から窓へ引いて離しても閉じない。
  // 窓の中で離すと click は共通の祖先の暗幕に出るので、離した先は pointerup で見る）
  const downOnBackdrop = useRef(false)
  const upOnBackdrop = useRef(false)
  return createPortal(
    <div
      className={`fixed inset-0 z-100000 flex items-center justify-center bg-black/60 ${OVERLAY_BACKDROP_PAD} [--text-sm:0.90625rem] [--text-xs:0.71875rem] min-[520px]:[--text-sm:1rem] min-[520px]:[--text-xs:0.78125rem]`}
      onClick={e => {
        e.stopPropagation()
        if (e.target === e.currentTarget && downOnBackdrop.current && upOnBackdrop.current) onClose()
        downOnBackdrop.current = false
        upOnBackdrop.current = false
      }}
      onPointerDown={e => {
        e.stopPropagation()
        downOnBackdrop.current = e.target === e.currentTarget
      }}
      onPointerUp={e => { upOnBackdrop.current = e.target === e.currentTarget }}
      role="presentation"
    >
      <div role="dialog" aria-modal="true" aria-label={title} className="flex max-h-full w-[min(32rem,100%)] flex-col rounded-md border border-border bg-panel p-4 shadow-[0_3px_8px_rgba(0,0,0,.55)]">
        <div className="mb-3 flex items-baseline gap-3 text-sm text-white">
          {title}
          <span aria-live={countLive ? 'polite' : 'off'} className="text-xs tabular-nums text-secondary">{count}</span>
        </div>
        <div className="min-h-0 overflow-y-auto text-xs text-secondary">{children}</div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className={BUTTON_CLASS} disabled={onClearAll === null} onClick={onClearAll ?? undefined}>{q.filter.clearAll}</button>
          <button ref={closeRef} type="button" className={BUTTON_CLASS} onClick={onClose}>{q.filter.close}</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** 震度の範囲。カタログと同じ二つまみのスライダーで、階級ごとに止まる。端に置くとその側の制限を外す。 */
function ScaleRange({ value, text, onChange }: { value: QuakeRange; text: string; onChange: (r: QuakeRange) => void }) {
  const q = useMessages().quake
  const last = QUAKE_SCALE_STEPS.length - 1
  const indexOf = (v: number | null, fallback: number) => {
    if (v === null) return fallback
    const i = QUAKE_SCALE_STEPS.findIndex(s => s === v)
    return i >= 0 ? i : fallback
  }
  const from = indexOf(value.min, 0)
  const to = indexOf(value.max, last)
  // 値の文は短い形（2026-11-07 選択「地震タブは短い形、カタログは総ざらいで (Recommended)」）。絞っていないときはカタログと同じ「制限なし」
  // （2026-11-08 選択「カタログと同じくいつも出す」・語は震源カタログタブの `rangeLabel`）
  const unset = value.min === null && value.max === null
  return (
    <div>
      <p className="mb-1 min-h-[1.25em] text-right tabular-nums">{unset ? q.filter.noLimit : text}</p>
      <RangeSlider
        label={q.filter.section.scale} min={0} max={last} step={1} from={from} to={to}
        onChange={(a, b) => onChange({ min: a <= 0 ? null : QUAKE_SCALE_STEPS[a], max: b >= last ? null : QUAKE_SCALE_STEPS[b] })}
      />
    </div>
  )
}

/** 規模・深さの範囲。端に置くとその側の制限を外す（カタログと同じ）。 */
function NumberRange({ range, value, label, text, onChange }: {
  range: { readonly min: number; readonly max: number; readonly step: number }
  value: QuakeRange
  label: string
  text: string
  onChange: (r: QuakeRange) => void
}) {
  const q = useMessages().quake
  const round = (v: number) => Math.round(v / range.step) * range.step
  return (
    <div>
      <p className="mb-1 min-h-[1.25em] text-right tabular-nums">{value.min === null && value.max === null ? q.filter.noLimit : text}</p>
      <RangeSlider
        label={label} min={range.min} max={range.max} step={range.step}
        from={value.min ?? range.min} to={value.max ?? range.max}
        onChange={(a, b) => onChange({
          min: a <= range.min ? null : Number(round(a).toFixed(1)),
          max: b >= range.max ? null : Number(round(b).toFixed(1)),
        })}
      />
    </div>
  )
}

function TypePicker({ value, onChange }: { value: readonly QuakeListType[]; onChange: (t: QuakeListType[]) => void }) {
  const q = useMessages().quake
  const toggle = (t: QuakeListType) => onChange(value.includes(t) ? value.filter(x => x !== t) : [...value, t])
  return (
    <div className="flex flex-col gap-1.5">
      {QUAKE_LIST_TYPES.map(t => (
        <label key={t} className="flex cursor-pointer items-center gap-1.5">
          <input type="checkbox" checked={value.includes(t)} onChange={() => toggle(t)} />
          {quakeReportNameText(t, q)}
        </label>
      ))}
    </div>
  )
}

function PeriodPicker({ filter, nowMs, onChange }: { filter: QuakeListFilter; nowMs: number; onChange: (f: QuakeListFilter) => void }) {
  const q = useMessages().quake
  const today = jstYmd(nowMs)
  const p = filter.period
  // 「日付を指定」を押した時点で範囲を入れるので、選んでいるかは値から導く（解除したら戻る）
  const custom = p?.kind === 'range'
  const from = p?.kind === 'range' ? p.from : today
  const to = p?.kind === 'range' ? p.to : today
  const setRange = (a: string, b: string) => onChange({ ...filter, period: { kind: 'range', from: a, to: b } })
  // 長さの上限で寄せたときだけ、日付の欄の下に注記を出す（次に打つまで残す。2026-11-08 選択「寄せて注記も出す」）
  const [clampedByLength, setClampedByLength] = useState(false)
  // 打った欄はそのままにして反対の欄を寄せる。前後が逆なら同じ日へ（2026-11-07 ユーザー選択「もう片方を同じ日に寄せる (Recommended)」）、
  // 両端を含めて 90 日を超えたら 90 日の内へ（→ `clampPeriodRange`）
  const commit = (a: string, b: string, edited: 'from' | 'to') => {
    const r = clampPeriodRange(a, b, edited, today)
    setClampedByLength(r.clampedByLength)
    setRange(r.from, r.to)
  }
  const setFrom = (v: string) => commit(v, to, 'from')
  const setTo = (v: string) => commit(from, v, 'to')
  const chip = (on: boolean) => `rounded-md border px-2 py-0.5 ${on ? 'border-blue-500 bg-blue-500/20 text-white' : 'border-border hover:bg-white/10'}`
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {QUAKE_PERIOD_HOURS.map(o => (
          <button key={o.hours} type="button" aria-pressed={p?.kind === 'hours' && p.hours === o.hours} className={chip(p?.kind === 'hours' && p.hours === o.hours)}
            // 選んでいる期間をもう一度押すと外す（2026-11-08 選択「もう一度押すと外れる」）
            onClick={() => onChange({ ...filter, period: p?.kind === 'hours' && p.hours === o.hours ? null : { kind: 'hours', hours: o.hours } })}>
            {quakePeriodHoursLabel(o.hours, q)}
          </button>
        ))}
        <button type="button" aria-pressed={custom} className={chip(custom)} onClick={() => (custom ? onChange({ ...filter, period: null }) : setRange(from, to))}>{q.filter.chooseDates}</button>
      </div>
      {custom && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <DateField label={q.filter.startDate} value={from} min={PERIOD_MIN_DAY} max={today} onCommit={setFrom} className={DATE_INPUT_CLASS} />
          <span>〜</span>
          <DateField label={q.filter.endDate} value={to} min={PERIOD_MIN_DAY} max={today} onCommit={setTo} className={DATE_INPUT_CLASS} />
        </div>
      )}
      {custom && clampedByLength && <p className="mt-1.5 text-xs text-secondary">{q.filter.periodLimit}</p>}
    </div>
  )
}

/**
 * 地域の窓。基準（震央地名／震度を観測した地域）を切り替え、読み込んだ地震に出てくる地域を県ごとに件数つきで並べる
 * （2026-11-07 選択「読んだ地震にある地域＋件数 (Recommended)」）。
 *
 * **一覧と地図を切り替えられる**（2026-11-07 選択「触ってから決める (Recommended)」の後、2026-11-08 ユーザー発言「両方残す」）。
 * 地図は細分区域の形なので、名前が細分区域と一致する「震度を観測した地域」のときだけ出す
 * （震央地名は「石川県能登地方」「石川県西方沖」のように細分区域の名前と合わない）。
 */
function RegionPicker({ filter, quakes, onChange }: { filter: QuakeListFilter; quakes: readonly JMAQuake[]; onChange: (f: QuakeListFilter) => void }) {
  const w = useMessages().quake
  // 県でない組（海域・遠方）の名前を画面の語にする。県と地方の名前は地名なので電文の文字のまま
  const groupLabel = (label: string) => w.filter.groupName[label] ?? label
  // 一覧と地図のどちらを出すかは設定に覚える（2026-11-08 選択「最後に選んだ方を覚える」）
  const mode = filter.region.view
  const setMode = (view: QuakeRegionView) => { if (view !== mode) onChange({ ...filter, region: { ...filter.region, view } }) }
  const [query, setQuery] = useState('')
  // 地方と県の開閉（2026-11-08 ユーザー発言「地名広すぎるからたためるようにして。」、同日選択「地方ごとにまとめて 2 段で畳む」）。
  // 押して決めた段だけ開／閉を持ち、決めていない段は「選んだ地名があれば開く」。地名で探している間は全部開く。
  // 鍵は地方が `b:`・県が `p:` を頭に付ける（「北海道」は地方と県の両方の名前）
  const [groupOpen, setGroupOpen] = useState<ReadonlyMap<string, boolean>>(() => new Map())
  const setGroup = (key: string, open: boolean | null) => setGroupOpen(prev => {
    const next = new Map(prev)
    if (open === null) next.delete(key); else next.set(key, open)
    return next
  })
  const basis = filter.region.basis
  const names = filter.region.names
  // 区域→県の索引と標準の並びは座標表から引く。**読み込みを待って組み直す**（開いた時点で読めていないと、
  // 区域が「海域」へ入ったまま窓を閉じるまで直らない）
  const [coords, setCoords] = useState<StationCoordsData | null>(() => getStationCoordsCache())
  useEffect(() => (coords ? undefined : onStationCoordsLoaded(setCoords)), [coords])
  const groups = useMemo(() => {
    const order = coords ? regionOrderIndexOf(coords) : null
    return quakeRegionGroups(quakes, basis, names, PREFECTURES, coords ? areaPrefIndexOf(coords) : null, name => regionOrderRank(name, order))
  }, [quakes, basis, names, coords])
  const blocks = useMemo(() => quakeRegionBlocks(groups, PREFECTURES), [groups])
  const toggle = (name: string) => {
    const adding = !names.includes(name)
    // 選んだときは、地図から選んだときも選んだ地名のある地方と県が開いて見えるよう、その開閉の指定を外す。
    // 外したときは、その地方と県を開いたまま固定する（最後の 1 つを外した途端に 2 段とも畳まれ、押した行が消えないように）
    const b = blocks.find(x => x.groups.some(g => g.options.some(o => o.name === name)))
    const g = b?.groups.find(x => x.options.some(o => o.name === name))
    if (b) setGroup(`b:${b.label}`, adding ? null : true)
    if (g) setGroup(`p:${g.label}`, adding ? null : true)
    onChange({ ...filter, region: { ...filter.region, names: adding ? [...names, name] : names.filter(n => n !== name) } })
  }
  // 基準を変えたら選んだ名前は空にする（震央地名と細分区域は別の名前の集まり）
  // 基準を替えたら畳みの指定も外す（県の名前は両方の基準で同じなので、残すと片方で畳んだ県がもう片方でも畳まれて見える）
  const setBasis = (b: QuakeRegionBasis) => { if (b !== basis) { setGroupOpen(new Map()); onChange({ ...filter, region: { ...filter.region, basis: b, names: [] } }) } }
  const seg = (on: boolean) => `px-2 py-0.5 ${on ? 'bg-blue-500/30 text-white' : 'hover:bg-white/10'}`
  const q = query.trim()
  const mapOn = basis === 'observed' && mode === 'map'
  // 地図のときは一覧（地名の検索欄も）を隠す。地図を読み込めなかったときだけ出す（2026-11-08 選択「地図のときは一覧を隠す」）。
  // 区域の形はメインの地図と同じ取得の控えを読むだけなので、ここで読んでも通信は増えない
  const { failed: mapFailed } = useSubRegions()
  const listOn = !mapOn || mapFailed
  const present = useMemo(() => new Set(groups.flatMap(g => g.options.map(o => o.name))), [groups])
  const shown = blocks
    .map(b => ({
      ...b,
      groups: b.groups
        .map(g => ({ ...g, options: q === '' || b.label.includes(q) || groupLabel(b.label).includes(q) ? g.options : g.options.filter(o => o.name.includes(q) || g.label.includes(q) || groupLabel(g.label).includes(q)) }))
        .filter(g => g.options.length > 0),
    }))
    .filter(b => b.groups.length > 0)
  const pickedIn = (options: readonly QuakeRegionOption[]) => options.filter(o => names.includes(o.name)).length
  // 開閉の見出し。探している間は全部開いているので、押しても開閉を変えない（裏で状態だけ変わると、探し終えたときに急に変わる）
  const header = (key: string, label: string, picked: number, isOpen: boolean, className: string) => (
    <button
      type="button" aria-expanded={isOpen}
      onClick={() => { if (q === '') setGroup(key, !isOpen) }}
      className={`mb-1 flex w-full items-center gap-1 text-left hover:text-blue-300 ${className}`}
    >
      <span aria-hidden="true" className="w-3 text-secondary">{isOpen ? '▾' : '▸'}</span>
      {label}{picked > 0 && <span className="text-blue-300">（{picked}）</span>}
    </button>
  )
  const optionGrid = (options: readonly QuakeRegionOption[]) => (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1 pl-4">
      {options.map(o => (
        <label key={o.name} className="flex cursor-pointer items-center gap-1.5">
          <input type="checkbox" checked={names.includes(o.name)} onChange={() => toggle(o.name)} />
          <span className="min-w-0 flex-1 truncate">{o.name}</span>
          <span className="tabular-nums">{o.count}</span>
        </label>
      ))}
    </div>
  )
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex overflow-hidden rounded-md border border-border">
          <button type="button" aria-pressed={basis === 'epicenter'} className={seg(basis === 'epicenter')} onClick={() => setBasis('epicenter')}>{w.filter.basis.epicenter}</button>
          <button type="button" aria-pressed={basis === 'observed'} className={seg(basis === 'observed')} onClick={() => setBasis('observed')}>{w.filter.basis.observed}</button>
        </div>
        {basis === 'observed' && (
          <div className="ml-auto inline-flex overflow-hidden rounded-md border border-border">
            <button type="button" aria-pressed={mode === 'list'} className={seg(mode === 'list')} onClick={() => setMode('list')}>{w.filter.mode.list}</button>
            <button type="button" aria-pressed={mode === 'map'} className={seg(mode === 'map')} onClick={() => setMode('map')}>{w.filter.mode.map}</button>
          </div>
        )}
      </div>
      {mapOn && <RegionMap selected={names} present={present} onToggle={toggle} />}
      {listOn && (<>
      <input
        type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder={w.filter.search} aria-label={w.filter.search}
        className="rounded-sm border border-border bg-panel px-2 py-1.5 text-white focus:border-blue-500 focus:outline-hidden"
      />
      <div className="flex flex-col gap-2">
        {shown.map(b => {
          const pickedB = b.groups.reduce((n, g) => n + pickedIn(g.options), 0)
          const openB = q !== '' || (groupOpen.get(`b:${b.label}`) ?? pickedB > 0)
          // 県が 1 つで地方と同じ名前（北海道）・県でない組（海域・遠方）は、2 段目を挟まずに地名を並べる
          const flat = b.groups.length === 1 && b.groups[0]!.label === b.label
          return (
            <div key={b.label}>
              {header(`b:${b.label}`, groupLabel(b.label), pickedB, openB, 'text-white')}
              {openB && (flat ? optionGrid(b.groups[0]!.options) : (
                <div className="flex flex-col gap-1 pl-4">
                  {b.groups.map(g => {
                    const picked = pickedIn(g.options)
                    const isOpen = q !== '' || (groupOpen.get(`p:${g.label}`) ?? picked > 0)
                    return (
                      <div key={g.label}>
                        {header(`p:${g.label}`, groupLabel(g.label), picked, isOpen, 'text-white')}
                        {isOpen && optionGrid(g.options)}
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>
          )
        })}
      </div>
      </>)}
    </div>
  )
}

/** 地図の全体の大きさ（viewBox の単位）と、拡大の上限（全体の幅の 1/12 まで寄れる）。 */
const MAP_W = 1000
const MAP_H = 900
const MAP_MIN_W = MAP_W / 12
/** 押したまま動かしたとみなす距離（画面の px）。これより動いたら区域を選ばない（拡大した地図を動かしただけ）。 */
const DRAG_PX = 4

interface MapView { x: number; y: number; w: number }

/** 表示範囲を全体の中に収める（幅は上限と全体の間、位置ははみ出さない）。 */
function clampView(v: MapView): MapView {
  const w = Math.min(MAP_W, Math.max(MAP_MIN_W, v.w))
  const h = w * (MAP_H / MAP_W)
  return { w, x: Math.min(MAP_W - w, Math.max(0, v.x)), y: Math.min(MAP_H - h, Math.max(0, v.y)) }
}

/** `factor` 倍に寄る（1 未満で拡大）。`cx`・`cy` は地図の座標で、そこを動かさずに寄る。 */
function zoomView(v: MapView, factor: number, cx: number, cy: number): MapView {
  const w = Math.min(MAP_W, Math.max(MAP_MIN_W, v.w * factor))
  const k = w / v.w
  return clampView({ w, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k })
}

/**
 * 細分区域を押して選ぶ地図。地図の区域データ（`useSubRegions`。メインの地図と同じ取得を使い回すので、通信は増えない）を
 * 緯度経度そのままの平面に描く。選んだ区域は色を付ける。押せるのは読み込んだ地震で震度を観測した区域だけで、
 * ほかは薄く描いて押せない（一覧が読んだ地震にある地域だけを並べるのと同じ）。
 *
 * **拡大できる**（2026-11-08 ユーザー発言「両方残すけど、地図拡大できないの？」・選択「ピンチ・ホイールで拡大 (Recommended)」
 * 「＋・−・全体 (Recommended)」）。ホイールとピンチで寄り、ドラッグで動かす。動かしたときは区域を選ばない。
 */
/**
 * 区域の形（SVG の path の文字列）の控え。約 14 万点の文字列を組むので、地図を開くたびに組み直さない。区域データ
 * （`useSubRegions` の data）は取得した 1 つを使い回すので、その参照が同じなら組んだものを返す。
 */
let regionPathCache: { data: unknown; paths: { name: string; d: string }[] } | null = null

function RegionMap({ selected, present, onToggle }: { selected: readonly string[]; present: ReadonlySet<string>; onToggle: (name: string) => void }) {
  const q = useMessages().quake
  const { data, failed } = useSubRegions()
  const paths = useMemo(() => {
    if (!data) return null
    if (regionPathCache?.data === data) return regionPathCache.paths
    // 西端 122°・東端 149°、南端 24°・北端 46°（本州・北海道・南西諸島が入る範囲）
    const W = 122, E = 149, S = 24, N = 46
    const sx = (lng: number) => ((lng - W) / (E - W)) * MAP_W
    const sy = (lat: number) => ((N - lat) / (N - S)) * MAP_H
    const built = data.map(r => ({
      name: r.name,
      // 間引かずに描く。区域ごとに別々に間引くと、隣り合う区域の境目が別々にずれ、拡大したときに隙間と段差が出る
      // （2026-11-08 ユーザー発言「きもすぎるんだけど。」。全国で約 14 万点・192 区域。組むのは地図を開いたときの 1 回だけ）
      d: r.rings.map(ring => ring.map(([lat, lng], i) => `${i === 0 ? 'M' : 'L'}${sx(lng).toFixed(2)},${sy(lat).toFixed(2)}`).join('') + 'Z').join(''),
    }))
    regionPathCache = { data, paths: built }
    return built
  }, [data])
  const [view, setView] = useState<MapView>({ x: 0, y: 0, w: MAP_W })
  // ホイールの受け口（購読は 1 回）から今の寄り具合を読むための控え
  const viewRef = useRef(view)
  viewRef.current = view
  const svgRef = useRef<SVGSVGElement | null>(null)
  // 寄り具合の変更は 1 フレームに 1 回へまとめる（ホイール・指の動きは 1 フレームに何度も来る。そのたびに描き直すと、
  // 約 14 万点の塗りを何度もやり直す）。来た変更を順に貯め、次のフレームでまとめて当てる
  const pendingView = useRef<((v: MapView) => MapView)[]>([])
  const viewFrame = useRef<number | null>(null)
  const updateView = (fn: (v: MapView) => MapView) => {
    pendingView.current.push(fn)
    if (viewFrame.current !== null) return
    viewFrame.current = requestAnimationFrame(() => {
      viewFrame.current = null
      const fns = pendingView.current
      pendingView.current = []
      setView(v => fns.reduce((acc, f) => f(acc), v))
    })
  }
  useEffect(() => () => { if (viewFrame.current !== null) cancelAnimationFrame(viewFrame.current) }, [])
  // 押している指・マウス（pointerId → 画面座標）。2 本ならピンチ、1 本ならドラッグ
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const moved = useRef(false)
  const startAt = useRef<{ x: number; y: number } | null>(null)
  /** 画面座標を地図の座標へ。 */
  const toMap = (clientX: number, clientY: number, v: MapView) => {
    const r = svgRef.current?.getBoundingClientRect()
    if (!r || r.width === 0) return { x: v.x + v.w / 2, y: v.y + (v.w * MAP_H / MAP_W) / 2 }
    return { x: v.x + ((clientX - r.left) / r.width) * v.w, y: v.y + ((clientY - r.top) / r.height) * (v.w * MAP_H / MAP_W) }
  }
  // ホイールは既定の巻き取り（窓の中身が巻かれる）を止めるため、passive: false で受ける。**寄れないとき（全体で縮小・
  // 上限で拡大）は止めない** —— 地図は窓の幅いっぱいで大きいので、止め続けると地図の上で窓の中身を巻けなくなる
  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      const out = e.deltaY > 0
      const v0 = viewRef.current
      if (out ? v0.w >= MAP_W : v0.w <= MAP_MIN_W) return
      e.preventDefault()
      updateView(v => {
        const p = toMap(e.clientX, e.clientY, v)
        return zoomView(v, e.deltaY > 0 ? 1.2 : 1 / 1.2, p.x, p.y)
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [paths])
  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 1) { moved.current = false; startAt.current = { x: e.clientX, y: e.clientY } }
  }
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const prev = pointers.current.get(e.pointerId)
    if (!prev) return
    const start = startAt.current
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > DRAG_PX && !moved.current) {
      moved.current = true
      // 動かし始めたら指を捕まえる（区域の上で押し始めても、外へ出ても動かし続けられる）
      svgRef.current?.setPointerCapture(e.pointerId)
    }
    const others = [...pointers.current.entries()].filter(([id]) => id !== e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (!moved.current) return
    const r = svgRef.current?.getBoundingClientRect()
    if (!r || r.width === 0) return
    if (others.length === 0) {
      // ドラッグ: 指の動きぶん地図を逆へずらす
      const dx = e.clientX - prev.x, dy = e.clientY - prev.y
      updateView(v => clampView({ ...v, x: v.x - (dx / r.width) * v.w, y: v.y - (dy / r.width) * v.w }))
    } else {
      // ピンチ: 2 本の指の間の距離の比で寄る（中点を動かさない）
      const [, o] = others[0]
      const before = Math.hypot(prev.x - o.x, prev.y - o.y)
      const after = Math.hypot(e.clientX - o.x, e.clientY - o.y)
      if (before < 1 || after < 1) return
      const mx = (e.clientX + o.x) / 2, my = (e.clientY + o.y) / 2
      updateView(v => {
        const mid = toMap(mx, my, v)
        return zoomView(v, before / after, mid.x, mid.y)
      })
    }
  }
  const onPointerEnd = (e: ReactPointerEvent<SVGSVGElement>) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size === 0) startAt.current = null
  }
  // 押したときの関数は親の描き直しのたびに作り直されるので、控えから呼ぶ（区域の絵を選択が変わったときだけ組み直すため）
  const onToggleRef = useRef(onToggle)
  onToggleRef.current = onToggle
  const regionPaths = useMemo(() => paths?.map(p => (
    <path
      key={p.name} d={p.d} onClick={present.has(p.name) ? () => onToggleRef.current(p.name) : undefined}
      className={present.has(p.name) ? 'cursor-pointer' : undefined}
      fill={selected.includes(p.name) ? 'rgba(59,130,246,.75)' : present.has(p.name) ? 'rgba(148,163,184,.45)' : 'rgba(148,163,184,.08)'}
      stroke="rgba(15,23,42,.9)" strokeWidth={0.8} vectorEffect="non-scaling-stroke"
    >
      <title>{p.name}</title>
    </path>
  )), [paths, present, selected])
  const zoomBy = (factor: number) => setView(v => zoomView(v, factor, v.x + v.w / 2, v.y + (v.w * MAP_H / MAP_W) / 2))
  const whole = view.w >= MAP_W
  // 読み込み中・失敗は地図の代わりに 1 行出す（2026-11-08 ユーザー選択「両方出す (Recommended)」）。選ぶのは下の一覧でもできる
  if (failed) return <p className="text-xs text-secondary">{q.filter.mapFailed}</p>
  if (!paths) return <p className="text-xs text-secondary">{q.filter.mapLoading}</p>
  // 限界で disabled にすると、押した直後にフォーカスが落ちる。押せない印（aria-disabled）にして、押しても何もしない
  const mapBtn = 'flex h-6 min-w-6 items-center justify-center rounded-sm border border-border bg-panel/90 px-1 text-white hover:bg-white/10 aria-disabled:opacity-40 aria-disabled:hover:bg-panel/90'
  const atMax = view.w <= MAP_MIN_W
  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`${view.x} ${view.y} ${view.w} ${view.w * MAP_H / MAP_W}`}
        className="w-full touch-none select-none rounded-sm border border-border bg-black/30"
        role="group" aria-label={q.filter.mapLabel}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}
        // 動かしたあとの click は区域の選択にしない（捕まえていると click は地図そのものに出るが、念のため手前で止める）
        onClickCapture={e => { if (moved.current) { e.stopPropagation(); moved.current = false } }}
      >
        {regionPaths}
      </svg>
      <div className="absolute top-1.5 right-1.5 flex flex-col gap-1">
        <button type="button" aria-label={q.filter.zoomIn} className={mapBtn} aria-disabled={atMax} onClick={() => { if (!atMax) zoomBy(1 / 1.5) }}>＋</button>
        <button type="button" aria-label={q.filter.zoomOut} className={mapBtn} aria-disabled={whole} onClick={() => { if (!whole) zoomBy(1.5) }}>−</button>
        <button type="button" aria-label={q.filter.fitLabel} className={mapBtn} aria-disabled={whole} onClick={() => { if (!whole) setView({ x: 0, y: 0, w: MAP_W }) }}>{q.filter.fit}</button>
      </div>
    </div>
  )
}
