import React from "react";
import { CompilerPrecomputeConfirmDialogContent } from "../teams/compilers/CompilerPrecomputeConfirmDialogContent";
import { CompilerSearchBarDropdowns } from "../teams/compilers/CompilerSearchBarDropdowns";

export const COMPONENT_REGISTRY: Record<string, React.ComponentType<any>> = {
  CompilerSearchBarDropdowns,
  CompilerPrecomputeConfirmDialogContent,
};

export function resolveComponent(
  name: string | undefined | null
): React.ComponentType<any> | undefined {
  if (typeof name !== "string") return undefined;
  return COMPONENT_REGISTRY[name]; // OK: string-indexed record
}

export const NotFoundComponent: React.FC<{ name: string }> = ({ name }) => (
  <div>Component not found: {name}</div>
);
