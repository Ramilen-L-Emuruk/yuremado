// 地震情報のブラウザ通知の中身と、出す回数を固定する。
// カードが採った報は、まだ通知していない報なら毎回出す（2026-10-26 ユーザー選択「カードが採った続報すべて (Recommended)」）。
// 本文は震度速報の文 → 震源の文（2026-10-19 ユーザー承認「速報の文＋震源で置き換え (推奨)」）で、震源が判ったあとに
// 最大震度が上がったら頭に「最大震度更新」を付ける（2026-10-22 選択「頭に「最大震度更新」 (Recommended)」）。
// 遠地地震は震度に関係なく出す（2026-10-22 選択「全部出す (Recommended)」）。tag は地震ごとで、置き換える。
import { describe, it, expect, vi } from 'vitest'
import type { EarthquakePoint, IntensityScale, JMAQuake } from '../types/earthquake'
import { collectQuakesToNotify, decideQuakeNotification, maxScaleAreaLabel, notifiedReportKey, QUAKE_NOTIFIED_REPORTS_MAX, rememberQuakeNotified, scalePromptNotificationBody, scheduleQuakeNotification, type QuakeNotification, type QuakeNotifiedState } from './quakeNotification'

/** DMDATA 経路の区域の点（`pref` は空。→ quake-spec.md §4）。 */
const area = (addr: string, scale: IntensityScale, unreceived = false): EarthquakePoint =>
  ({ pref: '', addr, isArea: true, scale, ...(unreceived && { unreceived: true }) })

function makeQuake(o: { hypoName?: string; maxScale?: IntensityScale; points?: EarthquakePoint[]; mag?: number; magnitudeCondition?: string; telegramKey?: string } = {}): JMAQuake {
  return {
    kind: 'quake',
    id: 'dmdata-quake-20260101162200-1',
    eventKey: '20260101162200',
    ...(o.telegramKey && { telegramKey: o.telegramKey }),
    time: '2026-01-01T07:22:30Z',
    issue: { source: 'dmdata', time: '2026-01-01T07:22:30Z', type: o.hypoName ? '震源・震度に関する情報' : '震度速報', correct: 'なし' },
    earthquake: {
      time: '2026-01-01T07:22:00Z',
      hypocenter: {
        name: o.hypoName ?? '',
        latitude: o.hypoName ? 37.5 : -200,
        longitude: o.hypoName ? 137.2 : -200,
        depth: o.hypoName ? 10 : -1,
        magnitude: o.mag ?? (o.hypoName ? 5.2 : NaN),
        ...(o.magnitudeCondition && { magnitudeCondition: o.magnitudeCondition }),
      },
      maxScale: o.maxScale ?? 45,
      domesticTsunami: 'なし',
    },
    points: o.points ?? [area('石川県能登', 45), area('石川県加賀', 30)],
  } as JMAQuake
}

describe('scalePromptNotificationBody', () => {
  // 正: 最大震度の区域の名前を出す。
  it('最大震度の区域が 1 つなら、その名前', () => {
    expect(scalePromptNotificationBody(makeQuake(), null)).toBe('震度速報 石川県能登 最大震度5弱')
  })

  it('最大震度の区域が複数なら、先頭に「ほか」', () => {
    const q = makeQuake({ points: [area('石川県能登', 45), area('新潟県上越', 45), area('富山県東部', 30)] })
    expect(scalePromptNotificationBody(q, null)).toBe('震度速報 石川県能登ほか 最大震度5弱')
  })

  // 対照: 最大震度より低い区域・都道府県のロールアップ点は数えない。
  it('都道府県のロールアップ点は区域として数えない', () => {
    const q = makeQuake({ points: [{ pref: '石川県', addr: '石川県', isArea: true, scale: 45 }, area('石川県能登', 45)] })
    expect(maxScaleAreaLabel(q, null)).toBe('石川県能登')
  })

  // 安全弁: 「以上」（未入電）を落とさない（既存の表記に揃える）。
  it('最大震度が「5弱以上」なら断定形にしない', () => {
    const q = makeQuake({ points: [area('石川県能登', 45, true), area('新潟県上越', 45)] })
    expect(scalePromptNotificationBody(q, null)).toBe('震度速報 石川県能登ほか 最大震度5弱以上')
  })
})

