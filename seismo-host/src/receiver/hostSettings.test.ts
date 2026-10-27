import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { DETECTION_SETTINGS_DEFAULT, type DetectionSettings } from '../detection/detectionSettings'
import {
  EMPTY_HOST_SETTINGS,
  HostSettingsFile,
  dirsUnder,
  isInside,
  parseHostSettings,
  readHostSettings,
  resolveDetection,
  resolveStorage,
  samePath,
  storageRootProblem,
  writeHostSettings,
  hostSettingsProblemDetail,
} from './hostSettings'

const DEFAULT_ROOT = join(tmpdir(), 'seismo-default-root')
const OTHER = join(tmpdir(), 'seismo-other-root')
const THIRD = join(tmpdir(), 'seismo-third-root')

describe('resolveStorage', () => {
  it('何も無ければ既定の親フォルダの下に 4 つを並べる', () => {
    const r = resolveStorage({ env: {}, settings: EMPTY_HOST_SETTINGS, defaultRoot: DEFAULT_ROOT })
    expect(r.source).toBe('default')
    expect(r.root).toBe(DEFAULT_ROOT)
    expect(r.dirs).toEqual(dirsUnder(DEFAULT_ROOT))
    expect(r.movedFrom).toBeNull()
    expect(r.nextSettings).toBeNull()
  })

  it('待っている変更は昇格させ、前の親フォルダを複製元として返す', () => {
    const r = resolveStorage({
      env: {},
      settings: { dataRoot: null, pendingDataRoot: OTHER, pendingFrom: null, detection: null, pendingDetection: null },
      defaultRoot: DEFAULT_ROOT,
    })
    expect(r.source).toBe('settings')
    expect(r.dirs).toEqual(dirsUnder(OTHER))
    expect(r.movedFrom).toBe(DEFAULT_ROOT)
    expect(r.nextSettings).toEqual({ dataRoot: OTHER, pendingDataRoot: null, pendingFrom: null, detection: null, pendingDetection: null })
  })

  it('正: 保存先を選んだ時の場所（pendingFrom）があれば、それを複製元にする（既定の保存先がプログラムと一緒に動いても）', () => {
    const r = resolveStorage({
      env: {},
      settings: { dataRoot: null, pendingDataRoot: OTHER, pendingFrom: THIRD, detection: null, pendingDetection: null },
      defaultRoot: DEFAULT_ROOT,
    })
    expect(r.movedFrom).toBe(THIRD)
    expect(r.dirs).toEqual(dirsUnder(OTHER))
    expect(r.nextSettings).toEqual({ dataRoot: OTHER, pendingDataRoot: null, pendingFrom: null, detection: null, pendingDetection: null })
  })

  it('2 度目の移動では、設定の保存先が複製元になる', () => {
    const r = resolveStorage({
      env: {},
      settings: { dataRoot: OTHER, pendingDataRoot: THIRD, pendingFrom: null, detection: null, pendingDetection: null },
      defaultRoot: DEFAULT_ROOT,
    })
    expect(r.movedFrom).toBe(OTHER)
    expect(r.dirs).toEqual(dirsUnder(THIRD))
  })

  it('対照: 待ちが今と同じ場所なら移さず、待ちだけ片付ける', () => {
    const r = resolveStorage({
      env: {},
      settings: { dataRoot: OTHER, pendingDataRoot: OTHER, pendingFrom: null, detection: null, pendingDetection: null },
      defaultRoot: DEFAULT_ROOT,
    })
    expect(r.movedFrom).toBeNull()
    expect(r.nextSettings).toEqual({ dataRoot: OTHER, pendingDataRoot: null, pendingFrom: null, detection: null, pendingDetection: null })
  })

  it('安全弁: 環境変数が 1 つでもあれば待っている変更は効かないと返し、足りない種類はいまの保存先に置いたまま（既定へ戻さない）', () => {
    const r = resolveStorage({
      env: { SEISMO_RAW_DIR: join(THIRD, 'r') },
      settings: { dataRoot: OTHER, pendingDataRoot: THIRD, pendingFrom: null, detection: null, pendingDetection: null },
      defaultRoot: DEFAULT_ROOT,
    })
    expect(r.source).toBe('env')
    expect(r.root).toBeNull()
    expect(r.dirs.raw).toBe(join(THIRD, 'r'))
    // 既定へ戻すと、画面で移した後に環境変数を 1 つ足しただけで残りの種類が既定の場所へ書き始める。
    expect(r.dirs.wave).toBe(dirsUnder(OTHER).wave)
    expect(r.nextSettings).toBeNull()
    expect(r.pendingIgnored).toBe(THIRD)
  })

  it('対照: 設定の保存先が無ければ、足りない種類は既定の置き場所', () => {
    const r = resolveStorage({
      env: { SEISMO_RAW_DIR: join(THIRD, 'r') },
      settings: EMPTY_HOST_SETTINGS,
      defaultRoot: DEFAULT_ROOT,
    })
    expect(r.dirs.wave).toBe(dirsUnder(DEFAULT_ROOT).wave)
  })

  it('空の環境変数は無いのと同じに扱う', () => {
    const r = resolveStorage({ env: { SEISMO_WAVE_DIR: '' }, settings: EMPTY_HOST_SETTINGS, defaultRoot: DEFAULT_ROOT })
    expect(r.source).toBe('default')
  })
})

