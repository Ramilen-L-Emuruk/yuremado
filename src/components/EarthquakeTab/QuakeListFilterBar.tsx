import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ARCHIVE_START_DAY } from '../../services/dmdataReplay'
import { createPortal } from 'react-dom'
import type { IssueType, JMAQuake } from '../../types/earthquake'
import { PREFECTURES } from '../../data/prefectureCodes'
import { RangeSlider } from '../RangeSlider'
import { DateField } from '../DateField'
import { useSubRegions } from '../../hooks/useSubRegions'
import { serverNow } from '../../utils/clock'
import { areaPrefIndexOf, getStationCoordsCache, onStationCoordsLoaded, regionOrderIndexOf, regionOrderRank, type StationCoordsData } from '../../utils/stationCoords'
import {
  DEFAULT_QUAKE_LIST_FILTER, QUAKE_DEPTH_RANGE, QUAKE_LIST_TYPES, QUAKE_MAGNITUDE_RANGE, QUAKE_PERIOD_HOURS, QUAKE_SCALE_STEPS,
  isQuakeListFiltered, quakeFilterChipLabels, quakeRegionGroups,
  type QuakeListFilter, type QuakeRange, type QuakeRegionBasis,
} from '../../utils/quakeListView'

/**
 * 地震タブの一覧の上に並ぶ絞り込みの帯（2026-11-07 ユーザー選択。決まったことは docs/spec/quake-spec.md「地震タブの絞り込みと並び替え」）。
 * 札を押すとその条件の窓が開く。何か絞っているときだけ末尾に「すべて解除」。
 */
export type FilterKind = 'scale' | 'magnitude' | 'depth' | 'region' | 'types' | 'period'

/** 窓の見出し（札と同じ語。2026-11-07 選択「見出しを札と同じ語にする」）。 */
const TITLES: Record<FilterKind, string> = {
  scale: '震度', magnitude: '規模', depth: '深さ', region: '地域', types: '種類', period: '期間',
}

const BUTTON_CLASS = 'rounded-md border border-border bg-panel px-3 py-1.5 text-xs text-white whitespace-nowrap transition-colors motion-reduce:transition-none hover:bg-white/10'
/** 震源カタログタブの日付の欄と同じ見た目（`CatalogTab` の `DATE_INPUT_CLASS`）。 */
const DATE_INPUT_CLASS = 'bg-panel border border-border text-white rounded-sm px-2 py-1.5 focus:outline-hidden focus:border-blue-500 scheme-dark'
/** 期間の日付で選べる最も古い日（地震情報のアーカイブの始まり）。 */
const PERIOD_MIN_DAY = ARCHIVE_START_DAY

function localYmd(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

interface BarProps {
  filter: QuakeListFilter
  onChange: (next: QuakeListFilter) => void
  /**
   * 開いている窓。**持ち主は地震タブ**で、窓（`QuakeListFilterDialog`）も帯とは別に地震タブが描く。
   * 帯は一覧が空の画面と並んだ画面で置き場所が替わって作り直されるので、窓を帯の中に置くと、
   * 0 件との行き来で窓が閉じる・つまみのドラッグが途切れる・探している地名が消える。
   */
  open: FilterKind | null
  setOpen: (kind: FilterKind | null) => void
}

export function QuakeListFilterBar({ filter, onChange, open, setOpen }: BarProps) {
  const labels = quakeFilterChipLabels(filter)
  const active: Record<FilterKind, boolean> = {
    scale: filter.scale.min !== null || filter.scale.max !== null,
    magnitude: filter.magnitude.min !== null || filter.magnitude.max !== null,
    depth: filter.depth.min !== null || filter.depth.max !== null,
    region: filter.region.names.length > 0,
    types: filter.types.length > 0,
    period: filter.period !== null,
  }
  const kinds: FilterKind[] = ['scale', 'magnitude', 'depth', 'region', 'types', 'period']
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-[var(--qk-pad)] py-2" style={{ fontSize: 'var(--qk-f)' }}>
      {kinds.map(kind => (
        <button
          key={kind}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open === kind}
          data-filter-kind={kind}
          onClick={() => setOpen(kind)}
          className={`rounded-md border px-2 py-0.5 whitespace-nowrap transition-colors motion-reduce:transition-none ${active[kind] ? 'border-blue-500 bg-blue-500/20 text-white' : 'border-border text-secondary hover:bg-white/10'}`}
        >
          {labels[kind]}
        </button>
      ))}
      {isQuakeListFiltered(filter) && (
        <button type="button" onClick={() => onChange(DEFAULT_QUAKE_LIST_FILTER)} className="ml-auto whitespace-nowrap px-1 text-secondary underline-offset-2 hover:underline">
          すべて解除
        </button>
      )}
    </div>
  )
}

