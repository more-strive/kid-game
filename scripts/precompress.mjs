#!/usr/bin/env node
/**
 * 构建产物预压缩（gzip）。
 *
 * 为什么需要：nginx 的 `gzip on` 是每个请求现算，14MB 的 wasm 每次都要压一遍，
 * 白白吃 CPU。这里提前压好 `.gz`，配合 nginx 的 `gzip_static on` 直接读文件，
 * 首字节更快、CPU 省下来。
 *
 * 只压文本类资源；`.task` 这类本身就是 zip 的二进制跳过（压了反而更大）。
 * 压缩后体积收益 < 5% 的文件不生成 .gz，避免无谓的文件数膨胀。
 *
 * 用法：node scripts/precompress.mjs [distDir]
 */
import { readdir, readFile, writeFile, stat } from 'node:fs/promises'
import { join, extname, relative } from 'node:path'
import { gzipSync } from 'node:zlib'

const DIST = process.argv[2] || 'dist'
const EXTS = new Set(['.html', '.js', '.mjs', '.css', '.svg', '.json', '.ico', '.txt', '.wasm'])
const MIN_BYTES = 1024
const MIN_GAIN = 0.95 // 压完至少小 5% 才落盘

async function walk(dir, out = []) {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) await walk(p, out)
    else if (!e.name.endsWith('.gz')) out.push(p)
  }
  return out
}

const files = await walk(DIST)
let written = 0
let savedBytes = 0

for (const file of files) {
  if (!EXTS.has(extname(file))) continue
  const info = await stat(file)
  if (info.size < MIN_BYTES) continue

  const buf = await readFile(file)
  const gz = gzipSync(buf, { level: 9 })
  if (gz.length > buf.length * MIN_GAIN) continue

  await writeFile(`${file}.gz`, gz)
  written++
  savedBytes += buf.length - gz.length
  console.log(
    `  ${relative(DIST, file).padEnd(52)} ${(buf.length / 1024).toFixed(0).padStart(6)}KB -> ${(gz.length / 1024).toFixed(0).padStart(6)}KB`,
  )
}

console.log(
  `\n预压缩完成：${written} 个 .gz，传输体积减少 ${(savedBytes / 1024 / 1024).toFixed(1)}MB`,
)
