import { useState } from 'react'
import { rotateInvite } from '../../services/membership'

/**
 * Under a share link: what the link grants, and a button to issue a new invite token (links
 * shared so far stop working for anyone who hasn't joined yet; current members are unaffected).
 */
export function InviteReset({ projectId, token }: { projectId: string; token: string | null | undefined }) {
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px] text-white/45" data-invite-reset>
      <span>
        🔒 只有拿到這個連結（含邀請碼）並用 Google 登入的人能加入成為協作者；其他人無法開啟或看到專案。
        {token === null && <span className="text-standby"> 無法取得邀請碼（你可能不是這個專案的成員）。</span>}
      </span>
      <button
        type="button"
        disabled={busy || !token}
        onClick={async () => {
          if (!confirm('重新產生邀請碼？之前分享出去的連結將無法再讓新的人加入（已加入的成員不受影響）。')) return
          setBusy(true)
          try {
            await rotateInvite(projectId)
            setDone(true)
            setTimeout(() => setDone(false), 2000)
          } finally {
            setBusy(false)
          }
        }}
        className="min-h-8 rounded-lg bg-white/[0.07] px-2.5 text-white/70 hover:bg-white/15 disabled:opacity-40"
        data-invite-rotate
      >
        {done ? '✓ 已更換，請複製新連結' : '↻ 重新產生邀請碼'}
      </button>
    </div>
  )
}
