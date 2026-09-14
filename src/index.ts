/**
 * dsh-anima-tags — danbooru-tags 封装插件（2026-08-20 主人需求）
 *
 * 封装 danbooru-tags.exe（Anima 生图硬锚点校验/随机抽卡，数据源 29MB sqlite 索引）
 * 为 DSH 工具面，支撑 Anima 生图 prompt 组装（comfyui-animatool 方法论的「验锚点」环节）：
 *   anima_tag：标签查询/校验（精确/模糊/前缀/分组/批量）
 *   anima_tag_random：随机抽卡（候选池）
 *
 * 设计：
 * - 子进程调用 danbooru-tags.exe（-j JSON 结构化输出），零重复实现（复用交接包已验证的 CLI）
 * - tagsBin 指向 danbooru-tags 可执行文件（默认命令名，具体路径由组合配置显式指定）
 * - 工具面 = 2 个：查询/校验 + 随机抽卡
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  buildQueryArgs, buildRandomArgs, cliError, parseTagsOutput, timeoutMessage,
  type TagQueryArgs, type TagRandomArgs, type TagsRunResult,
} from './pure.ts'
import {
  animaTagsTrace, buildStamp, describeQueryKind, readPackageVersion, redactQuery,
  summarizeTagsResult, truncate,
  type TagsRunMeta, type TraceQueryArgs,
} from './trace.ts'

export const name = 'anima-tags'
export const inject = ['tools'] as const

const OWN_FILE = fileURLToPath(import.meta.url)
/** 进程级构建自报 `<version>@<模块 mtime ms>`（Q1：线上跑的是哪个构建）。 */
const BUILD = buildStamp(OWN_FILE, readPackageVersion(OWN_FILE))

export interface Config {
  /** danbooru-tags.exe 可执行文件绝对路径 */
  tagsBin: string
  /** 子进程超时（ms） */
  timeoutMs: number
}
export const Config = z.object({
  // 默认命令名（PATH 查找）；部署组合用 config 显式指定 exe 绝对路径（本地路径不进源码）
  tagsBin: z.string().default('danbooru-tags'),
  timeoutMs: z.number().default(30000),
})

/** 调用 danbooru-tags，返回解析后的 JSON（stdout 首 JSON 对象/数组）。
 * 决策在 src/pure.ts（参数拼装 / 容错解析 / 错误归口，均可离线单测）；这里只做子进程 IO。
 *  `meta` 是**纯观测出口**（调用方传入即被填充）：Q3 要能区分「超时」与「CLI 报错」、
 *  Q5 要能对照预算，而这些只在定时器/回调里可得，故在此收口填出，不改变任何业务分支。 */
