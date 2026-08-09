/**
 * BillerStudioScreen — a chat window that does exactly one thing: turn a sender
 * address and a subject into a working invoice fetcher.
 *
 * It is deliberately not the dashboard chat. There is no free-form conversation
 * here: the model is asked two questions (what fields does this email have, and
 * write the fetcher for them) and everything else is a stage in a fixed
 * pipeline. Keeping it separate means the dashboard chat's commands, context
 * assembly and system prompt stay untouched.
 *
 * Stages:
 *   sender → subject → probe → [confirm send] → detect
 *                                                  ↓
 *          done ← save ← verify ← generate ← [confirm fields]
 *
 * The sample email is real mail. It lives in component state, is shown to the
 * user in full before anything is transmitted, and is never logged.
 */

import React, { useMemo, useRef, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import type { Screen } from '../App.js';
import { UI_COLORS } from '../theme.js';
import { HintBar } from '../components/HintBar.js';
import { parentOf } from '../config/navigation.js';
import { ChatLineRow } from '../components/ChatMessage.js';
import type { ChatMessage } from '../types/board.js';
import {
  clampOffset,
  flattenMessages,
  maxScrollOffset,
  pageStep,
  scrollbarColumn,
  visibleLines,
  type WrapCache,
} from '../utils/chatViewport.js';
import { ConfigService } from '../services/config/ConfigService.js';
import { TypedConfigRepository } from '../services/config/TypedConfigRepository.js';
import { BillerProbeService, type ProbeSample } from '../services/billers/BillerProbeService.js';
import {
  BillerScriptGenerator,
  type BillerProposal,
} from '../services/billers/BillerScriptGenerator.js';
import { BillerScriptWriter, DRY_RUN_LIMIT } from '../services/billers/BillerScriptWriter.js';
import { discoverBillers } from '../services/billers/BillerDiscoveryService.js';
import { BoardRegistryService } from '../services/project/BoardRegistryService.js';
import { sanitizeErrorMessage } from '../utils/logger.js';
import { nextStudioAction, type StudioStage as Stage } from './billerStudioFlow.js';

/** Rows of chrome above/below the log: header 5, status 1, input 3, footer 1, hints 2. */
const CHROME_ROWS = 14;
const MIN_LOG_HEIGHT = 5;
const MAX_MESSAGES = 120;

let messageSeq = 0;
function newMsg(role: ChatMessage['role'], content: string): ChatMessage {
  messageSeq += 1;
  return {
    id: `studio-${messageSeq}`,
    role,
    content,
    timestamp: Date.now(),
  };
}

/** Commands are local to this screen — the dashboard chat's palette is unrelated. */
const STUDIO_COMMANDS: Array<{ command: string; description: string }> = [
  { command: '/probe', description: 'search the mailbox again' },
  { command: '/fields', description: 'show the detected fields' },
  { command: '/script', description: 'show the generated script' },
  { command: '/restart', description: 'start over with a new sender' },
  { command: '/cancel', description: 'leave without saving' },
  { command: '/help', description: 'show these commands' },
];

/** Render the proposal as something a person can actually check against their email. */
export function formatProposal(proposal: BillerProposal): string {
  const lines = [
    `Biller:   ${proposal.displayName}  (key: ${proposal.key})`,
    `Sender:   ${proposal.senderEmail}`,
    proposal.subjectPrefix
      ? `Subject:  starts with "${proposal.subjectPrefix}"`
      : `Subject:  matched by keywords ${JSON.stringify(proposal.subjectKeywords)}`,
    `Window:   last ${proposal.defaultSinceDays} days, up to ${proposal.searchLimit} messages`,
    '',
    'Fields it will extract:',
  ];
  const width = Math.max(...proposal.fields.map((field) => field.name.length), 4);
  for (const field of proposal.fields) {
    const example = field.example ? `  ← "${field.example}"` : '';
    lines.push(`  ${field.name.padEnd(width)}  ${field.description}${example}`);
  }
  if (proposal.notes) {
    lines.push('', `Note: ${proposal.notes}`);
  }
  return lines.join('\n');
}

/** What the user sees before anything is transmitted. */
export function formatSamplePreview(sample: ProbeSample, providerName: string): string {
  const shown = sample.text.length > 1200 ? `${sample.text.slice(0, 1200)}\n…` : sample.text;
  return [
    `About to send this email to ${providerName} so it can work out what to extract:`,
    '',
    `  Subject: ${sample.subject}`,
    `  From:    ${sample.from}`,
    `  Date:    ${sample.date}`,
    sample.attachments.length ? `  Files:   ${sample.attachments.join(', ')}` : '',
    '',
    '─── body ───',
    shown,
    '─── end ───',
    '',
    sample.truncated
      ? `(${sample.fullLength} chars total, truncated to ${sample.text.length})`
      : `(${sample.text.length} chars)`,
    '',
    'Type "yes" to send it, anything else to cancel.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

interface BillerStudioScreenProps {
  onNavigate: (screen: Screen) => void;
  onBillerCreated?: () => void;
  /** Injected in tests so no interpreter, mailbox or provider is touched. */
  deps?: {
    probeService?: BillerProbeService;
    generator?: BillerScriptGenerator;
    writer?: BillerScriptWriter;
  };
}

export function BillerStudioScreen({ onNavigate, onBillerCreated, deps }: BillerStudioScreenProps) {
  const [messages, setMessages] = useState<ChatMessage[]>(() => [
    newMsg(
      'system',
      'Add a biller by showing OpenBoardCLI one of its emails.\n\nEnter the address these receipts arrive from — for example noreply@bigbasket.com.',
    ),
  ]);
  const [stage, setStage] = useState<Stage>('sender');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [scrollOffset, setScrollOffset] = useState(0);

  const [sender, setSender] = useState('');
  const [subject, setSubject] = useState('');
  const [sample, setSample] = useState<ProbeSample | null>(null);
  const [proposal, setProposal] = useState<BillerProposal | null>(null);
  const [script, setScript] = useState('');

  const config = useMemo(() => new ConfigService(), []);
  const settings = new TypedConfigRepository().getBillerSettings();

  const probeService = useMemo(() => deps?.probeService ?? new BillerProbeService(), [deps]);
  const generator = useMemo(() => deps?.generator ?? new BillerScriptGenerator(), [deps]);
  const writer = useMemo(() => deps?.writer ?? new BillerScriptWriter(), [deps]);

  const providerName = (config.get('llm.provider') as string) || 'the LLM provider';

  const say = (role: ChatMessage['role'], content: string) => {
    setMessages((current) => {
      const next = [...current, newMsg(role, content)];
      return next.length > MAX_MESSAGES ? next.slice(-MAX_MESSAGES) : next;
    });
    setScrollOffset(0);
  };

  /** Errors from subprocesses and providers can carry credentials. */
  const fail = (message: string) => say('error', sanitizeErrorMessage(message));

  const restart = () => {
    setSender('');
    setSubject('');
    setSample(null);
    setProposal(null);
    setScript('');
    setStage('sender');
    say('system', 'Starting over. Which address do the receipts come from?');
  };

  // ─── Stage actions ─────────────────────────────────────────────────────────

  const runProbe = async (senderValue: string, subjectValue: string) => {
    setBusy(true);
    setStage('working');
    say('system', `Searching your mailbox for mail from ${senderValue}…`);
    try {
      const result = await probeService.probe(
        { sender: senderValue, subject: subjectValue, sinceDays: 365 },
        settings,
      );

      if (!result.sample) {
        fail(
          `No matching emails found (scanned ${result.scanned} messages since ${result.sinceDate}).\n\nCheck the sender address, or widen the subject filter with /probe.`,
        );
        setStage('subject');
        return;
      }

      setSample(result.sample);
      if (result.sample.bodySource === 'pdf') {
        say('system', 'The receipt is in a PDF attachment — reading it with pdfplumber.');
      } else if (result.sample.attachments.some((name) => name.toLowerCase().endsWith('.pdf')) && !result.sample.pdfSupport) {
        say(
          'system',
          'This email has a PDF attachment but pdfplumber is not installed, so only the email body was read. Install it with `pip install pdfplumber` and /probe again if the fields look thin.',
        );
      }
      say(
        'assistant',
        `Found ${result.matched} matching email${result.matched === 1 ? '' : 's'}. Using the most recent one.` +
          (result.otherSubjects.length
            ? `\n\nOther subjects from this sender:\n${result.otherSubjects.map((s) => `  · ${s}`).join('\n')}`
            : ''),
      );
      say('system', formatSamplePreview(result.sample, providerName));
      setStage('confirm-send');
    } catch (error: any) {
      fail(error.message ?? String(error));
      setStage('subject');
    } finally {
      setBusy(false);
    }
  };

  const detectFields = async (sampleValue: ProbeSample) => {
    setBusy(true);
    setStage('working');
    say('system', 'Working out what can be extracted…');
    try {
      const detected = await generator.proposeFields({
        subject: sampleValue.subject,
        from: sampleValue.from,
        text: sampleValue.text,
        bodySource: sampleValue.bodySource,
        pdfSupport: sampleValue.pdfSupport,
      });
      setProposal(detected);
      say('assistant', formatProposal(detected));

      // A key that already names a dashboard is not blocked — replacing a
      // biller's fetcher is legitimate — but it must not be silent. Saving
      // would point that dashboard at this fetcher's CSV on the next sync.
      const clash = new BoardRegistryService()
        .listBoards()
        .find((board) => board.name === detected.key);
      if (clash) {
        say(
          'system',
          `Note: a dashboard called "${clash.name}" already exists. Saving this fetcher will make it the source for that dashboard from the next fetch onwards. Use /restart and a different key if you meant to add a separate biller.`,
        );
      }

      say(
        'system',
        'Does that match what you see in the email? Type "yes" to build the fetcher, anything else to cancel.',
      );
      setStage('confirm-fields');
    } catch (error: any) {
      fail(error.message ?? String(error));
      setStage('confirm-send');
    } finally {
      setBusy(false);
    }
  };

  const buildAndSave = async (proposalValue: BillerProposal, sampleValue: ProbeSample) => {
    setBusy(true);
    setStage('working');

    let writtenPath: string | undefined;
    try {
      const source = await generator.generateScript(
        proposalValue,
        {
          subject: sampleValue.subject,
          from: sampleValue.from,
          text: sampleValue.text,
          bodySource: sampleValue.bodySource,
          pdfSupport: sampleValue.pdfSupport,
        },
        {
          onAttempt: (attempt, total) =>
            say('system', `Writing fetch_${proposalValue.key}.py (attempt ${attempt} of ${total})…`),
          // Each candidate is written to a real path, compiled and run against
          // the mailbox. Anything that fails comes back as text the next
          // attempt has to fix.
          verify: async (candidate) => {
            if (writtenPath) {
              writer.discard(writtenPath);
              writtenPath = undefined;
            }
            try {
              writtenPath = writer.write(candidate, proposalValue.key, settings);
            } catch (error: any) {
              return error.message;
            }

            say('system', 'Compiling…');
            const compiled = await writer.compile(writtenPath, settings);
            if (!compiled.ok) return `py_compile failed:\n${compiled.error}`;

            if (!writer.isDiscoverable(writtenPath, settings.scriptsDir!, proposalValue.key)) {
              return 'The script compiled but OpenBoardCLI cannot discover it. KEY and DISPLAY_NAME must be plain string literals at the start of a line.';
            }

            // Grade against the sample first: it is offline, deterministic, and
            // catches blank fields that a mailbox dry run reports as success.
            say('system', 'Checking what it extracts from the sample…');
            const graded = await writer.parseSample(
              writtenPath,
              sampleValue.text,
              sampleValue.subject,
              settings,
            );
            if (!graded.ok) return graded.error;
            if (graded.filled) {
              say('assistant', `Extracted ${graded.filled.length}/${(graded.filled.length + (graded.empty?.length ?? 0))} fields from the sample.`);
            }

            say('system', `Running it against your mailbox (--dry-run, ${DRY_RUN_LIMIT} messages)…`);
            const dry = await writer.dryRun(writtenPath, settings);
            if (!dry.ok) return `The dry run failed:\n${dry.error}`;

            say('assistant', `Parsed ${dry.parsedRows} row${dry.parsedRows === 1 ? '' : 's'} from real email.`);
            return undefined;
          },
        },
      );

      setScript(source);

      // Enable it straight away — the user just watched it work.
      const enabled = new Set(settings.enabledKeys);
      enabled.add(proposalValue.key);
      config.set('billers.enabledKeys', [...enabled]);

      const total = discoverBillers(settings.scriptsDir).length;
      say(
        'assistant',
        `Saved ${writtenPath}\n\n${proposalValue.displayName} is now enabled and listed with your other billers (${total} total). Its CSV will appear at:\n  ${writer.csvPathFor(settings.scriptsDir!, proposalValue.key)}\n\nESC to go back, or /restart to add another.`,
      );
      onBillerCreated?.();
      setStage('done');
    } catch (error: any) {
      if (writtenPath) writer.discard(writtenPath);
      fail(`${error.message ?? String(error)}\n\nNothing was saved. /restart to try a different sender or subject.`);
      setStage('done');
    } finally {
      setBusy(false);
    }
  };

  // ─── Input dispatch ────────────────────────────────────────────────────────

  const handleSubmit = (raw: string) => {
    const text = raw.trim();
    if (!text || busy) return;
    setInput('');
    say('user', text);

    const action = nextStudioAction(stage, text);

    switch (action.type) {
      case 'leave':
        onNavigate(parentOf('biller-studio'));
        return;

      case 'help':
        say('system', STUDIO_COMMANDS.map((c) => `${c.command.padEnd(10)} ${c.description}`).join('\n'));
        return;

      case 'restart':
        restart();
        return;

      case 'show-fields':
        say(proposal ? 'assistant' : 'system', proposal ? formatProposal(proposal) : 'No fields detected yet.');
        return;

      case 'show-script':
        say(script ? 'assistant' : 'system', script || 'No script generated yet.');
        return;

      case 'reprobe':
        if (!sender) say('system', 'Enter a sender address first.');
        else void runProbe(sender, subject);
        return;

      case 'reject-sender':
        say('system', action.message);
        return;

      case 'accept-sender':
        setSender(action.sender);
        setStage('subject');
        say(
          'system',
          'Now a bit of the subject line, to separate receipts from marketing mail — for example "Your order". Enter "-" to match every email from this sender.',
        );
        return;

      case 'accept-subject':
        setSubject(action.subject);
        void runProbe(sender, action.subject);
        return;

      case 'send-sample':
        if (sample) void detectFields(sample);
        return;

      case 'decline-sample':
        say('system', 'Cancelled — nothing was sent. /probe to search again, /restart to start over.');
        return;

      case 'build':
        if (proposal && sample) void buildAndSave(proposal, sample);
        return;

      case 'decline-build':
        say('system', 'Cancelled — nothing was written. /restart to start over.');
        setStage('done');
        return;

      case 'idle-hint':
        say('system', 'Nothing left to do here. ESC to go back, or /restart to add another biller.');
        return;

      default:
        return;
    }
  };

  // ─── Viewport ──────────────────────────────────────────────────────────────

  const { stdout } = useStdout();
  const termHeight = stdout?.rows ?? 24;
  const termWidth = stdout?.columns ?? 80;
  const logWidth = Math.max(20, termWidth - 6);
  const logHeight = Math.max(MIN_LOG_HEIGHT, termHeight - CHROME_ROWS);

  const wrapCacheRef = useRef<WrapCache>(new Map());
  const lines = useMemo(
    () => flattenMessages(messages, logWidth, wrapCacheRef.current),
    [messages, logWidth],
  );

  const effectiveOffset = clampOffset(scrollOffset, lines.length, logHeight);
  const hiddenNewer = effectiveOffset;
  const hiddenOlder = maxScrollOffset(lines.length, logHeight) - effectiveOffset;
  const rows = visibleLines(lines, logHeight, effectiveOffset);
  const scrollbar = scrollbarColumn(lines.length, logHeight, effectiveOffset);

  const viewRef = useRef({ totalLines: lines.length, logHeight });
  viewRef.current = { totalLines: lines.length, logHeight };

  useInput((_input, key) => {
    if (key.escape && !busy) onNavigate(parentOf('biller-studio'));
    if (key.pageUp) {
      const view = viewRef.current;
      setScrollOffset((offset) => clampOffset(offset + pageStep(view.logHeight), view.totalLines, view.logHeight));
    }
    if (key.pageDown) {
      const view = viewRef.current;
      setScrollOffset((offset) => clampOffset(offset - pageStep(view.logHeight), view.totalLines, view.logHeight));
    }
  });

  const prompt =
    stage === 'sender' ? 'Sender address'
      : stage === 'subject' ? 'Subject contains'
        : stage === 'confirm-send' || stage === 'confirm-fields' ? 'yes / no'
          : 'Command';

  return (
    <Box flexDirection="column" padding={1} borderStyle="round" borderColor={UI_COLORS.border}>
      <Box
        borderStyle="round"
        borderColor={UI_COLORS.border}
        padding={1}
        marginBottom={1}
        width="100%"
        flexDirection="column"
        alignItems="center"
      >
        <Text bold color={UI_COLORS.logo}>Biller Studio</Text>
        <Text color={UI_COLORS.subtitle}>LLM - {providerName}</Text>
        <Text color={UI_COLORS.subtitle}>Teach OpenBoardCLI a new invoice source from one sample email</Text>
      </Box>

      <Box height={logHeight} overflow="hidden">
        <Box flexDirection="column" width={logWidth} flexShrink={0}>
          {rows.map((line) => (
            <ChatLineRow key={line.key} line={line} />
          ))}
        </Box>
        <Box flexDirection="column" width={1} flexShrink={0} marginLeft={1}>
          {scrollbar.map((filled, row) => (
            <Text key={row} color={filled ? UI_COLORS.logo : UI_COLORS.border} dimColor={!filled}>
              {filled ? '█' : '░'}
            </Text>
          ))}
        </Box>
      </Box>

      <Text color={hiddenNewer > 0 ? 'yellow' : UI_COLORS.subtitle}>
        {hiddenNewer > 0
          ? `↑ ${hiddenOlder} older · ↓ ${hiddenNewer} newer (PgDn for latest)`
          : hiddenOlder > 0
            ? `↑ ${hiddenOlder} older (PgUp)`
            : ' '}
      </Text>

      <Box borderStyle="single" borderColor={UI_COLORS.border} padding={0}>
        <Text color={UI_COLORS.logo}>{busy ? '… ' : `${prompt} › `}</Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          placeholder={busy ? 'working…' : ''}
        />
      </Box>

      <HintBar keys={['scroll', 'commands', 'back']} />
    </Box>
  );
}

export default BillerStudioScreen;
