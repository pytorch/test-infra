// Taken from https://stackoverflow.com/a/77157708 to get around errors like
// `TypeError: Cannot redefine property: searchSimilarFailures` when using
// jest.spyOn when upgrading to node 14.2.16.
// The following Object.defineProperty wrapper will ensure that all esModule exports
// are configurable and can be mocked by Jest.
const objectDefineProperty = Object.defineProperty;
Object.defineProperty = function <T>(
  obj: T,
  propertyName: PropertyKey,
  attributes: PropertyDescriptor & ThisType<any>
): T {
  if ((obj as { __esModule?: true })["__esModule"]) {
    attributes = { ...attributes, configurable: true };
  }
  return objectDefineProperty(obj, propertyName, attributes);
};

export {};
