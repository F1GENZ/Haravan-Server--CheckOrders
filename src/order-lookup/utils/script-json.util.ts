/**
 * Serialize a value for inlining inside an HTML <script> block.
 * JSON.stringify alone leaves "</script>" and U+2028/U+2029 intact, which lets
 * merchant-controlled strings close the script tag or break the JS literal.
 */
export function serializeForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
