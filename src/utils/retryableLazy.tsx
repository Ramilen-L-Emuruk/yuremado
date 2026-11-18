import { lazy, type ComponentProps, type ComponentType, type LazyExoticComponent, type ReactElement } from 'react'

/** `retryableLazy` が返す部品。`reset` で次に置いたときに読み込みからやり直させる */
export interface RetryableLazyComponent<P> {
  (props: P): ReactElement
  reset: () => void
}

/**
 * 読み込みに失敗しても、境界が受け止めた後に置き直せば読み込みからやり直す `React.lazy`。
 *
 * **素の `lazy` は失敗した読み込みを覚え続ける。** 一度の回線断・配信直後の古いページが無いチャンクを
 * 求めた、で失敗すると、包んでいる `ErrorBoundary` の［再表示］を押しても同じ失敗を投げ直すだけで、
 * ページを読み直すまで二度と出ない。
 *
 * **作り直すのは、包む境界が例外を受け止めた後（`ErrorBoundary` の `onCatch` に `reset` を渡す）。**
 * 読み込みの失敗の時点で作り直すと、React が例外を確かめに描き直したときに新しい `lazy` が
 * また読みに行って保留になり、境界まで例外が届かないまま読み込みを繰り返す（実際に踏んだ）
 */
// 型の制約（`ComponentType<any>`）は `React.lazy` 自身のものに合わせる
export function retryableLazy<T extends ComponentType<any>>(
  load: () => Promise<{ default: T }>,
): RetryableLazyComponent<ComponentProps<T>> {
  const make = (): LazyExoticComponent<T> => lazy(load)
  let current = make()
  const RetryableLazy = (props: ComponentProps<T>): ReactElement => {
    const Current = current as unknown as ComponentType<ComponentProps<T>>
    return <Current {...props} />
  }
  RetryableLazy.reset = (): void => {
    current = make()
  }
  return RetryableLazy
}
