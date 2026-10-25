import { describe, it, expect } from 'vitest'
import { readTelegramOperationStatus } from './telegramOperationStatus'
import { operationBadgeOf } from '../components/TelegramTab/labels'

const xml = (status: string) =>
  `<?xml version="1.0"?><Report><Control><Title>配信テスト</Title><DateTime>2026-10-25T00:00:00Z</DateTime>` +
  `<Status>${status}</Status><EditorialOffice>気象庁本庁</EditorialOffice></Control>` +
  `<Head><Title>震源・震度に関する情報</Title></Head></Report>`

describe('readTelegramOperationStatus', () => {
  // 正: 訓練と試験を別に読む（配信元の `head.test` はどちらも同じ真）
  it('訓練と試験を読み分ける', () => {
    expect(readTelegramOperationStatus(xml('訓練'))).toBe('訓練')
    expect(readTelegramOperationStatus(xml('試験'))).toBe('試験')
  })

  // 対照: 通常の電文には何も付けない
  it('通常の電文は何も返さない', () => {
    expect(readTelegramOperationStatus(xml('通常'))).toBeUndefined()
  })

  // 安全弁: `Control` の外の `Status`（本文の観測状態など）を運用種別と取り違えない
  it('Control の外の Status は読まない', () => {
    const body = `<Report><Control><Status>通常</Status></Control><Body><Status>試験</Status></Body></Report>`
    expect(readTelegramOperationStatus(body)).toBeUndefined()
    expect(readTelegramOperationStatus('<broken')).toBeUndefined()
  })

  // 正: 開始タグに属性や接頭辞が付いても読む
  it('Control の開始タグに属性・接頭辞があっても読む', () => {
    expect(readTelegramOperationStatus(`<Report><Control xmlns="x"><Status>訓練</Status></Control></Report>`)).toBe('訓練')
    expect(readTelegramOperationStatus(`<jmx:Report><jmx:Control><jmx:Status>試験</jmx:Status></jmx:Control></jmx:Report>`)).toBe('試験')
  })

  // 安全弁: Control に Status が無ければ、後ろの別の Status を拾わない。名前が Control で始まる別の要素も見ない
  it('Control の中に Status が無ければ何も返さない', () => {
    expect(readTelegramOperationStatus(`<Report><Control><Title>x</Title></Control><Body><Status>試験</Status></Body></Report>`)).toBeUndefined()
    expect(readTelegramOperationStatus(`<Report><ControlX><Status>試験</Status></ControlX></Report>`)).toBeUndefined()
  })
})

describe('operationBadgeOf', () => {
  it('名乗りがあればそれを、無くて試験報の印だけなら「訓練・試験」を出す', () => {
    expect(operationBadgeOf({ operationStatus: '訓練', isTest: true })?.label).toBe('訓練')
    expect(operationBadgeOf({ operationStatus: '試験', isTest: true })?.label).toBe('試験')
    expect(operationBadgeOf({ isTest: true })?.label).toBe('訓練・試験')
    expect(operationBadgeOf({ isTest: false })).toBeNull()
  })

  // 安全弁: 配信元が印を立てていなくても、本文が訓練と名乗れば印を付ける（テストボタンの訓練の台本）
  it('isTest が偽でも、本文の名乗りがあれば印を付ける', () => {
    expect(operationBadgeOf({ operationStatus: '訓練', isTest: false })?.label).toBe('訓練')
  })
})
