/**
 * 到達予想トークン・予報キーの発行。
 *
 * **予報キー**（`--kind=forecast`）は、中継から緊急地震速報の予報を受けるためのキー（設計書
 * `docs/relay-server-design.md` §0 の 2026-10-31「予報キー」の行）。形も署名の方式も到達予想トークンと同じで、
 * **鍵の組だけを別にする** —— 到達予想キーを渡した相手に予報まで流れないようにするため。
 *
 * 自前計算による「特定地点への主要動到達予想」は、鍵を渡した相手だけが使える形にしてある
 * （背景と法令上の整理は `docs/spec/eew-spec.md`）。このスクリプトは**秘密鍵で署名した
 * トークンを 1 本作るだけ**で、検証はアプリ側（`src/utils/arrivalToken.ts`）が公開鍵で行う。
 *
 * **共有の文字列ではなく署名にしている理由は 2 つ。**
 * - 公開鍵は配ってよいので、アプリのソースへそのまま埋められる（漏れても偽造できない）
 * - 渡した相手ごとに発行でき、期限を切れる。共有文字列は一度出回ったら作り直すしかない
 *
 * **トークンはテキスト**（`<payload>.<signature>` の 2 部・どちらも base64url）。設定欄へ
 * 貼る・設定の書き出し（JSON）に載る・チャットで渡す、のどれもテキストでないと成り立たない。
 *
 * **JWT にはしない。** 見た目は似ているが、JWT はヘッダで署名方式を名乗る仕様なので、
 * 検証側がヘッダを信じると方式のすり替え（`alg: none` 等）に開く。ここでは方式を
 * 実装側に固定し、電文に方式を書かせない。
 *
 * 使い方:
 *   npx tsx scripts/sign-arrival-token.ts --init          # 鍵を作る（初回だけ）
 *   npx tsx scripts/sign-arrival-token.ts --subject=自分  # トークンを 1 本発行する
 *   npx tsx scripts/sign-arrival-token.ts --kind=forecast --init           # 予報キーの鍵を作る
 *   npx tsx scripts/sign-arrival-token.ts --kind=forecast --subject=自分   # 予報キーを 1 本発行する
 *
 * `--out=<ファイル>` を足すと、発行したキーだけを入れたファイル（設定の窓の「読み込む」で入れる形。
 * `src/utils/settingsIo.ts` の `KeysFile`）も書く。既にあるファイルは上書きしない。
 */
import { createSign, generateKeyPairSync } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
const ENV_PATH = resolve(REPO_ROOT, '.env.local')

/** 発行するキーの種類 */
export type KeyKind = 'arrival' | 'forecast'

/**
 * 種類ごとの置き場所と名前。
 *
 * **秘密鍵の変数は `ARRIVAL_`・`FORECAST_` で始めない。** `vite.config.ts` は `loadEnv` に
 * プレフィクスを渡して環境変数を読むので、注入対象（`ARRIVAL_TOKEN`・`FORECAST_KEY`）と同じ頭文字にすると
 * 秘密鍵までバンドルへ載りうる。
 */
export const KEY_KINDS: Record<KeyKind, {
  privateKeyVar: string
  /** dev サーバーで自動投入する自分用のキー */
  tokenVar: string
  /** キーだけのファイルでの欄の名前（`KeysFile.keys`） */
  fileKey: 'arrivalToken' | 'forecastKey'
  label: string
  /** 公開鍵を貼る先（案内に出す） */
  publicKeyTargets: string
}> = {
  arrival: {
    privateKeyVar: 'TOKEN_SIGNING_PRIVATE_KEY',
    tokenVar: 'ARRIVAL_TOKEN',
    fileKey: 'arrivalToken',
    label: '到達予想トークン',
    publicKeyTargets: 'src/utils/arrivalToken.ts の PUBLIC_KEY_SPKI_BASE64',
  },
  forecast: {
    privateKeyVar: 'TOKEN_SIGNING_FORECAST_PRIVATE_KEY',
    tokenVar: 'FORECAST_KEY',
    fileKey: 'forecastKey',
    label: '予報キー',
    publicKeyTargets: 'src/utils/forecastKey.ts の FORECAST_PUBLIC_KEY_SPKI_BASE64 と、中継の FORECAST_PUBLIC_KEY',
  },
}

/** `--kind=` を読む。指定が無ければ到達予想トークン */
export function parseKindArg(kindArg: string | undefined): KeyKind {
  if (kindArg === undefined) return 'arrival'
  if (kindArg === 'arrival' || kindArg === 'forecast') return kindArg
  throw new Error(`--kind は arrival か forecast です: ${kindArg}`)
}

