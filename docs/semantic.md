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
| 插件自身 | `src/index.ts:126` `ctx.tools.register(defineTool({name:'anima_tag' …}))` | 装载时注册 |
| 插件自身 | `src/index.ts:158` `ctx.tools.register(defineTool({name:'anima_tag_random' …}))` | 装载时注册 |
| 插件自身 | `src/index.ts:183` `ctx.effect(...)` → `logger.info('ready（danbooru-tags 检索面：2 工具；tagsBin=…）')` | 装载成功（**宿主 logger 不落盘**） |
| 插件自身 | `src/index.ts:90` `runTool(...)` —— **两个工具执行体的唯一收口**（观测层单点落笔，见 §4.4） | 每次工具调用 |
| 插件自身 | `src/index.ts:185` `animaTagsTrace({phase:'boot' …})` | `apply()` 装载（进程级构建自报，Q1） |
| 依赖服务 | `src/index.ts:inject = ['tools']` | cordis 激活门 |
| 技能（消费方） | `alice-self-assets/skills/comfyui-guidance/SKILL.md:49`（工具表：`anima_tag`（dsh-anima-tags）｜精确校验/模糊/随机抽卡/批量） | 生图 prompt 组装前验锚点 |
| 技能（消费方） | `alice-self-assets/skills/comfyui-guidance/SKILL.md:272`（「封装后直接走 `anima_tag` 工具，不手拼命令」） | 同上 |
| 外部子进程 | `spawn('<tagsBin>', ['-j', …])`（`src/index.ts:54`）→ `E:/alice/anima/02-技能包/comfyui-good-anima/danbooru-tags/bin/danbooru-tags.exe` | 每次工具调用 |
| 落盘产物 | `<DSH_HOME>/anima-tags-trace.jsonl`（自证侧车，2026-09-14 批次 S4-A 新增，见 §4.4）。sqlite 索引仍由 CLI 自带 | 每次 `apply()` + 每次工具调用 |

### 4.4 自证轨迹契约（`<DSH_HOME>/anima-tags-trace.jsonl`）`[MUST]`

**动机**：本插件是透传型——关键事实全在插件之外（CLI 到底退到了哪一层匹配 / 命中几条 / 断在哪一段），
而 `ctx.logger` **不落盘**（AGENTS.md §5.22 规则 1）。补课前的状态：五问里三问答不了。

- **落盘路径**：`<DSH_HOME>/anima-tags-trace.jsonl`（`DSH_HOME` 环境变量优先，缺省 `<homedir>/.dsh`；
  解析走 `src/trace.ts:resolveHome` **单一真源**）。追加式 JSONL，一行一事件。
- **阶段枚举**（`AnimaTracePhase`，闭集）：`boot`（`apply()` 进程级构建自报）
  → `query`（`anima_tag`）→ `random`（`anima_tag_random`）。**无自由阶段字符串**。
- **行 schema**（字段固定，`boot` 行用中性值填充，`tail` 后可直接读列）：

  | 字段 | 含义 | 回答哪一问 |
  |------|------|-----------|
  | `atMs` | 写入时刻（ms epoch） | 时间线 join |
  | `phase` | `boot` / `query` / `random` | Q2 谁发起 |
  | `build` | `<version>@<模块 mtime ms>` | **Q1 线上跑的是哪个构建** |
  | `op` | `anima_tag` / `anima_tag_random` / `apply` | Q2 |
  | `bin` | `Config.tagsBin`（**投给谁**——换 exe 是最高频的故障源） | Q2/Q3 |
  | `queryKind` | `keyword` / `prefix` / `group` / `category` / `random` / `none` | **Q2 查询类型** |
  | `query` | 查询词摘要（**脱敏 + 截断 120**） | Q2 输入侧 |
  | `matchMode` | 请求的 `--match-mode`（空串 = 未指定 → CLI 缺省 `auto`） | Q4 |
  | `budgetMs` | 子进程超时预算（`Config.timeoutMs`） | Q5 预算 |
  | `hitCount` | 命中条数（**跨分组求和**） | **Q4 结果质量** |
  | `matchLayers` | **实测命中层**（CLI `match_layer` 去重，如 `exact_tag`） | **Q4 是否退回 fuzzy** |
  | `exitCode` | CLI 退出码（`-1` = 未执行到子进程） | Q3 |
  | `durationMs` | 调用耗时（ms） | Q5 |
  | `ok` | `cliError` 判 `null` = 成功 | Q3 |
  | `timedOut` | 是否走超时分支（**超时单列，不靠 error 文案辨认**） | **Q3 断点分类** |
  | `error?` | `cliError` 归口文案（截 500） | Q3 |

