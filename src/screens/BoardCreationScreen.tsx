import React, { useState, useCallback, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import SelectInput from 'ink-select-input';
import type { Screen } from '../App.js';
import type { BoardConfig } from '../types/board.js';
import { BOARD_PRESETS, createBoardConfig, type BoardPreset } from '../config/boardPresets.js';
import { DataParserService } from '../services/data/DataParserService.js';
import { DataAnalyzer, type DataAnalysis } from '../services/data/DataAnalyzer.js';
import { ConfigService } from '../services/config/ConfigService.js';
import { normalizeUserPath } from '../utils/pathNormalizer.js';
import { parentOf } from '../config/navigation.js';
import { UI_COLORS } from '../theme.js';
import { HintBar } from '../components/HintBar.js';
import { Spinner } from '../components/Spinner.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CreationStep =
  | 'select-preset'    // 1 — choose domain preset
  | 'select-quality'   // 2 — choose UI complexity (high/low)
  | 'enter-file'       // 3 — enter data file path
  | 'enter-name'       // 4 — name the board
  | 'analyzing'        // 5 — parsing + analyzing data
  | 'show-summary'     // 6 — show analysis, confirm
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
  // Strip a pasted markdown bullet prefix, then let the shared normalizer
  // handle whitespace/quote stripping (e.g. Windows "Copy as path").
  return normalizeUserPath(input.trim().replace(/^[-*]\s+/, ''));
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
  if (provider === 'ollama' || provider === 'lmstudio' || provider === 'openai-codex') return true;
  return Boolean(config.getSecret('llm.apiKey'));
}

function isLocalLLMProvider(config = new ConfigService()): boolean {
  const provider = config.get('llm.provider') as string | undefined;
  return provider === 'ollama' || provider === 'lmstudio';
}

