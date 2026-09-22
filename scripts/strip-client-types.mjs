// Build step: strip TypeScript syntax from the browser half.
//
// The browser half is authored in TypeScript like the host half, but what ships
// is plain JavaScript. This used to be done by renaming the file to `.js`, which
// left type syntax in place: `document.querySelector<HTMLDivElement>(…)` parses
// as a comparison in JavaScript, so tsc refuses to strip the type argument from
// a `.js` input, and the surviving identifier became a runtime ReferenceError.
//
// Authoring as `.ts` makes the strip unambiguous. Type errors are ignored on
// purpose: this step only removes syntax, and the emitted file is what ships.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// The repository root is this script's parent directory, and `tsc` comes from
// this package's own installed dependencies, so a fresh clone builds with its
// own toolchain and no machine-specific path.
const root = dirname(import.meta.dirname)
const tsc = join(root, 'node_modules', 'typescript', 'lib', 'tsc.js')
const node = process.execPath
const source = join(root, 'src', 'client.ts')
const target = join(root, 'src', 'client.js')
const configPath = join(root, 'tsconfig.client-strip.json')
const outDir = join(root, '.client-strip')

if (!existsSync(source)) throw new Error(`missing browser source: ${source}`)
if (!existsSync(tsc)) throw new Error(`typescript is not installed; run the package manager install first (looked for ${tsc})`)

writeFileSync(configPath, JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    lib: ['ES2022', 'DOM', 'DOM.Iterable'],
    module: 'ESNext',
    moduleResolution: 'bundler',
    allowJs: true,
    checkJs: false,
    // Type errors must not block the emit: this step only removes syntax.
    noEmitOnError: false,
    removeComments: false,
    outDir: '.client-strip',
    rootDir: 'src',
  },
  files: ['src/client.ts'],
}, null, 2))

try {
  // `stdio: 'inherit'` rather than a pipe: a confined sandbox can refuse to open
  // the pipe a captured child would need (EPERM), and the failure surfaces here
  // as "no emit" rather than as the real cause. Inherited descriptors are always
  // available, and tsc's diagnostics stay visible.
  execFileSync(node, [tsc, '-p', configPath], { cwd: root, stdio: 'inherit' })
} catch {
  // tsc exits non-zero when it reports diagnostics; the emit still happens and
  // the checks below decide whether the result is usable.
}

const emitted = join(outDir, 'client.js')
if (!existsSync(emitted)) throw new Error('tsc emitted no browser half')

const stripped = readFileSync(emitted, 'utf8')
writeFileSync(target, stripped, 'utf8')
rmSync(configPath, { force: true })
rmSync(outDir, { recursive: true, force: true })
mkdirSync(join(root, 'lib'), { recursive: true })

// Guards: the two mistakes this step exists to prevent.
if (/<\s*(HTML|HTMLElement|Record|Array)\w*\s*>/.test(stripped)) {
  throw new Error('type arguments survived the strip; the browser would parse this as comparison')
}
if (!/export function apply/.test(stripped)) {
  throw new Error('browser half no longer exports apply')
}
if (!stripped.includes('instanceof HTMLElement')) {
  throw new Error('browser half lost its element guard')
}

console.log(`stripped types: src/client.ts -> src/client.js (${stripped.length} bytes)`)
