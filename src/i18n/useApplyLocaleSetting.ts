import { useEffect, useState } from 'react'
import { useSetLocale } from './I18nProvider'
import { deviceLanguageTags, resolveLocale, type LocaleSetting } from './messages'

/**
 * 設定の言語を配り役へ渡す。`auto`（端末に合わせる）のときは、端末の言語が変わったら（`languagechange`）追う。
 *
 * 起動の最初の画面の言語は `main.tsx` が同じ決め方（`resolveLocale`）で先に決めて辞書を読んでおくので、
 * ここが最初に渡す言語はふつう同じで、何も起きない。
 */
export function useApplyLocaleSetting(setting: LocaleSetting): void {
  const setLocale = useSetLocale()
  const [tags, setTags] = useState(deviceLanguageTags)
  useEffect(() => {
    // 中身が同じなら入れ替えない（ブラウザは呼ぶたびに新しい配列を返すことがあり、そのまま入れると App 全体を描き直す）
    const onChange = () => {
      const next = deviceLanguageTags()
      setTags((prev) => (prev.join(',') === next.join(',') ? prev : next))
    }
    window.addEventListener('languagechange', onChange)
    return () => window.removeEventListener('languagechange', onChange)
  }, [])
  useEffect(() => {
    setLocale(resolveLocale(setting, tags))
  }, [setting, tags, setLocale])
}
