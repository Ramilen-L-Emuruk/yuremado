import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { OVERLAY_BACKDROP_PAD } from '../../rootFrame'
import { useLocale, useMessages } from '../../i18n/I18nProvider'
import type { Locale } from '../../i18n/messages'
import type { QuakeAnalysisView } from '../../hooks/useQuakeAnalysis'
import {
  ANALYSIS_SOURCES, analysisCheckedAt, analysisIsEmpty, faultTypeOf, groupSolutionVersions, latestVersion, representativeSolution,
  type AnalysisSource, type NodalPlane, type PagerEstimate, type QuakeAnalysis, type SourceState,
} from '../../services/relayAnalysis'
import { MMI_ROMAN, mmiColor, mmiIndex } from '../../services/analysisOverlay'
import { formatDateTime, formatDateTimeMin } from '../../utils/formatters'
import { CANCEL_FADE_MS, fadeIn } from './quakeMotion'
import { AgencyPanel, MechTable, sourceName, Term } from './QuakeAnalysisAgency'

/**
 * 地震カードに添える海外の機関と気象庁の解析（計画書 項目 98）。カードには要約の 1 行だけを置き、
 * ［詳しく ›］で画面の中央に窓を開く（2026-11-11 発言「そういう詳しいのはポップアップするのがいいかもね。」）。
 * 機関ごとのタブ＋種類ごとの切り替えは 2026-11-15 に決め、機関ごとのタブの中身（代表の解・震源・発震機構の表・説明の吹き出し）は
 * 2026-11-17 に作り直した（`QuakeAnalysisAgency.tsx`）
 */

type AnalysisWords = ReturnType<typeof useMessages>['quake']['analysis']

const ALERT_COLOR: Record<string, string> = { green: '#2e9d4a', yellow: '#e8c51c', orange: '#ef8a1f', red: '#d93a3a' }
const STATUS_COLOR: Record<SourceState['status'], string> = { matched: '#4fb26b', none: '#7d8894', pending: '#5b9bd5', error: '#d95c5c' }
const r0 = (v: number) => Math.round(v)

/** 窓の並べ方（機関ごと・種類ごと）を端末に覚える鍵 */
const GROUP_BY_KEY = 'quake-analysis-group-by'
type GroupBy = 'agency' | 'kind'
function readGroupBy(): GroupBy {
  try {
    return localStorage.getItem(GROUP_BY_KEY) === 'kind' ? 'kind' : 'agency'
  } catch {
    return 'agency'
  }
}
function writeGroupBy(v: GroupBy): void {
  try {
    localStorage.setItem(GROUP_BY_KEY, v)
  } catch {
    // 覚えられなくても、この窓の間は選んだ並べ方で出す
  }
}

const alertText = (w: AnalysisWords, a: string) => (w.alert as Record<string, string>)[a] ?? a
const faultText = (w: AnalysisWords, p: NodalPlane) => w.fault[faultTypeOf(p)]
const timeMin = (iso: string | null) => (iso ? formatDateTimeMin(iso) : null) ?? '—'
/** 取得元の地震の発生時刻（0.1 秒まで） */
function timeTenth(iso: string): string {
  const base = formatDateTime(iso)
  if (base === null) return '—'
  return `${base}.${Math.floor(new Date(iso).getMilliseconds() / 100)}`
}

/** 人数・金額の短い書き方。日本語は万・億、他は Intl の短縮形 */
function countFormats(locale: Locale) {
  if (locale === 'ja') {
    return {
      people: (n: number) => (n >= 10_000 ? `${(n / 10_000).toLocaleString('ja', { maximumFractionDigits: 1 })} 万人` : `${n.toLocaleString('ja')} 人`),
      usdMillions: (m: number) => (m >= 100 ? `${(m / 100).toLocaleString('ja')}億` : `${m.toLocaleString('ja')}百万`),
      deaths: (n: number) => (n >= 10_000 ? `${n / 10_000}万` : n.toLocaleString('ja')),
      num: (n: number) => n.toLocaleString('ja'),
    }
  }
  const compact = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 })
  return {
    people: (n: number) => compact.format(n),
    usdMillions: (m: number) => compact.format(m * 1_000_000),
    deaths: (n: number) => compact.format(n),
    num: (n: number) => n.toLocaleString(locale),
  }
}

