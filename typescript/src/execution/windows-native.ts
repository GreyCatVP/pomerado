import { randomUUID } from "node:crypto";
import { join, toNamespacedPath } from "node:path";
import koffi from "koffi";

// Load from the Windows system directory, never the workspace or DLL search path.
const kernel = koffi.load(join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "kernel32.dll"));
const closeHandle = kernel.func("int __stdcall CloseHandle(void *handle)");
const lastError = kernel.func("uint32 __stdcall GetLastError()");
const check = (ok: unknown) => { if (!ok) throw new Error(`Windows native operation failed (${lastError()})`); };
const createJob = kernel.func("void * __stdcall CreateJobObjectW(void *attributes, str16 name)");
const openJob = kernel.func("void * __stdcall OpenJobObjectW(uint32 access, int inherit, str16 name)");
const setJob = kernel.func("int __stdcall SetInformationJobObject(void *job, int kind, void *info, uint32 size)");
const assignJob = kernel.func("int __stdcall AssignProcessToJobObject(void *job, void *process)");
const currentProcess = kernel.func("void * __stdcall GetCurrentProcess()");
const terminateJob = kernel.func("int __stdcall TerminateJobObject(void *job, uint32 code)");
const queryJob = kernel.func("int __stdcall QueryInformationJobObject(void *job, int kind, void *info, uint32 size, void *returned)");

/** No breakaway or inherited handles: closing the host's handle kills the entire owned tree. */
export function createWindowsJob() {
  const name = `Local\\pomerado-${randomUUID()}`;
  const handle: unknown = createJob(null, name);
  check(handle);
  try {
    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION: LimitFlags is at byte 16 on both Win32 ABIs.
    const limits = Buffer.alloc(process.arch === "ia32" ? 112 : 144);
    limits.writeUInt32LE(0x2000, 16); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    check(setJob(handle, 9, limits, limits.length));
  } catch (error) { closeHandle(handle); throw error; }
  let closed = false;
  return {
    name,
    stop() { if (!closed) check(terminateJob(handle, 1)); },
    empty() {
      const info = Buffer.alloc(48);
      check(queryJob(handle, 1, info, info.length, null));
      return info.readUInt32LE(40) === 0;
    },
    close() { if (!closed) { check(closeHandle(handle)); closed = true; } },
  };
}

/** The trusted Node preloader joins before it imports authored code or starts a shell. */
export function joinWindowsJob(name: string) {
  const handle: unknown = openJob(1, 0, name); // JOB_OBJECT_ASSIGN_PROCESS
  check(handle);
  try { check(assignJob(handle, currentProcess())); }
  finally { closeHandle(handle); }
}

const createFile = kernel.func("void * __stdcall CreateFileW(str16 path, uint32 access, uint32 share, void *security, uint32 disposition, uint32 flags, void *template)");
const fileInformation = kernel.func("int __stdcall GetFileInformationByHandle(void *file, void *info)");
const readFile = kernel.func("int __stdcall ReadFile(void *file, void *buffer, uint32 length, void *read, void *overlapped)");
const invalidHandle = (1n << BigInt(koffi.sizeof("void *") * 8)) - 1n;

/** Hold every ancestor without delete sharing, so a junction/rename cannot redirect the read. */
export function readWindowsScopedFile(root: string, parts: readonly string[], maximumBytes: number): Uint8Array {
  const handles: unknown[] = [];
  try {
    let path = root;
    for (let index = -1; index < parts.length; index++) {
      if (index >= 0) path = join(path, parts[index]!);
      const directory = index < parts.length - 1;
      const handle: unknown = createFile(toNamespacedPath(path), directory ? 0x80 : 0x80000000,
        3, null, 3, 0x02200000, null); // READ|WRITE sharing; OPEN_REPARSE_POINT|BACKUP_SEMANTICS
      if (handle === null || koffi.address(handle) === invalidHandle) { check(false); }
      handles.push(handle);
      const info = Buffer.alloc(52); // BY_HANDLE_FILE_INFORMATION
      check(fileInformation(handle, info));
      const attributes = info.readUInt32LE(0);
      if (attributes & 0x400) throw new Error("scope: reparse points are refused (ELOOP)");
      if (directory) {
        if (!(attributes & 0x10)) throw new Error("scope: parent is not a directory (ENOTDIR)");
        continue;
      }
      const size = info.readUInt32LE(32) * 2 ** 32 + info.readUInt32LE(36);
      if ((attributes & 0x10) || size > maximumBytes) throw new Error("type_or_size");
      let bytes = Buffer.alloc(Math.min(size, maximumBytes) + 1);
      const count = Buffer.alloc(4);
      let length = 0;
      for (;;) {
        if (length === bytes.length) {
          if (length > maximumBytes) break;
          const grown = Buffer.alloc(Math.min(bytes.length * 2, maximumBytes + 1));
          bytes.copy(grown, 0, 0, length);
          bytes = grown;
        }
        check(readFile(handle, bytes.subarray(length), bytes.length - length, count, null));
        const read = count.readUInt32LE(0);
        if (read === 0) break;
        length += read;
      }
      if (length > maximumBytes) throw new Error("size");
      return new Uint8Array(bytes.subarray(0, length));
    }
    throw new Error("scope");
  } finally { for (const handle of handles.reverse()) closeHandle(handle); }
}
