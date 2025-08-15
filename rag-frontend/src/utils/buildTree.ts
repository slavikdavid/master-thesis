export interface DataNode {
  key: string;
  title: string;
  children?: DataNode[];
  isLeaf?: boolean;
  path: string;
}

/**
 * Turn [ "src/index.ts", "src/components/Button.tsx", "README.md" ]
 * into a nested treeData array.
 */
export function buildTree(paths: string[]): DataNode[] {
  const root: Record<string, any> = {};

  for (const p of paths) {
    const parts = p.split("/");
    let cur = root;

    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      if (!cur[name]) {
        cur[name] = {
          __node: {
            key: parts.slice(0, i + 1).join("/"),
            title: name,
            children: {},
          },
        };
      }
      cur = cur[name].__node.children;
    }
  }

  function toDataNodes(obj: Record<string, any>): DataNode[] {
    return Object.values(obj).map((x: any) => {
      const { key, title, children } = x.__node;
      const childNodes = toDataNodes(children);
      return {
        key,
        title,
        path: key,
        isLeaf: childNodes.length === 0,
        ...(childNodes.length > 0 ? { children: childNodes } : {}),
      } as DataNode;
    });
  }

  return toDataNodes(root);
}
