// Backfill thumbs/<id>.jpg (400px, q70) for existing photos. Never deletes originals.
// Usage: node scripts/backfill-thumbs.mjs   (reads .env; needs `npm i --no-save sharp`)
import { readFileSync } from 'node:fs'
import sharp from 'sharp'

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
)
const URL_ = 'https://kfptchtfvapkoeizewlu.supabase.co'
const KEY = env.VITE_SUPABASE_ANON_KEY
const h = { apikey: KEY, Authorization: `Bearer ${KEY}` }
const pub = (p) => `${URL_}/storage/v1/object/public/class-photos/${p}`

const rows = await (await fetch(`${URL_}/rest/v1/photos?select=id,storage_path`, { headers: h })).json()
let made = 0, skipped = 0, failed = 0
for (const r of rows) {
  const tp = `thumbs/${r.id}.jpg`
  if ((await fetch(pub(tp), { method: 'HEAD' })).ok) { skipped++; continue }
  try {
    const orig = Buffer.from(await (await fetch(pub(r.storage_path))).arrayBuffer())
    const thumb = await sharp(orig).rotate().resize(400, 400, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 70, mozjpeg: true }).toBuffer()
    const up = await fetch(`${URL_}/storage/v1/object/class-photos/${tp}`, {
      method: 'POST', headers: { ...h, 'Content-Type': 'image/jpeg', 'x-upsert': 'false', 'Cache-Control': 'max-age=31536000' }, body: thumb,
    })
    if (!up.ok) throw new Error(`${up.status} ${await up.text()}`)
    made++
    console.log(`ok ${r.id} ${orig.length} -> ${thumb.length}`)
  } catch (e) { failed++; console.error(`fail ${r.id}: ${e.message}`) }
}
console.log({ total: rows.length, made, skipped, failed })
