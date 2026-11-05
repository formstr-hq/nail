import type {
  Email,
  FolderEntry,
  FolderMatch,
  LabelEntry,
  MailFlags,
} from '@/app/types/mail'

/**
 * Folder and label resolution — the whole of NIP-XX "Nostr Mail Metadata" §
 * Folders, in one place and free of React/store state so it can be tested
 * against the spec directly.
 *
 * A message's folder is:
 *
 *   1. the explicit `folder` in its kind-34578 state, including an explicit
 *      `'inbox'` stored to override a match ("Not spam"); failing that
 *   2. the first folder, by `position` then `name`, whose `match` applies;
 *      failing that
 *   3. unfiled — the natural Sent (self-copy) or Inbox.
 *
 * Labels are additive: explicit ids from state, plus every label whose `match`
 * applies. Unlike folders they never move a message between folders.
 */

/** Ids the client's built-in actions depend on; names remain editable. */
export const RESERVED_FOLDER_IDS = ['inbox', 'sent', 'archive', 'spam', 'trash'] as const

/**
 * The folders a fresh mailbox starts with. Spam is an ordinary folder whose
 * match consumes the server's spam marker — there is no `labels: ['spam']`
 * special case anywhere.
 */
export const DEFAULT_FOLDERS: FolderEntry[] = [
  { id: 'inbox', name: 'Inbox', position: 0 },
  { id: 'sent', name: 'Sent', position: 1 },
  { id: 'archive', name: 'Archive', position: 2 },
  { id: 'spam', name: 'Spam', position: 3, match: { spam: true } },
  { id: 'trash', name: 'Trash', position: 4 },
]

export function foldersOf(settings: { folders?: FolderEntry[] } | undefined): FolderEntry[] {
  const folders = settings?.folders
  if (!folders || folders.length === 0) return DEFAULT_FOLDERS
  // Inbox and Sent are the natural mailboxes, not optional entries: a settings
  // event from another client that omitted them must not make the Inbox
  // button disappear. Everything else is exactly what the user saved.
  const ids = new Set(folders.map((f) => f.id))
  const missing = DEFAULT_FOLDERS.filter(
    (f) => (f.id === 'inbox' || f.id === 'sent') && !ids.has(f.id),
  )
  return missing.length ? [...folders, ...missing] : folders
}

export function labelsOf(settings: { labels?: LabelEntry[] } | undefined): LabelEntry[] {
  return settings?.labels ?? []
}

/** Spec order: `position` ascending, absent last, ties by name then id. */
export function sortFolders(entries: FolderEntry[]): FolderEntry[] {
  const position = (e: FolderEntry) => e.position ?? Number.POSITIVE_INFINITY
  return [...entries].sort(
    (a, b) =>
      position(a) - position(b) ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  )
}

/** "equals an entry, or ends with `@` or `.` followed by it", case-insensitive. */
function senderMatches(address: string, entry: string): boolean {
  const a = address.trim().toLowerCase()
  const e = entry.trim().toLowerCase()
  if (!e) return false
  return a === e || a.endsWith(`@${e}`) || a.endsWith(`.${e}`)
}

/**
 * All present fields must match; entries inside one field are OR-ed.
 *
 * An empty/absent match matches nothing. Vacuous truth would make `match: {}`
 * swallow every message, which is never what a user means by adding a folder.
 */
export function matchesMatch(match: FolderMatch | undefined, email: Email): boolean {
  if (!match) return false
  const checks: boolean[] = []

  if (match.from?.length) {
    checks.push(match.from.some((entry) => senderMatches(email.fromHeader.address, entry)))
  }
  if (match.subject?.length) {
    checks.push(
      match.subject.some((entry) => {
        const needle = entry.trim().toLowerCase()
        return needle.length > 0 && email.subject.toLowerCase().includes(needle)
      }),
    )
  }
  if (match.has_attachment !== undefined) {
    checks.push((email.attachments.length > 0) === match.has_attachment)
  }
  if (match.spam !== undefined) {
    checks.push(!!email.spam === match.spam)
  }

  return checks.length > 0 && checks.every(Boolean)
}