/** キーだけのファイルの中身（`src/utils/settingsIo.ts` の `KeysFile` と同じ形） */
export function buildKeysFile(kind: KeyKind, token: string): string {
  return JSON.stringify({ app: 'yuremado', kind: 'keys', version: 1, keys: { [KEY_KINDS[kind].fileKey]: token } }, null, 2) + '\n'
}

/** 既定の有効期間。無期限にしないのは、渡した相手の分を失効させる手段を残すため。 */
const DEFAULT_DAYS = 365

const b64url = (buf: Buffer) => buf.toString('base64url')

/**
 * `.env.local` の中身から 1 変数を読む。**値が空の行は無かったものとして読み飛ばす。**
 *
 * 空の `TOKEN_SIGNING_PRIVATE_KEY=` があると、読み飛ばさない作りでは空文字が返り、
 * `--init` が「鍵が無い」と判断して**鍵を作り直す** —— 発行済みのトークンが全部無効になる。
 * 空の行が生まれる形は 2 つ。手で `KEY=` だけ書いた場合と、**値の行を持つ雛形からコピーして
 * 作った `.env.local`**（いまの `.env.example` はこの 2 変数について値の行を置かない。理由は
 * あちらのコメント）。**この 2 つ目が無くなっても読み飛ばしは外さない** —— 既に手元にある
 * `.env.local` はそのまま残るし、守っている損失（発行済みのトークンが全部無効）が重い。
 *
 * **行末が CRLF でも読む。** 正規表現の `.` は行終端子を含まないので、CR を残したまま
 * 当てると行末の照合に失敗して**一致しない**。`.env.local` は Windows で編集すれば CRLF に
 * なるし、Git 管理下の雛形からコピーした場合もチェックアウトの時点で CRLF になっている。
 *
 * **非空の行が 2 つ以上あったら落とす。** 黙って 1 つ選ぶと、署名鍵を取り違えても
 * 気づけない —— 手で鍵を追記して古い行を消し忘れた `.env.local` では、このスクリプトが
 * 選んだ鍵とアプリに貼ってある公開鍵が対応せず、**「トークンは出力されるのに検証に通らない」**
 * という形で表に出る（例外もログも出ない）。
 *
 * **dev サーバー側（`vite.config.ts` の `loadEnv`）とは選び方が違う。** 実測すると
 * dotenv は同じ変数を**最後の一致**で上書きし、CRLF も自ら正規化する（あちらは `ARRIVAL_` で
 * 始まる変数しか読まないので、秘密鍵はこの述語しか読まない）。**片方に寄せるのではなく、
 * 曖昧な状態そのものを残さない**ことで食い違いを消している。
 */
export function readEnvVarFromText(text: string, name: string): string | null {
  const values: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`).exec(line)
    if (!m) continue
    const value = m[1].trim()
    if (value) values.push(value)
  }
  if (values.length === 0) return null
  if (values.length > 1) {
    throw new Error(
      `${name} が ${ENV_PATH} に ${values.length} 行あります。どれを使うか決められないので、` +
        '1 行だけ残してから実行してください（値は表示しません）。',
    )
  }
  return values[0]
}

/** `.env.local` があれば読んで上の述語へ渡す。無ければ null（初回の `--init` がこの形）。 */
function readEnvVar(name: string): string | null {
  if (!existsSync(ENV_PATH)) return null
  return readEnvVarFromText(readFileSync(ENV_PATH, 'utf8'), name)
}

function init(kind: KeyKind): void {
  const { privateKeyVar, label, publicKeyTargets } = KEY_KINDS[kind]
  if (readEnvVar(privateKeyVar)) {
    throw new Error(
      `${privateKeyVar} が既に ${ENV_PATH} にあります。作り直すと発行済みの${label}が全部無効になるので、` +
        '意図しているなら手で消してから実行してください。',
    )
  }
  // ECDSA P-256。ブラウザの Web Crypto がどこでも持っている曲線で、鍵も署名も短い。
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const priv = privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer
  const pub = publicKey.export({ type: 'spki', format: 'der' }) as Buffer
  appendFileSync(ENV_PATH, `\n# ${label}の署名鍵（アプリは読まない・配らない）\n${privateKeyVar}=${priv.toString('base64')}\n`, 'utf8')
  console.log(`秘密鍵を ${ENV_PATH} へ書きました（${privateKeyVar}）。`)
  console.log(`\n公開鍵（${publicKeyTargets} へ貼る。公開してよい値）:`)
  console.log(pub.toString('base64'))
}

