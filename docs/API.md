# Project Beyond — Chat & Attachment API, version 1 (Assignment 1.6)

Base: the local server only, `http://127.0.0.1:3000` (or the PORT set at
startup). All non-GET API calls require the header
`X-Requested-With: beyond`, the same pattern as the existing task routes.
All responses are JSON unless stated otherwise. Error shape:
`{ ok: false, error: "<message>", code: "<CODE>" }` where `code` is present
for chat/vision errors.

## Security boundary (read this first)

- The server binds to 127.0.0.1 only and rejects other Host headers.
  There is no multi-user authentication in this foundation. "Unauthorized
  attachment access" in this API means cross-conversation access: an
  attachment owned by conversation A cannot be attached to a message in
  conversation B (403), and an attachment id that does not exist or does
  not match `att_[0-9a-f]{32}` is rejected (400/404), never used as a path.
  Do not expose this server to a network without adding authentication.
- No paid provider is ever called without explicit approval. Chat routes
  always pass `allowPaid: false`. Gemini vision/text use only the verified
  free model `gemini-flash-lite-latest`. Unknown or paid models are
  rejected before any provider call.
- Attachments are stored by id, never by user-supplied filename, with no
  extension, under the attachments directory (default `<server>/attachments`,
  overridable with `ATTACHMENTS_DIR` for tests). Retrieval verifies path,
  size and SHA-256 before serving bytes.

## Conversations

### POST /api/conversations
Body: `{ "title": "Optional, 1-100 chars" }` (title optional, defaults to
"New conversation"). Response 201: `{ ok: true, conversation: { id, title, created_at, updated_at } }`.

### GET /api/conversations
Response: `{ ok: true, conversations: [ { id, title, created_at, updated_at, message_count } ] }`, newest updated first.

### GET /api/conversations/:id
Response: `{ ok: true, conversation: { id, title, created_at, updated_at, messages: [...] } }`. Messages are ordered by id ascending (authoritative order).

### PATCH /api/conversations/:id
Body: `{ "title": "New title, 1-100 chars" }`. Response: updated conversation.
Rename is the only field that can be changed this way.

### DELETE /api/conversations/:id
Deletes the conversation, its messages, and its owned attachments (rows
in one transaction, files best-effort after commit). Response:
`{ ok: true, deleted: { deleted: true, id, attachmentIds: [...] } }`.

## Messages

### GET /api/conversations/:id/messages
Response: `{ ok: true, conversation_id, messages: [...] }`.

### POST /api/conversations/:id/messages
Body: `{ "role": "user" (default), "content": "...", "attachment_ids": ["att_..."], "model": null }`.
- Content must be 1-20000 chars, unless attachments are present.
- An attachment owned by another conversation is rejected with 403.
- An unassigned attachment is claimed by this conversation in the same
  transaction as the message insert.
Response 201: `{ ok: true, message: { id, conversation_id, role, content, attachment_ids, model, created_at, edited_at } }`.

### PATCH /api/conversations/:id/messages/:messageId
Body: `{ "content": "Edited text, 1-20000 chars" }`. Sets `edited_at` and
updates the conversation's `updated_at`. Editing a user message does not
automatically regenerate an assistant reply; use retry for that.

### POST /api/conversations/:id/messages/:messageId/retry
Only for assistant messages. Generates a new reply from the history
*before* that message, using the same vision/text logic as /api/chat.
The old message is deleted only after generation succeeds, so a failed
retry does not lose the original answer. Response:
`{ ok: true, message: <new assistant message>, images_used: [...], model }`.

## Chat (main flow for Muse 2 frontend)

### POST /api/chat
Body: `{ "conversation_id": 1 (optional; a new conversation is created if omitted), "content": "...", "attachment_ids": ["att_..."], "title": "Only used when creating a conversation" }`.
Flow:
1. The user message is saved first, with its attachment references.
2. An assistant reply is generated:
   - If any message in the last 20 messages has image attachments, the
     actual image bytes are loaded from storage, verified by SHA-256,
     and passed to a vision-capable provider as `inlineData` (base64 +
     mime type). The provider never receives only a filename or URL.
   - Follow-up questions work without re-uploading: image references
     are preserved in message history, and generation re-loads them.
   - If no images are present, text generation tries Gemini free model,
     then local Ollama if Gemini has no key.
3. On success, the assistant message is saved and returned:
   `{ ok: true, conversation_id, user_message, assistant_message, images_used, model }`.
4. On failure, the user message stays saved, NO assistant message is
   saved, and an error is returned. Error codes:
   - `VISION_NOT_AVAILABLE` (503): no provider in code declares vision
     support. The image is saved, but no image answer can be generated.
   - `PROVIDER_ERROR` (502): a vision provider exists but failed, e.g.
     `GEMINI_API_KEY is not set`, auth error, or quota error. This is
     not a vision-capability lie; it is the provider's actual error.
   - `PROVIDER_UNAVAILABLE` (503): no text provider could generate a
     reply. Again, no fake answer is saved.

