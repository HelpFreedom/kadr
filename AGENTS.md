# Project Instructions

## Codebase Knowledge Graph

This project uses codebase-memory-mcp to maintain a knowledge graph of the codebase.
Always prefer MCP graph tools over grep, glob, or file search for code discovery.

Use the tools in this order:

1. `search_graph` to find functions, classes, routes, and variables by pattern.
2. `trace_path` to trace callers and callees.
3. `get_code_snippet` to read specific function or class source code.
4. `query_graph` for complex Cypher queries.
5. `get_architecture` for a high-level project summary.

Fall back to grep, glob, or file search for string literals, error messages,
configuration values, non-code files, or when graph results are insufficient.

## Commits After Changes

After completing requested project changes and the relevant checks, create a Git
commit without waiting for a separate request.

- Commit only files changed for the current task. Preserve unrelated existing
  changes in the working tree.
- Use a conventional commit type such as `feat`, `fix`, `docs`, `ref`, `test`,
  `build`, `ci`, `chore`, `style`, `perf`, `meta`, or `license`.
- Write a meaningful bilingual commit message in Russian and English.
- Format the subject as `<type>(<scope>): <Russian summary> / <English summary>`;
  omit the scope when it does not add useful context.
- For non-trivial changes, add a body that explains what changed and why in both
  Russian and English.
- Keep every message line under 100 characters and the subject under 70
  characters whenever practical.
- Do not commit when the user explicitly asks not to, when the task is read-only,
  or when the requested change is not complete.
