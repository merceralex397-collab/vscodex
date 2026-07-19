import { createHash, randomUUID } from 'node:crypto';

export const DEFAULT_MAX_CONVERSATION_BRANCHES = 64;
export const DEFAULT_CONVERSATION_BRANCH_TTL_MS = 10 * 60 * 1000;

export interface ConversationToolEnvelope {
  originalName: string;
  alias: string;
  description: string;
  inputSchema: unknown;
}

export interface ConversationEnvelope {
  processGeneration: number;
  accountGeneration: number;
  appServerVersion: string;
  passivePolicyVersion: string;
  model: string;
  requestedMode?: string;
  backendEffort?: string;
  orchestrationMode: string;
  serviceTier?: string;
  baseInstructions: string;
  developerInstructions: string;
  toolMode: string;
  tools: readonly ConversationToolEnvelope[];
}

export interface ConversationCheckpoint {
  projectedHistoryLength: number;
  historyHash: string;
  turnId: string;
}

export interface ActiveConversationTurn {
  turnId: string;
  visibleOutput: boolean;
}

export interface PendingConversationTool {
  callId: string;
  turnId: string;
}

export interface ConversationBranch<TItem = unknown> {
  id: string;
  envelope: ConversationEnvelope;
  envelopeHash: string;
  projectedHistory: TItem[];
  threadId: string;
  checkpoints: ConversationCheckpoint[];
  activeTurn?: ActiveConversationTurn;
  pendingTools: PendingConversationTool[];
  processGeneration: number;
  accountGeneration: number;
  lastUsedAt: number;
}

export type ConversationBranchEvictionReason =
  | 'expired'
  | 'overflow'
  | 'processChanged'
  | 'accountChanged'
  | 'invalidated'
  | 'disposed';

export type ConversationReusePlan<TItem = unknown> =
  | {
      kind: 'continue';
      branch: ConversationBranch<TItem>;
      appendedHistory: TItem[];
    }
  | {
      kind: 'fork';
      branch: ConversationBranch<TItem>;
      checkpoint: ConversationCheckpoint;
      appendedHistory: TItem[];
    }
  | {
      kind: 'cold';
      projectedHistory: TItem[];
      reason: 'noBranch' | 'envelopeChanged' | 'historyDiverged' | 'generationChanged';
    };

export interface ConversationThreadStoreOptions<TItem> {
  maxBranches?: number;
  ttlMs?: number;
  now?: () => number;
  itemIdentity?: (item: TItem) => string;
  onEvict?: (branch: ConversationBranch<TItem>, reason: ConversationBranchEvictionReason) => void;
}

export interface RegisterConversationBranch<TItem> {
  envelope: ConversationEnvelope;
  projectedHistory: readonly TItem[];
  threadId: string;
  checkpoints?: readonly ConversationCheckpoint[];
}

/**
 * Tracks ephemeral app-server threads without owning any RPC operations.
 * Consumers execute the returned continuation/fork/cold plan and then record
 * the resulting branch or checkpoint.
 */
export class ConversationThreadStore<TItem = unknown> {
  private readonly branches = new Map<string, ConversationBranch<TItem>>();
  private readonly maxBranches: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly itemIdentity: (item: TItem) => string;
  private readonly onEvict?: ConversationThreadStoreOptions<TItem>['onEvict'];

