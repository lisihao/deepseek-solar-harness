/** Six dog avatars drawn inline. Each sits on its own tinted tile so it stays legible on light and dark themes. */
import type { ReactElement } from 'react'
import { GOUZI_AVATAR_NAMES, type GouziAvatar } from '../contracts.ts'

const INK = '#2b2320'

interface Drawing {
  readonly tile: string
  readonly face: () => ReactElement
}

const eyes = (y = 33): ReactElement => (
  <>
    <circle cx="25" cy={y} r="2.4" fill={INK} />
    <circle cx="39" cy={y} r="2.4" fill={INK} />
  </>
)

const nose = (y = 40): ReactElement => <ellipse cx="32" cy={y} rx="3.2" ry="2.4" fill={INK} />

const DRAWINGS: Readonly<Record<GouziAvatar, Drawing>> = {
  // Orange head, pointed ears, cream cheeks.
  shiba: {
    tile: '#fbe3c4',
    face: () => (
      <>
        <path d="M14 30 L17 8 L30 20 Z" fill="#d9822b" stroke={INK} strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M50 30 L47 8 L34 20 Z" fill="#d9822b" stroke={INK} strokeWidth="1.5" strokeLinejoin="round" />
        <ellipse cx="32" cy="36" rx="19" ry="17" fill="#e8923a" stroke={INK} strokeWidth="1.5" />
        <path d="M18 40 Q32 56 46 40 Q40 48 32 48 Q24 48 18 40 Z" fill="#fff3df" />
        {eyes()}
        {nose()}
      </>
    ),
  },
  // Tan head, tall rounded ears, white blaze.
  corgi: {
    tile: '#e6efd9',
    face: () => (
      <>
        <ellipse cx="14" cy="18" rx="8" ry="12" fill="#c9893c" stroke={INK} strokeWidth="1.5" transform="rotate(-12 14 18)" />
        <ellipse cx="50" cy="18" rx="8" ry="12" fill="#c9893c" stroke={INK} strokeWidth="1.5" transform="rotate(12 50 18)" />
        <ellipse cx="32" cy="36" rx="19" ry="17" fill="#d99a4a" stroke={INK} strokeWidth="1.5" />
        <path d="M32 20 Q36 32 34 44 L30 44 Q28 32 32 20 Z" fill="#fffaf0" />
        <ellipse cx="32" cy="45" rx="9" ry="6" fill="#fffaf0" />
        {eyes()}
        {nose(41)}
      </>
    ),
  },
  // Black head with a white stripe and folded ears.
  'border-collie': {
    tile: '#dde6f3',
    face: () => (
      <>
        <path d="M12 26 Q8 14 20 12 Q26 18 24 28 Z" fill="#2f2f36" stroke={INK} strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M52 26 Q56 14 44 12 Q38 18 40 28 Z" fill="#2f2f36" stroke={INK} strokeWidth="1.5" strokeLinejoin="round" />
        <ellipse cx="32" cy="36" rx="19" ry="17" fill="#3a3a44" stroke={INK} strokeWidth="1.5" />
        <path d="M32 18 Q37 30 35 46 L29 46 Q27 30 32 18 Z" fill="#fafafa" />
        <ellipse cx="32" cy="46" rx="8" ry="5.5" fill="#fafafa" />
        <circle cx="24" cy="33" r="2.4" fill="#f4f4f4" />
        <circle cx="40" cy="33" r="2.4" fill="#f4f4f4" />
        <circle cx="24" cy="33" r="1.1" fill={INK} />
        <circle cx="40" cy="33" r="1.1" fill={INK} />
        {nose(42)}
      </>
    ),
  },
  // Curly puffs on the head and ears.
  poodle: {
    tile: '#f5dfe8',
    face: () => (
      <>
        <circle cx="13" cy="30" r="9" fill="#e9c6a2" stroke={INK} strokeWidth="1.5" />
        <circle cx="51" cy="30" r="9" fill="#e9c6a2" stroke={INK} strokeWidth="1.5" />
        <circle cx="32" cy="38" r="15" fill="#f1d3b3" stroke={INK} strokeWidth="1.5" />
        <circle cx="24" cy="14" r="7" fill="#e9c6a2" stroke={INK} strokeWidth="1.5" />
        <circle cx="40" cy="14" r="7" fill="#e9c6a2" stroke={INK} strokeWidth="1.5" />
        <circle cx="32" cy="10" r="7.5" fill="#e9c6a2" stroke={INK} strokeWidth="1.5" />
        {eyes(36)}
        {nose(43)}
      </>
    ),
  },
  // White cloud of fluff.
  bichon: {
    tile: '#e3e9f7',
    face: () => (
      <>
        <circle cx="14" cy="34" r="9" fill="#ffffff" stroke={INK} strokeWidth="1.5" />
        <circle cx="50" cy="34" r="9" fill="#ffffff" stroke={INK} strokeWidth="1.5" />
        <circle cx="20" cy="18" r="9" fill="#ffffff" stroke={INK} strokeWidth="1.5" />
        <circle cx="44" cy="18" r="9" fill="#ffffff" stroke={INK} strokeWidth="1.5" />
        <circle cx="32" cy="38" r="16" fill="#ffffff" stroke={INK} strokeWidth="1.5" />
        <circle cx="32" cy="16" r="8" fill="#ffffff" stroke={INK} strokeWidth="1.5" />
        {eyes(36)}
        {nose(43)}
      </>
    ),
  },
  // Patchwork coat, one ear up and one down.
  mixed: {
    tile: '#efe4d3',
    face: () => (
      <>
        <path d="M14 30 L16 8 L29 20 Z" fill="#8a8f98" stroke={INK} strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M50 22 Q60 22 56 36 Q50 34 46 26 Z" fill="#a8703a" stroke={INK} strokeWidth="1.5" strokeLinejoin="round" />
        <ellipse cx="32" cy="36" rx="19" ry="17" fill="#d8b98f" stroke={INK} strokeWidth="1.5" />
        <path d="M13 36 Q14 22 28 19 Q24 34 28 52 Q16 48 13 36 Z" fill="#9aa0a8" />
        <ellipse cx="42" cy="30" rx="6" ry="5" fill="#a8703a" />
        <ellipse cx="32" cy="46" rx="8.5" ry="5.5" fill="#fff3df" />
        {eyes()}
        {nose(42)}
      </>
    ),
  },
}

/**
 * Draw one avatar. It stays recognizable from 24 to 128 pixels because every shape is a plain fill with a shared
 * outline; no detail depends on a thin line.
 * @param props - avatar id and edge length in pixels.
 * @returns the avatar image.
 */
export function GouziAvatarImage({ avatarId, size = 40 }: { avatarId: GouziAvatar; size?: number }) {
  const drawing = DRAWINGS[avatarId]
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      role="img"
      aria-label={GOUZI_AVATAR_NAMES[avatarId]}
      data-avatar={avatarId}
    >
      <rect width="64" height="64" rx="16" fill={drawing.tile} />
      {drawing.face()}
    </svg>
  )
}
