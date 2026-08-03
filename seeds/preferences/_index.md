# Preferences — retrieval map for how the user likes to work

**Purpose:** scan these triggers whenever a prompt touches how the user works (tone, git, UI, standup, deploy, workflow). On a match, open that entry's **detail file** (`_details/<slug>.md`) for the Rule / Why / How to apply, then act on it.

**Two-tier:** this index = slug + triggers + a one-line summary (loads whole every session). The substance lives in `_details/<slug>.md`, loaded on demand when a trigger fires. Superseded entries are kept as detail files but omitted here.

---
