import { useEffect, useState } from 'react'

/**
 * メディアクエリが今当たっているか。画面の向き・大きさが変わったら追随する。
 * `matchMedia` が無い環境（試験の環境など）では常に false。
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof matchMedia === 'function' && matchMedia(query).matches)

  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const mq = matchMedia(query)
    const onChange = () => setMatches(mq.matches)
    onChange()
    // Safari 13 以前の MediaQueryList は addEventListener を持たない（古い addListener だけ）
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    }
    mq.addListener(onChange)
    return () => mq.removeListener(onChange)
  }, [query])

  return matches
}
