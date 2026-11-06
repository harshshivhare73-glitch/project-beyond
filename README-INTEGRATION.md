# Project Beyond — Integration Workspace (Assignment 1.6)

Location: `~/workspace/project-beyond-integration/`
Source: a copy of `~/workspace/project-beyond-dev/` at the end of
Assignment 1.4, as independently audited in Assignment 1.5
(71 tests, 65 pass, 1 pre-existing CSP failure, 5 skipped).
Baseline re-run in this workspace before any new code:
71 tests, 65 pass, 1 fail (CSP), 5 skipped — identical.
Log: `test-results-integration-baseline.log`.

## Phase 1 — Integration, conflicts

- No shared integration workspace, Antigravity workspace, or Muse 2
  workspace was found in this environment (only project-beyond-dev
  and project-beyond-qa exist under ~/workspace). Therefore no newer
  Antigravity or Muse 2 changes existed here to overwrite or conflict
  with. No file outside this integration workspace was modified.
- The protected checkpoint, production database, QA baseline, and
  GitHub repository were not touched. No commits, pushes, merges,
  deployments, dependency installs, or paid calls were made.
- Assignment 1.4 fixes are preserved unchanged in artifacts.js,
  orchestrator.js, providers.js, project_builder.js and server.js,
  except for the deliberate additions listed below. Diff counts vs
  the QA baseline will therefore grow only for the new files and the
  new routes; the 1.4 security code itself was not rewritten.

## Files changed / added in 1.6

- Added: `chat.js` (conversations, messages, generation, retry).
- Added: `attachments.js` (validation, storage, SHA-256, retrieval).
- Added: `docs/API.md` (versioned API contract, v1).
- Added: `tests/integration-chat-attachments.test.js` (Phase 7 tests).
- Changed: `providers.js` — Gemini `generateContent` now accepts
  `images` and sends them as `inlineData` (actual bytes), with the
  free-model allow-list enforced for vision; `supportsVision: true`
  is set only because that code exists.
- Changed: `server.js` — chat, conversation and attachment routes;
  `ATTACHMENTS_DIR` env support; multipart/raw upload handling;
  homepage CSP now includes `img-src 'self'` (no `blob:`).
- Changed: `tests/attachments-csp.test.js` — see below. No other
  existing test was weakened or deleted.

## CSP test change (documented, not a greenwash)

The old test asserted the homepage CSP contains `blob:`. That
expectation is superseded by the same-origin preview design in
docs/API.md: attachments are previewed via
`/api/chat/attachments/:id/content` on the same origin, with
validated types and `img-src 'self'`. Adding `blob:` would not make
stored attachments previewable and would weaken the CSP for no
benefit. The test now asserts `img-src 'self'` and, in the new
integration test file, that an actual uploaded image is retrievable
via its content URL with byte-identical content. The old blob:
assertion is removed, and this change is disclosed here and in
docs/API.md, so QA can judge it on its merits.

## Coordination status (honest)

- GPT-6 Technical Lead: final approval pending, as instructed.
  Nothing in this workspace is merged or deployed.
- Muse 2 (Frontend/UX): API contracts are published in docs/API.md
  for their review. No direct coordination channel or Muse 2
  workspace was available in this environment, so finalisation with
  Muse 2 is pending their review, not claimed as done.
- Antigravity (Primary Developer, image/context integration): no
  Antigravity workspace was found here, so no Antigravity work was
  duplicated or overwritten. The vision provider interface in
  chat.js (`supportsVision` + `generateContent({images})`) is the
  integration point for Antigravity's image/context work: any
  provider that truly sends image bytes can set `supportsVision`
  and be used by chat generation without changing chat.js.
- Luna / Old ChatGPT (Architecture / Integration Architect): no
  workspace or channel was available here; their review is pending
  with GPT-6 review.

## How to run

- `node server.js` (port 3000, or PORT env; DB_PATH env for a custom
  database; ATTACHMENTS_DIR env for a custom attachments directory).
- Tests: `node --test --test-concurrency=1 tests/*.test.js`
  (Node built-in runner, no dependencies, mocked providers only).
