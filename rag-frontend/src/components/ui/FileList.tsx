import React from "react";

interface Props {
  files: string[];
}

export function FileList({ files }: Props) {
  return (
    <ul className="list-disc pl-5">
      {files.map((f) => (
        <li key={f} className="truncate">
          {f}
        </li>
      ))}
    </ul>
  );
}