  constructor(options: ConversationThreadStoreOptions<TItem> = {}) {
    this.maxBranches = options.maxBranches ?? DEFAULT_MAX_CONVERSATION_BRANCHES;
    this.ttlMs = options.ttlMs ?? DEFAULT_CONVERSATION_BRANCH_TTL_MS;
    this.now = options.now ?? Date.now;
    this.itemIdentity = options.itemIdentity ?? ((item) => stableSerialize(item));
    this.onEvict = options.onEvict;

    if (!Number.isInteger(this.maxBranches) || this.maxBranches < 1) {
      throw new Error('Conversation branch capacity must be a positive integer.');
    }

    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) {
      throw new Error('Conversation branch TTL must be positive.');
    }
  }

  get size(): number {
    this.evictExpired();
    return this.branches.size;
  }

  register(input: RegisterConversationBranch<TItem>): ConversationBranch<TItem> {
    this.evictExpired();
    const now = this.now();
    const branch: ConversationBranch<TItem> = {
      id: randomUUID(),
      envelope: cloneEnvelope(input.envelope),
      envelopeHash: hashConversationEnvelope(input.envelope),
      projectedHistory: [...input.projectedHistory],
      threadId: input.threadId,
      checkpoints: normalizeCheckpoints(input.checkpoints ?? [], input.projectedHistory, this.itemIdentity),
      pendingTools: [],
      processGeneration: input.envelope.processGeneration,
      accountGeneration: input.envelope.accountGeneration,
      lastUsedAt: now
    };

    this.branches.set(branch.id, branch);
    this.evictOverflow();
    return branch;
  }

  get(branchId: string): ConversationBranch<TItem> | undefined {
    this.evictExpired();
    const branch = this.branches.get(branchId);
    if (branch) {
      branch.lastUsedAt = this.now();
    }
    return branch;
  }

  findByActiveTurn(threadId: string, turnId: string): ConversationBranch<TItem> | undefined {
    this.evictExpired();
    return [...this.branches.values()].find((branch) =>
      branch.threadId === threadId && branch.activeTurn?.turnId === turnId);
  }

  plan(envelope: ConversationEnvelope, projectedHistory: readonly TItem[]): ConversationReusePlan<TItem> {
    this.evictExpired();
    const envelopeHash = hashConversationEnvelope(envelope);
    const candidates = [...this.branches.values()]
      .filter((branch) => branch.envelopeHash === envelopeHash)
      .sort((left, right) => right.lastUsedAt - left.lastUsedAt);

    if (candidates.length === 0) {
      const hasDifferentGeneration = [...this.branches.values()].some((branch) =>
        branch.envelope.model === envelope.model
        && (branch.processGeneration !== envelope.processGeneration
          || branch.accountGeneration !== envelope.accountGeneration));

      return {
        kind: 'cold',
        projectedHistory: [...projectedHistory],
        reason: hasDifferentGeneration
          ? 'generationChanged'
          : this.branches.size > 0
            ? 'envelopeChanged'
            : 'noBranch'
      };
    }

    let bestContinuation: {
      branch: ConversationBranch<TItem>;
      prefixLength: number;
    } | undefined;
    let bestFork: {
      branch: ConversationBranch<TItem>;
      checkpoint: ConversationCheckpoint;
    } | undefined;

    for (const branch of candidates) {
      const matchingPrefixLength = countMatchingPrefix(
        branch.projectedHistory,
        projectedHistory,
        this.itemIdentity
      );

      if (matchingPrefixLength === branch.projectedHistory.length
        && branch.projectedHistory.length <= projectedHistory.length) {
        if (!bestContinuation || branch.projectedHistory.length > bestContinuation.prefixLength) {
          bestContinuation = {
            branch,
            prefixLength: branch.projectedHistory.length
          };
        }
        continue;
      }

      const checkpoint = findForkCheckpoint(
        branch,
        projectedHistory,
        matchingPrefixLength,
        this.itemIdentity
      );
      if (checkpoint && (!bestFork
        || checkpoint.projectedHistoryLength > bestFork.checkpoint.projectedHistoryLength)) {
        bestFork = { branch, checkpoint };
      }
    }

    if (bestContinuation) {
      bestContinuation.branch.lastUsedAt = this.now();
      return {
        kind: 'continue',
        branch: bestContinuation.branch,
        appendedHistory: projectedHistory.slice(bestContinuation.prefixLength)
      };
    }

    if (bestFork) {
      bestFork.branch.lastUsedAt = this.now();
      return {
        kind: 'fork',
        branch: bestFork.branch,
        checkpoint: bestFork.checkpoint,
        appendedHistory: projectedHistory.slice(bestFork.checkpoint.projectedHistoryLength)
      };
    }

    return {
      kind: 'cold',
      projectedHistory: [...projectedHistory],
      reason: 'historyDiverged'
    };
  }

  recordCheckpoint(
    branchId: string,
    projectedHistory: readonly TItem[],
    turnId: string
  ): ConversationCheckpoint {
    const branch = this.requireBranch(branchId);
    const checkpoint: ConversationCheckpoint = {
      projectedHistoryLength: projectedHistory.length,
      historyHash: hashHistory(projectedHistory, this.itemIdentity),
      turnId
    };

    branch.projectedHistory = [...projectedHistory];
    branch.checkpoints = [
      ...branch.checkpoints.filter((entry) => entry.projectedHistoryLength !== checkpoint.projectedHistoryLength),
      checkpoint
    ].sort((left, right) => left.projectedHistoryLength - right.projectedHistoryLength);
    branch.activeTurn = undefined;
    branch.lastUsedAt = this.now();
    return checkpoint;
  }

  updateProjectedHistory(branchId: string, projectedHistory: readonly TItem[]): void {
    const branch = this.requireBranch(branchId);
    branch.projectedHistory = [...projectedHistory];
    branch.checkpoints = branch.checkpoints.filter((checkpoint) =>
      checkpoint.projectedHistoryLength <= projectedHistory.length
      && checkpoint.historyHash === hashHistory(
        projectedHistory.slice(0, checkpoint.projectedHistoryLength),
        this.itemIdentity
      ));
    branch.lastUsedAt = this.now();
  }

  setActiveTurn(branchId: string, activeTurn: ActiveConversationTurn | undefined): void {
    const branch = this.requireBranch(branchId);
    branch.activeTurn = activeTurn ? { ...activeTurn } : undefined;
    branch.lastUsedAt = this.now();
  }

  setPendingTools(branchId: string, pendingTools: readonly PendingConversationTool[]): void {
    const branch = this.requireBranch(branchId);
    branch.pendingTools = pendingTools.map((tool) => ({ ...tool }));
    branch.lastUsedAt = this.now();
  }

  remove(branchId: string, reason: ConversationBranchEvictionReason = 'invalidated'): void {
    const branch = this.branches.get(branchId);
    if (!branch) {
      return;
    }

    this.branches.delete(branchId);
    this.onEvict?.(branch, reason);
  }

  invalidateProcessGeneration(processGeneration: number): void {
    for (const branch of [...this.branches.values()]) {
      if (branch.processGeneration !== processGeneration) {
        this.remove(branch.id, 'processChanged');
      }
    }
  }

  invalidateAccountGeneration(accountGeneration: number): void {
    for (const branch of [...this.branches.values()]) {
      if (branch.accountGeneration !== accountGeneration) {
        this.remove(branch.id, 'accountChanged');
      }
    }
  }

  invalidateAll(reason: ConversationBranchEvictionReason = 'invalidated'): void {
    for (const branch of [...this.branches.values()]) {
      this.remove(branch.id, reason);
    }
  }

  dispose(): void {
    this.invalidateAll('disposed');
  }

  private requireBranch(branchId: string): ConversationBranch<TItem> {
    this.evictExpired();
    const branch = this.branches.get(branchId);
    if (!branch) {
      throw new Error('Conversation branch is unavailable or expired.');
    }
    return branch;
  }

  private evictExpired(): void {
    const now = this.now();
    for (const branch of [...this.branches.values()]) {
      const isInUse = branch.activeTurn !== undefined || branch.pendingTools.length > 0;
      if (!isInUse && now - branch.lastUsedAt >= this.ttlMs) {
        this.remove(branch.id, 'expired');
      }
    }
  }

  private evictOverflow(): void {
    const oldestFirst = [...this.branches.values()]
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    while (this.branches.size > this.maxBranches) {
      const oldest = oldestFirst.shift();
      if (!oldest) {
        return;
      }
      this.remove(oldest.id, 'overflow');
    }
  }
}

