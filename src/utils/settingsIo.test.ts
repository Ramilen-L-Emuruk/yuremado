import { describe, it, expect } from 'vitest'
import { buildSettingsFile, keysFileNotice, LEGACY_SETTINGS_FILE_APP, parseSettingsFile, settingsFileHasKeys, settingsFileName, SETTINGS_FILE_VERSION } from './settingsIo'
import { DEFAULTS, type AppSettings } from '../hooks/useSettings'

const withKey = (key: string): AppSettings => ({ ...DEFAULTS, dmdataApiKey: key })
/** 既定の書き出し（鍵を含めない・dev の注入値なし）。 */
const NO_KEYS = { includeKeys: false, injected: { apiKey: undefined, arrivalToken: undefined, forecastKey: undefined } }

// 鍵を含めるかは書き出すときに選ぶ（2026-10-23 ユーザー選択「含めるかを書き出すときに選べる」）
describe('鍵も含める書き出し', () => {
  const both: AppSettings = { ...DEFAULTS, dmdataApiKey: 'user-key', arrivalToken: 'user-token', forecastKey: 'user-forecast' }

  // 正: 選んだときは 2 つとも入り、読み込むとそのまま戻る
  it('鍵も含めると、API キーと到達予想キーが入る', () => {
    const file = buildSettingsFile(both, { ...NO_KEYS, includeKeys: true })
    expect(file.settings.dmdataApiKey).toBe('user-key')
    expect(file.settings.arrivalToken).toBe('user-token')
    expect(settingsFileHasKeys(file)).toBe(true)
    const r = parseSettingsFile(file, DEFAULTS)
    expect(r.ok && r.settings.dmdataApiKey).toBe('user-key')
    expect(r.ok && r.settings.arrivalToken).toBe('user-token')
  })

  // 対照: 選ばなければ 2 つとも空（既定）
  it('既定では鍵を含めない', () => {
    const file = buildSettingsFile(both, NO_KEYS)
    expect(file.settings.dmdataApiKey).toBe('')
    expect(file.settings.arrivalToken).toBe('')
    expect(settingsFileHasKeys(file)).toBe(false)
  })

  // 安全弁: dev サーバーが `.env.local` から入れた鍵は、選んでも出さない
  it('dev の注入値は、鍵も含めると選んでも書き出さない', () => {
    const file = buildSettingsFile(both, {
      includeKeys: true, injected: { apiKey: 'user-key', arrivalToken: 'user-token', forecastKey: 'user-forecast' },
    })
    expect(file.settings.dmdataApiKey).toBe('')
    expect(file.settings.arrivalToken).toBe('')
  })
})

describe('設定の書き出し', () => {
  it('正: 設定がそのまま入る', () => {
    const settings: AppSettings = { ...DEFAULTS, soundVolume: 0.42, uiScale: 1.5 }
    const file = buildSettingsFile(settings, NO_KEYS)
    expect(file.app).toBe('yuremado')
    expect(file.kind).toBe('settings')
    expect(file.version).toBe(SETTINGS_FILE_VERSION)
    expect(file.variant).toBe('unified')
    expect(file.settings.soundVolume).toBe(0.42)
    expect(file.settings.uiScale).toBe(1.5)
  })

  it('安全弁: APIキーは書き出しに含まれない', () => {
    // 書き出したファイルはディスクに残り、人へ渡ることもリポジトリへ入ることもある。
    const file = buildSettingsFile(withKey('secret-key-value'), NO_KEYS)
    expect(file.settings.dmdataApiKey).toBe('')
    expect(JSON.stringify(file)).not.toContain('secret-key-value')
  })

  it('安全弁: 元の設定オブジェクトを書き換えない', () => {
    const settings = withKey('secret-key-value')
    buildSettingsFile(settings, NO_KEYS)
    expect(settings.dmdataApiKey).toBe('secret-key-value')
  })

  it('正: ファイル名に時刻印が入る', () => {
    // 時刻印は formatFileStamp（診断ログと共有）。時間帯の表記が付くので、日付と時刻だけ見る。
    const name = settingsFileName(new Date(2026, 8, 15, 4, 5, 6))
    expect(name).toMatch(/^20260915_040506[+-]\d{4}_quake-viewer-settings\.json$/)
  })
})

