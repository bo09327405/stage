import { useState } from 'react'
import { signInWithGoogle } from '../../services/auth'

/** Sign-in for the operator side (hub, console, control panel, Studio). The audience never sees this. */
export function LoginScreen() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-ink px-6 text-center text-white" data-login-screen>
      <div className="flex items-center gap-3">
        <span className="h-3 w-3 rounded-full bg-go shadow-[0_0_12px_#30d158]" />
        <span className="text-lg font-bold tracking-[0.25em]">THEATRE CUE</span>
      </div>
      <p className="max-w-sm text-sm text-white/55">登入後進入專案大廳：管理你的 Set Cue 與 Studio 專案，打開別人分享的專案網址即可加入共編。</p>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          setError(null)
          signInWithGoogle()
            .catch((err: Error) => setError(err.message))
            .finally(() => setBusy(false))
        }}
        className="flex min-h-12 items-center gap-3 rounded-xl bg-white px-6 text-sm font-semibold text-black shadow-lg hover:bg-white/90 disabled:opacity-60"
        data-google-signin
      >
        <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
          <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
          <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
          <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
          <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
        </svg>
        {busy ? '登入中…' : '使用 Google 帳號登入'}
      </button>
      {error && (
        <p className="max-w-md text-xs text-panic" role="alert" data-login-error>
          {error}
        </p>
      )}
      <p className="text-[11px] text-white/30">觀眾端不需要登入</p>
    </div>
  )
}
