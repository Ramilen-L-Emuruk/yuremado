// 共有タスクの一覧から、完了したタスクを控えのフォルダへ移す。
//
// タスク機能はしばらく使わずにいると、一覧を完了分まで丸ごと会話へ差し込む。完了分が溜まると
// その 1 回が数万トークンになり、会話の文脈の大半を食う。/release の手順 8 でタスクを閉じた後に走らせ、
// 一覧を未完了の分だけに保つ。
//
// どの一覧かは .claude/settings.json の CLAUDE_CODE_TASK_LIST_ID で決まる。中身は端末の
// ~/.claude/tasks/<ID>/ にあり、移し先は隣の ~/.claude/tasks/<ID>-archive/。消さずに移すので、
// 移した分は TaskList には出ないが grep で引け、ファイルを戻せば元に戻る。
//
// 移さないものが 2 つある。
//   - 件名に「リリース待ち」を含む完了タスク: リリースのときに件名を「リリース済み」へ直す決まりで、移すと直せなくなる
//   - 番号がいちばん大きいタスク: ハーネスは次の番号を残ったファイルから決めるとみられ、最大の番号を移すと
//     同じ番号がまた使われうる。番号の控え（.highwatermark）はハーネスの内部ファイルなので触らずに、1 件残して防ぐ
//
// 移した番号は、残ったタスクの待ち先（blockedBy・blocks）から外す。外さないと、ファイルが無くなった待ち先を
// TaskList が未完了と読み、終わった前提を待ち続けるように見える。
//
// 他のセッションが同時にタスクを書き換えていることがある。書き戻しは一時ファイルから名前を付け替えて行い、
// 書く直前に読み直して中身が変わっていれば書かない。
//
// 終了コード: 0 = すべて済んだ / 1 = 控えと名前が重なったタスクを残した / 2 = 読めない・移せない・書けないファイルがあった
//
// 使い方: node scripts/archive-completed-tasks.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const fail = (message) => {
  console.error(message)
  process.exit(2)
}

let listId
try {
  listId = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8')).env?.CLAUDE_CODE_TASK_LIST_ID
} catch (err) {
  fail(`.claude/settings.json を読めません: ${err.message}`)
}
if (typeof listId !== 'string' || listId === '') fail('.claude/settings.json に CLAUDE_CODE_TASK_LIST_ID がありません')

const tasksDir = path.join(os.homedir(), '.claude', 'tasks', listId)
const archiveDir = `${tasksDir}-archive`
if (!fs.existsSync(tasksDir)) fail(`タスクの一覧が見つかりません: ${tasksDir}`)

const TASK_FILE = /^\d+\.json$/
// このスクリプトの書き戻しが作る一時ファイルの名前（replaceFile と揃える）
const OWN_TEMP_FILE = /^\.\d+\.json\.tmp$/
// 残った一時ファイルを片付けるのは、これより古いものだけ（同時に走っている書き戻しの途中のものを消さない）
const STALE_TEMP_MS = 10 * 60 * 1000
const idOf = (name) => name.split('.')[0]
const listDir = (dir) => {
  try {
    return fs.readdirSync(dir)
  } catch (err) {
    fail(`フォルダを開けません: ${dir}（${err.message}）`)
  }
}
const taskNames = (dir) => listDir(dir).filter((name) => TASK_FILE.test(name))
try {
  fs.mkdirSync(archiveDir, { recursive: true })
} catch (err) {
  fail(`控えのフォルダを作れません: ${archiveDir}（${err.message}）`)
}

// 読めないファイルは移す判定と待ち先の書き戻しで 2 度読むので、同じ報告を重ねない
const problems = new Set()
const collisions = []

// 前の実行が書き戻しの途中で落ちて残した一時ファイルを片付ける
for (const name of listDir(tasksDir)) {
  if (!OWN_TEMP_FILE.test(name)) continue
  try {
    const file = path.join(tasksDir, name)
    if (Date.now() - fs.statSync(file).mtimeMs < STALE_TEMP_MS) continue
    fs.unlinkSync(file)
  } catch (err) {
    // 見てから消すまでの間に先に消えていたなら、片付けは済んでいる
    if (err.code === 'ENOENT') continue
    problems.add(`残っていた一時ファイルを消せなかった: ${name}（${err.code ?? err.message}）`)
  }
}

