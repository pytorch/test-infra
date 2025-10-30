import React from "react";
import { CompilerPrecomputeConfirmDialogContent } from "../teams/compilers/CompilerPrecomputeConfirmDialogContent";
import { CompilerSearchBarDropdowns } from "../teams/compilers/CompilerSearchBarDropdowns";
import { compilerQueryParameterConverter } from "../teams/compilers/config";
import { QueryParameterConverter } from "./utils/dataBindingRegistration";

export const COMPONENT_REGISTRY: Record<string, React.ComponentType<any>> = {
  CompilerSearchBarDropdowns,
  CompilerPrecomputeConfirmDialogContent,
};

// register converters for data params, this is
export const CONVERTER_REGISTRY: Record<string, QueryParameterConverter> = {
  compilerQueryParameterConverter,
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
