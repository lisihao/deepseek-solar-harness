/** CSS Modules: each `.module.css` import is a map from local class name to its scoped name. */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
