// @vitest-environment jsdom
//
// 特別情報の帯に出す運用種別（電文の `Control/Status`）の印。
//
// **この状態はブラウザで作れない。** アプリは試験報・訓練報を既定で捨て、リプレイ経路
// （`dmdataReplay.ts`）は設定に関わらず落とす。だが実電文を数えると、帯に出る種別は
// これまでに配信されたものの多くが訓練報だった（後発地震注意情報は訓練 5 / 通常 2、
// 南海トラフ臨時情報は訓練 4 / 通常 4）。印が無いと、訓練の「巨大地震注意」が本物と
// 同じ顔で出る。描いて確かめるしかない。
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { SpecialInfoBanner, shareButtonBottomClass } from './index'
import { useSpecialInfoBanners, type SpecialInfoItems } from './useSpecialInfoBanners'
import type { JMAKohatsu, JMANankai, JMANankaiCommentary, JMAQuakeNotice, JMAEarthquakeCount, TelegramOperationStatus } from '../../types/earthquake'

afterEach(cleanup)
// 閉じた帯の id は localStorage に残るので、テストどうしで持ち越さない
beforeEach(() => localStorage.clear())

/** 帯の束の状態はフックが持つので、テストでは App と同じく呼び出し側でフックを呼んで渡す。 */
function Banners({ items, atScreenBottom = true }: { items: SpecialInfoItems; atScreenBottom?: boolean }) {
  const banners = useSpecialInfoBanners(items)
  return <SpecialInfoBanner banners={banners} speakingTelegramTextSubject={null} atScreenBottom={atScreenBottom} />
}

const nankai = (operationStatus?: TelegramOperationStatus): JMANankai => ({
  id: 'n1', time: '2026-01-01T12:00:00+09:00', eventId: 'e1',
  kindCode: '120', kindName: '巨大地震警戒',
  headline: '南海トラフ地震臨時情報（巨大地震警戒）を発表しました。',
  body: '本文', cancelled: false, reportDateTime: '2026-01-01T12:00:00+09:00',
  ...(operationStatus && { operationStatus }),
})

const commentary = (operationStatus?: TelegramOperationStatus): JMANankaiCommentary => ({
  id: 'c1', time: '2026-01-01T12:00:00+09:00', eventId: 'e2',
  serialCode: '200', serialName: '定例解説',
  headline: '南海トラフ地震関連解説情報（定例）', summary: '', body: '本文',
  cancelled: false, reportDateTime: '2026-01-01T12:00:00+09:00',
  expireAt: '2026-01-08T12:00:00+09:00',
  ...(operationStatus && { operationStatus }),
})

const kohatsu = (operationStatus?: TelegramOperationStatus): JMAKohatsu => ({
  id: 'k1', time: '2026-01-01T12:00:00+09:00', eventId: 'e3',
  headline: '北海道・三陸沖後発地震注意情報を発表しました。', body: '本文',
  cancelled: false, reportDateTime: '2026-01-01T12:00:00+09:00',
  expireAt: '2026-01-08T12:00:00+09:00',
  ...(operationStatus && { operationStatus }),
})

const quakeNotice = (operationStatus?: TelegramOperationStatus): JMAQuakeNotice => ({
  id: 'q1', time: '2026-01-01T12:00:00+09:00', eventId: 'e4',
  headline: '沖縄県の震度データ入電停止のお知らせ', body: '本文',
  cancelled: false, reportDateTime: '2026-01-01T12:00:00+09:00',
  expireAt: '2026-01-08T12:00:00+09:00',
  ...(operationStatus && { operationStatus }),
})

