export const propsReducer = (state: any, action: any) => {
  switch (action.type) {
    case "UPDATE_FIELDS":
      return { ...state, ...action.payload };
    case "UPDATE_FIELD":
      return { ...state, [action.field]: action.value };
    default:
      return state;
  }
};
