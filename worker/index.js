/**
 * 阳朔攻略 · 行程修改 Agent（Cloudflare Worker）
 *
 * 职责：拿着密钥代用户改仓库里的 index.html
 *   POST /edit    口令 + 一句自然语言 → Claude 改 HTML → 一次提交推到 GitHub
 *   GET  /health  存活检查
 *
 * 密钥全部走 wrangler secret，不出现在前端。
 */

import Anthropic from "@anthropic-ai/sdk";

const REPO_OWNER = "jizetian";
const REPO_NAME = "yangshuo-guide";
const BRANCH = "main";
const PAGE_FILE = "index.html";
const HISTORY_FILE = "history.json";

// 提交标记：让 agent 改的和你手改的在 git 历史里一眼分得开
const AGENT_NAME = "行程助手 (agent)";
const AGENT_EMAIL = "agent@yangshuo-guide.local";
const COMMIT_PREFIX = "[agent]";

const MAX_INSTRUCTION = 500;
const MAX_EDITS = 8;

const SYSTEM_PROMPT = `你在维护一个阳朔两日游攻略的单页 HTML。用户会用一句话告诉你要改什么，你用 edit_page 工具改。

关于这个页面你需要知道的：
- 纯静态单文件，内联 CSS 和 JS，没有构建步骤
- 行程时刻不是写死的：D1 用 data-t（相对到站分钟数，或 SUNSET±N 锚定日落），D2 用 data-t2（ABS-HH:MM 绝对时刻，或 LASTCALL/PICKUP/ARRIVE/DEPART 由返程车次倒推）。改时间优先改这些属性，别改显示出来的时刻文本——那是 JS 算出来的
- 配色是纸质感（--paper/--ink/--jade/--river/--clay），不要引入渐变或大量 emoji
- 文案风格：具体、有出处、不说正确的废话。价格要有来源

规矩：
1. old_string 必须和文件里的内容逐字一致（含缩进），且在全文唯一
2. 一次改动尽量少，别顺手重排无关的东西
3. 用户要求含糊时按最合理的理解改，在 reason 里说明你怎么理解的
4. 如果要求会破坏页面（比如删掉返程警戒线的计算逻辑），不要改，直接说明原因
5. 改完用中文简短说清改了什么`;

const EDIT_TOOL = {
  name: "edit_page",
  description:
    "对 index.html 做一次精确替换。old_string 必须在文件中唯一且逐字匹配。",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      old_string: { type: "string", description: "被替换的原文，必须唯一且逐字匹配" },
      new_string: { type: "string", description: "替换后的内容" },
      reason: { type: "string", description: "一句话说明这处为什么改" },
    },
    required: ["old_string", "new_string", "reason"],
    additionalProperties: false,
  },
};

/* ────────── 工具函数 ────────── */

const json = (obj, status = 200, origin = "*") =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": origin,
      "cache-control": "no-store",
    },
  });

/** 定长比较，避免用响应时间猜口令 */
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

const b64encode = (str) => {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

const b64decode = (b64) => {
  const bin = atob(b64.replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
};

function gh(env, path, init = {}) {
  return fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "user-agent": "yangshuo-guide-agent",
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
}

async function ghJson(env, path, init) {
  const r = await gh(env, path, init);
  if (!r.ok) throw new Error(`GitHub ${path} ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

/** 用 Git Data API 把两个文件放进同一个提交（Contents API 只能一次一个文件） */
async function commitFiles(env, files, message) {
  const ref = await ghJson(env, `/git/ref/heads/${BRANCH}`);
  const baseCommitSha = ref.object.sha;
  const baseCommit = await ghJson(env, `/git/commits/${baseCommitSha}`);

  const blobs = await Promise.all(
    files.map(async (f) => {
      const blob = await ghJson(env, "/git/blobs", {
        method: "POST",
        body: JSON.stringify({ content: b64encode(f.content), encoding: "base64" }),
      });
      return { path: f.path, mode: "100644", type: "blob", sha: blob.sha };
    })
  );

  const tree = await ghJson(env, "/git/trees", {
    method: "POST",
    body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree: blobs }),
  });

  const commit = await ghJson(env, "/git/commits", {
    method: "POST",
    body: JSON.stringify({
      message,
      tree: tree.sha,
      parents: [baseCommitSha],
      author: { name: AGENT_NAME, email: AGENT_EMAIL, date: new Date().toISOString() },
      committer: { name: AGENT_NAME, email: AGENT_EMAIL, date: new Date().toISOString() },
    }),
  });

  await ghJson(env, `/git/refs/heads/${BRANCH}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha }),
  });

  return commit.sha;
}

/* ────────── 主流程 ────────── */