const earthquakeCount = (operationStatus?: TelegramOperationStatus): JMAEarthquakeCount => ({
  id: 'ec1', time: '2026-01-01T12:00:00+09:00', eventId: '20260101000000',
  headline: '地震回数に関する情報をお知らせします。',
  items: [{ type: '累積地震回数', startTime: '2026-01-01T00:00:00+09:00', endTime: '2026-01-01T12:00:00+09:00', number: 1704, feltNumber: 1 }],
  cancelled: false, reportDateTime: '2026-01-01T12:00:00+09:00',
  expireAt: '2026-01-08T12:00:00+09:00',
  ...(operationStatus && { operationStatus }),
})

describe('特別情報の帯の運用種別', () => {
  // 正: 5 つの帯すべてに印が出る。**帯ごとに書くと片方だけ落ちる**ので、まとめて見る。
  it('訓練報はどの帯にも印が出る', () => {
    render(<Banners items={{ nankai: nankai('訓練'), nankaiCommentary: commentary('訓練'), kohatsu: kohatsu('訓練'), quakeNotice: quakeNotice('訓練'), earthquakeCount: earthquakeCount('訓練') }} />)
    expect(screen.getAllByText('訓練報')).toHaveLength(5)
  })

  it('試験報も同じ', () => {
    render(<Banners items={{ nankai: nankai('試験'), nankaiCommentary: commentary('試験'), kohatsu: kohatsu('試験'), quakeNotice: quakeNotice('試験'), earthquakeCount: earthquakeCount('試験') }} />)
    expect(screen.getAllByText('試験報')).toHaveLength(5)
  })

  // 対照: 通常の報では印を出さない。**平常時に余計な印が出ないこと**を押さえる。
  it('通常の報では印を出さない', () => {
    render(<Banners items={{ nankai: nankai(), nankaiCommentary: commentary(), kohatsu: kohatsu(), quakeNotice: quakeNotice(), earthquakeCount: earthquakeCount() }} />)
    expect(screen.queryByText('訓練報')).toBeNull()
    expect(screen.queryByText('試験報')).toBeNull()
    // 帯そのものは出ている（印だけが出ない）
    expect(screen.getByText('巨大地震警戒')).toBeTruthy()
    // **後発地震の帯は情報名の札を持たない**（南海トラフのキーワードに当たる語が無く、置くと
    // 隣の見出しと同じ文字列が 2 つ並ぶ）。帯が出ていることは電文の見出しで確かめる。
    expect(screen.getByText('北海道・三陸沖後発地震注意情報を発表しました。')).toBeTruthy()
    expect(screen.getByText('お知らせ')).toBeTruthy()
    expect(screen.getByText('地震回数')).toBeTruthy()
  })
})

// 後発地震注意情報の帯を開いた中の発表時刻の行。**電文に期限の要素は無い**ので、アプリが帯を畳む
// 7 日（`expireAt`）を「まで有効」と言い切らない（2026-10-19 ユーザー選択「発表時刻だけにする (Recommended)」）。
describe('後発地震注意情報の帯の発表時刻の行', () => {
  const none: SpecialInfoItems = { nankai: null, nankaiCommentary: null, kohatsu: null, quakeNotice: null, earthquakeCount: null }

  // 正: 開くと発表時刻が出る。
  it('開くと発表時刻を出す', () => {
    render(<Banners items={{ ...none, kohatsu: kohatsu() }} />)
    fireEvent.click(screen.getByText('北海道・三陸沖後発地震注意情報を発表しました。'))
    expect(screen.getByText(/^発表: /)).toBeTruthy()
  })

  // 安全弁: 帯を畳む時刻は持っていても、期限として出さない。畳む時刻を発表と見分けの付く
  // 年（2099 年）にして、その日時がどの形でも画面に出ていないことを見る。
  it('「まで有効」も畳む時刻も出さない', () => {
    const { container } = render(<Banners items={{ ...none, kohatsu: { ...kohatsu(), expireAt: '2099-12-31T23:59:00+09:00' } }} />)
    fireEvent.click(screen.getByText('北海道・三陸沖後発地震注意情報を発表しました。'))
    expect(container.textContent).not.toContain('まで有効')
    expect(container.textContent).not.toContain('12/31')
    expect(container.textContent).not.toContain('2099')
  })
})

