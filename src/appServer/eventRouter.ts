export interface AppServerNotification<TParams = unknown> {
  method: string;
  params: TParams;
}

export interface RoutedAppServerEvent<TParams = unknown> extends AppServerNotification<TParams> {
  threadId?: string;
  turnId?: string;
  receivedAt: number;
}

export interface RoutedTurnSubscription {
  readonly threadId: string;
  readonly turnId: string | undefined;
  bindTurn(turnId: string): void;
  dispose(): void;
}

export interface EventRouterOptions {
  maxBufferedEvents?: number;
  now?: () => number;
  onUnscopedEvent?: (event: RoutedAppServerEvent) => void;
}

interface MutableTurnSubscription {
  threadId: string;
  turnId?: string;
  listener: (event: RoutedAppServerEvent) => void;
  disposed: boolean;
}

const DEFAULT_MAX_BUFFERED_EVENTS = 2048;

/**
 * Correlates app-server notifications without assuming turn/start responds
 * before the first turn notification. A provisional subscription is bound by
 * either the first event carrying a turn id or an explicit bindTurn call.
 */
export class AppServerEventRouter {
  private readonly exactSubscriptions = new Map<string, MutableTurnSubscription>();
  private readonly provisionalSubscriptions = new Map<string, MutableTurnSubscription>();
  private readonly bufferedEvents: RoutedAppServerEvent[] = [];
  private readonly closedTurnKeys = new Set<string>();
  private readonly closedTurnOrder: string[] = [];
  private readonly maxBufferedEvents: number;
  private readonly now: () => number;
  private readonly onUnscopedEvent?: EventRouterOptions['onUnscopedEvent'];

  constructor(options: EventRouterOptions = {}) {
    this.maxBufferedEvents = options.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED_EVENTS;
    this.now = options.now ?? Date.now;
    this.onUnscopedEvent = options.onUnscopedEvent;

    if (!Number.isInteger(this.maxBufferedEvents) || this.maxBufferedEvents < 1) {
      throw new Error('Event buffer capacity must be a positive integer.');
    }
  }

  beginTurn(
    threadId: string,
    listener: (event: RoutedAppServerEvent) => void
  ): RoutedTurnSubscription {
    if (this.provisionalSubscriptions.has(threadId)) {
      throw new Error('A provisional turn subscription already exists for this thread.');
    }

    const subscription: MutableTurnSubscription = {
      threadId,
      listener,
      disposed: false
    };
    this.provisionalSubscriptions.set(threadId, subscription);

    const firstBuffered = this.bufferedEvents.find(event =>
      event.threadId === threadId
      && Boolean(event.turnId)
      && !this.isTurnClosed(threadId, event.turnId!)
    );
    if (firstBuffered?.turnId) {
      this.bind(subscription, firstBuffered.turnId);
    }

    return this.publicSubscription(subscription);
  }

  subscribeTurn(
    threadId: string,
    turnId: string,
    listener: (event: RoutedAppServerEvent) => void
  ): RoutedTurnSubscription {
    if (this.isTurnClosed(threadId, turnId)) {
      throw new Error(`Cannot subscribe to closed app-server turn ${turnId}.`);
    }
    const key = turnKey(threadId, turnId);
    if (this.exactSubscriptions.has(key)) {
      throw new Error('A turn subscription already exists for this thread and turn.');
    }

    const subscription: MutableTurnSubscription = {
      threadId,
      turnId,
      listener,
      disposed: false
    };
    this.exactSubscriptions.set(key, subscription);
    this.drain(subscription);
    return this.publicSubscription(subscription);
  }

  route(notification: AppServerNotification): boolean {
    const event = createRoutedEvent(notification, this.now());
    if (!event.threadId) {
      this.onUnscopedEvent?.(event);
      return false;
    }
    if (event.turnId && this.closedTurnKeys.has(turnKey(event.threadId, event.turnId))) {
      return false;
    }

    if (event.turnId) {
      const exact = this.exactSubscriptions.get(turnKey(event.threadId, event.turnId));
      if (exact && !exact.disposed) {
        this.deliver(exact, event);
        return true;
      }

      const provisional = this.provisionalSubscriptions.get(event.threadId);
      if (provisional && !provisional.disposed) {
        this.bind(provisional, event.turnId);
        this.deliver(provisional, event);
        return true;
      }
    }

    if (!event.turnId) {
      const exactMatches = [...this.exactSubscriptions.values()].filter(subscription =>
        !subscription.disposed && subscription.threadId === event.threadId
      );
      if (exactMatches.length === 1) {
        this.deliver(exactMatches[0], event);
        return true;
      }
    }

    const provisional = this.provisionalSubscriptions.get(event.threadId);
    if (provisional && !provisional.disposed) {
      this.deliver(provisional, event);
      return true;
    }

    if (event.method === 'turn/completed' && event.turnId) {
      this.rememberClosedTurn(event.threadId, event.turnId);
      return false;
    }

    this.buffer(event);
    return false;
  }

  isTurnClosed(threadId: string, turnId: string): boolean {
    return this.closedTurnKeys.has(turnKey(threadId, turnId));
  }

