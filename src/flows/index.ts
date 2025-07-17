// lib/ts/paymcp/src/flows/index.ts
import type { FlowModule, PaidWrapperFactory } from "../types/flows.js";
import * as elicitationMod from "./elicitation.js";
import * as twoStepMod from "./two_step.js";
import * as progressMod from "./progress.js";

/** Реестр известных flow. */
const FLOW_MAP: Record<string, FlowModule> = {
  elicitation: elicitationMod,
  two_step: twoStepMod,
  progress: progressMod,
};

/** Выбрать flow по имени (case-insensitive), иначе ошибка. */
export function makeFlow(name: string): PaidWrapperFactory {
  const key = name.toLowerCase();
  const mod = FLOW_MAP[key];
  if (!mod) {
    throw new Error(`[PayMCP] Unknown payment flow: ${name}`);
  }
  return mod.makePaidWrapper;
}