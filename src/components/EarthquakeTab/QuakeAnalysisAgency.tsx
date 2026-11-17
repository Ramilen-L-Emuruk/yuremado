import { Fragment, useMemo, useState, type ReactNode } from 'react'
import { DescriptionTip } from '../DescriptionTip'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { useMessages } from '../../i18n/I18nProvider'
import {
  faultTypeOf, groupSolutionVersions, mirroredSource, representativeGroup,
  type AnalysisSource, type FaultType, type FocalSolution, type MatchedEvent, type NodalPlane, type QuakeAnalysis,
} from '../../services/relayAnalysis'
import { formatDateTime, formatDateTimeMin } from '../../utils/formatters'
import { Beachball } from './Beachball'
import { DisclosureCaret } from './quakeMotion'

/**
 * 解析の窓の機関ごとのタブの中身（2026-11-17 ユーザー選択「この形で作る (Recommended)」）。上から代表の解・震源・発震機構の表
 * （狭い幅は 1 解 2 行）の順に並べ、初めて見る人向けの説明は点線の語の吹き出しに置く（分かる人の邪魔にならないよう常には出さない）。
 * 表の列は、どの解にも値の無い列を出さない（取得元が出す値だけ）
 */

type AnalysisWords = ReturnType<typeof useMessages>['quake']['analysis']
interface Tip { text: string; src: string }

const r0 = (v: number) => Math.round(v)
const planeText = (p: NodalPlane) => `${r0(p.strike)}°/${r0(p.dip)}°/${r0(p.rake)}°`
const timeMin = (iso: string | null) => (iso ? formatDateTimeMin(iso) : null) ?? '—'
/** 取得元の地震の発生時刻（0.1 秒まで） */
function timeTenth(iso: string): string {
  const base = formatDateTime(iso)
  if (base === null) return '—'
  return `${base}.${Math.floor(new Date(iso).getMilliseconds() / 100)}`
}
/**
 * 割合の値を % に。単位は取得元で決まる（EMSC は 0〜100、USGS・GEOFON は 0〜1、気象庁の V.R. は 0〜100）。
 * 値の大きさで推し量ると、EMSC の 1% 以下の値が 100 倍に化ける
 */
export function percentOf(s: Pick<FocalSolution, 'source'>, v: number | boolean | undefined): number | null {
  if (typeof v !== 'number') return null
  return r0(s.source === 'usgs' || s.source === 'geofon' ? v * 100 : v)
}
const dcOf = (s: FocalSolution) => percentOf(s, s.extra.percentDoubleCouple ?? s.extra.doubleCouple)
const vrOf = (s: FocalSolution) => percentOf(s, s.extra.varianceReduction)
/** スカラーモーメント（Nm）。補足の値に無ければテンソルの Mo から */
const momentOf = (s: FocalSolution): number | null =>
  typeof s.extra.scalarMoment === 'number' ? s.extra.scalarMoment : s.tensor ? s.tensor.mo * 10 ** s.tensor.exponent : null
/** 表の列に出す補足の値の欄。これ以外の欄は「その他」の列に名前のまま出す */
const KNOWN_EXTRA = new Set(['percentDoubleCouple', 'doubleCouple', 'percentClvd', 'percentIso', 'scalarMoment', 'varianceReduction', 'stationCount'])
/** スカラーモーメント（Nm）を「2.27×10²⁰ N·m」の形に */
function momentText(v: number): string {
  const [m, e] = v.toExponential(2).split('e+')
  return `${m}×10${[...(e ?? '')].map(ch => '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(ch)]).join('')} N·m`
}
const stationsOf = (s: FocalSolution) => (typeof s.extra.stationCount === 'number' ? s.extra.stationCount : null)

export const sourceName = (w: AnalysisWords, s: AnalysisSource) => (s === 'jma' ? w.jma : s === 'usgs' ? 'USGS' : s === 'emsc' ? 'EMSC' : 'GEOFON')

