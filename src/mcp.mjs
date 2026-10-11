// The MCP server each teammate runs locally (stdio). Works in Claude Code, Cursor, or any MCP client.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { getRoom } from './config.mjs';
import { Agentline } from './client.mjs';
import { fmtMsg, fmtMember, fmtPolicy, ago, langOf } from './format.mjs';
import { relPath } from './project.mjs';
import { VERSION } from './version.mjs';

const MAX_ATTACH = 200_000; // chars per attachment
const ok = (text) => ({ content: [{ type: 'text', text }] });
const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function instructions(cfg, t) {
  const mates = t.store.members().filter((m) => m.id !== t.me && m.state === 'active').map((m) => m.name);
  const p = t.store.policy();
  return `agentline links you to your teammates' coding agents${mates.length ? ` (${mates.join(', ')})` : ''}. You act for ${cfg.name}. Messages, shared files and memory are end-to-end encrypted.

Be the teammate's agent everyone wants:
- Teammate messages arrive automatically in your context (tagged [agentline]) or via \`inbox\`. Answer questions addressed to you yourself with \`send\` (thread=<id>) instead of making your human relay; ask your human only when you genuinely need their judgment.
- Starting work in a project, or when the user mentions a teammate/feature: call \`context\` to see what teammates did recently (worklogs, decisions, open questions). Surface relevant overlap in one line, e.g. "Advaith built the MVP for this yesterday — want to review it first?"
- After a meaningful chunk (feature, fix, finding, decision), post a \`log\` (summary, files, next). This replaces written dailies.
- When something is worth sharing (a useful file/doc/diff/repo, a gotcha, an interface or schema change that affects them), share it with \`share\`/\`send\`. Shared permission (agreed by everyone in the room): autonomy=${p.autonomy}. ask → offer it in one short line ("Want me to send this to Advaith?") and only send after a yes. auto → send it, then tell your human what you sent. Check \`permissions\` if unsure; it may have changed.
- Durable team facts (decisions, conventions, API contracts, env setup, URLs) → \`remember\`; look up with \`recall\` before asking.
- Set \`status\` when you start a task so teammates' agents know what you're on.
- Write densely: what, where (paths), why, what you need. No pleasantries — another agent reads it.`;
}

