// 国際津波関連情報（WEPA60）の読み取り。**このアプリで唯一の平文の電文**（XML でも二進でもない）。
// 型の説明と画面での扱いは `types/earthquake.ts` の `JMAInternationalTsunami`。
import type { InternationalTsunamiEvaluation, JMAInternationalTsunami } from '../types/earthquake'

const MONTHS: Readonly<Record<string, number>> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
}

/** `0003Z 25 DEC 2020` の形（UTC・分まで）を ISO 8601 にする。読めなければ null。 */
export function parseWepaTime(text: string): string | null {
  const m = /^(\d{2})(\d{2})Z\s+(\d{1,2})\s+([A-Z]{3})\s+(\d{4})$/.exec(text.trim())
  if (!m) return null
  const month = MONTHS[m[4]]
  if (month === undefined) return null
  const hour = Number(m[1])
  const minute = Number(m[2])
  const day = Number(m[3])
  if (hour > 23 || minute > 59 || day < 1 || day > 31) return null
  const d = new Date(Date.UTC(Number(m[5]), month, day, hour, minute))
  // 2 月 30 日のような繰り上がりを弾く
  if (d.getUTCDate() !== day) return null
  return d.toISOString()
}

/**
 * 報の鍵。発表時刻（分まで）と題名だけでは、同じ分に同じ題名の別の報（訂正など）が来たとき
 * 後の報を「同じ報」として捨ててしまうので、本文から作った短い指紋も入れる。
 * 同じ報をライブと取り戻しで 2 度受けたときは本文も同じなので、1 通に畳める。
 */
export function wepa60Id(time: string, title: string, text: string): string {
  // FNV-1a（32 ビット）。暗号の強さは要らない —— 同じ分・同じ題名の報どうしを分けられればよい
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `WEPA60:${time}:${title}:${h.toString(16).padStart(8, '0')}`
}

/** 通信試験の題名か。空白の幅や大文字小文字の揺れで取り違えないよう、詰めてから比べる */
function isCommunicationsTestTitle(title: string): boolean {
  return title.replace(/\s+/g, ' ').toUpperCase().includes('COMMUNICATIONS TEST')
}

type Wepa60Read = { data: JMAInternationalTsunami } | { reason: string }

/**
 * 本文の終わりの印 `=` より後ろに付く、電文の本文ではない行か。全期間の控え（2020-12〜2026-10）の 181 通で
 * 現れたのは次の 2 つと空行だけ:
 * - 制御文字 ETX（`\x03`。回線で 1 通の終わりを機械へ知らせる印）だけの行 —— 2024-05 以降の 92 通すべて
 * - ISO 8601 の時刻だけの行 —— 2021-07〜2024-04 の 73 通（気象庁の書式には無い形。73 通とも値は発表時刻 `ISSUED AT` と同じ。判定は形だけで見る）
 * 画面に出すと化けて見えるので落とす。`=` 自体は気象庁が書いた字なので残す（承認の記録は quake-spec.md §3）。
 * 知らない形は落とさない（本文を消す向きには倒さない）
 */
function isTrailerLine(line: string): boolean {
  return line === '' || /^[\x00-\x1f]+$/.test(line) || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(line)
}

function readWepa60(raw: string): Wepa60Read {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n').map(line => line.replace(/\s+$/, ''))
  while (lines.length > 0 && isTrailerLine(lines[lines.length - 1])) lines.pop()
  if (!lines[0]?.startsWith('WEPA60 ')) return { reason: `1 行目が WEPA60 で始まりません（${JSON.stringify((lines[0] ?? '').slice(0, 40))}）` }
  const title = lines[1]?.trim() ?? ''
  if (!title) return { reason: '2 行目の題名がありません' }
  const issuedLine = lines.find(line => /^\s*ISSUED AT\s/.test(line))
  if (!issuedLine) return { reason: `ISSUED AT の行がありません（題名 ${title}）` }
  const time = parseWepaTime(issuedLine.replace(/^\s*ISSUED AT\s+/, ''))
  if (!time) return { reason: `発表時刻を読めません（${JSON.stringify(issuedLine.trim())}）` }
  const originLine = lines.find(line => /^\s*ORIGIN TIME:/.test(line))
  const originTime = originLine ? parseWepaTime(originLine.replace(/^\s*ORIGIN TIME:\s*/, '')) : null
  const text = lines.join('\n')
  const bulletin = /BULLETIN NUMBER\s+(\d+)/.exec(title)
  const evaluation = readEvaluation(lines)
  return {
    data: {
      id: wepa60Id(time, title, text),
      title,
      time,
      ...(originTime && { originTime }),
      isCommunicationsTest: isCommunicationsTestTitle(title),
      text,
      ...readHypocentralParameters(lines),
      ...(bulletin && { bulletinNumber: Number(bulletin[1]) }),
      ...(evaluation && { evaluation }),
    },
  }
}

