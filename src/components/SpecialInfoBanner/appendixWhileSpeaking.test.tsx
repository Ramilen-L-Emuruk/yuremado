// @vitest-environment jsdom
//
// 参考情報（`Appendix`）を読む設定の端末では、文を読んでいる間「この種類の情報について」も開く
// （2026-10-24 ユーザー選択「読む間は開く (Recommended)」）。声は参考情報を読むのに画面は閉じたまま、
// という食い違いを作らない。
//
//   正  : 読む設定で読み上げ中なら開き、読み終えたら閉じる
//   対照: 読まない設定（既定）なら、読み上げ中でも開かない
//   安全弁: 読み上げ中でない帯は開かない
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SpecialInfoBanner } from './index'
import { useSpecialInfoBanners } from './useSpecialInfoBanners'
import { telegramTextSubject } from '../../utils/ttsFollow'
import type { JMANankai } from '../../types/earthquake'

beforeEach(() => localStorage.clear())

const APPENDIX = '南海トラフ地震臨時情報の種類と発表条件の説明です。'

const nankai: JMANankai = {
  id: 'n1', time: '2026-01-01T12:00:00+09:00', eventId: 'e1', cancelled: false,
  kindName: '巨大地震注意', headline: '南海トラフ地震臨時情報（巨大地震注意）',
  summary: '要約です。', body: '本文です。', appendix: APPENDIX,
  reportDateTime: '2026-01-01T12:00:00+09:00',
} as unknown as JMANankai

function Banner({ speaking, readsAppendix }: { speaking: boolean; readsAppendix: boolean }) {
  const banners = useSpecialInfoBanners({ nankai, nankaiCommentary: null, kohatsu: null, quakeNotice: null, earthquakeCount: null })
  return (
    <SpecialInfoBanner
      banners={banners}
      speakingTelegramTextSubject={speaking ? telegramTextSubject('nankai') : null}
      readsAppendix={readsAppendix}
      atScreenBottom
    />
  )
}

describe('参考情報の読み上げに合わせて開く', () => {
  it('読む設定で読み上げ中なら開き、読み終えたら閉じる', () => {
    const { rerender } = render(<Banner speaking readsAppendix />)
    expect(screen.queryByText(APPENDIX)).not.toBeNull()
    rerender(<Banner speaking={false} readsAppendix />)
    expect(screen.queryByText(APPENDIX)).toBeNull()
  })

  it('読まない設定なら、読み上げ中でも開かない', () => {
    render(<Banner speaking readsAppendix={false} />)
    // 帯の本文は読み上げで開いている（参考情報だけが閉じている）
    expect(screen.queryByText('本文です。')).not.toBeNull()
    expect(screen.queryByText(APPENDIX)).toBeNull()
  })

  it('読み上げ中でなければ開かない', () => {
    render(<Banner speaking={false} readsAppendix />)
    expect(screen.queryByText(APPENDIX)).toBeNull()
  })

  // 手で開いたものは読み終わりでも閉じない（規約は `useAutoOpenWhileSpeaking` と同じ）
  it('手で開いた参考情報は、読み上げと関係なく開いたまま', () => {
    const { rerender } = render(<Banner speaking={false} readsAppendix />)
    fireEvent.click(screen.getByText('南海トラフ地震臨時情報（巨大地震注意）'))
    fireEvent.click(screen.getByText(/この種類の情報について/))
    expect(screen.queryByText(APPENDIX)).not.toBeNull()
    rerender(<Banner speaking readsAppendix />)
    rerender(<Banner speaking={false} readsAppendix />)
    expect(screen.queryByText(APPENDIX)).not.toBeNull()
  })
})
