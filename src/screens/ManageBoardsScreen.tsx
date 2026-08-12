import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import { LogPane } from '../components/LogPane.js';
import { useProgressLog } from '../hooks/useProgressLog.js';
import type { Screen } from '../App.js';
import type { BoardConfig } from '../types/board.js';
import { BoardRegistryService } from '../services/project/BoardRegistryService.js';
import { DashboardUpdateService } from '../services/project/DashboardUpdateService.js';
import { PipelineProgress } from '../components/PipelineProgress.js';
import type { PipelinePhase } from '../services/project/pipelinePhases.js';
import { ScreenFrame } from '../components/ScreenFrame.js';
import { summariseFailures } from '../utils/summariseFailures.js';
import { parentOf } from '../config/navigation.js';

// Re-exported so the generated-UI cleanup helper keeps a stable import path.
export { removeDashboardFromGeneratedApp } from '../services/project/DashboardUpdateService.js';

interface Props {
  onNavigate: (s: Screen) => void;
  onBoardSelected: (board: BoardConfig) => void;
  onModifyAll: () => void;
}

type MenuItem =
  { label: string; value:
      | 'add' | 'back' | 'refresh' | 'cancel-remove'
      | 'modify-all' | 'regen-all' | 'remove-all' | 'confirm-remove-all' | 'cancel-remove-all'
      | `open:${string}` | `remove:${string}` | `confirm-remove:${string}` };

/**
 * What the highlighted row does. Destructive rows say so here rather than in a
 * standing warning below the list — "Removing a dashboard deletes its tab and
 * data" used to sit on screen permanently, including when nothing was selected.
 */
function detailFor(value: string): string {
  if (value.startsWith('remove:')) return 'Deletes this dashboard, its tab and its data from your app.';
  if (value.startsWith('open:')) return 'Open this dashboard in chat to change it.';
  if (value.startsWith('confirm-remove:')) return 'This cannot be undone.';
  return {
    add: 'Pick a data file and describe the dashboard you want.',
    'modify-all': 'One prompt applied to every dashboard, deployed once.',
    'regen-all': 'Rebuild every dashboard from its saved prompts and latest data.',
    'remove-all': 'Deletes every dashboard and resets the app to an empty starter.',
    'confirm-remove-all': 'This cannot be undone.',
    'cancel-remove': 'Keep this dashboard.',
    'cancel-remove-all': 'Keep all dashboards.',
    refresh: 'Re-read the dashboard registry.',
    back: 'Return to the main menu.',
  }[value] ?? '';
}

