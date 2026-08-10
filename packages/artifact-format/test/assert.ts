/**
 * Shared assertions for the stage-2 suite. Test support, not source.
 */

import { expect } from "vitest";
import { ArtifactFormatError, isArtifactFormatError } from "../src/errors.js";

/**
 * Assert a call throws OUR typed error with the expected code, and return the
 * error so a test can go on to inspect its `issues` / `line` / message.
 *
 * Deliberately strict about the error TYPE as well as the code: "fails loud"
 * means a typed `ArtifactFormatError` a caller can switch on, not any old
 * throw that happens to abort the operation.
 */
export function expectCode(fn: () => unknown, code: string): ArtifactFormatError {
  try {
    fn();
  } catch (err) {
    if (!isArtifactFormatError(err)) {
      throw new Error(
        `expected an ArtifactFormatError with code ${code}, got ${
          err instanceof Error ? `${err.name}: ${err.message}` : String(err)
        }`,
      );
    }
    expect(err.code, `wrong code for: ${err.message}`).toBe(code);
    expect(err.name).toBe("ArtifactFormatError");
    return err;
  }
  throw new Error(`expected a ${code} failure, but nothing was thrown`);
}

/** Build an artifact file from a head block and a body, without any helper
 *  under test in the loop — the tests must not depend on `serializeArtifact`
 *  to state what a file looks like. */
export function file(head: string, body = ""): string {
  return `---\n${head}${head.endsWith("\n") ? "" : "\n"}---\n${body}`;
}
