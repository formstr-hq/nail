import { useMemo, useState } from 'react'
import type { Contact } from '@/app/lib/mail/contacts'
import { searchContacts } from '@/app/lib/mail/contacts'
import { splitRecipients } from '@/app/lib/mail/composeFields'

/**
 * Recipient autocomplete over past correspondents, for the To field.
 *
 * Suggestions appear once the token being typed reaches 3 characters, never
 * suggest an address already on the line, and are driven entirely from the
 * keyboard (↑/↓ to move, Enter to commit, Escape to dismiss without closing
 * the composer).
 */
export function useRecipientAutocomplete(input: {
  to: string
  contacts: Contact[]
  /** Commit the picked address back into the To field. */
  onPick: (address: string) => void
  /** Focus the To input after a pick. */
  toInputRef: React.RefObject<HTMLInputElement | null>
}) {
  const { to, contacts, onPick, toInputRef } = input
  const [recipientFocused, setRecipientFocused] = useState(false)
  const [activeSuggestion, setActiveSuggestion] = useState(0)

  const { token: recipientToken } = splitRecipients(to)
  // Addresses already on the line, so we never suggest a duplicate.
  const alreadyAdded = useMemo(
    () => new Set(to.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)),
    [to],
  )
  const suggestions = useMemo(
    () =>
      recipientFocused && recipientToken.length >= 3
        ? searchContacts(contacts, recipientToken).filter((c) => !alreadyAdded.has(c.key))
        : [],
    [recipientFocused, contacts, recipientToken, alreadyAdded],
  )
  const showSuggestions = suggestions.length > 0
  const activeIndex = Math.min(activeSuggestion, suggestions.length - 1)

  function applySuggestion(address: string) {
    const { head } = splitRecipients(to)
    onPick(`${head}${head ? ' ' : ''}${address}, `)
    setActiveSuggestion(0)
    toInputRef.current?.focus()
  }

  function onRecipientKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!showSuggestions) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveSuggestion((i) => Math.min(i + 1, suggestions.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveSuggestion((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      applySuggestion(suggestions[activeIndex].address)
    } else if (e.key === 'Escape') {
      // Dismiss the dropdown without letting the composer's own Escape close it.
      e.stopPropagation()
      setRecipientFocused(false)
    }
  }

  return {
    suggestions,
    showSuggestions,
    activeIndex,
    onRecipientFocus: () => setRecipientFocused(true),
    // Delay so a suggestion click registers before the list unmounts.
    onRecipientBlur: () => setTimeout(() => setRecipientFocused(false), 120),
    onRecipientKeyDown,
    applySuggestion,
    resetActiveSuggestion: () => setActiveSuggestion(0),
  }
}