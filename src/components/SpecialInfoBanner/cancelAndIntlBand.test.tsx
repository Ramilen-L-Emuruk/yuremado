// @vitest-environment jsdom
//
// 特別な情報の帯の取消の表示（2026-11-09 ユーザー選択「帯を取消に切り替え＋通知に理由 (Recommended)」、形は 2026-11-10
// ユーザー選択「A 帯の中に 3 行 (Recommended)」）と、国際津波関連情報の帯（2026-11-09 ユーザー選択「帯に出す (Recommended)」・
// 2026-11-10 ユーザー選択「灰（お知らせと同じ）」）を描いて確かめる。
import { describe, it, expect, beforeEach } from 'vitest'
import { act, render, screen, fireEvent } from '@testing-library/react'
import { SpecialInfoBanner } from './index'
import { useSpecialInfoBanners, type SpecialInfoItems } from './useSpecialInfoBanners'
import type { JMAInternationalTsunami, JMAQuakeNotice } from '../../types/earthquake'
import { specialInfoCancelBand, type SpecialInfoCancelBand } from '../../utils/specialInfoCancelBand'
import { internationalTsunamiBandItem, type InternationalTsunamiBandItem } from '../../utils/internationalTsunami'

beforeEach(() => localStorage.clear())

function Banners({ items }: { items: SpecialInfoItems }) {
  const banners = useSpecialInfoBanners(items)
  return <SpecialInfoBanner banners={banners} speakingTelegramTextSubject={null} readsAppendix={false} atScreenBottom bodyTopInset={0} bodyTopEdgeRef={{ current: null }} />
}

const none: SpecialInfoItems = { nankai: null, nankaiCommentary: [], kohatsu: [], quakeNotice: [], earthquakeCount: [], internationalTsunami: [], cancels: [] }

const notice = (id: string, headline: string, over: Partial<JMAQuakeNotice> = {}): JMAQuakeNotice => ({
  id, time: '2026-01-01T12:00:00+09:00', eventId: '20260101120000', headline, body: `${headline}の本文`, cancelled: false,
  reportDateTime: '2026-01-01T12:00:00+09:00', expireAt: '2026-01-08T12:00:00+09:00', ...over,
})

const REASON = '１８日１９時３６分に発表した「南海トラフ地震臨時情報（調査中）」は誤りですので取り消します。'

function noticeCancel(reason: string, targetIds: readonly string[] = ['q1']): SpecialInfoCancelBand {
  return specialInfoCancelBand({ kind: 'quakeNotice', data: notice('c1', '', { cancelled: true, body: reason }) }, targetIds)
}

describe('取消の表示', () => {
  it('正: 見出し「〇〇 取消」・1 行目「〇〇は取り消されました」・2 行目に理由をそのまま出す', () => {
    render(<Banners items={{ ...none, cancels: [noticeCancel(REASON)] }} />)
    const band = screen.getByTestId('band-cancel')
    expect(band.textContent).toContain('地震・津波に関するお知らせ 取消')
    expect(band.textContent).toContain('地震・津波に関するお知らせは取り消されました')
    expect(band.textContent).toContain(REASON)
  })

  it('対照: 理由が空なら 2 行目を出さない', () => {
    render(<Banners items={{ ...none, cancels: [noticeCancel('  ')] }} />)
    const band = screen.getByTestId('band-cancel')
    expect(band.querySelectorAll('p')).toHaveLength(2)
  })

  it('正: 残りの報があれば、取消の表示をその種類の帯のすぐ上に出し、残りの帯はそのまま', () => {
    render(<Banners items={{ ...none, quakeNotice: [notice('q2', '残ったお知らせ')], cancels: [noticeCancel(REASON)] }} />)
    const headers = screen.getByTestId('band-headers')
    const cancel = screen.getByTestId('band-cancel')
    expect(cancel.parentElement).toBe(headers)
    expect(cancel.nextElementSibling?.textContent).toContain('残ったお知らせ')
  })

  it('安全弁: 取り消した報を × で閉じていたなら、取消の表示も出さない', () => {
    localStorage.setItem('quake-notice-dismissed', JSON.stringify(['q1']))
    const { container } = render(<Banners items={{ ...none, cancels: [noticeCancel(REASON)] }} />)
    expect(screen.queryByTestId('band-cancel')).toBeNull()
    // 帯が 1 枚も無いので束ごと描かない
    expect(container.firstChild).toBeNull()
  })

  it('× で 10 秒を待たずに閉じられる', () => {
    render(<Banners items={{ ...none, cancels: [noticeCancel(REASON)] }} />)
    fireEvent.click(screen.getByLabelText('地震・津波に関するお知らせの取消の表示を閉じる'))
    expect(screen.queryByTestId('band-cancel')).toBeNull()
  })
})

const wepa = (over: Partial<JMAInternationalTsunami> = {}): JMAInternationalTsunami => ({
  id: 'w1', title: 'NWPTA COMMUNICATIONS TEST', time: '2026-01-01T12:00:00Z', isCommunicationsTest: true,
  text: 'WEPA60 RJTD 011200\nNWPTA COMMUNICATIONS TEST\n\nTHIS IS A TEST MESSAGE.', ...over,
} as JMAInternationalTsunami)

const bandItem = (x: JMAInternationalTsunami): InternationalTsunamiBandItem => {
  const item = internationalTsunamiBandItem(x)
  if (!item) throw new Error('帯の 1 通にならない')
  return item
}

describe('国際津波関連情報の帯', () => {
  it('正: 通信試験は見出し「国際津波関連情報 通信試験」の帯になり、開くと英文が出る', async () => {
    render(<Banners items={{ ...none, internationalTsunami: [bandItem(wepa())] }} />)
    // 開いた英文の欄は地名の表を読みに行く。読み終えるまで待つ（act の外で描き直さないように）
    await act(async () => { fireEvent.click(screen.getByText('国際津波関連情報 通信試験')) })
    expect(screen.getAllByText(/THIS IS A TEST MESSAGE\./).length).toBeGreaterThan(0)
  })

  it('対照: 発生時刻を読めない（通信試験でない）報は見出し「国際津波関連情報」', () => {
    render(<Banners items={{ ...none, internationalTsunami: [bandItem(wepa({ isCommunicationsTest: false, title: 'TSUNAMI INFORMATION' }))] }} />)
    expect(screen.getAllByText('国際津波関連情報').length).toBeGreaterThan(0)
    expect(screen.queryByText('国際津波関連情報 通信試験')).toBeNull()
  })

  it('× で閉じた報は次に開いたときも出さない', () => {
    const item = bandItem(wepa())
    const { unmount } = render(<Banners items={{ ...none, internationalTsunami: [item] }} />)
    fireEvent.click(screen.getByLabelText('国際津波関連情報を閉じる'))
    unmount()
    const { container } = render(<Banners items={{ ...none, internationalTsunami: [item] }} />)
    expect(container.firstChild).toBeNull()
  })
})
