import { createContext, useContext, useState } from "react";

export const UtilizationReportContext = createContext<{
  updateField: (key: string, value: any) => void;
  updateFields: (updates: Record<string, any>) => void;
  values: Record<string, any>;
}>({
  updateField: () => {},
  updateFields: () => {},
  values: {},
});

export const useUtilizationReportContext = () =>
  useContext(UtilizationReportContext);

export default function UtilizationReportProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [values, setValues] = useState<Record<string, any>>({});

  const updateField = (key: string, value: any) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  const updateFields = (updates: Record<string, any>) => {
    setValues((prev) => ({ ...prev, ...updates }));
  };

  return (
    <UtilizationReportContext.Provider
      value={{ values, updateField, updateFields }}
    >
      {children}
    </UtilizationReportContext.Provider>
  );
}
