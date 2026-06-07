import React, { useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import type { Screen } from '../App.js';
import type { BoardConfig } from '../types/board.js';
import { BoardRegistryService } from '../services/project/BoardRegistryService.js';
import { DashboardUpdateService } from '../services/project/DashboardUpdateService.js';
import { UI_COLORS } from '../theme.js';

// Re-exported so the generated-UI cleanup helper keeps a stable import path.
export { removeDashboardFromGeneratedApp } from '../services/project/DashboardUpdateService.js';

interface Props {
  onNavigate: (s: Screen) => void;
  onBoardSelected: (board: BoardConfig) => void;
}

type MenuItem =
  { label: string; value: 'add' | 'back' | 'refresh' | 'cancel-remove' | `open:${string}` | `remove:${string}` | `confirm-remove:${string}` };

export function ManageBoardsScreen({ onNavigate, onBoardSelected }: Props) {
  const registry = useMemo(() => new BoardRegistryService(), []);
  const [boards, setBoards] = useState<BoardConfig[]>(() => registry.listBoards());
  const [message, setMessage] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);

  const items: MenuItem[] = [
    { label: '+ Add new dashboard to UI', value: 'add' },
    ...(pendingRemoveId
      ? [
          { label: 'Confirm dashboard removal', value: `confirm-remove:${pendingRemoveId}` } as MenuItem,
          { label: 'Cancel removal', value: 'cancel-remove' } as MenuItem,
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
        const result = await new DashboardUpdateService().removeDashboard(board, (line) => setMessage(line));
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
          <Text color="yellow">Processing generated UI cleanup...</Text>
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
