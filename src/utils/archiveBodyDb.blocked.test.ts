// 版の昇格が別のタブに塞がれた間の扱いを固定する（→ `archiveBodyDb.ts` の `openDb` の `onblocked`）。
//
// **別ファイルにしてあるのは、本体のモジュールが接続を 1 本だけ持って使い回すため。** 版 1 の接続を
// 握ったまま本体を初めて読む形は、このファイルでしか作れない。
import 'fake-indexeddb/auto'
import { describe, it, expect, vi } from 'vitest'

const DB_NAME = 'dmdata-archive-bodies'

/** 版 1 のデータベースを開いたまま返す。`onversionchange` を付けないので、閉じるまで昇格を塞ぐ。 */
function holdVersion1(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1)
    open.onupgradeneeded = () => {
      const db = open.result
      db.createObjectStore('meta', { keyPath: 'id' }).createIndex('lastUsedAt', 'lastUsedAt')
      db.createObjectStore('bodies', { keyPath: 'id' })
    }
    open.onerror = () => reject(open.error)
    open.onsuccess = () => resolve(open.result)
  })
}

describe('版の昇格が別のタブに塞がれたとき', () => {
  it('塞がれている間は控えなしで答え、旧い接続が閉じたらその要求の接続を使う（開き直さない）', async () => {
    const old = await holdVersion1()
    const openSpy = vi.spyOn(indexedDB, 'open')
    const { readArchiveBody, writeArchiveBody } = await import('./archiveBodyDb')

    // 正: 塞がれている間は待たずに「控えなし」で返る
    expect(await readArchiveBody('https://x/a')).toBeNull()
    // 対照: 塞がれている間にもう一度呼んでも、2 本目の要求は出さない（出すと直列に並んで待たされる）
    expect(await readArchiveBody('https://x/a')).toBeNull()
    expect(openSpy).toHaveBeenCalledTimes(1)

    // 旧いタブが閉じると、同じ要求の昇格が通る
    old.close()
    await vi.waitFor(async () => {
      await writeArchiveBody('https://x/b', new Uint8Array([7]))
      expect(await readArchiveBody('https://x/b')).toEqual(new Uint8Array([7]))
    })
    // 安全弁: 昇格が通った後も、開き直しの要求は出ていない
    expect(openSpy).toHaveBeenCalledTimes(1)
  })
})
