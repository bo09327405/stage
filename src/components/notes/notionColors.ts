import type { CSSProperties } from 'react'

/*
 * Notion's own colors, as Notion shows them in dark mode (the Note window is dark), for text
 * ("red") and highlights ("red_background"). Unknown names fall back to no styling.
 */

const TEXT: Record<string, string> = {
  gray: '#9B9B9B',
  brown: '#BA856F',
  orange: '#C77D48',
  yellow: '#CA9849',
  green: '#529E72',
  blue: '#5E87C9',
  purple: '#9D68D3',
  pink: '#D15796',
  red: '#DF5452',
}

const BACKGROUND: Record<string, string> = {
  gray: '#373737',
  brown: '#4A3228',
  orange: '#5C3B23',
  yellow: '#564328',
  green: '#243D30',
  blue: '#143A4E',
  purple: '#3C2D49',
  pink: '#4E2C3C',
  red: '#522E2A',
}

/** Inline style for a Notion color name, or undefined for "default" / unknown. */
export function notionColor(name: string | undefined): CSSProperties | undefined {
  if (!name) return undefined
  if (name.endsWith('_background')) {
    const bg = BACKGROUND[name.slice(0, -'_background'.length)]
    return bg ? { backgroundColor: bg } : undefined
  }
  const color = TEXT[name]
  return color ? { color } : undefined
}

/** Whether the color sets the text color (as opposed to a highlight). */
export const isTextColor = (name: string | undefined) => !!name && !name.endsWith('_background') && name in TEXT
