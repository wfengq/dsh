/** Parse RFC 4180 CSV text into rows of fields. Strips a UTF-8 BOM; accepts CRLF or LF; drops blank lines. */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = 0
  const endRow = () => {
    row.push(field)
    field = ''
    if (row.length > 1 || row[0] !== '') rows.push(row)
    row = []
  }
  while (i < src.length) {
    const ch = src[i]!
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue }
        quoted = false
      } else field += ch
      i++
      continue
    }
    if (ch === '"' && field === '') quoted = true
    else if (ch === ',') { row.push(field); field = '' }
    else if (ch === '\r' && src[i + 1] === '\n') { endRow(); i++ }
    else if (ch === '\n' || ch === '\r') endRow()
    else field += ch
    i++
  }
  if (field !== '' || row.length > 0) endRow()
  return rows
}
