// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createElement as h } from 'react'
import { render, cleanup, act, fireEvent } from '@testing-library/react'
import { TelegramTab, formatEntryForView, formatEntryForDownload, showControlChars } from './index'
import type { TelegramLogEntry } from '../../types/earthquake'
import { withTz } from '../../test-utils/withTz'
import { ja } from '../../i18n/messages/ja'
import { en } from '../../i18n/messages/en'

// 電文ログのダウンロード名の時刻。UTC で作ると JST の端末では 9 時間ずれた名前が並び、
// 画面に出ている受信時刻と突き合わせられない（診断ログ側と同じ穴）。

/** ダウンロードを走らせず、`a.download` と Blob だけ捕まえる。 */
function captureDownloads(): { names: string[]; blobs: Blob[]; restore: () => void } {
  const names: string[] = []
  const blobs: Blob[] = []
  const origClick = HTMLAnchorElement.prototype.click
  const origCreate = URL.createObjectURL
  const origRevoke = URL.revokeObjectURL
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    if (this.download) { names.push(this.download); return }
    return origClick.apply(this)
  }
  URL.createObjectURL = (b: Blob | MediaSource) => { blobs.push(b as Blob); return 'blob:dummy' }
  URL.revokeObjectURL = () => {}
  return {
    names,
    blobs,
    restore: () => {
      HTMLAnchorElement.prototype.click = origClick
      URL.createObjectURL = origCreate
      URL.revokeObjectURL = origRevoke
    },
  }
}

function entry(receivedAt: Date, headType = 'VXSE53'): TelegramLogEntry {
  return {
    id: `id-${receivedAt.getTime()}`,
    receivedAt,
    source: 'dmdss',
    origin: 'live',
    headType,
    isTest: false,
    status: 'parsed',
    kind: 'quake',
    rawHead: { type: headType },
    rawBody: { ok: true },
  }
}

function click(container: HTMLElement, text: string): void {
  const btn = Array.from(container.querySelectorAll('button')).find(
    (b) => (b.textContent ?? '').trim() === text,
  )
  if (!btn) throw new Error(`ボタンが見つからない: ${text}`)
  act(() => { btn.click() })
}

/** 電文の行を押して本文を開く（ダウンロード・コピーは開かないと出ない）。 */
function expandRow(container: HTMLElement, headType: string): void {
  const row = Array.from(container.querySelectorAll('button')).find(
    (b) => (b.textContent ?? '').includes(headType),
  )
  if (!row) throw new Error(`電文の行が見つからない: ${headType}`)
  act(() => { row.click() })
}

