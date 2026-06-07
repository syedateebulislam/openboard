import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import SelectInput from 'ink-select-input';
import type { Screen } from '../App.js';
import { BOARD_PRESETS, createBoardConfig, type BoardPreset } from '../config/boardPresets.js';
import { DataParserService, type ParsedData } from '../services/data/DataParserService.js';
import { DataAnalyzer, type DataAnalysis } from '../services/data/DataAnalyzer.js';
import { ConfigService } from '../services/config/ConfigService.js';
import { UI_COLORS } from '../theme.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CreationStep =
  | 'select-preset'    // 1 — choose domain preset
  | 'enter-file'       // 2 — enter data file path
  | 'enter-name'       // 3 — name the board
  | 'analyzing'        // 4 — parsing + analyzing data
  | 'show-summary'     // 5 — show analysis, confirm
  | 'error';           // error state

interface Props {
  onNavigate: (s: Screen) => void;
  onBoardCreated?: (board: import('../types/board.js').BoardConfig) => void;
}

interface SelectItem {
  label: string;
  value: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeFilePath(input: string): string {
  return input
    .trim()
    .replace(/^[-*]\s+/, '')
    .replace(/^["']|["']$/g, '')
    .trim();
}

function presetItems(): SelectItem[] {
  const items = BOARD_PRESETS.map(p => ({
    label: `${p.icon}  ${p.name} — ${p.description}`,
    value: p.id,
  }));
  // Add "Go Back" option at the end
  items.push({ label: '← Go Back', value: 'back' });
  return items;
}

export function hasConfiguredLLM(config = new ConfigService()): boolean {
  const provider = config.get('llm.provider') as string | undefined;
  if (!provider) return false;
  if (provider === 'ollama' || provider === 'openai-codex') return true;
  return Boolean(config.getSecret('llm.apiKey'));
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BoardCreationScreen({ onNavigate, onBoardCreated }: Props) {
  // Step state
  const [step, setStep] = useState<CreationStep>('select-preset');

  // User selections
  const [selectedPreset, setSelectedPreset] = useState<BoardPreset | null>(null);
  const [filePath, setFilePath] = useState('');
  const [boardName, setBoardName] = useState('');

  // Analysis results
  const [parsedData, setParsedData] = useState<ParsedData | null>(null);
  const [analysis, setAnalysis] = useState<DataAnalysis | null>(null);
  const [analysisSummary, setAnalysisSummary] = useState('');

  // Error
  const [errorMessage, setErrorMessage] = useState('');

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  const handlePresetSelect = useCallback((item: SelectItem) => {
    // Handle "Go Back" option
    if (item.value === 'back') {
      onNavigate('welcome');
      return;
    }
    
    const preset = BOARD_PRESETS.find(p => p.id === item.value);
    if (preset) {
      setSelectedPreset(preset);
      setStep('enter-file');
    }
  }, [onNavigate]);

  const handleFileSubmit = useCallback((value: string) => {
    const trimmed = normalizeFilePath(value);
    if (!trimmed) return;
    setFilePath(trimmed);
    setStep('enter-name');
  }, []);

  const handleNameSubmit = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return;

      try {
        createBoardConfig(trimmed); // validates name
      } catch (e) {
        setErrorMessage(e instanceof Error ? e.message : String(e));
        setStep('error');
        return;
      }

      setBoardName(trimmed);
      setStep('analyzing');

      // Parse + analyze data asynchronously
      try {
        const parsed = await DataParserService.parse(filePath);
        const dataAnalysis = DataAnalyzer.analyze(parsed);
        const summary = DataAnalyzer.generateSummary(dataAnalysis);

        setParsedData(parsed);
        setAnalysis(dataAnalysis);
        setAnalysisSummary(summary);
        setStep('show-summary');
      } catch (e) {
        setErrorMessage(e instanceof Error ? e.message : String(e));
        setStep('error');
      }
    },
    [filePath],
  );

  // Keyboard: ESC goes back, Enter confirms on show-summary
  useInput((input, key) => {
    if (key.escape) {
      if (step === 'enter-file') setStep('select-preset');
      else if (step === 'enter-name') setStep('enter-file');
      else if (step === 'show-summary') setStep('enter-name');
      else if (step === 'error') setStep('select-preset');
    }
    if (key.return && step === 'show-summary' && selectedPreset) {
      if (!hasConfiguredLLM()) {
        setErrorMessage('No LLM provider is configured. Open Settings, configure an LLM provider, then create this dashboard again.');
        setStep('error');
        return;
      }

      // Create board config and pass to parent
      const boardConfig: import('../types/board.js').BoardConfig = {
        id: `board-${Date.now()}`,
        name: boardName.toLowerCase().replace(/\s+/g, '-'),
        title: boardName,
        type: selectedPreset.id as 'health' | 'finance' | 'grocery' | 'custom',
        outputDir: '',
        dataFiles: [filePath],
        components: [],
        createdAt: new Date().toISOString(),
        dataSummary: analysis ? DataAnalyzer.generateSummary(analysis) : undefined,
      };
      
      if (onBoardCreated) {
        onBoardCreated(boardConfig);
      } else {
        onNavigate('chat');
      }
    }
  });

  // -------------------------------------------------------------------------
  // Render helpers
  // -------------------------------------------------------------------------

  const renderHeader = () => (
    <Box marginBottom={1} flexDirection="column">
      <Text bold color={UI_COLORS.border}>
        ╔══════════════════════════════════════╗
      </Text>
      <Text bold color={UI_COLORS.logo}>
        ║        Create New Board              ║
      </Text>
      <Text bold color={UI_COLORS.border}>
        ╚══════════════════════════════════════╝
      </Text>
    </Box>
  );

  const renderStepIndicator = () => {
    const steps = ['Preset', 'File', 'Name', 'Analyze', 'Confirm'];
    const stepIndex = {
      'select-preset': 0,
      'enter-file': 1,
      'enter-name': 2,
      analyzing: 3,
      'show-summary': 4,
      error: 4,
    }[step];

    return (
      <Box marginBottom={1}>
        {steps.map((s, i) => (
          <Box key={s} marginRight={1}>
            <Text color={i === stepIndex ? UI_COLORS.logo : UI_COLORS.subtitle}>
              {i < stepIndex ? '✓' : i === stepIndex ? '●' : '○'} {s}
            </Text>
            {i < steps.length - 1 && <Text color={UI_COLORS.border}> → </Text>}
          </Box>
        ))}
      </Box>
    );
  };

  // -------------------------------------------------------------------------
  // Step renders
  // -------------------------------------------------------------------------

  if (step === 'select-preset') {
    return (
      <Box flexDirection="column" padding={2}>
        {renderHeader()}
        {renderStepIndicator()}
        <Text bold color={UI_COLORS.logo}>
          Step 1/4: Select a board preset
        </Text>
        <Box marginTop={1}>
          <SelectInput items={presetItems()} onSelect={handlePresetSelect} />
        </Box>
        <Box marginTop={1}>
          <Text color={UI_COLORS.subtitle}>
            Use ↑/↓ to navigate, Enter to select
          </Text>
        </Box>
      </Box>
    );
  }

  if (step === 'enter-file') {
    return (
      <Box flexDirection="column" padding={2}>
        {renderHeader()}
        {renderStepIndicator()}
        <Text bold color={UI_COLORS.logo}>
          Step 2/4: Data file path
        </Text>
        <Box marginTop={1}>
          <Text color={UI_COLORS.logo}>Preset: </Text>
          <Text>
            {selectedPreset?.icon} {selectedPreset?.name}
          </Text>
        </Box>
        {selectedPreset && selectedPreset.dataHints.length > 0 && (
          <Box marginTop={1} flexDirection="column">
            <Text color={UI_COLORS.subtitle}>
              Expected columns: {selectedPreset.dataHints.join(', ')}
            </Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text color={UI_COLORS.logo}>{'File path › '}</Text>
          <TextInput
            value={filePath}
            onChange={setFilePath}
            onSubmit={handleFileSubmit}
            placeholder="/path/to/data.csv or data.json"
          />
        </Box>
        <Box marginTop={1}>
          <Text color={UI_COLORS.subtitle}>
            Supports .csv and .json files · ESC to go back
          </Text>
        </Box>
      </Box>
    );
  }

  if (step === 'enter-name') {
    return (
      <Box flexDirection="column" padding={2}>
        {renderHeader()}
        {renderStepIndicator()}
        <Text bold color={UI_COLORS.logo}>
          Step 3/4: Name your board
        </Text>
        <Box marginTop={1}>
          <Text color={UI_COLORS.logo}>File: </Text>
          <Text>{filePath}</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={UI_COLORS.logo}>{'Board name › '}</Text>
          <TextInput
            value={boardName}
            onChange={setBoardName}
            onSubmit={handleNameSubmit}
            placeholder="e.g. My Finance Dashboard"
          />
        </Box>
        <Box marginTop={1}>
          <Text color={UI_COLORS.subtitle}>
            Will be used as the dashboard title · ESC to go back
          </Text>
        </Box>
      </Box>
    );
  }

  if (step === 'analyzing') {
    return (
      <Box flexDirection="column" padding={2}>
        {renderHeader()}
        {renderStepIndicator()}
        <Box marginTop={1}>
          <Text color="yellow">⏳ Analyzing data file…</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={UI_COLORS.subtitle}>
            Parsing {filePath}
          </Text>
        </Box>
      </Box>
    );
  }

  if (step === 'show-summary') {
    const cfg = createBoardConfig(boardName);
    return (
      <Box flexDirection="column" padding={2}>
        {renderHeader()}
        {renderStepIndicator()}
        <Text bold color="green">
          ✅ Data Analysis Complete
        </Text>

        <Box marginTop={1} flexDirection="column">
          <Text bold color={UI_COLORS.logo}>
            Board Config
          </Text>
          <Text>
            {'  '}Name: <Text color="white">{cfg.name}</Text>
          </Text>
          <Text>
            {'  '}Title: <Text color="white">{cfg.title}</Text>
          </Text>
          <Text>
            {'  '}Preset:{' '}
            <Text color="white">
              {selectedPreset?.icon} {selectedPreset?.name}
            </Text>
          </Text>
        </Box>

        {analysis && (
          <Box marginTop={1} flexDirection="column">
            <Text bold color={UI_COLORS.logo}>
              Dataset Summary
            </Text>
            <Text>
              {'  '}Rows: <Text color="white">{analysis.rowCount}</Text>
            </Text>
            <Text>
              {'  '}Columns: <Text color="white">{analysis.columnCount}</Text>
            </Text>
            <Box marginTop={1} flexDirection="column">
              {analysis.columns.map(col => (
                <Text key={col.name} color={UI_COLORS.subtitle}>
                  {'  '}
                  <Text color={UI_COLORS.logo}>{col.name}</Text>
                  {' '}({col.type})
                  {col.stats
                    ? ` | min: ${col.stats.min?.toFixed(1)}, max: ${col.stats.max?.toFixed(1)}`
                    : ''}
                  {col.dateRange
                    ? ` | ${col.dateRange.earliest} → ${col.dateRange.latest}`
                    : ''}
                  {col.isCategorical && col.uniqueValues
                    ? ` | [${col.uniqueValues.slice(0, 3).join(', ')}${col.uniqueValues.length > 3 ? '…' : ''}]`
                    : ''}
                </Text>
              ))}
            </Box>
          </Box>
        )}

        <Box marginTop={2} flexDirection="column">
          <Text bold color="green">
            Press Enter to continue to Chat → generate dashboard
          </Text>
          <Text color={UI_COLORS.subtitle}>
            ESC to go back and change name
          </Text>
        </Box>
      </Box>
    );
  }

  if (step === 'error') {
    return (
      <Box flexDirection="column" padding={2}>
        {renderHeader()}
        <Box marginTop={1} flexDirection="column">
          <Text bold color="red">
            ❌ Error
          </Text>
          <Text color="red">{errorMessage}</Text>
        </Box>
        <Box marginTop={2}>
          <Text color={UI_COLORS.subtitle}>
            Press ESC to go back and try again
          </Text>
        </Box>
      </Box>
    );
  }

  // Fallback (should never reach)
  return null;
}
