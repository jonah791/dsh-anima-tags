/**
 * 标签检索轨迹单测（跑 lib 产物，不拉 cordis 依赖树）。
 *
 * 覆盖：纯函数（路径 / 脱敏 / 截断 / 查询类型 / 结果摘要 / 序列化 / 解析）
 * + 真实落盘与回读 + 退化路径（脏数据/坏行/半行/空文件/缺失文件/目录误当文件）
 * + **尸体测试**（父路径是普通文件 → false 且不抛）
 * + **隐私尸体测试**（喂含凭据的 keyword → 落盘行里搜不到那些串）
 * + 一条离线组合（真 argv 拼装 + 结果摘要 → 轨迹行回答「命中几条 / 哪一层 / 断在哪」）。
 *
 * 夹具取自 **2026-09-14 CLI 探针实测**（不是猜的）：
 *   `danbooru-tags -j -k 1girl` → `{"general":[{"tag":"1girl",…,"match_score":1000,"match_layer":"exact_tag"}]}`
 *   查不到 → **`{}`（空对象，不是 `[]`）**；typo 关键词在 auto 下同样返回 `{}`（未实测到 fuzzy 层）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildQueryArgs, buildRandomArgs } from '../lib/pure.js'
import {
  animaTagsTrace,
  animaTracePath,
  appendTraceEntry,
  buildStamp,
  describeQueryKind,
  mtimeOf,
  parseTraceEntries,
  readPackageVersion,
  readTraceEntries,
  redactQuery,
  resolveHome,
  serializeTraceEntry,
  summarizeTagsResult,
  truncate,
} from '../lib/trace.js'

const tmp = mkdtempSync(join(tmpdir(), 'anima-tags-trace-test-'))
const CFG = { tagsBin: 'E:/x/danbooru-tags.exe', timeoutMs: 30000 }
const base = (entry) => ({
  atMs: 1_700_000_000_000,
  phase: 'query',
  build: '0.1.1@123',
  op: 'anima_tag',
  bin: CFG.tagsBin,
  queryKind: 'keyword',
  query: '1girl',
  matchMode: '',
  budgetMs: 30000,
  hitCount: 1,
  matchLayers: ['exact_tag'],
  exitCode: 0,
  durationMs: 120,
  ok: true,
  timedOut: false,
  ...entry,
})

test('resolveHome：DSH_HOME 优先，空白/缺失回退 <homedir>/.dsh', () => {
  assert.equal(resolveHome({ DSH_HOME: 'E:/alice/.dsh' }, '/home/x'), 'E:/alice/.dsh')
  assert.equal(resolveHome({ DSH_HOME: '  ' }, '/home/x'), join('/home/x', '.dsh'))
  assert.equal(resolveHome({}, '/home/x'), join('/home/x', '.dsh'))
})

test('animaTracePath：锚定 DSH_HOME 下的单一文件名', () => {
  assert.equal(animaTracePath('/h/.dsh'), join('/h/.dsh', 'anima-tags-trace.jsonl'))
})

test('truncate / redactQuery：截断与凭据擦除（普通标签词不误伤）', () => {
  assert.equal(truncate('abc', 5), 'abc')
  assert.equal(truncate('abcdef', 3), 'abc…')
  assert.equal(redactQuery('token=abcdef123'), 'token=[redacted]')
  assert.equal(redactQuery('sk-abcdefgh1234'), '[redacted]')
  assert.equal(redactQuery('a'.repeat(40)), '[redacted]')
  assert.equal(redactQuery('blue_archive'), 'blue_archive')
  assert.equal(redactQuery('@artist name'), '@artist name')
})

test('describeQueryKind：keyword/prefix/group/category 优先级 + none + random', () => {
  assert.deepEqual(describeQueryKind({ keyword: '1girl' }, 'query'), { kind: 'keyword', value: '1girl' })
  assert.deepEqual(describeQueryKind({ prefix: '@art' }, 'query'), { kind: 'prefix', value: '@art' })
  assert.deepEqual(describeQueryKind({ group: 'artist' }, 'query'), { kind: 'group', value: 'artist' })
  assert.deepEqual(describeQueryKind({ category: '1' }, 'query'), { kind: 'category', value: '1' })
  // 优先级：keyword 先于 prefix（与工具描述「按 keyword/prefix/group 查」一致）
  assert.equal(describeQueryKind({ keyword: 'k', prefix: 'p', group: 'g' }, 'query').kind, 'keyword')
  // 空串/纯空白不算「给了参数」（与 pure.ts 的 I4 门控同源）
  assert.deepEqual(describeQueryKind({ keyword: '   ', prefix: '' }, 'query'), { kind: 'none', value: '' })
  assert.deepEqual(describeQueryKind({}, 'query'), { kind: 'none', value: '' })
  // random 阶段无关键词语义，只记分组
  assert.deepEqual(describeQueryKind({ group: 'general' }, 'random'), { kind: 'random', value: 'general' })
  assert.deepEqual(describeQueryKind({}, 'random'), { kind: 'random', value: '' })
})

test('summarizeTagsResult：真实形状（分组数组 + match_layer）→ 命中数与命中层', () => {
  const real = {
    general: [
      { tag: '1girl', count: 7868012, match_score: 1000, match_layer: 'exact_tag' },
      { tag: '2girls', count: 100, match_score: 900, match_layer: 'fuzzy' },
    ],
    artist: [{ tag: '@x', match_layer: 'exact_tag' }],
  }
  const s = summarizeTagsResult(real)
  assert.equal(s.hitCount, 3)                                   // 跨分组求和
  assert.deepEqual(s.matchLayers, ['exact_tag', 'fuzzy'])       // 去重且保序 → 能看出退到了 fuzzy
})

test('summarizeTagsResult：脏数据全部退化为 0 命中且不抛（缺陷形状 D4）', () => {
  // 查不到的真实形状是空对象，不是空数组
  assert.deepEqual(summarizeTagsResult({}), { hitCount: 0, matchLayers: [] })
  assert.deepEqual(summarizeTagsResult(null), { hitCount: 0, matchLayers: [] })
  assert.deepEqual(summarizeTagsResult(undefined), { hitCount: 0, matchLayers: [] })
  assert.deepEqual(summarizeTagsResult('boom'), { hitCount: 0, matchLayers: [] })
  // 分组值不是数组（如 CLI 报错体 {"error":"..."}）→ 不 map 崩溃
  assert.deepEqual(summarizeTagsResult({ error: 'index missing' }), { hitCount: 0, matchLayers: [] })
  assert.deepEqual(summarizeTagsResult({ general: null }), { hitCount: 0, matchLayers: [] })
  // 数组顶层（CLI 另一种可能形态）+ 元素是 null/非对象
  assert.equal(summarizeTagsResult([{ match_layer: 'a' }, null, 42, 'str']).hitCount, 4)
  assert.deepEqual(summarizeTagsResult([null, 1]).matchLayers, [])
  // match_layer 非字符串（脏）→ 不污染命中层
  assert.deepEqual(summarizeTagsResult({ general: [{ match_layer: 7 }, { match_layer: '' }] }).matchLayers, [])
})

test('serializeTraceEntry：单行 + 键序固定 + error 缺省不污染', () => {
  const line = serializeTraceEntry(base({}))
  assert.equal(line.includes('\n'), false)
  assert.deepEqual(Object.keys(JSON.parse(line)), [
    'atMs', 'phase', 'build', 'op', 'bin', 'queryKind', 'query', 'matchMode', 'budgetMs',
    'hitCount', 'matchLayers', 'exitCode', 'durationMs', 'ok', 'timedOut',
  ])
  const withErr = JSON.parse(serializeTraceEntry(base({ ok: false, timedOut: true, error: 'danbooru-tags 超时（30000ms）' })))
  assert.equal(Object.keys(withErr).at(-1), 'error')
  assert.equal(withErr.timedOut, true)   // 超时**单列**，不靠 error 文案辨认
})

test('parseTraceEntries：坏行/半行/空行/null/字符串全部跳过，不抛', () => {
  const good = serializeTraceEntry(base({}))
  const text = ['', good, '  ', '{"atMs":1,"phase":"query"', '{"phase":"query"}', 'null', '"str"', '###'].join('\n')
  const parsed = parseTraceEntries(text)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].op, 'anima_tag')
})

test('readTraceEntries：缺失文件/目录误当文件 → 空数组（不抛）', () => {
  assert.deepEqual(readTraceEntries(join(tmp, 'nope', 'anima-tags-trace.jsonl')), [])
  assert.deepEqual(readTraceEntries(tmp), [])
})

test('appendTraceEntry：正常追加可回读；空文件读回空数组', () => {
  const path = join(tmp, 'ok', 'anima-tags-trace.jsonl')
  const emptyPath = join(tmp, 'empty-trace.jsonl')
  writeFileSync(emptyPath, '', 'utf8')
  assert.deepEqual(readTraceEntries(emptyPath), [])
  assert.equal(appendTraceEntry(path, base({ phase: 'boot', op: 'apply' })), true)
  assert.equal(appendTraceEntry(path, base({ phase: 'random', op: 'anima_tag_random', hitCount: 5 })), true)
  const back = readTraceEntries(path)
  assert.deepEqual(back.map((e) => e.phase), ['boot', 'random'])
  assert.equal(back[1].hitCount, 5)
  assert.equal(readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '').length, 2)
})

test('尸体测试：父路径是普通文件 → 返回 false 且不抛（观测不反噬检索）', () => {
  const blocker = join(tmp, 'blocker')
  writeFileSync(blocker, 'not a dir', 'utf8')
  assert.doesNotThrow(() => {
    assert.equal(appendTraceEntry(join(blocker, 'anima-tags-trace.jsonl'), base({})), false)
    assert.equal(animaTagsTrace(base({}), { path: join(blocker, 'anima-tags-trace.jsonl'), now: 1 }), false)
  })
})

test('animaTagsTrace：注入 now 落一行；不可写路径返回 false', () => {
  const path = join(tmp, 'thin', 'anima-tags-trace.jsonl')
  const { atMs, ...withoutAt } = base({ phase: 'random', op: 'anima_tag_random' })
  assert.equal(atMs, 1_700_000_000_000)
  assert.equal(animaTagsTrace(withoutAt, { path, now: 42 }), true)
  const [line] = readTraceEntries(path)
  assert.equal(line.atMs, 42)
  assert.equal(line.op, 'anima_tag_random')
  assert.equal(animaTagsTrace(withoutAt, { path: join(tmp, 'blocker', 'x.jsonl'), now: 43 }), false)
})

test('隐私尸体测试：含凭据的 keyword 落盘后搜不到凭据串（红线）', () => {
  const path = join(tmp, 'privacy', 'anima-tags-trace.jsonl')
  const secrets = ['sk-live-9f8e7d6c5b4a3210', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'hunter2secret', 'AbCdEf0123456789AbCdEf0123456789']
  const queries = [
    'sk-live-9f8e7d6c5b4a3210',
    'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    'api_key=hunter2secret',
    'Bearer AbCdEf0123456789AbCdEf0123456789',
  ]
  for (const q of queries) {
    assert.equal(animaTagsTrace(base({ query: truncate(redactQuery(q)) }), { path, now: 1 }), true)
  }
  const raw = readFileSync(path, 'utf8')
  for (const s of secrets) assert.equal(raw.includes(s), false, '凭据不得落盘: ' + s)
  assert.match(raw, /\[redacted\]/) // 擦除确实发生了（排除「没写进去」的假绿）
  assert.equal(parseTraceEntries(raw).length, queries.length)
})

test('构建自证：buildStamp/readPackageVersion/mtimeOf（版本读不到退化为 unknown@mtime）', () => {
  const root = join(tmp, 'pkg')
  mkdirSync(join(root, 'lib'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.1.1' }), 'utf8')
  const self = join(root, 'lib', 'index.js')
  writeFileSync(self, '// x', 'utf8')
  assert.equal(readPackageVersion(self), '0.1.1')
  assert.ok(mtimeOf(self) > 0)
  assert.equal(buildStamp(self, '0.1.1'), '0.1.1@' + String(mtimeOf(self)))
  assert.equal(buildStamp(join(root, 'missing.js'), ''), 'unknown@0')
})

test('离线组合：真 argv + 结果摘要 → 轨迹行回答「查了什么 / 命中几条 / 哪一层 / 断在哪」', () => {
  const path = join(tmp, 'combo', 'anima-tags-trace.jsonl')
  const args = { keyword: '1girl', matchMode: 'auto' }
  const argv = buildQueryArgs(args)
  assert.deepEqual(argv.slice(0, 2), ['-j', '-k'])
  assert.deepEqual(argv.slice(2), ['1girl', '--match-mode', 'auto'])
  // ① 成功且精确命中
  const real = { general: [{ tag: '1girl', match_layer: 'exact_tag' }] }
  const s = summarizeTagsResult(real)
  const { kind, value } = describeQueryKind(args, 'query')
  assert.equal(animaTagsTrace({
    phase: 'query', build: '0.1.1@1', op: 'anima_tag', bin: CFG.tagsBin,
    queryKind: kind, query: value, matchMode: 'auto', budgetMs: CFG.timeoutMs,
    hitCount: s.hitCount, matchLayers: s.matchLayers,
    exitCode: 0, durationMs: 120, ok: true, timedOut: false,
  }, { path, now: 100 }), true)
  const [ok] = readTraceEntries(path)
  assert.equal(ok.queryKind, 'keyword')          // 查了什么类型的查询
  assert.equal(ok.hitCount, 1)                   // 命中几条
  assert.deepEqual(ok.matchLayers, ['exact_tag']) // 哪一层（没退到 fuzzy）
  assert.equal(ok.exitCode, 0)
  assert.equal(ok.ok, true)
  assert.equal(ok.timedOut, false)
  // ② 查无结果（真实形状 = 空对象）：ok=true 且 hitCount=0
  const miss = summarizeTagsResult({})
  assert.equal(animaTagsTrace({
    phase: 'query', build: '0.1.1@1', op: 'anima_tag', bin: CFG.tagsBin,
    queryKind: 'keyword', query: 'zzqqnotexist9527', matchMode: 'auto', budgetMs: CFG.timeoutMs,
    hitCount: miss.hitCount, matchLayers: miss.matchLayers,
    exitCode: 0, durationMs: 90, ok: true, timedOut: false,
  }, { path, now: 101 }), true)
  const [, none] = readTraceEntries(path)
  // 关键：「查无结果」与「超时/CLI 报错」在轨迹里必须可辨（都是 0 命中的场景，但 ok/timedOut 不同）
  assert.equal(none.ok, true)
  assert.equal(none.hitCount, 0)
  assert.equal(none.exitCode, 0)
  // ③ 超时：**单列 timedOut**，不靠 error 文案辨认；且 durationMs 应吃满预算
  assert.equal(animaTagsTrace({
    phase: 'query', build: '0.1.1@1', op: 'anima_tag', bin: CFG.tagsBin,
    queryKind: 'keyword', query: '1girl', matchMode: '', budgetMs: 30000,
    hitCount: 0, matchLayers: [], exitCode: -1, durationMs: 30000, ok: false, timedOut: true,
    error: 'danbooru-tags 超时（30000ms）',
  }, { path, now: 102 }), true)
  const [, , to] = readTraceEntries(path)
  assert.equal(to.timedOut, true)               // Q3 断点分类：超时 ≠ CLI 报错
  assert.equal(to.exitCode, -1)                 // 没拿到退出码
  assert.equal(to.durationMs, to.budgetMs)      // Q5：预算耗尽（不是窗口未命中）
  // ④ 无 CLI（I2）：ok=false + error 归口，且 argv 构造成立（失败只在 spawn 层）
  assert.ok(buildRandomArgs({ count: 3 }).includes('3'))
  assert.equal(animaTagsTrace({
    phase: 'random', build: '0.1.1@1', op: 'anima_tag_random', bin: CFG.tagsBin,
    queryKind: 'random', query: '', matchMode: '', budgetMs: CFG.timeoutMs,
    hitCount: 0, matchLayers: [], exitCode: -1, durationMs: 3, ok: false, timedOut: false,
    error: '无法启动 danbooru-tags：spawn ENOENT',
  }, { path, now: 103 }), true)
  const [, , , bad] = readTraceEntries(path)
  assert.equal(bad.ok, false)
  assert.equal(bad.timedOut, false)             // 与超时可辨（同为空结果 + exitCode -1）
  assert.match(bad.error, /无法启动/)
})

test('cleanup', () => {
  rmSync(tmp, { recursive: true, force: true })
})
