import * as vscode from 'vscode';
import { CodexAccountUsageStatusBar } from './accountUsageStatusBar';
import { CodexAppServerBackend } from './appServer/codexBackend';
import {
  CODEX_INSTALL_COMMAND,
  createRuntimeDiagnostic,
  isCodexCliVersionNewerThanValidated,
  LATEST_VALIDATED_CODEX_CLI_VERSION,
  MINIMUM_CODEX_CLI_VERSION
} from './appServer/runtime';
import { getProviderConfig } from './config';
import { VsCodexProvider } from './provider';
import { VsCodeIntegrationAdvisor } from './vsCodeIntegration';

const CODEX_INSTALL_DOCS = vscode.Uri.parse('https://developers.openai.com/codex/cli');

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel('vsCodex', { log: true });
  await vscode.workspace.fs.createDirectory(context.globalStorageUri);

  const backend = new CodexAppServerBackend(context, outputChannel);
  const accountUsageStatusBar = new CodexAccountUsageStatusBar(outputChannel, backend);
  const integrationAdvisor = new VsCodeIntegrationAdvisor(outputChannel);
  const provider = new VsCodexProvider(
    outputChannel,
    backend,
    accountUsageStatusBar,
    integrationAdvisor
  );
  let activeLoginId: string | undefined;

  const signIn = async (kind: 'browser' | 'deviceCode'): Promise<void> => {
    if (activeLoginId) {
      await vscode.window.showInformationMessage('A ChatGPT sign-in is already in progress.');
      return;
    }

    let challenge: Awaited<ReturnType<CodexAppServerBackend['beginLogin']>> | undefined;
    try {
      challenge = await backend.beginLogin(kind);
      const loginChallenge = challenge;
      activeLoginId = loginChallenge.loginId;
      if (loginChallenge.kind === 'browser') {
        await vscode.env.openExternal(vscode.Uri.parse(loginChallenge.authUrl));
      } else {
        const action = await vscode.window.showInformationMessage(
          `Enter device code ${loginChallenge.userCode} to sign in to ChatGPT.`,
          'Copy Code and Open',
          'Open Verification Page',
          'Cancel'
        );
        if (action === 'Cancel' || !action) {
          await backend.cancelLogin(challenge.loginId);
          return;
        }
        if (action === 'Copy Code and Open') {
          await vscode.env.clipboard.writeText(loginChallenge.userCode);
        }
        await vscode.env.openExternal(vscode.Uri.parse(loginChallenge.verificationUrl));
      }

      const account = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: loginChallenge.kind === 'browser'
          ? 'Waiting for ChatGPT browser sign-in…'
          : 'Waiting for ChatGPT device-code sign-in…',
        cancellable: true
      }, async (_progress, cancellationToken) => {
        const cancellation = cancellationToken.onCancellationRequested(() => {
          void backend.cancelLogin(loginChallenge.loginId).catch(() => undefined);
        });
        try {
          return await loginChallenge.completion;
        } finally {
          cancellation.dispose();
        }
      });
      await vscode.window.showInformationMessage(`Signed in to ChatGPT (${account.planType}).`);
      await accountUsageStatusBar.refresh();
    } catch (error) {
      if (error instanceof vscode.CancellationError
        || (error instanceof Error && error.name === 'LoginCancelledError')) {
        await vscode.window.showInformationMessage('ChatGPT sign-in was cancelled.');
      } else {
        await vscode.window.showErrorMessage(error instanceof Error ? error.message : 'ChatGPT sign-in failed.');
      }
    } finally {
      if (challenge && activeLoginId === challenge.loginId) {
        activeLoginId = undefined;
      }
    }
  };

  const checkRuntime = async (): Promise<void> => {
    try {
      await backend.ensureReady();
      const runtimeVersion = backend.runtimeVersion ?? MINIMUM_CODEX_CLI_VERSION;
      await vscode.window.showInformationMessage(
        `Codex app-server is ready (codex-cli ${runtimeVersion}).`
      );
      if (isCodexCliVersionNewerThanValidated(runtimeVersion)) {
        await vscode.window.showWarningMessage(
          `Codex CLI ${runtimeVersion} is newer than ${LATEST_VALIDATED_CODEX_CLI_VERSION}, the latest version validated for this vsCodex release. Compatibility will be checked as features are used.`
        );
      }
    } catch (error) {
      const diagnostic = createRuntimeDiagnostic(error, vscode.env.remoteName);
      const action = await vscode.window.showErrorMessage(
        diagnostic.detail,
        'Open Installation Documentation',
        'Copy Install Command',
        'Configure Executable',
        'Retry'
      );
      if (action === 'Open Installation Documentation') {
        await vscode.env.openExternal(CODEX_INSTALL_DOCS);
      } else if (action === 'Copy Install Command') {
        await vscode.env.clipboard.writeText(CODEX_INSTALL_COMMAND);
        await vscode.window.showInformationMessage('Codex installation command copied.');
      } else if (action === 'Configure Executable') {
        await vscode.commands.executeCommand('vsCodex.configureExecutable');
      } else if (action === 'Retry') {
        await vscode.commands.executeCommand('vsCodex.checkRuntime');
      }
    }
  };

  context.subscriptions.push(
    outputChannel,
    backend,
    accountUsageStatusBar,
    provider,
    vscode.lm.registerLanguageModelChatProvider('vscodex', provider),
    vscode.commands.registerCommand('vsCodex.openDebugLogs', () => {
      outputChannel.show(true);
    }),
    vscode.commands.registerCommand('vsCodex.openSettings', () => {
      return vscode.commands.executeCommand('workbench.action.openSettings', 'vsCodex');
    }),
    vscode.commands.registerCommand(
      'vsCodex.signInWithChatGPT',
      () => signIn(vscode.env.remoteName ? 'deviceCode' : 'browser')
    ),
    vscode.commands.registerCommand('vsCodex.signInWithDeviceCode', () => signIn('deviceCode')),
    vscode.commands.registerCommand('vsCodex.cancelSignIn', async () => {
      if (!activeLoginId) {
        await vscode.window.showInformationMessage('No ChatGPT sign-in is in progress.');
        return;
      }
      await backend.cancelLogin(activeLoginId);
      activeLoginId = undefined;
    }),
    vscode.commands.registerCommand('vsCodex.showAccountStatus', async () => {
      try {
        const account = await backend.readAccount(false);
        await vscode.window.showInformationMessage(account
          ? `Codex is signed in with ChatGPT (${account.planType}).`
          : 'Codex is not signed in with ChatGPT.');
      } catch (error) {
        await vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Could not read Codex account status.');
      }
    }),
    vscode.commands.registerCommand('vsCodex.signOut', async () => {
      const confirmation = await vscode.window.showWarningMessage(
        'Signing out removes the shared ChatGPT login used by Codex CLI and other Codex clients on this host.',
        { modal: true },
        'Sign Out of Codex'
      );
      if (confirmation !== 'Sign Out of Codex') {
        return;
      }
      await backend.logout();
      accountUsageStatusBar.clear();
      await vscode.window.showInformationMessage('Signed out of the shared Codex ChatGPT account.');
    }),
    vscode.commands.registerCommand('vsCodex.checkRuntime', checkRuntime),
    vscode.commands.registerCommand(
      'vsCodex.configureUtilityModels',
      () => integrationAdvisor.configureUtilityModels()
    ),
    vscode.commands.registerCommand(
      'vsCodex.configureReasoningEffort',
      () => integrationAdvisor.configureReasoningEffort(backend)
    ),
    vscode.commands.registerCommand(
      'vsCodex.showIntegrationDiagnostics',
      () => integrationAdvisor.showDiagnostics(backend)
    ),
    vscode.commands.registerCommand('vsCodex.configureExecutable', async () => {
      const configured = await vscode.window.showInputBox({
        title: 'Configure Codex Executable',
        prompt: `Enter a Codex CLI ${MINIMUM_CODEX_CLI_VERSION} or newer executable or launcher on this extension host.`,
        value: getProviderConfig().appServerCommand,
        ignoreFocusOut: true
      });
      if (!configured?.trim()) {
        return;
      }
      await vscode.workspace.getConfiguration('vsCodex').update(
        'appServer.command',
        configured.trim(),
        vscode.ConfigurationTarget.Global
      );
      await vscode.window.showInformationMessage('Codex executable updated. Run “Codex: Check App-server Runtime” to validate it.');
    }),
    vscode.commands.registerCommand('vsCodex.refreshAccountLimits', async () => {
      await accountUsageStatusBar.refresh();
      await accountUsageStatusBar.showDetails();
    }),
    vscode.commands.registerCommand('vsCodex.manage', async () => {
      const actions = new Map<string, string>([
        ['Sign in with ChatGPT', 'vsCodex.signInWithChatGPT'],
        ['Sign in with Device Code', 'vsCodex.signInWithDeviceCode'],
        ['Cancel Sign-in', 'vsCodex.cancelSignIn'],
        ['Show Account Status', 'vsCodex.showAccountStatus'],
        ['Sign Out of Codex', 'vsCodex.signOut'],
        ['Check App-server Runtime', 'vsCodex.checkRuntime'],
        ['Configure Reasoning Effort', 'vsCodex.configureReasoningEffort'],
        ['Configure VS Code Utility Models', 'vsCodex.configureUtilityModels'],
        ['Show Integration Diagnostics', 'vsCodex.showIntegrationDiagnostics'],
        ['Configure Codex Executable', 'vsCodex.configureExecutable'],
        ['Refresh Account Limits', 'vsCodex.refreshAccountLimits'],
        ['Open Debug Logs', 'vsCodex.openDebugLogs'],
        ['Open Settings', 'vsCodex.openSettings']
      ]);
      const action = await vscode.window.showQuickPick([...actions.keys()], { title: 'vsCodex' });
      const command = action ? actions.get(action) : undefined;
      if (command) {
        await vscode.commands.executeCommand(command);
      }
    })
  );

}

export function deactivate(): void {}