// 読めなかったファイルは null を返し、触らずに残す（書きかけのファイルを掴んだときもここへ来る）
const readTask = (file) => {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const task = JSON.parse(raw)
    if (task === null || typeof task !== 'object') throw new Error('中身がオブジェクトではない')
    return { raw, task }
  } catch (err) {
    problems.add(`読めなかった: ${path.basename(file)}（${err.message}）`)
    return null
  }
}

// 一時ファイルに書いてから名前を付け替える。失敗したら一時ファイルを消し、元のファイルはそのまま残す
const replaceFile = (file, content) => {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp`)
  try {
    fs.writeFileSync(tmp, content)
    fs.renameSync(tmp, file)
    return true
  } catch (err) {
    problems.add(`書けなかった: ${path.basename(file)}（${err.code ?? err.message}）`)
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      problems.add(`一時ファイルを消せなかった: ${path.basename(tmp)}（次の実行で片付ける）`)
    }
    return false
  }
}

const highestId = Math.max(0, ...taskNames(tasksDir).map((name) => Number(idOf(name))))
let moved = 0
let keptPending = 0
let keptHighest = 0
for (const name of taskNames(tasksDir)) {
  const read = readTask(path.join(tasksDir, name))
  if (read === null || read.task.status !== 'completed') continue
  if (typeof read.task.subject === 'string' && read.task.subject.includes('リリース待ち')) {
    keptPending++
    continue
  }
  if (Number(idOf(name)) === highestId) {
    keptHighest++
    continue
  }
  // 同じ名前が控えにあれば上書きしない
  if (fs.existsSync(path.join(archiveDir, name))) {
    collisions.push(name)
    continue
  }
  try {
    fs.renameSync(path.join(tasksDir, name), path.join(archiveDir, name))
    moved++
  } catch (err) {
    problems.add(`移せなかった: ${name}（${err.code ?? err.message}）`)
  }
}

const activeIds = new Set(taskNames(tasksDir).map(idOf))
const archivedIds = new Set(taskNames(archiveDir).map(idOf))
// 外すのは控えにあって一覧にもう無い番号だけ。控えと名前が重なって移さなかったタスクは一覧に残るので、待ち先からも外さない
const isArchived = (id) => archivedIds.has(String(id)) && !activeIds.has(String(id))
let unblocked = 0
for (const name of taskNames(tasksDir)) {
  const file = path.join(tasksDir, name)
  const read = readTask(file)
  if (read === null) continue
  const next = { ...read.task }
  let changed = false
  for (const key of ['blockedBy', 'blocks']) {
    if (!Array.isArray(next[key])) continue
    const kept = next[key].filter((id) => !isArchived(id))
    if (kept.length === next[key].length) continue
    next[key] = kept
    changed = true
  }
  if (!changed) continue
  // 読んでから今までに別のセッションが書き換えていたら、その更新を消さないよう書かずに残す（次の実行で外れる）
  let current
  try {
    current = fs.readFileSync(file, 'utf8')
  } catch (err) {
    problems.add(`読み直せなかったので待ち先を外さなかった: ${name}（${err.code ?? err.message}）`)
    continue
  }
  if (current !== read.raw) {
    problems.add(`読んだ後に書き換わったので待ち先を外さなかった: ${name}`)
    continue
  }
  if (replaceFile(file, JSON.stringify(next, null, 2))) unblocked++
}

console.log(`控えへ移した: ${moved} 件（${archiveDir}）`)
console.log(
  `待ち先を外した: ${unblocked} 件・リリース待ちで残した: ${keptPending} 件・番号の最大で残した: ${keptHighest} 件・一覧に残った: ${activeIds.size} 件`,
)
for (const name of collisions) console.error(`控えに同じ名前があるので移さなかった: ${name}`)
for (const problem of problems) console.error(problem)
if (problems.size > 0) process.exit(2)
if (collisions.length > 0) process.exit(1)
