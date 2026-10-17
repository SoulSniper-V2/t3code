# Hoplite

Hoplite runs agents in managed cloud workspaces. Adding it as a provider lets you use those agents and import existing Hoplite conversations into T3 Code. Your local project directory is not synchronized to the cloud workspace; local terminals, Git changes, and filesystem checkpoints are separate.

## Connect an account

Open **Settings → Providers**, add Hoplite, and enable it. Choose **Hoplite API key** or **Sign in with Hoplite**. Credentials stay in the environment's secret store, not in provider settings or the browser's local storage.

Browser sign-in uses OAuth2 with PKCE. After authorizing, copy the complete localhost callback URL from the browser address bar into T3 Code. The localhost page does not need to load. This also works when the T3 server runs on a different machine. Refresh tokens renew the connection; signing out removes the stored credentials.

Set the Hoplite project used for new threads. Models come from the account's live catalog. Reasoning, speed, and the optional thread budget apply when a cloud thread is created; the REST API does not change reasoning or speed on follow-up messages. Select a separate provider for T3's local title, branch-name, and Git text generation.

## Existing cloud threads and workspace management

Open the Hoplite workspace section in the provider editor to browse remote projects and threads. Choose a local T3 project as the destination before importing a conversation. Import reads the remote transcript without starting a run, and importing the same remote thread again does not duplicate it. Very large imports fail explicitly rather than silently truncating history.

Workspace actions use your Hoplite account's permissions. A missing permission does not mean you need to sign in again. Environment-variable values cannot be read back. Destructive changes and checkpoint restores require confirmation.

Cloud previews expose their status and can be started, but an authenticated preview is not embedded in T3. Cloud tool approvals are not advertised through the REST provider; structured questions are supported. T3 does not expose automatic PR merging through this integration.
