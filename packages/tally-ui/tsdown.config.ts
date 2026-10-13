/**
 * Browser bundle of dsh-tally-ui (`lib/client.js`), following dsh's `clientConfig()` in
 * `packages/client/tsdown.client.ts`: one CJS chunk wrapped as a factory registration for the
 * client module loader. Only the host's shared module table stays a `require()`; everything else
 * (zod, `dsh-tally/remote`, this package's code and CSS) is inlined.
 */
import { readFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve } from 'node:path'
import { defineConfig, type UserConfig } from 'tsdown'

const ID = 'dsh-tally-ui'

/** Modules the dsh web shell shares with plugin bundles; keep in sync with scripts/check-client-bundle.mjs. */
const SHARED_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]
const shared = new Set(SHARED_MODULES)

// tsdown claims ids ending in `.css` for its own CSS pipeline, so the virtual id must not.
const CSS_PREFIX = '\0dsh-tally-ui-css:'
const CSS_SUFFIX = '.mjs'
/**
 * The virtual id names the stylesheet relative to the package, so the published bundle carries no
 * path of the machine that built it; tsdown runs with the package as its working directory.
 */
const PACKAGE_ROOT = process.cwd()

/** Turn a stylesheet into code that injects it once when the factory runs, tagged like dsh's own plugins. */
function styleInjection(file: string, css: string): string {
  const tagId = `${ID}/${basename(file)}`
  return [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(tagId)};`,
    'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
    '  const tag = document.createElement(\'style\');',
    `  tag.dataset.plugin = ${JSON.stringify(ID)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
    'export {};',
  ].join('\n')
}

const config: UserConfig = {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.ts' },
  tsconfig: 'tsconfig.client.json',
  // The host half (tsc) and the declarations (lib/types) live in lib/ too, so never clean it.
  outDir: 'lib',
  clean: false,
  format: 'cjs',
  platform: 'browser',
  // Browser output: do not derive the syntax target from the package's Node engine range.
  target: 'es2023',
  dts: false,
  sourcemap: true,
  deps: {
    neverBundle: SHARED_MODULES,
    alwaysBundle: (id: string) => !shared.has(id),
    // Inlining every other dependency is the point; no allow-list hint needed.
    onlyBundle: false,
  },
  // dsh's client module loader requires this CJS factory format; the ESM advice does not apply.
  checks: { legacyCjs: false },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  plugins: [{
    name: 'dsh-tally-ui-css-inject',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.css')) return null
      const file = importer === undefined ? resolve(source) : resolve(dirname(importer), source)
      return CSS_PREFIX + relative(PACKAGE_ROOT, file).split('\\').join('/') + CSS_SUFFIX
    },
    async load(id: string) {
      if (!id.startsWith(CSS_PREFIX)) return null
      const file = resolve(PACKAGE_ROOT, id.slice(CSS_PREFIX.length, -CSS_SUFFIX.length))
      this.addWatchFile(file)
      return styleInjection(file, await readFile(file, 'utf8'))
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
}

export default defineConfig(config)
