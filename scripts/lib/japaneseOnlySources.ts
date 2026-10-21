/**
 * ソースのうち「日本語で書く」と決めた文面を取り出す。判定は `japaneseOnly.ts`。
 *
 * 取り出すもの:
 * - TS/JS: 次の文面（引数に直接書いた文字列・テンプレート・`+` で繋いだもの。変数を経たものは追えない）
 *   - `new Error(…)`・名前が Error / Exception で終わる型（自前のエラー型・`DOMException`）の引数
 *   - Error を継ぐクラスの中の `super(…)` の引数
 *   - `console.*`・`log.*`・`logger.*`（`server.config.logger.info` のような連鎖の末尾も）の引数
 *   - `err.message = '…'`・`throw '…'`
 * - ファーム（.ino / .h）: `Serial.print*`・`http.send`・`static_assert` へ渡す文字列
 * - Codex の設定: `.codex/**\/*.toml` の値と `.agents/**\/*.md` の地の文
 * - CI: `.github/workflows/*.yml` の `name:` とコメント
 */

import ts from 'typescript'

export interface ExtractedText {
  /** 1 始まりの行番号。 */
  line: number
  text: string
}

const ERROR_CONSTRUCTORS = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError'])
const LOG_OBJECTS = new Set(['console', 'log'])
const LOG_METHODS = new Set(['log', 'debug', 'info', 'warn', 'error'])

/** 引数に直接書いた文字列を、テンプレートの式を空けて 1 本にする。文字列でなければ null。 */
function literalText(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' ')
  }
  if (ts.isParenthesizedExpression(node)) return literalText(node.expression)
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const parts = [literalText(node.left), literalText(node.right)].filter((p): p is string => p !== null)
    return parts.length === 0 ? null : parts.join(' ')
  }
  if (ts.isConditionalExpression(node)) {
    const parts = [literalText(node.whenTrue), literalText(node.whenFalse)].filter((p): p is string => p !== null)
    return parts.length === 0 ? null : parts.join(' / ')
  }
  return null
}

/** 呼び出し先の名前（`a.b.logger.warn` なら `warn`、その手前の `logger`）。 */
function lastName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text
  return null
}

function isTargetCall(callee: ts.Expression): boolean {
  if (ts.isIdentifier(callee)) {
    // `Error`・`TypeError` に加え、名前が Error / Exception で終わるもの（自前のエラー型・DOMException）
    return ERROR_CONSTRUCTORS.has(callee.text) || /(?:Error|Exception)$/.test(callee.text)
  }
  if (ts.isPropertyAccessExpression(callee) && LOG_METHODS.has(callee.name.text)) {
    // `console.warn`・`log.warn` に加え、`logger.warn`・`server.config.logger.info` のような連鎖の末尾
    const owner = lastName(callee.expression)
    return owner !== null && (LOG_OBJECTS.has(owner) || /^(?:logger|console)$/i.test(owner))
  }
  return false
}

/** `class FooError extends Error` の中か（`super('…')` の文面を拾うため）。 */
function inErrorClass(node: ts.Node): boolean {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isClassLike(p)) {
      return (p.heritageClauses ?? []).some((h) => h.types.some((t) => /(?:Error|Exception)$/.test(t.expression.getText())))
    }
  }
  return false
}

export function extractFromScript(fileName: string, source: string): ExtractedText[] {
  const kind = /\.[jt]sx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind)
  const out: ExtractedText[] = []
  const push = (expr: ts.Expression): void => {
    const text = literalText(expr)
    if (text !== null) out.push({ line: sf.getLineAndCharacterOfPosition(expr.getStart()).line + 1, text })
  }
  const visit = (node: ts.Node): void => {
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && isTargetCall(node.expression)) {
      for (const arg of node.arguments ?? []) push(arg)
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword && inErrorClass(node)) {
      for (const arg of node.arguments) push(arg)
    } else if (
      ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(node.left) && node.left.name.text === 'message'
    ) {
      push(node.right) // `err.message = '…'`
    } else if (ts.isThrowStatement(node) && node.expression) {
      push(node.expression) // `throw '…'`（`throw new Error` は上で拾うので、文字列のときだけ結果が出る）
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

const FIRMWARE_CALL = /\b(?:Serial\.(?:printf|println|print)|http\.send|static_assert)\s*\(/g

/** C の文字列リテラルの中身（エスケープは残したまま）。 */
function cStrings(segment: string): string[] {
  const out: string[] = []
  const re = /"((?:[^"\\\n]|\\.)*)"/g
  for (let m = re.exec(segment); m !== null; m = re.exec(segment)) out.push((m[1] as string).replace(/\\[nrt]/g, ' '))
  return out
}

