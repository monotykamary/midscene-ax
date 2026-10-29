import type {
  AiActEffort,
  DeviceAction,
  PlanningAIResponse,
  UIContext,
} from '@/types';
import type { ModelRuntime } from '../../models';
import type { PreparedUserPrompt } from '../../shared/multimodal-prompt';
import type { ConversationHistory } from './conversation-history';

export interface PlanOptions {
  context: UIContext;
  actionSpace: DeviceAction<any>[];
  actionContext?: string;
  /** Advisory guidance from a previous planner, not a user instruction. */
  planningAdvice?: string;
  modelRuntime: ModelRuntime;
  getDefaultModelRuntime?: () => ModelRuntime;
  conversationHistory: ConversationHistory;
  includeLocateInPlanning: boolean;
  imagesIncludeCount?: number;
  // Controls aiAct planning prompt shape and state updates, such as sub-goals.
  effort: AiActEffort;
  abortSignal?: AbortSignal;
  /** The device's description of this round's page (AbstractInterface.planningContext); sent with this request only. */
  pageDescription?: string;
}

export type PlanFn = (
  userInstruction: PreparedUserPrompt,
  options: PlanOptions,
) => Promise<PlanningAIResponse>;