describe('decideQuakeNotification', () => {
  const prompt = makeQuake()
  const withHypo = makeQuake({ hypoName: '石川県能登地方' })
  /** 1 通目→2 通目… と報の鍵だけ変えて流す。 */
  const decide = (q: JMAQuake, reportKey: string, prev: QuakeNotifiedState | null, min = 30) =>
    decideQuakeNotification(q, [reportKey], prev, min, null)

  // 正: 震度速報で 1 回目を出す。tag は地震ごとの鍵。
  it('震度速報なら速報の文で出す', () => {
    const r = decide(prompt, 'r1', null)!
    expect(r.notification).toEqual({ title: '地震情報', body: '震度速報 石川県能登 最大震度5弱', tag: '20260101162200' })
    expect(r.next).toEqual({ key: '20260101162200', withHypocenter: false, maxScale: 45, reportKeys: ['r1'] })
  })

  // 正: 同じ地震で震源が判ったら震源の文。tag が同じなので OS 上で置き換わる。
  it('震度速報のあと震源が判った報が来たら、震源の文で出す', () => {
    const first = decide(prompt, 'r1', null)!
    const second = decide(withHypo, 'r2', first.next)!
    expect(second.notification.body).toBe('石川県能登地方 最大震度5弱 M5.2')
    expect(second.notification.tag).toBe(first.notification.tag)
    expect(second.next.withHypocenter).toBe(true)
    expect(second.next.reportKeys).toEqual(['r2', 'r1'])
  })

  // 正: 内容が変わらない続報でも、カードが採った新しい報なら出す（2026-10-26 の決定で変わったところ）。
  it('震源が判ったあとの続報でも、新しい報なら出す', () => {
    const first = decide(withHypo, 'r1', null)!
    const second = decide(withHypo, 'r2', first.next)!
    expect(second.notification.body).toBe('石川県能登地方 最大震度5弱 M5.2')
  })

  it('震源が判らないままの続報（震度速報の続き）でも、新しい報なら出す', () => {
    const first = decide(prompt, 'r1', null)!
    expect(decide(prompt, 'r2', first.next)!.notification.body).toBe('震度速報 石川県能登 最大震度5弱')
  })

  // 対照: 同じ報が 2 度届いても 2 度は出さない。
  it('通知済みの報がもう一度届いても出さない', () => {
    const first = decide(withHypo, 'r1', null)!
    expect(decide(withHypo, 'r1', first.next)).toBeNull()
  })

  it('同じティックにまとめた報のうち 1 通でも新しければ出す', () => {
    const first = decide(withHypo, 'r1', null)!
    const r = decideQuakeNotification(withHypo, ['r1', 'r2'], first.next, 30, null)!
    expect(r.next.reportKeys).toEqual(['r2', 'r1'])
    expect(decideQuakeNotification(withHypo, ['r1', 'r2'], r.next, 30, null)).toBeNull()
  })

  // 安全弁: まとめて届いた新しい報は、新しい順（届いた順の逆）で覚える。
  it('まとめて届いた報の鍵は新しい順に覚える', () => {
    const r = decideQuakeNotification(withHypo, ['r1', 'r2', 'r3'], null, 30, null)!
    expect(r.next.reportKeys).toEqual(['r3', 'r2', 'r1'])
  })

  // 安全弁: 鍵が 1 つも無い呼び出しを重複と見なさない（空配列の every は真になる）。
  it('鍵の配列が空でも、前の記憶があるだけで黙らない', () => {
    const first = decide(withHypo, 'r1', null)!
    expect(decideQuakeNotification(withHypo, [], first.next, 30, null)).not.toBeNull()
  })

  it('規模が数値にならないときは気象庁の説明を出す', () => {
    const huge = makeQuake({ hypoName: '石川県能登地方', mag: NaN, magnitudeCondition: 'Ｍ８を超える巨大地震' })
    expect(decide(huge, 'r1', null)!.notification.body).toBe('石川県能登地方 最大震度5弱 M8を超える巨大地震')
  })

  // 安全弁: 閾値の判定は従来どおり。続報でも閾値に届かなければ出さない。
  it('最大震度が閾値に届かなければ出さない。負の閾値は通知しない', () => {
    expect(decide(prompt, 'r1', null, 50)).toBeNull()
    expect(decide(prompt, 'r1', null, -1)).toBeNull()
    const first = decide(withHypo, 'r1', null)!
    const lowered = makeQuake({ hypoName: '石川県能登地方', maxScale: 20, points: [area('石川県能登', 20)] })
    expect(decide(lowered, 'r2', first.next)).toBeNull()
  })

  // 正: 震源が判ったあとで最大震度の階級が上がったら、頭に「最大震度更新」を付ける。
  it('震源が判ったあと最大震度が上がったら「最大震度更新」を付ける', () => {
    const first = decide(withHypo, 'r1', null)!
    const raised = makeQuake({ hypoName: '石川県能登地方', maxScale: 55, points: [area('石川県能登', 55)] })
    const r = decide(raised, 'r2', first.next)!
    expect(r.notification).toEqual({ title: '地震情報', body: '最大震度更新 石川県能登地方 最大震度6弱 M5.2', tag: first.notification.tag })
    expect(r.next.maxScale).toBe(55)
    // 同じ階級のままの次の報では頭を付けない
    expect(decide(raised, 'r3', r.next)!.notification.body).toBe('石川県能登地方 最大震度6弱 M5.2')
  })

  // 対照: 下がった・据え置き・「以上」が付いただけでは頭を付けない（出すことは出す）。
  it('最大震度が下がった・変わらない続報では「最大震度更新」を付けない', () => {
    const first = decide(withHypo, 'r1', null)!
    const lowered = makeQuake({ hypoName: '石川県能登地方', maxScale: 40, points: [area('石川県能登', 40)] })
    expect(decide(lowered, 'r2', first.next)!.notification.body).toBe('石川県能登地方 最大震度4 M5.2')
    const orAbove = makeQuake({ hypoName: '石川県能登地方', points: [area('石川県能登', 45, true)] })
    expect(decide(orAbove, 'r3', first.next)!.notification.body).toBe('石川県能登地方 最大震度5弱以上 M5.2')
  })

  // 安全弁: 震源が判る前に上がった分は、震源の報で「最大震度更新」を付けない（そのときの最大震度をそのまま出す）。
  it('震度速報から震源の報へ移るときは、上がっていても「最大震度更新」を付けない', () => {
    const first = decide(prompt, 'r1', null)!
    const raisedPrompt = makeQuake({ maxScale: 50, points: [area('石川県能登', 50)] })
    const second = decide(raisedPrompt, 'r2', first.next)!
    expect(second.notification.body).toBe('震度速報 石川県能登 最大震度5強')
    const raisedHypo = makeQuake({ hypoName: '石川県能登地方', maxScale: 50, points: [area('石川県能登', 50)] })
    expect(decide(raisedHypo, 'r3', second.next)!.notification.body).toBe('石川県能登地方 最大震度5強 M5.2')
  })

  it('別の地震なら前の状態に関わらず出す', () => {
    const other = { ...withHypo, eventKey: '20260101170000' }
    const first = decide(withHypo, 'r1', null)!
    expect(decide(other, 'r1', first.next)?.notification.tag).toBe('20260101170000')
  })

  // 安全弁: 通知した報の記憶は上限で切る（覚え続けない）。新しい側を残す。
  it('通知した報の記憶は新しい順に上限まで', () => {
    let state: QuakeNotifiedState | null = null
    for (let i = 0; i < QUAKE_NOTIFIED_REPORTS_MAX + 5; i++) state = decide(withHypo, `r${i}`, state)!.next
    expect(state!.reportKeys).toHaveLength(QUAKE_NOTIFIED_REPORTS_MAX)
    expect(state!.reportKeys[0]).toBe(`r${QUAKE_NOTIFIED_REPORTS_MAX + 4}`)
  })
})

