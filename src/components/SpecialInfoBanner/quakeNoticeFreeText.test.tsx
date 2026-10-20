// @vitest-environment jsdom
//
// 地震・津波に関するお知らせ（VZSE40）の自由付加文（`Body/Comments/FreeFormComment`）を、
// 開いた帯の本文の後へ出す（2026-10-19 ユーザー承認「本文に続けて出す (推奨)」）。
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SpecialInfoBanner } from './index'
import { useSpecialInfoBanners } from './useSpecialInfoBanners'
import type { JMAQuakeNotice } from '../../types/earthquake'

// 閉じた帯の id は localStorage に残るので、テストどうしで持ち越さない
beforeEach(() => localStorage.clear())

function Banner({ notice }: { notice: JMAQuakeNotice }) {
  const banners = useSpecialInfoBanners({ nankai: null, nankaiCommentary: null, kohatsu: null, quakeNotice: notice, earthquakeCount: null })
  return <SpecialInfoBanner banners={banners} speakingTelegramTextSubject={null} atScreenBottom />
}

const notice = (over: Partial<JMAQuakeNotice> = {}): JMAQuakeNotice => ({
  id: 'q1', time: '2026-01-01T12:00:00+09:00', eventId: 'e4',
  headline: '沖縄県の震度データ入電停止のお知らせ', body: '本文の一行目\n本文の二行目',
  cancelled: false, reportDateTime: '2026-01-01T12:00:00+09:00',
  expireAt: '2026-01-08T12:00:00+09:00',
  ...over,
})

/** 帯を開いて、中身の段落（`<p>`）の文字列を上から順に返す。 */
function openAndReadParagraphs(container: HTMLElement): string[] {
  fireEvent.click(screen.getByText('沖縄県の震度データ入電停止のお知らせ'))
  return [...container.querySelectorAll('p')].map(p => p.textContent ?? '')
}

describe('お知らせの自由付加文', () => {
  // 正: 本文の後に、原文のまま（改行を保って）出し、その後に発表時刻が来る
  it('本文の後に自由付加文、その後に発表時刻', () => {
    const { container } = render(<Banner notice={notice({ freeText: '保守点検の時刻が\n変更になりました。' })} />)
    const ps = openAndReadParagraphs(container)
    const bodyAt = ps.findIndex(t => t.includes('本文の一行目'))
    const freeAt = ps.findIndex(t => t === '保守点検の時刻が\n変更になりました。')
    const issuedAt = ps.findIndex(t => t.startsWith('発表:'))
    expect(bodyAt).toBeGreaterThanOrEqual(0)
    expect(freeAt).toBe(bodyAt + 1)
    expect(issuedAt).toBe(freeAt + 1)
  })

  // 対照: 自由付加文の無いお知らせは本文と発表時刻だけ（空の段落を足さない）
  it('対照: 自由付加文が無ければ段落を足さない', () => {
    const { container } = render(<Banner notice={notice()} />)
    const ps = openAndReadParagraphs(container)
    expect(ps).toHaveLength(2)
  })
})
