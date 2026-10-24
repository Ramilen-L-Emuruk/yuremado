// @vitest-environment jsdom
//
// ウィンドウタイトルが平常へ戻る時刻と、取消で下ろす口のテスト。
//
// 1. **戻る時刻は自動復帰の秒数に合わせる**（2026-10-23 ユーザー選択「自動復帰に合わせる (Recommended)」）。
//    自動復帰を無効にした端末では次の情報まで出す。ただし「津波のタイトルを一定時間に制限」は 30 秒のまま
//    （2026-10-24 ユーザー選択「30 秒のまま (Recommended)」）
// 2. **取消で下ろすのは、いま出ているのがその種別のタイトルのときだけ**（`releaseTitle`）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useAlertTitle, titleResetMs, joinTitleParts, TSUNAMI_ACTIVE_TITLE } from './useAlertTitle'
import type { EEWAlert } from '../types/earthquake'

function setup(idleRevertSec: number, temporary = false) {
  const activeEEWsRef = { current: new Map<string, EEWAlert>() }
  const kyoshinDetectedRef = { current: false }
  const h = renderHook(() => useAlertTitle({ activeEEWsRef, kyoshinDetectedRef }))
  h.result.current.syncInputs({ tsunamiActive: false, tsunamiPriority: false, tsunamiTitleTemporary: temporary, idleRevertSec })
  return h
}

describe('titleResetMs', () => {
  it('正: 自動復帰の秒数そのまま', () => {
    expect(titleResetMs(60)).toBe(60_000)
    expect(titleResetMs(15)).toBe(15_000)
  })
  it('対照: 自動復帰が無効なら戻さない（null）', () => {
    expect(titleResetMs(0)).toBeNull()
    expect(titleResetMs(-1)).toBeNull()
  })
})

describe('タイトルが平常へ戻る時刻', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('正: 自動復帰が 60 秒なら 60 秒で戻る（かつては 30 秒で戻っていた）', () => {
    const h = setup(60)
    act(() => { h.result.current.setTitle('地震情報 石川県能登地方 最大震度5弱') })
    act(() => { h.result.current.scheduleTitleRevert('earthquake', null) })
    act(() => { vi.advanceTimersByTime(59_999) })
    expect(h.result.current.alertTitle).toBe('地震情報 石川県能登地方 最大震度5弱')
    act(() => { vi.advanceTimersByTime(1) })
    expect(h.result.current.alertTitle).toBeNull()
  })

  it('対照: 自動復帰が無効なら、時間が経っても戻らない', () => {
    const h = setup(0)
    act(() => { h.result.current.setTitle('地震情報 石川県能登地方 最大震度5弱') })
    act(() => { h.result.current.scheduleTitleRevert('earthquake', null) })
    act(() => { vi.advanceTimersByTime(600_000) })
    expect(h.result.current.alertTitle).toBe('地震情報 石川県能登地方 最大震度5弱')
  })

  it('安全弁: 自動復帰が無効でも「津波のタイトルを一定時間に制限」は 30 秒で閉じる', () => {
    const h = setup(0, true)
    act(() => { h.result.current.showTsunamiTitle() })
    expect(h.result.current.alertTitle).toBe(TSUNAMI_ACTIVE_TITLE)
    act(() => { vi.advanceTimersByTime(30_000) })
    expect(h.result.current.alertTitle).toBeNull()
  })
})

