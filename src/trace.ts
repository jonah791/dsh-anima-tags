/**
 * 标签检索自证轨迹（可维护性 S4 证据层 · 2026-09-14 批次 S4-A）。
 *
 * 动机：本插件是**透传型**（把 `danbooru-tags.exe` 包成工具面），关键事实全在插件之外——
 * 「这次查的是 keyword 还是 prefix、CLI 到底退到了哪一层匹配、命中几条、花了多久、断在哪一段」
 * 只有 `ctx.logger`（**宿主 logger 不落盘**）。于是「生图 prompt 里的锚点为什么没验上」
 * 这类问题只能靠外部脚本反解会话事件流（AGENTS.md §5.22 规则 1）。
 *
 * 修法：每次调用落一行 JSONL 侧车——`<DSH_HOME>/anima-tags-trace.jsonl`。
 * 阶段枚举：`boot`（进程级构建自报）→ `query`（anima_tag）→ `random`（anima_tag_random）。
 *
 * 轨迹回答的五问（技能 plugin-maintainability 判据）：
 *   Q1 线上跑哪个构建 → `build`（`<version>@<模块 mtime ms>`）
 *   Q2 谁发起         → `phase` + `op` + `bin`（哪个 exe）+ `queryKind`/`query`（查什么）
 *   Q3 断在哪一段      → `exitCode` / `ok` / `error` / `timedOut`（超时单列，不混进 error 文案）
 *   Q4 结果质量        → `hitCount`（命中数）+ `matchLayers`（**实测命中层**：是否退回 fuzzy）
 *   Q5 耗时与预算      → `durationMs` vs `budgetMs` + `timedOut`（预算耗尽 vs 窗口未命中）
 *
 * 观测绝不反噬主流程（技能 C4）：全部 IO 失败吞错并返回 `false`——写不进去也不影响检索。
 *
 * @module dsh-anima-tags/trace
 */
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 阶段枚举：一次进程从 boot 起，每次调用一行。 */
export type AnimaTracePhase = 'boot' | 'query' | 'random'

/** 一行标签检索轨迹。字段**固定**（boot 行用中性值填充），便于 `tail` 后直接读列。 */
export interface AnimaTraceEntry {
  /** 写入时刻（ms epoch）。 */
  atMs: number
  phase: AnimaTracePhase
  /** 构建标识 `<version>@<模块 mtime ms>`（Q1）。 */
  build: string
  /** 工具名（`anima_tag` / `anima_tag_random` / `apply`）。 */
  op: string
  /** 被调用的 CLI（`Config.tagsBin` 原样；Q2「投给谁」）。 */
  bin: string
  /** 查询类型：`keyword` / `prefix` / `group` / `category` / `random` / `none`（Q2）。 */
  queryKind: string
  /** 查询词摘要（**脱敏 + 截断 120**）。 */
  query: string
  /** 请求的 `--match-mode`（空串 = 未指定 → CLI 缺省 `auto`）。 */
  matchMode: string
  /** 子进程超时预算（ms；对照 `durationMs` 判「预算耗尽」）。 */
  budgetMs: number
  /** 命中条数（跨分组求和，Q4 量级）。 */
  hitCount: number
  /** **实测命中层**（CLI 的 `match_layer` 去重；如 `exact_tag`）——回答「是否退回 fuzzy」。 */
  matchLayers: string[]
  /** CLI 退出码（`-1` = 未执行到子进程）。 */
  exitCode: number
  /** 调用耗时（ms；boot=0）。 */
  durationMs: number
  /** 是否成功（`cliError` 判 `null` 即成功）。 */
  ok: boolean
  /** 是否走了超时分支（Q3 断点分类：超时 ≠ CLI 报错）。 */
  timedOut: boolean
  /** 失败原因（`cliError` 归口文案，截 500）。 */
  error?: string
}

/** 本模块需要的最小配置面。 */
export interface TraceConfig {
  tagsBin: string
  timeoutMs: number
}

/** 查询参数的结构上界（`TagQueryArgs` / `TagRandomArgs` 都满足它）。 */
export interface TraceQueryArgs {
  keyword?: string
  prefix?: string
  group?: string
  category?: string
  matchMode?: string
}

/** 一次子进程调用的观测面（由 `runTags` 填充；纯观测，不参与业务判定）。 */
export interface TagsRunMeta {
  exitCode: number
  timedOut: boolean
}

/** 解析 DSH_HOME：环境变量优先，缺省 `<homedir>/.dsh`（单一真源——**不要在多处各写一份**）。 */
export function resolveHome(
  env: Record<string, string | undefined> = process.env,
  fallback = homedir(),
): string {
  const raw = env['DSH_HOME']
  return raw !== undefined && raw.trim() !== '' ? raw : join(fallback, '.dsh')
}

/** 轨迹文件路径（纯函数）。 */
export function animaTracePath(home: string): string {
  return join(home, 'anima-tags-trace.jsonl')
}

/** 文件 mtime（ms；不可得为 0）。 */
export function mtimeOf(file: string): number {
  try {
    return Math.round(statSync(file).mtimeMs)
  } catch {
    return 0
  }
}

/** 从 `<file>` 所在包的 package.json 读版本（读不到返回空串，不抛）。 */
export function readPackageVersion(file: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(file), '..', 'package.json'), 'utf8')) as {
      version?: string
    }
    return typeof pkg.version === 'string' ? pkg.version : ''
  } catch {
    return ''
  }
}

