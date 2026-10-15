import { push, ref, serverTimestamp } from 'firebase/database'
import { DEFAULT_SEQ_CUE, formatCueNumber, nextCueNumber, type SeqCue, type Sequence } from '../types/sequence'
import { db } from './firebase'
import { recordedUpdate } from './history'

/*
 * Saving the control panel's sequences and executor assignments (types/sequence.ts). Every edit
 * is undoable (history) and refused in read-only projects.
 */

const base = (projectId: string, surfaceId: string) => `projects/${projectId}/surfaces/${surfaceId}`
const touched = (projectId: string, surfaceId: string) => ({ [`${base(projectId, surfaceId)}/updatedAt`]: serverTimestamp() })
const newKey = (path: string) => push(ref(db, path)).key!

/** The programmer's values that Store writes; `touched` lists the ones the user set (Merge writes only those). */
export type CueValues = Omit<SeqCue, 'id' | 'number'>

/** A new sequence, loaded onto `execNo`, with the given first cue. Returns the sequence id. */
export async function storeNewSequence(projectId: string, surfaceId: string, execNo: number, values: CueValues, name: string) {
  const b = base(projectId, surfaceId)
  const seqId = newKey(`${b}/sequences`)
  const cueId = newKey(`${b}/sequences/${seqId}/cues`)
  await recordedUpdate({
    label: `Store：Executor ${execNo} 新序列「${name}」Cue 1`,
    group: 'surface',
    updates: {
      [`${b}/sequences/${seqId}`]: { name, cues: { [cueId]: { ...values, number: 1 } } },
      [`${b}/executors/${execNo}`]: { sequenceId: seqId },
    },
    extra: touched(projectId, surfaceId),
  })
  return { seqId, cueId }
}

/** Store › Append: a new cue at the end of the sequence. */
export async function appendCue(projectId: string, surfaceId: string, seq: Sequence, values: CueValues) {
  const b = base(projectId, surfaceId)
  const cueId = newKey(`${b}/sequences/${seq.id}/cues`)
  const number = nextCueNumber(seq)
  await recordedUpdate({
    label: `Store Append：「${seq.name}」Cue ${number}`,
    group: 'surface',
    updates: { [`${b}/sequences/${seq.id}/cues/${cueId}`]: { ...values, number } },
    extra: touched(projectId, surfaceId),
  })
  return { cueId, number }
}

/** Store › Merge: write the given values into an existing cue (others stay as they are). */
export function mergeCue(projectId: string, surfaceId: string, seq: Sequence, cue: SeqCue, values: Partial<CueValues>) {
  const b = `${base(projectId, surfaceId)}/sequences/${seq.id}/cues/${cue.id}`
  return recordedUpdate({
    label: `Store Merge：「${seq.name}」Cue ${formatCueNumber(cue.number)}`,
    group: 'surface',
    updates: Object.fromEntries(Object.entries(values).map(([k, v]) => [`${b}/${k}`, v])),
    extra: touched(projectId, surfaceId),
  })
}

/** Edit one cue in the sequence sheet. */
export function updateSeqCue(projectId: string, surfaceId: string, seq: Sequence, cue: SeqCue, change: Partial<Omit<SeqCue, 'id'>>) {
  const b = `${base(projectId, surfaceId)}/sequences/${seq.id}/cues/${cue.id}`
  return recordedUpdate({
    label: `編輯「${seq.name}」Cue ${formatCueNumber(cue.number)}`,
    group: 'surface',
    updates: Object.fromEntries(Object.entries(change).map(([k, v]) => [`${b}/${k}`, v])),
    extra: touched(projectId, surfaceId),
    coalesceKey: `seqcue:${cue.id}:${Object.keys(change).join(',')}`,
  })
}

export function deleteSeqCue(projectId: string, surfaceId: string, seq: Sequence, cue: SeqCue) {
  return recordedUpdate({
    label: `刪除「${seq.name}」Cue ${formatCueNumber(cue.number)}`,
    group: 'surface',
    updates: { [`${base(projectId, surfaceId)}/sequences/${seq.id}/cues/${cue.id}`]: null },
    extra: touched(projectId, surfaceId),
  })
}

/** A blank sequence (optionally loaded onto an executor). */
export async function createSequence(projectId: string, surfaceId: string, name: string, execNo?: number) {
  const b = base(projectId, surfaceId)
  const seqId = newKey(`${b}/sequences`)
  await recordedUpdate({
    label: `新增序列「${name}」`,
    group: 'surface',
    updates: { [`${b}/sequences/${seqId}`]: { name }, ...(execNo ? { [`${b}/executors/${execNo}`]: { sequenceId: seqId } } : {}) },
    extra: touched(projectId, surfaceId),
  })
  return seqId
}

export function renameSequence(projectId: string, surfaceId: string, seq: Sequence, name: string) {
  return recordedUpdate({
    label: `序列重新命名為「${name}」`,
    group: 'surface',
    updates: { [`${base(projectId, surfaceId)}/sequences/${seq.id}/name`]: name },
    extra: touched(projectId, surfaceId),
    coalesceKey: `seqname:${seq.id}`,
  })
}

/** Delete a sequence (and unload it from every executor). */
export function deleteSequence(projectId: string, surfaceId: string, seq: Sequence, executors: Record<string, { sequenceId: string }>) {
  const b = base(projectId, surfaceId)
  const updates: Record<string, unknown> = { [`${b}/sequences/${seq.id}`]: null }
  for (const [no, e] of Object.entries(executors)) if (e.sequenceId === seq.id) updates[`${b}/executors/${no}`] = null
  return recordedUpdate({ label: `刪除序列「${seq.name}」`, group: 'surface', updates, extra: touched(projectId, surfaceId) })
}

/** Load a sequence onto an executor (null: unload). */
export function assignExecutor(projectId: string, surfaceId: string, execNo: number, sequenceId: string | null) {
  return recordedUpdate({
    label: sequenceId ? `Executor ${execNo} 載入序列` : `Executor ${execNo} 卸載序列`,
    group: 'surface',
    updates: { [`${base(projectId, surfaceId)}/executors/${execNo}`]: sequenceId ? { sequenceId } : null },
    extra: touched(projectId, surfaceId),
  })
}

export const blankCueValues = (): CueValues => ({ ...DEFAULT_SEQ_CUE, source: { kind: 'none' } })
