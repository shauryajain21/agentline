# agentline

Share a Claude Code or Cursor session with a teammate's agent. When you say "share this session with bob", your agent sends the conversation (end-to-end encrypted, secrets redacted). Bob's agent can then search and read it to answer anything about what you did — without you writing it up or being online.

```
 your Claude Code ──MCP──▶ agentline (local) ══WebSocket══▶ hub ◀══WebSocket══ agentline (local) ◀──MCP── bob's Claude Code
   "share this session"        encrypts + redacts           (relay; sees only          query_session: search / read
                                                               ciphertext)
```

- **Only when you ask.** Nothing is shared automatically: no background sync, no summaries, no file activity.
- **Just this session.** `share_session` sends the conversation you're in — prompts, replies, tool calls and trimmed tool output. Thinking and subagent side-threads are left out.
- **Secrets redacted** before anything leaves your machine: API keys (OpenAI, Anthropic, GitHub, Slack, AWS, Google), JWTs, private keys, agentline invites, and `KEY=value` / `token: ...` assignments.
- **Queryable offline.** Bob's agent reads its own decrypted copy, so it works when you're away.
- **Share again** to send the latest version; it replaces the old copy.

## Agent tools

| Tool | Use |
|---|---|
| `share_session` | Share the current session (`to` one teammate or everyone, optional `title`). Only when the human asks. |
| `shared_sessions` | List sessions teammates have shared. |
| `query_session` | `query` → best-matching entries (each with the entry after it); `entries: "40-60"` → that range in full; neither → outline of every prompt plus the latest entries. |
| `permissions` | See members; approve or remove one. |

Hooks (Claude Code): `SessionStart` and `UserPromptSubmit` record which transcript is the current session, and mention newly shared sessions once. They never send anything.

## Quickstart (two people, ~3 minutes)

Requires Node ≥ 22.13 (uses built-in `node:sqlite`).

```bash
git clone https://github.com/shauryajain21/agentline && cd agentline
npm install && npm link      # gives you the `agentline` command
```

**1. Run a hub** — anywhere both of you can reach. Deploy the `Dockerfile` (Railway/Fly.io/Render; mount a volume at `/data`, expose port 8787), or run `agentline hub --port 8787` behind ngrok/Tailscale. Use `https://` for anything over the internet.

**2. You create a room:**

```bash
agentline init --hub https://your-hub.example.com --name alice --alias team
```

It prints an invite (`agentline1.…`). Send it to your teammate privately — it contains the room key.

**3. Teammate joins, you approve:**

```bash
agentline join agentline1.… --name bob      # teammate
agentline approve bob                       # you (or ask your agent: "approve bob")
```

**4. Both of you wire it into Claude Code:**

```bash
agentline install            # Claude Code: MCP server (user scope) + 2 hooks in ~/.claude/settings.json (backs it up first)
agentline install --cursor   # also Cursor: adds the MCP server to ~/.cursor/mcp.json
```

Restart Claude Code / Cursor. Then, in any session: *"share this session with bob"*. Bob asks his agent: *"what did alice decide about pagination?"*

`agentline doctor` checks the setup.

## Security model

- Room secret (32 random bytes) → HKDF → keys: **enc** (AES-256-GCM for every payload) and **auth** (proves the invite to the hub; the hub stores only its SHA-256).
- The hub sees: room id, member names, message sizes/timestamps, who-sent-to-whom. Not content.
- Each member gets their own bearer token (revocable). `~/.agentline/config.json` is `0600`; the local replica (`~/.agentline/rooms/<id>/local.db`) is plaintext on your own disk.
- A direct share (`to: bob`) is only delivered to bob, but every member holds the room key: use one room per group of people you trust with each other's sessions.
- Redaction is pattern-based. It catches common key formats, not every secret — don't share a session where you pasted something sensitive that doesn't look like a key.
- Revoking a member stops hub access but they keep the room key and anything already shared: for a hard reset, create a new room.

## Limits

- A shared session must fit one message (~1 MB compressed). Long tool output is trimmed first; for very long sessions the oldest entries are left out (the share says how many).
- Cursor: "this session" is the most recently updated agent conversation for the open folder (`~/.cursor/projects/<folder>/agent-transcripts/`). Cursor doesn't save tool output, so shares from Cursor contain prompts, replies and tool calls only.

## CLI

```
agentline hub | init | join | approve | revoke | install [--cursor] [--dry-run] | uninstall
agentline invite | rooms | use <room> | doctor | team
agentline mcp | hook <Event>     (launched by Claude Code)
```

Env: `AGENTLINE_HOME` (default `~/.agentline`), `AGENTLINE_ROOM` (pick a room per project).

## License

MIT
