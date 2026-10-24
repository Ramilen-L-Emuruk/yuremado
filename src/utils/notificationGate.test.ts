import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { sep } from 'node:path'
import { DEFAULTS } from '../hooks/useSettings'
import { effectiveNotifyMinScale, notificationAllowed, type NotificationKind } from './notificationGate'

const KINDS: NotificationKind[] = ['quake', 'detection', 'eew', 'tsunami', 'nankai']
const all = { ...DEFAULTS, notifyEnabled: true, notifyQuake: true, notifyDetection: true, notifyEEW: true, notifyTsunami: true, notifyNankai: true }

describe('notificationAllowed', () => {
  it('正: まとめて止めると、種類ごとの設定によらずどれも出さない', () => {
    for (const kind of KINDS) expect(notificationAllowed({ ...all, notifyEnabled: false }, kind)).toBe(false)
  })

  it('対照: まとめて止めていなければ、種類ごとの設定どおり', () => {
    for (const kind of KINDS) expect(notificationAllowed(all, kind)).toBe(true)
    expect(notificationAllowed({ ...all, notifyEEW: false }, 'eew')).toBe(false)
    expect(notificationAllowed({ ...all, notifyEEW: false }, 'tsunami')).toBe(true)
  })

  it('安全弁: まとめて止めても、種類ごとの値は書き換えない（戻せば元どおり）', () => {
    const off = { ...all, notifyEnabled: false, notifyEEW: false }
    expect(notificationAllowed({ ...off, notifyEnabled: true }, 'eew')).toBe(false)
    expect(notificationAllowed({ ...off, notifyEnabled: true }, 'tsunami')).toBe(true)
  })
})

describe('effectiveNotifyMinScale', () => {
  it('正: 地震情報の通知を出すときは選んだ最低震度', () => {
    expect(effectiveNotifyMinScale({ ...all, notifyMinScale: 50 })).toBe(50)
  })
  it('対照: 地震情報の通知を切る・まとめて止めると -1（通知しない）', () => {
    expect(effectiveNotifyMinScale({ ...all, notifyQuake: false, notifyMinScale: 50 })).toBe(-1)
    expect(effectiveNotifyMinScale({ ...all, notifyEnabled: false, notifyMinScale: 50 })).toBe(-1)
  })
})

// 通知を出す場所が、まとめて止める設定を迂回していないこと。種類ごとの値を直に読むと、
// まとめて止めてもその種類だけが出続ける（型検査では捕まらない）。
//
// **見るファイルは決め打ちにしない。** `src` のうち通知を出す呼び出しを含むファイルをすべて拾う
// （新しいファイルが通知を出し始めたら、自動で対象に入る）。
describe('ブラウザ通知の判定はすべて notificationAllowed を通る', () => {
  /**
   * 通知を出しうるファイルの印。`notifications.ts` は出す部品そのものなので対象から外す。
   * **呼び出しの字面だけに頼らない**: 部品を import しているファイル（別名で呼んでも import 文に名前が残る）と、
   * Service Worker 経由の `showNotification` も拾う。
   */
  const EMITTERS = /\bshowBrowserNotification\b|new Notification\(|showQuakeNotification\(|\.showNotification\(|from '(\.\.?\/)+(utils\/)?notifications'/
  const GATE_DEFINED_IN = ['src/utils/notifications.ts']
  /**
   * 種類ごとの値の名前。**`settings.` の形に限らず名前そのもので拾う**（分割代入・別名・括弧アクセスもこれで掛かる）。
   * あわせて、外した旧来の判定（最低震度が 0 以上なら通知する）の復活も拾う。
   */
  const DIRECT = /\b(notifyQuake|notifyDetection|notifyEEW|notifyTsunami|notifyNankai)\b|notifyMinScale\s*(>=|<|>)\s*-?\d/

  const sources = (readdirSync('src', { recursive: true }) as string[])
    .map(p => `src/${p.split(sep).join('/')}`)
    .filter(p => /\.(ts|tsx)$/.test(p) && !/\.(test|spec|probe\.test)\.|\.d\.ts$/.test(p))
  /** コメントを除いた本文（コメントで部品の名前を挙げているだけのファイルを、通知を出すファイルに数えない） */
  const codeOf = (p: string) => readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/).filter(line => !/^\s*\/\//.test(line)).join('\n')
  const emitters = sources.filter(p => !GATE_DEFINED_IN.includes(p) && EMITTERS.test(codeOf(p)))

  it('通知を出すファイルが見つかる（0 件なら走査そのものが壊れている）', () => {
    expect(emitters).toEqual(expect.arrayContaining(['src/App.tsx', 'src/hooks/useKyoshinAlerts.ts', 'src/hooks/useLiveEventHandler.ts']))
  })

  it('通知を出すファイルは、どれも判定の関数を import している', () => {
    const missing = emitters.filter(p => !/from '(\.\.?\/)+(utils\/)?notificationGate'/.test(readFileSync(p, 'utf8')))
    expect(missing).toEqual([])
  })

  it('通知を出すファイルが、種類ごとの値を直に読んでいない', () => {
    const hits: string[] = []
    for (const file of emitters) {
      readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
        // 依存配列（`}, [..., settings.notifyDetection])`）は値の変化を拾うためのもので、判定ではない
        if (/^\s*\}, \[/.test(line)) return
        if (/^\s*(\/\/|\*)/.test(line)) return
        if (DIRECT.test(line)) hits.push(`${file}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(hits).toEqual([])
  })

  // 対照: 検出の正規表現が、直に読む書き方を拾えること（拾えなければ上のテストは何も見ていない）
  it('直に読む書き方を拾える', () => {
    for (const line of [
      'if (settings.notifyEEW && isNew) {',
      'const { notifyTsunami } = settings',
      "if (s['notifyNankai']) {",
      'if (settings.notifyMinScale >= 0) {',
    ]) expect(DIRECT.test(line), line).toBe(true)
    // 安全弁: 判定の関数を通す書き方は拾わない
    expect(DIRECT.test("if (notificationAllowed(settings, 'eew')) {")).toBe(false)
  })
})
