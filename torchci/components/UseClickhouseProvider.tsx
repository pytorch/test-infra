import { usePreference } from "lib/useGroupingPreference";
import { createContext, useContext } from "react";

interface UseCHContextProps {
  useCH: boolean;
  setUseCH: (_value: boolean) => void;
}

const UseCHContext = createContext<UseCHContextProps>({
  useCH: true,
  setUseCH: () => {},
});

export function useCHContext() {
  const context = useContext(UseCHContext);
  return context;
}

export function UseCHContextProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [useCH, setUseCH] = usePreference("useClickHouse2", undefined, true);
  return (
    <UseCHContext.Provider
      value={{
        useCH,
        setUseCH,
      }}
    >
      {children}
    </UseCHContext.Provider>
  );
}

export function CHToggle() {
  const { useCH, setUseCH } = useCHContext();
  return (
    <span
      onClick={() => {
        setUseCH(!useCH);
      }}
      style={{
        cursor: "pointer",
      }}
      title={useCH ? "Click to use Rockset" : "Click to use Clickhouse"}
      data-toggle="tooltip"
    >
      {useCH ? "CH" : "RS"}
    </span>
  );
}
