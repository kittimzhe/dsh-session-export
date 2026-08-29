import { randomBytes } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Write a file atomically: write to a sibling temp file, then rename over the
 * destination. Readers never observe a partial transcript.
 */
export async function atomicWriteFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, path)
}

/** Binary variant of {@link atomicWriteFile} for ZIP payloads. */
export async function atomicWriteBytes(path: string, data: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`
  await writeFile(tmp, data)
  await rename(tmp, path)
}
