import React from "react";
import { Button } from "@/components/ui/button";

interface Props {
  repos: string[];
  current: string | null;
  onSelect: (id: string) => void;
}

export function RepoSelector({ repos, current, onSelect }: Props) {
  return (
    <div className="flex space-x-2 mb-4">
      {repos.map((id) => (
        <Button
          key={id}
          variant={id === current ? "secondary" : "outline"}
          onClick={() => onSelect(id)}
        >
          {id.slice(0, 8)}
        </Button>
      ))}
    </div>
  );
}
