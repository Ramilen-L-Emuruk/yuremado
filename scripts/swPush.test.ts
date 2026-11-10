import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// public/sw-push.js は Service Worker の中で `importScripts` で読まれる素の台本なので、偽の `self` を渡して中身を走らせる。
// 見るのは、中継が付ける「鳴らさずに差し替える」印（`quiet`）の扱い（2026-11-10 ユーザー選択「鳴らさずに出し直す (Recommended)」）
const SOURCE = readFileSync(join(__dirname, '..', 'public', 'sw-push.js'), 'utf8')

interface Shown { title: string; options: Record<string, unknown> }

interface Env {
  stillShown: number
  chromium: boolean
  /** 見えている窓があるか（既定は Chromium なら見えている） */
  windowVisible?: boolean
  /** 見えている窓が「アプリを開いている間は通知しない」で止めると答えるか */
  visibleWindowAnswersQuiet?: boolean
  getNotificationsFails?: boolean
}

function runPush(payload: Record<string, unknown>, env: Env) {
  const shown: Shown[] = []
  let handler: ((ev: unknown) => void) | null = null
  const client = {
    visibilityState: env.windowVisible === false ? 'hidden' : 'visible',
    postMessage: (_msg: unknown, ports: MessagePort[]) => {
      ports[0].postMessage({ quiet: env.visibleWindowAnswersQuiet === true })
    },
  }
  const self = {
    registration: {
      scope: 'https://example.invalid/',
      showNotification: vi.fn(async (title: string, options: Record<string, unknown>) => { shown.push({ title, options }) }),
      getNotifications: vi.fn(async () => {
        if (env.getNotificationsFails) throw new Error('getNotifications に失敗')
        return Array.from({ length: env.stillShown }, () => ({}))
      }),
    },
    navigator: env.chromium ? { userAgentData: {} } : {},
    clients: { matchAll: vi.fn(async () => (env.chromium ? [client] : [])) },
    addEventListener: (type: string, fn: (ev: unknown) => void) => { if (type === 'push') handler = fn },
  }
  const quietConsole = { info: () => {}, warn: () => {}, error: () => {} }
  new Function('self', 'console', SOURCE)(self, quietConsole)
  let done: Promise<unknown> = Promise.resolve()
  handler!({ data: { json: () => payload }, waitUntil: (p: Promise<unknown>) => { done = p } })
  return done.then(() => shown)
}

const base = { title: '緊急地震速報（予報）', body: '本文', tag: 'eew-1' }

describe('sw-push.js の鳴らさずに差し替える印（quiet）', () => {
  it('対照: 印の無い報は知らせ直して鳴らす', async () => {
    const shown = await runPush(base, { stillShown: 1, chromium: false })
    expect(shown).toHaveLength(1)
    expect(shown[0].options).toMatchObject({ tag: 'eew-1', renotify: true, silent: false })
  })
  it('正: 前の通知が残っていれば、知らせ直さず鳴らさずに差し替える', async () => {
    const shown = await runPush({ ...base, quiet: true }, { stillShown: 1, chromium: true })
    expect(shown).toHaveLength(1)
    expect(shown[0].options).toMatchObject({ tag: 'eew-1', renotify: false, silent: true })
  })
  it('正: 閉じられていて Chromium 系でアプリが画面に出ていれば、出し直さない', async () => {
    const shown = await runPush({ ...base, quiet: true }, { stillShown: 0, chromium: true })
    expect(shown).toHaveLength(0)
  })
  it('安全弁: 閉じられていても、Chromium 系でなければ鳴らさずに出し直す（出さないと購読を打ち切られる）', async () => {
    const shown = await runPush({ ...base, quiet: true }, { stillShown: 0, chromium: false })
    expect(shown).toHaveLength(1)
    expect(shown[0].options).toMatchObject({ renotify: false, silent: true })
  })

  it('安全弁: Chromium 系でも窓が見えていなければ、閉じられた通知を鳴らさずに出し直す', async () => {
    const shown = await runPush({ ...base, quiet: true }, { stillShown: 0, chromium: true, windowVisible: false })
    expect(shown).toHaveLength(1)
    expect(shown[0].options).toMatchObject({ renotify: false, silent: true })
  })
  it('安全弁: 前の通知が残っているかを確かめられなければ、鳴らさずに出す', async () => {
    const shown = await runPush({ ...base, quiet: true }, { stillShown: 0, chromium: true, getNotificationsFails: true })
    expect(shown).toHaveLength(1)
    expect(shown[0].options).toMatchObject({ renotify: false, silent: true })
  })
  it('安全弁: tag の無い報は前の通知を見ずに鳴らさずに出す（既定の tag は別の報に当たる）', async () => {
    const shown = await runPush({ title: 't', body: 'b', quiet: true }, { stillShown: 0, chromium: true })
    expect(shown).toHaveLength(1)
    expect(shown[0].options).toMatchObject({ tag: 'push', renotify: false, silent: true })
  })
  it('対照: quiet は真偽値の true だけを印とみる（文字列の "true" は鳴らす）', async () => {
    const shown = await runPush({ ...base, quiet: 'true' }, { stillShown: 0, chromium: true })
    expect(shown).toHaveLength(1)
    expect(shown[0].options).toMatchObject({ renotify: true, silent: false })
  })
  it('「アプリを開いている間は通知しない」で止める答えは、quiet の判定より先に効く', async () => {
    const shown = await runPush({ ...base, quiet: true }, { stillShown: 1, chromium: true, visibleWindowAnswersQuiet: true })
    expect(shown).toHaveLength(0)
  })
})
