/**
 * dsh-anima-tags · 纯逻辑套件（离线；无子进程、无网络）。
 *
 * 覆盖正常路径 + 失败/退化路径（空串/纯空白/undefined 参数、BOM、前置日志行、
 * 半截 JSON、非零退出、错误归口三级回落）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildQueryArgs, buildRandomArgs, cliError, parseTagsOutput, timeoutMessage,
} from '../lib/pure.js'

test('buildQueryArgs: 正常路径——`-j` 恒在首位，参数按固定顺序（keyword→prefix→group→category→matchMode→minCount→limit→开关）', () => {
  assert.deepEqual(
    buildQueryArgs({ keyword: '1girl', prefix: '@artist', group: 'general', category: '0', matchMode: 'exact', minCount: 5, limit: 20, forPrompt: true, compact: true, extended: true }),
    ['-j', '-k', '1girl', '-p', '@artist', '-g', 'general', '-c', '0', '--match-mode', 'exact', '-m', '5', '-l', '20', '--for-prompt', '--compact', '-e'],
  )
})

test('buildQueryArgs: 空参数全部不传——只留 `-j`（不得把空串塞给 CLI）', () => {
  assert.deepEqual(buildQueryArgs({}), ['-j'])
  assert.deepEqual(buildQueryArgs({ keyword: '', prefix: '', group: '', category: '', matchMode: '' }), ['-j'], '空串跳过')
  assert.deepEqual(buildQueryArgs({ keyword: '   ', group: '\t' }), ['-j'], '纯空白跳过')
})

test('buildQueryArgs: 参数值两端去空白（` 1girl ` → `1girl`）', () => {
  assert.deepEqual(buildQueryArgs({ keyword: ' 1girl ' }), ['-j', '-k', '1girl'])
})

test('buildQueryArgs: 退化输入——开关必须严格 true 才传；false/undefined 不传', () => {
  assert.deepEqual(buildQueryArgs({ forPrompt: false, compact: false, extended: false }), ['-j'])
  assert.deepEqual(buildQueryArgs({ forPrompt: true }), ['-j', '--for-prompt'])
})

test('buildQueryArgs: 边界——数值 0 是合法参数（不得按 falsy 丢掉）', () => {
  assert.deepEqual(buildQueryArgs({ minCount: 0, limit: 0 }), ['-j', '-m', '0', '-l', '0'])
})

test('buildRandomArgs: 正常路径——count 缺省 1；group/limit/开关按顺序附加', () => {
  assert.deepEqual(buildRandomArgs({}), ['-j', '-r', '1'])
  assert.deepEqual(buildRandomArgs({ count: 5, group: 'artist', limit: 50, forPrompt: true, extended: true }), ['-j', '-r', '5', '-g', 'artist', '-l', '50', '--for-prompt', '-e'])
})

test('buildRandomArgs: 退化输入——空分组跳过；count=0 原样传（现状语义）', () => {
  assert.deepEqual(buildRandomArgs({ group: '  ' }), ['-j', '-r', '1'])
  assert.deepEqual(buildRandomArgs({ count: 0 }), ['-j', '-r', '0'])
  assert.notDeepEqual(buildRandomArgs({ count: -1 }), ['-j', '-r', '1'], '负数原样传给 CLI（由 CLI 裁决，插件不猜）')
})

test('parseTagsOutput: 正常路径——纯 JSON（对象/数组）直接解析', () => {
  assert.deepEqual(parseTagsOutput('{"tags":[1]}', 0), { ok: true, data: { tags: [1] }, raw: '{"tags":[1]}' })
  assert.deepEqual(parseTagsOutput('[{"tag":"1girl"}]', 0).data, [{ tag: '1girl' }])
})

test('parseTagsOutput: 容错路径——前置日志行/警告后跟 JSON → 截块解析（对象优先）', () => {
  const out = 'loading index...\nwarn: 29MB db\n{"tags":[{"name":"1girl"}]}\ndone\n'
  const r = parseTagsOutput(out, 0)
  assert.equal(r.ok, true)
  assert.deepEqual(r.data, { tags: [{ name: '1girl' }] })
})

test('parseTagsOutput: 容错路径——退出码非 0 但解析出数据仍判 ok（CLI 非零退出携结果的场景）', () => {
  const r = parseTagsOutput('{"tags":[]}', 1)
  assert.equal(r.ok, true, '现状语义：data !== null 即 ok')
  assert.equal(parseTagsOutput('{"tags":[]}', null).ok, true, 'code 为 null（被杀）但解析出数据也判 ok')
})

test('parseTagsOutput: 失败路径——非零退出且不可解析 / 半截 JSON → ok:false 且 data:null', () => {
  assert.deepEqual(parseTagsOutput('', 0), { ok: true, data: null, raw: '' }, '退出码 0 无输出：ok 但 data 为 null（现状语义）')
  assert.equal(parseTagsOutput('', 1).ok, false)
  assert.equal(parseTagsOutput('not json at all', 1).ok, false)
  assert.equal(parseTagsOutput('{"a":', 1).data, null, '半截 JSON 截块后仍解析失败 → data null')
  assert.equal(parseTagsOutput('{bad json}', 1).ok, false)
})

test('parseTagsOutput: 文档化 quirk——退出码 0 但输出不可解析仍判 ok（调用方会拿到 result:null）', () => {
  // `ok = code === 0 || data !== null` 的副作用：CLI 正常退出却打印了非 JSON（例如换了输出格式）
  // 时，工具返回 `{ok:true, result:null}` —— **假成功**。本用例钉住现状；风险登记 semantic.md §10。
  const r = parseTagsOutput('not json at all', 0)
  assert.equal(r.ok, true)
  assert.equal(r.data, null)
  assert.equal(cliError({ ...r, stderr: '' }), null, 'ok:true ⇒ cliError 也判成功，错误信息被吞掉')
})

test('parseTagsOutput: 退化输入——BOM 剥离（trim 已含 U+FEFF，双重防御）与 CRLF', () => {
  const r = parseTagsOutput('\uFEFF{"tags":[]}\r\n', 0)
  assert.equal(r.ok, true)
  assert.equal(r.raw, '{"tags":[]}', 'BOM 与换行都必须从 raw 里去掉（诊断可见性）')
  assert.equal(parseTagsOutput(undefined, 1).raw, '')
  assert.doesNotThrow(() => parseTagsOutput(null, 0))
})

test('cliError: 成功 → null（四种成功形态都不报错）', () => {
  assert.equal(cliError({ ok: true, data: { tags: [] }, raw: 'x', stderr: '' }), null)
  assert.equal(cliError({ ok: true, data: null, raw: '', stderr: 'warn' }), null)
})

test('cliError: 失败路径三级回落——data.error → stderr → raw → 兜底文案', () => {
  assert.equal(cliError({ ok: false, data: { error: 'db missing' }, raw: '', stderr: '' }), '"db missing"', 'error 字段 JSON 化（含引号）')
  assert.equal(cliError({ ok: false, data: { error: { code: 3 } }, raw: '', stderr: '' }), '{"code":3}')
  assert.equal(cliError({ ok: false, data: null, raw: '', stderr: 'spawn ENOENT' }), 'spawn ENOENT')
  assert.equal(cliError({ ok: false, data: null, raw: 'partial output', stderr: '' }), 'partial output')
  assert.equal(cliError({ ok: false, data: null, raw: '', stderr: '' }), 'danbooru-tags 执行失败')
})

test('cliError: 边界——超长输出截断到 500 字；error 字段为 undefined 时不算命中', () => {
  assert.equal(cliError({ ok: false, data: null, raw: 'x'.repeat(900), stderr: '' }).length, 500)
  assert.equal(cliError({ ok: false, data: { error: undefined }, raw: '', stderr: 's' }), 's', 'error===undefined 视为未提供')
  assert.equal(cliError({ ok: false, data: { error: null }, raw: '', stderr: 's' }), 'null', 'error===null 是显式值，JSON 化为 "null"')
})

test('timeoutMessage: 毫秒显式呈现（含 0 与超大值）', () => {
  assert.equal(timeoutMessage(30000), 'danbooru-tags 超时（30000ms）')
  assert.equal(timeoutMessage(0), 'danbooru-tags 超时（0ms）')
})
