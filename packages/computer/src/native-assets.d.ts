declare module '*bin/darwin/phased-scroll' {
  const filename: string;
  export default filename;
}
declare module '*bin/darwin/display-info' {
  const filename: string;
  export default filename;
}
declare module 'node-mac-permissions' {
  const permissions: {
    getAuthStatus(type: string): string;
    askForAccessibilityAccess(): void;
    askForScreenCaptureAccess(openPreferences?: boolean): void;
  };
  export default permissions;
}
