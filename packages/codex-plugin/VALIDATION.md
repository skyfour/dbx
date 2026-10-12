# Native plugin validation

Local acceptance: 2026-10-10, macOS ARM64, Node.js 24.21.0 and Rust 1.99.0 for build/test tooling. Runtime programs were launched from the actual Codex plugin cache, not the source checkout. DBX desktop was not running.

| Check | Result |
| --- | --- |
| Frontend full Vitest suite | 1,732 files / 21,218 tests passed |
| Frontend typecheck and production build | Passed |
| MCP library suite | 205 tests passed |
| Full-feature embedded Web suite | 166 unit tests and 1 HTTP integration test passed; 1 pre-existing ignored test |
| Native runtime/gateway suite | 20 tests passed, including two child-process fixture entrypoints |
| Native packaging suite | 5 tests passed |
| Windows private-file implementation and tests | Cross-compiled for x86_64-pc-windows-msvc; not executed locally |
| Workflow YAML | Parsed; six native targets and packaged acceptance step verified |
| Native multi-platform CI | Workflow supplied; not run as part of local acceptance |

The native protocol tests exercise tool/resource/template pagination, unchanged backend denial, resource content, resource-list notifications, progress token mapping, cancellation exactly once, expired HTTP sessions without write retries, upstream DELETE on client disconnect, bootstrap tools and explicit stop confirmation. Runtime tests exercise concurrent launchers, process survival, isolated directories, mismatched/foreign services, missing programs, credential permissions and persistence.

## Packaged end-to-end

The plugin archive was relocated through a path containing spaces, registered using `codex plugin marketplace add`, and installed using `codex plugin add dbx@dbx-local`. The Codex MCP loader resolved the relative executable and working directory to the installed cache. The final build was reinstalled after review fixes.

`scripts/verify-codex-plugin.mjs` passed against the installed cache while the checkout's `dist` directory was temporarily moved away and restored in `finally`. This proves the workbench's HTML and JS are embedded in the packaged executable. The verifier checks first-setup gating, two clients sharing one service, survival after one client exits, 150 SQLite rows with 6,000-character original cells, multiple result sets, unauthenticated intent rejection, read-only denial, exactly-once writes, repeated intent fetches without SQL replay, explicit stop, and password/connection/encryption-key preservation after restart. It executes a fresh query after restart.

## Codex browser acceptance

The actual Codex in-app browser passed these manual checks against the installed native plugin using disposable local data:

- Login with an MCP result URL preserves its intent and automatically opens both original result sets.
- SQL editor executes a SELECT and renders three rows with the expected original text lengths.
- SQLite table browsing loads the second page (50 remaining rows of 150).
- Editing and committing a cell persists the change in SQLite.
- CSV import previews/maps/appends a new row; the UI reports `1 / 1`, and a direct SQLite assertion confirms it.
- Exporting the current query page creates a CSV with the expected header and three rows.
- A long-running read-only recursive query is cancelled through **Stop query**; the running task count returns to zero.

Independent review found and corrected a batch-tool allowlist bypass, unawaited upstream protocol cleanup, and a restart-wait race. Both substantive defects have failing-before/passing-after regressions. Browser acceptance additionally found and corrected loss of result intent during login, covered for both root entry and `/login` reload. The reviewer rechecked the fixes and found no remaining important defect.

Only SQLite was live-connected. Other database servers, third-party DBX plugins/driver agents, Windows/Linux runtime behavior and release signing are not claimed as locally verified. See the capability matrix and platform gates in the README.

## Native MCP App replacement — 2026-10-12

The HTTP iframe attempt above was incompatible with the installed Codex host. Its CSP normalizer and sandbox network filter reject ordinary loopback HTTP. The browser acceptance recorded above applies to the earlier Web UI, not the sidebar implementation below.

The current sidebar resource bundles the full existing Vue workbench, workers, fonts and icons (145 assets, approximately 12.5 MB compressed HTML). It has no HTTP iframe, external script, browser redirect or network allowlist. An app-only native MCP tool carries bounded binary HTTP uploads/responses, SSE and Redis WebSocket messages. The password session cookie stays in the gateway. Downloads use private files in the data directory's `exports` folder; confirmations use in-panel dialogs because the host disables native dialogs and downloads.

Current local checks:

- Native gateway/runtime and UI transport: 24 passed, including private session isolation, binary uploads, encoded path validation, large text/binary WebSocket messages, disposal and private exports.
- Web backend: 166 unit tests plus 1 HTTP integration test passed; 1 pre-existing ignored test.
- Frontend typecheck and standalone MCP UI build passed. Full rework regression: 1,734 files / 21,225 tests passed. A subsequent full run after review fixes passed 21,227 tests with one Redis infinite-scroll timing failure; the unchanged Redis spec then passed all 56 tests on rerun. Additional focused tests cover repeated void HTTP responses, native Mongo archive upload, auth paths, failed exports and stream cancellation.
- Build/packaging self-checks: 7 passed, including JavaScript syntax, worker asset rewriting and rejecting missing/iframe UI packages.
- The packaged native verifier passed with an actual 12.5 MB MCP resource, private native login, native export, SQLite, policy denials, exactly-once writes and restart persistence.
- Independent review found and fixed an XHR upload path outside the native transport, unconsumed response leaks and over-restrictive encoded paths; focused regressions passed.

The new package is installed in the local Codex cache. Actual left-rail rendering/login remains pending a Codex host UI check; protocol, build and HTTP checks alone do not establish that the visible sidebar works. No host security policies were modified. Only macOS ARM64 and SQLite were live-tested; other platform and database gates above still apply.
