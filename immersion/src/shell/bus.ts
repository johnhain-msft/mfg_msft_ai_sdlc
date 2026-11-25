/**
 * Cross-window transport between the audience deck and the speaker view.
 *
 * Three redundant transports carry every message, because no single one works everywhere:
 *   postMessage        deck <-> the window it opened (works from file:// where each page is its own origin)
 *   BroadcastChannel   any same-origin windows
 *   localStorage       the `storage` event reaches other same-origin windows, and a late-opened speaker
 *                      window reads the last known deck state from it
 * Duplicates are dropped by (sender, sequence), so receivers see each message once.
 *
 * There is no timer, pacing or clock traffic here: the optional stopwatch is local to the speaker view.
 */

import { STORAGE_PREFIX } from './constants';

export const CHANNEL = 'ai-sdlc-immersion-deck';
const MSG_KEY = `${STORAGE_PREFIX}:msg`;
const STATE_KEY = `${STORAGE_PREFIX}:state`;

export type Role = 'deck' | 'speaker';

export type Command = 'next' | 'prev' | 'first' | 'last' | 'goto';

export type Msg =
  /** A window announces itself; the deck answers with its current state. */
  | { type: 'hello'; role: Role }
  /** The deck's position. `widget` is the active slide widget's JSON state, mirrored to previews. */
  | { type: 'state'; id: string; step: number; n: number; total: number; stepTotal: number; blackout: boolean; widget: unknown }
  /** A widget on the active slide changed. */
  | { type: 'widget'; id: string; state: unknown }
  /** The speaker view drives the deck. */
  | { type: 'cmd'; cmd: Command; id?: string; step?: number };

export type StateMsg = Extract<Msg, { type: 'state' }>;

interface Envelope {
  __sdlc: 1;
  from: string;
  seq: number;
  msg: Msg;
}

export interface Bus {
  readonly id: string;
  send(msg: Msg): void;
  on(fn: (msg: Msg) => void): () => void;
  /** Direct window handle for postMessage (an opener or a window we opened). */
  setPeer(win: Window | null): void;
  close(): void;
}

const isEnvelope = (x: unknown): x is Envelope =>
  typeof x === 'object' && x !== null && (x as Envelope).__sdlc === 1 && typeof (x as Envelope).from === 'string' && typeof (x as Envelope).msg === 'object';

export function createBus(): Bus {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let seq = 0;
  let peer: Window | null = null;
  const listeners = new Set<(m: Msg) => void>();
  const seen: string[] = [];
  const bc = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null;

  const deliver = (env: unknown) => {
    if (!isEnvelope(env) || env.from === id) return;
    const key = `${env.from}:${env.seq}`;
    if (seen.includes(key)) return;
    seen.push(key);
    if (seen.length > 200) seen.shift();
    for (const fn of listeners) fn(env.msg);
  };

  if (bc) bc.onmessage = (e: MessageEvent) => deliver(e.data);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== MSG_KEY || !e.newValue) return;
    try {
      deliver(JSON.parse(e.newValue));
    } catch {
      /* ignore a malformed write */
    }
  };
  const onMessage = (e: MessageEvent) => {
    if (!isEnvelope(e.data)) return;
    if (e.source && e.source !== window) peer = e.source as Window;
    deliver(e.data);
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener('message', onMessage);

  return {
    id,
    send(msg) {
      const env: Envelope = { __sdlc: 1, from: id, seq: ++seq, msg };
      if (peer && !peer.closed) {
        try {
          peer.postMessage(env, '*');
        } catch {
          /* peer navigated away */
        }
      }
      bc?.postMessage(env);
      try {
        localStorage.setItem(MSG_KEY, JSON.stringify(env));
        if (msg.type === 'state') localStorage.setItem(STATE_KEY, JSON.stringify(msg));
      } catch {
        /* storage unavailable or full: the other transports still carry it */
      }
    },
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    setPeer(win) {
      peer = win;
    },
    close() {
      bc?.close();
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('message', onMessage);
      listeners.clear();
    },
  };
}

/** The deck's last broadcast state, for a speaker window opened after the deck. */
export function readLastState(): StateMsg | null {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    const m = raw ? (JSON.parse(raw) as StateMsg) : null;
    return m && m.type === 'state' ? m : null;
  } catch {
    return null;
  }
}
