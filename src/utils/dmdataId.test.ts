import { describe, it, expect } from 'vitest'
import { isQuakeNoticeDismissed, normalizeDmdataTelegramId, quakeNoticeId } from './dmdataId'

describe('normalizeDmdataTelegramId', () => {
  // 正: 旧書式で保存された既読の記録が、いまの書式と突き合わせられる。
  it('旧書式の `xml-` を落として現行の書式に揃える', () => {
    expect(normalizeDmdataTelegramId('dmdata-xml-nankai-commentary-20260904120000-1')).toBe(
      'dmdata-nankai-commentary-20260904120000-1',
    )
    // 揃えた結果、旧書式と現行書式が同じものを指すと判定できる。
    expect(normalizeDmdataTelegramId('dmdata-xml-quake-20260904120000-2')).toBe(
      normalizeDmdataTelegramId('dmdata-quake-20260904120000-2'),
    )
  })

  // 対照: 現行の書式は素通しする（二重に削らない）。
  it('現行の書式はそのまま返す', () => {
    expect(normalizeDmdataTelegramId('dmdata-nankai-commentary-20260904120000-1')).toBe(
      'dmdata-nankai-commentary-20260904120000-1',
    )
  })

  // 安全弁: 落とすのは**先頭の**接頭辞だけ。id の途中に現れる同じ並びには触らない。
  // 削る位置を緩めると、別の電文を同じものと見なす方向へ倒れる。
  it('先頭以外の `dmdata-xml-` は削らない', () => {
    expect(normalizeDmdataTelegramId('p2p-dmdata-xml-quake-20260904120000-1')).toBe(
      'p2p-dmdata-xml-quake-20260904120000-1',
    )
    expect(normalizeDmdataTelegramId('dmdata-quake-dmdata-xml-1')).toBe('dmdata-quake-dmdata-xml-1')
  })

  it('DMDATA 以外の id には触らない', () => {
    expect(normalizeDmdataTelegramId('p2p-12345')).toBe('p2p-12345')
    expect(normalizeDmdataTelegramId('')).toBe('')
  })
})

describe('isQuakeNoticeDismissed', () => {
  const notice = { id: quakeNoticeId('20230110160100', '2023-01-10T07:01:33Z'), eventId: '20230110160100' }

  // 正: 閉じたお知らせそのものは閉じたまま。
  it('同じ id の記録なら閉じている', () => {
    expect(isQuakeNoticeDismissed(notice.id, notice)).toBe(true)
  })

  // 正: **同じ分に出た別のお知らせは、先のお知らせを閉じても出る。** id が EventID だけだったころは
  // ここが重なって、後のお知らせまで隠れていた。
  it('同じ分の別のお知らせを閉じた記録では隠れない', () => {
    const earlier = quakeNoticeId('20230110160100', '2023-01-10T07:01:15Z')
    expect(isQuakeNoticeDismissed(earlier, notice)).toBe(false)
  })

  // 安全弁: 旧い書式（`…-<EventID>-<Serial>`）の記録は EventID で効かせる。更新した直後に
  // 閉じた帯が出直さないように。
  it('旧い書式の記録は EventID が同じなら閉じている', () => {
    expect(isQuakeNoticeDismissed('dmdata-quake-notice-20230110160100-1', notice)).toBe(true)
    expect(isQuakeNoticeDismissed('dmdata-xml-quake-notice-20230110160100-1', notice)).toBe(true)
  })

  // 対照: 旧い書式でも EventID が違えば別のお知らせ。
  it('旧い書式で EventID が違えば閉じていない', () => {
    expect(isQuakeNoticeDismissed('dmdata-quake-notice-20230110160200-1', notice)).toBe(false)
    expect(isQuakeNoticeDismissed(null, notice)).toBe(false)
  })
})
