import './style.css'
import { registerSW } from 'virtual:pwa-register'
import type { Photo, PhotoDraft, Screen } from './types'
import { isUnlocked, lockSession, resolvePinPresence, setPin, verifyPin } from './pin'
import { getStorageMode, listPhotos, removePhoto, uploadPhoto } from './storage'

registerSW({ immediate: true })

function detectViewOnly(): boolean {
  const params = new URLSearchParams(location.search)
  const view = (params.get('view') || '').toLowerCase()
  const mode = (params.get('mode') || '').toLowerCase()
  return view === '1' || view === 'true' || view === 'parent' || mode === 'view'
}

function galleryBaseUrl(): string {
  const base = import.meta.env.BASE_URL || '/'
  return `${location.origin}${base}`
}

function parentViewUrl(): string {
  const base = galleryBaseUrl()
  return base.includes('?') ? `${base}&view=1` : `${base}?view=1`
}

type State = {
  screen: Screen
  photos: Photo[]
  drafts: PhotoDraft[]
  caption: string
  pinInput: string
  pinConfirm: string
  toast: string
  busy: boolean
  error: string
  lightbox: Photo | null
  loadingGallery: boolean
  booting: boolean
  viewOnly: boolean
  selectMode: boolean
  selectedIds: Set<string>
}

const state: State = {
  screen: 'unlock',
  photos: [],
  drafts: [],
  caption: '',
  pinInput: '',
  pinConfirm: '',
  toast: '',
  busy: false,
  error: '',
  lightbox: null,
  loadingGallery: false,
  booting: true,
  viewOnly: detectViewOnly(),
  selectMode: false,
  selectedIds: new Set(),
}

function toast(msg: string): void {
  state.toast = msg
  render()
  window.setTimeout(() => {
    if (state.toast === msg) {
      state.toast = ''
      render()
    }
  }, 2600)
}

