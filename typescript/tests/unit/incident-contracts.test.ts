import { Schema } from "effect";
import { expect, it } from "vitest";
import { MintIncident } from "../../src/mint/incident-contracts.js";

const gap = (severity: string) => ({
  source: "recorder",
  kind: "observation_gap",
  reason: "target_setup_failed",
  hostBug: false,
  severity,
  websiteEffect: "may_have_dispatched",
  detail: { subCause: "cdp_command_rejected" },
});

it("round-trips a recorder gap at every severity and rejects an unknown one", () => {
  for (const severity of ["info", "high", "critical"]) {
    const decoded = Schema.decodeUnknownSync(MintIncident)(gap(severity));
    expect(decoded.severity).toBe(severity);
    expect(Schema.encodeSync(MintIncident)(decoded)).toEqual(decoded);
  }
  expect(() => Schema.decodeUnknownSync(MintIncident)(gap("urgent"))).toThrow();
});