/** 要約の行の文（代表の解の Mw と断層の型・被害の見込み・解の数）。解が無ければ取得元ごとの規模 */
export function analysisSummaryText(w: AnalysisWords, a: QuakeAnalysis): string {
  const rep = representativeSolution(a)
  const parts: string[] = []
  if (rep) {
    parts.push(`Mw ${rep.mw?.toFixed(1) ?? '—'}${rep.planes ? ` ${faultText(w, rep.planes[0])}` : ''}`)
  } else {
    const mags = ANALYSIS_SOURCES.flatMap(s => {
      const e = a.sources[s].event
      return e?.mag != null ? [`${sourceName(w, s)} ${e.magType ?? 'M'} ${e.mag}`] : []
    })
    if (mags.length) parts.push(mags.join('・'))
  }
  const pager = latestVersion(a.usgs.pager)
  if (pager?.alert) parts.push(`${w.damage} ${alertText(w, pager.alert)}`)
  const n = groupSolutionVersions(a.solutions).length
  if (n > 0) parts.push(w.solutions(n))
  return parts.length ? parts.join('・') : w.status.none
}

/** カードの要約の行。中継が確かめられない地震（404）・問い合わせない地震には出さない */
export function QuakeAnalysisSummary({ view, title }: { view: QuakeAnalysisView; title: string }) {
  const w = useMessages().quake.analysis
  const [open, setOpen] = useState(false)
  if (view.state === 'none' || view.state === 'unverifiable') return null
  const answer = view.state === 'ready' ? view.analysis : null
  const empty = answer !== null && analysisIsEmpty(answer)
  // 何も結べていないときは、取得元の状態で「なし」と「取れていない」を分ける（取れていないのを「なし」と言わない）。
  // 取得元のどれかが失敗・確認中なら、窓で取得元ごとの状態を見られるよう［詳しく ›］も出す
  const statuses = answer ? ANALYSIS_SOURCES.map(s => answer.sources[s].status) : []
  const emptyText = statuses.includes('error') ? w.status.error : statuses.includes('pending') ? w.status.pending : w.status.none
  const openable = answer !== null && (!empty || emptyText !== w.status.none)
  const text = view.state === 'loading' ? w.loading
    : view.state === 'failed' ? w.status.error
    : answer && !empty ? analysisSummaryText(w, answer)
    : emptyText
  const pagerAlert = answer && !empty ? latestVersion(answer.usgs.pager)?.alert ?? null : null
  return (
    <>
      <div className="mt-1.5 flex w-full items-center justify-between gap-2 rounded-lg border border-border bg-panel px-3 py-1.5 text-xs roomy:text-sm">
        <span className="line-clamp-2 min-w-0 text-white">
          {w.label}
          <span className="ml-2 text-secondary">{text}</span>
          {pagerAlert && ALERT_COLOR[pagerAlert] && <i className="ml-1.5 inline-block h-2 w-2 rounded-full align-middle" style={{ backgroundColor: ALERT_COLOR[pagerAlert] }} />}
        </span>
        {openable && (
          <button type="button" onClick={(e) => { e.stopPropagation(); setOpen(true) }} className="shrink-0 text-secondary hover:text-white">{w.more}</button>
        )}
      </div>
      {open && openable && answer && <QuakeAnalysisDialog title={title} analysis={answer} onClose={() => setOpen(false)} />}
    </>
  )
}


