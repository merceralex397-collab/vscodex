import * as vscode from 'vscode';
import type {
  AccountTokenActivitySnapshot,
  CodexAccountUsageSnapshot as BackendUsageSnapshot,
  EventLike,
  TokenCount
} from './appServer/types';
import { buildCodexAccountUsageDisplay, type CodexAccountUsageSnapshot } from './accountUsage';
import { getProviderConfig } from './config';

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export interface AccountUsageSource {
  readonly onDidUpdateRateLimits: EventLike<BackendUsageSnapshot>;
  readonly onDidChangeAccount?: EventLike<void>;
  readRateLimits(): Promise<BackendUsageSnapshot>;
  readTokenActivity?(): Promise<AccountTokenActivitySnapshot>;
}

export class CodexAccountUsageStatusBar implements vscode.Disposable {
  private readonly statusBarItem: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[];
  private readonly refreshTimer: ReturnType<typeof setInterval>;
  private lastSnapshot?: CodexAccountUsageSnapshot;
  private refreshInFlight?: Promise<void>;
  private selectedModel = getProviderConfig().model;

  constructor(
    private readonly outputChannel: vscode.LogOutputChannel,
    private readonly usageSource: AccountUsageSource
  ) {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
    this.statusBarItem.name = 'Codex Account Limits';
    this.statusBarItem.command = 'vsCodex.refreshAccountLimits';
    this.statusBarItem.hide();

    this.refreshTimer = setInterval(() => {
      if (this.lastSnapshot) {
        void this.refresh();
      }
    }, REFRESH_INTERVAL_MS);

    const rateLimitSubscription = this.usageSource.onDidUpdateRateLimits((snapshot) => {
      this.acceptSnapshot(snapshot);
    });
    const accountSubscription = this.usageSource.onDidChangeAccount?.(() => {
      this.clear();
    });
    this.disposables = [
      this.statusBarItem,
      rateLimitSubscription,
      ...(accountSubscription ? [accountSubscription] : []),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('vsCodex.model')) {
          this.selectedModel = getProviderConfig().model;
          if (this.lastSnapshot) {
            this.render(this.lastSnapshot);
          }
        }
      })
    ];

  }

  setSelectedModel(model: string): void {
    if (!model.trim() || model === this.selectedModel) {
      return;
    }

    this.selectedModel = model;
    if (this.lastSnapshot) {
      this.render(this.lastSnapshot);
    }
  }

  clear(): void {
    this.lastSnapshot = undefined;
    this.statusBarItem.hide();
  }

  async refresh(): Promise<void> {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

    this.refreshInFlight = this.refreshNow().finally(() => {
      this.refreshInFlight = undefined;
    });
    return this.refreshInFlight;
  }

  async showDetails(): Promise<void> {
    if (!this.lastSnapshot) {
      await this.refresh();
    }

    if (!this.lastSnapshot) {
      await vscode.window.showInformationMessage('No Codex account limits are available for the signed-in ChatGPT account.');
      return;
    }

    const display = buildCodexAccountUsageDisplay(this.lastSnapshot, this.selectedModel);
    let activity: AccountTokenActivitySnapshot | undefined;
    try {
      activity = await this.usageSource.readTokenActivity?.();
    } catch (error) {
      this.outputChannel.debug('account token-activity refresh failed', {
        status: error instanceof Error ? error.name : 'unknown'
      });
    }
    const activitySummary = activity ? formatTokenActivity(activity) : undefined;
    await vscode.window.showInformationMessage([
      display.tooltip.replace(/\n/g, ' | '),
      activitySummary
    ].filter(Boolean).join(' | '));
  }

  dispose(): void {
    clearInterval(this.refreshTimer);
    vscode.Disposable.from(...this.disposables).dispose();
  }

  private async refreshNow(): Promise<void> {
    try {
      this.acceptSnapshot(await this.usageSource.readRateLimits());
    } catch (error) {
      this.outputChannel.warn('account rate-limit refresh failed', {
        status: error instanceof Error ? error.name : 'unknown'
      });
      if (this.lastSnapshot) {
        this.render(this.lastSnapshot);
      } else {
        this.statusBarItem.hide();
      }
    }
  }

  private acceptSnapshot(snapshot: BackendUsageSnapshot): void {
    this.lastSnapshot = {
      fetchedAt: snapshot.fetchedAt,
      planType: snapshot.planType,
      creditsBalance: snapshot.creditsBalance,
      limits: snapshot.limits.map((limit) => ({ ...limit }))
    };
    this.render(this.lastSnapshot);
  }

  private render(snapshot: CodexAccountUsageSnapshot): void {
    const display = buildCodexAccountUsageDisplay(snapshot, this.selectedModel);
    if (!display.compactText) {
      this.statusBarItem.hide();
      return;
    }

    this.statusBarItem.text = display.compactText;
    this.statusBarItem.tooltip = display.tooltip;
    this.statusBarItem.show();
  }
}

function formatTokenActivity(activity: AccountTokenActivitySnapshot): string {
  const values = [
    activity.lifetimeTokens === undefined
      ? undefined
      : `Lifetime tokens: ${formatTokenCount(activity.lifetimeTokens)}`,
    activity.peakDailyTokens === undefined
      ? undefined
      : `Peak daily tokens: ${formatTokenCount(activity.peakDailyTokens)}`,
    activity.currentStreakDays === undefined
      ? undefined
      : `Current streak: ${formatTokenCount(activity.currentStreakDays)} days`
  ].filter((value): value is string => Boolean(value));
  return values.join(' | ');
}

function formatTokenCount(value: TokenCount): string {
  return typeof value === 'bigint'
    ? value.toLocaleString('en-US')
    : Math.floor(value).toLocaleString('en-US');
}
