/**
 * Identity-only document-readiness policy used by Page.goto. IDs are opaque: production
 * passes CDP frame and loader strings, a proof bridge may pass natural-number labels.
 * A readiness receipt is not a verdict about any control or authored step.
 */
export type NavigationId = string | number;
export type NavigationParams = {
  /** The owning CDP session; events from any other session never move the state. */
  session: NavigationId | undefined;
  /** The frame and loader `Page.navigate` reported: only their commit may anchor the chain. */
  expectedFrame: NavigationId | undefined;
  expectedLoader: NavigationId | undefined;
};
export type NavigationState = {
  frame: NavigationId;
  loader: NavigationId;
  committed: boolean;
  anchored: boolean;
  pending: boolean;
  ready: boolean;
  terminal: boolean;
};
export type NavigationEvent = {
  kind: 'commit' | 'dcl' | 'reset' | 'start' | 'fail' | 'timeout';
  session?: NavigationId;
  frame?: NavigationId;
  loader?: NavigationId;
  /** `commit` only: the top-level frame committed a document. */
  root?: boolean;
};

export const initialNavigation = (): NavigationState => ({ frame: 0, loader: 0, committed: false, anchored: false, pending: false, ready: false, terminal: false });

export function navigationStep(params: NavigationParams, state: NavigationState, event: NavigationEvent): NavigationState {
  if (state.terminal) return state;
  const owned = event.session === params.session;
  if (event.kind === 'timeout' || (owned && event.kind === 'fail')) {
    return { ...state, ready: false, terminal: true };
  }
  if (owned && event.kind === 'commit' && event.root) {
    if (!state.anchored && (event.frame !== params.expectedFrame || event.loader !== params.expectedLoader)) return state;
    return { ...state, frame: event.frame!, loader: event.loader!, committed: true, anchored: true, pending: false, ready: false };
  }
  if (owned && event.kind === 'start' && event.frame === state.frame) {
    return { ...state, committed: false, pending: true, ready: false };
  }
  const current = owned && state.anchored && state.committed && !state.pending && event.frame === state.frame && event.loader === state.loader;
  if (current && event.kind === 'reset') return { ...state, ready: false };
  if (current && event.kind === 'dcl') return { ...state, ready: true };
  return state;
}
