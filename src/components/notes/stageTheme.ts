import { useCueMonitorState } from '../../hooks/useCueMonitorState'
import type { useTheatreEngine } from '../../hooks/useTheatreEngine'

/** "auto" follows the show; "normal" / "dark" pin the look. */
export type NoteTheme = 'auto' | 'normal' | 'dark'

export const NOTE_THEME_LABELS: Record<NoteTheme, string> = {
  auto: '自動（跟隨演出）',
  normal: '一般',
  dark: '暗場',
}

/**
 * Whether notes should use the dark-stage look: always when pinned to "dark", and in "auto" mode
 * while the show is dimmed (DIM) or a blackout cue is running — when a bright panel would glare.
 */
export function useStageDark(engine: ReturnType<typeof useTheatreEngine>, theme: NoteTheme = 'auto') {
  const { instances } = useCueMonitorState(engine)
  if (theme !== 'auto') return theme === 'dark'
  return engine.showState.dim || instances.some((i) => i.stopAt == null && i.cue.type === 'BLACKOUT')
}

/**
 * Colours for both looks. Normal sits between the surface's ink and panel tones so the notes read
 * as part of the console; dark-stage drops to near-black with dimmed, warmer text (less blue light).
 */
export const noteSkin = (dark: boolean) =>
  dark
    ? {
        shell: 'bg-[#060606] border-white/[0.05]',
        header: 'bg-black/60 border-white/[0.05]',
        content: { filter: 'brightness(0.68) sepia(0.18)' },
      }
    : {
        shell: 'bg-[#161616] border-line',
        header: 'bg-black/20 border-line',
        content: undefined,
      }
