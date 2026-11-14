/**
 * 幅の決まった欄に短い語（英語の「5+」「Max」「Cl. 1」など）を出し、正式な呼び名を読み上げとマウスを乗せたときに渡す。
 * 読み上げソフトには全文を渡す（2026-11-14 ユーザー選択「5+ 5- 6+ 6- (Recommended)」の説明「吹き出しと読み上げソフトには
 * 今の全文（5 Upper など）を渡す」）。`title` だけでは読み上げに確実には乗らないので、見える短い語は読み上げから隠し、
 * 全文を画面に出ない形で添える。短い語と全文が同じ言語（日本語など）は、1 つだけ出す。
 */
export function ShortLabel({ short, full }: { short: string; full: string }) {
  if (short === full) return <>{short}</>
  return (
    <>
      <span aria-hidden="true" title={full}>{short}</span>
      <span className="sr-only">{full}</span>
    </>
  )
}