function PagerBar({ label, e, fmt }: { label: string; e: PagerEstimate; fmt: (n: number) => string }) {
  const w = useMessages().quake.analysis
  const width = (p: number) => `${Math.max(p * 100, 0.6)}%`
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-2">
        <span className="text-secondary">{label}</span>
        {ALERT_COLOR[e.level] && <span className="rounded px-1.5 text-[11px] font-bold text-black" style={{ backgroundColor: ALERT_COLOR[e.level] }}>{alertText(w, e.level)}</span>}
      </div>
      <div className="flex h-5 w-full overflow-hidden rounded-sm">
        {e.bins.map(b => (
          <div key={b.min} className="flex items-center justify-center text-[10px] font-bold text-black"
            style={{ width: width(b.probability), backgroundColor: ALERT_COLOR[b.color] ?? '#7d8894' }}
            title={`${fmt(b.min)}–${fmt(b.max)}: ${r0(b.probability * 100)}%`}>
            {b.probability >= 0.08 ? `${r0(b.probability * 100)}%` : ''}
          </div>
        ))}
      </div>
      <div className="flex w-full text-[10px] text-secondary">
        {e.bins.map(b => (
          <div key={b.min} className="truncate text-center" style={{ width: width(b.probability) }}>{b.probability >= 0.08 ? `${fmt(b.min)}–${fmt(b.max)}` : ''}</div>
        ))}
      </div>
    </div>
  )
}

function MmiBadge({ v }: { v: number }) {
  return <span className="inline-flex items-center rounded px-1.5 font-bold text-black" style={{ backgroundColor: mmiColor(v) }}>MMI {MMI_ROMAN[mmiIndex(v)]} ({v.toFixed(1)})</span>
}

function Section({ title, tip, at, older, children }: { title: string; tip: { text: string; src: string } | null; at: string; older: number; children: ReactNode }) {
  const w = useMessages().quake.analysis
  return (
    <section className="flex min-w-0 flex-col gap-1.5 rounded-md border border-border bg-[#141a21] p-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <h5 className="m-0 font-semibold text-white">{tip ? <Term label={title} tip={tip} /> : title}</h5>
        <span className="text-secondary">{timeMin(at)} {w.published}{older > 0 ? `・${w.older(older)}` : ''}</span>
      </div>
      {children}
    </section>
  )
}

