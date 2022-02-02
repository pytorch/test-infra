import { createContext } from "react";

const UserSettingContext = createContext<{ useGrouping: boolean }>({
  useGrouping: true,
});

export default UserSettingContext;
