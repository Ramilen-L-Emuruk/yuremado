// K-NET/KiK-netのZIP（NIEDからダウンロードした生データ）に含まれるNS/EW/UD波形ファイルを
// すべて解析する。ネットワーク・ファイルI/Oを含まないため、Node CLI（capture-kyoshin-waveform.ts）
// とブラウザ内インポート（useKyoshinImport.ts）の両方から使う。

import { unzipSync } from 'fflate'
import { parseKnetAsciiFile, type KnetAsciiFile } from './knetAscii'

/**
 * ZIP内のNS/EW/UD波形ファイルをすべて解析する。それ以外のファイル（メタ情報等）は無視する。
 *
 * 読めたファイルにもファイル名を添えて返す。読めなかったファイルと同じ観測点のほかの成分を、
 * 名前から見つけるため（`buildEventResultFromZip`）。
 */
export function parseAllStationFiles(zip: Uint8Array): {
  files: { fileName: string; file: KnetAsciiFile }[]
  failures: { fileName: string; message: string }[]
} {
  const entries = unzipSync(zip)
  const files: { fileName: string; file: KnetAsciiFile }[] = []
  const failures: { fileName: string; message: string }[] = []
  const decoder = new TextDecoder('utf-8')
  for (const [path, data] of Object.entries(entries)) {
    const fileName = path.split('/').pop() ?? path
    if (!/\.(NS|EW|UD)[12]?$/i.test(fileName)) continue
    try {
      files.push({ fileName, file: parseKnetAsciiFile(decoder.decode(data), fileName) })
    } catch (err) {
      failures.push({ fileName, message: err instanceof Error ? err.message : String(err) })
    }
  }
  return { files, failures }
}
