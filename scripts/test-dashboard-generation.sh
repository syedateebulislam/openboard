#!/usr/bin/env bash
# ==============================================================================
# test-dashboard-generation.sh
# End-to-end test: verifies OpenBoard can scaffold and generate a sample dashboard
# using the OpenAI provider.
#
# Usage:
#   export OPENAI_API_KEY="sk-..."
#   bash scripts/test-dashboard-generation.sh
# ==============================================================================

set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); echo -e "  ${GREEN}[PASS]${NC} $1"; }
fail() { FAIL=$((FAIL + 1)); echo -e "  ${RED}[FAIL]${NC} $1"; }
info() { echo -e "  ${CYAN}[INFO]${NC} $1"; }
section() { echo -e "\n${YELLOW}── $1 ──${NC}"; }

# Helper: run a TypeScript snippet via tsx, capturing stdout.
# Writes the snippet to a temp .ts file inside the project root so relative
# imports (./src/...) resolve correctly, then cleans it up.
run_ts() {
  local script_file="$PROJECT_ROOT/_test_$1.ts"
  cat > "$script_file"
  local result
  result=$(cd "$PROJECT_ROOT" && npx tsx "$script_file" 2>&1) || true
  rm -f "$script_file"
  echo "$result"
}

# ── Project root ──────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# ── Temp workspace (cleaned up on exit) ───────────────────────────────────────
TEST_DIR=$(mktemp -d)
OPENBOARD_CONFIG_DIR="$TEST_DIR/config"
OUTPUT_DIR="$TEST_DIR/output"
mkdir -p "$OPENBOARD_CONFIG_DIR" "$OUTPUT_DIR"

cleanup() {
  rm -rf "$TEST_DIR"
  info "Cleaned up temp dir: $TEST_DIR"
}
trap cleanup EXIT

echo -e "${CYAN}"
echo "  ___                   ____                      _ "
echo " / _ \ _ __   ___ _ __ | __ )  ___   __ _ _ __ __| |"
echo "| | | | '_ \ / _ \ '_ \|  _ \ / _ \ / _\` | '__/ _\` |"
echo "| |_| | |_) |  __/ | | | |_) | (_) | (_| | | | (_| |"
echo " \___/| .__/ \___|_| |_|____/ \___/ \__,_|_|  \__,_|"
echo "      |_|     Dashboard Generation Test Suite"
echo -e "${NC}"

# ==============================================================================
# 1. Prerequisites
# ==============================================================================
section "1. Prerequisites"

# Check OPENAI_API_KEY
if [ -z "${OPENAI_API_KEY:-}" ]; then
  fail "OPENAI_API_KEY is not set. Export it before running this script."
  echo -e "  ${RED}  export OPENAI_API_KEY=\"sk-...\"${NC}"
  exit 1
fi
pass "OPENAI_API_KEY is set"

# Check node
if ! command -v node &>/dev/null; then
  fail "node is not installed"
  exit 1
fi
NODE_VERSION=$(node -v)
pass "Node.js installed ($NODE_VERSION)"

# Check npm
if ! command -v npm &>/dev/null; then
  fail "npm is not installed"
  exit 1
fi
pass "npm installed ($(npm -v))"

# Check dependencies installed
if [ ! -d "$PROJECT_ROOT/node_modules" ]; then
  info "node_modules not found, running npm install..."
  npm install --silent
fi
pass "node_modules present"

# Check template directory exists
if [ ! -d "$PROJECT_ROOT/templates/dashboard" ]; then
  fail "templates/dashboard/ directory not found"
  exit 1
fi
pass "Template directory exists"

# ==============================================================================
# 2. ConfigService — write & read config
# ==============================================================================
section "2. ConfigService (write/read LLM config)"