/** 気象庁の解の名前（中継の手法: 初動・CMT・CMT全世界・CMT（精査後）・初動（精査後）） */
export function jmaMethodText(w: AnalysisWords, method: string): string {
  const refined = method.endsWith('（精査後）')
  const base = refined ? method.slice(0, -'（精査後）'.length) : method
  const name = base === 'CMT' || base === 'CMT全世界' ? w.jmaMethod.cmt : base === '初動' ? w.jmaMethod.firstMotion : base
  return w.jmaMethodLabel(name, refined ? w.jmaStage.refined : w.jmaStage.preliminary, base === 'CMT全世界' ? w.jmaScopeGlobal : null)
}

/**
 * 点線の語。押す・乗せる・焦点で説明を吹き出しに出す（設定の窓の説明と同じ部品）。
 * `also` は同じ語に重ねて要る 2 つ目の説明（気象庁の「CMT 解（精査後）」の「精査後」）で、出典ごと下に続ける
 */
export function Term({ label, tip, also = null, figure = null, className = 'text-inherit' }: { label: string; tip: Tip; also?: Tip | null; figure?: ReactNode; className?: string }) {
  const w = useMessages().quake.analysis
  return (
    <DescriptionTip
      label={label}
      labelClassName={className}
      description={(
        <span className="flex max-w-[19rem] flex-col gap-1 text-[#e5e7eb]">
          <span>{tip.text}</span>
          {figure}
          <span className="text-[10.5px] text-secondary">{w.credit}: {tip.src}</span>
          {also && <span>{also.text}</span>}
          {also && <span className="text-[10.5px] text-secondary">{w.credit}: {also.src}</span>}
        </span>
      )}
    />
  )
}

/**
 * 断層の型の小図（正断層・逆断層は横から見た断面、横ずれは真上から見た図）。今の型を強調する。
 * 左が下盤・右が上盤（断層面は右へ傾く）で、矢印は上盤の動き
 */
export function FaultTypesFigure({ highlight }: { highlight: FaultType | null }) {
  const w = useMessages().quake.analysis
  const on = (t: FaultType) => highlight === t
  const stroke = (t: FaultType) => (on(t) ? '#e5e7eb' : '#64748b')
  const fill = (t: FaultType) => (on(t) ? '#2b3443' : '#1c222c')
  const arrow = (t: FaultType) => (on(t) ? '#e15241' : '#64748b')
  const section = (t: FaultType, dy: number) => (
    <>
      <polygon points="2,14 38,14 22,52 2,52" fill={fill(t)} stroke={stroke(t)} />
      <polygon points={`${42 + dy * 0.42},${14 - dy} 82,${14 - dy} 82,${52 - dy} ${26 + dy * 0.42},${52 - dy}`} fill={fill(t)} stroke={stroke(t)} />
    </>
  )
  const line = (t: FaultType, x1: number, y1: number, x2: number, y2: number) => (
    <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={arrow(t)} strokeWidth={2} markerEnd={`url(#fault-arrow-${on(t) ? 'on' : 'off'})`} />
  )
  const label = (t: FaultType) => (
    <text x={42} y={66} fill={on(t) ? '#fff' : '#94a3b8'} fontSize={10} textAnchor="middle">{w.fault[t]}</text>
  )
  return (
    <svg viewBox="0 0 280 72" style={{ width: '100%', maxWidth: 280, height: 'auto' }} role="img" aria-label={`${w.fault.normal}・${w.fault.reverse}・${w.fault.strikeSlip}`} className="my-1 block">
      <defs>
        {(['on', 'off'] as const).map(k => (
          <marker key={k} id={`fault-arrow-${k}`} viewBox="0 0 6 6" refX={5} refY={3} markerWidth={5} markerHeight={5} orient="auto">
            <path d="M0,0 L6,3 L0,6Z" fill={k === 'on' ? '#e15241' : '#64748b'} />
          </marker>
        ))}
      </defs>
      <g>{section('normal', -5)}{line('normal', 56, 26, 53, 36)}{label('normal')}</g>
      <g transform="translate(96,0)">{section('reverse', 5)}{line('reverse', 52, 38, 56, 26)}{label('reverse')}</g>
      <g transform="translate(192,0)">
        <rect x={2} y={14} width={80} height={18} fill={fill('strikeSlip')} stroke={stroke('strikeSlip')} />
        <rect x={2} y={34} width={80} height={18} fill={fill('strikeSlip')} stroke={stroke('strikeSlip')} />
        {line('strikeSlip', 56, 23, 30, 23)}{line('strikeSlip', 28, 43, 54, 43)}{label('strikeSlip')}
      </g>
    </svg>
  )
}