describe('設定の読み込み', () => {
  it('正: 書き出したものを読み戻せる', () => {
    const settings: AppSettings = { ...DEFAULTS, soundVolume: 0.3, uiScale: 2, notifyMinScale: 40 }
    const round = parseSettingsFile(buildSettingsFile(settings, NO_KEYS), DEFAULTS)
    expect(round.ok).toBe(true)
    if (!round.ok) return
    expect(round.settings.soundVolume).toBe(0.3)
    expect(round.settings.uiScale).toBe(2)
    expect(round.settings.notifyMinScale).toBe(40)
  })

  // 通知を地震情報の通知から切り離す前に書き出したファイルも、端末の設定と同じく移し替える
  // （2026-10-24 ユーザー選択「ファイルにも掛ける (Recommended)」）
  it('正: 切り離す前のファイルで地震情報の通知を切っていれば、緊急地震速報・津波・南海トラフも切って入れ、読めなかった項目に数えない', () => {
    const { notifyNankai: _drop, ...old } = { ...DEFAULTS, notifyMinScale: -1, notifyEEW: true, notifyTsunami: true }
    const file = buildSettingsFile(old as AppSettings, NO_KEYS)
    const r = parseSettingsFile(file, DEFAULTS)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.settings.notifyEEW).toBe(false)
    expect(r.settings.notifyTsunami).toBe(false)
    expect(r.settings.notifyNankai).toBe(false)
    expect(r.rejectedKeys).toEqual([])
  })

  it('対照: 切り離した後に書き出したファイルは移し替えない', () => {
    const r = parseSettingsFile(buildSettingsFile({ ...DEFAULTS, notifyMinScale: -1, notifyEEW: true }, NO_KEYS), DEFAULTS)
    expect(r.ok && r.settings.notifyEEW).toBe(true)
  })

  // 読み上げの入り切りを voicevoxEnabled で持っていた頃に書き出したファイルも、端末の設定と同じく移し替える（→ `migrateLegacyTts`）
  it('正: voicevoxEnabled を入れていたファイルは、読み上げを入れて声を VOICEVOX にして入れ、読めなかった項目に数えない', () => {
    const { ttsEnabled: _a, ttsVoice: _b, ...rest } = DEFAULTS
    const file = buildSettingsFile({ ...rest, voicevoxEnabled: true } as unknown as AppSettings, NO_KEYS)
    const r = parseSettingsFile(file, DEFAULTS)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.settings.ttsEnabled).toBe(true)
    expect(r.settings.ttsVoice).toBe('voicevox')
    expect(r.rejectedKeys).toEqual([])
  })

  it('対照: ttsEnabled を持つファイルは移し替えない（声は書いてあるまま）', () => {
    const r = parseSettingsFile(buildSettingsFile({ ...DEFAULTS, ttsEnabled: true, ttsVoice: 'system' }, NO_KEYS), DEFAULTS)
    expect(r.ok && r.settings.ttsVoice).toBe('system')
  })

  it('安全弁: 読み込んでも、いま入力してあるAPIキーが消えない', () => {
    // 書き出しにキーが入らない以上、ファイル側は空。空で塗ると読み込むたびにキーが消える。
    const file = buildSettingsFile(DEFAULTS, NO_KEYS)
    const r = parseSettingsFile(file, withKey('current-key'))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.settings.dmdataApiKey).toBe('current-key')
    expect(r.usedFileApiKey).toBe(false)
  })

  it('対照: ファイルに手で書き足されたAPIキーは使う（意図して入れたものを無視しない）', () => {
    const file = { ...buildSettingsFile(DEFAULTS, NO_KEYS) }
    file.settings = { ...file.settings, dmdataApiKey: 'written-by-hand' }
    const r = parseSettingsFile(file, withKey('current-key'))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.settings.dmdataApiKey).toBe('written-by-hand')
    expect(r.usedFileApiKey).toBe(true)
  })

  it('正: 壊れた値は sanitize が既定へ戻す', () => {
    // 読み込み専用の検証を別に書かない決まりの裏取り。sanitize を通っていれば範囲外は直る。
    const file = buildSettingsFile(DEFAULTS, NO_KEYS)
    const broken = { ...file, settings: { ...file.settings, soundVolume: 99, uiScale: 'あ' } }
    const r = parseSettingsFile(broken, DEFAULTS)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.settings.soundVolume).toBe(DEFAULTS.soundVolume)
    expect(r.settings.uiScale).toBe(DEFAULTS.uiScale)
  })

  it('安全弁: 値が入っていたのに読めなかった項目は名前を返す', () => {
    // sanitize は弾いた値をほとんど黙って落とすので、ここで拾わないと画面が「読み込みました」
    // としか言えず、設定が既定へ戻ったことに気づけない。
    const file = buildSettingsFile(DEFAULTS, NO_KEYS)
    const broken = { ...file, settings: { ...file.settings, soundVolume: 99, uiScale: 'あ' } }
    const r = parseSettingsFile(broken, DEFAULTS)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.rejectedKeys).toEqual(expect.arrayContaining(['soundVolume', 'uiScale']))
  })

  it('対照: 項目が欠けているだけなら「読めなかった」に数えない', () => {
    // 項目が増える前に書き出したファイルには新しい項目が無いのが当たり前で、欠損補完は失敗ではない。
    const r = parseSettingsFile({
      app: 'yuremado', kind: 'settings', version: 1, variant: 'dmdss',
      settings: { soundVolume: 0.5 },
    }, DEFAULTS)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.rejectedKeys).toEqual([])
    expect(r.settings.soundVolume).toBe(0.5)
  })

  it('対照: 正常なファイルでは「読めなかった」が空', () => {
    const r = parseSettingsFile(buildSettingsFile({ ...DEFAULTS, uiScale: 1.25 }, NO_KEYS), DEFAULTS)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.rejectedKeys).toEqual([])
  })

  it('対照: 入れ子のオブジェクトでサブキーが欠けているだけなら数えない', () => {
    // `ttsTelegramTextBlocks` は後からブロックが増える。増える前に書き出したファイルには
    // 新しいサブキーが無いのが当たり前で、それは欠損補完であって失敗ではない。
    // オブジェクト全体の一致で見ていた頃は、ここで毎回「読めなかった」と誤報していた
    // （ブロックを 1 つ足すたび、それ以前の全ファイルが偽の警告を出すことになる）。
    const full = buildSettingsFile(DEFAULTS, NO_KEYS)
    const blocks = { ...(full.settings.ttsTelegramTextBlocks as Record<string, unknown>) }
    const [firstKey] = Object.keys(blocks)
    delete blocks[firstKey]
    const r = parseSettingsFile({ ...full, settings: { ...full.settings, ttsTelegramTextBlocks: blocks } }, DEFAULTS)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.rejectedKeys).not.toContain('ttsTelegramTextBlocks')
    // 欠けたサブキーは既定値で埋まる
    expect((r.settings.ttsTelegramTextBlocks as Record<string, unknown>)[firstKey])
      .toBe((DEFAULTS.ttsTelegramTextBlocks as Record<string, unknown>)[firstKey])
  })

  it('正: 入れ子のオブジェクトの中に読めない値があれば、その項目名を挙げる', () => {
    const full = buildSettingsFile(DEFAULTS, NO_KEYS)
    const blocks = { ...(full.settings.ttsTelegramTextBlocks as Record<string, unknown>) }
    const [firstKey] = Object.keys(blocks)
    blocks[firstKey] = 'これは真偽値ではない'
    const r = parseSettingsFile({ ...full, settings: { ...full.settings, ttsTelegramTextBlocks: blocks } }, DEFAULTS)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.rejectedKeys).toContain('ttsTelegramTextBlocks')
  })

  it('安全弁: 0 と -0 は同じ値として扱う', () => {
    // JSON は `-0` を書けるが、`clampNumber` は `Math.max` を通すので `0` になる。
    // `Object.is` に任せると、均されただけの値を「読めなかった」と誤報する。
    const full = buildSettingsFile(DEFAULTS, NO_KEYS)
    const r = parseSettingsFile({ ...full, settings: { ...full.settings, soundVolume: -0 } }, DEFAULTS)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.rejectedKeys).not.toContain('soundVolume')
  })

  it('安全弁: 配列は短くなったら見逃さない', () => {
    // いまの設定に配列の項目は無いが、`keptAsWritten` は `unknown` を受けるので挙動を固定する。
    // オブジェクトとして扱うと添字が「サブキー」になり、短くなった配列を欠損補完と読み違える。
    const full = buildSettingsFile(DEFAULTS, NO_KEYS)
    const withArray = { ...full, settings: { ...full.settings, ttsTelegramTextBlocks: [1, 2, 3] } }
    const r = parseSettingsFile(withArray, DEFAULTS)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.rejectedKeys).toContain('ttsTelegramTextBlocks')
  })

  it('安全弁: APIキーは「読めなかった」に数えない', () => {
    // 書き出しで空にしてから現在値へ差し替えるので必ず値が変わる。数えると毎回警告が出る。
    const r = parseSettingsFile(buildSettingsFile(DEFAULTS, NO_KEYS), withKey('current-key'))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.rejectedKeys).not.toContain('dmdataApiKey')
  })

  // 版を 1 つにまとめる前の印（dmdss・standard）のファイルも読む（docs/relay-server-design.md §0 の 2026-10-31 の行）
  it.each(['dmdss', 'standard', 'unified'])('正: 印が %s のファイルも読める（型は同じなので拒否しない）', (variant) => {
    const file = { ...buildSettingsFile({ ...DEFAULTS, soundVolume: 0.37 }, NO_KEYS), variant }
    const r = parseSettingsFile(file, DEFAULTS)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.settings.soundVolume).toBe(0.37)
  })

  it('正: リポジトリを改名する前に書き出したファイル（app が旧名）も読める', () => {
    // 作り置きの設定ファイルが、改名（2026-10-12）を境に読めなくならないこと。
    const old = { ...buildSettingsFile({ ...DEFAULTS, soundVolume: 0.42 }, NO_KEYS), app: LEGACY_SETTINGS_FILE_APP }
    const r = parseSettingsFile(old, DEFAULTS)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.settings.soundVolume).toBe(0.42)
  })

  it('対照: 別のアプリのファイルは受け付けない', () => {
    const r = parseSettingsFile({ app: 'something-else', kind: 'settings', version: 1, settings: {} }, DEFAULTS)
    expect(r.ok).toBe(false)
  })

  it('対照: 同じアプリでも種類が違えば受け付けない', () => {
    // いまのところ書き出しは設定しか無いので、この分岐は将来ほかの種類を足したときの保険。
    const r = parseSettingsFile({ app: 'yuremado', kind: 'something-else', version: 1, settings: {} }, DEFAULTS)
    expect(r.ok).toBe(false)
  })

  it('安全弁: 自分より新しい形式は受け付けない', () => {
    // 項目の意味が変わった後のファイルを古いアプリが黙って取り込むと、静かに設定が壊れる。
    const file = { ...buildSettingsFile(DEFAULTS, NO_KEYS), version: SETTINGS_FILE_VERSION + 1 }
    const r = parseSettingsFile(file, DEFAULTS)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('アプリを更新')
  })

  it('対照: 形式の番号が無いファイルは、新しい版とは別の文面で断る', () => {
    // 同じ文面にすると「アプリを更新してください」と案内することになるが、壊れたファイルは
    // 新しい版を入れても直らない。生の値（undefined）を画面へ出さないことも併せて確かめる。
    const file = { ...buildSettingsFile(DEFAULTS, NO_KEYS) } as Record<string, unknown>
    delete file.version
    const r = parseSettingsFile(file, DEFAULTS)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).not.toContain('undefined')
    expect(r.error).not.toContain('アプリを更新')
  })

  it('対照: settings が無いファイルは受け付けない', () => {
    const r = parseSettingsFile({ app: 'yuremado', kind: 'settings', version: 1 }, DEFAULTS)
    expect(r.ok).toBe(false)
  })

  it('対照: 設定ファイルの形をしていないものは受け付けない', () => {
    for (const bad of [null, undefined, 'text', 42, [], {}]) {
      expect(parseSettingsFile(bad, DEFAULTS).ok).toBe(false)
    }
  })
})

