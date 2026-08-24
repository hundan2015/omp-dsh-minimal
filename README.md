# omp-dsh-minimal

A minimal-mode extension for [Oh My Pi (omp)](https://omp.sh) that simulates the `dsh` minimal preset from [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

It reduces the system prompt to a single sentence and moves all capability discovery into an always-available `xd` tool. The model can discover everything else on demand through `read xd://` — without bloating the prompt.

## Why

DeepSeek Harness's `dsh` minimal mode uses an extremely short system prompt:

```
You are a helpful software engineer assistant.
```

Long prompts add tokens and can hurt model behavior. This plugin applies the same idea to omp:

- System prompt stays at **46 characters** — exactly the dsh minimal sentence.
- Tool descriptions carry the discovery protocol, so the model still knows how to find capabilities.
- `xd` is injected as an essential tool, so discovery is always available.
- Skills are not injected into the system prompt; they are exposed through `xd://skills`.

## Results / Observations

In our testing, reducing the prompt to the dsh minimal sentence and relying on `xd` discovery gives behavior comparable to DeepSeek's `dsh` minimal mode in omp.

A notable signature we observed in DeepSeek CoT traces is a high frequency of **"we need"** planning phrases — the same style seen in dsh minimal-mode runs. This suggests the minimal prompt preserves the model's natural reasoning behavior while avoiding prompt-induced verbosity.

## Features

- **One-line system prompt**: `You are a helpful software engineer assistant.` (46 chars)
- **`xd` discovery tool** injected directly into the tool list
  - `read xd://` enumerates mounted discoverable devices
  - `read xd://<tool>` reads a device's docs/schema
  - `write xd://<tool>` executes the device
- **Two modes**:
  - `minimal` — full tool surface with one-line descriptions
  - `strict` — allowlist: `bash`, `edit`, `write`, `read`, `xd`
- **Skills via `xd://skills`** — no skills injected into the system prompt
- **Persistent state** — mode survives session restarts
- **Auto-enable on DeepSeek** — if no manual state has been set and the active model is a DeepSeek model, minimal mode is enabled automatically and a TUI notification explains why
- **Pro handoff reads project context** — when `AGENTS.md` or `CLAUDE.md` exists in the project root, the pro handoff includes `Read AGENTS.md in the project root before starting.` (or both files) so the model still loads workspace context after the native system prompt is minimized
- **No runtime dependencies**, no `any`, minimal structural types

## Installation

### Option 1: `omp plugin install`

```bash
omp plugin install github:hundan2015/omp-dsh-minimal
```

### Option 2: Manual copy

Copy `dsh-minimal.ts` into your user extensions directory:

```bash
# Windows
copy dsh-minimal.ts %USERPROFILE%\.omp\agent\extensions\

# macOS / Linux
cp dsh-minimal.ts ~/.omp/agent/extensions/
```

Then restart omp or run `/reload-plugins`.

### Option 3: Clone + config

Clone the repo and add the path to `~/.omp/agent/config.yml`:

```yaml
extensions:
  - /path/to/omp-dsh-minimal
```

## Usage

| Command | Effect |
| --- | --- |
| `/dsh-minimal` | Toggle off ↔ minimal |
| `/dsh-minimal minimal` or `/dsh-minimal on` | Enable minimal mode |
| `/dsh-minimal strict` | Enable strict mode |
| `/dsh-minimal off` | Disable |

### Auto-enable on DeepSeek

If you have never run `/dsh-minimal` in the current session, the plugin checks the active model on each agent start (with a provider-request fallback for side-channel flows). When the model id, provider, or name contains `deepseek`, it automatically enables `minimal` mode and shows a TUI notification like:

```text
dsh-minimal auto-enabled (minimal): detected deepseek-v4-flash, discovery protocol active
```

This is a convenience for DeepSeek users: you can start a session with a DeepSeek model and immediately get the minimal-prompt behavior without typing `/dsh-minimal` first.

Manual state always wins. If you run `/dsh-minimal off`, the plugin records that as your explicit choice and will not auto-enable again until you remove the state or start a fresh session.

Example discovery flow:

```text
read xd://
read xd://<device>
write xd://<device> {"action": "..."}
```

## Files

```text
omp-dsh-minimal/
  dsh-minimal.ts   # single-file omp extension
  package.json     # omp plugin manifest
  README.md
  LICENSE
```

## License

MIT
