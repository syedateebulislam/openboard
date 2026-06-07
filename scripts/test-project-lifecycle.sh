#!/usr/bin/env bash
# ==============================================================================
# test-project-lifecycle.sh
# End-to-end verification of the per-board project lifecycle:
#   scaffold → install → build → preview → git → (push/deploy skipped without remote)
#
# Usage:
#   bash scripts/test-project-lifecycle.sh
# ==============================================================================

set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); echo -e "  ${GREEN}[PASS]${NC} $1"; }
fail() { FAIL=$((FAIL + 1)); echo -e "  ${RED}[FAIL]${NC} $1"; }
info() { echo -e "  ${CYAN}[INFO]${NC} $1"; }
section() { echo -e "\n${YELLOW}── $1 ──${NC}"; }

# Helper: run a TypeScript snippet via tsx from the project root.
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

# ── Temp workspace ────────────────────────────────────────────────────────────
TEST_DIR=$(mktemp -d)
PROJECTS_ROOT="$TEST_DIR/projects"
mkdir -p "$PROJECTS_ROOT"

cleanup() {
  # Stop any preview servers first
  run_ts cleanup_servers <<'EOF' >/dev/null 2>&1
import { PreviewService } from './src/services/deploy/PreviewService.js';
PreviewService.stopAll();
EOF
  sleep 1
  rm -rf "$TEST_DIR" 2>/dev/null || true
  info "Cleaned up temp dir: $TEST_DIR"
}
trap cleanup EXIT

echo -e "${CYAN}"
echo "  ___                   ____                      _ "
echo " / _ \ _ __   ___ _ __ | __ )  ___   __ _ _ __ __| |"
echo "| | | | '_ \ / _ \ '_ \|  _ \ / _ \ / _\` | '__/ _\` |"
echo "| |_| | |_) |  __/ | | | |_) | (_) | (_| | | | (_| |"
echo " \___/| .__/ \___|_| |_|____/ \___/ \__,_|_|  \__,_|"
echo "      |_|     Project Lifecycle Test Suite"
echo -e "${NC}"

# ==============================================================================
# 1. Prerequisites
# ==============================================================================
section "1. Prerequisites"

if ! command -v node &>/dev/null; then fail "node not installed"; exit 1; fi
pass "Node.js installed ($(node -v))"

if [ ! -d "$PROJECT_ROOT/node_modules" ]; then
  info "Installing dependencies..."
  npm install --silent
fi
pass "node_modules present"

if [ ! -d "$PROJECT_ROOT/templates/dashboard" ]; then
  fail "templates/dashboard/ not found"; exit 1
fi
pass "Template directory exists"

if [ ! -f "$PROJECT_ROOT/templates/dashboard/src/App.tsx" ]; then
  fail "templates/dashboard/src/App.tsx not found"; exit 1
fi
pass "Template App.tsx exists (buildable)"

# ==============================================================================
# 2. Scaffold a dashboard project
# ==============================================================================
section "2. Scaffold"

SCAFFOLD_RESULT=$(PROJECTS_ROOT="$PROJECTS_ROOT" run_ts scaffold <<'EOF'
import { ProjectManager } from './src/services/project/ProjectManager.js';

const pm = new ProjectManager(process.env.PROJECTS_ROOT!);
const board = {
  id: 'board-test-1',
  name: 'sales-analytics',
  title: 'Sales Analytics Dashboard',
  type: 'finance' as const,
  outputDir: '',
  dataFiles: [],
  components: [],
  createdAt: new Date().toISOString(),
};

const result = await pm.scaffold(board);
if (result.success) {
  console.log('SCAFFOLD_OK');
  console.log('PROJECT_DIR:' + result.projectDir);
} else {
  console.log('SCAFFOLD_FAIL:' + result.error);
}
EOF
)

if echo "$SCAFFOLD_RESULT" | grep -q "SCAFFOLD_OK"; then
  pass "Dashboard project scaffolded"
