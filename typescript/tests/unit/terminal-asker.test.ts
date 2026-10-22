import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { Effect, Either } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { makeTerminalAsker, OwnerCancelled } from "../../src/inputs/terminal.js";

const stdin = Object.getOwnPropertyDescriptor(process, "stdin");
afterEach(() => {
  if (stdin !== undefined) Object.defineProperty(process, "stdin", stdin);
  vi.restoreAllMocks();
});

it("reports the owner closing the input at a question as their own cancel, still NoResponse", async () => {
  const input = new PassThrough();
  Object.defineProperty(process, "stdin", { value: input, configurable: true });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const asked = Effect.runPromise(
    Effect.either(
      makeTerminalAsker()({
        id: randomUUID(),
        source: "system",
        questions: [
          {
            id: "choice",
            type: "choice",
            prompt: "How should Pomerado respond to this dialog?",
            options: [
              { id: "accept", label: "Accept" },
              { id: "dismiss", label: "Dismiss" },
            ],
          },
        ],
      }),
    ),
  );
  input.end();
  const answered = await asked;
  expect(Either.isLeft(answered) && answered.left).toBeInstanceOf(OwnerCancelled);
  expect(Either.isLeft(answered) && answered.left).toMatchObject({
    _tag: "InputRequestFailure",
    code: "NoResponse",
  });
});

it("omits password prompt and answer field when currentStep.password is false", async () => {
  const input = new PassThrough();
  (input as any).isTTY = true;
  (input as any).setRawMode = () => {};
  Object.defineProperty(process, "stdin", { value: input, configurable: true });
  const stderr: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });

  const asked = Effect.runPromise(
    makeTerminalAsker()({
      id: randomUUID(),
      source: "system",
      questions: [
        {
          id: "login",
          type: "credential",
          prompt: "Sign in with your username",
          fields: "username_password",
          reason: "missing_credentials",
          allowSave: false,
          siteOrigin: "https://example.com",
          currentStep: {
            identifierKinds: ["username"],
            password: false,
          },
        },
      ],
    }),
  );

  input.write("alice\n");
  const answered = await asked;

  expect(stderr.join("")).toContain("Username: ");
  expect(stderr.join("")).not.toContain("Password: ");
  expect(answered).toEqual({
    login: {
      type: "credential",
      value: { username: "alice", saveLogin: false },
    },
  });
  expect("password" in (answered as any).login.value).toBe(false);
});

it("prompts for password and includes it when currentStep requires a password", async () => {
  const input = new PassThrough();
  (input as any).isTTY = true;
  (input as any).setRawMode = () => {};
  Object.defineProperty(process, "stdin", { value: input, configurable: true });
  const stderr: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });

  const asked = Effect.runPromise(
    makeTerminalAsker()({
      id: randomUUID(),
      source: "system",
      questions: [
        {
          id: "login",
          type: "credential",
          prompt: "Sign in with your credentials",
          fields: "username_password",
          reason: "missing_credentials",
          allowSave: false,
          siteOrigin: "https://example.com",
          currentStep: {
            identifierKinds: ["username"],
            password: true,
          },
        },
      ],
    }),
  );

  input.write("alice\n");
  // Simulate password keypress and enter in raw mode
  setTimeout(() => {
    input.emit("keypress", "s", { name: "s" });
    input.emit("keypress", "", { name: "return" });
  }, 20);

  const answered = await asked;

  expect(stderr.join("")).toContain("Username: ");
  expect(stderr.join("")).toContain("Password: ");
  expect(answered).toEqual({
    login: {
      type: "credential",
      value: { username: "alice", password: "s", saveLogin: false },
    },
  });
});

it("declines login when username is empty and allowDecline is true on a password-free step", async () => {
  const input = new PassThrough();
  (input as any).isTTY = true;
  (input as any).setRawMode = () => {};
  Object.defineProperty(process, "stdin", { value: input, configurable: true });
  const stderr: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });

  const asked = Effect.runPromise(
    makeTerminalAsker()({
      id: randomUUID(),
      source: "system",
      questions: [
        {
          id: "login",
          type: "credential",
          prompt: "Sign in with your username",
          fields: "username_password",
          reason: "missing_credentials",
          allowSave: false,
          allowDecline: true,
          siteOrigin: "https://example.com",
          currentStep: {
            identifierKinds: ["username"],
            password: false,
          },
        },
      ],
    }),
  );

  // Leave username empty to decline
  input.write("\n");
  const answered = await asked;

  expect(stderr.join("")).toContain("Username (leave empty to go on without signing in): ");
  expect(stderr.join("")).not.toContain("Password: ");
  expect(answered).toEqual({
    login: {
      type: "credential",
      value: { declined: "public_only", saveLogin: false },
    },
  });
});