describe('releaseTitle', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('正: その種別が出したタイトルなら、取消で平常へ戻す', () => {
    const h = setup(30)
    act(() => { h.result.current.setTitle('長周期地震動 石川県能登地方 最大階級3') })
    act(() => { h.result.current.scheduleTitleRevert('lpgm', 'q1') })
    act(() => { h.result.current.releaseTitle('lpgm', 'q1') })
    expect(h.result.current.alertTitle).toBeNull()
  })

  it('対照: 後から別の情報がタイトルを取っていれば、そちらを消さない', () => {
    const h = setup(30)
    act(() => { h.result.current.setTitle('長周期地震動 石川県能登地方 最大階級3') })
    act(() => { h.result.current.scheduleTitleRevert('lpgm', 'q1') })
    act(() => { h.result.current.setTitle('地震情報 石川県能登地方 最大震度5弱') })
    act(() => { h.result.current.scheduleTitleRevert('earthquake', null) })
    act(() => { h.result.current.releaseTitle('lpgm', 'q1') })
    expect(h.result.current.alertTitle).toBe('地震情報 石川県能登地方 最大震度5弱')
  })

  it('安全弁: 先に張った種別の待ちが切れても、後から別の種別が出したタイトルは消さない', () => {
    const h = setup(30)
    act(() => { h.result.current.setTitle('地震情報 石川県能登地方 最大震度5弱') })
    act(() => { h.result.current.scheduleTitleRevert('earthquake', null) })
    act(() => { vi.advanceTimersByTime(10_000) })
    act(() => { h.result.current.setTitle('長周期地震動 石川県能登地方 最大階級3') })
    act(() => { h.result.current.scheduleTitleRevert('lpgm', 'q1') })
    act(() => { vi.advanceTimersByTime(20_000) })   // 地震情報の待ちが切れる
    expect(h.result.current.alertTitle).toBe('長周期地震動 石川県能登地方 最大階級3')
    act(() => { vi.advanceTimersByTime(10_000) })   // 長周期の待ちが切れる
    expect(h.result.current.alertTitle).toBeNull()
  })

  it('対照: 同じ種別でも別の電文への取消では下ろさない（別の地震の長周期・古い情報単位の臨時情報）', () => {
    const h = setup(30)
    act(() => { h.result.current.setTitle('南海トラフ地震臨時情報（巨大地震警戒）') })
    act(() => { h.result.current.scheduleTitleRevert('specialInfo', 'new-unit') })
    act(() => { h.result.current.releaseTitle('specialInfo', 'old-unit') })
    expect(h.result.current.alertTitle).toBe('南海トラフ地震臨時情報（巨大地震警戒）')
  })

  it('正: 識別子を null で渡せば種別だけで下ろす（臨時情報の調査終了）', () => {
    const h = setup(30)
    act(() => { h.result.current.setTitle('南海トラフ地震臨時情報（巨大地震注意）') })
    act(() => { h.result.current.scheduleTitleRevert('specialInfo', 'unit-a') })
    act(() => { h.result.current.releaseTitle('specialInfo', null) })
    expect(h.result.current.alertTitle).toBeNull()
  })
})

describe('extendTitle', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('正: いまのタイトルがその種別のものなら、待ちだけ張り直す', () => {
    const h = setup(30)
    act(() => { h.result.current.setTitle('地震情報 A 最大震度4') })
    act(() => { h.result.current.scheduleTitleRevert('earthquake', null) })
    act(() => { vi.advanceTimersByTime(20_000) })
    act(() => { h.result.current.extendTitle('earthquake') })
    act(() => { vi.advanceTimersByTime(20_000) })
    expect(h.result.current.alertTitle).toBe('地震情報 A 最大震度4')
    act(() => { vi.advanceTimersByTime(10_000) })
    expect(h.result.current.alertTitle).toBeNull()
  })

  it('安全弁: 別の種別のタイトルが出ていれば持ち主を奪わない（その種別の取消でちゃんと下りる）', () => {
    const h = setup(30)
    act(() => { h.result.current.setTitle('北海道・三陸沖後発地震注意情報 発表中') })
    act(() => { h.result.current.scheduleTitleRevert('kohatsu', 'k') })
    act(() => { h.result.current.extendTitle('earthquake') })
    act(() => { h.result.current.releaseTitle('kohatsu', 'k') })
    expect(h.result.current.alertTitle).toBeNull()
  })
})

describe('joinTitleParts', () => {
  it('正: 空の部品を詰め、空白を二重に残さない（震央地名が空の緊急地震速報）', () => {
    expect(joinTitleParts('緊急地震速報', '', '最大震度5弱予想', '')).toBe('緊急地震速報 最大震度5弱予想')
  })
  it('対照: 部品が揃えば空白 1 つで繋ぐ', () => {
    expect(joinTitleParts('緊急地震速報', '三陸沖', '最大震度5弱予想', '他1件')).toBe('緊急地震速報 三陸沖 最大震度5弱予想 他1件')
  })
})
