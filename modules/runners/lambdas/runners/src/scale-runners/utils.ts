export function getBoolean(value: string | number | undefined | boolean, defaultVal = false): boolean {
  if (value === undefined) return defaultVal;

  if (typeof value === 'string') value = value.toLowerCase();

  switch (value) {
    case true:
    case 'true':
    case 1:
    case 1.0:
    case '1':
    case '1.0':
    case 'on':
    case 'yes':
      return true;

    case false:
    case 'false':
    case 0:
    case 0.0:
    case '0':
    case '0.0':
    case 'off':
    case 'no':
      return false;

    default:
      console.warn(`Unrecognized value at getBoolean: ${value}, returning default ${defaultVal}`);
      return defaultVal;
  }
}