/** 断層の型の語（吹き出しに型の説明と小図） */
function FaultTerm({ plane, className }: { plane: NodalPlane; className?: string }) {
  const w = useMessages().quake.analysis
  const t = faultTypeOf(plane)
  return (
    <Term label={w.fault[t]} tip={w.tips[t]} className={className}
      figure={<><FaultTypesFigure highlight={t} /><span>{w.tips.figureNote}</span></>} />
  )
}

/** 解の手法の語。気象庁は CMT・初動・精査後・参考、USGS は Mww に説明を付ける */
function MethodTerm({ s }: { s: FocalSolution }) {
  const w = useMessages().quake.analysis
  if (s.source === 'jma') {
    const refined = s.method.endsWith('（精査後）')
    const base = refined ? s.method.slice(0, -'（精査後）'.length) : s.method
    const tip = s.reference ? w.tips.reference : base === '初動' ? w.tips.first : w.tips.cmt
    return <Term label={jmaMethodText(w, s.method)} tip={tip} also={refined ? w.tips.refined : null} />
  }
  if (s.source === 'geofon') return <Term label="GEOFON standard" tip={w.tips.gstd} />
  if (s.source === 'emsc') return <AgencyTerm agency={s.agency} />
  return s.method === 'Mww' ? <Term label={`W-phase（${s.method}）`} tip={w.tips.wphase} /> : <>{s.method}</>
}

function AgencyTerm({ agency }: { agency: string }) {
  const w = useMessages().quake.analysis
  const name = w.tips.agency[agency]
  return name ? <Term label={agency} tip={{ text: name, src: w.tips.agencySrc }} /> : <>{agency}</>
}

/**
 * 版をまたいで値が変わっていないか。表に出すすべての値（Mw・深さ・セントロイド・丸める前の節面・主軸・テンソル・補足の値）を比べる
 * （Mw と節面だけだと、観測点数や深さが変わった版でも「変わっていない」と言ってしまう）
 */
export function unchangedAcrossVersions(group: { latest: FocalSolution; older: readonly FocalSolution[] }): boolean {
  const sig = (s: FocalSolution) => JSON.stringify([s.mw, s.depthKm, s.centroid, s.planes, s.axes, s.tensor, s.reference, s.extra])
  return group.older.every(o => sig(o) === sig(group.latest))
}

function VersionsNote({ group }: { group: { latest: FocalSolution; older: FocalSolution[] } }) {
  const w = useMessages().quake.analysis
  if (group.older.length === 0) {
    return <>{group.latest.publishedAt ? `${timeMin(group.latest.publishedAt)} ${w.published}` : w.noPublished}</>
  }
  const first = group.older.reduce((a, b) => ((a.publishedAt ?? '') < (b.publishedAt ?? '') ? a : b))
  return (
    <>
      <Term label={w.versionsSpan(timeMin(first.publishedAt), timeMin(group.latest.publishedAt), group.older.length + 1)} tip={w.tips.versions} />
      {unchangedAcrossVersions(group) && <span>{w.unchanged}</span>}
    </>
  )
}

