import { spawn } from "node:child_process";
const { joinWindowsJob } = await import(new URL(
  import.meta.url.endsWith(".ts") ? "./windows-native.ts" : "./windows-native.js", import.meta.url,
).href);

const job = process.env["POMERADO_WINDOWS_JOB"];
const command = process.env["POMERADO_WINDOWS_COMMAND"];
delete process.env["POMERADO_WINDOWS_JOB"];
delete process.env["POMERADO_WINDOWS_COMMAND"];
if (!job) throw new Error("Windows process has no owning job");
joinWindowsJob(job);

if (command !== undefined) {
  const { executable, args }: { executable: string; args: string[] } = JSON.parse(command);
  const child = spawn(executable, args, { stdio: "inherit", windowsHide: true });
  child.once("error", () => { process.exitCode = 1; });
  child.once("exit", (code) => { process.exitCode = code ?? 1; });
}
