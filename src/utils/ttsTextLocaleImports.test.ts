// 本体のファイルが、読み上げの文を組む関数を `ttsText.ts` から直に読んでいないことを確かめる。
//
// `ttsText.ts` が今の名前で書き出す関数（`earthquakeToText` など）は日本語の組のもの。本体がそれを直に呼ぶと、
// 画面の言語によらず日本語で読む ―― 型チェックは通り、日本語の画面では誰も気づけない。画面の言語の読み上げは
// `speechTextFor` で引いた組から組む決まり（→ `ttsText.ts` の `createSpeechText`）。
//
// 許すのは、言語に依らない名前（既読の記録・件数の上限・選抜・電文の文の割り方）と、組を引く関数・日本語の組そのもの
// （`JA_SPEECH_TEXT` は、既読の鍵だけを取って声にしない経路で使う）。テスト・計測台は日本語の文面を照合するので対象外。
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ALLOWED = new Set([
  'speechTextFor', 'createSpeechText', 'JA_SPEECH_TEXT',
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

/**
 * 日本語の組（`JA_SPEECH_TEXT`）を本体で使ってよいファイル。既読の鍵だけを取って声にしない経路だけ（→ ttsText.ts の createSpeechText）。
 * 使う所を足すときは、声にしない経路であることを確かめてからここへ足す
 */
const JA_SPEECH_TEXT_FILES = new Set(['src/hooks/useLiveEventHandler.ts'])

describe('本体は読み上げの文を組む関数を画面の言語の組から引く', () => {
  it('ttsText から直に読む値は、言語に依らない名前と組を引く関数だけ', () => {
    const offenders: string[] = []
    for (const file of sourceFiles('src')) {
      const rel = relative('.', file).replace(/\\/g, '/')
      if (rel === 'src/utils/ttsText.ts') continue
      const src = readFileSync(file, 'utf8')
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

  it('照合は組を丸ごと取る書き方を拾う', () => {
    expect(wholeModuleAccesses("import * as t from '../utils/ttsText'")).toHaveLength(1)
    expect(wholeModuleAccesses("const m = await import('./ttsText')")).toHaveLength(1)
    expect(wholeModuleAccesses("export { earthquakeToText } from './ttsText'")).toHaveLength(1)
    expect(wholeModuleAccesses("export * from './ttsText'")).toHaveLength(1)
    expect(wholeModuleAccesses("import { speechTextFor } from './ttsText'")).toEqual([])
  })
})
