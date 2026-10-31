import "dotenv/config";
import "./bootstrap.ts";
import config from "./lib/config.ts";
import createServer from './http/http_server.ts';
import createApp from "./api/app.ts";
import { closeBackends } from "./backend/index.ts";
import { formatAddressPort } from "./lib/address.ts";
import logger from "./lib/logger.ts";
import { checkWindowsVersion } from "./lib/windows-version.ts";
import os from "node:os";
import osPath from "path";

checkWindowsVersion(os.release(), process.platform);

const { promise: terminationPromise, resolve: terminationResolve } = Promise.withResolvers<NodeJS.Signals>();
process.on("SIGINT", terminationResolve);
process.on("SIGTERM", terminationResolve);
if (process.platform === "win32") {
    // The console window closing and Ctrl+Break; elsewhere SIGHUP stays free for a reload
    process.on("SIGHUP", terminationResolve);
    process.on("SIGBREAK", terminationResolve);
}

const httpServer = createServer(config.http, await createApp(config.app, config.environment));

httpServer.on("listenHost", (proto: string, host, port) => {
    logger.info(`> Starting ${ proto.toUpperCase() } server to listen at ${ proto }://${ host }:${
        port !== 0 ? port : "<?>" } as ${ config.environment }`);
});
httpServer.on("listeningAddress", (proto, address) => {
    logger.info(`> ${ proto.toUpperCase() } server listening at ${ proto }://${ formatAddressPort(address) } as ${
        config.environment
    }`);
})

await httpServer.listen();

logger.info(`Incoming base directory: ${ config.app.paths.incomingDir }`);
logger.info(`Repository state directory: ${ config.app.paths.repoStateDir }`);
logger.info(`Final repository base directory: ${ config.app.paths.repoDir }`);
logger.info(`Repository database: ${ osPath.join(config.app.paths.repoStateDir, "repo.db") }`);

await terminationPromise;

logger.info("Terminating...");

await httpServer.close();
// Lets a running import or GC finish before the database closes
await closeBackends();

logger.info("Terminated");