- **不变量**：① **`timedOut` / `exitCode=-1` / `ok=false` 三态可辨**——「超时」「无 CLI」「CLI 报错」
  三种同为 0 命中的场景必须能区分（补课前它们都只是「结果空」）；
  ② **`query` 落盘前必经 `redactQuery`**——凭据形状串一个字符都不落盘（§7 A16 有尸体测试）；
  ③ **观测绝不反噬主流程**：`appendTraceEntry` 全部 IO 失败吞错并返回 `false`，业务异常原样重抛；
  ④ **业务返回形状逐字不变**（`{ok:false,result:null,error}` / `{ok:true,result:data}`）。
- **调用点清单**：`src/index.ts:90 runTool()`（唯一收口，包住两个执行体）+ `src/index.ts:185` boot 行。
  **新增工具必须经 `runTool()` 落笔**——绕开它 = 悄悄制造新的观测盲区。
- **查询方式**：`tail -3 <DSH_HOME>/anima-tags-trace.jsonl`（最近三次调用的五问）。

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
| A3 | 空参数不进 argv（I4） | `npm test` → `buildQueryArgs: 空参数全部不传——只留 -j`（空串/纯空白/undefined 三类）+ `边界——数值 0 是合法参数` | 已实测（2026-09-14，离线的 I4 机器版） |
| A4 | 无 CLI 即失败（I2） | 临时把 `tagsBin` 指向不存在路径 → 返回 `'无法启动 danbooru-tags：…'`，**不是**空成功 | **待验收**（需进程级；其错误归口已由 `cliError` 三级回落用例覆盖） |
| A5 | 超时必杀（I3） | `timeoutMs` 调到极小值 → 返回超时错误且子进程不残留（任务管理器无该 PID） | **待验收**（需进程级；超时文案由 `timeoutMessage` 用例钉住） |
| A6 | 当前进程加载最新构建 | lib mtime `2026-08-21 13:45:38` < web PID 7080 启动 `2026-09-14 10:05:47` | 已实测（2026-09-14 读数；本次补课重建后需重新部署核对） |
| A7 | 挂载行与 tagsBin 唯一 | `grep -n "dsh-anima-tags" cordis.patch.yml` → 1 命中（行 159）；`tagsBin` 行 161 | 已实测 |
| A8 | 包描述与实际工具面一致 | `package.json.description` 称「硬锚点校验/随机抽卡/**批量**」，实际无批量工具 → 命题：**描述含未实现能力**（§8） | 已实测（不一致，登记为缺口） |
| A9 | 参数 → CLI flag 映射逐条可验（含顺序） | `npm test` → `buildQueryArgs` / `buildRandomArgs` 7 条用例（§4.2 的映射表变成断言） | 已实测（2026-09-14） |
| A10 | stdout 容错解析：BOM / 前置日志行 / 对象优先 / 半截 JSON | `npm test` → `parseTagsOutput` 6 条用例 | 已实测（2026-09-14） |
| A11 | 错误归口三级回落（data.error → stderr → raw → 兜底）+ 500 字截断 | `npm test` → `cliError` 3 条用例 | 已实测（2026-09-14） |
| A12 | 失败/退化路径被机器锁住（S6 判据） | `npm test` → 17/17 pass，含空参/非零退出/半截 JSON/BOM/quirk 各失败面 | 已实测（2026-09-14） |
| A13 | 每次调用落一行自证轨迹（五问可一条命令答） | `npm test` → `tests/trace.test.mjs:离线组合` 真写出四行；线上：`tail -3 $DSH_HOME/anima-tags-trace.jsonl` 可读 `build/op/bin/queryKind/hitCount/matchLayers/exitCode/durationMs/ok/timedOut` | **待线上验收**（离线已锁；本批不部署，由派发者统一部署） |
| A14 | **「超时 / 无 CLI / CLI 报错 / 查无结果」四态在轨迹里可辨** | `npm test` → 离线组合四段：查无结果(`ok=true,hitCount=0,exitCode=0`)、超时(`timedOut=true,exitCode=-1,durationMs==budgetMs`)、无 CLI(`ok=false,timedOut=false,error=/无法启动/`)、精确命中(`matchLayers=['exact_tag']`) | **已实测（离线）** |
| A15 | 观测绝不反噬主流程（IO 失败不抛） | `npm test` → `尸体测试：父路径是普通文件 → 返回 false 且不抛`（`assert.doesNotThrow` + `=== false`） | **已实测** |
| A16 | **凭据不落盘**（隐私红线，含尸体测试） | `npm test` → `隐私尸体测试`：喂 `sk-live-…`/`ghp_…`/`api_key=hunter2secret`/`Bearer <32位>` 四种 keyword → 断言落盘原文 `includes(secret) === false`，且 `[redacted]` 确实出现（排除「没写进去」的假绿） | **已实测** |
| A17 | 命中数与命中层提取对脏数据设防（D4） | `npm test` → `summarizeTagsResult` 脏数据组：`{}`（**查不到的真实形状**）/`null`/字符串/`{error:…}`/`{general:null}`/元素为 `null`·数字·字符串/`match_layer` 非字符串 → 全部退化为 0 命中或忽略，不抛 | **已实测** |
| A18 | 查询类型判定与 `pure.ts` 的 I4 门控同源 | `npm test` → `describeQueryKind`：keyword>prefix>group>category 优先级、空串/纯空白不算参数、random 阶段只记 group | **已实测** |
| A19 | CLI 输出形状的证据来自**探针实测**而非猜测 | 2026-09-14 探针：`-j -k 1girl` → `{"general":[{…,"match_layer":"exact_tag"}]}`；查不到 → **`{}`（空对象）**；typo 关键词（`1gurl`/`1girll`，含 `--match-mode fuzzy`）→ 同样 `{}` | 已实测（本机 exe，命令见 §9） |

## 8 · 与实现的关系

- 主实现：`self-plugins/dsh-anima-tags/src/index.ts`（IO 接线：spawn / 超时 / 工具注册）**+ `src/pure.ts`（纯逻辑层：`buildQueryArgs` / `buildRandomArgs` / `parseTagsOutput` / `cliError` / `timeoutMessage`）+ `src/trace.ts`（自证轨迹层：`resolveHome` / `describeQueryKind` / `summarizeTagsResult` / `redactQuery` + 薄 IO，2026-09-14 批次 S4-A 新增）**；三者无同语义副本。产物 `lib/index.js` + `lib/pure.js` + `lib/trace.js`。测试：`tests/pure.test.mjs`（17 例）+ `tests/trace.test.mjs`（**16 例**）。
- 未实现/未验证部分**显式标注**：
  - **描述漂移（已实测）**：`package.json` description 与 `README.md` 公约声明写「批量」，但工具面只有查询与随机抽卡 2 个，**无批量工具**（批量可由 `limit`/`prefix` 部分替代，但语义不等价）。本文件只登记，不改源码/README。
  - 无单测文件（仓库内无 `tests/`），A2–A5 无自动化证据。**已部分闭环（2026-09-14）**：现有 17 例离线回归覆盖参数映射 / 容错解析 / 错误归口（A9–A12），A2/A4/A5 仍是进程级验收。
  - **自证侧车已补（2026-09-14 批次 S4-A）**：`<DSH_HOME>/anima-tags-trace.jsonl`（§4.4）。
    此前 `ctx.logger` 不落盘 ⇒「CLI 实际 argv / 命中数 / 耗时 / 断点」事后不可查（§5.22 缺口，见 U3）；
    现在 `tail` 一行即可回答五问。**仍待线上验收**：本批不部署（由派发者统一部署），轨迹行尚未在真实 web 进程里产出。
  - 索引更新机制不在本仓库：`danbooru-tags.exe` 的 sqlite 如何更新**未在本插件内定义**（U2）。

## 9 · 实践修订记录

- **2026-09-14 补课：本插件此前无语义文档（可维护性工程）**
  - 语义**被确认**：零重复实现（复用 CLI）、`-j` JSON 契约、`cliError` 优先级（data.error > stderr > raw）、`shell:false`、I4 空参不拼 argv。
  - 语义**被补充**：组合挂载点（patch 行 157–161，`tagsBin` 绝对路径）、消费方技能 `comfyui-guidance`（行 49/272）、「数据源 = 29MB sqlite 索引」这一事实。
  - 语义**被修正**：无（此前无文档）；但登记了 description「批量」与实际工具面不一致。
  - 教训（同时回写技能 `semantic-doc-first`）：**「透传型插件」的语义重心在 CLI 契约与失败归口**——不写清「退出码 0 但无 JSON / 非 0 但有 JSON」这两条边界，排障时会反复误判。
- **2026-09-14 · 可维护性补课（S3 有测试 / S6 失败路径）：抽纯逻辑层 + 17 例回归；§4.2 映射表变断言**
  - **抽层（行为不变的搬家）**：新增 `src/pure.ts` —— `buildQueryArgs`（原 `anima_tag.execute` 里 12 行 `if (args.x !== undefined && args.x.trim() !== '')` 拼装）/ `buildRandomArgs`（原 `-j -r <count>` 那三行）/ `parseTagsOutput`（原 `close` 回调里的 trim+BOM+整体 JSON+截块解析）/ `cliError`（原模块级函数）/ `timeoutMessage`。`index.ts` 只留 spawn / 定时器 / 工具注册。`runTags` 的返回类型由匿名结构改为导出的 `TagsRunResult`（**形状不变**）。
  - **语义被确认（并升级为断言）**：§4.2 的参数 → flag 映射表此前只是文档，现在逐条有测试；空串/纯空白/undefined 一律不进 argv；`minCount: 0` / `limit: 0` 是合法参数（不得按 falsy 丢弃）；`count` 缺省 1；开关必须严格 `true`。
  - **语义被补充（新不变量）**：`ok` 判定口径 `code === 0 || data !== null` 的**两个方向**都要被钉住——① 非 0 退出但携 JSON → 判成功；② **退出 0 但输出不可解析 → 也判成功**（`result:null`，`cliError` 返回 null）＝**假成功**。②已用「文档化 quirk」用例锁住并登记 §10 U1，**本次不改行为**（宽松口径是既有设计取舍，改它需要一次真实反例验证）。
  - **行为变更：无**（逐条比对：参数数组、解析分支、错误文案、500 字截断、超时文案全部逐字一致）。
  - **教训**：透传型插件的可测性红利最大——参数映射与输出解析是**纯字符串进出**，一次抽取就换来了 17 例秒级回归，把「CLI 换了输出格式」这类事故从「线上才发现」提前到「改完就红」。

- **2026-09-14 · 批次 S4-A：自证轨迹层 + CLI 输出形状探针（观测层新增，业务行为零变更）**
  - **语义被补充（新不变量）**：**同为「空结果」的四种场景必须可辨**——「查无结果」（`ok=true, hitCount=0,
    exitCode=0`）/「超时」（`timedOut=true, exitCode=-1, durationMs==budgetMs`）/「无 CLI」（`ok=false,
    timedOut=false, error=无法启动…`）/「CLI 报错」。补课前它们对调用方都只是「结果空」，这正是本插件
    最主要的排障盲区。`timedOut` **单列成字段**而不是靠 error 文案辨认——文案措辞会变，字段不会。
  - **语义被补充（探针实测，此前文档里没有的事实）**：CLI 的 `-j` 输出是**按分组聚合的对象**
    （`{"general":[…],"artist":[…]}`），**查不到时是 `{}` 而不是 `[]`**；每条命中带
    `match_score` 与 **`match_layer`**（精确命中为 `exact_tag`）——后者原本无人知道，
    现在成了「是否退回 fuzzy」的**唯一可观测判据**。探针命令：
    `E:/alice/anima/02-技能包/comfyui-good-anima/danbooru-tags/bin/danbooru-tags.exe -j -k 1girl`。
  - **语义被修正（我自己的预期错）**：首版单测把断言写成「keyword/prefix 优先级」时未注意
    `describeQueryKind` 的 `random` 阶段不吃关键词——已按真实语义写清（random 只记 group）；
    另首版测试文件头注释里写了 `**结果摘要**/序列化`，其中 `**/` 被 JS 当作**块注释终止符**
    ⇒ 整个测试文件语法错。**教训：块注释里不要出现 `**/`**（属编辑期陷阱，非业务缺陷）。
  - **行为变更清单**：**无**——`runTags` 仅新增「观测出口 `meta`」参数与两处赋值；
    `runTool` 逐字复刻原两个 `execute` 的返回形状（`{ok:false,result:null,error}` / `{ok:true,result:data}`）；
    超时分支在 `close` 时**不覆写** `meta.exitCode`（否则「超时」会被后到的 close 伪装成「退出码 0」——
    这是观测层的正确性要求，不改变业务 resolve 顺序）。
  - **教训**：透传型插件的「可观测性」不靠读自己的代码，靠**探一次 CLI**——`match_layer`、
    `{}` vs `[]` 这两个事实都不是能猜出来的，猜错就会写出一条「永远 hitCount=0」的空轨迹。

## 10 · 未决问题

- **U1 `ok` 判定口径**：`ok = code === 0 || data !== null`——非 0 退出但有 JSON 时算成功，没有把「退出码」与「数据」分开暴露。是否改为返回 `{exitCode, data}` 两字段由调用方裁决？倾向：保持宽松（CLI 的告警走 JSON 内 `error` 字段），但需一次真实反例验证。
- **U2 索引新鲜度**：sqlite 索引随 exe 分发，**何时更新、谁负责更新**未定义；词表落后会导致「新角色标签查不到」被误读为工具故障。倾向：在 `anima_tag` 输出里带索引版本/日期（若 CLI 支持），否则在 README 写明更新流程。
- **U3 可维护性缺口（✅ 已闭环 2026-09-14 批次 S4-A）**：无落盘轨迹 → 「CLI 实际 argv / 耗时 / 断点」
  事后不可查（§5.22 五问中三问答不了）。**已按倾向实现**：`<DSH_HOME>/anima-tags-trace.jsonl`（§4.4），
  吞错返回 bool + 尸体测试 + 隐私尸体测试。**遗留**：需一次线上验收（真实 web 进程里 `tail` 出轨迹行）。
- **U4（新，2026-09-14）「假成功」路径**：退出码 0 + 输出不可解析 → 工具返回 `{ok:true, result:null}`（`cliError` 也判成功），调用方拿到 null 会以为「查无结果」。判据已由 quirk 用例钉住。倾向修法：`ok` 改为 `data !== null`（或 `code === 0 && data !== null`）——**属行为变更**，需一次真实反例（CLI 换输出格式/静默 exit 0）后再定调。与 U1 同一处取舍。**注（S4-A）**：轨迹里的 `ok` 沿用 `cliError` 口径（= 业务口径），故「假成功」在轨迹里同样显示 `ok=true, hitCount=0`——本批**未**借此悄悄改判据，保持观测与业务同源。
- **U5（新，2026-09-14）超时错误丢弃已收集的 stdout/stderr**：超时分支只返回 `'超时（Nms）'`，CLI 挂起前打印的线索（如「loading index…」）被丢掉，定位「卡在哪一步」缺证据。倾向：把 `stdout/stderr` 尾部各 200 字拼进超时文案（属行为变更，需定调）。
- **U6（新，2026-09-14 批次 S4-A）`matchLayers` 尚未见过 `fuzzy` 取值**：探针用 typo 关键词
  （`1gurl` / `1girll`，含显式 `--match-mode fuzzy`）全部返回 `{}` ⇒ **从未实测到 fuzzy 层标签**。
  故 schema 里的 `matchLayers` 是「CLI 报什么记什么」的透传，**「是否退回 fuzzy」目前只能靠
  出现非 `exact_tag` 取值来判**。倾向：等一次真实模糊命中（如查一个近似角色名）后，把该取值
  补进本文档并加一条夹具。需主人/实际使用给样本——**不得编造取值**。
- **U7（新，2026-09-14 批次 S4-A）轨迹文件无轮转**：`anima-tags-trace.jsonl` 为纯追加，无上界。
  本插件调用频率中低（生图前验锚点），短期无风险；长期仍应按 `dsh-plugin-bootreport` 的
  「有界裁剪（`keepLines + 50`）」加上限，且断言写「有界」而非「恰好等于」。需裁决是否本轮补。

## 附 · 快速取证命令

```bash
# Q1–Q5 一条命令（最近三次调用）
tail -3 "$DSH_HOME/anima-tags-trace.jsonl"
# 只看失败/超时笔次（Q3 断点分类）
grep -E '"ok":false|"timedOut":true' "$DSH_HOME/anima-tags-trace.jsonl" | tail -5
# 只看命中层不是精确匹配的笔次（U6：等一个真实 fuzzy 样本）
grep -v '"matchLayers":\["exact_tag"\]' "$DSH_HOME/anima-tags-trace.jsonl" | tail -5
```
