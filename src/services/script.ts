import { onValue, ref } from 'firebase/database'
import { useCallback, useEffect, useState } from 'react'
import { db } from './firebase'
import { recordedUpdate } from './history'

export const SCRIPT_HELP =
  '輸入劇本對白或排練筆記。寫上 Q3、Q4.5 等會變成 Cue 點：執行中亮綠、Standby 亮黃，點一下即設為 Standby。「# 標題」為段落標題，「角色：台詞」會標出角色。貼上 Notion 頁面網址可切換為 Notion 預覽。'

/** Hand-written notes, or a live preview of a public Notion page. */
export type ScriptSource = 'manual' | 'notion'

export interface ScriptData {
  text: string
  source: ScriptSource
  notionUrl: string
}

/** The show's script / rehearsal notes for a version: {basePath}/script/{text,source,notionUrl}. */
export function useScript(basePath: string) {
  const path = `${basePath}/script`
  const [data, setData] = useState<ScriptData>({ text: '', source: 'manual', notionUrl: '' })
  const [loaded, setLoaded] = useState(false)

  useEffect(
    () =>
      onValue(ref(db, path), (snapshot) => {
        const raw = (snapshot.val() ?? {}) as Partial<ScriptData>
        setData({
          text: typeof raw.text === 'string' ? raw.text : '',
          source: raw.source === 'notion' ? 'notion' : 'manual',
          notionUrl: typeof raw.notionUrl === 'string' ? raw.notionUrl : '',
        })
        setLoaded(true)
      }),
    [path],
  )

  /** Save the whole text; continuous typing becomes one undo step. */
  const save = useCallback(
    (next: string) =>
      recordedUpdate({
        label: '編輯劇本 / 筆記',
        group: 'note',
        updates: { [`${path}/text`]: next },
        extra: { [`${path}/updatedAt`]: Date.now() },
        coalesceKey: `script:${path}`,
      }),
    [path],
  )

  /** Switch between manual notes and a Notion page (the manual text is kept either way). */
  const saveSource = useCallback(
    (source: ScriptSource, notionUrl?: string) =>
      recordedUpdate({
        label: source === 'notion' ? (notionUrl !== undefined ? '設定 Notion 頁面' : '切換為 Notion 預覽') : '切換為手動筆記',
        group: 'note',
        updates: { [`${path}/source`]: source, ...(notionUrl !== undefined ? { [`${path}/notionUrl`]: notionUrl.trim() } : {}) },
        extra: { [`${path}/updatedAt`]: Date.now() },
      }),
    [path],
  )

  return { ...data, loaded, save, saveSource }
}
