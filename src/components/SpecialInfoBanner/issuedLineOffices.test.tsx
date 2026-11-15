// @vitest-environment jsdom
//
// 帯を開いた本文の最後の「発表: 日時」の行に、電文を編集・発表した官署を続ける
// （2026-11-15 ユーザー選択「本文の発表の行に続ける (Recommended)」）。
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { SpecialInfoBanner } from './index'
import { useSpecialInfoBanners, type SpecialInfoItems } from './useSpecialInfoBanners'
import type { JMANankai } from '../../types/earthquake'

afterEach(cleanup)
beforeEach(() => localStorage.clear())

const EMPTY: SpecialInfoItems = { nankai: null, nankaiCommentary: [], kohatsu: [], quakeNotice: [], earthquakeCount: [], internationalTsunami: [], cancels: [] }

function Banners({ items }: { items: Partial<SpecialInfoItems> }) {
  const banners = useSpecialInfoBanners({ ...EMPTY, ...items })
  return <SpecialInfoBanner banners={banners} speakingTelegramTextSubject={null} readsAppendix={false} atScreenBottom bodyTopInset={0} bodyTopEdgeRef={{ current: null }} />
}

const HEADLINE = '南海トラフ地震臨時情報（巨大地震警戒）を発表しました。'
const nankai = (over: Partial<JMANankai> = {}): JMANankai => ({
  id: 'n1', time: '2026-01-01T12:00:00+09:00', eventId: 'e1',
  kindCode: '120', kindName: '巨大地震警戒',
  headline: HEADLINE, body: '本文', cancelled: false, reportDateTime: '2026-01-01T12:00:00+09:00',
  ...over,
})

/** 帯を開いて、本文の発表の行を返す */
async function openIssuedLine(): Promise<HTMLElement> {
  const toggle = screen.getAllByText(HEADLINE)[0].closest('button')!
  await act(async () => { fireEvent.click(toggle) })
  return (await screen.findByText(/^発表: /)).parentElement!
}

describe('帯の本文の発表の行と官署', () => {
  // 正: 発表の日時に続けて、編集官署・発表官署をそれぞれ割らない塊で並べる
  it('発表の日時に官署を続ける', async () => {
    render(<Banners items={{ nankai: nankai({ editorialOffice: '大阪管区気象台', publishingOffice: '気象庁' }) }} />)
    const line = await openIssuedLine()
    const parts = [...line.children].map(e => e.textContent)
    expect(parts.slice(1)).toEqual(['編集官署 大阪管区気象台', '発表官署 気象庁'])
    expect([...line.children].every(e => e.className.includes('whitespace-nowrap'))).toBe(true)
  })

  // 対照: 官署を持たない報では、発表の日時だけ
  it('官署が無ければ発表の日時だけ', async () => {
    render(<Banners items={{ nankai: nankai() }} />)
    const line = await openIssuedLine()
    expect(line.children).toHaveLength(1)
  })

  // 安全弁: 片方だけなら、ある方だけを出す（もう片方の語で埋めない）
  it('発表官署だけなら発表官署だけ', async () => {
    render(<Banners items={{ nankai: nankai({ publishingOffice: '気象庁' }) }} />)
    const line = await openIssuedLine()
    expect([...line.children].map(e => e.textContent).slice(1)).toEqual(['発表官署 気象庁'])
  })
})
