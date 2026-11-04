// 時報の純粋な計算。次に鳴らす時刻・鳴らさない時間帯・読み上げの文・音と声を置く時刻を決める。
// 鳴らすのは `hooks/useTimeSignal.ts`、音そのものは `utils/alertSound.ts` の `scheduleTimeSignalSound`。
//
// 決めたこと（いずれも 2026-11-04 ユーザー選択）:
// - 時刻は `serverNow()`（リプレイ中は再生時刻）。時計がまだ合っていなくても端末の時計で鳴らす
// - 間隔は 1 時間・30 分・15 分・10 分・5 分。既定は切
// - 音は「ピッ・ピッ・ピッ・ポーン」「ポーン」「チャイム」「鳴らさない」
// - 順番は「音が先（既定）」「読み上げが先」。どちらでも時刻の合図（ポーン・チャイムの頭）は境の時刻ちょうど
// - 読み上げの文は 4 形。既定は「15時30分です」。時刻の読み方は 24 時間制（既定）と 12 時間制
// - 鳴らさない時間帯は始まりと終わりを分まで決める（日をまたいでよい）
// - 他の読み上げの最中に境が来たら「音だけ鳴らす（既定）」か「鳴らさない」

/** 間隔（分）。60 を割り切る値だけ（境が毎時同じ分に揃う）。 */
export type TimeSignalIntervalMin = 60 | 30 | 15 | 10 | 5
export const TIME_SIGNAL_INTERVALS: readonly TimeSignalIntervalMin[] = [60, 30, 15, 10, 5]

export type TimeSignalSound = 'pips' | 'pon' | 'chime' | 'none'
export const TIME_SIGNAL_SOUNDS: readonly TimeSignalSound[] = ['pips', 'pon', 'chime', 'none']

export type TimeSignalOrder = 'soundFirst' | 'speechFirst'
export const TIME_SIGNAL_ORDERS: readonly TimeSignalOrder[] = ['soundFirst', 'speechFirst']

/** 読み上げの文の形。`oshirase`「15時30分をお知らせします」・`desu`「15時30分です」・`narimashita`「15時30分になりました」・`bare`「15時30分」 */
export type TimeSignalPhrase = 'oshirase' | 'desu' | 'narimashita' | 'bare'
export const TIME_SIGNAL_PHRASES: readonly TimeSignalPhrase[] = ['oshirase', 'desu', 'narimashita', 'bare']

export type TimeSignalClock = '24h' | '12h'
export const TIME_SIGNAL_CLOCKS: readonly TimeSignalClock[] = ['24h', '12h']

/** 他の読み上げの最中に境が来たとき。`soundOnly` は音だけ鳴らして読み上げを省く、`skip` はその回を飛ばす */
export type TimeSignalWhileSpeaking = 'soundOnly' | 'skip'
export const TIME_SIGNAL_WHILE_SPEAKING: readonly TimeSignalWhileSpeaking[] = ['soundOnly', 'skip']

/** 1 日の分（0〜1439）。 */
export const MINUTES_PER_DAY = 24 * 60

/**
 * `nowMs` より**後**の最初の境（epoch ms）。境は端末の現地時刻で、毎時 0 分から `intervalMin` ごと。
 *
 * ちょうど境の時刻を渡すと次の境を返す（鳴らしたばかりの境をもう一度選ばない）。
 */
export function nextSignalAt(nowMs: number, intervalMin: TimeSignalIntervalMin): number {
  const d = new Date(nowMs)
  d.setSeconds(0, 0)
  const m = d.getMinutes()
  d.setMinutes(m - (m % intervalMin) + intervalMin)
  // 夏時間の切り替わりで現地の時計が戻ると、組んだ時刻が `nowMs` 以前になりうる
  while (d.getTime() <= nowMs) d.setMinutes(d.getMinutes() + intervalMin)
  return d.getTime()
}

/**
 * `atMs` が鳴らさない時間帯に入るか。始まりは含み、終わりは含まない（22:00〜7:00 なら 22:00 は鳴らさず 7:00 は鳴らす）。
 * 始まりと終わりが同じなら、時間帯は空（いつでも鳴らす）。
 */
