/**
 * 把 src/client.js 包成 DSH 客户端模块要求的经典脚本格式，产出 lib/client.js。
 *
 * 为什么需要它：`dsh.client.platform = 'web'` 的插件，其 `./client` 出口必须是
 * `window.__ModuleLoader__.load({ id, factory })` 包裹的产物（见 DSH 仓库
 * packages/client/tsdown.client.ts 的 clientBundle 预设）。若直接出口裸 ESM 源码，
 * 该文件会被并进 /plugins/??a,b,c 的合并包，里面的顶层 `export` 会让整个合并包
 * 抛 `SyntaxError: Unexpected token 'export'`，浏览器端所有插件一起加载失败
 * （报 "Failed to load plugins ... loaded without registering ..."）。
 *
 * 本插件的浏览器半边是手写 JS，没有依赖需要打包，所以这里只做包装，不引入打包器。
 * 一旦它需要 `import`（React 等），就应改用 DSH 的 clientBundle 预设或 esbuild 打包。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'src', 'client.js')
const target = join(root, 'lib', 'client.js')

const code = readFileSync(source, 'utf8')

if (/^\s*import\s/m.test(code)) {
  throw new Error('src/client.js 含 import：请改用 DSH 的 clientBundle 预设打包，本包装脚本不解析依赖')
}

const exported = []
const body = code
  .replace(/^export\s+default\s+/m, () => {
    throw new Error('src/client.js 用了 export default：DSH 客户端模块约定是具名 apply/inject')
  })
  .replace(/^export\s+(async\s+function|function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm, (_all, kind, name) => {
    exported.push(name)
    return `${kind} ${name}`
  })

if (/^\s*export\s/m.test(body)) {
  throw new Error('src/client.js 还有未处理的顶层 export，请手工确认')
}

const assignments = exported.map(name => `    exports.${name} = ${name};`).join('\n')
const output = `window.__ModuleLoader__.load({
  id: "dsh-offpeak-inbox",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

${body.replace(/^(?!\s*$)/gm, '    ').replace(/\s+$/u, '')}

${assignments}
    return module.exports;
  },
});
`

mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, output)
console.log(`wrapped ${exported.join(', ')} -> ${target} (${output.length} bytes)`)
