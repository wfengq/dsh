/**
 * Minimal in-memory ZIP reader for bill exports: stored and deflated entries, read through the central
 * directory. Nothing is written to disk. ZIP64, encryption and other methods are refused with a reason.
 */
import { inflateRawSync } from 'node:zlib'

export interface ZipEntry {
  name: string
  data: Buffer
}

const LOCAL = 0x04034b50
const CENTRAL = 0x02014b50
const END = 0x06054b50
/** A bill export is small; refuse anything that would inflate past this. */
const MAX_ENTRY_BYTES = 256 * 1024 * 1024

/** Whether the bytes start like a ZIP archive. */
export function isZip(buf: Uint8Array): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04
}

function findEnd(buf: Buffer): number {
  // The end record is 22 bytes plus a comment of at most 65535 bytes.
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === END) return i
  }
  return -1
}

export function readZip(input: Uint8Array): ZipEntry[] {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  const end = buf.length >= 22 ? findEnd(buf) : -1
  if (end < 0) throw new Error('不是有效的 ZIP 文件')
  const count = buf.readUInt16LE(end + 10)
  const dirOffset = buf.readUInt32LE(end + 16)
  if (count === 0xffff || dirOffset === 0xffffffff) throw new Error('不支持 ZIP64 格式的压缩包')
  const entries: ZipEntry[] = []
  let p = dirOffset
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL) throw new Error('ZIP 目录已损坏')
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const compressed = buf.readUInt32LE(p + 20)
    const size = buf.readUInt32LE(p + 24)
    const nameLength = buf.readUInt16LE(p + 28)
    const extraLength = buf.readUInt16LE(p + 30)
    const commentLength = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLength).toString(flags & 0x0800 ? 'utf8' : 'latin1')
    p += 46 + nameLength + extraLength + commentLength
    if (name.endsWith('/')) continue
    if (flags & 0x1) throw new Error(`ZIP 中的文件已加密：${name}`)
    if (size > MAX_ENTRY_BYTES) throw new Error(`ZIP 中的文件过大：${name}`)
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL) throw new Error(`ZIP 中的文件已损坏：${name}`)
    const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28)
    const body = buf.subarray(start, start + compressed)
    if (body.length !== compressed) throw new Error(`ZIP 中的文件不完整：${name}`)
    let data: Buffer
    if (method === 0) data = Buffer.from(body)
    else if (method === 8) {
      try {
        data = inflateRawSync(body, { maxOutputLength: MAX_ENTRY_BYTES })
      } catch {
        throw new Error(`ZIP 中的文件无法解压：${name}`)
      }
    } else throw new Error(`不支持的压缩方式（${method}）：${name}`)
    if (data.length !== size) throw new Error(`ZIP 中的文件长度不符：${name}`)
    entries.push({ name, data })
  }
  return entries
}