export function hashConversationEnvelope(envelope: ConversationEnvelope): string {
  const normalized = {
    processGeneration: envelope.processGeneration,
    accountGeneration: envelope.accountGeneration,
    appServerVersion: envelope.appServerVersion,
    passivePolicyVersion: envelope.passivePolicyVersion,
    model: envelope.model,
    requestedMode: envelope.requestedMode ?? null,
    backendEffort: envelope.backendEffort ?? null,
    orchestrationMode: envelope.orchestrationMode,
    serviceTier: envelope.serviceTier ?? null,
    baseInstructions: envelope.baseInstructions,
    developerInstructions: envelope.developerInstructions,
    toolMode: envelope.toolMode,
    tools: [...envelope.tools]
      .map((tool) => ({
        originalName: tool.originalName,
        alias: tool.alias,
        description: tool.description,
        inputSchema: tool.inputSchema
      }))
      .sort((left, right) => left.alias.localeCompare(right.alias))
  };
  return sha256(stableSerialize(normalized));
}

export function hashHistory<TItem>(
  history: readonly TItem[],
  itemIdentity: (item: TItem) => string = (item) => stableSerialize(item)
): string {
  const hasher = createHash('sha256');
  for (const item of history) {
    const identity = itemIdentity(item);
    hasher.update(String(identity.length));
    hasher.update(':');
    hasher.update(identity);
    hasher.update(';');
  }
  return hasher.digest('hex');
}

