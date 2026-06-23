# omp-cmd

**omp** plugin that adds [Command Code](https://commandcode.ai) as a model provider. I aim for this to be a better maintained and simpler version of [patlux's repo](https://github.com/patlux/pi-commandcode-provider) that strips all the things I personally don't need. This plugin is entirely vibes based tho so do be advised.

# Warning

The founder of CommandCode warned that they're gonna ban people for using reverse engineered APIs such as this one in an [issue opened on patlux's repo](https://github.com/patlux/pi-commandcode-provider/issues/5) it seems so far they haven't spent many resources on detecting this but do be aware use this at your own risk. If you have the $15 plan you can use their provider API instead (as mentioned in the issue linked above).

## Installation

```bash
# From a local clone
git clone https://github.com/bl4zee1g/omp-cmd.git
omp plugin link ./omp-cmd
```

## Uninstall

```bash
omp plugin unlink omp-commandcode
```

Delete the directory:
```bash
rm -rf ./omp-cmd
```

To fully clean up credentials:
```bash
rm ~/.omp/agent/auth.json
# or just remove the commandcode key:
# edit ~/.omp/agent/auth.json to delete the "commandcode" entry
```

After uninstalling, restart omp to pick up the change.

## Updating

```bash
# Pull latest changes from repo
cd [..]/omp-cmd
git pull
```
After that, just relaunch omp and it should include the latest changes.
Alternatively, if you use [topgrade](https://github.com/topgrade-rs/topgrade) you can add it to your config:
```topgrade.toml
[git]
# Pull these repos every time you run topgrade
repos = [
    "[path to]/omp-cmd",
]
```

## Authentication
The plugin auto-creates `~/.omp/agent/auth.json` with a placeholder
(`{"commandcode": "user_xxxxxxxxxxxx"}`) on first load.

**Option A — interactive login (recommended):**
Run `/login` in an omp session, select **Command Code**. Your browser opens to
commandcode.ai/api-keys. Generate an API key, then paste it when prompted — or
skip the paste and add it to `~/.omp/agent/auth.json`:

```json
{ "commandcode": "user_..." }
```

Then re-run `/login` or restart the session.

**Option B — manual file edit:**
Place the key directly in `~/.omp/agent/auth.json`:
```json
{ "commandcode": "user_..." }
```

## Models

Models are auto-discovered from Command Code's Provider API at startup. Display prices are hardcoded in index.ts and shown in the status line.

## Usage

Once installed and authenticated, switch to a Command Code model in your omp session:

```
/switch commandcode/deepseek-v4-flash
```

Or any other model available through Command Code's API.

## How it works

This plugin registers a custom provider (`commandcode`) with omp's `ExtensionAPI.registerProvider()`. It implements a custom `streamSimple` handler that translates omp's request format to Command Code's proprietary `/alpha/generate` API, and translates the streaming response back into omp's event stream.

Model discovery uses `fetchDynamicModels`, which fetches the live model list from Command Code's Provider API endpoint.