describe('storageRootProblem', () => {
  it('相対パスを弾く', () => {
    expect(storageRootProblem('data2', DEFAULT_ROOT)).toBe('not-absolute')
  })
  it('今と同じ場所を弾く（Windows では大文字・小文字と末尾の区切りを無視する）', () => {
    expect(storageRootProblem('C:\\Data\\Seismo\\', 'c:\\data\\seismo', 'win32')).toBe('same')
  })
  it('対照: Windows 以外では大文字・小文字を区別し、末尾の区切りだけを無視する', () => {
    expect(storageRootProblem('/data/seismo/', '/data/seismo', 'linux')).toBe('same')
    expect(storageRootProblem('/Data/Seismo', '/data/seismo', 'linux')).toBeNull()
  })
  it('安全弁: 渡した platform の作法で比べる（実行している OS の作法を混ぜない）', () => {
    // Windows のパスは Linux の作法では絶対パスでない。CI（Linux）と手元（Windows）で結果を揃える
    expect(storageRootProblem('C:\\Data\\Seismo\\sub', 'c:\\data\\seismo', 'win32')).toBe('nested')
    expect(storageRootProblem('C:\\Data\\Seismo', '/data/seismo', 'linux')).toBe('not-absolute')
  })
  it('入れ子を両方向とも弾く', () => {
    expect(storageRootProblem(join(DEFAULT_ROOT, 'sub'), DEFAULT_ROOT)).toBe('nested')
    expect(storageRootProblem(tmpdir(), DEFAULT_ROOT)).toBe('nested')
  })
  it('対照: 名前の頭が同じだけの隣のフォルダは入れ子ではない', () => {
    expect(isInside(`${DEFAULT_ROOT}2`, DEFAULT_ROOT)).toBe(false)
    expect(storageRootProblem(`${DEFAULT_ROOT}2`, DEFAULT_ROOT)).toBeNull()
  })
  it('samePath は解決してから比べる', () => {
    expect(samePath(join(DEFAULT_ROOT, 'a', '..'), DEFAULT_ROOT)).toBe(true)
  })
})

