import { Effect } from "effect";
import { expect, it } from "vitest";
import * as pomerado from "../../src/standalone/index.js";

it("the local host refuses to attach over CDP, since its runs reset a browser's tabs and site data", async () => {
  const created = await Effect.runPromise(
    Effect.scoped(
      Effect.either(
        pomerado.createPomerado({
          ask: () => Effect.die(new Error("never asked")),
          browser: { cdp: { url: "ws://127.0.0.1:9/never" } },
        } as Parameters<typeof pomerado.createPomerado>[0]),
      ),
    ),
  );
  expect(created).toMatchObject({
    _tag: "Left",
    left: { message: expect.stringContaining("doesn't attach over CDP") },
  });
});