else
  fail "Scaffold: $SCAFFOLD_RESULT"
  exit 1
fi

# Extract project dir for subsequent tests
PROJECT_DIR=$(echo "$SCAFFOLD_RESULT" | grep "PROJECT_DIR:" | cut -d: -f2-)
info "Project dir: $PROJECT_DIR"

# Verify directory naming: <uuid8>-<board-name>
BASENAME=$(basename "$PROJECT_DIR")
if echo "$BASENAME" | grep -qE '^[a-f0-9]{8}-sales-analytics$'; then
  pass "Directory naming: $BASENAME (uuid8-boardname format)"
else
  fail "Directory naming: expected uuid8-sales-analytics, got $BASENAME"
fi

# Verify key files
for f in "package.json" "vite.config.ts" "index.html" "src/main.tsx" "src/App.tsx"; do
  if [ -f "$PROJECT_DIR/$f" ]; then
    pass "File exists: $f"
  else
    fail "Missing: $f"
  fi
done

# Verify template variables replaced
if ! grep -q '{{BOARD_NAME}}' "$PROJECT_DIR/index.html" 2>/dev/null; then
  pass "Template variables replaced in index.html"
else
  fail "Template variables NOT replaced in index.html"
fi

# ==============================================================================
# 3. Install dependencies
# ==============================================================================
section "3. Install"

INSTALL_RESULT=$(PROJECT_DIR="$PROJECT_DIR" run_ts install <<'EOF'
import { ProjectManager } from './src/services/project/ProjectManager.js';

const pm = new ProjectManager();
const result = await pm.install(process.env.PROJECT_DIR!);
if (result.success) {
  console.log('INSTALL_OK');
} else {
  console.log('INSTALL_FAIL:' + result.error);
}
EOF
)

if echo "$INSTALL_RESULT" | grep -q "INSTALL_OK"; then
  pass "npm install succeeded"
else
  fail "Install: $INSTALL_RESULT"
fi

if [ -d "$PROJECT_DIR/node_modules" ]; then
  pass "node_modules directory created"
else
  fail "node_modules not found after install"
fi

# ==============================================================================
# 4. Build
# ==============================================================================
section "4. Build"

BUILD_RESULT=$(PROJECT_DIR="$PROJECT_DIR" run_ts build <<'EOF'
import { ProjectManager } from './src/services/project/ProjectManager.js';

const pm = new ProjectManager();
const result = await pm.build(process.env.PROJECT_DIR!);
if (result.success) {
  console.log('BUILD_OK');
} else {
  console.log('BUILD_FAIL:' + result.error);
}
EOF
)

if echo "$BUILD_RESULT" | grep -q "BUILD_OK"; then
  pass "Vite build succeeded"
else
  fail "Build: $BUILD_RESULT"
fi

if [ -d "$PROJECT_DIR/dist" ]; then
  pass "dist/ directory created"
else
  fail "dist/ not found after build"
fi

if [ -f "$PROJECT_DIR/dist/index.html" ]; then
  pass "dist/index.html exists (deployable)"
else
  fail "dist/index.html missing"
fi

# ==============================================================================
# 5. Preview (local dev server)
# ==============================================================================
section "5. Preview"

PREVIEW_RESULT=$(PROJECT_DIR="$PROJECT_DIR" run_ts preview <<'EOF'
import { ProjectManager } from './src/services/project/ProjectManager.js';

const pm = new ProjectManager();
const result = await pm.preview(process.env.PROJECT_DIR!);
if (result.success) {
  console.log('PREVIEW_OK');
  console.log('URL:' + result.url);

  // Verify it's running
  const running = pm.isPreviewRunning(process.env.PROJECT_DIR!);
  console.log('RUNNING:' + running);

  // Stop it
  pm.stopPreview(process.env.PROJECT_DIR!);
  // Give it a moment
  await new Promise(r => setTimeout(r, 500));
  const stillRunning = pm.isPreviewRunning(process.env.PROJECT_DIR!);
  console.log('STOPPED:' + !stillRunning);
} else {
  console.log('PREVIEW_FAIL:' + result.error);
}
EOF
)

