/** One CSV record and the 1-based physical line it starts on. */
export interface CsvRecord {
  fields: string[]
  line: number
}

/**
 * Parse RFC 4180 CSV text into records. Strips a UTF-8 BOM; accepts CRLF or LF; drops blank
 * lines; a quoted field may span lines, so each record keeps the physical line it starts on.
 */
export function parseCsvRecords(text: string): CsvRecord[] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const records: CsvRecord[] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let line = 1
  let start = 1
  let i = 0
  const endRow = () => {
    row.push(field)
    field = ''
    if (row.length > 1 || row[0] !== '') records.push({ fields: row, line: start })
    row = []
  }
  while (i < src.length) {
    const ch = src[i]!
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue }
        quoted = false
      } else {
        if (ch === '\n') line++
        field += ch
      }
      i++
      continue
    }
    if (ch === '"' && field === '') quoted = true
    else if (ch === ',') { row.push(field); field = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      endRow()
      line++
      start = line
    } else field += ch
    i++
  }
  if (field !== '' || row.length > 0) endRow()
  return records
}

/** {@link parseCsvRecords} without line numbers. */
export function parseCsv(text: string): string[][] {
  return parseCsvRecords(text).map(r => r.fields)
}
