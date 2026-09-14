<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 封装 danbooru-tags 二进制为 DSH 工具面（canonical 标签检索/硬锚点校验/随机抽卡），支撑 Anima 生图 prompt 组装
  inject: 'tools'
  tools: anima_tag,anima_tag_random
  runtime: host-only
  envDeps: danbooru-tags 可执行文件（默认从 PATH 找 `danbooru-tags`，部署时用 config 显式指定绝对路径）
  boundary: 只读检索（向本地 exe 传参取标签），不写任何文件/不调外部网络；标签正确性以该 exe 的离线 tag 库为准
  compat: cordis ^4.0.1 / dsh-tools ^0.1.0-rc.6
-->
# dsh-anima-tags

<p align="center">
  <a href="https://github.com/jonah791/dsh-anima-tags"><img src="https://img.shields.io/badge/version-0.1.1-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-33%20passed-brightgreen" alt="tests">
</p>

**一句话**：把本地 `danbooru-tags` 二进制包成两个工具——`anima_tag`（按关键词/前缀查 **canonical** 标签、校验拼写、导出可回填 prompt 的格式）与 `anima_tag_random`（按分组抽卡）。

**为什么值得用**：生图 prompt 里**拼错的标签会被模型静默忽略**（画风/角色特征直接丢失，却不报错）。用 canonical 标签库校验一遍，等于在写 prompt 前把「模型认不认这个词」这件事变成可查证的事实，而不是靠记忆赌；抽卡则用来跳出固定搭配，一次取样一批候选。

## 能力

| 工具 | 用途 |
|------|------|
| `anima_tag` | Danbooru 标签检索/校验（Anima 生图硬锚点）：按 `keyword`/`prefix`/`group` 查 canonical tag。artist 用 `@` 前缀，`group` 可传 `artist`/`character`/`series`/`general` 等。`matchMode` 默认 `auto`（先 exact 后 fuzzy），直接命中才用 `exact` |
| `anima_tag_random` | Danbooru 随机抽卡（Anima 生图 roll/抽卡）：按分组随机取候选 tag。用户明确要求随机/抽卡时才用；随机候选不用 `forPrompt` |

`anima_tag` 关键参数：`keyword` / `prefix` / `group`（如 `artist`/`character`/`series`/`general`）/ `category` / `matchMode`（`auto`|`exact`|`fuzzy`）/ `minCount`（最低使用次数过滤）/ `limit`（缺省 20）/ `forPrompt`（输出可回填 prompt 的格式）/ `compact` / `extended`。

## 快速开始

**1) 装依赖**：

```jsonc
"dsh-anima-tags": "link:<工作区>/self-plugins/dsh-anima-tags"
```

**2) 挂组合**（`tagsBin` 指向你机器上的 exe；**绝对路径只写进组合，不进源码**）：

```yaml
- id: anima-tags
  name: dsh-anima-tags
  config:
    tagsBin: '<你的目录>/danbooru-tags/bin/danbooru-tags.exe'
    timeoutMs: 30000
```

**3) 30 秒验证**：调 `anima_tag { keyword: "hatsune_miku", group: "character" }` → 应返回命中条目（带使用次数）；再调 `anima_tag { keyword: "hatsune_miku_typo_xxx" }` → 应返回无命中或 fuzzy 候选（**校验能力生效的证据**）。

## 配置

| 项 | 默认 | 说明 |
|----|------|------|
| `tagsBin` | `danbooru-tags` | 可执行文件：默认按 PATH 查找；部署时用绝对路径显式指定（本地路径不进源码） |
| `timeoutMs` | `30000` | 单次调用超时（超时单列，不混进 error 文案——见轨迹 `timedOut`） |

## 落盘与自证（出问题时先看这里）

每次调用落一行 JSONL 到 **`<DSH_HOME>/anima-tags-trace.jsonl`**：

| 阶段 | 含义 |
|------|------|
| `boot` | 插件装载（含配置快照与 `bin` 实际路径） |
| `query` | `anima_tag` 检索/校验 |
| `random` | `anima_tag_random` 抽卡 |

关键字段：`build`（`<版本>@<模块 mtime ms>`）、`op`、`bin`、`queryKind`/`query`（查什么）、`matchMode`、`budgetMs`、`hitCount`、`matchLayers`、`exitCode`、`durationMs`、`ok`、`timedOut`。

**一条命令答五问**：

