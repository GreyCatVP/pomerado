import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { ModelRequest } from "@openai/agents";
import { expect, test } from "@playwright/test";
import { Effect, Schema } from "effect";
import { makePomeradoMcp } from "../../src/standalone/mcp-server.js";
import {
  call,
  execution,
  executionIdOf,
  html,
  message,
  objects,
  patch,
  quietReviewer,
  recordingGuardian,
  scripted,
  startSite,
  toolResult,
} from "./guardian-context-fixture.js";
import type { Turn } from "./standalone-mint-fixture.js";

const privatePage = "SYNTHETIC_PRIVATE_PAGE_FAILURE_CANARY";
const privateSecret = "SYNTHETIC_SECRET_FAILURE_CANARY";
const privateStdout = "SYNTHETIC_STDOUT_FAILURE_CANARY";
const publicRecord = Schema.Record({ key: Schema.String, value: Schema.Unknown });

const failedScript = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"failing_fixture",input:Schema.Struct({}),output:Schema.Unknown},
async ({kernel,sessionId,errors}) => {
  const page = await kernel.browsers.playwright.execute(sessionId,{code:"return await page.locator('h1').textContent();",timeout_sec:5});
  if (!page.success || page.result !== ${JSON.stringify(privatePage)}) throw new Error("Fixture page was not read");
  console.log(${JSON.stringify(privateStdout)});
  throw new errors.OperationFailure(${JSON.stringify(privateSecret)} + " " + page.result);
});`;

const finishedMint = async (url: string, turns: readonly Turn[]) => {
  const requests: ModelRequest[] = [];
  const guardian = recordingGuardian();
  const minter = scripted(
    (request, index) => turns[index]?.(request) ?? [message("Stopped after the fixture failure.")],
    requests,
  );
  const response = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* makePomeradoMcp({
          pomerado: {
            minterProvider: minter,
            guardianProvider: guardian.provider,
            outcomeReviewerProvider: quietReviewer,
            timeoutMs: 60_000,
          },
          prepare: () => Effect.succeed(() => Effect.dieMessage("A failing build must not publish")),
        });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        yield* Effect.promise(() => server.connect(serverTransport));
        const client = new Client({ name: "failure-evidence-fixture", version: "1.0.0" });
        yield* Effect.acquireRelease(
          Effect.promise(() => client.connect(clientTransport)),
          () => Effect.promise(() => client.close()),
        );
        const started = yield* Effect.promise(() => client.callTool({
          name: "mint",
          arguments: {
            name: "failure_fixture",
            url,
            intent: "Read the synthetic fixture heading",
            effect: "read",
          },
        }));
        expect(started.isError).not.toBe(true);
        const { job_id } = Schema.decodeUnknownSync(Schema.Struct({ job_id: Schema.UUID }))(
          started.structuredContent,
        );
        for (let attempt = 0; attempt < 12; attempt++) {
          const result = yield* Effect.promise(() => client.callTool({
            name: "get_job",
            arguments: { job_id, wait_seconds: 5 },
          }));
          expect(result.isError).not.toBe(true);
          const view = Schema.decodeUnknownSync(publicRecord)(result.structuredContent);
          if (view["status"] === "completed") return result;
          expect(view["status"], JSON.stringify(result)).toBe("running");
        }
        throw new Error("Scripted fixture mint did not complete within 60 seconds");
      }),
    ),
  );
  const view = Schema.decodeUnknownSync(publicRecord)(response.structuredContent);
  const output = Schema.decodeUnknownSync(publicRecord)(view["output"]);
  expect(output).toMatchObject({
    build: "incomplete",
    executionSummary: { total: 1, failed: 1, completed: 0 },
  });
  const publicText = JSON.stringify(response);
  for (const privateText of [privatePage, privateSecret, privateStdout])
    expect(publicText).not.toContain(privateText);
  return { output, requests, guardian };
};

test("MCP get_job retains finite failure evidence from a real failed browser script", async () => {
  test.setTimeout(90_000);
  const site = await startSite((_request, response) =>
    html(response, `<title>Failure fixture</title><h1>${privatePage}</h1>`),
  );
  try {
    const { output, requests, guardian } = await finishedMint(site.url, [
      () => patch({ "src/tool.mjs": failedScript }),
      () => [call("execute", execution("example", "src/tool.mjs"), "failed_script")],
    ]);
    const receipt = toolResult(requests.at(-1), "failed_script");
    expect(receipt).toMatchObject({ status: "failed", review: { outcome: "allow" } });
    const failure = objects(receipt?.["observations"]).find(
      (value) => value["code"] === "OperationFailure",
    );
    expect(failure).toMatchObject({ code: "OperationFailure", tag: "OperationFailure" });
    expect(failure?.["message"]).toContain(privatePage);
    expect(failure?.["message"]).toContain(privateSecret);
    expect(guardian.reviews.some((review) => review.kind === "execution")).toBe(true);
    expect(site.requests).toContain("GET /");
    const executionId = executionIdOf(requests.at(-1), "failed_script");
    expect(executionId).toMatch(/^[0-9a-f-]{36}$/u);
    console.info("Real script receipt and public MCP output", {
      executionId, code: failure?.["code"], tag: failure?.["tag"], output,
    });
    expect(output["failedExecutions"]).toEqual(expect.arrayContaining([
      expect.objectContaining({ executionId, purpose: "example", code: "OperationFailure" }),
    ]));
    for (const failed of objects(output["failedExecutions"])) {
      expect(failed).not.toHaveProperty("message");
      expect(failed).not.toHaveProperty("stdout");
    }
  } finally {
    await site.close();
  }
});

test("MCP get_job retains a real nonzero pureFiles command's failure evidence", async () => {
  test.setTimeout(90_000);
  const site = await startSite((_request, response) =>
    html(response, "<title>Command fixture</title><h1>Synthetic fixture</h1>"),
  );
  try {
    const { output, requests } = await finishedMint(site.url, [
      () => [call("exec_command", {
        cmd: `printf '%s\\n' '${privateSecret} ${privatePage} ${privateStdout}'; exit 7`,
      }, "failed_command")],
    ]);
    const receipt = toolResult(requests.at(-1), "failed_command");
    expect(receipt).toMatchObject({ status: "failed" });
    expect(objects(receipt?.["observations"])).toContainEqual(
      expect.objectContaining({ exitCode: 7, stdout: expect.stringContaining(privateStdout) }),
    );
    const executionId = executionIdOf(requests.at(-1), "failed_command");
    console.info("Real command receipt and public MCP output", { executionId, exitCode: 7, output });
    expect(output["failedExecutions"]).toEqual(expect.arrayContaining([
      expect.objectContaining({ executionId, purpose: "command", exitCode: 7 }),
    ]));
    for (const failed of objects(output["failedExecutions"])) {
      expect(failed).not.toHaveProperty("message");
      expect(failed).not.toHaveProperty("stdout");
    }
  } finally {
    await site.close();
  }
});