export function extractFromFirmware(source: string): ExtractedText[] {
  const out: ExtractedText[] = []
  for (let m = FIRMWARE_CALL.exec(source); m !== null; m = FIRMWARE_CALL.exec(source)) {
    // 対応する閉じ括弧まで（文字列の中の括弧は数えない）
    let depth = 0
    let end = m.index + m[0].length - 1
    for (let i = end, inString = false; i < source.length; i++) {
      const c = source[i]
      if (inString) {
        if (c === '\\') i++
        else if (c === '"') inString = false
        continue
      }
      if (c === '"') inString = true
      else if (c === '(') depth++
      else if (c === ')' && --depth === 0) {
        end = i
        break
      }
    }
    const line = source.slice(0, m.index).split('\n').length
    for (const text of cStrings(source.slice(m.index, end + 1))) out.push({ line, text })
  }
  return out
}

/** 値が識別子だけのキー（`name = "architect"` など）。訳さない。 */
const TOML_IDENTIFIER_KEYS = new Set(['name', 'model', 'model_reasoning_effort', 'sandbox_mode', 'approval_policy'])

export function extractFromToml(source: string): ExtractedText[] {
  const out: ExtractedText[] = []
  // 複数行の値の終わりの印（`"""`・`'''`・配列の `]`）。null なら 1 行の値を読んでいるところ
  let closing: string | null = null
  source.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim()
    if (closing !== null) {
      if (line.endsWith(closing)) closing = null
      const text = line.endsWith('"""') || line.endsWith("'''") ? line.slice(0, -3) : line
      if (text !== '') out.push({ line: i + 1, text })
      return
    }
    if (line.startsWith('#')) {
      out.push({ line: i + 1, text: line.slice(1) })
      return
    }
    const kv = /^([\w.-]+)\s*=\s*(.*)$/.exec(line)
    if (kv === null) return
    const [, key, value] = kv as unknown as [string, string, string]
    const skip = TOML_IDENTIFIER_KEYS.has(key)
    const fence = value.startsWith('"""') ? '"""' : value.startsWith("'''") ? "'''" : null
    if (fence !== null) {
      const rest = value.slice(3)
      if (rest.endsWith(fence) && rest.length >= 3) {
        if (!skip) out.push({ line: i + 1, text: rest.slice(0, -3) })
      } else {
        closing = fence
        if (rest !== '' && !skip) out.push({ line: i + 1, text: rest })
      }
      return
    }
    if (value.startsWith('[') && !value.endsWith(']')) closing = ']'
    if (!skip) out.push({ line: i + 1, text: value.replace(/^(["'])(.*)\1$/, '$2') })
  })
  return out
}

/** Markdown の地の文（コードの囲みの中と、前置きの `name:` は外す）。 */
export function extractFromMarkdown(source: string): ExtractedText[] {
  const out: ExtractedText[] = []
  const lines = source.split(/\r?\n/)
  let fence = false
  let frontMatter = lines[0]?.trim() === '---'
  lines.forEach((raw, i) => {
    if (i === 0 && frontMatter) return
    if (frontMatter) {
      if (raw.trim() === '---') {
        frontMatter = false
        return
      }
      const kv = /^([\w-]+):\s*(.*)$/.exec(raw)
      if (kv !== null && kv[1] !== 'name') out.push({ line: i + 1, text: kv[2] as string })
      return
    }
    if (/^\s*(```|~~~)/.test(raw)) {
      fence = !fence
      return
    }
    if (!fence && raw.trim() !== '') out.push({ line: i + 1, text: raw })
  })
  return out
}

/**
 * CI の `name:` とコメント（行頭の `#`・行末の ` # …`）。`name: >-` のように折り畳んだ値は、
 * 字下げが深い続きの行も名前として拾う。`run:` の中のコマンド（`echo` の文面など）は見ない。
 */
export function extractFromWorkflow(source: string): ExtractedText[] {
  const out: ExtractedText[] = []
  let foldedIndent: number | null = null // 折り畳んだ `name:` の字下げ。続きの行はこれより深い
  source.split(/\r?\n/).forEach((raw, i) => {
    const indent = raw.length - raw.trimStart().length
    if (foldedIndent !== null) {
      if (raw.trim() !== '' && indent > foldedIndent) {
        out.push({ line: i + 1, text: raw.trim() })
        return
      }
      foldedIndent = null
    }
    const comment = /^\s*#(.*)$/.exec(raw)
    if (comment !== null) {
      out.push({ line: i + 1, text: comment[1] as string })
      return
    }
    // 行末のコメント（引用符の外にある ` # `）
    const trailing = /^[^'"#]*\s#\s(.*)$/.exec(raw)
    if (trailing !== null) out.push({ line: i + 1, text: trailing[1] as string })
    const name = /^\s*(?:-\s+)?name:\s*(.+?)\s*$/.exec(raw.replace(/\s#\s.*$/, ''))
    if (name === null) return
    const value = name[1] as string
    if (/^[>|][-+]?$/.test(value)) {
      foldedIndent = indent
      return
    }
    out.push({ line: i + 1, text: value.replace(/^(['"])(.*)\1$/, '$2') })
  })
  return out
}
