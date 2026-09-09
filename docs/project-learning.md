# Memory Learning

Memory Learning stores reviewed knowledge in two complementary layers: a **user coding profile** (GLOBAL) and **this repository's briefing, notes and procedures** (PROJECT). It does **not** train the model, diagnose you, run saved commands, or prove improved coding quality.

## Try it

1. Open a trusted project. In **Settings → Memory Learning**, turn the master switch on, then enable **GLOBAL**, **PROJECT**, or both. Save. All three default off/on as: master **off**, layers **on** once the master is enabled.
2. Open **Learning** from the composer, or **Manage lessons, drafts & recent use** from Settings. Settings also lists the exact files on disk.
3. Edit **GLOBAL** as **User profile**: communication, workflow, coding/design preferences, decision-making, learning style, likes and dislikes. Approve only explicit preferences you stated. Fate UI does not infer a psychological profile.
4. Edit **PROJECT** as a **Project briefing** (purpose, architecture, decisions, current work, next steps) plus ordinary notes and procedures. Use **Add lesson** for task-specific project knowledge.
5. Save a manual draft without a provider, or generate one from reviewed evidence. Generation is one tool-free request to the previewed model and can incur cost. Sending evidence is not approval.
6. Set each store's selection mode to **Automatic** if you want that store's reviewed core memory reused on later sessions without picking it again. Manual remains the default. After a new session, **Recent use** shows the actual attached revisions.

## Switch, scope, and modes

The Settings switch overrides both stores. Off prevents new captures, generation, and attachments; stored data remains manageable and is not deleted.

- **GLOBAL · user coding profile:** `learning/v1/global/current.json` under the Fate UI data directory. One reviewed profile per Fate UI data root. It can be reused across trusted projects. It is not a personality model. Repository facts, architecture and task state do not belong here. Legacy shared notes in this store stay visible but are not attached automatically until you convert and approve them as profile preferences.
- **PROJECT · repository memory:** `learning/v1/projects/<canonical-root-hash>/current.json`. Isolated by the trusted canonical directory, not folder name or Git remote. Separate clones and linked worktrees have separate stores. Moving a repository does not migrate its knowledge. The briefing orients later sessions; notes and procedures still use lexical activation.

