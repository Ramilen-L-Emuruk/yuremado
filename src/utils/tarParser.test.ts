// tar 展開の単体テスト。
// 重点は「壊れたアーカイブを無言で握り潰さないこと」。サイズヘッダが読めない場合に
// 黙って打ち切ると、呼び出し側は正常終了と区別できず、以降のファイルが丸ごと消える。
import { describe, it, expect } from 'vitest'
import { parseTar } from './tarParser'

const HEADER = 512
const enc = new TextEncoder()

/** tar のヘッダブロックを 1 つ作る。sizeField を渡すと壊れたサイズ欄を再現できる。 */
function makeHeader(name: string, size: number, sizeField?: string, typeFlag = '0'): Uint8Array {
  const h = new Uint8Array(HEADER)
  h.set(enc.encode(name).subarray(0, 100), 0)
  h.set(enc.encode(sizeField ?? size.toString(8).padStart(11, '0')), 124)
  h[156] = typeFlag.charCodeAt(0) // 0 は通常ファイル、x は次のファイルの pax の拡張の頭
  return h
}

/** ファイル群から tar バイト列を組み立てる（末尾はゼロブロック 2 つ）。 */
function makeTar(files: Array<{ name: string; content: string; sizeField?: string; typeFlag?: string }>): Uint8Array {
  const blocks: Uint8Array[] = []
  for (const f of files) {
    const body = enc.encode(f.content)
    blocks.push(makeHeader(f.name, body.length, f.sizeField, f.typeFlag))
    const padded = new Uint8Array(Math.ceil(body.length / HEADER) * HEADER)
    padded.set(body)
    blocks.push(padded)
  }
  blocks.push(new Uint8Array(HEADER * 2))

  const total = blocks.reduce((n, b) => n + b.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const b of blocks) { out.set(b, offset); offset += b.length }
  return out
}

const decode = (b: Uint8Array) => new TextDecoder().decode(b)

describe('parseTar', () => {
  it('複数ファイルを名前と中身つきで取り出す', () => {
    const tar = makeTar([
      { name: 'telegrams.json', content: '[{"id":"a"}]' },
      { name: 'body.json', content: '{"type":"VXSE53"}' },
    ])
    const entries = [...parseTar(tar)]

    expect(entries.map(e => e.name)).toEqual(['telegrams.json', 'body.json'])
    expect(decode(entries[0].content)).toBe('[{"id":"a"}]')
    expect(decode(entries[1].content)).toBe('{"type":"VXSE53"}')
  })

  it('512 バイト境界をまたぐファイルも正しく切り出す', () => {
    const content = 'x'.repeat(1500)
    const entries = [...parseTar(makeTar([{ name: 'big.json', content }, { name: 'after.json', content: 'ok' }]))]

    expect(decode(entries[0].content)).toBe(content)
    // 直後のファイルまで到達できることがパディング計算の正しさを示す
    expect(decode(entries[1].content)).toBe('ok')
  })

  it('ゼロブロックで終端し、余分なエントリを返さない', () => {
    expect([...parseTar(makeTar([{ name: 'only.json', content: 'a' }]))]).toHaveLength(1)
  })

  it('空の tar は 0 件', () => {
    expect([...parseTar(new Uint8Array(HEADER * 2))]).toHaveLength(0)
  })

  it('サイズヘッダが壊れていたら throw する（無言で打ち切らない）', () => {
    // 旧実装は size=NaN で offset を汚染し、while 条件が false になって静かに終了していた。
    // 呼び出し側から見ると「そこから先のファイルが存在しなかった」のと区別がつかない。
    const tar = makeTar([{ name: 'broken.json', content: 'a', sizeField: 'zzzzzzzzzzz' }])
    expect(() => [...parseTar(tar)]).toThrow(/tar 破損/)
  })

  it('pax の拡張の頭が名乗る完全な名前で、次の 1 ファイルを返す（100 バイトを超える名前）', () => {
    // 中継の束のファイル名は電文 id（96 文字）を丸ごと含み 125 バイトになる。ustar の名前の欄には切り詰めた名前しか無い
    const long = `VXSE53_20261030010203456_${'f'.repeat(96)}.xml`
    const record = (len: number) => `${len} path=${long}\n`
    const pax = record(record(0).length + 2) // 長さは自分の桁数を含む（0 の 1 桁を 3 桁に置き換える）
    expect(enc.encode(pax).length).toBe(Number.parseInt(pax, 10))
    const entries = [...parseTar(makeTar([
      { name: 'telegrams.json', content: '[]' },
      { name: `PaxHeader/${long}`, content: pax, typeFlag: 'x' },
      { name: long, content: '<Report/>' },
      { name: 'after.xml', content: 'ok' },
    ]))]

    expect(entries.map(e => e.name)).toEqual(['telegrams.json', long, 'after.xml'])
    expect(decode(entries[1].content)).toBe('<Report/>')
  })

  it('pax の名前は直後の 1 件にだけ効き、通常ファイルでない項目を挟んでも次へ持ち越さない', () => {
    const entries = [...parseTar(makeTar([
      { name: 'PaxHeader/dir', content: '16 path=longdir\n', typeFlag: 'x' },
      { name: 'dir', content: '', typeFlag: '5' },
      { name: 'plain.xml', content: 'ok' },
    ]))]
    expect(entries.map(e => e.name)).toEqual(['plain.xml'])
  })

  it('pax の記録の長さが読めなければ throw する（切り詰めた名前で黙って返さない）', () => {
    const tar = makeTar([
      { name: 'PaxHeader/x', content: '999 path=x\n', typeFlag: 'x' },
      { name: 'x', content: 'a' },
    ])
    expect(() => [...parseTar(tar)]).toThrow(/tar 破損/)
  })

  it('壊れたヘッダより前のエントリは取り出せている（打ち切り位置が分かる）', () => {
    const tar = makeTar([
      { name: 'good.json', content: 'ok' },
      { name: 'broken.json', content: 'a', sizeField: 'zzzzzzzzzzz' },
    ])
    const collected: string[] = []
    expect(() => {
      for (const e of parseTar(tar)) collected.push(e.name)
    }).toThrow(/tar 破損/)
    expect(collected).toEqual(['good.json'])
  })
})
