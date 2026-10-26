import { Runner, type ModelProvider } from "@openai/agents";
import type { ModelObserverFactory } from "../models/model-observer.js";
import type { JobTrace } from "./job-trace.js";

export const tracedProvider = (trace: JobTrace, role: "minter" | "guardian" | "outcome", provider: ModelProvider = new Runner().config.modelProvider): ModelProvider => {
  let calls = 0;
  return {
    getModel: async (name) => {
      let model;
      try { model = await provider.getModel(name); }
      catch (error) { trace.event("model.error", { role, name, error }); throw error; }
      return {
        ...model,
        ...(model.getRetryAdvice === undefined ? {} : { getRetryAdvice: model.getRetryAdvice.bind(model) }),
        getResponse: async (request) => {
          const ref = `${role}:${++calls}`;
          trace.event("model.request", { role, ...request }, ref);
          try {
            const result = await model.getResponse(request);
            trace.event("model.response", { role, result }, ref);
            return result;
          } catch (error) { trace.event("model.error", { role, error }, ref); throw error; }
        },
        getStreamedResponse: async function* (request) {
          const ref = `${role}:${++calls}`;
          trace.event("model.request", { role, ...request }, ref);
          try {
            for await (const event of model.getStreamedResponse(request)) {
              trace.event("model.stream", { role, event }, ref);
              yield event;
            }
          } catch (error) { trace.event("model.error", { role, error }, ref); throw error; }
        },
      };
    },
  };
};

export const traceObserverFactory = (trace: JobTrace): ModelObserverFactory => () => ({
  attach: (runner) => {
    runner.on("agent_tool_start", (_context, _agent, tool, details) => {
      trace.event("tool.request", { name: tool.name, call: details.toolCall }, "callId" in details.toolCall ? details.toolCall.callId : details.toolCall.id);
    });
    runner.on("agent_tool_end", (_context, _agent, tool, result, details) => {
      trace.event("tool.result", { name: tool.name, result }, "callId" in details.toolCall ? details.toolCall.callId : details.toolCall.id);
    });
  },
  tool: async (call, invoke) => {
    trace.event("tool.dispatch", call, call.callId);
    try {
      const result = await invoke();
      trace.event("tool.returned", { name: call.name, result }, call.callId);
      return result;
    } catch (error) { trace.event("tool.error", { name: call.name, error }, call.callId); throw error; }
  },
  provider: (provider) => provider,
  started: (input) => trace.event("model.started", input),
  skillsInstalled: (names) => trace.event("model.skills", names),
  segment: (details) => trace.event("model.segment", details),
  completed: (history, usage) => trace.event("model.completed", { history, usage }),
  failed: (error) => trace.event("model.failed", error),
  takeNativeCall: () => undefined,
  durabilityFailure: () => undefined,
  terminal: () => ({ phase: "terminal", timing: { phase: "terminal", sequence: 0, occurredAtUtc: new Date().toISOString(), occurredMonotonicMs: performance.now(), queueMs: 0 }, value: undefined }),
  flush: async () => {},
});
