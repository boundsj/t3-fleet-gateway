/** Preload for a child process that reports an older Node release (process.versions is configurable). */
export const pretendNode = (version: string) =>
  `data:text/javascript,Object.defineProperty(process,'versions',{value:{...process.versions,node:'${version}'}})`;