function UsgsProducts({ a }: { a: QuakeAnalysis }) {
  const w = useMessages().quake.analysis
  const c = countFormats(useLocale())
  const u = a.usgs
  const p = latestVersion(u.pager), s = latestVersion(u.shakemap), f = latestVersion(u.finiteFault), g = latestVersion(u.groundFailure), d = latestVersion(u.dyfi)
  const pending = (content: string) => <div className="text-secondary">{content === 'failed' ? w.status.error : w.status.pending}</div>
  return (
    <div className="grid gap-1.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(22rem, 100%), 1fr))' }}>
      {p && (
        <Section title={w.pager} tip={w.tips.pager} at={p.publishedAt} older={u.pager.length - 1}>
          {p.fatality ? <PagerBar label={w.deaths} e={p.fatality} fmt={c.deaths} /> : pending(p.content)}
          {p.economic && <PagerBar label={w.economic} e={p.economic} fmt={c.usdMillions} />}
        </Section>
      )}
      {s && (
        <Section title={w.shakemap} tip={w.tips.shakemap} at={s.publishedAt} older={u.shakemap.length - 1}>
          <div className="flex flex-wrap items-center gap-2">
            {s.maxMmi != null && <><span className="text-secondary">{w.max}</span><MmiBadge v={s.maxMmi} /></>}
            <span className="text-[#cfd6dd]">
              {[s.maxPga != null ? `${w.accel} ${s.maxPga} g` : '', s.maxPgv != null ? `${w.velocity} ${s.maxPgv.toFixed(0)} cm/s` : ''].filter(Boolean).join('・')}
            </span>
          </div>
        </Section>
      )}
      {f && (
        <Section title={w.finiteFault} tip={w.tips.ffm} at={f.publishedAt} older={u.finiteFault.length - 1}>
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[#cfd6dd]">
            {([
              ['Mw', f.mw != null ? f.mw.toFixed(1) : null],
              [w.maxSlip, f.maxSlipM != null ? `${f.maxSlipM.toFixed(1)} m` : null],
              [w.length, f.lengthKm != null ? `${f.lengthKm} km` : null],
              [w.width, f.widthKm != null ? `${f.widthKm} km` : null],
              [w.sdr, f.strike != null && f.dip != null && f.rake != null ? `${f.strike}°/${f.dip}°/${f.rake}°` : null],
            ] as const).flatMap(([k, v]) => (v === null ? [] : [
              <span key={k} className="whitespace-nowrap"><span className="text-secondary">{k}</span> <b className="text-white">{v}</b></span>,
            ]))}
          </div>
        </Section>
      )}
      {g && (
        <Section title={w.groundFailure} tip={null} at={g.publishedAt} older={u.groundFailure.length - 1}>
          <div className="flex flex-wrap gap-2">
            {([[w.landslide, g.landslideAlert, g.landslidePopulation], [w.liquefaction, g.liquefactionAlert, g.liquefactionPopulation]] as const).map(([name, al, pop]) => (
              <span key={name} className="inline-flex items-center gap-1.5">
                <span className="text-secondary">{name}</span>
                {al && ALERT_COLOR[al] && <span className="rounded px-1.5 text-[11px] font-bold text-black" style={{ backgroundColor: ALERT_COLOR[al] }}>{alertText(w, al)}</span>}
                {pop != null && <span className="text-[#cfd6dd]">{w.exposed} {c.people(pop)}</span>}
              </span>
            ))}
          </div>
        </Section>
      )}
      {d && (
        <Section title={w.dyfi} tip={null} at={d.publishedAt} older={u.dyfi.length - 1}>
          <div className="flex flex-wrap items-center gap-2">
            {d.responses != null && <span className="text-[#cfd6dd]">{w.reports(c.num(d.responses))}</span>}
            {d.maxMmi != null && <><span className="text-secondary">{w.max}</span><MmiBadge v={d.maxMmi} /></>}
          </div>
        </Section>
      )}
    </div>
  )
}

/**
 * 取得元の状態の行。`withEvent` が偽なら状態と時点だけ（機関ごとのタブは、結べた地震を震源の欄に別に出すので重ねない）
 */
function EventLine({ source, state, withEvent }: { source: AnalysisSource; state: SourceState; withEvent: boolean }) {
  const w = useMessages().quake.analysis
  const e = withEvent ? state.event : null
  const hint = state.status === 'error' ? `${timeMin(state.errorAt)} ${state.error ?? ''}` : state.missingAt ? timeMin(state.missingAt) : state.checkedAt ? timeMin(state.checkedAt) : undefined
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5" title={hint}>
      <span className="inline-flex items-center gap-1.5">
        <i className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: STATUS_COLOR[state.status] }} />
        <b className="text-white">{sourceName(w, source)}</b>
        <span className="text-white">{w.status[state.status]}{state.missingAt ? `（${w.stale}）` : ''}</span>
        {state.checkedAt && <span className="text-secondary">{w.asOf(timeMin(state.checkedAt))}</span>}
      </span>
      {e && (
        <a href={e.url ?? undefined} target="_blank" rel="noreferrer" onClick={ev => ev.stopPropagation()} className="text-[#cfd6dd] underline decoration-dotted">
          {timeTenth(e.time)}・{w.lat} {e.lat.toFixed(2)}° {w.lon} {e.lon.toFixed(2)}°・{w.depth} {e.depthKm != null ? r0(e.depthKm) : '—'} km・{e.magType ?? 'M'} {e.mag ?? '—'}
        </a>
      )}
    </div>
  )
}