// 下端の余白（ホームインジケータを避ける分）。媒体の条件（スマホの横画面）は jsdom では効かないので、
// ここで見るのは「付けるか」の側だけ —— 包みのクラスに余白の指定が載るか。
describe('特別情報の帯の下端の余白', () => {
  const SAFE = 'sideShort:[&>*:last-child]:pb-[env(safe-area-inset-bottom,0px)]'
  const scroller = (container: HTMLElement) => container.querySelector('.overflow-y-auto') as HTMLElement

  // 正: 画面の下端に接しているときは包みに余白の指定が載る
  it('下端に接していれば余白を付ける', () => {
    const { container } = render(<Banners items={{ nankai: null, nankaiCommentary: null, kohatsu: null, quakeNotice: quakeNotice(), earthquakeCount: null }} />)
    expect(scroller(container).className).toContain(SAFE)
  })

  // 対照: 地図の下に波形が出ていて下端に届かないときは付けない
  it('下端に接していなければ余白を付けない', () => {
    const { container } = render(<Banners items={{ nankai: null, nankaiCommentary: null, kohatsu: null, quakeNotice: quakeNotice(), earthquakeCount: null }} atScreenBottom={false} />)
    expect(scroller(container).className).not.toContain('safe-area-inset-bottom')
  })

  // 共有ボタンも帯と同じ条件で下端を避ける。帯が出ていれば下端に届くのは帯なので、ボタンは避けない
  it('共有ボタンは、帯が無く下端に接するときだけ safe-area を避ける', () => {
    const avoid = 'sideShort:bottom-[max(0.5rem,env(safe-area-inset-bottom,0px))]'
    expect(shareButtonBottomClass(false, true)).toContain(avoid)
    expect(shareButtonBottomClass(true, true)).not.toContain('safe-area')
    expect(shareButtonBottomClass(false, false)).not.toContain('safe-area')
    expect(shareButtonBottomClass(true, false)).not.toContain('safe-area')
    // どの場合も地図の下端（帯の上端）から 0.5rem
    for (const [s, b] of [[false, true], [true, true], [false, false], [true, false]] as const) {
      expect(shareButtonBottomClass(s, b).split(' ')).toContain('bottom-2')
    }
  })

  // 安全弁: 帯の 1 枚 1 枚は余白を持たない（最後の 1 枚へは包みから効かせる）。帯の側に戻すと、
  // 波形が出ていても余白が付き、帯と帯の間にも隙間ができうる
  it('帯の 1 枚 1 枚は余白を持たない', () => {
    const { container } = render(<Banners items={{ nankai: nankai(), nankaiCommentary: commentary(), kohatsu: kohatsu(), quakeNotice: quakeNotice(), earthquakeCount: earthquakeCount() }} />)
    for (const child of Array.from(scroller(container).children)) {
      expect((child as HTMLElement).className).not.toContain('safe-area-inset-bottom')
    }
  })
})

