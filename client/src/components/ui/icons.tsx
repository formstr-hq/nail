/**
 * Inline single-path icons (lucide geometry) at a shared 24px grid.
 *
 * Kept local rather than pulled from an icon package: the client uses a dozen
 * glyphs and a dependency for that would ship a few hundred it never renders.
 */
import { type SVGProps } from 'react'

function Icon({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  )
}

export const PenIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
  </Icon>
)

export const ReplyIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
    <path d="m9 17-5-5 5-5" />
  </Icon>
)

export const ReplyAllIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="m7 17-5-5 5-5" />
    <path d="m12 17-5-5 5-5" />
    <path d="M22 18v-2a4 4 0 0 0-4-4h-8" />
  </Icon>
)

export const ForwardIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M4 18v-2a4 4 0 0 1 4-4h12" />
    <path d="m15 17 5-5-5-5" />
  </Icon>
)

export const ArchiveIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <rect width="20" height="5" x="2" y="3" rx="1" />
    <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
    <path d="M10 12h4" />
  </Icon>
)

export const TrashIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M3 6h18" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </Icon>
)

export const SearchIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
  </Icon>
)

export const SettingsIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </Icon>
)

export const LogOutIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="m16 17 5-5-5-5" />
    <path d="M21 12H9" />
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
  </Icon>
)

export const KeyIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <circle cx="7.5" cy="15.5" r="5.5" />
    <path d="m21 2-9.6 9.6" />
    <path d="m15.5 7.5 3 3L22 7l-3-3" />
  </Icon>
)

export const SunIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
  </Icon>
)

export const MoonIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9" />
  </Icon>
)

export const XIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Icon>
)

export const MinimizeIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M5 12h14" />
  </Icon>
)

export const ExpandIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="m18 15-6-6-6 6" />
  </Icon>
)

export const BackIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="m15 18-6-6 6-6" />
  </Icon>
)

export const PaperclipIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M13.234 20.252 21 12.3a3.94 3.94 0 0 0 0-5.573 3.94 3.94 0 0 0-5.573 0l-9.19 9.192a5.91 5.91 0 0 0 0 8.36 5.91 5.91 0 0 0 8.36 0l8.485-8.486" />
  </Icon>
)

export const AlertIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M12 9v4M12 17h.01" />
    <circle cx="12" cy="12" r="10" />
  </Icon>
)

export const CopyIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
  </Icon>
)

export const CheckIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M20 6 9 17l-5-5" />
  </Icon>
)

export const ChevronDownIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="m6 9 6 6 6-6" />
  </Icon>
)

export const ChevronRightIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="m9 18 6-6-6-6" />
  </Icon>
)

export const UserIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </Icon>
)

export const PlusIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M5 12h14M12 5v14" />
  </Icon>
)

export const AtSignIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
  </Icon>
)

export const InboxIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M22 12h-6l-2 3h-4l-2-3H2" />
    <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
  </Icon>
)

/**
 * The mailstr mark — same glyph as the landing favicon and the signer modal.
 *
 * The gradient id is per-instance. A fixed id breaks as soon as the mark
 * appears twice in one document (the responsive layout renders a hidden mobile
 * copy alongside the sidebar one): duplicate ids make `url(#…)` resolve to
 * whichever came first, and the envelope loses its fill.
 */
export function BrandGlyph({ size = 22 }: { size?: number }) {
  // Monochrome + one spark, tracking the theme: the envelope is ink (paper in
  // dark), its cut-out disc is the ground behind it, the asterisk is emphasis.
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
      <rect
        x="4"
        y="12"
        width="56"
        height="40"
        rx="8"
        className="fill-foreground"
      />
      <path
        d="M8 18 L32 38 L56 18"
        fill="none"
        className="stroke-background"
        strokeWidth="4.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="50" cy="14" r="10" className="fill-background" />
      <path
        d="M50 8.5 L50 19.5 M45.2 11.25 L54.8 16.75 M45.2 16.75 L54.8 11.25"
        className="stroke-emphasis"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </svg>
  )
}
