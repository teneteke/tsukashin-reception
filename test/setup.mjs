/**
 * Vitest setup file — loads project JS into the jsdom global scope.
 *
 * The production code uses classic `<script>` tag globals rather than ES
 * modules. To make the same symbols callable from tests, we read every
 * project JS file, rewrite top-level `let` / `const` declarations to plain
 * assignments on `globalThis`, concatenate everything, and run the combined
 * source through indirect eval in the jsdom realm.
 *
 * Why indirect eval: a direct `eval(code)` call places `let` bindings in the
 * block scope of the eval, which is unreachable from tests. An indirect call
 * (`(0, eval)(code)`) runs the code as a script in the surrounding realm so
 * function declarations and the rewritten assignments attach to globalThis.
 *
 * Why the rewrite: top-level `let x = 1` in a classic script keeps `x` in a
 * script-scope binding that does not leak across separate eval invocations.
 * By converting to `globalThis.x = 1` we make these settings visible across
 * test files.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

/** Load order matches the `<script>` tag order in index.html. */
const JS_FILES = [
  'js/ui-helpers.js',
  'js/db.js',
  'js/repository.js',
  'js/csv.js',
  'js/confirm-dialog.js',
  'js/visitor-list.js',
  'js/individual-detail.js',
  'js/product-master.js',
  'js/receipt.js',
  'js/data-management.js',
  'js/sync.js',
  'js/app.js',
];

/**
 * Rewrite top-level `let X =` / `const X =` into `globalThis.X =` so the
 * binding is visible after indirect eval. Only single-variable declarations
 * at column zero are touched; any `let` inside a block or function keeps
 * its leading whitespace and is left alone.
 */
function promoteTopLevelDecls(source) {
  return source.replace(/^(let|const)\s+(\w+)(\s*=)/gm, 'globalThis.$2$3');
}

const combined = JS_FILES
  .map((file) => fs.readFileSync(path.join(projectRoot, file), 'utf-8'))
  .map(promoteTopLevelDecls)
  .join('\n\n');

/**
 * jsdom sets `window` on globalThis but `document.addEventListener` paths
 * inside app.js run at load. Those listeners are harmless in tests.
 */
(0, eval)(combined);
