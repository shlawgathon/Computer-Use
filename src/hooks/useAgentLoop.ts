// ── useAgentLoop — Agent Loop State & Controls ─────────

import { useRef, useState, useCallback } from "react";
import type { AgentStep } from "../HudWidgets";
import type { CaptureFrame, VisionAction } from "../types";
import { runAgentLoop } from "../lib/agentRunner";

export interface AgentLoopState {
  looping: boolean;
  busy: boolean;
  activity: AgentStep[];
  capture: CaptureFrame | null;
  vision: VisionAction | null;
}

export function useAgentLoop() {
  const [looping, setLooping] = useState(false);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<AgentStep[]>([]);
  const [capture, setCapture] = useState<CaptureFrame | null>(null);
  const [vision, setVision] = useState<VisionAction | null>(null);
  const stopRef = useRef(false);

  const pushActivity = useCallback((step: AgentStep) => {
    setActivity((a) => [...a.slice(-40), step]);
  }, []);

  const clearActivity = useCallback(() => {
    setActivity([]);
  }, []);

  const startLoop = useCallback(
    async (opts: {
      instruction: string;
      model: string;
      maxSteps?: number;
      delayMs?: number;
      onComplete?: (steps: AgentStep[]) => void;
    }) => {
      stopRef.current = false;
      setLooping(true);
      setBusy(true);

      try {
        const steps = await runAgentLoop({
          instruction: opts.instruction,
          model: opts.model,
          maxSteps: opts.maxSteps,
          delayMs: opts.delayMs,
          shouldStop: () => stopRef.current,
          onStep: pushActivity,
          onCapture: setCapture,
          onVision: setVision,
        });
        opts.onComplete?.(steps);
        return steps;
      } finally {
        setLooping(false);
        setBusy(false);
      }
    },
    [pushActivity],
  );

  const stopLoop = useCallback(() => {
    stopRef.current = true;
  }, []);

  return {
    looping,
    busy,
    activity,
    capture,
    vision,
    setCapture,
    setVision,
    pushActivity,
    clearActivity,
    startLoop,
    stopLoop,
    stopRef,
  };
}
