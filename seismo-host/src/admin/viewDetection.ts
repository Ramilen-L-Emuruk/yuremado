// 「検出」タブ。引き金（STA/LTA）・地震らしい揺れの枠・気象庁の地震との照合の余裕を、次の起動で使う値として
// 書く（`GET`/`PUT /api/detection`・#313・2026-10-27 ユーザー承認）。表の中身と文言は `detectionForm.ts`。
//
// **保存しても、いまの検出は変わらない**（次の起動で効く。理由は `receiver/detectionControl.ts`）。このタブには
// 再起動のボタンを置かない（同日ユーザー承認）—— 再起動は稼働状況タブから頼む。

import { apiFetch, ApiError, describeAdminAuthFailure } from './api'
import {
  DETECTION_SECTIONS,
  differsFromDefault,
  formValues,
  problemLines,
  problemsOf,
  rowHasProblem,
  rowValueText,
  settingsFromForm,
  type DetectionInputId,
  type DetectionRow,
} from './detectionForm'
import { escapeHtml, qs } from './dom'
import type { TabContext } from './tabState'
import { tipHtml } from './tip'
import type { DetectionProblem, DetectionSettings } from '../detection/detectionSettings'

interface DetectionReportView {
  readonly active: DetectionSettings
  readonly pending: DetectionSettings | null
  readonly defaults: DetectionSettings
  readonly discardedPending: string | null
}

const SAVED_TEXT = '次の再起動からこの値を使う'
/** いまと同じ値を保存したとき（待っている変更は無くなる）。 */
const SAME_AS_ACTIVE_TEXT = 'いまと同じ値なので、次の再起動で変わる値はない'
const PENDING_TEXT = '次の再起動で変わる値がある'
/** 起動時に待っていた値を捨てたとき（2026-10-27 ユーザー承認「タブにも出す」）。 */
const discardedText = (detail: string): string => `保存してあった次の再起動の値が読めなかったので捨てた（項目: ${detail}）`

function describeFailure(error: unknown): string {
  if (error instanceof ApiError) {
    const auth = describeAdminAuthFailure(error.message)
    if (auth !== null) return auth
  }
  return error instanceof Error ? error.message : String(error)
}

/** ホストが値を断った応え（`400 invalid-values`）なら、その断り。 */
function problemsInError(error: unknown): readonly DetectionProblem[] | null {
  if (!(error instanceof ApiError) || error.status !== 400) return null
  const body = error.body as { error?: string; problems?: DetectionProblem[] } | null
  return body?.error === 'invalid-values' && Array.isArray(body.problems) ? body.problems : null
}

function rowHtml(row: DetectionRow, active: DetectionSettings): string {
  const inputs = row.inputs
    .map((id) => `<input type="text" inputmode="decimal" class="detection-input" data-input="${id}" aria-label="${escapeHtml(row.label)}" />`)
    .join('<span>〜</span>')
  return `<tr data-field="${escapeHtml(row.field)}">
    <td data-tip-row>${tipHtml(row.label, row.tip)}</td>
    <td class="nowrap">${escapeHtml(rowValueText(row, active))} ${row.unit}</td>
    <td class="nowrap detection-next">${inputs}<span>${row.unit}</span><span class="detection-default muted"></span></td>
  </tr>`
}

export function tablesHtml(active: DetectionSettings): string {
  return DETECTION_SECTIONS.map(
    (section) => `<h3>${escapeHtml(section.heading)}</h3>
    <table class="detection-table">
      <thead><tr><th>項目</th><th class="nowrap">いま</th><th class="nowrap">次の再起動から</th></tr></thead>
      <tbody>${section.rows.map((row) => rowHtml(row, active)).join('')}</tbody>
    </table>`,
  ).join('')
}

