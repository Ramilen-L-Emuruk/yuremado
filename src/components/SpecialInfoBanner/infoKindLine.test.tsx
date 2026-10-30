// @vitest-environment jsdom
//
// 南海トラフ・後発地震の帯の見出しの下に、電文の `Body/EarthquakeInfo` の `@type` と `InfoKind` を添える
// （2026-10-30 ユーザー選択「帯に添える (Recommended)」）。
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { SpecialInfoBanner } from './index'
import { useSpecialInfoBanners, type SpecialInfoItems } from './useSpecialInfoBanners'
import type { JMAKohatsu, JMANankai, JMANankaiCommentary } from '../../types/earthquake'

afterEach(cleanup)
beforeEach(() => localStorage.clear())

const EMPTY: SpecialInfoItems = { nankai: null, nankaiCommentary: null, kohatsu: null, quakeNotice: null, earthquakeCount: null }

function Banners({ items }: { items: Partial<SpecialInfoItems> }) {
  const banners = useSpecialInfoBanners({ ...EMPTY, ...items })
  return <SpecialInfoBanner banners={banners} speakingTelegramTextSubject={null} readsAppendix={false} atScreenBottom />
}

const nankai = (over: Partial<JMANankai> = {}): JMANankai => ({
  id: 'n1', time: '2026-01-01T12:00:00+09:00', eventId: 'e1',
  kindCode: '120', kindName: '巨大地震警戒',
  headline: '南海トラフ地震臨時情報（巨大地震警戒）を発表しました。',
  body: '本文', cancelled: false, reportDateTime: '2026-01-01T12:00:00+09:00',
  ...over,
})

const commentary = (over: Partial<JMANankaiCommentary> = {}): JMANankaiCommentary => ({
  id: 'c1', time: '2026-01-01T12:00:00+09:00', eventId: 'e2',
  serialCode: '200', serialName: '定例解説',
  headline: '南海トラフ地震関連解説情報（定例）', summary: '', body: '本文',
  cancelled: false, reportDateTime: '2026-01-01T12:00:00+09:00',
  expireAt: '2026-01-08T12:00:00+09:00',
  ...over,
})

const kohatsu = (over: Partial<JMAKohatsu> = {}): JMAKohatsu => ({
  id: 'k1', time: '2026-01-01T12:00:00+09:00', eventId: 'e3',
  headline: '北海道・三陸沖後発地震注意情報を発表しました。', body: '本文',
  cancelled: false, reportDateTime: '2026-01-01T12:00:00+09:00',
  expireAt: '2026-01-08T12:00:00+09:00',
  ...over,
})

describe('帯の見出しの下の情報の種別', () => {
  // 正: 3 つの帯とも「@type／InfoKind」の形で出る
  it('臨時情報・解説情報・後発地震の帯に出る', () => {
    render(<Banners items={{
      nankai: nankai({ earthquakeInfoType: '南海トラフ地震に関連する情報', earthquakeInfoKind: '南海トラフ地震臨時情報' }),
      nankaiCommentary: commentary({ earthquakeInfoType: '南海トラフ地震に関連する情報', earthquakeInfoKind: '南海トラフ地震関連解説情報' }),
      kohatsu: kohatsu({ earthquakeInfoType: '北海道・三陸沖後発地震注意情報', earthquakeInfoKind: '北海道・三陸沖後発地震注意情報' }),
    }} />)
    const lines = screen.getAllByTestId('info-kind-line').map(el => el.textContent)
    expect(lines).toEqual([
      '南海トラフ地震に関連する情報／南海トラフ地震臨時情報',
      '南海トラフ地震に関連する情報／南海トラフ地震関連解説情報',
      // 後発地震は 2 つが同じ語なので 1 つに畳む
      '北海道・三陸沖後発地震注意情報',
    ])
  })

  // 対照: 電文が持たなければ行ごと出さない（空の行を置かない）
  it('どちらも無ければ出さない', () => {
    render(<Banners items={{ nankai: nankai() }} />)
    expect(screen.queryByTestId('info-kind-line')).toBeNull()
  })

  // 安全弁: 片方だけなら、ある方を出す（区切りだけが残らない）
  it('片方だけならある方だけ', () => {
    render(<Banners items={{ nankai: nankai({ earthquakeInfoKind: '南海トラフ地震臨時情報' }) }} />)
    expect(screen.getByTestId('info-kind-line').textContent).toBe('南海トラフ地震臨時情報')
  })
})
