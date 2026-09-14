# 语义文档：dsh-anima-tags（Danbooru 标签检索面 / Anima 生图硬锚点）

> 版本 v0.1 · 2026-09-14 · 作者：爱丽丝 · 状态：**draft**
> 开发方式：语义文档优先（先写清「是什么/什么关系/怎么裁决」，再让实现逼近，最后用实践回修）
> 实现落点：`self-plugins/dsh-anima-tags/src/index.ts`（唯一源文件，170 行；构建产物 `lib/index.js`）

| 项 | 值 |
|----|----|
| 能力名 | dsh-anima-tags（插件内 `name = 'anima-tags'`） |
| 主副本路径 | `self-plugins/dsh-anima-tags/docs/semantic.md` |
| 实现落点 | `self-plugins/dsh-anima-tags/src/index.ts` |
| 版本 | `package.json` = 0.1.1 |
| 组合行 | `E:\alice\.dsh\profiles\web\cordis.patch.yml` 行 157–161，`id: agent-anima-tags`，config = `tagsBin: E:/alice/anima/02-技能包/comfyui-good-anima/danbooru-tags/bin/danbooru-tags.exe` |
| 状态 | **draft**（实现已上线并挂载；本文为 2026-09-14 补课产物） |

---

## 1 · 定位与反定位

**定位**：把外部 CLI `danbooru-tags.exe`（数据源为随包分发的 **29MB sqlite 索引**）封成 2 个 DSH 工具——`anima_tag`（canonical tag 检索/校验）与 `anima_tag_random`（随机抽卡）。用途是 Anima 生图工作流里的**「验锚点」**环节：先证明标签真的存在于 Danbooru 词表，再往 prompt 里写。

**反定位（本文不管什么）**：
- 不管**prompt 组装方法论**（词序/权重/画风四维属技能 `comfyui-guidance`）
- 不管**生图执行**（属 `dsh-comfyui`）
- 不管**图片理解/评分**（属 `dsh-agent-vision` 与 `read_image`）
- **不是**标签翻译器/中文对齐工具（无本地化层，输出即 canonical 英文 tag）
- **不是**索引构建者：sqlite 索引由 `danbooru-tags` 自带，本插件**不管理其更新**（见 U2）

## 2 · 术语表

| 术语 | 含义 |
|------|------|
| canonical tag | Danbooru 词表中的规范标签名（如 `1girl`、`blue_archive`） |
| 硬锚点 | 生图 prompt 中必须命中真实词表的标签——「硬」= 可被 CLI 校验，不靠记忆 |
| `matchMode` | 匹配模式：`auto`（缺省，先 exact 后 fuzzy）/ `exact` / `fuzzy` |
| 抽卡（roll） | `anima_tag_random`，按分组随机取候选 tag |
| 子进程三态 | CLI 执行结果：正常退出 / 超时被 kill / 无法启动 |
| 生效判据 | 「当前 web 进程真的在跑这份构建」的进程级判据（见 §6） |

## 3 · 概念模型

```
爱丽丝 / comfyui-guidance 技能
   │  anima_tag{keyword, prefix, group, category, matchMode, minCount, limit, forPrompt, compact, extended}
   │  anima_tag_random{count, group, limit, forPrompt, extended}
   ▼
dsh-anima-tags · apply(ctx, config)
   ▼ runTags(config, args, timeoutMs?)
   spawn(config.tagsBin, ['-j', …flags], { windowsHide:true, shell:false })
   ├─ 超时 → child.kill() → { ok:false, stderr:'danbooru-tags 超时（<ms>ms）' }
   ├─ spawn 失败 → { ok:false, stderr:'无法启动 danbooru-tags：<msg>' }
   └─ close(code) → stdout 去 BOM/trim → JSON.parse
         ├─ 直接解析成功 → data
         ├─ 失败 → 正则截取首个 {...} 或 [...] 再解析
         └─ ok = (code === 0 || data !== null)
   ▼ cliError(r)：ok → null；否则 data.error（JSON 化）> stderr > raw > 'danbooru-tags 执行失败'
   ▼ { ok:true, result:data } | { ok:false, result:null, error }
```

