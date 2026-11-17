/**
 * 設定の窓「解析テスト」が流した地震に添える解析の答え（中継に問い合わせない）。
 *
 * テストボタンの地震は EventID を押した時刻へ書き換えて流すので、中継はその地震を確かめられない（404）。
 * 代わりに中継が返した実物の答え（能登・2026-11-17 取得の `services/relayAnalysis.noto-refined.fixture.json`）を、その EventID に結び付けてここへ置き、
 * `hooks/useQuakeAnalysis.ts` が中継へ問い合わせる前に引く。**端末の控えには書かない**（本物の答えと混ざらないように）。
 *
 * リセット（リプレイの開始・停止）で消す（`useEarthquakes.ts` のテストの待ちを落とす所と同じ）。
 */

const answers = new Map<string, unknown>()

/** その地震（EventID）にテストの答えを結び付ける */
export function setTestAnalysis(eventId: string, raw: unknown): void {
  answers.set(eventId, raw)
}

/** テストの答え。結び付けていなければ undefined */
export function testAnalysisFor(eventId: string): unknown {
  return answers.get(eventId)
}

/** テストの答えをすべて消す（リセット） */
export function clearTestAnalyses(): void {
  answers.clear()
}

/**
 * キューへ積む中身（読み取った電文。押した時刻へ寄せた後）から EventID（14 桁）を集める。
 * **XML からは読まない** —— テストの台本は読み取った後で EventID を押した時刻へ書き換える（`instantiateScenario`）ので、
 * XML に残るのは元の電文の EventID で、カードの地震と合わない
 */
export function payloadEventIds(payload: unknown): string[] {
  return [...new Set([...JSON.stringify(payload ?? null).matchAll(/"eventId":"(\d{14})"/g)].map(m => m[1]))]
}
