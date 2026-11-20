import {
  folderIds,
  getFolderPath,
  type KnowledgeFolderNode,
} from "@/lib/knowledge";

export function getFolderDisplayName(folder: KnowledgeFolderNode): string {
  if (folder.id === folderIds.campus) return "Общие параметры кампуса";
  if (folder.id === folderIds.universities) return "Вузы-резиденты";
  if (folder.kind === "custom-type") return folder.name;

  return folder.name.replace(/^\d+_/, "").replaceAll("_", " ");
}

export function getFolderDisplayPath(
  folderId: string,
  tree: KnowledgeFolderNode[]
): string {
  const path = getFolderPath(folderId, tree);
  return path.length > 0
    ? path.map(getFolderDisplayName).join(" / ")
    : folderId;
}