/**
 * 津波発生の可能性の文と値。**仕様で決まった 5 種だけ**（気象庁「配信資料に関する技術情報（地震火山編）第522号」別紙1（5）
 * 「Tsunamigenic Potential には以下の表現のいずれかを記す」）。全期間の控え（2020-12〜2026-10）の地震の報 163 通もすべてこの 5 種。
 */
const EVALUATIONS: readonly (readonly [string, InternationalTsunamiEvaluation])[] = [
  ['THERE IS A POSSIBILITY OF A DESTRUCTIVE OCEAN-WIDE TSUNAMI', 'oceanWide'],
  ['THERE IS A POSSIBILITY OF A DESTRUCTIVE REGIONAL TSUNAMI', 'regional'],
  ['THERE IS A POSSIBILITY OF A DESTRUCTIVE LOCAL TSUNAMI NEAR THE EPICENTER', 'localNearEpicenter'],
  ['THERE IS A VERY SMALL POSSIBILITY OF A DESTRUCTIVE LOCAL TSUNAMI', 'verySmall'],
  ['THERE IS NO POSSIBILITY OF A TSUNAMI', 'none'],
]

/** `EVALUATION` の段落（次の空行まで。文が 2 行に折れる報がある）を 5 種のどれかとして読む。どれでもなければ undefined */
function readEvaluation(lines: readonly string[]): InternationalTsunamiEvaluation | undefined {
  const at = lines.findIndex(line => /^\s*EVALUATION\s*$/.test(line))
  if (at < 0) return undefined
  const words: string[] = []
  for (let i = at + 1; i < lines.length && lines[i].trim() !== ''; i++) words.push(lines[i].trim())
  const sentence = words.join(' ').replace(/\s+/g, ' ').replace(/\.$/, '')
  return EVALUATIONS.find(([s]) => s === sentence)?.[1]
}

/**
 * 震源の値を読む（地震の報にだけある）。全期間の控え（2020-11〜2026-10）の地震の報 163 通の書式:
 * - 震央 `PRELIMINARY EPICENTER:LAT04.8NORTH LON127.4EAST`（163 通すべて。南緯は `SOUTH`）。地名はその次の行
 * - 規模 `MAG:7.0`（163 通すべて。`(MJMA)`・`(MW)` が付くことがある。深さと同じ行に書く報もある）
 * - 深さ `FOCAL DEPTH:139KM`（12 通だけ）
 * 読めない値は持たない（本文はそのまま出すので、値が欠けても電文の中身は画面に残る）。
 */
function readHypocentralParameters(lines: readonly string[]): Partial<JMAInternationalTsunami> {
  const out: Partial<JMAInternationalTsunami> = {}
  const epiAt = lines.findIndex(line => /^\s*PRELIMINARY EPICENTER:/.test(line))
  if (epiAt >= 0) {
    const m = lines[epiAt].match(/LAT\s*(\d+(?:\.\d+)?)\s*(NORTH|SOUTH)\s+LON\s*(\d+(?:\.\d+)?)\s*(EAST|WEST)/)
    if (m) {
      out.epicenter = {
        latitude: Number(m[1]) * (m[2] === 'SOUTH' ? -1 : 1),
        longitude: Number(m[3]) * (m[4] === 'WEST' ? -1 : 1),
      }
    }
    // 地名は震央の次の行（字下げされている）。空行や次の項目なら持たない
    const next = lines[epiAt + 1]
    if (next && /^\s+\S/.test(next) && !next.includes(':')) out.regionName = next.trim()
  }
  const mag = lines.join('\n').match(/MAG:\s*(\d+(?:\.\d+)?)(?:\s*\((MJMA|MW)\))?/)
  if (mag) {
    out.magnitude = Number(mag[1])
    if (mag[2]) out.magnitudeType = mag[2] === 'MJMA' ? 'Mj' : 'Mw'
  }
  const depth = lines.join('\n').match(/FOCAL DEPTH:\s*(\d+(?:\.\d+)?)\s*KM/)
  if (depth) out.depthKm = Number(depth[1])
  return out
}

/**
 * WEPA60 の本文を読む。
 *
 * 1 行目が `WEPA60 ` で始まらない・題名が無い・`ISSUED AT` の時刻が読めないときは null（書式が変わった印。
 * 理由は {@link wepa60FailureReason}）。
 * `ORIGIN TIME:` は地震の報にだけあり、読めなければ持たない（題名と本文はそのまま出せる）。
 */
export function parseWepa60Text(raw: string): JMAInternationalTsunami | null {
  const r = readWepa60(raw)
  return 'data' in r ? r.data : null
}

/** {@link parseWepa60Text} が null を返した理由（記録に残す文）。読めた本文には null */
export function wepa60FailureReason(raw: string): string | null {
  const r = readWepa60(raw)
  return 'reason' in r ? r.reason : null
}