function runTags(config: Config, args: string[], timeoutMs: number | undefined, meta: TagsRunMeta): Promise<TagsRunResult> {
  return new Promise((resolve) => {
    const child = spawn(config.tagsBin, args, {
      windowsHide: true,
      shell: false,
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      meta.timedOut = true
      resolve({ ok: false, data: null, raw: '', stderr: timeoutMessage(timeoutMs ?? config.timeoutMs) })
    }, timeoutMs ?? config.timeoutMs)
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
    child.on('close', (code) => {
      clearTimeout(timer)
      // 超时分支已 resolve，此处不再覆写观测出口（否则「超时」会被后到的 close 伪装成「退出码 0」）
      if (!meta.timedOut) meta.exitCode = typeof code === 'number' ? code : -1
      const parsed = parseTagsOutput(stdout, code)
      resolve({ ok: parsed.ok, data: parsed.data, raw: parsed.raw, stderr: stderr.trim() })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, data: null, raw: '', stderr: '无法启动 danbooru-tags：' + err.message })
    })
  })
}

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('dsh-anima-tags')

  /**
   * 两个工具执行体的**唯一收口**：调 CLI → `cliError` 归口 → 落一行轨迹。
   * 单点落笔（可维护性纪律 5）：新增工具必须经此，否则会悄悄制造新的观测盲区。
   * 业务返回形状**逐字保持原实现**（`{ok:false,result:null,error}` / `{ok:true,result:data}`）；
   * 业务异常原样重抛（观测层不吞业务错），但先记一笔失败轨迹。
   */
  async function runTool(
    phase: 'query' | 'random',
    op: string,
    args: TraceQueryArgs,
    cliArgs: string[],
  ): Promise<{ ok: boolean; result: TagsRunResult['data']; error?: string }> {
    const meta: TagsRunMeta = { exitCode: -1, timedOut: false }
    const startedAtMs = Date.now()
    let r: TagsRunResult | undefined
    let thrown: unknown = null
    try {
      r = await runTags(config, cliArgs, undefined, meta)
    } catch (err) {
      thrown = err
    }
    const err = thrown !== null
      ? '抛错: ' + (thrown instanceof Error ? thrown.message : String(thrown))
      : cliError(r as TagsRunResult)
    const summary = summarizeTagsResult(r?.data)
    const { kind, value } = describeQueryKind(args, phase)
    animaTagsTrace({
      phase, build: BUILD, op, bin: config.tagsBin,
      queryKind: kind, query: truncate(redactQuery(value)),
      matchMode: args.matchMode ?? '', budgetMs: config.timeoutMs,
      hitCount: summary.hitCount, matchLayers: summary.matchLayers,
      exitCode: meta.exitCode, durationMs: Date.now() - startedAtMs,
      ok: err === null, timedOut: meta.timedOut,
      ...(err !== null ? { error: err } : {}),
    })
    if (thrown !== null) throw thrown
    if (err !== null) return { ok: false, result: null, error: err }
    return { ok: true, result: (r as TagsRunResult).data }
  }

  // ---------- anima_tag：标签查询/校验 ----------
  ctx.tools.register(defineTool({
    name: 'anima_tag',
    description: 'Danbooru 标签检索/校验（Anima 生图硬锚点）：按 keyword/prefix/group 查 canonical tag。artist 用 @前缀，group 可传 artist/character/series/general 等。matchMode 默认 auto（先 exact 后 fuzzy），直接命中才用 exact。',
    parameters: {
      keyword: { type: 'string', description: '精确关键词（canonical tag，如 1girl、blue_archive）' },
      prefix: { type: 'string', description: '前缀匹配（如 @artist name、角色名片段）' },
      group: { type: 'string', description: '分组过滤：artist/character/series/general/copyright 等' },
      category: { type: 'string', description: '分类过滤' },
      matchMode: { type: 'string', description: '匹配模式：auto（缺省）/exact/fuzzy' },
      minCount: { type: 'number', description: '最低使用次数过滤' },
      limit: { type: 'number', description: '返回条数上限（缺省 20）' },
      forPrompt: { type: 'boolean', description: '输出可回填 prompt 的格式' },
      compact: { type: 'boolean', description: '紧凑输出' },
      extended: { type: 'boolean', description: '扩展字段输出' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          result: { type: 'json' },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: any) => [{ type: 'text', text: v.ok ? 'tag：' + JSON.stringify(v.result).slice(0, 300) : 'tag 查询失败：' + String(v.error ?? '').slice(0, 100) }],
    },
    async execute(args: TagQueryArgs) {
      return runTool('query', 'anima_tag', args, buildQueryArgs(args))
    },
  }))

  // ---------- anima_tag_random：随机抽卡 ----------
  ctx.tools.register(defineTool({
    name: 'anima_tag_random',
    description: 'Danbooru 随机抽卡（Anima 生图 roll/抽卡）：按分组随机取候选 tag。用户明确要求随机/抽卡时才用；随机候选不用 forPrompt。',
    parameters: {
      count: { type: 'number', description: '随机取 n 个（缺省 1）' },
      group: { type: 'string', description: '分组过滤：artist/character/series/general 等' },
      limit: { type: 'number', description: '候选池条数上限' },
      forPrompt: { type: 'boolean', description: '输出可回填 prompt 的格式（随机候选一般不用）' },
      extended: { type: 'boolean', description: '扩展字段输出' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          result: { type: 'json' },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: any) => [{ type: 'text', text: v.ok ? '随机：' + JSON.stringify(v.result).slice(0, 300) : '随机失败：' + String(v.error ?? '').slice(0, 100) }],
    },
    async execute(args: TagRandomArgs) {
      return runTool('random', 'anima_tag_random', args, buildRandomArgs(args))
    },
  }))

  ctx.effect(() => {
    // 进程级构建自报（Q1）：boot 行用中性值填充，字段与调用行完全同形（tail 后可直接读列）。
    animaTagsTrace({
      phase: 'boot', build: BUILD, op: 'apply', bin: config.tagsBin,
      queryKind: 'none', query: '', matchMode: '', budgetMs: config.timeoutMs,
      hitCount: 0, matchLayers: [], exitCode: -1, durationMs: 0, ok: true, timedOut: false,
    })
    logger.info('ready（danbooru-tags 检索面：2 工具；tagsBin=' + config.tagsBin + '）')
    return () => { /* 清理 */ }
  })
}