  clearThread(threadId: string): void {
    const provisional = this.provisionalSubscriptions.get(threadId);
    if (provisional) {
      this.disposeSubscription(provisional);
    }

    for (const subscription of [...this.exactSubscriptions.values()]) {
      if (subscription.threadId === threadId) {
        this.disposeSubscription(subscription);
      }
    }

    for (let index = this.bufferedEvents.length - 1; index >= 0; index -= 1) {
      if (this.bufferedEvents[index].threadId === threadId) {
        this.bufferedEvents.splice(index, 1);
      }
    }
    for (const key of [...this.closedTurnKeys]) {
      if (key.startsWith(`${threadId}\u0000`)) {
        this.closedTurnKeys.delete(key);
      }
    }
    for (let index = this.closedTurnOrder.length - 1; index >= 0; index -= 1) {
      if (this.closedTurnOrder[index].startsWith(`${threadId}\u0000`)) {
        this.closedTurnOrder.splice(index, 1);
      }
    }
  }

  clearAll(): void {
    for (const subscription of [...this.provisionalSubscriptions.values()]) {
      this.disposeSubscription(subscription);
    }
    for (const subscription of [...this.exactSubscriptions.values()]) {
      this.disposeSubscription(subscription);
    }
    this.bufferedEvents.length = 0;
    this.closedTurnKeys.clear();
    this.closedTurnOrder.length = 0;
  }

  get bufferedEventCount(): number {
    return this.bufferedEvents.length;
  }

  private publicSubscription(subscription: MutableTurnSubscription): RoutedTurnSubscription {
    const router = this;
    return {
      get threadId() {
        return subscription.threadId;
      },
      get turnId() {
        return subscription.turnId;
      },
      bindTurn(turnId: string) {
        router.bind(subscription, turnId);
      },
      dispose() {
        router.disposeSubscription(subscription);
      }
    };
  }

  private bind(subscription: MutableTurnSubscription, turnId: string): void {
    if (subscription.disposed) {
      throw new Error('Cannot bind a disposed turn subscription.');
    }
    if (this.isTurnClosed(subscription.threadId, turnId)) {
      throw new Error(`Cannot bind app-server subscription to closed turn ${turnId}.`);
    }

    if (subscription.turnId && subscription.turnId !== turnId) {
      throw new Error('Turn subscription is already bound to a different turn.');
    }

    if (subscription.turnId === turnId) {
      return;
    }

    const key = turnKey(subscription.threadId, turnId);
    const existing = this.exactSubscriptions.get(key);
    if (existing && existing !== subscription) {
      throw new Error('A turn subscription already exists for this thread and turn.');
    }

    this.provisionalSubscriptions.delete(subscription.threadId);
    subscription.turnId = turnId;
    this.exactSubscriptions.set(key, subscription);
    this.drain(subscription);
  }

  private drain(subscription: MutableTurnSubscription): void {
    if (!subscription.turnId || subscription.disposed) {
      return;
    }

    const events: RoutedAppServerEvent[] = [];
    for (let index = this.bufferedEvents.length - 1; index >= 0; index -= 1) {
      const event = this.bufferedEvents[index];
      if (event.threadId === subscription.threadId && event.turnId === subscription.turnId) {
        events.unshift(event);
        this.bufferedEvents.splice(index, 1);
      }
    }

    for (const event of events) {
      if (subscription.disposed || this.isTurnClosed(subscription.threadId, subscription.turnId)) {
        break;
      }
      this.deliver(subscription, event);
    }
  }

  private buffer(event: RoutedAppServerEvent): void {
    this.bufferedEvents.push(event);
    while (this.bufferedEvents.length > this.maxBufferedEvents) {
      this.bufferedEvents.shift();
    }
  }

  private deliver(subscription: MutableTurnSubscription, event: RoutedAppServerEvent): void {
    if (event.method === 'turn/completed' && event.turnId && event.threadId) {
      this.rememberClosedTurn(event.threadId, event.turnId);
    }
    subscription.listener(event);
  }

  private rememberClosedTurn(threadId: string, turnId: string): void {
    const key = turnKey(threadId, turnId);
    if (this.closedTurnKeys.has(key)) {
      return;
    }
    this.closedTurnKeys.add(key);
    this.closedTurnOrder.push(key);
    while (this.closedTurnOrder.length > this.maxBufferedEvents) {
      const oldest = this.closedTurnOrder.shift();
      if (oldest) {
        this.closedTurnKeys.delete(oldest);
      }
    }
    for (let index = this.bufferedEvents.length - 1; index >= 0; index -= 1) {
      const event = this.bufferedEvents[index];
      if (event.threadId === threadId && event.turnId === turnId) {
        this.bufferedEvents.splice(index, 1);
      }
    }
  }

  private disposeSubscription(subscription: MutableTurnSubscription): void {
    if (subscription.disposed) {
      return;
    }

    subscription.disposed = true;
    if (subscription.turnId) {
      this.exactSubscriptions.delete(turnKey(subscription.threadId, subscription.turnId));
    } else {
      this.provisionalSubscriptions.delete(subscription.threadId);
    }
  }
}

export function extractEventScope(params: unknown): {
  threadId?: string;
  turnId?: string;
} {
  if (!isRecord(params)) {
    return {};
  }

  const threadId = typeof params.threadId === 'string' ? params.threadId : undefined;
  let turnId = typeof params.turnId === 'string' ? params.turnId : undefined;
  if (!turnId && isRecord(params.turn) && typeof params.turn.id === 'string') {
    turnId = params.turn.id;
  }

  return { threadId, turnId };
}

function createRoutedEvent(
  notification: AppServerNotification,
  receivedAt: number
): RoutedAppServerEvent {
  const scope = extractEventScope(notification.params);
  return {
    ...notification,
    ...scope,
    receivedAt
  };
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}\u0000${turnId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
