import { createContext, Dispatch, SetStateAction } from "react";

const userSettings = {
  useGrouping: true,
};

const UserSettingContext = createContext<{
  userSettings: typeof userSettings;
  setUserSettings: Dispatch<SetStateAction<{ useGrouping: boolean }>>;
}>({
  userSettings: userSettings,
  setUserSettings: () => {},
});

export default UserSettingContext;
