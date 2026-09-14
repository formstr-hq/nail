import { useState } from 'react'

/** Two letters that stand in for a face. Never derived from a bare `npub1`. */
function initials(label: string): string {
  const cleaned = label.replace(/^npub1/, '').trim()
  const words = cleaned.split(/[\s@._-]+/).filter(Boolean)
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
  return cleaned.slice(0, 2).toUpperCase()
}

interface AvatarProps {
  /** Name or address the initials come from when there is no picture. */
  label: string
  /** kind-0 picture URL, already validated as https by the profile lib. */
  picture?: string | null
  size?: number
  className?: string
}

/**
 * A sender's face: their kind-0 picture, or their initials on the brand
 * gradient.
 *
 * The picture is a URL the sender chose, so a load failure is expected rather
 * than exceptional — a dead host, a hotlink block, or a deleted file all end
 * up here. Failing back to initials keeps the row from collapsing.
 */
export function Avatar({ label, picture, size = 32, className = '' }: AvatarProps) {
  // The picture URL whose load failed. Derived against the current `picture`
  // instead of resetting via an effect, so a new URL is always treated as a
  // fresh attempt without a setState round-trip.
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const failed = !!picture && failedUrl === picture

  const box = {
    width: size,
    height: size,
    fontSize: Math.max(9, Math.round(size * 0.34)),
  }

  if (picture && !failed) {
    return (
      <img
        src={picture}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailedUrl(picture ?? null)}
        style={box}
        className={`flex-none rounded-md bg-muted object-cover ${className}`}
      />
    )
  }

  return (
    <span
      aria-hidden="true"
      style={box}
      className={`grid flex-none place-items-center rounded-md bg-secondary font-bold text-foreground ${className}`}
    >
      {initials(label)}
    </span>
  )
}
