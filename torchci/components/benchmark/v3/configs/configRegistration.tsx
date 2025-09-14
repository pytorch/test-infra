import React from "react";
import DefaultSidebarMetricsDropdowns from "../components/benchmarkSideBar/components/DefaultSideBarMetricsDropdowns";
import { DefaultRenderContent } from "../components/dataRender/defaultRenderContent";
import { CompilerSearchBarDropdowns } from "../teamBasedComponents/compilers/CompilerSearchBarDropdowns";
import { compilerDataRenderConverter } from "../teamBasedComponents/compilers/config";
import {
  BenchmarkUIConfig,
  DataParamConverter,
  getDefaultDataConverter,
} from "./type";

export const COMPONENT_REGISTRY: Record<string, React.ComponentType<any>> = {
  CompilerSearchBarDropdowns,
};
// register converters for data params, this is
export const CONVERTER_REGISTRY: Record<string, DataParamConverter> = {
  compilerDataRenderConverter,
};

export function resolveBenchmarkQueryParamConverter(
  name: string | undefined | null
): DataParamConverter | undefined {
  if (typeof name !== "string") return undefined;
  return CONVERTER_REGISTRY[name]; // OK: string-indexed record
}

export function resolveComponent(
  name: string | undefined | null
): React.ComponentType<any> | undefined {
  if (typeof name !== "string") return undefined;
  return COMPONENT_REGISTRY[name]; // OK: string-indexed record
}

const NotFoundComponent: React.FC<{ name: string }> = ({ name }) => (
  <div>Component not found: {name}</div>
);

export const getSideBarMetricsComponent = (
  config: BenchmarkUIConfig
): React.ComponentType<any> => {
  const dr = config.sidebar?.customizedDropdown;
  if (!dr || dr.type != "component") return DefaultSidebarMetricsDropdowns;
  const Comp = resolveComponent(dr.object_id);
  if (Comp) return Comp;

  // inline fallback component to satisfy the return type
  const Missing: React.FC = () => <NotFoundComponent name={dr.object_id} />;
  return Missing;
};

// Return a component type
export const getDataRenderComponent = (
  config: BenchmarkUIConfig
): React.ComponentType<any> => {
  const dr = config.dataRender;
  if (!dr || dr.type !== "component") return DefaultRenderContent;

  const Comp = resolveComponent(dr.object_id);
  if (Comp) return Comp;

  // inline fallback component to satisfy the return type
  const Missing: React.FC = () => <NotFoundComponent name={dr.object_id} />;
  return Missing;
};

/**
 * get the benchmark query params converter
 * @param config
 * @returns
 */
export const getGetBenchmarkQueryParamsConverter = (
  config: BenchmarkUIConfig
): DataParamConverter => {
  const dr = config.dataRender;
  if (!dr || dr.type !== "converter") {
    return getDefaultDataConverter;
  }
  const converter = resolveBenchmarkQueryParamConverter(dr.object_id);
  if (!converter) {
    throw new Error(`Customized Converter is not found: ${dr.object_id}`);
  }
  // default return the default converter
  return converter;
};
