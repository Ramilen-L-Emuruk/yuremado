/**
 * 端末の声（Web Speech API の `speechSynthesis`）で 1 文ずつ読む部品。
 *
 * 読み上げの流れ（割り込み・取り下げ・既読・追従）は `voicevox.ts` の `speakOnce` が持ち、ここは
 * 1 つの発話を鳴らして終わりを返すことだけを受け持つ。声は Windows の Haruka・iPhone と Mac の Kyoko を先に選び、
 * 速さは 1.1 倍（2026-11-08 ユーザー発言「1.1がいいですね。Windows iPhoneともに」）。
 *
 * **読み仮名の辞書は当てない**（2026-11-08 ユーザー選択「辞書なしで出す」）。VOICEVOX 用の辞書は句の区切りとアクセントの
 * 指定で、端末の声には渡す口が無い。
 *
 * **同時に持つ発話は 1 つだけ**（{@link active}）。`speechSynthesis.cancel()` は列にある発話をすべて止めるので、
 * 止めるときは必ず持ち主の発話を「止めた」で終わらせてから呼ぶ。そうしないと、止めた発話の見切りのタイマーが後で
 * 発火して、その間に始まった別の発話まで止める（割り込みで鳴り始め前の発話が列に残るのも同じ形で防ぐ）。
 */
import { log, createLogThrottle } from './logger'

/** 端末の声の速さ（2026-11-08 ユーザー発言「1.1がいいですね。Windows iPhoneともに」） */
export const SYSTEM_SPEECH_RATE = 1.1

/** 先に選ぶ声の名前（聴き比べで選んだもの。Windows は Haruka、iPhone と Mac は Kyoko） */
const PREFERRED_VOICE_NAMES = ['Haruka', 'Kyoko'] as const

/**
 * 鳴り始めを待つ上限（ms）。ブラウザによっては、操作の前に読ませると `onstart` も `onerror` も来ないまま黙る。
 * 待ち続けると読み上げの流れごと止まるので、ここで見切って「鳴らなかった」とする。
 */
const START_TIMEOUT_MS = 4000

/**
 * 鳴り始めてから終わりを待つ上限の見積もり（1 文字あたりの秒）。Chrome は `onend` を落とすことがあるので、
 * 文の長さから見積もった時間を過ぎたら止めて終わりとする。日本語の読み上げは 1.1 倍で 1 文字およそ 0.15 秒なので、
 * 倍以上の余裕を取る。
 */
const END_TIMEOUT_SEC_PER_CHAR = 0.35
const END_TIMEOUT_MIN_MS = 5000

/**
 * 声の一覧が空のとき、届くのを待つ上限（ms）。Chrome と Safari は開いた直後の `getVoices()` が空で、`voiceschanged` の後に
 * 埋まる。空のまま渡すと Haruka・Kyoko を選べず、端末の既定の声になる。
 */
const VOICES_WAIT_MS = 1000

const warnStartTimeout = createLogThrottle(60_000)
/** 失敗の種類（`ev.error`）ごとに間引く。種類をまたいで間引くと、別の原因の失敗が記録から消える */
const warnSpeechErrorByKind = new Map<string, ReturnType<typeof createLogThrottle>>()
function warnSpeechError(kind: string, text: string): void {
  let throttle = warnSpeechErrorByKind.get(kind)
  if (!throttle) { throttle = createLogThrottle(60_000); warnSpeechErrorByKind.set(kind, throttle) }
  throttle(() => log.warn(`[SystemSpeech] 端末の声で読めなかった（${kind}）: ${text.slice(0, 30)}`))
}

/** この端末で端末の声が使えるか */
export function isSystemSpeechSupported(): boolean {
  return typeof window !== 'undefined'
    && typeof window.speechSynthesis !== 'undefined'
    && typeof SpeechSynthesisUtterance !== 'undefined'
}

/**
 * 日本語の声を選ぶ。聴き比べで選んだ名前（Haruka・Kyoko）を先に、無ければ端末の中で動く日本語の声、
 * それも無ければ最初の日本語の声。日本語の声が 1 つも無ければ null（言語だけ指定して端末に任せる）。
 */
export function pickJapaneseVoice(voices: readonly SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  const ja = voices.filter(v => v.lang.replace('_', '-').toLowerCase().startsWith('ja'))
  for (const name of PREFERRED_VOICE_NAMES) {
    const matches = ja.filter(v => v.name.includes(name))
    const picked = matches.find(v => v.localService) ?? matches[0]
    if (picked) return picked
  }
  return ja.find(v => v.localService) ?? ja[0] ?? null
}

/**
 * 声の一覧が空なら、届くまで（最大 {@link VOICES_WAIT_MS}）待つ。**待つのは一度だけ** —— 埋まっても時間切れでも、以後は待たない
 * （声が 1 つも無い端末で、チャンクごとに 1 秒ずつ遅れないため）。
 */