if echo "$PREVIEW_RESULT" | grep -q "PREVIEW_OK"; then
  pass "Dev server started"
  PREVIEW_URL=$(echo "$PREVIEW_RESULT" | grep "URL:" | cut -d: -f2-)
  pass "Preview URL: $PREVIEW_URL"
else
  fail "Preview: $PREVIEW_RESULT"
fi

if echo "$PREVIEW_RESULT" | grep -q "RUNNING:true"; then
  pass "isPreviewRunning() returns true while server is up"
else
  fail "isPreviewRunning() did not return true"
fi

if echo "$PREVIEW_RESULT" | grep -q "STOPPED:true"; then
  pass "stopPreview() successfully stopped the server"
else
  fail "stopPreview() did not stop the server"
fi

# ==============================================================================
# 6. Git init + commit
# ==============================================================================
section "6. Git (init + commit)"

GIT_RESULT=$(PROJECT_DIR="$PROJECT_DIR" run_ts git <<'EOF'
import { ProjectManager } from './src/services/project/ProjectManager.js';

const pm = new ProjectManager();
const projectDir = process.env.PROJECT_DIR!;

const initResult = await pm.gitInit(projectDir);
if (!initResult.success) {
  console.log('GIT_FAIL:init:' + initResult.error);
  process.exit(0);
}
console.log('GIT_INIT_OK');

const commitResult = await pm.gitCommit(projectDir, 'Initial commit');
if (!commitResult.success) {
  console.log('GIT_FAIL:commit:' + commitResult.error);
  process.exit(0);
}
console.log('GIT_COMMIT_OK');
console.log('HASH:' + commitResult.commitHash);
EOF
)

if echo "$GIT_RESULT" | grep -q "GIT_INIT_OK"; then
  pass "git init succeeded"
else
  fail "git init: $GIT_RESULT"
fi

if echo "$GIT_RESULT" | grep -q "GIT_COMMIT_OK"; then
  HASH=$(echo "$GIT_RESULT" | grep "HASH:" | cut -d: -f2)
  pass "git commit succeeded (${HASH:0:7})"
else
  fail "git commit: $GIT_RESULT"
fi

if [ -d "$PROJECT_DIR/.git" ]; then
  pass ".git directory exists"
else
  fail ".git directory not found"
fi

# ==============================================================================
# 7. Project info
# ==============================================================================
section "7. Project Info"

INFO_RESULT=$(PROJECT_DIR="$PROJECT_DIR" run_ts info <<'EOF'
import { ProjectManager } from './src/services/project/ProjectManager.js';

const pm = new ProjectManager();
const info = pm.getProjectInfo(process.env.PROJECT_DIR!);
if (info) {
  console.log('INFO_OK');
  console.log('PKG:' + info.hasPackageJson);
  console.log('MODULES:' + info.hasNodeModules);
  console.log('DIST:' + info.hasDist);
  console.log('GIT:' + info.hasGit);
} else {
  console.log('INFO_FAIL');
}
EOF
)

if echo "$INFO_RESULT" | grep -q "INFO_OK"; then
  pass "getProjectInfo() returned data"
else
  fail "getProjectInfo(): $INFO_RESULT"
fi

for field in "PKG:true" "MODULES:true" "DIST:true" "GIT:true"; do
  KEY=$(echo "$field" | cut -d: -f1)
  if echo "$INFO_RESULT" | grep -q "$field"; then
    pass "ProjectInfo.$KEY = true"
  else
    fail "ProjectInfo.$KEY expected true"
  fi
done

# ==============================================================================
# 8. List projects
# ==============================================================================
section "8. List Projects"

