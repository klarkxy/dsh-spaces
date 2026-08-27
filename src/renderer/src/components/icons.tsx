import {
  Book,
  Bot,
  Code2,
  Folder,
  Globe,
  Music,
  Pencil,
  Sparkles,
  Terminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { PresetIcon } from "@shared/types";
import { PRESET_ICONS } from "@shared/types";

const ICONS: Record<PresetIcon, LucideIcon> = {
  code: Code2,
  pencil: Pencil,
  terminal: Terminal,
  folder: Folder,
  sparkles: Sparkles,
  bot: Bot,
  book: Book,
  wrench: Wrench,
  globe: Globe,
  music: Music,
};

export { PRESET_ICONS };

export function SpaceGlyph({
  icon,
  name,
  className = "h-5 w-5",
}: {
  icon?: string;
  name: string;
  className?: string;
}) {
  const key = icon && PRESET_ICONS.includes(icon as PresetIcon) ? (icon as PresetIcon) : undefined;
  if (key) {
    const Glyph = ICONS[key];
    return <Glyph className={className} strokeWidth={2} />;
  }
  return <span className="text-sm font-semibold">{name.slice(0, 1).toUpperCase()}</span>;
}
