// K-NET/KiK-netのZIP（NIEDからダウンロードした生データ）に含まれるNS/EW/UD波形ファイルを
// すべて解析する。ネットワーク・ファイルI/Oを含まないため、Node CLI（capture-kyoshin-waveform.ts）
// とブラウザ内インポート（useKyoshinImport.ts）の両方から使う。

import { unzipSync } from 'fflate'
import { parseKnetAsciiFile, type KnetAsciiFile } from './knetAscii'
import { errorDetailOf, type ErrorText } from '../keyedError'

/** 読めなかったファイル。`message` は日本語の文、`detail` は画面で言語の辞書から組み直すための鍵と引数（無ければ `message`） */
export interface StationFileFailure {
  fileName: string
  message: string
  detail: ErrorText | string
}

/**
 * ZIP内のNS/EW/UD波形ファイルをすべて解析する。それ以外のファイル（メタ情報等）は無視する。
 *
 * 読めたファイルにもファイル名を添えて返す。読めなかったファイルと同じ観測点のほかの成分を、
 * 名前から見つけるため（`buildEventResultFromZip`）。
 */
export function parseAllStationFiles(zip: Uint8Array): {
  files: { fileName: string; file: KnetAsciiFile }[]
  failures: StationFileFailure[]
} {
  const entries = unzipSync(zip)
  const files: { fileName: string; file: KnetAsciiFile }[] = []
  const failures: StationFileFailure[] = []
  const decoder = new TextDecoder('utf-8')
  for (const [path, data] of Object.entries(entries)) {
    const fileName = path.split('/').pop() ?? path
    if (!/\.(NS|EW|UD)[12]?$/i.test(fileName)) continue
    try {
      files.push({ fileName, file: parseKnetAsciiFile(decoder.decode(data), fileName) })
    } catch (err) {
      failures.push({ fileName, message: err instanceof Error ? err.message : String(err), detail: errorDetailOf(err) })
    }
  }
  return { files, failures }
}
