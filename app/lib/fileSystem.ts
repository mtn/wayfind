export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileEntry[];
  content?: string;
}

export class InMemoryFileSystem {
  private root: FileEntry;
  private workspacePath: string | null = null;

  constructor(
    initialFiles: Array<FileEntry>,
    workspacePath: string | null = null,
  ) {
    this.workspacePath = workspacePath;
    this.root = {
      name: "/",
      path: "/",
      type: "directory",
      children: initialFiles,
    };
  }

  // Get entries in a directory
  async getEntries(path: string = "/"): Promise<FileEntry[]> {
    const entry = this.findEntry(path);
    if (!entry || entry.type !== "directory") {
      return [];
    }
    return entry.children || [];
  }

  // Get a specific file entry
  async getFile(path: string): Promise<FileEntry | null> {
    const entry = this.findEntry(path);
    if (!entry || entry.type !== "file") {
      return null;
    }
    return entry;
  }

  // Update file content
  async updateFile(path: string, content: string): Promise<boolean> {
    const entry = this.findEntry(path);
    if (!entry || entry.type !== "file") {
      return false;
    }
    entry.content = content;
    return true;
  }

  getFullPath(relativePath: string): string {
    if (!this.workspacePath) {
      throw new Error("No workspace path set");
    }
    const cleanPath = relativePath.startsWith("/")
      ? relativePath.slice(1)
      : relativePath;
    return `${this.workspacePath}/${cleanPath}`;
  }

  setWorkspacePath(path: string) {
    this.workspacePath = path;
  }

  private findEntry(path: string): FileEntry | null {
    if (path === "/" || path === "") return this.root;

    const parts = path.split("/").filter(Boolean);
    let current: FileEntry = this.root;

    for (const part of parts) {
      const child = current.children?.find((c) => c.name === part);
      if (!child) return null;
      current = child;
    }

    return current;
  }
}
