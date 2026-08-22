import type { AnnotationStatus, AnnotationTask, Project } from '@shared/types'
import { findAnnotation, useEditor } from '@/state/store'

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value))

interface TaskStart {
  status: AnnotationStatus
  result?: string
  updatedAt: string
  completedAt?: string
}

const taskStarts = new Map<string, TaskStart>()

export interface LiveAnnotationTask extends AnnotationTask {
  trackId: string
  trackName: string
  end: number
}

export function getAnnotationTasks(filter: {
  status?: AnnotationStatus
  trackId?: string
} = {}): LiveAnnotationTask[] {
  const project = useEditor.getState().project
  return project.tracks
    .filter((track) => track.kind === 'annotation' && (!filter.trackId || track.id === filter.trackId))
    .flatMap((track) => (track.annotations ?? [])
      .filter((task) => !filter.status || task.status === filter.status)
      .map((task) => ({
        ...clone(task),
        trackId: track.id,
        trackName: track.name,
        end: task.start + task.duration
      })))
    .sort((a, b) => a.start - b.start)
}

export function startAnnotationTask(id: string): LiveAnnotationTask {
  const state = useEditor.getState()
  const live = findAnnotation(state.project, id)
  if (!live) throw new Error(`annotation task not found: ${id}`)
  if (!taskStarts.has(id)) {
    taskStarts.set(id, {
      status: live.annotation.status,
      result: live.annotation.result,
      updatedAt: live.annotation.updatedAt,
      completedAt: live.annotation.completedAt
    })
  }
  const project = clone(state.project)
  const found = findAnnotation(project, id)!
  found.annotation.status = 'in_progress'
  found.annotation.completedAt = undefined
  found.annotation.updatedAt = new Date().toISOString()
  useEditor.setState({ project })
  return getAnnotationTasks().find((task) => task.id === id)!
}

/**
 * Apply one agent task as one undo entry. The undo snapshot restores the
 * pre-agent status/result while retaining the latest live text and timing, so
 * a user drag performed while the agent was thinking is never overwritten.
 * `mutate` should contain the final, short editor mutation batch.
 */
export async function applyAnnotationTask<T>(
  id: string,
  result: string,
  mutate?: () => T | Promise<T>
): Promise<{ task: LiveAnnotationTask; value: T | null }> {
  const before = useEditor.getState()
  const live = findAnnotation(before.project, id)
  if (!live) {
    taskStarts.delete(id)
    throw new Error(`annotation task not found: ${id}`)
  }

  const currentProject = clone(before.project)
  const undoProject: Project = clone(currentProject)
  const undoTask = findAnnotation(undoProject, id)!.annotation
  const started = taskStarts.get(id)
  if (started) {
    undoTask.status = started.status
    undoTask.result = started.result
    undoTask.updatedAt = started.updatedAt
    undoTask.completedAt = started.completedAt
  }
  const past = before.past
  const future = before.future

  try {
    const value = mutate ? await mutate() : null
    const after = useEditor.getState()
    const project = clone(after.project)
    const found = findAnnotation(project, id)
    if (!found) throw new Error(`annotation task not found: ${id}`)
    const now = new Date().toISOString()
    found.annotation.status = 'done'
    found.annotation.result = result.trim()
    found.annotation.updatedAt = now
    found.annotation.completedAt = now
    useEditor.setState({
      project,
      past: [...past, { project: undoProject, label: 'hAnnotationAgent' }].slice(-50),
      future: []
    })
    taskStarts.delete(id)
    return { task: getAnnotationTasks().find((task) => task.id === id)!, value }
  } catch (error) {
    const latest = useEditor.getState()
    if (findAnnotation(latest.project, id)) {
      useEditor.setState({ project: currentProject, past, future })
    } else {
      // A concurrent user deletion wins: never resurrect a task by ID.
      useEditor.setState({ past, future: [] })
    }
    taskStarts.delete(id)
    throw error
  }
}

export function updateAnnotationTask(
  id: string,
  patch: { status?: AnnotationStatus; result?: string }
): LiveAnnotationTask {
  const ok = useEditor.getState().updateAnnotation(id, patch)
  if (!ok) throw new Error(`annotation task not found: ${id}`)
  return getAnnotationTasks().find((task) => task.id === id)!
}
