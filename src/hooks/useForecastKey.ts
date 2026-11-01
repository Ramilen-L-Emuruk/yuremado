import type { ArrivalTokenStatus } from '../utils/arrivalToken'
import { verifyForecastKey } from '../utils/forecastKey'
import { useSignedKeyCheck } from './useArrivalToken'

/**
 * 予報キーの検証結果。設定の窓の状態と、中継へキーを送るかの判断に使う（→ `utils/forecastKey.ts`）。
 * 失効時刻での張り直しなどの振る舞いは到達予想キーと同じ（→ `hooks/useArrivalToken.ts`）。
 */
export function useForecastKeyCheck(key: string | null | undefined): ArrivalTokenStatus {
  return useSignedKeyCheck(key, verifyForecastKey, '[forecast]')
}