/**
 * `--days` の上限。**100 年。**
 *
 * 上限が要るのは打ち間違いを弾くため —— `--days=100000000000` のような値を渡すと、失効日が
 * **日時として扱える範囲（西暦 275760 年あたり）を超えた**トークンができる。受け取る側も
 * そういう期限は通さないが（→ `src/utils/arrivalToken.ts` の `isDateRepresentableMs`）、
 * **配り終えたトークンには効かない**ので発行の入口でも見る。
 *
 * 100 年という値そのものに根拠はない。失効を仕組みの中核に据えているので「実質失効しない」
 * 期限は弾きたい、という判断の表れ。もっと長くしたければ動かしてよい。
 */
const MAX_DAYS = 36_500

/**
 * `--days=` の値を読む。**読めない値と長すぎる値は、理由を分けて落とす。**
 *
 * 指定が無ければ既定（`DEFAULT_DAYS`）。**`--days=` と書いて値を空にした場合は既定へ倒さず
 * 落とす** —— 明示して空にしたのは打ち間違いなので、黙って既定を使うと気づく機会が無い。
 */
export function parseDaysArg(daysArg: string | undefined): number {
  if (daysArg === undefined) return DEFAULT_DAYS
  const days = Number(daysArg)
  if (!Number.isFinite(days) || days <= 0) throw new Error(`--days が読めません: ${daysArg}`)
  if (days > MAX_DAYS) throw new Error(`--days が長すぎます（上限 ${MAX_DAYS} 日）: ${daysArg}`)
  return days
}

function sign(kind: KeyKind, subject: string, days: number): string {
  const { privateKeyVar } = KEY_KINDS[kind]
  const b64 = readEnvVar(privateKeyVar)
  const initHint = kind === 'arrival' ? '--init' : `--kind=${kind} --init`
  if (!b64) throw new Error(`${privateKeyVar} がありません。先に ${initHint} を実行してください。`)
  const nowSec = Math.floor(Date.now() / 1000)
  // **並びを固定した JSON を自分で組む。** `JSON.stringify` のキー順は入力順なので、
  // ここで書いた順がそのまま署名対象になる。検証側は中身を読むだけで順序に依存しない。
  const payload = JSON.stringify({ sub: subject, iat: nowSec, exp: nowSec + days * 86400 })
  const payloadPart = b64url(Buffer.from(payload, 'utf8'))
  const signer = createSign('SHA256')
  signer.update(payloadPart)
  // **`ieee-p1363`（r||s の生の 64 バイト）で署名する。** 既定の DER は Web Crypto の
  // `verify('ECDSA', ...)` が受け付けない。
  const sig = signer.sign(
    { key: Buffer.from(b64, 'base64'), format: 'der', type: 'pkcs8', dsaEncoding: 'ieee-p1363' },
  )
  return `${payloadPart}.${b64url(sig)}`
}

export function main(): void {
  const args = process.argv.slice(2)
  const argOf = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(`--${name}=`.length)
  const kind = parseKindArg(argOf('kind'))
  if (args.includes('--init')) {
    init(kind)
    return
  }
  const subject = argOf('subject')
  if (!subject) {
    throw new Error('--subject=<渡す相手の名前> は必須です（--init で鍵を作ってから実行します）')
  }
  // 書き出し先は署名の前に確かめる（発行してから断ると、出力だけ流れて控えが残らない）
  const out = argOf('out')
  if (out !== undefined && (out === '' || existsSync(resolve(out)))) {
    throw new Error(`--out のファイルが空か、既にあります（上書きしません）: ${out}`)
  }
  const token = sign(kind, subject, parseDaysArg(argOf('days')))
  console.log(token)
  if (out !== undefined) {
    writeFileSync(resolve(out), buildKeysFile(kind, token), { encoding: 'utf8', flag: 'wx' })
    console.log(`\nキーだけのファイルを ${resolve(out)} へ書きました（設定の窓の「読み込む」で入れます）。`)
  }
  const { tokenVar, label } = KEY_KINDS[kind]
  if (!readEnvVar(tokenVar)) {
    appendFileSync(ENV_PATH, `\n# dev サーバーで自動投入する自分用の${label}\n${tokenVar}=${token}\n`, 'utf8')
    console.log(`\n${ENV_PATH} へ ${tokenVar} として書きました（dev サーバーで自動投入されます）。`)
  } else {
    console.log(`\n${ENV_PATH} には既に ${tokenVar} があるので上書きしていません。差し替えるなら手で書き換えてください。`)
  }
}

/**
 * **直接実行されたときだけ走らせる。**
 *
 * テストが定数を読むために import するので、読み込みだけで `main()` が動くと
 * `npm test` が鍵を作って `.env.local` へ書き込む（→ `scripts/scriptEntrypoints.test.ts`）。
 */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (err) {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  }
}