describe('decideQuakeNotification（遠地地震）', () => {
  const foreign = {
    ...makeQuake({ hypoName: 'メキシコ、チアパス州沿岸', mag: 7.4, maxScale: -1, points: [] }),
    issue: { source: 'dmdata', time: '2026-01-01T07:22:30Z', type: '遠地地震', correct: 'なし' },
  } as JMAQuake

  // 正: 国内の震度を持たなくても、設定の震度に関係なく出す。本文は詳細震央地名と規模。
  it('震度の閾値に関係なく、遠地地震の文で出す', () => {
    const r = decideQuakeNotification(foreign, ['r1'], null, 50, null)!
    expect(r.notification).toEqual({ title: '地震情報', body: '遠地地震 メキシコ、チアパス州沿岸 M7.4', tag: '20260101162200' })
  })

  // 正: 同じ遠地地震の続報も、新しい報なら出す。対照: 同じ報の重複は出さない。
  it('同じ遠地地震の続報は出し、同じ報の重複は出さない', () => {
    const r = decideQuakeNotification(foreign, ['r1'], null, 30, null)!
    expect(decideQuakeNotification(foreign, ['r2'], r.next, 30, null)!.notification.body).toBe('遠地地震 メキシコ、チアパス州沿岸 M7.4')
    expect(decideQuakeNotification(foreign, ['r1'], r.next, 30, null)).toBeNull()
  })

  // 安全弁: 通知を切っていれば遠地地震も出さない。
  it('通知を切っている（負の閾値）なら出さない', () => {
    expect(decideQuakeNotification(foreign, ['r1'], null, -1, null)).toBeNull()
  })
})

