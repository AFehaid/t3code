import type {
  OrchestrationV2ThreadProjection,
  ServerProvider,
  TurnItemId,
} from "@t3tools/contracts";
import { formatModelSlugName, resolveSelectableModel } from "@t3tools/shared/model";

import { resolveModelShortName } from "../providerClients.ts";

type Projection = OrchestrationV2ThreadProjection;

export interface V2ItemSupport {
  readonly item: Projection["turnItems"][number] | null;
  readonly run: Projection["runs"][number] | null;
  readonly attempts: ReadonlyArray<Projection["attempts"][number]>;
  readonly node: Projection["nodes"][number] | null;
  readonly providerSession: Projection["providerSessions"][number] | null;
  readonly providerThread: Projection["providerThreads"][number] | null;
  readonly providerTurn: Projection["providerTurns"][number] | null;
  readonly runtimeRequest: Projection["runtimeRequests"][number] | null;
  readonly checkpoint: Projection["checkpoints"][number] | null;
  readonly subagent: Projection["subagents"][number] | null;
  readonly contextHandoff: Projection["contextHandoffs"][number] | null;
  readonly contextTransfer: Projection["contextTransfers"][number] | null;
}

export const EMPTY_V2_ITEM_SUPPORT: V2ItemSupport = Object.freeze({
  item: null,
  run: null,
  attempts: Object.freeze([]),
  node: null,
  providerSession: null,
  providerThread: null,
  providerTurn: null,
  runtimeRequest: null,
  checkpoint: null,
  subagent: null,
  contextHandoff: null,
  contextTransfer: null,
});

export function resolveV2ItemSupport(projection: Projection, itemId: TurnItemId): V2ItemSupport {
  const item =
    projection.turnItems.find((candidate) => candidate.id === itemId) ??
    projection.visibleTurnItems.find((candidate) => candidate.sourceItemId === itemId)?.item ??
    null;
  if (item === null) return EMPTY_V2_ITEM_SUPPORT;

  const run =
    item.runId === null
      ? null
      : (projection.runs.find((candidate) => candidate.id === item.runId) ?? null);
  const attempts =
    item.runId === null
      ? EMPTY_V2_ITEM_SUPPORT.attempts
      : projection.attempts.filter((candidate) => candidate.runId === item.runId);
  const node =
    item.nodeId === null
      ? null
      : (projection.nodes.find((candidate) => candidate.id === item.nodeId) ?? null);
  const providerThread =
    item.providerThreadId === null || item.providerThreadId === undefined
      ? null
      : (projection.providerThreads.find((candidate) => candidate.id === item.providerThreadId) ??
        null);
  const providerSession =
    providerThread?.providerSessionId == null
      ? null
      : (projection.providerSessions.find(
          (candidate) => candidate.id === providerThread.providerSessionId,
        ) ?? null);
  const providerTurn =
    item.providerTurnId === null
      ? null
      : (projection.providerTurns.find((candidate) => candidate.id === item.providerTurnId) ??
        null);
  const requestId =
    item.type === "approval_request" || item.type === "user_input_request"
      ? item.requestId
      : node?.runtimeRequestId;
  const runtimeRequest =
    requestId == null
      ? null
      : (projection.runtimeRequests.find((candidate) => candidate.id === requestId) ?? null);
  const checkpoint =
    item.type === "checkpoint"
      ? (projection.checkpoints.find((candidate) => candidate.id === item.checkpointId) ?? null)
      : null;
  const subagent =
    item.type === "subagent"
      ? (projection.subagents.find((candidate) => candidate.id === item.subagentId) ?? null)
      : null;
  const contextHandoff =
    item.type === "handoff"
      ? (projection.contextHandoffs.find((candidate) => candidate.id === item.contextHandoffId) ??
        null)
      : null;
  const contextTransfer =
    contextHandoff?.transferId == null
      ? null
      : (projection.contextTransfers.find(
          (candidate) => candidate.id === contextHandoff.transferId,
        ) ?? null);

  return {
    item,
    run,
    attempts,
    node,
    providerSession,
    providerThread,
    providerTurn,
    runtimeRequest,
    checkpoint,
    subagent,
    contextHandoff,
    contextTransfer,
  };
}

export interface ReportedModelLabel {
  /** Compact, as the model picker's trigger shows it. */
  readonly label: string;
  readonly name: string;
}

/** Labels for a turn whose provider reported running another model than its run selected. */
export function resolveReportedModelLabels(
  support: Pick<V2ItemSupport, "run" | "providerTurn">,
  providers: ReadonlyArray<ServerProvider>,
): { readonly selected: ReportedModelLabel; readonly reported: ReportedModelLabel } | null {
  const reported = support.providerTurn?.model;
  const selection = support.run?.modelSelection;
  if (reported === undefined || selection === undefined) return null;
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  const resolve = (value: string) => {
    const slug =
      (provider ? resolveSelectableModel(provider.driver, value, provider.models) : null) ?? value;
    const model = provider?.models.find((candidate) => candidate.slug === slug);
    const name = model?.name ?? formatModelSlugName(value);
    const label = (model && resolveModelShortName(model, provider?.driver)) ?? name;
    return { slug, display: { label, name } };
  };
  const selected = resolve(selection.model);
  const ran = resolve(reported);
  return selected.slug === ran.slug ? null : { selected: selected.display, reported: ran.display };
}

function sameEntities<A>(left: ReadonlyArray<A>, right: ReadonlyArray<A>): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function v2ItemSupportEqual(left: V2ItemSupport, right: V2ItemSupport): boolean {
  return (
    left.item === right.item &&
    left.run === right.run &&
    sameEntities(left.attempts, right.attempts) &&
    left.node === right.node &&
    left.providerSession === right.providerSession &&
    left.providerThread === right.providerThread &&
    left.providerTurn === right.providerTurn &&
    left.runtimeRequest === right.runtimeRequest &&
    left.checkpoint === right.checkpoint &&
    left.subagent === right.subagent &&
    left.contextHandoff === right.contextHandoff &&
    left.contextTransfer === right.contextTransfer
  );
}