/** タブの先頭の札: 代表の解の震源球・Mw・断層の型と、どの解か・公表と版 */
function Lead({ a, source }: { a: QuakeAnalysis; source: AnalysisSource }) {
  const w = useMessages().quake.analysis
  const groups = groupSolutionVersions(a.solutions.filter(s => s.source === source))
  const rep = representativeGroup(groups)
  if (!rep) return null
  const s = rep.latest
  const depth = s.depthKm != null ? (s.centroid ? w.centroidDepth(String(Math.round(s.depthKm * 10) / 10)) : `${w.depth} ${r0(s.depthKm)} km`) : null
  const noFirstMotion = source === 'jma' && !groups.some(g => g.latest.method.startsWith('初動'))
  return (
    <div className="flex items-center gap-3.5 rounded-md border border-border bg-[#171b22] px-3 py-2.5">
      <div className="flex shrink-0 flex-col items-center gap-0.5">
        {s.planes ? <Beachball plane={s.planes[0]} size={56} /> : <div className="h-14 w-14 rounded-full border border-dashed border-border" />}
        <Term label={w.beachball} tip={w.tips.ball} className="text-[10.5px] text-secondary" />
      </div>
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <b className="text-xl text-white">Mw {s.mw?.toFixed(1) ?? '—'}</b>
          {s.planes && <FaultTerm plane={s.planes[0]} className="text-sm text-white" />}
        </div>
        <div className="flex flex-wrap items-baseline gap-x-1 text-secondary">
          {s.preferred && (source === 'usgs' || source === 'emsc') && (
            <><Term label={w.pickedBy[source]} tip={source === 'usgs' ? w.tips.adopted : w.tips.emscpref} /><span>・</span></>
          )}
          <MethodTerm s={s} />
          {depth && <><span>・</span>{s.centroid ? <Term label={depth} tip={w.tips.centroid} /> : <span>{depth}</span>}</>}
        </div>
        <div className="flex flex-wrap items-baseline gap-x-1 text-[11px] text-secondary">
          {source === 'emsc' ? <Term label={w.emscNote} tip={w.tips.emscpref} />
            : source === 'jma' && noFirstMotion ? <><Term label={w.jmaMethod.firstMotion} tip={w.tips.first} /><span>{w.notPublished}</span></>
            : source !== 'jma' ? <VersionsNote group={rep} />
            : null}
        </div>
      </div>
    </div>
  )
}

/**
 * GEOFON の状態（A 自動・C 人が確かめた・M 手で見直した。GEOFON の頁の Status の決め方）。知らない組み合わせは
 * 取得元の語を括弧で添え、黙って「自動で出した」に畳まない
 */
export function evaluationWord(w: Pick<AnalysisWords, 'evaluation'>, e: Pick<MatchedEvent, 'evaluationMode' | 'evaluationStatus'>): string | null {
  const st = e.evaluationStatus
  if (e.evaluationMode === 'manual') return st === null || st === 'confirmed' ? w.evaluation.manual : `${w.evaluation.manual}（${st}）`
  if (e.evaluationMode === 'automatic') {
    if (st === 'confirmed') return w.evaluation.confirmed
    return st === null || st === 'preliminary' ? w.evaluation.automatic : `${w.evaluation.automatic}（${st}）`
  }
  if (e.evaluationMode === null) return st
  return st ? `${e.evaluationMode}（${st}）` : e.evaluationMode
}

