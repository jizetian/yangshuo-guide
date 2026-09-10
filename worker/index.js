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
const MAX_READS = 6; // 一次会话最多读几块，防止读满全页
const CALL_TIMEOUT_MS = 75000; // 单次模型调用上限：中转服务会无响应地挂住
const JOB_DEADLINE_MS = 240000; // 整个任务上限，超了标记失败而不是永远 running

/**
 * 把整页切成命名片段。改动通常只碰一两块，
 * 让模型按需取，比每次发 22K token 的整页省一个数量级。
 */
function splitParts(html) {
  const parts = [];
  const add = (name, text, desc) => {
    if (text && text.length) parts.push({ name, text, desc });
  };

  const styleM = html.match(/<style>[\s\S]*?<\/style>/);
  add("css", styleM ? styleM[0] : "", "全部样式");

  const headM = html.match(/<header>[\s\S]*?<\/nav>/);
  add("header", headM ? headM[0] : "", "标题栏和导航");

  // 正文各 section
  const secRe = /<section id="([^"]+)"[\s\S]*?(?=\n<section id=|\n<footer|<!-- ═)/g;
  let m;
  while ((m = secRe.exec(html)) !== null) {
    add("body:" + m[1], m[0], "正文 · " + m[1]);
  }

  const footM = html.match(/<footer>[\s\S]*?<\/footer>/);
  add("footer", footM ? footM[0] : "", "页脚数据来源说明");

  // JS 按 /* ══ 名称 ══ */ 注释分块
  const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((x) => x[1]).join("\n");
  const marks = [...js.matchAll(/\/\* ═+ (.+?) ═+ \*\//g)];
  marks.forEach((mk, i) => {
    const start = mk.index;
    const end = i + 1 < marks.length ? marks[i + 1].index : js.length;
    add("js:" + mk[1].trim(), js.slice(start, end), "脚本 · " + mk[1].trim());
  });

  return parts;
}

function outlineOf(parts) {
  return parts
    .map((p) => `- ${p.name}  (${(p.text.length / 1024).toFixed(1)}KB) ${p.desc}`)
    .join("\n");
}

const SYSTEM_PROMPT = `你在维护一个阳朔两日游攻略的单页 HTML。用户会用一句话告诉你要改什么。

页面很大（约 2 万 token），所以不会整页发给你。先用 read_part 取你需要的那几块，看清楚了再用 edit_page 改。

关于这个页面你需要知道的：
- 纯静态单文件，内联 CSS 和 JS，没有构建步骤
- 行程时刻不是写死的：D1 用 data-t（相对到站分钟数，或 SUNSET±N 锚定日落），D2 用 data-t2（ABS-HH:MM 绝对时刻，或 LASTCALL/PICKUP/ARRIVE/DEPART 由返程车次倒推）。改时间优先改这些属性，别改显示出来的时刻文本——那是 JS 算出来的
- 有些内容在 JS 数据里而不在 HTML 里：打包清单是 js:数据 里的 PACK 数组，地图点位是同一块的 PTS 数组
- 配色是纸质感（--paper/--ink/--jade/--river/--clay），不要引入渐变或大量 emoji
- 文案风格：具体、有出处、不说正确的废话。价格要有来源

工作方式：
1. 先判断要改的东西在哪一块，read_part 取来看。**一次把需要的块全部取完**（同一轮里并列多个 read_part 调用），不要一块一块来回问——每多一轮都要等很久
2. 拿到内容后，**在同一轮里把所有 edit_page 一次性发出来**，别一处一处改
3. old_string 必须和文件里的内容逐字一致（含缩进），且在全文唯一——没读过的地方不要凭猜写 old_string
4. 一次改动尽量少，别顺手重排无关的东西
5. 用户要求含糊时按最合理的理解改，在 reason 里说明你怎么理解的
6. 如果要求会破坏页面（比如删掉返程警戒线的计算逻辑），不要改，直接说明原因
7. 发出 edit_page 的同一条消息里就用中文说清你改了什么，别留到下一轮——改完就结束，不要再问「还需要什么吗」`;

const READ_TOOL = {
  name: "read_part",
  description:
    "读取页面的某一块内容。先读再改，不要凭猜写 old_string。可以一次调用多个。",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "块名，从大纲里选，例如 body:d2 或 js:数据" },
    },
    required: ["name"],
    additionalProperties: false,
  },
};

