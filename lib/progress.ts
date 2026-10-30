'use client';
/**
 * v126: progress of the long jobs (Packing List download, uploads, Import Packing List, Pick all matched, cut roll tally):
 * each job reports its step and how far it is; the header shows a progress bar for every running job.
 */
export interface Task { id: number; label: string; step: string; done: number; total: number; started: number }
let seq = 0;
const tasks = new Map<number, Task>();
const listeners = new Set<(t: Task[]) => void>();
const emit = () => { const l = Array.from(tasks.values()); listeners.forEach((f) => f(l)); };
export function onTasks(f: (t: Task[]) => void) { listeners.add(f); f(Array.from(tasks.values())); return () => { listeners.delete(f); }; }

export interface TaskHandle {
  /** how far: done of total (total 0 = not known yet: a moving bar) and, optionally, the step */
  set: (done: number, total?: number, step?: string) => void;
  /** a new step (the bar starts again when total is given) */
  step: (step: string, total?: number) => void;
  end: () => void;
}
export function startTask(label: string, step = '', total = 0): TaskHandle {
  const id = ++seq;
  tasks.set(id, { id, label, step, done: 0, total, started: Date.now() });
  emit();
  return {
    set: (done, tot, st) => { const t = tasks.get(id); if (!t) return; t.done = done; if (tot !== undefined) t.total = tot; if (st !== undefined) t.step = st; emit(); },
    step: (st, tot) => { const t = tasks.get(id); if (!t) return; t.step = st; if (tot !== undefined) { t.total = tot; t.done = 0; } emit(); },
    end: () => { if (tasks.delete(id)) emit(); },
  };
}
