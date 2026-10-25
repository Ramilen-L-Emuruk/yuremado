// @vitest-environment jsdom
//
// 津波のブラウザ通知を受け手の結線ごと固定するテスト。中身の組み立ては `utils/tsunamiNotification.test.ts`。
// ここで守るのは、**どの報で何が `showBrowserNotification` に渡るか**（材料・解除の報・送らない報）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useLiveEventHandler } from './useLiveEventHandler'
import { DEFAULTS, type AppSettings } from './useSettings'
import { showBrowserNotification } from '../utils/notifications'
import type { JMAQuake, JMATsunami, TsunamiArea, TsunamiGrade } from '../types/earthquake'

vi.mock('../utils/voicevox', () => ({
  speakWithVoicevox: vi.fn(() => Promise.resolve({ spoke: true, spokenChunks: [] })),
  prewarmVoicevox: () => null,
  getSpeechClock: () => null,
}))
vi.mock('../utils/alertSound', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/alertSound')>()
  return { ...actual, playAlertSound: vi.fn() }
})
vi.mock('../utils/notifications', () => ({ showBrowserNotification: vi.fn() }))

const notify = vi.mocked(showBrowserNotification)

const area = (name: string, code: string, grade: TsunamiGrade, lastGrade?: TsunamiGrade): TsunamiArea =>
  ({ name, code, grade, ...(lastGrade && { lastGrade }), immediate: false } as TsunamiArea)

let serial = 0
function report(areas: TsunamiArea[], extra: Partial<JMATsunami> = {}): JMATsunami {
  serial += 1
  return {
    kind: 'tsunami', id: `tsunami-${serial}`, eventId: '20240101161010', time: '2024-01-01T16:22:00+09:00',
    cancelled: false, issue: { source: '気象庁', time: '2024-01-01T16:22:00+09:00', type: 'Focus' },
    areas, ...extra,
  }
}

function setup(notifyTsunami = true) {
  const settings = { ...DEFAULTS,
    voicevoxEnabled: false, soundEnabled: false, notifyMinScale: 0,
    notifyEEW: false, notifyTsunami, notifyDetection: false, minDisplayScale: -1,
  } as unknown as AppSettings
  const title = new Proxy({ alertTitle: null } as Record<string, unknown>, {
    get: (t, k) => (k in t ? t[k as string] : vi.fn()),
  })
  const displayed: JMATsunami[] = []
  const { result } = renderHook(() => useLiveEventHandler({
    settings, title: title as never,
    earthquakesRef: { current: [] as JMAQuake[] },
    tsunamisRef: { current: displayed },
    nankaiActiveRef: { current: false },
    setActiveTabNonRealtime: vi.fn(),
    setActiveTabRealtimeOnUpdate: vi.fn(),
    setActiveTabRealtimeUrgent: vi.fn(), followSpeechTab: vi.fn(), preSpeechTab: vi.fn(() => true),
    quakeSpeakingCard: null,
    expandPanelForSpecialInfo: vi.fn(),
    selectQuake: vi.fn(), openLpgmFromQuake: vi.fn(), openEstimatedIntensity: vi.fn(), closeDistributionOnQuakeReport: vi.fn(),
  }))
  const handle = (t: JMATsunami) => {
    act(() => { result.current.handleLiveEvent(t as never) })
    if (!t.cancelled) displayed[0] = t
  }
  // 設定は受け手が呼ばれた時点の値を読むので、テストの途中で書き換えれば「途中で止めた」形になる
  return { handle, settings }
}

beforeEach(() => {
  vi.useFakeTimers()
  serial = 0
  notify.mockClear()
})
afterEach(() => { vi.useRealTimers() })

