// 分发清单验收：本仓库必须满足「可分发型」的硬约束。
//
// 这些检查不碰网络、不启动宿主，只读仓库里的包清单 / bundle patch / 文档，
// 防止后续改动把本机绝对路径、private 包、隐私默认、安装说明之类的分发前提改坏。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (name) => readFileSync(join(ROOT, name), 'utf8')
const manifest = JSON.parse(read('package.json'))
const patch = read('cordis.patch.yml')
const readme = read('README.md')
const roadmap = read('ROADMAP.md')
const hostLib = read('lib/index.js')
const clientLib = read('lib/client.js')

const results = []
const check = (name, fn) => {
  try {
    fn()
    results.push(['PASS', name])
  } catch (error) {
    results.push(['FAIL', name, error.message])
  }
}

// ── 包清单 ──────────────────────────────────────────────────────────────
check('包名与语义化版本', () => {
  assert.equal(manifest.name, 'dsh-system-fingerprint')
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
})
check('不是 private 包（可安装/可发布）', () => {
  assert.equal(Object.hasOwn(manifest, 'private'), false, '分发版不应声明 private: true')
})
check('bundle 入口声明存在', () => {
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.type, 'module')
})
check('浏览器半边入口声明存在', () => {
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-locale'))
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'))
  assert.equal(manifest.exports['./client'], './lib/client.js')
  assert.equal(manifest.exports['./package.json'], './package.json')
})
check('files 覆盖运行/文档所需文件', () => {
  for (const name of ['lib', 'docs', 'cordis.patch.yml', 'README.md', 'ROADMAP.md']) {
    assert.ok(manifest.files.includes(name), `files 缺 ${name}`)
  }
})
check('devDependencies 覆盖真渲染测试所需依赖', () => {
  for (const name of ['jsdom', 'react', 'react-dom']) {
    assert.ok(manifest.devDependencies[name], `devDependencies 缺 ${name}`)
  }
})

// ── bundle patch ────────────────────────────────────────────────────────
const activePatchLines = patch.split('\n').filter((line) => !/^\s*#/u.test(line))
check('patch 用包名安装，不写本机绝对路径（file://）', () => {
  assert.ok(activePatchLines.some((line) => /name:\s*'dsh-system-fingerprint'/u.test(line)), '缺少包名 name 行')
  assert.ok(!activePatchLines.some((line) => line.includes('file://')), '有效配置里不应出现 file://')
  assert.ok(!activePatchLines.some((line) => /\/home\/|\/Users\/|\/srv\//u.test(line)), '不应出现本机绝对路径')
})
check('patch 的隐私默认写清楚（captureRaw 默认关，仅注释示例）', () => {
  assert.ok(!activePatchLines.some((line) => /^\s*captureRaw:\s*true/u.test(line)), '模板不应默认打开原始字节落盘')
  assert.match(patch, /captureRaw/u)
})
check('patch 提供网关映射/检查点表的配置示例', () => {
  assert.match(patch, /gatewayHeaders/u)
  assert.match(patch, /gatewaySessionHeader/u)
  assert.match(patch, /checkpointTable/u)
})
check('patch 入口 id 与客户端槽位 id 一致', () => {
  assert.match(patch, /- id: system-fingerprint/u)
  assert.match(clientLib, /'system-fingerprint'/u)
})

// ── 宿主/客户端半边的依赖约束 ────────────────────────────────────────────
check('宿主半边只 import Node 内建模块（不依赖安装目录解析）', () => {
  const imports = [...hostLib.matchAll(/^import .* from '([^']+)'/gmu)].map((match) => match[1])
  assert.ok(imports.length > 0)
  assert.ok(imports.every((name) => name.startsWith('node:')), `出现非内建 import: ${imports.join(', ')}`)
})
check('客户端半边不直接 import Harness 包（只走模块表 require react）', () => {
  assert.ok(!/from '@deepseek-ai\//u.test(clientLib))
  assert.ok(!/require\('@deepseek-ai\//u.test(clientLib))
  assert.match(clientLib, /require\('react\/jsx-runtime'\)/u)
})

// ── 文档 ────────────────────────────────────────────────────────────────
check('README 有安装/接口/隐私默认/供应商无关/验证状态', () => {
  for (const needle of ['## 安装（分发）', '## 对外接口（契约 v1）', 'docs/INTERFACE.md', '隐私默认', 'gatewayHeaders', '## 验证状态', 'ROADMAP.md']) {
    assert.ok(readme.includes(needle), `README 缺 ${needle}`)
  }
})
check('ROADMAP 的 P1（可分发型）验收项已全部勾选', () => {
  const start = roadmap.indexOf('### P1')
  const end = roadmap.indexOf('### P2')
  assert.ok(start > 0 && end > start, '找不到 P1/P2 段落')
  const p1 = roadmap.slice(start, end)
  assert.ok(p1.includes('- [x]'), 'P1 应当有已勾选项')
  assert.ok(!p1.includes('- [ ]'), 'P1 不应有未完成的验收项')
})

const failed = results.filter((row) => row[0] === 'FAIL')
for (const [status, name, message] of results) {
  console.log(`${status === 'PASS' ? '  ✓' : '  ✗'} ${name}${message ? ` — ${message}` : ''}`)
}
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