describe('キーだけのファイル（kind: keys）', () => {
  const current: AppSettings = { ...DEFAULTS, soundVolume: 0.42, arrivalToken: 'old-token' }
  const keysFile = (keys: Record<string, unknown>) => ({ app: 'yuremado', kind: 'keys', version: 1, keys })

  it('正: 予報キーだけを重ね、ほかの設定と入っていないキーはそのまま', () => {
    const r = parseSettingsFile(keysFile({ forecastKey: ' f.k ' }), current)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.settings.forecastKey).toBe('f.k')
    expect(r.settings.arrivalToken).toBe('old-token')
    expect(r.settings.soundVolume).toBe(0.42)
    expect(r.keysOnly).toEqual({ forecastKey: true, arrivalToken: false })
    expect(keysFileNotice(r.keysOnly!)).toBe('予報キーを読み込みました（ほかの設定はそのままです）')
  })

  it('正: 2 つとも入っていれば両方を名前に出す', () => {
    const r = parseSettingsFile(keysFile({ forecastKey: 'f.k', arrivalToken: 'a.t' }), current)
    expect(r.ok && r.keysOnly && keysFileNotice(r.keysOnly)).toBe('予報キー・到達予想キーを読み込みました（ほかの設定はそのままです）')
  })

  it('対照: キーが 1 つも無いファイルは断る', () => {
    expect(parseSettingsFile(keysFile({}), current).ok).toBe(false)
    expect(parseSettingsFile(keysFile({ forecastKey: 42 }), current).ok).toBe(false)
  })

  it('対照: 設定のファイルなら keysOnly は null', () => {
    const r = parseSettingsFile(buildSettingsFile(DEFAULTS, NO_KEYS), current)
    expect(r.ok && r.keysOnly).toBeNull()
  })

  it('安全弁: 予報キーも、鍵を含めて書き出したときだけファイルへ出る', () => {
    expect(buildSettingsFile({ ...DEFAULTS, forecastKey: 'f' }, NO_KEYS).settings.forecastKey).toBe('')
    const withKeys = buildSettingsFile({ ...DEFAULTS, forecastKey: 'f' }, { ...NO_KEYS, includeKeys: true })
    expect(withKeys.settings.forecastKey).toBe('f')
    expect(settingsFileHasKeys(withKeys)).toBe(true)
  })
})

