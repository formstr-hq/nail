import { useEffect, useMemo, useState } from 'react'
import { useAccountStore } from '@/app/store/account'
import { useMailStore } from '@/app/store/mail'
import { useSettingsStore } from '@/app/store/settings'
import { Field, inputClass } from '@/app/components/settings/Field'
import { Button } from '@/app/components/ui/Button'
import type { FolderEntry, FolderMatch, LabelEntry } from '@/app/types/mail'
import {
  colorForId,
  foldersOf,
  isReservedFolderId,
  labelsOf,
  newEntryId,
  validateEntry,
} from '@/app/lib/mail/folders'

/**
 * Folder and label definitions (NIP-XX § Folders / § Labels).
 *
 * These are *definitions* only: the per-message folder/label state lives in
 * kind-34578 and is written by the filing actions. Everything here is stored in
 * the encrypted kind-30078 settings event, so it syncs across devices.
 *
 * The five reserved ids (inbox, sent, archive, spam, trash) are the ones the
 * built-in actions name. Their names, colours, order and match rules are all
 * editable; they cannot be deleted, because a Trash button has to have a
 * Trash to put things in. Custom folders can be deleted once empty.
 */

const RESERVED_NOTE =
  'Built-in folders cannot be deleted; their name, colour, order and match rule are yours.'

function nextPosition(entries: FolderEntry[]): number {
  return entries.reduce((max, e) => Math.max(max, e.position ?? -1), -1) + 1
}

function uniqueName(base: string, entries: FolderEntry[]): string {
  const names = new Set(entries.map((e) => e.name.trim().toLowerCase()))
  if (!names.has(base.toLowerCase())) return base
  for (let i = 2; ; i++) {
    const candidate = `${base} ${i}`
    if (!names.has(candidate.toLowerCase())) return candidate
  }
}

type Tri = 'any' | 'yes' | 'no'

function triValue(value: boolean | undefined): Tri {
  return value === undefined ? 'any' : value ? 'yes' : 'no'
}

function triPatch(value: Tri): boolean | undefined {
  return value === 'any' ? undefined : value === 'yes'
}

function MatchEditor({
  match,
  onChange,
}: {
  match: FolderMatch | undefined
  onChange: (match: FolderMatch | undefined) => void
}) {
  const patch = (next: Partial<FolderMatch>) => {
    const merged: FolderMatch = { ...(match ?? {}), ...next }
    // Keep the object clean: an absent condition and one set to undefined are
    // the same thing, and the spec treats missing fields as "not present".
    for (const key of Object.keys(merged) as (keyof FolderMatch)[]) {
      const value = merged[key]
      if (value === undefined || (Array.isArray(value) && value.length === 0)) {
        delete merged[key]
      }
    }
    onChange(Object.keys(merged).length ? merged : undefined)
  }

  const listValue = (entries: string[] | undefined) => (entries ?? []).join(', ')
  const listPatch = (value: string) =>
    value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <label className="flex flex-col gap-1 text-[11.5px] text-muted-foreground">
        From (address or domain, comma-separated)
        <input
          className={inputClass}
          value={listValue(match?.from)}
          onChange={(e) => patch({ from: listPatch(e.target.value) })}
          placeholder="example.com, boss@work.com"
        />
      </label>
      <label className="flex flex-col gap-1 text-[11.5px] text-muted-foreground">
        Subject contains (comma-separated)
        <input
          className={inputClass}
          value={listValue(match?.subject)}
          onChange={(e) => patch({ subject: listPatch(e.target.value) })}
          placeholder="invoice, receipt"
        />
      </label>
      <label className="flex flex-col gap-1 text-[11.5px] text-muted-foreground">
        Has attachments
        <select
          className={inputClass}
          value={triValue(match?.has_attachment)}
          onChange={(e) => patch({ has_attachment: triPatch(e.target.value as Tri) })}
        >
          <option value="any">Any</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[11.5px] text-muted-foreground">
        Marked spam by the server
        <select
          className={inputClass}
          value={triValue(match?.spam)}
          onChange={(e) => patch({ spam: triPatch(e.target.value as Tri) })}
        >
          <option value="any">Any</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      </label>
    </div>
  )
}

function EntryEditor({
  entry,
  kind,
  onChange,
  onRemove,
  removeDisabled,
  removeHint,
}: {
  entry: FolderEntry
  kind: 'folder' | 'label'
  onChange: (entry: FolderEntry) => void
  onRemove: () => void
  removeDisabled: boolean
  removeHint?: string
}) {
  const color = entry.color ?? colorForId(entry.id)

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label={`${kind} name`}
          className={`${inputClass} max-w-[16rem]`}
          value={entry.name}
          onChange={(e) => onChange({ ...entry, name: e.target.value })}
        />
        <input
          aria-label={`${kind} colour`}
          type="color"
          value={color}
          onChange={(e) => onChange({ ...entry, color: e.target.value })}
          className="h-9 w-9 flex-none rounded-md border border-input bg-background p-1"
        />
        <label className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
          Order
          <input
            aria-label={`${kind} position`}
            type="number"
            className={`${inputClass} w-20`}
            value={entry.position ?? ''}
            onChange={(e) =>
              onChange({
                ...entry,
                position: e.target.value === '' ? undefined : Number(e.target.value),
              })
            }
          />
        </label>
        <code className="ml-auto font-mono text-[10px] text-subtle">{entry.id}</code>
        <Button
          variant="danger"
          size="sm"
          onClick={onRemove}
          disabled={removeDisabled}
          title={removeHint}
        >
          Remove
        </Button>
      </div>

      <MatchEditor match={entry.match} onChange={(match) => onChange({ ...entry, match })} />
    </div>
  )
}