let voicesReady = false
function waitForVoices(): Promise<void> {
  if (voicesReady) return Promise.resolve()
  const synth = window.speechSynthesis
  if (synth.getVoices().length > 0) { voicesReady = true; return Promise.resolve() }
  return new Promise(resolve => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      synth.removeEventListener?.('voiceschanged', onChange)
      voicesReady = true
      resolve()
    }
    const onChange = () => finish()
    const timer = setTimeout(finish, VOICES_WAIT_MS)
    synth.addEventListener?.('voiceschanged', onChange)
  })
}

/**
 * 1 つの発話の結末。`ended` は最後まで鳴った、`timeout` は鳴り始めたが読み終わりの知らせが来ず見切った（たぶん鳴りきっている）、
 * `cancelled` は止められた、`failed` は鳴らなかったか途中で壊れた（鳴り始めてから壊れたかは呼び出し側が `onStart` で知っている）。
 *
 * `timeout` を `ended` と分けるのは、声の長さを測る側（`voicevox.ts` の `measureSystemSpeechSec`）が、見切った時間を長さとして覚えないため。
 */
export type SystemUtteranceResult = 'ended' | 'timeout' | 'cancelled' | 'failed'

/**
 * いま持っている発話。**参照を握っておく** —— Chrome は参照の切れた発話を片付け、`onend` を出さなくなる。
 * `finish` を呼べば、その発話のタイマーも落ちて結末が返る。
 */
let active: { utter: SpeechSynthesisUtterance; finish: (result: SystemUtteranceResult) => void } | null = null

/** 持っている発話を「止めた」で終わらせ、列を空にする */
function dropActive(): void {
  const prev = active
  active = null
  prev?.finish('cancelled')
  try {
    window.speechSynthesis.cancel()
  } catch (err) {
    log.debug('[SystemSpeech] 止められなかった', err)
  }
}

/**
 * 1 文を鳴らし、終わったら結末を返す。例外は投げない。前の発話が残っていれば止めてから渡す。
 *
 * @param onStart 実際に鳴り始めたときに呼ぶ（既読と追従はここで進める）
 */
export async function speakSystemUtterance(
  text: string, volume: number, onStart: () => void,
): Promise<SystemUtteranceResult> {
  if (!isSystemSpeechSupported()) return 'failed'
  // 声の一覧を待つ間に別の発話が始まったら、こちらは渡さずに降りる
  const ticket = {}
  pendingTicket = ticket
  await waitForVoices()
  if (pendingTicket !== ticket) return 'cancelled'
  pendingTicket = null
  if (active !== null) {
    dropActive()
  } else if (window.speechSynthesis.speaking || window.speechSynthesis.pending) {
    // 持ち主のいない発話が列に残っている（見切った発話・後始末の済んだ有効化の発話）。後ろに並ぶと開始待ちを食うので止める
    try { window.speechSynthesis.cancel() } catch { /* 止められなくても先へ進む */ }
  }
  return new Promise(resolve => {
    let settled = false
    let started = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const utter = new SpeechSynthesisUtterance(text)
    const finish = (result: SystemUtteranceResult) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      if (active?.utter === utter) active = null
      resolve(result)
    }
    /** 見切るとき。**列を止めるのは自分がまだ持ち主のときだけ**（他の発話を巻き込まない） */
    const giveUp = (result: SystemUtteranceResult) => {
      const mine = active?.utter === utter
      finish(result)
      if (mine) {
        try { window.speechSynthesis.cancel() } catch { /* 止められなくても先へ進む */ }
      }
    }
    utter.lang = 'ja-JP'
    const voice = pickJapaneseVoice(window.speechSynthesis.getVoices())
    if (voice) utter.voice = voice
    utter.rate = SYSTEM_SPEECH_RATE
    utter.volume = Math.min(1, Math.max(0, volume))
    utter.onstart = () => {
      // 見切った後に遅れて鳴り始めても、端末の声が使えることには変わりない
      speechEverStarted = true
      if (settled || started) return
      started = true
      if (timer !== null) clearTimeout(timer)
      const endMs = Math.max(END_TIMEOUT_MIN_MS, text.length * END_TIMEOUT_SEC_PER_CHAR * 1000)
      timer = setTimeout(() => {
        log.warn(`[SystemSpeech] 読み終わりの知らせが ${Math.round(endMs / 1000)} 秒来ないため、止めて次へ進む: ${text.slice(0, 30)}`)
        giveUp('timeout')
      }, endMs)
      try {
        onStart()
      } catch (err) {
        log.warn('[SystemSpeech] 鳴り始めの知らせの処理に失敗（読み上げは続行）', err)
      }
    }
    utter.onend = () => finish('ended')
    utter.onerror = (ev) => {
      // 止めたとき（割り込み・取り消し）は異常ではない
      if (ev.error === 'interrupted' || ev.error === 'canceled') { finish('cancelled'); return }
      warnSpeechError(ev.error, text)
      // 鳴り始めてから壊れても「最後まで鳴った」とはしない（後ろのチャンクを読まずに止める）
      finish('failed')
    }
    timer = setTimeout(() => {
      warnStartTimeout(() => log.warn(`[SystemSpeech] 端末の声が鳴り始めない（画面をまだ一度も操作していない可能性）: ${text.slice(0, 30)}`))
      giveUp('failed')
    }, START_TIMEOUT_MS)
    active = { utter, finish }
    try {
      window.speechSynthesis.speak(utter)
    } catch (err) {
      log.warn('[SystemSpeech] 端末の声に渡せなかった', err)
      finish('failed')
    }
  })
}