CONFIG_TEST_RESULT=$(OPENBOARD_CONFIG_DIR="$OPENBOARD_CONFIG_DIR" run_ts config <<'CONFIGEOF'
import { ConfigService } from './src/services/config/ConfigService.js';

try {
  const config = new ConfigService(process.env.OPENBOARD_CONFIG_DIR);

  config.set('llm.provider', 'openai');
  config.set('llm.model', 'gpt-4o-mini');
  config.set('llm.apiKey', process.env.OPENAI_API_KEY!);

  const provider = config.get('llm.provider');
  const model = config.get('llm.model');
  const apiKey = config.get('llm.apiKey');

  if (provider !== 'openai') throw new Error(`provider mismatch: ${provider}`);
  if (model !== 'gpt-4o-mini') throw new Error(`model mismatch: ${model}`);
  if (!apiKey) throw new Error('apiKey not stored');

  console.log('CONFIG_OK');
} catch (e: any) {
  console.error('CONFIG_FAIL: ' + e.message);
  process.exit(1);
}
CONFIGEOF
)

if echo "$CONFIG_TEST_RESULT" | grep -q "CONFIG_OK"; then
  pass "ConfigService: write and read LLM config"
else
  fail "ConfigService: $CONFIG_TEST_RESULT"
fi

# ==============================================================================
# 3. LLM Provider — validate API key
# ==============================================================================
section "3. LLM Provider (OpenAI key validation)"

VALIDATE_RESULT=$(run_ts validate <<'VALIDATEEOF'
import { LLMService } from './src/services/llm/LLMService.js';

try {
  const provider = LLMService.createProvider({
    provider: 'openai',
    model: 'gpt-4o-mini',
    apiKey: process.env.OPENAI_API_KEY,
  });

  const result = await provider.validate();
  if (result.valid) {
    console.log('VALIDATE_OK');
  } else {
    console.log('VALIDATE_FAIL: ' + result.error);
  }
} catch (e: any) {
  console.error('VALIDATE_FAIL: ' + e.message);
  process.exit(1);
}
VALIDATEEOF
)

if echo "$VALIDATE_RESULT" | grep -q "VALIDATE_OK"; then
  pass "OpenAI API key is valid"
else
  fail "OpenAI key validation: $VALIDATE_RESULT"
fi

# ==============================================================================
# 4. TemplateService — scaffold a dashboard project
# ==============================================================================
section "4. TemplateService (scaffold dashboard)"

SCAFFOLD_RESULT=$(OUTPUT_DIR="$OUTPUT_DIR" run_ts scaffold <<'SCAFFOLDEOF'
import { TemplateService } from './src/services/template/TemplateService.js';

try {
  const ts = new TemplateService();
  await ts.scaffold(process.env.OUTPUT_DIR!, {
    boardName: 'test-dashboard',
    boardTitle: 'Test Dashboard',
  });
  console.log('SCAFFOLD_OK');
} catch (e: any) {
  console.error('SCAFFOLD_FAIL: ' + e.message);
  process.exit(1);
}
SCAFFOLDEOF
)

if echo "$SCAFFOLD_RESULT" | grep -q "SCAFFOLD_OK"; then
  pass "Dashboard project scaffolded"
else
  fail "Scaffold: $SCAFFOLD_RESULT"
fi

# Verify key files were created
for f in "package.json" "vite.config.ts" "index.html" "src/main.tsx"; do
  if [ -f "$OUTPUT_DIR/$f" ]; then
    pass "Scaffolded file exists: $f"
  else
    fail "Missing scaffolded file: $f"
  fi
done

# ==============================================================================
# 5. LLM Code Generation — generate a sample React component
# ==============================================================================
section "5. LLM Code Generation (generate sample component)"

