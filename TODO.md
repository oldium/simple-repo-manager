# Things to Do

* Make Repository Management API asynchronous. This should prevent any timeouts
  during the REST API call when a large import takes a long time.
* Make the server horizontally scalable. The state is one local SQLite database
  guarded by an in-process lock, so it would need a shared database and a
  distributed lock, possibly in Redis.
* Add more tests for the rendering engine.
* Asynchronous MCP/REST operations with progress streaming over SSE (currently
  both surfaces are synchronous). At that point, switch the MCP endpoint to a
  stateful transport and accept `GET /api/v1/mcp` as the client-opened SSE
  channel for server→client notifications (progress, logging) instead of
  returning 405.