describe('津波のブラウザ通知（受け手）', () => {
  it('正: 一部解除の報で、発表中の区域と「解除：」の行を送る', () => {
    const { handle } = setup()
    handle(report([area('石川県能登', '360', 'Watch'), area('青森県日本海沿岸', '200', 'Watch')]))
    notify.mockClear()
    handle(report([area('石川県能登', '360', 'Watch', 'Watch')], {
      cancelledAreas: [area('青森県日本海沿岸', '200', 'Unknown', 'Watch')],
    }))
    expect(notify).toHaveBeenCalledWith('津波注意報', '石川県能登\n解除：青森県日本海沿岸', 'tsunami', true)
  })

  it('対照: 津波予報だけの報は閉じるまで残さない', () => {
    const { handle } = setup()
    handle(report([area('石川県能登', '360', 'Forecast')]))
    expect(notify).toHaveBeenCalledWith('津波予報（若干の海面変動）', '石川県能登', 'tsunami', false)
  })

  // 2026-10-19 ユーザー選択「送る (Recommended)」
  it('正: 全区域解除の報で、気象庁の文を本文にして送る', () => {
    const { handle } = setup()
    handle(report([area('石川県能登', '360', 'Watch')]))
    notify.mockClear()
    const text = '現在、大津波警報・津波警報・津波注意報を発表している沿岸はありません。'
    handle(report([], { cancelled: true, cancelReason: 'lifted', warningComments: [{ key: 'VTSE41', text }] } as Partial<JMATsunami>))
    expect(notify).toHaveBeenCalledWith('津波警報等の解除', text, 'tsunami', false)
  })

  it('安全弁: 同じ解除が 2 度届いても 1 回だけ送る', () => {
    const { handle } = setup()
    handle(report([area('石川県能登', '360', 'Watch')]))
    notify.mockClear()
    const lift = { cancelled: true, cancelReason: 'lifted' } as Partial<JMATsunami>
    handle(report([], lift))
    handle(report([], lift))
    expect(notify).toHaveBeenCalledTimes(1)
  })

  // 正（2026-10-21 ユーザー選択「取消も失効も通知 (Recommended)」で覆した。文面は 2026-10-24 ユーザー選択「この文面で (Recommended)」）
  it('正: 誤報の取消は取消理由を本文にして送り、前の通知を書き換える', () => {
    const { handle } = setup()
    handle(report([area('石川県能登', '360', 'Watch')]))
    notify.mockClear()
    handle(report([], { cancelled: true, cancelReason: 'retracted', headType: 'VTSE41', cancelText: '津波注意報を取り消します。' } as Partial<JMATsunami>))
    expect(notify).toHaveBeenCalledWith('津波警報等の取消', '津波注意報を取り消します。', 'tsunami', false)
  })

  it('正: 取消理由を持たない取消は定型の文を送る', () => {
    const { handle } = setup()
    handle(report([area('石川県能登', '360', 'Watch')]))
    notify.mockClear()
    handle(report([], { cancelled: true, cancelReason: 'retracted', headType: 'VTSE41' } as Partial<JMATsunami>))
    expect(notify).toHaveBeenCalledWith('津波警報等の取消', '津波警報等は誤って発表されたため取り消されました。', 'tsunami', false)
  })

  it('正: 失効は「津波予報の失効」を送る', () => {
    const { handle } = setup()
    handle(report([area('石川県能登', '360', 'Forecast')]))
    notify.mockClear()
    handle(report([], { cancelled: true, cancelReason: 'expired' } as Partial<JMATsunami>))
    expect(notify).toHaveBeenCalledWith('津波予報の失効', '津波予報は失効しました。', 'tsunami', false)
  })

  // 安全弁（2026-10-23 ユーザー選択「安全弁では「失効」と名乗らない (Recommended)」）: 標準版の 24 時間の安全弁は通知しない
  it('安全弁: 標準版の安全弁で消える津波は「失効」の通知を出さない', () => {
    const { handle } = setup()
    handle(report([area('石川県能登', '360', 'Forecast')], { eventId: undefined }))
    notify.mockClear()
    handle(report([], { eventId: undefined, cancelled: true, cancelReason: 'expired', failsafeExpiry: true } as Partial<JMATsunami>))
    expect(notify).not.toHaveBeenCalled()
  })

  // 安全弁: 津波情報だけの取消（警報等は続いている）は通知しない。終わったと読める通知で警報の通知を置き換えないため
  it('安全弁: 津波情報だけの取消は通知しない', () => {
    const { handle } = setup()
    handle(report([area('石川県能登', '360', 'Watch')]))
    handle(report([], { headType: 'VTSE51', observations: [{ name: '輪島港', height: { value: 0.5, description: '0.5m' } }] } as Partial<JMATsunami>))
    notify.mockClear()
    handle(report([], { cancelled: true, cancelReason: 'retracted', headType: 'VTSE51' } as Partial<JMATsunami>))
    expect(notify).not.toHaveBeenCalled()
  })

  // 観測情報だけの報（2026-10-21 ユーザー選択「観測でも通知する」・2026-10-24 ユーザー選択「別の通知にする (Recommended)」）
  it('正: 観測情報だけの報は、印の付いた観測点を別の札で送る', () => {
    const { handle } = setup()
    handle(report([area('石川県能登', '360', 'Warning')]))
    notify.mockClear()
    handle(report([], { headType: 'VTSE51', infoName: '津波観測に関する情報', observations: [
      { name: '輪島港', height: { value: 1.2, description: '1.2m' } },
      { name: '珠洲市長橋' },
    ] } as Partial<JMATsunami>))
    expect(notify).toHaveBeenCalledWith('津波観測に関する情報', '輪島港 1.2m、珠洲市長橋 到達確認', 'tsunami-obs', false)
  })

  // 等級を発表するのは VTSE41 だけ（2026-10-25 ユーザー選択「A 発表は VTSE41 だけ (Recommended)」）。
  // 実配信の VTSE51 は観測の報も区域を載せ、その区域は直前の VTSE41 の写し（全期間の控えで 295 通すべて）
  describe('区域を載せた津波情報（VTSE51）', () => {
    const issued = () => report([area('石川県能登', '360', 'Warning')], { headType: 'VTSE41' })
    const copied = (extra: Partial<JMATsunami> = {}) =>
      report([area('石川県能登', '360', 'Warning', 'Warning')], { headType: 'VTSE51', ...extra })

    it('正: 区域を写しただけの満潮時刻の報は、発表の通知を出し直さない', () => {
      const { handle } = setup()
      handle(issued())
      notify.mockClear()
      handle(copied({ infoName: '各地の満潮時刻・津波到達予想時刻に関する情報' }))
      expect(notify).not.toHaveBeenCalled()
    })

    it('正: 区域を載せた観測の報は、印の付いた観測点を観測の札で送る', () => {
      const { handle } = setup()
      handle(issued())
      notify.mockClear()
      handle(copied({ infoName: '津波観測に関する情報', observations: [{ name: '輪島港', height: { value: 1.2, description: '1.2m' } }] }))
      expect(notify).toHaveBeenCalledTimes(1)
      expect(notify).toHaveBeenCalledWith('津波観測に関する情報', '輪島港 1.2m', 'tsunami-obs', false)
    })

    it('対照: 等級が同じでも VTSE41 の続報は発表の通知を出す', () => {
      const { handle } = setup()
      handle(issued())
      notify.mockClear()
      handle(report([area('石川県能登', '360', 'Warning', 'Warning'), area('富山県', '370', 'Watch')], { headType: 'VTSE41' }))
      expect(notify).toHaveBeenCalledWith('津波警報', '石川県能登、富山県', 'tsunami', true)
    })

    it('対照: 観測値が同じ VTSE51 の再送では、観測の通知も出さない', () => {
      const { handle } = setup()
      handle(issued())
      const obs = { infoName: '津波観測に関する情報', observations: [{ name: '輪島港', height: { value: 1.2, description: '1.2m' } }] } as Partial<JMATsunami>
      handle(copied(obs))
      notify.mockClear()
      handle(copied(obs))
      expect(notify).not.toHaveBeenCalled()
    })

    // VTSE51 の区域は写しなので、区域の等級が動いた形で届いても発表の通知は VTSE41 に任せる（実配信では起きていない形）
    it('安全弁: 区域の等級が上がった形の VTSE51 でも発表の通知は出さない', () => {
      const { handle } = setup()
      handle(issued())
      notify.mockClear()
      handle(report([area('石川県能登', '360', 'MajorWarning', 'Warning')], { headType: 'VTSE51', infoName: '各地の満潮時刻・津波到達予想時刻に関する情報' }))
      expect(notify).not.toHaveBeenCalled()
    })

    it('正: 沖合の観測（VTSE52）は、印の付いた観測点を観測の札で送る', () => {
      const { handle } = setup()
      handle(issued())
      notify.mockClear()
      handle(report([], { headType: 'VTSE52', infoName: '沖合の津波観測に関する情報', observations: [{ name: '岩手釜石沖' }] } as Partial<JMATsunami>))
      expect(notify).toHaveBeenCalledWith('沖合の津波観測に関する情報', '岩手釜石沖 到達確認', 'tsunami-obs', false)
    })

    it('安全弁: 種別を持たない報（P2PQuake）は発表の通知を出す', () => {
      const { handle } = setup()
      handle(report([area('石川県能登', '360', 'Warning')], { eventId: undefined }))
      expect(notify).toHaveBeenCalledWith('津波警報', '石川県能登', 'tsunami', true)
    })
  })

  it('対照: 何も変わらない再送では観測情報の通知を出さない', () => {
    const { handle } = setup()
    handle(report([area('石川県能登', '360', 'Warning')]))
    const obs = { headType: 'VTSE51', infoName: '津波観測に関する情報', observations: [{ name: '輪島港', height: { value: 1.2, description: '1.2m' } }] } as Partial<JMATsunami>
    handle(report([], obs))
    notify.mockClear()
    handle(report([], obs))
    expect(notify).not.toHaveBeenCalled()
  })

  // 通知は発表中の通知と tag が同じ。別の津波の解除で、閉じるまで残していた警報の通知を「解除」へ置き換えない
  it('安全弁: 表示中の津波と別の津波の解除では通知しない', () => {
    const { handle } = setup()
    handle(report([area('石川県能登', '360', 'Warning')]))
    notify.mockClear()
    handle(report([], { eventId: '20240102000000', cancelled: true, cancelReason: 'lifted' } as Partial<JMATsunami>))
    expect(notify).not.toHaveBeenCalled()
  })

  // 受信処理が表示中の津波を覚えていない（リロード直後など）ときの解除は照合で弾かない。照合を
  // 「覚えている津波があるときだけ」へ寄せると、この解除の通知が黙って出なくなる。
  // なお失効で閉じた後に届く同じ津波の解除は、読み上げと同じ既読の判定（`tsunamiCancelKey`）で音・声ごと黙る
  it('正: 覚えている津波が無いときに届いた解除でも送る', () => {
    const { handle } = setup()
    handle(report([], { cancelled: true, cancelReason: 'lifted' } as Partial<JMATsunami>))
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).toBe('津波警報等の解除')
  })

  // P2PQuake など理由を持たない解除は、画面と同じく解除へ倒す
  it('正: 理由を持たない解除は解除として送る', () => {
    const { handle } = setup()
    handle(report([area('石川県能登', '360', 'Watch')]))
    notify.mockClear()
    handle(report([], { cancelled: true } as Partial<JMATsunami>))
    expect(notify).toHaveBeenCalledWith('津波警報等の解除', '津波警報等は全て解除されました。', 'tsunami', false)
  })

  it('対照: 等級を読めなかった区域だけの報は閉じるまで残さない', () => {
    const { handle } = setup()
    handle(report([area('石川県能登', '360', 'Unknown')]))
    expect(notify.mock.calls[0]?.[3]).toBe(false)
  })

  it('安全弁: 区域を載せない報（観測情報だけ）は通知しない', () => {
    const { handle } = setup()
    handle(report([area('石川県能登', '360', 'Watch')]))
    notify.mockClear()
    handle(report([]))
    expect(notify).not.toHaveBeenCalled()
  })

  it('安全弁: 津波の通知を切った端末では解除も送らない', () => {
    const { handle } = setup(false)
    handle(report([area('石川県能登', '360', 'Watch')]))
    handle(report([], { cancelled: true, cancelReason: 'lifted' } as Partial<JMATsunami>))
    expect(notify).not.toHaveBeenCalled()
  })

  // 閉じるまで残る通知を出した後に通知を止めても、解除・取消はその通知を置き換える
  // （2026-10-25 ユーザー選択「解除・取消だけ出す (Recommended)」）。終わった警報が通知センターに残らないように
  it('正: 警報の通知を出した後にまとめて止めても、解除で置き換える', () => {
    const { handle, settings } = setup()
    handle(report([area('石川県能登', '360', 'Warning')]))
    settings.notifyEnabled = false
    notify.mockClear()
    handle(report([], { cancelled: true, cancelReason: 'lifted' } as Partial<JMATsunami>))
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).toBe('津波警報等の解除')
  })

  it('正: 津波の通知だけを途中で切っても、取消で置き換える', () => {
    const { handle, settings } = setup()
    handle(report([area('石川県能登', '360', 'Watch')]))
    settings.notifyTsunami = false
    notify.mockClear()
    handle(report([], { cancelled: true, cancelReason: 'retracted', headType: 'VTSE41' } as Partial<JMATsunami>))
    expect(notify.mock.calls[0]?.[0]).toBe('津波警報等の取消')
  })

  it('対照: 止めている間に始まった津波は、解除も送らない（置き換える通知が無い）', () => {
    const { handle, settings } = setup()
    settings.notifyEnabled = false
    handle(report([area('石川県能登', '360', 'Warning')]))
    handle(report([], { cancelled: true, cancelReason: 'lifted' } as Partial<JMATsunami>))
    expect(notify).not.toHaveBeenCalled()
  })

  it('安全弁: 閉じるまで残さない通知（津波予報）だけを出していたなら、止めた後の失効は送らない', () => {
    const { handle, settings } = setup()
    handle(report([area('石川県能登', '360', 'Forecast')]))
    settings.notifyEnabled = false
    notify.mockClear()
    handle(report([], { cancelled: true, cancelReason: 'expired' } as Partial<JMATsunami>))
    expect(notify).not.toHaveBeenCalled()
  })

  it('安全弁: 解除で置き換えた後に届いた別の解除は、止めていれば送らない', () => {
    const { handle, settings } = setup()
    handle(report([area('石川県能登', '360', 'Warning')]))
    settings.notifyEnabled = false
    handle(report([], { cancelled: true, cancelReason: 'lifted' } as Partial<JMATsunami>))
    notify.mockClear()
    handle(report([], { cancelled: true, cancelReason: 'retracted', headType: 'VTSE41' } as Partial<JMATsunami>))
    expect(notify).not.toHaveBeenCalled()
  })
})