describe('電文ログのダウンロード名', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  // ローカルで 2026-08-23 15:04:05（JST）になる受信時刻。UTC 基準だと 060405 になる
  const RECEIVED = () => new Date(2026, 7, 23, 15, 4, 5)
  const NOW = () => new Date(2026, 7, 24, 9, 30, 0).getTime()

  it('個別ダウンロードは受信時刻を端末のローカル時刻で出す', () => {
    withTz('Asia/Tokyo', () => {
      const cap = captureDownloads()
      try {
        const { container } = render(h(TelegramTab, { telegramLog: [entry(RECEIVED())], onClear: () => {}, active: true }))
        expandRow(container, 'VXSE53')
        click(container, 'ダウンロード')
        expect(cap.names).toEqual(['20260823_150405+0900_DMDSS_VXSE53.json'])
      } finally {
        cap.restore()
      }
    })
  })

  it('選択ダウンロード（JSON）は書き出した時刻で出す', () => {
    withTz('Asia/Tokyo', () => {
      vi.spyOn(Date, 'now').mockReturnValue(NOW())
      const cap = captureDownloads()
      try {
        const { container } = render(h(TelegramTab, { telegramLog: [entry(RECEIVED())], onClear: () => {}, active: true }))
        const box = container.querySelector('input[type=checkbox]')
        if (!box) throw new Error('選択のチェックボックスが無い')
        fireEvent.click(box)
        click(container, 'JSON')
        expect(cap.names).toEqual(['20260824_093000+0900_telegrams_1件.json'])
      } finally {
        cap.restore()
      }
    })
  })

  it('JSON の中身の受信時刻は ISO のまま（ファイル名だけをローカル時刻にする）', async () => {
    // ファイル名は人が読んで突き合わせるもの、中身は機械が読み直すもの。役割が違うので基準を分ける。
    // 「名前と揃えよう」と本文までローカル時刻にすると、他のツールでの再解析が壊れる
    const cap = captureDownloads()
    try {
      // 期待値もこの中で作る。`RECEIVED()` は壁時計から Date を組むので、外で呼ぶと実行環境の
      // 時間帯で解釈される。UTC で走る CI では中身（JST 解釈）と 9 時間ずれて落ちる
      const expectedIso = withTz('Asia/Tokyo', () => {
        const { container } = render(h(TelegramTab, { telegramLog: [entry(RECEIVED())], onClear: () => {}, active: true }))
        const box = container.querySelector('input[type=checkbox]')
        if (!box) throw new Error('選択のチェックボックスが無い')
        fireEvent.click(box)
        click(container, 'JSON')
        return RECEIVED().toISOString()
      })
      const payload = JSON.parse(await cap.blobs[0].text()) as { receivedAt: string }[]
      expect(payload[0].receivedAt).toBe(expectedIso)
      expect(payload[0].receivedAt).toMatch(/Z$/)
    } finally {
      cap.restore()
    }
  })

  // **壊れた受信時刻がダウンロードを道連れにしない。**
  //
  // `Date.prototype.toISOString()` は `Invalid Date` に対して `RangeError` を**投げる**
  // （`NaN` を返すだけの `getTime()` とは違う）。素で呼んでいた頃は、選んだ電文に 1 件でも
  // 壊れた時刻が混じると `map` ごと例外で止まり、**正常な電文まで巻き添えでダウンロードが
  // 何も起きずに終わった** —— 利用者には何も伝わらない。
  it('受信時刻が壊れていても、他の電文ごとダウンロードが止まらない', async () => {
    const cap = captureDownloads()
    try {
      withTz('Asia/Tokyo', () => {
        vi.spyOn(Date, 'now').mockReturnValue(NOW())
        const broken = { ...entry(RECEIVED(), 'VXSE51'), id: 'broken', receivedAt: new Date('壊れた値') }
        const { container } = render(h(TelegramTab, { telegramLog: [broken, entry(RECEIVED())], onClear: () => {}, active: true }))
        const box = container.querySelector('input[type=checkbox]')
        if (!box) throw new Error('選択のチェックボックスが無い')
        fireEvent.click(box)
        click(container, 'JSON')
      })
      // 正: ダウンロードそのものが成立する（例外で止まらない）。
      expect(cap.names).toEqual(['20260824_093000+0900_telegrams_2件.json'])
      const payload = JSON.parse(await cap.blobs[0].text()) as { headType: string; receivedAt: string | null }[]
      // 正: 壊れた時刻は `null` として書き出す。JSON を読む側にも「時刻が無い」と分かる。
      expect(payload.find(e => e.headType === 'VXSE51')?.receivedAt).toBeNull()
      // 対照: 同じ書き出しに混ざった正常な電文は、従来どおり ISO で残る。
      expect(payload.find(e => e.headType === 'VXSE53')?.receivedAt).toMatch(/Z$/)
    } finally {
      cap.restore()
    }
  })

  it('ZIP は外側を書き出した時刻・中身を受信時刻で出す', async () => {
    const cap = captureDownloads()
    try {
      withTz('Asia/Tokyo', () => {
        vi.spyOn(Date, 'now').mockReturnValue(NOW())
        const { container } = render(h(TelegramTab, { telegramLog: [entry(RECEIVED())], onClear: () => {}, active: true }))
        const box = container.querySelector('input[type=checkbox]')
        if (!box) throw new Error('選択のチェックボックスが無い')
        fireEvent.click(box)
        click(container, 'ZIP')
      })
      expect(cap.names).toEqual(['20260824_093000+0900_telegrams_1件.zip'])
      // zip はローカルファイルヘッダに名前を非圧縮で持つので、生バイトから読める
      const bytes = new Uint8Array(await cap.blobs[0].arrayBuffer())
      const text = new TextDecoder('utf-8').decode(bytes)
      expect(text).toContain('20260823_150405+0900_DMDSS_VXSE53.json')
    } finally {
      cap.restore()
    }
  })
})