const EDIT_TOOL = {
  name: "edit_page",
  description:
    "对 index.html 做一次精确替换。old_string 必须在全文唯一且逐字匹配（含缩进）。",
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

const JOB_TTL = 3600; // 任务状态留 1 小时

async function setJob(env, id, patch) {
  const prev = JSON.parse((await env.JOBS.get(id)) || "{}");
  const next = { ...prev, ...patch, at: new Date().toISOString() };
  await env.JOBS.put(id, JSON.stringify(next), { expirationTtl: JOB_TTL });
  return next;
}

/**
 * 真正干活的部分。中转服务慢的时候一次要一两分钟，
 * 所以放在 ctx.waitUntil 里跑，进度写 KV，前端轮询。
 */
async function runEdit(env, jobId, instr) {
  const step = (s) => setJob(env, jobId, { step: s });
  const startedAt = Date.now();
  try {
    await step("读取当前页面");
    const pageMeta = await ghJson(env, `/contents/${PAGE_FILE}?ref=${BRANCH}`);
    let html = b64decode(pageMeta.content);
    const originalHtml = html;

    const client = new Anthropic({
      apiKey: env.ANTHROPIC_API_KEY,
      ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}),
    });

    const parts = splitParts(html);
    const outline = outlineOf(parts);
    const applied = [];
    const readNames = [];
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

    let messages = [
      {
        role: "user",
        content: `页面分成这些块（改动通常只碰一两块）：\n\n${outline}\n\n用户要求：${instr}`,
      },
    ];

    let summary = "";
    let editSummary = "";
    for (let turn = 0; turn < 8; turn++) {
      if (Date.now() - startedAt > JOB_DEADLINE_MS) {
        return setJob(env, jobId, {
          status: "error",
          error: "超时了。上游模型服务这会儿响应很慢，过几分钟再试；如果一直这样，多半是中转服务的问题。",
          usage,
          read: readNames,
        });
      }
      await step(turn === 0 ? "助手在想改哪里" : `第 ${turn + 1} 轮`);

      // 中转服务偶尔会挂住不返回，必须自己掐表；掐断后重试一次
      let resp = null;
      for (let attempt = 0; attempt < 2 && !resp; attempt++) {
        if (attempt) await step(`第 ${turn + 1} 轮 · 上游没响应，重试中`);
        try {
          resp = await client.messages.create(
            {
              model: "claude-opus-5",
              max_tokens: 8000,
              thinking: { type: "adaptive" },
              // 改文案不需要 high；上游延迟随请求增大而暴涨，省一轮就是省几十秒
              output_config: { effort: "medium" },
              // 系统提示是稳定前缀，缓存它；页面内容按需通过工具进来，不进前缀
              system: [
                { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
              ],
              tools: [READ_TOOL, EDIT_TOOL],
              messages,
            },
            // SDK 的 timeout 选项在 Workers 运行时不可靠，用 AbortController 自己掐
            {
              signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
              timeout: CALL_TIMEOUT_MS,
              maxRetries: 0,
            }
          );
        } catch (e) {
          const msg = String(e && e.message ? e.message : e);
          if (attempt === 1) {
            return setJob(env, jobId, {
              status: "error",
              error: `上游模型服务没响应（${msg.slice(0, 100)}）。已经重试过一次。`,
              usage,
              read: readNames,
            });
          }
        }
      }

      const u = resp.usage || {};
      usage.input += u.input_tokens || 0;
      usage.output += u.output_tokens || 0;
      usage.cacheRead += u.cache_read_input_tokens || 0;
      usage.cacheWrite += u.cache_creation_input_tokens || 0;

      if (resp.stop_reason === "refusal") {
        return setJob(env, jobId, { status: "error", error: "这个要求我不能改" });
      }

      const toolUses = resp.content.filter((b) => b.type === "tool_use");
      const text = resp.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (text && text.length > 8) summary = text;
      // 跟 edit_page 同一轮说出来的话才是改动说明；
      // 收尾轮往往只是「改好了，还有别的吗」，不该覆盖它
      if (text && toolUses.some((t) => t.name === "edit_page")) editSummary = text;

      if (resp.stop_reason === "end_turn" || toolUses.length === 0) break;

      messages.push({ role: "assistant", content: resp.content });

      const results = [];
      for (const tu of toolUses) {
        if (tu.name === "read_part") {
          const want = String(tu.input.name || "").trim();
          const hit = parts.find((p) => p.name === want);
          if (!hit) {
            results.push({
              type: "tool_result",
              tool_use_id: tu.id,
              content: `没有这一块。可选：\n${parts.map((p) => p.name).join("\n")}`,
              is_error: true,
            });
          } else if (readNames.length >= MAX_READS) {
            results.push({
              type: "tool_result",
              tool_use_id: tu.id,
              content: `已达读取上限（${MAX_READS} 块）。用已经读到的内容来改。`,
              is_error: true,
            });
          } else {
            readNames.push(hit.name);
            await step(`读了 ${readNames.join("、")}`);
            results.push({ type: "tool_result", tool_use_id: tu.id, content: hit.text });
          }
          continue;
        }

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
            content:
              "old_string 在文件里找不到。注意空格和缩进必须逐字一致；" +
              "如果这块还没读过，先 read_part 取来看。",
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
          await step(`已改 ${applied.length} 处`);
          results.push({ type: "tool_result", tool_use_id: tu.id, content: "改好了" });
        }
      }
      messages.push({ role: "user", content: results });

      // 这一轮已经改成了，且没有失败的 edit 需要重试 —— 直接收工。
      // 再跑一轮只为让模型说句「还有别的吗」，而中转服务每轮要几十秒。
      const editedThisTurn = toolUses.some((t) => t.name === "edit_page");
      const anyEditFailed = results.some((r) => r.is_error);
      if (editedThisTurn && !anyEditFailed && applied.length) break;
    }

    if (!applied.length) {
      return setJob(env, jobId, {
        status: "nochange",
        error: summary || "没有做任何改动",
        usage,
        read: readNames,
      });
    }
    if (html === originalHtml) {
      return setJob(env, jobId, { status: "nochange", error: "改完内容没变化", usage });
    }

    // 改动说明：优先用改动那一轮说的话，否则退回逐条 reason
    const finalSummary = editSummary || summary || applied.map((a) => a.reason).join("；");

    await step("写入修改历史");
    let history = { version: 1, entries: [] };
    try {
      const hMeta = await ghJson(env, `/contents/${HISTORY_FILE}?ref=${BRANCH}`);
      history = JSON.parse(b64decode(hMeta.content));
    } catch {
      /* 首次运行还没有这个文件 */
    }
    if (!Array.isArray(history.entries)) history.entries = [];

    history.entries.unshift({
      at: new Date().toISOString(),
      instruction: instr,
      summary: finalSummary,
      edits: applied.map((a) => a.reason),
      read: readNames,
      usage,
      bytes: html.length - originalHtml.length,
    });
    history.entries = history.entries.slice(0, 100);

    await step("提交到 GitHub");
    const title = instr.replace(/\s+/g, " ").slice(0, 50);
    const sha = await commitFiles(
      env,
      [
        { path: PAGE_FILE, content: html },
        { path: HISTORY_FILE, content: JSON.stringify(history, null, 2) + "\n" },
      ],
      `${COMMIT_PREFIX} ${title}\n\n` +
        (finalSummary ? `${finalSummary}\n\n` : "") +
        `改动 ${applied.length} 处：\n` +
        applied.map((a) => `- ${a.reason}`).join("\n") +
        (readNames.length ? `\n\n读取：${readNames.join(", ")}` : "") +
        `\n\n由行程助手自动提交。`
    );

    return setJob(env, jobId, {
      status: "done",
      summary: finalSummary,
      edits: applied.map((a) => a.reason),
      commit: sha.slice(0, 7),
      read: readNames,
      usage,
      step: "完成",
    });
  } catch (err) {
    return setJob(env, jobId, {
      status: "error",
      error: String(err && err.message ? err.message : err).slice(0, 400),
    });
  }
}

/** 只做校验和建任务，立刻返回 —— 不让调用方举着连接干等 */
async function handleEdit(request, env, ctx, origin) {
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

  const jobId = crypto.randomUUID().slice(0, 8);
  await setJob(env, jobId, { status: "running", step: "排队中", instruction: instr });
  ctx.waitUntil(runEdit(env, jobId, instr));

  return json({ ok: true, jobId, status: "running" }, 202, origin);
}

export default {
  async fetch(request, env, ctx) {
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

    if (url.pathname === "/job" && request.method === "GET") {
      const id = url.searchParams.get("id") || "";
      const raw = await env.JOBS.get(id);
      if (!raw) return json({ ok: false, error: "任务不存在或已过期" }, 404, origin);
      return json({ ok: true, job: JSON.parse(raw) }, 200, origin);
    }

    if (url.pathname === "/edit" && request.method === "POST") {
      try {
        return await handleEdit(request, env, ctx, origin);
      } catch (err) {
        return json({ ok: false, error: String(err.message || err).slice(0, 400) }, 500, origin);
      }
    }

    return json({ ok: false, error: "Not found" }, 404, origin);
  },
};