/** 震源: その機関が決めた位置と規模 */
function Hypocenter({ a, source }: { a: QuakeAnalysis; source: AnalysisSource }) {
  const w = useMessages().quake.analysis
  const e = a.sources[source].event
  if (!e) return null
  const state = evaluationWord(w, e)
  const rows: [ReactNode, ReactNode][] = [
    [w.originTime, timeTenth(e.time)],
    [w.epicenter, `${w.lat} ${e.lat.toFixed(2)}° ${w.lon} ${e.lon.toFixed(2)}°`],
    [w.depth, <>
      {e.depthKm != null ? `${r0(e.depthKm)} km` : '—'}
      {e.depthType === 'operator assigned' && <> <Term label={w.depthAssigned} tip={w.tips.depthAssigned} className="text-secondary" /></>}
      {e.depthType === 'from location' && <span className="text-secondary"> {w.depthFromLocation}</span>}
      {/* 名前を付けていない決め方（QuakeML の from modeling など）は、取得元の値のまま括弧で添える（値を落とさない） */}
      {e.depthType && e.depthType !== 'operator assigned' && e.depthType !== 'from location' && <span className="text-secondary"> ({e.depthType})</span>}
    </>],
    [w.magnitude, `${e.magType ?? 'M'} ${e.mag ?? '—'}`],
  ]
  if (state) rows.push([<Term key="state" label={w.state} tip={w.tips.gstatus} />, state])
  return (
    <>
      <h3 className="m-0 flex items-baseline gap-2 text-xs font-semibold text-white">
        {w.hypo}
        {e.url ? (
          <a href={e.url} target="_blank" rel="noreferrer" onClick={ev => ev.stopPropagation()} className="font-normal text-secondary underline decoration-dotted">{w.hypoBy(sourceName(w, source))}</a>
        ) : <span className="font-normal text-secondary">{w.hypoBy(sourceName(w, source))}</span>}
      </h3>
      <div className="grid grid-cols-[max-content_1fr] gap-x-3.5 gap-y-0.5">
        {rows.map(([k, v], i) => (
          <Fragment key={i}><span className="text-secondary">{k}</span><span className="text-white">{v}</span></Fragment>
        ))}
      </div>
    </>
  )
}

interface Column {
  key: string
  head: ReactNode
  /** 狭い幅の 2 行目に並べるときの前置き（無ければ値だけ） */
  short: ReactNode | null
  value: (s: FocalSolution) => ReactNode | null
}

