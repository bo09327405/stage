import { useRef, useState, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react'

/**
 * Text that is saved straight to the database (no Save button) must not be driven by the stored
 * value while the user types: every keystroke is a round trip, and when the old value comes back
 * React rewrites the field — which cancels a Chinese (Zhuyin / Pinyin) IME composition halfway.
 *
 * This keeps its own text while focused, reports nothing during an IME composition, commits the
 * chosen characters on compositionend, and only follows the stored value again once the field
 * isn't being edited.
 */
function useImeText(value: string, onCommit: (value: string) => void) {
  const [text, setText] = useState(value)
  const [focused, setFocused] = useState(false)
  const composing = useRef(false)
  const last = useRef(value)

  // Follow outside changes (undo, other devices) whenever the user isn't editing here.
  const [synced, setSynced] = useState(value)
  if (value !== synced) {
    setSynced(value)
    if (!focused) setText(value)
  }

  const commit = (next: string) => {
    if (next === last.current) return
    last.current = next
    onCommit(next)
  }

  return {
    value: text,
    onChange: (e: { target: { value: string }; nativeEvent: Event }) => {
      setText(e.target.value)
      // Mid-composition the text holds unconfirmed Zhuyin symbols; wait for compositionend.
      if (composing.current || (e.nativeEvent as InputEvent).isComposing) return
      commit(e.target.value)
    },
    onCompositionStart: () => {
      composing.current = true
    },
    onCompositionEnd: (e: { currentTarget: { value: string } }) => {
      composing.current = false
      setText(e.currentTarget.value)
      commit(e.currentTarget.value)
    },
    onFocus: () => {
      last.current = value
      setFocused(true)
    },
    onBlur: () => {
      composing.current = false
      setFocused(false)
    },
  }
}

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  value: string
  onValueChange: (value: string) => void
}

/** An <input> that saves as you type and works with Chinese IME. */
export function ImeInput({ value, onValueChange, onFocus, onBlur, ...rest }: InputProps) {
  const ime = useImeText(value, onValueChange)
  return (
    <input
      {...rest}
      {...ime}
      onFocus={(e) => {
        ime.onFocus()
        onFocus?.(e)
      }}
      onBlur={(e) => {
        ime.onBlur()
        onBlur?.(e)
      }}
    />
  )
}

type TextareaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & {
  value: string
  onValueChange: (value: string) => void
}

/** A <textarea> that saves as you type and works with Chinese IME. */
export function ImeTextarea({ value, onValueChange, onFocus, onBlur, ...rest }: TextareaProps) {
  const ime = useImeText(value, onValueChange)
  return (
    <textarea
      {...rest}
      {...ime}
      onFocus={(e) => {
        ime.onFocus()
        onFocus?.(e)
      }}
      onBlur={(e) => {
        ime.onBlur()
        onBlur?.(e)
      }}
    />
  )
}
