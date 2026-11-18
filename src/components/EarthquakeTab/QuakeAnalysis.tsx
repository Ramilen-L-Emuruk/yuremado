import { Component, lazy, Suspense, useState, type ReactNode } from 'react'
import { useMessages } from '../../i18n/I18nProvider'
import type { QuakeAnalysisView } from '../../hooks/useQuakeAnalysis'
import {
  ANALYSIS_SOURCES, analysisIsEmpty, faultTypeOf, groupSolutionVersions, latestVersion, representativeSolution,
  type NodalPlane, type QuakeAnalysis,
} from '../../services/relayAnalysis'
import { log } from '../../utils/logger'
import { sourceName, type AnalysisWords } from './analysisTerm'

/**
 * 地震カードに添える海外の機関と気象庁の解析（計画書 項目 98）。カードには要約の 1 行だけを置き、
 * ［詳しく ›］で画面の中央に窓を開く（2026-11-11 発言「そういう詳しいのはポップアップするのがいいかもね。」）。
 * 機関ごとのタブ＋種類ごとの切り替えは 2026-11-15 に決め、機関ごとのタブの中身（代表の解・震源・発震機構の表・説明の吹き出し）は
 * 2026-11-17 に作り直した（`QuakeAnalysisAgency.tsx`）。窓そのものは `QuakeAnalysisDialog.tsx`
 */

export const ALERT_COLOR: Record<string, string> = { green: '#2e9d4a', yellow: '#e8c51c', orange: '#ef8a1f', red: '#d93a3a' }

export const alertText = (w: AnalysisWords, a: string) => (w.alert as Record<string, string>)[a] ?? a
const faultText = (w: AnalysisWords, p: NodalPlane) => w.fault[faultTypeOf(p)]

/**
 * 解析の窓。**押されてから読む**（開かない人のほうが多く、3D の断層・発震機構の表まで起動時のチャンクに
 * 載せると事前キャッシュの予算を超える）。作りは `QuakeSeismoWave.tsx` の詳細の窓に揃える
 */
function loadQuakeAnalysisDialog() {
  return lazy(() => import('./QuakeAnalysisDialog').then((m) => ({ default: m.QuakeAnalysisDialog })))
}
/**
 * **読み込みに失敗したら作り直す**（`DialogBoundary`）。`lazy` は失敗した読み込みを覚え続けるので、
 * 作り直さないと一度の回線断でそのページを開き直すまで二度と開けなくなる。
 */
let QuakeAnalysisDialog = loadQuakeAnalysisDialog()

/**
 * 窓だけを包む境界。**落ちたら記録へ残して窓を閉じる**（何も代わりに描かない）。
 * 素通しにすると地震情報タブの境界が受けて、カードの一覧ごと差し替わる
 */
class DialogBoundary extends Component<{ onClose: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: Error): void {
    log.error('[analysis] 解析の窓を開けなかった', error)
    // 次に押されたら読み込みからやり直す（描画の例外でも作り直して害は無い。読み直しは控えから返る）。
    QuakeAnalysisDialog = loadQuakeAnalysisDialog()
    this.props.onClose()
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children
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
  const close = () => setOpen(false)
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
      {open && openable && answer && (
        <DialogBoundary onClose={close}>
          <Suspense fallback={null}>
            <QuakeAnalysisDialog title={title} analysis={answer} onClose={close} />
          </Suspense>
        </DialogBoundary>
      )}
    </>
  )
}