On Windows with no `FATE_GUI_DATA_DIR` override, the master toggle lives in `%USERPROFILE%\.pi\fateGUI\settings.json` and the two stores sit beside it under `learning\v1\`. Settings shows the resolved paths for this machine. Nothing is written into the git repository.

Changing the editing scope never copies, merges, or promotes knowledge. Each store has **Off**, **Manual** (initial), and **Automatic**. Automatic core memories (the profile and the briefing) can attach without keyword matching. Ordinary project notes still need a score of at least 2 from exact task-path match +4, symbol match +3, or nontrivial keywords +1 (capped at +3). Common words and substring matches are excluded. Declared paths and branch restrictions remain hard filters. Project briefings that list current work or next steps require review after seven days. Project-specific guidance outranks a general preference when they differ. Current user instructions always win.

At most three complete items and 6 KiB of UTF-8 advisory context are supplied. Procedures are skipped whole, never cut midway through a step. Token counts are explicitly estimates (`ceil(UTF-8 bytes / 4)`); this adapter has no compatible exact tokenizer. Model permissions and current user instructions remain authoritative.

## Evidence and provider data

The message action opens a review form; it does not contact a model. Message-row text uses the **user-asserted** fallback because renderer row IDs are not durable SDK entry IDs. Exact capture uses the durable entries listed in the open session. Open a saved session first to capture its entries; selected branches are reconstructed read-only through Pi's parser and in-memory session manager.

Runtime entry previews exclude hidden reasoning and include only selected visible text. Secret-like filtering helps but is not comprehensive. Edited source text is labelled user-asserted. Tool output being captured is not proof that a test passed against the present code. Test exit status/code-state association remains unknown unless supported; this version never infers it from prose or a nearby timestamp.

Captures allow six sources, 16 KiB total stored text, a 16 MiB saved-session input, and 1 MiB per selected source file. Capture has a five-second deadline and cancellation. Ordinary session opening is unchanged. Oversized, binary, damaged, or unsafe evidence can be replaced with manual text. No repository-wide evidence scan or background transcript mining runs.

Generation sends the versioned extraction instructions, your correction, selected scope and the accepted redacted evidence as JSON. It uses the already configured model shown in the preview, not a new agent session, and has no tools. There is a 32 KiB extraction-input bound, bounded output, a 60-second deadline, cancellation, no automatic retry, no fallback model, and no semantic-repair request. Invalid output and `no_lesson` never activate knowledge. The capture remains available for manual editing. A late response cannot recreate deleted data or overwrite a newer store revision.

Usage is separate from the coding turn. Missing or ambiguous cost is **unknown**, not zero. A cancelled request may still have been billed. In a deletion/concurrent-edit race, late usage metadata can be discarded rather than resurrecting the deleted store.

## Review, freshness, and forgetting

Approved revisions are immutable. Editing creates a replacement draft while the previous revision remains active. Reusing old content requires a new approval, not silently restoring an old pointer. Exact duplicates and lexical overlaps are warnings, not automatic merges or proven contradictions. Mark conflicting lessons to exclude them until you explicitly resolve the conflict.

File evidence is hashed and checked again at dispatch. Changed, missing, unsafe or oversized dependencies require updated evidence and a new reviewed revision. Removing evidence also blocks reuse. Approval is labelled **Approved by you**, not “verified.” A successful coding turn does not promote or refresh anything.

**Disable** keeps history but prevents new use. **Delete lesson** removes its revisions, related drafts and orphan evidence. **Delete evidence** removes source text and requires dependent lessons to be reviewed. **Reset selected learning scope** removes that store's settings and data after typing `DELETE LEARNING`.

None of these actions retracts provider requests, erases existing Pi conversations or model echoes, deletes exported copies, or clears OS backups. Start a fresh session to avoid historical context. This is not secure erasure.

## Dispatch records

Learning is attached only through the root user-turn adapter, not installed as child skills or placed in the system prompt. Queue records contain exact revision references, not cached learning text. Final selection happens at the runtime's provider boundary. Stale explicit items block that dispatch and leave a recoverable editable draft; optional automatic items are skipped without blocking the coding request.

The advisory block is ephemeral provider context. It does not alter persisted user/assistant messages or signed reasoning. Retries and tool-loop requests reuse one prepared block and dispatch identity. Output-length continuation does not create another manifest. Final settlement, replacement, fork, and new-session paths do not replay old prompts to inject learning.

Recent use records dispatch/project/session identity, exact revision IDs and digests, selection reasons, skips, byte count, token estimate, and delivery state. **Handed to runtime** does not prove provider receipt. **Prepared** after interruption means delivery may be uncertain. No crash recovery automatically resends a turn. Deleted revisions are labelled as deleted in retained metadata; raw evidence and lesson titles are not copied into manifests.

## Storage, limits, and recovery

The master toggle and editing-scope preference persist in `<FATE_GUI_DATA_DIR or ~/.pi/fateGUI>/settings.json`. Reviewed memories persist in `<same data root>/learning/v1/global/current.json` and `<same data root>/learning/v1/projects/<canonical-root-hash>/current.json`. Capturing does not modify project files, `.gitignore`, `AGENTS.md`, or Pi's shared resource directory. Settings → Memory Learning shows the resolved paths.

Each snapshot is limited to 8 MiB, 100 lessons, ten revisions per lesson, and 100 total retained drafts (including approved/rejected draft records). Delete reviewed drafts when needed; approved revisions are never silently pruned. Up to 500 non-content manifests are retained, with 30-day expiry applied on the next mutation. Generation usage retains its last 100 entries. In-memory previews expire after 30 minutes and are limited to 16.

Writes use a per-store process queue, an exclusive `writer.lock` directory, on-disk epoch/revision comparison, a unique same-directory temporary file, file flush, atomic replacement, and directory flush on POSIX. Windows lacks the same directory-fsync primitive. Another process cannot overwrite a stale revision. This is ordinary crash/concurrent-writer safety, not protection against a hostile process with the same OS-user authority; Full access is unsandboxed.

A live or uncertain lock is never stolen because of age. **Recover dead writer lock** verifies host, PID death, and the exact lock preview. PID reuse conservatively blocks recovery. Missing/malformed owner records, unsafe links, or inaccessible/oversized stores require manual recovery after closing all app processes and backing up the affected learning directory. Never remove a live writer's lock. Abandoned temporary files are not loaded as snapshots; remove only known abandoned files while all writers are stopped.

Invalid JSON, unsupported versions, mismatched identity and unsafe file targets disable writes and use without replacing the original bytes. A small regular corrupt store can be explicitly reset against its preview digest. Reset loses that store's data. There is no automatic schema downgrade or store migration.

## Evaluation and non-goals

See [implementation and verification](project-learning-implementation.md) and the [offline evaluation guide](../scripts/agent-evals/README.md). Deterministic tests establish engineering behavior, not model benefit. Live benefit and provider-specific smoke results are currently **unmeasured**; no provider was called during implementation checks.

Managed procedures render readable Markdown, but are not native Pi skills. Export, native `SKILL.md` installation, cross-store migration, vector search, autonomous approvals, agent-owned learning tools, training, cloud sync, and automatic command execution are not included.
