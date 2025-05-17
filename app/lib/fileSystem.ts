import { invoke } from "@tauri-apps/api/core";

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

    // Only load children if expanding and there are no children yet
    if (!entry.expanded && (!entry.children || entry.children.length === 0)) {
      try {
        // Get full directory path
        const fullPath = this.getFullPath(path);

        // Invoke the backend to get the directory contents
        const dirEntries = await invoke<
          Array<{
            name: string;
            path: string;
            is_dir: boolean;
            content?: string;
          }>
        >("read_directory", {
          path: fullPath,
        });

        // Convert to FileEntry objects
        const children: FileEntry[] = dirEntries.map((item) => {
          // Create relative path (remove workspace path prefix)
          const relativePath = `${path}/${item.name}`.replace(/\/+/g, "/");

          return {
            name: item.name,
            path: relativePath,
            type: item.is_dir ? "directory" : "file",
            content: item.content || "",
            expanded: false,
            children: item.is_dir ? [] : undefined,
          };
        });

        // Sort: directories first, then files alphabetically
        children.sort((a, b) => {
          if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

        // Set the children
        entry.children = children;
      } catch (error) {
        console.error(`Error loading directory contents for ${path}:`, error);
        return false;
      }
    }

    // Toggle expanded state
    entry.expanded = !entry.expanded;
    return true;
  }

  // Get entries at the root level or in a directory
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
    let cleanPath = relativePath;
    if (cleanPath.startsWith("./")) {
      cleanPath = cleanPath.slice(2);
    } else if (cleanPath.startsWith("/")) {
      cleanPath = cleanPath.slice(1);
    }
    return `${this.workspacePath}/${cleanPath}`;
  }

  setWorkspacePath(path: string) {
    this.workspacePath = path;
  }

  getWorkspacePath(): string | null {
    return this.workspacePath;
  }

  // Find entry by path - more complete implementation
  private findEntry(path: string): FileEntry | null {
    // Root path is not a real entry
    if (path === "/" || path === "") return null;

    // Split the path into components
    let parts = path.split("/").filter(Boolean);
    if (parts[0] === ".") {
      parts = parts.slice(1);
    }

    // Start at the root level
    let current: FileEntry[] = this.files;
    let currentEntry: FileEntry | undefined;

    // Navigate through the path components
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      currentEntry = current.find((f) => f.name === part);

      if (!currentEntry) {
        console.log(`Could not find path component "${part}" in`, current);
        return null;
      }

      if (i === parts.length - 1) {
        // This is the target we're looking for
        return currentEntry;
      }

      // Move to the next level
      if (currentEntry.type !== "directory" || !currentEntry.children) {
        console.log(
          `Path component "${part}" is not a directory or has no children`,
        );
        return null;
      }

      current = currentEntry.children;
    }

    return null;
  }

  // Recursively collects all file entries from the tree.
  public getAllFileEntries(): FileEntry[] {
    function flatten(entries: FileEntry[]): FileEntry[] {
      return entries.reduce((acc, entry) => {
        acc.push(entry);
        if (entry.type === "directory" && entry.children) {
          acc.push(...flatten(entry.children));
        }
        return acc;
      }, [] as FileEntry[]);
    }
    return flatten(this.files);
  }

  // Expand non-hidden and non-gitignored directories in the background.
  public async expandDefaultDirectories(): Promise<void> {
    async function processDir(
      fs: InMemoryFileSystem,
      entries: FileEntry[],
    ): Promise<void> {
      const promises = entries
        .filter(
          (e) =>
            e.type === "directory" &&
            !e.name.startsWith(".") &&
            e.name !== ".git" &&
            e.name !== "node_modules" &&
            e.name !== "target",
        )
        .map(async (entry) => {
          // Expand directory if not already expanded or if children are empty.
          if (
            !entry.expanded ||
            !entry.children ||
            entry.children.length === 0
          ) {
            await fs.toggleDirectoryExpanded(entry.path);
          }
          if (entry.children && entry.children.length > 0) {
            await processDir(fs, entry.children);
          }
        });
      await Promise.all(promises);
    }
    await processDir(this, this.files);
  }
}