describe('設定ファイル', () => {
  let dir: string | null = null
  afterEach(() => {
    if (dir !== null) rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  it('書いて読み戻せる', () => {
    dir = mkdtempSync(join(tmpdir(), 'host-settings-'))
    const path = join(dir, 'config', 'host-settings.json')
    writeHostSettings(path, { dataRoot: OTHER, pendingDataRoot: null, pendingFrom: null, detection: null, pendingDetection: null })
    expect(readHostSettings(path, unexpectedDiscard)).toEqual({ dataRoot: OTHER, pendingDataRoot: null, pendingFrom: null, detection: null, pendingDetection: null })
  })

  it('無ければ空の設定', () => {
    dir = mkdtempSync(join(tmpdir(), 'host-settings-'))
    expect(readHostSettings(join(dir, 'none.json'), unexpectedDiscard)).toEqual(EMPTY_HOST_SETTINGS)
  })

  it('安全弁: 壊れていれば既定へ倒さず投げる（データが 2 か所に割れる）', () => {
    dir = mkdtempSync(join(tmpdir(), 'host-settings-'))
    const path = join(dir, 'host-settings.json')
    writeFileSync(path, '{"dataRoot": 3}')
    expect(() => readHostSettings(path, unexpectedDiscard)).toThrow(/形が合わない/)
    writeFileSync(path, 'not json')
    expect(() => readHostSettings(path, unexpectedDiscard)).toThrow()
    expect(readFileSync(path, 'utf8')).toBe('not json')
  })

  it('相対パスの保存先は読み取りで弾く', () => {
    expect(parseHostSettings('{"dataRoot":"data"}', unexpectedDiscard)).toBeNull()
    expect(parseHostSettings('{"dataRoot":null}', unexpectedDiscard)).toEqual(EMPTY_HOST_SETTINGS)
    expect(parseHostSettings('{"pendingFrom":"data"}', unexpectedDiscard)).toBeNull()
  })

  it('v5.49.0 までの設定（pendingFrom が無い）は、選んだ時の場所が無いものとして読む', () => {
    expect(parseHostSettings(JSON.stringify({ dataRoot: null, pendingDataRoot: OTHER }), unexpectedDiscard)).toEqual({
      dataRoot: null,
      pendingDataRoot: OTHER,
      pendingFrom: null,
      detection: null,
      pendingDetection: null,
    })
  })

  it('正: 検出の値を書いて読み戻せる', () => {
    dir = mkdtempSync(join(tmpdir(), 'host-settings-'))
    const path = join(dir, 'host-settings.json')
    const value = { ...EMPTY_HOST_SETTINGS, pendingDetection: TUNED }
    writeHostSettings(path, value)
    expect(readHostSettings(path, unexpectedDiscard)).toEqual(value)
  })

  it('安全弁: 検出の値が読めなければ既定へ倒さず投げる（変えたはずの値と違う値で揺れを切り出し続ける）', () => {
    const broken = { ...EMPTY_HOST_SETTINGS, detection: { ...TUNED, trigger: { ...TUNED.trigger, staSec: 600 } } }
    expect(parseHostSettings(JSON.stringify(broken), unexpectedDiscard)).toBeNull()
  })

  it('正: 待っている検出の値だけが読めなければ、それを捨てて読み、理由を渡す（2026-10-27 ユーザー承認）', () => {
    const discarded: string[] = []
    const broken = { ...EMPTY_HOST_SETTINGS, detection: TUNED, pendingDetection: { ...TUNED, trigger: { ...TUNED.trigger, onRatio: 1 } } }
    expect(parseHostSettings(JSON.stringify(broken), (d) => discarded.push(d))).toEqual({ ...broken, pendingDetection: null })
    expect(parseHostSettings(JSON.stringify({ ...EMPTY_HOST_SETTINGS, pendingDetection: 'x' }), (d) => discarded.push(d))).toEqual(
      EMPTY_HOST_SETTINGS,
    )
    expect(discarded).toEqual(['onRatio=not-above-one', '形が違う'])
  })

  it('対照: 読める待ちの値は捨てない', () => {
    const value = { ...EMPTY_HOST_SETTINGS, pendingDetection: TUNED }
    expect(parseHostSettings(JSON.stringify(value), unexpectedDiscard)).toEqual(value)
  })
})

/** 捨てるはずのない読み出しに渡す（呼ばれたらテストを落とす）。 */
const unexpectedDiscard = (detail: string): never => {
  throw new Error(`捨てないはずの待ちの値を捨てた: ${detail}`)
}

const TUNED: DetectionSettings = {
  ...DETECTION_SETTINGS_DEFAULT,
  trigger: { ...DETECTION_SETTINGS_DEFAULT.trigger, onRatio: 3 },
}

describe('resolveDetection', () => {
  it('正: 待っている値を昇格させ、待ちを片付けて書き戻す（保存先の欄は触らない）', () => {
    const settings = { ...EMPTY_HOST_SETTINGS, dataRoot: OTHER, pendingDetection: TUNED }
    const r = resolveDetection(settings, DETECTION_SETTINGS_DEFAULT)
    expect(r.settings).toEqual(TUNED)
    expect(r.nextSettings).toEqual({ ...settings, detection: TUNED, pendingDetection: null })
  })

  it('対照: 待っていなければ今の値のまま・書き戻さない', () => {
    const r = resolveDetection({ ...EMPTY_HOST_SETTINGS, detection: TUNED }, DETECTION_SETTINGS_DEFAULT)
    expect(r).toEqual({ settings: TUNED, nextSettings: null })
    expect(resolveDetection(EMPTY_HOST_SETTINGS, DETECTION_SETTINGS_DEFAULT)).toEqual({ settings: null, nextSettings: null })
  })

  it('正: 既定と同じ値を待っていたら「既定」（null）へ戻す', () => {
    const r = resolveDetection(
      { ...EMPTY_HOST_SETTINGS, detection: TUNED, pendingDetection: DETECTION_SETTINGS_DEFAULT },
      DETECTION_SETTINGS_DEFAULT,
    )
    expect(r.settings).toBeNull()
    expect(r.nextSettings?.detection).toBeNull()
  })
})

describe('resolveStorage と検出の値', () => {
  it('安全弁: 保存先を昇格させても検出の値を消さない', () => {
    const settings = { ...EMPTY_HOST_SETTINGS, pendingDataRoot: OTHER, detection: TUNED, pendingDetection: TUNED }
    const r = resolveStorage({ env: {}, settings, defaultRoot: DEFAULT_ROOT })
    expect(r.nextSettings?.detection).toEqual(TUNED)
    expect(r.nextSettings?.pendingDetection).toEqual(TUNED)
  })
})

describe('HostSettingsFile', () => {
  it('正: 書き手は 1 つ。続けて変えても前の変更を消さない', () => {
    const written: unknown[] = []
    const file = new HostSettingsFile('x.json', EMPTY_HOST_SETTINGS, (_p, s) => written.push(s))
    file.update((s) => ({ ...s, pendingDataRoot: OTHER }))
    file.update((s) => ({ ...s, pendingDetection: TUNED }))
    expect(file.get()).toEqual({ ...EMPTY_HOST_SETTINGS, pendingDataRoot: OTHER, pendingDetection: TUNED })
    expect(written).toHaveLength(2)
  })

  it('安全弁: 書けなければ投げ、手元の値も変えない', () => {
    const file = new HostSettingsFile('x.json', EMPTY_HOST_SETTINGS, () => {
      throw new Error('EACCES')
    })
    expect(() => file.update((s) => ({ ...s, pendingDetection: TUNED }))).toThrow('EACCES')
    expect(file.get()).toEqual(EMPTY_HOST_SETTINGS)
  })
})

describe('hostSettingsProblemDetail', () => {
  it('正: 検出の欄のどの項目が駄目かを添える', () => {
    const bad = { ...DETECTION_SETTINGS_DEFAULT, trigger: { ...DETECTION_SETTINGS_DEFAULT.trigger, offRatio: 9 } }
    expect(hostSettingsProblemDetail(JSON.stringify({ detection: bad }))).toBe('（detection: offRatio=off-not-below-on）')
    expect(hostSettingsProblemDetail(JSON.stringify({ detection: { trigger: {} } }))).toBe('（detection: 形が違う）')
  })

  it('対照: 検出の欄が正しければ何も添えない・JSON が壊れていればそう言う', () => {
    expect(hostSettingsProblemDetail(JSON.stringify({ detection: DETECTION_SETTINGS_DEFAULT, dataRoot: 'x' }))).toBe('')
    expect(hostSettingsProblemDetail('{')).toBe('（JSON として読めない）')
    // 待っている変更は読めなくても捨てて読むので、起動を止めた理由に挙げない。
    const bad = { ...DETECTION_SETTINGS_DEFAULT, trigger: { ...DETECTION_SETTINGS_DEFAULT.trigger, offRatio: 9 } }
    expect(hostSettingsProblemDetail(JSON.stringify({ pendingDetection: bad, dataRoot: 'x' }))).toBe('')
  })
})
