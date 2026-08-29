/**
 * Minimal single-file ZIP writer (DEFLATE method 8, no external dependency).
 *
 * Emits one local-file header per entry plus the central directory and EOCD
 * record — no data descriptors, no extra fields. Entries are compressed with
 * raw DEFLATE (`node:zlib.deflateRawSync`, which is exactly the ZIP method 8
 * stream) and CRC32-checked with `node:zlib.crc32`, both present in the
 * supported Node range. `unzip` and standard extractors accept the output.
 *
 * @module dsh-session-export/util/zip
 */
import { crc32, deflateRawSync } from 'node:zlib'

export interface ZipEntry {
  readonly name: string
  readonly data: Uint8Array
}

const LFH_SIG = 0x04034b50
const CD_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50

/** MS-DOS packed time/date used by the ZIP headers. */
function dosDateTime(epochMs: number): { time: number; date: number } {
  const d = new Date(epochMs)
  // top 5 bits hours, next 6 minutes, low 5 seconds/2
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)
  // top 7 bits years since 1980, next 4 month, low 5 day
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time, date }
}

/** Build one DEFLATE-compressed ZIP archive over the given entries. */
export function buildZip(entries: readonly ZipEntry[], nowMs: number = Date.now()): Uint8Array {
  const { time, date } = dosDateTime(nowMs)
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const raw = Buffer.from(entry.data)
    const deflated = deflateRawSync(raw)
    const checksum = crc32(raw) >>> 0

    const lfh = Buffer.alloc(30)
    lfh.writeUInt32LE(LFH_SIG, 0)
    lfh.writeUInt16LE(20, 4) // version needed (2.0)
    lfh.writeUInt16LE(0, 6) // general-purpose flags
    lfh.writeUInt16LE(8, 8) // compression method: deflate
    lfh.writeUInt16LE(time, 10)
    lfh.writeUInt16LE(date, 12)
    lfh.writeUInt32LE(checksum, 14)
    lfh.writeUInt32LE(deflated.length, 18)
    lfh.writeUInt32LE(raw.length, 22)
    lfh.writeUInt16LE(name.length, 26)
    lfh.writeUInt16LE(0, 28) // extra length
    locals.push(lfh, name, deflated)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(CD_SIG, 0)
    cd.writeUInt16LE(20, 4) // version made by
    cd.writeUInt16LE(20, 6) // version needed
    cd.writeUInt16LE(0, 8) // flags
    cd.writeUInt16LE(8, 10) // method: deflate
    cd.writeUInt16LE(time, 12)
    cd.writeUInt16LE(date, 14)
    cd.writeUInt32LE(checksum, 16)
    cd.writeUInt32LE(deflated.length, 20)
    cd.writeUInt32LE(raw.length, 24)
    cd.writeUInt16LE(name.length, 28)
    cd.writeUInt16LE(0, 30) // extra length
    cd.writeUInt16LE(0, 32) // comment length
    cd.writeUInt16LE(0, 34) // disk number
    cd.writeUInt16LE(0, 36) // internal attributes
    cd.writeUInt32LE(0, 38) // external attributes
    cd.writeUInt32LE(offset, 42) // local header offset
    centrals.push(cd, name)

    offset += lfh.length + name.length + deflated.length
  }

  const cdSize = centrals.reduce((sum, part) => sum + part.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(0, 4) // number of this disk
  eocd.writeUInt16LE(0, 6) // disk with central directory
  eocd.writeUInt16LE(entries.length, 8) // entries on this disk
  eocd.writeUInt16LE(entries.length, 10) // total entries
  eocd.writeUInt32LE(cdSize, 12)
  eocd.writeUInt32LE(offset, 16) // central directory offset
  eocd.writeUInt16LE(0, 20) // comment length

  return Buffer.concat([...locals, ...centrals, eocd])
}