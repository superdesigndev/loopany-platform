/**
 * Central logger (pino + pino-pretty).
 *
 * Uses pino-pretty as a *synchronous* destination stream (not a worker-thread
 * transport) so logs flush before process.exit() in the one-shot CLIs. Writes to
 * stderr (fd 2) to keep stdout clean for QR codes and human CLI output.
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

export const logger = pino({ level }, stream);