interface DialogProps extends BarProps {
  /** 地域の一覧と件数を作る元（絞る前の、読み込んだ地震すべて）。 */
  quakes: readonly JMAQuake[]
}

/**
 * 条件を選ぶ窓。**地震タブの、一覧の画面の枝より外の決まった位置に描く**（読み込み中・空・一覧のどの画面でも
 * 同じ位置にあるので、画面が替わっても作り直されない。body へ描くので見た目の位置は変わらない）。
 */
export function QuakeListFilterDialog({ filter, onChange, quakes, open, setOpen }: DialogProps) {
  if (open === null) return null
  const labels = quakeFilterChipLabels(filter)
  return (
        <FilterDialog kind={open} title={TITLES[open]} onClose={() => setOpen(null)} onClear={() => onChange(clearKind(filter, open))}>
          {open === 'scale' && <ScaleRange value={filter.scale} text={labels.scale} onChange={scale => onChange({ ...filter, scale })} />}
          {open === 'magnitude' && (
            <NumberRange
              range={QUAKE_MAGNITUDE_RANGE} value={filter.magnitude} label="規模" text={labels.magnitude}
              onChange={magnitude => onChange({ ...filter, magnitude })}
            />
          )}
          {open === 'depth' && (
            <NumberRange
              range={QUAKE_DEPTH_RANGE} value={filter.depth} label="深さ" text={labels.depth}
              onChange={depth => onChange({ ...filter, depth })}
            />
          )}
          {open === 'region' && <RegionPicker filter={filter} quakes={quakes} onChange={onChange} />}
          {open === 'types' && <TypePicker value={filter.types} onChange={types => onChange({ ...filter, types })} />}
          {open === 'period' && <PeriodPicker filter={filter} nowMs={serverNow()} onChange={onChange} />}
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
 * Esc は先に受けて伝わりを止める。閉じたらフォーカスを開いた札へ戻す（ブラウザが押した要素を覚えているので、閉じる側で戻す）。
 * 選んだものはその場で一覧へ効かせる（2026-11-07 選択「地域で絞る／地名で探す／海域／選択を解除 (Recommended)」の説明「決定のボタンは置かない」）。
 */
function FilterDialog({ kind, title, onClose, onClear, children }: { kind: FilterKind; title: string; onClose: () => void; onClear: () => void; children: ReactNode }) {
  const closeRef = useRef<HTMLButtonElement | null>(null)
  // **開いたときに 1 回だけ**フォーカスを移し、閉じたときに戻す。`onClose` は描くたびに新しい関数になるので、
  // 依存に置くと値を変えるたびにフォーカスが札と［閉じる］を往復し、スライダーの矢印キーが 2 回目から届かない
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
      // 開いている間に一覧が空の画面と行き来すると帯が作り直され、開いた札は DOM から外れている。そのときは同じ条件の札へ戻す
      const back = opener instanceof HTMLElement && opener.isConnected
        ? opener
        : document.querySelector<HTMLElement>(`[data-filter-kind="${kind}"]`)
      back?.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 開いたときの 1 回だけ（kind が替わるのは閉じて開き直したとき）
  }, [])
  // 暗幕で押し始めて暗幕で離したときだけ閉じる（つまみを窓の外まで引いて離しても、暗幕から窓へ引いて離しても閉じない。
  // 窓の中で離すと click は共通の祖先の暗幕に出るので、離した先は pointerup で見る）
  const downOnBackdrop = useRef(false)
  const upOnBackdrop = useRef(false)
  return createPortal(
    <div
      className="fixed inset-0 z-100000 flex items-center justify-center bg-black/60 p-2 sm:p-6 [--text-sm:0.90625rem] [--text-xs:0.71875rem] min-[520px]:[--text-sm:1rem] min-[520px]:[--text-xs:0.78125rem]"
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
        <div className="mb-3 text-sm text-white">{title}</div>
        <div className="min-h-0 overflow-y-auto text-xs text-secondary">{children}</div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className={BUTTON_CLASS} onClick={onClear}>選択を解除</button>
          <button ref={closeRef} type="button" className={BUTTON_CLASS} onClick={onClose}>閉じる</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** 震度の範囲。カタログと同じ二つまみのスライダーで、階級ごとに止まる。端に置くとその側の制限を外す。 */
function ScaleRange({ value, text, onChange }: { value: QuakeRange; text: string; onChange: (r: QuakeRange) => void }) {
  const last = QUAKE_SCALE_STEPS.length - 1
  const indexOf = (v: number | null, fallback: number) => {
    if (v === null) return fallback
    const i = QUAKE_SCALE_STEPS.findIndex(s => s === v)
    return i >= 0 ? i : fallback
  }
  const from = indexOf(value.min, 0)
  const to = indexOf(value.max, last)
  // 値の文は帯の札と同じ形（2026-11-07 選択「地震タブは短い形、カタログは総ざらいで (Recommended)」）。絞っていないときは出さない
  const unset = value.min === null && value.max === null
  return (
    <div>
      <p className="mb-1 min-h-[1.25em] text-right tabular-nums">{unset ? '' : text}</p>
      <RangeSlider
        label="震度" min={0} max={last} step={1} from={from} to={to}
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
  const round = (v: number) => Math.round(v / range.step) * range.step
  return (
    <div>
      <p className="mb-1 min-h-[1.25em] text-right tabular-nums">{value.min === null && value.max === null ? '' : text}</p>
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

function TypePicker({ value, onChange }: { value: readonly IssueType[]; onChange: (t: IssueType[]) => void }) {
  const toggle = (t: IssueType) => onChange(value.includes(t) ? value.filter(x => x !== t) : [...value, t])
  return (
    <div className="flex flex-col gap-1.5">
      {QUAKE_LIST_TYPES.map(t => (
        <label key={t} className="flex cursor-pointer items-center gap-1.5">
          <input type="checkbox" checked={value.includes(t)} onChange={() => toggle(t)} />
          {t}
        </label>
      ))}
    </div>
  )
}

function PeriodPicker({ filter, nowMs, onChange }: { filter: QuakeListFilter; nowMs: number; onChange: (f: QuakeListFilter) => void }) {
  const today = localYmd(nowMs)
  const p = filter.period
  // 「日付を指定」を押した時点で範囲を入れるので、選んでいるかは値から導く（解除したら戻る）
  const custom = p?.kind === 'range'
  const from = p?.kind === 'range' ? p.from : today
  const to = p?.kind === 'range' ? p.to : today
  const setRange = (a: string, b: string) => onChange({ ...filter, period: { kind: 'range', from: a, to: b } })
  // 逆転したら、打った欄はそのままにして反対の欄を同じ日へ寄せる（2026-11-07 ユーザー選択「もう片方を同じ日に寄せる (Recommended)」）
  const setFrom = (v: string) => setRange(v, v > to ? v : to)
  const setTo = (v: string) => setRange(v < from ? v : from, v)
  const chip = (on: boolean) => `rounded-md border px-2 py-0.5 ${on ? 'border-blue-500 bg-blue-500/20 text-white' : 'border-border hover:bg-white/10'}`
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {QUAKE_PERIOD_HOURS.map(o => (
          <button key={o.hours} type="button" aria-pressed={p?.kind === 'hours' && p.hours === o.hours} className={chip(p?.kind === 'hours' && p.hours === o.hours)}
            onClick={() => onChange({ ...filter, period: { kind: 'hours', hours: o.hours } })}>
            {o.label}
          </button>
        ))}
        <button type="button" aria-pressed={custom} className={chip(custom)} onClick={() => setRange(from, to)}>日付を指定</button>
      </div>
      {custom && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <DateField label="期間の開始日" value={from} min={PERIOD_MIN_DAY} max={today} onCommit={setFrom} className={DATE_INPUT_CLASS} />
          <span>〜</span>
          <DateField label="期間の終了日" value={to} min={PERIOD_MIN_DAY} max={today} onCommit={setTo} className={DATE_INPUT_CLASS} />
        </div>
      )}
    </div>
  )
}

/**
 * 地域の窓。基準（震央地名／震度を観測した地域）を切り替え、読み込んだ地震に出てくる地域を県ごとに件数つきで並べる
 * （2026-11-07 選択「読んだ地震にある地域＋件数 (Recommended)」）。
 *
 * **試作の切り替え（一覧／地図）を置いている**（2026-11-07 選択「一覧／地図 (Recommended)」。選び方は原文「ちょっと実際のUX次第で決めさせて」）。
 * どちらかに決まったら、選ばれなかった方を消す。地図は細分区域の形なので、名前が細分区域と一致する
 * 「震度を観測した地域」のときだけ出す（震央地名は「石川県能登地方」「石川県西方沖」のように細分区域の名前と合わない）。
 */
function RegionPicker({ filter, quakes, onChange }: { filter: QuakeListFilter; quakes: readonly JMAQuake[]; onChange: (f: QuakeListFilter) => void }) {
  const [mode, setMode] = useState<'list' | 'map'>('list')
  const [query, setQuery] = useState('')
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
  const toggle = (name: string) => onChange({
    ...filter, region: { basis, names: names.includes(name) ? names.filter(n => n !== name) : [...names, name] },
  })
  // 基準を変えたら選んだ名前は空にする（震央地名と細分区域は別の名前の集まり）
  const setBasis = (b: QuakeRegionBasis) => { if (b !== basis) onChange({ ...filter, region: { basis: b, names: [] } }) }
  const seg = (on: boolean) => `px-2 py-0.5 ${on ? 'bg-blue-500/30 text-white' : 'hover:bg-white/10'}`
  const q = query.trim()
  const mapOn = basis === 'observed' && mode === 'map'
  const present = useMemo(() => new Set(groups.flatMap(g => g.options.map(o => o.name))), [groups])
  const shown = groups
    .map(g => ({ ...g, options: q === '' ? g.options : g.options.filter(o => o.name.includes(q) || g.label.includes(q)) }))
    .filter(g => g.options.length > 0)
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex overflow-hidden rounded-md border border-border">
          <button type="button" aria-pressed={basis === 'epicenter'} className={seg(basis === 'epicenter')} onClick={() => setBasis('epicenter')}>震央地名</button>
          <button type="button" aria-pressed={basis === 'observed'} className={seg(basis === 'observed')} onClick={() => setBasis('observed')}>震度を観測した地域</button>
        </div>
        {basis === 'observed' && (
          <div className="ml-auto inline-flex overflow-hidden rounded-md border border-border">
            <button type="button" aria-pressed={mode === 'list'} className={seg(mode === 'list')} onClick={() => setMode('list')}>一覧</button>
            <button type="button" aria-pressed={mode === 'map'} className={seg(mode === 'map')} onClick={() => setMode('map')}>地図</button>
          </div>
        )}
      </div>
      {mapOn && <RegionMap selected={names} present={present} onToggle={toggle} />}
      <input
        type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="地名で探す" aria-label="地名で探す"
        className="rounded-sm border border-border bg-panel px-2 py-1.5 text-white focus:border-blue-500 focus:outline-hidden"
      />
      <div className="flex flex-col gap-2">
        {shown.map(g => (
          <div key={g.label}>
            <div className="mb-1 text-white">{g.label}</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              {g.options.map(o => (
                <label key={o.name} className="flex cursor-pointer items-center gap-1.5">
                  <input type="checkbox" checked={names.includes(o.name)} onChange={() => toggle(o.name)} />
                  <span className="min-w-0 flex-1 truncate">{o.name}</span>
                  <span className="tabular-nums">{o.count}</span>
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * 細分区域を押して選ぶ地図（試作）。地図の区域データ（`useSubRegions`。メインの地図と同じ取得を使い回すので、通信は増えない）を
 * 緯度経度そのままの平面に描く。選んだ区域は色を付ける。押せるのは読み込んだ地震で震度を観測した区域だけで、
 * ほかは薄く描いて押せない（一覧が読んだ地震にある地域だけを並べるのと同じ）。
 */
function RegionMap({ selected, present, onToggle }: { selected: readonly string[]; present: ReadonlySet<string>; onToggle: (name: string) => void }) {
  const { data, failed } = useSubRegions()
  const paths = useMemo(() => {
    if (!data) return null
    // 西端 122°・東端 149°、南端 24°・北端 46°（本州・北海道・南西諸島が入る範囲）
    const W = 122, E = 149, S = 24, N = 46
    const sx = (lng: number) => ((lng - W) / (E - W)) * 1000
    const sy = (lat: number) => ((N - lat) / (N - S)) * 900
    return data.map(r => ({
      name: r.name,
      d: r.rings.map(ring => {
        // 点が多いので間引いて描く（選ぶための目安の形で足りる）
        const step = Math.max(1, Math.floor(ring.length / 60))
        const pts = ring.filter((_, i) => i % step === 0)
        return pts.map(([lat, lng], i) => `${i === 0 ? 'M' : 'L'}${sx(lng).toFixed(1)},${sy(lat).toFixed(1)}`).join('') + 'Z'
      }).join(''),
    }))
  }, [data])
  // 読み込み中・失敗は地図を出さない（一覧で選べる。試作なので文言は足さない）
  if (failed || !paths) return null
  return (
    <svg viewBox="0 0 1000 900" className="w-full rounded-sm border border-border bg-black/30" role="group" aria-label="地図">
      {paths.map(p => (
        <path
          key={p.name} d={p.d} onClick={present.has(p.name) ? () => onToggle(p.name) : undefined}
          className={present.has(p.name) ? 'cursor-pointer stroke-[0.8]' : 'stroke-[0.8]'}
          fill={selected.includes(p.name) ? 'rgba(59,130,246,.75)' : present.has(p.name) ? 'rgba(148,163,184,.45)' : 'rgba(148,163,184,.08)'}
          stroke="rgba(15,23,42,.9)"
        >
          <title>{p.name}</title>
        </path>
      ))}
    </svg>
  )
}