Note for Muse 2: do not render a filename-only answer as an image
inspection. If the API returns one of the codes above, show the error
and the saved user message, and offer retry. Do not invent an answer.

## Attachments

Limits: max 10 MB per file. Allowed types: image/png, image/jpeg,
image/gif, image/webp, application/pdf, text/plain, text/markdown.
SVG is rejected (it can contain scripts). File signature (magic bytes)
must match the declared type; a mismatch is rejected. Filenames are
sanitised (basename, unsafe characters replaced, max 100 chars).

### POST /api/chat/attachments
Two upload forms, both require `X-Requested-With: beyond`:
- Multipart: `multipart/form-data` with a `file` part (standard browser
  FormData) and an optional `conversation_id` text field. The boundary
  is case-sensitive and is read from the original header.
- Raw binary: whole body is the file, with `Content-Type` as the file
  type, `X-Filename` as the filename, and optional `X-Conversation-Id`
  or `?conversation_id=` query.
Response 201: `{ ok: true, attachment: { id, conversation_id, filename, original_filename, content_type, size, sha256, created_at } }`.
Errors: 400 (empty, unknown type, signature mismatch, no file part),
413 (over limit), 404 (conversation_id does not exist).

### GET /api/chat/attachments?conversation_id=:id
Lists attachments, optionally filtered by conversation. Response:
`{ ok: true, attachments: [...] }`.

### GET /api/chat/attachments/:id
Metadata only. Response: `{ ok: true, attachment: {...} }`.

### GET /api/chat/attachments/:id/content
Returns the actual file bytes, after path, size and SHA-256 verification.
Headers: `Content-Type` is the validated type, `X-Content-Type-Options:
nosniff`, `Cache-Control: private, no-store`,
`Content-Security-Policy: default-src 'none'; sandbox`,
`Content-Disposition: inline` by default, or `attachment` with
`?download=1`. This is the preview mechanism: use this same-origin URL
in `<img src>` or a download link, never a `blob:` URL for a stored
attachment. If the file is missing or corrupt, the endpoint returns
500, never a placeholder.

### DELETE /api/chat/attachments/:id
Deletes the row and the file (file best-effort). Response:
`{ ok: true, deleted: "<id>" }`.

## Attachment CSP (Phase 5)

Homepage CSP (server.js, homepage handler) is now:
`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'`
- `img-src 'self'` was added; `blob:` was NOT added. This is not a
  weakening to make a test pass: it is the secure preview design.
  `blob:` previews are client-side object URLs that disappear on
  refresh and are not server-verified. Same-origin content URLs are
  persistent, server-validated (type, size, hash), and restricted to
  this origin only. A `blob:` URL from a different origin or from
  unvalidated data would be weaker, not stronger.
- The old QA test that asserted `blob:` in the CSP is therefore
  superseded by the same-origin design. In this integration workspace
  that test is updated to assert `img-src 'self'` and to verify an
  actual uploaded image can be retrieved via its content URL.
  See tests/integration-chat-attachments.test.js.
- Attachment content responses carry their own `default-src 'none';
  sandbox` CSP, so even a PDF or text file cannot execute scripts
  from the content origin.

## Database migrations

No separate migration files are needed for SQLite: on startup the
server runs `CREATE TABLE IF NOT EXISTS` for `conversations`,
`messages` and `attachments` (chat.js `initChatTables`,
attachments.js `initAttachmentsTables`), plus an index on
`messages(conversation_id, id)` and `attachments(conversation_id)`.
Existing tasks/logs/settings tables are untouched. Before any future
migration that changes existing rows, take a backup via
`GET /api/backup` and confirm it, as with the existing reset flow.

## Limitations (do not overstate)

- Resumable upload is NOT implemented. A failed upload must be retried
  in full. Multipart bodies are bounded to 10 MB in memory; raw binary
  uploads are streamed to disk in chunks up to the same limit.
- Vision requires a configured Gemini key for the free model. Without
  it, image questions return an honest provider error, not an answer.
  Vision has been verified at the provider-function level with mock
  fetch (see tests), not with a live Gemini call, because no key is
  available in this environment and no paid call is allowed.
- Attachment content is served after full SHA-256 verification, so
  retrieval time is linear in file size (bounded by the 10 MB limit).
- The server is localhost-only with no multi-user auth. Do not expose
  it to a network without adding authentication and per-user ownership.
- Frontend UI for conversations, chat and attachment previews is
  Muse 2's work. This workspace provides the backend APIs and the
  homepage CSP change only; it does not ship a new chat frontend.
  The API contracts above are published for Muse 2, and finalising
  them with Muse 2 is pending their review, because no Muse 2
  workspace or channel was available in this environment to coordinate
  with directly. No Muse 2 or Antigravity file was modified.
