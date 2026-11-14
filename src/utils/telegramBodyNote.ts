// 電文ログの行で、本文の代わりに置く要約（二進電文＝推計震度分布図の BUFR）。
//
// **行には鍵と値（`TelegramLogEntry.bodyNote`）を持たせ、描くときに辞書で文にする**（言語を変えても行を組み直さずに済む）。
// 行の `rawBody` には同じ要約の日本語の文も入れておく —— ダウンロードの JSON と、この欄を持たない古い行
// （そのときの文がそのまま入っている）を、今までどおり読めるようにするため。
import type { Messages } from '../i18n/messages'
import { ja } from '../i18n/messages/ja'
import type { TelegramBodyNote } from '../types/earthquake'

export type { TelegramBodyNote }

/** 要約の文（画面は言語の辞書、`rawBody` に入れる文は日本語の辞書を渡す） */
export function telegramBodyNoteText(note: TelegramBodyNote, w: Pick<Messages['telegramLog'], 'bodyNote'>): string {
  const t = w.bodyNote
  switch (note.kind) {
    case 'bufr': return t.bufr(note.bytes)
    case 'bufrFragment': return t.bufrFragment(note.bytes)
    case 'bufrFragmentWaiting': return t.bufrFragmentWaiting(note.bytes)
    case 'bufrKind': return t.bufrKind(note.bytes, note.telegramKind)
    case 'bufrCells': return t.bufrCells(note.bytes, note.cells)
    case 'bufrFragmentSkipped': return t.bufrFragmentSkipped
    case 'bufrFile': return t.bufrFile(note.file)
  }
}

/** 行に入れる 2 つの欄（日本語の要約の文と、鍵と値）。行を組む所はこれを広げて入れる */
export function bodyNoteFields(note: TelegramBodyNote): { rawBody: string; bodyNote: TelegramBodyNote } {
  return { rawBody: telegramBodyNoteText(note, ja.telegramLog), bodyNote: note }
}
