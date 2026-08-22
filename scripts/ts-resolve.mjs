/**
 * Resolve the app's extensionless relative imports when running under Node.
 *
 * The browser sources are bundled by Vite, which resolves `../util/math` to
 * `../util/math.ts` for free. Node does not, so without this hook the CV
 * modules can only be exercised by loading them into a browser — and a
 * pipeline that can only be tested by pointing a camera at something is a
 * pipeline nobody tests.
 *
 *   node --import ./scripts/ts-resolve.mjs scripts/whatever.mjs
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

register(
  'data:text/javascript,' +
    encodeURIComponent(`
      import { existsSync } from 'node:fs';
      import { fileURLToPath } from 'node:url';
      export async function resolve(specifier, context, next) {
        if (specifier.startsWith('.') && !/\\.[a-z]+$/i.test(specifier)) {
          const base = new URL(specifier, context.parentURL);
          for (const ext of ['.ts', '.mjs', '.js', '/index.ts']) {
            const candidate = new URL(base.href + ext);
            if (existsSync(fileURLToPath(candidate))) {
              return next(candidate.href, context);
            }
          }
        }
        return next(specifier, context);
      }
    `),
  pathToFileURL('./'),
);

if (!existsSync('src')) {
  throw new Error('Run from the project root.');
}
