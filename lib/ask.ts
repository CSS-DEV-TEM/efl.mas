/**
 * v221: questions asked on the page itself instead of the browser's confirm / prompt / alert boxes. A browser that was told
 * to "prevent this page from creating additional dialogs" answers those boxes with Cancel at once — and then buttons such as
 * Pick all matched did nothing at all. AskHost (in the Shell) shows these; with no host on the page the browser box is used.
 */
export type AskKind = 'confirm' | 'prompt' | 'alert';
export interface AskReq { kind: AskKind; msg: string; def?: string; resolve: (v: unknown) => void }
let host: ((r: AskReq) => void) | null = null;
export const setAskHost = (h: ((r: AskReq) => void) | null) => { host = h; };

function ask(kind: AskKind, msg: string, def?: string): Promise<unknown> {
  return new Promise((resolve) => {
    if (!host || typeof window === 'undefined') {
      if (typeof window === 'undefined') { resolve(kind === 'confirm' ? false : null); return; }
      if (kind === 'confirm') resolve(window.confirm(msg));
      else if (kind === 'prompt') resolve(window.prompt(msg, def ?? ''));
      else { window.alert(msg); resolve(undefined); }
      return;
    }
    host({ kind, msg, def, resolve });
  });
}
/** OK → true, Cancel → false */
export const askConfirm = (msg: string) => ask('confirm', msg) as Promise<boolean>;
/** the text typed, or null for Cancel */
export const askPrompt = (msg: string, def = '') => ask('prompt', msg, def) as Promise<string | null>;
/** a message with OK */
export const notify = (msg: string) => ask('alert', msg) as Promise<void>;