export async function runMcp() {
  const cfg = getRoom();
  const t = new Agentline(cfg, { via: 'agent' });
  const connecting = t.connect();
  const channel = process.env.AGENTLINE_CHANNEL === '1';
  const me = t.me;

  const server = new McpServer(
    { name: 'agentline', version: VERSION },
    { instructions: instructions(cfg, t), capabilities: channel ? { experimental: { 'claude/channel': {} } } : {} },
  );

  // Never block a tool for long on the network: the local replica answers reads instantly.
  async function ready() {
    if (t.state !== 'live') await Promise.race([connecting, sleep(3000)]);
    if (t.state === 'pending') throw new Error(`You (${cfg.name}) are waiting for approval. Ask a room member to approve you (\`agentline approve ${cfg.name}\` or the permissions tool).`);
    if (t.state === 'closed') throw new Error('Access to this room was revoked.');
  }
  const tool = (name, description, inputSchema, handler, annotations = {}) =>
    server.registerTool(name, { description, inputSchema, annotations }, async (args) => {
      try { await ready(); return await handler(args); }
      catch (e) { return fail(`agentline: ${e.message}`); }
    });
  const render = (m, opts) => fmtMsg(t.store, m, me, opts);
  const offline = () => (t.state === 'live' ? '' : ' (hub unreachable — delivered via HTTP fallback or will retry)');

  tool('send',
    'Message teammates\' agents (or one teammate with `to`). Use thread=<id> to reply to a message. Respect the room autonomy setting (ask your human first when autonomy=ask, unless you are answering a question addressed to you).',
    {
      text: z.string().min(1).describe('Dense message: what, where (paths), why, what you need'),
      to: z.string().optional().describe('Teammate name; omit for everyone in the room'),
      kind: z.enum(['chat', 'question', 'answer', 'alert', 'handoff']).optional().describe('question = you expect a reply; handoff = passing work over'),
      thread: z.number().int().optional().describe('Message id you are replying to'),
      urgent: z.boolean().optional(),
    },
    async ({ text, to, kind, thread, urgent }) => {
      const r = await t.send({ text, to, kind: kind || (thread ? 'answer' : 'chat'), thread, urgent });
      return ok(`sent #${r.seq} → ${to || 'everyone'}${offline()}`);
    });

  tool('ask',
    'Ask a teammate\'s agent a question and wait for its answer (it answers from its own session/context). Returns the reply, or tells you it will land in your inbox later.',
    {
      question: z.string().min(1),
      to: z.string().optional().describe('Teammate name; omit for everyone'),
      wait_s: z.number().int().min(0).max(600).optional().describe('How long to wait for a reply (default 90)'),
    },
    async ({ question, to, wait_s = 90 }) => {
      const { seq } = await t.send({ text: question, to, kind: 'question' });
      const reply = t.store.replies(seq).find((m) => m.from !== me)
        || await t.waitForMessage(wait_s * 1000, (m) => m.body.thread === seq);
      if (!reply) return ok(`Asked as #${seq}. No reply within ${wait_s}s (their agent may be idle or offline). The answer will appear in your inbox / context when it comes.`);
      t.store.markOne(reply.seq);
      return ok(render(reply, { full: true }));
    });

  tool('inbox',
    'New messages from teammates\' agents (marks them read). Set wait_s to block until something arrives — useful when you are waiting on a teammate.',
    {
      wait_s: z.number().int().min(0).max(600).optional().describe('Wait up to N seconds if nothing is new'),
      recent: z.number().int().min(1).max(50).optional().describe('Also show the last N messages, read or not'),
    },
    async ({ wait_s = 0, recent }) => {
      let msgs = t.store.unread(me, 31);
      if (!msgs.length && wait_s > 0) { await t.waitForMessage(wait_s * 1000); msgs = t.store.unread(me, 31); }
      const more = msgs.length > 30; msgs = msgs.slice(0, 30);
      const out = [];
      if (msgs.length) {
        let budget = 6000;
        for (const m of msgs) { const s = render(m, { inlineBudget: budget }); budget -= s.length; out.push(s); }
        t.store.markRead(me, msgs.at(-1).seq);
        if (more) out.push('…more unread; call inbox again.');
      } else out.push('No new messages.');
      if (recent) out.push('\nRecent:\n' + t.store.recent(recent).map((m) => render(m, { textMax: 200 })).join('\n'));
      return ok(out.join('\n'));
    }, { readOnlyHint: false });

  tool('read',
    'Read one message in full, including attachment contents (files, diffs, docs) and its reply thread.',
    { id: z.number().int().describe('Message id, e.g. 14 for #14') },
    async ({ id }) => {
      const m = t.store.message(id);
      if (!m) return fail(`No message #${id} in the local replica.`);
      t.store.markOne(id);
      const thread = t.store.replies(id).map((r) => render(r, { textMax: 1000 }));
      return ok(render(m, { full: true }) + (thread.length ? `\n\nReplies:\n${thread.join('\n')}` : ''));
    }, { readOnlyHint: true });

  tool('share',
    'Share something from this coding session with teammates\' agents: a file or line range, a git diff, or any text (markdown doc, plan, transcript excerpt, command output). Paths are relative to this project. Respect autonomy (ask first when autonomy=ask).',
    {
      note: z.string().min(1).describe('Why it matters / what they should do with it'),
      path: z.string().optional().describe('File to share'),
      lines: z.string().regex(/^\d+(-\d+)?$/).optional().describe('Line range, e.g. "40-120"'),
      diff: z.string().optional().describe('Git diff spec: "HEAD" = uncommitted changes, "main...HEAD" = this branch, a commit sha, etc.'),
      content: z.string().optional().describe('Arbitrary text to share (doc, plan, snippet)'),
      title: z.string().optional().describe('Title for `content`'),
      to: z.string().optional().describe('Teammate name; omit for everyone'),
    },
    async ({ note, path, lines, diff, content, title, to }) => {
      const p = t.project;
      const attachments = [];
      if (path) {
        const abs = resolve(p.root, path);
        let text = readFileSync(abs, 'utf8');
        if (text.includes('\0')) return fail('That looks like a binary file; share text files only.');
        if (lines) {
          const [a, b = a] = lines.split('-').map(Number);
          text = text.split('\n').slice(a - 1, b).join('\n');
        }
        attachments.push(clamp({ type: 'file', path: relPath(p, abs), lines, lang: langOf(abs), content: text }));
      }
      if (diff) {
        const args = ['-C', p.root, 'diff', '--no-color', ...diff.split(/\s+/).filter(Boolean)];
        const stat = execFileSync('git', [...args, '--stat'], { encoding: 'utf8', maxBuffer: 64e6 }).trim();
        const body = execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64e6 });
        if (!body.trim()) return fail(`git diff ${diff} is empty.`);
        attachments.push(clamp({ type: 'diff', title: `git diff ${diff}`, lang: 'diff', content: `${stat}\n\n${body}` }));
      }
      if (content) attachments.push(clamp({ type: 'doc', title: title || 'note', lang: title?.endsWith('.md') ? 'md' : '', content }));
      if (!attachments.length) return fail('Give at least one of path, diff or content.');
      const r = await t.send({ to, kind: 'share', text: note, attachments });
      return ok(`shared #${r.seq} → ${to || 'everyone'}: ${attachments.map((a) => a.path || a.title).join(', ')}${offline()}`);
    });

  tool('log',
    'Post a worklog entry for teammates (replaces dailies): what you did, files touched, what is next. Files default to what was edited in this project since your last log. Post after any meaningful chunk of work (respect autonomy).',
    {
      summary: z.string().min(1).describe('What was done and why, incl. decisions and gotchas'),
      next: z.string().optional().describe('What is next / open questions / where someone could pick it up'),
      files: z.array(z.string()).optional().describe('Override the auto-detected file list'),
      to: z.string().optional(),
    },
    async ({ summary, next, files, to }) => {
      const p = t.project;
      const since = t.store.get(`lastlog:${p.id}`, Date.now() - 24 * 3600e3);
      const touched = files || t.store.projectEdits(p.id, since).map((f) => f.path).slice(0, 60);
      const r = await t.send({ to, kind: 'worklog', worklog: { summary, next, files: touched, project: p.id } });
      t.store.set(`lastlog:${p.id}`, Date.now());
      return ok(`logged #${r.seq} for ${p.name} (${touched.length} files)${offline()}`);
    });

  tool('context',
    'What teammates have been doing: statuses, recent worklogs for this project, open questions to you, and (with query) the most relevant past messages, shares and shared memory. Cheap — reads the local replica.',
    {
      query: z.string().optional().describe('Topic, feature, file path or keyword to focus on'),
      scope: z.enum(['project', 'all']).optional().describe('Default: this project'),
      hours: z.number().int().min(1).max(24 * 60).optional().describe('Look-back window for worklogs (default 72)'),
    },
    async ({ query, scope = 'project', hours = 72 }) => {
      const p = t.project;
      const since = Date.now() - hours * 3600e3;
      const out = [`Project: ${p.name} (${p.id}). Permissions: ${fmtPolicy(t.store.policy())}.`];
      const mates = t.store.members().filter((m) => m.id !== me);
      out.push('Team:\n' + (mates.length ? mates.map((m) => '  ' + fmtMember(m, me)).join('\n') : '  (no teammates yet — share your invite)'));

      const logs = t.store.byKind('worklog', since, 40)
        .filter((m) => m.from !== me && (scope === 'all' || m.project === p.id)).slice(0, 6);
      if (logs.length) out.push(`Teammate worklogs (${scope === 'all' ? 'all projects' : 'this project'}, ${hours}h):\n` + logs.map((m) => render(m, { textMax: 400 })).join('\n'));

      const open = openQuestions();
      if (open.length) out.push('Unanswered questions to you:\n' + open.map((m) => render(m, { textMax: 300 })).join('\n'));

      if (query) {
        const hits = t.store.search(query, { project: scope === 'all' ? null : p.id, limit: 8 });
        out.push(`Relevant to "${query}":\n` + (hits.length ? hits.map(({ type, item }) => type === 'mem'
          ? `memory "${item.key}" (${t.store.name(item.author)}, ${ago(item.ts)}): ${clip(item.value, 300)}`
          : render(item, { textMax: 300 })).join('\n') : '  nothing found'));
      } else {
        const keys = t.store.memories().slice(0, 15).map((m) => m.key);
        if (keys.length) out.push(`Shared memory keys: ${keys.join(', ')}`);
      }
      return ok(out.join('\n\n'));
    }, { readOnlyHint: true });

  tool('status',
    'Set what you are working on (visible to teammates\' agents) and/or see the team: who is online and what they are on.',
    { text: z.string().optional().describe('e.g. "refactoring auth middleware in api/ — touching src/auth/*"') },
    async ({ text }) => {
      if (text) await t.setStatus(text);
      return ok(t.store.members().map((m) => fmtMember(m, me)).join('\n') + `\nPermissions: ${fmtPolicy(t.store.policy())}`);
    });

  tool('remember',
    'Save a durable fact to the room\'s shared memory (both agents read/write it): decisions, conventions, API contracts, env setup, links. Overwrites the key.',
    {
      key: z.string().min(1).max(200).describe('Stable, namespaced key, e.g. "api/auth-token-format" or "decision/use-postgres"'),
      value: z.string().min(1).max(100_000),
      tags: z.array(z.string()).optional(),
    },
    async ({ key, value, tags }) => {
      if (key.startsWith('_')) return fail('Keys starting with "_" are reserved.');
      const prev = t.recall(key);
      await t.remember(key, value, tags || []);
      return ok(`${prev ? 'updated' : 'saved'} "${key}"${offline()}`);
    });

  tool('recall',
    'Read shared memory: exact `key`, or `query` to search keys/values/tags, or nothing to list keys.',
    { key: z.string().optional(), query: z.string().optional(), limit: z.number().int().min(1).max(50).optional() },
    async ({ key, query, limit = 8 }) => {
      if (key) {
        const m = t.recall(key);
        return m ? ok(`${m.key} (${t.store.name(m.author)}, ${ago(m.ts)}${m.tags.length ? `, #${m.tags.join(' #')}` : ''}):\n${m.value}`) : fail(`No memory "${key}".`);
      }
      if (query) {
        const hits = t.store.search(query, { kinds: ['memory'], limit });
        return ok(hits.length ? hits.map(({ item: m }) => `${m.key} (${t.store.name(m.author)}, ${ago(m.ts)}): ${clip(m.value, 500)}`).join('\n') : 'Nothing matches.');
      }
      const all = t.store.memories();
      return ok(all.length ? all.slice(0, 100).map((m) => `${m.key}: ${clip(m.value.replace(/\s+/g, ' '), 90)}`).join('\n') : 'Shared memory is empty.');
    }, { readOnlyHint: true });

  tool('forget', 'Delete a key from shared memory.', { key: z.string() }, async ({ key }) => {
    if (!t.recall(key)) return fail(`No memory "${key}".`);
    await t.forget(key);
    return ok(`forgot "${key}"`);
  });

  tool('permissions',
    'The room\'s shared permissions. Shows members (incl. pending join requests) and the policy everyone agreed to. Changes are proposals that apply only once every active member accepts. Only change permissions when your human asks you to.',
    {
      approve: z.string().optional().describe('Approve a pending member by name'),
      revoke: z.string().optional().describe('Remove a member by name'),
      propose: z.object({
        autonomy: z.enum(['ask', 'auto']).optional(),
        worklogs: z.boolean().optional(),
        overlap: z.boolean().optional(),
      }).optional().describe('Propose new settings; teammates must accept'),
      accept: z.boolean().optional().describe('Accept the open proposal'),
      reject: z.boolean().optional().describe('Withdraw/reject the open proposal'),
    },
    async ({ approve, revoke, propose, accept, reject }) => {
      const notes = [];
      if (approve) { const m = await t.moderate(approve, 'approve'); notes.push(`approved ${m.name}`); }
      if (revoke) { const m = await t.moderate(revoke, 'revoke'); notes.push(`revoked ${m.name}`); }
      if (propose) {
        const doc = await t.updatePolicy((d) => ({ ...d, proposal: { settings: propose, by: me, at: Date.now(), acks: [me] } }));
        notes.push(doc.proposal ? 'proposal sent — waiting for teammates to accept' : 'applied (you are the only active member)');
        if (doc.proposal) await t.send({ kind: 'alert', text: `${cfg.name} proposes new room permissions: ${JSON.stringify(propose)}. Ask your human; if they agree, call permissions(accept=true).` });
      }
      if (accept || reject) {
        if (!t.store.policyDoc().proposal) return fail('There is no open proposal.');
        const doc = await t.updatePolicy((d) => (reject ? { ...d, proposal: null } : { ...d, proposal: { ...d.proposal, acks: [...new Set([...d.proposal.acks, me])] } }));
        notes.push(reject ? 'proposal withdrawn' : doc.proposal ? 'accepted — waiting for others' : 'accepted — new permissions are in effect');
      }
      const doc = t.store.policyDoc();
      const members = t.store.members();
      const out = [...notes, `Policy: ${fmtPolicy(t.store.policy())}`];
      if (doc.proposal) {
        const waiting = members.filter((m) => m.state === 'active' && !doc.proposal.acks.includes(m.id)).map((m) => m.name);
        out.push(`Open proposal by ${t.store.name(doc.proposal.by)}: ${JSON.stringify(doc.proposal.settings)} — waiting on ${waiting.join(', ') || 'nobody'}`);
      }
      out.push('Members:\n' + members.map((m) => '  ' + fmtMember(m, me)).join('\n'));
      return ok(out.join('\n'));
    });

  function openQuestions() {
    const cutoff = Date.now() - 48 * 3600e3;
    return t.store.byKind('question', cutoff, 30)
      .filter((m) => m.from !== me && (!m.to || m.to === me) && !t.store.replies(m.seq).some((r) => r.from === me));
  }

  // Claude Code "channels" (research preview): push teammate messages straight into the session.
  if (channel) {
    t.on('message', (m) => {
      if (m.from === me) return;
      server.server.notification({
        method: 'notifications/claude/channel',
        params: { content: render(m, { inlineBudget: 3000 }), meta: { from: t.store.name(m.from), id: String(m.seq), kind: m.body.kind || 'chat' } },
      }).then(() => t.store.markOne(m.seq)).catch(() => {});
    });
  }

  await server.connect(new StdioServerTransport());
  const shutdown = () => { t.close(); process.exit(0); };
  process.stdin.on('close', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

function clamp(a) {
  if (a.content && a.content.length > MAX_ATTACH) return { ...a, content: a.content.slice(0, MAX_ATTACH), truncated: true };
  return a;
}
const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
