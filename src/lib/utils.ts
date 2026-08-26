import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Merge Tailwind classes with correct precedence.
 *
 * `clsx` resolves conditionals; `twMerge` then drops earlier classes that the
 * later ones override (so a caller's `px-6` really beats a component's `px-4`
 * instead of both landing in the class list and letting source order decide).
 * Every shadcn component depends on this being present at `~/lib/utils`.
 */
export function cn(...inputs: Array<ClassValue>) {
  return twMerge(clsx(inputs))
}
