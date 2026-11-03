export interface TarEntry {
  name: string
  content: Uint8Array
}

const HEADER = 512
const dec = new TextDecoder()

export function* parseTar(bytes: Uint8Array): Generator<TarEntry> {
  let offset = 0
  // 直前の pax の拡張の頭（種類 x）が名乗った名前。直後の 1 件にだけ効く（通常ファイルでなくても消費する）。
  // 中継の束は電文 id を丸ごと含むファイル名（100 バイト超）を使うので、ustar の名前の欄には切り詰めた名前しか無い
  let paxPath: string | null = null
  while (offset + HEADER <= bytes.length) {
    const header = bytes.subarray(offset, offset + HEADER)
    if (header.every((b) => b === 0)) break

    const name = dec.decode(header.subarray(0, 100)).replace(/\0.*/, '')
    const sizeOctal = dec.decode(header.subarray(124, 136)).replace(/\0.*/, '').trim()
    const size = parseInt(sizeOctal, 8)
    const typeFlag = String.fromCharCode(header[156])

    offset += HEADER

    // サイズが読めないヘッダに当たったら、そこで打ち切らず必ず投げる。
    // 黙って続けると offset が NaN に汚染され、次の while 判定が常に false になって
    // ジェネレータが正常終了と区別つかない形で終わる（＝以降の全エントリが無言で消える）。
    if (Number.isNaN(size)) {
      throw new Error(`tar 破損: サイズヘッダを解析できない (offset=${offset - HEADER}, name="${name}")`)
    }

    if (typeFlag === 'x') {
      paxPath = readPaxPath(bytes.subarray(offset, offset + size)) ?? paxPath
    } else {
      const fullName = paxPath ?? name
      paxPath = null
      if ((typeFlag === '0' || typeFlag === '\0') && fullName) {
        yield { name: fullName, content: bytes.subarray(offset, offset + size) }
      }
    }

    offset += Math.ceil(size / HEADER) * HEADER
  }
}

/** pax の拡張の頭の中身（`<長さ> <鍵>=<値>\n` の並び）から path を読む。無ければ null */
function readPaxPath(body: Uint8Array): string | null {
  let path: string | null = null
  // 長さはバイトで数える（値に多バイト文字があってもずれないように）
  for (let i = 0; i < body.length;) {
    const sp = body.indexOf(0x20, i)
    if (sp < 0) break
    const len = Number.parseInt(dec.decode(body.subarray(i, sp)), 10)
    if (!Number.isInteger(len) || len <= sp - i || i + len > body.length) {
      throw new Error(`tar 破損: pax の記録の長さが読めない (位置=${i})`)
    }
    const kv = dec.decode(body.subarray(sp + 1, i + len)).replace(/\n$/, '')
    const eq = kv.indexOf('=')
    if (eq > 0 && kv.slice(0, eq) === 'path') path = kv.slice(eq + 1)
    i += len
  }
  return path
}
