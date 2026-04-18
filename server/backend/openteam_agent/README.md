# OpenTeam Agent Backend

`openteam_agent` is the built-in custom AgentServer backend.

It vendors the minimal built AI SDK runtime under `node_modules/` so AgentServer can run independently without importing from an external SDK checkout or an absolute local path.

The backend still uses AgentServer's shared local tool bridge. Upper layers see the same normalized events and canonical tool primitives as the other backends.

Vendored SDK packages are derived from the local AI SDK repository and keep their original package metadata. The upstream AI SDK license is copied to `LICENSE-ai-sdk.txt`.
