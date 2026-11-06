/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  // dev サーバーでのみ値が入る（vite.config.ts の devApiKeyDefine が define で渡す）。
  // 本番ビルドでは渡さないので常に undefined。用途は useSettings の devApiKey。
  readonly DMDATA_API_KEY?: string
  // 同じく dev サーバーでのみ値が入る（vite.config.ts の devArrivalTokenDefine）。
  // 本番ビルドへ渡すとトークンが配信された JS に平文で載るため、そこでは常に undefined。
  // 用途は useSettings の devArrivalToken。
  readonly ARRIVAL_TOKEN?: string
  // 予報キー。到達予想トークンと同じ門で dev サーバーにだけ入る（vite.config.ts の devForecastKeyDefine）。
  // 用途は useSettings の devForecastKey。
  readonly FORECAST_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare const __APP_VERSION__: string
