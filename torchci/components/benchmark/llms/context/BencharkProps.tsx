export const propsReducer = (state: any, action: any) => {
  switch (action.type) {
    case "UPDATE_FIELDS":
      return { ...state, ...action.payload }; // 批量更新多个字段
    case "UPDATE_FIELD":
      return { ...state, [action.field]: action.value }; // 单独更新某个字段
    default:
      return state;
  }
};
