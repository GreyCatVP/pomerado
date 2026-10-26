import { execFileSync } from "node:child_process";
import { chmod } from "node:fs/promises";

/** Windows chmod does not deny directory writes; exercise real ACL failures instead. */
export async function readOnlyDirectory(path: string): Promise<() => Promise<void>> {
  if (process.platform !== "win32") {
    await chmod(path, 0o500);
    return () => chmod(path, 0o700);
  }
  const identity = execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" });
  const sid = /S-1-[0-9-]+/.exec(identity)?.[0];
  if (!sid) throw new Error("Cannot identify the test account for the write-denial fixture");
  execFileSync("icacls.exe", [path, "/deny", `*${sid}:(OI)(CI)(WD,AD)`], { stdio: "pipe" });
  return async () => { execFileSync("icacls.exe", [path, "/remove:d", `*${sid}`], { stdio: "pipe" }); };
}
