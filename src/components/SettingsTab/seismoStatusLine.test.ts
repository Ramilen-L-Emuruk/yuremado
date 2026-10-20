import { describe, it, expect } from 'vitest'
import { seismoStatusLine, SEISMO_STATUS_TONE_CLASS, type SeismoUiStatus } from './seismoStatusLine'

describe('seismoStatusLine', () => {
  it('正: 繋がったら観測点とセンサーの本数を出す', () => {
    // **「繋がった」だけでは足りない。** 観測点が 0 件なら、ホストは動いているが
    // 設定がまだ、と分かる。
    const line = seismoStatusLine({
      kind: 'ok',
      stations: [{ stationId: 'home', displayName: '自宅', lat: 35, lon: 139 }],
      sensorCount: 9,
      assignedStationCount: null,
    })
    expect(line.tone).toBe('ok')
    expect(line.text).toContain('観測点 1')
    expect(line.text).toContain('センサー 9')
  })

  it('対照: 繋がらない 4 つの理由を別の文で出す', () => {
    // **これがトグルを持つ形にした代償の手当て。** 1 つの「繋がりません」へ潰すと、
    // 利用者は何を直せばよいか分からない。
    const texts = (['disabled', 'no-url', 'invalid'] as const).map(
      (kind) => seismoStatusLine({ kind }).text,
    )
    texts.push(seismoStatusLine({ kind: 'unreachable', detail: 'Failed to fetch' }).text)
    expect(new Set(texts).size).toBe(4)
  })

  it('対照: 通信する手前で決まる状態は赤で騒がない', () => {
    // トグルが切れている・URL が空は「まだ設定していない」だけで、異常ではない。
    expect(seismoStatusLine({ kind: 'disabled' }).tone).toBe('muted')
    expect(seismoStatusLine({ kind: 'no-url' }).tone).toBe('muted')
    expect(seismoStatusLine({ kind: 'checking' }).tone).toBe('muted')
    // URL の形が違うのは直せる誤りなので赤で出す。
    expect(seismoStatusLine({ kind: 'invalid' }).tone).toBe('problem')
  })

  // **観測点の数は設定の割り当てから数える**（2026-10-19 ユーザー承認「割り当てから数える (推奨)」）。
  // 届いたセンサーから数えると、ホストの起動直後に設定済みの観測点が「未設定」に見える。
  describe('割り当てから数える', () => {
    const home = { stationId: 'home', displayName: '自宅', lat: 35, lon: 139 }

    it('正: 割り当てがあり、センサーから 1 つも届いていなければ「まだ届いていない」', () => {
      const line = seismoStatusLine({ kind: 'ok', stations: [], sensorCount: 0, assignedStationCount: 2 })
      expect(line.text).toBe('接続済み: 観測点 2・まだ届いていない')
      expect(line.tone).toBe('ok')
    })

    it('正: ふだんは観測点の数を割り当てから、センサーの数は届いているものから出す', () => {
      // 届いた観測点は 1 つでも、割り当ては 2 つ。
      const line = seismoStatusLine({ kind: 'ok', stations: [home], sensorCount: 9, assignedStationCount: 2 })
      expect(line.text).toBe('接続済み: 観測点 2・センサー 9')
    })

    it('対照: 割り当てが 0 なら、届いたものがあっても「未設定」', () => {
      expect(seismoStatusLine({ kind: 'ok', stations: [], sensorCount: 3, assignedStationCount: 0 }).text)
        .toBe('接続済み: 観測点は未設定')
    })

    it('安全弁: 割り当てを返さない古いホストでは、届いたセンサーから組んだ観測点で数える', () => {
      expect(seismoStatusLine({ kind: 'ok', stations: [home], sensorCount: 3, assignedStationCount: null }).text)
        .toBe('接続済み: 観測点 1・センサー 3')
      expect(seismoStatusLine({ kind: 'ok', stations: [], sensorCount: 0, assignedStationCount: null }).text)
        .toBe('接続済み: 観測点は未設定')
    })
  })

  it('正: 観測点が 0 件のときは別の文にする', () => {
    // **「接続済み: 観測点 0・センサー 0」では成功か異常か判らない。**
    // ホストは動いているが設定がまだ、という状態なので、それを名指しする。
    const line = seismoStatusLine({ kind: 'ok', stations: [], sensorCount: 0, assignedStationCount: null })
    expect(line.tone).toBe('ok')
    expect(line.text).toContain('観測点は未設定')
    expect(line.text).not.toContain('観測点 0')
  })

  it('安全弁: 到達できないときは何を確かめるかを書く', () => {
    const line = seismoStatusLine({ kind: 'unreachable', detail: 'Failed to fetch' })
    expect(line.text).toContain('起動')
    expect(line.tone).toBe('problem')
  })

  it('対照: 確認事項を 2 つ詰めない', () => {
    // ホーム画面から開く前提は、この行の上にある常時表示の但し書きが受け持つ。
    // 両方に書くと狭いパネルで折り返して読みにくくなる。
    const line = seismoStatusLine({ kind: 'unreachable', detail: 'Failed to fetch' })
    expect(line.text).not.toContain('ホーム画面')
  })

  it('対照: どの状態の文にも括弧の補足を付けない', () => {
    // 管理コンソールと同じ形（状態は言い切り・内訳は「: X」・次の手順は丁寧形の 1 文）へ
    // 揃えた（2026-10-13 ユーザー承認）。括弧の補足へ戻すと、片方だけ形が変わる。
    const all: SeismoUiStatus[] = [
      { kind: 'no-url' },
      { kind: 'invalid' },
      { kind: 'checking' },
      { kind: 'ok', stations: [], sensorCount: 0, assignedStationCount: null },
      { kind: 'ok', stations: [], sensorCount: 0, assignedStationCount: 2 },
      { kind: 'ok', stations: [{ stationId: 'a', displayName: 'A', lat: 35, lon: 139 }], sensorCount: 3, assignedStationCount: null },
      { kind: 'unreachable', detail: 'Failed to fetch' },
      { kind: 'http-error', status: 503 },
      { kind: 'unreadable', detail: 'x' },
    ]
    for (const s of all) expect(seismoStatusLine(s).text).not.toMatch(/[（(]/)
  })

  it('安全弁: 失敗の詳細を画面へ出さない', () => {
    // `fetch` が返す文面（`Failed to fetch` 等）は利用者の行動に繋がらない。
    // 詳細は記録へ出る（`seismoStream.ts`）。
    const line = seismoStatusLine({ kind: 'unreachable', detail: 'Failed to fetch' })
    expect(line.text).not.toContain('Failed to fetch')
    const unreadable = seismoStatusLine({ kind: 'unreadable', detail: 'sensors が無い' })
    expect(unreadable.text).not.toContain('sensors')
  })

  it('安全弁: HTTP の状態コードだけは内訳として出す', () => {
    // あちらはこちらの言葉ではなく相手が名乗った番号で、調べる手掛かりになる。
    expect(seismoStatusLine({ kind: 'http-error', status: 503 }).text).toContain('503')
  })

  it('安全弁: 色調の表は 3 種すべてを持つ', () => {
    expect(Object.keys(SEISMO_STATUS_TONE_CLASS).sort()).toEqual(['muted', 'ok', 'problem'])
  })
})
