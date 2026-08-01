/**
 * useProgressLog — append-only progress log with a scrollable viewport.
 *
 * Screens that run long operations (dashboard removal, invoice fetches) get a
 * stable `append` to hand straight to any onProgress callback, and a resolved
 * viewport to hand to LogPane. Both screens needed identical state, so it lives
 * here rather than being copied into each.
 */
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { useStdout } from 'ink';
import type { Key } from 'ink';
import { MAX_VIEW_LINES, clampOffset, pageStep } from '../utils/chatViewport.js';
import { LOG_PANE_HEIGHT, logViewport, type LogViewport } from '../utils/logViewport.js';

/**
 * Terminal columns the pane cannot use: the screen's own padding (4), the
 * pane border (2), its horizontal padding (2), and the scrollbar gutter (2).
 */
const PANE_CHROME_COLS = 10;

/** Stable identity: a fresh [] each call would loop useSyncExternalStore. */
const EMPTY_LINES: string[] = [];

/**
 * An append-only line store living outside React.
 *
 * Needed when the writer is not the screen: scheduled invoice fetches run with
 * no screen mounted, so their output cannot live in a component's state.
 */
export interface ProgressLogStore {
  getLines: () => string[];
  append: (line: string) => void;
  subscribe: (listener: () => void) => () => void;
}

export interface ProgressLogOptions {
  height?: number;
  /** Bind to a shared store instead of local state. */
  store?: ProgressLogStore;
}

export interface ProgressLog {
  /** Raw appended entries, newest last. Empty until the first line arrives. */
  entries: string[];
  /** Resolved rows + scrollbar for the current width, height and offset. */
  view: LogViewport;
  /** Pass directly as an onProgress callback — identity is stable. */
  append: (line: string) => void;
  clear: () => void;
  /** Feed from a screen's useInput; handles PgUp/PgDn, ignores everything else. */
  onKey: (key: Key) => void;
}

export function useProgressLog(options: ProgressLogOptions | number = {}): ProgressLog {
  // Numeric form kept for the screens that only need a local log.
  const { height = LOG_PANE_HEIGHT, store } = typeof options === 'number' ? { height: options } as ProgressLogOptions : options;

  const [localEntries, setLocalEntries] = useState<string[]>([]);
  const [offset, setOffset] = useState(0);
  const { stdout } = useStdout();
  const width = Math.max(20, (stdout?.columns ?? 80) - PANE_CHROME_COLS);

  // A shared store may be written while this screen is unmounted, so the pane
  // subscribes rather than owning the lines.
  const noopSubscribe = useCallback(() => () => {}, []);
  const storedEntries = useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    store?.getLines ?? (() => EMPTY_LINES),
    store?.getLines ?? (() => EMPTY_LINES),
  );
  const entries = store ? storedEntries : localEntries;

  const view = useMemo(
    () => logViewport(entries, width, height, offset),
    [entries, width, height, offset],
  );

  const append = useCallback((line: string) => {
    if (store) {
      store.append(line);
    } else {
      setLocalEntries((previous) => {
        // Bound retained history the same way the chat log does; the viewport
        // caps wrapped lines, this caps entries so the array cannot grow forever.
        const next = [...previous, line];
        return next.length > MAX_VIEW_LINES ? next.slice(-MAX_VIEW_LINES) : next;
      });
    }
    // Snap back to the newest line. A user who scrolled up mid-run still wants
    // to see the operation's latest output rather than a frozen window.
    setOffset(0);
  }, [store]);

  const clear = useCallback(() => {
    if (!store) setLocalEntries([]);
    setOffset(0);
  }, [store]);

  const onKey = useCallback((key: Key) => {
    if (key.pageUp) {
      setOffset((current) => clampOffset(current + pageStep(height), view.totalLines, height));
    }
    if (key.pageDown) {
      setOffset((current) => clampOffset(current - pageStep(height), view.totalLines, height));
    }
  }, [height, view.totalLines]);

  return { entries, view, append, clear, onKey };
}

export default useProgressLog;
