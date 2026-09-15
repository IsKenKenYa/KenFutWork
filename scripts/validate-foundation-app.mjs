import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const mode = process.argv[2] ?? "typecheck";
const cwd = process.cwd();

const manifest = JSON.parse(
  await readFile(path.join(cwd, "package.json"), "utf8"),
);

if (
  !manifest.private ||
  manifest.type !== "module" ||
  typeof manifest.name !== "string" ||
  !manifest.name.startsWith("@loomic/")
) {
  throw new Error(
    "Task 1 app manifests must stay private, ESM, and scoped under @loomic/.",
  );
}

// NOTE: TypeScript 7 (native port) no longer exposes the `ts.sys`-style
// programmatic API, so we validate tsconfig.json without the compiler API.
// Supports the subset this monorepo uses: single-chain `extends` merging of
// compilerOptions. Keep in sync if tsconfigs grow exotic features.
async function loadTsConfig(configPath) {
  const raw = JSON.parse(await readFile(configPath, "utf8"));
  if (typeof raw.extends !== "string") {
    return raw;
  }
  const parentPath = path.resolve(path.dirname(configPath), raw.extends);
  const parent = await loadTsConfig(parentPath);
  return {
    ...parent,
    ...raw,
    compilerOptions: {
      ...(parent.compilerOptions ?? {}),
      ...(raw.compilerOptions ?? {}),
    },
  };
}

const config = await loadTsConfig(path.join(cwd, "tsconfig.json"));

if (config.compilerOptions?.noEmit !== true) {
  throw new Error("Task 1 app tsconfig files must set noEmit=true.");
}

if (mode === "build") {
  const outputDir = path.join(cwd, "dist");
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    path.join(outputDir, ".kenfutwork-build"),
    "Task 1 foundation build marker\n",
    "utf8",
  );
  console.log(
    `[validate-foundation-app] ${manifest.name} build marker written.`,
  );
}
