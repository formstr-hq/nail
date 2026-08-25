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

export const LockIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <rect x="3" y="11" width="18" height="11" rx="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
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

export const RefreshIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
    <path d="M8 16H3v5" />
  </Icon>
)

export const CalendarIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M8 2v4M16 2v4" />
    <rect width="18" height="18" x="3" y="4" rx="2" />
    <path d="M3 10h18" />
  </Icon>
)

export const HelpIcon = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="10" />
    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
    <path d="M12 17h.01" />
  </Icon>
)

/**
 * The Mail by Form* mark for inline use (headers, cards, loading screen).
 *
 * Same red envelope + white flap as the Android launcher icon, but TILE-LESS:
 * the launcher's ink tile reads as a heavy black badge on the app's light
 * "paper" chrome (and the landing), so here the mark sits on the surface and the
 * asterisk uses `currentColor` — ink on light, paper on dark — so it adapts to
 * whatever it's placed on. The self-contained tile version lives in the favicon
 * and native icon (see scripts/render-app-icon.py); geometry is shared so they
 * don't drift.
 */
export function BrandGlyph({ size = 22 }: { size?: number }) {
  const RED = '#E5484D'
  const PAPER = '#F4F4F3'
  // Asterisk: three round-capped strokes crossing at (70,38), in currentColor.
  const AST = { cx: 70, cy: 38, arm: 22, w: 5, angles: [90, 30, 150] }
  const half = AST.arm / 2
  const astLines = AST.angles.map((a) => {
    const r = (a * Math.PI) / 180
    const dx = half * Math.cos(r)
    const dy = half * Math.sin(r)
    return { x1: AST.cx - dx, y1: AST.cy - dy, x2: AST.cx + dx, y2: AST.cy + dy }
  })
  return (
    // Cropped tight and centred on the art's true bounding box — envelope plus
    // the asterisk that overhangs top-right — so the mark sits balanced in its
    // box at every size (not low-left as a naive envelope-only crop would).
    <svg viewBox="23 15.25 68 68" width={size} height={size} aria-hidden="true">
      <rect x="32" y="40" width="44" height="34" rx="6" fill={RED} />
      <path
        d="M38.5,44 L54,59 L69.5,44"
        fill="none"
        stroke={PAPER}
        strokeWidth={3.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {astLines.map((l, i) => (
        <line key={i} {...l} stroke="currentColor" strokeWidth={AST.w} strokeLinecap="round" />
      ))}
    </svg>
  )
}
