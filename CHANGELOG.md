## [Unreleased]

### Changed

- Simplify /login flow: removed OAuth callback server, login now opens browser
  to commandcode.ai/api-keys and instructs user to add key to ~/.omp/agent/auth.json.
- Auto-create ~/.omp/agent/auth.json with a placeholder on first load.
- Read API key directly from ~/.omp/agent/auth.json at startup.

### Removed

- Removed `src/auth-server.ts` — no longer needed.
- Dropped `COMMANDCODE_API_KEY` environment variable support — API key must be
  in ~/.omp/agent/auth.json or provided via /login.

### Added

- Initial omp plugin for Command Code API.
- Custom streaming handler for the `/alpha/generate` endpoint.
- OAuth login flow via `/login` in omp.
- Dynamic model discovery from Command Code's Provider API.
