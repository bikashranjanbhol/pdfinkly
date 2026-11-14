import "server-only";
import { env } from "../env";
import { localStorageDriver } from "./local";
import { s3StorageDriver } from "./s3";
import type { StorageDriver } from "./types";

export * from "./types";

export function storage(): StorageDriver {
  return env.storageDriver === "s3" ? s3StorageDriver() : localStorageDriver();
}

export const versionKey = (userId: string, fileId: string, versionId: string) =>
  `users/${userId}/files/${fileId}/${versionId}.pdf`;