LIST_RESULT=$(PROJECTS_ROOT="$PROJECTS_ROOT" run_ts list <<'EOF'
import { ProjectManager } from './src/services/project/ProjectManager.js';

const pm = new ProjectManager(process.env.PROJECTS_ROOT!);
const projects = pm.listProjects();
console.log('COUNT:' + projects.length);
projects.forEach(p => console.log('PROJECT:' + p));
EOF
)

if echo "$LIST_RESULT" | grep -q "COUNT:1"; then
  pass "listProjects() found 1 project"
else
  fail "listProjects(): $LIST_RESULT"
fi

if echo "$LIST_RESULT" | grep -q "sales-analytics"; then
  pass "Listed project contains 'sales-analytics'"
else
  fail "Listed project name mismatch"
fi

# ==============================================================================
# 9. Second board — verify isolation
# ==============================================================================
section "9. Multi-board Isolation"

SECOND_RESULT=$(PROJECTS_ROOT="$PROJECTS_ROOT" run_ts second <<'EOF'
import { ProjectManager } from './src/services/project/ProjectManager.js';

const pm = new ProjectManager(process.env.PROJECTS_ROOT!);
const board = {
  id: 'board-test-2',
  name: 'health-tracker',
  title: 'Health Tracker',
  type: 'health' as const,
  outputDir: '',
  dataFiles: [],
  components: [],
  createdAt: new Date().toISOString(),
};

const result = await pm.scaffold(board);
if (result.success) {
  console.log('SECOND_OK');
  console.log('DIR:' + result.projectDir);
  const projects = pm.listProjects();
  console.log('TOTAL:' + projects.length);
} else {
  console.log('SECOND_FAIL:' + result.error);
}
EOF
)

if echo "$SECOND_RESULT" | grep -q "SECOND_OK"; then
  pass "Second board scaffolded"
else
  fail "Second board: $SECOND_RESULT"
fi

if echo "$SECOND_RESULT" | grep -q "TOTAL:2"; then
  pass "Two boards now exist in projects root"
else
  fail "Expected 2 projects"
fi

SECOND_DIR=$(echo "$SECOND_RESULT" | grep "DIR:" | cut -d: -f2-)
SECOND_BASENAME=$(basename "$SECOND_DIR")
if echo "$SECOND_BASENAME" | grep -qE '^[a-f0-9]{8}-health-tracker$'; then
  pass "Second board dir: $SECOND_BASENAME"
else
  fail "Second board naming: $SECOND_BASENAME"
fi

# Verify they're separate directories
if [ "$PROJECT_DIR" != "$SECOND_DIR" ]; then
  pass "Boards have separate project directories"
else
  fail "Boards share same directory!"
fi

# ==============================================================================
# 10. Run vitest (unit tests)
# ==============================================================================
section "10. Unit Tests (vitest)"

TEST_OUTPUT=$(npx vitest run tests/phase7/project-manager.test.ts --reporter=dot 2>&1 | tail -5)

if echo "$TEST_OUTPUT" | grep -q "19 passed"; then
  pass "All 19 ProjectManager unit tests pass"
else
  fail "Some unit tests failed: $TEST_OUTPUT"
fi

# ==============================================================================
# Summary
# ==============================================================================
echo ""
echo -e "${CYAN}================================================================${NC}"
TOTAL=$((PASS + FAIL))
echo -e "  Total: ${TOTAL}  |  ${GREEN}Passed: ${PASS}${NC}  |  ${RED}Failed: ${FAIL}${NC}"

if [ "$FAIL" -eq 0 ]; then
  echo -e "  ${GREEN}All tests passed! Project lifecycle is working.${NC}"
  echo -e "${CYAN}================================================================${NC}"
  exit 0
else
  echo -e "  ${RED}Some tests failed. Check output above.${NC}"
  echo -e "${CYAN}================================================================${NC}"
  exit 1
fi
