import tmp from "tmp";
import fs from "fs";
import path from "path";

import { install } from "source-map-support";
import { writeAuthorizedKeys } from "../src/add-github-ssh-key";
import { expect, test } from "@jest/globals";

install();

test("keys can be written", async () => {
  const tmpDir = tmp.dirSync();
  const superSecretKey = "sooper-secret-keys";
  const keysExpectedPath = path.join(tmpDir.name, ".ssh", "authorized_keys");
  const keysActualPath = await writeAuthorizedKeys(
    tmpDir.name,
    superSecretKey,
    false
  );
  expect(keysActualPath).toEqual(keysExpectedPath);
  expect(fs.existsSync(keysExpectedPath)).toBe(true);
  expect(fs.readFileSync(keysExpectedPath).toString()).toBe(superSecretKey);
  fs.rmSync(tmpDir.name, { recursive: true });
});

test("keys can be overwritten", async () => {
  const tmpDir = tmp.dirSync();
  const superSecretKey = "sooper-secret-keys";
  const keysExpectedPath = path.join(tmpDir.name, ".ssh", "authorized_keys");
  await writeAuthorizedKeys(tmpDir.name, superSecretKey, false);
  const keysActualPath = await writeAuthorizedKeys(
    tmpDir.name,
    superSecretKey,
    true
  );
  expect(keysActualPath).toEqual(keysExpectedPath);
  expect(fs.existsSync(keysExpectedPath)).toBe(true);
  expect(fs.readFileSync(keysExpectedPath).toString()).toBe(superSecretKey);
  fs.rmSync(tmpDir.name, { recursive: true });
});
