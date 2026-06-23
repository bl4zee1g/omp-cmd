# Contributing

## Prerequisites

- [omp](https://omp.sh) installed
- [Bun](https://bun.sh) for local development

## Development

Clone this repo and link it into omp for development:

```bash
git clone https://github.com/patlux/omp-commandcode.git
cd omp-commandcode
omp plugin link .
```

Changes to the `.ts` source files are picked up immediately — no rebuild step.

## Structure

```
omp-commandcode/
├── index.ts            # Extension entry point (registers the provider)
├── src/
│   ├── core.ts         # Streaming logic (custom API handler)
│   ├── converters.ts   # Message/tool/system prompt conversion
│   ├── models.ts       # Model discovery from Provider API
│   ├── oauth.ts        # OAuth login flow
│   ├── auth-server.ts  # Local HTTP server for OAuth callback
│   └── types.ts        # Shared type guards and helpers
├── package.json
├── README.md
├── CHANGELOG.md
└── LICENSE
```

## Release

1. Update version in `package.json`.
2. Move CHANGELOG entries from `[Unreleased]` to a new release section.
3. Tag and publish to npm.
