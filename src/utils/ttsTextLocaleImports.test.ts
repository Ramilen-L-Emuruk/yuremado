// 本体のファイルが、読み上げの文を組む関数を `ttsText.ts` から直に読んでいないことを確かめる。
//
// `ttsText.ts` が今の名前で書き出す関数（`earthquakeToText` など）は日本語の組のもの。本体がそれを直に呼ぶと、
// 画面の言語によらず日本語で読む ―― 型チェックは通り、日本語の画面では誰も気づけない。画面の言語の読み上げは
// `speechTextFor` で引いた組から組む決まり（→ `ttsText.ts` の `createSpeechText`）。
//
// 許すのは、言語に依らない名前（既読の記録・件数の上限・選抜・電文の文の割り方）と、組を引く関数・日本語の組そのもの
// （`JA_SPEECH_TEXT` は、既読の鍵だけを取って声にしない経路で使う）。テスト・計測台は日本語の文面を照合するので対象外。
import { describe, it, expect } from 'vitest'
import { readdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

const ALLOWED = new Set([
  'speechTextFor', 'createSpeechText', 'canBuildSpeechText', 'JA_SPEECH_TEXT',
  'createQuakeSpokenState', 'applySpokenRefs', 'applyTsunamiSpokenRefs',
  'selectObservationUpdatesToSpeak', 'selectArrivalsToSpeak', 'selectMissingToSpeak', 'selectWarningLevelToSpeak',
  'selectMaxHeightTimeUpdatesToSpeak', 'selectFirstWaveUpdatesToSpeak',
  'OBS_UPDATE_SPEAK_MAX_POINTS', 'ARRIVAL_SPEAK_MAX_POINTS', 'MAX_HEIGHT_TIME_SPEAK_MAX_POINTS',
  'FIRST_WAVE_UPDATE_SPEAK_MAX_POINTS', 'MISSING_SPEAK_MAX_POINTS', 'WARNING_LEVEL_SPEAK_MAX_POINTS',
  'CANCEL_REASON_INLINE_MAX_CHARS', 'domesticTsunamiFactValue', 'splitTelegramTextUnits', 'warnUnmatchedBoilerplate',
  'TELEGRAM_TEXT_BLOCK_KEYS', 'TELEGRAM_BOILERPLATE_KEYS', 'TELEGRAM_BOILERPLATE_DEFAULT_READS',
  'DOMESTIC_TSUNAMI_CODE_TEXT', 'tsunamiMaxGrade',
])

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p))
    else if (/\.tsx?$/.test(name) && !/\.(test|probe\.test|spec|d)\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p)
  }
  return out
}

/**
 * 本体のファイルの中身（`src` からの相対パス → 本文）。**ファイルを読み込む時点で、まとめて並べて読む。** テストの本体で
 * 千を超えるファイルを 1 件ずつ読むと、全件を並列で流したときだけ既定の 5 秒を超える（CLAUDE.md「多数のファイルをテスト本体で直列に読まないこと」）
 */
const SOURCES: ReadonlyMap<string, string> = new Map(await Promise.all(
  sourceFiles('src').map(async file => [relative('.', file).replace(/\\/g, '/'), await readFile(file, 'utf8')] as const),
))

const TTS_TEXT_PATH = String.raw`['"][./]+(?:utils\/)?ttsText(?:\.ts)?['"]`

/** `import { a, type B, c as d } from '…/ttsText'` の値の名前（型だけの import は外す。波括弧の中のコメントは読まない） */
function importedValues(src: string): string[] {
  const names: string[] = []
  for (const m of src.matchAll(new RegExp(String.raw`import\s+(type\s+)?\{([^}]*)\}\s+from\s+` + TTS_TEXT_PATH, 'g'))) {
    if (m[1]) continue
    const body = m[2].replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
    for (const raw of body.split(',')) {
      const part = raw.trim()
      if (!part || part.startsWith('type ')) continue
      names.push(part.split(/\s+as\s+/)[0].trim())
    }
  }
  return names
}

/** 名前を見ずに組を丸ごと取る書き方（`import * as`・動的 import・`export … from`）。拾えたものを返す */
function wholeModuleAccesses(src: string): string[] {
  const found: string[] = []
  for (const re of [
    new RegExp(String.raw`import\s+\*\s+as\s+\w+\s+from\s+` + TTS_TEXT_PATH, 'g'),
    new RegExp(String.raw`import\(\s*` + TTS_TEXT_PATH, 'g'),
    new RegExp(String.raw`export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+` + TTS_TEXT_PATH, 'g'),
  ]) {
    for (const m of src.matchAll(re)) found.push(m[0])
  }
  return found
}

/** 日本語以外の語表・画面の辞書のパス（`speech/en`・`messages/ko` など。`shared.ts` は語表の部品） */
const OTHER_LOCALE_MODULE = /(?:^|\/)(?:speech\/(?:en|zhHans|zhHant|ko|ptBR|es|shared)|messages\/(?:en|zhHans|zhHant|ko|ptBR|es))(?:\.ts)?$/

/**
 * 静的な `import`・`export … from` で読む日本語以外の語表・画面の辞書のパス。動的 import（`import('…')`）と型だけの読み込み
 * （`import type`）は束に入れないので拾わない。文の途中の引用符や括弧を越えて次の文へ伸びないよう、`from` の前に引用符・括弧を許さない
 */
