import {execFileSync} from "node:child_process";
import {createRequire} from "node:module";
import {mkdtempSync, realpathSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";

const require = createRequire(import.meta.url);
const tscPath = require.resolve("typescript/bin/tsc");
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lodestarModulesDir = path.join(rootDir, "packages/light-client/node_modules/@lodestar");
const packageNames = ["params", "utils", "types", "config", "api", "state-transition"];
const tempDir = mkdtempSync(path.join(tmpdir(), "lodestar-prover-build-"));

try {
  for (const packageName of packageNames) {
    const packageDir = realpathSync(path.join(lodestarModulesDir, packageName));
    const sourceDir = path.join(packageDir, "src");
    const outputDir = path.join(packageDir, "lib");
    const configPath = path.join(tempDir, `${packageName}.json`);

    writeFileSync(
      configPath,
      JSON.stringify({
        compilerOptions: {
          declaration: false,
          incremental: false,
          lib: ["es2023", "esnext.array", "dom"],
          module: "nodenext",
          moduleResolution: "nodenext",
          noCheck: true,
          outDir: outputDir,
          rewriteRelativeImportExtensions: true,
          rootDir: sourceDir,
          sourceMap: true,
          target: "es2023",
        },
        exclude: [`${sourceDir}/**/*.test.ts`],
        include: [`${sourceDir}/**/*.ts`],
      })
    );

    console.log(`Building @lodestar/${packageName} from Git source`);
    execFileSync(process.execPath, [tscPath, "-p", configPath], {cwd: rootDir, stdio: "inherit"});
  }
} finally {
  rmSync(tempDir, {force: true, recursive: true});
}