describe('rememberQuakeNotified', () => {
  const quakeA = makeQuake({ hypoName: '石川県能登地方' })
  const quakeB = { ...quakeA, eventKey: '20260101170000' } as JMAQuake
  const decideFrom = (memory: Map<string, QuakeNotifiedState>, q: JMAQuake, reportKey: string) => {
    const d = decideQuakeNotification(q, [reportKey], memory.get(q.eventKey!) ?? null, 30, null)
    if (d) rememberQuakeNotified(memory, d.next)
    return d
  }
  const state = (key: string): QuakeNotifiedState => ({ key, withHypocenter: true, maxScale: 45, reportKeys: [] })

  // 正: 2 つの地震の報が交互に来ても、通知済みの報を忘れない。
  it('地震 A・B が交互に来ても、A の同じ報の重複は出さない', () => {
    const memory = new Map<string, QuakeNotifiedState>()
    expect(decideFrom(memory, quakeA, 'a1')).not.toBeNull()
    expect(decideFrom(memory, quakeB, 'b1')).not.toBeNull()
    expect(decideFrom(memory, quakeA, 'a1')).toBeNull()
  })

  // 安全弁: 上限を超えたら古いものから落とす（覚え続けない）。
  it('上限を超えたら最も古く覚えた地震から忘れる', () => {
    const memory = new Map<string, QuakeNotifiedState>()
    for (const key of ['a', 'b', 'c']) rememberQuakeNotified(memory, state(key), 2)
    expect([...memory.keys()]).toEqual(['b', 'c'])
  })

  // 対照: 同じ地震を覚え直すと新しい側へ移り、すぐには落ちない。
  it('同じ地震を覚え直すと、古い側から外れる', () => {
    const memory = new Map<string, QuakeNotifiedState>()
    rememberQuakeNotified(memory, state('a'), 2)
    rememberQuakeNotified(memory, state('b'), 2)
    rememberQuakeNotified(memory, state('a'), 2)
    rememberQuakeNotified(memory, state('c'), 2)
    expect([...memory.keys()]).toEqual(['a', 'c'])
  })
})

describe('collectQuakesToNotify', () => {
  const card = makeQuake({ hypoName: '石川県能登地方' })
  const other = { ...makeQuake({ hypoName: '福島県沖' }), id: 'dmdata-quake-20260101170000-1', eventKey: '20260101170000', earthquake: { ...makeQuake({ hypoName: '福島県沖' }).earthquake, time: '2026-01-01T08:00:00Z' } } as JMAQuake

  // 正: 先頭でない地震の報も引く。同じ地震の報が並んだら 1 つにまとめ、報の鍵を並べる。
  it('一覧の先頭でない地震も引き、同じカードに当たる報はまとめて鍵を並べる', () => {
    const r1 = { ...card, telegramKey: 'k1' }
    const r2 = { ...card, telegramKey: 'k2' }
    const r = collectQuakesToNotify([r1, r2, r1], [other, card], null)
    expect(r.cards).toEqual([{ card, reportKeys: ['k1', 'k2'] }])
    expect(r.unmatched).toEqual([])
  })

  // 安全弁: 鍵を持たない報は id・発表時刻・種別の組で見分ける。DMDATA の震度速報・震源情報は同じ地震の全報が
  // 同じ id になるので、id だけでは 2 通目以降を重複として黙らせてしまう。
  it('鍵を持たない報は id・発表時刻・種別の組で見分け、同じ id の続報も別の報として数える', () => {
    const prompt = makeQuake()
    const later = { ...card, time: '2026-01-01T07:25:00Z' } as JMAQuake
    expect(notifiedReportKey(prompt)).not.toBe(notifiedReportKey(card))
    expect(notifiedReportKey(card)).not.toBe(notifiedReportKey(later))
    expect(notifiedReportKey(card)).toBe(notifiedReportKey({ ...card }))
    const r = collectQuakesToNotify([prompt, later], [card], null)
    expect(r.cards[0].reportKeys).toHaveLength(2)
  })

  it('鍵を持つ報はその鍵を使う', () => {
    expect(notifiedReportKey({ ...card, telegramKey: 'k9' })).toBe('k9')
  })

  // 対照: 引けない報は外して返す（呼び出し側が記録する）。
  it('当たるカードが無い報は unmatched に返す', () => {
    const r = collectQuakesToNotify([other], [card], null)
    expect(r.cards).toEqual([])
    expect(r.unmatched).toEqual([other])
  })

  // 安全弁: 取り消されたカードには当てない。
  it('取り消されたカードには当てない', () => {
    const cancelled = { ...card, cancelledAt: new Date('2026-01-01T07:30:00Z') } as JMAQuake
    expect(collectQuakesToNotify([card], [cancelled], null).cards).toEqual([])
  })
})

