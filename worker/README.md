# 行程修改 Agent · 部署说明

页面是纯静态的（GitHub Pages），存不了密钥。这个 Worker 就是替它拿密钥的那一层：
收到「口令 + 一句话要求」→ 调 Claude 改 `index.html` → 用带标记的身份提交回仓库。

```
攻略页 ──POST /edit──> Cloudflare Worker ──> Claude API
  (公开)                 (持有密钥)          └─> GitHub Contents/Git Data API
                                                  提交作者：行程助手 (agent)
                                                  提交前缀：[agent]
```

---

## 一次性部署（约 10 分钟）

### 1. 装 wrangler 并登录

```bash
cd worker
npm install
npx wrangler login          # 浏览器里授权 Cloudflare，没账号就现注册，免费
```

### 2. 准备两个密钥

**Anthropic API Key** — https://console.anthropic.com/settings/keys
新建一个 key，形如 `sk-ant-api03-...`。

**GitHub Token** — https://github.com/settings/personal-access-tokens/new
选 **Fine-grained token**：
- Repository access → Only select repositories → `jizetian/yangshuo-guide`
- Permissions → Repository permissions → **Contents: Read and write**
- 有效期按需（建议 90 天）

> 只给这一个仓库的写权限。别用有全部仓库权限的经典 token。

### 3. 写进 Worker（不会出现在前端）

```bash
npx wrangler secret put ANTHROPIC_API_KEY    # 粘贴 sk-ant-...
npx wrangler secret put GITHUB_TOKEN         # 粘贴 github_pat_...
npx wrangler secret put EDIT_PASSPHRASE      # 你自己定一个口令
```

### 4. 部署

```bash
npx wrangler deploy
```

输出里会有一行地址，形如：

```
https://yangshuo-agent.<你的子域>.workers.dev
```

### 5. 把地址填回页面

编辑仓库根目录的 `index.html`，找到这一行：

```js
var AGENT_API = "";
```

填成你的 worker 地址：

```js
var AGENT_API = "https://yangshuo-agent.xxx.workers.dev";
```

然后 `git commit && git push`。等 Pages 构建完（约 1 分钟），「改行程」那一节就能用了。

---

## 验证

```bash
curl https://yangshuo-agent.xxx.workers.dev/health
# {"ok":true,"hasKey":true,"hasToken":true,"hasPass":true}
```

三个都是 `true` 才算配好。

---

## 怎么用

在攻略页拉到底部「改行程」，填口令，用一句话说要改什么：

- 「竹筏改到下午两点，后面顺延」
- 「把大榕树从 D2 去掉」
- 「打包清单加上泳衣」
- 「西街那家啤酒鱼换一家」

助手改完直接提交，约 1 分钟后强刷页面生效。

---

## 标记机制

**git 提交** — 作者是 `行程助手 (agent)`，标题带 `[agent]` 前缀，正文记录原始要求和每处改动的理由：

```
[agent] 竹筏时间改到 14:00，后续行程顺延

用户要求：竹筏改到下午两点，后面顺延
改动 3 处：
- 竹筏起点时刻从 ABS-12:00 改为 ABS-14:00
- ...
```

跟你自己改的提交在 `git log` 里一眼分开。

**修改历史面板** — 页面底部可展开，读 `history.json`（每次改动由 Worker 一并提交），
显示时间、原始要求、改了什么、对应的 commit。保留最近 100 条。

---

## 出问题时

| 现象 | 原因 |
|---|---|
| 「口令不对」 | `EDIT_PASSPHRASE` 和你输的不一致，重新 `wrangler secret put` |
| 「连不上后端」 | `AGENT_API` 没填或填错；或 worker 没部署成功 |
| GitHub 40x | token 过期，或没给 `Contents: Read and write` |
| 「old_string 找不到」 | 正常，助手会自己重试；连续失败说明要求太模糊，换个说法 |
| 改完页面没变 | Pages 还在构建，等 1 分钟后 Ctrl+F5 |

**回滚**：改坏了直接 `git revert <commit>` 再 push。历史面板里有 commit 号。

---

## 成本

每次改动把整个 HTML（约 66KB，≈2 万 token）发给 Claude Opus 5，
一次约 **¥0.8–1.5**。偶尔改行程可以忽略；不打算用了就 `wrangler delete` 把 worker 删掉。

## 安全边界

- 口令是唯一的门。**别把口令和页面链接一起发给不相干的人。**
- `ALLOWED_ORIGIN` 限制了只有攻略页能调，别人拿 worker 地址直接打会被 CORS 挡（但这挡不住 curl，所以口令才是真正的防线）。
- GitHub token 只对这一个仓库有写权限，最坏情况是这份攻略被改乱——`git revert` 就能回来。