export function stableSerialize(value: unknown): string {
  return JSON.stringify(sortForStableSerialization(value));
}

function findForkCheckpoint<TItem>(
  branch: ConversationBranch<TItem>,
  projectedHistory: readonly TItem[],
  matchingPrefixLength: number,
  itemIdentity: (item: TItem) => string
): ConversationCheckpoint | undefined {
  return [...branch.checkpoints]
    .sort((left, right) => right.projectedHistoryLength - left.projectedHistoryLength)
    .find((checkpoint) => checkpoint.projectedHistoryLength === matchingPrefixLength
      && checkpoint.projectedHistoryLength <= projectedHistory.length
      && checkpoint.historyHash === hashHistory(
        projectedHistory.slice(0, checkpoint.projectedHistoryLength),
        itemIdentity
      ));
}

function countMatchingPrefix<TItem>(
  left: readonly TItem[],
  right: readonly TItem[],
  itemIdentity: (item: TItem) => string
): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (itemIdentity(left[index]) !== itemIdentity(right[index])) {
      return index;
    }
  }
  return length;
}

function normalizeCheckpoints<TItem>(
  checkpoints: readonly ConversationCheckpoint[],
  projectedHistory: readonly TItem[],
  itemIdentity: (item: TItem) => string
): ConversationCheckpoint[] {
  return checkpoints
    .filter((checkpoint) => checkpoint.projectedHistoryLength >= 0
      && checkpoint.projectedHistoryLength <= projectedHistory.length)
    .filter((checkpoint) => checkpoint.historyHash === hashHistory(
      projectedHistory.slice(0, checkpoint.projectedHistoryLength),
      itemIdentity
    ))
    .map((checkpoint) => ({ ...checkpoint }))
    .sort((left, right) => left.projectedHistoryLength - right.projectedHistoryLength);
}

function cloneEnvelope(envelope: ConversationEnvelope): ConversationEnvelope {
  return {
    ...envelope,
    tools: envelope.tools.map((tool) => ({ ...tool }))
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sortForStableSerialization(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortForStableSerialization(entry));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [key, sortForStableSerialization(entryValue)]));
  }

  return value;
}
