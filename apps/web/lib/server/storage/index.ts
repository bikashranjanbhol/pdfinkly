import "server-only";
import { env } from "../env";
import { blobStorageDriver } from "./blob";
import { localStorageDriver } from "./local";
import { s3StorageDriver } from "./s3";
import type { StorageDriver } from "./types";

export * from "./types";

export function storage(): StorageDriver {
  switch (env.storageDriver) {
    case "blob":
      return blobStorageDriver();
    case "s3":
      return s3StorageDriver();
    default:
      return localStorageDriver();
  }
}

export const versionKey = (userId: string, fileId: string, versionId: string) =>
  `users/${userId}/files/${fileId}/${versionId}.pdf`;
