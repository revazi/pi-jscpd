import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Reviewed public version. Changing this does not authorize a tag or publish. */
export const APPROVED_RELEASE_VERSION = "0.2.2";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function assertApprovedReleaseVersion(actual, label = "version") {
  assert.match(
    APPROVED_RELEASE_VERSION,
    SEMVER,
    "Approved release version must be a MAJOR.MINOR.PATCH value.",
  );
  assert.equal(
    actual,
    APPROVED_RELEASE_VERSION,
    `${label} differs from the approved release ${APPROVED_RELEASE_VERSION}.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.match(
    APPROVED_RELEASE_VERSION,
    SEMVER,
    "Approved release version must be a MAJOR.MINOR.PATCH value.",
  );
  process.stdout.write(`${APPROVED_RELEASE_VERSION}\n`);
}
