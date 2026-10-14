export type Screen = 'unlock' | 'setup' | 'waiting' | 'gallery' | 'capture' | 'review' | 'settings'

export type Photo = {
  id: string
  caption: string
  createdAt: string
  url: string
  /** Small tile image URL (falls back to fallbackUrls then url on error) */
  thumbUrl?: string
  /** Ordered fallbacks tried if thumbUrl fails */
  thumbFallbacks?: string[]
  /** Storage path / blob key; used for deletes and cloud sync */
  path: string
}

export type PhotoDraft = {
  blob: Blob
  url: string
  filename: string
}

export type StorageMode = 'local' | 'supabase'