/** The folder id a message belongs to, or undefined when unfiled. */
export function resolveFolder(
  email: Email,
  flags: MailFlags | undefined,
  folders: FolderEntry[],
): string | undefined {
  // Explicit state wins over every match, including an explicit 'inbox'.
  if (flags?.folder) return flags.folder
  for (const folder of sortFolders(folders)) {
    if (folder.match && matchesMatch(folder.match, email)) return folder.id
  }
  return undefined
}

/** Explicit label ids plus every label whose match applies. */
export function resolveLabels(
  email: Email,
  flags: MailFlags | undefined,
  labels: LabelEntry[],
): string[] {
  // A deleted label leaves its id in old state events. Drop dangling ids once
  // definitions exist; while settings are still loading (no definitions), keep
  // them so a label defined on another device is not hidden transiently.
  const known = new Set(labels.map((l) => l.id))
  const ids = new Set(
    (flags?.labels ?? []).filter((id) => labels.length === 0 || known.has(id)),
  )
  for (const label of labels) {
    if (label.match && matchesMatch(label.match, email)) ids.add(label.id)
  }
  return [...ids]
}

export function folderName(folders: FolderEntry[], id: string | undefined): string | undefined {
  if (!id) return undefined
  return folders.find((f) => f.id === id)?.name
}

export function isReservedFolderId(id: string): boolean {
  return (RESERVED_FOLDER_IDS as readonly string[]).includes(id)
}

/**
 * The `spam` property a folder match consumes.
 *
 * Prefer the bridge's authenticated marker when present: the bridge is the last
 * hop and strips sender-supplied `X-Spam*` headers, so a sender cannot file
 * itself (or forge its way out). `X-Spam-Flag` is the fallback for mail from
 * other bridges and for messages already on relays.
 */
export function spamFromHeaders(
  headers: ReadonlyArray<{ key: string; value: string }> | undefined,
): boolean {
  if (!headers?.length) return false
  const get = (name: string) =>
    headers.find((h) => h.key.toLowerCase() === name)?.value.trim()

  const bridge = get('x-bridge-spam')
  if (bridge !== undefined) return /^yes$/i.test(bridge)
  return /^yes/i.test(get('x-spam-flag') ?? '')
}

/** `#RRGGBB` derived from an id, for entries that did not pick a colour. */
export function colorForId(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  const hue = hash % 360
  // Fixed S/L keeps every generated colour legible on both themes.
  return hslToHex(hue, 62, 46)
}

function hslToHex(h: number, s: number, l: number): string {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100)
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    const color = l / 100 - a * Math.max(Math.min(k - 3, 9 - k, 1), -1)
    return Math.round(255 * color)
      .toString(16)
      .padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}

/** A URL-safe id derived from a name, unique among `existing`. */
export function newEntryId(name: string, existing: string[]): string {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'folder'
  if (!existing.includes(base)) return base
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`
    if (!existing.includes(candidate)) return candidate
  }
}

/** Validation for the settings editor. Returns an error message or undefined. */
export function validateEntry(
  entry: FolderEntry,
  existing: FolderEntry[],
): string | undefined {
  const name = entry.name.trim()
  if (!entry.id.trim()) return 'Folder id is required.'
  if (!name) return 'Name is required.'
  if (name.length > 64) return 'Name must be 64 characters or fewer.'
  if (
    existing.some(
      (e) => e.id !== entry.id && e.name.trim().toLowerCase() === name.toLowerCase(),
    )
  ) {
    return 'Name must be unique.'
  }
  const from = entry.match?.from?.map((s) => s.trim()).filter(Boolean) ?? []
  if (from.some((s) => !s.includes('@') && !/^[a-z0-9.-]+$/i.test(s))) {
    return 'Sender entries must be an address or a domain.'
  }
  return undefined
}