export function FoldersSection() {
  const { settings, save } = useSettingsStore()
  const { account, active } = useAccountStore()
  const mailState = useMailStore((s) => s.mailState)

  const initialFolders = useMemo(() => foldersOf(settings), [settings.folders])
  const initialLabels = useMemo(() => labelsOf(settings), [settings.labels])

  const [folders, setFolders] = useState<FolderEntry[]>(initialFolders)
  const [labels, setLabels] = useState<LabelEntry[]>(initialLabels)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // Another device (or a settings reload) may replace the definitions; adopt
  // them unless the user is mid-edit on this device. The panel is small enough
  // that "reload wins" is the least surprising rule.
  useEffect(() => {
    setFolders(initialFolders)
    setLabels(initialLabels)
  }, [initialFolders, initialLabels])

  const dirty =
    JSON.stringify(folders) !== JSON.stringify(initialFolders) ||
    JSON.stringify(labels) !== JSON.stringify(initialLabels)

  function addFolder() {
    const id = newEntryId('folder', folders.map((f) => f.id))
    setFolders([
      ...folders,
      {
        id,
        name: uniqueName('New folder', folders),
        position: nextPosition(folders),
      },
    ])
    setSaved(false)
  }

  function addLabel() {
    const id = newEntryId('label', labels.map((l) => l.id))
    setLabels([
      ...labels,
      {
        id,
        name: uniqueName('New label', labels),
        color: colorForId(id),
      },
    ])
    setSaved(false)
  }

  function removeFolder(id: string) {
    if (isReservedFolderId(id)) return
    const inUse = Object.values(mailState).some((flags) => flags.folder === id)
    if (inUse) {
      setError('Move the messages out of this folder before removing it.')
      return
    }
    setFolders(folders.filter((f) => f.id !== id))
    setError(null)
    setSaved(false)
  }

  function removeLabel(id: string) {
    setLabels(labels.filter((l) => l.id !== id))
    setSaved(false)
  }

  async function onSave() {
    setError(null)
    setSaved(false)
    for (const entry of folders) {
      const message = validateEntry(entry, folders)
      if (message) return setError(`Folder "${entry.name}": ${message}`)
    }
    for (const entry of labels) {
      const message = validateEntry(entry, labels)
      if (message) return setError(`Label "${entry.name}": ${message}`)
    }
    if (!account || !active) return setError('Sign in to save folders.')
    setSaving(true)
    try {
      await save({ folders, labels }, account.pubkey, active)
      setSaved(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save folders.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Field
        label="Folders"
        hint="A message belongs to the first folder whose rule matches, unless you have filed it yourself. Spam is a normal folder with the rule “marked spam by the server”. Order is ascending."
      >
        <div className="flex flex-col gap-3">
          {folders.map((entry) => (
            <EntryEditor
              key={entry.id}
              entry={entry}
              kind="folder"
              onChange={(next) =>
                setFolders(folders.map((f) => (f.id === entry.id ? next : f)))
              }
              onRemove={() => removeFolder(entry.id)}
              removeDisabled={isReservedFolderId(entry.id)}
              removeHint={isReservedFolderId(entry.id) ? RESERVED_NOTE : undefined}
            />
          ))}
          <div>
            <Button size="sm" onClick={addFolder}>
              Add folder
            </Button>
          </div>
        </div>
      </Field>

      <Field
        label="Labels"
        hint="Unlike folders, a message may carry any number of labels. A label can also be added by a rule."
      >
        <div className="flex flex-col gap-3">
          {labels.length === 0 && (
            <p className="text-[11.5px] text-muted-foreground">
              No labels yet. Add one, or leave this empty.
            </p>
          )}
          {labels.map((entry) => (
            <EntryEditor
              key={entry.id}
              entry={entry}
              kind="label"
              onChange={(next) =>
                setLabels(labels.map((l) => (l.id === entry.id ? next : l)))
              }
              onRemove={() => removeLabel(entry.id)}
              removeDisabled={false}
            />
          ))}
          <div>
            <Button size="sm" onClick={addLabel}>
              Add label
            </Button>
          </div>
        </div>
      </Field>

      {error && (
        <p className="text-[12px] leading-relaxed text-destructive" role="alert">
          {error}
        </p>
      )}

      <div className="flex items-center gap-3">
        <Button variant="primary" onClick={onSave} disabled={saving || !dirty}>
          {saving ? 'Saving…' : 'Save folders and labels'}
        </Button>
        {saved && !dirty && (
          <span className="text-[11.5px] text-muted-foreground">Saved to your relays.</span>
        )}
      </div>
    </div>
  )
}