/** 検出タブは選択も表示の好みも持たない。 */
export async function initDetectionView(container: HTMLElement, ctx: TabContext): Promise<void> {
  const { signal } = ctx
  container.innerHTML = `
    <div class="detection-error error"></div>
    <section class="panel">
      <h2>検出</h2>
      <p class="detection-discarded error"></p>
      <p class="detection-pending"></p>
      <form class="detection-form">
        <div class="detection-tables"></div>
        <p class="detection-problems error"></p>
        <div class="row">
          <button type="submit" style="flex: 0 0 auto">保存</button>
          <button type="button" class="detection-reset" style="flex: 0 0 auto">既定の値に戻す</button>
          <span class="detection-status muted" style="align-self: center"></span>
        </div>
      </form>
    </section>
  `
  const errorEl = qs(container, '.detection-error')
  const pendingEl = qs(container, '.detection-pending')
  const discardedEl = qs(container, '.detection-discarded')
  const form = qs<HTMLFormElement>(container, '.detection-form')
  const tablesEl = qs(container, '.detection-tables')
  const problemsEl = qs(container, '.detection-problems')
  const statusEl = qs(container, '.detection-status')
  form.hidden = true

  /** 最後に入力欄へ入れた値（保存していない入力があるかの比べ先）。 */
  let filled: Record<DetectionInputId, string> | null = null
  let saving = false

  const inputs = (): HTMLInputElement[] => [...container.querySelectorAll<HTMLInputElement>('input.detection-input')]
  const currentValues = (): Record<DetectionInputId, string> => {
    const out = {} as Record<DetectionInputId, string>
    for (const el of inputs()) out[el.dataset.input as DetectionInputId] = el.value
    return out
  }
  const isDirty = (): boolean => {
    if (filled === null) return false
    const now = currentValues()
    return (Object.keys(filled) as DetectionInputId[]).some((id) => now[id] !== filled![id])
  }
  ctx.setUnsavedProbe(isDirty)

  /** 「既定 2.5」の添え字と、断りの付いた行の赤い枠を描き直す。 */
  const refreshMarks = (problems: readonly DetectionProblem[]): void => {
    const s = settingsFromForm(currentValues())
    for (const section of DETECTION_SECTIONS) {
      for (const row of section.rows) {
        const tr = container.querySelector<HTMLElement>(`tr[data-field="${CSS.escape(row.field)}"]`)
        if (tr === null) continue
        const mark = qs(tr, '.detection-default')
        mark.textContent = differsFromDefault(row, s) ? `既定 ${rowValueText(row, report!.defaults)}` : ''
        const bad = rowHasProblem(row, problems)
        for (const el of tr.querySelectorAll<HTMLInputElement>('input.detection-input')) el.classList.toggle('invalid', bad)
      }
    }
  }

  const fill = (values: Record<DetectionInputId, string>): void => {
    for (const el of inputs()) el.value = values[el.dataset.input as DetectionInputId] ?? ''
  }

  let report: DetectionReportView | null = null
  const render = (r: DetectionReportView): void => {
    report = r
    pendingEl.textContent = r.pending === null ? '' : PENDING_TEXT
    discardedEl.textContent = r.discardedPending === null ? '' : discardedText(r.discardedPending)
    tablesEl.innerHTML = tablesHtml(r.active)
    filled = formValues(r.pending ?? r.active)
    fill(filled)
    problemsEl.textContent = ''
    refreshMarks([])
    form.hidden = false
  }

  const showProblems = (problems: readonly DetectionProblem[]): void => {
    problemsEl.textContent = problemLines(problems).join('\n')
    refreshMarks(problems)
  }

  form.addEventListener(
    'input',
    () => {
      statusEl.textContent = ''
      // 入力のたびに断りを出し直すと、打ち終わる前から赤くなる。添え字だけ追い、断りは保存のときに出す。
      // 前の断りの文も消す（赤い枠だけ消えて文が残ると食い違う）。
      problemsEl.textContent = ''
      refreshMarks([])
    },
    { signal },
  )

  qs(container, '.detection-reset').addEventListener(
    'click',
    () => {
      if (report === null) return
      fill(formValues(report.defaults))
      statusEl.textContent = ''
      problemsEl.textContent = ''
      refreshMarks([])
    },
    { signal },
  )

  form.addEventListener(
    'submit',
    (e) => {
      e.preventDefault()
      if (saving || report === null) return
      statusEl.textContent = ''
      const settings = settingsFromForm(currentValues())
      const problems = problemsOf(settings)
      if (problems.length > 0) {
        showProblems(problems)
        return
      }
      // 前に断った行を残したまま送らない（直した後も赤いままに見える）。
      showProblems([])
      saving = true
      void (async () => {
        try {
          const r = await apiFetch<DetectionReportView>('/api/detection', {
            method: 'PUT',
            body: JSON.stringify({ pendingDetection: settings }),
            signal,
          })
          if (signal.aborted) return
          render(r)
          statusEl.textContent = r.pending === null ? SAME_AS_ACTIVE_TEXT : SAVED_TEXT
        } catch (error) {
          if (signal.aborted) return
          const fromHost = problemsInError(error)
          if (fromHost !== null) showProblems(fromHost)
          else statusEl.textContent = describeFailure(error)
        } finally {
          saving = false
        }
      })()
    },
    { signal },
  )

  try {
    const r = await apiFetch<DetectionReportView>('/api/detection', { signal })
    if (signal.aborted) return
    render(r)
  } catch (error) {
    if (signal.aborted) return
    errorEl.textContent = describeFailure(error)
  }
}
