// @vitest-environment jsdom
//
// 同じ種類の報を 1 本に積んだ帯（2026-11-04 ユーザー選択「1 本に積む (Recommended)」「「ほか 2 件」 (Recommended)」
// 「帯は全件・行は 1 件 (Recommended)」）。見出し・残りの件数・開いた一覧・閉じ方を描いて確かめる。
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SpecialInfoBanner } from './index'
import { DISMISSED_IDS_MAX, parseDismissed, useSpecialInfoBanners, type SpecialInfoItems } from './useSpecialInfoBanners'
import type { JMAQuakeNotice, JMAKohatsu } from '../../types/earthquake'

beforeEach(() => localStorage.clear())

function Banners({ items }: { items: SpecialInfoItems }) {
  const banners = useSpecialInfoBanners(items)
  return <SpecialInfoBanner banners={banners} speakingTelegramTextSubject={null} readsAppendix={false} atScreenBottom />
}

const none: SpecialInfoItems = { nankai: null, nankaiCommentary: [], kohatsu: [], quakeNotice: [], earthquakeCount: [] }

const notice = (id: string, headline: string, minute: number): JMAQuakeNotice => ({
  id, time: `2026-01-01T12:${String(minute).padStart(2, '0')}:00+09:00`, eventId: `2026010112${String(minute).padStart(2, '0')}00`,
  headline, body: `${headline}の本文`, cancelled: false,
  reportDateTime: `2026-01-01T12:${String(minute).padStart(2, '0')}:00+09:00`, expireAt: '2026-01-08T12:00:00+09:00',
})

const kohatsu = (id: string, body: string): JMAKohatsu => ({
  id, time: '2026-01-01T12:00:00+09:00', eventId: `e-${id}`,
  headline: '北海道・三陸沖後発地震注意情報', body, cancelled: false,
  reportDateTime: '2026-01-01T12:00:00+09:00', expireAt: '2026-01-08T12:00:00+09:00',
})

// 新しい順（一覧はこの順で届く）
const notices = [notice('q3', '三通目のお知らせ', 30), notice('q2', '二通目のお知らせ', 20), notice('q1', '一通目のお知らせ', 10)]

