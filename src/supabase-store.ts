import type { Photo } from './types'

type RemoteRow = {
  id: string
  caption: string
  created_at: string
  storage_path: string
}

function config() {
  const url = (import.meta.env.VITE_SUPABASE_URL ?? '').replace(/\/$/, '')
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY ?? ''
  return { url, key }
}

export function supabaseConfigured(): boolean {
  const { url, key } = config()
  return Boolean(url && key)
}

function headers(extra: Record<string, string> = {}): HeadersInit {
  const { key } = config()
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    ...extra,
  }
}

function publicUrl(path: string): string {
  const { url } = config()
  return `${url}/storage/v1/object/public/class-photos/${path}`
}

function thumbPath(id: string): string {
  return `thumbs/${id}.jpg`
}

function renderUrl(path: string): string {
  const { url } = config()
  return `${url}/storage/v1/render/image/public/class-photos/${path}?width=400&quality=60`
}

function toPhoto(id: string, caption: string, createdAt: string, path: string): Photo {
  return {
    id,
    caption,
    createdAt,
    path,
    url: publicUrl(path),
    thumbUrl: publicUrl(thumbPath(id)),
    thumbFallbacks: [renderUrl(path), publicUrl(path)],
  }
}

async function resizeToJpeg(blob: Blob, maxSide: number, quality: number): Promise<Blob | null> {
  try {
    let source: CanvasImageSource
    let w: number
    let h: number
    let cleanup = () => {}
    if (typeof createImageBitmap === 'function') {
      const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' } as ImageBitmapOptions)
      source = bmp
      w = bmp.width
      h = bmp.height
      cleanup = () => bmp.close()
    } else {
      const objUrl = URL.createObjectURL(blob)
      const img = new Image()
      img.src = objUrl
      await img.decode()
      source = img
      w = img.naturalWidth
      h = img.naturalHeight
      cleanup = () => URL.revokeObjectURL(objUrl)
    }
    if (!w || !h) {
      cleanup()
      return null
    }
    const scale = Math.min(1, maxSide / Math.max(w, h))
    const cw = Math.max(1, Math.round(w * scale))
    const ch = Math.max(1, Math.round(h * scale))
    const canvas = document.createElement('canvas')
    canvas.width = cw
    canvas.height = ch
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      cleanup()
      return null
    }
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(source, 0, 0, cw, ch)
    cleanup()
    const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
    canvas.width = 0
    canvas.height = 0
    return out
  } catch {
    return null
  }
}

async function uploadObject(path: string, body: Blob, contentType: string): Promise<Response> {
  const { url } = config()
  return fetch(`${url}/storage/v1/object/class-photos/${path}`, {
    method: 'POST',
    headers: headers({ 'Content-Type': contentType, 'x-upsert': 'false', 'Cache-Control': 'max-age=31536000' }),
    body,
  })
}

export async function fetchCloudPinHash(): Promise<string | null> {
  const { url } = config()
  let res: Response
  try {
    res = await fetch(`${url}/rest/v1/wall_config?id=eq.1&select=pin_hash`, {
      headers: headers({ Accept: 'application/json' }),
    })
  } catch (err) {
    if (err instanceof TypeError) {
      throw new Error('Could not reach photo cloud. Clear Safari cache for this site or reopen the link (old app used a broken address).')
    }
    throw err
  }
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Could not load class PIN (${res.status}): ${text.slice(0, 160)}`)
  }
  const rows = (await res.json()) as { pin_hash: string }[]
  return rows[0]?.pin_hash ?? null
}

export async function saveCloudPinHash(pinHash: string): Promise<void> {
  const { url } = config()
  const res = await fetch(`${url}/rest/v1/wall_config`, {
    method: 'POST',
    headers: headers({
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    }),
    body: JSON.stringify({
      id: 1,
      pin_hash: pinHash,
      updated_at: new Date().toISOString(),
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Could not save class PIN (${res.status}): ${text.slice(0, 160)}`)
  }
}

export async function listCloudPhotos(): Promise<Photo[]> {
  const { url } = config()
  let res: Response
  try {
    res = await fetch(
      `${url}/rest/v1/photos?select=id,caption,created_at,storage_path&order=created_at.desc`,
      { headers: headers({ Accept: 'application/json' }) },
    )
  } catch (err) {
    if (err instanceof TypeError) {
      throw new Error('Could not reach photo cloud. Clear Safari cache for this site or reopen the link (old app used a broken address).')
    }
    throw err
  }
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Could not load gallery (${res.status}): ${text.slice(0, 160)}`)
  }
  const rows = (await res.json()) as RemoteRow[]
  return rows.map((r) => toPhoto(r.id, r.caption ?? '', r.created_at, r.storage_path))
}

export async function addCloudPhoto(blob: Blob, caption: string, filename: string): Promise<Photo> {
  const { url } = config()
  const id = crypto.randomUUID()
  const full = await resizeToJpeg(blob, 1600, 0.8)
  let storagePath: string
  let up: Response
  if (full && full.size < blob.size) {
    storagePath = `${id}.jpg`
    up = await uploadObject(storagePath, full, 'image/jpeg')
  } else {
    // Decode failed (e.g. HEIC on a browser that can't read it) or resize didn't help: upload original
    const ext = filename.split('.').pop()?.toLowerCase() || (blob.type.includes('png') ? 'png' : 'jpg')
    storagePath = `${id}.${ext}`
    const contentType = blob.type || (ext === 'png' ? 'image/png' : 'image/jpeg')
    up = await uploadObject(storagePath, blob, contentType)
  }
  if (!up.ok) {
    const text = await up.text()
    throw new Error(`Upload failed (${up.status}): ${text.slice(0, 160)}`)
  }
  const thumb = await resizeToJpeg(full ?? blob, 400, 0.7)
  if (thumb) {
    try {
      await uploadObject(thumbPath(id), thumb, 'image/jpeg')
    } catch {
      /* thumb is best-effort; gallery falls back */
    }
  }

  const createdAt = new Date().toISOString()
  const ins = await fetch(`${url}/rest/v1/photos`, {
    method: 'POST',
    headers: headers({
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    }),
    body: JSON.stringify({
      id,
      caption,
      storage_path: storagePath,
      created_at: createdAt,
    }),
  })
  if (!ins.ok) {
    const text = await ins.text()
    throw new Error(`Saved file but not metadata (${ins.status}): ${text.slice(0, 160)}`)
  }

  return toPhoto(id, caption, createdAt, storagePath)
}

export async function deleteCloudPhoto(id: string, path: string): Promise<void> {
  const { url } = config()
  await fetch(`${url}/storage/v1/object/class-photos`, {
    method: 'DELETE',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ prefixes: [path, thumbPath(id)] }),
  })
  const del = await fetch(`${url}/rest/v1/photos?id=eq.${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: headers({ Prefer: 'return=minimal' }),
  })
  if (!del.ok) {
    const text = await del.text()
    throw new Error(`Delete failed (${del.status}): ${text.slice(0, 160)}`)
  }
}
