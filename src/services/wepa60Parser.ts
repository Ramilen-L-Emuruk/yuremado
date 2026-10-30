// 国際津波関連情報（WEPA60）の読み取り。**このアプリで唯一の平文の電文**（XML でも二進でもない）。
// 型の説明と画面での扱いは `types/earthquake.ts` の `JMAInternationalTsunami`。
import type { JMAInternationalTsunami } from '../types/earthquake'

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

function readWepa60(raw: string): Wepa60Read {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n').map(line => line.replace(/\s+$/, ''))
  while (lines.length > 0 && (lines[lines.length - 1] === '' || lines[lines.length - 1] === '=')) lines.pop()
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
  return {
    data: {
      id: wepa60Id(time, title, text),
      title,
      time,
      ...(originTime && { originTime }),
      isCommunicationsTest: isCommunicationsTestTitle(title),
      text,
    },
  }
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