function discardDrafts(): void {
  for (const d of state.drafts) {
    URL.revokeObjectURL(d.url)
  }
  state.drafts = []
  state.caption = ''
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function formatWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

async function refreshGallery(): Promise<void> {
  state.loadingGallery = true
  state.error = ''
  render()
  try {
    // Revoke prior local blob URLs
    for (const p of state.photos) {
      if (p.url.startsWith('blob:')) URL.revokeObjectURL(p.url)
    }
    state.photos = await listPhotos()
  } catch (err) {
    state.error = err instanceof Error ? err.message : 'Could not load photos'
  } finally {
    state.loadingGallery = false
    render()
  }
}

function go(screen: Screen): void {
  if (state.viewOnly && (screen === 'capture' || screen === 'review' || screen === 'setup')) {
    screen = 'gallery'
  }
  if (screen !== 'gallery' && state.selectMode) exitSelectMode()
  state.screen = screen
  state.error = ''
  render()
  if (screen === 'gallery') void refreshGallery()
}

function onPhotoFiles(files: FileList | File[]): void {
  if (state.viewOnly) return
  const list = [...files].filter((f) => f.type.startsWith('image/') || !f.type)
  if (list.length === 0) return
  discardDrafts()
  const now = Date.now()
  state.drafts = list.map((file, i) => ({
    blob: file,
    url: URL.createObjectURL(file),
    filename: file.name || `photo-${now}-${i + 1}.jpg`,
  }))
  state.caption = ''
  state.screen = 'review'
  state.error = ''
  render()
}

async function doUpload(skipCaption = false): Promise<void> {
  if (state.viewOnly || state.drafts.length === 0 || state.busy) return
  state.busy = true
  state.error = ''
  render()
  const caption = skipCaption ? '' : state.caption.trim()
  const total = state.drafts.length
  let uploaded = 0
  try {
    while (state.drafts.length > 0) {
      const draft = state.drafts[0]
      await uploadPhoto(draft.blob, caption, draft.filename)
      URL.revokeObjectURL(draft.url)
      state.drafts = state.drafts.slice(1)
      uploaded += 1
      render()
    }
    state.caption = ''
    toast(uploaded === 1 ? 'Photo added to the wall' : `${uploaded} photos added`)
    go('gallery')
  } catch (err) {
    state.error =
      err instanceof Error
        ? uploaded > 0
          ? `${uploaded} of ${total} uploaded, then failed: ${err.message}`
          : err.message
        : 'Upload failed'
    state.busy = false
    render()
    return
  }
  state.busy = false
}

async function doDelete(photo: Photo): Promise<void> {
  if (state.viewOnly || state.busy) return
  if (!window.confirm('Remove this photo from the class wall?')) return
  state.busy = true
  state.error = ''
  render()
  try {
    await removePhoto(photo)
    if (photo.url.startsWith('blob:')) URL.revokeObjectURL(photo.url)
    state.photos = state.photos.filter((p) => p.id !== photo.id)
    if (state.lightbox?.id === photo.id) state.lightbox = null
    toast('Photo removed')
  } catch (err) {
    state.error = err instanceof Error ? err.message : 'Delete failed'
  } finally {
    state.busy = false
    render()
  }
}


function exitSelectMode(): void {
  state.selectMode = false
  state.selectedIds = new Set()
}

function toggleSelectMode(): void {
  if (state.viewOnly) return
  if (state.selectMode) {
    exitSelectMode()
  } else {
    state.selectMode = true
    state.selectedIds = new Set()
    state.lightbox = null
  }
  state.error = ''
  render()
}

function togglePhotoSelection(id: string): void {
  if (!state.selectMode || state.viewOnly) return
  const next = new Set(state.selectedIds)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  state.selectedIds = next
  render()
}

async function doDeleteSelected(): Promise<void> {
  if (state.viewOnly || state.busy || !state.selectMode) return
  const ids = [...state.selectedIds]
  if (ids.length === 0) return
  const n = ids.length
  if (!window.confirm(`Remove ${n} photo${n === 1 ? '' : 's'} from the class wall?`)) return
  state.busy = true
  state.error = ''
  render()
  let removed = 0
  try {
    for (const id of ids) {
      const photo = state.photos.find((p) => p.id === id)
      if (!photo) {
        state.selectedIds.delete(id)
        continue
      }
      await removePhoto(photo)
      if (photo.url.startsWith('blob:')) URL.revokeObjectURL(photo.url)
      state.photos = state.photos.filter((p) => p.id !== photo.id)
      state.selectedIds.delete(id)
      if (state.lightbox?.id === photo.id) state.lightbox = null
      removed += 1
    }
    toast(removed === 1 ? 'Photo removed' : `${removed} photos removed`)
    exitSelectMode()
  } catch (err) {
    state.error = err instanceof Error ? err.message : 'Delete failed'
    // Keep remaining selectedIds for retry
  } finally {
    state.busy = false
    render()
  }
}

function topbar(title: string, left: string, right: string): string {
  return `<header class="topbar">
    <div class="topbar-slot left">${left}</div>
    <h1>${escapeHtml(title)}</h1>
    <div class="topbar-slot right">${right}</div>
  </header>`
}

function renderUnlock(): string {
  if (state.booting) {
    return `<div class="screen gate">
    ${topbar('Class Photo Wall', '', '')}
    <div class="body gate-body">
      <div class="hero-card">
        <p class="muted center">Loading…</p>
      </div>
    </div>
  </div>`
  }
  const heading = state.viewOnly ? 'Enter class PIN to view the wall' : 'Enter class PIN'
  const blurb = state.viewOnly
    ? 'View-only link — enter the class PIN your teacher shared.'
    : 'Same PIN for viewing the wall and uploading photos.'
  return `<div class="screen gate">
    ${topbar('Class Photo Wall', '', '')}
    <div class="body gate-body">
      <div class="hero-card">
        <p class="eyebrow">${state.viewOnly ? 'Parents' : 'Parents &amp; teachers'}</p>
        <h2>${heading}</h2>
        <p class="muted">${blurb}</p>
        <form id="pin-form" class="pin-form">
          <input id="pin-input" class="pin-input" type="password" inputmode="numeric" autocomplete="one-time-code" placeholder="Class PIN" maxlength="32" value="${escapeHtml(state.pinInput)}" />
          ${state.error ? `<p class="error">${escapeHtml(state.error)}</p>` : ''}
          <button class="btn primary big" type="submit" ${state.busy ? 'disabled' : ''}>Unlock</button>
        </form>
      </div>
    </div>
  </div>`
}

function renderWaiting(): string {
  return `<div class="screen gate">
    ${topbar('Class Photo Wall', '', '')}
    <div class="body gate-body">
      <div class="hero-card">
        <p class="eyebrow">View only</p>
        <h2>Photo wall isn’t ready yet</h2>
        <p class="muted">Ask your teacher for the class link PIN — wall not set up yet. Your teacher will share the PIN after they create it on the full teacher link.</p>
      </div>
    </div>
  </div>`
}

function renderSetup(): string {
  return `<div class="screen gate">
    ${topbar('Class Photo Wall', '', '')}
    <div class="body gate-body">
      <div class="hero-card">
        <p class="eyebrow">Teacher setup</p>
        <h2>Create a class PIN</h2>
        <p class="muted">This PIN is shared for the whole class link. Parents on any device enter it to open the gallery. Store it somewhere safe.</p>
        <form id="setup-form" class="pin-form">
          <input id="pin-input" class="pin-input" type="password" inputmode="numeric" autocomplete="new-password" placeholder="New PIN (4+ chars)" maxlength="32" value="${escapeHtml(state.pinInput)}" />
          <input id="pin-confirm" class="pin-input" type="password" inputmode="numeric" autocomplete="new-password" placeholder="Confirm PIN" maxlength="32" value="${escapeHtml(state.pinConfirm)}" />
          ${state.error ? `<p class="error">${escapeHtml(state.error)}</p>` : ''}
          <button class="btn primary big" type="submit" ${state.busy ? 'disabled' : ''}>Save PIN &amp; open wall</button>
        </form>
      </div>
    </div>
  </div>`
}

function renderGallery(): string {
  const mode = getStorageMode()
  const tiles = state.photos
    .map((p) => {
      const selected = state.selectMode && state.selectedIds.has(p.id)
      const selectClass = state.selectMode ? ` select-mode${selected ? ' selected' : ''}` : ''
      const check = state.selectMode
        ? `<span class="tile-check" aria-hidden="true">${selected ? '✓' : ''}</span>`
        : ''
      const aria = state.selectMode
        ? selected
          ? 'Deselect photo'
          : 'Select photo'
        : 'Open photo'
      return `<button type="button" class="tile${selectClass}" data-id="${escapeHtml(p.id)}" aria-label="${aria}" aria-pressed="${selected ? 'true' : 'false'}">
        ${check}
        <img src="${escapeHtml(p.thumbUrl ?? p.url)}" data-fallbacks="${escapeHtml((p.thumbFallbacks ?? []).join(' '))}" alt="" loading="lazy" decoding="async" />
        ${p.caption ? `<span class="tile-cap">${escapeHtml(p.caption)}</span>` : ''}
      </button>`
    })
    .join('')

  const empty = !state.loadingGallery && state.photos.length === 0
    ? state.viewOnly
      ? `<div class="empty-wall">
        <div class="empty-art" aria-hidden="true">📷</div>
        <h2>Class photo wall</h2>
        <p class="muted">No photos yet. Check back after your teacher adds snapshots.</p>
      </div>`
      : `<div class="empty-wall">
        <div class="empty-art" aria-hidden="true">📷</div>
        <h2>Your class photo wall</h2>
        <p class="muted">Tap <strong>Take photo</strong> to add the first snapshot. Parents open the parent link and enter the class PIN.</p>
      </div>`
    : ''

  const chips = state.viewOnly
    ? `<div class="chip-row">
        <div class="mode-chip view-only">View only</div>
        <div class="mode-chip ${mode}">${mode === 'supabase' ? 'Cloud gallery' : 'Demo mode (this device)'}</div>
      </div>`
    : `<div class="chip-row">
        <div class="mode-chip ${mode}">${mode === 'supabase' ? 'Cloud gallery' : 'Demo mode (this device)'}</div>
        ${
          state.photos.length > 0
            ? `<button type="button" class="icon-btn select-toggle${state.selectMode ? ' active' : ''}" id="btn-select">${state.selectMode ? 'Selecting…' : 'Select'}</button>`
            : ''
        }
      </div>`

  const settingsBtn = `<button type="button" class="icon-btn ghost" id="btn-settings">Settings</button>`

  const n = state.selectedIds.size
  const selectBar =
    !state.viewOnly && state.selectMode
      ? `<div class="select-bar" role="toolbar" aria-label="Selection">
        <span class="select-count">${n} selected</span>
        <button type="button" class="btn danger" id="btn-delete-selected" ${state.busy || n === 0 ? 'disabled' : ''}>Delete selected</button>
        <button type="button" class="btn secondary" id="btn-cancel-select" ${state.busy ? 'disabled' : ''}>Cancel</button>
      </div>`
      : ''

  const fab =
    state.viewOnly || state.selectMode
      ? ''
      : `<div class="fab-bar">
      <button type="button" class="btn primary big fab" id="btn-capture">Take photo</button>
    </div>`

  return `<div class="screen">
    ${topbar(
      'Class Photo Wall',
      settingsBtn,
      `<button type="button" class="icon-btn ghost" id="btn-lock">Lock</button>`,
    )}
    <div class="body gallery-body${state.viewOnly ? ' view-only' : ''}${state.selectMode ? ' select-mode' : ''}">
      ${chips}
      ${selectBar}
      ${state.error ? `<p class="error">${escapeHtml(state.error)}</p>` : ''}
      ${state.loadingGallery ? `<p class="muted center">Loading wall…</p>` : ''}
      ${empty}
      <div class="masonry">${tiles}</div>
    </div>
    ${fab}
    ${state.lightbox ? renderLightbox(state.lightbox) : ''}
  </div>`
}

function renderLightbox(photo: Photo): string {
  const deleteBtn = state.viewOnly
    ? ''
    : `<button type="button" class="btn danger" id="lightbox-delete" ${state.busy ? 'disabled' : ''}>Remove photo</button>`
  return `<div class="lightbox" id="lightbox" role="dialog" aria-modal="true">
    <button type="button" class="lightbox-close" id="lightbox-close" aria-label="Close">×</button>
    <img src="${escapeHtml(photo.url)}" alt="" />
    <div class="lightbox-meta">
      <p class="lightbox-cap">${photo.caption ? escapeHtml(photo.caption) : '<span class="muted">No caption</span>'}</p>
      <p class="muted">${escapeHtml(formatWhen(photo.createdAt))}</p>
      ${deleteBtn}
    </div>
  </div>`
}

function renderCapture(): string {
  if (state.viewOnly) return renderGallery()
  return `<div class="screen">
    ${topbar(
      'Add photos',
      `<button type="button" class="icon-btn ghost" id="btn-back-gallery">Back</button>`,
      '',
    )}
    <div class="body capture-body">
      <p class="lead">Snap classroom moments for the shared wall. Parents see them after you upload.</p>
      <label class="btn primary big file-btn">
        Take photo
        <input id="file-camera" type="file" accept="image/*" capture="environment" multiple hidden />
      </label>
      <label class="btn secondary big file-btn">
        Choose from Photos
        <input id="file-library" type="file" accept="image/*" multiple hidden />
      </label>
      <p class="hint">Pick several from Photos at once, or snap one with the rear camera on iPad.</p>
    </div>
  </div>`
}

function renderReview(): string {
  if (state.viewOnly || state.drafts.length === 0) {
    return state.viewOnly ? renderGallery() : renderCapture()
  }
  const multi = state.drafts.length > 1
  const preview = multi
    ? `<div class="multi-preview">
        <p class="multi-count"><strong>${state.drafts.length}</strong> photos ready</p>
        <div class="thumb-row">
          ${state.drafts
            .map(
              (d) =>
                `<div class="thumb"><img src="${escapeHtml(d.url)}" alt="" /></div>`,
            )
            .join('')}
        </div>
      </div>`
    : `<div class="preview-wrap">
        <img class="preview" src="${escapeHtml(state.drafts[0].url)}" alt="Preview" />
      </div>`

  const captionLabel = multi
    ? 'Shared caption <span class="optional">(optional — applies to all)</span>'
    : 'Caption <span class="optional">(optional)</span>'

  const uploadLabel = state.busy
    ? multi
      ? `Uploading… (${state.drafts.length} left)`
      : 'Uploading…'
    : multi
      ? `Upload all (${state.drafts.length})`
      : 'Upload'

  const fastLabel = multi ? 'Upload all without caption' : 'Upload without caption'

  return `<div class="screen">
    ${topbar(
      multi ? 'Add photos' : 'Add to wall',
      `<button type="button" class="icon-btn ghost" id="btn-retake"${state.busy ? ' disabled' : ''}>${multi ? 'Cancel' : 'Retake'}</button>`,
      '',
    )}
    <div class="body review-body">
      ${preview}
      <label class="field">
        <span>${captionLabel}</span>
        <input id="caption-input" type="text" maxlength="120" placeholder="e.g. Science fair builds" value="${escapeHtml(state.caption)}" ${state.busy ? 'disabled' : ''} />
      </label>
      ${state.error ? `<p class="error">${escapeHtml(state.error)}</p>` : ''}
      <button type="button" class="btn primary big" id="btn-upload" ${state.busy ? 'disabled' : ''}>
        ${uploadLabel}
      </button>
      <button type="button" class="btn secondary" id="btn-upload-fast" ${state.busy ? 'disabled' : ''}>
        ${fastLabel}
      </button>
    </div>
  </div>`
}

function renderSettings(): string {
  if (state.viewOnly) {
    return `<div class="screen">
    ${topbar(
      'Settings',
      `<button type="button" class="icon-btn ghost" id="btn-back-gallery">Back</button>`,
      '',
    )}
    <div class="body">
      <section class="card">
        <div class="mode-chip view-only">View only</div>
        <h2>Parent gallery</h2>
        <p class="muted">You’re on the view-only link. Photos can be added from the teacher link.</p>
        <button type="button" class="btn secondary" id="btn-lock">Lock</button>
      </section>
    </div>
  </div>`
  }

  const mode = getStorageMode()
  const teacherLink = galleryBaseUrl()
  const parentLink = parentViewUrl()
  return `<div class="screen">
    ${topbar(
      'Settings',
      `<button type="button" class="icon-btn ghost" id="btn-back-gallery">Back</button>`,
      '',
    )}
    <div class="body">
      <section class="card">
        <h2>Share with parents</h2>
        <p class="muted">Send the <strong>parent link</strong> below. They enter the class PIN to view the wall (no upload).</p>
        <p class="share-label">Parent link (view only)</p>
        <p class="share-link">${escapeHtml(parentLink)}</p>
        <button type="button" class="btn primary" id="btn-copy-parent-link">Copy parent link</button>
        <p class="share-label">Teacher link (full app)</p>
        <p class="share-link">${escapeHtml(teacherLink)}</p>
        <button type="button" class="btn secondary" id="btn-copy-link">Copy teacher link</button>
      </section>
      <section class="card">
        <h2>Class PIN</h2>
        <p class="muted">One PIN unlocks viewing and uploading for the whole class link on every device.</p>
        <form id="change-pin-form" class="pin-form">
          <input id="pin-input" class="pin-input" type="password" inputmode="numeric" autocomplete="new-password" placeholder="New PIN" maxlength="32" />
          <input id="pin-confirm" class="pin-input" type="password" inputmode="numeric" autocomplete="new-password" placeholder="Confirm new PIN" maxlength="32" />
          ${state.error ? `<p class="error">${escapeHtml(state.error)}</p>` : ''}
          <button class="btn secondary" type="submit">Update PIN</button>
        </form>
      </section>
      <section class="card">
        <h2>Storage</h2>
        <p><strong>${mode === 'supabase' ? 'Supabase cloud' : 'Local demo (IndexedDB)'}</strong></p>
        <p class="muted">${
          mode === 'supabase'
            ? 'Photos sync for parents on other devices.'
            : 'Photos stay on this iPad only. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, then rebuild, for a shared cloud gallery. See README.'
        }</p>
      </section>
      <section class="card">
        <h2>Privacy note</h2>
        <p class="muted">Classroom-trust security: the PIN is a soft gate in the app. It is not bank-grade auth. Share the link and PIN only with your class families.</p>
      </section>
    </div>
  </div>`
}

function render(): void {
  const app = document.getElementById('app')
  if (!app) return
  let html = ''
  switch (state.screen) {
    case 'unlock':
      html = renderUnlock()
      break
    case 'waiting':
      html = renderWaiting()
      break
    case 'setup':
      html = renderSetup()
      break
    case 'gallery':
      html = renderGallery()
      break
    case 'capture':
      html = renderCapture()
      break
    case 'review':
      html = renderReview()
      break
    case 'settings':
      html = renderSettings()
      break
  }
  if (state.toast) {
    html += `<div class="toast" role="status">${escapeHtml(state.toast)}</div>`
  }
  app.innerHTML = html
  bind()
}

async function copyText(text: string, okMsg: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast(okMsg)
  } catch {
    window.prompt('Copy this link:', text)
  }
}