const QUALITY_ITEMS: Array<{ label: string; value: BoardConfig['uiQuality'] }> = [
  { label: 'High quality — full-featured (default)', value: 'high' },
  { label: 'Low quality — lightweight, recommended for local/small models', value: 'low' },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BoardCreationScreen({ onNavigate, onBoardCreated }: Props) {
  // Step state
  const [step, setStep] = useState<CreationStep>('select-preset');

  // User selections
  const [selectedPreset, setSelectedPreset] = useState<BoardPreset | null>(null);
  const [uiQuality, setUiQuality] = useState<BoardConfig['uiQuality']>('high');
  const [filePath, setFilePath] = useState('');
  const [boardName, setBoardName] = useState('');

  // Analysis results
  const [analysis, setAnalysis] = useState<DataAnalysis | null>(null);

  // Seconds spent in the 'analyzing' step, so the wait is visibly progressing.
  const [analyzeElapsed, setAnalyzeElapsed] = useState(0);

  useEffect(() => {
    if (step !== 'analyzing') return;
    setAnalyzeElapsed(0);
    const startedAt = Date.now();
    const timer = setInterval(() => {
      setAnalyzeElapsed(Math.round((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [step]);

  // Error, plus the step ESC should return to so typed input is not lost.
  const [errorMessage, setErrorMessage] = useState('');
  const [errorReturnStep, setErrorReturnStep] = useState<CreationStep>('select-preset');

  // Checked once at entry so users learn about missing setup before doing work.
  const [llmReady] = useState(() => hasConfiguredLLM());
  const [localLLM] = useState(() => isLocalLLMProvider());

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
      setStep('select-quality');
    }
  }, [onNavigate]);

  const handleQualitySelect = useCallback((item: { value: BoardConfig['uiQuality'] }) => {
    setUiQuality(item.value ?? 'high');
    setStep('enter-file');
  }, []);

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
        setErrorReturnStep('enter-name');
        setStep('error');
        return;
      }

      setBoardName(trimmed);
      setStep('analyzing');

      // Parse + analyze data asynchronously
      try {
        const parsed = await DataParserService.parse(filePath);
        const dataAnalysis = DataAnalyzer.analyze(parsed);

        setAnalysis(dataAnalysis);
        setStep('show-summary');
      } catch (e) {
        setErrorMessage(e instanceof Error ? e.message : String(e));
        // Data problems are almost always the path — send ESC back there
        // with the typed path preserved instead of restarting the flow.
        setErrorReturnStep('enter-file');
        setStep('error');
      }
    },
    [filePath],
  );

  // Keyboard: ESC goes back, Enter confirms on show-summary
  useInput((_input, key) => {
    if (key.escape) {
      // 'select-preset' is the first step, so its back target is out of this
      // screen entirely — without a case here Esc was simply dead on the
      // opening screen, with no way back to the menu but finishing the flow.
      if (step === 'select-preset') onNavigate(parentOf('create-board'));
      else if (step === 'select-quality') setStep('select-preset');
      else if (step === 'enter-file') setStep('select-quality');
      else if (step === 'enter-name') setStep('enter-file');
      else if (step === 'show-summary') setStep('enter-name');
      else if (step === 'error') setStep(errorReturnStep);
      // 'analyzing' has no case on purpose: the parse it is waiting on cannot
      // be cancelled, so leaving would strand it. It is the one step where a
      // dead Esc is the honest answer — the hint bar says so.
    }
    if (key.return && step === 'show-summary' && selectedPreset) {
      if (!hasConfiguredLLM()) {
        setErrorMessage('No LLM provider is configured. Run Setup from the main menu, then press Enter here again.');
        setErrorReturnStep('show-summary');
        setStep('error');
        return;
      }

      // Create board config and pass to parent
      const boardConfig: import('../types/board.js').BoardConfig = {
        id: `board-${Date.now()}`,
        name: boardName.toLowerCase().replace(/\s+/g, '-'),
        title: boardName,
        type: selectedPreset.id as BoardConfig['type'],
        outputDir: '',
        dataFiles: [filePath],
        components: [],
        createdAt: new Date().toISOString(),
        dataSummary: analysis ? DataAnalyzer.generateSummary(analysis) : undefined,
        uiQuality,
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
        ║        Create New Dashboard          ║
      </Text>
      <Text bold color={UI_COLORS.border}>
        ╚══════════════════════════════════════╝
      </Text>
    </Box>
  );

  const renderStepIndicator = () => {
    const steps = ['Preset', 'Quality', 'File', 'Name', 'Analyze', 'Confirm'];
    const stepIndex = {
      'select-preset': 0,
      'select-quality': 1,
      'enter-file': 2,
      'enter-name': 3,
      analyzing: 4,
      'show-summary': 5,
      error: 5,
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
          Step 1/5: Select a dashboard preset
        </Text>
        {!llmReady && (
          <Box marginTop={1}>
            <Text color="yellow">
              ⚠ No LLM provider is configured yet — generation will need one. Run Setup from the main menu first.
            </Text>
          </Box>
        )}
        <Box marginTop={1}>
          <SelectInput items={presetItems()} onSelect={handlePresetSelect} />
        </Box>
        <Box marginTop={1}>
          <HintBar keys={['move', 'select', 'back']} />
        </Box>
      </Box>
    );
  }

  if (step === 'select-quality') {
    return (
      <Box flexDirection="column" padding={2}>
        {renderHeader()}
        {renderStepIndicator()}
        <Text bold color={UI_COLORS.logo}>
          Step 2/5: Choose UI complexity
        </Text>
        {localLLM && (
          <Box marginTop={1}>
            <Text color="yellow">
              ⚠ Local LLM detected — "Low quality" is recommended so smaller models can finish generating.
            </Text>
          </Box>
        )}
        <Box marginTop={1}>
          <SelectInput
            items={QUALITY_ITEMS}
            initialIndex={localLLM ? 1 : 0}
            onSelect={handleQualitySelect}
          />
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text color={UI_COLORS.subtitle}>
            Low quality uses a shorter prompt and fewer required features — better odds of
            completing on local or small-context models.
          </Text>
          <HintBar keys={['move', 'select', 'back']} />
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
          Step 3/5: Data file path
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
            placeholder="/path/to/data.csv, data.xlsx, or data.json"
          />
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text color={UI_COLORS.subtitle}>Supports .csv, .xlsx and .json</Text>
          <HintBar keys={['continue', 'back']} />
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
          Step 4/5: Name your dashboard
        </Text>
        <Box marginTop={1}>
          <Text color={UI_COLORS.logo}>File: </Text>
          <Text>{filePath}</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={UI_COLORS.logo}>{'Dashboard name › '}</Text>
          <TextInput
            value={boardName}
            onChange={setBoardName}
            onSubmit={handleNameSubmit}
            placeholder="e.g. My Finance Dashboard"
          />
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text color={UI_COLORS.subtitle}>Used as the dashboard title</Text>
          <HintBar keys={['continue', 'back']} />
        </Box>
      </Box>
    );
  }

  if (step === 'analyzing') {
    return (
      <Box flexDirection="column" padding={2}>
        {renderHeader()}
        {renderStepIndicator()}
        {/*
          A spinner and an elapsed count, not static text. Parsing a large CSV
          takes long enough that a frozen line reads as a hang, and this is the
          one step with no Esc — so the screen has to keep saying it is alive,
          and say why it will not respond.
        */}
        <Box marginTop={1}>
          <Spinner label={`Analyzing data file… ${analyzeElapsed}s`} color="yellow" />
        </Box>
        <Box marginTop={1}>
          <Text color={UI_COLORS.subtitle}>
            Parsing {filePath}
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text color={UI_COLORS.subtitle} dimColor>
            This cannot be interrupted — it finishes on its own.
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
            Dashboard Config
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
          <Text>
            {'  '}UI quality: <Text color="white">{uiQuality === 'low' ? 'Low (lightweight)' : 'High (full-featured)'}</Text>
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
          <Text bold color="green">Ready to generate</Text>
          <HintBar keys={['continue', 'back']} />
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
          <HintBar keys={['back']} />
        </Box>
      </Box>
    );
  }

  // Fallback (should never reach)
  return null;
}
