// 版 1 で控えたアーカイブ本体を、版 2 へ上げるときに一度だけ捨てることを固定する（→ `archiveBodyDb.ts` の `DB_VERSION`）。
//
// 別ファイルにしてあるのは、本体のモジュールが接続を 1 本だけ持って使い回すため。モジュールはファイルごとに
// 分かれるので、ここでは接続がまだ開いていない状態から、版 1 を作ってから本体を初めて呼べる。
//
// **本体はファイルの上で読む（テストの中で `await import` しない）。** 接続は最初の読み書き（`openDb`）で
// 開き、読み込んだだけでは開かない。テストの中で初めて読むと、全件並列のときはモジュールの解決が他の
// ワーカーとの順番待ちで数秒に伸び、それが丸ごとテストの上限（5 秒）に乗って時間切れになっていた
// （単独なら 63〜95 ms）。上で読めば待ちはファイルの読み込みへ移り、上限の外になる。
// なお、先に接続を開いていても、版 1 を作る要求で本体の接続は自分から閉じる（`onversionchange`）ので、
// このテストは同じように通る（2026-10-21 に、版 1 を作る前に読ませる形で回して確かめた）。
import 'fake-indexeddb/auto'
import { describe, it, expect } from 'vitest'

import { readArchiveBody, writeArchiveBody } from './archiveBodyDb'

const DB_NAME = 'dmdata-archive-bodies'

/** 版 1 のデータベースを作り、1 件控えた状態にする（版 1 のストアの形は本体と同じ）。 */
function seedVersion1(key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const del = indexedDB.deleteDatabase(DB_NAME)
    del.onerror = () => reject(del.error)
    del.onsuccess = () => {
      const open = indexedDB.open(DB_NAME, 1)
      open.onupgradeneeded = () => {
        const db = open.result
        db.createObjectStore('meta', { keyPath: 'id' }).createIndex('lastUsedAt', 'lastUsedAt')
        db.createObjectStore('bodies', { keyPath: 'id' })
      }
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        const db = open.result
        const t = db.transaction(['meta', 'bodies'], 'readwrite')
        const now = Date.now()
        t.objectStore('meta').put({ id: key, bytes: 3, lastUsedAt: now, createdAt: now })
        t.objectStore('bodies').put({ id: key, gz: new Uint8Array([1, 2, 3]) })
        t.oncomplete = () => { db.close(); resolve() }
        t.onerror = () => reject(t.error)
      }
    }
  })
}

describe('アーカイブ本体の控えを版 2 へ上げる', () => {
  it('正: 版 1 で控えた中身は読まない（捨てる）。上げたあとは書いて読める', async () => {
    await seedVersion1('https://x/v1')

    // 版 1 の中身は、育ちきる前に控えたものが混じりうる（期限が無くなったので、ここで捨てないと残り続ける）
    expect(await readArchiveBody('https://x/v1')).toBeNull()

    // 安全弁: 捨てたあともストアは使える
    await writeArchiveBody('https://x/v2', new Uint8Array([9]))
    expect(await readArchiveBody('https://x/v2')).toEqual(new Uint8Array([9]))
  })
})