GENERATE_RESULT=$(run_ts generate <<'GENEOF'
import { LLMService } from './src/services/llm/LLMService.js';

try {
  const provider = LLMService.createProvider({
    provider: 'openai',
    model: 'gpt-4o-mini',
    apiKey: process.env.OPENAI_API_KEY,
  });

  const response = await provider.complete({
    messages: [
      {
        role: 'system',
        content: 'You are an expert React developer. Generate ONLY valid TypeScript React code. No markdown, no explanations, just the code.',
      },
      {
        role: 'user',
        content: `Generate a simple React dashboard component called "Overview" that displays:
- A title "Dashboard Overview"
- 3 stat cards showing: Total Users (1,234), Revenue ($56,789), Active Sessions (42)
Use TypeScript, export default the component. Use inline styles or className strings (no CSS imports).
Return ONLY the .tsx file content.`,
      },
    ],
    temperature: 0.3,
    maxTokens: 2048,
  });

  if (!response || response.length < 50) {
    console.log('GENERATE_FAIL: Response too short');
    process.exit(1);
  }

  const hasExport = response.includes('export');
  const hasOverview = response.includes('Overview');

  if (hasExport && hasOverview) {
    console.log('GENERATE_OK');
    console.log('GENERATED_LENGTH: ' + response.length);
  } else {
    console.log('GENERATE_FAIL: Missing expected patterns (export/Overview)');
  }
} catch (e: any) {
  console.error('GENERATE_FAIL: ' + e.message);
  process.exit(1);
}
GENEOF
)

if echo "$GENERATE_RESULT" | grep -q "GENERATE_OK"; then
  GENERATED_LEN=$(echo "$GENERATE_RESULT" | grep "GENERATED_LENGTH" | cut -d' ' -f2)
  pass "LLM generated a dashboard component (${GENERATED_LEN} chars)"
else
  fail "Code generation: $GENERATE_RESULT"
fi

# ==============================================================================
# 6. Write generated component into scaffolded project
# ==============================================================================
section "6. Write Generated File into Project"

WRITE_RESULT=$(OUTPUT_DIR="$OUTPUT_DIR" run_ts writefile <<'WRITEEOF'
import { TemplateService } from './src/services/template/TemplateService.js';
import fs from 'node:fs';
import path from 'node:path';

try {
  const ts = new TemplateService();
  const sampleComponent = `import React from 'react';

interface StatCardProps {
  title: string;
  value: string;
}

function StatCard({ title, value }: StatCardProps) {
  return (
    <div style={{ padding: '1rem', border: '1px solid #ccc', borderRadius: '8px', minWidth: '200px' }}>
      <h3 style={{ margin: 0, color: '#666' }}>{title}</h3>
      <p style={{ margin: '0.5rem 0 0', fontSize: '1.5rem', fontWeight: 'bold' }}>{value}</p>
    </div>
  );
}

export default function Overview() {
  return (
    <div style={{ padding: '2rem' }}>
      <h1>Dashboard Overview</h1>
      <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem' }}>
        <StatCard title="Total Users" value="1,234" />
        <StatCard title="Revenue" value="$56,789" />
        <StatCard title="Active Sessions" value="42" />
      </div>
    </div>
  );
}
`;

  await ts.writeGeneratedFile(process.env.OUTPUT_DIR!, 'components/Overview.tsx', sampleComponent);

  const filePath = path.join(process.env.OUTPUT_DIR!, 'src', 'components', 'Overview.tsx');

  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, 'utf-8');
    if (content.includes('Overview') && content.includes('StatCard')) {
      console.log('WRITE_OK');
    } else {
      console.log('WRITE_FAIL: File content missing expected patterns');
    }
  } else {
    console.log('WRITE_FAIL: File not found at ' + filePath);
  }
} catch (e: any) {
  console.error('WRITE_FAIL: ' + e.message);
  process.exit(1);
}
WRITEEOF
)

if echo "$WRITE_RESULT" | grep -q "WRITE_OK"; then
  pass "Generated component written to src/components/Overview.tsx"
else
  fail "Write generated file: $WRITE_RESULT"
fi

# ==============================================================================
# 7. Data Parsing — test CSV parsing
# ==============================================================================
section "7. Data Parsing (sample CSV)"

# Create a sample CSV
SAMPLE_CSV="$TEST_DIR/sample-data.csv"
cat > "$SAMPLE_CSV" <<'CSV'
date,users,revenue,sessions
2024-01-01,100,5000,20
2024-01-02,120,5200,25
2024-01-03,115,4800,22
2024-01-04,130,5500,28
2024-01-05,125,5100,24
CSV

