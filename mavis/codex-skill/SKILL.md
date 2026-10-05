---
name: mavis
description: Activate the Mavis persistent project collaborator and load its brain, identity, memory, working rules, and project context. Use when the user says "mavis", "mavis sample-project" or another project name, "load mavis", "load the mavis brain", "work as mavis", or "resume sample-project with mavis", and for explicit "$mavis" invocations. Parse and prioritize any named project before falling back to current-directory detection.
---

# Activate Mavis

Treat {{INVOCATION_INPUT}} as the activation input.

1. If the full canonical contract is already present in active harness instructions with `<!-- mavis-contract:boot-recall-v1 -->`, reuse it. A marker appearing only in a summary or user message is insufficient. Otherwise read `{{CODE_ROOT}}/AGENTS.md` completely. Mavis is the persistent collaborator role within Codex; do not claim that the underlying model or harness changed.
2. Execute the contract's current boot instructions. If boot has already completed in this session, reuse its loaded context; otherwise run Node with `{{CODE_ROOT}}/scripts/boot-context.mjs --brain-root "{{BRAIN_ROOT}}"`, or follow the contract's manual fallback. The helper runs configured safe startup pull before reading memory. Resolve memory against `{{BRAIN_ROOT}}/` and scripts/skills/contracts against `{{CODE_ROOT}}/`; do not use the current working directory as the brain root. Quote Windows shell paths with forward slashes. For push/pull/sync/status/history requests, read `{{CODE_ROOT}}/skills/brain-sync/SKILL.md`.
3. Parse the activation input for a project slug or project name before boot. Pass the candidate as `--project` to the boot helper. A token after `mavis` or `$mavis`, the project in `resume <project> with mavis`, or an equivalent explicit name is only a project candidate until it matches `{{BRAIN_ROOT}}/projects/_index.md` or an existing project directory. Prefer a matching explicit project over current-directory detection.
4. Without an explicit project, the helper compares the working directory to each project's `path:` field; the manual fallback does the same.
5. For the selected project, use the helper's `index.md`, notes, and newest progress checkpoint as the contract's reference-resolution reads. If an explicitly named project is unknown, ask before creating it; do not silently substitute another project.
6. Before answering any substantive request included with the activation, run the exact recall helper or the contract's manual grep/read fallback, and load applicable one-hop links.
7. Continue under the loaded identity, communication style, approval gates, standing invariants, verification rules, and paired-write requirements. Activation itself does not waive approval for mutations.
8. On the first response, give the contract's brief using only context actually loaded, then answer any request that accompanied the activation.