/** 构建标识 `<version>@<模块 mtime ms>`（版本缺失退化为 `unknown@<mtime>`）。 */
export function buildStamp(file: string, version = ''): string {
  return version !== '' ? `${version}@${String(mtimeOf(file))}` : `unknown@${String(mtimeOf(file))}`
}

/** 文本截断（摘要用；超长补省略号）。 */
export function truncate(text: string, max = 120): string {
  return text.length <= max ? text : text.slice(0, max) + '…'
}

/**
 * 凭据脱敏（纯函数，**隐私红线**）：本插件的参数面是标签词，凭据风险本身低，
 * 但 `keyword`/`prefix` 是**模型自由输入的字符串**——统一按形状擦除，
 * 换掉「逐个插件判断要不要脱敏」这种必然会漂移的做法（判据单一真源）。
 */
export function redactQuery(text: string): string {
  return text
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/(?<![A-Za-z0-9])(api[_-]?key|token|secret|password|passwd|passphrase|authorization)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g, '[redacted]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{16,}/g, '[redacted]')
    .replace(/\bAKIA[0-9A-Z]{12,}/g, '[redacted]')
    .replace(/[A-Za-z0-9+/=_-]{32,}/g, '[redacted]')
}

/**
 * 查询类型判定（纯函数，Q2）：优先级与工具描述一致（「按 keyword/prefix/group 查」）。
 * `random` 阶段没有关键词语义，只记分组过滤。
 */
export function describeQueryKind(args: TraceQueryArgs, phase: 'query' | 'random'): { kind: string; value: string } {
  if (phase === 'random') {
    const g = args.group
    return { kind: 'random', value: g !== undefined && g.trim() !== '' ? g : '' }
  }
  const candidates: Array<[string, string | undefined]> = [
    ['keyword', args.keyword], ['prefix', args.prefix],
    ['group', args.group], ['category', args.category],
  ]
  for (const [kind, raw] of candidates) {
    if (raw !== undefined && raw.trim() !== '') return { kind, value: raw }
  }
  return { kind: 'none', value: '' }
}

/**
 * 结果摘要（纯函数，Q4）：**跨分组求和命中数 + 去重实测命中层**。
 *
 * 真实输出形状（2026-09-14 探针实测）：`{"general":[{"tag":"1girl",…,"match_layer":"exact_tag"}]}`；
 * 查不到时是 **`{}`（空对象）而不是 `[]`**；失败时可能是 `{"error":…}`。
 * 故必须**对脏数据设防**（缺陷形状 D4）：`null`/非对象/数组/分组值非数组一律退化为 0 命中，不抛。
 */
export function summarizeTagsResult(data: unknown): { hitCount: number; matchLayers: string[] } {
  const hit: { hitCount: number; matchLayers: string[] } = { hitCount: 0, matchLayers: [] }
  const addItem = (item: unknown): void => {
    hit.hitCount += 1
    if (item === null || typeof item !== 'object') return
    const layer = (item as { match_layer?: unknown }).match_layer
    if (typeof layer === 'string' && layer !== '' && !hit.matchLayers.includes(layer)) hit.matchLayers.push(layer)
  }
  if (data === null || typeof data !== 'object') return hit
  if (Array.isArray(data)) {
    for (const item of data) addItem(item)
    return hit
  }
  for (const value of Object.values(data as Record<string, unknown>)) {
    if (Array.isArray(value)) for (const item of value) addItem(item)
  }
  return hit
}

/** 稳定序列化（键序固定 + 单行 JSON）。 */
export function serializeTraceEntry(entry: AnimaTraceEntry): string {
  const ordered: AnimaTraceEntry = {
    atMs: entry.atMs,
    phase: entry.phase,
    build: entry.build,
    op: entry.op,
    bin: entry.bin,
    queryKind: entry.queryKind,
    query: entry.query,
    matchMode: entry.matchMode,
    budgetMs: entry.budgetMs,
    hitCount: entry.hitCount,
    matchLayers: entry.matchLayers,
    exitCode: entry.exitCode,
    durationMs: entry.durationMs,
    ok: entry.ok,
    timedOut: entry.timedOut,
    ...(entry.error !== undefined ? { error: entry.error } : {}),
  }
  return JSON.stringify(ordered)
}

/** 容错解析：坏行/半行/空行跳过，不抛。 */
export function parseTraceEntries(text: string): AnimaTraceEntry[] {
  const out: AnimaTraceEntry[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    try {
      const parsed = JSON.parse(line) as AnimaTraceEntry
      if (typeof parsed.atMs === 'number' && typeof parsed.phase === 'string') out.push(parsed)
    } catch {
      continue
    }
  }
  return out
}

/** 读轨迹文件；缺失/不可读返回空数组（诊断工具的安全入口）。 */
export function readTraceEntries(path: string): AnimaTraceEntry[] {
  try {
    return parseTraceEntries(readFileSync(path, 'utf8'))
  } catch {
    return []
  }
}

/** 追加一行（失败即吞并返回 false：观测绝不反噬检索）。 */
export function appendTraceEntry(path: string, entry: AnimaTraceEntry): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, serializeTraceEntry(entry) + '\n', 'utf8')
    return true
  } catch {
    return false
  }
}

/** 记一笔标签检索轨迹（薄接线：补 atMs，路径缺省 `<DSH_HOME>/anima-tags-trace.jsonl`）。 */
export function animaTagsTrace(
  entry: Omit<AnimaTraceEntry, 'atMs'>,
  opts: { path?: string; home?: string; now?: number } = {},
): boolean {
  const path = opts.path ?? animaTracePath(opts.home ?? resolveHome())
  return appendTraceEntry(path, { atMs: opts.now ?? Date.now(), ...entry })
}