```bash
tail -3 "$DSH_HOME/anima-tags-trace.jsonl"
# ① 跑的是哪个构建   → build = "<版本>@<模块 mtime ms>"
# ② 谁发起/查什么     → phase + op + bin（哪个 exe）+ queryKind/query
# ③ 断在哪一段       → exitCode / ok / error / timedOut（超时单列，不被伪装成 exit 0）
# ④ 结果质量         → hitCount + matchLayers（命中在哪一层：exact / fuzzy）+ matchMode
# ⑤ 耗时与预算       → durationMs vs budgetMs（预算耗尽 vs 窗口未命中）
```

写盘失败一律吞错返回 `false`，**绝不影响检索**。

## 生效判据与回退

**生效判据**（三选一，按可靠性排序）：
1. `tail -1 "$DSH_HOME/anima-tags-trace.jsonl"` 里 `build` 的 mtime **等于** `lib/index.js` 的 mtime ⇒ 进程在跑当前构建；
2. 生态级：`plugin_boot_status`（`dsh-plugin-bootreport`）返回 `liveNow` 含本插件 ⇒ 同上；
3. 行为级：`anima_tag` 能返回带使用次数的命中条目；`boot` 行里的 `bin` 与实际部署 exe 一致（**exe 路径写错时工具在但必失败**）。

> 注意：**重新构建 ≠ 生效**——产物 mtime 新只证明「构建过」，进程启动时间晚于产物 mtime 才算「在跑它」。

**回退**（三档）：
- 源码级：`git -C self-plugins/dsh-anima-tags revert <commit>` → 重新构建 → 预检 → 重启；
- 组合级：预设里给 `anima-tags` 行加 `disabled: true`（或移除该行）→ 哨兵重启；
- 运行期：无需回退（只读检索、无持久业务状态）；轨迹文件可随时删除。

## 测试

```bash
npm test        # = node --test "tests/*.test.mjs"
```

**33 例离线测试**（**不需要**真实 exe、不联网）：
- `tests/pure.test.mjs` — 纯逻辑：参数拼装（`keyword`/`prefix`/`group`/`matchMode` 组合）、输出容错解析（stdout 首 JSON 对象/数组、坏 JSON、空输出）、错误归口（超时文案 vs CLI 报错）、`describeQueryKind` 的分类
- `tests/trace.test.mjs` — 轨迹层：路径解析、序列化稳定、容错解析、**尸体测试**（不可写路径 → 返回 `false` 且不抛）、端到端接线

**真实外部依赖**：跑通业务需要 `danbooru-tags` 可执行文件（含其离线标签库）；子进程调用在测试中以桩替代。

## 设计要点

- **超时与退出码不互相伪装**：超时分支先 resolve 并打 `meta.timedOut`，后到的 `close` 事件**不再覆写**观测出口——否则「超时」会被记成「退出码 0」（本插件已修，`tests/pure.test.mjs` 覆盖）。
- **参数拼装与 IO 分离**：决策在 `src/pure.ts`（可离线单测），子进程 IO 只在 `index.ts`——`windowsHide: true` + `shell: false`（不经过 shell，参数不被二次解析）。
- **`matchMode` 默认 `auto`**：先 exact 后 fuzzy，把「是不是 canonical」和「有没有近似词」一次答完；`matchLayers` 记录命中发生在哪一层，避免 fuzzy 命中被误当硬锚点。
- **`forPrompt` 的语义边界**：只有检索到的 canonical 结果才适合回填 prompt；**随机抽卡结果不用** `forPrompt`（未经验证，回填等于把校验绕过去了）。
- **本地路径不进源码**：默认值只是命令名 `danbooru-tags`，真实 exe 路径一律由组合配置注入。

## 相关文档

| 文档 | 内容 |
|------|------|
| [`docs/semantic.md`](docs/semantic.md) | **权威契约**：定位与反定位、术语、概念模型与不变量、契约（含调用点清单）、边界与信任、可证伪验收清单、实践修订记录、未决问题 |
| [alice-digital-life](https://github.com/jonah791/alice-digital-life) | 本插件所属生态的中心索引（全部自研插件） |
| 技能 `comfyui-guidance` | ComfyUI / Anima 生图体系操控 + 参数经验 + 逆推（prompt 组装的上游方法论） |
| 技能 `plugin-maintainability` | 插件可维护性工程（自证轨迹 / 五问可取 / 观测不反噬） |

## License

MIT © jonah791

---

本插件属于我的数字生命爱丽丝（[alice-digital-life](https://github.com/jonah791/alice-digital-life)）的 DSH 自研插件生态——**50 个插件**按生命/认知/感知/行动/通信/治理/呈现七层组织。
