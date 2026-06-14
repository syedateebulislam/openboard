import React, { useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import type { Screen } from '../App.js';
import type { BoardConfig } from '../types/board.js';
import { BoardRegistryService } from '../services/project/BoardRegistryService.js';
import { DashboardUpdateService } from '../services/project/DashboardUpdateService.js';
import { PipelineProgress } from '../components/PipelineProgress.js';
import type { PipelinePhase } from '../services/project/pipelinePhases.js';
import { UI_COLORS } from '../theme.js';

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

export function ManageBoardsScreen({ onNavigate, onBoardSelected, onModifyAll }: Props) {
  const registry = useMemo(() => new BoardRegistryService(), []);
  const [boards, setBoards] = useState<BoardConfig[]>(() => registry.listBoards());
  const [message, setMessage] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [pipeline, setPipeline] = useState<{ phase: PipelinePhase; pct: number; phaseStartedAt: number } | null>(null);
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);
  const [pendingRemoveAll, setPendingRemoveAll] = useState(false);

  const items: MenuItem[] = [
    { label: '+ Add new dashboard to UI', value: 'add' },
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
        label: `Open: ${board.title} (${board.type})`,
        value: `open:${board.id}`,
      },
      {
        label: `Remove: ${board.title}`,
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
      onNavigate('welcome');
      return;
    }
    if (item.value === 'refresh') {
      setBoards(registry.listBoards());
      setMessage('Dashboard list refreshed.');
      return;
    }
    if (item.value === 'cancel-remove') {
      setPendingRemoveId(null);
      setMessage('Dashboard removal cancelled.');
      return;
    }
    if (item.value === 'cancel-remove-all') {
      setPendingRemoveAll(false);
      setMessage('Remove-all cancelled.');
      return;
    }
    if (item.value === 'modify-all') {
      onModifyAll();
      return;
    }
    if (item.value === 'remove-all') {
      setPendingRemoveAll(true);
      setMessage(`Confirm removal of ALL ${boards.length} dashboard(s). The app will be reset to the empty OpenBoard shell and redeployed.`);
      return;
    }
    if (item.value === 'regen-all') {
      setIsProcessing(true);
      setMessage('Regenerating all dashboards from saved prompt history...');
      try {
        const service = makeBulkService();
        const results = await service.updateAll((line) => setMessage(line));
        setBoards(registry.listBoards());
        const failed = results.filter((r) => !r.success);
        setMessage(
          failed.length === 0
            ? `Regenerated ${results.length} dashboard(s) and redeployed.`
            : `Regenerated with ${failed.length} failure(s): ${failed.map((f) => f.error).join('; ')}`,
        );
      } catch (error: unknown) {
        setMessage(`Regenerate-all failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setPipeline(null);
        setIsProcessing(false);
      }
      return;
    }
    if (item.value === 'confirm-remove-all') {
      setIsProcessing(true);
      setPendingRemoveAll(false);
      setMessage('Removing all dashboards and resetting the app...');
      try {
        const service = makeBulkService();
        const result = await service.removeAllDashboards((line) => setMessage(line));
        setBoards(registry.listBoards());
        if (result.success) {
          setMessage(
            result.deployUrl
              ? `Removed all dashboards. Deployed empty shell: ${result.deployUrl}`
              : 'Removed all dashboards. The app now shows the empty OpenBoard shell.',
          );
        } else {
          setMessage(`Could not remove all dashboards: ${result.error ?? 'Unknown error'}`);
        }
      } catch (error: unknown) {
        setMessage(`Remove-all failed: ${error instanceof Error ? error.message : String(error)}`);
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
        setMessage('Dashboard was not found.');
        return;
      }
      setPendingRemoveId(boardId);
      setMessage(`Confirm removal for "${board.title}". Cleanup will run before OpenBoard removes it from the registry.`);
      return;
    }

    if (item.value.startsWith('confirm-remove:')) {
      const boardId = item.value.slice('confirm-remove:'.length);
      const board = boards.find((b) => b.id === boardId);
      if (!board) {
        setPendingRemoveId(null);
        setMessage('Dashboard was not found.');
        return;
      }

      setIsProcessing(true);
      setMessage(`Removing "${board.title}" and updating the deployed app...`);
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
        const result = await service.removeDashboard(board, (line) => setMessage(line));
        setBoards(registry.listBoards());
        setPendingRemoveId(null);
        if (result.success) {
          setMessage(
            result.deployUrl
              ? `Removed "${board.title}". Deployed: ${result.deployUrl}`
              : `Removed "${board.title}". Generated app updated.`,
          );
        } else {
          setMessage(`Could not fully remove "${board.title}": ${result.error ?? 'Unknown error'}`);
        }
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        setMessage(`Could not remove "${board.title}": ${msg}`);
      } finally {
        setPipeline(null);
        setIsProcessing(false);
      }
    }
  };

  return (
    <Box flexDirection="column" padding={2}>
      <Text bold color={UI_COLORS.logo}>Existing Dashboards</Text>
      <Text color={UI_COLORS.subtitle}>
        Add data sources to the master UI, or open an existing dashboard chat.
      </Text>
      {boards.length === 0 && (
        <Box marginTop={1}>
          <Text color="yellow">No dashboards registered yet.</Text>
        </Box>
      )}
      {message && (
        <Box marginTop={1}>
          <Text color="green">{message}</Text>
        </Box>
      )}
      {isProcessing && (
        <Box marginTop={1}>
          {pipeline ? (
            <PipelineProgress phase={pipeline.phase} pct={pipeline.pct} phaseStartedAt={pipeline.phaseStartedAt} />
          ) : (
            <Text color="yellow">Processing generated UI cleanup...</Text>
          )}
        </Box>
      )}
      <Box marginTop={1}>
        <SelectInput items={items} onSelect={handleSelect} />
      </Box>
      <Box marginTop={1}>
        <Text color={UI_COLORS.subtitle}>
          Removing a dashboard updates the registry and asks the configured LLM to remove its tab from the generated app.
        </Text>
      </Box>
    </Box>
  );
}

export default ManageBoardsScreen;
