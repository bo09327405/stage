/** "12 KB" / "3.4 MB". */
export const formatBytes = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

/** "10/11 21:39" in local time, or '' for no time. */
export const formatWhen = (ms: number) => (ms ? new Date(ms).toLocaleString('zh-TW', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '')