// 使用状況データの送信の許可は運ばない（2026-11-03 ユーザー選択「運ばない (Recommended)」）
describe('使用状況データの送信の許可', () => {
  const on: AppSettings = { ...DEFAULTS, usageStatsEnabled: true }
  it('書き出したファイルには許可を入れない（いつもオフで書く）', () => {
    expect(buildSettingsFile(on, NO_KEYS).settings.usageStatsEnabled).toBe(false)
  })
  it('安全弁: オンと書かれたファイルを読み込んでも、許可していない端末はオフのまま', () => {
    const file = { ...buildSettingsFile(DEFAULTS, NO_KEYS), settings: { ...DEFAULTS, usageStatsEnabled: true } }
    const r = parseSettingsFile(file, DEFAULTS)
    expect(r.ok && r.settings.usageStatsEnabled).toBe(false)
  })
  it('対照: 許可している端末は、オフと書かれたファイルを読み込んでもオンのまま', () => {
    const r = parseSettingsFile(buildSettingsFile(DEFAULTS, NO_KEYS), on)
    expect(r.ok && r.settings.usageStatsEnabled).toBe(true)
  })
})

// プッシュ通知の購読も運ばない（2026-11-03 ユーザー選択「設定で入れたときだけ (Recommended)」）
describe('プッシュ通知の購読', () => {
  const on: AppSettings = { ...DEFAULTS, pushNotifyEnabled: true }
  it('書き出したファイルには入れない（いつもオフで書く）', () => {
    expect(buildSettingsFile(on, NO_KEYS).settings.pushNotifyEnabled).toBe(false)
  })
  it('安全弁: オンと書かれたファイルを読み込んでも、購読していない端末はオフのまま', () => {
    const file = { ...buildSettingsFile(DEFAULTS, NO_KEYS), settings: { ...DEFAULTS, pushNotifyEnabled: true } }
    const r = parseSettingsFile(file, DEFAULTS)
    expect(r.ok && r.settings.pushNotifyEnabled).toBe(false)
  })
  it('対照: 購読している端末は、オフと書かれたファイルを読み込んでもオンのまま', () => {
    const r = parseSettingsFile(buildSettingsFile(DEFAULTS, NO_KEYS), on)
    expect(r.ok && r.settings.pushNotifyEnabled).toBe(true)
  })
  it('通知する地域は運ぶ（端末に結びつかない設定）', () => {
    const r = parseSettingsFile(buildSettingsFile({ ...DEFAULTS, notifyPrefectures: ['13', '16'] }, NO_KEYS), DEFAULTS)
    expect(r.ok && r.settings.notifyPrefectures).toEqual(['13', '16'])
  })
})
