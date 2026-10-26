import { AsyncLocalStorage } from "node:async_hooks";
import type { Editor, FunctionTool } from "@openai/agents";
import { filesystem, type SandboxSession } from "@openai/agents/sandbox";

/** Use the SDK's function patch parser with the capability's already-scoped host editor. */
export const functionFileTool = (editor: Editor, session: SandboxSession): FunctionTool => {
  const calls = new AsyncLocalStorage<{ applied: number; failed: boolean }>();
  const observe = <A extends unknown[], R>(
    apply: (...args: A) => Promise<R>,
  ) => async (...args: A): Promise<R | { status: "failed"; output: string }> => {
    const call = calls.getStore();
    if (call === undefined) throw new Error("File edit has no active tool call.");
    if (call.failed) return { status: "failed", output: "An earlier patch operation failed; nothing else was applied." };
    try {
      const result = await apply(...args);
      call.applied++;
      if (result && typeof result === "object" && "status" in result && result.status === "failed")
        call.failed = true;
      return result;
    } catch (error) {
      call.failed = true;
      throw error;
    }
  };
  const observed: Editor = {
    createFile: observe((...args: Parameters<Editor["createFile"]>) => editor.createFile(...args)),
    updateFile: observe((...args: Parameters<Editor["updateFile"]>) => editor.updateFile(...args)),
    deleteFile: observe((...args: Parameters<Editor["deleteFile"]>) => editor.deleteFile(...args)),
  };
  // An unbound model selects the SDK's existing function fallback. No transport or parser is
  // replaced. Only this patch tool is taken; the SDK has already scoped the supplied editor.
  const fallback = filesystem()
    .bind({ ...session, createEditor: () => observed })
    .tools()
    .find((entry): entry is FunctionTool => entry.type === "function" && entry.name === "apply_patch");
  if (fallback === undefined) throw new Error("The SDK function file tool is unavailable.");
  return {
    ...fallback,
    invoke: (...args) => calls.run({ applied: 0, failed: false }, async () => {
      const call = calls.getStore()!;
      const output = await fallback.invoke(...args);
      return JSON.stringify({ status: call.applied > 0 && !call.failed ? "completed" : "failed", output });
    }),
  };
};
