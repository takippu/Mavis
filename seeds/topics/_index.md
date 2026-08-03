# Topics — retrieval map for past cross-project work

**Purpose:** scan these triggers whenever a prompt touches a topic that might have prior context, BEFORE composing a response. On a match, open that topic's **detail file** (`_details/<slug>.md`) for the Did / Refs / Pre-empt and answer with that context — not from scratch.

**Two-tier:** this index = slug + triggers + a one-line summary (loads whole every session). The substance (Did / Refs / Pre-empt + dated sub-notes) lives in `_details/<slug>.md`, loaded on demand when a trigger fires. Superseded/archived topics are kept as detail files but omitted here.

---