function columns(w: AnalysisWords, a: QuakeAnalysis): Column[] {
  const quakeMs = (s: FocalSolution) => {
    const t = a.sources[s.source].event?.time
    return t ? Date.parse(t) : NaN
  }
  const ax = (s: FocalSolution) => {
    if (!s.axes) return null
    const L = w.axisLetters
    return `${L.p} ${r0(s.axes.p.azimuth)}°/${r0(s.axes.p.plunge)}° ${L.t} ${r0(s.axes.t.azimuth)}°/${r0(s.axes.t.plunge)}° ${L.n} ${r0(s.axes.n.azimuth)}°/${r0(s.axes.n.plunge)}°`
  }
  const cols: Column[] = [
    { key: 'mw', head: w.col.mw, short: null, value: s => (s.mw != null ? `Mw ${s.mw.toFixed(1)}` : null) },
    { key: 'fault', head: <Term label={w.col.fault} tip={w.tips.faultType} figure={<FaultTypesFigure highlight={null} />} />, short: null, value: s => (s.planes ? <FaultTerm plane={s.planes[0]} /> : null) },
    { key: 'p1', head: <Term label={w.col.plane1} tip={w.tips.plane} />, short: <Term label={w.planes} tip={w.tips.plane} />, value: s => (s.planes ? planeText(s.planes[0]) : null) },
    { key: 'p2', head: <Term label={w.col.plane2} tip={w.tips.plane} />, short: null, value: s => (s.planes ? planeText(s.planes[1]) : null) },
    { key: 'depth', head: w.depth, short: null, value: s => (s.depthKm != null ? `${Math.round(s.depthKm * 10) / 10} km` : null) },
    { key: 'axes', head: <Term label={w.col.axes} tip={w.tips.axes} />, short: <Term label={w.col.axes} tip={w.tips.axes} />, value: ax },
    { key: 'dc', head: <Term label={w.col.dc} tip={w.tips.dc} />, short: <Term label={w.col.dc} tip={w.tips.dc} />, value: s => { const v = dcOf(s); return v === null ? null : `${v}%` } },
    { key: 'ndc', head: <Term label={w.col.ndc} tip={w.tips.ndc} />, short: <Term label={w.col.ndc} tip={w.tips.ndc} />, value: s => (s.tensor?.nonDcRatio != null ? s.tensor.nonDcRatio.toFixed(2).replace('-', '−') : null) },
    { key: 'clvd', head: w.extra.clvd, short: w.extra.clvd, value: s => { const v = percentOf(s, s.extra.percentClvd); return v === null ? null : `${v}%` } },
    { key: 'iso', head: w.extra.iso, short: w.extra.iso, value: s => { const v = percentOf(s, s.extra.percentIso); return v === null ? null : `${v}%` } },
    { key: 'mo', head: 'Mo', short: 'Mo', value: s => { const v = momentOf(s); return v === null ? null : momentText(v) } },
    { key: 'vr', head: <Term label={w.col.vr} tip={w.tips.vr} />, short: <Term label={w.col.vr} tip={w.tips.vr} />, value: s => { const v = vrOf(s); return v === null ? null : `${v}%` } },
    { key: 'st', head: w.col.stations, short: w.col.stations, value: s => { const v = stationsOf(s); return v === null ? null : String(v) } },
    // 解ごとの見直しの段階（震源の「状態」と同じ語。知らない値は取得元の値のまま）
    { key: 'eval', head: w.col.evaluation, short: null, value: s => (s.evaluationMode === 'manual' ? w.evaluation.manual : s.evaluationMode === 'automatic' ? w.evaluation.automatic : s.evaluationMode) },
    // テンソルの 6 成分。幅のある表では列にせず、解の行の下に表の幅で添える（MechTable）
    {
      key: 'tensor', head: <Term label={w.col.tensor} tip={w.tips.tensor} />, short: <Term label={w.col.tensorShort} tip={w.tips.tensor} />,
      value: s => {
        if (!s.tensor) return null
        const t = s.tensor
        // 丸めて 0 になる負の値は「−0.00」ではなく「0.00」と出す
        const f = (v: number) => { const r = Math.round(v * 100) / 100; return (r === 0 ? 0 : r).toFixed(2).replace('-', '−') }
        const exp = [...String(t.exponent)].map(ch => (ch === '-' ? '⁻' : '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(ch)])).join('')
        // 括弧は言語を問わず半角（数式の単位の添え書き）
        return `Mrr ${f(t.mrr)} Mtt ${f(t.mtt)} Mff ${f(t.mff)} Mrt ${f(t.mrt)} Mrf ${f(t.mrf)} Mtf ${f(t.mtf)} (×10${exp} N·m)`
      },
    },
    // 名前の分からない補足の値（気象庁の初動解のスコアなど）は、取得元の欄の名前のまま出す（前の窓と同じ。値を落とさない）
    {
      key: 'other', head: '', short: null,
      value: s => {
        const rest = Object.entries(s.extra).filter(([k, v]) => typeof v === 'number' && !KNOWN_EXTRA.has(k)).map(([k, v]) => `${k} ${v}`)
        return rest.length ? rest.join('・') : null
      },
    },
    {
      key: 'arrived', head: w.col.arrived, short: null,
      value: s => {
        if (s.source !== 'emsc' || !s.publishedAt) return null
        const min = Math.round((Date.parse(s.publishedAt) - quakeMs(s)) / 60_000)
        return Number.isFinite(min) && min >= 0 ? w.afterQuake(w.elapsed(min)) : null
      },
    },
    // 公表の時刻が無い解（気象庁の速報値・精査後）は「公表時刻なし」と出す（前の窓と同じ。空欄で黙らない）
    { key: 'pub', head: w.col.published, short: w.col.published, value: s => (s.publishedAt ? timeMin(s.publishedAt) : w.noPublished) },
  ]
  return cols
}

/** 表に切り替える幅（Tailwind の sm と同じ 640px） */
const WIDE_QUERY = '(min-width: 640px)'

/** 発震機構の表。幅のある画面は 1 解 1 行の表、狭い画面は 1 解 2 行の並び。前の版は「ほか N 版 ▸」で開く */
export function MechTable({ a, solutions, withSource }: { a: QuakeAnalysis; solutions: readonly FocalSolution[]; withSource: boolean }) {
  const w = useMessages().quake.analysis
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  // 表と狭い並びは片方だけ組む（CSS で隠すだけだと、見えない側の節・ホバーの解説まで毎回組み立てる）
  const wide = useMediaQuery(WIDE_QUERY)
  const groups = useMemo(() => groupSolutionVersions(solutions), [solutions])
  const cols = useMemo(() => {
    const all = groups.flatMap(g => [g.latest, ...g.older])
    return columns(w, a).filter(c => all.some(s => c.value(s) !== null))
  }, [groups, w, a])
  if (groups.length === 0) return <div className="text-secondary">{w.noSolutions}</div>
  const tableCols = cols.filter(c => c.key !== 'tensor')
  const tensorCol = cols.find(c => c.key === 'tensor') ?? null
  const toggle = (key: string) => setOpen(prev => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })
  // 「USGS のタブの解と同じ」は、機関ごとのタブで隣のタブに同じ値の解が実際にあるときだけ（種類ごとの表は同じ表に並ぶので出さない）
  const sameAs = (s: FocalSolution) => {
    if (withSource) return null
    const src = mirroredSource(s, a.solutions)
    return src ? w.sameAs(sourceName(w, src)) : null
  }
  const badge = (s: FocalSolution) => (s.preferred && s.source !== 'jma'
    ? <span className="ml-1 inline-block rounded-[3px] border border-[#3b82f6] px-1 text-[10px] text-[#93c5fd]">{w.badge[s.source]}</span>
    : null)
  const head = (s: FocalSolution) => (
    <span className="inline-flex flex-wrap items-center gap-x-1">
      {s.planes && <span className="inline-block align-middle"><Beachball plane={s.planes[0]} size={22} /></span>}
      {withSource && s.source !== 'emsc' && <b className="text-white">{sourceName(w, s.source)}</b>}
      {withSource && s.source === 'emsc' && <span className="text-secondary">EMSC</span>}
      <MethodTerm s={s} />
      {badge(s)}
    </span>
  )
  const more = (g: (typeof groups)[number]) => (g.older.length > 0 ? (
    <button type="button" className="ml-1 whitespace-nowrap text-secondary hover:text-white" aria-expanded={open.has(g.latest.key)}
      onClick={(e) => { e.stopPropagation(); toggle(g.latest.key) }}>
      {w.moreVersions(g.older.length)} <DisclosureCaret open={open.has(g.latest.key)} />
    </button>
  ) : null)
  return wide ? (
      /* 列が多い（種類ごとで全機関を並べる・長い言語）ときは、窓を広げずに表の中で横へ送る */
      <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            {/* EMSC のタブは機関ごとの解なので「機関」 */}
            <th className="px-2 py-1 text-left text-[11px] font-normal text-secondary">{withSource || groups.every(g => g.latest.source === 'emsc') ? w.col.agency : w.col.method}</th>
            {tableCols.map(c => <th key={c.key} className="px-2 py-1 text-left text-[11px] font-normal text-secondary">{c.head}</th>)}
            <th />
          </tr>
        </thead>
        <tbody>
          {groups.map(g => (
            <Fragment key={g.latest.key}>
              <tr className={g.latest.preferred ? 'bg-[#1b2430]' : undefined}>
                <td className="whitespace-nowrap border-t border-border px-2 py-1.5">{head(g.latest)}</td>
                {tableCols.map(c => <td key={c.key} className="whitespace-nowrap border-t border-border px-2 py-1.5 text-white">{c.value(g.latest) ?? ''}</td>)}
                {/* 注記は長い言語で幅を越えるので折り返す（「ほか N 版」の釦だけは折り返さない） */}
                <td className="min-w-[7rem] border-t border-border px-2 py-1.5 text-[11px] text-secondary">{sameAs(g.latest)}{more(g)}</td>
              </tr>
              {/* テンソルの 6 成分は列にすると表が窮屈になるので、行の下に表の幅で添える */}
              {tensorCol && tensorCol.value(g.latest) !== null && (
                <tr className={g.latest.preferred ? 'bg-[#1b2430]' : undefined}>
                  <td />
                  <td colSpan={tableCols.length + 1} className="px-2 pb-1.5 pt-0 text-[11px] text-secondary">{tensorCol.head} {tensorCol.value(g.latest)}</td>
                </tr>
              )}
              {open.has(g.latest.key) && g.older.map((o, i) => (
                // 公表時刻の無い版が並んでも鍵が重ならないよう、並びの番号を添える
                <Fragment key={`${o.publishedAt ?? o.key}#${i}`}>
                  <tr className="text-secondary">
                    <td className="px-2 py-1" />
                    {tableCols.map(c => <td key={c.key} className="whitespace-nowrap px-2 py-1">{c.value(o) ?? ''}</td>)}
                    <td />
                  </tr>
                  {/* 前の版のテンソルも、最新の版と同じく行の下に添える（狭い並びの 2 行目と同じく値を落とさない） */}
                  {tensorCol && tensorCol.value(o) !== null && (
                    <tr className="text-secondary">
                      <td />
                      <td colSpan={tableCols.length + 1} className="px-2 pb-1 pt-0 text-[11px]">{tensorCol.head} {tensorCol.value(o)}</td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
      </div>
  ) : (
      <div className="flex flex-col">
        {groups.map(g => (
          <div key={g.latest.key} className="border-t border-border py-1.5">
            <div className="flex flex-wrap items-center gap-x-2">
              {head(g.latest)}
              {g.latest.mw != null && <b className="text-white">Mw {g.latest.mw.toFixed(1)}</b>}
              {g.latest.planes && <FaultTerm plane={g.latest.planes[0]} className="text-white" />}
            </div>
            <SecondLine s={g.latest} cols={cols} note={sameAs(g.latest)} tail={more(g)} />
            {open.has(g.latest.key) && g.older.map((o, i) => <SecondLine key={`${o.publishedAt ?? o.key}#${i}`} s={o} cols={cols} note={null} tail={null} />)}
          </div>
        ))}
      </div>
  )
}

/** 狭い幅の 2 行目: 節面・主軸・割合・観測点・時刻と注記を「・」でつなぎ（各値は折り返さない）、最後に「ほか N 版」の釦 */
function SecondLine({ s, cols, note, tail }: { s: FocalSolution; cols: readonly Column[]; note: string | null; tail: ReactNode }) {
  const parts = cols.filter(c => c.key !== 'mw' && c.key !== 'fault' && c.key !== 'p2').flatMap(c => {
    const v = c.value(s)
    if (v === null) return []
    const value = c.key === 'p1' && s.planes ? `${planeText(s.planes[0])}・${planeText(s.planes[1])}` : v
    // テンソルの 6 成分は 1 つの値として長いので、成分の間で折り返す（ほかの値は折り返さない）
    return [<span key={c.key} className={c.key === 'tensor' ? undefined : 'whitespace-nowrap'}>{c.short ? <>{c.short} </> : null}{value}</span>]
  })
  if (note) parts.push(<span key="note">{note}</span>)
  return (
    <div className="flex flex-wrap gap-x-1 text-secondary">
      {parts.map((p, i) => <Fragment key={i}>{i > 0 && <span>・</span>}{p}</Fragment>)}
      {tail}
    </div>
  )
}

/** 機関ごとのタブの中身: 代表の解・震源・発震機構の表 */
export function AgencyPanel({ a, source, children }: { a: QuakeAnalysis; source: AnalysisSource; children: ReactNode }) {
  const w = useMessages().quake.analysis
  const solutions = useMemo(() => a.solutions.filter(s => s.source === source), [a, source])
  const n = useMemo(() => groupSolutionVersions(solutions).length, [solutions])
  return (
    <div className="flex flex-col gap-2.5">
      <Lead a={a} source={source} />
      <Hypocenter a={a} source={source} />
      <h3 className="m-0 flex items-baseline gap-2 text-xs font-semibold text-white">
        {source === 'emsc' ? w.collected : w.mech}
        <span className="font-normal text-secondary">{source === 'emsc' ? w.collectedCount(n) : w.solutions(n)}</span>
      </h3>
      <MechTable a={a} solutions={solutions} withSource={false} />
      {children}
    </div>
  )
}
