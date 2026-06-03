#!/usr/bin/env node
import { createReadStream, createWriteStream } from 'node:fs'
import { readdir, stat, rename, unlink } from 'node:fs/promises'
import { join, extname, dirname, basename } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createBrotliCompress, createGzip, constants } from 'node:zlib'

const DIST = new URL('../dist/', import.meta.url).pathname
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

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.isFile()) yield full
  }
}

async function compressTo(src, dest, makeStream) {
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

async function main() {
  let rawTotal = 0
  let brTotal = 0
  let gzTotal = 0
  let count = 0

  for await (const file of walk(DIST)) {
    const ext = extname(file).toLowerCase()
    if (ext === '.br' || ext === '.gz') continue
    if (!COMPRESSIBLE.has(ext)) continue
    const { size } = await stat(file)
    if (size < MIN_SIZE) continue

    const brSize = await compressTo(file, `${file}.br`, brotli)
    const gzSize = await compressTo(file, `${file}.gz`, gzip)

    rawTotal += size
    brTotal += brSize
    gzTotal += gzSize
    count++
  }

  const kb = (n) => `${(n / 1024).toFixed(1)}KB`
  console.log(
    `[compress-dist] ${count} files: raw ${kb(rawTotal)} → brotli ${kb(brTotal)} / gzip ${kb(gzTotal)}`,
  )
}

main().catch((err) => {
  console.error('[compress-dist] failed:', err)
  process.exit(1)
})
