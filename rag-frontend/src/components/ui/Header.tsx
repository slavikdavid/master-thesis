import React from "react";
import { useAuth } from "../../context/AuthContext";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./dropdown-menu";
import { Button } from "./button";

export default function Header() {
  const { user, logout } = useAuth();

  return (
    <header className="w-full flex items-center justify-between px-4 py-2 bg-white shadow">
      <h1 className="text-xl font-semibold">
        byte
        <span className="tracking-tight font-bold text-indigo-600">sophos</span>
      </h1>

      {user && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost">
              <span>{user.name}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={logout}>Logout</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </header>
  );
}