describe('閉じた帯と「いま出す帯」', () => {
  const none: SpecialInfoItems = { nankai: null, nankaiCommentary: null, kohatsu: null, quakeNotice: null, earthquakeCount: null }

  // 正: 帯が 1 枚あれば描き、閉じたら消える
  it('閉じると、その帯は描かれない', () => {
    const { container } = render(<Banners items={{ ...none, quakeNotice: quakeNotice() }} />)
    expect(screen.getByText('お知らせ')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('お知らせを閉じる'))
    expect(screen.queryByText('お知らせ')).toBeNull()
    // **閉じた帯しか残っていなければ外枠ごと描かない**（下限 2.5rem の空の枠を残さない）
    expect(container.firstChild).toBeNull()
  })

  // 対照: 閉じた id と違う電文（続報）なら出直す
  it('続報（別の id）が届けば出直す', () => {
    const { rerender } = render(<Banners items={{ ...none, quakeNotice: quakeNotice() }} />)
    fireEvent.click(screen.getByLabelText('お知らせを閉じる'))
    rerender(<Banners items={{ ...none, quakeNotice: { ...quakeNotice(), id: 'q2' } }} />)
    expect(screen.getByText('お知らせ')).toBeTruthy()
  })

  // 安全弁: shown は閉じた帯を数えない（共有ボタンの置き場所はこれで決める）
  it('shown は閉じた帯を数えない', () => {
    let shown: boolean | null = null
    function Probe({ items }: { items: SpecialInfoItems }) {
      const b = useSpecialInfoBanners(items)
      shown = b.shown
      return <SpecialInfoBanner banners={b} speakingTelegramTextSubject={null} atScreenBottom />
    }
    render(<Probe items={{ ...none, earthquakeCount: earthquakeCount() }} />)
    expect(shown).toBe(true)
    fireEvent.click(screen.getByLabelText(/閉じる/))
    expect(shown).toBe(false)
  })

  // 閉じた id はリロードしても残る（localStorage）
  it('閉じた電文はマウントし直しても出ない', () => {
    const first = render(<Banners items={{ ...none, quakeNotice: quakeNotice() }} />)
    fireEvent.click(screen.getByLabelText('お知らせを閉じる'))
    first.unmount()
    const { container } = render(<Banners items={{ ...none, quakeNotice: quakeNotice() }} />)
    expect(container.firstChild).toBeNull()
  })

  // 閉じた種類ごとに、決まったキーへ書く。キーの文字列を取り違えると、更新した端末で閉じた帯が
  // 復活する（型検査では捕まらない）。3 種とも従来のキー名のまま
  it('3 種はそれぞれ従来のキーへ id を書き、互いに干渉しない', () => {
    render(<Banners items={{ ...none, nankaiCommentary: commentary(), quakeNotice: quakeNotice(), earthquakeCount: earthquakeCount() }} />)
    fireEvent.click(screen.getByLabelText('解説情報を閉じる'))
    expect(localStorage.getItem('nankai-commentary-dismissed')).toBe('c1')
    expect(localStorage.getItem('quake-notice-dismissed')).toBeNull()
    expect(localStorage.getItem('earthquake-count-dismissed')).toBeNull()
    // 残りの 2 枚は出たまま
    expect(screen.getByText('お知らせ')).toBeTruthy()
    expect(screen.getByText('地震回数')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('お知らせを閉じる'))
    fireEvent.click(screen.getByLabelText('地震回数を閉じる'))
    expect(localStorage.getItem('quake-notice-dismissed')).toBe('q1')
    expect(localStorage.getItem('earthquake-count-dismissed')).toBe('ec1')
  })

  // 正: 閉じた当時の書式（dmdata-xml-）の id でも、今の書式の電文を閉じたままにする
  it('閉じた id は書式を揃えてから突き合わせる', () => {
    localStorage.setItem('quake-notice-dismissed', 'dmdata-xml-abc')
    const { container } = render(<Banners items={{ ...none, quakeNotice: { ...quakeNotice(), id: 'dmdata-abc' } }} />)
    expect(container.firstChild).toBeNull()
  })

  // 対照: 書式を揃えても別の電文なら出す
  it('書式を揃えても別の id なら出す', () => {
    localStorage.setItem('quake-notice-dismissed', 'dmdata-xml-abc')
    render(<Banners items={{ ...none, quakeNotice: { ...quakeNotice(), id: 'dmdata-def' } }} />)
    expect(screen.getByText('お知らせ')).toBeTruthy()
  })

  // 設定で隠した種類は呼び出し側が null で渡す。帯も shown も出ない
  it('null で渡した種類は shown に数えない', () => {
    let shown: boolean | null = null
    function Probe() {
      shown = useSpecialInfoBanners(none).shown
      return null
    }
    render(<Probe />)
    expect(shown).toBe(false)
  })
})
