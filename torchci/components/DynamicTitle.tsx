// DynamicTitle.tsx
import { createContext, useContext, useState, useEffect } from "react";

interface TitleContextProps {
  setTitle: (title: string) => void;
}

const TitleContext = createContext<TitleContextProps | undefined>(undefined);

export function useSetTitle(title: string) {
  const context = useContext(TitleContext);
  if (!context) {
    throw new Error("useSetTitle must be used within a TitleProvider");
  }
  context.setTitle(title);
}

interface TitleProviderProps {
  children: JSX.Element | JSX.Element[];
}

export default function TitleProvider(props: TitleProviderProps) {
  const [title, setTitle] = useState<string>("PyTorch CI HUD");

  useEffect(() => {
    document.title = title;
  }, [title]);

  return (
    <TitleContext.Provider value={{ setTitle }}>
      {props.children}
    </TitleContext.Provider>
  );
}
