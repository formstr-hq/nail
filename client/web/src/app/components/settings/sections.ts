import {
  AtSignIcon,
  InboxIcon,
  PenIcon,
  SunIcon,
  KeyIcon,
  LockIcon,
  HelpIcon,
} from '@/app/components/ui/icons'

export type SectionId =
  | 'addresses'
  | 'workspace'
  | 'relays'
  | 'composing'
  | 'encryption'
  | 'security'
  | 'appearance'
  | 'help'

export const SECTIONS: { id: SectionId; label: string; icon: typeof AtSignIcon }[] = [
  { id: 'addresses', label: 'Addresses', icon: AtSignIcon },
  { id: 'workspace', label: 'Workspace', icon: InboxIcon },
  { id: 'relays', label: 'Relays', icon: InboxIcon },
  { id: 'composing', label: 'Composing', icon: PenIcon },
  { id: 'encryption', label: 'Encryption', icon: LockIcon },
  { id: 'security', label: 'Security', icon: KeyIcon },
  { id: 'appearance', label: 'Appearance', icon: SunIcon },
  { id: 'help', label: 'Help', icon: HelpIcon },
]