/** 声の一覧を待っている発話の札（{@link speakSystemUtterance}）。止めるときに外す */
let pendingTicket: object | null = null

/** 鳴っている・待っている端末の声をすべて止める（持ち主の発話は「止めた」で終わる） */
export function cancelSystemSpeech(): void {
  if (!isSystemSpeechSupported()) return
  pendingTicket = null
  dropActive()
}

/**
 * もう有効化が要らないか。端末の声の発話が一度でも鳴り始めたか、有効化の発話が最後まで済んだ（`onend`）ら真。
 * 鳴り始めの知らせを出さずに終わりだけ出す環境（声が 1 つも無い端末）でも、終わりが来れば発話は受け付けられている
 */
let speechEverStarted = false
/** 有効化を試した回数（1 秒の間隔を見るため。上限は置かない —— 2026-11-08 ユーザー選択「上限を置かない (Recommended)」） */
let unlockAttempts = 0
/** 有効化のために渡した空の発話と、渡した時刻（鳴り始めずに残ったものを見分けてやり直すため） */
let unlockUtter: SpeechSynthesisUtterance | null = null
let unlockIssuedAt = 0
/** 渡したばかりの有効化の発話は、鳴り始めを待つ（同じ操作から続けて呼ばれても渡し直さない） */
const UNLOCK_RETRY_AFTER_MS = 1000

/**
 * 画面の操作で、端末の声を使えるようにする。iPhone の Safari は、最初の発話を「利用者の操作」の中で始めないと以後も読まない。
 * 音量 0 の空の発話を 1 つ渡す。**持ち主として登録する** —— 直後に本番の発話が来たら、これを止めてから渡す（列に残して本番を待たせない）。
 *
 * **呼ぶのは、ブラウザが操作と数える瞬間にする**（指を離したとき `pointerup`・キー入力 `keydown`）。指で触れた瞬間の `pointerdown` は
 * 操作と数えられず、そこで渡した発話は iPhone では鳴り始めない（2026-11-08 実機の記録: `pointerdown(touch)` の時点で
 * `navigator.userActivation.isActive` が偽、`pointerup` で真）。
 *
 * 有効化が済む（発話が一度でも鳴り始める・有効化の発話が最後まで済む）までは、呼ばれるたびに試す。前に渡した有効化の発話が
 * 1 秒たっても鳴り始めずに残っていれば、捨ててやり直す。回数の上限は置かない（使えないまま止まらないため。渡すのは 1 秒に 1 回まで）。
 *
 * @returns もう有効化が要らなければ true（呼び出し側は操作の見張りを外してよい）
 */
export function unlockSystemSpeech(): boolean {
  if (!isSystemSpeechSupported() || speechEverStarted) return true
  // 前に渡してから 1 秒は渡し直さない（失敗で終わった後も。操作と数えられない操作が続いて上限を一気に使い切らないため）
  if (unlockAttempts > 0 && performance.now() - unlockIssuedAt < UNLOCK_RETRY_AFTER_MS) return false
  if (active !== null) {
    // 本番の発話が持ち主なら邪魔しない（鳴り始めれば有効化は済む）
    if (active.utter !== unlockUtter) return false
    // 操作の外で渡されて鳴り始めなかった有効化の発話。捨てて、この操作の中で渡し直す
    dropActive()
  }
  try {
    const utter = new SpeechSynthesisUtterance(' ')
    utter.volume = 0
    const finish = () => {
      if (active?.utter === utter) active = null
      if (unlockUtter === utter) unlockUtter = null
    }
    utter.onstart = () => { speechEverStarted = true }
    // 数えるのは持ち主のまま最後まで済んだときだけ。止めて捨てた後に届く終わりの知らせ（WebKit は cancel にも end を出すことがある）は数えない
    utter.onend = () => { if (unlockUtter === utter) speechEverStarted = true; finish() }
    utter.onerror = (ev) => {
      // 本番の発話に止められたとき（interrupted・canceled）は異常ではない。それ以外は、操作の中で有効にできなかった印
      if (ev.error !== 'interrupted' && ev.error !== 'canceled') log.debug(`[SystemSpeech] 有効化の発話が失敗（${ev.error}）`)
      finish()
    }
    active = { utter, finish }
    unlockUtter = utter
    unlockIssuedAt = performance.now()
    unlockAttempts++
    window.speechSynthesis.speak(utter)
  } catch (err) {
    active = null
    unlockUtter = null
    log.debug('[SystemSpeech] 有効化の発話に失敗', err)
  }
  return false
}

export function __resetSystemSpeechForTest(): void {
  active = null
  pendingTicket = null
  voicesReady = false
  speechEverStarted = false
  unlockUtter = null
  unlockIssuedAt = 0
  unlockAttempts = 0
  warnSpeechErrorByKind.clear()
}
