export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileEntry[];
  content?: string;
  expanded?: boolean;
}

export class InMemoryFileSystem {
  private files: FileEntry[];
  private workspacePath: string | null = null;

  constructor(
    initialFiles: Array<FileEntry>,
    workspacePath: string | null = null,
  ) {
    this.workspacePath = workspacePath;
    this.files = initialFiles;
  }

  // Toggle directory expansion state
  async toggleDirectoryExpanded(path: string): Promise<boolean> {
    const entry = this.findEntry(path);
    if (!entry || entry.type !== "directory") {
      return false;
    }
    entry.expanded = !entry.expanded;
    return true;
  }

  // Get entries at the root level
  async getEntries(path: string = "/"): Promise<FileEntry[]> {
    if (path === "/") {
      return this.files;
    }

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
    // Handle the case where relativePath starts with a slash
    const cleanPath = relativePath.startsWith("/")
      ? relativePath.slice(1)
      : relativePath;
    return `${this.workspacePath}/${cleanPath}`;
  }

  setWorkspacePath(path: string) {
    this.workspacePath = path;
  }

  getWorkspacePath(): string | null {
    return this.workspacePath;
  }

  // Find entry by path - basic implementation
  private findEntry(path: string): FileEntry | null {
    // Root path is not a real entry
    if (path === "/" || path === "") return null;

    // For simplicity, we only handle top-level files and directories
    const name = path.startsWith("/") ? path.slice(1) : path;

    // First check if it's a top-level entry
    const topLevelEntry = this.files.find((f) => f.name === name);
    if (topLevelEntry) return topLevelEntry;

    // If not found, let's check inside directories
    for (const dir of this.files.filter(
      (f) => f.type === "directory" && f.children,
    )) {
      if (dir.children) {
        // Check if it's a direct child of this directory
        const directChild = dir.children.find((f) => f.name === name);
        if (directChild) return directChild;
      }
    }

    return null;
  }
}
