# omp-cmd

**omp** plugin that adds [Command Code](https://commandcode.ai) as a model provider. Based on [patlux's repo](https://github.com/patlux/pi-commandcode-provider)

## Installation

```bash
# From npm (once published)
omp plugin install omp-commandcode

# From a local clone
git clone https://github.com/bl4zee1g/omp-cmd.git
omp plugin link ./omp-cmd
```

## Authentication

Choose **one**:

### 1. Interactive login (recommended)

Run `/login` in an omp session, select **Command Code**, and your browser opens to commandcode.ai. The API key is auto-stored in `~/.omp/agent/auth.json`.

### 2. Environment variable

```bash
export COMMANDCODE_API_KEY=user_xxxxxxxxxxxx
```

### 3. Auth file

Create `~/.commandcode/auth.json` or `~/.omp/agent/auth.json`:

```json
{ "apiKey": "user_xxxxxxxxxxxx" }
```

or

```json
{ "commandcode": "user_xxxxxxxxxxxx" }
```

## Configuration

| Environment variable | Default | Description |
|---|---|---|
| `COMMANDCODE_API_BASE` | `https://api.commandcode.ai` | API base URL |
| `COMMANDCODE_MODELS_URL` | `https://api.commandcode.ai/provider/v1/models` | Model list endpoint |

## Models

Models are auto-discovered from Command Code's Provider API at startup. Display prices are maintained in this plugin and shown in `omp model list`.

## Usage

Once installed and authenticated, select a Command Code model in your omp session:

```
/model deepseek/deepseek-v4-flash
```

Or any other model available through Command Code's API.

## How it works

This plugin registers a custom provider (`commandcode`) with omp's `ExtensionAPI.registerProvider()`. It implements a custom `streamSimple` handler that translates omp's request format to Command Code's proprietary `/alpha/generate` API, and translates the streaming response back into omp's event stream.

Model discovery uses `fetchDynamicModels`, which fetches the live model list from Command Code's Provider API endpoint.
