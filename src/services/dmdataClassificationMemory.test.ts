// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DMDATA_CLASSIFICATION_MEMORY_KEY,
  forgetClassifications,
  loadRememberedClassifications,
  rememberClassifications,
  resetClassificationMemoryWarningsForTest,
  sameClassifications,
} from './dmdataClassificationMemory'
import { log } from '../utils/logger'

const KEY_A = 'AKe.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const KEY_B = 'AKe.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

describe('dmdataClassificationMemory', () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('覚えていなければ null を返す', () => {
    expect(loadRememberedClassifications(KEY_A)).toBeNull()
  })

  it('覚えた区分を同じ鍵で読み戻せる', () => {
    rememberClassifications(KEY_A, ['eew.warning', 'telegram.earthquake'])
    expect(loadRememberedClassifications(KEY_A)).toEqual(['eew.warning', 'telegram.earthquake'])
  })

  // 鍵を入れ替えたら、前の鍵が受けられた区分を当てない（契約の違う鍵かもしれない）
  it('別の鍵では読まない', () => {
    rememberClassifications(KEY_A, ['eew.forecast', 'telegram.earthquake'])
    expect(loadRememberedClassifications(KEY_B)).toBeNull()
  })

  it('鍵そのものは端末へ書かない', () => {
    rememberClassifications(KEY_A, ['eew.forecast'])
    expect(localStorage.getItem(DMDATA_CLASSIFICATION_MEMORY_KEY)).not.toContain(KEY_A)
  })

  it('後から覚えた区分で上書きする', () => {
    rememberClassifications(KEY_A, ['eew.forecast', 'telegram.earthquake'])
    rememberClassifications(KEY_A, ['telegram.earthquake'])
    expect(loadRememberedClassifications(KEY_A)).toEqual(['telegram.earthquake'])
  })

  // 壊れた値で起動を止めない。覚えが無いのと同じ扱い（今までどおり申し込みの結果を待つ）へ倒す
  it('壊れた JSON は null', () => {
    localStorage.setItem(DMDATA_CLASSIFICATION_MEMORY_KEY, '{not json')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(loadRememberedClassifications(KEY_A)).toBeNull()
  })

  it('知らない区分が混じっていたら丸ごと使わない', () => {
    rememberClassifications(KEY_A, ['eew.forecast'])
    const stored = JSON.parse(localStorage.getItem(DMDATA_CLASSIFICATION_MEMORY_KEY) ?? '{}') as Record<string, unknown>
    localStorage.setItem(DMDATA_CLASSIFICATION_MEMORY_KEY, JSON.stringify({ ...stored, classifications: ['eew.forecast', 'telegram.volcano'] }))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(loadRememberedClassifications(KEY_A)).toBeNull()
  })

  // 受けられる区分が無い鍵は接続そのものを止める（→ dmdata.ts の fatal）。空の覚えで取りに行かない
  it('空の区分は覚えず、読んでも null', () => {
    rememberClassifications(KEY_A, [])
    expect(loadRememberedClassifications(KEY_A)).toBeNull()
  })

  it('保存に失敗しても投げない', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError') })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => rememberClassifications(KEY_A, ['eew.forecast'])).not.toThrow()
  })

  // 繋がるたびに呼ばれる。書けない環境で再接続のたびに警告を出さないよう、同じ値なら書かない
  it('覚えている値と同じなら書き直さない', () => {
    rememberClassifications(KEY_A, ['eew.forecast'])
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    rememberClassifications(KEY_A, ['eew.forecast'])
    expect(setItem).not.toHaveBeenCalled()
  })

  // 認証エラーで覚えを捨てる。別の鍵の覚えは、この鍵の失敗と関係が無いので残す
  it('forgetClassifications はこの鍵の覚えだけ消す', () => {
    rememberClassifications(KEY_A, ['eew.forecast'])
    forgetClassifications(KEY_B)
    expect(loadRememberedClassifications(KEY_A)).toEqual(['eew.forecast'])
    forgetClassifications(KEY_A)
    expect(loadRememberedClassifications(KEY_A)).toBeNull()
  })

  it('forgetClassifications は壊れた覚えも消す', () => {
    localStorage.setItem(DMDATA_CLASSIFICATION_MEMORY_KEY, '{not json')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    forgetClassifications(KEY_A)
    expect(localStorage.getItem(DMDATA_CLASSIFICATION_MEMORY_KEY)).toBeNull()
  })

  // 保存領域を読めない環境では起動のたびに読む。警告はページを開いている間に 1 度だけ
  it('保存領域を読めない警告はページを開いている間に 1 度だけ出す', () => {
    resetClassificationMemoryWarningsForTest()
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('SecurityError') })
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    expect(loadRememberedClassifications(KEY_A)).toBeNull()
    expect(loadRememberedClassifications(KEY_A)).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  describe('sameClassifications', () => {
    it('並びが違っても同じ組なら真', () => {
      expect(sameClassifications(['eew.forecast', 'telegram.earthquake'], ['telegram.earthquake', 'eew.forecast'])).toBe(true)
    })
    it('1 つでも違えば偽', () => {
      expect(sameClassifications(['eew.forecast', 'telegram.earthquake'], ['eew.warning', 'telegram.earthquake'])).toBe(false)
      expect(sameClassifications(['eew.forecast', 'telegram.earthquake'], ['telegram.earthquake'])).toBe(false)
    })
  })
})