// 電文の読み取りを XML へ一本化したことで、`rawBody` には気象庁の XML がそのまま入る。
// `JSON.stringify` に通すと全体がエスケープされ、改行が \n の 2 文字に潰れて 1 行になる。
describe('電文ログの本文の見せ方・落とし方', () => {
  const xmlEntry = (body: string, head?: unknown): TelegramLogEntry => ({
    id: 'x', receivedAt: new Date('2026-09-04T12:00:00+09:00'), source: 'dmdss', origin: 'live',
    headType: 'VXSE53', isTest: false, status: 'parsed', kind: 'quake',
    ...(head !== undefined ? { rawHead: head } : {}),
    rawBody: body,
  })
  const XML = '<?xml version="1.0" encoding="UTF-8"?>\n<Report>\n  <Control/>\n</Report>'

  // 正: XML はエスケープせずそのまま見せる。改行が保たれること。
  it('XML の本文はエスケープせずに見せる', () => {
    const text = formatEntryForView(xmlEntry(XML), ja.telegramLog)
    expect(text).toContain('<?xml version="1.0"')
    expect(text.split('\n').length).toBeGreaterThan(1)
  })

  // 正: ヘッダは電文の外側の情報なので、表示では XML の前に置く。
  it('ヘッダがあれば XML の前に JSON で置く', () => {
    const text = formatEntryForView(xmlEntry(XML, { type: 'VXSE53' }), ja.telegramLog)
    expect(text.indexOf('"type"')).toBeLessThan(text.indexOf('<?xml'))
  })

  // 正: ダウンロードは XML そのもの。ヘッダを混ぜると XML 宣言が先頭でなくなり読めなくなる。
  it('XML は .xml で、ヘッダを混ぜずに落とす', () => {
    expect(formatEntryForDownload(xmlEntry(XML, { type: 'VXSE53' }))).toEqual({ text: XML, ext: 'xml' })
  })

  // 安全弁: **文字列だからといって XML とは限らない。** 復号に失敗した電文は、復号前の base64 が
  // そのまま入る。これを XML や平文扱いすると base64 の塊に .xml・.txt が付き、ヘッダも落ちたファイルになる。
  it('復号できなかった base64 は XML・平文扱いしない（ヘッダごと .json で落とす）', () => {
    const b64 = 'H4sIAAAAAAAAA6tWKkpNzMlRsl'
    const d = formatEntryForDownload({ ...xmlEntry(b64, { type: 'VXSE53' }), status: 'error', errorMessage: 'body decode failed' })
    expect(d.ext).toBe('json')
    expect('text' in d && JSON.parse(d.text)).toEqual({ head: { type: 'VXSE53' }, body: b64 })
  })

  // 正: 平文の電文（国際津波関連情報）は改行どおりに見せ、本文そのままの .txt で落とす
  it('平文の電文は改行どおりに見せ、.txt で落とす', () => {
    const plain = 'WEPA60 RJTD 211247\r\nTSUNAMI BULLETIN NUMBER 001\r\n'
    const e = { ...xmlEntry(plain, { type: 'WEPA60' }), headType: 'WEPA60', kind: 'internationalTsunami' as const }
    expect(formatEntryForView(e, ja.telegramLog)).toContain('TSUNAMI BULLETIN NUMBER 001\r\n')
    expect(formatEntryForView(e, ja.telegramLog)).not.toContain('\\r\\n')
    expect(formatEntryForDownload(e)).toEqual({ text: plain, ext: 'txt' })
  })

  // 正: 画面には末尾の ETX を図記号で見せる。対照: コピー（formatEntryForView）とダウンロードは生のまま。
  // 安全弁: 改行・復帰・タブは置き換えない（改行どおりに見せる決まりを壊さない）
  it('画面に描くときだけ制御文字を図記号にし、コピーとダウンロードは生のまま', () => {
    const plain = 'WEPA60 RJTD 211247\r\n\tTSUNAMI BULLETIN NUMBER 001\r\n=\r\n\x03'
    const e = { ...xmlEntry(plain, { type: 'WEPA60' }), headType: 'WEPA60', kind: 'internationalTsunami' as const }
    const view = formatEntryForView(e, ja.telegramLog)
    expect(showControlChars(view).endsWith('=\r\n␃')).toBe(true)
    expect(showControlChars(view)).toContain('211247\r\n\tTSUNAMI')
    expect(view.endsWith('=\r\n\x03')).toBe(true)
    expect(formatEntryForDownload(e)).toEqual({ text: plain, ext: 'txt' })
    expect(showControlChars('a\x00b\x7f')).toBe('a␀b␡')
  })

  // 正: 要約の鍵と値（`bodyNote`）を持つ行は、いまの言語の辞書で文にする。対照: 日本語の辞書なら本文の欄の文と同じ。
  // 安全弁: 欄の無い古い行（下の 2 件のように要約の文だけを持つ行）は、その文のまま出す
  it('二進の電文の要約は、行の鍵と値から言語の辞書で組む', () => {
    const e = { ...xmlEntry('（BUFR 4 バイト・1 セル）'), headType: 'IXAC41', bodyNote: { kind: 'bufrCells' as const, bytes: 4, cells: 1 } }
    expect(formatEntryForView(e, en.telegramLog)).toBe('(BUFR, 4 bytes, 1 cell)')
    expect(formatEntryForView(e, ja.telegramLog)).toBe('（BUFR 4 バイト・1 セル）')
    const waiting = { ...e, bodyNote: { kind: 'bufrFragmentWaiting' as const, bytes: 512 } }
    expect(formatEntryForView(waiting, en.telegramLog)).toBe('(BUFR fragment, 512 bytes, waiting to join)')
    const skipped = { ...e, bodyNote: { kind: 'bufrFragmentSkipped' as const } }
    expect(formatEntryForView(skipped, en.telegramLog)).toBe('(BUFR fragment; body not loaded)')
  })

  // 正: 推計震度分布図は、要約の文を見せ、結合した元の電文を .bin で落とす
  it('二進の電文を持つ行は .bin で落とす', () => {
    const bytes = new Uint8Array([0x42, 0x55, 0x46, 0x52])
    const e = { ...xmlEntry('（BUFR 4 バイト・1 セル）'), headType: 'IXAC41', rawBytes: bytes }
    expect(formatEntryForView(e, ja.telegramLog)).toBe('（BUFR 4 バイト・1 セル）')
    expect(formatEntryForDownload(e)).toEqual({ bytes, ext: 'bin' })
  })

  // 安全弁: 推計震度分布図で元の二進を持たない行（結合待ちの断片の要約）は、要約の文を元の電文に見せない
  it('元の二進を持たない推計震度分布図の行は .txt にせず .json で落とす', () => {
    const e = { ...xmlEntry('（BUFR の断片 512 バイト・結合待ち）'), headType: 'IXAC41', status: 'filtered' as const }
    expect(formatEntryForDownload(e).ext).toBe('json')
  })

  // 対照: オブジェクトの本文は従来どおり JSON。
  it('オブジェクトの本文は従来どおり .json', () => {
    const e = { ...xmlEntry(XML), rawBody: { code: 551 } as unknown as string }
    expect(formatEntryForDownload(e).ext).toBe('json')
  })
})
