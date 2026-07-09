/**
 * Daemon logger (pino + pino-pretty), mirroring the server's logger.ts.
 *
 * pino-pretty is wired as a *synchronous* destination stream (not a worker-thread
 * transport) so logs flush before process.exit() in the one-shot CLI paths.
 * Writes to stderr (fd 2) so stdout stays clean for the `adscaile` shim's protocol
 * output (the text claude reads back from `adscaile report` etc.).
 */
import pino from "pino";
import pretty from "pino-pretty";

const level = (process.env.ADSCAILE_LOG_LEVEL || "info").toLowerCase();

const stream = pretty({
  destination: 2, // stderr
  colorize: true,
  translateTime: "SYS:HH:MM:ss",
  ignore: "pid,hostname",
});

export const logger = pino({ level }, stream).child({ mod: "daemon" });