export function isInQuietHours(atMs: number, startMin: number, endMin: number): boolean {
  if (startMin === endMin) return false
  const d = new Date(atMs)
  const m = d.getHours() * 60 + d.getMinutes()
  return startMin < endMin
    ? m >= startMin && m < endMin
    : m >= startMin || m < endMin
}

/** 時刻の読み。正時は分を読まない（「15時」）。12 時間制は 0〜11 時に午前・午後を付ける（正午は「午後0時」）。 */
export function timeSignalClockText(atMs: number, clock: TimeSignalClock): string {
  const d = new Date(atMs)
  const h = d.getHours()
  const m = d.getMinutes()
  const hour = clock === '24h' ? `${h}時` : `${h < 12 ? '午前' : '午後'}${h % 12}時`
  return m === 0 ? hour : `${hour}${m}分`
}

/** 読み上げる文。 */
export function timeSignalSpeechText(atMs: number, clock: TimeSignalClock, phrase: TimeSignalPhrase): string {
  const t = timeSignalClockText(atMs, clock)
  switch (phrase) {
    case 'oshirase': return `${t}をお知らせします`
    case 'desu': return `${t}です`
    case 'narimashita': return `${t}になりました`
    case 'bare': return t
  }
}

/**
 * 音の形（秒）。`leadSec` は合図の前に鳴り始める長さ、`tailSec` は合図から鳴り終わるまで。
 * **`alertSound.ts` の `scheduleTimeSignalSound` と揃えること**（あちらがこの表を読んで音を置く）。
 */
export const TIME_SIGNAL_SOUND_SHAPE: Record<TimeSignalSound, { leadSec: number; tailSec: number }> = {
  // 57・58・59 秒にピッ、00 秒ちょうどにポーン（電話の時報 117 と同じ並び）
  pips: { leadSec: 3, tailSec: 1.2 },
  pon: { leadSec: 0, tailSec: 1.2 },
  // 4 音を 0.3 秒ごとに。最後の音の余韻まで
  chime: { leadSec: 0, tailSec: 1.6 },
  none: { leadSec: 0, tailSec: 0 },
}

/** 音と声の間（秒）。 */
export const TIME_SIGNAL_SPEECH_GAP_SEC = 0.3

/**
 * 声を出し始める時刻（境からの秒。負なら境より前）。
 *
 * - 音が先: 音が鳴り終わってから間を置いて読む（音なしなら境ちょうどに読み始める）
 * - 読み上げが先: 音が鳴り始める間の手前で読み終わるよう、読み上げの長さから逆算する（音なしなら境で読み終わる）
 */
export function speechStartOffsetSec(sound: TimeSignalSound, order: TimeSignalOrder, speechDurSec: number): number {
  const shape = TIME_SIGNAL_SOUND_SHAPE[sound]
  if (order === 'soundFirst') {
    return sound === 'none' ? 0 : shape.tailSec + TIME_SIGNAL_SPEECH_GAP_SEC
  }
  const gap = sound === 'none' ? 0 : TIME_SIGNAL_SPEECH_GAP_SEC
  return -shape.leadSec - gap - speechDurSec
}

/**
 * 境のどれだけ前から支度するか（ms）。音を先に予約しておくため。
 * **タブが裏に回ったときのタイマーの間引き（Chrome は 1 分に 1 回まで）より長く取る** —— 短いと、
 * 時計を見る刻みが支度の窓を飛び越え、その境は支度されないまま過ぎる。
 */
export const TIME_SIGNAL_PREPARE_MS = 75_000

/**
 * 読み上げが先の順で、声の長さとして見込む上限（秒）。この長さでも音の前に読み終われる時刻に先に合成し、
 * 実際の長さから始める時刻を決める。いちばん長い文（「午前11時55分をお知らせします」）で 3 秒前後（未実測）
 */
export const TIME_SIGNAL_MAX_SPEECH_SEC = 4

/**
 * 支度しているうちに時計がこれ以上動いたら、予約を取り直す（リプレイの頭出し・時計の較正のし直し）。
 */
export const TIME_SIGNAL_RESYNC_TOLERANCE_MS = 250

/**
 * 声を出すはずの時刻からこれ以上遅れて起きたら、その回の声は出さない（裏に回ったタブでタイマーが間引かれたとき）。
 * 遅れて読むと、過ぎた時刻を告げることになる。
 */
export const TIME_SIGNAL_LATE_SPEECH_MS = 2_000