function bind(): void {
  const pinForm = document.getElementById('pin-form') as HTMLFormElement | null
  pinForm?.addEventListener('submit', async (e) => {
    e.preventDefault()
    const input = document.getElementById('pin-input') as HTMLInputElement
    state.pinInput = input.value
    state.busy = true
    state.error = ''
    render()
    const ok = await verifyPin(state.pinInput)
    state.busy = false
    if (!ok) {
      state.error = 'Incorrect PIN'
      render()
      return
    }
    state.pinInput = ''
    go('gallery')
  })

  const setupForm = document.getElementById('setup-form') as HTMLFormElement | null
  setupForm?.addEventListener('submit', async (e) => {
    e.preventDefault()
    if (state.viewOnly) return
    const a = (document.getElementById('pin-input') as HTMLInputElement).value
    const b = (document.getElementById('pin-confirm') as HTMLInputElement).value
    state.pinInput = a
    state.pinConfirm = b
    if (a.trim().length < 4) {
      state.error = 'PIN must be at least 4 characters'
      render()
      return
    }
    if (a !== b) {
      state.error = 'PINs do not match'
      render()
      return
    }
    state.busy = true
    render()
    try {
      await setPin(a)
      state.pinInput = ''
      state.pinConfirm = ''
      go('gallery')
    } catch (err) {
      state.error = err instanceof Error ? err.message : 'Could not save PIN'
      render()
    } finally {
      state.busy = false
    }
  })

  const changePin = document.getElementById('change-pin-form') as HTMLFormElement | null
  changePin?.addEventListener('submit', async (e) => {
    e.preventDefault()
    if (state.viewOnly) return
    const a = (document.getElementById('pin-input') as HTMLInputElement).value
    const b = (document.getElementById('pin-confirm') as HTMLInputElement).value
    if (a.trim().length < 4) {
      state.error = 'PIN must be at least 4 characters'
      render()
      return
    }
    if (a !== b) {
      state.error = 'PINs do not match'
      render()
      return
    }
    try {
      await setPin(a)
      state.error = ''
      toast('PIN updated')
      render()
    } catch (err) {
      state.error = err instanceof Error ? err.message : 'Could not update PIN'
      render()
    }
  })

  document.getElementById('btn-settings')?.addEventListener('click', () => go('settings'))
  document.getElementById('btn-lock')?.addEventListener('click', () => {
    lockSession()
    state.pinInput = ''
    exitSelectMode()
    go('unlock')
  })
  document.getElementById('btn-capture')?.addEventListener('click', () => {
    if (!state.viewOnly) go('capture')
  })
  document.getElementById('btn-back-gallery')?.addEventListener('click', () => go('gallery'))
  document.getElementById('btn-retake')?.addEventListener('click', () => {
    if (state.viewOnly) return
    discardDrafts()
    go('capture')
  })

  const cam = document.getElementById('file-camera') as HTMLInputElement | null
  cam?.addEventListener('change', () => {
    if (cam.files && cam.files.length > 0) onPhotoFiles(cam.files)
    cam.value = ''
  })
  const lib = document.getElementById('file-library') as HTMLInputElement | null
  lib?.addEventListener('change', () => {
    if (lib.files && lib.files.length > 0) onPhotoFiles(lib.files)
    lib.value = ''
  })

  const caption = document.getElementById('caption-input') as HTMLInputElement | null
  caption?.addEventListener('input', () => {
    state.caption = caption.value
  })

  document.getElementById('btn-upload')?.addEventListener('click', () => void doUpload(false))
  document.getElementById('btn-upload-fast')?.addEventListener('click', () => void doUpload(true))

  document.getElementById('btn-select')?.addEventListener('click', () => toggleSelectMode())
  document.getElementById('btn-cancel-select')?.addEventListener('click', () => {
    exitSelectMode()
    render()
  })
  document.getElementById('btn-delete-selected')?.addEventListener('click', () => void doDeleteSelected())

  document.querySelectorAll('.tile').forEach((el) => {
    el.addEventListener('click', () => {
      const id = (el as HTMLElement).dataset.id
      if (!id) return
      if (state.selectMode && !state.viewOnly) {
        togglePhotoSelection(id)
        return
      }
      const photo = state.photos.find((p) => p.id === id) ?? null
      state.lightbox = photo
      render()
    })
  })

  document.getElementById('lightbox-close')?.addEventListener('click', () => {
    state.lightbox = null
    render()
  })
  document.getElementById('lightbox')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
      state.lightbox = null
      render()
    }
  })
  document.getElementById('lightbox-delete')?.addEventListener('click', () => {
    if (!state.viewOnly && state.lightbox) void doDelete(state.lightbox)
  })

  document.getElementById('btn-copy-link')?.addEventListener('click', () => {
    void copyText(galleryBaseUrl(), 'Teacher link copied')
  })
  document.getElementById('btn-copy-parent-link')?.addEventListener('click', () => {
    void copyText(parentViewUrl(), 'Parent link copied')
  })
}

async function boot(): Promise<void> {
  render()
  const has = await resolvePinPresence()
  state.booting = false
  if (!has) {
    state.screen = state.viewOnly ? 'waiting' : 'setup'
  } else if (isUnlocked()) {
    state.screen = 'gallery'
  } else {
    state.screen = 'unlock'
  }
  render()
  if (state.screen === 'gallery') void refreshGallery()
}

void boot()

// Tile thumb fallback chain: thumbs/<id>.jpg -> render transform -> original
document.addEventListener(
  'error',
  (e) => {
    const img = e.target
    if (!(img instanceof HTMLImageElement)) return
    const list = (img.dataset.fallbacks ?? '').split(' ').filter(Boolean)
    const next = list.shift()
    if (!next) return
    img.dataset.fallbacks = list.join(' ')
    img.src = next
  },
  true,
)