不变量（invariants）：
1. **I1 透传不翻译**：插件不解释标签语义、不做缓存、不做重写——CLI 返回什么就是什么（可用「同一参数两次调用结果同构（除随机工具外）」一次测量判真假）。
2. **I2 无 CLI 即失败**：`tagsBin` 不可执行时，工具必须返回 `{ok:false, error:'无法启动 danbooru-tags：…'}`，**不得**返回空结果冒充成功。
3. **I3 超时必杀进程**：超过 `timeoutMs` 时子进程被 `kill()` 且返回超时错误（`src/index.ts:43-46`）。
4. **I4 参数白名单**：只有显式给出且 trim 后非空的参数才转成 CLI flag（空串/undefined 一律不拼进 argv）——杜绝空 `-k` 之类误用。
5. **I5 shell:false**：子进程不经 shell，参数不被 shell 解释（注入面收窄到 argv 本身）。

## 4 · 契约

### 4.1 配置（`Config`）

| 字段 | 类型 | 默认 | 语义 |
|------|------|------|------|
| `tagsBin` | string | `danbooru-tags`（走 PATH） | **组合里已显式钉住绝对路径**（行 161）——本地路径不进源码 |
| `timeoutMs` | number | `30000` | 子进程超时；`anima_tag`/`anima_tag_random` 都用默认值（未按工具覆盖） |

### 4.2 参数 → CLI flag 映射（`anima_tag`）

| 工具入参 | CLI flag | 备注 |
|---------|---------|------|
| （恒定） | `-j` | JSON 输出 |
| `keyword` | `-k` | 空串跳过 |
| `prefix` | `-p` | artist 用 `@` 前缀 |
| `group` | `-g` | `artist/character/series/general/copyright` 等 |
| `category` | `-c` | 分类过滤 |
| `matchMode` | `--match-mode` | `auto`/`exact`/`fuzzy` |
| `minCount` | `-m` | 最低使用次数 |
| `limit` | `-l` | 条数上限（缺省由 CLI 决定，工具描述写 20） |
| `forPrompt` | `--for-prompt` | 仅 `true` 时加 |
| `compact` | `--compact` | 仅 `true` 时加 |
| `extended` | `-e` | 仅 `true` 时加 |

`anima_tag_random` 映射：恒定 `-j -r <count>`（count 缺省 1），另有 `-g` / `-l` / `--for-prompt` / `-e`（**无 `-k/-p/-c`**——随机工具不接受关键词）。

### 4.3 调用点清单 `[MUST]`

| 调用方 | 调用点（文件:符号） | 时机 |
|-------|------------------|------|
| web 组合 | `.dsh/profiles/web/cordis.patch.yml:158`（`id: agent-anima-tags` + `config.tagsBin`） | web 启动装载（**唯一挂载点**） |
| 插件自身 | `src/index.ts:86` `ctx.tools.register(defineTool({name:'anima_tag' …}))` | 装载时注册 |
| 插件自身 | `src/index.ts:132` `ctx.tools.register(defineTool({name:'anima_tag_random' …}))` | 装载时注册 |
| 插件自身 | `src/index.ts:166` `ctx.effect(...)` → `logger.info('ready（danbooru-tags 检索面：2 工具；tagsBin=…）')` | 装载成功（**宿主 logger 不落盘**） |
| 依赖服务 | `src/index.ts:inject = ['tools']` | cordis 激活门 |
| 技能（消费方） | `alice-self-assets/skills/comfyui-guidance/SKILL.md:49`（工具表：`anima_tag`（dsh-anima-tags）｜精确校验/模糊/随机抽卡/批量） | 生图 prompt 组装前验锚点 |
| 技能（消费方） | `alice-self-assets/skills/comfyui-guidance/SKILL.md:272`（「封装后直接走 `anima_tag` 工具，不手拼命令」） | 同上 |
| 外部子进程 | `spawn('<tagsBin>', ['-j', …])`（`src/index.ts:37`）→ `E:/alice/anima/02-技能包/comfyui-good-anima/danbooru-tags/bin/danbooru-tags.exe` | 每次工具调用 |
| 落盘产物 | **无**——不写缓存/索引/侧车轨迹；sqlite 索引由 CLI 自带 | — |

