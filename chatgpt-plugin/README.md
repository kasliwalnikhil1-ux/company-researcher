# ChatGPT / Codex plugins

One plugin per connector, each = its skill + its MCP server (portable Agent Plugins layout: `plugin.json`, `mcp.json`, `skills/<skill>/`).

| Plugin | Skill | MCP server | Who |
|---|---|---|---|
| `capitalxai` | capitalxai | `…/functions/v1/capitalxai-mcp/mcp` | anyone with a CapitalxAI account |
| `capitalxai-admin` | capitalxai-admin | `…/functions/v1/capitalxai-mcp/mcp` | the two admin accounts only — do not share |
| `capitalxai-crm` | crm | `…/functions/v1/crm-mcp/mcp` | CRM team members |
| `capitalxai-smartlead` | smartlead | `…/functions/v1/smartlead-mcp/mcp` | Smartlead team members |

**Generated — do not edit here.** Edit `claude-skill/<skill>/`, then run `python scripts/skills-build.py`, which rewrites these folders, `dist/*.zip`, the `skills.gen.ts` the servers serve, and the claude.ai skill zips. Redeploy the function afterwards.

## Install

- **ChatGPT (web or desktop)**: Settings → Security and login → turn on **Developer mode**. Then Plugins → **Upload plugin** → `dist/<plugin>.zip`, and sign in with the CapitalxAI account when asked (OAuth).
- **Just the connector**: Plugins → **+** → paste the MCP URL above (Connection: OAuth). The skill still reaches the model: every server has a `read_skill` tool its instructions tell the model to call first.
- **Workspace**: a workspace admin can publish an uploaded plugin to selected roles (Plugins → Personal → ⋯ → Publish). Only publish `capitalxai-admin` to admins.
- **Codex / ChatGPT desktop local marketplace**: point a `marketplace.json` entry's `source.path` at the plugin folder (see OpenAI's "Package your plugin").

## What differs from Claude

- ChatGPT uses tools only — no MCP resources or prompts. The skills say where the equivalent lives (`crm_context`, `standup_brief`, `read_skill`).
- The CRM recording flow cannot run the get-transcript skill's Python locally: `transcribe_recording` transcribes on the server (Deepgram, secret `DEEPGRAM_API`). Developer-mode connectors do not receive chat attachments, so `recording_upload_link` sends the user to the meeting in the app, where an audio or video upload is transcribed on arrival.
- Browser-dependent admin pipelines (LinkedIn research, the Gmail-Compose email search) need ChatGPT agent mode's browser; without one they degrade as the skill describes.