PARSE_RESULT=$(SAMPLE_CSV="$SAMPLE_CSV" run_ts parse <<'PARSEEOF'
import { DataParserService } from './src/services/data/DataParserService.js';
import { DataAnalyzer } from './src/services/data/DataAnalyzer.js';

try {
  const parsed = await DataParserService.parse(process.env.SAMPLE_CSV!);

  if (!parsed || !parsed.rows || parsed.rows.length === 0) {
    console.log('PARSE_FAIL: No rows parsed');
    process.exit(1);
  }

  if (parsed.rows.length !== 5) {
    console.log('PARSE_FAIL: Expected 5 rows, got ' + parsed.rows.length);
    process.exit(1);
  }

  const analysis = DataAnalyzer.analyze(parsed);
  const summary = DataAnalyzer.generateSummary(analysis);

  if (analysis.rowCount === 5 && analysis.columnCount === 4) {
    console.log('PARSE_OK');
    console.log('SUMMARY: ' + summary.split('\n')[0]);
  } else {
    console.log('PARSE_FAIL: analysis mismatch rows=' + analysis.rowCount + ' cols=' + analysis.columnCount);
  }
} catch (e: any) {
  console.error('PARSE_FAIL: ' + e.message);
  process.exit(1);
}
PARSEEOF
)

if echo "$PARSE_RESULT" | grep -q "PARSE_OK"; then
  pass "CSV parsed and analyzed (5 rows, 4 columns)"
else
  fail "Data parsing: $PARSE_RESULT"
fi

# ==============================================================================
# 8. LLM Streaming — verify streaming works
# ==============================================================================
section "8. LLM Streaming"

STREAM_RESULT=$(run_ts stream <<'STREAMEOF'
import { LLMService } from './src/services/llm/LLMService.js';

try {
  const provider = LLMService.createProvider({
    provider: 'openai',
    model: 'gpt-4o-mini',
    apiKey: process.env.OPENAI_API_KEY,
  });

  let chunkCount = 0;
  let fullText = '';

  for await (const chunk of provider.stream({
    messages: [
      { role: 'user', content: 'Say "hello world" and nothing else.' },
    ],
    temperature: 0,
    maxTokens: 20,
  })) {
    chunkCount++;
    fullText += chunk.text;
    if (chunk.done) break;
  }

  if (chunkCount > 0 && fullText.toLowerCase().includes('hello')) {
    console.log('STREAM_OK: ' + chunkCount + ' chunks, text="' + fullText.trim() + '"');
  } else {
    console.log('STREAM_FAIL: chunks=' + chunkCount + ' text="' + fullText + '"');
  }
} catch (e: any) {
  console.error('STREAM_FAIL: ' + e.message);
  process.exit(1);
}
STREAMEOF
)

if echo "$STREAM_RESULT" | grep -q "STREAM_OK"; then
  CHUNKS=$(echo "$STREAM_RESULT" | grep "STREAM_OK" | sed 's/STREAM_OK: //')
  pass "LLM streaming works ($CHUNKS)"
else
  fail "Streaming: $STREAM_RESULT"
fi

# ==============================================================================
# Summary
# ==============================================================================
echo ""
echo -e "${CYAN}================================================================${NC}"
TOTAL=$((PASS + FAIL))
echo -e "  Total: ${TOTAL}  |  ${GREEN}Passed: ${PASS}${NC}  |  ${RED}Failed: ${FAIL}${NC}"

if [ "$FAIL" -eq 0 ]; then
  echo -e "  ${GREEN}All tests passed! OpenBoard can generate dashboards.${NC}"
  echo -e "${CYAN}================================================================${NC}"
  exit 0
else
  echo -e "  ${RED}Some tests failed. Check output above.${NC}"
  echo -e "${CYAN}================================================================${NC}"
  exit 1
fi
