import { isNativeApp } from '@/lib/platform'

/**
 * A filename safe to hand a download.
 *
 * Two classes of invisible character are stripped, for different reasons:
 *
 *  - C0 controls and DEL, which can truncate or corrupt the name downstream.
 *  - Bidirectional overrides. A name containing U+202E renders in the save
 *    dialog with its extension reversed - "invoice<RLO>fdp.exe" reads as
 *    "invoiceexe.pdf" while staying an executable on disk, so stripping
 *    C0 alone leaves the extension-spoofing trick fully intact.
 */
const UNSAFE_INVISIBLE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

export function safeFilename(name: string): string {
  const flattened = name
    .replace(/[/\\]/g, '_')
    .replace(UNSAFE_INVISIBLE, '')
    .replace(/^\.+/, '')
    .trim()
  return flattened.slice(0, 200) || 'attachment'
}

/**
 * Hand a file to the user — a real download, on both targets.
 *
 * On the web an `<a download>` off a blob: URL is the whole story. Inside the
 * Capacitor app that click is a silent no-op: the Android WebView has no
 * download handling, so the file never lands anywhere. There we write the
 * bytes to the app cache with the Filesystem plugin and open the system share
 * sheet, which is the platform's "save this file" affordance — the user picks
 * Files, Drive, or sends it wherever.
 *
 * The plugins are reached through the runtime global (`window.Capacitor.
 * Plugins`) rather than npm deps so the client build stays Capacitor-free,
 * like the other native bridges (see notifications.ts, androidBack.ts).
 */

interface FilesystemPlugin {
  writeFile(options: {
    path: string
    data: string
    directory: string
    recursive?: boolean
  }): Promise<{ uri: string }>
}

interface SharePlugin {
  share(options: {
    title?: string
    url?: string
    dialogTitle?: string
  }): Promise<unknown>
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean
  Plugins?: { Filesystem?: FilesystemPlugin; Share?: SharePlugin }
}

function nativePlugins(): { filesystem: FilesystemPlugin; share: SharePlugin } | null {
  if (!isNativeApp()) return null
  const cap = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor
  const filesystem = cap?.Plugins?.Filesystem
  const share = cap?.Plugins?.Share
  return filesystem && share ? { filesystem, share } : null
}

/**
 * Bytes -> base64, in 32 KB slices so a large attachment can't blow the
 * argument limit of `String.fromCharCode`.
 */
function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/**
 * Save `data` for the user. Text callers hand a string; binary callers (the
 * attachments) hand bytes. Both go through the same native write + share
 * sheet, or the plain browser download on the web.
 */
export async function saveToDisk(
  data: Uint8Array | string,
  filename: string,
  contentType: string,
): Promise<void> {
  const name = safeFilename(filename)
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data

  const native = nativePlugins()
  if (native) {
    const { uri } = await native.filesystem.writeFile({
      path: name,
      data: toBase64(bytes),
      directory: 'CACHE',
      recursive: true,
    })
    // Cancelling the share sheet is not an error — the file is written; the
    // user can come back and save it again.
    await native.share
      .share({ title: name, url: uri, dialogTitle: 'Save file' })
      .catch(() => {})
    return
  }

  const blob = new Blob([bytes as BlobPart], { type: contentType || 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.rel = 'noopener'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}