describe('積んだ帯の見出しと開いた一覧', () => {
  it('正: 見出しは最新の 1 通の表題で、札の横に残りの件数を添える', () => {
    render(<Banners items={{ ...none, quakeNotice: notices }} />)
    expect(screen.getAllByText('三通目のお知らせ').length).toBeGreaterThan(0)
    expect(screen.getByTestId('band-more-count').textContent).toBe('ほか 2 件')
    // 帯は 1 本だけ（閉じる × が 1 つ）
    expect(screen.getAllByLabelText('お知らせを閉じる')).toHaveLength(1)
  })

  it('対照: 1 通だけなら件数を添えず、開くと行を並べずに本文を出す', () => {
    render(<Banners items={{ ...none, quakeNotice: [notices[0]] }} />)
    expect(screen.queryByTestId('band-more-count')).toBeNull()
    fireEvent.click(screen.getByText('三通目のお知らせ'))
    expect(screen.getByText('三通目のお知らせの本文')).toBeTruthy()
    expect(screen.queryAllByTestId('band-row')).toHaveLength(0)
    expect(screen.queryByLabelText('このお知らせを閉じる')).toBeNull()
  })

  it('開くと新しい順に全件を並べ、最新の 1 件だけが開いている', () => {
    render(<Banners items={{ ...none, quakeNotice: notices }} />)
    fireEvent.click(screen.getByTestId('band-more-count'))
    const rows = screen.getAllByTestId('band-row')
    expect(rows).toHaveLength(3)
    expect(rows.map(r => r.textContent)).toEqual([
      expect.stringContaining('三通目のお知らせ'),
      expect.stringContaining('二通目のお知らせ'),
      expect.stringContaining('一通目のお知らせ'),
    ])
    expect(screen.getByText('三通目のお知らせの本文')).toBeTruthy()
    expect(screen.queryByText('二通目のお知らせの本文')).toBeNull()
    // ほかの行は表題の行を押すと本文が開く
    fireEvent.click(screen.getByText('二通目のお知らせ'))
    expect(screen.getByText('二通目のお知らせの本文')).toBeTruthy()
  })

  it('行の × は 1 件だけを閉じ、見出しは次に新しい 1 通へ替わる', () => {
    render(<Banners items={{ ...none, quakeNotice: notices }} />)
    fireEvent.click(screen.getByTestId('band-more-count'))
    fireEvent.click(screen.getAllByLabelText('このお知らせを閉じる')[0])
    expect(screen.getByTestId('band-more-count').textContent).toBe('ほか 1 件')
    expect(screen.queryByText('三通目のお知らせ')).toBeNull()
    expect(JSON.parse(localStorage.getItem('quake-notice-dismissed') ?? '[]')).toEqual(['q3'])
  })

  it('帯の × は積まれている全件を閉じ、閉じた後に別件が届けばその 1 通で帯が出直す', () => {
    const { rerender, container } = render(<Banners items={{ ...none, quakeNotice: notices }} />)
    fireEvent.click(screen.getByLabelText('お知らせを閉じる'))
    expect(container.firstChild).toBeNull()
    expect(JSON.parse(localStorage.getItem('quake-notice-dismissed') ?? '[]')).toEqual(['q3', 'q2', 'q1'])

    rerender(<Banners items={{ ...none, quakeNotice: [notice('q4', '四通目のお知らせ', 40), ...notices] }} />)
    expect(screen.getAllByText('四通目のお知らせ').length).toBeGreaterThan(0)
    expect(screen.queryByTestId('band-more-count')).toBeNull()
  })

  it('行の × の名前は種類ごとに分ける', () => {
    render(<Banners items={{ ...none, kohatsu: [kohatsu('k2', '後の本文'), kohatsu('k1', '前の本文')] }} />)
    fireEvent.click(screen.getByTestId('band-more-count'))
    expect(screen.getAllByLabelText('この後発地震注意情報を閉じる')).toHaveLength(2)
  })
})

describe('閉じた記録の形', () => {
  it('正: 一覧（JSON の配列）を読む', () => {
    expect(parseDismissed(JSON.stringify(['a', 'b']))).toEqual(['a', 'b'])
  })

  it('対照: 古い形（1 つの id の文字列）も 1 件として読む', () => {
    expect(parseDismissed('dmdata-quake-notice-20260101120000-1')).toEqual(['dmdata-quake-notice-20260101120000-1'])
    expect(parseDismissed(null)).toEqual([])
  })

  it('古い形の記録が残っている端末でも、閉じたお知らせは閉じたまま', () => {
    localStorage.setItem('quake-notice-dismissed', 'q3')
    render(<Banners items={{ ...none, quakeNotice: notices }} />)
    expect(screen.getByTestId('band-more-count').textContent).toBe('ほか 1 件')
    expect(screen.queryByText('三通目のお知らせ')).toBeNull()
  })

  it('安全弁: 閉じた id は上限を超えたら古いものから捨てる', () => {
    const many = Array.from({ length: DISMISSED_IDS_MAX }, (_, i) => `old-${i}`)
    localStorage.setItem('quake-notice-dismissed', JSON.stringify(many))
    render(<Banners items={{ ...none, quakeNotice: [notices[0]] }} />)
    fireEvent.click(screen.getByLabelText('お知らせを閉じる'))
    const stored: string[] = JSON.parse(localStorage.getItem('quake-notice-dismissed') ?? '[]')
    expect(stored).toHaveLength(DISMISSED_IDS_MAX)
    expect(stored[0]).toBe('old-1')
    expect(stored[stored.length - 1]).toBe('q3')
  })
})
