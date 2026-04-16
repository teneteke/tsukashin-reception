#!/usr/bin/env bash
# verify-mechanical.sh — Mechanical checks for a vanilla JS + sql.js PWA project
# Tech stack: HTML + CSS + vanilla JS (no TypeScript, no framework, no package.json)
# Vendor libs in lib/ are excluded from all checks.
set -euo pipefail

cd "$(dirname "$0")/.."
PROJECT_ROOT="$(pwd)"

RED='\033[0;31m'
YELLOW='\033[0;33m'
GREEN='\033[0;32m'
BOLD='\033[1m'
RESET='\033[0m'

step_pass() { printf "${GREEN}PASS${RESET}  %s\n" "$1"; }
step_warn() { printf "${YELLOW}WARN${RESET}  %s — skipped\n" "$1"; }
step_fail() { printf "${RED}FAIL${RESET}  %s\n" "$1"; }

########################################
# 1. Syntax check (vanilla JS — node --check)
#    This is the applicable "type check" for a project with no TypeScript.
########################################
printf "\n${BOLD}[1/5] Syntax check (node --check)${RESET}\n"

if ! command -v node &>/dev/null; then
  step_warn "node is not installed"
else
  js_files=()
  while IFS= read -r -d '' f; do
    js_files+=("$f")
  done < <(find "$PROJECT_ROOT" -name '*.js' -not -path '*/lib/*' -not -path '*/node_modules/*' -print0)

  if [ ${#js_files[@]} -eq 0 ]; then
    step_warn "No project JS files found outside lib/"
  else
    syntax_ok=true
    for f in "${js_files[@]}"; do
      if ! node --check "$f" 2>&1; then
        syntax_ok=false
        break
      fi
    done
    if [ "$syntax_ok" = true ]; then
      step_pass "All ${#js_files[@]} JS files have valid syntax"
    else
      step_fail "Syntax error detected (see above)"
      exit 1
    fi
  fi
fi

########################################
# 2. Linter (ESLint)
#    No package.json / no ESLint config in this project.
########################################
printf "\n${BOLD}[2/5] Linter (ESLint)${RESET}\n"

has_eslint=false
if [ -f "$PROJECT_ROOT/package.json" ]; then
  # Check for eslint in devDependencies or scripts
  if command -v npx &>/dev/null && npx --no -- eslint --version &>/dev/null 2>&1; then
    has_eslint=true
  fi
elif command -v eslint &>/dev/null; then
  # Globally installed ESLint
  has_eslint=true
fi

eslint_config_exists=false
for cfg in .eslintrc .eslintrc.js .eslintrc.cjs .eslintrc.json .eslintrc.yml eslint.config.js eslint.config.mjs eslint.config.cjs; do
  if [ -f "$PROJECT_ROOT/$cfg" ]; then
    eslint_config_exists=true
    break
  fi
done

if [ "$has_eslint" = true ] && [ "$eslint_config_exists" = true ]; then
  if eslint "$PROJECT_ROOT/js/" "$PROJECT_ROOT/sw.js" 2>&1; then
    step_pass "ESLint passed"
  else
    step_fail "ESLint found issues (see above)"
    exit 1
  fi
else
  step_warn "ESLint not configured (no config file or eslint not installed)"
fi

########################################
# 3. Tests
#    No test framework configured in this project.
########################################
printf "\n${BOLD}[3/5] Tests${RESET}\n"

test_ran=false

# Check for package.json test script
if [ -f "$PROJECT_ROOT/package.json" ] && command -v node &>/dev/null; then
  has_test_script=$(node -e "
    const pkg = require('./package.json');
    const s = (pkg.scripts && pkg.scripts.test) || '';
    console.log(s && !s.includes('no test specified') ? 'yes' : 'no');
  " 2>/dev/null || echo "no")
  if [ "$has_test_script" = "yes" ]; then
    if npm test 2>&1; then
      step_pass "npm test passed"
    else
      step_fail "npm test failed (see above)"
      exit 1
    fi
    test_ran=true
  fi
fi

# Check for pytest
if [ "$test_ran" = false ] && [ -f "$PROJECT_ROOT/pyproject.toml" ] && command -v pytest &>/dev/null; then
  if pytest 2>&1; then
    step_pass "pytest passed"
  else
    step_fail "pytest failed (see above)"
    exit 1
  fi
  test_ran=true
fi

# Check for go test
if [ "$test_ran" = false ] && [ -f "$PROJECT_ROOT/go.mod" ] && command -v go &>/dev/null; then
  if go test ./... 2>&1; then
    step_pass "go test passed"
  else
    step_fail "go test failed (see above)"
    exit 1
  fi
  test_ran=true
fi

if [ "$test_ran" = false ]; then
  step_warn "No test framework configured (no package.json test script, pytest, or go test)"
fi

########################################
# 4. Build
#    Vanilla JS served directly — no build step needed.
########################################
printf "\n${BOLD}[4/5] Build${RESET}\n"

if [ -f "$PROJECT_ROOT/package.json" ] && command -v node &>/dev/null; then
  has_build_script=$(node -e "
    const pkg = require('./package.json');
    console.log(pkg.scripts && pkg.scripts.build ? 'yes' : 'no');
  " 2>/dev/null || echo "no")
  if [ "$has_build_script" = "yes" ]; then
    if npm run build 2>&1; then
      step_pass "npm run build passed"
    else
      step_fail "npm run build failed (see above)"
      exit 1
    fi
  else
    step_warn "No build script in package.json"
  fi
else
  step_warn "No build step (vanilla JS — static files served directly)"
fi

########################################
# 5. Vulnerability scan
#    No package manager — vendor libs are manually managed.
########################################
printf "\n${BOLD}[5/5] Vulnerability scan${RESET}\n"

vuln_ran=false

if [ -f "$PROJECT_ROOT/package-lock.json" ] && command -v npm &>/dev/null; then
  if npm audit --omit=dev 2>&1; then
    step_pass "npm audit passed"
  else
    step_fail "npm audit found vulnerabilities (see above)"
    exit 1
  fi
  vuln_ran=true
elif [ -f "$PROJECT_ROOT/package.json" ] && command -v npm &>/dev/null; then
  step_warn "package.json exists but no lock file — run npm install first to enable npm audit"
fi

if [ "$vuln_ran" = false ] && [ -f "$PROJECT_ROOT/requirements.txt" ] && command -v pip-audit &>/dev/null; then
  if pip-audit -r requirements.txt 2>&1; then
    step_pass "pip-audit passed"
  else
    step_fail "pip-audit found vulnerabilities (see above)"
    exit 1
  fi
  vuln_ran=true
fi

if [ "$vuln_ran" = false ]; then
  step_warn "No package manager lock file (vendor libs in lib/ are manually managed)"
fi

########################################
# Summary
########################################
printf "\n${GREEN}${BOLD}All mechanical checks passed.${RESET}\n"
