import { createReadStream, createWriteStream } from 'node:fs'
import { readdir, stat, rename, unlink } from 'node:fs/promises'
import { join, extname, dirname, basename } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createBrotliCompress, createGzip, constants } from 'node:zlib'
import type { Transform } from 'node:stream'

const MIN_SIZE = 1024
const COMPRESSIBLE = new Set([
  '.js', '.mjs', '.css', '.html', '.svg', '.json', '.webmanifest', '.txt', '.map',
])

const brotli = () =>
  createBrotliCompress({
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
    },
  })

const gzip = () => createGzip({ level: constants.Z_BEST_COMPRESSION })

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.isFile()) yield full
  }
}

async function compressTo(src: string, dest: string, makeStream: () => Transform) {
  const tmp = join(dirname(dest), `.${basename(dest)}.${process.pid}.tmp`)
  try {
    await pipeline(createReadStream(src), makeStream(), createWriteStream(tmp))
    await rename(tmp, dest)
  } catch (err) {
    await unlink(tmp).catch(() => {})
    throw err
  }
  const { size } = await stat(dest)
  return size
}

/** Writes `.br`/`.gz` siblings next to every compressible file under `dist`.
 *  The directory is a parameter because the build has three of them: the
 *  packaged UI, e2e's `dist-e2e`, and whatever `--outDir` a caller passes. */
export async function compressDist(dist: string) {
  let rawTotal = 0
  let brTotal = 0
  let gzTotal = 0
  let count = 0
  let failed = 0

  for await (const file of walk(dist)) {
    const ext = extname(file).toLowerCase()
    if (ext === '.br' || ext === '.gz') continue
    if (!COMPRESSIBLE.has(ext)) continue
    const { size } = await stat(file)
    if (size < MIN_SIZE) continue

    try {
      const brSize = await compressTo(file, `${file}.br`, brotli)
      const gzSize = await compressTo(file, `${file}.gz`, gzip)
      rawTotal += size
      brTotal += brSize
      gzTotal += gzSize
      count++
    } catch (err) {
      failed++
      console.warn(`[compress-dist] WARN ${file}: ${err instanceof Error ? err.message : String(err)}`)
      // Sweep any orphan temp files this PID left in the source's directory.
      const dir = dirname(file)
      const base = basename(file)
      const prefix = `.${base}.${process.pid}.`
      try {
        for (const entry of await readdir(dir)) {
          if (entry.startsWith(prefix) && entry.endsWith('.tmp')) {
            await unlink(join(dir, entry)).catch(() => {})
          }
        }
      } catch {
        // Directory listing failed — nothing we can clean up here.
      }
    }
  }

  const kb = (n: number) => `${(n / 1024).toFixed(1)}KB`
  console.log(
    `[compress-dist] ${count} files: raw ${kb(rawTotal)} → brotli ${kb(brTotal)} / gzip ${kb(gzTotal)} (failed: ${failed})`,
  )
}
