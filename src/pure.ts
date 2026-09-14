/** dsh-anima-tags · 纯逻辑层（无 IO：子进程输出与退出码由调用方注入）。
 *
 * 从 `index.ts` 抽出三类判定：
 * ① CLI 参数拼装（两个工具的 `!== undefined && trim() !== ''` 门控——写错就是「参数悄悄没传」）；
 * ② stdout 容错解析（BOM / 前置日志行 / 数组或对象 / 半截 JSON）；
 * ③ 错误信息归口（`cliError` 的三级回落）。
 * `index.ts` 只留 spawn 与工具注册。
 */

export interface TagQueryArgs {
  keyword?: string
  prefix?: string
  group?: string
  category?: string
  matchMode?: string
  minCount?: number
  limit?: number
  forPrompt?: boolean
  compact?: boolean
  extended?: boolean
}

export interface TagRandomArgs {
  count?: number
  group?: string
  limit?: number
  forPrompt?: boolean
  extended?: boolean
}

/** 空串/纯空白/undefined 一律**不传**（不得把空参数塞给 CLI）。 */
const pushStr = (out: string[], flag: string, value: string | undefined): void => {
  if (value === undefined || value.trim() === '') return
  out.push(flag, value.trim())
}

/** `anima_tag` 的 CLI 参数（`-j` 恒在首位 = JSON 输出）。 */
export function buildQueryArgs(args: TagQueryArgs): string[] {
  const out: string[] = ['-j']
  pushStr(out, '-k', args.keyword)
  pushStr(out, '-p', args.prefix)
  pushStr(out, '-g', args.group)
  pushStr(out, '-c', args.category)
  pushStr(out, '--match-mode', args.matchMode)
  if (args.minCount !== undefined) out.push('-m', String(args.minCount))
  if (args.limit !== undefined) out.push('-l', String(args.limit))
  if (args.forPrompt === true) out.push('--for-prompt')
  if (args.compact === true) out.push('--compact')
  if (args.extended === true) out.push('-e')
  return out
}

/** `anima_tag_random` 的 CLI 参数：`count` 缺省 1（`-r`）。 */
export function buildRandomArgs(args: TagRandomArgs): string[] {
  const out: string[] = ['-j', '-r', String(args.count ?? 1)]
  pushStr(out, '-g', args.group)
  if (args.limit !== undefined) out.push('-l', String(args.limit))
  if (args.forPrompt === true) out.push('--for-prompt')
  if (args.extended === true) out.push('-e')
  return out
}

export interface TagsRunResult {
  ok: boolean
  /** 解析出的 JSON 值（`JSON.parse` 产物，天然 JSON 可序列化；供工具 output.schema 的 `json` 字段直用） */
  data: any
  raw: string
  stderr: string
}

/**
 * stdout 容错解析：**先整体 JSON，失败再退到「截取第一个 `{…}` / `[…]` 块」**。
 * `ok = 退出码为 0 || 解析出了数据`（CLI 有非零退出但仍打印结果的场景）。
 * `raw` 是去空白并剥掉 BOM 后的原文（诊断用）。
 */
export function parseTagsOutput(stdout: string, code: number | null): { ok: boolean; data: any; raw: string } {
  const raw = String(stdout ?? '').trim().replace(/^\uFEFF/, '')
  let data: any = null
  try {
    data = JSON.parse(raw)
  } catch {
    const objMatch = raw.match(/\{[\s\S]*\}/)
    const arrMatch = raw.match(/\[[\s\S]*\]/)
    const block = objMatch ?? arrMatch
    if (block !== null) {
      try { data = JSON.parse(block[0]) } catch { data = null }
    }
  }
  return { ok: code === 0 || data !== null, data, raw }
}

/**
 * 错误信息归口：成功 → `null`；失败时按 ① data.error（JSON 化）② stderr ③ raw ④ 兜底文案 回落，统一截 500 字。
 */
export function cliError(r: TagsRunResult): string | null {
  if (r.ok) return null
  const d = r.data as { error?: unknown } | null
  if (d !== null && typeof d === 'object' && (d as { error?: unknown }).error !== undefined) {
    return JSON.stringify((d as { error?: unknown }).error)
  }
  return (r.stderr || r.raw || 'danbooru-tags 执行失败').slice(0, 500)
}

/** 超时文案（毫秒显式传入，便于断言）。 */
export function timeoutMessage(ms: number): string {
  return 'danbooru-tags 超时（' + ms + 'ms）'
}