async function handleEdit(request, env, origin) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "请求格式不对" }, 400, origin);
  }

  const { pass, instruction } = body || {};

  if (!safeEqual(pass || "", env.EDIT_PASSPHRASE || "")) {
    return json({ ok: false, error: "口令不对" }, 401, origin);
  }
  const instr = (instruction || "").trim();
  if (!instr) return json({ ok: false, error: "说一下想改什么" }, 400, origin);
  if (instr.length > MAX_INSTRUCTION) {
    return json({ ok: false, error: `太长了，${MAX_INSTRUCTION} 字以内` }, 400, origin);
  }

  // 1. 取当前页面
  const pageMeta = await ghJson(env, `/contents/${PAGE_FILE}?ref=${BRANCH}`);
  let html = b64decode(pageMeta.content);
  const originalHtml = html;

  // 2. 让 Claude 提出改动
  // ANTHROPIC_BASE_URL 可选：走中转服务时设置，留空则直连官方
  const client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}),
  });
  const applied = [];
  let messages = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `这是 index.html 的当前内容：\n\n<page>\n${html}\n</page>`,
          cache_control: { type: "ephemeral" },
        },
        { type: "text", text: `用户要求：${instr}` },
      ],
    },
  ];

  let summary = "";
  for (let turn = 0; turn < 6; turn++) {
    const resp = await client.messages.create({
      model: "claude-opus-5",
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system: SYSTEM_PROMPT,
      tools: [EDIT_TOOL],
      messages,
    });

    if (resp.stop_reason === "refusal") {
      return json({ ok: false, error: "这个要求我不能改" }, 400, origin);
    }

    const toolUses = resp.content.filter((b) => b.type === "tool_use");
    const text = resp.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (text) summary = text;

    if (resp.stop_reason === "end_turn" || toolUses.length === 0) break;

    messages.push({ role: "assistant", content: resp.content });

    const results = [];
    for (const tu of toolUses) {
      if (applied.length >= MAX_EDITS) {
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: `已达单次改动上限（${MAX_EDITS} 处），请分次来。`,
          is_error: true,
        });
        continue;
      }
      const { old_string, new_string, reason } = tu.input;
      const hits = html.split(old_string).length - 1;
      if (hits === 0) {
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: "old_string 在文件里找不到。注意空格和缩进必须逐字一致。",
          is_error: true,
        });
      } else if (hits > 1) {
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: `old_string 匹配到 ${hits} 处，不唯一。往前后多带几行让它唯一。`,
          is_error: true,
        });
      } else {
        html = html.replace(old_string, new_string);
        applied.push({ reason, chars: new_string.length - old_string.length });
        results.push({ type: "tool_result", tool_use_id: tu.id, content: "改好了" });
      }
    }
    messages.push({ role: "user", content: results });
  }

  if (!applied.length) {
    return json(
      { ok: false, error: summary || "没有做任何改动", noChange: true },
      200,
      origin
    );
  }
  if (html === originalHtml) {
    return json({ ok: false, error: "改完内容没变化" }, 200, origin);
  }

  // 3. 写修改历史
  let history = { version: 1, entries: [] };
  let historySha = null;
  try {
    const hMeta = await ghJson(env, `/contents/${HISTORY_FILE}?ref=${BRANCH}`);
    history = JSON.parse(b64decode(hMeta.content));
    historySha = hMeta.sha;
  } catch {
    /* 首次运行还没有这个文件 */
  }
  if (!Array.isArray(history.entries)) history.entries = [];

  const entry = {
    at: new Date().toISOString(),
    instruction: instr,
    summary: summary || "（无说明）",
    edits: applied.map((a) => a.reason),
    bytes: html.length - originalHtml.length,
  };
  history.entries.unshift(entry);
  history.entries = history.entries.slice(0, 100);

  // 4. 一次提交推上去，带标记
  //    标题用用户原话（短且稳定），summary 可能很长且带换行，放正文
  const title = instr.replace(/\s+/g, " ").slice(0, 50);
  const sha = await commitFiles(
    env,
    [
      { path: PAGE_FILE, content: html },
      { path: HISTORY_FILE, content: JSON.stringify(history, null, 2) + "\n" },
    ],
    `${COMMIT_PREFIX} ${title}\n\n` +
      (summary ? `${summary}\n\n` : "") +
      `改动 ${applied.length} 处：\n` +
      applied.map((a) => `- ${a.reason}`).join("\n") +
      `\n\n由行程助手自动提交。`
  );

  entry.commit = sha.slice(0, 7);
  return json(
    {
      ok: true,
      summary: summary || "改好了",
      edits: applied.map((a) => a.reason),
      commit: sha.slice(0, 7),
      note: "GitHub Pages 构建约 1 分钟，之后强刷页面就能看到。",
    },
    200,
    origin
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const reqOrigin = request.headers.get("origin") || "";
    const allow = (env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
    const origin = allow.length === 0 ? "*" : allow.includes(reqOrigin) ? reqOrigin : allow[0];

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": origin,
          "access-control-allow-methods": "POST, GET, OPTIONS",
          "access-control-allow-headers": "content-type",
          "access-control-max-age": "86400",
        },
      });
    }

    if (url.pathname === "/health") {
      return json(
        {
          ok: true,
          hasKey: !!env.ANTHROPIC_API_KEY,
          hasToken: !!env.GITHUB_TOKEN,
          hasPass: !!env.EDIT_PASSPHRASE,
          baseUrl: env.ANTHROPIC_BASE_URL || "官方直连",
        },
        200,
        origin
      );
    }

    if (url.pathname === "/edit" && request.method === "POST") {
      try {
        return await handleEdit(request, env, origin);
      } catch (err) {
        return json({ ok: false, error: String(err.message || err).slice(0, 400) }, 500, origin);
      }
    }

    return json({ ok: false, error: "Not found" }, 404, origin);
  },
};
