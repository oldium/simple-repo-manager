import "dotenv/config";
import config from "./lib/config.ts";
import createServer from './http/http_server.ts';
import createApp from "./api/app.ts";
import { formatAddressPort } from "./lib/address.ts";
import logger from "./lib/logger.ts";

const { promise: terminationPromise, resolve: terminationResolve } = Promise.withResolvers<NodeJS.Signals>();
process.on("SIGINT", terminationResolve);
process.on("SIGTERM", terminationResolve);

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
logger.info(`Wrapper script for createrepo: ${ config.app.paths.createrepoScript }`);
if (config.app.gpg.gpgRepoPrivateKeyFile) {
    logger.info(`Signing script: ${ config.app.paths.signScript ?? "<no script>" }`);
} else {
    logger.info(`Signing script: ${ config.app.paths.signScript ?? "<no repo private key>" }`);
}

await terminationPromise;

logger.info("Terminating...");

await httpServer.close();

logger.info("Terminated");
