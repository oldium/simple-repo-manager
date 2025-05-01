import { TestEnvironment } from "jest-environment-node";
import { BufferedConsole } from "@jest/console";
import osPath from "path";

const originalWrite = BufferedConsole.write;

// Fix reported logger line for console logs
function write(buffer, type, message, stackLevel = 2) {
    const result = originalWrite.call(BufferedConsole, buffer, type, message, stackLevel);
    const originArray = result[result.length - 1].origin.split("\n");
    if (originArray.length > 0 && originArray[0].includes(`winston${osPath.sep}transports${osPath.sep}console.js`)) {
        const winstonModule = `node_modules${osPath.sep}winston`;
        let skip = 0;
        while (skip < originArray.length && (originArray[skip].includes(winstonModule) || originArray[skip].includes("node:events"))) {
            skip++;
        }
        originArray.splice(0, skip);
    }
    result[result.length - 1].origin = originArray.join("\n");
    return result;
}

Object.defineProperty(BufferedConsole, "write", {
    value: write,
    writable: true,
    configurable: true,
    enumerable: false
});

// Custom test environment inheriting Error
// noinspection JSUnusedGlobalSymbols
export default class CustomEnvironment extends TestEnvironment {
    constructor(config, context) {
        super(config, context);
        this.global.Error = Error;
    }
}
