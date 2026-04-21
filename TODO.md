# Things to Do

* Make Repository Management API asynchronous. This should prevent any timeouts
  during the REST API call when `reprepro` and `createrepo_c` calls take a long
  time.
* Make the Repository Management API lock distributed, possible backend is
  Redis. The goal would be to make the server horizontal scalable.
* Add more tests for the rendering engine.
* Split `server/lib/deb.ts` and `server/lib/rpm.ts` into smaller modules
  (history, listing, removal, build, fs helpers).
* Asynchronous MCP/REST operations with progress streaming over SSE (currently
  both surfaces are synchronous). At that point, switch the MCP endpoint to a
  stateful transport and accept `GET /api/v1/mcp` as the client-opened SSE
  channel for server→client notifications (progress, logging) instead of
  returning 405.
