import childProcess, {ChildProcessWithoutNullStreams} from "node:child_process";
import path from "node:path";
import type {Argv} from "yargs";
import {sleep} from "@lodestar/utils";

type CommandRunOptions = {
  timeoutMs?: number;
};

type SpawnCliCommandOptions = {
  env?: Record<string, string>;
  pipeStdioToParent?: boolean;
  runWith?: "node" | "ts-node";
};

function parseArgs(args: string[]): string[] {
  return args.flatMap((arg) => arg.split(" "));
}

function repoRootPath(filePath: string): string {
  return path.join(process.cwd(), filePath);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    sleep(timeoutMs).then(() => {
      throw new Error(`Promise timeout after ${timeoutMs}ms.`);
    }),
  ]);
}

export async function runCliCommand<T>(cli: Argv<T>, args: string[], opts: CommandRunOptions = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 1000;

  return withTimeout(
    new Promise<string>((resolve, reject) => {
      void cli
        .parseAsync(parseArgs(args), {}, (err, _argv, output) => {
          if (err) {
            reject(err);
            return;
          }

          resolve(output);
        })
        .catch(reject);
    }),
    timeoutMs
  );
}

export async function spawnCliCommand(
  command: string,
  args: string[],
  opts?: SpawnCliCommandOptions
): Promise<ChildProcessWithoutNullStreams> {
  const argsPrefixed =
    opts?.runWith === "ts-node"
      ? ["--loader", "ts-node/esm", repoRootPath(command), ...args]
      : [repoRootPath(command), ...args];

  return new Promise<ChildProcessWithoutNullStreams>((resolve, reject) => {
    const proc = childProcess.spawn("node", parseArgs(argsPrefixed), {
      env: {...process.env, ...opts?.env},
    });

    if (opts?.pipeStdioToParent) {
      proc.stdout.pipe(process.stdout);
      proc.stderr.pipe(process.stderr);
    }

    proc.once("error", reject);
    resolve(proc);
  });
}

export async function stopChildProcess(
  proc: childProcess.ChildProcess,
  signal: NodeJS.Signals | number = "SIGTERM"
): Promise<void> {
  if (proc.killed || proc.exitCode !== null || proc.signalCode !== null) {
    return;
  }

  const pid = proc.pid;

  await new Promise<void>((resolve, reject) => {
    proc.once("error", reject);
    proc.once("exit", () => resolve());
    proc.kill(signal);
  });

  if (pid !== undefined && isPidRunning(pid)) {
    await sleep(500);
    await stopChildProcess(proc, "SIGKILL");
  }
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_e) {
    return false;
  }
}