function staticImportsOfOtherLocales(src: string): string[] {
  const found: string[] = []
  const re = /(?:^|\n)[ \t]*(?:import|export)\s+(?!type\b)(?:[^;'"()]*?\sfrom\s+)?['"]([^'"]+)['"]/g
  for (const m of src.matchAll(re)) {
    if (OTHER_LOCALE_MODULE.test(m[1])) found.push(m[1])
  }
  return found
}

/**
 * 日本語の組（`JA_SPEECH_TEXT`）を本体で使ってよいファイル。既読の鍵だけを取って声にしない経路だけ（→ ttsText.ts の createSpeechText）。
 * 使う所を足すときは、声にしない経路であることを確かめてからここへ足す
 */
const JA_SPEECH_TEXT_FILES = new Set(['src/hooks/useLiveEventHandler.ts'])

describe('本体は読み上げの文を組む関数を画面の言語の組から引く', () => {
  it('ttsText から直に読む値は、言語に依らない名前と組を引く関数だけ', () => {
    const offenders: string[] = []
    for (const [rel, src] of SOURCES) {
      if (rel === 'src/utils/ttsText.ts') continue
      for (const n of importedValues(src)) {
        if (!ALLOWED.has(n)) offenders.push(`${rel}: ${n}`)
        else if (n === 'JA_SPEECH_TEXT' && !JA_SPEECH_TEXT_FILES.has(rel)) offenders.push(`${rel}: JA_SPEECH_TEXT（使ってよいファイルの外）`)
      }
      for (const w of wholeModuleAccesses(src)) offenders.push(`${rel}: ${w}`)
    }
    expect(offenders).toEqual([])
  })

  // 対照: 照合の正規表現が import を拾えていること（拾えないと上のテストは何も見ずに通る）
  it('照合は import の名前を拾う', () => {
    expect(importedValues("import { earthquakeToText, type TtsSpeechOptions, JA_SPEECH_TEXT as J } from '../utils/ttsText'"))
      .toEqual(['earthquakeToText', 'JA_SPEECH_TEXT'])
    expect(importedValues("import type { TtsSpeechOptions } from './ttsText'")).toEqual([])
    expect(importedValues("import {\n  speechTextFor, // 組を引く\n  lpgmToText,\n} from './ttsText.ts'")).toEqual(['speechTextFor', 'lpgmToText'])
  })

  // 日本語以外の語表（`i18n/speech/<言語>.ts`）は画面の辞書（`messages/<言語>.ts`）から語を引く。本体が静的に読むと、
  // 言語ごとに後から読む画面の辞書が 6 言語ぶん起動の束へ入る。語表と辞書は `i18n/messages.ts` の `LOADERS` が動的 import で一緒に読む
  // （2026-11-18 ユーザー選択「辞書と一緒に後から読む (Recommended)」。→ `i18n/speechWords.ts`）。動的 import は通し、静的な読み込みだけを止める
  it('本体は日本語以外の語表と画面の辞書を静的に読まない', () => {
    const offenders: string[] = []
    for (const [rel, src] of SOURCES) {
      // 語表どうし（語表は自分の言語の辞書と `shared.ts` を静的に読む。どちらも同じ言語の後読みの束に乗る）
      if (/^src\/i18n\/speech\//.test(rel)) continue
      for (const target of staticImportsOfOtherLocales(src)) offenders.push(`${rel}: ${target}`)
    }
    expect(offenders).toEqual([])
  })

  // 対照: 静的な読み込みを拾い、動的 import と型だけの読み込みは拾わない（拾えないと上のテストは何も見ずに通る）
  it('照合は静的な読み込みだけを拾う', () => {
    expect(staticImportsOfOtherLocales("import { enSpeech } from './speech/en'")).toEqual(['./speech/en'])
    expect(staticImportsOfOtherLocales("import {\n  ko,\n} from '../i18n/messages/ko'")).toEqual(['../i18n/messages/ko'])
    expect(staticImportsOfOtherLocales("export { esSpeech } from './speech/es'")).toEqual(['./speech/es'])
    expect(staticImportsOfOtherLocales("import './speech/shared'")).toEqual(['./speech/shared'])
    expect(staticImportsOfOtherLocales("const load = () => import('./speech/en').then((m) => m.enSpeech)")).toEqual([])
    expect(staticImportsOfOtherLocales("import type { SpeechWords } from './speech/en'")).toEqual([])
    expect(staticImportsOfOtherLocales("import { ja } from './messages/ja'")).toEqual([])
  })

  // 正: 6 言語とも、辞書と語表を同じ読み込みの口で動的に読む（片方だけの言語があると、その言語は読み上げが日本語のまま残る）
  it('辞書の読み込みの口は、6 言語の辞書と語表を動的 import で読む', () => {
    const src = SOURCES.get('src/i18n/messages.ts') ?? ''
    for (const file of ['en', 'zhHans', 'zhHant', 'ko', 'ptBR', 'es']) {
      expect(src).toContain(`import('./messages/${file}')`)
      expect(src).toContain(`import('./speech/${file}')`)
    }
  })

  it('照合は組を丸ごと取る書き方を拾う', () => {
    expect(wholeModuleAccesses("import * as t from '../utils/ttsText'")).toHaveLength(1)
    expect(wholeModuleAccesses("const m = await import('./ttsText')")).toHaveLength(1)
    expect(wholeModuleAccesses("export { earthquakeToText } from './ttsText'")).toHaveLength(1)
    expect(wholeModuleAccesses("export * from './ttsText'")).toHaveLength(1)
    expect(wholeModuleAccesses("import { speechTextFor } from './ttsText'")).toEqual([])
  })
})
