// fallow-ignore-file unused-class-member -- SDK namespace methods are the public API.
import { routes } from "./routes";
import type { Transport } from "./transport";
import type {
  DirEntry,
  FileContents,
  RenameRequest,
  WorktreePathRequest,
  WriteFileRequest,
} from "./types/fs";

/** Filesystem RPC namespace. */
export class FsClient {
  constructor(private readonly transport: Transport) {}

  listDir(payload: WorktreePathRequest): Promise<DirEntry[]> {
    return this.rpc("listDir", payload);
  }

  createFile(payload: WorktreePathRequest): Promise<void> {
    return this.rpc("createFile", payload);
  }

  createFolder(payload: WorktreePathRequest): Promise<void> {
    return this.rpc("createFolder", payload);
  }

  pathExists(payload: WorktreePathRequest): Promise<boolean> {
    return this.rpc("pathExists", payload);
  }

  readFile(payload: WorktreePathRequest): Promise<FileContents> {
    return this.rpc("readFile", payload);
  }

  writeFile(payload: WriteFileRequest): Promise<void> {
    return this.rpc("writeFile", payload);
  }

  rename(payload: RenameRequest): Promise<void> {
    return this.rpc("rename", payload);
  }

  delete(payload: WorktreePathRequest): Promise<void> {
    return this.rpc("delete", payload);
  }

  private rpc<T>(op: string, payload: object): Promise<T> {
    return this.transport.request<T>(routes.rpc("filesystem"), { body: { op, ...payload } });
  }
}
