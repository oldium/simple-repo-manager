import { AsyncLocalStorage } from "node:async_hooks";
import winston, { type LoggerOptions } from "winston";
import crypto from "crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";

export type LoggedResponse = Response & { logResponse?: boolean };

type LoggingAsyncStorage = { correlationId: string };

const exceptionFormat = winston.format(
    (info) => {
        const err = info.err ?? info.error ?? info.exception;
        if (err instanceof Error) {
            info.err_message = (err.stack ?? `${ err.name ?? "Error" }: ${ err.message }`);
            info.err_cause = err.cause;
        } else if (err !== null && err !== undefined) {
            info.err_message = String(err);
        }
        return info;
    });

export function getCorrelationId(): string | undefined {
    return asyncLocalStorage.getStore()?.correlationId;
}

const correlationIdFormat = winston.format((info) => {
    const correlationId = getCorrelationId();
    if (correlationId) {
        info.correlationId = correlationId;
    }
    return info;
});

const outputFormat = winston.format.printf((info) => {
    const result = `[${ info.level }]${ info.correlationId ? `[${ info.correlationId }]` : "" } ` +
        `${ info.timestamp ? `${ info.timestamp } ` : "" }` +
        `${ info.message }` +
        `${ info.err_message ? `\n${ info.err_message }` : "" }` +
        `${ info.err_cause ? `\nCaused by: ${ info.err_cause }` : "" }`;
    const resultArray = result.split('\n');
    return resultArray.map((line, index) => index === 0 ? line : '    ' + line).join('\n');
});

const asyncLocalStorage = new AsyncLocalStorage<LoggingAsyncStorage>();

function correlationIdMiddleware(): RequestHandler {
    return (_req: Request, _res: Response, next: NextFunction) => {
        asyncLocalStorage.run({ correlationId: crypto.randomBytes(16).toString('hex') },
            next);
    }
}

function accessLogMiddleware(): RequestHandler {
    return (req: Request, res: LoggedResponse, next: NextFunction) => {
        // Use req.ip if trust proxy is properly configured, otherwise fallback
        const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
        const method = req.method;
        const url = req.originalUrl;
        logger.info(`${ method } ${ url } from ${ clientIp }`);

        res.once("finish", () => {
            const statusCode = res.statusCode;
            if (statusCode >= 400 || res.logResponse) {
                const statusMessage = res.statusMessage;
                logger.info(
                    `${ method } ${ url } from ${ clientIp } - ${
                        statusCode < 400 ?
                            colorize.colorize("info", `${ statusCode } ${ statusMessage }`) :
                            statusCode < 500 ?
                                colorize.colorize("warn", `${ statusCode } ${ statusMessage }`) :
                                colorize.colorize("error", `${ statusCode } ${ statusMessage }`)
                    }`);
            }
        });
        next();
    }
}

export function loggingMiddlewares(): RequestHandler[] {
    return [
        correlationIdMiddleware(),
        accessLogMiddleware(),
    ];
}

export function logResponseMiddleware(): RequestHandler {
    return (_req: Request, res: LoggedResponse, next: NextFunction) => {
        res.logResponse = true;
        next();
    }
}

const defaultLevel = process.env.NODE_ENV === "production" ? "info" : "debug";
const level = process.env.LOG_LEVEL ? process.env.LOG_LEVEL : defaultLevel;

export const colorize = winston.format.colorize({ level: true });

const loggerOpts: LoggerOptions = {
    level: level,
    transports: [
        new winston.transports.Console({
            forceConsole: true,
            format: winston.format.combine(
                correlationIdFormat(),
                exceptionFormat(),
                winston.format(info => {
                    info.level = info.level.toUpperCase()
                    return info;
                })(),
                winston.format.timestamp(),
                winston.format.splat(),
                colorize,
                outputFormat
            )
        })
    ]
};

const logger = winston.createLogger(loggerOpts);

export default logger;
