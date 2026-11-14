import { log } from '../utils/logger'

/**
 * 日本語以外の言語の日付の書き方。ブラウザが持つ言語ごとの書式（`Intl.DateTimeFormat`）で組み、
 * 時刻は 24 時間にそろえる（2026-11-11 ユーザー選択「言語ごとの書き方 (Recommended)」）。
 *
 * 渡す日時は、画面に出したい年月日・時刻を**その端末の時刻として**持つ `Date`。JST で決まる日（震源カタログの日付など）は、
 * 呼び出し側が年・月・日の数から `new Date(y, m - 1, d)` を作って渡す。
 *
 * 書式は作るたびに組み直さず、言語ごとに 1 回だけ作って使い回す（一覧の行ごとに呼ばれるため）。
 */
export interface DateWords {
  /** 月・日と時刻（地震の発生時刻など。日本語は「11月11日 11:32」） */
  monthDayTime: (d: Date) => string
  /** 月・日（日本語は「11月11日」） */
  monthDay: (d: Date) => string
  /** 年・月・日と曜日（地震タブ・電文ログの日付の区切り。日本語は「2026年11月11日」） */
  fullDate: (d: Date) => string
  /** 曜日の無い年・月・日（震源カタログの期間など） */
  calendarDate: (d: Date) => string
}

export function intlDateWords(tag: string): DateWords {
  const monthDayTime = new Intl.DateTimeFormat(tag, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hourCycle: 'h23' })
  const monthDay = new Intl.DateTimeFormat(tag, { month: 'short', day: 'numeric' })
  const fullDate = new Intl.DateTimeFormat(tag, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' })
  const calendarDate = new Intl.DateTimeFormat(tag, { year: 'numeric', month: 'long', day: 'numeric' })
  return {
    monthDayTime: (d) => safeFormat(monthDayTime, d, tag, 'monthDayTime'),
    monthDay: (d) => safeFormat(monthDay, d, tag, 'monthDay'),
    fullDate: (d) => safeFormat(fullDate, d, tag, 'fullDate'),
    calendarDate: (d) => safeFormat(calendarDate, d, tag, 'calendarDate'),
  }
}

/**
 * 月・日と時刻を**日本時間で**書く（通知の本文の発生時刻。時間帯の印「JST」は辞書の文が添える）。
 * 渡すのはその瞬間そのもの（`Date.parse` した値）。端末の時刻として組み直さないので、端末の時間帯の夏時間に左右されない
 * （2026-11-12 ユーザー選択「日本時間＋JST を添える (Recommended)」）
 */
export function intlJstMonthDayTime(tag: string): (d: Date) => string {
  const fmt = new Intl.DateTimeFormat(tag, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Tokyo' })
  return (d) => safeFormat(fmt, d, tag, 'jstMonthDayTime')
}

/** 記録を出した書式（言語と書式の組）。一覧の行ごと・描き直しごとに同じ記録を積まないよう、組ごとに 1 回だけ出す */
const warned = new Set<string>()

/**
 * 読めない日時（`Invalid Date`）は `format` が例外を投げ、描いている画面ごと落ちる。記録を残して「—」を返す
 * （日本語の書式は投げずに「NaN月」と出るので、日本語以外だけが落ちる形を作らない）。
 * 元の文字列は上流の読み取り（`utils/formatters.ts` の `readDateTime`）が記録するので、ここでは言語と書式だけを残す
 */
function safeFormat(fmt: Intl.DateTimeFormat, d: Date, tag: string, kind: string): string {
  if (Number.isNaN(d.getTime())) {
    const key = `${tag}:${kind}`
    if (!warned.has(key)) {
      warned.add(key)
      log.warn(`[i18n] 読めない日時を書式に渡された（${key}）`)
    }
    return '—'
  }
  return fmt.format(d)
}
