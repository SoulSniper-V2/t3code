# Hoplite

[Hoplite](https://hoplite.sh) runs coding agents in cloud sandboxes. A Hoplite thread in T3 Code
works on the GitHub repository behind your project, in its own Hoplite workspace, and can open a
pull request. Nothing runs on your machine, and the thread is also visible in the Hoplite app.

## Set Up Hoplite

1. Install the Hoplite CLI on the machine running the T3 Code server, version 3.5.1 or newer:

   ```sh
   npm install -g @usehoplite/cli
   ```

   Homebrew (`brew install usehoplite/tap/hoplite`) and Hoplite's install script work too. The
   agent runs on macOS and Linux.

2. Open **Settings → Providers**, add Hoplite, and choose how to connect under **Account**:
   - **Sign in with Hoplite** shows a code and opens Hoplite's approval page. Approve it in any
     browser and choose the workspace. This uses the Hoplite CLI's sign-in, so the `hoplite`
     command in your terminal is signed in too, and it needs a system keychain on the server.
   - **Use an API key** accepts a key from Hoplite's **Settings → Workspace → API keys**. A
     service-account key needs **Projects: Read** and **Threads: Write**.

3. In Hoplite, connect the GitHub repository and create a project for it.

T3 Code stores the key for each Hoplite instance separately. Signing out of T3 Code does not sign
out the Hoplite CLI in your terminal; use `hoplite logout` for that.

## Projects

Each thread runs in the Hoplite project linked to its repository's GitHub remote, preferring
`origin`. If several Hoplite projects link the same repository, or the folder has no GitHub
remote, set **Hoplite project** in the provider settings to a project ID such as `proj_…`.

Hoplite works from the repository on GitHub, not your local checkout. Push changes the agent
should see, and review its work in the pull request it opens or in the Hoplite app.

## Models and Permissions

The model picker lists the models your Hoplite plan offers, with the project's default marked.
Reasoning and Fast speed appear for models that support them.

Hoplite threads run **Supervised**. Your Hoplite project's tool permissions decide what needs
approval, and those requests appear in T3 Code like any other approval.

Hoplite threads cannot roll back to an earlier turn from T3 Code, since the workspace lives in
Hoplite's cloud. Hoplite does not generate thread titles or commit messages; T3 Code uses your
other providers for those.

## Troubleshooting

- **Out of credits**: Hoplite runs use workspace credits. Add credits in Hoplite's billing
  settings, then send the message again.
- **No Hoplite project is linked**: create a project for the repository in Hoplite, or set the
  **Hoplite project** setting.
- **Sign-in needs a keychain**: on a headless server without a system keychain, use an API key.
