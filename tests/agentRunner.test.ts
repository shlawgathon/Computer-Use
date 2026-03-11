import { describe, expect, it, mock } from "bun:test";
import type { CaptureFrame, VisionAction } from "../src/types";
import {
  executeAgentStepWithDeps,
  formatVisionCost,
  formatVisionUsage,
  runAgentLoopWithDeps,
  summarizeRunCost,
  type AgentRunnerDeps,
} from "../src/lib/agentRunner";
import type { AgentStep } from "../src/HudWidgets";

function makeCaptureFrame(index: number): CaptureFrame {
  return {
    monitor_id: 1,
    monitor_origin_x_pt: 0,
    monitor_origin_y_pt: 0,
    screenshot_w_px: 1440,
    screenshot_h_px: 900,
    scale_factor: 2,
    png_path: `/tmp/frame-${index}.png`,
    capture_ms: 12 + index,
  };
}

function makeTimeouts(overrides?: Partial<AgentRunnerDeps["timeouts"]>): AgentRunnerDeps["timeouts"] {
  return {
    captureMs: 15000,
    contextMs: 8000,
    inferMs: 45000,
    actionMs: 20000,
    ...overrides,
  };
}

describe("agentRunner", () => {
  it("executes the mocked ingestion, context, view, and output flow end-to-end", async () => {
    const captures = [makeCaptureFrame(1), makeCaptureFrame(2), makeCaptureFrame(3)];
    const inferredActions: VisionAction[] = [
      {
        action: "shell",
        x_norm: 0,
        y_norm: 0,
        confidence: 0.94,
        reason: "List the Desktop contents",
        model_ms: 120,
        sent_w: 1440,
        sent_h: 900,
        model: "openai/gpt-5-pro",
        provider: "openrouter",
        usage: {
          prompt_tokens: 900,
          completion_tokens: 40,
          total_tokens: 940,
          estimated_prompt_tokens: 900,
          estimated_completion_tokens: 40,
          estimated_total_tokens: 940,
          estimated_cost_usd: 0.0084,
        },
        command: "ls -la ~/Desktop",
      },
      {
        action: "click",
        x_norm: 640,
        y_norm: 360,
        confidence: 0.97,
        reason: "Open the selected item",
        model_ms: 95,
        sent_w: 1440,
        sent_h: 900,
        model: "openai/gpt-5-pro",
        provider: "openrouter",
        usage: {
          prompt_tokens: 940,
          completion_tokens: 18,
          total_tokens: 958,
          estimated_prompt_tokens: 940,
          estimated_completion_tokens: 18,
          estimated_total_tokens: 958,
          estimated_cost_usd: 0.0091,
        },
      },
      {
        action: "none",
        x_norm: 0,
        y_norm: 0,
        confidence: 0,
        reason: "The target window is already open",
        model_ms: 80,
        sent_w: 1440,
        sent_h: 900,
        model: "openai/gpt-5-pro",
        provider: "openrouter",
        usage: {
          prompt_tokens: 980,
          completion_tokens: 12,
          total_tokens: 992,
          estimated_prompt_tokens: 980,
          estimated_completion_tokens: 12,
          estimated_total_tokens: 992,
          estimated_cost_usd: 0.0096,
        },
      },
    ];
    const windowContexts = [
      "Window: Finder\nFrontmost: Finder",
      "Window: Finder\nFrontmost: Finder",
      "Window: Preview\nFrontmost: Preview",
    ];

    const inferRequests: Array<Record<string, unknown>> = [];
    const clickRequests: Array<Record<string, unknown>> = [];
    const emittedSteps: AgentStep[] = [];
    const sleepCalls: number[] = [];
    const seenCaptures: CaptureFrame[] = [];
    const seenVision: VisionAction[] = [];
    const onStepCalls: AgentStep[] = [];

    const invokeFn: AgentRunnerDeps["invokeFn"] = mock(async (command, payload) => {
      switch (command) {
        case "capture_primary_cmd":
          return captures.shift();
        case "infer_click_cmd":
          inferRequests.push((payload as { req: Record<string, unknown> }).req);
          return inferredActions.shift();
        case "run_shell_cmd":
          expect((payload as { command: string }).command).toBe("ls -la ~/Desktop");
          return "report.md\nnotes.txt";
        case "execute_real_click_cmd":
          clickRequests.push((payload as { req: Record<string, unknown> }).req);
          return undefined;
        default:
          throw new Error(`Unexpected command: ${command}`);
      }
    });

    const emitFn: AgentRunnerDeps["emitFn"] = mock(async (event, payload) => {
      expect(event).toBe("agent_step");
      emittedSteps.push(payload as AgentStep);
    });

    const getWindowContextFn: AgentRunnerDeps["getWindowContextFn"] = mock(async () => {
      return windowContexts.shift() ?? "";
    });

    const sleepFn: AgentRunnerDeps["sleepFn"] = mock(async (ms) => {
      sleepCalls.push(ms);
    });

    const steps = await runAgentLoopWithDeps(
      {
        instruction: "Open the selected desktop item",
        model: "test-model",
        delayMs: 25,
        shouldStop: () => false,
        onStep: (step) => onStepCalls.push(step),
        onCapture: (captured) => seenCaptures.push(captured),
        onVision: (inferred) => seenVision.push(inferred),
      },
      { invokeFn, emitFn, getWindowContextFn, sleepFn, timeouts: makeTimeouts() },
    );

    expect(seenCaptures).toHaveLength(3);
    expect(seenVision).toHaveLength(3);
    expect(sleepCalls).toEqual([25, 25]);

    expect(inferRequests).toHaveLength(3);
    expect(inferRequests[0]).toMatchObject({
      png_path: "/tmp/frame-1.png",
      instruction: "Open the selected desktop item",
      model: "test-model",
      step_context: "Window: Finder\nFrontmost: Finder",
    });
    expect(inferRequests[1].step_context).toContain("Window: Finder\nFrontmost: Finder");
    expect(inferRequests[1].step_context).toContain(
      "Step 1: shell `ls -la ~/Desktop` → report.md\nnotes.txt — List the Desktop contents",
    );
    expect(inferRequests[2].step_context).toContain("Window: Preview\nFrontmost: Preview");
    expect(inferRequests[2].step_context).toContain(
      "Step 2: clicked at (640, 360) — Open the selected item",
    );

    expect(clickRequests).toEqual([
      {
        x_norm: 640,
        y_norm: 360,
        screenshot_w_px: 1440,
        screenshot_h_px: 900,
        monitor_origin_x_pt: 0,
        monitor_origin_y_pt: 0,
        scale_factor: 2,
        confidence: 0.97,
        sent_w_px: 1440,
        sent_h_px: 900,
      },
    ]);

    expect(steps.map((step) => step.phase)).toEqual([
      "capture",
      "thinking",
      "shell",
      "capture",
      "thinking",
      "click",
      "capture",
      "thinking",
      "done",
    ]);
    expect(emittedSteps.map((step) => step.phase)).toEqual(
      steps.map((step) => step.phase),
    );
    expect(onStepCalls.map((step) => step.phase)).toEqual(
      steps.map((step) => step.phase),
    );
    expect(summarizeRunCost(steps)).toBe("total cost ~$0.027100 (2890 tok)");
  });

  it("passes explicit step context through single-step ingestion", async () => {
    const capture = makeCaptureFrame(9);
    const action: VisionAction = {
      action: "type",
      x_norm: 0,
      y_norm: 0,
      confidence: 0.99,
      reason: "Spotlight is focused",
      model_ms: 40,
      sent_w: 1440,
      sent_h: 900,
      model: "openai/gpt-5.2-pro",
      provider: "openrouter",
      usage: {
        prompt_tokens: 120,
        completion_tokens: 6,
        total_tokens: 126,
        estimated_prompt_tokens: 120,
        estimated_completion_tokens: 6,
        estimated_total_tokens: 126,
        estimated_cost_usd: 0.0008,
      },
      text: "Preview",
    };

    const invokeFn: AgentRunnerDeps["invokeFn"] = mock(async (command, payload) => {
      if (command === "capture_primary_cmd") return capture;
      if (command === "infer_click_cmd") {
        expect(payload).toEqual({
          req: {
            png_path: "/tmp/frame-9.png",
            instruction: "Open Preview",
            model: "test-model",
            step_context: "Window: Spotlight",
          },
        });
        return action;
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const result = await executeAgentStepWithDeps(
      {
        instruction: "Open Preview",
        model: "test-model",
        stepContext: "Window: Spotlight",
      },
      {
        invokeFn,
        emitFn: mock(async () => undefined),
        getWindowContextFn: mock(async () => ""),
        sleepFn: mock(async () => undefined),
        timeouts: makeTimeouts(),
      },
    );

    expect(result).toEqual({
      captured: capture,
      inferred: action,
    });
  });

  it("formats estimated usage when provider token counts are unavailable", () => {
    expect(
      formatVisionUsage({
        action: "none",
        x_norm: 0,
        y_norm: 0,
        confidence: 0,
        reason: "done",
        model_ms: 1,
        sent_w: 100,
        sent_h: 100,
        model: "test-model",
        provider: null,
        usage: {
          prompt_tokens: null,
          completion_tokens: null,
          total_tokens: null,
          estimated_prompt_tokens: 123,
          estimated_completion_tokens: 7,
          estimated_total_tokens: 130,
          estimated_cost_usd: 0.00123,
        },
      }),
    ).toBe("~130 tok (~123 in / ~7 out)");
    expect(
      formatVisionCost({
        action: "none",
        x_norm: 0,
        y_norm: 0,
        confidence: 0,
        reason: "done",
        model_ms: 1,
        sent_w: 100,
        sent_h: 100,
        model: "test-model",
        provider: null,
        usage: {
          prompt_tokens: null,
          completion_tokens: null,
          total_tokens: null,
          estimated_prompt_tokens: 123,
          estimated_completion_tokens: 7,
          estimated_total_tokens: 130,
          estimated_cost_usd: 0.00123,
        },
      }),
    ).toBe("~$0.001230");
  });

  it("emits an error step when inference stalls", async () => {
    const emittedSteps: AgentStep[] = [];
    const onStepCalls: AgentStep[] = [];

    const invokeFn: AgentRunnerDeps["invokeFn"] = mock(async (command) => {
      if (command === "capture_primary_cmd") return makeCaptureFrame(1);
      if (command === "infer_click_cmd") {
        return await new Promise(() => {});
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const emitFn: AgentRunnerDeps["emitFn"] = mock(async (_event, payload) => {
      emittedSteps.push(payload as AgentStep);
    });

    await expect(
      runAgentLoopWithDeps(
        {
          instruction: "Open Chrome",
          model: "test-model",
          shouldStop: () => false,
          onStep: (step) => onStepCalls.push(step),
        },
        {
          invokeFn,
          emitFn,
          getWindowContextFn: mock(async () => "Window: Finder"),
          sleepFn: mock(async () => undefined),
          timeouts: makeTimeouts({ inferMs: 5 }),
        },
      ),
    ).rejects.toThrow("model inference timed out");

    expect(onStepCalls.at(-1)?.phase).toBe("error");
    expect(onStepCalls.at(-1)?.message).toContain("model inference timed out");
    expect(emittedSteps.at(-1)?.phase).toBe("error");
  });
});