function Segment({ on, onClick, children, small = false }: { on: boolean; onClick: () => void; children: ReactNode; small?: boolean }) {
  return (
    <button type="button" aria-pressed={on} onClick={(e) => { e.stopPropagation(); onClick() }}
      className={`flex items-center gap-1.5 whitespace-nowrap ${small ? 'px-2 py-0.5' : 'px-2.5 py-1'} ${on ? 'bg-[#24303d] text-white' : 'text-secondary hover:text-white'}`}>
      {children}
    </button>
  )
}


/** 解析の窓。画面の中央に出し、Esc・窓の外・［閉じる］で閉じる（作りは `SeismoWaveDetail` に揃える） */
export function QuakeAnalysisDialog({ title, analysis: a, onClose }: { title: string; analysis: QuakeAnalysis; onClose: () => void }) {
  const w = useMessages().quake.analysis
  const [groupBy, setGroupBy] = useState<GroupBy>(readGroupBy)
  const [kindTab, setKindTab] = useState<'mech' | 'usgs' | 'src'>('mech')
  const [agencyTab, setAgencyTab] = useState<AnalysisSource>(
    () => ANALYSIS_SOURCES.find(s => a.solutions.some(x => x.source === s)) ?? 'usgs',
  )
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  useLayoutEffect(() => {
    if (dialogRef.current) fadeIn(dialogRef.current, CANCEL_FADE_MS)
  }, [])
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    return () => before?.focus()
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const trapTab = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Tab') return
    const root = dialogRef.current
    if (root === null) return
    const focusable = [...root.querySelectorAll<HTMLElement>('button, a[href]')]
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    } else if (!root.contains(document.activeElement)) {
      e.preventDefault()
      first.focus()
    }
  }
  const chooseGroupBy = (v: GroupBy) => {
    setGroupBy(v)
    writeGroupBy(v)
  }

  const groups = groupSolutionVersions(a.solutions)
  const hasUsgs = Object.values(a.usgs).some(v => v.length > 0)
  const near = a.catalogCheck?.jmaQuakesNearUsgs ?? 0
  const mergedLine = near >= 2 ? <div className="text-[#ef8a1f]">{w.merged(near)}</div> : null
  const m = a.match
  const base = m.source === 'catalog' ? `${w.catalog} ${timeTenth(m.from)}` : `${w.quakeInfo} ${timeMin(m.from)}`
  const c = a.catalogCheck
  // 答え全体の時点（端末の控えを出しているときも、いつの答えかが分かるように。2026-11-16 ユーザー選択「窓と取得元の行に出す (Recommended)」）
  const asOf = analysisCheckedAt(a)

  const content = (
    <div
      className={`fixed inset-0 z-100000 flex items-center justify-center bg-black/60 ${OVERLAY_BACKDROP_PAD}`}
      onClick={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) onClose() }}
      onPointerDown={(e) => e.stopPropagation()}
      // 窓の中に焦点がある間のキーはここで止まり `window` へ届かないので、Esc もここで受ける
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onClose(); else trapTab(e) }}
      role="presentation"
    >
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={w.title(title)}
        className="flex max-h-full w-full max-w-[76rem] flex-col gap-2.5 overflow-y-auto rounded-lg border border-border bg-panel p-3 text-xs shadow-2xl shadow-black/60 [&>*]:shrink-0">
        {/* ［閉じる］は 1 行目（地震の名前と時点）だけに並べ、2 行目（地震の時刻と長期震源カタログの状態）は窓の幅いっぱいに使う */}
        <div className="flex flex-col gap-1">
          <div className="flex items-start gap-2">
            <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
              <span className="text-sm text-white">{w.title(title)}</span>
              {asOf && <span className="text-secondary">{w.asOf(timeMin(asOf))}</span>}
            </div>
            <button ref={closeRef} type="button" onClick={(e) => { e.stopPropagation(); onClose() }}
              className="shrink-0 rounded-md border border-border bg-panel px-3 py-1 text-secondary hover:bg-white/10 hover:text-white">{w.close}</button>
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-white">{base}</span>
            {/* 長期震源カタログと照合できたときだけ出す（2026-11-16 ユーザー発言「照合できたときだけ照合済みとか出せばいいじゃん」）。
                長期震源カタログで結んだ地震は、左の時刻がもう長期震源カタログのものなので重ねて出さない */}
            {c?.result === 'found' && m.source !== 'catalog' && (
              <span className="whitespace-nowrap text-secondary">{`${w.catalog} ${w.catalogMatched}`}</span>
            )}
          </div>
        </div>
        {a.watch.usgsError && <div className="text-[#ef8a1f]">{w.watchError(timeMin(a.watch.usgsErrorAt))}</div>}
        <div className="flex flex-wrap items-center justify-between gap-2">
          {groupBy === 'agency' ? (
            <div className="grid w-full grid-cols-4 divide-x divide-border overflow-hidden rounded border border-border">
              {ANALYSIS_SOURCES.map(s => {
                const n = groupSolutionVersions(a.solutions.filter(x => x.source === s)).length
                return (
                  <button key={s} type="button" aria-pressed={agencyTab === s} onClick={(e) => { e.stopPropagation(); setAgencyTab(s) }}
                    className={`flex min-w-0 items-center justify-center gap-1.5 px-1.5 py-1 text-center ${agencyTab === s ? 'bg-[#24303d] text-white' : 'text-secondary hover:text-white'}`}>
                    <i className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: STATUS_COLOR[a.sources[s].status] }} />
                    <span className="leading-tight">{sourceName(w, s)}{n > 0 ? ` ${n}` : ''}</span>
                  </button>
                )
              })}
            </div>
          ) : (
            <div className="flex flex-wrap divide-x divide-border overflow-hidden rounded border border-border">
              <Segment on={kindTab === 'mech'} onClick={() => setKindTab('mech')}>{`${w.tabMech} ${groups.length}`}</Segment>
              {hasUsgs && <Segment on={kindTab === 'usgs'} onClick={() => setKindTab('usgs')}>{w.tabUsgs}</Segment>}
              <Segment on={kindTab === 'src'} onClick={() => setKindTab('src')}>{w.tabSources}</Segment>
            </div>
          )}
          <div className="ml-auto flex divide-x divide-border overflow-hidden rounded border border-border text-[11px]">
            <Segment small on={groupBy === 'agency'} onClick={() => chooseGroupBy('agency')}>{w.byAgency}</Segment>
            <Segment small on={groupBy === 'kind'} onClick={() => chooseGroupBy('kind')}>{w.byKind}</Segment>
          </div>
        </div>
        {groupBy === 'agency' ? (
          <>
            <EventLine source={agencyTab} state={a.sources[agencyTab]} withEvent={false} />
            {agencyTab === 'usgs' && mergedLine}
            <AgencyPanel a={a} source={agencyTab}>
              {agencyTab === 'usgs' && hasUsgs && (
                <>
                  <h3 className="m-0 flex items-baseline gap-2 text-xs font-semibold text-white">{w.impact}<span className="font-normal text-secondary">{w.usgsEstimate}</span></h3>
                  <UsgsProducts a={a} />
                </>
              )}
            </AgencyPanel>
          </>
        ) : (
          <>
            {kindTab === 'mech' && <MechTable a={a} solutions={a.solutions} withSource />}
            {kindTab === 'usgs' && hasUsgs && <UsgsProducts a={a} />}
            {kindTab === 'src' && (
              <div className="flex flex-col gap-1">
                {ANALYSIS_SOURCES.map(s => <EventLine key={s} source={s} state={a.sources[s]} withEvent />)}
                {mergedLine}
              </div>
            )}
          </>
        )}
        <div className="text-secondary">{w.credit}: {w.jma}・U.S. Geological Survey・EMSC・GFZ GEOFON</div>
      </div>
    </div>
  )
  return createPortal(content, document.body)
}
