import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import type { useTheatreEngine } from '../../hooks/useTheatreEngine'
import type { ScriptData, ScriptSource } from '../../services/script'
import type { Cue } from '../../types/cue'
import type { SurfaceWidget } from '../../types/surface'
import { NotesViewer, type NoteSource } from './NotesViewer'
import { useStageDark } from './stageTheme'
import { useNotePrefs } from './useNotePrefs'

/**
 * A surface button set to "Note" display: the same Note window as the Notes drawer — 📌 跟隨,
 * A− / A+, ✎ 編輯 / 🔗 網址, ↻, the 手動 / Notion switch — showing either the version's shared
 * script (noteSource "script") or this button's own note (its text, or its own Notion page).
 * ⤢ opens it large. In edit mode (`preview`) it only previews, so the block can be dragged.
 */
export function MiniNote({
  widget,
  engine,
  cues,
  script,
  onChange,
  preview = false,
}: {
  widget: SurfaceWidget
  engine: ReturnType<typeof useTheatreEngine>
  cues: Cue[]
  script: ScriptData & { save: (text: string) => Promise<void>; saveSource: (source: ScriptSource, notionUrl?: string) => Promise<void> }
  /** Save this button's own note (text / Notion link). */
  onChange: (widget: SurfaceWidget) => Promise<void> | void
  preview?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const fromScript = widget.noteSource === 'script'
  // Per button and device; starts at the size set in the button's properties.
  const prefs = useNotePrefs(`theatre.miniNote.${widget.id}`, { font: widget.noteFont, follow: true })
  const dark = useStageDark(engine, prefs.theme)

  // Where its content lives: the shared script, or the button's own fields.
  const note: NoteSource = fromScript
    ? { text: script.text, source: script.source, notionUrl: script.notionUrl, saveText: script.save, saveSource: script.saveSource, empty: '劇本筆記是空的（按 ✎ 編輯，或在 📝 筆記區編輯）' }
    : {
        text: widget.noteText,
        source: widget.noteSource === 'notion' ? 'notion' : 'manual',
        notionUrl: widget.noteNotionUrl,
        saveText: async (noteText) => void (await onChange({ ...widget, noteText })),
        saveSource: async (source, notionUrl) =>
          void (await onChange({ ...widget, noteSource: source === 'notion' ? 'notion' : 'custom', ...(notionUrl !== undefined ? { noteNotionUrl: notionUrl } : {}) })),
        empty: '這個 Note 還沒有內容（按 ✎ 編輯）',
      }

  const title = (
    <>
      📝 <span className="truncate">{widget.label || 'Note'}</span>
      <span className="shrink-0 font-normal text-white/35">{note.source === 'notion' ? '· Notion' : fromScript ? '· 劇本' : ''}</span>
    </>
  )
  const btn = 'flex h-6 min-w-6 shrink-0 items-center justify-center rounded px-1 text-[11px] text-white/60 hover:bg-white/10 hover:text-white'

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden rounded-2xl border transition-colors duration-700"
      style={{ borderColor: `${widget.color}${dark ? '40' : '80'}` }}
      data-mini-note={widget.id}
      data-stage={dark ? 'dark' : 'normal'}
    >
      <NotesViewer
        engine={engine}
        cues={cues}
        note={note}
        prefs={prefs}
        variant="mini"
        title={title}
        titleColor={widget.color}
        interactive={!preview}
        actions={
          !preview && (
            <button type="button" onClick={() => setExpanded(true)} className={btn} aria-label="放大檢視" title="放大檢視" data-mini-note-expand>
              ⤢
            </button>
          )
        }
      />

      {createPortal(
        <AnimatePresence>
          {expanded && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
              onClick={() => setExpanded(false)}
            >
              <motion.div
                initial={{ scale: 0.96 }}
                animate={{ scale: 1 }}
                onClick={(e) => e.stopPropagation()}
                className="flex h-[min(820px,92dvh)] w-[min(900px,100%)] flex-col overflow-hidden rounded-2xl border shadow-2xl"
                style={{ borderColor: `${widget.color}80` }}
                role="dialog"
                aria-label={widget.label}
                data-note-expanded
              >
                <NotesViewer
                  engine={engine}
                  cues={cues}
                  note={note}
                  prefs={prefs}
                  variant="panel"
                  title={title}
                  titleColor={widget.color}
                  scale={1.5}
                  actions={
                    <button type="button" onClick={() => setExpanded(false)} className="flex h-8 w-8 items-center justify-center rounded-md text-white/50 hover:bg-white/10" aria-label="關閉">
                      ✕
                    </button>
                  }
                />
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  )
}
