import { API_FETCH_TIMEOUT_MS, fetchWithTimeout } from '../utils/fetchWithTimeout'
import { log } from '../utils/logger'
import { parseReleaseNotes, type ReleaseNoteEntry } from '../utils/releaseNotes'

/**
 * 配信されている変更内容（`release-notes.json`）を取る。取れなければ投げる（窓が「読み込めませんでした」を出す）。
 *
 * **配信されているものを毎回取る。** 待っている新しい版の内容は、古い版のページから読む必要があるので、
 * アプリへは同梱しない。`json` は事前キャッシュに載らず（`vite.config.ts` の拡張子の一覧）、HTTP の控えも
 * `no-store` で避ける —— 古い内容を見せないため。
 */
export async function fetchReleaseNotes(signal: AbortSignal | null): Promise<ReleaseNoteEntry[]> {
  return fetchWithTimeout(
    `${import.meta.env.BASE_URL}release-notes.json`,
    { timeoutMs: API_FETCH_TIMEOUT_MS, signal, init: { cache: 'no-store' } },
    async (res) => {
      if (!res.ok) throw new Error(`変更内容を取れなかった（HTTP ${res.status}）`)
      const { entries, dropped, ignoredTranslations } = parseReleaseNotes(await res.json())
      if (dropped > 0) log.warn(`[更新] 変更内容のうち ${dropped} 版を読めなかった（形が違う）`)
      // 後の版で足した言語の訳もここに数える（その言語の画面は日本語の文で出る）
      if (ignoredTranslations > 0) log.warn(`[更新] 変更内容の訳のうち ${ignoredTranslations} 件を読まずに捨てた（知らない言語か形が違う）`)
      return entries
    },
  )
}