## 5 · 边界与信任

- **能力边界 ≠ 沙箱**：`tagsBin` 是**可执行路径**，配置即「可执行任意二进制」的能力面。插件本身不校验二进制来源/签名/hash——`tagsBin` 的信任完全落在组合配置（谁改了 patch 谁就换了被执行的东西）。**不要**把它当作只读查询的安全边界。
- 不越界清单：不写文件、不更新索引、不联网（CLI 若联网属 CLI 行为，插件不感知）、不缓存、不重试、不校验标签语义正确性。
- 失败面：
  - 超时 → kill + `{ok:false, error:'danbooru-tags 超时（30000ms）'}`（拒绝 + 报错）
  - 无法启动 → `{ok:false, error:'无法启动 danbooru-tags：<msg>'}`（拒绝 + 报错）
  - CLI 返回含 `error` 字段 → `cliError` 把它 `JSON.stringify` 后作为 error（拒绝 + 报错，**保住结构化错误**）
  - 非 0 退出但 stdout 有可解析 JSON → `ok = true`（**语义：有 JSON 就算成功**，退出码不单独判——宽松口径，见 U1）
  - 退出 0 但 stdout 无 JSON → `ok = false`，error 取 stderr/raw 前 500 字符（拒绝 + 报错）
- 凭据/隐私：本插件不接触任何密钥；查询词会进入本地 CLI argv（可能出现在进程列表中，属本机范围）。

## 6 · 与既有机制的关系

- **技能链**：`comfyui-guidance` 把「验锚点」列为生图前置环节，本插件是该环节的**唯一执行器**（技能明示「不手拼命令」）。
- **记忆纪律（§5.8）**：标签事实（哪些 tag 存在）**不入记忆库**——它是可随时查的词表，本插件就是查询入口（避免「文件可索引内容入库」的反模式）。
- **组合变更纪律（§5.11）**：改源码 = 组合变更；改 `tagsBin` = 配置变更（走 `plugin_configure`，自带预检 + 哨兵重启）。
- **生效判据（改代码后怎么证明真的生效）**：
  1. 进程级：`self-plugins/dsh-anima-tags/lib/index.js` mtime 必须早于 3080 监听进程启动时间。本轮实测：lib = `2026-08-21 13:45:38`，web（PID 7080）启动 = `2026-09-14 10:05:47` → **已生效**。
  2. 二进制级：`Test-Path 'E:/alice/anima/02-技能包/comfyui-good-anima/danbooru-tags/bin/danbooru-tags.exe'` 为真（**改了插件但 exe 丢了 = 工具面整体不可用**）。
  3. 工具级：`anima_tag keyword=1girl` 返回 `ok:true` 且 `result` 含 canonical tag（一次真实调用即判真假）。
- **回退（出问题怎么退）**：
  1. 二进制换版：把 `tagsBin` 改回上一个可用 exe 路径（`plugin_configure`），或临时改回 `danbooru-tags`（走 PATH）。
  2. 组合级：`plugin_stop dsh-anima-tags` / 删 patch 行 → 工具面消失，`comfyui-guidance` 的验锚点环节退化为「不可用」，不会静默出错数据。
  3. 代码级：`git -C E:/alice/self-plugins/dsh-anima-tags log --oneline` → `git revert <sha>` → `pnpm build` → 预检 → 哨兵重启。

## 7 · 可证伪验收清单

