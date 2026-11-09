/** Loader hooks for tsx-lite.mjs: transpile .ts/.tsx in-process. */
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import ts from "typescript";

const TS_EXT = [".ts", ".tsx"];

function toFile(specifier, parentURL) {
  if (specifier.startsWith("file:")) return fileURLToPath(specifier);
  const base = parentURL?.startsWith("file:") ? dirname(fileURLToPath(parentURL)) : process.cwd();
  return resolvePath(base, specifier);
}

export function resolve(specifier, context, nextResolve) {
  const relative = specifier.startsWith(".") || specifier.startsWith("file:");
  if (!relative) return nextResolve(specifier, context);
  const file = toFile(specifier, context.parentURL);
  if (TS_EXT.some((ext) => file.endsWith(ext))) {
    return { url: pathToFileURL(file).href, shortCircuit: true };
  }
  // transpileModule rewrites relative .ts/.tsx imports to .js: map them back.
  for (const tsExt of TS_EXT) {
    const jsExt = tsExt === ".tsx" ? ".jsx" : ".js";
    if (file.endsWith(jsExt)) {
      const candidate = file.slice(0, -jsExt.length) + tsExt;
      if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
    }
  }
  // rewriteRelativeImportExtensions also emits .js for a .tsx source
  // (e.g. ../../client/index.tsx → index.js); try the .tsx twin as well.
  if (file.endsWith(".js")) {
    const candidate = file.slice(0, -".js".length) + ".tsx";
    if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
  }
  if (!existsSync(file) || (statSync(file).isDirectory() && !TS_EXT.some((e) => existsSync(file + "/index" + e)))) {
    for (const tsExt of TS_EXT) {
      const candidate = file + tsExt;
      if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
    }
  }
  if (existsSync(file) && statSync(file).isDirectory()) {
    for (const tsExt of TS_EXT) {
      const candidate = file + "/index" + tsExt;
      if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}

export function load(url, context, nextLoad) {
  if (url.endsWith(".ts") || url.endsWith(".tsx")) {
    const file = fileURLToPath(url);
    const source = readFileSync(file, "utf8");
    const out = ts.transpileModule(source, {
      fileName: file,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ES2022,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        jsx: ts.JsxEmit.ReactJSX,
        strict: true,
        esModuleInterop: true,
        resolveJsonModule: true,
        rewriteRelativeImportExtensions: true,
        sourceMap: false,
      },
      reportDiagnostics: false,
    });
    return { format: "module", source: out.outputText, shortCircuit: true };
  }
  return nextLoad(url, context);
}
