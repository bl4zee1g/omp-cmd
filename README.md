# pi-commandcode-provider

A [pi](https://github.com/badlogic/pi-mono) custom provider that connects pi to the [Command Code](https://commandcode.ai) API.

> **Note:** This package only provides a model *provider*. It does **not** include an API key. You must bring your own Command Code API key or subscription.

## Models

18 models across premium and open-source providers:

| Category | Models |
|----------|--------|
| **Anthropic** | Claude Opus 4.7, Claude Opus 4.6, Claude Sonnet 4.6, Claude Haiku 4.5 |
| **OpenAI** | GPT-5.5, GPT-5.4, GPT-5.3 Codex, GPT-5.4 Mini |
| **Open-source** | DeepSeek V4 Pro, DeepSeek V4 Flash, Kimi K2.6, Kimi K2.5, GLM-5.1, GLM-5, MiniMax M2.7, MiniMax M2.5, Qwen 3.6 Max, Qwen 3.6 Plus |

## Install

```sh
pi install npm:pi-commandcode-provider
```

Or shorthand:

```sh
pi install pi-commandcode-provider
```

Then reload pi:

```txt
/reload
```

## Setup

Set your Command Code API key using one of these methods:

### 1. Environment variable

```sh
export COMMANDCODE_API_KEY="cc-..."
```

### 2. Auth file (recommended)

Create `~/.commandcode/auth.json`:

```json
{
  "apiKey": "cc-..."
}
```

Or use pi's auth file at `~/.pi/agent/auth.json`:

```json
{
  "commandcode": "cc-..."
}
```

## Usage

After installing and setting your API key, select a Command Code model in pi:

```txt
/model claude-sonnet-4-6
```

Any query will then use the Command Code API. You can list available models:

```sh
pi -e index.ts --list-models
```

Or within pi:

```txt
/models
```

## Publish

```sh
npm login
npm publish --access public
```

## License

MIT