export function ManageBoardsScreen({ onNavigate, onBoardSelected, onModifyAll }: Props) {
  const [highlighted, setHighlighted] = useState('add');
  const registry = useMemo(() => new BoardRegistryService(), []);
  const [boards, setBoards] = useState<BoardConfig[]>(() => registry.listBoards());
  // Progress and outcomes both append here: one feedback surface, below the
  // menu, instead of a single line above it that each new line overwrote.
  const log = useProgressLog();
  const [isProcessing, setIsProcessing] = useState(false);
  const [pipeline, setPipeline] = useState<{ phase: PipelinePhase; pct: number; phaseStartedAt: number } | null>(null);
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);
  const [pendingRemoveAll, setPendingRemoveAll] = useState(false);

  // PgUp/PgDn scroll the log. ink-select-input binds only the arrow keys, so
  // menu navigation is untouched.
  useInput((_input, key) => {
    // Esc had no handler here at all: this was the one screen where the only
    // way back was to find the '← Go Back' row, while every other screen in
    // the app takes Esc. Held during a removal or deploy, which cannot be
    // abandoned halfway.
    if (key.escape && !isProcessing) {
      onNavigate(parentOf('manage-boards'));
      return;
    }
    log.onKey(key);
  });

  const items: MenuItem[] = [
    { label: '✚ Add new dashboard', value: 'add' },
    ...(pendingRemoveAll
      ? [
          { label: `! Confirm: remove ALL ${boards.length} dashboard(s)`, value: 'confirm-remove-all' } as MenuItem,
          { label: 'Cancel remove-all', value: 'cancel-remove-all' } as MenuItem,
        ]
      : []),
    ...(pendingRemoveId
      ? [
          { label: 'Confirm dashboard removal', value: `confirm-remove:${pendingRemoveId}` } as MenuItem,
          { label: 'Cancel removal', value: 'cancel-remove' } as MenuItem,
        ]
      : []),
    ...(boards.length > 0 && !pendingRemoveAll && !pendingRemoveId
      ? [
          { label: '✎ Modify all dashboards (open chat)', value: 'modify-all' } as MenuItem,
          { label: '↻ Regenerate all dashboards (from saved prompts)', value: 'regen-all' } as MenuItem,
          { label: '✕ Remove all dashboards', value: 'remove-all' } as MenuItem,
        ]
      : []),
    ...boards.flatMap((board): MenuItem[] => [
      {
        label: `✎ Modify: ${board.title} (${board.type})`,
        value: `open:${board.id}`,
      },
      {
        label: `✕ Remove: ${board.title}`,
        value: `remove:${board.id}`,
      },
    ]),
    { label: 'Refresh list', value: 'refresh' },
    { label: '← Go Back', value: 'back' },
  ];

  // Shared pipeline-progress event sink for bulk operations.
  const makeBulkService = () =>
    new DashboardUpdateService(undefined, undefined, undefined, undefined, (event) => {
      if (event.event === 'result' || event.phase === 'done') {
        setPipeline(null);
        return;
      }
      if (event.event === 'phase' && event.phase) {
        setPipeline({ phase: event.phase, pct: event.pct ?? 0, phaseStartedAt: Date.now() });
      } else if (event.event === 'log' && event.phase && event.pct !== undefined) {
        setPipeline((prev) => (prev && prev.phase === event.phase ? { ...prev, pct: event.pct! } : prev));
      }
    });

  const handleSelect = async (item: MenuItem) => {
    if (isProcessing) return;

    if (item.value === 'add') {
      onNavigate('create-board');
      return;
    }
    if (item.value === 'back') {
      onNavigate(parentOf('manage-boards'));
      return;
    }
    if (item.value === 'refresh') {
      setBoards(registry.listBoards());
      log.append('Dashboard list refreshed.');
      return;
    }
    if (item.value === 'cancel-remove') {
      setPendingRemoveId(null);
      log.append('Dashboard removal cancelled.');
      return;
    }
    if (item.value === 'cancel-remove-all') {
      setPendingRemoveAll(false);
      log.append('Remove-all cancelled.');
      return;
    }
    if (item.value === 'modify-all') {
      onModifyAll();
      return;
    }
    if (item.value === 'remove-all') {
      setPendingRemoveAll(true);
      log.append(`Confirm removal of ALL ${boards.length} dashboard(s). This cannot be undone — your app will be reset to an empty starter app.`);
      return;
    }
    if (item.value === 'regen-all') {
      setIsProcessing(true);
      log.append('Regenerating all dashboards from saved prompt history...');
      try {
        const service = makeBulkService();
        const results = await service.updateAll((line) => log.append(line));
        setBoards(registry.listBoards());
        const failed = results.filter((r) => !r.success);
        log.append(
          failed.length === 0
            ? `Regenerated ${results.length} dashboard(s) and redeployed.`
            : `Regenerated with ${failed.length} failure(s): ${summariseFailures(failed.map((f) => f.error))}`,
        );
      } catch (error: unknown) {
        log.append(`Regenerate-all failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setPipeline(null);
        setIsProcessing(false);
      }
      return;
    }
    if (item.value === 'confirm-remove-all') {
      setIsProcessing(true);
      setPendingRemoveAll(false);
      log.append('Removing all dashboards and resetting the app...');
      try {
        const service = makeBulkService();
        const result = await service.removeAllDashboards((line) => log.append(line));
        setBoards(registry.listBoards());
        if (result.success) {
          log.append(
            result.deployUrl
              ? `Removed all dashboards. Deployed empty shell: ${result.deployUrl}`
              : 'Removed all dashboards. Your app is now an empty starter app.',
          );
        } else {
          log.append(`Could not remove all dashboards: ${result.error ?? 'Unknown error'}`);
        }
      } catch (error: unknown) {
        log.append(`Remove-all failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setPipeline(null);
        setIsProcessing(false);
      }
      return;
    }
    if (item.value.startsWith('open:')) {
      const board = boards.find((b) => b.id === item.value.slice('open:'.length));
      if (board) onBoardSelected(board);
      return;
    }
    if (item.value.startsWith('remove:')) {
      const boardId = item.value.slice('remove:'.length);
      const board = boards.find((b) => b.id === boardId);
      if (!board) {
        log.append('Dashboard was not found.');
        return;
      }
      setPendingRemoveId(boardId);
      log.append(`Confirm removal for "${board.title}". Cleanup will run before OpenBoardCLI removes it from the registry.`);
      return;
    }

    if (item.value.startsWith('confirm-remove:')) {
      const boardId = item.value.slice('confirm-remove:'.length);
      const board = boards.find((b) => b.id === boardId);
      if (!board) {
        setPendingRemoveId(null);
        log.append('Dashboard was not found.');
        return;
      }

      setIsProcessing(true);
      log.append(`Removing "${board.title}" and updating the deployed app...`);
      try {
        const service = new DashboardUpdateService(undefined, undefined, undefined, undefined, (event) => {
          if (event.event === 'result' || event.phase === 'done') {
            setPipeline(null);
            return;
          }
          if (event.event === 'phase' && event.phase) {
            setPipeline({ phase: event.phase, pct: event.pct ?? 0, phaseStartedAt: Date.now() });
          } else if (event.event === 'log' && event.phase && event.pct !== undefined) {
            setPipeline((prev) => (prev && prev.phase === event.phase ? { ...prev, pct: event.pct! } : prev));
          }
        });
        const result = await service.removeDashboard(board, (line) => log.append(line));
        setBoards(registry.listBoards());
        setPendingRemoveId(null);
        if (result.success) {
          log.append(
            result.deployUrl
              ? `Removed "${board.title}". Deployed: ${result.deployUrl}`
              : `Removed "${board.title}". Generated app updated.`,
          );
        } else {
          log.append(`Could not fully remove "${board.title}": ${result.error ?? 'Unknown error'}`);
        }
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        log.append(`Could not remove "${board.title}": ${msg}`);
      } finally {
        setPipeline(null);
        setIsProcessing(false);
      }
    }
  };

  return (
    <ScreenFrame
      title="Dashboards"
      meta={[boards.length === 0 ? 'none yet' : `${boards.length} registered`]}
      detail={detailFor(highlighted)}
      hints={['move', 'select', 'scroll', 'back']}
    >
      {isProcessing && (
        <Box marginBottom={1}>
          {pipeline ? (
            <PipelineProgress phase={pipeline.phase} pct={pipeline.pct} phaseStartedAt={pipeline.phaseStartedAt} />
          ) : (
            <Text color="yellow">Processing generated UI cleanup...</Text>
          )}
        </Box>
      )}
      <SelectInput
        items={items}
        onSelect={handleSelect}
        onHighlight={(item) => setHighlighted(item.value)}
      />

      {/* Progress belongs below every option, never above them. */}
      <LogPane view={log.view} />
    </ScreenFrame>
  );
}

export default ManageBoardsScreen;
