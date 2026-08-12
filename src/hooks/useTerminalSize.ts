/**
 * useTerminalSize — terminal dimensions that stay current.
 *
 * Ink's useStdout hands back the stream, not a subscription, so a component
 * that reads `stdout.columns` during render gets the size as it was when that
 * render happened to run. Resizing the window emits 'resize' on the stream but
 * causes no re-render, so the layout kept whatever width it was born with:
 * widening the terminal left the chat wrapped to the old narrow column, and
 * narrowing it pushed the frame off the right edge until an unrelated
 * keystroke happened to redraw.
 *
 * The fallbacks are the conventional 80x24, used when stdout is not a TTY —
 * under test, or piped.
 */
import { useEffect, useState } from 'react';
import { useStdout } from 'ink';

export interface TerminalSize {
  columns: number;
  rows: number;
}

export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState<TerminalSize>(() => ({
    columns: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  }));

  useEffect(() => {
    // ink-testing-library supplies a write-only stdout stand-in with no
    // emitter methods, and a non-TTY stdout has no resize event to give. In
    // both cases the initial read above is the whole answer.
    if (typeof stdout?.on !== 'function' || typeof stdout.off !== 'function') return;

    const sync = () => {
      setSize((previous) => {
        const columns = stdout.columns ?? 80;
        const rows = stdout.rows ?? 24;
        // Same object identity when nothing moved: 'resize' can fire more than
        // once for a single drag, and a new object each time would re-run every
        // memo keyed on the size.
        return previous.columns === columns && previous.rows === rows
          ? previous
          : { columns, rows };
      });
    };

    sync();
    stdout.on('resize', sync);
    return () => {
      stdout.off('resize', sync);
    };
  }, [stdout]);

  return size;
}

export default useTerminalSize;
