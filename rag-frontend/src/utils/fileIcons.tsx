import React from "react";
import { IconType } from "react-icons";
import { FileText } from "lucide-react";
import {
  SiHtml5,
  SiCss3,
  SiSass,
  SiTailwindcss,
  SiJavascript,
  SiTypescript,
  SiReact,
  SiNextdotjs,
  SiVuedotjs,
  SiSvelte,
  SiAstro,
  SiNodedotjs,
  SiPython,
  SiGo,
  SiRust,
  SiC,
  SiCplusplus,
  SiKotlin,
  SiPhp,
  SiRuby,
  SiSwift,
  SiDocker,
  SiMarkdown,
  SiJson,
  SiYaml,
  SiToml,
  SiGnubash,
  SiPostgresql,
  SiXml,
} from "react-icons/si";

import { TbBrandCSharp, TbBrandPowershell } from "react-icons/tb";
import { FaJava } from "react-icons/fa";

/** Base filename from path */
export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** File extension (handles dotfiles like `.env`) */
export function extName(path: string): string {
  const base = baseName(path);
  // `.env`, `.gitignore`, etc. (no second dot)
  if (base.startsWith(".") && !base.includes(".", 1)) return base.toLowerCase();
  const idx = base.lastIndexOf(".");
  return idx >= 0 ? base.slice(idx + 1).toLowerCase() : "";
}

function isTSX(path: string) {
  return /\.tsx$/i.test(path);
}
function isJSX(path: string) {
  return /\.jsx$/i.test(path);
}
function specialNameKind(path: string): string | null {
  const name = baseName(path).toLowerCase();
  if (name === "dockerfile") return "dockerfile";
  if (name === "makefile") return "makefile";
  if (name.startsWith("readme")) return "md";
  if (name === "next.config.js" || name === "next.config.ts") return "next";
  return null;
}

type IconSpec = { Icon: IconType; colorClass?: string };

const ICONS: Record<string, IconSpec> = {
  html: { Icon: SiHtml5, colorClass: "text-orange-500" },
  htm: { Icon: SiHtml5, colorClass: "text-orange-500" },

  css: { Icon: SiCss3, colorClass: "text-blue-500" },
  scss: { Icon: SiSass, colorClass: "text-pink-500" },
  sass: { Icon: SiSass, colorClass: "text-pink-500" },
  tailwind: { Icon: SiTailwindcss, colorClass: "text-cyan-500" },

  js: { Icon: SiJavascript, colorClass: "text-yellow-500" },
  mjs: { Icon: SiJavascript, colorClass: "text-yellow-500" },
  cjs: { Icon: SiJavascript, colorClass: "text-yellow-500" },
  ts: { Icon: SiTypescript, colorClass: "text-blue-600" },
  jsx: { Icon: SiReact, colorClass: "text-sky-500" },
  tsx: { Icon: SiReact, colorClass: "text-sky-500" },
  next: { Icon: SiNextdotjs, colorClass: "text-neutral-900 dark:text-white" },
  vue: { Icon: SiVuedotjs, colorClass: "text-emerald-500" },
  svelte: { Icon: SiSvelte, colorClass: "text-orange-600" },
  astro: { Icon: SiAstro, colorClass: "text-orange-400" },
  node: { Icon: SiNodedotjs, colorClass: "text-green-600" },

  py: { Icon: SiPython, colorClass: "text-blue-500" },
  go: { Icon: SiGo, colorClass: "text-cyan-600" },
  rs: { Icon: SiRust, colorClass: "text-orange-700" },
  c: { Icon: SiC, colorClass: "text-blue-600" },
  h: { Icon: SiC, colorClass: "text-blue-600" },
  cpp: { Icon: SiCplusplus, colorClass: "text-blue-700" },
  cxx: { Icon: SiCplusplus, colorClass: "text-blue-700" },
  cc: { Icon: SiCplusplus, colorClass: "text-blue-700" },
  hpp: { Icon: SiCplusplus, colorClass: "text-blue-700" },
  cs: { Icon: TbBrandCSharp, colorClass: "text-purple-600" },
  java: { Icon: FaJava, colorClass: "text-red-600" },
  kt: { Icon: SiKotlin, colorClass: "text-purple-500" },
  php: { Icon: SiPhp, colorClass: "text-indigo-500" },
  rb: { Icon: SiRuby, colorClass: "text-red-500" },
  swift: { Icon: SiSwift, colorClass: "text-orange-500" },

  dockerfile: { Icon: SiDocker, colorClass: "text-blue-500" },
  md: { Icon: SiMarkdown, colorClass: "text-slate-600" },
  markdown: { Icon: SiMarkdown, colorClass: "text-slate-600" },
  json: { Icon: SiJson, colorClass: "text-amber-600" },
  yml: { Icon: SiYaml, colorClass: "text-cyan-700" },
  yaml: { Icon: SiYaml, colorClass: "text-cyan-700" },
  toml: { Icon: SiToml, colorClass: "text-gray-700" },
  xml: { Icon: SiXml, colorClass: "text-orange-500" },

  sh: { Icon: SiGnubash, colorClass: "text-green-600" },
  bash: { Icon: SiGnubash, colorClass: "text-green-600" },
  zsh: { Icon: SiGnubash, colorClass: "text-green-600" },
  ps1: { Icon: TbBrandPowershell, colorClass: "text-blue-700" },

  sql: { Icon: SiPostgresql, colorClass: "text-indigo-600" },

  env: { Icon: SiGnubash, colorClass: "text-green-700" },
  ini: { Icon: SiToml, colorClass: "text-gray-700" },
  makefile: { Icon: SiGnubash, colorClass: "text-slate-700" },
};

/** kind string used for icon lookup */
export function detectFileKind(filename: string): string {
  const special = specialNameKind(filename);
  if (special) return special;

  if (isTSX(filename)) return "tsx";
  if (isJSX(filename)) return "jsx";

  const ext = extName(filename);
  if (ext) return ext;

  const low = baseName(filename).toLowerCase();
  if (/tailwind\.config\./.test(low)) return "tailwind";
  if (low === "package.json") return "node";
  if (/\.astro$/i.test(low)) return "astro";

  return "";
}

/** get the icon spec for a filename (with brand color classes) */
export function getIconSpecForFile(filename: string): IconSpec | null {
  const kind = detectFileKind(filename);
  const spec = ICONS[kind];
  if (spec) return spec;
  return null;
}

export function getFileIconForFilename(
  filename: string,
  className?: string
): React.ReactNode {
  return <FileIcon filename={filename} className={className} />;
}

export const FileIcon: React.FC<{ filename: string; className?: string }> = ({
  filename,
  className,
}) => {
  const spec = getIconSpecForFile(filename);
  if (spec) {
    const { Icon, colorClass } = spec;
    return (
      <Icon
        className={["h-3.5 w-3.5", colorClass, className]
          .filter(Boolean)
          .join(" ")}
      />
    );
  }
  return (
    <FileText
      className={["h-3.5 w-3.5 text-slate-600", className]
        .filter(Boolean)
        .join(" ")}
    />
  );
};