| # | 可证伪命题 | 证据（单测名/命令/日志行/HTTP） | 状态 |
|---|-----------|------------------------------|------|
| A1 | 工具面恰为 2 个（`anima_tag`、`anima_tag_random`） | 会话工具列表 `anima_tag` 前缀命中 2；源码 `ctx.tools.register` 计数 = 2 | 已实测（源码计数） |
| A2 | 精确校验可用 | `anima_tag keyword=1girl matchMode=exact` → `ok:true` 且命中 canonical tag | **待验收** |
| A3 | 空参数不进 argv（I4） | 传 `keyword:''`/`group:''` → 不产生 `-k ''`/`-g ''`（等价于不传，返回与不传相同） | **待验收** |
| A4 | 无 CLI 即失败（I2） | 临时把 `tagsBin` 指向不存在路径 → 返回 `'无法启动 danbooru-tags：…'`，**不是**空成功 | **待验收** |
| A5 | 超时必杀（I3） | `timeoutMs` 调到极小值 → 返回超时错误且子进程不残留（任务管理器无该 PID） | **待验收** |
| A6 | 当前进程加载最新构建 | lib mtime `2026-08-21 13:45:38` < web PID 7080 启动 `2026-09-14 10:05:47` | 已实测（2026-09-14 读数） |
| A7 | 挂载行与 tagsBin 唯一 | `grep -n "dsh-anima-tags" cordis.patch.yml` → 1 命中（行 159）；`tagsBin` 行 161 | 已实测 |
| A8 | 包描述与实际工具面一致 | `package.json.description` 称「硬锚点校验/随机抽卡/**批量**」，实际无批量工具 → 命题：**描述含未实现能力**（§8） | 已实测（不一致，登记为缺口） |

## 8 · 与实现的关系

- 主实现：`self-plugins/dsh-anima-tags/src/index.ts`（唯一文件，无同语义副本）。
- 未实现/未验证部分**显式标注**：
  - **描述漂移（已实测）**：`package.json` description 与 `README.md` 公约声明写「批量」，但工具面只有查询与随机抽卡 2 个，**无批量工具**（批量可由 `limit`/`prefix` 部分替代，但语义不等价）。本文件只登记，不改源码/README。
  - **无单测**：仓库内无 `tests/`，A2–A5 无自动化证据。
  - **无自证侧车**：`ctx.logger` 不落盘 → 「装载成功/CLI 实际 argv/耗时」事后不可查（依据 §5.22，属可维护性缺口，见 U3）。
  - 索引更新机制不在本仓库：`danbooru-tags.exe` 的 sqlite 如何更新**未在本插件内定义**（U2）。

## 9 · 实践修订记录

- **2026-09-14 补课：本插件此前无语义文档（可维护性工程）**
  - 语义**被确认**：零重复实现（复用 CLI）、`-j` JSON 契约、`cliError` 优先级（data.error > stderr > raw）、`shell:false`、I4 空参不拼 argv。
  - 语义**被补充**：组合挂载点（patch 行 157–161，`tagsBin` 绝对路径）、消费方技能 `comfyui-guidance`（行 49/272）、「数据源 = 29MB sqlite 索引」这一事实。
  - 语义**被修正**：无（此前无文档）；但登记了 description「批量」与实际工具面不一致。
  - 教训（同时回写技能 `semantic-doc-first`）：**「透传型插件」的语义重心在 CLI 契约与失败归口**——不写清「退出码 0 但无 JSON / 非 0 但有 JSON」这两条边界，排障时会反复误判。

## 10 · 未决问题

- **U1 `ok` 判定口径**：`ok = code === 0 || data !== null`——非 0 退出但有 JSON 时算成功，没有把「退出码」与「数据」分开暴露。是否改为返回 `{exitCode, data}` 两字段由调用方裁决？倾向：保持宽松（CLI 的告警走 JSON 内 `error` 字段），但需一次真实反例验证。
- **U2 索引新鲜度**：sqlite 索引随 exe 分发，**何时更新、谁负责更新**未定义；词表落后会导致「新角色标签查不到」被误读为工具故障。倾向：在 `anima_tag` 输出里带索引版本/日期（若 CLI 支持），否则在 README 写明更新流程。
- **U3 可维护性缺口**：无落盘轨迹 → 「CLI 实际 argv / 耗时 / 断点」事后不可查（§5.22 五问中三问答不了）。倾向：补 `<DSH_HOME>/anima-tags-trace.jsonl`（吞错、一行一调用），但需主人确认是否要新增落盘面。
