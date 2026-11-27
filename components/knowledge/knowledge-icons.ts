import {
  BookOpen,
  Boxes,
  ContactRound,
  FileCheck2,
  FileText,
  FlaskConical,
  Folder,
  GraduationCap,
  Handshake,
  HardHat,
  Landmark,
  Layers,
  Network,
  Rocket,
  type LucideIcon,
} from "lucide-react";
import {
  folderIds,
  type KnowledgeCardType,
  type KnowledgeFolderKind,
  type KnowledgeFolderNode,
} from "@/lib/knowledge";

export const cardTypeIcons: Record<KnowledgeCardType, LucideIcon> = {
  campus: Landmark,
  custom: FileText,
  laboratory: FlaskConical,
  project: Boxes,
  university: ContactRound,
};
const folderIcons: Record<KnowledgeFolderKind, LucideIcon> = {
  campus: cardTypeIcons.campus,
  "universities-root": GraduationCap,
  university: BookOpen,
  subfolder: Folder,
  joint: Handshake,
  "custom-root": Layers,
  "custom-type": cardTypeIcons.custom,
};
const sectionIcons = {
  passport: cardTypeIcons.university,
  infrastructure: cardTypeIcons.laboratory,
  products: cardTypeIcons.project,
  partners: Network,
  articles: FileCheck2,
};
export function getFolderIcon(node: KnowledgeFolderNode) {
  if (node.id === folderIds.chkkParameters) return HardHat;
  if (node.id === folderIds.rioProjects) return Rocket;
  const section = Object.entries(sectionIcons).find(
    ([key]) => node.kind === "subfolder" && node.id.endsWith(`/${key}`)
  );
  return section?.[1] ?? folderIcons[node.kind];
}
