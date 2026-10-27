// 通知タブ（ブラウザ通知の許可と、何を知らせるかの設定。#313・2026-10-27 ユーザー承認。文言も同日承認）。
//
// 通知を出すのはこのタブではなく、画面を開いている間ずっと動く見張り（`notifyWatcher.ts`）。
// ここは許可を求めることと、設定を書くことと、見張りの不調を 1 行ずつ出すことだけをする。

import { escapeHtml, qs } from './dom'
import {
  notifyPermission,
  notifyStorage,
  onWatcherProblems,
  readNotifySettings,
  watcherProblems,
  writeNotifySettings,
  type NotifySettings,
  type WatcherProblems,
} from './notifyWatcher'
import type { TabContext } from './tabState'

/** チェックの並びと文言（2026-10-27 ユーザー承認）。 */
const CHECKS: readonly { readonly key: keyof NotifySettings; readonly label: string }[] = [
  { key: 'warnings', label: '稼働状況の警告' },
  { key: 'resolved', label: '警告の解消' },
  { key: 'shakes', label: '揺れの記録' },
]

/** 見張りの不調の行（2026-10-27 ユーザー承認「通知＋通知タブ」）。不調が無ければ空。 */
export function problemLines(p: WatcherProblems, saveFailed: boolean): readonly string[] {
  const out: string[] = []
  if (p.hostUnreachable) out.push('ホストの状態を読めない')
  if (p.streamDown) out.push('揺れの記録を受け取れていない（繋ぎ直している）')
  if (p.notifyError !== null) out.push(`通知を出せなかった: ${p.notifyError}`)
  if (saveFailed) out.push('設定を保存できなかった')
  return out
}

export async function initNotifyView(container: HTMLElement, ctx: TabContext): Promise<void> {
  const { signal } = ctx
  container.innerHTML = `
    <section class="panel">
      <div class="row">
        <button type="button" class="notify-permit" style="flex: 0 0 auto" hidden>通知を許可する</button>
        <span class="notify-blocked error" hidden>ブラウザが通知をブロックしている</span>
      </div>
      <div class="notify-checks">
        ${CHECKS.map(
          (c) => `
          <label class="row">
            <input type="checkbox" class="notify-check" data-key="${c.key}" />
            <span>${c.label}</span>
          </label>`,
        ).join('')}
      </div>
      <div class="notify-problems"></div>
    </section>
  `
  const permit = qs<HTMLButtonElement>(container, '.notify-permit')
  const blocked = qs(container, '.notify-blocked')
  const problemsEl = qs(container, '.notify-problems')
  let saveFailed = false

  const renderPermission = (): void => {
    const p = notifyPermission()
    permit.hidden = p !== 'default'
    blocked.hidden = p !== 'blocked'
  }
  const renderProblems = (): void => {
    problemsEl.innerHTML = problemLines(watcherProblems(), saveFailed)
      .map((line) => `<div class="error">${escapeHtml(line)}</div>`)
      .join('')
  }
  renderPermission()
  renderProblems()

  const off = onWatcherProblems(() => {
    if (!signal.aborted) renderProblems()
  })
  signal.addEventListener('abort', off, { once: true })

  // **ブラウザの設定で許可を変えたら、戻ってきたときに読み直す**（許可の変化を知らせる仕組みは
  // ブラウザによって無いので、画面が見えたときに見る）。
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') renderPermission()
  }
  document.addEventListener('visibilitychange', onVisible)
  signal.addEventListener('abort', () => document.removeEventListener('visibilitychange', onVisible), { once: true })

  permit.addEventListener('click', () => {
    Notification.requestPermission()
      .catch((error: unknown) => {
        console.warn('[admin] 通知の許可を求められない:', error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (!signal.aborted) renderPermission()
      })
  })

  const storage = notifyStorage()
  const settings = readNotifySettings(storage)
  for (const box of container.querySelectorAll<HTMLInputElement>('.notify-check')) {
    const key = box.dataset.key as keyof NotifySettings
    box.checked = settings[key]
    box.addEventListener('change', () => {
      saveFailed = !writeNotifySettings(storage, { ...readNotifySettings(storage), [key]: box.checked })
      renderProblems()
    })
  }
}
