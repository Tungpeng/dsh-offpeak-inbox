// Publish the browser half as a client-module bundle at the path package.json declares.
//
// The registry does not serve this file on its own: it merges every dynamic client half
// into the `/plugins/??a,b,c/client.js` request, which the browser loads as a classic
// <script>. A client half must therefore be the `window.__ModuleLoader__.load({ id,
// factory })` handoff that the harness's own client packages emit
// (packages/client/tsdown.client.ts), not the authored ESM. A top-level `export` inside
// the merged bundle is a SyntaxError, the whole bundle stops executing, and every other
// plugin reports
//   "Failed to load plugins … bundle … loaded without registering … via __ModuleLoader__.load".
// Measured 2026-09-16: line 112100 of the merged bundle was `export function apply()`.
//
// The authored half has no dependencies to bundle, so this wraps it instead of running a
// bundler. An `import` in src/client.js makes wrapping impossible — build that half with
// the clientBundle preset (or another bundler) instead.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'src', 'client.js')
const target = join(root, 'lib', 'client.js')
const id = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name

// Keep the authored file free of a byte-order mark, which would break the browser parse.
const rawSource = readFileSync(source)
if (rawSource[0] === 0xEF && rawSource[1] === 0xBB && rawSource[2] === 0xBF) {
  writeFileSync(source, rawSource.subarray(3))
  console.log('stripped a UTF-8 BOM from src/client.js')
}
const code = readFileSync(source, 'utf8')

if (/^\s*import\s/m.test(code)) {
  throw new Error('src/client.js imports a module: bundle it with the clientBundle preset instead of wrapping')
}

const exported = []
const body = code.replace(
  /^export\s+(async\s+function|function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gmu,
  (_match, kind, name) => {
    exported.push(name)
    return `${kind} ${name}`
  },
)
if (/^\s*export\s/m.test(body)) throw new Error('src/client.js has an unhandled top-level export')
if (exported.length === 0) throw new Error('src/client.js exports nothing: the loader expects apply (and inject)')

const indented = body.replace(/[ \t]+$/gmu, '').replace(/^(?=.)/gmu, '    ')
const output = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(id)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

${indented}

${exported.map(name => `    exports.${name} = ${name};`).join('\n')}
    return module.exports;
  },
});
`

// Guards: a stale or unwrapped copy must fail here, not in the browser.
new vm.Script(output)
if (!code.includes('instanceof HTMLElement')) {
  throw new Error('src/client.js lost its `instanceof HTMLElement` element guard')
}

mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, output)
console.log(`published ${target} (id ${id}; ${output.length} bytes; exports: ${exported.join(', ')})`)