// 通知は Service Worker の返事を待つので、出せたかがすぐには分からない。同じ地震の通知は前が済んでから
// 判定し、出せたときだけ覚える（`scheduleQuakeNotification`）
describe('scheduleQuakeNotification', () => {
  /** 呼ばれた順に記録し、`results` の順に成功・失敗を返す `show`。 */
  function makeShow(results: ('ok' | 'fail')[]) {
    const shown: QuakeNotification[] = []
    const show = vi.fn((n: QuakeNotification) => {
      shown.push(n)
      return results.shift() === 'fail' ? Promise.reject(new TypeError('Illegal constructor')) : Promise.resolve()
    })
    return { shown, show }
  }
  const prompt = makeQuake()
  const withHypo = makeQuake({ hypoName: '石川県能登地方' })

  function schedule(chains: Map<string, Promise<void>>, memory: Map<string, QuakeNotifiedState>, quake: JMAQuake, reportKey: string, show: (n: QuakeNotification) => Promise<void>) {
    return scheduleQuakeNotification({ chains, memory, quake, reportKeys: [reportKey], notifyMinScale: 30, areaPrefIndex: null, show })
  }

  it('正: 出せたら覚え、同じ報が続けて届いても 2 度は出さない', async () => {
    const chains = new Map<string, Promise<void>>()
    const memory = new Map<string, QuakeNotifiedState>()
    const { shown, show } = makeShow(['ok', 'ok'])
    const a = schedule(chains, memory, prompt, 'r1', show)
    const b = schedule(chains, memory, prompt, 'r1', show)
    await Promise.all([a, b])
    expect(shown).toHaveLength(1)
    expect(memory.size).toBe(1)
  })

  // 先に覚えて失敗で戻す形だと、2 通とも出せなかったとき、1 通目が通知済みとして残った
  it('安全弁: 続けて 2 通とも出せなければ、何も覚えない', async () => {
    const chains = new Map<string, Promise<void>>()
    const memory = new Map<string, QuakeNotifiedState>()
    const { show } = makeShow(['fail', 'fail'])
    const a = schedule(chains, memory, prompt, 'r1', show)
    const b = schedule(chains, memory, withHypo, 'r2', show)
    await expect(a).rejects.toThrow()
    await expect(b).rejects.toThrow()
    expect(memory.size).toBe(0)
  })

  it('正: 前が出せなくても、同じ報の届き直しは出す（通知済みになっていない）', async () => {
    const chains = new Map<string, Promise<void>>()
    const memory = new Map<string, QuakeNotifiedState>()
    const { shown, show } = makeShow(['fail', 'ok'])
    const a = schedule(chains, memory, prompt, 'r1', show)
    const b = schedule(chains, memory, prompt, 'r1', show)
    await expect(a).rejects.toThrow()
    await b
    expect(shown).toHaveLength(2)
    expect(memory.size).toBe(1)
  })

  it('対照: 同じ地震の次の報は、前の通知が済むまで出さない', async () => {
    const chains = new Map<string, Promise<void>>()
    const memory = new Map<string, QuakeNotifiedState>()
    let release!: () => void
    const order: string[] = []
    const show = vi.fn((n: QuakeNotification) => {
      order.push(n.title)
      return order.length === 1 ? new Promise<void>(resolve => { release = resolve }) : Promise.resolve()
    })
    const a = schedule(chains, memory, prompt, 'r1', show)
    const b = schedule(chains, memory, withHypo, 'r2', show)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(show).toHaveBeenCalledTimes(1)
    release()
    await Promise.all([a, b])
    expect(show).toHaveBeenCalledTimes(2)
    expect(chains.size).toBe(0)
  })

  // 出せたかが分かるのは返事が来てから。返事の前に覚えると、出せなかった通知が通知済みになる
  it('安全弁: 返事が来るまでは覚えず、出せてから渡した memory へ覚える', async () => {
    const chains = new Map<string, Promise<void>>()
    const memory = new Map<string, QuakeNotifiedState>()
    let release!: () => void
    const show = vi.fn(() => new Promise<void>(resolve => { release = resolve }))
    const a = schedule(chains, memory, prompt, 'r1', show)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(memory.size).toBe(0)
    release()
    await a
    expect(memory.size).toBe(1)
  })
})
